/**
 * 钉钉机器人渠道：官方 Stream 长连接；支持扫码创建后的 Client ID/Secret。
 * 扫码授权由 core/provisioning.ts 负责，adapter 只负责收发消息。
 */
import type { ChannelAdapter } from '../core/types.js';
export interface DingTalkChannelConfig {
    enabled?: boolean;
    clientId?: string;
    clientSecret?: string;
}
export declare function safeDingTalkSessionWebhook(value: unknown): string | undefined;
export declare function createDingTalkChannel(config: DingTalkChannelConfig, log: (line: string) => void): ChannelAdapter | undefined;
//# sourceMappingURL=dingtalk.d.ts.map