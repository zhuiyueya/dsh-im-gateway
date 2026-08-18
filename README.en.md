# 🐋 dsh-im-gateway

<h3 align="center">Connect DeepSeek Harness to every chat app you use</h3>
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

<p align="center"><b>English</b> · <a href="README.md">简体中文</a></p>

---

## 📸 Screenshots

<p align="center">
  <img src="docs/screenshots/im-gateway-settings.png" width="92%" alt="dsh IM Gateway settings">
</p>

<p align="center">
  <img src="docs/screenshots/wechat-chat.jpg" width="30%" alt="WeChat chat screenshot">
  <img src="docs/screenshots/qq-chat.jpg" width="30%" alt="QQ chat screenshot">
  <img src="docs/screenshots/feishu-chat.jpg" width="30%" alt="Feishu chat screenshot">
</p>

---

## ⚡ One-command install: just paste a prompt into your dsh

> Pick any option below and paste the whole prompt into your dsh (Web GUI chat box / `dsh --profile headless "…"` / any connected IM chat) — the agent will **download, build and install automatically**. No manual commands needed.

<details open>
<summary><b>Option A · Install from npm (recommended, available on the npm registry)</b></summary>

```text
Please install the dsh-im-gateway plugin: dsh plugin --profile web add dsh-im-gateway
Tell me when it's done and remind me to restart dsh web.
```
</details>

<details>
<summary><b>Option B · Clone from GitHub (most reliable)</b></summary>

```text
Please install the dsh-im-gateway plugin (the aggregated IM gateway for DeepSeek Harness):
1. Run git clone --depth 1 https://github.com/zhuiyueya/dsh-im-gateway.git /tmp/dsh-im-gateway
2. Run cd /tmp/dsh-im-gateway && npm install && npm run build
3. Run dsh plugin --profile web add /tmp/dsh-im-gateway
4. Report the result; if it asks for a restart, remind me to restart dsh web.
```
</details>

<details>
<summary><b>Option C · Install straight from the git URL (no clone, tested)</b></summary>

```text
Please install the dsh-im-gateway plugin: dsh plugin --profile web add https://github.com/zhuiyueya/dsh-im-gateway.git
Remind me to restart dsh web when done (first install takes 1–2 min for dependencies).
```
</details>

<details>
<summary><b>Option D · Local project directory</b></summary>

```text
Please install the local dsh-im-gateway project as a dsh plugin:
1. cd into the project and run npm install && npm run build
2. Run dsh plugin --profile web add <absolute path to project>
3. Remind me to restart dsh web.
```
</details>

After install: **open the dsh Web GUI → Settings ⚙️ → 🐋 IM Gateway → click a channel to connect** (WeChat/WhatsApp link a device; Feishu/QQ/DingTalk/WeCom support official bot provisioning by QR; other channels use guided credentials or infrastructure setup).

---

## 💬 IM Commands

Messages starting with `/` in any connected chat are commands:

| Command | Description |
|---|---|
| `/help` | This help |
| `/status` | Current session (session id / workspace / pending approvals) |
| `/new` · `/clear` | Start a brand-new session (per-chat mode) |
| `/workspaces` | List all workspaces |
| `/workspace <path>` | Switch workspace (takes effect on the next `/new`) |
| `/sessions [all\|path]` | List sessions (default: current workspace; `all` for everything) |
| `/continue <session-id>` | Resume an existing session (across channels/workspaces) |
| `/bind <session-id>` | Bind a local live session (bound mode) |
| `/unbind` | Unbind (bound mode) |
| `/channels` | Connection status of each channel |
| `/cron list` | List scheduled tasks of this chat |
| `/cron rm <id>` | Delete a scheduled task (created via `im_cron` tools) |
| `approve` / `reject` | Answer a pending approval (also `yes` / `no` / `同意`) |
| Plain text | Sent to the agent; trailing `..` means "more coming", `!!` submits immediately |

---

## ✨ Highlights

- 🌐 **25+ channels covered** — aligned with OpenClaw's channel surface: WeChat, Feishu, Telegram, Discord, Slack, QQ, WhatsApp, Signal, Teams, LINE, Matrix, Mattermost, IRC, Twitch, Nostr, Zalo, iMessage…
- 🔁 **One agent session per chat** — chatting in a group drives the agent, replies stream back in real time; `/new` starts a fresh session, `/bind` attaches an existing one
- ✅ **Remote approval bridge** — when the agent requests a tool approval it's pushed to the chat; reply 「approve / reject」 right there, and it falls back to the local approval system on timeout
- ❓ **Interactive Question Bridge** — `ask_user_question` prompts and options fan out to every bound channel; answer from Web or any IM, and the first valid answer resumes the same agent
- ⏰ **Chat-scoped scheduled reminders (im_cron)** — scheduled tasks bind to the chat, not the session, so `/new` rotation or session restarts never break them; say "remind me to drink water at 9am daily" right in the chat to create one, and it fires straight into the chat
- 📱 **Mobile multi-part input merge** — `..` means "more coming", `!!` submits immediately, bare text merges within a 5s window, auto-recovers after a crash
- ✂️ **Smart splitting of long replies** — chunks by each channel's limit, breaks at newlines/periods first, numbered `(i/n)` and convergent
- 🛡️ **Optional allowlist mode** — `allowAllUsers: true` is the default for easy setup; set it to `false` and configure an allowlist when access control is needed. Approval replies always verify session ownership
- 🔑 **Six QR access flows** — WeChat / WhatsApp link a device; Feishu / QQ / DingTalk / WeCom use official scan-to-create-bot flows, automatically save credentials, and still offer manual setup
- 🖼️ **Media in and out** — WeChat fully supports images/voice (server-side transcription)/files/video (CDN AES-128-ECB encrypted); agents can send workspace files into chats via the `im_send_file` tool
- 📦 **One-command install + visual setup** — a standard `dsh.bundle` plugin; connect channels from the Web GUI settings panel by scanning or pasting credentials, no restart needed
- 🎯 **Beginner friendly** — WeChat/WhatsApp/Feishu/QQ/DingTalk/WeCom pop a QR code from settings; other channels provide guided credential or infrastructure setup with live status

### ❓ Answering interactive questions

When the agent calls `ask_user_question`, the structured prompt shown in the Web GUI is also sent to every IM chat bound to that session. Web and IM remain active together: **the first valid answer wins**, every other bound channel receives a resolved notice, and the same agent resumes from its waiting point.

| Question type | IM reply format | Example |
|---|---|---|
| Single choice | Option number, exact label, or custom text | `2`, `Full mode`, `Ask me later` |
| Multiple choice | Separate values with commas, Chinese commas, ideographic commas, or semicolons | `1,3`, `Fast;Tests` |
| Free text | Reply with the full answer | `Use dsh-im-gateway as the project name` |
| Multiple questions | One line per question: `question-number: answer` | `1: 2`, then `2: 1,3` on the next line |

The IM answer window is controlled by `questionTimeoutSecs` (600 seconds by default). When it expires, only the IM wait is removed—the question remains answerable in the Web GUI. Pending questions are isolated by session, and concurrent channel replies can resume the agent only once.

## 🏗 Architecture

```
   IM channels (Telegram / WeChat / Feishu / Discord / …)       DSH agent
        │  adapter normalizes inbound                              ▲
        ▼                                                         │
┌─────────────────────────┐      ┌────────────────────────┐      │
│  ChannelAdapter          │◄────►│  ImGateway (core)       │──────┘
│  · one adapter per channel│     │  · session routing      │
│  · recv: poll/WebSocket/ │      │    (per-chat)           │
│    webhook → ImMessage   │      │  · allowlist & IM cmds  │
│  · send: send(chatId,    │      │  · approval bridge      │
│    text)                 │      │  · question bridge      │
└─────────────────────────┘      └────────────────────────┘
        ▲
        │  session/event · assistant/message · turn/end
        └────────────────────────────────────────────────────
```

```
user message → channel adapter → gateway (allowlist → merge → route) → agent.followup()
agent reply  ← gateway (split per channel) ← session/event(assistant/message) ← agent
tool approval → approval/request → pushed to chat → 「approve」→ allowed-once
```

## 📡 Supported Channels

| Channel | Status | Receive mode | Requires |
|---|---|---|---|
| **Telegram** | ✅ Full | Bot API long-polling | @BotFather token |
| **Discord** | ✅ Full | Gateway WebSocket | Bot token |
| **Slack** | ✅ Full | Socket Mode | xoxb- + xapp- token |
| **Feishu / Lark** | ✅ Full | Official SDK long-connection | Official QR or App ID + Secret |
| **DingTalk** | ✅ Full | Official Stream connection | Official QR or Client ID + Secret |
| **WeCom** | ✅ Full | Official intelligent-bot WebSocket | Official QR or Bot ID + Secret |
| **WeChat** | ✅ Full* | Official iLink long-polling (device QR) | Official iLink account (dedicated account recommended) |
| **QQ Bot** | ✅ Full | Official WebSocket | Official QR or AppID + Secret |
| **LINE** | ✅ Full | REST + webhook | Channel token |
| **Matrix** | ✅ Full | Client sync | Homeserver + token |
| **Mattermost** | ✅ Full | WebSocket + REST | Server URL + token |
| **IRC** | ✅ Full | Native socket | Server address |
| **Twitch** | ✅ Full | WebSocket IRC | OAuth token |
| **Signal** | ✅ Full | signal-cli subprocess | Local signal-cli |
| **Nextcloud Talk** | ✅ Full | REST polling | Instance account |
| **Synology Chat** | ✅ Full | webhook | Incoming webhook |
| **Zalo** | ✅ Full | REST + webhook | OA token |
| **iMessage** | ✅ Full* | imsg / osascript | macOS |
| **WhatsApp** | 🔄 Dynamic dep | Baileys QR | `npm i @whiskeysockets/baileys` |
| **Nostr** | 🔄 Dynamic dep | NIP-04 DM | `npm i @noble/curves` |
| **Teams** | 🧪 Experimental | Bot Framework | Azure registration |
| **Google Chat** | 🧪 Experimental | webhook | Public endpoint |
| **Tlon / Yuanbao / Voice** | 🧪 Skeleton | — | Infrastructure |

✅ Full = send & receive work ｜ 🔄 Dynamic dep = prompts to install SDK if missing ｜ 🧪 Experimental = needs public network / dedicated infra ｜ *WeChat = Tencent's official iLink channel (media + voice-to-text + typing)

## 🚀 Quick Start

### 1. Install (once)

```bash
# Option 1: from npm (recommended)
dsh plugin --profile web add dsh-im-gateway

# Option 2: local source (development/debugging)
cd dsh-im-gateway
npm install && npm run build
dsh plugin --profile web add /path/to/dsh-im-gateway

dsh web    # restart dsh (required once after installing a plugin)
```

### 2. Connect channels (everything after this lives in the web UI, no config files)

Open the dsh Web GUI (default http://localhost:3080) → **Settings ⚙️ → 「🐋 IM Gateway」**:

- **WeChat / WhatsApp**: click 「Connect (scan)」→ link the device with the corresponding mobile app ✅
- **Feishu / QQ / DingTalk / WeCom**: click 「Scan to connect bot」→ scan with the platform app; the bot is created and connected automatically, or use manual credentials ✅
- **Telegram / Discord / Slack and others**: these platforms have no official QR bot-creation flow; use the guided token or manifest setup ✅

No restart needed after connecting; status updates live (connecting / connected / not connected / error). **All configured channels auto-reconnect after a dsh restart** (WeChat login state is persisted, no rescanning). See [`docs/qr-login-matrix.md`](docs/qr-login-matrix.md) for the platform-by-platform QR capability research.

> 🔧 **Disconnect vs Delete config**: connected channel cards have two buttons — 「Disconnect」 just pauses it temporarily (auto-restored on restart); 「Delete config」 removes the credentials (won't reconnect until reconfigured).

> 💡 Manual config (optional): write config in `~/.dsh/profiles/web/cordis.patch.yml`; credentials can also come from environment variables — see 「Configuration」 below.

### 3. Start using it

Message your bot in any connected chat app:

```
/help        ← available commands
Hi, take a look at my current workspace    ← plain chat = drive the agent
```

> 🔔 **Optional first-use authorization**: when `allowAllUsers: false`, the first message from an unknown user gets an "unauthorized" reply and the **「Users requesting access」** banner appears in the IM Gateway settings panel; click 「Allow」 to approve them. With the default `allowAllUsers: true`, this step is not needed.

Agent replies stream back in real time; when approval is needed, reply 「approve / reject」 in the chat; the agent can also use `im_send_file` to send files (screenshots/reports) straight into the chat.

## ⚙️ Configuration

All config goes under the `im-gateway` entry in the profile's `cordis.patch.yml`; credentials can also use environment variables (see table below).

### Common config

```yaml
- id: im-gateway
  config:
    sessionMode: per-chat          # per-chat (default) | bound
    cwd: /path/to/workspace        # agent working directory
    provider: deepseek-official    # LLM provider (defaults to dsh)
    model: deepseek-v4-flash       # model (defaults to dsh)
    allowAllUsers: true            # allow all users out of the box; set false for control
    allowedUserIds:                # allowlist per channel (used when allowAllUsers=false)
      telegram: ['123456789']
      '*': ['u-common']            # cross-channel common users
    mergeTimeoutSecs: 5            # mobile multi-part merge window
    approvalTimeoutSecs: 120       # approval timeout, then fall back to local approval
    questionTimeoutSecs: 600       # IM answer window; Web remains available after timeout
    summaryOnTurnEnd: true         # push a [✅ done] summary after each turn
    stateDir: ''                   # state dir (default $DSH_HOME/dsh-im-gateway)
```

### Channel credentials cheat sheet

| Channel | Config fields | Environment variables |
|---|---|---|
| telegram | `token` | `DSH_TELEGRAM_TOKEN` |
| discord | `token` | `DSH_DISCORD_TOKEN` |
| slack | `token` + `appToken` | `DSH_SLACK_TOKEN` / `DSH_SLACK_APP_TOKEN` |
| feishu | `appId` + `appSecret` (or settings QR) | `DSH_FEISHU_APP_ID` / `DSH_FEISHU_APP_SECRET` |
| dingtalk | `clientId` + `clientSecret` (or settings QR) | `DSH_DINGTALK_CLIENT_ID` / `DSH_DINGTALK_CLIENT_SECRET` |
| wecom | `botId` + `secret` (or settings QR) | `DSH_WECOM_BOT_ID` / `DSH_WECOM_SECRET` |
| qqbot | `appId` + `appSecret` (or settings QR) | `DSH_QQ_APP_ID` / `DSH_QQ_APP_SECRET` |
| signal | `cli` + `phone` | `DSH_SIGNAL_CLI` / `DSH_SIGNAL_PHONE` |
| line | `channelToken` + `channelSecret` | `DSH_LINE_TOKEN` / `DSH_LINE_SECRET` |
| matrix | `homeserver` + `accessToken` | `DSH_MATRIX_HOMESERVER` / `DSH_MATRIX_ACCESS_TOKEN` |
| mattermost | `serverUrl` + `token` | `DSH_MATTERMOST_URL` / `DSH_MATTERMOST_TOKEN` |
| irc | `server` + `nick` + `channels` | `DSH_IRC_SERVER` |
| twitch | `botName` + `token` | `DSH_TWITCH_BOT_NAME` / `DSH_TWITCH_TOKEN` |
| nostr | `privateKey` + `relays` | `DSH_NOSTR_PRIVATE_KEY` / `DSH_NOSTR_RELAYS` |
| nextcloud | `serverUrl` + `user` + `password` | `DSH_NEXTCLOUD_URL` etc. |
| synology | `webhookUrl` | `DSH_SYNOLOGY_WEBHOOK_URL` |
| zalo | `accessToken` | `DSH_ZALO_TOKEN` |
| imessage | `enabled` + `imsgPath` | `DSH_IMSG_PATH` |
| wechat | `enabled: true` | — (iLink QR) |
| whatsapp | `enabled: true` | — (Baileys QR) |

## 🧪 Development

```bash
npm install
npm run build          # tsc builds to lib/
npm test               # node --test (105 cases: split/merge/approval/questions/gateway/QR channel protocols)
```

**Adding a new channel takes 4 steps**:

1. Create `src/channels/yourchannel.ts` implementing `ChannelAdapter` (6 methods)
2. Register it in `src/channels/index.ts`
3. Add the config fields in the Config in `src/index.ts`
4. Add a row to the README channel table ✨

```typescript
export function createYourChannel(config, log): ChannelAdapter | undefined {
  if (!config.token) return undefined          // no credentials → don't start
  return {
    id: 'yourchannel', label: 'YourChannel', maxMessageLength: 2000,
    start() { /* connect / poll / scan */ },
    stop() { /* cleanup */ },
    async send(chatId, text) { /* send message */ },
    setMessageHandler(h) { /* inbound callback */ },
    status() { return 'running' },
  }
}
```

## 🤝 Contributing

- Bug fixes, new channels and doc improvements are all welcome!
- Please make sure `npm test` passes all 105 cases first
- Add the `dsh-plugin` and `deepseek-harness` topics to the repo to get into the awesome-plugin list

## 📄 License

[MIT](./LICENSE) © zhuiyueya

---

<p align="center">Made with 🐋 for the DeepSeek Harness ecosystem</p>
