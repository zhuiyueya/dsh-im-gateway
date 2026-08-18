/**
 * 微信渠道适配器：腾讯官方 iLink Bot 协议（ilinkai.weixin.qq.com）。
 * 与 OpenClaw 官方插件 @tencent-weixin/openclaw-weixin 同协议：
 * - 扫码登录 → 长轮询收消息 → context_token 回复
 * - 媒体收发：图片/语音/文件/视频，CDN AES-128-ECB 加密上传/下载
 * - "正在输入"状态（getconfig → sendtyping）
 *
 * ⚠️ 仅私聊、一个账号一个 poller；建议使用专用小号。
 * 使用本渠道即表示同意《微信ClawBot功能使用条款》（腾讯官方产品，非逆向方案）。
 * @module dsh-im-gateway/channels/wechat
 */
import type { ChannelAdapter } from '../core/types.js';
export interface WechatChannelConfig {
    enabled?: boolean;
    /** 登录/上下文/媒体落盘目录。 */
    stateDir?: string;
    pollTimeoutSecs?: number;
}
/** CDN 基址（官方插件同款）。 */
export declare const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
/**
 * 微信客户端渲染已知行为：消息里的单个 `\n` 会被折叠成空格，
 * 只有空行（`\n\n`）才渲染为换行。发送前把单换行提升为双换行，
 * 已有空行保持原样（不把 `\n\n` 变成 `\n\n\n\n`）。
 */
export declare function normalizeWechatNewlines(text: string): string;
/** PKCS7 填充后的密文大小。 */
export declare function aesEcbPaddedSize(plaintextSize: number): number;
export declare function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer;
export declare function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer;
/**
 * 解析 CDNMedia.aes_key 为 16 字节原始 key。
 * 野外有两种编码：base64(16 原始字节)（图片）或 base64(hex 字符串)（文件/语音/视频）。
 */
export declare function parseAesKey(aesKeyBase64: string, label?: string): Buffer;
/** 构建 CDN 下载 URL。 */
export declare function buildCdnDownloadUrl(encryptedQueryParam: string, cdnBaseUrl?: string): string;
export declare function mimeFromExt(ext: string): string;
export declare function createWechatChannel(config: WechatChannelConfig, log: (line: string) => void, stateDir: string): ChannelAdapter | undefined;
//# sourceMappingURL=wechat.d.ts.map