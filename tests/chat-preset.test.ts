import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ChatPresetStore,
  isPresetId,
  presetNameFor,
  PUBLIC_PRESET_IDS,
} from '../src/chat-preset'

const dirs: string[] = []

function tmpStore(): { store: ChatPresetStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lark-preset-'))
  dirs.push(dir)
  const path = join(dir, 'chat-presets.json')
  return { store: new ChatPresetStore(path), path }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('preset vocabulary', () => {
  it('ships the three public tiers', () => {
    expect(PUBLIC_PRESET_IDS).toEqual(['workspace', 'read-only', 'full'])
  })

  it('accepts public ids and configured extras', () => {
    const extras = new Set(['internal'])
    expect(isPresetId('workspace', extras)).toBe(true)
    expect(isPresetId('full', extras)).toBe(true)
    expect(isPresetId('internal', extras)).toBe(true)
    expect(isPresetId('internal', new Set())).toBe(false)
    expect(isPresetId('standard', extras)).toBe(false)
  })

  it('maps ids to preset names (extras resolve from config, full = default)', () => {
    const extras = { internal: 'internal' }
    expect(presetNameFor('workspace', extras)).toBe('lark-workspace')
    expect(presetNameFor('read-only', extras)).toBe('lark-readonly')
    expect(presetNameFor('full', extras)).toBeUndefined()
    expect(presetNameFor('internal', extras)).toBe('internal')
  })
})

describe('ChatPresetStore', () => {
  it('starts empty, sets, clears', () => {
    const { store } = tmpStore()
    expect(store.get('oc_x')).toBeUndefined()
    store.set('oc_x', 'internal')
    expect(store.get('oc_x')).toBe('internal')
    store.clear('oc_x')
    expect(store.get('oc_x')).toBeUndefined()
  })

  it('persists across instances', () => {
    const { store, path } = tmpStore()
    store.set('oc_p', 'read-only')
    const reloaded = new ChatPresetStore(path)
    expect(reloaded.get('oc_p')).toBe('read-only')
  })

  it('survives malformed entries', () => {
    const { store, path } = tmpStore()
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(path, JSON.stringify({ presets: { oc_x: 42, oc_y: 'internal' } }))
    const reloaded = new ChatPresetStore(path)
    expect(reloaded.get('oc_x')).toBeUndefined()
    expect(reloaded.get('oc_y')).toBe('internal')
  })

  it('persisted file is valid JSON', () => {
    const { store, path } = tmpStore()
    store.set('oc_a', 'internal')
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { presets: Record<string, string> }
    expect(raw.presets.oc_a).toBe('internal')
  })
})
