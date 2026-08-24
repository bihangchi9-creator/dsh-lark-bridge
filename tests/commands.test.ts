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

  it('parses owner admin commands', () => {
    expect(parseCommand('/allow')).toEqual({ kind: 'allow' })
    expect(parseCommand('/disallow')).toEqual({ kind: 'disallow' })
    expect(parseCommand('/whoami')).toEqual({ kind: 'whoami' })
  })

  it('parses /preset with and without a value', () => {
    expect(parseCommand('/preset')).toEqual({ kind: 'preset', value: undefined })
    expect(parseCommand('/preset internal')).toEqual({ kind: 'preset', value: 'internal' })
    expect(parseCommand('/preset   workspace  ')).toEqual({ kind: 'preset', value: 'workspace' })
  })

  it('flags unknown commands with their name', () => {
    expect(parseCommand('/frobnicate x')).toEqual({ kind: 'unknown', name: 'frobnicate' })
  })

  it('is case-insensitive on the command name', () => {
    expect(parseCommand('/HELP')).toEqual({ kind: 'help' })
    expect(parseCommand('/Model foo')).toEqual({ kind: 'model', value: 'foo' })
  })
})
