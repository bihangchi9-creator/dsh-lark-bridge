import { describe, expect, it } from 'vitest'
import { parseCommand } from '../src/commands'

describe('parseCommand', () => {
  it('returns undefined for non-command text', () => {
    expect(parseCommand('hello')).toBeUndefined()
    expect(parseCommand('')).toBeUndefined()
    expect(parseCommand('   ')).toBeUndefined()
  })

  it('parses help aliases', () => {
    expect(parseCommand('/help')).toEqual({ kind: 'help' })
    expect(parseCommand('/?')).toEqual({ kind: 'help' })
  })

  it('parses new/reset/clear', () => {
    for (const name of ['new', 'reset', 'clear']) {
      expect(parseCommand(`/${name}`)).toEqual({ kind: 'new' })
    }
  })

  it('parses where/pwd/dir', () => {
    for (const name of ['where', 'pwd', 'dir']) {
      expect(parseCommand(`/${name}`)).toEqual({ kind: 'where' })
    }
  })

  it('parses /model with and without an argument', () => {
    expect(parseCommand('/model')).toEqual({ kind: 'model', value: undefined })
    expect(parseCommand('/model deepseek-v4-flash')).toEqual({
      kind: 'model',
      value: 'deepseek-v4-flash',
    })
    expect(parseCommand('/model   deepseek-v4-flash  ')).toEqual({
      kind: 'model',
      value: 'deepseek-v4-flash',
    })
  })

  it('flags unknown commands with their name', () => {
    expect(parseCommand('/frobnicate x')).toEqual({ kind: 'unknown', name: 'frobnicate' })
  })

  it('is case-insensitive on the command name', () => {
    expect(parseCommand('/HELP')).toEqual({ kind: 'help' })
    expect(parseCommand('/Model foo')).toEqual({ kind: 'model', value: 'foo' })
  })
})
