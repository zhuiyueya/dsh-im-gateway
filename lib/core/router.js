/**
 * 会话路由：管理 (渠道, chat) → agent 会话的映射与生命周期。
 * - per-chat 模式：网关用 ctx.agents.create 为每个 chat 创建独立 agent 会话，
 *   `/new` 轮换（dispose 旧的，建新的）。
 * - bound 模式：不创建 agent；用户 `/bind <session-id>` 绑定本进程 live 的 agent。
 * @module dsh-im-gateway/core/router
 */
import { SessionId } from '@deepseek-ai/dsh-session';
export class SessionRouter {
    ctx;
    options;
    entries = new Map();
    /** sessionId → 绑定它的 chat 集合（bound 模式可多 chat 绑同一会话）。 */
    bySession = new Map();
    /** 每 chat 的工作区偏好（/workspace 设置，持久化由网关层负责）。 */
    workspaces = new Map();
    /** chat 最后绑定的会话（持久化，重启恢复）。 */
    chatSessions = new Map();
    constructor(ctx, options) {
        this.ctx = ctx;
        this.options = options;
        for (const [key, sid] of Object.entries(options.chatSessionStore?.load() ?? {}))
            this.chatSessions.set(key, sid);
    }
    /** 恢复持久化的工作区偏好（启动时由网关层灌入）。 */
    restoreWorkspaces(entries) {
        for (const [key, path] of entries)
            this.workspaces.set(key, path);
    }
    /** 当前 chat 的工作区偏好（无则全局 cwd）。 */
    workspaceOf(channelId, chatId) {
        return this.workspaces.get(`${channelId}:${chatId}`);
    }
    /** 设置 chat 的工作区偏好，返回旧值。 */
    setWorkspace(channelId, chatId, path) {
        const key = `${channelId}:${chatId}`;
        const old = this.workspaces.get(key);
        this.workspaces.set(key, path);
        return old;
    }
    /** 全部工作区偏好（持久化用）。 */
    workspaceEntries() {
        return [...this.workspaces.entries()];
    }
    /** 取 chat 条目；不存在时返回 undefined（调用方决定是否创建）。 */
    get(channelId, chatId) {
        return this.entries.get(`${channelId}:${chatId}`);
    }
    /** per-chat 模式：取或建（优先恢复该 chat 上次的会话，否则创建新会话）。 */
    async getOrCreate(channelId, chatId) {
        const key = `${channelId}:${chatId}`;
        const existing = this.entries.get(key);
        if (existing)
            return existing;
        // 重启恢复：上次绑定的会话仍存在则继续它（resume/复用 live），否则新建
        const last = this.chatSessions.get(key);
        if (last) {
            const restored = await this.continueSession(channelId, chatId, last);
            if (restored.ok)
                return this.entries.get(key);
        }
        return this.create(channelId, chatId);
    }
    /** 记录 chat 当前绑定的会话（持久化，重启后恢复）。 */
    recordChatSession(channelId, chatId, sessionId) {
        const key = `${channelId}:${chatId}`;
        this.chatSessions.set(key, sessionId);
        this.options.chatSessionStore?.save(Object.fromEntries(this.chatSessions));
    }
    /** 该 chat 上次绑定的会话（无则 undefined；供命令路径恢复用）。 */
    lastSessionOf(channelId, chatId) {
        return this.chatSessions.get(`${channelId}:${chatId}`);
    }
    /** 创建新会话（per-chat；cwd 优先 chat 工作区偏好）。 */
    async create(channelId, chatId) {
        const key = `${channelId}:${chatId}`;
        const sessionId = SessionId(`im:${channelId}:${chatId}:${Date.now()}`);
        const cwd = this.workspaces.get(key) ?? this.options.cwd;
        const handle = await this.ctx.agents.create({
            sessionId,
            meta: { cwd },
            agentOptions: { provider: this.options.provider, model: this.options.model },
            setup: this.presetSetup(this.options.agentPreset),
        });
        await this.attachToWorkspace(cwd, sessionId);
        const entry = { channelId, chatId, key, sessionId: String(sessionId), handle, workspace: cwd };
        this.entries.set(key, entry);
        this.index(entry);
        this.recordChatSession(channelId, chatId, String(sessionId));
        return entry;
    }
    /** 把新会话登记到宿主 Workspace Registry，确保 Web 侧按目录分组。 */
    async attachToWorkspace(cwd, sessionId) {
        const registry = this.ctx.workspaceRegistry;
        if (!registry)
            return;
        try {
            const workspace = await registry.resolveByPath(cwd) ?? await registry.create(cwd);
            await workspace.attachSession(sessionId);
        }
        catch (err) {
            this.options.log?.(`[gateway] 会话 ${sessionId} 挂载工作区失败: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    /** Agent setup：把 agent scope 挂入 preset（否则工具/prompt/skills 只有全局层，
     * 缺失 bash/fs/web 等核心工具）。
     */
    presetSetup(presetId) {
        const ctx = this.ctx;
        return async (agentCtx) => {
            await ctx.agentPresets.mount(agentCtx, presetId);
        };
    }
    /** 解析会话的 agentPreset（header 记录；未知时用默认）。 */
    async presetOf(sessionId) {
        try {
            const query = this.ctx.sessionQuery;
            if (query) {
                const records = await query.filterSessions([{ kind: 'id', values: [SessionId(sessionId)] }]);
                const header = records[0]?.header;
                if (header?.agentPreset)
                    return header.agentPreset;
            }
        }
        catch { /* 未知则用默认 */ }
        return this.options.agentPreset;
    }
    /**
     * 继续已有会话（per-chat）：优先复用本进程 live agent，否则 resume 持久化会话。
     * 成功时把 chat 条目切换到该会话。
     */
    async continueSession(channelId, chatId, sessionId) {
        const key = `${channelId}:${chatId}`;
        const existing = this.entries.get(key);
        // 本进程已有 live agent（其他 chat 正在用或本 chat 的旧条目）
        let liveAgent = this.ctx.agents.get(SessionId(sessionId));
        if (!liveAgent) {
            try {
                // 必须带 agentOptions（provider/model）与 setup（挂入 preset），否则
                // prompt 缺 {{model}} 变量、且工具只剩全局层（无 bash/fs/web 等核心工具）
                const preset = await this.presetOf(sessionId);
                const handle = await this.ctx.agents.resume({
                    resumeSessionId: SessionId(sessionId),
                    agentOptions: { provider: this.options.provider, model: this.options.model },
                    setup: this.presetSetup(preset),
                });
                if (existing?.handle) {
                    this.unindex(existing);
                    await existing.handle.dispose().catch(() => undefined);
                }
                const entry = { channelId, chatId, key, sessionId, handle };
                this.entries.set(key, entry);
                this.index(entry);
                this.recordChatSession(channelId, chatId, sessionId);
                return { ok: true, workspace: sessionCwdOf(handle.agent) };
            }
            catch (err) {
                return { ok: false, error: `继续会话失败：${err instanceof Error ? err.message : String(err)}` };
            }
        }
        // live agent 复用：本 chat 条目指向它（释放旧 handle；agent 引用供注入，不 dispose）
        if (existing?.handle && existing.sessionId !== sessionId) {
            this.unindex(existing);
            await existing.handle.dispose().catch(() => undefined);
        }
        const entry = { channelId, chatId, key, sessionId, agent: liveAgent, boundBy: undefined };
        this.entries.set(key, entry);
        this.index(entry);
        this.recordChatSession(channelId, chatId, sessionId);
        return { ok: true, workspace: sessionCwdOf(liveAgent) };
    }
    /** `/new`：轮换新会话。 */
    async rotate(channelId, chatId) {
        const key = `${channelId}:${chatId}`;
        const old = this.entries.get(key);
        if (old?.handle) {
            this.unindex(old);
            this.entries.delete(key);
            await old.handle.dispose().catch(() => undefined);
        }
        if (!old)
            return undefined;
        return this.create(channelId, chatId);
    }
    /** bound 模式：把 chat 绑定到本进程的 live agent 会话。 */
    bind(channelId, chatId, sessionId, userId) {
        const agent = this.ctx.agents.get(SessionId(sessionId));
        if (!agent)
            return { ok: false, error: `会话 ${sessionId} 当前没有运行中的 agent（须为本进程 live 会话）` };
        const key = `${channelId}:${chatId}`;
        const existing = this.entries.get(key);
        if (existing?.handle) {
            // per-chat 条目转 bound：释放自建 handle
            this.unindex(existing);
            void existing.handle.dispose().catch(() => undefined);
        }
        const entry = { channelId, chatId, key, sessionId, boundBy: userId };
        this.entries.set(key, entry);
        this.index(entry);
        return { ok: true };
    }
    /** 解绑（bound 模式回到无绑定状态）。 */
    unbind(channelId, chatId) {
        const key = `${channelId}:${chatId}`;
        const entry = this.entries.get(key);
        if (entry) {
            this.unindex(entry);
            this.entries.delete(key);
        }
    }
    /** 按 sessionId 找所有关联 chat（事件路由用）。 */
    chatsForSession(sessionId) {
        return [...(this.bySession.get(sessionId) ?? [])];
    }
    /** 全部条目（/status 用）。 */
    list() {
        return [...this.entries.values()];
    }
    /** 插件卸载时释放所有自建 agent。 */
    async disposeAll() {
        const handles = [...this.entries.values()].filter((e) => e.handle).map((e) => e.handle);
        this.entries.clear();
        this.bySession.clear();
        await Promise.allSettled(handles.map((h) => h.dispose()));
    }
    index(entry) {
        let set = this.bySession.get(entry.sessionId);
        if (!set) {
            set = new Set();
            this.bySession.set(entry.sessionId, set);
        }
        set.add(entry);
    }
    unindex(entry) {
        const set = this.bySession.get(entry.sessionId);
        if (set) {
            set.delete(entry);
            if (set.size === 0)
                this.bySession.delete(entry.sessionId);
        }
    }
}
/** 从 agent 的会话 header 取工作目录（可能没有）。 */
function sessionCwdOf(agent) {
    return agent.session.header?.cwd;
}
//# sourceMappingURL=router.js.map