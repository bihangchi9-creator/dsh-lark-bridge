import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildCodexExecArgs,
  CliSpawnAdapter,
  resolveExecutablePath,
  sanitizeChildEnv,
  sandboxForPreset,
  TRAEX_RUNTIME,
} from '../src/cli-adapter'
import type { BridgeEvent } from '../src/dsh-binding'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lark-cli-'))
  dirs.push(dir)
  return dir
}

class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  constructor() {
    super()
    this.stdin.on('error', () => {})
  }
  kill(): boolean {
    this.exitCode = 0
    this.emit('close', 0, null)
    return true
  }
}

describe('buildCodexExecArgs', () => {
  it('starts a fresh exec over stdin', () => {
    expect(buildCodexExecArgs({ cwd: '/ws', sandbox: 'danger-full-access' })).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'danger-full-access',
      '-c',
      'approval_policy="never"',
      '-C',
      '/ws',
      '-',
    ])
  })

  it('resumes a thread by id', () => {
    const args = buildCodexExecArgs({
      cwd: '/ws',
      sandbox: 'workspace-write',
      threadId: 'thr_9',
    })
    expect(args).toContain('resume')
    expect(args).toContain('thr_9')
  })
})

describe('CLI security policy', () => {
  it('strips bridge and credential-shaped environment variables from children', () => {
    const env = sanitizeChildEnv({
      PATH: '/usr/bin',
      HOME: '/tmp/home',
      LANG: 'en_US.UTF-8',
      LARK_APP_SECRET: 'must-not-leak',
      OPENAI_API_KEY: 'agent-auth-is-required',
      CUSTOM_TOKEN_VALUE: 'must-not-leak',
      SAFE_FLAG: 'also-not-forwarded',
    })
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/tmp/home',
      LANG: 'en_US.UTF-8',
      OPENAI_API_KEY: 'agent-auth-is-required',
    })
  })

  it('maps only enforceable public presets and rejects unknown presets', () => {
    expect(sandboxForPreset('lark-readonly', 'workspace-write')).toBe('read-only')
    expect(sandboxForPreset('lark-workspace', 'read-only')).toBe('workspace-write')
    expect(sandboxForPreset(undefined, 'workspace-write')).toBe('workspace-write')
    expect(() => sandboxForPreset('bytedance', 'workspace-write')).toThrow(/cannot enforce preset/)
  })
})

describe('resolveExecutablePath', () => {
  it('finds a file on PATH', () => {
    const dir = tmp()
    const bin = join(dir, 'traex')
    writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 })
    expect(resolveExecutablePath('traex', dir)).toBe(bin)
  })

  it('returns undefined when missing', () => {
    expect(resolveExecutablePath('definitely-not-a-bin', '/tmp')).toBeUndefined()
  })
})

describe('CliSpawnAdapter', () => {
  it('does not spawn if disposed while availability is still resolving', async () => {
    const dir = tmp()
    let spawned = false
    const adapter = new CliSpawnAdapter({
      id: 'codex', displayName: 'Codex CLI', binary: 'codex', env: { PATH: dir },
      catalogPath: join(dir, 'catalog.json'), threadsPath: join(dir, 'threads.json'),
      spawnFn: (() => { spawned = true; return new FakeChild() as never }) as never,
    })
    let release: ((value: boolean) => void) | undefined
    vi.spyOn(adapter, 'isAvailable').mockImplementation(() => new Promise(resolve => { release = resolve }))
    const events: BridgeEvent[] = []
    const session = await adapter.ensureSession('oc_race', dir, event => events.push(event))
    session.send('race')
    await new Promise<void>(resolve => setImmediate(resolve))
    await adapter.dispose('oc_race')
    release?.(true)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(spawned).toBe(false)
    expect(events).toEqual([])
  })

  it('is unavailable when the binary is missing', async () => {
    const dir = tmp()
    const adapter = new CliSpawnAdapter({
      id: TRAEX_RUNTIME.id,
      displayName: TRAEX_RUNTIME.displayName,
      binary: 'missing-traex',
      env: { PATH: dir },
      catalogPath: join(dir, 'catalog.json'),
      threadsPath: join(dir, 'threads.json'),
    })
    await expect(adapter.isAvailable()).resolves.toBe(false)
  })

  it('spawns exec --json and translates a completed turn', async () => {
    const dir = tmp()
    const bin = join(dir, 'traex')
    writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 })
    let spawned: { command: string; args: string[] } | undefined
    const children: FakeChild[] = []
    const adapter = new CliSpawnAdapter({
      id: 'traex',
      displayName: 'TRAE CLI',
      binary: 'traex',
      env: { PATH: dir },
      catalogPath: join(dir, 'catalog.json'),
      threadsPath: join(dir, 'threads.json'),
      spawnFn: ((command, args) => {
        spawned = { command: String(command), args: args as string[] }
        const child = new FakeChild()
        children.push(child)
        return child as never
      }) as never,
    })
    await expect(adapter.isAvailable()).resolves.toBe(true)

    const events: BridgeEvent[] = []
    const session = await adapter.ensureSession('oc_1', dir, event => events.push(event))
    session.send('hello from feishu')
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(spawned?.command).toBe('traex')
    expect(spawned?.args[0]).toBe('exec')
    expect(spawned?.args).toContain('--json')
    expect(spawned?.args).toContain('workspace-write')

    children[0]!.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'thr_live' })}\n`)
    children[0]!.stdout.write(`${JSON.stringify({ type: 'agent_message', message: 'pong' })}\n`)
    children[0]!.stdout.write(`${JSON.stringify({ type: 'turn.completed' })}\n`)
    children[0]!.kill()
    await new Promise<void>(resolve => setImmediate(resolve))

    expect(events.some(event => event.type === 'final_text' && event.content === 'pong')).toBe(true)
    expect(events.some(event => event.type === 'done')).toBe(true)

    const events2: BridgeEvent[] = []
    const resumed = await adapter.ensureSession('oc_1', dir, event => events2.push(event))
    resumed.send('again')
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(spawned?.args).toContain('resume')
    expect(spawned?.args).toContain('thr_live')
    children[1]!.kill()
  })

  it('applies route sandbox and model to the spawned CLI', async () => {
    const dir = tmp()
    const bin = join(dir, 'codex')
    writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 })
    let spawned: { args: string[]; env?: NodeJS.ProcessEnv } | undefined
    let child: FakeChild | undefined
    const adapter = new CliSpawnAdapter({
      id: 'codex',
      displayName: 'Codex CLI',
      binary: 'codex',
      env: { PATH: dir, HOME: dir, LARK_APP_SECRET: 'secret' },
      catalogPath: join(dir, 'catalog.json'),
      threadsPath: join(dir, 'threads.json'),
      spawnFn: ((_command, args, options) => {
        spawned = { args: args as string[], env: options?.env as NodeJS.ProcessEnv }
        child = new FakeChild()
        return child as never
      }) as never,
    })
    const session = await adapter.ensureSession('oc_route', dir, () => {}, {
      preset: 'lark-readonly',
      sandbox: 'read-only',
      model: 'gpt-test',
    })
    session.send('inspect')
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(spawned?.args).toContain('read-only')
    expect(spawned?.args).toContain('--model')
    expect(spawned?.args).toContain('gpt-test')
    expect(spawned?.env?.LARK_APP_SECRET).toBeUndefined()
    child!.kill()
  })

  it('fails closed when a custom preset has no enforceable CLI sandbox', async () => {
    const dir = tmp()
    const bin = join(dir, 'codex')
    writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 })
    let spawned = false
    const adapter = new CliSpawnAdapter({
      id: 'codex', displayName: 'Codex CLI', binary: 'codex', env: { PATH: dir },
      catalogPath: join(dir, 'catalog.json'), threadsPath: join(dir, 'threads.json'),
      spawnFn: (() => { spawned = true; return new FakeChild() as never }) as never,
    })
    const events: BridgeEvent[] = []
    const session = await adapter.ensureSession('oc_custom', dir, event => events.push(event), {
      preset: 'internal-privileged',
    })
    session.send('must not run')
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(spawned).toBe(false)
    expect(events.some(event => event.type === 'error' && event.message.includes('cannot enforce preset'))).toBe(true)
  })

  it('treats a nonzero child exit as failure', async () => {
    const dir = tmp()
    const bin = join(dir, 'codex')
    writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 })
    let child: FakeChild | undefined
    const adapter = new CliSpawnAdapter({
      id: 'codex',
      displayName: 'Codex CLI',
      binary: 'codex',
      env: { PATH: dir },
      catalogPath: join(dir, 'catalog.json'),
      threadsPath: join(dir, 'threads.json'),
      spawnFn: (() => {
        child = new FakeChild()
        return child as never
      }) as never,
    })
    const events: BridgeEvent[] = []
    const session = await adapter.ensureSession('oc_fail', dir, event => events.push(event))
    session.send('fail')
    await new Promise<void>(resolve => setImmediate(resolve))
    child!.exitCode = 7
    child!.emit('close', 7, null)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(events.some(event => event.type === 'error')).toBe(true)
    expect(events.some(event => event.type === 'done' && event.reason === 'completed')).toBe(false)
  })

  it('reset drops the thread so the next turn is not a resume', async () => {
    const dir = tmp()
    const bin = join(dir, 'traex')
    writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 })
    let lastArgs: string[] = []
    const children: FakeChild[] = []
    const adapter = new CliSpawnAdapter({
      id: 'traex',
      displayName: 'TRAE CLI',
      binary: 'traex',
      env: { PATH: dir },
      catalogPath: join(dir, 'catalog.json'),
      threadsPath: join(dir, 'threads.json'),
      spawnFn: ((_command, args) => {
        lastArgs = args as string[]
        const child = new FakeChild()
        children.push(child)
        return child as never
      }) as never,
    })
    const session = await adapter.ensureSession('oc_2', dir, () => {})
    session.send('one')
    await new Promise<void>(resolve => setImmediate(resolve))
    children[0]!.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'thr_old' })}\n`)
    children[0]!.kill()
    await new Promise<void>(resolve => setImmediate(resolve))
    await adapter.reset('oc_2')
    const next = await adapter.ensureSession('oc_2', dir, () => {})
    next.send('two')
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(lastArgs).not.toContain('resume')
    children[1]!.kill()
  })
})
