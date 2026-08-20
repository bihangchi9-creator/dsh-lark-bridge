/**
 * Per-chat workspace resolution: the "one group chat, one project folder" rule.
 *
 * Each Feishu chat id maps to a stable directory under the configured
 * workspace root. The directory is created on first use so the agent's `cwd`
 * always exists before it runs a tool.
 *
 * @module dsh-lark-bridge/workspace
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Sanitize a Feishu chat id into a filesystem-safe folder name. */
function safeName(chatId: string): string {
  // Feishu chat ids look like `oc_xxx`; keep them but strip anything odd.
  const cleaned = chatId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return cleaned.length > 0 ? cleaned : 'default'
}

/**
 * Resolve (and create) the project directory for a chat.
 * `<workspaceRoot>/<safe chatId>`.
 */
export async function resolveWorkspace(workspaceRoot: string, chatId: string): Promise<string> {
  const dir = join(workspaceRoot, safeName(chatId))
  await mkdir(dir, { recursive: true })
  return dir
}
