/**
 * Discord 渠道适配器：Gateway v10 WebSocket + REST，零第三方依赖
 * （使用 Node 22+ 全局 WebSocket 与 fetch）。
 * @module dsh-im-gateway/channels/discord
 */

import type { ChannelAdapter, ImMessage } from '../core/types.js'

export interface DiscordChannelConfig {
  enabled?: boolean
  /** Bot token；缺省回退 DSH_DISCORD_TOKEN 环境变量。 */
  token?: string
  /** 允许私聊的用户 id（字符串化）。 */
  allowedUserIds?: string[]
}

interface GatewayHello {
  heartbeat_interval: number
}

interface GatewayPayload {
  op: number
  d?: unknown
  s?: number
  t?: string
}

interface DispatchMessage {
  id: string
  channel_id: string
  author: { id: string; username: string; bot?: boolean }
  content?: string
  guild_id?: string
}

const API = 'https://discord.com/api/v10'
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15) // GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT

export function createDiscordChannel(config: DiscordChannelConfig, log: (line: string) => void): ChannelAdapter | undefined {
  const token = config.token ?? process.env.DSH_DISCORD_TOKEN
  if (!token) return undefined

  let handler: ((msg: ImMessage) => void | Promise<void>) | undefined
  let ws: WebSocket | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let stopped = false
  let seq: number | null = null
  let botUserId: string | undefined
  let statusText = '未连接'

  async function rest<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        authorization: `Bot ${token}`,
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`discord ${path}: HTTP ${res.status} ${body.slice(0, 200)}`)
    }
    return res.json() as Promise<T>
  }

  async function connect(): Promise<void> {
    const { url } = await rest<{ url: string }>('/gateway/bot')
    ws = new WebSocket(`${url}/?v=10&encoding=json`)
    ws.onopen = () => {
      log('[discord] gateway 已连接，identify…')
      ws?.send(JSON.stringify({
        op: 2,
        d: {
          token,
          intents: INTENTS,
          properties: { os: 'linux', browser: 'dsh-im-gateway', device: 'dsh-im-gateway' },
        },
      }))
    }
    ws.onmessage = (ev) => {
      const payload = JSON.parse(String(ev.data)) as GatewayPayload
      if (payload.s !== undefined) seq = payload.s
      switch (payload.op) {
        case 10: {
          const hello = payload.d as GatewayHello
          heartbeat = setInterval(() => {
            ws?.send(JSON.stringify({ op: 1, d: seq }))
          }, hello.heartbeat_interval)
          statusText = '已连接'
          log('[discord] gateway 就绪')
          break
        }
        case 11:
          break // heartbeat ack
        case 0: {
          const t = payload.t
          const d = payload.d as Record<string, unknown>
          if (t === 'READY') {
            const user = d.user as { id?: string } | undefined
            botUserId = user?.id
          } else if (t === 'MESSAGE_CREATE') {
            const m = d as unknown as DispatchMessage
            const authoredByBot = m.author.bot === true || m.author.id === botUserId
            if (m.content && !authoredByBot) {
              const isDM = (d as { channel_type?: number }).channel_type === 1
              void handler?.({
                chatId: m.channel_id,
                userId: m.author.id,
                username: m.author.username,
                text: m.content,
                context: isDM ? { dm: true } : { guild: true },
              })
            }
          }
          break
        }
        case 7:
          statusText = '重连中'
          break
      }
    }
    ws.onclose = (ev) => {
      clearInterval(heartbeat)
      heartbeat = undefined
      statusText = `已断开（code ${ev.code}）`
      if (!stopped) {
        log(`[discord] 连接断开（${ev.code}），3s 后重连`)
        setTimeout(() => void connect(), 3000)
      }
    }
    ws.onerror = () => {
      statusText = '连接错误'
    }
  }

  return {
    id: 'discord',
    label: 'Discord',
    maxMessageLength: 2000,
    async start() {
      stopped = false
      await connect()
    },
    async stop() {
      stopped = true
      clearInterval(heartbeat)
      ws?.close(1000, 'shutdown')
      ws = undefined
    },
    async send(chatId, text) {
      await rest(`/channels/${chatId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: text }),
      })
    },
    async sendAction(chatId) {
      await rest(`/channels/${chatId}/typing`, { method: 'POST' }).catch(() => undefined)
    },
    setMessageHandler(h) {
      handler = h
    },
    status() {
      return statusText
    },
  }
}
