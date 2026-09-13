/**
 * Per-chat workspace resolution: the "one group chat, one project folder" rule.
 *
 * Each Feishu chat id maps to a stable directory under the configured
 * workspace root. The directory is created on first use so the agent's `cwd`
 * always exists before it runs a tool.
 *
 * @module lark-agent-bridge/workspace
 */

import { lstat, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

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
  await mkdir(workspaceRoot, { recursive: true })
  const root = await realpath(workspaceRoot)
  const dir = join(root, safeName(chatId))
  const existing = await lstat(dir).catch(() => undefined)
  if (existing?.isSymbolicLink()) throw new Error('chat workspace may not be a symbolic link')
  await mkdir(dir, { recursive: true })
  const resolved = await realpath(dir)
  const rel = relative(root, resolved)
  if (rel.startsWith('..') || rel === '..' || isAbsolute(rel)) {
    throw new Error('chat workspace escapes configured workspace root')
  }
  return resolved
}
