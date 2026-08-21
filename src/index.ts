/**
 * dsh-lark-bridge — a DeepSeek Harness plugin that bridges dsh agents to
 * Feishu/Lark group chats.
 *
 * This is an "external protocol driver" in dsh's architecture: it injects the
 * core `agents` service and adapts a Feishu WebSocket peer onto it. Each group
 * chat becomes one long-lived agent session with its own project directory —
 * "one group, one project folder".
 *
 * Loaded by dsh through the bundle patch (see cordis.patch.yml). On first run,
 * if no Feishu credentials are configured, the plugin auto-launches the QR
 * registration wizard (terminal QR + a browser-openable URL file) and connects
 * as soon as you finish it — no separate setup command required. Configuration
 * otherwise comes from the plugin config block or environment variables; see
 * config.ts.
 *
 * @module dsh-lark-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig, tryResolveConfig, type LarkBridgeConfig } from './config.js'
import { PRESET_BY_ACCESS_MODE } from './access-mode.js'
import { registerUrlPath, writeRegisterUrl } from './credentials.js'
import { DshBinding } from './dsh-binding.js'
import { LarkBridge } from './lark.js'
import { runRegister } from './register.js'

/** The Cordis plugin name. */
export const name = 'lark-bridge'

/**
 * Core services this plugin drives: the agent factory, the session registry,
 * the preset registry (toolset + prompt), and the default-model service (the
 * agent's LLM route — without it a turn ends with no model call).
 */
export const inject = ['agents', 'sessions', 'agentPresets', 'agentDefaultModel']

export { Config }
export type { LarkBridgeConfig }

/** Structured logger shape, falling back to console when Cordis has none. */
type LogFn = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void

/**
 * Plugin entry. If credentials are present it wires the Feishu channel and
 * connects; if not, it runs the registration wizard first and connects once it
 * completes. Registers a disposer so a plugin reload or host shutdown tears the
 * channel and every agent down cleanly. A `cancelled` flag makes the wizard
 * path a no-op if the plugin is disposed mid-registration.
 */
export function apply(ctx: Context, config: LarkBridgeConfig = {}): void {
  const log = makeLogger(ctx)

  ctx.effect(() => {
    let cancelled = false
    let bridge: LarkBridge | undefined

    // Connect a channel with fully-resolved credentials. Shared by the ready
    // path and the post-registration path.
    const connect = (resolved: ReturnType<typeof resolveConfig>): void => {
      if (cancelled) return
      // P0-2 blast radius: the accessMode tier picks the agent preset (which
      // tools exist), not just the model route.
      const binding = new DshBinding(
        ctx,
        {
          provider: resolved.provider,
          model: resolved.model,
          preset: PRESET_BY_ACCESS_MODE[resolved.accessMode],
        },
        log,
      )
      bridge = new LarkBridge(resolved, binding, log)
      void bridge.connect().catch(err => log('error', 'failed to connect', err))
    }

    const ready = tryResolveConfig(config)
    if (ready !== undefined) {
      connect(ready)
    } else {
      // No credentials yet: guide the user through QR registration, then
      // connect. Fire-and-forget so dsh's other plugins boot normally; the
      // bridge simply stays offline until setup completes.
      log(
        'warn',
        'no Feishu credentials found — starting the registration wizard. ' +
          'Scan the terminal QR code, or open the URL saved at ' +
          `${registerUrlPath()} in a browser.`,
      )
      void runRegister({
        log: line => log('info', line.trim()),
        onUrl: url => {
          try {
            const path = writeRegisterUrl(url)
            log('info', `registration URL saved to ${path} (open it in a browser to register)`)
          } catch (err) {
            log('warn', 'could not persist registration URL', err)
          }
        },
      })
        .then(() => {
          if (cancelled) return
          // Re-resolve now that credentials are saved; env/config still take
          // precedence, so this simply picks up the freshly written file.
          const resolved = resolveConfig(config)
          log('info', 'registration complete — connecting to Feishu')
          connect(resolved)
        })
        .catch(err => log('error', 'registration wizard failed', err))
    }

    return async () => {
      cancelled = true
      if (bridge) await bridge.disconnect().catch(err => log('warn', 'disconnect failed', err))
    }
  }, 'lark-bridge.connect()')
}

/** Build the level-aware logger, preferring the Cordis logger when present. */
function makeLogger(ctx: Context): LogFn {
  return (level, msg, extra) => {
    const logger = (ctx as unknown as { logger?: Record<string, (...args: unknown[]) => void> })
      .logger
    if (logger && typeof logger[level] === 'function') {
      logger[level](extra !== undefined ? `${msg} ${safeStringify(extra)}` : msg)
    } else {
      // eslint-disable-next-line no-console
      console[level](`[dsh-lark-bridge] ${msg}`, extra ?? '')
    }
  }
}

/** Best-effort stringify for log extras (errors, objects). */
function safeStringify(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
