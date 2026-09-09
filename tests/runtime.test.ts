import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ChatRuntimeStore,
  DSH_RUNTIME,
  describeRuntime,
  isRuntimeId,
  resolveChatRuntime,
  type RuntimeDescriptor,
} from '../src/runtime'

const dirs: string[] = []

function tmpStore(): { store: ChatRuntimeStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lark-runtime-'))
  dirs.push(dir)
  const path = join(dir, 'chat-runtimes.json')
  return { store: new ChatRuntimeStore(path), path }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const traex: RuntimeDescriptor = {
  id: 'traex',
  kind: 'cli',
  displayName: 'TRAE CLI',
  attach: 'spawn',
}

const ide: RuntimeDescriptor = {
  id: 'trae-ide',
  kind: 'ide',
  displayName: 'TRAE window',
  attach: 'attach',
}

describe('runtime vocabulary', () => {
  it('ships dsh as the plugin runtime', () => {
    expect(DSH_RUNTIME).toEqual({
      id: 'dsh',
      kind: 'dsh',
      displayName: 'DeepSeek Harness',
      attach: 'plugin',
    })
  })

  it('accepts only installed ids', () => {
    const installed = new Set(['dsh', 'traex'])
    expect(isRuntimeId('dsh', installed)).toBe(true)
    expect(isRuntimeId('traex', installed)).toBe(true)
    expect(isRuntimeId('trae-ide', installed)).toBe(false)
  })
})

describe('resolveChatRuntime', () => {
  it('uses the host default when the chat has no pin', () => {
    const { store } = tmpStore()
    const resolved = resolveChatRuntime('oc_a', store, [DSH_RUNTIME], 'dsh')
    expect(resolved).toEqual({ id: 'dsh', runtime: DSH_RUNTIME, pinned: false })
  })

  it('lets a pin win over the host default', () => {
    const { store } = tmpStore()
    store.set('oc_a', 'traex')
    const resolved = resolveChatRuntime('oc_a', store, [DSH_RUNTIME, traex], 'dsh')
    expect(resolved).toEqual({ id: 'traex', runtime: traex, pinned: true })
  })

  it('keeps a pin even when that runtime is gone — no silent fallback', () => {
    const { store } = tmpStore()
    store.set('oc_a', 'trae-ide')
    const resolved = resolveChatRuntime('oc_a', store, [DSH_RUNTIME, traex], 'dsh')
    expect(resolved).toEqual({ id: 'trae-ide', runtime: undefined, pinned: true })
    expect(describeRuntime('trae-ide', [DSH_RUNTIME, traex])).toBeUndefined()
  })

  it('does not retarget a missing pin to another installed runtime', () => {
    const { store } = tmpStore()
    store.set('oc_a', 'trae-ide')
    const resolved = resolveChatRuntime('oc_a', store, [DSH_RUNTIME, traex, ide], 'dsh')
    expect(resolved.id).toBe('trae-ide')
    expect(resolved.runtime).toEqual(ide)
  })
})

describe('ChatRuntimeStore', () => {
  it('starts empty, sets, clears', () => {
    const { store } = tmpStore()
    expect(store.get('oc_x')).toBeUndefined()
    store.set('oc_x', 'dsh')
    expect(store.get('oc_x')).toBe('dsh')
    store.clear('oc_x')
    expect(store.get('oc_x')).toBeUndefined()
  })

  it('persists across instances', () => {
    const { store, path } = tmpStore()
    store.set('oc_p', 'traex')
    const reloaded = new ChatRuntimeStore(path)
    expect(reloaded.get('oc_p')).toBe('traex')
  })

  it('survives malformed entries', () => {
    const { path } = tmpStore()
    writeFileSync(path, JSON.stringify({ runtimes: { oc_x: 42, oc_y: 'dsh' } }))
    const reloaded = new ChatRuntimeStore(path)
    expect(reloaded.get('oc_x')).toBeUndefined()
    expect(reloaded.get('oc_y')).toBe('dsh')
  })

  it('persisted file is valid JSON', () => {
    const { store, path } = tmpStore()
    store.set('oc_a', 'dsh')
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { runtimes: Record<string, string> }
    expect(raw.runtimes.oc_a).toBe('dsh')
  })
})
