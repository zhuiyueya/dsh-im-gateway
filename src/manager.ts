/**
 * 渠道管理器：UI 驱动的渠道生命周期（启用/停用/刷新二维码/状态查询）。
 *
 * - 持久化：`$DSH_HOME/dsh-im-gateway/channels.json`（UI 配置优先于 cordis config）
 * - 动态启停：无需重启 dsh，点「连接」即生效
 * - HTTP API：`/dsh-im-gateway/api/*`（Web GUI 面板调用）
 * @module dsh-im-gateway/manager
 */

import type { Context } from '@deepseek-ai/cordis'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChannelAdapter, ImGatewayConfig } from './core/types.js'
import { ImGateway } from './core/gateway.js'
import type { CronRegistry } from './core/cron.js'
import { provisionerFor, type ProvisionerHandle } from './core/provisioning.js'
import { CHANNEL_IDS, CHANNEL_META, createChannel, type ChannelMeta } from './channels/index.js'

/** 本模块目录（ESM 无 __dirname；lib/manager.js 的 ../assets 即包根 assets）。 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

/** 设置页统一展示的渠道状态；底层协议细节只保留在 adapter 日志中。 */
export type ChannelDisplayStatus = '已连接' | '未连接' | '连接中' | '异常'

const TERMINAL_PROVISIONING = new Set(['已连接', '已取消'])
const FAILED_PROVISIONING = new Set(['扫码失败', '扫码启动失败', '连接失败', '二维码已过期'])

export function normalizeChannelStatus(input: {
  running: boolean
  rawStatus?: string
  loginUrl?: string
  provisioningStatus?: string
}): ChannelDisplayStatus {
  const provisioning = input.provisioningStatus ?? ''
  if (FAILED_PROVISIONING.has(provisioning)) return '异常'
  if (provisioning && !TERMINAL_PROVISIONING.has(provisioning)) return '连接中'
  if (!input.running) return '未连接'

  const raw = input.rawStatus ?? ''
  if (/错误|失败|异常|缺少依赖|已断开|已停止|已登出|仅支持/.test(raw)) return '异常'
  if (input.loginUrl || /等待|登录中|连接中|重连中|鉴权中|握手|未启动/.test(raw)) return '连接中'
  return '已连接'
}

/** 前端展示用的渠道视图。 */
export interface ChannelView {
  id: string
  label: string
  emoji: string
  /** 本地图标文件名（assets/icons/），前端经 /dsh-im-gateway/api/icon/<id> 加载；缺省回退 emoji。 */
  icon?: string
  docs?: string
  kind: ChannelMeta['kind']
  needs: string[]
  fields: ChannelMeta['fields']
  hint: string
  /** 是否已在 UI 中启用（channels.json 或 cordis 配置）。 */
  enabled: boolean
  /** 是否正在运行（adapter 已启动）。 */
  running: boolean
  /** 设置页统一状态，不暴露 WebSocket、轮询等 adapter 实现细节。 */
  status: ChannelDisplayStatus
  /** 登录二维码 URL（设备扫码类渠道，如微信）。 */
  loginUrl?: string
  /** 是否支持官方扫码创建/绑定机器人。 */
  qrProvisioning: boolean
  /** 官方扫码接入状态。 */
  provisioningStatus?: string
  /** 本地生成的二维码 data URL。 */
  provisioningQrDataUrl?: string
  /** 二维码过期时刻。 */
  provisioningExpiresAt?: number
  /** 扫码流程安全化错误摘要（不包含凭据）。 */
  provisioningError?: string
  /** 已配置的凭据键（脱敏，仅显示哪些已填）。 */
  configuredKeys: string[]
  /** UI 批准的渠道白名单用户。 */
  allowlist: string[]
}

export interface ManagerOptions {
  config: ImGatewayConfig
  stateDir: string
  log: (line: string) => void
  gateway: ImGateway
  /** im_cron 注册表（/api/cron 管理端点用）。 */
  cron: CronRegistry
}

export class ChannelManager {
  private readonly ctx: Context
  private readonly options: ManagerOptions
  private readonly stateFile: string
  private readonly cron: CronRegistry
  private store: Record<string, Record<string, unknown>>
  /** 渠道级白名单（UI 批准的用户）：channelId → userId[]。 */
  private allowlist: Record<string, string[]>
  /** 待授权请求：channelId → 请求列表。 */
  private pending: Record<string, Array<{ userId: string; username?: string; chatId?: string; time: number }>>
  /** 运行中的 adapter：id → { adapter }。 */
  private readonly running = new Map<string, ChannelAdapter>()
  /** 官方扫码接入尝试：同一渠道最多一个。 */
  private readonly provisioning = new Map<string, {
    controller: AbortController
    handle?: ProvisionerHandle
    status: string
    qrDataUrl?: string
    expiresAt?: number
    error?: string
  }>()
  /** API 路由 disposer（HMR 重载/卸载时清理，避免重复注册）。 */
  private apiDisposers: Array<() => void> = []

  constructor(ctx: Context, options: ManagerOptions) {
    this.ctx = ctx
    this.options = options
    this.cron = options.cron
    this.stateFile = join(options.stateDir, 'channels.json')
    const loaded = this.load()
    this.store = loaded.channels
    this.allowlist = loaded.allowlist
    this.pending = loaded.pending
  }

  private load(): { channels: Record<string, Record<string, unknown>>; allowlist: Record<string, string[]>; pending: Record<string, Array<{ userId: string; username?: string; chatId?: string; time: number }>> } {
    try {
      const raw = readFileSync(this.stateFile, 'utf8')
      const parsed = JSON.parse(raw) as {
        channels?: Record<string, Record<string, unknown>>
        allowlist?: Record<string, string[]>
        pending?: Record<string, Array<{ userId: string; username?: string; chatId?: string; time: number }>>
      }
      return {
        channels: parsed.channels ?? {},
        allowlist: parsed.allowlist ?? {},
        pending: parsed.pending ?? {},
      }
    } catch {
      return { channels: {}, allowlist: {}, pending: {} }
    }
  }

  private flush(): void {
    try {
      mkdirSync(this.options.stateDir, { recursive: true })
      writeFileSync(this.stateFile, JSON.stringify({ channels: this.store, allowlist: this.allowlist, pending: this.pending }, null, 2))
    } catch (err) {
      this.options.log(`[manager] 状态落盘失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ── 授权 ─────────────────────────────────────────────────────

  /** 该用户是否已获授权（UI allowlist 或 cordis 配置白名单）。 */
  isAuthorized(channelId: string, userId: string): boolean {
    if (this.options.config.allowAllUsers) return true
    const fromAllowlist = this.allowlist[channelId]
    if (fromAllowlist && fromAllowlist.includes(userId)) return true
    const perChannel = this.options.config.allowedUserIds[channelId]
    if (perChannel && perChannel.includes(userId)) return true
    const global = this.options.config.allowedUserIds['*']
    if (global && global.includes(userId)) return true
    return false
  }

  /** 记录一个待授权请求（去重）。 */
  requestAuthorization(channelId: string, userId: string, username?: string, chatId?: string): void {
    const list = this.pending[channelId] ?? []
    if (!list.some((p) => p.userId === userId)) {
      list.push({ userId, username, chatId, time: Date.now() })
      this.pending[channelId] = list
      this.flush()
      this.options.log(`[manager] ${channelId} 有待授权请求：${username ?? userId}`)
    }
  }

  /** 批准用户：加入渠道白名单并同步网关。 */
  approve(channelId: string, userId: string): { ok: boolean; error?: string } {
    const list = this.allowlist[channelId] ?? []
    if (!list.includes(userId)) {
      list.push(userId)
      this.allowlist[channelId] = list
    }
    this.options.gateway.addAuthorizedUser(channelId, userId)
    this.removePending(channelId, userId)
    this.flush()
    this.options.log(`[manager] 已授权 ${channelId} 用户 ${userId}`)
    return { ok: true }
  }

  /** 拒绝用户：仅移除待授权请求。 */
  deny(channelId: string, userId: string): void {
    this.removePending(channelId, userId)
    this.flush()
  }

  private removePending(channelId: string, userId: string): void {
    const list = this.pending[channelId]
    if (!list) return
    this.pending[channelId] = list.filter((p) => p.userId !== userId)
    if (this.pending[channelId]!.length === 0) delete this.pending[channelId]
  }

  /** 全部待授权请求（跨渠道聚合，UI 横幅用）。 */
  pendingRequests(): Array<{ channelId: string; userId: string; username?: string; time: number }> {
    const out: Array<{ channelId: string; userId: string; username?: string; time: number }> = []
    for (const [channelId, list] of Object.entries(this.pending)) {
      for (const p of list) out.push({ channelId, userId: p.userId, username: p.username, time: p.time })
    }
    return out
  }

  /** 合并配置：channels.json（UI）优先，cordis config 兜底。 */
  private mergedConfig(id: string): Record<string, unknown> {
    const cordis = (this.options.config.channels as Record<string, Record<string, unknown>>)[id] ?? {}
    return { ...cordis, ...(this.store[id] ?? {}) }
  }

  /** 启动时初始化：合并配置中应启用的渠道全部启动；并把持久化白名单灌入网关。 */
  async initAll(): Promise<void> {
    // 重启后恢复 UI 批准的渠道白名单
    for (const [channelId, users] of Object.entries(this.allowlist)) {
      for (const userId of users) this.options.gateway.addAuthorizedUser(channelId, userId)
    }
    for (const id of CHANNEL_IDS) {
      const cfg = this.mergedConfig(id)
      // 启用判定：cordis enabled=true，或 store 存在且未被显式禁用
      // （断开只停运行态不写 enabled，因此"配置了 = 重启自动恢复"）
      const stored = this.store[id]
      const enabled = cfg.enabled === true || (stored !== undefined && stored.enabled !== false)
      if (enabled) {
        await this.connect(id).catch((err) => {
          this.options.log(`[manager] ${id} 启动失败: ${err instanceof Error ? err.message : String(err)}`)
        })
      }
    }
  }

  /** 持久化白名单条目（重启恢复用）。 */
  allowlistEntries(): Array<[string, string[]]> {
    return Object.entries(this.allowlist)
  }

  /** 启用并启动一个渠道。extra 里的字段合并进配置并持久化。 */
  async connect(id: string, extra?: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
    const meta = CHANNEL_META[id as keyof typeof CHANNEL_META]
    if (!meta) return { ok: false, error: `未知渠道 ${id}` }
    // 合并 extra → store
    if (extra) {
      this.store[id] = { ...(this.store[id] ?? {}), ...extra, enabled: true }
      this.flush()
    }
    const cfg = this.mergedConfig(id)
    if (this.running.has(id)) {
      // 已运行：extra 变更时先停再启
      await this.disconnect(id)
    }
    const adapter = createChannel(id, { ...cfg, enabled: true }, this.options.log, this.options.stateDir)
    if (!adapter) {
      const error = `${meta.label}：缺少必要配置（${meta.needs.join(' / ') || '未知原因'}）`
      this.options.log(`[manager] ${id} 连接失败: ${error}`)
      return { ok: false, error }
    }
    this.options.gateway.register(adapter)
    this.running.set(id, adapter)
    try {
      await adapter.start()
      this.options.log(`[manager] ${id} 已连接`)
      return { ok: true }
    } catch (err) {
      this.running.delete(id)
      this.options.gateway.unregister(id)
      const error = `${meta.label} 启动失败：${err instanceof Error ? err.message : String(err)}`
      this.options.log(`[manager] ${id} 启动失败: ${err instanceof Error ? err.message : String(err)}`)
      return { ok: false, error }
    }
  }

  /**
   * 停用并停止一个渠道（仅运行态，不持久化 enabled——重启后按配置自动恢复）。
   * 彻底移除配置请用 {@link remove}。
   */
  async disconnect(id: string): Promise<void> {
    const adapter = this.running.get(id)
    if (adapter) {
      await Promise.resolve(adapter.stop()).catch(() => undefined)
      this.running.delete(id)
      this.options.gateway.unregister(id)
    }
    this.options.log(`[manager] ${id} 已断开（配置保留，重启自动恢复）`)
  }

  /** 彻底移除渠道：停止并删除持久化配置（重启后不再自动连接）。 */
  async remove(id: string): Promise<void> {
    await this.cancelProvisioning(id)
    await this.disconnect(id)
    if (this.store[id]) {
      delete this.store[id]
      this.flush()
    }
    // 清空该渠道的授权与待授权
    delete this.allowlist[id]
    delete this.pending[id]
    this.flush()
    this.options.log(`[manager] ${id} 配置已删除`)
  }

  /** 刷新登录（重新启停，用于重新取二维码）。 */
  async refreshLogin(id: string): Promise<{ ok: boolean; error?: string }> {
    await this.disconnect(id)
    return this.connect(id)
  }

  /** 开始官方扫码创建/绑定机器人（飞书、QQ 等）。 */
  async startProvisioning(id: string): Promise<{ ok: boolean; error?: string }> {
    const provisioner = provisionerFor(id)
    if (!provisioner) return { ok: false, error: `${CHANNEL_META[id as keyof typeof CHANNEL_META]?.label ?? id} 暂不支持官方扫码接入` }
    await this.cancelProvisioning(id)
    const controller = new AbortController()
    const attempt: {
      controller: AbortController
      handle?: ProvisionerHandle
      status: string
      qrDataUrl?: string
      expiresAt?: number
      error?: string
    } = { controller, status: '登录中' }
    this.provisioning.set(id, attempt)
    try {
      const handle = await provisioner.start({
        onQr: (qr) => {
          if (this.provisioning.get(id) !== attempt) return
          attempt.qrDataUrl = qr.dataUrl
          attempt.expiresAt = qr.expiresAt
          attempt.status = '等待扫码'
        },
        onStatus: (status) => {
          if (this.provisioning.get(id) === attempt) attempt.status = status
        },
        onCredentials: async (credentials) => {
          if (this.provisioning.get(id) !== attempt) return
          attempt.status = '保存凭据'
          const owner = typeof credentials.ownerOpenId === 'string'
            ? credentials.ownerOpenId
            : typeof credentials.ownerUserOpenid === 'string' ? credentials.ownerUserOpenid : undefined
          const config = { ...credentials }
          delete config.ownerOpenId
          delete config.ownerUserOpenid
          const result = await this.connect(id, config)
          if (result.ok) {
            if (owner) this.approve(id, owner)
            attempt.status = '已连接'
            attempt.qrDataUrl = undefined
            attempt.expiresAt = undefined
          } else {
            attempt.status = '连接失败'
            attempt.error = result.error
          }
        },
        onFailure: (error) => {
          if (this.provisioning.get(id) !== attempt) return
          const detail = error instanceof Error ? error.message : String(error)
          this.options.log(`[manager] ${id} 扫码失败: ${detail}`)
          attempt.status = controller.signal.aborted ? '已取消' : '扫码失败'
          attempt.error = controller.signal.aborted ? undefined : '平台扫码服务暂时不可用或二维码已过期，请重新扫码。'
        },
      }, controller.signal)
      if (this.provisioning.get(id) === attempt) attempt.handle = handle
      return { ok: true }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.options.log(`[manager] ${id} 扫码启动失败: ${detail}`)
      if (this.provisioning.get(id) === attempt) {
        attempt.status = '扫码启动失败'
        attempt.error = '无法启动扫码流程，请检查网络和可选依赖后重试。'
      }
      return { ok: false, error: '无法启动扫码流程，请检查网络和可选依赖后重试。' }
    }
  }

  /** 取消官方扫码接入尝试。 */
  async cancelProvisioning(id: string): Promise<void> {
    const attempt = this.provisioning.get(id)
    if (!attempt) return
    this.provisioning.delete(id)
    attempt.controller.abort()
    await Promise.resolve(attempt.handle?.cancel()).catch(() => undefined)
  }

  /** 渠道视图列表（UI 渲染用）。 */
  list(): ChannelView[] {
    const out: ChannelView[] = []
    for (const id of CHANNEL_IDS) {
      const meta = CHANNEL_META[id]
      const adapter = this.running.get(id)
      const cfg = this.mergedConfig(id)
      const provisioning = this.provisioning.get(id)
      const rawStatus = adapter?.status?.()
      const loginUrl = adapter?.loginUrl?.()
      out.push({
        id,
        label: meta.label,
        emoji: meta.emoji,
        icon: meta.icon,
        docs: meta.docs,
        kind: meta.kind,
        qrProvisioning: meta.qrProvisioning === true && provisionerFor(id) !== undefined,
        provisioningStatus: provisioning?.status,
        provisioningQrDataUrl: provisioning?.qrDataUrl,
        provisioningExpiresAt: provisioning?.expiresAt,
        provisioningError: provisioning?.error,
        needs: meta.needs,
        fields: meta.fields,
        hint: meta.hint,
        enabled: this.store[id]?.enabled === true || (cfg.enabled === true && !this.store[id]),
        running: adapter !== undefined,
        status: normalizeChannelStatus({
          running: adapter !== undefined,
          rawStatus,
          loginUrl,
          provisioningStatus: provisioning?.status,
        }),
        loginUrl,
        configuredKeys: Object.keys(cfg).filter((k) => k !== 'enabled' && cfg[k] !== undefined && cfg[k] !== ''),
        allowlist: this.allowlist[id] ?? [],
      })
    }
    return out
  }

  /** 注册 HTTP API（prefix 路由，由 webServer 提供）。 */
  registerApi(): void {
    const webServer = (this.ctx as Context & { webServer?: { register(r: { kind: string; path: string; handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void }): void } }).webServer
    if (!webServer) return
    const send = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    const readBody = (req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> =>
      new Promise((resolve) => {
        let body = ''
        req.on('data', (c) => { body += c })
        req.on('end', () => {
          try { resolve(body ? JSON.parse(body) as Record<string, unknown> : {}) } catch { resolve({}) }
        })
      })

    this.apiDisposers.push(webServer.register({
      kind: 'prefix',
      path: '/dsh-im-gateway/api',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
        const parts = url.pathname.split('/').filter(Boolean) // [dsh-im-gateway, api, ...]
        // /dsh-im-gateway/api/icon/<channelId>：本地品牌图标（assets/icons/<meta.icon>），无外网依赖
        if (parts[2] === 'icon' && parts.length === 4 && req.method === 'GET') {
          const channelId = parts[3]
          const icon = CHANNEL_META[channelId as keyof typeof CHANNEL_META]?.icon
          if (!icon) {
            send(res, 404, { ok: false, error: `no icon for ${channelId}` })
            return
          }
          try {
            const buf = readFileSync(join(MODULE_DIR, '../assets/icons', icon))
            const ext = icon.includes('.') ? icon.slice(icon.lastIndexOf('.')) : '.svg'
            const contentType = ext === '.png' ? 'image/png' : ext === '.ico' ? 'image/x-icon' : 'image/svg+xml'
            res.writeHead(200, { 'content-type': `${contentType}; charset=utf-8`, 'cache-control': 'public, max-age=86400' })
            res.end(buf)
          } catch {
            send(res, 404, { ok: false, error: `icon file missing: ${icon}` })
          }
          return
        }
        // /dsh-im-gateway/api/channels
        if (parts[2] === 'channels' && parts.length === 3 && req.method === 'GET') {
          send(res, 200, { ok: true, channels: this.list(), pending: this.pendingRequests() })
          return
        }
        // /dsh-im-gateway/api/cron
        if (parts[2] === 'cron' && parts.length === 3 && req.method === 'GET') {
          send(res, 200, { ok: true, tasks: this.cron.list() })
          return
        }
        if (parts[2] === 'cron' && parts.length === 4 && req.method === 'POST') {
          const id = parts[3]
          const body = await readBody(req)
          if (id === 'delete') {
            const removed = this.cron.remove(String(body.id ?? ''))
            send(res, removed ? 200 : 404, { ok: removed, ...(removed ? {} : { error: `任务不存在：${String(body.id ?? '')}` }) })
            return
          }
          if (id === 'enable') {
            const enabled = body.enabled !== false
            const done = this.cron.setEnabled(String(body.id ?? ''), enabled)
            send(res, done ? 200 : 404, { ok: done, ...(done ? { enabled } : { error: `任务不存在：${String(body.id ?? '')}` }) })
            return
          }
          send(res, 404, { ok: false, error: `unknown cron action ${id}` })
          return
        }
        // /dsh-im-gateway/api/channels/<id>/connect|disconnect|refresh
        if (parts[2] === 'channels' && parts.length === 5) {
          const id = parts[3]!
          const action = parts[4]!
          if (req.method !== 'POST') {
            send(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const body = await readBody(req)
          if (action === 'connect') {
            const result = await this.connect(id, body.config as Record<string, unknown> | undefined)
            send(res, result.ok ? 200 : 400, result.ok ? { ok: true, channel: this.list().find((c) => c.id === id) } : { ok: false, error: result.error })
            return
          }
          if (action === 'provision') {
            const result = await this.startProvisioning(id)
            send(res, result.ok ? 200 : 400, result.ok ? { ok: true, channel: this.list().find((c) => c.id === id) } : { ok: false, error: result.error })
            return
          }
          if (action === 'cancel-provision') {
            await this.cancelProvisioning(id)
            send(res, 200, { ok: true, channel: this.list().find((c) => c.id === id) })
            return
          }
          if (action === 'disconnect') {
            await this.disconnect(id)
            send(res, 200, { ok: true, channel: this.list().find((c) => c.id === id) })
            return
          }
          if (action === 'remove') {
            await this.remove(id)
            send(res, 200, { ok: true, channel: this.list().find((c) => c.id === id) })
            return
          }
          if (action === 'refresh') {
            const result = await this.refreshLogin(id)
            send(res, result.ok ? 200 : 400, result.ok ? { ok: true, channel: this.list().find((c) => c.id === id) } : { ok: false, error: result.error })
            return
          }
          if (action === 'approve') {
            const userId = String(body.userId ?? '')
            if (!userId) { send(res, 400, { ok: false, error: '缺少 userId' }); return }
            this.approve(id, userId)
            send(res, 200, { ok: true, channel: this.list().find((c) => c.id === id) })
            return
          }
          if (action === 'deny') {
            const userId = String(body.userId ?? '')
            if (!userId) { send(res, 400, { ok: false, error: '缺少 userId' }); return }
            this.deny(id, userId)
            send(res, 200, { ok: true, channel: this.list().find((c) => c.id === id) })
            return
          }
          send(res, 404, { ok: false, error: `unknown action ${action}` })
          return
        }
        send(res, 404, { ok: false, error: 'not found' })
      },
    }))
    this.options.log('[manager] API 已注册（/dsh-im-gateway/api）')
  }

  /** 注销 API 路由（HMR 重载/插件卸载时调用）。 */
  disposeApi(): void {
    for (const disposer of this.apiDisposers) disposer()
    this.apiDisposers = []
  }

  /** 停用全部渠道（插件卸载时）。 */
  async disconnectAll(): Promise<void> {
    for (const id of [...this.running.keys()]) {
      await this.disconnect(id)
    }
  }
}
