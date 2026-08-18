/**
 * 聚合网关主服务：统一 IM 渠道的注册、会话路由、命令、审批桥与出站投递。
 *
 * 数据流：
 * - 入站：渠道 adapter → authorize → 命令? → merge → router 定位会话 → followup
 * - 出站：session/event（assistant/message）→ 按 sessionId 路由回渠道 → 分片 send
 * - 审批：approval/request waterfall → 推送到会话所在 chat → 回复「批准/拒绝」→ 返回 verdict
 * @module dsh-im-gateway/core/gateway
 */
import type { Context } from '@deepseek-ai/cordis';
import { type MergeResult } from './merge.js';
import type { ChannelAdapter, ImGatewayConfig, ImMessage } from './types.js';
export interface GatewayOptions {
    config: ImGatewayConfig;
    /** 登录状态落盘目录（扫码链接等）。 */
    stateDir: string;
    log: (line: string) => void;
    /** 未授权用户触达时回调（如登记待授权请求）。返回给用户的提示文案（默认引导去设置批准）。 */
    onUnauthorized?: (channelId: string, msg: ImMessage) => string;
    /** 每聊天工作区偏好的持久化（/workspace 命令）。 */
    workspaceStore?: {
        load(): Array<[string, string]>;
        save(entries: Array<[string, string]>): void;
    };
    /** 会话标题缓存持久化（/sessions 列表用；dsh 标题缺失时的兜底）。 */
    titleStore?: {
        load(): Record<string, string>;
        save(titles: Record<string, string>): void;
    };
    /** 会话最后活动时间持久化（/sessions 按活动排序，与 Web 一致）。 */
    activityStore?: {
        load(): Record<string, number>;
        save(activity: Record<string, number>): void;
    };
    /** 会话日志根目录（$DSH_HOME/sessions），用于读取历史会话的最后更新时间。 */
    sessionsRoot?: string;
    /** 每 chat 最后绑定的会话持久化（重启后自动恢复上次会话）。 */
    chatSessionStore?: {
        load(): Record<string, string>;
        save(sessions: Record<string, string>): void;
    };
}
export declare class ImGateway {
    private readonly ctx;
    private readonly config;
    private readonly stateDir;
    private readonly logLine;
    /** 工作区偏好持久化（/workspace 命令）。 */
    private readonly workspaceStore;
    /** 会话标题缓存（sessionId → 标题；dsh 标题缺失时兜底）。 */
    private readonly titleStore;
    private readonly titles;
    /** 会话最后活动时间（sessionId → epoch ms），/sessions 排序用。 */
    private readonly activityStore;
    /** 会话日志根目录（历史会话 update_time 读取）。 */
    private readonly sessionsRoot;
    private readonly lastActivity;
    private readonly channels;
    private readonly router;
    private readonly broker;
    private readonly questionBroker;
    private restoreUserQuestionsAsk;
    private readonly merger;
    private readonly mergeBuffers;
    private readonly disposeEvents;
    private readonly disposeTools;
    /** 未授权回调（manager 登记待授权请求用）；options.onUnauthorized 兜底。 */
    private unauthorizedHandler;
    /** UI 批准的渠道白名单（manager 同步），重启后由 manager 重新灌入。 */
    private readonly extraAllowlist;
    /** im_cron 注册表（index.ts 接线后注入；工具经它读写定时任务）。 */
    private cron;
    constructor(ctx: Context, options: GatewayOptions);
    register(channel: ChannelAdapter): void;
    unregister(channelId: string): void;
    channel(channelId: string): ChannelAdapter | undefined;
    listChannels(): ChannelAdapter[];
    /** 注入 im_cron 注册表（index.ts 构造后接线用）。 */
    setCronRegistry(registry: import('./cron.js').CronRegistry): void;
    /** 注册 im_cron 工具：agent 在聊天里一句话创建/查看/删除聊天级定时任务。 */
    private registerCronTools;
    /** 当前会话所在 chat（首个绑定 chat；无则 undefined）。 */
    private chatOfSession;
    /** im_cron_add 执行体（可测试）：任务绑定当前 chat，防越权。 */
    cronAddFromSession(sessionId: string | undefined, input: Record<string, unknown>): Promise<{
        ok: boolean;
        detail: string;
    }>;
    /** im_cron_list 执行体：仅返回当前 chat 的任务。 */
    cronListFromSession(sessionId: string | undefined): Promise<{
        ok: boolean;
        detail: string;
    }>;
    /** im_cron_rm 执行体：仅允许删除当前 chat 的任务。 */
    cronRemoveFromSession(sessionId: string | undefined, id: string): Promise<{
        ok: boolean;
        detail: string;
    }>;
    /** 设置未授权回调（manager 构造后接线用）。 */
    setUnauthorizedHandler(handler: (channelId: string, msg: ImMessage) => string): void;
    /** 添加 UI 批准的渠道白名单用户（manager 同步调用；重启后重新灌入）。 */
    addAuthorizedUser(channelId: string, userId: string): void;
    private handleInbound;
    /** 把媒体消息组装成 content blocks（图片走 attachments → image block；文件/视频注明路径）。 */
    private buildMediaBlocks;
    /** 把文本注入目标 chat 的 agent 会话，返回给用户的可选回执。 */
    private injectText;
    /** 把 content blocks 注入目标 chat 的 agent 会话，返回给用户的可选回执。 */
    private injectBlocks;
    /** 会话首次收到用户消息时记录标题（dsh 标题缺失时的兜底显示）。 */
    private recordTitleIfNeeded;
    /** 记录会话最后活动时间（followup 注入时调用）。 */
    private recordActivity;
    /** 从会话日志懒读取标题（/sessions 列表时对无标题会话补全，结果缓存）。 */
    private lazyTitle;
    private ackFor;
    /** 注册 im_send_file 工具：agent 把工作区文件发给当前 IM 聊天。 */
    private registerSendMediaTool;
    /** 把文件发送到会话关联的所有渠道（im_send_file 工具的执行体，可测试）。 */
    sendFileToChats(filePath: string, caption?: string, channelFilter?: string, sessionId?: string): Promise<{
        ok: boolean;
        detail: string;
    }>;
    private authorized;
    /** 恢复该 chat 上次绑定的会话（命令也触发，使 /status 显示真实状态；失败静默）。 */
    private ensureChatRestored;
    private handleCommand;
    /** 持久化每聊天工作区偏好。 */
    private persistWorkspaces;
    /** 列出所有工作区（按会话数排序）。 */
    private listWorkspaces;
    /** 列出会话：标题优先、目录置顶分组、按最后更新时间排序。 */
    private listSessions;
    /** 会话最后更新时间：网关注入缓存 → 日志文件 mtime → createdAt。 */
    private updateTimeOf;
    private installQuestionBridge;
    private answerQuestion;
    private broadcastToSession;
    private handleApprovalRequest;
    private answerApproval;
    private handleSessionEvent;
    private deliver;
    dispose(): void;
    stopAgents(): Promise<void>;
}
/** 消息合并结果类型再导出（供渠道层无感知使用）。 */
export type { MergeResult };
//# sourceMappingURL=gateway.d.ts.map