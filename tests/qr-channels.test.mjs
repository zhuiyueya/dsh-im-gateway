import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { CHANNEL_IDS, CHANNEL_META, createChannel } from '../lib/channels/index.js'
import { classifyWecomQrStatus, provisionerFor, wecomProvisioner } from '../lib/core/provisioning.js'
import { safeDingTalkSessionWebhook } from '../lib/channels/dingtalk.js'

test('官方扫码渠道矩阵包含飞书、QQ、钉钉、企业微信', () => {
  for (const id of ['feishu', 'qqbot', 'dingtalk', 'wecom']) {
    assert.ok(CHANNEL_IDS.includes(id))
    assert.equal(CHANNEL_META[id].qrProvisioning, true)
    assert.ok(provisionerFor(id))
  }
})

test('钉钉和企业微信使用打包的本地图标', async () => {
  for (const [id, filename] of [['dingtalk', 'dingtalk.svg'], ['wecom', 'wecom.svg']]) {
    assert.equal(CHANNEL_META[id].icon, filename)
    const svg = await readFile(new URL(`../assets/icons/${filename}`, import.meta.url), 'utf8')
    assert.match(svg, /^<svg[\s>]/)
  }
})

test('没有凭据时四个官方渠道不启动', () => {
  for (const id of ['feishu', 'qqbot', 'dingtalk', 'wecom']) {
    assert.equal(createChannel(id, {}, () => {}, '/tmp'), undefined)
  }
})

test('钉钉 sessionWebhook 只接受官方 HTTPS 域名', () => {
  assert.equal(safeDingTalkSessionWebhook('https://api.dingtalk.com/robot/send?x=1'), 'https://api.dingtalk.com/robot/send?x=1')
  assert.equal(safeDingTalkSessionWebhook('https://evil.example/steal'), undefined)
  assert.equal(safeDingTalkSessionWebhook('http://api.dingtalk.com/robot/send'), undefined)
  assert.equal(safeDingTalkSessionWebhook('https://user:pass@api.dingtalk.com/robot/send'), undefined)
})

test('企业微信扫码使用官方 CLI 接受的 source=wecom-cli', async () => {
  const originalFetch = globalThis.fetch
  const controller = new AbortController()
  let requested
  globalThis.fetch = async (input) => {
    requested = new URL(String(input))
    return new Response(JSON.stringify({
      data: {
        scode: '0123456789abcdef',
        auth_url: 'https://work.weixin.qq.com/ai/qc/c?s=0123456789abcdef&hide_more_btn=true&for_native=true',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const handle = await wecomProvisioner.start({
      onQr() { controller.abort() },
      onStatus() {},
      async onCredentials() {},
      onFailure(error) { throw error },
    }, controller.signal)
    assert.equal(requested.hostname, 'work.weixin.qq.com')
    assert.equal(requested.pathname, '/ai/qc/generate')
    assert.equal(requested.searchParams.get('source'), 'wecom-cli')
    assert.ok(['1', '2', '3'].includes(requested.searchParams.get('plat')))
    await handle.cancel()
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('企业微信 init 状态保持等待，只有明确终态才结束', () => {
  assert.equal(classifyWecomQrStatus('init'), 'waiting')
  assert.equal(classifyWecomQrStatus('waiting'), 'waiting')
  assert.equal(classifyWecomQrStatus(undefined), 'waiting')
  assert.equal(classifyWecomQrStatus('success'), 'success')
  assert.equal(classifyWecomQrStatus('expired'), 'expired')
  assert.equal(classifyWecomQrStatus('timeout'), 'expired')
  assert.equal(classifyWecomQrStatus('fail'), 'failed')
  assert.equal(classifyWecomQrStatus('error'), 'failed')
})
