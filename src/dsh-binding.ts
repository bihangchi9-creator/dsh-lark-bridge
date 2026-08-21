/**
 * The dsh binding — the single isolation layer over dsh's internal `agents`
 * service and session-event stream.
 *
 * Everything the rest of the plugin needs to *drive an agent* lives here:
 * create/resume a per-chat session, feed it a user turn, and receive a small,
 * stable stream of {@link BridgeEvent}s. If a future dsh release renames an API
 * or reshapes an event, this file is the only place that changes.
 *
 * The event translation table (dsh → bridge):
 *
 *   assistant/chunk (text-delta)     -> { type: 'text', delta }
 *   assistant/chunk (reasoning-delta)-> { type: 'thinking', delta }
 *   assistant/message                -> { type: 'final_text', content, usage? }
 *   tool/call                        -> { type: 'tool_use', id, name }
 *   tool/result                      -> { type: 'tool_result', id, isError }
 *   turn/end                         -> { type: 'done', reason }
 *
 * @module dsh-lark-bridge/dsh-binding
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

/**
 * A resolved model route: which provider + model (and optional reasoning
 * effort) a created agent should call. Structurally identical to dsh's
 * `ModelSelection`; kept local so we don't add a runtime dependency on the
 * core agent package (whose event bus must stay the host's single instance).
 */
interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** Provider/model route handed to each created agent. */
export interface AgentRoute {
  provider?: string
  model?: string
  /**
   * Which agent preset to mount (toolset + system prompt + model loop). When
   * omitted the deployment default (`standard` in the shipped web profile) is
   * used, matching what a normal browser session gets.
   */
  preset?: string
}

/** The small, dsh-agnostic event vocabulary the Feishu layer consumes. */
export type BridgeEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'final_text'; content: string; inputTokens?: number; outputTokens?: number }
  | { type: 'tool_use'; id: string; name: string }
  | { type: 'tool_result'; id: string; isError: boolean }
  | { type: 'done'; reason: string }
  | { type: 'error'; message: string }

/** A live per-chat agent handle owned by the binding. */
export interface BridgeSession {
  readonly sessionId: string
  /** Enqueue a user turn (plain text). The agent streams via the subscribed handler. */
  send(text: string): void
  /** Stop and dispose the underlying agent, reaching quiescence. */
  dispose(): Promise<void>
}

/**
 * Minimal structural views of the dsh agent handle and session-event payload.
 * Declared locally so this plugin does not hard-depend on unstable internal
 * type exports; the real objects satisfy these shapes at runtime.
 */
interface AgentHandleLike {
  readonly agent: {
    readonly id: unknown
    followup(message: unknown): void
    /** Resolve once the agent reaches quiescence (post-create and post-turn). */
    whenIdle(): Promise<void>
  }
  dispose(): Promise<void>
}

interface AgentsServiceLike {
  create(options: {
    sessionId: unknown
    meta?: { cwd?: string }
    agentOptions?: AgentRoute
    setup?: (agentCtx: unknown) => Promise<void> | void
  }): Promise<AgentHandleLike>
  resume(options: {
    resumeSessionId: unknown
    agentOptions?: AgentRoute
    setup?: (agentCtx: unknown) => Promise<void> | void
  }): Promise<AgentHandleLike>
  get(sessionId: unknown): { followup(message: unknown): void } | undefined
}

/**
 * The session-persistence service (`ctx.sessionPersistence`), present when the
 * deployment loads a persistence backend (the shipped web profile does). Used
 * to detect whether a chat's fixed session id already has a log on disk so we
 * resume it instead of colliding with `create`.
 */
interface SessionPersistenceLike {
  list(signal?: unknown): Promise<Array<{ id: unknown; cwd?: string }>>
}

/**
 * The preset registry service (`ctx.agentPresets`). Mounting a preset onto a
 * freshly created agent's scoped context is what gives it its toolset, system
 * prompt, and model loop — a bare `agents.create` with no preset produces an
 * agent that has nothing to do and ends the turn with no output.
 */
interface AgentPresetsLike {
  /** Compose the named preset (or the deployment default) onto an agent context. */
  mount(agentCtx: unknown, id?: string): Promise<unknown>
}

/**
 * The default-model service (`ctx.agentDefaultModel`). Mounting a preset gives
 * an agent its tools and prompt but NOT a model; every turn needs a resolved
 * `{ provider, model }`, and the deployment default lives here (e.g.
 * `deepseek-official` / `deepseek-v4-flash`). Without it a turn ends with no
 * model call and produces no output.
 */
interface AgentDefaultModelLike {
  currentSelection(): ModelSelection
}

/**
 * Wraps `ctx.agents` for one plugin instance. Owns a `chatId -> BridgeSession`
 * map so each Feishu chat gets exactly one long-lived agent, and fans the
 * global `session/event` stream out to per-session subscribers.
 */
export class DshBinding {
  private readonly sessions = new Map<string, BridgeSession>()
  private readonly handlers = new Map<string, (event: BridgeEvent) => void>()

  constructor(
    private readonly ctx: Context,
    private readonly route: AgentRoute,
    private readonly log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void,
  ) {
    // One global subscription; routed to the right chat by the session id we
    // minted for it. dsh emits (session, event) for every live agent.
    ctx.on('session/event', (session: { id: unknown }, event: unknown) => {
      const key = String((session as { id: unknown }).id)
      const handler = this.handlers.get(key)
      if (!handler) return
      const translated = translate(event)
      if (translated) handler(translated)
    })
  }

  /** The injected dsh agent-factory service (typed structurally, see AgentsServiceLike). */
  private get agents(): AgentsServiceLike {
    return (this.ctx as unknown as { agents: AgentsServiceLike }).agents
  }

  /** The injected preset registry, if the deployment composed one. */
  private get agentPresets(): AgentPresetsLike | undefined {
    return (this.ctx as unknown as { agentPresets?: AgentPresetsLike }).agentPresets
  }

  /** The injected default-model service, if the deployment composed one. */
  private get agentDefaultModel(): AgentDefaultModelLike | undefined {
    return (this.ctx as unknown as { agentDefaultModel?: AgentDefaultModelLike }).agentDefaultModel
  }

  /**
   * The injected persistence service, if the deployment loaded a backend.
   *
   * Accessed via `ctx.get(name)` rather than a direct property: this service is
   * intentionally NOT in the plugin's `inject` list (it is optional — a headless
   * profile may omit persistence), and cordis THROWS on direct property access
   * to an undeclared service. `ctx.get` performs the same optional lookup the
   * host itself uses (see api-proxy `ctx.get('sessionPersistence')`).
   */
  private get sessionPersistence(): SessionPersistenceLike | undefined {
    const get = (this.ctx as unknown as { get(name: string): unknown }).get
    if (typeof get !== 'function') return undefined
    return get.call(this.ctx, 'sessionPersistence') as SessionPersistenceLike | undefined
  }

  /** Whether a live session exists for this chat. */
  has(chatId: string): boolean {
    return this.sessions.has(chatId)
  }

  /**
   * Get the existing session for a chat, or create one bound to `cwd`.
   * `onEvent` is (re)registered as the sink for this chat's stream.
   *
   * `routeOverride` lets a chat pin its own model (see `/model`); it only
   * applies when a fresh session is created, so callers that switch models
   * dispose first, then re-ensure.
   */
  async ensureSession(
    chatId: string,
    cwd: string,
    onEvent: (event: BridgeEvent) => void,
    routeOverride?: AgentRoute,
  ): Promise<BridgeSession> {
    const existing = this.sessions.get(chatId)
    if (existing) {
      this.handlers.set(existing.sessionId, onEvent)
      return existing
    }

    const agents = this.agents
    const presets = this.agentPresets
    // A stable, readable id per chat keeps sessions greppable in dsh logs.
    const sessionId = SessionId(`lark-${chatId}`)
    // `preset` selects the agent's composed world (tools + prompt); the model
    // route (`provider`/`model`) is separate and must be bound explicitly —
    // mounting a preset does NOT give the agent a model.
    const { preset, ...routeOnly } = { ...this.route, ...routeOverride }

    // Resolve the model selection. A preset alone leaves the agent with no
    // model, so every turn would end immediately with no output. We seed the
    // deployment default (e.g. deepseek-official / deepseek-v4-flash) from the
    // agentDefaultModel service, letting an explicit provider/model override it.
    const fallback = this.agentDefaultModel?.currentSelection()
    const selection: ModelSelection | undefined =
      routeOnly.provider && routeOnly.model
        ? { provider: routeOnly.provider, model: routeOnly.model }
        : fallback
          ? {
              provider: routeOnly.provider ?? fallback.provider,
              model: routeOnly.model ?? fallback.model,
              reasoningEffort: fallback.reasoningEffort,
            }
          : undefined

    // Shared agent options and setup, used identically by create and resume.
    // A resumed agent must mount the same preset and model selection as a fresh
    // one, or it comes back with bare host tools and no model.
    const agentOptions: AgentRoute = selection
      ? { provider: selection.provider, model: selection.model }
      : routeOnly
    const setup = async (agentCtx: unknown): Promise<void> => {
      if (selection) installModelSelection(agentCtx as Context, selection)
      if (presets) {
        try {
          await presets.mount(agentCtx, preset)
        } catch (err) {
          if (preset === undefined) throw err
          // The named tier preset (lark-workspace / lark-readonly) is not
          // installed in this deployment. Rather than fail every turn, fall
          // back to the deployment default and say so loudly — otherwise a
          // deployment without the presets silently loses its blast-radius
          // reduction.
          this.log?.(
            'warn',
            `preset ${JSON.stringify(preset)} unavailable — falling back to the deployment default`,
            err,
          )
          await presets.mount(agentCtx, undefined)
        }
      }
    }

    // Resume-or-create: a fixed per-chat session id collides with `create` once
    // its log is persisted on disk (id collision). If persistence reports an
    // existing log for this id, resume it (preserving the chat's history across
    // restarts); otherwise create a fresh one. The session id IS the identity.
    const persistence = this.sessionPersistence
    const idKey = String(sessionId)
    let persisted: { id: unknown; cwd?: string } | undefined
    if (persistence) {
      try {
        persisted = (await persistence.list()).find(h => String(h.id) === idKey)
      } catch {
        // Listing failed — treat as "no persisted log" and fall through to create.
      }
    }

    let handle: AgentHandleLike
    try {
      handle = persisted
        ? await agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
        : await agents.create({ sessionId, meta: { cwd }, agentOptions, setup })
    } catch (err) {
      // Another path may have published this id while we awaited persistence/fs;
      // adopt the already-live agent instead of failing the turn.
      const live = agents.get(sessionId)
      if (!live) throw err
      handle = {
        agent: {
          id: sessionId,
          followup: (message: unknown) => live.followup(message),
          whenIdle: async () => {},
        },
        dispose: async () => {},
      }
    }

    // Let the freshly created agent settle to quiescence before we drive it.
    // A followup sent before the initial waking activity retires gets spliced
    // into the inbox but not claimed into the turn — the turn opens and closes
    // with an empty claim (reason `completed`, no model call). This mirrors the
    // headless bundle's `create → whenIdle → followup` sequence.
    await handle.agent.whenIdle()

    const key = String(handle.agent.id)
    const sessionKey = String(sessionId)
    // Events may be keyed by the session id OR the agent id depending on the
    // emitter; register under both so routing never silently misses.
    this.handlers.set(key, onEvent)
    if (sessionKey !== key) this.handlers.set(sessionKey, onEvent)

    const session: BridgeSession = {
      sessionId: key,
      send: (text: string) => {
        // Prefer the live registry lookup so a hot-reloaded agent still works.
        const live = agents.get(handle.agent.id) ?? handle.agent
        live.followup(
          createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
        )
      },
      dispose: async () => {
        this.handlers.delete(key)
        this.sessions.delete(chatId)
        await handle.dispose()
      },
    }
    this.sessions.set(chatId, session)
    return session
  }

  /** Dispose one chat's session, if any (used by `/new` and `/model`). */
  async dispose(chatId: string): Promise<void> {
    const session = this.sessions.get(chatId)
    if (session) await session.dispose()
  }

  /** Dispose every live session (plugin teardown). */
  async disposeAll(): Promise<void> {
    const all = [...this.sessions.values()]
    this.sessions.clear()
    this.handlers.clear()
    await Promise.allSettled(all.map(s => s.dispose()))
  }
}

/**
 * Bind a model selection to an agent's scoped context.
 *
 * Mounting a preset gives an agent tools and a system prompt but no model, so
 * the request waterfall would produce no provider/model and the turn would end
 * without ever calling the LLM. This mirrors dsh's own `installModelSelection`
 * (packages/core/agent/src/model-selection.ts): it registers two scoped
 * waterfall listeners — one that injects `provider`/`model` prompt variables at
 * assembly time, and one that pins the request config's provider/model on every
 * step. Inlined (rather than imported) so the plugin adds no runtime dependency
 * on the core agent package, whose cordis event bus must remain the host's.
 */
function installModelSelection(agentCtx: Context, selection: ModelSelection): void {
  const ctx = agentCtx as unknown as {
    on(event: string, handler: (...args: never[]) => unknown): () => void
  }
  const onAssemble = async (
    _assembly: unknown,
    _context: unknown,
    next: () => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> => {
    const assembled = await next()
    return {
      ...assembled,
      variables: {
        ...(assembled.variables as Record<string, unknown> | undefined),
        provider: selection.provider,
        model: selection.model,
      },
    }
  }
  const onRequest = async (
    _payload: unknown,
    next: () => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> => {
    const resolved = await next()
    const { reasoningEffort: _inherited, ...rest } = resolved
    return {
      ...rest,
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: selection.reasoningEffort }),
    }
  }
  ctx.on('system-prompt/assemble', onAssemble as unknown as (...args: never[]) => unknown)
  ctx.on('agent/request', onRequest as unknown as (...args: never[]) => unknown)
}

/** Narrow an opaque dsh session event into a {@link BridgeEvent}, or drop it. */
function translate(event: unknown): BridgeEvent | undefined {
  if (typeof event !== 'object' || event === null) return undefined
  const e = event as { type?: string; data?: Record<string, unknown> }
  switch (e.type) {
    case 'assistant/chunk': {
      const chunk = e.data?.chunk as { type?: string; text?: string } | undefined
      if (!chunk) return undefined
      if (chunk.type === 'text-delta') return { type: 'text', delta: chunk.text ?? '' }
      if (chunk.type === 'reasoning-delta') return { type: 'thinking', delta: chunk.text ?? '' }
      return undefined
    }
    case 'assistant/message': {
      const message = e.data?.message as { content?: unknown } | undefined
      const usage = e.data?.usage as
        | { inputTokens?: number; outputTokens?: number }
        | undefined
      return {
        type: 'final_text',
        content: extractText(message?.content),
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
      }
    }
    case 'tool/call': {
      return {
        type: 'tool_use',
        id: String(e.data?.callId ?? ''),
        name: String(e.data?.name ?? 'tool'),
      }
    }
    case 'tool/result': {
      return {
        type: 'tool_result',
        id: String(e.data?.callId ?? ''),
        isError: e.data?.error !== undefined,
      }
    }
    case 'turn/end': {
      // reason is a discriminated object ({ kind: 'completed' | 'error' | … });
      // stringify it so callers can log the actual cause, not `[object Object]`.
      const reason = e.data?.reason
      const asText =
        reason && typeof reason === 'object' ? JSON.stringify(reason) : String(reason ?? 'normal')
      return { type: 'done', reason: asText }
    }
    default:
      return undefined
  }
}

/** Flatten an assistant message `content` array into plain text. */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object' && 'text' in part) {
        return String((part as { text: unknown }).text ?? '')
      }
      return ''
    })
    .join('')
}
