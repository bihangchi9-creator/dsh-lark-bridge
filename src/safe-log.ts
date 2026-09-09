/**
 * Safe logging for bridge and SDK errors.
 *
 * Third-party HTTP errors may contain complete request configs, including
 * Authorization headers and credentials. Never pass opaque objects directly
 * to console: reduce Error-like values to a small diagnostic summary and
 * recursively redact ordinary metadata.
 *
 * @module dsh-lark-bridge/safe-log
 */

export type LogLevel = 'info' | 'warn' | 'error'
export type LogFn = (level: LogLevel, msg: string, extra?: unknown) => void

const SENSITIVE_KEY = /authorization|cookie|secret|token|password|credential|api[-_]?key|app[-_]?secret/i
const MAX_DEPTH = 4
const MAX_ENTRIES = 30
const MAX_STRING = 2000

/** Redact credential-shaped substrings while preserving useful error text. */
export function redactLogText(value: string): string {
  return value
    .replace(
      /\b(authorization|cookie|set-cookie|app[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\b(\s*[:=]\s*)((?:Bearer|Basic)\s+)?[^\s,;]+/gi,
      '$1$2[REDACTED]',
    )
    .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, '$1 [REDACTED]')
    .slice(0, MAX_STRING)
}

/** Convert any log value into bounded, serializable, credential-safe data. */
export function sanitizeLogValue(value: unknown): unknown {
  return sanitize(value, new WeakSet<object>(), 0)
}

function sanitize(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === undefined || value === null || typeof value === 'boolean' || typeof value === 'number') {
    return value
  }
  if (typeof value === 'string') return redactLogText(value)
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
    return String(value)
  }
  if (depth >= MAX_DEPTH) return '[truncated]'
  if (typeof value !== 'object') return redactLogText(String(value))
  if (seen.has(value)) return '[circular]'
  seen.add(value)

  if (isErrorLike(value)) return summarizeError(value, seen, depth)
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ENTRIES).map(item => sanitize(item, seen, depth + 1))
  }

  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value).slice(0, MAX_ENTRIES)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitize(item, seen, depth + 1)
  }
  return out
}

function isErrorLike(value: object): value is Record<string, unknown> {
  return value instanceof Error || 'message' in value || 'isAxiosError' in value
}

function summarizeError(
  error: Record<string, unknown>,
  seen: WeakSet<object>,
  depth: number,
): Record<string, unknown> {
  const response = asRecord(error.response)
  const config = asRecord(error.config)
  const summary: Record<string, unknown> = {
    name: redactLogText(String(error.name ?? 'Error')),
    message: redactLogText(String(error.message ?? 'unknown error')),
  }
  addScalar(summary, 'code', error.code)
  addScalar(summary, 'status', error.status ?? response?.status)
  addScalar(summary, 'errno', error.errno)
  addScalar(summary, 'syscall', error.syscall)
  addScalar(summary, 'hostname', error.hostname)
  const url = typeof config?.url === 'string' ? config.url : undefined
  if (summary.hostname === undefined && url !== undefined) {
    try {
      summary.hostname = new URL(url).hostname
    } catch {
      // An invalid URL is not useful diagnostic data.
    }
  }
  if (error.cause !== undefined && error.cause !== error) {
    summary.cause = sanitize(error.cause, seen, depth + 1)
  }
  return summary
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function addScalar(target: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === 'string') target[key] = redactLogText(value)
  else if (typeof value === 'number' || typeof value === 'boolean') target[key] = value
}

/** Logger passed into @larksuite/channel and its underlying Feishu SDK. */
export function createSafeSdkLogger(log: LogFn): {
  error: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
  trace: (...args: unknown[]) => void
} {
  const emit = (level: LogLevel, args: unknown[]): void => {
    const [first, ...rest] = args
    const message = typeof first === 'string' ? redactLogText(first) : 'SDK event'
    const details = (typeof first === 'string' ? rest : args).map(sanitizeLogValue)
    log(level, `lark-sdk: ${message}`, details.length === 0 ? undefined : details)
  }
  return {
    error: (...args) => emit('error', args),
    warn: (...args) => emit('warn', args),
    info: (...args) => emit('info', args),
    debug: (...args) => emit('info', args),
    trace: (...args) => emit('info', args),
  }
}
