/**
 * dsh-im-gateway：DeepSeek Harness 聚合 IM 网关插件。
 *
 * 把 dsh agent 接入 20+ 聊天渠道（Telegram / Discord / Slack / 飞书 / 微信 /
 * QQ / WhatsApp / Signal / Teams / LINE / Matrix / Mattermost / Google Chat /
 * IRC / Twitch / Nostr / Nextcloud Talk / Synology Chat / Zalo / iMessage …），
 * 统一提供：每聊天一个 agent 会话、/new /status /bind 等命令、审批远程应答、
 * ask_user_question 交互提问桥、手机多段输入合并、长回复分片、白名单、媒体收发。
 *
 * 两种配置方式：
 * 1. Web GUI 设置面板「IM 网关」：点选渠道 → 扫码/填凭据 → 立即连接（无需重启）
 * 2. profile 的 cordis.patch.yml 写 im-gateway 行 config（或环境变量）
 *
 * @module dsh-im-gateway
 */
import Schema from '@deepseek-ai/schemastery';
import { ImGateway } from './core/gateway.js';
import { CronRegistry } from './core/cron.js';
import { ChannelManager } from './manager.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { acquireDshHomeInstanceLock } from './instance-lock.js';
export const name = 'dsh-im-gateway';
// agents：创建/查找 agent 会话；jobs：后台任务（扫码/轮询状态对 Web UI 可见）；
// tools：注册 im_send_file（agent → IM 发文件）；attachments：图片入站转 image block；
// webServer：提供设置面板调用的 HTTP API；agentPresets：创建/继续 agent 时挂入 preset
export const inject = ['agents', 'jobs', 'tools', 'attachments', 'webServer', 'sessionQuery', 'agentPresets', 'userQuestions'];
/** 网关部署配置。 */
export const Config = Schema.object({
    // 渠道配置用宽松 dict：任意渠道字段（token/appId 等）原样保留，按渠道读取
    channels: Schema.dict(Schema.any()).default({}),
    sessionMode: Schema.union(['per-chat', 'bound']).default('per-chat'),
    cwd: Schema.string().default(process.cwd()),
    provider: Schema.string().default('deepseek-official'),
    model: Schema.string().default('deepseek-v4-flash'),
    agentPreset: Schema.string().default('standard'),
    // 默认放行所有用户（个人/小团队开箱即用）；需要管控时改为 false 并配置白名单
    allowAllUsers: Schema.boolean().default(true),
    allowedUserIds: Schema.dict(Schema.array(Schema.string())).default({}),
    mergeTimeoutSecs: Schema.number().default(5),
    longInputAckChars: Schema.number().default(180),
    approvalTimeoutSecs: Schema.number().default(120),
    questionTimeoutSecs: Schema.number().default(600),
    summaryOnTurnEnd: Schema.boolean().default(true),
    // im_cron：聊天级定时任务（绑定 chatId，与会话轮换无关）
    cronTickIntervalSecs: Schema.number().default(30),
    cronMaxConcurrent: Schema.number().default(2),
    cronCatchUp: Schema.boolean().default(false),
    stateDir: Schema.string().default(''),
});
/**
 * 启动聚合网关。
 * @param ctx - Cordis 上下文；声明注入的服务。
 * @param config - 部署配置。
 */
export function apply(ctx, config) {
    const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    const instanceLock = acquireDshHomeInstanceLock(dshHome);
    try {
        ctx.effect(() => () => instanceLock.release(), 'im-gateway.instance-lock');
    }
    catch (error) {
        instanceLock.release();
        throw error;
    }
    const stateDir = config.stateDir !== ''
        ? config.stateDir
        : join(dshHome, 'dsh-im-gateway');
    mkdirSync(stateDir, { recursive: true });
    // 环形日志缓冲：Web UI 的 jobs readOutput 可读（扫码链接等），同时落盘便于排查
    const recent = [];
    const rawLog = ctx.logger(name);
    const logFile = join(stateDir, 'gateway.log');
    const log = (line) => {
        const stamped = `${new Date().toISOString()} ${line}`;
        recent.push(stamped);
        if (recent.length > 300)
            recent.splice(0, recent.length - 300);
        rawLog.info(line);
        try {
            writeFileSync(logFile, `${stamped}\n`, { flag: 'a' });
        }
        catch { /* 日志失败不影响运行 */ }
    };
    // 每聊天工作区偏好持久化（/workspace 命令）
    const workspaceFile = join(stateDir, 'workspaces.json');
    const workspaceStore = {
        load: () => {
            try {
                const parsed = JSON.parse(readFileSync(workspaceFile, 'utf8'));
                return Array.isArray(parsed) ? parsed : [];
            }
            catch {
                return [];
            }
        },
        save: (entries) => {
            try {
                mkdirSync(stateDir, { recursive: true });
                writeFileSync(workspaceFile, JSON.stringify(entries, null, 2));
            }
            catch (err) {
                log(`[manager] 工作区状态落盘失败: ${err instanceof Error ? err.message : String(err)}`);
            }
        },
    };
    // 会话标题缓存持久化（/sessions 列表兜底显示）
    const titleFile = join(stateDir, 'session-titles.json');
    const titleStore = {
        load: () => {
            try {
                const parsed = JSON.parse(readFileSync(titleFile, 'utf8'));
                return parsed && typeof parsed === 'object' ? parsed : {};
            }
            catch {
                return {};
            }
        },
        save: (titles) => {
            try {
                mkdirSync(stateDir, { recursive: true });
                writeFileSync(titleFile, JSON.stringify(titles, null, 2));
            }
            catch (err) {
                log(`[manager] 标题缓存落盘失败: ${err instanceof Error ? err.message : String(err)}`);
            }
        },
    };
    // 会话最后活动时间持久化（/sessions 按活动排序）
    const activityFile = join(stateDir, 'last-activity.json');
    const activityStore = {
        load: () => {
            try {
                const parsed = JSON.parse(readFileSync(activityFile, 'utf8'));
                return parsed && typeof parsed === 'object' ? parsed : {};
            }
            catch {
                return {};
            }
        },
        save: (activity) => {
            try {
                mkdirSync(stateDir, { recursive: true });
                writeFileSync(activityFile, JSON.stringify(activity, null, 2));
            }
            catch (err) {
                log(`[manager] 活动时间落盘失败: ${err instanceof Error ? err.message : String(err)}`);
            }
        },
    };
    // 每 chat 最后绑定的会话持久化（重启后自动恢复上次会话）
    const chatSessionFile = join(stateDir, 'chat-sessions.json');
    const chatSessionStore = {
        load: () => {
            try {
                const parsed = JSON.parse(readFileSync(chatSessionFile, 'utf8'));
                return parsed && typeof parsed === 'object' ? parsed : {};
            }
            catch {
                return {};
            }
        },
        save: (sessions) => {
            try {
                mkdirSync(stateDir, { recursive: true });
                writeFileSync(chatSessionFile, JSON.stringify(sessions, null, 2));
            }
            catch (err) {
                log(`[manager] 会话绑定落盘失败: ${err instanceof Error ? err.message : String(err)}`);
            }
        },
    };
    const gateway = new ImGateway(ctx, { config, stateDir, log, workspaceStore, titleStore, activityStore, chatSessionStore });
    // im_cron：聊天级定时任务（绑定 chatId，与会话轮换无关）
    const cron = new CronRegistry({
        stateDir,
        log,
        catchUp: config.cronCatchUp,
        send: async (channelId, chatId, text) => {
            const channel = gateway.channel(channelId);
            if (!channel)
                return false;
            try {
                await channel.send(chatId, text);
                return true;
            }
            catch (err) {
                log(`[cron] ${channelId} 发送失败: ${err instanceof Error ? err.message : String(err)}`);
                return false;
            }
        },
    });
    gateway.setCronRegistry(cron);
    const manager = new ChannelManager(ctx, { config, stateDir, log, gateway, cron });
    // 未授权用户 → 登记待授权请求（设置面板可一键批准，无需手动找用户 ID）
    gateway.setUnauthorizedHandler((channelId, msg) => {
        manager.requestAuthorization(channelId, msg.userId ?? '(匿名)', msg.username, msg.chatId);
        return '⛔ 未授权：请让管理员在 dsh 设置 → IM 网关 中批准你的访问请求。';
    });
    // im_cron tick：独立 effect，热重载时定时器随 effect 清理，不会残留双 tick
    ctx.effect(() => {
        const timer = setInterval(() => {
            void cron.tick();
        }, Math.max(1, config.cronTickIntervalSecs) * 1000);
        timer.unref?.();
        return () => {
            clearInterval(timer);
            cron.dispose();
        };
    }, 'im-gateway.cron');
    ctx.effect(() => {
        // 启动已启用渠道（channels.json / cordis 配置）
        void manager.initAll().then(() => {
            const running = manager.list().filter((c) => c.running);
            log(`网关启动完成：${running.length} 个渠道运行中（${running.map((c) => c.id).join(', ') || '无'}）`);
        });
        manager.registerApi();
        return () => {
            manager.disposeApi();
            void manager.disconnectAll();
            gateway.dispose();
            void gateway.stopAgents();
        };
    }, 'im-gateway.serve');
    // 后台任务：让 Web UI 能看到网关状态与扫码链接
    ctx.jobs.attachController(name);
    ctx.jobs.start({
        kind: 'im-gateway',
        label: 'IM 网关（设置面板可快速连接渠道）',
        run: () => {
            const timer = setInterval(() => {
                // 保持任务活跃；状态通过 readOutput 暴露
            }, 60_000);
            timer.unref?.();
            return {
                cancel: () => clearInterval(timer),
                done: Promise.resolve({ status: 'completed' }),
                readOutput: () => recent.splice(0).join('\n'),
            };
        },
    });
}
export * from './core/types.js';
export * from './core/gateway.js';
export * from './channels/index.js';
export * from './manager.js';
//# sourceMappingURL=index.js.map