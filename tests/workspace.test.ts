import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveWorkspace } from '../src/workspace'

const dirs: string[] = []
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lark-workspace-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('resolveWorkspace containment', () => {
  it('creates a real chat directory beneath the configured root', async () => {
    const root = tmp()
    await expect(resolveWorkspace(root, 'oc_safe')).resolves.toBe(join(realpathSync(root), 'oc_safe'))
  })

  it('rejects a chat directory symlinked outside the configured root', async () => {
    const root = tmp()
    const outside = tmp()
    symlinkSync(outside, join(root, 'oc_escape'))
    await expect(resolveWorkspace(root, 'oc_escape')).rejects.toThrow(/symbolic link|escapes/)
  })
})
