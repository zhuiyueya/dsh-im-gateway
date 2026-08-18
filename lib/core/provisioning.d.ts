/**
 * 渠道官方扫码接入：只负责生成二维码、等待平台返回机器人凭据。
 * 长连接仍由各渠道 adapter 负责；凭据成功后交回 manager 持久化并连接。
 */
export interface ProvisioningQr {
    dataUrl: string;
    expiresAt: number;
}
export interface ProvisioningCallbacks {
    onQr(qr: ProvisioningQr): void;
    onStatus(status: string): void;
    onCredentials(credentials: Record<string, unknown>): void | Promise<void>;
    onFailure(error: unknown): void;
}
export interface ProvisionerHandle {
    cancel(): void | Promise<void>;
}
export interface ChannelProvisioner {
    start(callbacks: ProvisioningCallbacks, signal: AbortSignal): Promise<ProvisionerHandle>;
}
/** 飞书官方 SDK registerApp：扫码创建应用并返回 App ID/Secret。 */
export declare const feishuProvisioner: ChannelProvisioner;
/** QQ 官方 connector：手机 QQ 扫码创建 QQ 开放平台机器人。 */
export declare const qqProvisioner: ChannelProvisioner;
/** 钉钉官方设备授权：初始化 → begin → 轮询，成功返回 Client ID/Secret。 */
export declare const dingtalkProvisioner: ChannelProvisioner;
export type WecomQrState = 'waiting' | 'success' | 'expired' | 'failed';
export declare function classifyWecomQrStatus(value: unknown): WecomQrState;
/** 企业微信官方智能机器人扫码授权。 */
export declare const wecomProvisioner: ChannelProvisioner;
export declare function provisionerFor(channelId: string): ChannelProvisioner | undefined;
//# sourceMappingURL=provisioning.d.ts.map