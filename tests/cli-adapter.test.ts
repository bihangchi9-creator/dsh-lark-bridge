import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildCodexExecArgs,
  CliSpawnAdapter,
  resolveExecutablePath,
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
