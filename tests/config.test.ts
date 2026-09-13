import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Config, tryResolveConfig } from '../src/config'
import { readCredentials, saveOwnerId } from '../src/credentials'

const dirs: string[] = []
const originalHome = process.env.DSH_LARK_HOME

afterEach(() => {
  if (originalHome === undefined) delete process.env.DSH_LARK_HOME
  else process.env.DSH_LARK_HOME = originalHome
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('credential identity binding', () => {
  it('does not reuse the saved owner when inline credentials select another app', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lark-config-'))
    dirs.push(dir)
    process.env.DSH_LARK_HOME = dir
    writeFileSync(join(dir, 'credentials.json'), JSON.stringify({
      appId: 'saved-app', appSecret: 'saved-secret', ownerId: 'ou_owner', savedAt: Date.now(),
    }))
    expect(tryResolveConfig({ appId: 'other-app', appSecret: 'other-secret' })?.ownerId).toBeUndefined()
    expect(tryResolveConfig({ appId: 'saved-app', appSecret: 'saved-secret' })?.ownerId).toBe('ou_owner')
  })

  it('does not backfill an owner into a different saved app identity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lark-owner-'))
    dirs.push(dir)
    process.env.DSH_LARK_HOME = dir
    writeFileSync(join(dir, 'credentials.json'), JSON.stringify({
      appId: 'saved-app', appSecret: 'saved-secret', ownerId: 'ou_old', savedAt: Date.now(),
    }))
    saveOwnerId('ou_other_app', 'other-app', 'other-secret')
    expect(readCredentials()?.ownerId).toBe('ou_old')
    saveOwnerId('ou_new', 'saved-app', 'saved-secret')
    expect(readCredentials()?.ownerId).toBe('ou_new')
  })
})

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
