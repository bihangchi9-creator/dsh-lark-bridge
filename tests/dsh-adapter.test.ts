import { describe, expect, it } from 'vitest'
import { DshAdapter } from '../src/dsh-adapter'
import { DSH_RUNTIME } from '../src/runtime'

describe('DshAdapter', () => {
  it('exposes the plugin runtime identity', () => {
    const adapter = new DshAdapter({
      listModels: async () => [],
      ensureSession: async () => ({ sessionId: 's', send() {}, async dispose() {} }),
      dispose: async () => {},
      reset: async () => {},
      disposeAll: async () => {},
    } as never)
    expect(adapter.id).toBe(DSH_RUNTIME.id)
    expect(adapter.kind).toBe('dsh')
    expect(adapter.attach).toBe('plugin')
  })

  it('is always available inside the dsh process', async () => {
    const adapter = new DshAdapter({} as never)
    await expect(adapter.isAvailable()).resolves.toBe(true)
  })
})
