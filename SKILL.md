---
name: lark-bridge
description: >-
  Bridge a local coding agent to Feishu/Lark group chats. Use when the user
  wants Feishu/Lark messages to drive dsh, a CLI agent (traex/claude/codex),
  an IDE window (Doubao/TRAE/Codex/Claude Code), or a custom agent. One group
  is one conversation pinned to one runtime. Multiple runtimes may be
  installed; they never silently replace each other.
---

# Lark Bridge

Connect Feishu / Lark chats to a local coding agent. **One group = one
conversation = one pinned runtime.**

This skill ships:

- **dsh plugin** (in-process, `pnpm setup` + `dsh web`)
- **CLI daemon** (`dsh-lark-bridge` / `node lib/daemon.js`) that **spawns**
  `traex` or `codex`
- **IDE attach**: Unix-socket JSONL sidecar (`LARK_BRIDGE_IDE_SOCKET`).
  Window closed / socket gone ⇒ this line is down; the pin is kept.
- **custom**: `LARK_BRIDGE_CUSTOM_ADAPTER` loads an ESM module that
  implements the adapter contract (`examples/custom-adapter.mjs`).

## Host classes

| Class | Examples | How Feishu is bridged |
|---|---|---|
| **dsh** | DeepSeek Harness | Cordis **plugin** inside the dsh process (this repo today) |
| **CLI** | `traex`, `claude`, `codex` | Separate gateway process **spawns** that binary (trae-to-lark shape) |
| **IDE** | Doubao, TRAE, Codex app, Claude Code | Separate gateway **attaches** that window. Closing the window **breaks this line**; that is expected |
| **custom** | in-house agent | Same adapter contract (spawn or attach) |

Never auto-fallback. If the pinned runtime is down, say so. Do not retarget
the chat to another agent.

Multiple runtimes may be installed. Each chat still has **one** conversation
on **one** line. Two groups can pin two different runtimes. One message is
never broadcast.

## External vs internal

- **External (this GitHub repo):** generic gateway + public adapters + this
  skill. No ByteDance overlay.
- **Internal:** local `internal/` overlay (gitignored) + AgentBuddy publish.
  Do not copy `internal/` into the public tree.

## dsh (live)

Treat dsh as a **plugin**, not a second daemon.

1. Confirm Node `^22.19.0 || >=24.0.0` and a dsh checkout / `dsh` on PATH.
2. From this repo: `pnpm setup` (or `pnpm install && pnpm build`, then
   `dsh plugin --profile web add link:$PWD`).
3. Launch: `DSH_PERMISSION_MODE=danger-full-access dsh web`.
4. First run without credentials opens the QR wizard. Scan with Feishu.
5. In chat: `/help`, `/new`, `/where`, `/models`, `/whoami`. Owner:
   `/model`, `/preset`, `/allow`, `/disallow`, `/agent`.

`/agent` shows or pins **this chat's** runtime. The dsh plugin installs only
`dsh`. The CLI daemon installs whatever of `traex` / `codex` is on PATH.
Pinning a missing id is rejected; an existing pin whose runtime later
disappears stays pinned and the turn fails closed.

## CLI daemon

Independent of dsh and of any IDE window.

1. `pnpm install && pnpm build`
2. Put `traex` and/or `codex` on PATH (or set `LARK_BRIDGE_TRAEX_BIN` /
   `LARK_BRIDGE_CODEX_BIN`).
3. `node lib/daemon.js` (or `npx dsh-lark-bridge` after install).
4. Optional: `LARK_BRIDGE_RUNTIME=traex` to choose the default pin.
5. Same QR wizard as the plugin if credentials are missing.

Each chat still has one conversation. Owner `/agent traex` or `/agent codex`
pins that chat; other chats can pin the other binary. Dead binary ⇒ that
chat errors, it does not move to dsh.

## IDE attach

The daemon **attaches** a sidecar over a Unix socket. It does not spawn a
new IDE.

1. IDE / sidecar listens on a Unix socket and speaks JSONL:
   inbound `{ type: "prompt", chatId, cwd, text }`, outbound BridgeEvent
   lines ending in `{ type: "done" }` or `{ type: "error" }`.
2. `LARK_BRIDGE_IDE_SOCKET=/path/to.sock node lib/daemon.js`
3. Owner `/agent ide` pins a chat to that window.
4. Closing the window (socket gone) fails that chat closed. Other chats on
   CLI stay up. Do not retarget.

ACP / app-server framing is not claimed; this is the attach contract.

## custom

1. Implement `AgentAdapter` (`src/adapter.ts`). See
   `examples/custom-adapter.mjs`.
2. `LARK_BRIDGE_CUSTOM_ADAPTER=/abs/path/to/adapter.mjs node lib/daemon.js`
3. Pin with `/agent <your-id>`.

## Rules

1. Ask which host class and which runtime id before installing extra lines.
2. Do not publish `internal/` or credentials.
3. CLI spawn and IDE JSONL attach are live. Do not invent ACP/app-server
   details beyond the Unix-socket JSONL contract in this skill.
4. Restarting a live dsh/daemon: tell the user first.
5. SSO / bytecli / TRAE internal models belong only to the internal overlay.
