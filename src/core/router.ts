/**
 * 会话路由：管理 (渠道, chat) → agent 会话的映射与生命周期。
 * - per-chat 模式：网关用 ctx.agents.create 为每个 chat 创建独立 agent 会话，
 *   `/new` 轮换（dispose 旧的，建新的）。
 * - bound 模式：不创建 agent；用户 `/bind <session-id>` 绑定本进程 live 的 agent。
 * @module dsh-im-gateway/core/router
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentSetup } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
// dsh-agent-presets 模块增强（ctx.agentPresets：把 agent 挂入 preset，否则无核心工具）
import type {} from '@deepseek-ai/dsh-agent-presets'

interface WorkspaceRegistryLike {
  resolveByPath(path: string): Promise<{ attachSession(sessionId: SessionId): Promise<void> } | undefined>
  create(path: string): Promise<{ attachSession(sessionId: SessionId): Promise<void> }>
}

/** 一个 chat 的会话条目。 */
export interface ChatEntry {
  readonly channelId: string
  readonly chatId: string
  /** `${channelId}:${chatId}` 唯一键。 */
  readonly key: string
  /** 当前 agent 会话 id。 */
  sessionId: string
  /** per-chat 模式持有 handle；bound 模式为 undefined。 */
  handle?: AgentHandle
  /** 复用的 live agent（非本网关创建、不能 dispose）；注入消息时优先于 handle。 */
  agent?: Agent
  /** bound 模式的绑定者 userId（用于鉴权）。 */
  boundBy?: string
  /** 会话所属工作区（创建时 cwd）。 */
  workspace?: string
}

export interface RouterOptions {
  /** 网关创建 agent 时的工作目录。 */
  cwd: string
  provider: string
  model: string
  /** 创建会话使用的 agent preset（默认 standard；不挂 preset 会缺失核心工具）。 */
  agentPreset: string
  /** 每 chat 最后绑定的会话持久化（重启后自动恢复）。 */
  chatSessionStore?: {
    load(): Record<string, string>
    save(sessions: Record<string, string>): void
  }
  /** Workspace Registry 兼容失败日志。 */
  log?: (line: string) => void
}

export class SessionRouter {
  private readonly ctx: Context
  private readonly options: RouterOptions
  private readonly entries = new Map<string, ChatEntry>()
  /** sessionId → 绑定它的 chat 集合（bound 模式可多 chat 绑同一会话）。 */
  private readonly bySession = new Map<string, Set<ChatEntry>>()

  /** 每 chat 的工作区偏好（/workspace 设置，持久化由网关层负责）。 */
  private readonly workspaces = new Map<string, string>()
  /** chat 最后绑定的会话（持久化，重启恢复）。 */
  private readonly chatSessions = new Map<string, string>()

  constructor(ctx: Context, options: RouterOptions) {
    this.ctx = ctx
    this.options = options
    for (const [key, sid] of Object.entries(options.chatSessionStore?.load() ?? {})) this.chatSessions.set(key, sid)
  }

  /** 恢复持久化的工作区偏好（启动时由网关层灌入）。 */
  restoreWorkspaces(entries: Array<[string, string]>): void {
    for (const [key, path] of entries) this.workspaces.set(key, path)
  }

  /** 当前 chat 的工作区偏好（无则全局 cwd）。 */
  workspaceOf(channelId: string, chatId: string): string | undefined {
    return this.workspaces.get(`${channelId}:${chatId}`)
  }

  /** 设置 chat 的工作区偏好，返回旧值。 */
  setWorkspace(channelId: string, chatId: string, path: string): string | undefined {
    const key = `${channelId}:${chatId}`
    const old = this.workspaces.get(key)
    this.workspaces.set(key, path)
    return old
  }

  /** 全部工作区偏好（持久化用）。 */
  workspaceEntries(): Array<[string, string]> {
    return [...this.workspaces.entries()]
  }

  /** 取 chat 条目；不存在时返回 undefined（调用方决定是否创建）。 */
  get(channelId: string, chatId: string): ChatEntry | undefined {
    return this.entries.get(`${channelId}:${chatId}`)
  }

  /** per-chat 模式：取或建（优先恢复该 chat 上次的会话，否则创建新会话）。 */
  async getOrCreate(channelId: string, chatId: string): Promise<ChatEntry> {
    const key = `${channelId}:${chatId}`
    const existing = this.entries.get(key)
    if (existing) return existing
    // 重启恢复：上次绑定的会话仍存在则继续它（resume/复用 live），否则新建
    const last = this.chatSessions.get(key)
    if (last) {
      const restored = await this.continueSession(channelId, chatId, last)
      if (restored.ok) return this.entries.get(key)!
    }
    return this.create(channelId, chatId)
  }

  /** 记录 chat 当前绑定的会话（持久化，重启后恢复）。 */
  recordChatSession(channelId: string, chatId: string, sessionId: string): void {
    const key = `${channelId}:${chatId}`
    this.chatSessions.set(key, sessionId)
    this.options.chatSessionStore?.save(Object.fromEntries(this.chatSessions))
  }

  /** 该 chat 上次绑定的会话（无则 undefined；供命令路径恢复用）。 */
  lastSessionOf(channelId: string, chatId: string): string | undefined {
    return this.chatSessions.get(`${channelId}:${chatId}`)
  }

  /** 创建新会话（per-chat；cwd 优先 chat 工作区偏好）。 */
  async create(channelId: string, chatId: string): Promise<ChatEntry> {
    const key = `${channelId}:${chatId}`
    const sessionId = SessionId(`im:${channelId}:${chatId}:${Date.now()}`)
    const cwd = this.workspaces.get(key) ?? this.options.cwd
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd },
      agentOptions: { provider: this.options.provider, model: this.options.model },
      setup: this.presetSetup(this.options.agentPreset),
    })
    await this.attachToWorkspace(cwd, sessionId)
    const entry: ChatEntry = { channelId, chatId, key, sessionId: String(sessionId), handle, workspace: cwd }
    this.entries.set(key, entry)
    this.index(entry)
    this.recordChatSession(channelId, chatId, String(sessionId))
    return entry
  }

  /** 把新会话登记到宿主 Workspace Registry，确保 Web 侧按目录分组。 */
  private async attachToWorkspace(cwd: string, sessionId: SessionId): Promise<void> {
    const registry = (this.ctx as Context & { workspaceRegistry?: WorkspaceRegistryLike }).workspaceRegistry
    if (!registry) return
    try {
      const workspace = await registry.resolveByPath(cwd) ?? await registry.create(cwd)
      await workspace.attachSession(sessionId)
    } catch (err) {
      this.options.log?.(`[gateway] 会话 ${sessionId} 挂载工作区失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Agent setup：把 agent scope 挂入 preset（否则工具/prompt/skills 只有全局层，
   * 缺失 bash/fs/web 等核心工具）。
   */
  private presetSetup(presetId: string): AgentSetup {
    const ctx = this.ctx
    return async (agentCtx) => {
      await ctx.agentPresets.mount(agentCtx, presetId)
    }
  }

  /** 解析会话的 agentPreset（header 记录；未知时用默认）。 */
  private async presetOf(sessionId: string): Promise<string> {
    try {
      const query = this.ctx.sessionQuery
      if (query) {
        const records = await query.filterSessions([{ kind: 'id', values: [SessionId(sessionId)] }])
        const header = records[0]?.header as { agentPreset?: string } | undefined
        if (header?.agentPreset) return header.agentPreset
      }
    } catch { /* 未知则用默认 */ }
    return this.options.agentPreset
  }

  /**
   * 继续已有会话（per-chat）：优先复用本进程 live agent，否则 resume 持久化会话。
   * 成功时把 chat 条目切换到该会话。
   */
  async continueSession(channelId: string, chatId: string, sessionId: string): Promise<{ ok: boolean; error?: string; workspace?: string }> {
    const key = `${channelId}:${chatId}`
    const existing = this.entries.get(key)
    // 本进程已有 live agent（其他 chat 正在用或本 chat 的旧条目）
    let liveAgent = this.ctx.agents.get(SessionId(sessionId))
    if (!liveAgent) {
      try {
        // 必须带 agentOptions（provider/model）与 setup（挂入 preset），否则
        // prompt 缺 {{model}} 变量、且工具只剩全局层（无 bash/fs/web 等核心工具）
        const preset = await this.presetOf(sessionId)
        const handle = await this.ctx.agents.resume({
          resumeSessionId: SessionId(sessionId),
          agentOptions: { provider: this.options.provider, model: this.options.model },
          setup: this.presetSetup(preset),
        })
        if (existing?.handle) {
          this.unindex(existing)
          await existing.handle.dispose().catch(() => undefined)
        }
        const entry: ChatEntry = { channelId, chatId, key, sessionId, handle }
        this.entries.set(key, entry)
        this.index(entry)
        this.recordChatSession(channelId, chatId, sessionId)
        return { ok: true, workspace: sessionCwdOf(handle.agent) }
      } catch (err) {
        return { ok: false, error: `继续会话失败：${err instanceof Error ? err.message : String(err)}` }
      }
    }
    // live agent 复用：本 chat 条目指向它（释放旧 handle；agent 引用供注入，不 dispose）
    if (existing?.handle && existing.sessionId !== sessionId) {
      this.unindex(existing)
      await existing.handle.dispose().catch(() => undefined)
    }
    const entry: ChatEntry = { channelId, chatId, key, sessionId, agent: liveAgent, boundBy: undefined }
    this.entries.set(key, entry)
    this.index(entry)
    this.recordChatSession(channelId, chatId, sessionId)
    return { ok: true, workspace: sessionCwdOf(liveAgent) }
  }

  /** `/new`：解绑旧条目并始终创建新会话。 */
  async rotate(channelId: string, chatId: string): Promise<ChatEntry> {
    const key = `${channelId}:${chatId}`
    const old = this.entries.get(key)
    if (old) {
      this.unindex(old)
      this.entries.delete(key)
      if (old.handle) await old.handle.dispose().catch(() => undefined)
    }
    return this.create(channelId, chatId)
  }

  /** bound 模式：把 chat 绑定到本进程的 live agent 会话。 */
  bind(channelId: string, chatId: string, sessionId: string, userId?: string): { ok: boolean; error?: string } {
    const agent = this.ctx.agents.get(SessionId(sessionId))
    if (!agent) return { ok: false, error: `会话 ${sessionId} 当前没有运行中的 agent（须为本进程 live 会话）` }
    const key = `${channelId}:${chatId}`
    const existing = this.entries.get(key)
    if (existing?.handle) {
      // per-chat 条目转 bound：释放自建 handle
      this.unindex(existing)
      void existing.handle.dispose().catch(() => undefined)
    }
    const entry: ChatEntry = { channelId, chatId, key, sessionId, boundBy: userId }
    this.entries.set(key, entry)
    this.index(entry)
    return { ok: true }
  }

  /** 解绑（bound 模式回到无绑定状态）。 */
  unbind(channelId: string, chatId: string): void {
    const key = `${channelId}:${chatId}`
    const entry = this.entries.get(key)
    if (entry) {
      this.unindex(entry)
      this.entries.delete(key)
    }
  }

  /** 按 sessionId 找所有关联 chat（事件路由用）。 */
  chatsForSession(sessionId: string): ChatEntry[] {
    return [...(this.bySession.get(sessionId) ?? [])]
  }

  /** 全部条目（/status 用）。 */
  list(): ChatEntry[] {
    return [...this.entries.values()]
  }

  /** 插件卸载时释放所有自建 agent。 */
  async disposeAll(): Promise<void> {
    const handles = [...this.entries.values()].filter((e) => e.handle).map((e) => e.handle!)
    this.entries.clear()
    this.bySession.clear()
    await Promise.allSettled(handles.map((h) => h.dispose()))
  }

  private index(entry: ChatEntry): void {
    let set = this.bySession.get(entry.sessionId)
    if (!set) {
      set = new Set()
      this.bySession.set(entry.sessionId, set)
    }
    set.add(entry)
  }

  private unindex(entry: ChatEntry): void {
    const set = this.bySession.get(entry.sessionId)
    if (set) {
      set.delete(entry)
      if (set.size === 0) this.bySession.delete(entry.sessionId)
    }
  }
}

/** 从 agent 的会话 header 取工作目录（可能没有）。 */
function sessionCwdOf(agent: { session: { header?: { cwd?: string } } }): string | undefined {
  return agent.session.header?.cwd
}
