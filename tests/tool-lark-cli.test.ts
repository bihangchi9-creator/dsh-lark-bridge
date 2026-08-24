import { describe, expect, it } from 'vitest'
import { splitArgs } from '../tools/lark-cli/src/split-args'

describe('splitArgs', () => {
  it('splits simple whitespace tokens', () => {
    expect(splitArgs('im +send --chat-id oc_x')).toEqual(['im', '+send', '--chat-id', 'oc_x'])
  })

  it('handles double-quoted values with spaces', () => {
    expect(splitArgs('im +send --text "hello world"')).toEqual([
      'im',
      '+send',
      '--text',
      'hello world',
    ])
  })

  it('handles single-quoted values', () => {
    expect(splitArgs("docs +fetch --doc 'a b c'")).toEqual(['docs', '+fetch', '--doc', 'a b c'])
  })

  it('handles backslash escapes outside single quotes', () => {
    expect(splitArgs('echo a\\ b')).toEqual(['echo', 'a b'])
  })

  it('collapses repeated whitespace and empty input', () => {
    expect(splitArgs('  a   b  ')).toEqual(['a', 'b'])
    expect(splitArgs('')).toEqual([])
    expect(splitArgs('   ')).toEqual([])
  })

  it('keeps adjacent quotes empty token out (no empty tokens)', () => {
    expect(splitArgs('a "" b')).toEqual(['a', 'b'])
  })
})
