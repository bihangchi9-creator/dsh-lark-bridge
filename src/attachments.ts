/**
 * Message attachment support for lark-agent-bridge — images and files sent to
 * the bot are downloaded into the chat's own workspace and handed to the
 * agent as file paths (the agent reads images via `read_image`).
 *
 * Security posture:
 *   - attachments land in `<workspaceRoot>/<chatId>/.attachments/` — the
 *     per-chat jail, never outside it;
 *   - file names are sanitized (no separators, no control chars, length
 *     capped) so a hostile name cannot escape the directory;
 *   - size limits are enforced from `bytesWritten` after the stream (the SDK
 *     has no pre-download length); oversized files are deleted immediately;
 *   - a count cap per message with a loud rejection summary;
 *   - files older than a week are swept on each download (best-effort).
 *
 * @module lark-agent-bridge/attachments
 */

import { mkdir, lstat, readdir, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

/** Max attachments accepted from one message. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 5
/** Size cap for images (10 MB). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
/** Size cap for other files (20 MB). */
export const MAX_FILE_BYTES = 20 * 1024 * 1024
/** Attachment files older than this are swept on the next download (7 days). */
export const ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** The minimal channel surface `downloadAttachments` needs (structural, testable). */
export interface AttachmentChannelLike {
  downloadResourceToFile(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
    destPath: string,
  ): Promise<{ contentType?: string; bytesWritten: number }>
}

/** One inbound resource (subset of the SDK's ResourceDescriptor). */
export interface AttachmentResource {
  type: string
  fileKey: string
  fileName?: string
}

/** An attachment successfully downloaded into the chat workspace. */
export interface DownloadedAttachment {
  path: string
  type: 'image' | 'file'
  fileName: string
  bytes: number
}

/** Result of a download pass: what landed and what was rejected and why. */
export interface AttachmentResult {
  accepted: DownloadedAttachment[]
  rejected: Array<{ fileName?: string; reason: string }>
}

/** Sanitize a file name for local storage: no separators, no control chars. */
export function safeAttachmentName(fileName: string | undefined, fallback: string): string {
  const base = fileName?.trim()
  if (!base) return fallback
  const cleaned = base
    .replace(/[/\\]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 120)
  // `join(dir, '.')` and `join(dir, '..')` resolve to the directory itself or
  // its parent. Never allow these special path components as file names.
  return cleaned.length > 0 && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback
}

/**
 * Download a message's resources into `dir` (created if needed), enforcing
 * count/size limits and sweeping stale files. Never throws: per-attachment
 * failures become rejection entries.
 */
export async function downloadAttachments(
  channel: AttachmentChannelLike,
  messageId: string,
  resources: AttachmentResource[],
  dir: string,
  workspaceRoot = dir,
): Promise<AttachmentResult> {
  const accepted: DownloadedAttachment[] = []
  const rejected: Array<{ fileName?: string; reason: string }> = []
  if (resources.length === 0) return { accepted, rejected }

  // Images first, then other files, capped by count.
  const selected = [...resources].sort((a, b) =>
    a.type === 'image' && b.type !== 'image' ? -1 : a.type === b.type ? 0 : 1,
  ).slice(0, MAX_ATTACHMENTS_PER_MESSAGE)
  if (resources.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    rejected.push({
      reason: `附件数量超过上限（${MAX_ATTACHMENTS_PER_MESSAGE} 个），仅处理前 ${MAX_ATTACHMENTS_PER_MESSAGE} 个`,
    })
  }

  const safeRoot = await prepareAttachmentRoot(dir, workspaceRoot)
  if (!safeRoot) {
    return {
      accepted,
      rejected: [{ reason: '附件目录不安全（可能是符号链接），已拒绝写入' }],
    }
  }
  await sweepStaleAttachments(safeRoot)
  // Isolate each message so same-named files from later messages cannot
  // overwrite an earlier attachment the conversation may still reference.
  const messageDir = join(safeRoot, safeAttachmentName(messageId, `message-${Date.now()}`))
  try {
    await mkdir(messageDir, { recursive: false, mode: 0o700 })
  } catch {
    return { accepted, rejected: [{ reason: '无法创建隔离的附件目录' }] }
  }

  for (let i = 0; i < selected.length; i++) {
    const res = selected[i]!
    const kind: 'image' | 'file' = res.type === 'image' ? 'image' : 'file'
    const maxBytes = kind === 'image' ? MAX_IMAGE_BYTES : MAX_FILE_BYTES
    const fallback = `${kind}-${i + 1}${res.fileKey.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)}`
    let name = safeAttachmentName(res.fileName, fallback)
    // Avoid collisions between same-named attachments in one message.
    if (accepted.some(a => a.fileName === name)) name = `${i + 1}-${name}`
    const dest = join(messageDir, name)
    try {
      const { bytesWritten } = await channel.downloadResourceToFile(
        messageId,
        res.fileKey,
        kind,
        dest,
      )
      if (bytesWritten > maxBytes) {
        await rm(dest, { force: true }).catch(() => {})
        rejected.push({
          fileName: name,
          reason: `超过大小上限（${Math.round(maxBytes / 1024 / 1024)}MB）`,
        })
        continue
      }
      accepted.push({ path: dest, type: kind, fileName: name, bytes: bytesWritten })
    } catch {
      await rm(dest, { force: true }).catch(() => {})
      rejected.push({ fileName: name, reason: '下载失败' })
    }
  }
  return { accepted, rejected }
}

/** Create and verify a real directory root, refusing any symlink component at the leaf. */
async function prepareAttachmentRoot(dir: string, workspaceRoot: string): Promise<string | undefined> {
  try {
    // The workspace must already exist and resolve beneath the configured root.
    // This anchors containment even when a parent of `.attachments` is swapped
    // for a symlink by a workspace-write agent.
    const configuredRoot = await realpath(workspaceRoot)
    const existing = await lstat(dir).catch(() => undefined)
    if (existing?.isSymbolicLink()) return undefined
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const info = await lstat(dir)
    if (!info.isDirectory() || info.isSymbolicLink()) return undefined
    const resolved = await realpath(dir)
    return isInside(configuredRoot, resolved) ? resolved : undefined
  } catch {
    return undefined
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Best-effort sweep of attachment files older than the TTL without following symlinks. */
async function sweepStaleAttachments(dir: string): Promise<void> {
  try {
    const root = await realpath(dir)
    const now = Date.now()
    for (const entry of await readdir(root)) {
      const p = join(root, entry)
      if (!isInside(root, p)) continue
      try {
        const info = await lstat(p)
        if (info.isSymbolicLink()) {
          if (now - info.mtimeMs > ATTACHMENT_TTL_MS) await rm(p, { force: true })
          continue
        }
        if (now - info.mtimeMs > ATTACHMENT_TTL_MS) {
          await rm(p, { force: true, recursive: info.isDirectory() })
        }
      } catch {
        // Unreadable entry — leave it.
      }
    }
  } catch {
    // Directory unreadable — nothing to sweep.
  }
}
