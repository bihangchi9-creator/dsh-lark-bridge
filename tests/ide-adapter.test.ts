import { createServer, type Server } from 'node:net'
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { IdeAttachAdapter } from '../src/ide-adapter'
import type { BridgeEvent } from '../src/dsh-binding'

const dirs: string[] = []
const servers: Server[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lark-ide-'))
  dirs.push(dir)
  return dir
}

async function listen(
  path: string,
  handler: (chunk: string, write: (line: string) => void, socket: import('node:net').Socket) => void,
): Promise<Server> {
  try { unlinkSync(path) } catch { /* first listen */ }
  const server = createServer(socket => {
    let buf = ''
    socket.on('data', chunk => {
      buf += chunk.toString('utf8')
      if (!buf.includes('\n')) return
      handler(buf, line => socket.write(`${line}\n`), socket)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.listen(path, () => resolve())
    server.on('error', reject)
  })
  return server
}

describe('IdeAttachAdapter', () => {
  it('is down when no socket exists — window closed', async () => {
    const adapter = new IdeAttachAdapter({ socketPath: '/tmp/definitely-missing-ide.sock' })
    await expect(adapter.isAvailable()).resolves.toBe(false)
    const events: BridgeEvent[] = []
    const session = await adapter.ensureSession('oc_1', '/tmp', event => events.push(event))
    session.send('hi')
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(events.some(event => event.type === 'error')).toBe(true)
    expect(events.some(event => event.type === 'done')).toBe(true)
  })

  it('streams BridgeEvent lines from a live sidecar', async () => {
    const dir = tmpDir()
    const socketPath = join(dir, 'ide.sock')
    await listen(socketPath, (_chunk, write) => {
      write(JSON.stringify({ type: 'text', delta: 'from-ide' }))
      write(JSON.stringify({ type: 'done', reason: 'completed' }))
    })
    const adapter = new IdeAttachAdapter({ socketPath })
    await expect(adapter.isAvailable()).resolves.toBe(true)
    const events: BridgeEvent[] = []
    const session = await adapter.ensureSession('oc_1', dir, event => events.push(event))
    session.send('hello')
    await new Promise<void>(resolve => setTimeout(resolve, 50))
    expect(events).toContainEqual({ type: 'text', delta: 'from-ide' })
    expect(events).toContainEqual({ type: 'done', reason: 'completed' })
  })

  it('fails closed if the window dies mid-turn', async () => {
    const dir = tmpDir()
    const socketPath = join(dir, 'ide.sock')
    await listen(socketPath, (_chunk, _write, socket) => {
      socket.destroy()
    })
    const adapter = new IdeAttachAdapter({ socketPath })
    const events: BridgeEvent[] = []
    const session = await adapter.ensureSession('oc_1', dir, event => events.push(event))
    session.send('hello')
    await new Promise<void>(resolve => setTimeout(resolve, 80))
    expect(events.some(event => event.type === 'error')).toBe(true)
    expect(events.some(event => event.type === 'done')).toBe(true)
  })
})
