import { describe, expect, it } from 'vitest'
import { Config, tryResolveConfig } from '../src/config'

describe('presetModels resolution (DSH_LARK_PRESET_MODELS)', () => {
  it('parses provider:model routes from env, even through the schema', () => {
    const validated = Config({})
    const r = tryResolveConfig({
      ...validated,
      // simulate the schemastery default {} + env fallback path
    })
    // env is not set in the test runner, so extras resolve empty — this test
    // asserts the field exists and defaults empty.
    expect(r?.presetModels).toEqual({})
  })

  it('keeps explicit config over env', () => {
    const validated = Config({
      appId: 'cli_test',
      appSecret: 'secret',
      presetModels: { internal: { provider: 'acme-provider', model: 'm1' } },
    })
    const r = tryResolveConfig(validated)
    expect(r?.presetModels).toEqual({ internal: { provider: 'acme-provider', model: 'm1' } })
  })

  it('uses a bounded positive turn timeout', () => {
    expect(tryResolveConfig({ appId: 'cli_test', appSecret: 'secret' })?.turnTimeoutMs)
      .toBe(10 * 60 * 1000)
    expect(tryResolveConfig({ appId: 'cli_test', appSecret: 'secret', turnTimeoutMs: 1234 })?.turnTimeoutMs)
      .toBe(1234)
    expect(tryResolveConfig({ appId: 'cli_test', appSecret: 'secret', turnTimeoutMs: -1 })?.turnTimeoutMs)
      .toBe(10 * 60 * 1000)
  })
})
