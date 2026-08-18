/**
 * 聚合网关主服务：统一 IM 渠道的注册、会话路由、命令、审批桥与出站投递。
 *
 * 数据流：
 * - 入站：渠道 adapter → authorize → 命令? → merge → router 定位会话 → followup
 * - 出站：session/event（assistant/message）→ 按 sessionId 路由回渠道 → 分片 send
 * - 审批：approval/request waterfall → 推送到会话所在 chat → 回复「批准/拒绝」→ 返回 verdict
 * @module dsh-im-gateway/core/gateway
 */
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { readFile, stat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { ApprovalBroker } from './approval.js';
import { QuestionBroker, formatAnswerSummary, formatQuestionPrompt } from './questions.js';
import { SessionMerger } from './merge.js';
import { SessionRouter } from './router.js';
import { splitText } from './split.js';
import { toPlainText } from './format.js';
const PLUGIN_NAME = 'dsh-im-gateway';
const HELP_TEXT = [
    '🤖 dsh-im-gateway 可用命令：',
    '/help — 本帮助',
    '/status — 查询当前会话（会话 id / 工作区 / 待批准）',
    '/new — 开启全新会话（per-chat 模式）',
    '/clear — 同 /new',
    '/workspaces — 列出所有工作区',
    '/workspace <路径> — 切换工作区（后续 /new 生效）',
    '/sessions [all|路径] — 列出会话（默认当前工作区；all 全部）',
    '/continue <会话id> — 继续已有会话（跨渠道/跨工作区）',
    '/bind <session-id> — 绑定本机 live 会话（bound 模式）',
    '/unbind — 解绑（bound 模式）',
    '/channels — 各渠道连接状态',
    '/cron list — 查看本聊天定时任务',
    '/cron rm <id> — 删除定时任务（im_cron 工具创建）',
    '批准 / 拒绝 — 应答待批准的请求',
    '编号 / 选项文字 — 回答待处理的 ask_user_question（多选用逗号）',
    '普通文本直接发给 agent；结尾 .. 表示还有后续，!! 表示立即提交',
].join('\n');
const TURN_END_LABEL = {
    completed: '✅ 完成',
    error: '❌ 出错',
    aborted: '⏹ 已中止',
    blocked: '🚫 被阻塞',
    'max-tokens': '↯ 达到 token 上限',
    interrupted: '⏸ 被打断',
};
export class ImGateway {
    ctx;
    config;
    stateDir;
    logLine;
    /** 工作区偏好持久化（/workspace 命令）。 */
    workspaceStore;
    /** 会话标题缓存（sessionId → 标题；dsh 标题缺失时兜底）。 */
    titleStore;
    titles = new Map();
    /** 会话最后活动时间（sessionId → epoch ms），/sessions 排序用。 */
    activityStore;
    /** 会话日志根目录（历史会话 update_time 读取）。 */
    sessionsRoot;
    lastActivity = new Map();
    channels = new Map();
    router;
    broker = new ApprovalBroker();
    questionBroker = new QuestionBroker();
    restoreUserQuestionsAsk;
    merger;
    mergeBuffers = new Map();
    disposeEvents = [];
    disposeTools = [];
    /** 未授权回调（manager 登记待授权请求用）；options.onUnauthorized 兜底。 */
    unauthorizedHandler;
    /** UI 批准的渠道白名单（manager 同步），重启后由 manager 重新灌入。 */
    extraAllowlist = new Map();
    /** im_cron 注册表（index.ts 接线后注入；工具经它读写定时任务）。 */
    cron;
    constructor(ctx, options) {
        this.ctx = ctx;
        this.config = options.config;
        this.stateDir = options.stateDir;
        this.logLine = options.log;
        this.unauthorizedHandler = options.onUnauthorized;
        this.workspaceStore = options.workspaceStore;
        this.titleStore = options.titleStore;
        for (const [sid, title] of Object.entries(options.titleStore?.load() ?? {}))
            this.titles.set(sid, title);
        this.activityStore = options.activityStore;
        this.sessionsRoot = options.sessionsRoot ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions');
        for (const [sid, time] of Object.entries(options.activityStore?.load() ?? {}))
            this.lastActivity.set(sid, time);
        this.router = new SessionRouter(ctx, {
            cwd: this.config.cwd,
            provider: this.config.provider,
            model: this.config.model,
            agentPreset: this.config.agentPreset ?? 'standard',
            chatSessionStore: options.chatSessionStore,
        });
        // 恢复每聊天工作区偏好
        this.router.restoreWorkspaces(options.workspaceStore?.load() ?? []);
        this.merger = new SessionMerger({
            mergeTimeoutMs: this.config.mergeTimeoutSecs * 1000,
            onSnapshot: (key, buffer) => this.mergeBuffers.set(key, buffer),
            onFlush: (key, text) => {
                const [channelId, chatId] = splitKey(key);
                if (!channelId || !chatId)
                    return;
                void this.injectText(channelId, chatId, text);
            },
        });
        // 崩溃恢复：未 flush 的合并缓冲（重启后超时即提交）
        for (const [key, buffer] of this.mergeBuffers)
            this.merger.restore(key, buffer);
        // 出站：agent 输出 → 渠道
        this.disposeEvents.push(ctx.on('session/event', (session, event) => {
            this.handleSessionEvent(session, event);
        }, { global: true }));
        // 审批桥：approval/request waterfall
        this.disposeEvents.push(ctx.on('approval/request', async (req, next) => {
            return this.handleApprovalRequest(req, next);
        }, { global: true }));
        // 交互式提问桥：保留 Web provider，同时让绑定 IM 并行回答 ask_user_question
        this.installQuestionBridge();
        // 工具：agent 可以把工作区文件发给当前 IM 聊天（图片/视频/文档）
        this.registerSendMediaTool();
    }
    // ── 渠道注册 ──────────────────────────────────────────────
    register(channel) {
        if (this.channels.has(channel.id))
            return;
        this.channels.set(channel.id, channel);
        channel.setMessageHandler((msg) => this.handleInbound(channel.id, msg));
    }
    unregister(channelId) {
        this.channels.delete(channelId);
    }
    channel(channelId) {
        return this.channels.get(channelId);
    }
    listChannels() {
        return [...this.channels.values()];
    }
    /** 注入 im_cron 注册表（index.ts 构造后接线用）。 */
    setCronRegistry(registry) {
        this.cron = registry;
        this.registerCronTools();
    }
    /** 注册 im_cron 工具：agent 在聊天里一句话创建/查看/删除聊天级定时任务。 */
    registerCronTools() {
        const tools = this.ctx.tools;
        if (!tools)
            return;
        try {
            const disposer = tools.register({
                name: 'im_cron_add',
                description: '创建聊天级定时提醒：到点直接推送到当前 IM 聊天，与会话轮换（/new）无关。' +
                    '用户说「提醒我…/定时…/几点叫我/多少分钟后叫我」时优先使用本工具；' +
                    '不要使用 schedule_create——它绑定会话，/new 轮换后提醒会丢失，而本工具绑定聊天不受影响。' +
                    'at 为一次性提醒（ISO 8601 带时区偏移，或本地时刻配合 tz）；time 为每天/每周周期提醒；二者选一。' +
                    'remind 模式到点直推文案；task 模式（一次性 agent 执行）暂未实现。',
                parameters: {
                    type: 'object',
                    properties: {
                        prompt: { type: 'string', description: '提醒文案（如：该去拿证件了）' },
                        at: { type: 'string', description: '一次性提醒时刻：ISO 8601 带时区偏移（如 2026-09-18T09:00:00+08:00），或本地时刻（如 2026-09-18T09:00:00）配合 tz；与 time 二选一' },
                        time: { type: 'string', description: '周期提醒：本地时刻 HH:MM（24 小时制），如 09:00；与 at 二选一' },
                        days: { type: 'array', items: { type: 'number' }, description: '星期 1=周一…7=周日；省略=每天' },
                        tz: { type: 'string', description: 'IANA 时区（如 Asia/Hong_Kong）；省略=进程默认' },
                        mode: { type: 'string', enum: ['remind', 'task'], description: 'remind=到点直推（默认）；task=一次性 agent 执行（未实现）' },
                        workspace: { type: 'string', description: 'task 模式的工作目录（可选）' },
                    },
                    required: ['prompt'],
                },
                output: {
                    schema: {
                        type: 'object',
                        properties: {
                            ok: { type: 'boolean' },
                            detail: { type: 'string' },
                        },
                        required: ['ok', 'detail'],
                    },
                    render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
                },
                execute: async (args, exec) => {
                    const sessionId = exec.agent?.session?.id;
                    return this.cronAddFromSession(sessionId ? String(sessionId) : undefined, args);
                },
            });
            this.disposeTools.push(disposer);
            const disposerList = tools.register({
                name: 'im_cron_list',
                description: '列出当前 IM 聊天已创建的定时任务（id / 时刻 / 星期 / 文案 / 下次触发）。',
                parameters: { type: 'object', properties: {} },
                output: {
                    schema: {
                        type: 'object',
                        properties: {
                            ok: { type: 'boolean' },
                            detail: { type: 'string' },
                        },
                        required: ['ok', 'detail'],
                    },
                    render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
                },
                execute: async (args, exec) => {
                    const sessionId = exec.agent?.session?.id;
                    return this.cronListFromSession(sessionId ? String(sessionId) : undefined);
                },
            });
            this.disposeTools.push(disposerList);
            const disposerRm = tools.register({
                name: 'im_cron_rm',
                description: '删除当前 IM 聊天的一个定时任务（仅限本聊天创建的任务）。',
                parameters: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: '任务 id（im_cron_list 返回）' },
                    },
                    required: ['id'],
                },
                output: {
                    schema: {
                        type: 'object',
                        properties: {
                            ok: { type: 'boolean' },
                            detail: { type: 'string' },
                        },
                        required: ['ok', 'detail'],
                    },
                    render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
                },
                execute: async (args, exec) => {
                    const sessionId = exec.agent?.session?.id;
                    return this.cronRemoveFromSession(sessionId ? String(sessionId) : undefined, String(args.id ?? ''));
                },
            });
            this.disposeTools.push(disposerRm);
        }
        catch (err) {
            this.logLine(`[gateway] im_cron 工具注册失败: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    /** 当前会话所在 chat（首个绑定 chat；无则 undefined）。 */
    chatOfSession(sessionId) {
        if (!sessionId)
            return undefined;
        return this.router.chatsForSession(sessionId)[0];
    }
    /** im_cron_add 执行体（可测试）：任务绑定当前 chat，防越权。 */
    async cronAddFromSession(sessionId, input) {
        const registry = this.cron;
        if (!registry)
            return { ok: false, detail: 'im_cron 服务未就绪' };
        const chat = this.chatOfSession(sessionId);
        if (!chat)
            return { ok: false, detail: '当前会话没有关联的 IM 聊天（仅 IM 发起的会话可用此工具）' };
        const days = Array.isArray(input.days) ? input.days.map(Number) : [];
        const at = typeof input.at === 'string' && input.at !== '' ? input.at : undefined;
        const time = typeof input.time === 'string' && input.time !== '' ? input.time : undefined;
        const result = registry.addTask({
            channelId: chat.channelId,
            chatId: chat.chatId,
            ...(at !== undefined ? { at } : { time: time ?? '' }),
            days,
            ...(typeof input.tz === 'string' && input.tz !== '' ? { tz: input.tz } : {}),
            mode: input.mode === 'task' ? 'task' : 'remind',
            prompt: String(input.prompt ?? ''),
            ...(typeof input.workspace === 'string' && input.workspace !== '' ? { workspace: input.workspace } : {}),
        });
        if (!result.ok)
            return { ok: false, detail: result.error };
        const next = new Date(result.task.nextRunAt).toISOString();
        return { ok: true, detail: `已创建定时提醒 ${result.task.id}：${result.task.time}，下次触发 ${next}` };
    }
    /** im_cron_list 执行体：仅返回当前 chat 的任务。 */
    async cronListFromSession(sessionId) {
        const registry = this.cron;
        if (!registry)
            return { ok: false, detail: 'im_cron 服务未就绪' };
        const chat = this.chatOfSession(sessionId);
        if (!chat)
            return { ok: false, detail: '当前会话没有关联的 IM 聊天' };
        const tasks = registry.list().filter((t) => t.channelId === chat.channelId && t.chatId === chat.chatId);
        if (tasks.length === 0)
            return { ok: true, detail: '本聊天还没有定时任务。例：创建「每天 09:00 提醒我喝水」' };
        const rows = tasks.map((t) => {
            const when = `${t.time}${t.days.length ? ' 周' + t.days.join('、') : ' 每天'}`;
            const next = new Date(t.nextRunAt).toISOString();
            return `[${t.id}] ${when} · ${t.prompt.slice(0, 40)}${t.enabled ? '' : '（已停用）'} · 下次 ${next}`;
        });
        return { ok: true, detail: rows.join('\n') };
    }
    /** im_cron_rm 执行体：仅允许删除当前 chat 的任务。 */
    async cronRemoveFromSession(sessionId, id) {
        const registry = this.cron;
        if (!registry)
            return { ok: false, detail: 'im_cron 服务未就绪' };
        const chat = this.chatOfSession(sessionId);
        if (!chat)
            return { ok: false, detail: '当前会话没有关联的 IM 聊天' };
        const task = registry.list().find((t) => t.id === id);
        if (!task)
            return { ok: false, detail: `任务不存在：${id}` };
        if (task.channelId !== chat.channelId || task.chatId !== chat.chatId) {
            return { ok: false, detail: '只能删除本聊天创建的任务' };
        }
        registry.remove(id);
        return { ok: true, detail: `已删除任务 ${id}` };
    }
    /** 设置未授权回调（manager 构造后接线用）。 */
    setUnauthorizedHandler(handler) {
        this.unauthorizedHandler = handler;
    }
    /** 添加 UI 批准的渠道白名单用户（manager 同步调用；重启后重新灌入）。 */
    addAuthorizedUser(channelId, userId) {
        let set = this.extraAllowlist.get(channelId);
        if (!set) {
            set = new Set();
            this.extraAllowlist.set(channelId, set);
        }
        set.add(userId);
    }
    // ── 入站流水线 ────────────────────────────────────────────
    async handleInbound(channelId, msg) {
        const channel = this.channels.get(channelId);
        if (!channel)
            return;
        try {
            // 0. 恢复该 chat 的上次会话绑定（命令也会触发，使 /status 显示真实状态）
            await this.ensureChatRestored(channelId, msg.chatId);
            // 1. 命令（不经合并窗口）
            if (msg.text.startsWith('/')) {
                const reply = await this.handleCommand(channel, msg);
                if (reply !== undefined)
                    await channel.send(msg.chatId, reply);
                return;
            }
            // 2. 批准 / 拒绝（应答审批）
            const verdictText = msg.text.trim();
            if (verdictText === '批准' || verdictText === '同意' || verdictText === 'yes' || verdictText === 'y' || verdictText === 'allow') {
                const handled = await this.answerApproval(channel, msg, true);
                if (handled)
                    return;
            }
            if (verdictText === '拒绝' || verdictText === 'no' || verdictText === 'n' || verdictText === 'reject' || verdictText === 'deny') {
                const handled = await this.answerApproval(channel, msg, false);
                if (handled)
                    return;
            }
            // 3. 白名单：渠道本地授权（如微信扫码用户）优先，其次网关全局白名单
            const localAuth = channel.authorizes?.(msg.userId ?? '');
            if (localAuth === false || (localAuth === undefined && !this.authorized(channelId, msg.userId))) {
                this.logLine(`[${channelId}] 未授权用户 ${msg.userId ?? '(匿名)'} 消息被拦截（已登记待授权）`);
                const reply = this.unauthorizedHandler?.(channelId, msg) ?? '⛔ 未授权：请在 dsh 设置 → IM 网关 中批准你的访问请求。';
                await channel.send(msg.chatId, reply).catch(() => undefined);
                return;
            }
            // 4. ask_user_question 回答：在普通消息注入前消费
            if (await this.answerQuestion(channel, msg))
                return;
            // 5. 媒体消息：直接注入（不过合并窗口）
            if (msg.media && msg.media.length > 0) {
                const blocks = await this.buildMediaBlocks(msg);
                if (blocks.length > 0) {
                    const ack = await this.injectBlocks(channelId, msg.chatId, blocks);
                    if (ack)
                        await channel.send(msg.chatId, ack);
                }
                return;
            }
            // 6. 合并窗口
            const key = `${channelId}:${msg.chatId}`;
            const result = this.merger.ingest(key, msg.text);
            if (result.kind === 'flushed' && result.text) {
                const ack = await this.injectText(channelId, msg.chatId, result.text);
                if (ack)
                    await channel.send(msg.chatId, ack);
            }
        }
        catch (err) {
            this.logLine(`[${channelId}] 消息处理失败: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    /** 把媒体消息组装成 content blocks（图片走 attachments → image block；文件/视频注明路径）。 */
    async buildMediaBlocks(msg) {
        const blocks = [];
        if (msg.text !== '')
            blocks.push({ type: 'text', text: msg.text });
        for (const m of msg.media ?? []) {
            try {
                if (m.kind === 'voice-text' && m.text) {
                    blocks.push({ type: 'text', text: `[语音] ${m.text}` });
                }
                else if (m.kind === 'image') {
                    let data = m.data;
                    if (!data && m.path) {
                        try {
                            data = new Uint8Array(await readFile(m.path));
                        }
                        catch { /* 读取失败走文本说明 */ }
                    }
                    if (data && this.ctx.attachments) {
                        try {
                            const ref = await this.ctx.attachments.saveImage({
                                data,
                                mediaType: (m.mediaType ?? 'image/jpeg'),
                                name: m.name,
                            });
                            blocks.push({ type: 'image', attachment: ref });
                            continue;
                        }
                        catch (err) {
                            this.logLine(`[gateway] 图片保存失败（降级为路径说明）: ${err instanceof Error ? err.message : String(err)}`);
                        }
                    }
                    blocks.push({ type: 'text', text: `[用户发来图片${m.name ? `：${m.name}` : ''}${m.path ? `，已保存到 ${m.path}` : ''}]` });
                }
                else if (m.kind === 'file' || m.kind === 'video') {
                    blocks.push({
                        type: 'text',
                        text: `[用户发来${m.kind === 'video' ? '视频' : '文件'}${m.name ? `：${m.name}` : ''}，已保存到 ${m.path ?? '（未知路径）'}]`,
                    });
                }
            }
            catch (err) {
                this.logLine(`[gateway] 媒体 block 构建失败: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        return blocks;
    }
    /** 把文本注入目标 chat 的 agent 会话，返回给用户的可选回执。 */
    async injectText(channelId, chatId, text) {
        return this.injectBlocks(channelId, chatId, [{ type: 'text', text }]);
    }
    /** 把 content blocks 注入目标 chat 的 agent 会话，返回给用户的可选回执。 */
    async injectBlocks(channelId, chatId, blocks) {
        // source 必须为 user：Web 端只把 source.kind==='user' 的消息渲染为用户气泡，
        // plugin 来源会被显示为 context（看起来像"没同步"）
        const message = createUserMessage({
            content: blocks,
            source: { kind: 'user' },
        });
        if (this.config.sessionMode === 'bound') {
            const entry = this.router.get(channelId, chatId);
            if (!entry) {
                return '还没有绑定会话。请先用 /bind <session-id> 绑定一个 DSH 会话，或用 /status 查看。';
            }
            const agent = this.ctx.agents.get(SessionId(entry.sessionId));
            if (!agent) {
                return `会话 ${entry.sessionId} 当前没有运行中的 agent，无法注入。`;
            }
            agent.followup(message);
            this.logLine(`[${channelId}] 消息注入会话 ${entry.sessionId}`);
            return this.ackFor(blocks);
        }
        const entry = await this.router.getOrCreate(channelId, chatId);
        // 优先用自建 handle 的 agent；复用的 live agent 从 entry.agent 取
        const target = entry.handle?.agent ?? entry.agent;
        if (!target) {
            return `会话 ${entry.sessionId} 当前没有运行中的 agent，无法注入。`;
        }
        target.followup(message);
        this.logLine(`[${channelId}] 消息注入会话 ${entry.sessionId}`);
        this.recordTitleIfNeeded(entry.sessionId, blocks);
        this.recordActivity(entry.sessionId);
        return this.ackFor(blocks);
    }
    /** 会话首次收到用户消息时记录标题（dsh 标题缺失时的兜底显示）。 */
    recordTitleIfNeeded(sessionId, blocks) {
        if (this.titles.has(sessionId))
            return;
        const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
        const title = summarizeTitle(text);
        if (title) {
            this.titles.set(sessionId, title);
            this.titleStore?.save(Object.fromEntries(this.titles));
        }
    }
    /** 记录会话最后活动时间（followup 注入时调用）。 */
    recordActivity(sessionId) {
        this.lastActivity.set(sessionId, Date.now());
        this.activityStore?.save(Object.fromEntries(this.lastActivity));
    }
    /** 从会话日志懒读取标题（/sessions 列表时对无标题会话补全，结果缓存）。 */
    async lazyTitle(sessionId) {
        const cached = this.titles.get(sessionId);
        if (cached !== undefined)
            return cached;
        const query = this.ctx.sessionQuery;
        if (!query)
            return undefined;
        try {
            const snapshot = await query.readSession(SessionId(sessionId));
            const firstUser = snapshot.events.find((e) => e.type === 'user/message');
            if (!firstUser)
                return undefined;
            // user/message 事件的 data 即 UserMessage（{ id, role, content, source }）
            const data = firstUser.data;
            const text = (data.content ?? [])
                .filter((b) => b.type === 'text')
                .map((b) => b.text ?? '')
                .join('')
                .trim();
            const title = summarizeTitle(text);
            if (title) {
                this.titles.set(sessionId, title);
                this.titleStore?.save(Object.fromEntries(this.titles));
            }
            return title;
        }
        catch {
            return undefined;
        }
    }
    ackFor(blocks) {
        const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
        return text.length >= this.config.longInputAckChars ? '收到，处理中，稍后给你完整回复。' : '';
    }
    /** 注册 im_send_file 工具：agent 把工作区文件发给当前 IM 聊天。 */
    registerSendMediaTool() {
        const tools = this.ctx.tools;
        if (!tools)
            return;
        try {
            const disposer = tools.register({
                name: 'im_send_file',
                description: '把工作区文件发送给当前 IM 会话的用户（微信/Telegram/飞书等渠道）。支持图片、视频和任意文档；' +
                    'channel 可指定渠道 id（默认发送到所有关联渠道），caption 为可选附言。',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: '要发送的文件路径（相对或绝对）' },
                        caption: { type: 'string', description: '附言文本（可选，先于文件发送）' },
                        channel: { type: 'string', description: '目标渠道 id（可选，默认所有关联渠道）' },
                    },
                    required: ['path'],
                },
                output: {
                    schema: {
                        type: 'object',
                        properties: {
                            ok: { type: 'boolean' },
                            detail: { type: 'string' },
                        },
                        required: ['ok', 'detail'],
                    },
                    render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
                },
                execute: async (args, exec) => {
                    const { path, caption, channel: channelFilter } = args;
                    const sessionId = exec.agent?.session?.id;
                    return this.sendFileToChats(path, caption, channelFilter, sessionId ? String(sessionId) : undefined);
                },
            });
            this.disposeTools.push(disposer);
        }
        catch (err) {
            this.logLine(`[gateway] im_send_file 工具注册失败: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    /** 把文件发送到会话关联的所有渠道（im_send_file 工具的执行体，可测试）。 */
    async sendFileToChats(filePath, caption, channelFilter, sessionId) {
        const chats = sessionId ? this.router.chatsForSession(sessionId) : [];
        if (chats.length === 0) {
            return { ok: false, detail: '当前会话没有关联的 IM 聊天（仅 IM 发起的会话可用此工具）' };
        }
        const details = [];
        let anyOk = false;
        for (const chat of chats) {
            if (channelFilter && chat.channelId !== channelFilter)
                continue;
            const ch = this.channels.get(chat.channelId);
            if (!ch?.sendMedia) {
                details.push(`${chat.channelId}: 该渠道不支持发送文件`);
                continue;
            }
            try {
                await ch.sendMedia(chat.chatId, filePath, caption);
                details.push(`${chat.channelId}: 已发送 ${filePath}`);
                anyOk = true;
            }
            catch (err) {
                details.push(`${chat.channelId}: 发送失败（${err instanceof Error ? err.message : String(err)}）`);
            }
        }
        if (details.length === 0)
            details.push('没有匹配的渠道');
        return { ok: anyOk, detail: details.join('；') };
    }
    // ── 白名单 ────────────────────────────────────────────────
    authorized(channelId, userId) {
        if (this.config.allowAllUsers)
            return true;
        if (!userId)
            return false;
        const perChannel = this.config.allowedUserIds[channelId];
        if (perChannel && perChannel.includes(userId))
            return true;
        // 扁平兜底：keys 为 * 或空时按全局名单
        const global = this.config.allowedUserIds['*'];
        if (global && global.includes(userId))
            return true;
        // UI 批准的渠道白名单
        const extra = this.extraAllowlist.get(channelId);
        if (extra && extra.has(userId))
            return true;
        return false;
    }
    // ── 命令 ──────────────────────────────────────────────────
    /** 恢复该 chat 上次绑定的会话（命令也触发，使 /status 显示真实状态；失败静默）。 */
    async ensureChatRestored(channelId, chatId) {
        if (this.router.get(channelId, chatId))
            return;
        const last = this.router.lastSessionOf(channelId, chatId);
        if (!last)
            return;
        const restored = await this.router.continueSession(channelId, chatId, last);
        if (restored.ok) {
            this.logLine(`[${channelId}] 会话自动恢复：${last}`);
        }
    }
    async handleCommand(channel, msg) {
        const [rawCmd, ...args] = msg.text.trim().split(/\s+/);
        const cmd = rawCmd?.toLowerCase();
        const channelId = channel.id;
        const chatId = msg.chatId;
        switch (cmd) {
            case '/help':
                return HELP_TEXT;
            case '/status': {
                const entry = this.router.get(channelId, chatId);
                let sessionLabel = '（无）';
                if (entry) {
                    // 标题在前：dsh 标题优先（与 /sessions 一致），网关缓存兜底，不懒读保持快速
                    let title = '';
                    try {
                        const obs = await this.ctx.sessionQuery.readTitleSnapshots([SessionId(entry.sessionId)]);
                        title = dshTitleOf(obs[0]);
                    }
                    catch { /* 忽略 */ }
                    if (!title)
                        title = this.titles.get(entry.sessionId) ?? '';
                    sessionLabel = title ? `「${title.slice(0, 40)}」 ${entry.sessionId}` : entry.sessionId;
                }
                const lines = [
                    `会话模式：${this.config.sessionMode}`,
                    `当前工作区：${this.router.workspaceOf(channelId, chatId) ?? this.config.cwd}`,
                    `绑定会话：${sessionLabel}`,
                    `待批准：${this.broker.size > 0 ? `${this.broker.size} 个` : '无'}`,
                ];
                return lines.join('\n');
            }
            case '/new':
            case '/clear': {
                if (this.config.sessionMode === 'bound') {
                    this.router.unbind(channelId, chatId);
                    return '已解绑。用 /bind <session-id> 绑定新会话。';
                }
                const entry = await this.router.rotate(channelId, chatId);
                return entry ? `已开启全新会话：${entry.sessionId}（工作区 ${entry.workspace ?? this.config.cwd}）` : '尚未有会话。';
            }
            case '/workspaces': {
                return await this.listWorkspaces();
            }
            case '/workspace': {
                const pathArg = args[0];
                if (!pathArg) {
                    const current = this.router.workspaceOf(channelId, chatId) ?? this.config.cwd;
                    return `当前工作区：${current}\n用法：/workspace <路径> 切换（后续 /new 生效）`;
                }
                // 相对路径基于全局 cwd 解析
                const target = pathArg.startsWith('/') ? pathArg : resolve(this.config.cwd, pathArg);
                try {
                    if (!statSync(target).isDirectory())
                        return `不是目录：${target}`;
                }
                catch {
                    return `目录不存在：${target}`;
                }
                this.router.setWorkspace(channelId, chatId, target);
                this.persistWorkspaces();
                return `✅ 工作区已切换：${target}\n发送 /new 在此工作区开启新会话，或 /sessions 查看该工作区的历史会话。`;
            }
            case '/sessions': {
                // 默认当前聊天工作区（与 Web 侧边栏当前工作区视角一致）；all 显示全部
                const filter = args[0];
                let workspace;
                if (filter === 'all') {
                    workspace = undefined;
                }
                else if (filter) {
                    workspace = filter.startsWith('/') ? filter : resolve(this.config.cwd, filter);
                }
                else {
                    workspace = this.router.workspaceOf(channelId, chatId) ?? this.config.cwd;
                }
                return await this.listSessions(workspace);
            }
            case '/continue': {
                const sessionId = args[0];
                if (!sessionId)
                    return '用法：/continue <会话id>（用 /sessions 查看）';
                const r = await this.router.continueSession(channelId, chatId, sessionId);
                if (!r.ok)
                    return `❌ ${r.error}`;
                return `✅ 已继续会话 ${sessionId}${r.workspace ? `（工作区 ${r.workspace}）` : ''}\n直接发消息即可继续对话。`;
            }
            case '/bind': {
                const sessionId = args[0];
                if (!sessionId)
                    return '用法：/bind <session-id>';
                const r = this.router.bind(channelId, chatId, sessionId, msg.userId);
                return r.ok ? `已绑定会话 ${sessionId}。` : `绑定失败：${r.error}`;
            }
            case '/unbind':
                this.router.unbind(channelId, chatId);
                return '已解绑。';
            case '/channels': {
                const lines = ['渠道状态：'];
                for (const ch of this.channels.values()) {
                    const status = ch.status?.() ?? (ch ? '运行中' : '');
                    lines.push(`• ${ch.label} (${ch.id}) — ${status || '运行中'}`);
                }
                return lines.join('\n');
            }
            case '/cron': {
                const sub = args[0]?.toLowerCase();
                if (sub === 'rm' && args[1]) {
                    return (await this.cronRemoveFromSession(this.router.get(channelId, chatId)?.sessionId, args[1])).detail;
                }
                if (sub && sub !== 'list')
                    return '用法：/cron list 或 /cron rm <id>';
                return (await this.cronListFromSession(this.router.get(channelId, chatId)?.sessionId)).detail;
            }
            default:
                return `未知命令 ${cmd}。发送 /help 查看可用命令。`;
        }
    }
    // ── 会话 / 工作区查询 ─────────────────────────────────────
    /** 持久化每聊天工作区偏好。 */
    persistWorkspaces() {
        this.workspaceStore?.save(this.router.workspaceEntries());
    }
    /** 列出所有工作区（按会话数排序）。 */
    async listWorkspaces() {
        const query = this.ctx.sessionQuery;
        if (!query)
            return '会话查询服务不可用。';
        let records;
        try {
            records = await query.listSessions();
        }
        catch (err) {
            return `列出工作区失败：${err instanceof Error ? err.message : String(err)}`;
        }
        const byWorkspace = new Map();
        for (const r of records) {
            const cwd = r.header.cwd ?? '(未知工作区)';
            const cur = byWorkspace.get(cwd) ?? { count: 0, last: 0 };
            cur.count += 1;
            if (r.header.createdAt > cur.last)
                cur.last = r.header.createdAt;
            byWorkspace.set(cwd, cur);
        }
        const rows = [...byWorkspace.entries()].sort((a, b) => b[1].last - a[1].last);
        const body = rows.slice(0, 20)
            .map(([cwd, info]) => `• ${cwd}（${info.count} 会话，最近 ${relTime(info.last)}）`)
            .join('\n\n');
        return [
            '',
            `📁 工作区（${rows.length} 个）：`,
            body,
            '用 /workspace <路径> 切换；/sessions <路径> 查看会话。',
            '',
        ].join('\n\n');
    }
    /** 列出会话：标题优先、目录置顶分组、按最后更新时间排序。 */
    async listSessions(workspace) {
        const query = this.ctx.sessionQuery;
        if (!query)
            return '会话查询服务不可用。';
        let records;
        try {
            records = await query.listSessions();
        }
        catch (err) {
            return `列出会话失败：${err instanceof Error ? err.message : String(err)}`;
        }
        const filtered = workspace ? records.filter((r) => (r.header.cwd ?? '') === workspace) : records;
        if (filtered.length === 0) {
            return workspace
                ? `该工作区没有会话：${workspace}\n发送 /new 开启一个。`
                : '还没有任何会话。发送 /new 开启一个。';
        }
        // 更新时间：网关注入缓存 → 会话日志文件 mtime → createdAt 兜底
        const updates = new Map();
        await runBatched(filtered.slice(0, 40), 8, async (r) => {
            updates.set(String(r.header.id), await this.updateTimeOf(r));
        });
        // 按最后更新时间排序（与 Web 的 updatedAt 一致）
        filtered.sort((a, b) => {
            const uA = updates.get(String(a.header.id)) ?? a.header.createdAt;
            const uB = updates.get(String(b.header.id)) ?? b.header.createdAt;
            return uB - uA || String(a.header.id).localeCompare(String(b.header.id));
        });
        const top = filtered.slice(0, 20);
        let titles = [];
        try {
            const observations = await query.readTitleSnapshots(top.map((r) => r.header.id));
            // 真实结构: { sessionId, status: 'fulfilled'|'rejected', value: { session, title?: { title } } }
            titles = observations;
        }
        catch (err) { /* 标题读取失败不阻塞 */ }
        // 无 dsh 标题的会话：用缓存标题，仍无则懒读取会话日志补全（限制并发，显示范围内全部补）
        const needBackfill = top.map((r, i) => ({ r, i })).filter(({ r, i }) => {
            const dshTitle = dshTitleOf(titles[i]);
            return !dshTitle && !this.titles.has(String(r.header.id));
        });
        await runBatched(needBackfill.slice(0, 20), 3, async ({ r }) => {
            await this.lazyTitle(String(r.header.id));
        });
        const rowOf = (r, live, index) => {
            const title = dshTitleOf(titles[index]) || this.titles.get(String(r.header.id)) || '';
            const updated = updates.get(String(r.header.id)) ?? r.header.createdAt ?? 0;
            // 序号 → 标题 → 会话编号 → 更新时间 → 状态
            return `[${index + 1}] ${title ? `「${title.slice(0, 40)}」` : ''} ${r.header.id}${updated ? ` · ${relTime(updated)}` : ''} ${live ? '🟢' : '💤'}`;
        };
        // 每个块（标题/组头/条目/提示）之间都插入空行，避免微信等客户端里粘连
        const chunks = ['', `📋 ${workspace ? `会话（当前工作区 ${workspace}）` : '全部会话'}：${filtered.length} 个${filtered.length > 20 ? `，显示前 20` : ''}${workspace ? `（/sessions all 查看全部）` : ''}`];
        if (workspace) {
            // 单工作区：目录放顶部一次，条目不再重复目录
            top.forEach((r, i) => {
                chunks.push('', rowOf(r, r.live, i));
            });
        }
        else {
            // 全部：按工作区分区，先目录再其下会话
            const groups = new Map();
            top.forEach((r, i) => {
                const cwd = r.header.cwd ?? '(未知工作区)';
                const list = groups.get(cwd) ?? [];
                list.push({ r, i });
                groups.set(cwd, list);
            });
            for (const [cwd, members] of groups) {
                chunks.push('', `📁 ${cwd}（${members.length} 个会话）`);
                for (const { r, i } of members) {
                    chunks.push('', rowOf(r, r.live, i));
                }
            }
        }
        chunks.push('', '用 /continue <会话id> 继续某个会话。', '');
        return chunks.join('\n');
    }
    /** 会话最后更新时间：网关注入缓存 → 日志文件 mtime → createdAt。 */
    async updateTimeOf(record) {
        const id = String(record.header.id);
        const cached = this.lastActivity.get(id);
        if (cached)
            return cached;
        try {
            const logPath = sessionLogPathOf(record.header.cwd, id, this.sessionsRoot);
            if (logPath) {
                const st = await stat(logPath);
                return st.mtimeMs;
            }
        }
        catch { /* 无文件则用 createdAt */ }
        return record.header.createdAt ?? 0;
    }
    // ── 交互式提问桥（ask_user_question）──────────────────────
    installQuestionBridge() {
        const service = this.ctx.userQuestions;
        const originalAsk = service.ask;
        const wrappedAsk = async (request) => {
            const sessionId = request.agent ? String(request.agent.id) : '';
            const chats = sessionId ? this.router.chatsForSession(sessionId) : [];
            if (!sessionId || chats.length === 0)
                return originalAsk.call(service, request);
            const questionTimeoutSecs = Math.max(1, this.config.questionTimeoutSecs ?? 600);
            const timeoutMs = questionTimeoutSecs * 1000;
            const webAbort = new AbortController();
            const forwardAbort = () => webAbort.abort(request.signal?.reason);
            request.signal?.addEventListener('abort', forwardAbort, { once: true });
            const imWait = this.questionBroker.wait(sessionId, request.questions, timeoutMs, request.signal);
            await Promise.all(chats.map((chat) => this.deliver(chat, formatQuestionPrompt(request.questions, questionTimeoutSecs))));
            this.logLine(`[questions] 会话 ${sessionId} 的 ${request.questions.length} 个问题已同步到 ${chats.length} 个 IM 聊天`);
            const webWait = originalAsk.call(service, { ...request, signal: webAbort.signal }).then((answer) => ({ kind: 'web', answer }), (error) => ({ kind: 'web-error', error }));
            const finishWeb = async () => {
                const web = await webWait;
                if (web.kind === 'web-error')
                    throw web.error;
                this.questionBroker.finishFromWeb(sessionId, web.answer);
                await this.broadcastToSession(sessionId, `✅ 已在网页端回答：${formatAnswerSummary(request.questions, web.answer)}`);
                return web.answer;
            };
            try {
                const first = await Promise.race([webWait, imWait]);
                if (first.kind === 'web') {
                    this.questionBroker.finishFromWeb(sessionId, first.answer);
                    await this.broadcastToSession(sessionId, `✅ 已在网页端回答：${formatAnswerSummary(request.questions, first.answer)}`);
                    return first.answer;
                }
                if (first.kind === 'web-error') {
                    this.questionBroker.cancel(sessionId);
                    throw first.error;
                }
                if (first.kind === 'answered') {
                    webAbort.abort();
                    void webWait;
                    await this.broadcastToSession(sessionId, `✅ 已选择：${formatAnswerSummary(request.questions, first.answer)}\n回答端：${first.source.label ?? first.source.channelId}`);
                    return first.answer;
                }
                if (first.kind === 'external')
                    return first.answer;
                if (first.kind === 'timeout') {
                    await this.broadcastToSession(sessionId, '⌛ IM 回答窗口已结束，请在网页端继续选择。');
                }
                // cancelled / busy / timeout：Web provider 仍是最终兜底。
                return finishWeb();
            }
            finally {
                request.signal?.removeEventListener('abort', forwardAbort);
            }
        };
        service.ask = wrappedAsk;
        this.restoreUserQuestionsAsk = () => {
            if (service.ask === wrappedAsk)
                service.ask = originalAsk;
        };
    }
    async answerQuestion(channel, msg) {
        const entry = this.router.get(channel.id, msg.chatId);
        if (!entry)
            return false;
        const questions = this.questionBroker.questionsFor(entry.sessionId);
        const result = this.questionBroker.answer(entry.sessionId, msg.text, {
            channelId: channel.id,
            chatId: msg.chatId,
            label: channel.label,
        });
        if (result.kind === 'not-pending')
            return false;
        if (result.kind === 'invalid') {
            await channel.send(msg.chatId, `⚠️ 无法识别这个选择：${result.message}`).catch(() => undefined);
            return true;
        }
        if (result.kind === 'already-answered') {
            await channel.send(msg.chatId, `ℹ️ ${result.message}`).catch(() => undefined);
            return true;
        }
        if (questions)
            this.logLine(`[questions] 会话 ${entry.sessionId} 由 ${channel.id}:${msg.chatId} 回答：${formatAnswerSummary(questions, result.answer)}`);
        return true;
    }
    async broadcastToSession(sessionId, text) {
        await Promise.all(this.router.chatsForSession(sessionId).map((chat) => this.deliver(chat, text)));
    }
    // ── 审批桥 ────────────────────────────────────────────────
    async handleApprovalRequest(req, next) {
        const sessionId = String(req.agent.session.id);
        const chats = this.router.chatsForSession(sessionId);
        if (chats.length === 0)
            return next();
        const timeoutMs = this.config.approvalTimeoutSecs * 1000;
        const text = [
            `⚠️ 批准请求（${timeoutMs / 1000}s 内回复「批准」或「拒绝」）`,
            `工具：${req.toolName}`,
            req.reason ? `原因：${req.reason}` : '',
            '回复「批准」或「拒绝」，超时转回本机批准体系。',
        ].filter(Boolean).join('\n');
        const verdicts = await Promise.all(chats.map(async (chat) => {
            const channel = this.channels.get(chat.channelId);
            if (!channel)
                return undefined;
            await channel.send(chat.chatId, text).catch(() => undefined);
            return this.broker.wait(sessionId, timeoutMs, req.signal);
        }));
        // 任一 chat 批准 → 放行；任一拒绝 → 拒绝；否则委托下游
        if (verdicts.includes('allow'))
            return 'allowed-once';
        if (verdicts.includes('reject'))
            return 'rejected';
        return next();
    }
    async answerApproval(channel, msg, allow) {
        const entry = this.router.get(channel.id, msg.chatId);
        if (!entry)
            return false;
        const answered = this.broker.answer(entry.sessionId, allow);
        if (answered)
            await channel.send(msg.chatId, allow ? '已批准 ✅' : '已拒绝 ❌').catch(() => undefined);
        return answered;
    }
    // ── 出站：会话事件 → 渠道 ─────────────────────────────────
    handleSessionEvent(session, event) {
        const chats = this.router.chatsForSession(String(session.id));
        if (chats.length === 0)
            return;
        switch (event.type) {
            case 'turn/start':
                for (const chat of chats) {
                    const channel = this.channels.get(chat.channelId);
                    void channel?.sendAction?.(chat.chatId, 'typing').catch(() => undefined);
                }
                break;
            case 'assistant/message': {
                const text = assistantText(event);
                if (text === undefined)
                    return;
                for (const chat of chats)
                    this.deliver(chat, text);
                break;
            }
            case 'turn/end': {
                if (!this.config.summaryOnTurnEnd)
                    return;
                const label = TURN_END_LABEL[event.data.reason.kind] ?? event.data.reason.kind;
                // 失败时附带错误详情，渠道里直接可见
                const reason = event.data.reason;
                const detail = reason.kind === 'error' && reason.error?.message ? `\n原因：${reason.error.message.slice(0, 300)}` : '';
                for (const chat of chats) {
                    const channel = this.channels.get(chat.channelId);
                    if (!channel)
                        continue;
                    void channel.send(chat.chatId, `[${label}] 会话 ${String(session.id)} 第 ${event.data.turn} 轮结束${detail}`).catch(() => undefined);
                }
                break;
            }
            default:
                break;
        }
    }
    async deliver(chat, text) {
        const channel = this.channels.get(chat.channelId);
        if (!channel)
            return;
        const plain = toPlainText(text);
        if (plain === '')
            return;
        for (const chunk of splitText(plain, channel.maxMessageLength)) {
            await channel.send(chat.chatId, chunk).catch(() => undefined);
        }
    }
    // ── 生命周期 ──────────────────────────────────────────────
    dispose() {
        this.restoreUserQuestionsAsk?.();
        this.restoreUserQuestionsAsk = undefined;
        for (const off of this.disposeEvents)
            off();
        this.disposeEvents.length = 0;
        for (const off of this.disposeTools)
            off();
        this.disposeTools.length = 0;
        this.merger.dispose();
        this.broker.dispose();
        this.questionBroker.dispose();
    }
    async stopAgents() {
        await this.router.disposeAll();
    }
}
/** 提取 assistant 消息的文本块拼接。 */
function assistantText(event) {
    const blocks = event.data.message.content.filter((block) => block.type === 'text');
    return blocks.length === 0 ? undefined : blocks.map((block) => block.text).join('');
}
function splitKey(key) {
    const idx = key.indexOf(':');
    if (idx < 0)
        return ['', ''];
    return [key.slice(0, idx), key.slice(idx + 1)];
}
/** 相对时间显示（x 分钟/小时/天前）。 */
function relTime(ms) {
    const diff = Date.now() - ms;
    const min = Math.floor(diff / 60_000);
    if (min < 1)
        return '刚刚';
    if (min < 60)
        return `${min} 分钟前`;
    const hours = Math.floor(min / 60);
    if (hours < 24)
        return `${hours} 小时前`;
    return `${Math.floor(hours / 24)} 天前`;
}
/** 从 readTitleSnapshots 观测结果中取 dsh 标题（真实结构: status 'fulfilled' + value.title.title）。 */
function dshTitleOf(observation) {
    if (observation?.status !== 'fulfilled')
        return '';
    return observation.value?.title?.title ?? '';
}
/**
 * 从文本生成简短标题：与 dsh session-title 官方 fallback 算法一致
 * （清洗控制字符 + 取前 5 词 + 40 字节 UTF-8 截断），另去掉命令/终端前缀。
 */
function summarizeTitle(text) {
    const clean = text
        // 去掉 IM 命令前缀
        .replace(/^\/(help|status|new|clear|sessions|workspace\S*|continue\S*|workspaces|bind\S*|unbind|channels)(\s|$).*$/m, '')
        // 去掉终端提示符前缀（如 chasemoon@host ~ %）
        .replace(/^[\w.-]+@[\w.-]+[^\n]{0,30}?[%$#]\s*/m, '')
        // 去掉围栏代码块
        .replace(/```[\s\S]*?```/g, ' ')
        // 清洗控制字符与 ANSI 转义（对齐 dsh cleanTitleText）
        .replace(/[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e]/g, '')
        // 空白归一化
        .replace(/\s+/g, ' ')
        .trim();
    if (clean === '')
        return '';
    // 前 5 词（对齐 dsh fallbackMaxWords: 5）
    const words = clean.split(' ').filter(Boolean).slice(0, 5).join(' ');
    // 40 字节 UTF-8 截断（对齐 dsh fallbackMaxBytes: 40），不拆散码点
    if (Buffer.byteLength(words, 'utf8') <= 40)
        return words;
    let used = 0;
    let out = '';
    for (const ch of words) {
        const bytes = Buffer.byteLength(ch, 'utf8');
        if (used + bytes > 40)
            break;
        out += ch;
        used += bytes;
    }
    return out;
}
/** 分批并发执行（限制并发数，避免一次性打爆资源）。 */
async function runBatched(items, batchSize, fn) {
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        await Promise.all(batch.map((item) => fn(item).catch(() => undefined)));
    }
}
/** 会话日志文件路径：$DSH_HOME/sessions/<工作区编码>/<会话id编码>/session.jsonl.zstd。 */
function sessionLogPathOf(cwd, id, sessionsRoot) {
    if (!cwd)
        return undefined;
    const wsDir = `--${cwd.replace(/^\/+|\/+$/g, '').replace(/\//g, '-')}--`;
    const idDir = encodeURIComponent(id).replace(/%/g, '~');
    return join(sessionsRoot, wsDir, idDir, 'session.jsonl.zstd');
}
//# sourceMappingURL=gateway.js.map