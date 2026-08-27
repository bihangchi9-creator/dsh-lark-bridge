/**
 * Tokenize a command line into argv tokens. No shell is involved — this only
 * parses configuration/model-generated input into an argument array, honoring
 * single/double quotes. A backslash escapes only whitespace, quotes, or another
 * backslash; otherwise it is preserved so Windows paths survive intact.
 *
 * @module dsh-lark-bridge/split-args
 */

export function splitArgs(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (ch === '\\' && quote !== "'") {
      const next = input[i + 1]
      if (next !== undefined && (/\s/.test(next) || next === '"' || next === "'" || next === '\\')) {
        current += next
        i++
      } else {
        current += '\\'
      }
      continue
    }
    if (quote !== undefined) {
      if (ch === quote) quote = undefined
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (current.length > 0) tokens.push(current)
  return tokens
}
