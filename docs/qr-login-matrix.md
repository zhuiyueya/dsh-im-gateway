# 渠道扫码接入能力矩阵

> “扫码”至少有三种完全不同的含义：①关联个人设备；②扫码创建机器人应用；③把普通 OAuth/登录 URL 画成二维码。项目只把前两类标记为扫码接入，不把第三类包装成“一键扫码”。

## 已实现

| 渠道 | 类型 | 依据 | 实现 |
|---|---|---|---|
| 微信 | 设备关联 | 腾讯 iLink / `openclaw-weixin` | 手机微信扫码，登录态本地持久化 |
| WhatsApp | 设备关联（非官方 Web 协议） | Baileys linked-device flow | 手机 WhatsApp 扫码关联设备 |
| 飞书 / Lark | 官方扫码创建应用 | [飞书开放平台：扫码一键创建应用（Node.js）](https://open.feishu.cn/document/mcp_open_tools/integrating-agents-with-feishu/scan-to-create-an-app-in-one-click-nodejs.md) | 官方 Node SDK `registerApp()`；自动申请消息权限/事件并返回 App ID/Secret |
| QQ 机器人 | 官方扫码创建机器人 | [腾讯官方 dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot) / `@tencent-connect/qqbot-connector` | 手机 QQ 扫码；返回 AppID/AppSecret 和扫码者 openid |
| 钉钉 | 官方设备授权创建机器人 | [钉钉官方连接器](https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector) | device authorization init/begin/poll；返回 Client ID/Secret |
| 企业微信 | 官方扫码创建智能机器人 | [企业微信智能机器人长连接](https://developer.work.weixin.qq.com/document/path/101463) | 企业微信 App 扫码；返回 Bot ID/Secret |

飞书、QQ、钉钉、企业微信同时保留手动凭据入口。二维码由 Host 本地 `qrcode` 生成，不经过第三方二维码网站。

## 有相关协议，但当前不应标成“一键扫码”

| 渠道 | 现状 | 结论 |
|---|---|---|
| Nextcloud Talk | Nextcloud Login Flow v2 可生成登录 URL并轮询 app password，但仍需先填写实例地址和 Talk room token | 可作为后续“扫码授权实例”，不是零配置机器人创建 |
| Signal | `signal-cli link` 能生成关联设备 URI，但 signal-cli 是社区项目，且当前 adapter 依赖已注册号码 | 可做实验性设备关联；需先重构账号发现/持久化 |
| Nostr | [NIP-46](https://nips.nostr.com/46) 支持 remote signer / nostrconnect QR | 需把本地私钥签名改成远程 signer，会改变安全模型，不能只加一个二维码按钮 |
| Matrix | [MSC4108](https://github.com/matrix-org/matrix-spec-proposals/blob/19628930fa795a6cc02e9538d45aacc1778dbfc1/proposals/4108-oidc-qr-login.md) 定义 OIDC + E2EE QR 登录 | 仍是提案且 homeserver/client 支持不统一，不宜默认启用 |
| Twitch | OAuth 授权需要预注册应用；设备码能力和 bot scopes 仍依赖 Client ID | 适合 OAuth 向导，不是扫码创建机器人 |
| Zalo OA | OAuth 授权需要预注册 Zalo 应用、redirect URI | 适合 OAuth 向导，不是零配置扫码 |

## 没有官方扫码创建机器人流程

- Telegram：机器人必须由 `@BotFather` 创建并取得 Bot Token。
- Discord：必须在 Developer Portal 创建应用和 Bot，再邀请到服务器。
- Slack：官方推荐 App Manifest + OAuth 安装；Socket Mode 仍需要 Bot Token 与 App Token。
- Microsoft Teams：需要 Azure / Bot Framework 资源和应用凭据。
- LINE：需要 Developers Console 创建 Messaging API channel。
- Mattermost：需要 Personal Access Token 或预注册 OAuth app。
- Google Chat：需要 Google Cloud 项目和 Chat app 配置。
- IRC、Synology Chat、iMessage、Tlon、腾讯元宝、Twilio Voice：没有可统一使用的官方机器人扫码创建协议。

## 安全原则

1. 扫码 URL 只在本机 Host 内转换为 data URL；浏览器不访问第三方二维码服务。
2. 扫码返回的 Secret 不回传到状态 API，只写入本地渠道配置。
3. 飞书/QQ 扫码者自动加入该渠道 allowlist；手动凭据仍采用平台侧可见范围和网关白名单。
4. 钉钉 `sessionWebhook` 只允许 `https://*.dingtalk.com`，防止任意 URL 请求。
5. 第三方或草案协议不会伪装成“官方扫码”。
