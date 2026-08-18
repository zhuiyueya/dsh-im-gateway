/**
 * 渠道注册表：把配置对象映射为各渠道 adapter 实例。
 * 每个 factory 在凭据缺失/未启用时返回 undefined（不启动）。
 * @module dsh-im-gateway/channels
 */
import type { ChannelAdapter, ImGatewayConfig } from '../core/types.js';
import { createTelegramChannel } from './telegram.js';
import { createDiscordChannel } from './discord.js';
import { createSlackChannel } from './slack.js';
import { createFeishuChannel } from './feishu.js';
import { createWechatChannel } from './wechat.js';
export type ChannelLog = (line: string) => void;
/** 渠道 id 列表（展示顺序即推荐顺序）。 */
export declare const CHANNEL_IDS: readonly ["wechat", "feishu", "dingtalk", "wecom", "qqbot", "telegram", "discord", "slack", "whatsapp", "signal", "msteams", "line", "matrix", "mattermost", "googlechat", "irc", "twitch", "nostr", "nextcloud", "synology", "zalo", "imessage", "tlon", "yuanbao", "voice"];
export type ChannelId = (typeof CHANNEL_IDS)[number];
/** 渠道展示元数据（UI 面板用）。 */
export interface ChannelField {
    key: string;
    label: string;
    /** 密文字段（输入框用 password）。 */
    secret?: boolean;
}
export interface ChannelMeta {
    label: string;
    emoji: string;
    /** 本地品牌图标文件名（assets/icons/<icon>，前端经 /dsh-im-gateway/api/icon/<id> 加载）；缺省回退 emoji。 */
    icon?: string;
    /** 是否有官方扫码创建/绑定机器人流程。 */
    qrProvisioning?: boolean;
    /** 凭据获取/官方文档地址（前端显示为链接）。 */
    docs?: string;
    /** 连接所需的最小配置字段（UI 表单提示）。 */
    needs: string[];
    /** 凭据表单字段（kind=credentials 时渲染输入框）。 */
    fields: ChannelField[];
    /** 一句话连接说明。 */
    hint: string;
    /** 连接方式：qr=扫码登录 credentials=填凭据 simple=开关即用 stub=未实现。 */
    kind: 'qr' | 'credentials' | 'simple' | 'stub';
}
export declare const CHANNEL_META: Record<ChannelId, ChannelMeta>;
/** 创建单个渠道（凭据缺失/未启用返回 undefined）。 */
export declare function createChannel(id: string, config: Record<string, unknown>, log: ChannelLog, stateDir: string): ChannelAdapter | undefined;
/** 创建全部已配置渠道。stateDir 供扫码/状态类渠道落盘。 */
export declare function createChannels(config: ImGatewayConfig, log: ChannelLog, stateDir: string): ChannelAdapter[];
export { createTelegramChannel, createDiscordChannel, createSlackChannel, createFeishuChannel, createWechatChannel };
//# sourceMappingURL=index.d.ts.map