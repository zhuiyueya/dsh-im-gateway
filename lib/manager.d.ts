/**
 * 渠道管理器：UI 驱动的渠道生命周期（启用/停用/刷新二维码/状态查询）。
 *
 * - 持久化：`$DSH_HOME/dsh-im-gateway/channels.json`（UI 配置优先于 cordis config）
 * - 动态启停：无需重启 dsh，点「连接」即生效
 * - HTTP API：`/dsh-im-gateway/api/*`（Web GUI 面板调用）
 * @module dsh-im-gateway/manager
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ImGatewayConfig } from './core/types.js';
import { ImGateway } from './core/gateway.js';
import type { CronRegistry } from './core/cron.js';
import { type ChannelMeta } from './channels/index.js';
/** 设置页统一展示的渠道状态；底层协议细节只保留在 adapter 日志中。 */
export type ChannelDisplayStatus = '已连接' | '未连接' | '连接中' | '异常';
export declare function normalizeChannelStatus(input: {
    running: boolean;
    rawStatus?: string;
    loginUrl?: string;
    provisioningStatus?: string;
}): ChannelDisplayStatus;
/** 前端展示用的渠道视图。 */
export interface ChannelView {
    id: string;
    label: string;
    emoji: string;
    /** 本地图标文件名（assets/icons/），前端经 /dsh-im-gateway/api/icon/<id> 加载；缺省回退 emoji。 */
    icon?: string;
    docs?: string;
    kind: ChannelMeta['kind'];
    needs: string[];
    fields: ChannelMeta['fields'];
    hint: string;
    /** 是否已在 UI 中启用（channels.json 或 cordis 配置）。 */
    enabled: boolean;
    /** 是否正在运行（adapter 已启动）。 */
    running: boolean;
    /** 设置页统一状态，不暴露 WebSocket、轮询等 adapter 实现细节。 */
    status: ChannelDisplayStatus;
    /** 登录二维码 URL（设备扫码类渠道，如微信）。 */
    loginUrl?: string;
    /** 是否支持官方扫码创建/绑定机器人。 */
    qrProvisioning: boolean;
    /** 官方扫码接入状态。 */
    provisioningStatus?: string;
    /** 本地生成的二维码 data URL。 */
    provisioningQrDataUrl?: string;
    /** 二维码过期时刻。 */
    provisioningExpiresAt?: number;
    /** 扫码流程安全化错误摘要（不包含凭据）。 */
    provisioningError?: string;
    /** 已配置的凭据键（脱敏，仅显示哪些已填）。 */
    configuredKeys: string[];
    /** UI 批准的渠道白名单用户。 */
    allowlist: string[];
}
export interface ManagerOptions {
    config: ImGatewayConfig;
    stateDir: string;
    log: (line: string) => void;
    gateway: ImGateway;
    /** im_cron 注册表（/api/cron 管理端点用）。 */
    cron: CronRegistry;
}
export declare class ChannelManager {
    private readonly ctx;
    private readonly options;
    private readonly stateFile;
    private readonly cron;
    private store;
    /** 渠道级白名单（UI 批准的用户）：channelId → userId[]。 */
    private allowlist;
    /** 待授权请求：channelId → 请求列表。 */
    private pending;
    /** 运行中的 adapter：id → { adapter }。 */
    private readonly running;
    /** 官方扫码接入尝试：同一渠道最多一个。 */
    private readonly provisioning;
    /** API 路由 disposer（HMR 重载/卸载时清理，避免重复注册）。 */
    private apiDisposers;
    constructor(ctx: Context, options: ManagerOptions);
    private load;
    private flush;
    /** 该用户是否已获授权（UI allowlist 或 cordis 配置白名单）。 */
    isAuthorized(channelId: string, userId: string): boolean;
    /** 记录一个待授权请求（去重）。 */
    requestAuthorization(channelId: string, userId: string, username?: string, chatId?: string): void;
    /** 批准用户：加入渠道白名单并同步网关。 */
    approve(channelId: string, userId: string): {
        ok: boolean;
        error?: string;
    };
    /** 拒绝用户：仅移除待授权请求。 */
    deny(channelId: string, userId: string): void;
    private removePending;
    /** 全部待授权请求（跨渠道聚合，UI 横幅用）。 */
    pendingRequests(): Array<{
        channelId: string;
        userId: string;
        username?: string;
        time: number;
    }>;
    /** 合并配置：channels.json（UI）优先，cordis config 兜底。 */
    private mergedConfig;
    /** 启动时初始化：合并配置中应启用的渠道全部启动；并把持久化白名单灌入网关。 */
    initAll(): Promise<void>;
    /** 持久化白名单条目（重启恢复用）。 */
    allowlistEntries(): Array<[string, string[]]>;
    /** 启用并启动一个渠道。extra 里的字段合并进配置并持久化。 */
    connect(id: string, extra?: Record<string, unknown>): Promise<{
        ok: boolean;
        error?: string;
    }>;
    /**
     * 停用并停止一个渠道（仅运行态，不持久化 enabled——重启后按配置自动恢复）。
     * 彻底移除配置请用 {@link remove}。
     */
    disconnect(id: string): Promise<void>;
    /** 彻底移除渠道：停止并删除持久化配置（重启后不再自动连接）。 */
    remove(id: string): Promise<void>;
    /** 刷新登录（重新启停，用于重新取二维码）。 */
    refreshLogin(id: string): Promise<{
        ok: boolean;
        error?: string;
    }>;
    /** 开始官方扫码创建/绑定机器人（飞书、QQ 等）。 */
    startProvisioning(id: string): Promise<{
        ok: boolean;
        error?: string;
    }>;
    /** 取消官方扫码接入尝试。 */
    cancelProvisioning(id: string): Promise<void>;
    /** 渠道视图列表（UI 渲染用）。 */
    list(): ChannelView[];
    /** 注册 HTTP API（prefix 路由，由 webServer 提供）。 */
    registerApi(): void;
    /** 注销 API 路由（HMR 重载/插件卸载时调用）。 */
    disposeApi(): void;
    /** 停用全部渠道（插件卸载时）。 */
    disconnectAll(): Promise<void>;
}
//# sourceMappingURL=manager.d.ts.map