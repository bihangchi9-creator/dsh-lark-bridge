/**
 * IDE attach adapter.
 *
 * Talks to an already-running IDE sidecar over a Unix socket (JSONL).
 * Closing the window (socket gone) makes {@link isAvailable} false; the
 * chat's pin stays, and the next turn fails closed instead of moving to
 * CLI/dsh.
 *
 * Protocol (one turn = one TCP/unix connection):
 *   gateway → { type: "prompt", chatId, cwd, text }
 *   sidecar → BridgeEvent JSON lines, ending with { type: "done" | "error" }
 *
 * @module lark-agent-bridge/ide-adapter
 */

import { lstatSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import type { AgentAdapter, AdapterRoute, BridgeEvent, BridgeSession } from './adapter.js'
import type { RuntimeDescriptor } from './runtime.js'

export const IDE_RUNTIME: RuntimeDescriptor = {
  id: 'ide',
  kind: 'ide',
  displayName: 'IDE window',
  attach: 'attach',
}

export interface IdeAttachAdapterOptions {
  id?: string
  displayName?: string
  /** Filesystem path of the IDE control socket. Missing ⇒ this line is down. */
  socketPath?: string
  connect?: typeof createConnection
}

interface LiveSession {
  cwd: string
  onEvent: (event: BridgeEvent) => void
  socket?: Socket
}

const EVENT_TYPES = new Set(['text', 'thinking', 'final_text', 'tool_use', 'tool_result', 'done', 'error'])
const MAX_IDE_JSONL_LINE_BYTES = 1024 * 1024
const MAX_EVENT_TEXT_CHARS = 256 * 1024

export class IdeAttachAdapter implements AgentAdapter {
  readonly id: string
  readonly kind = 'ide' as const
  readonly displayName: string
  readonly attach = 'attach' as const
  private readonly socketPath: string | undefined
  private readonly connectFn: typeof createConnection
  private readonly sessions = new Map<string, LiveSession>()

  constructor(opts: IdeAttachAdapterOptions = {}) {
    this.id = opts.id ?? IDE_RUNTIME.id
    this.displayName = opts.displayName ?? IDE_RUNTIME.displayName
    this.socketPath = opts.socketPath ?? process.env.LARK_BRIDGE_IDE_SOCKET
    this.connectFn = opts.connect ?? createConnection
  }

  async isAvailable(): Promise<boolean> {
    if (!this.socketPath) return false
    try {
      const info = lstatSync(this.socketPath)
      if (!info.isSocket() || info.isSymbolicLink()) return false
      if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return false
      // Group/other writable sockets allow unrelated local users to impersonate
      // the IDE sidecar. Require owner-only write access.
      if ((info.mode & 0o022) !== 0) return false
      return true
    } catch {
      return false
    }
  }

  async ensureSession(
    chatId: string,
    cwd: string,
    onEvent: (event: BridgeEvent) => void,
    _routeOverride?: AdapterRoute,
  ): Promise<BridgeSession> {
    const existing = this.sessions.get(chatId)
    if (existing) {
      existing.onEvent = onEvent
      existing.cwd = cwd
      return this.toHandle(chatId)
    }
    this.sessions.set(chatId, { cwd, onEvent })
    return this.toHandle(chatId)
  }

  async dispose(chatId: string): Promise<void> {
    const session = this.sessions.get(chatId)
    session?.socket?.destroy()
    this.sessions.delete(chatId)
  }

  async reset(chatId: string): Promise<void> {
    await this.dispose(chatId)
  }

  async disposeAll(): Promise<void> {
    const ids = [...this.sessions.keys()]
    await Promise.allSettled(ids.map(id => this.dispose(id)))
  }

  private toHandle(chatId: string): BridgeSession {
    return {
      sessionId: `${this.id}-${chatId}`,
      send: (text: string) => {
        void this.runTurn(chatId, text)
      },
      dispose: () => this.dispose(chatId),
    }
  }

  private async runTurn(chatId: string, text: string): Promise<void> {
    const session = this.sessions.get(chatId)
    if (!session) return
    const available = await this.isAvailable()
    if (this.sessions.get(chatId) !== session) return
    if (!available || !this.socketPath) {
      session.onEvent({
        type: 'error',
        message: `${this.displayName} window is down; this line is not retargeted`,
      })
      session.onEvent({ type: 'done', reason: 'failed' })
      return
    }
    if (session.socket) {
      session.onEvent({ type: 'error', message: `${this.id} already has a turn in flight` })
      return
    }

    const socket = this.connectFn({ path: this.socketPath })
    session.socket = socket
    let terminal = false
    const finish = (events: BridgeEvent[] = []): void => {
      if (terminal) return
      terminal = true
      session.socket = undefined
      for (const event of events) session.onEvent(event)
      socket.destroy()
    }

    socket.on('error', err => {
      finish([
        { type: 'error', message: err.message },
        { type: 'done', reason: 'failed' },
      ])
    })
    socket.on('close', () => {
      if (!terminal) {
        finish([
          { type: 'error', message: `${this.displayName} window closed during the turn` },
          { type: 'done', reason: 'failed' },
        ])
      }
    })

    let buffer = ''
    socket.on('data', chunk => {
      if (terminal) return
      buffer += chunk.toString('utf8')
      if (Buffer.byteLength(buffer) > MAX_IDE_JSONL_LINE_BYTES && !buffer.includes('\n')) {
        finish([
          { type: 'error', message: 'IDE sidecar emitted an oversized JSONL line' },
          { type: 'done', reason: 'failed' },
        ])
        return
      }
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const trimmed = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!trimmed) continue
        if (Buffer.byteLength(trimmed) > MAX_IDE_JSONL_LINE_BYTES) {
          finish([
            { type: 'error', message: 'IDE sidecar emitted an oversized JSONL line' },
            { type: 'done', reason: 'failed' },
          ])
          return
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(trimmed)
        } catch {
          continue
        }
        const event = asBridgeEvent(parsed)
        if (!event) continue
        session.onEvent(event)
        if (event.type === 'done' || event.type === 'error') {
          if (event.type === 'error') session.onEvent({ type: 'done', reason: 'failed' })
          terminal = true
          session.socket = undefined
          socket.destroy()
          return
        }
      }
    })

    socket.write(`${JSON.stringify({ type: 'prompt', chatId, cwd: session.cwd, text })}\n`)
  }
}

function asBridgeEvent(value: unknown): BridgeEvent | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const type = (value as { type?: unknown }).type
  if (typeof type !== 'string' || !EVENT_TYPES.has(type)) return undefined
  const event = value as Record<string, unknown>
  for (const key of ['delta', 'content', 'message', 'name', 'reason']) {
    const field = event[key]
    if (typeof field === 'string' && field.length > MAX_EVENT_TEXT_CHARS) return undefined
  }
  return value as BridgeEvent
}
