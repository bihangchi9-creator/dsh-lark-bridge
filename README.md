# dsh-lark-bridge

> A native [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-V3) (dsh) plugin that bridges dsh coding agents to **Feishu / Lark group chats** — *one group, one project folder*.

[中文 README](./README.zh.md)

Send a message in a Feishu chat, and a real dsh agent — with its own tools, its own project directory, and its own persistent conversation — answers you right there. Each group chat is an isolated workspace, so a team can run several projects in parallel, one per group.

---

## What it does

- **Feishu ⇄ dsh agent.** Inbound Feishu messages drive a live dsh agent through the host's `agents` service; the reply streams back onto a live-updating Feishu message.
- **One group, one project folder.** Every chat id maps to a stable directory (`<workspaceRoot>/<chatId>`), created on first use. Different groups never touch each other's files.
- **Persistent per-chat sessions.** A chat's conversation survives restarts (resume-or-create on a fixed per-chat session id).
- **Zero-config setup.** On first launch, if no credentials exist, the plugin auto-runs a QR registration wizard — scan it in the Feishu app and it connects automatically. No portal spelunking.
- **Slash commands.** `/help`, `/new`, `/where`, `/model` manage each chat locally.

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

Because the dsh public npm graph is still partial, install from source alongside your dsh checkout.

```bash
# 1. Clone next to your dsh checkout
git clone https://github.com/bihangchi9-creator/dsh-lark-bridge.git
cd dsh-lark-bridge

# 2. Install & build
pnpm install
pnpm build            # compiles src/ -> lib/
```

Then tell dsh to load it. Add the plugin row to the profile you launch (or reuse the shipped patch):

```yaml
# cordis.patch.yml  (already provided by this package)
- insert:
    - id: lark-bridge
      name: dsh-lark-bridge
      inject: [agents, sessions, agentPresets, agentDefaultModel]
```

Launch dsh with the patch:

```bash
# from your dsh checkout
DSH_PERMISSION_MODE=danger-full-access \
  dsh web --patch /path/to/dsh-lark-bridge/cordis.patch.yml
```

> `DSH_PERMISSION_MODE=danger-full-access` makes the agent's approval policy `never`. This is needed because Feishu users cannot click through a local approval prompt. Only use it in an environment you trust.

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

Credentials are read in this order: inline config → environment variables → the file written by the registration wizard.

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
