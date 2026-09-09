/**
 * dsh in-process adapter.
 *
 * The Feishu channel still lives inside the dsh plugin; this wrapper only
 * exposes {@link DshBinding} through the host-agnostic {@link AgentAdapter}
 * contract so later CLI/IDE adapters can sit beside it without a fallback.
 *
 * @module lark-agent-bridge/dsh-adapter
 */

import type { AgentAdapter, AdapterRoute, BridgeEvent, BridgeSession } from './adapter.js'
import type { DshBinding } from './dsh-binding.js'
import { DSH_RUNTIME } from './runtime.js'

/** Plugin-path adapter: one dsh host, attach = plugin. */
export class DshAdapter implements AgentAdapter {
  readonly id = DSH_RUNTIME.id
  readonly kind = DSH_RUNTIME.kind
  readonly displayName = DSH_RUNTIME.displayName
  readonly attach = DSH_RUNTIME.attach

  constructor(private readonly binding: DshBinding) {}

  async isAvailable(): Promise<boolean> {
    return true
  }

  listModels(): Promise<Array<{
    provider: string
    providerName?: string
    models: Array<{ id: string; name?: string }>
  }>> {
    return this.binding.listModels()
  }

  ensureSession(
    chatId: string,
    cwd: string,
    onEvent: (event: BridgeEvent) => void,
    routeOverride?: AdapterRoute,
  ): Promise<BridgeSession> {
    return this.binding.ensureSession(chatId, cwd, onEvent, routeOverride)
  }

  dispose(chatId: string): Promise<void> {
    return this.binding.dispose(chatId)
  }

  reset(chatId: string): Promise<void> {
    return this.binding.reset(chatId)
  }

  disposeAll(): Promise<void> {
    return this.binding.disposeAll()
  }
}
