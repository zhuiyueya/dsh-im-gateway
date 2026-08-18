/**
 * 渠道注册表：把配置对象映射为各渠道 adapter 实例。
 * 每个 factory 在凭据缺失/未启用时返回 undefined（不启动）。
 * @module dsh-im-gateway/channels
 */
import { createTelegramChannel } from './telegram.js';
import { createDingTalkChannel } from './dingtalk.js';
import { createWecomChannel } from './wecom.js';
import { createDiscordChannel } from './discord.js';
import { createSlackChannel } from './slack.js';
import { createFeishuChannel } from './feishu.js';
import { createWechatChannel } from './wechat.js';
import { createQQBotChannel } from './qqbot.js';
import { createWhatsAppChannel } from './whatsapp.js';
import { createSignalChannel } from './signal.js';
import { createMSTeamsChannel } from './msteams.js';
import { createLineChannel } from './line.js';
import { createMatrixChannel } from './matrix.js';
import { createMattermostChannel } from './mattermost.js';
import { createGoogleChatChannel } from './googlechat.js';
import { createIrcChannel } from './irc.js';
import { createTwitchChannel } from './twitch.js';
import { createNostrChannel } from './nostr.js';
import { createNextcloudChannel } from './nextcloud.js';
import { createSynologyChannel } from './synology.js';
import { createZaloChannel } from './zalo.js';
import { createIMessageChannel } from './imessage.js';
import { createTlonChannel, createYuanbaoChannel, createVoiceChannel } from './stubs.js';
/** 渠道 id 列表（展示顺序即推荐顺序）。 */
export const CHANNEL_IDS = [
    'wechat',
    'feishu',
    'dingtalk',
    'wecom',
    'qqbot',
    'telegram',
    'discord',
    'slack',
    'whatsapp',
    'signal',
    'msteams',
    'line',
    'matrix',
    'mattermost',
    'googlechat',
    'irc',
    'twitch',
    'nostr',
    'nextcloud',
    'synology',
    'zalo',
    'imessage',
    'tlon',
    'yuanbao',
    'voice',
];
export const CHANNEL_META = {
    wechat: { label: '微信', emoji: '💬', icon: 'wechat.svg', docs: 'https://docs.openclaw.ai/channels/wechat', needs: [], fields: [], hint: '扫码登录，官方 iLink 协议，仅私聊（建议专用小号）', kind: 'qr' },
    feishu: { label: '飞书 / Lark', emoji: '📘', icon: 'feishu.png', qrProvisioning: true, docs: 'https://open.feishu.cn/app', needs: ['App ID', 'App Secret'], fields: [{ key: 'appId', label: 'App ID' }, { key: 'appSecret', label: 'App Secret', secret: true }], hint: '扫码一键创建应用，或手动填写凭据；机器人事件走 WebSocket 长连接', kind: 'credentials' },
    dingtalk: { label: '钉钉', emoji: '🔔', icon: 'dingtalk.svg', qrProvisioning: true, docs: 'https://open.dingtalk.com/document/orgapp/robot-device-authorization', needs: ['Client ID', 'Client Secret'], fields: [{ key: 'clientId', label: 'Client ID' }, { key: 'clientSecret', label: 'Client Secret', secret: true }], hint: '扫码创建企业机器人，或手动填写 Client ID / Client Secret；使用 Stream 长连接', kind: 'credentials' },
    wecom: { label: '企业微信', emoji: '🟢', icon: 'wecom.svg', qrProvisioning: true, docs: 'https://developer.work.weixin.qq.com/document/path/101463', needs: ['Bot ID', 'Secret'], fields: [{ key: 'botId', label: 'Bot ID' }, { key: 'secret', label: 'Secret', secret: true }], hint: '扫码创建企业微信智能机器人，或手动填写 Bot ID / Secret；使用官方 WebSocket 长连接', kind: 'credentials' },
    telegram: { label: 'Telegram', emoji: '✈️', icon: 'telegram.svg', docs: 'https://t.me/BotFather', needs: ['Bot Token'], fields: [{ key: 'token', label: 'Bot Token', secret: true }], hint: '找 @BotFather 创建机器人拿 token', kind: 'credentials' },
    qqbot: { label: 'QQ 机器人', emoji: '🐧', icon: 'qqbot.svg', qrProvisioning: true, docs: 'https://q.qq.com/qqbot/openclaw/login.html', needs: ['AppID', 'AppSecret'], fields: [{ key: 'appId', label: 'AppID' }, { key: 'appSecret', label: 'AppSecret', secret: true }], hint: 'QQ 开放平台扫码创建机器人（官方 API），复制 AppID/AppSecret 填到右侧', kind: 'credentials' },
    discord: { label: 'Discord', emoji: '🎮', icon: 'discord.svg', docs: 'https://discord.com/developers/applications', needs: ['Bot Token'], fields: [{ key: 'token', label: 'Bot Token', secret: true }], hint: 'Discord Developer Portal 创建应用拿 token', kind: 'credentials' },
    slack: { label: 'Slack', emoji: '💼', icon: 'slack.svg', docs: 'https://api.slack.com/apps', needs: ['Bot Token', 'App Token'], fields: [{ key: 'token', label: 'Bot Token (xoxb-)', secret: true }, { key: 'appToken', label: 'App Token (xapp-)', secret: true }], hint: 'Socket Mode 需要 xoxb- 和 xapp- 两个 token', kind: 'credentials' },
    whatsapp: { label: 'WhatsApp', emoji: '🟢', icon: 'whatsapp.svg', docs: 'https://docs.openclaw.ai/channels/whatsapp', needs: [], fields: [], hint: '扫码配对（需安装 baileys 依赖）', kind: 'qr' },
    signal: { label: 'Signal', emoji: '🔒', icon: 'signal.svg', docs: 'https://github.com/AsamK/signal-cli', needs: ['手机号', 'signal-cli'], fields: [{ key: 'phone', label: '本机号码（+86…）' }], hint: '需本机安装 signal-cli 并注册号码', kind: 'credentials' },
    msteams: { label: 'Microsoft Teams', emoji: '🏢', icon: 'msteams.svg', docs: 'https://learn.microsoft.com/azure/bot-service', needs: ['App ID', 'App Password'], fields: [{ key: 'appId', label: 'App ID' }, { key: 'appPassword', label: 'App Password', secret: true }], hint: '实验性：需 Azure Bot Framework 注册', kind: 'credentials' },
    line: { label: 'LINE', emoji: '🟩', icon: 'line.svg', docs: 'https://developers.line.biz/', needs: ['Channel Token'], fields: [{ key: 'channelToken', label: 'Channel Access Token', secret: true }], hint: 'Messaging API；接收需公网 webhook', kind: 'credentials' },
    matrix: { label: 'Matrix', emoji: '🧩', icon: 'matrix.svg', docs: 'https://matrix.org/', needs: ['Homeserver', 'Access Token'], fields: [{ key: 'homeserver', label: 'Homeserver（如 https://matrix.org）' }, { key: 'accessToken', label: 'Access Token', secret: true }], hint: '客户端同步长轮询', kind: 'credentials' },
    mattermost: { label: 'Mattermost', emoji: '🅜', icon: 'mattermost.svg', docs: 'https://mattermost.com/', needs: ['Server URL', 'Token'], fields: [{ key: 'serverUrl', label: '服务器地址' }, { key: 'token', label: '个人访问令牌', secret: true }], hint: 'WebSocket + REST', kind: 'credentials' },
    googlechat: { label: 'Google Chat', emoji: '🔷', icon: 'googlechat.svg', docs: 'https://developers.google.com/workspace/chat', needs: [], fields: [], hint: '实验性：接收需公网 webhook', kind: 'stub' },
    irc: { label: 'IRC', emoji: '💻', icon: 'irc.svg', docs: 'https://libera.chat/', needs: ['服务器地址'], fields: [{ key: 'server', label: '服务器地址' }, { key: 'nick', label: '昵称（可选）' }], hint: '经典 IRC 协议', kind: 'credentials' },
    twitch: { label: 'Twitch', emoji: '📺', icon: 'twitch.svg', docs: 'https://twitchtokengenerator.com/', needs: ['Bot 名', 'OAuth Token'], fields: [{ key: 'botName', label: 'Bot 用户名' }, { key: 'token', label: 'OAuth Token', secret: true }], hint: 'WebSocket IRC', kind: 'credentials' },
    nostr: { label: 'Nostr', emoji: '🧅', docs: 'https://nostr.com/', needs: ['私钥', '中继'], fields: [{ key: 'privateKey', label: '私钥 (hex)', secret: true }, { key: 'relays', label: '中继（逗号分隔）' }], hint: 'NIP-04 私信（需安装 @noble/curves）', kind: 'credentials' },
    nextcloud: { label: 'Nextcloud Talk', emoji: '☁️', icon: 'nextcloud.svg', docs: 'https://nextcloud.com/talk/', needs: ['Server URL', '账号', '密码'], fields: [{ key: 'serverUrl', label: '服务器地址' }, { key: 'user', label: '用户名' }, { key: 'password', label: '密码', secret: true }], hint: '实验性：Nextcloud Talk', kind: 'credentials' },
    synology: { label: 'Synology Chat', emoji: '🖥️', icon: 'synology.svg', docs: 'https://www.synology.com/', needs: ['Webhook URL'], fields: [{ key: 'webhookUrl', label: 'Incoming Webhook URL', secret: true }], hint: '群晖 NAS 聊天', kind: 'credentials' },
    zalo: { label: 'Zalo', emoji: '🇻🇳', icon: 'zalo.svg', docs: 'https://developers.zalo.me/', needs: ['Access Token'], fields: [{ key: 'accessToken', label: 'OA Access Token', secret: true }], hint: '实验性：Zalo OA', kind: 'credentials' },
    imessage: { label: 'iMessage', emoji: '🍏', icon: 'imessage.svg', docs: 'https://support.apple.com/imessage', needs: [], fields: [], hint: 'macOS only；发送 osascript / 接收 imsg 桥', kind: 'simple' },
    tlon: { label: 'Tlon (Urbit)', emoji: '🌌', icon: 'urbit.png', docs: 'https://tlon.io/', needs: [], fields: [], hint: '骨架：未实现完整协议', kind: 'stub' },
    yuanbao: { label: '腾讯元宝', emoji: '🧧', docs: 'https://yuanbao.tencent.com/', needs: [], fields: [], hint: '骨架：未实现', kind: 'stub' },
    voice: { label: '语音电话', emoji: '📞', icon: 'voice.svg', docs: 'https://www.twilio.com/', needs: [], fields: [], hint: '骨架：需 Twilio/Plivo', kind: 'stub' },
};
/** 创建单个渠道（凭据缺失/未启用返回 undefined）。 */
export function createChannel(id, config, log, stateDir) {
    switch (id) {
        case 'telegram': return createTelegramChannel(config, log);
        case 'dingtalk': return createDingTalkChannel(config, log);
        case 'wecom': return createWecomChannel(config, log);
        case 'discord': return createDiscordChannel(config, log);
        case 'slack': return createSlackChannel(config, log);
        case 'feishu': return createFeishuChannel(config, log);
        case 'wechat': return createWechatChannel(config, log, stateDir);
        case 'qqbot': return createQQBotChannel(config, log);
        case 'whatsapp': return createWhatsAppChannel(config, log, stateDir);
        case 'signal': return createSignalChannel(config, log);
        case 'msteams': return createMSTeamsChannel(config, log);
        case 'line': return createLineChannel(config, log);
        case 'matrix': return createMatrixChannel(config, log);
        case 'mattermost': return createMattermostChannel(config, log);
        case 'googlechat': return createGoogleChatChannel(config, log);
        case 'irc': return createIrcChannel(config, log);
        case 'twitch': return createTwitchChannel(config, log);
        case 'nostr': return createNostrChannel(config, log);
        case 'nextcloud': return createNextcloudChannel(config, log);
        case 'synology': return createSynologyChannel(config, log);
        case 'zalo': return createZaloChannel(config, log);
        case 'imessage': return createIMessageChannel(config, log);
        case 'tlon': return createTlonChannel(config, log);
        case 'yuanbao': return createYuanbaoChannel(config, log);
        case 'voice': return createVoiceChannel(config, log);
        default: return undefined;
    }
}
/** 创建全部已配置渠道。stateDir 供扫码/状态类渠道落盘。 */
export function createChannels(config, log, stateDir) {
    const out = [];
    for (const id of CHANNEL_IDS) {
        const channel = createChannel(id, config.channels[id] ?? {}, log, stateDir);
        if (channel)
            out.push(channel);
    }
    return out;
}
export { createTelegramChannel, createDiscordChannel, createSlackChannel, createFeishuChannel, createWechatChannel };
//# sourceMappingURL=index.js.map