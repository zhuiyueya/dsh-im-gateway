/**
 * 渠道管理器：UI 驱动的渠道生命周期（启用/停用/刷新二维码/状态查询）。
 *
 * - 持久化：`$DSH_HOME/dsh-im-gateway/channels.json`（UI 配置优先于 cordis config）
 * - 动态启停：无需重启 dsh，点「连接」即生效
 * - HTTP API：`/dsh-im-gateway/api/*`（Web GUI 面板调用）
 * @module dsh-im-gateway/manager
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHANNEL_IDS, CHANNEL_META, createChannel } from './channels/index.js';
export class ChannelManager {
    ctx;
    options;
    stateFile;
    cron;
    store;
    /** 渠道级白名单（UI 批准的用户）：channelId → userId[]。 */
    allowlist;
    /** 待授权请求：channelId → 请求列表。 */
    pending;
    /** 运行中的 adapter：id → { adapter }。 */
    running = new Map();
    /** API 路由 disposer（HMR 重载/卸载时清理，避免重复注册）。 */
    apiDisposers = [];
    constructor(ctx, options) {
        this.ctx = ctx;
        this.options = options;
        this.cron = options.cron;
        this.stateFile = join(options.stateDir, 'channels.json');
        const loaded = this.load();
        this.store = loaded.channels;
        this.allowlist = loaded.allowlist;
        this.pending = loaded.pending;
    }
    load() {
        try {
            const raw = readFileSync(this.stateFile, 'utf8');
            const parsed = JSON.parse(raw);
            return {
                channels: parsed.channels ?? {},
                allowlist: parsed.allowlist ?? {},
                pending: parsed.pending ?? {},
            };
        }
        catch {
            return { channels: {}, allowlist: {}, pending: {} };
        }
    }
    flush() {
        try {
            mkdirSync(this.options.stateDir, { recursive: true });
            writeFileSync(this.stateFile, JSON.stringify({ channels: this.store, allowlist: this.allowlist, pending: this.pending }, null, 2));
        }
        catch (err) {
            this.options.log(`[manager] 状态落盘失败: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    // ── 授权 ─────────────────────────────────────────────────────
    /** 该用户是否已获授权（UI allowlist 或 cordis 配置白名单）。 */
    isAuthorized(channelId, userId) {
        if (this.options.config.allowAllUsers)
            return true;
        const fromAllowlist = this.allowlist[channelId];
        if (fromAllowlist && fromAllowlist.includes(userId))
            return true;
        const perChannel = this.options.config.allowedUserIds[channelId];
        if (perChannel && perChannel.includes(userId))
            return true;
        const global = this.options.config.allowedUserIds['*'];
        if (global && global.includes(userId))
            return true;
        return false;
    }
    /** 记录一个待授权请求（去重）。 */
    requestAuthorization(channelId, userId, username, chatId) {
        const list = this.pending[channelId] ?? [];
        if (!list.some((p) => p.userId === userId)) {
            list.push({ userId, username, chatId, time: Date.now() });
            this.pending[channelId] = list;
            this.flush();
            this.options.log(`[manager] ${channelId} 有待授权请求：${username ?? userId}`);
        }
    }
    /** 批准用户：加入渠道白名单并同步网关。 */
    approve(channelId, userId) {
        const list = this.allowlist[channelId] ?? [];
        if (!list.includes(userId)) {
            list.push(userId);
            this.allowlist[channelId] = list;
        }
        this.options.gateway.addAuthorizedUser(channelId, userId);
        this.removePending(channelId, userId);
        this.flush();
        this.options.log(`[manager] 已授权 ${channelId} 用户 ${userId}`);
        return { ok: true };
    }
    /** 拒绝用户：仅移除待授权请求。 */
    deny(channelId, userId) {
        this.removePending(channelId, userId);
        this.flush();
    }
    removePending(channelId, userId) {
        const list = this.pending[channelId];
        if (!list)
            return;
        this.pending[channelId] = list.filter((p) => p.userId !== userId);
        if (this.pending[channelId].length === 0)
            delete this.pending[channelId];
    }
    /** 全部待授权请求（跨渠道聚合，UI 横幅用）。 */
    pendingRequests() {
        const out = [];
        for (const [channelId, list] of Object.entries(this.pending)) {
            for (const p of list)
                out.push({ channelId, userId: p.userId, username: p.username, time: p.time });
        }
        return out;
    }
    /** 合并配置：channels.json（UI）优先，cordis config 兜底。 */
    mergedConfig(id) {
        const cordis = this.options.config.channels[id] ?? {};
        return { ...cordis, ...(this.store[id] ?? {}) };
    }
    /** 启动时初始化：合并配置中应启用的渠道全部启动；并把持久化白名单灌入网关。 */
    async initAll() {
        // 重启后恢复 UI 批准的渠道白名单
        for (const [channelId, users] of Object.entries(this.allowlist)) {
            for (const userId of users)
                this.options.gateway.addAuthorizedUser(channelId, userId);
        }
        for (const id of CHANNEL_IDS) {
            const cfg = this.mergedConfig(id);
            // 启用判定：cordis enabled=true，或 store 存在且未被显式禁用
            // （断开只停运行态不写 enabled，因此"配置了 = 重启自动恢复"）
            const stored = this.store[id];
            const enabled = cfg.enabled === true || (stored !== undefined && stored.enabled !== false);
            if (enabled) {
                await this.connect(id).catch((err) => {
                    this.options.log(`[manager] ${id} 启动失败: ${err instanceof Error ? err.message : String(err)}`);
                });
            }
        }
    }
    /** 持久化白名单条目（重启恢复用）。 */
    allowlistEntries() {
        return Object.entries(this.allowlist);
    }
    /** 启用并启动一个渠道。extra 里的字段合并进配置并持久化。 */
    async connect(id, extra) {
        const meta = CHANNEL_META[id];
        if (!meta)
            return { ok: false, error: `未知渠道 ${id}` };
        // 合并 extra → store
        if (extra) {
            this.store[id] = { ...(this.store[id] ?? {}), ...extra, enabled: true };
            this.flush();
        }
        const cfg = this.mergedConfig(id);
        if (this.running.has(id)) {
            // 已运行：extra 变更时先停再启
            await this.disconnect(id);
        }
        const adapter = createChannel(id, { ...cfg, enabled: true }, this.options.log, this.options.stateDir);
        if (!adapter) {
            const error = `${meta.label}：缺少必要配置（${meta.needs.join(' / ') || '未知原因'}）`;
            this.options.log(`[manager] ${id} 连接失败: ${error}`);
            return { ok: false, error };
        }
        this.options.gateway.register(adapter);
        this.running.set(id, adapter);
        try {
            await adapter.start();
            this.options.log(`[manager] ${id} 已连接`);
            return { ok: true };
        }
        catch (err) {
            this.running.delete(id);
            this.options.gateway.unregister(id);
            const error = `${meta.label} 启动失败：${err instanceof Error ? err.message : String(err)}`;
            this.options.log(`[manager] ${id} 启动失败: ${err instanceof Error ? err.message : String(err)}`);
            return { ok: false, error };
        }
    }
    /**
     * 停用并停止一个渠道（仅运行态，不持久化 enabled——重启后按配置自动恢复）。
     * 彻底移除配置请用 {@link remove}。
     */
    async disconnect(id) {
        const adapter = this.running.get(id);
        if (adapter) {
            await Promise.resolve(adapter.stop()).catch(() => undefined);
            this.running.delete(id);
            this.options.gateway.unregister(id);
        }
        this.options.log(`[manager] ${id} 已断开（配置保留，重启自动恢复）`);
    }
    /** 彻底移除渠道：停止并删除持久化配置（重启后不再自动连接）。 */
    async remove(id) {
        await this.disconnect(id);
        if (this.store[id]) {
            delete this.store[id];
            this.flush();
        }
        // 清空该渠道的授权与待授权
        delete this.allowlist[id];
        delete this.pending[id];
        this.flush();
        this.options.log(`[manager] ${id} 配置已删除`);
    }
    /** 刷新登录（重新启停，用于重新取二维码）。 */
    async refreshLogin(id) {
        await this.disconnect(id);
        return this.connect(id);
    }
    /** 渠道视图列表（UI 渲染用）。 */
    list() {
        const out = [];
        for (const id of CHANNEL_IDS) {
            const meta = CHANNEL_META[id];
            const adapter = this.running.get(id);
            const cfg = this.mergedConfig(id);
            out.push({
                id,
                label: meta.label,
                emoji: meta.emoji,
                iconDomain: meta.iconDomain,
                docs: meta.docs,
                kind: meta.kind,
                needs: meta.needs,
                fields: meta.fields,
                hint: meta.hint,
                enabled: this.store[id]?.enabled === true || (cfg.enabled === true && !this.store[id]),
                running: adapter !== undefined,
                status: adapter?.status?.() ?? '未连接',
                loginUrl: adapter?.loginUrl?.(),
                configuredKeys: Object.keys(cfg).filter((k) => k !== 'enabled' && cfg[k] !== undefined && cfg[k] !== ''),
                allowlist: this.allowlist[id] ?? [],
            });
        }
        return out;
    }
    /** 注册 HTTP API（prefix 路由，由 webServer 提供）。 */
    registerApi() {
        const webServer = this.ctx.webServer;
        if (!webServer)
            return;
        const send = (res, status, body) => {
            res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(body));
        };
        const readBody = (req) => new Promise((resolve) => {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                try {
                    resolve(body ? JSON.parse(body) : {});
                }
                catch {
                    resolve({});
                }
            });
        });
        this.apiDisposers.push(webServer.register({
            kind: 'prefix',
            path: '/dsh-im-gateway/api',
            handler: async (req, res) => {
                const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
                const parts = url.pathname.split('/').filter(Boolean); // [dsh-im-gateway, api, ...]
                // /dsh-im-gateway/api/channels
                if (parts[2] === 'channels' && parts.length === 3 && req.method === 'GET') {
                    send(res, 200, { ok: true, channels: this.list(), pending: this.pendingRequests() });
                    return;
                }
                // /dsh-im-gateway/api/cron
                if (parts[2] === 'cron' && parts.length === 3 && req.method === 'GET') {
                    send(res, 200, { ok: true, tasks: this.cron.list() });
                    return;
                }
                if (parts[2] === 'cron' && parts.length === 4 && req.method === 'POST') {
                    const id = parts[3];
                    const body = await readBody(req);
                    if (id === 'delete') {
                        const removed = this.cron.remove(String(body.id ?? ''));
                        send(res, removed ? 200 : 404, { ok: removed, ...(removed ? {} : { error: `任务不存在：${String(body.id ?? '')}` }) });
                        return;
                    }
                    if (id === 'enable') {
                        const enabled = body.enabled !== false;
                        const done = this.cron.setEnabled(String(body.id ?? ''), enabled);
                        send(res, done ? 200 : 404, { ok: done, ...(done ? { enabled } : { error: `任务不存在：${String(body.id ?? '')}` }) });
                        return;
                    }
                    send(res, 404, { ok: false, error: `unknown cron action ${id}` });
                    return;
                }
                // /dsh-im-gateway/api/channels/<id>/connect|disconnect|refresh
                if (parts[2] === 'channels' && parts.length === 5) {
                    const id = parts[3];
                    const action = parts[4];
                    if (req.method !== 'POST') {
                        send(res, 405, { ok: false, error: 'method not allowed' });
                        return;
                    }
                    const body = await readBody(req);
                    if (action === 'connect') {
                        const result = await this.connect(id, body.config);
                        send(res, result.ok ? 200 : 400, result.ok ? { ok: true, channel: this.list().find((c) => c.id === id) } : { ok: false, error: result.error });
                        return;
                    }
                    if (action === 'disconnect') {
                        await this.disconnect(id);
                        send(res, 200, { ok: true, channel: this.list().find((c) => c.id === id) });
                        return;
                    }
                    if (action === 'remove') {
                        await this.remove(id);
                        send(res, 200, { ok: true, channel: this.list().find((c) => c.id === id) });
                        return;
                    }
                    if (action === 'refresh') {
                        const result = await this.refreshLogin(id);
                        send(res, result.ok ? 200 : 400, result.ok ? { ok: true, channel: this.list().find((c) => c.id === id) } : { ok: false, error: result.error });
                        return;
                    }
                    if (action === 'approve') {
                        const userId = String(body.userId ?? '');
                        if (!userId) {
                            send(res, 400, { ok: false, error: '缺少 userId' });
                            return;
                        }
                        this.approve(id, userId);
                        send(res, 200, { ok: true, channel: this.list().find((c) => c.id === id) });
                        return;
                    }
                    if (action === 'deny') {
                        const userId = String(body.userId ?? '');
                        if (!userId) {
                            send(res, 400, { ok: false, error: '缺少 userId' });
                            return;
                        }
                        this.deny(id, userId);
                        send(res, 200, { ok: true, channel: this.list().find((c) => c.id === id) });
                        return;
                    }
                    send(res, 404, { ok: false, error: `unknown action ${action}` });
                    return;
                }
                send(res, 404, { ok: false, error: 'not found' });
            },
        }));
        this.options.log('[manager] API 已注册（/dsh-im-gateway/api）');
    }
    /** 注销 API 路由（HMR 重载/插件卸载时调用）。 */
    disposeApi() {
        for (const disposer of this.apiDisposers)
            disposer();
        this.apiDisposers = [];
    }
    /** 停用全部渠道（插件卸载时）。 */
    async disconnectAll() {
        for (const id of [...this.running.keys()]) {
            await this.disconnect(id);
        }
    }
}
//# sourceMappingURL=manager.js.map