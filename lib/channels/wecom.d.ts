/**
 * 企业微信智能机器人渠道：官方 WebSocket 长连接。
 * 扫码创建后的 Bot ID/Secret 由 core/provisioning.ts 写入配置。
 */
import type { ChannelAdapter } from '../core/types.js';
export interface WecomChannelConfig {
    enabled?: boolean;
    botId?: string;
    secret?: string;
}
export declare function createWecomChannel(config: WecomChannelConfig, log: (line: string) => void): ChannelAdapter | undefined;
//# sourceMappingURL=wecom.d.ts.map