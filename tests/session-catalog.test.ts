import { describe, expect, it } from 'vitest'
import {
  nextGen,
  policyFingerprint,
  resetEntry,
  RESET_FINGERPRINT,
  sessionIdFor,
  type CatalogEntry,
} from '../src/session-catalog'

const entry = (gen: number, fingerprint: string): CatalogEntry => ({
  gen,
  fingerprint,
  updatedAt: Date.now(),
})

describe('policyFingerprint', () => {
  it('is stable for the same policy', () => {
    const a = policyFingerprint({ cwd: '/w', preset: 'lark-workspace', provider: 'p', model: 'm' })
    const b = policyFingerprint({ cwd: '/w', preset: 'lark-workspace', provider: 'p', model: 'm' })
    expect(a).toBe(b)
  })

  it('changes when any policy dimension changes', () => {
    const base = { cwd: '/w', preset: 'lark-workspace', provider: 'p', model: 'm' }
    expect(policyFingerprint(base)).not.toBe(policyFingerprint({ ...base, cwd: '/w2' }))
    expect(policyFingerprint(base)).not.toBe(policyFingerprint({ ...base, preset: 'full' }))
    expect(policyFingerprint(base)).not.toBe(policyFingerprint({ ...base, model: 'm2' }))
    expect(policyFingerprint(base)).not.toBe(policyFingerprint({ ...base, provider: 'p2' }))
  })
})

describe('nextGen', () => {
  it('starts at 0 with no entry (legacy id)', () => {
    expect(nextGen(undefined, 'fp')).toBe(0)
  })

  it('keeps the generation when the fingerprint matches (resume)', () => {
    expect(nextGen(entry(3, 'fp'), 'fp')).toBe(3)
  })

  it('bumps when the policy changed', () => {
    expect(nextGen(entry(3, 'fp-old'), 'fp-new')).toBe(4)
  })

  it('bumps against the reset sentinel', () => {
    expect(nextGen(entry(2, RESET_FINGERPRINT), 'fp')).toBe(3)
  })
})

describe('resetEntry', () => {
  it('writes a sentinel that never matches, preserving the generation base', () => {
    const r = resetEntry(entry(2, 'fp'))
    expect(r.fingerprint).toBe(RESET_FINGERPRINT)
    expect(r.gen).toBe(2)
    // The next ensure sees a mismatch → rotates to gen+1 → fresh id.
    expect(nextGen(r, 'fp')).toBe(3)
  })

  it('works with no prior entry', () => {
    expect(nextGen(resetEntry(undefined), 'fp')).toBe(1)
  })
})

describe('sessionIdFor', () => {
  it('keeps the legacy bare id at generation 0 (migration path)', () => {
    expect(sessionIdFor('oc_abc', 0)).toBe('lark-oc_abc')
  })

  it('suffixes generations above 0', () => {
    expect(sessionIdFor('oc_abc', 1)).toBe('lark-oc_abc-1')
    expect(sessionIdFor('oc_abc', 7)).toBe('lark-oc_abc-7')
  })
})
