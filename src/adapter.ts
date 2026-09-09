/**
 * Host-agnostic agent adapter contract.
 *
 * The Feishu gateway talks only this vocabulary. dsh implements it in-process
 * (the plugin path). CLI adapters spawn a binary; IDE adapters attach a
 * window; a custom agent implements the same methods. Runtimes never
 * silently replace each other — the chat's pin is the authority.
 *
 * @module lark-agent-bridge/adapter
 */

import type { BridgeEvent, BridgeSession } from './dsh-binding.js'
import type { RuntimeKind } from './runtime.js'

export type { BridgeEvent, BridgeSession }

/** How the gateway drives this runtime. */
export type AdapterAttach = 'plugin' | 'spawn' | 'attach'

/** Optional model route applied when a fresh session is created. */
export interface AdapterRoute {
  provider?: string
  model?: string
  preset?: string
}

/**
 * One installed runtime. The gateway looks the adapter up by {@link id}
 * using the chat's `/agent` pin.
 */
export interface AgentAdapter {
  readonly id: string
  readonly kind: RuntimeKind
  readonly displayName: string
  readonly attach: AdapterAttach
  isAvailable(): Promise<boolean>
  listModels?(): Promise<Array<{
    provider: string
    providerName?: string
    models: Array<{ id: string; name?: string }>
  }>>
  ensureSession(
    chatId: string,
    cwd: string,
    onEvent: (event: BridgeEvent) => void,
    routeOverride?: AdapterRoute,
  ): Promise<BridgeSession>
  dispose(chatId: string): Promise<void>
  reset(chatId: string): Promise<void>
  disposeAll(): Promise<void>
}
