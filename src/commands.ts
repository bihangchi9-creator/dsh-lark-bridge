/**
 * Slash-command parsing for the Feishu bridge.
 *
 * Commands are handled locally (never forwarded to the agent) and let a chat
 * manage its own session: reset context, inspect the working directory, switch
 * model, or read help. Anything not starting with `/` is an agent prompt.
 *
 * @module dsh-lark-bridge/commands
 */

/** A recognized command plus its raw argument tail. */
export type Command =
  | { kind: 'help' }
  | { kind: 'new' }
  | { kind: 'where' }
  | { kind: 'model'; value?: string }
  | { kind: 'preset'; value?: string }
  | { kind: 'allow' }
  | { kind: 'disallow' }
  | { kind: 'whoami' }
  | { kind: 'unknown'; name: string }

/** Parse leading-slash input into a {@link Command}, or `undefined` for a normal prompt. */
export function parseCommand(text: string): Command | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return undefined
  const [head, ...rest] = trimmed.slice(1).split(/\s+/)
  const name = (head ?? '').toLowerCase()
  const arg = rest.join(' ').trim()
  switch (name) {
    case 'help':
    case '?':
      return { kind: 'help' }
    case 'new':
    case 'reset':
    case 'clear':
      return { kind: 'new' }
    case 'where':
    case 'pwd':
    case 'dir':
      return { kind: 'where' }
    case 'model':
      return { kind: 'model', value: arg.length > 0 ? arg : undefined }
    case 'preset':
      return { kind: 'preset', value: arg.length > 0 ? arg : undefined }
    case 'allow':
      return { kind: 'allow' }
    case 'disallow':
      return { kind: 'disallow' }
    case 'whoami':
      return { kind: 'whoami' }
    default:
      return { kind: 'unknown', name }
  }
}

/** The help text shown for `/help`. */
export const HELP_TEXT = [
  '**dsh-lark-bridge** — DeepSeek Harness in Feishu',
  '',
  'Send any message to talk to the coding agent. This chat has its own project folder and its own conversation memory.',
  '',
  '**Commands**',
  '- `/help` — show this help',
  '- `/new` — start a fresh session (clears this chat\'s context)',
  '- `/where` — show this chat\'s project directory',
  '- `/model [name]` — show or switch the model for this chat',
  '- `/whoami` — show this chat\'s id and authorization state',
  '',
  '**Owner-only**',
  '- `/allow` — authorize the current group chat',
  '- `/disallow` — revoke the current group chat',
  '',
  'In a group chat, @-mention the bot to trigger it (unless mention is disabled).',
].join('\n')
