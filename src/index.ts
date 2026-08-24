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
 * The ONLY service this plugin truly requires: the agent factory (`agents`).
 * Everything else — `agentPresets`, `agentDefaultModel`, `llm`,
 * `sessionPersistence` — is read via `ctx.get` (optional) when present, so a
 * deployment lacking them still boots the plugin (it degrades, never crashes
 * the host). A listed-but-missing inject makes cordis fail the ENTIRE
 * application at load, so this list is deliberately minimal.
 */
export const inject = ['agents']

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
 *
 * The whole body is wrapped so that ANY failure here — a config error, an
 * incompatible host API, a bad import surfacing at call time — is logged and
 * contained. A bridge that cannot start must never take the dsh host down
 * with it; the worst outcome is "the bot is offline", never "dsh won't boot".
 */
export function apply(ctx: Context, config: LarkBridgeConfig = {}): void {
  const log = makeLogger(ctx)
  try {
    applyInner(ctx, config, log)
  } catch (err) {
    log('error', 'dsh-lark-bridge failed to initialize — the bot is offline, but dsh is unaffected', err)
  }
}

/** The real entry body; {@link apply} contains any failure it throws. */
function applyInner(ctx: Context, config: LarkBridgeConfig, log: LogFn): void {
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

/** Build the level-aware logger. Always writes to the process console so
 * operator logs reach the host's captured stdout (e.g. the launchd log
 * file); the cordis `ctx.logger` is NOT used because its output does not
 * land on the process stdout and would be invisible to tail-based debugging. */
function makeLogger(ctx: Context): LogFn {
  return (level, msg, extra) => {
    // eslint-disable-next-line no-console
    console[level](`[dsh-lark-bridge] ${msg}`, extra ?? '')
  }
}
