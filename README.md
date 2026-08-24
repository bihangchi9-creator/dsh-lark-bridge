# dsh-lark-bridge

> A native [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-V3) (dsh) plugin that bridges dsh coding agents to **Feishu / Lark group chats** — *one group, one project folder*.

[中文 README](./README.zh.md)

Send a message in a Feishu chat, and a real dsh agent — with its own tools, its own project directory, and its own persistent conversation — answers you right there. Each group chat is an isolated workspace, so a team can run several projects in parallel, one per group.

---

## What it does

- **Feishu ⇄ dsh agent.** Inbound Feishu messages drive a live dsh agent through the host's `agents` service; the reply streams back onto a live-updating Feishu message.
- **One group, one project folder.** Every chat id maps to a stable directory (`<workspaceRoot>/<chatId>`), created on first use. Different groups never touch each other's files.
- **Persistent per-chat sessions.** A chat's conversation survives restarts (policy-fingerprint-gated resume-or-create; `/new` really clears it).
- **Images & files.** Just send them to the bot — the bridge downloads them into the chat's `.attachments/` folder and hands the paths to the agent (images via `read_image`). Limits: 5 attachments per message, images ≤10 MB, files ≤20 MB (over-limit attachments are rejected loudly); file names are sanitized; files older than 7 days are swept.
- **Zero-config setup.** On first launch, if no credentials exist, the plugin auto-runs a QR registration wizard — scan it in the Feishu app and it connects automatically. No portal spelunking.
- **Slash commands.** `/help`, `/new`, `/where`, `/model`, `/whoami` manage each chat locally; the owner can authorize/revoke a group in-chat with `/allow` and `/disallow`.

## Architecture in one picture

```
①  Feishu Open Platform            ← register a bot here (auto QR wizard does it for you)
        │  gives: app_id + app_secret
        ▼
②  dsh-lark-bridge  (this plugin)  ← holds the keys, opens a WebSocket to Feishu,
        │                             turns each message into an agent turn
        ▼
③  dsh host (DeepSeek Harness)     ← loads the plugin, provides the `agents` service
```

The bot **registration lives entirely on Feishu**, not in dsh. dsh only *loads this plugin*; the plugin then connects out to Feishu over a long-lived WebSocket (so no public IP or callback URL is needed).

---

## Requirements

- A working **DeepSeek Harness (dsh)** checkout you can launch with `dsh web`.
- **Node.js** `^22.19.0 || >=24.0.0`.
- A **DeepSeek API key** (set `DEEPSEEK_API_KEY`, or configure it in your dsh credentials).
- A **Feishu account** to scan the QR code (the wizard creates the app for you).

## Install

### Option 1: official `dsh plugin` command (recommended when dsh is installed)

```bash
# run from your dsh checkout; `link:` points at this project directory
dsh plugin --profile web add link:/path/to/dsh-lark-bridge
```

`dsh plugin` runs `pnpm add` in the profile directory and **auto-reconciles
`dsh.profile.bundles`**: a package that declares `dsh.bundle` joins the layer
stack automatically — installed and registered in one line, loaded after the
next restart, with no `--patch` and no manual config edits. Remove/update with
the same family: `dsh plugin --profile web remove dsh-lark-bridge` /
`dsh plugin --profile web update dsh-lark-bridge`.

### Option 2: one-command setup (recommended)

```bash
git clone https://github.com/bihangchi9-creator/dsh-lark-bridge.git
cd dsh-lark-bridge
pnpm setup            # macOS / Linux (scripts/setup.sh)
pnpm setup:win        # Windows (scripts/setup.ps1)
```

The script preflights your Node version, builds the plugin, links it into the
dsh profile, and **registers it as a bundle** (when `dsh` is on PATH it
delegates to Option 1's official command internally). After that, launch dsh
directly — **no `--patch` flag needed**:

```bash
# macOS / Linux
DSH_PERMISSION_MODE=danger-full-access dsh web

# Windows PowerShell
$env:DSH_PERMISSION_MODE = "danger-full-access"; dsh web
```

> Different profile: `DSH_PROFILE=headless pnpm setup`; custom dsh home: `DSH_HOME=/path/.dsh pnpm setup` (both env vars work on Windows too).

### Option 3: manual install (source mode)

Because the dsh public npm graph is still partial, install from source alongside your dsh checkout.

```bash
# 1. Clone next to your dsh checkout; install & build
git clone https://github.com/bihangchi9-creator/dsh-lark-bridge.git
cd dsh-lark-bridge
pnpm install
pnpm build            # compiles src/ -> lib/
```

Then register it as a dsh **bundle** (once it's in the profile, `dsh web` loads it automatically — no `--patch`):

```bash
# 2. Link it into the profile's node_modules (bundle resolution anchor)
#    macOS / Linux:
mkdir -p ~/.dsh/profiles/web/node_modules
ln -s "$(pwd)" ~/.dsh/profiles/web/node_modules/dsh-lark-bridge
#    Windows PowerShell (directory junction — no admin rights needed):
#    New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-lark-bridge" -Target (Get-Location).Path

# 3. Append the package name to dsh.profile.bundles in ~/.dsh/profiles/web/package.json:
#    "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-lark-bridge"]
```

Launch dsh (the bundle loads the plugin automatically):

```bash
# from your dsh checkout
DSH_PERMISSION_MODE=danger-full-access dsh web
```

> `DSH_PERMISSION_MODE=danger-full-access` makes the agent's approval policy `never`. This is needed because Feishu users cannot click through a local approval prompt. Only use it in an environment you trust.

## Platform notes (Windows vs macOS/Linux)

| Item | macOS / Linux | Windows |
|---|---|---|
| One-command setup | `pnpm setup` (`scripts/setup.sh`) | `pnpm setup:win` (`scripts/setup.ps1`) |
| dsh home directory | `~/.dsh` (i.e. `$HOME/.dsh`) | `%USERPROFILE%\.dsh` |
| Directory link | `ln -s` (symlink) | `New-Item -ItemType Junction` (junction — **no admin rights needed**) |
| Env var syntax | `DSH_PERMISSION_MODE=danger-full-access dsh web` | PowerShell: `$env:DSH_PERMISSION_MODE="danger-full-access"; dsh web`; cmd: `set DSH_PERMISSION_MODE=danger-full-access && dsh web` |
| Registration URL file | `~/.dsh-lark-bridge/register-url.txt` | `%USERPROFILE%\.dsh-lark-bridge\register-url.txt` |
| Run as a background service | `launchd` (macOS) / `systemd` (Linux) | Task Scheduler (`schtasks`) |
| QR registration / build / chat commands | identical everywhere | identical everywhere |

> The two setup scripts behave identically and are idempotent: preflight → build → link → register bundle.

## First run: register your bot

**Every user registers their own Feishu bot** — you cannot share an `app_secret`, as that hands over control of your bot.

On the first launch with no credentials, the plugin prints a **QR code** in the terminal (and writes the raw URL to `~/.dsh-lark-bridge/register-url.txt` for backgrounded runs). Steps:

1. Open the **Feishu mobile app**, scan the QR code.
2. Confirm creating a self-built app on your phone.
3. The plugin receives the credentials, saves them to `~/.dsh-lark-bridge/credentials.json`, and connects automatically.
4. Add the bot to a group (or DM it) and start talking.

Prefer to do it manually / re-register / switch accounts? Run the standalone wizard:

```bash
pnpm register           # or: npx dsh-lark-register
```

Already have credentials? Skip the wizard entirely by exporting them:

```bash
export LARK_APP_ID=cli_xxx
export LARK_APP_SECRET=yyy
export LARK_TENANT=feishu      # or `lark` for larksuite.com
```

---

## Using it in a chat

| Command | What it does |
|---|---|
| *(any text)* | A prompt to this chat's agent |
| `/help` | Show help |
| `/new` | Start a fresh session (clears this chat's context) |
| `/where` | Show this chat's project directory |
| `/model [name]` | Show or switch the model for this chat |
| `/whoami` | Show your identity and this chat's authorization state |
| `/allow` | (owner only, group chats) Authorize this chat to use the bot |
| `/disallow` | (owner only, group chats) Revoke this chat's authorization |

In a **group** chat, `@`-mention the bot to trigger it (unless mention is disabled). In a **DM**, just send a message.

## Configuration

Every field can come from the plugin `config:` block **or** an environment variable (env is the friendlier default).

| Config | Env var | Default | Meaning |
|---|---|---|---|
| `appId` | `LARK_APP_ID` | — | Feishu app id (`cli_...`) |
| `appSecret` | `LARK_APP_SECRET` | — | Feishu app secret |
| `tenant` | `LARK_TENANT` | `feishu` | `feishu` (feishu.cn) or `lark` (larksuite.com) |
| `provider` | `DSH_LARK_PROVIDER` | dsh default | LLM provider route |
| `model` | `DSH_LARK_MODEL` | dsh default | Model for created agents |
| `workspaceRoot` | `DSH_LARK_WORKSPACE_ROOT` | `~/dsh-lark-workspaces` | Root for per-chat folders |
| `allowDm` | `DSH_LARK_ALLOW_DM` | `true` | Respond in direct messages |
| `requireMention` | `DSH_LARK_REQUIRE_MENTION` | `true` | In groups, require an `@`-mention |
| `allowedChats` | `DSH_LARK_ALLOWED_CHATS` | `[]` | Chat ids allowed to use the bot (comma-separated). **Empty = no group allowed (fail-closed)** |
| `allowedUsers` | `DSH_LARK_ALLOWED_USERS` | `[]` | User open_ids allowed to DM the bot (comma-separated). **Empty = only the owner may DM** |

Credentials are read in this order: inline config → environment variables → the file written by the registration wizard.

## Access control (security model)

The bot's **security boundary is exactly "who may send it a message"**: every
message becomes an agent turn with host-level permissions, so access is
deny-by-default:

- **The owner always passes.** The person who scanned the QR at registration
  is the owner (open_id stored in `credentials.json`); older installs are
  backfilled automatically at startup via the app-info API.
- **Groups:** only chat ids listed in `DSH_LARK_ALLOWED_CHATS` may use the bot.
- **DMs:** only open_ids listed in `DSH_LARK_ALLOWED_USERS` may use the bot
  (owner always allowed).
- **Fail-closed:** with an unknown owner and empty allowlists, *every* message
  is denied — the denial reply includes the chat id so you can configure it.

Example:

```bash
# Allow groups oc_xxx1, oc_xxx2 and let ou_friend DM the bot
export DSH_LARK_ALLOWED_CHATS="oc_xxx1,oc_xxx2"
export DSH_LARK_ALLOWED_USERS="ou_friend"
```

> Runtime owner resolution needs the `application-info` scope; the
> registration wizard captures the open_id directly, so usually nothing extra
> is needed. **Any deployment reachable by people outside your team should
> configure the allowlists.**

## Access tiers (blast radius)

Even after the access gate passes, what an agent may touch is tiered
(`DSH_LARK_ACCESS_MODE`, default `workspace`):

| Tier | Preset | What the agent can do |
|---|---|---|
| `read-only` | `lark-readonly` | search/read files only — no writes, no shell, no network |
| `workspace` (default) | `lark-workspace` | read/write/edit files; **no shell, no network, no subagents** (no arbitrary code execution) |
| `full` | deployment default | everything the host offers (shell, network, subagents) |

Presets are dsh's *toolset compositions*: the host sandbox is identical for
every preset, so the enforceable difference between tiers is **which tools
exist**. The workspace tier removes the crown jewels of the attack surface —
arbitrary code execution, network egress, and delegation.

Install the presets into the harness-home user root (discovery is uncached):

```bash
mkdir -p ~/.dsh/.agent-presets
cp -r presets/lark-workspace presets/lark-readonly ~/.dsh/.agent-presets/
```

> Further host-level hardening: dsh's `workspace-write` permission preset
> (sandbox = writes inside the workspace, wider operations require approval)
> hard-bounds fs writes — but for remote users "wider" means "denied" (nobody
> can click the approval prompt), and it changes shell behavior, so verify it
> in your target deployment before enabling. The plugin-level tiers already
> remove shell/web/subagents, which is the highest value-per-risk change.

---

## Pairs well with lark-cli

If you already use [`lark-cli`](https://github.com/larksuite/cli) / the Lark skills to drive Feishu (docs, sheets, IM, calendar…), this plugin slots in beside it: keep using `lark-cli` for structured Feishu operations, and let **dsh-lark-bridge** be the conversational coding agent living in your group chats. You're very welcome to combine the two — for example, ask the agent in a group to draft something, then use `lark-cli` skills to push it into a Feishu doc.

## Troubleshooting

- **Bot says nothing / "(no output)"** — make sure a model is resolvable (dsh's default model service must be configured, or set `DSH_LARK_MODEL`).
- **"missing Feishu credentials"** — the wizard didn't complete; re-run `pnpm register` or export `LARK_APP_ID` / `LARK_APP_SECRET`.
- **QR not visible (backgrounded dsh)** — open the URL saved at `~/.dsh-lark-bridge/register-url.txt` in a browser.
- **Group messages ignored** — you must `@`-mention the bot, or set `DSH_LARK_REQUIRE_MENTION=false`.

## Credits

`dsh-lark-bridge` is a creative extension of [lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) (originally `feishu-claude-code-bridge`) by [zarazhangrui](https://github.com/zarazhangrui), by way of [trae-to-lark](https://github.com/bihangchi9-creator/trae-to-lark). This project is a native DeepSeek Harness plugin reimplementation. All original work remains under its MIT license; see [LICENSE](./LICENSE) and [NOTICE](./NOTICE) for the full copyright chain.

## License

[MIT](./LICENSE)
