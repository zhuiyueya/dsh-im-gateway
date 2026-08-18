/**
 * 钉钉机器人渠道：官方 Stream 长连接；支持扫码创建后的 Client ID/Secret。
 * 扫码授权由 core/provisioning.ts 负责，adapter 只负责收发消息。
 */
import type { ChannelAdapter, ImMessage } from '../core/types.js'

export interface DingTalkChannelConfig {
  enabled?: boolean
  clientId?: string
  clientSecret?: string
}

type StreamClient = {
  registerCallbackListener(topic: string, callback: (response: Record<string, unknown>) => void): void
  connect(): Promise<void> | void
  disconnect(): Promise<void> | void
  socketCallBackResponse(messageId: string, body: Record<string, unknown>): void
  connected?: boolean
  socket?: { readyState?: number }
}

function textOf(message: Record<string, any>): string {
  return message.msgtype === 'text' && typeof message.text?.content === 'string' ? message.text.content.trim() : ''
}

export function safeDingTalkSessionWebhook(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  try {
    const url = new URL(value)
    const official = url.hostname === 'dingtalk.com' || url.hostname.endsWith('.dingtalk.com')
    if (url.protocol !== 'https:' || !official || url.username || url.password) return undefined
    return url.href
  } catch {
    return undefined
  }
}

export function createDingTalkChannel(config: DingTalkChannelConfig, log: (line: string) => void): ChannelAdapter | undefined {
  const clientId = config.clientId ?? process.env.DSH_DINGTALK_CLIENT_ID
  const clientSecret = config.clientSecret ?? process.env.DSH_DINGTALK_CLIENT_SECRET
  if (!clientId || !clientSecret) return undefined
  let handler: ((msg: ImMessage) => void | Promise<void>) | undefined
  let client: StreamClient | undefined
  let stopped = false
  let statusText = '未连接'
  const webhooks = new Map<string, string>()

  return {
    id: 'dingtalk',
    label: '钉钉',
    maxMessageLength: 4000,
    async start() {
      stopped = false
      const sdk = await import('dingtalk-stream')
      const stream = new sdk.DWClient({ clientId, clientSecret, keepAlive: true, debug: false } as { clientId: string; clientSecret: string; keepAlive: boolean; debug: boolean }) as unknown as StreamClient
      client = stream
      const topic = sdk.TOPIC_ROBOT
      stream.registerCallbackListener(topic, (response) => {
        const headers = response.headers as Record<string, unknown> | undefined
        const messageId = typeof headers?.messageId === 'string' ? headers.messageId : ''
        if (messageId) stream.socketCallBackResponse(messageId, { success: true })
        let message: Record<string, any>
        try { message = typeof response.data === 'string' ? JSON.parse(response.data) : response.data as Record<string, any> } catch { return }
        const sender = String(message.senderStaffId ?? message.senderId ?? '').trim()
        if (!sender) return
        const isGroup = String(message.conversationType) === '2'
        if (isGroup && message.isInAtList !== true) return
        const chatId = isGroup ? `group:${String(message.conversationId ?? '')}` : `p2p:${sender}`
        const webhook = safeDingTalkSessionWebhook(message.sessionWebhook)
        if (!chatId || chatId.endsWith(':') || !webhook) return
        webhooks.set(chatId, webhook)
        const text = textOf(message)
        if (!text) return
        void handler?.({ chatId, userId: sender, username: message.senderNick, text, context: { sessionWebhook: webhook } })
      })
      await stream.connect()
      statusText = '已连接'
      log('[dingtalk] Stream 长连接已启动')
    },
    async stop() {
      stopped = true
      await Promise.resolve(client?.disconnect()).catch(() => undefined)
      client = undefined
      webhooks.clear()
      statusText = '已断开'
    },
    async send(chatId, text) {
      const webhook = webhooks.get(chatId)
      if (!webhook) throw new Error('dingtalk: 当前会话没有可用的 sessionWebhook，请等待用户发送新消息')
      const response = await fetch(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
      })
      if (!response.ok) throw new Error(`dingtalk send: HTTP ${response.status}`)
    },
    setMessageHandler(h) { handler = h },
    status() { return stopped ? '已断开' : statusText },
  }
}
