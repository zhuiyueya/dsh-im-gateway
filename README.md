# 🐋 dsh-im-gateway

<h3 align="center">把 DeepSeek Harness 接入你常用的每一个聊天软件</h3>
<p align="center">Aggregated IM gateway for <b>DeepSeek Harness (dsh)</b> — drive your coding agents from <b>WeChat, Feishu, Telegram, Discord, QQ</b> and 25+ chat platforms, with unified sessions, remote approvals, interactive questions and one-command setup.</p>

<p align="center">
  <img alt="npm version" src="https://img.shields.io/npm/v/dsh-im-gateway?color=4d6bfe">
  <img alt="npm downloads" src="https://img.shields.io/npm/dm/dsh-im-gateway?color=4d6bfe">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-4d6bfe">
  <img alt="Platform" src="https://img.shields.io/badge/platform-DeepSeek%20Harness-4d6bfe">
  <img alt="Channels" src="https://img.shields.io/badge/channels-25%2B-238636">
  <img alt="DSH bundle" src="https://img.shields.io/badge/dsh-bundle%20plugin-4d6bfe">
  <img alt="PRs Welcome" src="https://img.shields.io/badge/PRs-welcome-brightgreen">
  <img alt="Tests" src="https://img.shields.io/badge/tests-105%20passed-238636">
</p>

<p align="center"><a href="README.en.md">English</a> · <b>简体中文</b></p>

---

## 📸 效果预览

<p align="center">
  <img src="docs/screenshots/im-gateway-settings.png" width="92%" alt="dsh IM 网关设置界面">
</p>

<p align="center">
  <img src="docs/screenshots/wechat-chat.jpg" width="30%" alt="微信聊天截图">
  <img src="docs/screenshots/qq-chat.jpg" width="30%" alt="QQ 聊天截图">
  <img src="docs/screenshots/feishu-chat.jpg" width="30%" alt="飞书聊天截图">
</p>

---

## ⚡ 一键安装

任选一种方式，把下面整段提示词发给你的 dsh（Web GUI 聊天框、`dsh --profile headless "…"` 或已接入的 IM 聊天），agent 会自动完成安装。安装插件后重启一次 dsh web。

<details open>
<summary><b>方式 A · npm 安装（推荐）</b></summary>

```text
请安装 dsh-im-gateway 插件：dsh plugin --profile web add dsh-im-gateway
装完提醒我重启 dsh web。
```
</details>

<details>
<summary><b>方式 B · GitHub 克隆安装</b></summary>

```text
请帮我安装 dsh-im-gateway 插件（DeepSeek Harness 的聚合 IM 网关）：
1. 执行 git clone --depth 1 https://github.com/zhuiyueya/dsh-im-gateway.git /tmp/dsh-im-gateway
2. 执行 cd /tmp/dsh-im-gateway && npm install && npm run build
3. 执行 dsh plugin --profile web add /tmp/dsh-im-gateway
4. 汇报结果；如果提示需要重启，提醒我重启 dsh web。
```
</details>

<details>
<summary><b>方式 C · 远程仓库直装</b></summary>

```text
请安装 dsh-im-gateway 插件：dsh plugin --profile web add https://github.com/zhuiyueya/dsh-im-gateway.git
装完提醒我重启 dsh web（首次安装依赖约 1-2 分钟）。
```
</details>

<details>
<summary><b>方式 D · 本机已有项目目录</b></summary>

```text
请把本机项目 dsh-im-gateway 安装为 dsh 插件：
1. 进入项目目录执行 npm install && npm run build
2. 执行 dsh plugin --profile web add <项目绝对路径>
3. 提醒我重启 dsh web。
```
</details>

---

## 🚀 快速开始

### 1. 安装并打开设置

安装完成后重启 dsh web，打开：**设置 ⚙️ → 🐋 IM 网关**。

### 2. 连接渠道

- **微信 / WhatsApp**：点击「连接（扫码）」，用手机关联设备。
- **飞书 / QQ / 钉钉 / 企业微信**：点击「扫码接入机器人」，使用对应平台 App 扫码确认；也可以手动填写凭据。
- **Telegram / Discord / Slack 等**：按卡片中的官方文档和凭据表单完成接入。

连接后无需重启，状态统一显示为：**已连接 / 未连接 / 连接中 / 异常**。重启 dsh 后，已保存配置的渠道会自动恢复；微信登录态已持久化，无需重复扫码。

> **断开 vs 删除配置**：暂时断开只停止运行并保留配置，重启后会自动恢复；删除配置会移除凭据，之后需要重新接入。

### 3. 开始使用

在连接好的聊天软件里给机器人发消息：

```text
/help        ← 查看可用命令
你好，帮我看看当前工作区    ← 普通聊天 = 驱动 agent
```

如果设置了 `allowAllUsers: false`，未授权用户首次发消息会收到授权提示，Web 设置页顶部会出现访问请求；默认 `allowAllUsers: true` 时无需授权步骤。

agent 回复会实时回推；需要批准时在聊天里回复「批准 / 拒绝」；agent 也可以使用 `im_send_file` 将工作区文件发送到聊天。

各平台为什么支持或不支持扫码，见 [`docs/qr-login-matrix.md`](docs/qr-login-matrix.md)。

---

## 📡 支持的渠道

| 渠道 | 状态 | 接收方式 | 接入方式 |
|---|---|---|---|
| **Telegram** | ✅ 完整 | Bot API 长轮询 | @BotFather token |
| **Discord** | ✅ 完整 | Gateway WebSocket | Bot token |
| **Slack** | ✅ 完整 | Socket Mode | xoxb- + xapp- token |
| **飞书 / Lark** | ✅ 完整 | 官方 SDK 长连接 | 官方扫码或 App ID + Secret |
| **钉钉** | ✅ 完整 | 官方 Stream 长连接 | 官方扫码或 Client ID + Secret |
| **企业微信** | ✅ 完整 | 官方智能机器人 WebSocket | 官方扫码或 Bot ID + Secret |
| **微信** | ✅ 完整* | 腾讯官方 iLink 长轮询（设备扫码） | 官方 iLink 账号（建议专用账号） |
| **QQ 机器人** | ✅ 完整 | 官方 WebSocket | 官方扫码或 AppID + Secret |
| **LINE** | ✅ 完整 | REST + webhook | Channel token |
| **Matrix** | ✅ 完整 | 客户端同步 | Homeserver + token |
| **Mattermost** | ✅ 完整 | WebSocket + REST | Server URL + token |
| **IRC** | ✅ 完整 | 原生 socket | 服务器地址 |
| **Twitch** | ✅ 完整 | WebSocket IRC | OAuth token |
| **Signal** | ✅ 完整 | signal-cli 子进程 | 本机 signal-cli |
| **Nextcloud Talk** | ✅ 完整 | REST 轮询 | 实例账号 |
| **Synology Chat** | ✅ 完整 | webhook | Incoming webhook |
| **Zalo** | ✅ 完整 | REST + webhook | OA token |
| **iMessage** | ✅ 完整* | imsg / osascript | macOS |
| **WhatsApp** | 🔄 动态依赖 | Baileys 扫码 | `npm i @whiskeysockets/baileys` |
| **Nostr** | 🔄 动态依赖 | NIP-04 私信 | `npm i @noble/curves` |
| **Teams** | 🧪 实验性 | Bot Framework | Azure 注册 |
| **Google Chat** | 🧪 实验性 | webhook | 公网地址 |
| **Tlon / 元宝 / 语音** | 🧪 骨架 | — | 基础设施 |

✅ 完整 = 收发可用 ｜ 🔄 动态依赖 = 未装 SDK 时提示安装 ｜ 🧪 实验性 = 需公网或专用基础设施 ｜ *微信 = 腾讯官方 iLink 渠道（媒体收发 + 语音转文字 + typing）

---

## ✨ 核心功能

### 💬 IM 命令

在连接好的聊天软件里，发给机器人的消息以 `/` 开头即命令：

| 命令 | 说明 |
|---|---|
| `/help` | 本帮助 |
| `/status` | 查询当前会话（会话 id / 工作区 / 待批准） |
| `/new` · `/clear` | 开启全新会话（per-chat 模式） |
| `/workspaces` | 列出所有工作区 |
| `/workspace <路径>` | 切换工作区（后续 `/new` 生效） |
| `/sessions [all\|路径]` | 列出会话（默认当前工作区；`all` 全部） |
| `/continue <会话id>` | 继续已有会话（跨渠道/跨工作区） |
| `/bind <session-id>` | 绑定本机 live 会话（bound 模式） |
| `/unbind` | 解绑（bound 模式） |
| `/channels` | 各渠道连接状态 |
| `/cron list` | 查看本聊天定时任务 |
| `/cron rm <id>` | 删除本聊天的定时任务 |
| `批准` / `拒绝` | 应答待批准请求（也支持 yes / no / 同意） |
| 普通文本 | 发给 agent；结尾 `..` 表示还有后续，`!!` 立即提交 |

### ✅ 远程审批

agent 请求工具批准时会把请求推送到聊天；直接回复「批准 / 拒绝」即可。审批回复会校验聊天与会话归属，超时后转回本机批准体系。

### ❓ 交互式提问

当 agent 调用 `ask_user_question` 时，Web GUI 的问题和选项会同步发送到该会话绑定的全部 IM 聊天。Web 和 IM 均可回答，**第一份有效答案生效**，其余渠道会收到已回答通知。

| 问题类型 | IM 回答方式 | 示例 |
|---|---|---|
| 单选 | 选项编号、完整标签或自定义文字 | `2`、`完整模式`、`以后再说` |
| 多选 | 用逗号、中文逗号、顿号或分号分隔 | `1,3`、`快速、测试` |
| 自由输入 | 直接回复完整文本 | `项目名叫 dsh-im-gateway` |
| 多个问题 | 每行使用 `问题序号: 答案` | `1: 2` 换行 `2: 1,3` |

回答窗口由 `questionTimeoutSecs` 控制，默认 600 秒。窗口超时只会停止 IM 等待，Web GUI 中的问题仍可继续回答；等待按 session 隔离。

### ⏰ 聊天级定时提醒

定时任务绑定**聊天（chatId）而非会话（sessionId）**。在聊天里说「每天 9 点提醒我喝水」或「每周一 9 点生成今日待办」，agent 会创建提醒；无论 `/new` 轮换多少次或会话是否重启，到点都会直接推送到该聊天。

- `/cron list`：查看本聊天的定时任务
- `/cron rm <id>`：删除定时任务
- 支持一次性提醒、每天提醒和按星期提醒
- 支持 IANA 时区与 DST 间隙/重叠处理
- 状态落盘，重启自动恢复；发送失败自动重试

### 📱 消息与媒体

- 手机多段输入：`..` 表示还有后续，`!!` 立即提交，裸文本在 5 秒窗口内合并，崩溃后自动恢复。
- 长回复按各渠道上限分片，优先在换行或句号处断行，带 `（i/n）` 序号。
- 微信支持图片、语音转文字、文件、视频；agent 可通过 `im_send_file` 发送工作区文件。

### 🛡️ 访问控制

默认 `allowAllUsers: true` 便于开箱使用；需要管控时设为 `false` 并配置渠道白名单。审批应答始终校验会话归属。

---

## 🏗 架构

```text
   IM 渠道 (Telegram / 微信 / 飞书 / Discord / …)              DSH agent
        │  adapter 归一化入站                                    ▲
        ▼                                                       │
┌─────────────────────────┐      ┌────────────────────────┐    │
│  ChannelAdapter          │◄────►│  ImGateway (核心网关)    │────┘
│  · 每渠道一个适配器       │      │  · 会话路由 (per-chat)   │
│  · 收: 轮询/WebSocket/   │      │  · 白名单 & IM 命令      │
│     webhook → ImMessage  │      │  · 审批桥 / 提问桥       │
│  · 发: send(chatId,text) │      │  · 分片 / 多段合并       │
└─────────────────────────┘      └────────────────────────┘
        ▲
        │  session/event · assistant/message · turn/end
        └────────────────────────────────────────────────────
```

```text
用户消息 → 渠道 adapter → 网关(白名单→合并→会话路由) → agent.followup()
agent 回复 ← 网关(按渠道分片) ← session/event(assistant/message) ← agent
工具批准 → approval/request → 推送到聊天 → 「批准」→ allowed-once
```

---

## 🧪 开发

```bash
npm install
npm run build          # tsc 构建到 lib/
npm test               # node --test（105 个用例）
```

**新增一个渠道只需 4 步**：

1. 在 `src/channels/` 新建 `yourchannel.ts`，实现 `ChannelAdapter`（6 个方法）
2. 在 `src/channels/index.ts` 注册
3. 在 `src/index.ts` 的 Config 里补配置字段
4. 在 README 渠道表加一行 ✨

```typescript
export function createYourChannel(config, log): ChannelAdapter | undefined {
  if (!config.token) return undefined          // 未配置凭据 → 不启动
  return {
    id: 'yourchannel', label: 'YourChannel', maxMessageLength: 2000,
    start() { /* 连接 / 轮询 / 扫码 */ },
    stop() { /* 释放 */ },
    async send(chatId, text) { /* 发消息 */ },
    setMessageHandler(h) { /* 入站回调 */ },
    status() { return 'running' },
  }
}
```

---

## 🤝 贡献

- 修 bug、补渠道、完善文档都欢迎！
- 请先 `npm test` 保证 105 个用例全绿
- 给仓库加 `dsh-plugin` 和 `deepseek-harness` topic 可以进 awesome 插件列表

## 📄 许可证

[MIT](./LICENSE) © zhuiyueya

---

<p align="center">Made with 🐋 for the DeepSeek Harness ecosystem</p>
