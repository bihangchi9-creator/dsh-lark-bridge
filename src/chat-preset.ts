/**
 * Per-chat preset overrides for dsh-lark-bridge.
 *
 * `accessMode` (env) sets the default tier for every chat; `/preset` lets the
 * owner pin a specific chat to another tier. The shipped vocabulary is the
 * three public tiers; deployments may add more via `DSH_LARK_EXTRA_PRESETS`
 * (id:preset-name pairs) — e.g. an internal-only preset that stays out of the
 * public repo. Persisted to `~/.dsh-lark-bridge/chat-presets.json`.
 *
 * @module dsh-lark-bridge/chat-preset
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { bridgeHome } from './credentials.js'

/** The preset vocabulary shipped with the public plugin. */
export type PublicPresetId = 'workspace' | 'read-only' | 'full'

export const PUBLIC_PRESET_IDS: readonly PublicPresetId[] = [
  'workspace',
  'read-only',
  'full',
]

/** Map a public `/preset` id to the agent-preset name; `undefined` = deployment default. */
export const PUBLIC_PRESET_NAME_BY_ID: Record<PublicPresetId, string | undefined> = {
  workspace: 'lark-workspace',
  'read-only': 'lark-readonly',
  full: undefined,
}

/** Whether a value is a known preset id: public tiers plus configured extras. */
export function isPresetId(value: string, extras: ReadonlySet<string>): boolean {
  return (PUBLIC_PRESET_IDS as readonly string[]).includes(value) || extras.has(value)
}

/** Resolve a preset id (public or extra) to its agent-preset name. */
export function presetNameFor(id: string, extras: Record<string, string>): string | undefined {
  if ((PUBLIC_PRESET_IDS as readonly string[]).includes(id)) {
    return PUBLIC_PRESET_NAME_BY_ID[id as PublicPresetId]
  }
  return extras[id]
}

/** Absolute path to the per-chat preset overrides file. */
export function chatPresetPath(): string {
  return join(bridgeHome(), 'chat-presets.json')
}

/** Persisted shape. */
interface ChatPresetFile {
  presets: Record<string, string>
}

/** Durable per-chat preset overrides. Loaded at construction, persisted on mutation. */
export class ChatPresetStore {
  private readonly data = new Map<string, string>()

  constructor(private readonly path: string) {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as ChatPresetFile
      for (const [chatId, id] of Object.entries(raw.presets ?? {})) {
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
      const payload: ChatPresetFile = { presets: Object.fromEntries(this.data) }
      writeFileSync(this.path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
    } catch {
      // A lost override only costs a fallback to the accessMode default.
    }
  }
}
