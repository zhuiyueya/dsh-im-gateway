/**
 * 企业微信智能机器人渠道：官方 WebSocket 长连接。
 * 扫码创建后的 Bot ID/Secret 由 core/provisioning.ts 写入配置。
 */
import type { ChannelAdapter, ImMessage } from '../core/types.js'

export interface WecomChannelConfig {
  enabled?: boolean
  botId?: string
  secret?: string
}

type WecomClient = {
  connect(): void | Promise<void>
  disconnect(): void | Promise<void>
  on(event: string, callback: (value: any) => void): void
  removeAllListeners?(): void
  sendMessage(chatId: string, message: Record<string, unknown>): Promise<unknown>
  replyStream?(frame: Record<string, unknown>, streamId: string, text: string, finish: boolean): Promise<unknown>
}

function messageText(frame: Record<string, any>): string {
  const body = frame?.body ?? {}
  if (body.msgtype === 'text') return typeof body.text?.content === 'string' ? body.text.content.trim() : ''
  if (body.msgtype === 'voice') return typeof body.voice?.content === 'string' ? body.voice.content.trim() : ''
  if (body.msgtype === 'mixed' && Array.isArray(body.mixed?.msg_item)) {
    return body.mixed.msg_item.filter((item: any) => item?.msgtype === 'text' && typeof item.text?.content === 'string').map((item: any) => item.text.content).join('\n').trim()
  }
  return ''
}

export function createWecomChannel(config: WecomChannelConfig, log: (line: string) => void): ChannelAdapter | undefined {
  const botId = config.botId ?? process.env.DSH_WECOM_BOT_ID
  const secret = config.secret ?? process.env.DSH_WECOM_SECRET
  if (!botId || !secret) return undefined
  let handler: ((msg: ImMessage) => void | Promise<void>) | undefined
  let client: WecomClient | undefined
  let stopped = false
  let statusText = '未连接'

  return {
    id: 'wecom',
    label: '企业微信',
    maxMessageLength: 4000,
    async start() {
      stopped = false
      const sdk = await import('@wecom/aibot-node-sdk')
      const ws = new sdk.WSClient({ botId, secret, logger: { debug() {}, info() {}, warn() {}, error() {} }, maxReconnectAttempts: 10 }) as unknown as WecomClient
      client = ws
      ws.on('authenticated', () => { statusText = '已连接'; log('[wecom] WebSocket 已认证') })
      ws.on('reconnecting', () => { statusText = '重连中' })
      ws.on('disconnected', () => { if (!stopped) statusText = '已断开' })
      ws.on('error', (error) => { if (!stopped) log(`[wecom] WebSocket 错误: ${error instanceof Error ? error.message : String(error)}`) })
      ws.on('message', (frame) => {
        const body = frame?.body ?? {}
        const sender = typeof body.from?.userid === 'string' ? body.from.userid : ''
        const chatId = body.chattype === 'group' ? String(body.chatid ?? '') : sender
        const text = messageText(frame)
        if (!sender || !chatId || !text) return
        void handler?.({ chatId, userId: sender, text, context: { frame } })
      })
      ws.connect()
      statusText = '连接中'
    },
    async stop() {
      stopped = true
      await Promise.resolve(client?.disconnect()).catch(() => undefined)
      client?.removeAllListeners?.()
      client = undefined
      statusText = '已断开'
    },
    async send(chatId, text) {
      if (!client) throw new Error('wecom: 未连接')
      await client.sendMessage(chatId, { msgtype: 'markdown', markdown: { content: text } })
    },
    setMessageHandler(h) { handler = h },
    status() { return statusText },
  }
}
