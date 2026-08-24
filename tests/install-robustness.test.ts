import { describe, expect, it } from 'vitest'
import { apply, inject } from '../src/index'

describe('install robustness — inject surface', () => {
  it('requires only the agents service (everything else is optional via ctx.get)', () => {
    // A listed-but-missing inject makes cordis fail the whole host at load,
    // so the required set must be minimal. `agentPresets`/`agentDefaultModel`/
    // `llm`/`sessionPersistence` are read with ctx.get instead.
    expect(inject).toEqual(['agents'])
  })
})

describe('install robustness — apply() containment', () => {
  it('never throws to the host, even when the context misbehaves', () => {
    // A bridge that cannot start must log and stay offline — it must NOT take
    // the dsh host down. apply() wraps its whole body.
    const throwingCtx = {
      effect() {
        throw new Error('simulated incompatible host API')
      },
      get() {
        return undefined
      },
    }
    expect(() => apply(throwingCtx as never, {})).not.toThrow()
  })

  it('tolerates a context with no effect/get at all', () => {
    expect(() => apply({} as never, {})).not.toThrow()
  })
})
