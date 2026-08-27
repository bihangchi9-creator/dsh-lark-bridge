/**
 * Tokenize model-generated input into an argv array. A backslash escapes only
 * whitespace, quotes, or another backslash; otherwise it is preserved so
 * Windows paths such as `C:\\Program Files\\Lark` remain intact.
 *
 * @module dsh-tool-lark-cli/split-args
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
