/**
 * Load a user-supplied adapter module for the standalone daemon.
 *
 * The module is ordinary ESM/CJS. It must export one of:
 *   - `adapter` — an {@link AgentAdapter}
 *   - `createAdapter()` — factory returning an adapter (sync or async)
 *   - `default` — adapter or factory
 *
 * Set `LARK_BRIDGE_CUSTOM_ADAPTER` to the module path. The adapter's `id`
 * is what `/agent` pins; kind should be `custom` (spawn or attach).
 *
 * @module lark-agent-bridge/custom-adapter
 */

import { pathToFileURL } from 'node:url'
import type { AgentAdapter } from './adapter.js'

export async function loadCustomAdapter(specifier: string): Promise<AgentAdapter> {
  const url = specifier.startsWith('file:')
    ? specifier
    : pathToFileURL(specifier).href
  const mod: Record<string, unknown> = await import(url)
  const candidate = mod.adapter ?? mod.default ?? mod.createAdapter
  const adapter = await resolveCandidate(candidate)
  assertAdapter(adapter, specifier)
  return adapter
}

async function resolveCandidate(value: unknown): Promise<unknown> {
  if (typeof value === 'function') return value()
  return value
}

function assertAdapter(value: unknown, specifier: string): asserts value is AgentAdapter {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`custom adapter ${specifier} did not export an adapter object`)
  }
  const adapter = value as Partial<AgentAdapter>
  for (const key of ['id', 'kind', 'displayName', 'attach'] as const) {
    if (adapter[key] === undefined) {
      throw new Error(`custom adapter ${specifier} is missing ${key}`)
    }
  }
  for (const key of ['isAvailable', 'ensureSession', 'dispose', 'reset', 'disposeAll'] as const) {
    if (typeof adapter[key] !== 'function') {
      throw new Error(`custom adapter ${specifier} is missing ${key}()`)
    }
  }
}
