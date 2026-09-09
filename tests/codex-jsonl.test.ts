import { describe, expect, it } from 'vitest'
import { CodexJsonlTranslator } from '../src/codex-jsonl'

describe('CodexJsonlTranslator', () => {
  it('captures thread id and emits final text + done', () => {
    const t = new CodexJsonlTranslator()
    expect(t.translate({ type: 'thread.started', thread_id: 'thr_1' })).toEqual([])
    expect(t.threadId).toBe('thr_1')
    expect(t.translate({ type: 'agent_message', message: 'hello' })).toEqual([])
    expect(t.translate({ type: 'turn.completed' })).toEqual([
      { type: 'final_text', content: 'hello' },
      { type: 'done', reason: 'completed' },
    ])
  })

  it('dedupes identical agent_message copies', () => {
    const t = new CodexJsonlTranslator()
    expect(t.translate({ type: 'agent_message', message: 'hi' })).toEqual([])
    expect(t.translate({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } })).toEqual([])
    expect(t.translate({ type: 'turn.completed' })).toEqual([
      { type: 'final_text', content: 'hi' },
      { type: 'done', reason: 'completed' },
    ])
  })

  it('emits tool_use / tool_result for command_execution', () => {
    const t = new CodexJsonlTranslator()
    expect(t.translate({
      type: 'item.started',
      item: { type: 'command_execution', id: 'c1', command: 'ls' },
    })).toEqual([{ type: 'tool_use', id: 'c1', name: 'command_execution' }])
    expect(t.translate({
      type: 'item.completed',
      item: { type: 'command_execution', id: 'c1', exit_code: 0 },
    })).toEqual([{ type: 'tool_result', id: 'c1', isError: false }])
  })

  it('maps turn.failed to an error event', () => {
    const t = new CodexJsonlTranslator()
    expect(t.translate({ type: 'turn.failed', message: 'boom' })).toEqual([
      { type: 'error', message: 'boom' },
    ])
  })
})
