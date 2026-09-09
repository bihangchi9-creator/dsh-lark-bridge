/**
 * Standalone Feishu gateway for CLI / IDE / custom runtimes.
 *
 * This process is *not* a dsh plugin. It opens the same Lark WebSocket, then
 * routes each chat to a pinned spawn/attach adapter. dsh stays in-process
 * via {@link apply} in index.ts.
 *
 *   node lib/daemon.js
 *   LARK_BRIDGE_RUNTIME=traex node lib/daemon.js
 *   LARK_BRIDGE_IDE_SOCKET=/tmp/ide.sock node lib/daemon.js
 *   LARK_BRIDGE_CUSTOM_ADAPTER=./examples/custom-adapter.mjs node lib/daemon.js
 *
 * @module dsh-lark-bridge/daemon
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentAdapter } from './adapter.js'
import { detectCliAdapters } from './cli-adapter.js'
import { resolveConfig, tryResolveConfig } from './config.js'
import { registerUrlPath, writeRegisterUrl } from './credentials.js'
import { loadCustomAdapter } from './custom-adapter.js'
import { IdeAttachAdapter } from './ide-adapter.js'
import { LarkBridge } from './lark.js'
import { runRegister } from './register.js'
import { sanitizeLogValue, type LogFn } from './safe-log.js'

function makeLogger(): LogFn {
  return (level, msg, extra) => {
    // eslint-disable-next-line no-console
    console[level](
      `[dsh-lark-bridge] ${msg}`,
      extra === undefined ? '' : sanitizeLogValue(extra),
    )
  }
}

/** Discover CLI / IDE / custom adapters. IDE is included even when down. */
export async function loadDaemonAdapters(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentAdapter[]> {
  const adapters: AgentAdapter[] = []
  for (const adapter of detectCliAdapters(env)) {
    if (await adapter.isAvailable()) adapters.push(adapter)
  }
  if (env.LARK_BRIDGE_IDE_SOCKET) {
    adapters.push(new IdeAttachAdapter({ socketPath: env.LARK_BRIDGE_IDE_SOCKET }))
  }
  if (env.LARK_BRIDGE_CUSTOM_ADAPTER) {
    adapters.push(await loadCustomAdapter(env.LARK_BRIDGE_CUSTOM_ADAPTER))
  }
  return adapters
}

export function resolveDefaultRuntimeId(
  adapters: readonly AgentAdapter[],
  preferred: string | undefined,
): string {
  if (adapters.length === 0) {
    throw new Error(
      'dsh-lark-bridge daemon: no runtime configured. Put traex/codex on PATH, ' +
        'or set LARK_BRIDGE_IDE_SOCKET / LARK_BRIDGE_CUSTOM_ADAPTER. ' +
        'dsh still uses the plugin path (`dsh web`), not this process.',
    )
  }
  if (!preferred) return adapters[0]!.id
  if (adapters.some(adapter => adapter.id === preferred)) return preferred
  throw new Error(
    `dsh-lark-bridge daemon: LARK_BRIDGE_RUNTIME=${JSON.stringify(preferred)} is not installed`,
  )
}

export async function startDaemon(env: NodeJS.ProcessEnv = process.env): Promise<LarkBridge> {
  const log = makeLogger()
  let resolved = tryResolveConfig({})
  if (resolved === undefined) {
    log(
      'warn',
      'no Feishu credentials found — starting the registration wizard. ' +
        `Scan the terminal QR code, or open the URL saved at ${registerUrlPath()} in a browser.`,
    )
    await runRegister({
      log: line => log('info', line.trim()),
      onUrl: url => {
        try {
          const path = writeRegisterUrl(url)
          log('info', `registration URL saved to ${path}`)
        } catch (err) {
          log('warn', 'could not persist registration URL', err)
        }
      },
    })
    resolved = resolveConfig({})
  }

  const adapters = await loadDaemonAdapters(env)
  const defaultRuntimeId = resolveDefaultRuntimeId(adapters, env.LARK_BRIDGE_RUNTIME)
  const bridge = new LarkBridge(resolved, adapters, log, defaultRuntimeId)
  await bridge.connect()
  log(
    'info',
    `daemon runtimes: ${adapters.map(adapter => adapter.id).join(', ')} (default ${defaultRuntimeId})`,
  )
  return bridge
}

function isMainModule(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return resolve(entry) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isMainModule()) {
  startDaemon().catch(err => {
    // eslint-disable-next-line no-console
    console.error('[dsh-lark-bridge] daemon failed', err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
}
