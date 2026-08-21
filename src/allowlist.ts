/**
 * Mutable, persisted allowlist for dsh-lark-bridge.
 *
 * The env/config allowlist (`DSH_LARK_ALLOWED_CHATS`) is read-only at
 * runtime; this store adds a command-managed layer (owner `/allow` /
 * `/disallow`) that persists to `~/.dsh-lark-bridge/allowlist.json` and
 * takes effect immediately — no restart needed. Effective access checks the
 * union of both layers.
 *
 * @module dsh-lark-bridge/allowlist
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { bridgeHome } from './credentials.js'

/** Absolute path to the command-managed allowlist file. */
export function allowlistPath(): string {
  return join(bridgeHome(), 'allowlist.json')
}

/** Persisted shape. */
interface AllowlistFile {
  chats: string[]
}

/**
 * Command-managed chat allowlist. Loaded once at construction, persisted on
 * every mutation; unreadable/missing files start empty. Sync writes are fine
 * — the file is tiny and writes are rare (owner commands only).
 */
export class AllowlistStore {
  private readonly chats = new Set<string>()

  constructor(private readonly path: string) {
    this.load()
  }

  hasChat(chatId: string): boolean {
    return this.chats.has(chatId)
  }

  chatIds(): string[] {
    return [...this.chats]
  }

  /** Add a chat; returns false when already present. */
  addChat(chatId: string): boolean {
    if (this.chats.has(chatId)) return false
    this.chats.add(chatId)
    this.persist()
    return true
  }

  /** Remove a chat; returns false when not present. */
  removeChat(chatId: string): boolean {
    if (!this.chats.delete(chatId)) return false
    this.persist()
    return true
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as AllowlistFile
      for (const chatId of raw.chats ?? []) {
        if (typeof chatId === 'string' && chatId.length > 0) this.chats.add(chatId)
      }
    } catch {
      // Missing or malformed — start empty.
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      const payload: AllowlistFile = { chats: [...this.chats].sort() }
      writeFileSync(this.path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
    } catch {
      // A lost allowlist only costs a re-authorization on the next start.
    }
  }
}
