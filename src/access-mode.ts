/**
 * Access-mode tiers for dsh-lark-bridge — how much of the host an agent
 * created from a Feishu chat may touch.
 *
 * The blast radius of an agent turn is bounded by the *toolset* it mounts:
 * the host sandbox/approval stack is host-plane and identical for every
 * preset, so the enforceable difference between tiers is which tools exist.
 * The crown jewel of the attack surface is arbitrary code execution and
 * network egress, so the default tier removes both.
 *
 *   read-only | lark-readonly  | search/read only — no writes, no shell
 *   workspace | lark-workspace | file editing in the group's folder, no shell,
 *             |                | no network, no subagents (default)
 *   full      | (deployment default) | everything the host offers
 *
 * Pure module on purpose (no imports): unit-testable without any dsh or
 * Feishu machinery.
 *
 * @module dsh-lark-bridge/access-mode
 */

/** The three privilege tiers. */
export type AccessMode = 'read-only' | 'workspace' | 'full'

/** The agent-preset id to mount for each tier; `undefined` = deployment default. */
export const PRESET_BY_ACCESS_MODE: Record<AccessMode, string | undefined> = {
  'read-only': 'lark-readonly',
  workspace: 'lark-workspace',
  full: undefined,
}

/**
 * Parse a raw access-mode value (config field or env var). Unknown values
 * throw a clear error so a typo never silently downgrades security.
 */
export function parseAccessMode(raw: string | undefined, fallback: AccessMode): AccessMode {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = raw.trim().toLowerCase()
  if (value === 'read-only' || value === 'workspace' || value === 'full') return value
  throw new Error(
    `dsh-lark-bridge: invalid accessMode ${JSON.stringify(raw)} — ` +
      `expected one of: read-only, workspace, full`,
  )
}
