function textOf(message) {
    return message.msgtype === 'text' && typeof message.text?.content === 'string' ? message.text.content.trim() : '';
}
export function safeDingTalkSessionWebhook(value) {
    if (typeof value !== 'string' || !value)
        return undefined;
    try {
        const url = new URL(value);
        const official = url.hostname === 'dingtalk.com' || url.hostname.endsWith('.dingtalk.com');
        if (url.protocol !== 'https:' || !official || url.username || url.password)
            return undefined;
        return url.href;
    }
    catch {
        return undefined;
    }
}
export function createDingTalkChannel(config, log) {
    const clientId = config.clientId ?? process.env.DSH_DINGTALK_CLIENT_ID;
    const clientSecret = config.clientSecret ?? process.env.DSH_DINGTALK_CLIENT_SECRET;
    if (!clientId || !clientSecret)
        return undefined;
    let handler;
    let client;
    let stopped = false;
    let statusText = '未连接';
    const webhooks = new Map();
    return {
        id: 'dingtalk',
        label: '钉钉',
        maxMessageLength: 4000,
        async start() {
            stopped = false;
            const sdk = await import('dingtalk-stream');
            const stream = new sdk.DWClient({ clientId, clientSecret, keepAlive: true, debug: false });
            client = stream;
            const topic = sdk.TOPIC_ROBOT;
            stream.registerCallbackListener(topic, (response) => {
                const headers = response.headers;
                const messageId = typeof headers?.messageId === 'string' ? headers.messageId : '';
                if (messageId)
                    stream.socketCallBackResponse(messageId, { success: true });
                let message;
                try {
                    message = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
                }
                catch {
                    return;
                }
                const sender = String(message.senderStaffId ?? message.senderId ?? '').trim();
                if (!sender)
                    return;
                const isGroup = String(message.conversationType) === '2';
                if (isGroup && message.isInAtList !== true)
                    return;
                const chatId = isGroup ? `group:${String(message.conversationId ?? '')}` : `p2p:${sender}`;
                const webhook = safeDingTalkSessionWebhook(message.sessionWebhook);
                if (!chatId || chatId.endsWith(':') || !webhook)
                    return;
                webhooks.set(chatId, webhook);
                const text = textOf(message);
                if (!text)
                    return;
                void handler?.({ chatId, userId: sender, username: message.senderNick, text, context: { sessionWebhook: webhook } });
            });
            await stream.connect();
            statusText = '已连接';
            log('[dingtalk] Stream 长连接已启动');
        },
        async stop() {
            stopped = true;
            await Promise.resolve(client?.disconnect()).catch(() => undefined);
            client = undefined;
            webhooks.clear();
            statusText = '已断开';
        },
        async send(chatId, text) {
            const webhook = webhooks.get(chatId);
            if (!webhook)
                throw new Error('dingtalk: 当前会话没有可用的 sessionWebhook，请等待用户发送新消息');
            const response = await fetch(webhook, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
            });
            if (!response.ok)
                throw new Error(`dingtalk send: HTTP ${response.status}`);
        },
        setMessageHandler(h) { handler = h; },
        status() { return stopped ? '已断开' : statusText; },
    };
}
//# sourceMappingURL=dingtalk.js.map