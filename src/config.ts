/**
 * Plugin configuration for dsh-lark-bridge.
 *
 * Every field can be supplied two ways:
 *   1. Inline in the profile's `cordis.patch.yml` (a `config:` block under the
 *      `lark-bridge` row), or
 *   2. Environment variables (the default, friendlier path for end users).
 *
 * The Config schema below is what dsh validates; `resolveConfig` fills any
 * unset field from `process.env` so a bare install works with just the two
 * Feishu app secrets and a DeepSeek key exported in the shell.
 *
 * @module dsh-lark-bridge/config
 */

import Schema from '@deepseek-ai/schemastery'
import { readCredentials } from './credentials.js'

/** Tenant selects the Feishu (feishu.cn) vs Lark (larksuite.com) open domain. */
export type LarkTenant = 'feishu' | 'lark'

export interface LarkBridgeConfig {
  /** Feishu/Lark app id (`cli_...`). Falls back to `LARK_APP_ID`. */
  appId?: string
  /** Feishu/Lark app secret. Falls back to `LARK_APP_SECRET`. */
  appSecret?: string
  /** Which open-platform domain to use. Falls back to `LARK_TENANT`, default `feishu`. */
  tenant?: LarkTenant
  /** DeepSeek provider route for created agents. Falls back to `DSH_LARK_PROVIDER`. */
  provider?: string
  /** DeepSeek model for created agents. Falls back to `DSH_LARK_MODEL`. */
  model?: string
  /**
   * Root directory under which each group's project folder is created:
   * `<workspaceRoot>/<chatId>`. Falls back to `DSH_LARK_WORKSPACE_ROOT`,
   * default `~/dsh-lark-workspaces`.
   */
  workspaceRoot?: string
  /** Whether the agent may act in direct messages. Falls back to `DSH_LARK_ALLOW_DM`, default true. */
  allowDm?: boolean
  /** In group chats, require an @-mention of the bot to trigger. Default true. */
  requireMention?: boolean
  /**
   * Group chat ids (`oc_...`) allowed to drive the bot. Empty = no group
   * allowed (fail-closed). Falls back to `DSH_LARK_ALLOWED_CHATS`
   * (comma-separated).
   */
  allowedChats?: string[]
  /**
   * User open_ids allowed to drive the bot in DMs. Empty = no DM user
   * allowed (fail-closed). The app owner always passes regardless. Falls back
   * to `DSH_LARK_ALLOWED_USERS` (comma-separated).
   */
  allowedUsers?: string[]
}

export const Config: Schema<LarkBridgeConfig> = Schema.object({
  appId: Schema.string(),
  appSecret: Schema.string(),
  tenant: Schema.union(['feishu', 'lark'] as const),
  provider: Schema.string(),
  model: Schema.string(),
  workspaceRoot: Schema.string(),
  allowDm: Schema.boolean(),
  requireMention: Schema.boolean(),
  allowedChats: Schema.array(Schema.string()),
  allowedUsers: Schema.array(Schema.string()),
})

/** The fully-resolved config after environment fallback; secrets are guaranteed present. */
export interface ResolvedConfig {
  appId: string
  appSecret: string
  tenant: LarkTenant
  provider?: string
  model?: string
  workspaceRoot: string
  allowDm: boolean
  requireMention: boolean
  /** open_id of the app owner captured at registration, when known. */
  ownerId?: string
  allowedChats: string[]
  allowedUsers: string[]
}

/** Read a boolean-ish env var (`1/true/yes/on` = true), returning `fallback` when unset. */
function envBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback
  return /^(1|true|yes|on)$/i.test(value)
}

/**
 * Merge the validated plugin config with environment and saved-credential
 * fallbacks, returning `undefined` when the Feishu secrets are not yet
 * available anywhere. Precedence for the secrets: inline config → environment
 * variables → the file written by the registration wizard.
 *
 * Unlike {@link resolveConfig} this never throws on missing credentials: it is
 * the "have we been set up yet?" probe the plugin runs at boot, so a fresh
 * install can fall through to the auto-registration wizard instead of crashing.
 */
export function tryResolveConfig(config: LarkBridgeConfig): ResolvedConfig | undefined {
  const env = process.env
  const saved = readCredentials()
  const appId = config.appId ?? env.LARK_APP_ID ?? saved?.appId
  const appSecret = config.appSecret ?? env.LARK_APP_SECRET ?? saved?.appSecret
  if (!appId || !appSecret) return undefined
  const tenant = (config.tenant ?? env.LARK_TENANT ?? saved?.tenant ?? 'feishu') as LarkTenant
  const home = env.HOME ?? env.USERPROFILE ?? process.cwd()
  return {
    appId,
    appSecret,
    tenant,
    provider: config.provider ?? env.DSH_LARK_PROVIDER,
    model: config.model ?? env.DSH_LARK_MODEL,
    workspaceRoot:
      config.workspaceRoot ?? env.DSH_LARK_WORKSPACE_ROOT ?? `${home}/dsh-lark-workspaces`,
    allowDm: config.allowDm ?? envBool(env.DSH_LARK_ALLOW_DM, true),
    requireMention: config.requireMention ?? envBool(env.DSH_LARK_REQUIRE_MENTION, true),
    ownerId: saved?.ownerId,
    allowedChats: config.allowedChats ?? envList(env.DSH_LARK_ALLOWED_CHATS),
    allowedUsers: config.allowedUsers ?? envList(env.DSH_LARK_ALLOWED_USERS),
  }
}

/** Parse a comma-separated env list into a trimmed string array (empty when unset). */
function envList(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return []
  return value
    .split(',')
    .map(item => item.trim())
    .filter(item => item.length > 0)
}

/**
 * Merge the validated plugin config with environment and saved-credential
 * fallbacks. Precedence for the Feishu secrets: inline config → environment
 * variables → the file written by the `dsh-lark-register` wizard. Throws a
 * clear error if none supply them, so the failure surfaces at boot rather than
 * on the first inbound message.
 */
export function resolveConfig(config: LarkBridgeConfig): ResolvedConfig {
  const resolved = tryResolveConfig(config)
  if (resolved === undefined) {
    throw new Error(
      'dsh-lark-bridge: missing Feishu credentials. Run the `dsh-lark-register` wizard ' +
        'to create an app by QR, or set LARK_APP_ID and LARK_APP_SECRET ' +
        '(or appId/appSecret in the plugin config).',
    )
  }
  return resolved
}

/** The open-platform base URL for the selected tenant. */
export function domainFor(tenant: LarkTenant): string {
  return tenant === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
}
