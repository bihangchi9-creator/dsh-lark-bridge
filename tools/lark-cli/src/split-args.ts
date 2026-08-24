/**
 * Tokenize a command line into argv tokens. No shell is involved — this only
 * parses model-generated input into an argument array, honoring single/double
 * quotes and backslash escapes. Kept dependency-free so it is unit-testable
 * in isolation.
 *
 * @module dsh-tool-lark-cli/split-args
 */

export function splitArgs(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let escaped = false
  for (const ch of input) {
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true
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
  if (escaped) current += '\\'
  if (current.length > 0) tokens.push(current)
  return tokens
}
