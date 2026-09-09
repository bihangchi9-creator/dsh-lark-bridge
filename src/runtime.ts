/**
 * Per-chat runtime pins.
 *
 * A Feishu chat has one conversation on one runtime. Several runtimes may
 * be installed on the host; they never silently replace each other. If the
 * pinned runtime is missing or down (IDE window closed), the turn fails
 * closed instead of retargeting.
 *
 * @module dsh-lark-bridge/runtime
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AdapterAttach } from './adapter.js'
import { bridgeHome } from './credentials.js'

/** The four host classes this skill recognizes. */
export type RuntimeKind = 'dsh' | 'cli' | 'ide' | 'custom'

/** One installed runtime the gateway can pin a chat to. */
export interface RuntimeDescriptor {
  id: string
  kind: RuntimeKind
  displayName: string
  attach: AdapterAttach
}

/** The only runtime the dsh plugin ships today. */
export const DSH_RUNTIME: RuntimeDescriptor = {
  id: 'dsh',
  kind: 'dsh',
  displayName: 'DeepSeek Harness',
  attach: 'plugin',
}

/** Absolute path to the per-chat runtime pin file. */
export function chatRuntimePath(): string {
  return join(bridgeHome(), 'chat-runtimes.json')
}

export function isRuntimeId(value: string, installed: ReadonlySet<string>): boolean {
  return installed.has(value)
}

export function describeRuntime(
  id: string,
  installed: readonly RuntimeDescriptor[],
): RuntimeDescriptor | undefined {
  return installed.find(runtime => runtime.id === id)
}

/**
 * Resolve which runtime this chat should use.
 *
 * A pin always wins, even when that runtime is no longer installed — the
 * caller must then refuse the turn instead of falling back.
 */
export function resolveChatRuntime(
  chatId: string,
  pins: { get(chatId: string): string | undefined },
  installed: readonly RuntimeDescriptor[],
  fallbackId: string,
): { id: string; runtime: RuntimeDescriptor | undefined; pinned: boolean } {
  const pinned = pins.get(chatId)
  const id = pinned ?? fallbackId
  return { id, runtime: describeRuntime(id, installed), pinned: pinned !== undefined }
}

interface ChatRuntimeFile {
  runtimes: Record<string, string>
}

/** Durable per-chat runtime pins. Loaded at construction, persisted on mutation. */
export class ChatRuntimeStore {
  private readonly data = new Map<string, string>()

  constructor(private readonly path: string) {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as ChatRuntimeFile
      for (const [chatId, id] of Object.entries(raw.runtimes ?? {})) {
        if (typeof id === 'string' && id.length > 0) this.data.set(chatId, id)
      }
    } catch {
      // Missing or malformed — start empty.
    }
  }

  get(chatId: string): string | undefined {
    return this.data.get(chatId)
  }

  set(chatId: string, id: string): void {
    this.data.set(chatId, id)
    this.persist()
  }

  clear(chatId: string): void {
    if (!this.data.delete(chatId)) return
    this.persist()
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      const payload: ChatRuntimeFile = { runtimes: Object.fromEntries(this.data) }
      writeFileSync(this.path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
    } catch {
      // A lost pin only costs a fallback to the host default at next resolve.
    }
  }
}
