/**
 * Saved-credentials storage for dsh-lark-bridge.
 *
 * The registration wizard ({@link module:dsh-lark-bridge/register}) writes the
 * Feishu app credentials it obtains here, and {@link resolveConfig} reads them
 * as a fallback. This lets a user run the one-time `dsh-lark-register` wizard,
 * scan a QR, and then launch the plugin with no manual credential handling.
 *
 * The file lives at `~/.dsh-lark-bridge/credentials.json` and is written with
 * owner-only (0600) permissions because it holds an app secret.
 *
 * @module dsh-lark-bridge/credentials
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { LarkTenant } from './config.js'

/** The persisted credential shape. */
export interface SavedCredentials {
  appId: string
  appSecret: string
  tenant: LarkTenant
  /**
   * open_id of the app owner, captured at registration (the person who
   * scanned the QR). Used by the access gate to bootstrap trust without any
   * pre-configuration. `undefined` for credentials written before this field
   * existed — the plugin backfills it at runtime via the app-info API.
   */
  ownerId?: string
  /** App/bot display name, captured at registration for nicer logs. */
  botName?: string
  /** Unix ms when these credentials were saved. */
  savedAt: number
}

/** Directory holding bridge state. Honors `DSH_LARK_HOME`, else `~/.dsh-lark-bridge`. */
export function bridgeHome(): string {
  return process.env.DSH_LARK_HOME ?? join(homedir(), '.dsh-lark-bridge')
}

/** Absolute path to the credentials file. */
export function credentialsPath(): string {
  return join(bridgeHome(), 'credentials.json')
}

/**
 * Absolute path to the pending-registration URL file.
 *
 * When the auto-registration wizard runs while dsh is detached (its terminal
 * QR code is not visible, e.g. a backgrounded `dsh web`), the raw registration
 * URL is written here so a user can open it in a browser instead. It is deleted
 * once registration completes. Purely a convenience artifact — never a secret.
 */
export function registerUrlPath(): string {
  return join(bridgeHome(), 'register-url.txt')
}

/** Write the pending-registration URL for out-of-band (browser) access. */
export function writeRegisterUrl(url: string): string {
  const path = registerUrlPath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${url}\n`, { mode: 0o600 })
  return path
}

/** Remove the pending-registration URL file, if present (post-registration cleanup). */
export function clearRegisterUrl(): void {
  try {
    rmSync(registerUrlPath(), { force: true })
  } catch {
    // Best-effort cleanup; a leftover URL file is harmless.
  }
}

/** Read saved credentials, or `undefined` when absent or unreadable. */
export function readCredentials(): SavedCredentials | undefined {
  try {
    const raw = readFileSync(credentialsPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<SavedCredentials>
    if (typeof parsed.appId === 'string' && typeof parsed.appSecret === 'string') {
      return {
        appId: parsed.appId,
        appSecret: parsed.appSecret,
        tenant: parsed.tenant === 'lark' ? 'lark' : 'feishu',
        ownerId: typeof parsed.ownerId === 'string' ? parsed.ownerId : undefined,
        botName: parsed.botName,
        savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
      }
    }
  } catch {
    // Missing or malformed — treated as "no saved credentials".
  }
  return undefined
}

/** Persist credentials with owner-only permissions, creating the dir as needed. */
export function writeCredentials(creds: Omit<SavedCredentials, 'savedAt'>): string {
  const path = credentialsPath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const payload: SavedCredentials = { ...creds, savedAt: Date.now() }
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
  return path
}

/**
 * Backfill (or update) the owner open_id in the saved credentials without
 * touching anything else. Used by the runtime owner resolver when the
 * app-info API returns an owner that registration did not capture.
 */
export function saveOwnerId(ownerId: string): void {
  const existing = readCredentials()
  if (!existing) return
  if (existing.ownerId === ownerId) return
  writeCredentials({ ...existing, ownerId })
}
