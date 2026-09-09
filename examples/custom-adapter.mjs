/**
 * Minimal custom runtime for dsh-lark-bridge.
 *
 *   LARK_BRIDGE_CUSTOM_ADAPTER=/path/to/examples/custom-adapter.mjs node lib/daemon.js
 *
 * Pin a chat with `/agent echo`. This is a contract sample, not a coding agent.
 */

export const adapter = {
  id: 'echo',
  kind: 'custom',
  displayName: 'Echo (custom example)',
  attach: 'spawn',
  async isAvailable() {
    return true
  },
  async ensureSession(chatId, _cwd, onEvent) {
    return {
      sessionId: `echo-${chatId}`,
      send(text) {
        onEvent({ type: 'final_text', content: text })
        onEvent({ type: 'done', reason: 'completed' })
      },
      async dispose() {},
    }
  },
  async dispose() {},
  async reset() {},
  async disposeAll() {},
}
