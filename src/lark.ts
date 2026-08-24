/**
 * The Feishu/Lark surface: connect a channel, route inbound messages to a
 * per-chat dsh agent, and stream the agent's reply back as a live-updating
 * message.
 *
 * This is the plugin's "external protocol driver" in dsh terms: Feishu is the
 * wire peer, {@link DshBinding} is the agent factory, and each group chat maps
 * to one long-lived session with its own project directory.
 *
 * @module dsh-lark-bridge/lark
 */

import type { LarkChannel, LarkChannelOptions, NormalizedMessage } from '@larksuite/channel'
import { createLarkChannel } from '@larksuite/channel'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { decideAccess } from './access.js'
import { AllowlistStore, allowlistPath } from './allowlist.js'
import { downloadAttachments } from './attachments.js'
import { buildBridgePrompt, type BridgePromptAttachment } from './bridge-prompt.js'
import { ChatPresetStore, chatPresetPath, isPresetId, presetNameFor } from './chat-preset.js'
import { parseCommand, HELP_TEXT } from './commands.js'
import { domainFor, type ResolvedConfig } from './config.js'
import { saveOwnerId } from './credentials.js'
import { DshBinding, type BridgeEvent } from './dsh-binding.js'
import { splitArgs } from './split-args.js'
import { resolveWorkspace } from './workspace.js'

/** Coalesce streamed deltas so we do not spam Feishu with one edit per token. */
const STREAM_FLUSH_MS = 500

/** How often the app owner is re-resolved from the app-info API. */
const OWNER_REFRESH_MS = 30 * 60 * 1000

/** Max queued messages per chat while a turn is running (beyond: dropped loudly). */
const MAX_PENDING_PER_CHAT = 10

/** Conservative per-message length cap; longer replies are split at newlines. */
const MAX_REPLY_CHARS = 8000

/** Per-chat model override, chosen via `/model <name>`. */
type ChatModels = Map<string, string>

/**
 * Owns the channel connection and the message pump. Call {@link connect} to go
 * live and {@link disconnect} to tear down (also disposes every agent).
 */
export class LarkBridge {
  private readonly channel: LarkChannel
  private readonly chatModels: ChatModels = new Map()
  /** Chats with a run currently in flight — one run per chat at a time. */
  private readonly busy = new Set<string>()
  /** Per-chat FIFO of messages that arrived while a turn was running. */
  private readonly pending = new Map<string, NormalizedMessage[]>()
  /**
   * open_id of the app owner. Seeded from the credentials captured at
   * registration; when absent, resolved at runtime via the app-info API and
   * persisted back (see {@link resolveOwner}).
   */
  private ownerId: string | undefined
  /** This bot's own open_id, resolved from the channel identity. */
  private botOpenId: string | undefined
  private ownerRefreshTimer: ReturnType<typeof setInterval> | undefined
  /** Command-managed chat allowlist (owner `/allow` / `/disallow`). */
  private readonly allowlist: AllowlistStore
  /** Per-chat preset overrides (owner `/preset`, persisted). */
  private readonly chatPresets: ChatPresetStore

  constructor(
    private readonly config: ResolvedConfig,
    private readonly binding: DshBinding,
    private readonly log: (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void,
  ) {
    const opts: LarkChannelOptions = {
      appId: config.appId,
      appSecret: config.appSecret,
      domain: domainFor(config.tenant),
      source: 'dsh-lark-bridge',
      policy: {
        dmMode: config.allowDm ? 'open' : 'disabled',
        requireMention: config.requireMention,
        respondToMentionAll: false,
      },
      respectProxyEnv: true,
    }
    this.channel = createLarkChannel(opts)
    this.ownerId = config.ownerId
    this.allowlist = new AllowlistStore(allowlistPath())
    this.chatPresets = new ChatPresetStore(chatPresetPath())
    this.allowlist = new AllowlistStore(allowlistPath())
  }

  /** The effective access controls: config/env allowlists + command-managed store. */
  private accessControls(): {
    ownerId: string | undefined
    allowedChats: string[]
    allowedUsers: string[]
  } {
    return {
      ownerId: this.ownerId,
      allowedChats: [...this.config.allowedChats, ...this.allowlist.chatIds()],
      allowedUsers: this.config.allowedUsers,
    }
  }

  /** Whether the sender is the app owner (admin commands). Fail-closed when unknown. */
  private isOwner(msg: NormalizedMessage): boolean {
    return this.ownerId !== undefined && msg.senderId === this.ownerId
  }

  /**
   * Verify host SSO before enabling a gated tier (`DSH_LARK_SSO_GATED_PRESETS`).
   * Runs `DSH_LARK_SSO_CHECK_CMD` (argv tokens, no shell) and requires exit 0
   * AND the `DSH_LARK_SSO_OK_MARKER` in its output. Fail-closed — no checker
   * configured, any error, timeout, or unclear output counts as not verified.
   */
  private verifySso(): Promise<boolean> {
    const cmd = this.config.ssoCheckCmd
    if (!cmd) return Promise.resolve(false)
    const argv = splitArgs(cmd)
    if (argv.length === 0) return Promise.resolve(false)
    const marker = this.config.ssoOkMarker
    return new Promise(resolve => {
      const child = spawn(argv[0]!, argv.slice(1), {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      let settled = false
      const finish = (ok: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(ok)
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish(false)
      }, 10_000)
      child.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString()
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        out += chunk.toString()
      })
      child.on('error', () => finish(false))
      child.on('close', code => {
        finish(code === 0 && marker.length > 0 && out.includes(marker))
      })
    })
  }

  /** Connect the WebSocket and start handling messages. */
  async connect(): Promise<void> {
    this.channel.on({
      message: msg => {
        void this.onMessage(msg).catch(err =>
          this.log('error', 'message handler failed', err),
        )
      },
      error: err => this.log('warn', 'channel error', err),
    })
    await this.channel.connect()
    this.log('info', `dsh-lark-bridge connected (${this.config.tenant})`)

    // The bot's own identity ("this id is you") for the bridge metadata.
    try {
      this.botOpenId = this.channel.getBotIdentity().openId
    } catch {
      // Identity not available yet — the metadata block simply omits it.
    }

    // Resolve the owner if registration did not capture it (pre-upgrade
    // installs), then keep it fresh in case the app changes hands.
    if (!this.ownerId) void this.resolveOwner()
    this.ownerRefreshTimer = setInterval(() => {
      void this.resolveOwner()
    }, OWNER_REFRESH_MS)
    this.ownerRefreshTimer.unref?.()
  }

  /** Disconnect and dispose every agent. */
  async disconnect(): Promise<void> {
    if (this.ownerRefreshTimer) clearInterval(this.ownerRefreshTimer)
    this.ownerRefreshTimer = undefined
    await this.binding.disposeAll()
    await this.channel.disconnect()
  }

  /**
   * Resolve the app owner's open_id via the app-info API and persist it, so
   * the access gate works even for credentials written before the owner was
   * captured. Best-effort: on failure the owner stays unknown and the gate
   * stays fail-closed.
   */
  private async resolveOwner(): Promise<void> {
    try {
      const info = await this.channel.getAppInfo({ userIdType: 'open_id' })
      if (!info.ownerId) return
      this.ownerId = info.ownerId
      try {
        saveOwnerId(info.ownerId)
      } catch {
        // Persisting is a convenience; the in-memory value is what gates.
      }
      this.log('info', `app owner resolved (${info.ownerId})`)
    } catch (err) {
      this.log(
        'warn',
        'could not resolve app owner via app-info API (access stays fail-closed)',
        err,
      )
    }
  }

  /** Route one inbound message: access gate, command, or agent prompt. */
  private async onMessage(msg: NormalizedMessage): Promise<void> {
    // Never react to our own or other bots' messages — avoids loops.
    if (msg.senderIsBot) return
    const text = msg.content?.trim() ?? ''
    // Image/file-only messages carry their content in `resources`, so an
    // empty text is not a reason to drop the message.
    const hasResources = (msg.resources?.length ?? 0) > 0
    if (text.length === 0 && !hasResources) return

    // Access gate: the security boundary is exactly "who may send the bot a
    // message". Deny loudly and explain how to fix — never fall through.
    const decision = decideAccess(this.accessControls(), {
      chatId: msg.chatId,
      chatType: msg.chatType,
      senderId: msg.senderId,
    })
    if (!decision.ok) {
      this.log('warn', 'access denied', {
        chatId: msg.chatId,
        chatType: msg.chatType,
        senderId: msg.senderId,
      })
      await this.reply(msg, deniedMessage(msg))
      return
    }

    // Commands are handled locally and never reach the agent.
    const command = parseCommand(text)
    if (command) {
      await this.handleCommand(msg, command)
      return
    }

    await this.runAgent(msg, text)
  }

  /** Handle a slash command. */
  private async handleCommand(
    msg: NormalizedMessage,
    command: NonNullable<ReturnType<typeof parseCommand>>,
  ): Promise<void> {
    switch (command.kind) {
      case 'help':
        await this.reply(msg, HELP_TEXT)
        return
      case 'new': {
        // P3: reset must defeat persistence — a sentinel fingerprint makes
        // the next session rotate to a fresh generation, so the old context
        // cannot come back after a restart.
        this.binding.reset(msg.chatId)
        await this.reply(msg, '🧹 Started a fresh session for this chat.')
        return
      }
      case 'where': {
        const dir = await resolveWorkspace(this.config.workspaceRoot, msg.chatId)
        await this.reply(msg, `📁 This chat's project directory:\n\`${dir}\``)
        return
      }
      case 'allow': {
        if (msg.chatType !== 'group') {
          await this.reply(msg, 'ℹ️ `/allow` 用于授权群聊。私聊授权请 owner 配置 `DSH_LARK_ALLOWED_USERS`。')
          return
        }
        if (!this.isOwner(msg)) {
          await this.reply(msg, '🔒 只有机器人 owner 可以授权群聊。')
          return
        }
        const added = this.allowlist.addChat(msg.chatId)
        await this.reply(
          msg,
          added
            ? `✅ 本群已授权（\`${msg.chatId}\`），立即生效。`
            : `ℹ️ 本群已在授权列表中。`,
        )
        return
      }
      case 'disallow': {
        if (msg.chatType !== 'group') {
          await this.reply(msg, 'ℹ️ `/disallow` 用于撤销群聊授权。')
          return
        }
        if (!this.isOwner(msg)) {
          await this.reply(msg, '🔒 只有机器人 owner 可以撤销授权。')
          return
        }
        if (this.config.allowedChats.includes(msg.chatId)) {
          await this.reply(
            msg,
            'ℹ️ 本群来自环境变量 `DSH_LARK_ALLOWED_CHATS`，命令无法覆盖——请从环境变量中移除。',
          )
          return
        }
        const removed = this.allowlist.removeChat(msg.chatId)
        await this.reply(msg, removed ? '✅ 已撤销本群授权。' : 'ℹ️ 本群本就不在授权列表中。')
        return
      }
      case 'whoami': {
        const inEnv = this.config.allowedChats.includes(msg.chatId)
        const inStore = this.allowlist.hasChat(msg.chatId)
        const chatStatus = inEnv || inStore
          ? `✅ 已授权（${inEnv ? '环境变量' : '命令授权'}）`
          : '🔒 未授权'
        const lines = [
          `📋 **chatId**: \`${msg.chatId}\``,
          `聊天类型: ${msg.chatType === 'p2p' ? '私聊' : '群聊'}`,
          `本聊天授权状态: ${chatStatus}`,
        ]
        if (msg.chatType === 'p2p') {
          const dm = this.config.allowedUsers.includes(msg.senderId)
          lines.push(`你的私聊授权: ${dm ? '✅ 已授权' : '🔒 未授权（仅 owner 可用）'}`)
        }
        await this.reply(msg, lines.join('\n'))
        return
      }
      case 'model': {
        if (!command.value) {
          const current = this.chatModels.get(msg.chatId) ?? this.config.model ?? '(default)'
          await this.reply(msg, `🤖 Current model: \`${current}\`\nUse \`/model <name>\` to switch, \`/models\` to list.`)
          return
        }
        this.chatModels.set(msg.chatId, command.value)
        // A model change only takes effect on a fresh session.
        await this.binding.dispose(msg.chatId)
        await this.reply(msg, `🤖 Model set to \`${command.value}\` and session reset.`)
        return
      }
      case 'models': {
        // List the deployment's model catalog from the llm service.
        const catalog = await this.binding.listModels()
        if (catalog.length === 0) {
          await this.reply(msg, '🤖 模型目录不可用（llm 服务未提供）。')
          return
        }
        const lines: string[] = ['🤖 **可用模型**（`/model <id>` 切换）:']
        for (const p of catalog) {
          const head = p.providerName ?? p.provider
          if (p.models.length === 0) {
            lines.push(`- **${head}**: (无目录)`)
            continue
          }
          lines.push(
            `- **${head}**:\n` +
              p.models
                .map(m => (m.name && m.name !== m.id ? `  - \`${m.id}\` (${m.name})` : `  - \`${m.id}\``))
                .join('\n'),
          )
        }
        const text = lines.join('\n')
        // Feishu replies are chunked at 8000 chars; a huge catalog would
        // arrive as multiple messages — fine.
        await this.reply(msg, text)
        return
      }
      case 'preset': {
        if (!this.isOwner(msg)) {
          await this.reply(msg, '🔒 只有机器人 owner 可以切换档位。')
          return
        }
        const extraIds = new Set(Object.keys(this.config.extraPresets))
        const value = command.value
        if (value === undefined || value === '') {
          const current = this.chatPresets.get(msg.chatId) ?? this.config.accessMode
          const extras = Object.keys(this.config.extraPresets)
            .map(id => `\`/preset ${id}\``)
            .join(' ')
          await this.reply(
            msg,
            `🎚️ 本群档位: \`${current}\`\n可切换: \`/preset workspace\` \`/preset read-only\` \`/preset full\`${extraIds.size > 0 ? ' ' + [...extraIds].map(id => `\`/preset ${id}\``).join(' ') : ''}`,
          )
          return
        }
        if (!isPresetId(value, extraIds)) {
          await this.reply(
            msg,
            `❓ 未知档位 \`${value}\`。可用: workspace / read-only / full${extraIds.size > 0 ? ' / ' + [...extraIds].join(' / ') : ''}。`,
          )
          return
        }
        // SSO-gated tiers (configured via DSH_LARK_SSO_GATED_PRESETS) must
        // prove host SSO BEFORE the switch — fail-closed, so a gated tier can
        // never be enabled without valid host credentials.
        if (this.config.ssoGatedPresets.includes(value) && !(await this.verifySso())) {
          await this.reply(
            msg,
            `❌ 无法启用 \`${value}\` 档：宿主 SSO 校验未通过（${this.config.ssoCheckCmd ?? '未配置校验命令'}）。`,
          )
          return
        }
        if (value === 'workspace') this.chatPresets.clear(msg.chatId)
        else this.chatPresets.set(msg.chatId, value)
        // Preset is part of the session fingerprint — disposing rotates to a
        // fresh generation, so no old context carries into the new tier.
        await this.binding.dispose(msg.chatId)
        await this.reply(msg, `🎚️ 本群已切换到 \`${value}\` 档（新会话生效）。`)
        return
      }
      case 'unknown':
        await this.reply(msg, `❓ Unknown command: \`/${command.name}\`. Try \`/help\`.`)
        return
    }
  }

  /** Feed a prompt to the chat's agent, queueing if a turn is already running. */
  private async runAgent(msg: NormalizedMessage, prompt: string): Promise<void> {
    const chatId = msg.chatId
    if (this.busy.has(chatId)) {
      // P2: don't drop — queue per chat, process after the current turn.
      const queue = this.pending.get(chatId) ?? []
      if (queue.length >= MAX_PENDING_PER_CHAT) {
        await this.reply(msg, `📥 队列已满（${MAX_PENDING_PER_CHAT} 条），这条没有入队。`)
        return
      }
      queue.push(msg)
      this.pending.set(chatId, queue)
      await this.reply(msg, '📥 收到，前一条还在处理中，我会接着处理这条。')
      return
    }
    await this.runTurn(msg, prompt)
  }

  /** Run one turn for a chat, then drain the chat's pending queue. */
  private async runTurn(msg: NormalizedMessage, prompt: string): Promise<void> {
    const chatId = msg.chatId
    this.busy.add(chatId)
    try {
      await this.runAgentTurn(msg, prompt, chatId)
    } catch (err) {
      // ensureSession (or any setup step before the stream) can reject; without
      // this the chat's busy flag would stay set forever and every later message
      // would get queued behind a dead turn. Release it here and surface it.
      this.log('error', 'agent turn failed', err)
      await this.reply(msg, `⚠️ Failed to produce a reply: ${String(err)}`)
    } finally {
      this.busy.delete(chatId)
      const queue = this.pending.get(chatId)
      const next = queue?.shift()
      if (queue && queue.length === 0) this.pending.delete(chatId)
      if (next) {
        const text = next.content?.trim() ?? ''
        // Image-only messages have empty text — still process them.
        if (text.length > 0 || (next.resources?.length ?? 0) > 0) {
          void this.runTurn(next, text)
        }
      }
    }
  }

  /** The body of one turn: resolve the session, drive it, stream the reply. */
  private async runAgentTurn(
    msg: NormalizedMessage,
    prompt: string,
    chatId: string,
  ): Promise<void> {
    const cwd = await resolveWorkspace(this.config.workspaceRoot, chatId)
    const modelOverride = this.chatModels.get(chatId)
    // Per-chat preset override (owner `/preset`); `undefined` falls back to
    // the accessMode-derived preset from the plugin route. `full` maps to the
    // deployment default.
    const presetId = this.chatPresets.get(chatId)
    const route: { model?: string; provider?: string; preset?: string } = {}
    // Precedence: per-chat `/model` override > per-tier model route
    // (DSH_LARK_PRESET_MODELS, an extra tier -> its provider) > global default.
    if (modelOverride !== undefined) {
      route.model = modelOverride
    } else {
      const tierModel = presetId !== undefined ? this.config.presetModels[presetId] : undefined
      if (tierModel !== undefined) {
        route.provider = tierModel.provider
        route.model = tierModel.model
      }
    }
    if (presetId !== undefined) route.preset = presetNameFor(presetId, this.config.extraPresets)

    // Attachments: download images/files into the chat's workspace and hand
    // the paths to the agent (read_image / file reads). Rejections are
    // reported before the turn starts.
    const attachments: BridgePromptAttachment[] = []
    if ((msg.resources?.length ?? 0) > 0) {
      const result = await downloadAttachments(
        this.channel,
        msg.messageId,
        msg.resources,
        join(cwd, '.attachments'),
      )
      attachments.push(...result.accepted)
      if (result.rejected.length > 0) {
        const summary = result.rejected
          .map(r => (r.fileName ? `- ${r.fileName}: ${r.reason}` : `- ${r.reason}`))
          .join('\n')
        await this.reply(msg, `⚠️ 部分附件未处理：\n${summary}`)
      }
    }
    // An image-only message has no text — give the agent a stub so the turn
    // still runs (it would otherwise be dropped as "empty").
    const effectivePrompt =
      prompt.length > 0 ? prompt : attachments.length > 0 ? '（对方发来的附件）请查看以下附件。' : prompt

    // Buffer streamed text; a periodic flush pushes it to the Feishu card.
    let buffer = ''
    let done = false
    let doneReason = ''
    let errored: string | undefined

    const session = await this.binding.ensureSession(
      chatId,
      cwd,
      (event: BridgeEvent) => {
        switch (event.type) {
          case 'text':
            buffer += event.delta
            break
          case 'final_text':
            if (buffer.length === 0) buffer = event.content
            break
          case 'done':
            done = true
            doneReason = event.reason
            break
          case 'error':
            errored = event.message
            done = true
            break
          // 'thinking', 'tool_use', 'tool_result' are intentionally not shown
          // inline yet — kept minimal for the first release.
          default:
            break
        }
      },
      route,
    )

    await this.channel.stream(
      chatId,
      {
        markdown: async controller => {
          // P1: wrap the user message in bridge metadata blocks so message
          // text is framed as data, never as instructions.
          session.send(
            buildBridgePrompt(effectivePrompt, {
              chatId,
              chatType: msg.chatType,
              senderId: msg.senderId,
              ...(msg.senderName !== undefined ? { senderName: msg.senderName } : {}),
              ...(this.botOpenId !== undefined ? { botOpenId: this.botOpenId } : {}),
              ...(msg.mentions !== undefined && msg.mentions.length > 0
                ? { mentions: msg.mentions }
                : {}),
            }, attachments),
          )
          let shown = ''
          // Poll the buffer and push incremental content until the turn ends.
          while (!done) {
            await delay(STREAM_FLUSH_MS)
            if (buffer !== shown) {
              await controller.setContent(buffer)
              shown = buffer
            }
          }
          // Final flush. P2: long replies are split at newline boundaries so
          // the streaming card shows the first chunk and the rest arrives as
          // follow-up messages — a truncated reply is a failed deliverable.
          const finalText = errored
            ? `⚠️ ${errored}`
            : buffer.length > 0
              ? buffer
              : '(no output)'
          const chunks = splitLongText(finalText, MAX_REPLY_CHARS)
          const first = chunks[0] ?? ''
          if (first !== shown) await controller.setContent(first)
          for (const extra of chunks.slice(1)) {
            await this.channel.send(chatId, { markdown: extra }, { replyTo: msg.messageId })
          }
        },
      },
      { replyTo: msg.messageId },
    )
    this.log('info', `turn done (${doneReason || 'n/a'}) chat=${chatId}`)
  }

  /** Send a plain reply to a message. */
  private async reply(msg: NormalizedMessage, markdown: string): Promise<void> {
    await this.channel.send(msg.chatId, { markdown }, { replyTo: msg.messageId })
  }
}

/**
 * The denial message for a blocked message. Includes the chat id on purpose:
 * it is not a secret, and the owner needs it to configure the allowlist.
 */
function deniedMessage(msg: NormalizedMessage): string {
  if (msg.chatType === 'p2p') {
    return (
      '🔒 你未授权使用该机器人。\n' +
      '请机器人 owner 将你的 open_id 加入 `DSH_LARK_ALLOWED_USERS`，' +
      '或由 owner 本人直接私聊（owner 始终可用）。'
    )
  }
  return (
    `🔒 此群未授权使用该机器人。\n` +
    `chatId: \`${msg.chatId}\`\n` +
    '请机器人 owner 将该 chatId 加入 `DSH_LARK_ALLOWED_CHATS` 白名单。'
  )
}

/** Promise-based delay. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Split text longer than `max` chars into chunks, cutting at newline
 * boundaries and keeping markdown code fences valid across chunks. Each
 * processed chunk that ends inside an open fence closes it (```` ``` ````) and
 * the next chunk reopens it, so every chunk is self-contained and the whole
 * result is balanced. Returns `[text]` unchanged when the text fits.
 */
export function splitLongText(text: string, max: number): string[] {
  if (text.length <= max) return [text]
  const chunks: string[] = []
  let rest = text
  // Whether the previous chunk closed a fence, so this chunk must reopen it.
  let reopen = false
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max)
    if (cut <= 0) cut = max
    let chunk = rest.slice(0, cut)
    rest = rest.slice(cut)
    if (reopen) chunk = '```\n' + chunk
    const markers = (chunk.match(/```/g) ?? []).length
    if (markers % 2 === 1) {
      chunk += '\n```'
      reopen = true
    } else {
      reopen = false
    }
    chunks.push(chunk)
  }
  // The final chunk needs the same fence treatment.
  if (reopen) rest = '```\n' + rest
  if (((rest.match(/```/g) ?? []).length) % 2 === 1) rest += '\n```'
  chunks.push(rest)
  return chunks
}
