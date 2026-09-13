/**
 * CLI spawn adapter (trae-to-lark shape).
 *
 * Each Feishu turn spawns `traex` / `codex` with `exec --json`. The child is
 * not an IDE window: closing TRAE/Doubao does not affect this line. A missing
 * binary makes {@link isAvailable} false; the gateway then fails closed
 * instead of retargeting the chat.
 *
 * @module lark-agent-bridge/cli-adapter
 */

import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import spawn from 'cross-spawn'
import type { AgentAdapter, AdapterRoute, BridgeEvent, BridgeSession } from './adapter.js'
import { CodexJsonlTranslator } from './codex-jsonl.js'
import { bridgeHome } from './credentials.js'
import type { RuntimeDescriptor } from './runtime.js'
import {
  nextGen,
  policyFingerprint,
  resetEntry,
  SessionCatalog,
  sessionIdFor,
} from './session-catalog.js'

export const TRAEX_RUNTIME: RuntimeDescriptor = {
  id: 'traex',
  kind: 'cli',
  displayName: 'TRAE CLI',
  attach: 'spawn',
}

export const CODEX_RUNTIME: RuntimeDescriptor = {
  id: 'codex',
  kind: 'cli',
  displayName: 'Codex CLI',
  attach: 'spawn',
}

export const CLAUDE_RUNTIME: RuntimeDescriptor = {
  id: 'claude',
  kind: 'cli',
  displayName: 'Claude Code CLI',
  attach: 'spawn',
}

export type SpawnFn = typeof spawn

export interface CliSpawnAdapterOptions {
  id: string
  displayName: string
  binary: string
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  spawnFn?: SpawnFn
  env?: NodeJS.ProcessEnv
  catalogPath?: string
  threadsPath?: string
  pathExt?: string
}

interface ThreadFile {
  threads: Record<string, string>
}

interface LiveSession {
  sessionId: string
  cwd: string
  route?: AdapterRoute
  threadId?: string
  child?: ChildProcess
  onEvent: (event: BridgeEvent) => void
}

const MAX_JSONL_LINE_BYTES = 1024 * 1024
const MAX_STDERR_BYTES = 64 * 1024
const CLI_SECRET_KEY = /(?:^|_)(?:APP_SECRET|SECRET|TOKEN|PASSWORD|CREDENTIAL|COOKIE|AUTHORIZATION|API_KEY)(?:_|$)/i
const CLI_ENV_ALLOW = new Set([
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'PATHEXT', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'NO_COLOR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
  // Target-agent authentication only. Bridge/Lark/internal credentials remain denied.
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
])

/** Build the minimal environment a spawned agent needs without leaking host secrets. */
export function sanitizeChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    // Explicit agent-auth variables are allowed; all other credential-shaped
    // names (including LARK_APP_SECRET) remain denied.
    if (CLI_ENV_ALLOW.has(key) || key.startsWith('LC_')) out[key] = value
    else if (CLI_SECRET_KEY.test(key)) continue
  }
  return out
}

/** Codex-family CLI adapter: spawn `exec --json`, resume by thread id. */
export class CliSpawnAdapter implements AgentAdapter {
  readonly id: string
  readonly kind = 'cli' as const
  readonly displayName: string
  readonly attach = 'spawn' as const

  private readonly binary: string
  private readonly sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
  private readonly spawnFn: SpawnFn
  private readonly env: NodeJS.ProcessEnv
  private readonly pathExt: string
  private readonly catalog: SessionCatalog
  private readonly threadsPath: string
  private readonly threads = new Map<string, string>()
  private readonly sessions = new Map<string, LiveSession>()

  constructor(opts: CliSpawnAdapterOptions) {
    this.id = opts.id
    this.displayName = opts.displayName
    this.binary = opts.binary
    this.sandbox = opts.sandbox ?? 'workspace-write'
    this.spawnFn = opts.spawnFn ?? spawn
    this.env = opts.env ?? process.env
    this.pathExt = opts.pathExt ?? this.env.PATHEXT ?? ''
    this.catalog = new SessionCatalog(opts.catalogPath ?? join(bridgeHome(), `cli-catalog-${this.id}.json`))
    this.threadsPath = opts.threadsPath ?? join(bridgeHome(), `cli-threads-${this.id}.json`)
    this.loadThreads()
  }

  async isAvailable(): Promise<boolean> {
    return resolveExecutablePath(this.binary, this.env.PATH ?? '', this.pathExt) !== undefined
  }

  async ensureSession(
    chatId: string,
    cwd: string,
    onEvent: (event: BridgeEvent) => void,
    routeOverride?: AdapterRoute,
  ): Promise<BridgeSession> {
    const existing = this.sessions.get(chatId)
    if (existing) {
      existing.onEvent = onEvent
      existing.cwd = cwd
      existing.route = routeOverride
      return this.toHandle(chatId, existing)
    }

    const fingerprint = policyFingerprint({
      cwd,
      preset: routeOverride?.preset,
      provider: routeOverride?.provider,
      model: routeOverride?.model,
    })
    const entry = this.catalog.entryFor(chatId)
    const gen = nextGen(entry, fingerprint)
    const sessionId = `${this.id}-${sessionIdFor(chatId, gen)}`
    this.catalog.set(chatId, { gen, fingerprint, updatedAt: Date.now() })

    const session: LiveSession = {
      sessionId,
      cwd,
      route: routeOverride,
      threadId: fingerprint === entry?.fingerprint ? this.threads.get(chatId) : undefined,
      onEvent,
    }
    this.sessions.set(chatId, session)
    return this.toHandle(chatId, session)
  }

  async dispose(chatId: string): Promise<void> {
    const session = this.sessions.get(chatId)
    if (!session) return
    // Remove ownership before killing so a late close handler cannot re-persist
    // a thread that reset/dispose deliberately erased.
    this.sessions.delete(chatId)
    await killChild(session.child)
  }

  async reset(chatId: string): Promise<void> {
    const entry = this.catalog.entryFor(chatId)
    this.catalog.set(chatId, resetEntry(entry))
    this.threads.delete(chatId)
    this.persistThreads()
    await this.dispose(chatId)
  }

  async disposeAll(): Promise<void> {
    const ids = [...this.sessions.keys()]
    await Promise.allSettled(ids.map(id => this.dispose(id)))
  }

  private toHandle(chatId: string, session: LiveSession): BridgeSession {
    return {
      sessionId: session.sessionId,
      send: (text: string) => {
        void this.runTurn(chatId, session, text).catch(err => {
          const message = err instanceof Error ? err.message : String(err)
          session.onEvent({ type: 'error', message })
          session.onEvent({ type: 'done', reason: 'failed' })
        })
      },
      dispose: () => this.dispose(chatId),
    }
  }

  private async runTurn(chatId: string, session: LiveSession, text: string): Promise<void> {
    if (session.child) {
      session.onEvent({ type: 'error', message: `${this.id} already has a turn in flight` })
      return
    }
    const available = await this.isAvailable()
    if (this.sessions.get(chatId) !== session) return
    if (!available) {
      session.onEvent({ type: 'error', message: `${this.displayName} is not available (${this.binary})` })
      session.onEvent({ type: 'done', reason: 'failed' })
      return
    }
    const sandbox = session.route?.sandbox ?? sandboxForPreset(session.route?.preset, this.sandbox)
    const args = buildCodexExecArgs({
      cwd: session.cwd,
      sandbox,
      threadId: session.threadId,
      model: session.route?.model,
    })
    const child = this.spawnFn(this.binary, args, {
      cwd: session.cwd,
      env: sanitizeChildEnv(this.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    session.child = child
    const translator = new CodexJsonlTranslator()
    if (session.threadId) translator.threadId = session.threadId

    const emit = (events: BridgeEvent[]): void => {
      for (const event of events) session.onEvent(event)
    }

    if (child.stdout) {
      consumeBoundedJsonl(
        child.stdout,
        line => {
          try {
            emit(translator.translate(JSON.parse(line)))
          } catch {
            // Non-JSON stdout is ignored; a missing terminal event still fails on close.
          }
        },
        err => {
          emit(translator.finish('failed'))
          session.onEvent({ type: 'error', message: err.message })
          void killChild(child)
        },
      )
    }
    let stderr = ''
    child.stderr?.on('data', chunk => {
      if (stderr.length < MAX_STDERR_BYTES) {
        stderr += chunk.toString('utf8').slice(0, MAX_STDERR_BYTES - stderr.length)
      }
    })

    child.on('error', err => {
      emit(translator.finish('failed'))
      session.onEvent({ type: 'error', message: err.message })
    })
    child.on('close', (code, signal) => {
      session.child = undefined
      const stillOwned = this.sessions.get(chatId) === session
      if (stillOwned && translator.threadId) {
        session.threadId = translator.threadId
        this.threads.set(chatId, translator.threadId)
        this.persistThreads()
      }
      const cleanExit = code === 0 && signal === null
      emit(translator.finish(cleanExit ? 'completed' : 'failed'))
      if (!cleanExit && stderr.trim().length > 0) {
        session.onEvent({ type: 'error', message: `${this.displayName} exited unsuccessfully` })
      }
    })

    child.stdin?.on('error', err => {
      session.onEvent({ type: 'error', message: err.message })
    })
    child.stdin?.end(text, 'utf8')
  }

  private loadThreads(): void {
    try {
      const raw = JSON.parse(readFileSync(this.threadsPath, 'utf8')) as ThreadFile
      for (const [chatId, threadId] of Object.entries(raw.threads ?? {})) {
        if (typeof threadId === 'string' && threadId.length > 0) this.threads.set(chatId, threadId)
      }
    } catch {
      // Missing file is a fresh adapter.
    }
  }

  private persistThreads(): void {
    try {
      mkdirSync(dirname(this.threadsPath), { recursive: true, mode: 0o700 })
      writeFileSync(
        this.threadsPath,
        `${JSON.stringify({ threads: Object.fromEntries(this.threads) }, null, 2)}\n`,
        { mode: 0o600 },
      )
    } catch {
      // A lost thread id only costs a fresh CLI session on the next turn.
    }
  }
}

/** Map bridge preset names onto Codex-family sandbox modes. Unknown presets fail closed. */
export function sandboxForPreset(
  preset: string | undefined,
  fallback: 'read-only' | 'workspace-write' | 'danger-full-access',
): 'read-only' | 'workspace-write' | 'danger-full-access' {
  if (preset === undefined) return fallback
  if (preset === 'lark-readonly') return 'read-only'
  if (preset === 'lark-workspace') return 'workspace-write'
  throw new Error(`CLI runtime cannot enforce preset ${JSON.stringify(preset)}`)
}

export function buildCodexExecArgs(input: {
  cwd: string
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
  threadId?: string
  model?: string
}): string[] {
  const globalFlags = [
    '--sandbox',
    input.sandbox,
    '-c',
    'approval_policy="never"',
    '-C',
    input.cwd,
    ...(input.model ? ['--model', input.model] : []),
  ]
  if (input.threadId) {
    return ['exec', ...globalFlags, 'resume', '--json', input.threadId, '-']
  }
  return ['exec', '--json', ...globalFlags, '-']
}

/** Consume newline-delimited JSON with a hard per-line cap. */
function consumeBoundedJsonl(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
  onError: (error: Error) => void,
): void {
  let buffer = ''
  let failed = false
  stream.on('data', chunk => {
    if (failed) return
    buffer += chunk.toString('utf8')
    if (Buffer.byteLength(buffer) > MAX_JSONL_LINE_BYTES && !buffer.includes('\n')) {
      failed = true
      onError(new Error(`CLI emitted a JSONL line larger than ${MAX_JSONL_LINE_BYTES} bytes`))
      return
    }
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (Buffer.byteLength(line) > MAX_JSONL_LINE_BYTES) {
        failed = true
        onError(new Error(`CLI emitted a JSONL line larger than ${MAX_JSONL_LINE_BYTES} bytes`))
        return
      }
      if (line) onLine(line)
    }
  })
}

/** Locate an executable on PATH without spawning a shell. */
export function resolveExecutablePath(
  command: string,
  pathValue: string,
  pathExt = '',
): string | undefined {
  const exts = pathExt
    .split(';')
    .map(ext => ext.trim())
    .filter(Boolean)
  const names = exts.length > 0 && !command.includes('.')
    ? [command, ...exts.map(ext => `${command}${ext}`)]
    : [command]
  if (isAbsolute(command)) {
    return names.find(name => isExecutable(name))
  }
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const candidate = join(dir, name)
      if (isExecutable(candidate)) return candidate
    }
  }
  return undefined
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function killChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      resolve()
    }, 2000)
    child.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/** Detect the supported Codex-family CLI runtimes present on PATH. */
export function detectCliAdapters(env: NodeJS.ProcessEnv = process.env): CliSpawnAdapter[] {
  const specs: Array<{ runtime: RuntimeDescriptor; command: string }> = [
    { runtime: TRAEX_RUNTIME, command: env.LARK_BRIDGE_TRAEX_BIN ?? env.LARK_CHANNEL_TRAE_BIN ?? 'traex' },
    { runtime: CODEX_RUNTIME, command: env.LARK_BRIDGE_CODEX_BIN ?? env.LARK_CHANNEL_CODEX_BIN ?? 'codex' },
  ]
  const found: CliSpawnAdapter[] = []
  for (const spec of specs) {
    const adapter = new CliSpawnAdapter({
      id: spec.runtime.id,
      displayName: spec.runtime.displayName,
      binary: spec.command,
      env,
    })
    found.push(adapter)
  }
  return found
}
