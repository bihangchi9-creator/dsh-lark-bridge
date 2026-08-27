/**
 * dsh-tool-lark-cli — expose the Feishu/Lark CLI (`lark-cli`) as a single
 * agent tool, so a preset's agent can operate Feishu (IM, docs, sheets,
 * calendar, …) through the deployment's lark-cli installation.
 *
 * Security posture:
 *   - commands are spawned as an **argv array, never a shell string**, so
 *     model-generated input cannot inject shell syntax;
 *   - an optional `allowedPrefixes` allowlist (empty = everything the logged-in
 *     lark-cli user can do; the bridge's access gate and trusted-chat model
 *     are the boundary);
 *   - output is capped and the process is killed on timeout, so a runaway
 *     command cannot OOM the host or blow the context window.
 *
 * Run-time requirements: `lark-cli` resolvable from PATH (or `bin` config),
 * and a completed `lark-cli config init` + `auth login` for the identity the
 * commands should act as.
 *
 * @module dsh-tool-lark-cli
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import spawn from 'cross-spawn'
import { splitArgs } from './split-args.js'

/** Cordis plugin name (the row id the preset mounts). */
export const name = 'tool-lark-cli'

/** The tool registry this plugin registers into. */
export const inject = ['tools']

export interface Config {
  /** lark-cli executable. Defaults to `lark-cli` resolved from PATH. */
  bin?: string
  /** Kill the child after this many ms. Default 60s. */
  timeoutMs?: number
  /** Cap of returned stdout+stderr characters. Default 100k. */
  maxOutputChars?: number
  /**
   * Optional command-prefix allowlist (each entry a full prefix, e.g.
   * `im +send`). Empty = every lark-cli command is allowed.
   */
  allowedPrefixes?: string[]
}

export const Config: z<Config> = z.object({
  bin: z.string().default('lark-cli'),
  timeoutMs: z.number().default(60_000),
  maxOutputChars: z.number().default(100_000),
  allowedPrefixes: z.array(z.string()).default([]),
})

type Resolved = Required<Config>

export function apply(ctx: Context, config: Config): void {
  const c = config as Resolved
  ctx.tools.register(defineTool({
    name: 'lark_cli',
    description:
      'Run a Feishu/Lark CLI (lark-cli) command. ' +
      'Operates the logged-in lark-cli identity: send/receive IM messages, ' +
      'read/write docs, sheets, calendar, tasks, drive files, etc. ' +
      'Pass the full command line as one string, e.g. ' +
      '`im +send --chat-id oc_xxx --text "hello"` or `docs +fetch --doc <token>`. ' +
      'Requires lark-cli to be installed and authenticated on this host.',
    parameters: {
      args: {
        type: 'string',
        required: true,
        description: 'The lark-cli command line to run (argv tokens, quotes allowed).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          output: { type: 'string', required: true },
          exitCode: { type: 'integer', required: true },
        },
      },
      render: (args, value) => [{ type: 'text', text: value.output }],
    },
    timeoutMs: c.timeoutMs,
    execute: async (args) => {
      const argv = splitArgs(args.args)
      if (argv.length === 0) throw new Error('lark_cli: empty command')
      const joined = argv.join(' ')
      if (c.allowedPrefixes.length > 0) {
        const allowed = c.allowedPrefixes.some(
          p => joined === p || joined.startsWith(`${p} `),
        )
        if (!allowed) {
          throw new Error(`lark_cli: command not allowed by prefix allowlist: ${joined}`)
        }
      }
      const { stdout, stderr, code } = await run(c.bin, argv, c.timeoutMs)
      let output = `${stdout}${stderr}`.trim()
      if (output.length > c.maxOutputChars) {
        output = `${output.slice(0, c.maxOutputChars)}\n…(truncated)`
      }
      if (code !== 0) {
        throw new Error(`lark_cli exited with code ${code}:\n${output.slice(0, 4000)}`)
      }
      return { output, exitCode: code }
    },
  }))
}

/** Spawn without a shell, collecting output, with a hard timeout. */
function run(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`lark_cli timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`lark_cli spawn failed: ${err.message}`))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, code: code ?? -1 })
    })
  })
}
