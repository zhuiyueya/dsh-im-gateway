/**
 * 渠道官方扫码接入：只负责生成二维码、等待平台返回机器人凭据。
 * 长连接仍由各渠道 adapter 负责；凭据成功后交回 manager 持久化并连接。
 */

export interface ProvisioningQr {
  dataUrl: string
  expiresAt: number
}

export interface ProvisioningCallbacks {
  onQr(qr: ProvisioningQr): void
  onStatus(status: string): void
  onCredentials(credentials: Record<string, unknown>): void | Promise<void>
  onFailure(error: unknown): void
}

export interface ProvisionerHandle {
  cancel(): void | Promise<void>
}

export interface ChannelProvisioner {
  start(callbacks: ProvisioningCallbacks, signal: AbortSignal): Promise<ProvisionerHandle>
}

async function qrDataUrl(value: string): Promise<string> {
  const mod = await import('qrcode')
  return mod.toDataURL(value, {
    type: 'image/png',
    margin: 2,
    width: 320,
    errorCorrectionLevel: 'M',
  })
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

const FEISHU_SCOPES = [
  'im:message.p2p_msg:readonly',
  'im:message.group_at_msg:readonly',
  'im:message:send_as_bot',
]

/** 飞书官方 SDK registerApp：扫码创建应用并返回 App ID/Secret。 */
export const feishuProvisioner: ChannelProvisioner = {
  async start(callbacks, signal) {
    const sdk = await import('@larksuiteoapi/node-sdk')
    let cancelled = false
    let resolveHandle: ((handle: ProvisionerHandle) => void) | undefined
    const handlePromise = new Promise<ProvisionerHandle>((resolve) => { resolveHandle = resolve })
    const registration = sdk.registerApp({
      source: 'deepseek-harness',
      createOnly: true,
      signal,
      appPreset: {
        name: '{user} 的 DeepSeek Harness 助手',
        desc: '连接飞书与 DeepSeek Harness，在聊天中使用 AI 助手。',
      },
      addons: {
        preset: false,
        scopes: { tenant: FEISHU_SCOPES },
        events: { items: { tenant: ['im.message.receive_v1'] } },
      },
      onQRCodeReady: async (info) => {
        const url = cleanString(info?.url)
        const expireIn = Number(info?.expireIn)
        if (!url || !Number.isFinite(expireIn) || expireIn <= 0) {
          callbacks.onFailure(new Error('飞书扫码服务返回了无效二维码'))
          return
        }
        try {
          callbacks.onQr({ dataUrl: await qrDataUrl(url), expiresAt: Date.now() + expireIn * 1000 })
          callbacks.onStatus('等待扫码')
        } catch (error) {
          callbacks.onFailure(error)
        }
      },
      onStatusChange: (info) => {
        if (cancelled) return
        const status = cleanString(info?.status)
        if (status === 'polling' || status === 'slow_down' || status === 'domain_switched') callbacks.onStatus('登录中')
      },
    }).then(async (result) => {
      if (cancelled) return
      const appId = cleanString(result?.client_id)
      const appSecret = cleanString(result?.client_secret)
      if (!appId || !appSecret) {
        callbacks.onFailure(new Error('飞书扫码未返回完整应用凭据'))
        return
      }
      await callbacks.onCredentials({
        appId,
        appSecret,
        ownerOpenId: cleanString(result?.user_info?.open_id),
        domain: result?.user_info?.tenant_brand === 'lark' ? 'lark' : 'feishu',
      })
    }).catch((error) => {
      if (!cancelled && !signal.aborted) callbacks.onFailure(error)
    })
    const handle: ProvisionerHandle = {
      cancel() {
        cancelled = true
        if (!signal.aborted) callbacks.onStatus('已取消')
      },
    }
    resolveHandle?.(handle)
    void handlePromise
    // Keep the registration promise alive; completion is delivered through callbacks.
    void registration
    return handle
  },
}

/** QQ 官方 connector：手机 QQ 扫码创建 QQ 开放平台机器人。 */
export const qqProvisioner: ChannelProvisioner = {
  async start(callbacks, signal) {
    const mod = await import('@tencent-connect/qqbot-connector')
    let disposed = false
    const dispose = await mod.startQrConnect({
      onQrDisplayed: async (url: string) => {
        if (disposed) return
        try {
          callbacks.onQr({ dataUrl: await qrDataUrl(url), expiresAt: Date.now() + 5 * 60_000 })
          callbacks.onStatus('等待扫码')
        } catch (error) {
          callbacks.onFailure(error)
        }
      },
      onQrExpired: () => {
        if (!disposed) callbacks.onStatus('二维码已过期')
      },
      onSuccess: async (credentials: Array<{ appId?: string; appSecret?: string; userOpenid?: string }>) => {
        if (disposed) return
        const first = credentials?.find((item) => cleanString(item?.appId) && cleanString(item?.appSecret))
        if (!first) {
          callbacks.onFailure(new Error('QQ 扫码未返回完整机器人凭据'))
          return
        }
        await callbacks.onCredentials({
          appId: cleanString(first.appId),
          appSecret: cleanString(first.appSecret),
          ownerUserOpenid: cleanString(first.userOpenid),
        })
      },
      onFailure: (error: unknown) => {
        if (!disposed) callbacks.onFailure(error)
      },
    }, {
      displayQrCodeToConsole: false,
      source: 'deepseek-harness',
      signal,
    })
    const handle: ProvisionerHandle = {
      cancel() {
        disposed = true
        if (typeof dispose === 'function') dispose()
      },
    }
    return handle
  },
}

/** 钉钉官方设备授权：初始化 → begin → 轮询，成功返回 Client ID/Secret。 */
export const dingtalkProvisioner: ChannelProvisioner = {
  async start(callbacks, signal) {
    const base = 'https://oapi.dingtalk.com'
    const post = async (path: string, body: Record<string, unknown>) => {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
      if (!response.ok) throw new Error(`钉钉扫码服务 HTTP ${response.status}`)
      const value = await response.json() as Record<string, any>
      if (Number(value.errcode) !== 0) throw new Error('钉钉扫码服务拒绝了请求')
      return value
    }
    const initialized = await post('/app/registration/init', { source: 'DING_DWS_CLAW' })
    const nonce = cleanString(initialized.nonce)
    if (!nonce) throw new Error('钉钉扫码初始化未返回 nonce')
    const begun = await post('/app/registration/begin', { nonce })
    const deviceCode = cleanString(begun.device_code)
    const verificationUrl = cleanString(begun.verification_uri_complete)
    if (!deviceCode || !verificationUrl) throw new Error('钉钉扫码服务未返回完整二维码信息')
    callbacks.onQr({ dataUrl: await qrDataUrl(verificationUrl), expiresAt: Date.now() + Number(begun.expires_in ?? 7200) * 1000 })
    callbacks.onStatus('等待扫码')
    let cancelled = false
    const interval = Math.max(1, Number(begun.interval ?? 5)) * 1000
    const poll = async () => {
      while (!cancelled && !signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, interval))
        if (cancelled || signal.aborted) return
        const result = await post('/app/registration/poll', { device_code: deviceCode })
        const status = cleanString(result.status)?.toUpperCase()
        if (status === 'WAITING') { callbacks.onStatus('登录中'); continue }
        if (status !== 'SUCCESS') { callbacks.onFailure(new Error('钉钉扫码未完成或已过期')); return }
        const clientId = cleanString(result.client_id)
        const clientSecret = cleanString(result.client_secret)
        if (!clientId || !clientSecret) { callbacks.onFailure(new Error('钉钉扫码未返回完整机器人凭据')); return }
        await callbacks.onCredentials({ clientId, clientSecret })
        return
      }
    }
    const task = poll().catch((error) => { if (!cancelled && !signal.aborted) callbacks.onFailure(error) })
    return { cancel() { cancelled = true; void task } }
  },
}

export type WecomQrState = 'waiting' | 'success' | 'expired' | 'failed'

export function classifyWecomQrStatus(value: unknown): WecomQrState {
  const status = cleanString(value)?.toLowerCase()
  if (status === 'success') return 'success'
  if (status === 'expired' || status === 'timeout') return 'expired'
  if (status === 'fail' || status === 'failed' || status === 'error') return 'failed'
  // 官方接口首次返回 init；未知状态也继续等待，避免误杀有效二维码。
  return 'waiting'
}

/** 企业微信官方智能机器人扫码授权。 */
export const wecomProvisioner: ChannelProvisioner = {
  async start(callbacks, signal) {
    const generate = new URL('https://work.weixin.qq.com/ai/qc/generate')
    // 企业微信生成接口会为未知 source 返回二维码，但手机授权页会再校验并报“参数不合法”。
    // 官方 @wecom/wecom-openclaw-cli 固定使用 wecom-cli。
    generate.searchParams.set('source', 'wecom-cli')
    generate.searchParams.set('plat', process.platform === 'win32' ? '2' : process.platform === 'linux' ? '3' : '1')
    const response = await fetch(generate, { headers: { accept: 'application/json' }, redirect: 'error', signal })
    if (!response.ok) throw new Error(`企业微信扫码服务 HTTP ${response.status}`)
    const body = await response.json() as Record<string, any>
    const scode = cleanString(body?.data?.scode)
    const verificationUrl = cleanString(body?.data?.auth_url)
    if (!scode || !verificationUrl || !verificationUrl.startsWith('https://work.weixin.qq.com/')) throw new Error('企业微信扫码服务返回了无效数据')
    callbacks.onQr({ dataUrl: await qrDataUrl(verificationUrl), expiresAt: Date.now() + 5 * 60_000 })
    callbacks.onStatus('等待扫码')
    let cancelled = false
    const poll = async () => {
      while (!cancelled && !signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 3000))
        if (cancelled || signal.aborted) return
        const url = new URL('https://work.weixin.qq.com/ai/qc/query_result')
        url.searchParams.set('scode', scode)
        const resultResponse = await fetch(url, { headers: { accept: 'application/json' }, signal })
        if (!resultResponse.ok) throw new Error(`企业微信扫码轮询 HTTP ${resultResponse.status}`)
        const result = await resultResponse.json() as Record<string, any>
        const state = classifyWecomQrStatus(result?.data?.status)
        if (state === 'waiting') { callbacks.onStatus('登录中'); continue }
        if (state === 'expired') { callbacks.onFailure(new Error('企业微信二维码已过期')); return }
        if (state === 'failed') { callbacks.onFailure(new Error('企业微信扫码未完成')); return }
        const botId = cleanString(result?.data?.bot_info?.botid)
        const secret = cleanString(result?.data?.bot_info?.secret)
        if (!botId || !secret) { callbacks.onFailure(new Error('企业微信扫码未返回完整机器人凭据')); return }
        await callbacks.onCredentials({ botId, secret })
        return
      }
    }
    const task = poll().catch((error) => { if (!cancelled && !signal.aborted) callbacks.onFailure(error) })
    return { cancel() { cancelled = true; void task } }
  },
}

export function provisionerFor(channelId: string): ChannelProvisioner | undefined {
  if (channelId === 'feishu') return feishuProvisioner
  if (channelId === 'qqbot') return qqProvisioner
  if (channelId === 'dingtalk') return dingtalkProvisioner
  if (channelId === 'wecom') return wecomProvisioner
  return undefined
}
