import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  downloadAttachments,
  safeAttachmentName,
  type AttachmentChannelLike,
} from '../src/attachments'

const dirs: string[] = []

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lark-attach-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('safeAttachmentName', () => {
  it('strips path separators and control chars', () => {
    expect(safeAttachmentName('../../etc/passwd', 'fb')).toBe('.._.._etc_passwd')
    expect(safeAttachmentName('a\u0000b\u001fc.txt', 'fb')).toBe('abc.txt')
  })

  it('caps length and falls back for empty or special path components', () => {
    expect(safeAttachmentName('x'.repeat(500), 'fb')).toHaveLength(120)
    expect(safeAttachmentName('   ', 'fb')).toBe('fb')
    expect(safeAttachmentName(undefined, 'fb')).toBe('fb')
    expect(safeAttachmentName('.', 'fb')).toBe('fb')
    expect(safeAttachmentName('..', 'fb')).toBe('fb')
  })
})

describe('downloadAttachments', () => {
  function fakeChannel(handlers: {
    onDownload?: (fileKey: string) => { bytesWritten: number; ok?: boolean }
  } = {}): AttachmentChannelLike {
    return {
      async downloadResourceToFile(_messageId, fileKey, _type, destPath) {
        const h = handlers.onDownload?.(fileKey)
        if (h?.ok === false) throw new Error('boom')
        writeFileSync(destPath, 'x'.repeat(h?.bytesWritten ?? 10))
        return { bytesWritten: h?.bytesWritten ?? 10 }
      },
    }
  }

  it('downloads images and files into the target dir', async () => {
    const dir = tmpDir()
    const channel = fakeChannel()
    const result = await downloadAttachments(channel, 'om_1', [
      { type: 'image', fileKey: 'fk-img', fileName: 'photo.png' },
      { type: 'file', fileKey: 'fk-doc', fileName: 'notes.txt' },
    ], dir)
    expect(result.accepted).toHaveLength(2)
    expect(result.accepted[0]).toMatchObject({ type: 'image', fileName: 'photo.png' })
    expect(result.accepted[1]).toMatchObject({ type: 'file', fileName: 'notes.txt' })
    for (const a of result.accepted) expect(existsSync(a.path)).toBe(true)
    expect(result.rejected).toHaveLength(0)
  })

  it('rejects oversized files and removes them from disk', async () => {
    const dir = tmpDir()
    const channel = fakeChannel({
      onDownload: () => ({ bytesWritten: 30 * 1024 * 1024 }), // > 20MB cap
    })
    const result = await downloadAttachments(channel, 'om_1', [
      { type: 'file', fileKey: 'fk-big', fileName: 'big.bin' },
    ], dir)
    expect(result.accepted).toHaveLength(0)
    expect(result.rejected).toMatchObject([{ fileName: 'big.bin' }])
    expect(result.rejected[0]!.reason).toContain('上限')
    expect(existsSync(join(dir, 'big.bin'))).toBe(false)
  })

  it('reports download failures without throwing', async () => {
    const dir = tmpDir()
    const channel = fakeChannel({ onDownload: () => ({ bytesWritten: 0, ok: false }) })
    const result = await downloadAttachments(channel, 'om_1', [
      { type: 'image', fileKey: 'fk-bad', fileName: 'bad.png' },
    ], dir)
    expect(result.accepted).toHaveLength(0)
    expect(result.rejected).toMatchObject([{ fileName: 'bad.png', reason: '下载失败' }])
  })

  it('caps the count per message and says so', async () => {
    const dir = tmpDir()
    const channel = fakeChannel()
    const resources = Array.from({ length: 8 }, (_, i) => ({
      type: 'file' as const,
      fileKey: `fk-${i}`,
      fileName: `f${i}.txt`,
    }))
    const result = await downloadAttachments(channel, 'om_1', resources, dir)
    expect(result.accepted).toHaveLength(5)
    expect(result.rejected[0]!.reason).toContain('上限')
  })

  it('returns empty for no resources', async () => {
    const dir = tmpDir()
    const result = await downloadAttachments(fakeChannel(), 'om_1', [], dir)
    expect(result.accepted).toHaveLength(0)
    expect(result.rejected).toHaveLength(0)
  })

  it('avoids name collisions within one message', async () => {
    const dir = tmpDir()
    const channel = fakeChannel()
    const result = await downloadAttachments(channel, 'om_1', [
      { type: 'image', fileKey: 'fk-a', fileName: 'same.png' },
      { type: 'image', fileKey: 'fk-b', fileName: 'same.png' },
    ], dir)
    expect(result.accepted).toHaveLength(2)
    expect(result.accepted[0]!.fileName).not.toBe(result.accepted[1]!.fileName)
  })

  it('isolates same-named attachments from different messages', async () => {
    const dir = tmpDir()
    const channel = fakeChannel()
    const first = await downloadAttachments(channel, 'om_1', [
      { type: 'file', fileKey: 'fk-a', fileName: 'same.txt' },
    ], dir)
    const second = await downloadAttachments(channel, 'om_2', [
      { type: 'file', fileKey: 'fk-b', fileName: 'same.txt' },
    ], dir)
    expect(first.accepted[0]!.path).not.toBe(second.accepted[0]!.path)
    expect(existsSync(first.accepted[0]!.path)).toBe(true)
    expect(existsSync(second.accepted[0]!.path)).toBe(true)
  })
})
