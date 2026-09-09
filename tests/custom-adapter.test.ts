import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadCustomAdapter } from '../src/custom-adapter'
import { loadDaemonAdapters, resolveDefaultRuntimeId } from '../src/daemon'
import type { BridgeEvent } from '../src/dsh-binding'

const example = join(dirname(fileURLToPath(import.meta.url)), '../examples/custom-adapter.mjs')

describe('loadCustomAdapter', () => {
  it('loads the example echo adapter', async () => {
    const adapter = await loadCustomAdapter(example)
    expect(adapter.id).toBe('echo')
    expect(adapter.kind).toBe('custom')
    const events: BridgeEvent[] = []
    const session = await adapter.ensureSession('oc_1', '/tmp', event => events.push(event))
    session.send('ping')
    expect(events).toEqual([
      { type: 'final_text', content: 'ping' },
      { type: 'done', reason: 'completed' },
    ])
  })

  it('rejects a module that is not an adapter', async () => {
    await expect(loadCustomAdapter(join(dirname(fileURLToPath(import.meta.url)), '../package.json'))).rejects.toThrow(/missing/)
  })
})

describe('loadDaemonAdapters', () => {
  it('includes a down IDE line so pins can fail closed', async () => {
    const adapters = await loadDaemonAdapters({
      PATH: '/tmp/empty-path-for-lark-tests',
      LARK_BRIDGE_IDE_SOCKET: '/tmp/definitely-missing-ide.sock',
    })
    expect(adapters.map(adapter => adapter.id)).toEqual(['ide'])
    await expect(adapters[0]!.isAvailable()).resolves.toBe(false)
  })

  it('loads a custom adapter from LARK_BRIDGE_CUSTOM_ADAPTER', async () => {
    const adapters = await loadDaemonAdapters({
      PATH: '/tmp/empty-path-for-lark-tests',
      LARK_BRIDGE_CUSTOM_ADAPTER: example,
    })
    expect(adapters.map(adapter => adapter.id)).toEqual(['echo'])
  })
})

describe('resolveDefaultRuntimeId', () => {
  it('throws when nothing is installed', () => {
    expect(() => resolveDefaultRuntimeId([], undefined)).toThrow(/no runtime configured/)
  })

  it('refuses an unknown preferred id instead of falling back', () => {
    const fake = { id: 'traex' } as never
    expect(() => resolveDefaultRuntimeId([fake], 'ide')).toThrow(/not installed/)
  })
})
