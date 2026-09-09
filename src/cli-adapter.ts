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
import { createInterface } from 'node:readline'
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
  threadId?: string
  child?: ChildProcess
  onEvent: (event: BridgeEvent) => void
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
    this.sandbox = opts.sandbox ?? 'danger-full-access'
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
      threadId: fingerprint === entry?.fingerprint ? this.threads.get(chatId) : undefined,
      onEvent,
    }
    this.sessions.set(chatId, session)
    return this.toHandle(chatId, session)
  }

  async dispose(chatId: string): Promise<void> {
    const session = this.sessions.get(chatId)
    if (!session) return
    await killChild(session.child)
    this.sessions.delete(chatId)
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
        void this.runTurn(chatId, session, text)
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
    if (!available) {
      session.onEvent({ type: 'error', message: `${this.displayName} is not available (${this.binary})` })
      session.onEvent({ type: 'done', reason: 'failed' })
      return
    }
    const args = buildCodexExecArgs({
      cwd: session.cwd,
      sandbox: this.sandbox,
      threadId: session.threadId,
    })
    const child = this.spawnFn(this.binary, args, {
      cwd: session.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    session.child = child
    const translator = new CodexJsonlTranslator()
    if (session.threadId) translator.threadId = session.threadId

    const emit = (events: BridgeEvent[]): void => {
      for (const event of events) session.onEvent(event)
    }

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout })
      rl.on('line', line => {
        const trimmed = line.trim()
        if (!trimmed) return
        try {
          emit(translator.translate(JSON.parse(trimmed)))
        } catch {
          // Non-JSON stdout is ignored; the translator still finishes on close.
        }
      })
    }

    child.on('error', err => {
      emit(translator.finish('failed'))
      session.onEvent({ type: 'error', message: err.message })
    })
    child.on('close', () => {
      session.child = undefined
      if (translator.threadId) {
        session.threadId = translator.threadId
        this.threads.set(chatId, translator.threadId)
        this.persistThreads()
      }
      emit(translator.finish('completed'))
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

/** Detect Codex-family CLI runtimes present on PATH. Claude is listed, not spawned here. */
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
