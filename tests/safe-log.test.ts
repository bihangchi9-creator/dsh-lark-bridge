import { describe, expect, it } from 'vitest'
import {
  createSafeSdkLogger,
  redactLogText,
  sanitizeLogValue,
  type LogFn,
} from '../src/safe-log'

describe('safe logging', () => {
  it('redacts credential-shaped strings', () => {
    const text =
      'Authorization: Bearer tenant-secret Cookie=session-secret ' +
      'app_secret=app-secret access_token=access-secret'
    const redacted = redactLogText(text)
    expect(redacted).not.toContain('tenant-secret')
    expect(redacted).not.toContain('session-secret')
    expect(redacted).not.toContain('app-secret')
    expect(redacted).not.toContain('access-secret')
    expect(redacted).toContain('[REDACTED]')
  })

  it('summarizes an Axios-style cyclic error without request secrets', () => {
    const error = new Error('request failed with Bearer message-secret') as Error & {
      isAxiosError: boolean
      code: string
      config: Record<string, unknown>
      response: Record<string, unknown>
      cause: unknown
    }
    error.isAxiosError = true
    error.code = 'ENOTFOUND'
    error.config = {
      url: 'https://open.feishu.cn/open-apis/application/v6/applications/cli_test',
      headers: {
        Authorization: 'Bearer header-secret',
        Cookie: 'cookie-secret',
      },
      appSecret: 'app-secret',
    }
    error.response = {
      status: 503,
      headers: { 'set-cookie': 'response-secret' },
    }
    error.cause = {
      message: 'getaddrinfo ENOTFOUND open.feishu.cn',
      hostname: 'open.feishu.cn',
      refreshToken: 'refresh-secret',
    }
    error.config.self = error

    const sanitized = sanitizeLogValue(error)
    const serialized = JSON.stringify(sanitized)
    for (const secret of [
      'message-secret',
      'header-secret',
      'cookie-secret',
      'app-secret',
      'response-secret',
      'refresh-secret',
    ]) {
      expect(serialized).not.toContain(secret)
    }
    expect(sanitized).toMatchObject({
      name: 'Error',
      message: 'request failed with Bearer [REDACTED]',
      code: 'ENOTFOUND',
      status: 503,
      hostname: 'open.feishu.cn',
    })
  })

  it('routes SDK logs through the same sanitizer', () => {
    const events: Array<{ level: string; message: string; extra?: unknown }> = []
    const log: LogFn = (level, message, extra) => {
      events.push({ level, message, extra })
    }
    const logger = createSafeSdkLogger(log)
    logger.error('[ws] request failed', {
      message: 'timeout Authorization: Bearer sdk-secret',
      code: 'ETIMEDOUT',
      config: {
        url: 'https://open.feishu.cn/open-apis/test',
        headers: { Authorization: 'Bearer nested-secret' },
      },
    })

    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain('sdk-secret')
    expect(serialized).not.toContain('nested-secret')
    expect(events).toEqual([
      {
        level: 'error',
        message: 'lark-sdk: [ws] request failed',
        extra: [
          {
            name: 'Error',
            message: 'timeout Authorization: [REDACTED]',
            code: 'ETIMEDOUT',
            hostname: 'open.feishu.cn',
          },
        ],
      },
    ])
  })

  it('redacts sensitive keys in ordinary metadata', () => {
    const sanitized = sanitizeLogValue({
      chatId: 'oc_safe',
      authorization: 'Bearer secret',
      nested: {
        accessToken: 'token-secret',
        count: 2,
      },
    })
    expect(sanitized).toEqual({
      chatId: 'oc_safe',
      authorization: '[REDACTED]',
      nested: {
        accessToken: '[REDACTED]',
        count: 2,
      },
    })
  })
})
