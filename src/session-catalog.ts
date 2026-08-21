/**
 * Per-chat session catalog with policy fingerprints — P3 of the hardening
 * plan.
 *
 * Why fingerprints: dsh resumes a session by id from persistence, and the
 * bridge's session id is derived from the chat id, so a chat's context would
 * otherwise be reused even after its policy changed (accessMode tier, preset,
 * model, workspace). Resuming old context under new privileges is exactly the
 * confusion we must not have — so every session carries the fingerprint of
 * the policy it was created under, and resume only happens when the
 * fingerprint still matches. `/new` writes a sentinel fingerprint that never
 * matches, forcing a fresh generation.
 *
 * Session id layout: generation 0 uses the legacy bare id (`lark-<chatId>`)
 * so pre-upgrade logs are resumed once and then recorded; generation n > 0
 * uses `lark-<chatId>-<n>`.
 *
 * @module dsh-lark-bridge/session-catalog
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Sentinel fingerprint: never matches a real policy, so the next ensure rotates. */
export const RESET_FINGERPRINT = 'reset'

/** Entries older than this are dropped on load (unbounded growth guard). */
const ENTRY_TTL_MS = 90 * 24 * 60 * 60 * 1000

/** The policy dimensions a session's context was produced under. */
export interface PolicyInput {
  cwd: string
  /** Agent preset id mounted for this chat (undefined = deployment default). */
  preset?: string
  provider?: string
  model?: string
}

/** One catalog entry: which generation, under which policy. */
export interface CatalogEntry {
  gen: number
  fingerprint: string
  updatedAt: number
}

/** Deterministic short hash of the policy a session was created under. */
export function policyFingerprint(input: PolicyInput): string {
  const canonical = JSON.stringify({
    cwd: input.cwd,
    preset: input.preset ?? null,
    provider: input.provider ?? null,
    model: input.model ?? null,
  })
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

/**
 * The generation to use for a chat: no entry → 0 (legacy id); matching
 * fingerprint → keep the generation (resume); mismatch → bump (fresh id).
 */
export function nextGen(entry: CatalogEntry | undefined, fingerprint: string): number {
  if (!entry) return 0
  if (entry.fingerprint === fingerprint) return entry.gen
  return entry.gen + 1
}

/** The sentinel entry `/new` writes so the next ensure rotates generations. */
export function resetEntry(entry: CatalogEntry | undefined): CatalogEntry {
  return { gen: entry?.gen ?? 0, fingerprint: RESET_FINGERPRINT, updatedAt: Date.now() }
}

/** Build the session id for a chat and generation (gen 0 keeps the legacy id). */
export function sessionIdFor(chatId: string, gen: number): string {
  return gen === 0 ? `lark-${chatId}` : `lark-${chatId}-${gen}`
}

/**
 * Durable per-chat catalog. Loaded once at plugin start, persisted on every
 * mutation; unreadable/missing files start empty. Sync writes are fine — the
 * file is small and writes are rare (per session creation/reset).
 */
export class SessionCatalog {
  private data = new Map<string, CatalogEntry>()

  constructor(private readonly path: string) {
    this.load()
  }

  entryFor(chatId: string): CatalogEntry | undefined {
    return this.data.get(chatId)
  }

  set(chatId: string, entry: CatalogEntry): void {
    this.data.set(chatId, entry)
    this.persist()
  }

  delete(chatId: string): void {
    if (!this.data.delete(chatId)) return
    this.persist()
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, CatalogEntry>
      const now = Date.now()
      for (const [chatId, entry] of Object.entries(raw)) {
        if (typeof entry?.gen !== 'number' || typeof entry.fingerprint !== 'string') continue
        if (now - entry.updatedAt > ENTRY_TTL_MS) continue
        this.data.set(chatId, entry)
      }
    } catch {
      // Missing or malformed — start empty.
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      const payload = JSON.stringify(Object.fromEntries(this.data), null, 2) + '\n'
      writeFileSync(this.path, payload, { mode: 0o600 })
    } catch {
      // A lost catalog only costs a fresh session on the next restart.
    }
  }
}
