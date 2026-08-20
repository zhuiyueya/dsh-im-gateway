/**
 * 会话路由：管理 (渠道, chat) → agent 会话的映射与生命周期。
 * - per-chat 模式：网关用 ctx.agents.create 为每个 chat 创建独立 agent 会话，
 *   `/new` 轮换（dispose 旧的，建新的）。
 * - bound 模式：不创建 agent；用户 `/bind <session-id>` 绑定本进程 live 的 agent。
 * @module dsh-im-gateway/core/router
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
/** 一个 chat 的会话条目。 */
export interface ChatEntry {
    readonly channelId: string;
    readonly chatId: string;
    /** `${channelId}:${chatId}` 唯一键。 */
    readonly key: string;
    /** 当前 agent 会话 id。 */
    sessionId: string;
    /** per-chat 模式持有 handle；bound 模式为 undefined。 */
    handle?: AgentHandle;
    /** 复用的 live agent（非本网关创建、不能 dispose）；注入消息时优先于 handle。 */
    agent?: Agent;
    /** bound 模式的绑定者 userId（用于鉴权）。 */
    boundBy?: string;
    /** 会话所属工作区（创建时 cwd）。 */
    workspace?: string;
}
export interface RouterOptions {
    /** 网关创建 agent 时的工作目录。 */
    cwd: string;
    provider: string;
    model: string;
    /** 创建会话使用的 agent preset（默认 standard；不挂 preset 会缺失核心工具）。 */
    agentPreset: string;
    /** 每 chat 最后绑定的会话持久化（重启后自动恢复）。 */
    chatSessionStore?: {
        load(): Record<string, string>;
        save(sessions: Record<string, string>): void;
    };
    /** Workspace Registry 兼容失败日志。 */
    log?: (line: string) => void;
}
export declare class SessionRouter {
    private readonly ctx;
    private readonly options;
    private readonly entries;
    /** sessionId → 绑定它的 chat 集合（bound 模式可多 chat 绑同一会话）。 */
    private readonly bySession;
    /** 每 chat 的工作区偏好（/workspace 设置，持久化由网关层负责）。 */
    private readonly workspaces;
    /** chat 最后绑定的会话（持久化，重启恢复）。 */
    private readonly chatSessions;
    constructor(ctx: Context, options: RouterOptions);
    /** 恢复持久化的工作区偏好（启动时由网关层灌入）。 */
    restoreWorkspaces(entries: Array<[string, string]>): void;
    /** 当前 chat 的工作区偏好（无则全局 cwd）。 */
    workspaceOf(channelId: string, chatId: string): string | undefined;
    /** 设置 chat 的工作区偏好，返回旧值。 */
    setWorkspace(channelId: string, chatId: string, path: string): string | undefined;
    /** 全部工作区偏好（持久化用）。 */
    workspaceEntries(): Array<[string, string]>;
    /** 取 chat 条目；不存在时返回 undefined（调用方决定是否创建）。 */
    get(channelId: string, chatId: string): ChatEntry | undefined;
    /** per-chat 模式：取或建（优先恢复该 chat 上次的会话，否则创建新会话）。 */
    getOrCreate(channelId: string, chatId: string): Promise<ChatEntry>;
    /** 记录 chat 当前绑定的会话（持久化，重启后恢复）。 */
    recordChatSession(channelId: string, chatId: string, sessionId: string): void;
    /** 该 chat 上次绑定的会话（无则 undefined；供命令路径恢复用）。 */
    lastSessionOf(channelId: string, chatId: string): string | undefined;
    /** 创建新会话（per-chat；cwd 优先 chat 工作区偏好）。 */
    create(channelId: string, chatId: string): Promise<ChatEntry>;
    /** 把新会话登记到宿主 Workspace Registry，确保 Web 侧按目录分组。 */
    private attachToWorkspace;
    /** Agent setup：把 agent scope 挂入 preset（否则工具/prompt/skills 只有全局层，
     * 缺失 bash/fs/web 等核心工具）。
     */
    private presetSetup;
    /** 解析会话的 agentPreset（header 记录；未知时用默认）。 */
    private presetOf;
    /**
     * 继续已有会话（per-chat）：优先复用本进程 live agent，否则 resume 持久化会话。
     * 成功时把 chat 条目切换到该会话。
     */
    continueSession(channelId: string, chatId: string, sessionId: string): Promise<{
        ok: boolean;
        error?: string;
        workspace?: string;
    }>;
    /** `/new`：解绑旧条目并始终创建新会话。 */
    rotate(channelId: string, chatId: string): Promise<ChatEntry>;
    /** bound 模式：把 chat 绑定到本进程的 live agent 会话。 */
    bind(channelId: string, chatId: string, sessionId: string, userId?: string): {
        ok: boolean;
        error?: string;
    };
    /** 解绑（bound 模式回到无绑定状态）。 */
    unbind(channelId: string, chatId: string): void;
    /** 按 sessionId 找所有关联 chat（事件路由用）。 */
    chatsForSession(sessionId: string): ChatEntry[];
    /** 全部条目（/status 用）。 */
    list(): ChatEntry[];
    /** 插件卸载时释放所有自建 agent。 */
    disposeAll(): Promise<void>;
    private index;
    private unindex;
}
//# sourceMappingURL=router.d.ts.map