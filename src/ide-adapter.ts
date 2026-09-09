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

import { accessSync, constants } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { createInterface } from 'node:readline'
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
      accessSync(this.socketPath, constants.R_OK)
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
    if (!(await this.isAvailable()) || !this.socketPath) {
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

    const rl = createInterface({ input: socket })
    rl.on('line', line => {
      const trimmed = line.trim()
      if (!trimmed) return
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        return
      }
      const event = asBridgeEvent(parsed)
      if (!event) return
      session.onEvent(event)
      if (event.type === 'done' || event.type === 'error') {
        if (event.type === 'error') session.onEvent({ type: 'done', reason: 'failed' })
        terminal = true
        session.socket = undefined
        socket.destroy()
      }
    })

    socket.write(`${JSON.stringify({ type: 'prompt', chatId, cwd: session.cwd, text })}\n`)
  }
}

function asBridgeEvent(value: unknown): BridgeEvent | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const type = (value as { type?: unknown }).type
  if (typeof type !== 'string' || !EVENT_TYPES.has(type)) return undefined
  return value as BridgeEvent
}
