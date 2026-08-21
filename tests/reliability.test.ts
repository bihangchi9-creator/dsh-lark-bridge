import { describe, expect, it } from 'vitest'
import { splitLongText } from '../src/lark'

describe('splitLongText', () => {
  it('returns the text unchanged when it fits', () => {
    expect(splitLongText('short', 8000)).toEqual(['short'])
    expect(splitLongText('exactly-8000', 13)).toHaveLength(1)
  })

  it('cuts at newline boundaries, never mid-line', () => {
    const text = Array.from({ length: 20 }, (_, i) => `line-${i}-${'x'.repeat(30)}`).join('\n')
    const chunks = splitLongText(text, 200)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200 + 1)
    expect(chunks.join('')).toBe(text.replace(/^/m, '')) // no content loss (fence-free case)
    expect(chunks.join('')).toBe(text)
  })

  it('preserves content exactly when no fences are involved', () => {
    const text = 'a'.repeat(100) + '\n' + 'b'.repeat(100) + '\n' + 'c'.repeat(100)
    expect(splitLongText(text, 50).join('')).toBe(text)
  })

  it('closes and reopens code fences across chunk boundaries', () => {
    // One long code block, longer than the cap.
    const code = '```\n' + 'const x = 1;\n'.repeat(200) + '```'
    const chunks = splitLongText(code, 400)
    expect(chunks.length).toBeGreaterThan(1)
    // Every chunk except the last ends with a closed fence; the last ends with the original.
    for (const [i, c] of chunks.entries()) {
      if (i < chunks.length - 1) {
        expect(c.endsWith('```')).toBe(true)
      }
    }
    // Fences balance across the whole result.
    const total = chunks.join('')
    expect((total.match(/```/g) ?? []).length % 2).toBe(0)
    // Original fence markers survived (2), plus the close/reopen pairs.
    expect(total.split('```').length - 1).toBeGreaterThanOrEqual(2)
  })

  it('handles a fence that stays open until the very end', () => {
    const text = '```\n' + 'x'.repeat(1000)
    const chunks = splitLongText(text, 200)
    expect(chunks[chunks.length - 1].startsWith('```')).toBe(true)
    expect((chunks.join('').match(/```/g) ?? []).length % 2).toBe(0)
  })
})
