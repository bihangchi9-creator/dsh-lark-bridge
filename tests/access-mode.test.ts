import { describe, expect, it } from 'vitest'
import { parseAccessMode, PRESET_BY_ACCESS_MODE } from '../src/access-mode'

describe('parseAccessMode', () => {
  it('defaults when unset or blank', () => {
    expect(parseAccessMode(undefined, 'workspace')).toBe('workspace')
    expect(parseAccessMode('', 'workspace')).toBe('workspace')
    expect(parseAccessMode('   ', 'read-only')).toBe('read-only')
  })

  it('accepts the three tiers, case-insensitively', () => {
    expect(parseAccessMode('read-only', 'workspace')).toBe('read-only')
    expect(parseAccessMode('workspace', 'workspace')).toBe('workspace')
    expect(parseAccessMode('full', 'workspace')).toBe('full')
    expect(parseAccessMode('FULL', 'workspace')).toBe('full')
  })

  it('throws on unknown values — a typo must not silently downgrade security', () => {
    expect(() => parseAccessMode('everything', 'workspace')).toThrow(/invalid accessMode/)
    expect(() => parseAccessMode('write', 'workspace')).toThrow(/read-only, workspace, full/)
  })
})

describe('PRESET_BY_ACCESS_MODE', () => {
  it('maps tiers to the dedicated presets, full to the deployment default', () => {
    expect(PRESET_BY_ACCESS_MODE['read-only']).toBe('lark-readonly')
    expect(PRESET_BY_ACCESS_MODE.workspace).toBe('lark-workspace')
    expect(PRESET_BY_ACCESS_MODE.full).toBeUndefined()
  })
})
