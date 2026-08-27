import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { apply, inject } from '../src/index'

describe('install robustness — inject surface', () => {
  it('requires only the agents service (everything else is optional via ctx.get)', () => {
    // A listed-but-missing inject makes cordis fail the whole host at load,
    // so the required set must be minimal. `agentPresets`/`agentDefaultModel`/
    // `llm`/`sessionPersistence` are read with ctx.get instead.
    expect(inject).toEqual(['agents'])
  })

  it('keeps the shipped bundle patch inject aligned with the module', () => {
    const path = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
    const patch = readFileSync(path, 'utf8')
    const match = patch.match(/^\s*inject:\s*\[([^\]]*)\]\s*$/m)
    expect(match).not.toBeNull()
    const patchInject = (match?.[1] ?? '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
    expect(patchInject).toEqual(inject)
  })
})

describe('install robustness — complete workspace tier delivery', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))

  it('builds and ships the lark-cli tool required by lark-workspace', () => {
    const pkg = JSON.parse(readFileSync(`${root}/package.json`, 'utf8')) as {
      scripts: { build: string }
      files: string[]
    }
    expect(pkg.scripts.build).toContain('tools/lark-cli/tsconfig.json')
    expect(pkg.files.some(value => value.startsWith('tools/lark-cli/lib/'))).toBe(true)
  })

  it('installs and verifies dsh-tool-lark-cli on Unix and Windows', () => {
    const unix = readFileSync(`${root}/scripts/setup.sh`, 'utf8')
    const windows = readFileSync(`${root}/scripts/setup.ps1`, 'utf8')
    for (const script of [unix, windows]) {
      expect(script).toContain('dsh-tool-lark-cli')
      expect(script.replaceAll('\\', '/')).toContain('tools/lark-cli')
      expect(script).toContain('installation incomplete')
    }
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
