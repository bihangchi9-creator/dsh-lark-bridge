import { describe, expect, it, vi } from 'vitest'
import { mountPresetFailClosed } from '../src/dsh-binding'

describe('mountPresetFailClosed', () => {
  it('mounts a named preset when available', async () => {
    const mount = vi.fn(async () => undefined)
    await mountPresetFailClosed({ mount }, {}, 'lark-workspace')
    expect(mount).toHaveBeenCalledWith({}, 'lark-workspace')
  })

  it('refuses to fall back when a named preset is unavailable', async () => {
    const mount = vi.fn(async () => {
      throw new Error('not found')
    })
    await expect(mountPresetFailClosed({ mount }, {}, 'lark-workspace')).rejects.toThrow(
      /refusing to fall back/,
    )
    expect(mount).toHaveBeenCalledTimes(1)
  })

  it('refuses a named preset when the preset service is absent', async () => {
    await expect(mountPresetFailClosed(undefined, {}, 'lark-readonly')).rejects.toThrow(
      /agentPresets service is unavailable/,
    )
  })

  it('allows an explicit default/full route without the optional preset service', async () => {
    await expect(mountPresetFailClosed(undefined, {}, undefined)).resolves.toBeUndefined()
  })
})
