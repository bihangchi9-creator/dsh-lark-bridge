/**
 * Message attachment support for dsh-lark-bridge — images and files sent to
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
 * @module dsh-lark-bridge/attachments
 */

import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

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
  return cleaned.length > 0 ? cleaned : fallback
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

  await mkdir(dir, { recursive: true }).catch(() => {})
  await sweepStaleAttachments(dir)

  for (let i = 0; i < selected.length; i++) {
    const res = selected[i]!
    const kind: 'image' | 'file' = res.type === 'image' ? 'image' : 'file'
    const maxBytes = kind === 'image' ? MAX_IMAGE_BYTES : MAX_FILE_BYTES
    const fallback = `${kind}-${i + 1}${res.fileKey.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)}`
    let name = safeAttachmentName(res.fileName, fallback)
    // Avoid collisions between same-named attachments in one message.
    if (accepted.some(a => a.fileName === name)) name = `${i + 1}-${name}`
    const dest = join(dir, name)
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

/** Best-effort sweep of attachment files older than the TTL. */
async function sweepStaleAttachments(dir: string): Promise<void> {
  try {
    const now = Date.now()
    for (const entry of await readdir(dir)) {
      const p = join(dir, entry)
      try {
        const info = await stat(p)
        if (info.isFile() && now - info.mtimeMs > ATTACHMENT_TTL_MS) {
          await rm(p, { force: true })
        }
      } catch {
        // Unreadable entry — leave it.
      }
    }
  } catch {
    // Directory unreadable — nothing to sweep.
  }
}
