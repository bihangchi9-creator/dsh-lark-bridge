/**
 * Translate Codex-family JSONL (`codex exec --json` / `traex exec --json`)
 * into the gateway's {@link BridgeEvent} stream.
 *
 * Protocol is the one trae-to-lark already ships against: thread/turn/item
 * events, plus a duplicated agent_message shape across versions.
 *
 * @module lark-agent-bridge/codex-jsonl
 */

import type { BridgeEvent } from './dsh-binding.js'

export class CodexJsonlTranslator {
  threadId: string | undefined
  private terminal = false
  private pendingAgentMessage: string | undefined

  translate(raw: unknown): BridgeEvent[] {
    if (this.terminal) return []
    if (!isRecord(raw) || typeof raw.type !== 'string') return []

    switch (raw.type) {
      case 'thread.started': {
        const threadId = stringValue(raw.thread_id ?? raw.threadId)
        if (threadId) this.threadId = threadId
        return []
      }
      case 'item.started': {
        const item = recordValue(raw.item)
        if (!item || item.type !== 'command_execution') return []
        const id = stringValue(item.id) ?? 'command'
        return this.flushPending([
          { type: 'tool_use', id, name: 'command_execution' },
        ])
      }
      case 'item.completed': {
        const item = recordValue(raw.item)
        if (!item) return []
        if (item.type === 'agent_message') {
          const message = stringValue(item.text ?? item.message)
          return message ? this.queueAgentMessage(message) : []
        }
        if (item.type !== 'command_execution') return []
        const id = stringValue(item.id) ?? 'command'
        const exitCode = numberValue(item.exit_code)
        return this.flushPending([
          { type: 'tool_result', id, isError: exitCode !== undefined && exitCode !== 0 },
        ])
      }
      case 'agent_message': {
        const message = stringValue(raw.message ?? raw.text)
        return message ? this.queueAgentMessage(message) : []
      }
      case 'turn.completed': {
        this.terminal = true
        const events: BridgeEvent[] = []
        if (this.pendingAgentMessage) {
          events.push({ type: 'final_text', content: this.pendingAgentMessage })
          this.pendingAgentMessage = undefined
        }
        events.push({ type: 'done', reason: 'completed' })
        return events
      }
      case 'turn.failed':
      case 'error': {
        this.terminal = true
        const message = stringValue(raw.message ?? raw.error) ?? 'codex turn failed'
        return this.flushPending([{ type: 'error', message }])
      }
      default:
        return []
    }
  }

  finish(reason: 'completed' | 'interrupted' | 'failed' = 'failed'): BridgeEvent[] {
    if (this.terminal) return []
    this.terminal = true
    const events = this.flushPending([])
    events.push(
      reason === 'failed'
        ? { type: 'error', message: 'cli stream ended before a terminal event' }
        : { type: 'done', reason },
    )
    return events
  }

  private queueAgentMessage(message: string): BridgeEvent[] {
    if (message === this.pendingAgentMessage) return []
    const events: BridgeEvent[] = this.pendingAgentMessage
      ? [{ type: 'text', delta: this.pendingAgentMessage }]
      : []
    this.pendingAgentMessage = message
    return events
  }

  private flushPending(events: BridgeEvent[]): BridgeEvent[] {
    if (!this.pendingAgentMessage) return events
    const pending = this.pendingAgentMessage
    this.pendingAgentMessage = undefined
    return [{ type: 'text', delta: pending }, ...events]
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
