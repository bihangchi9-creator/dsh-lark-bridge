import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AllowlistStore } from '../src/allowlist'

const dirs: string[] = []

function tmpStore(): { store: AllowlistStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lark-allowlist-'))
  dirs.push(dir)
  const path = join(dir, 'allowlist.json')
  return { store: new AllowlistStore(path), path }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('AllowlistStore', () => {
  it('starts empty for a missing file', () => {
    const { store } = tmpStore()
    expect(store.chatIds()).toEqual([])
    expect(store.hasChat('oc_x')).toBe(false)
  })

  it('adds and removes chats', () => {
    const { store } = tmpStore()
    expect(store.addChat('oc_a')).toBe(true)
    expect(store.addChat('oc_a')).toBe(false) // already present
    expect(store.hasChat('oc_a')).toBe(true)
    expect(store.removeChat('oc_a')).toBe(true)
    expect(store.removeChat('oc_a')).toBe(false)
    expect(store.hasChat('oc_a')).toBe(false)
  })

  it('persists across instances', () => {
    const { store, path } = tmpStore()
    store.addChat('oc_persist')
    const reloaded = new AllowlistStore(path)
    expect(reloaded.hasChat('oc_persist')).toBe(true)
    expect(reloaded.chatIds()).toEqual(['oc_persist'])
  })

  it('survives malformed files as empty', () => {
    const { store, path } = tmpStore()
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(path, 'not json{{{')
    const reloaded = new AllowlistStore(path)
    expect(reloaded.chatIds()).toEqual([])
  })

  it('persisted file is valid JSON with sorted chats', () => {
    const { store, path } = tmpStore()
    store.addChat('oc_b')
    store.addChat('oc_a')
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { chats: string[] }
    expect(raw.chats).toEqual(['oc_a', 'oc_b'])
  })
})
