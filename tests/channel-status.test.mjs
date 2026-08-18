import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeChannelStatus } from '../lib/manager.js'

test('渠道状态统一为已连接、未连接、连接中、异常', () => {
  assert.equal(normalizeChannelStatus({ running: false }), '未连接')
  assert.equal(normalizeChannelStatus({ running: true, rawStatus: 'WebSocket 长连接' }), '已连接')
  assert.equal(normalizeChannelStatus({ running: true, rawStatus: '轮询中' }), '已连接')
  assert.equal(normalizeChannelStatus({ running: true, rawStatus: '已登录（自动恢复）' }), '已连接')
  assert.equal(normalizeChannelStatus({ running: true, rawStatus: 'webhook 监听 :8080' }), '已连接')
  assert.equal(normalizeChannelStatus({ running: true, rawStatus: '连接中' }), '连接中')
  assert.equal(normalizeChannelStatus({ running: true, rawStatus: '鉴权中' }), '连接中')
  assert.equal(normalizeChannelStatus({ running: true, rawStatus: '已连接', loginUrl: 'https://example.test/qr' }), '连接中')
  assert.equal(normalizeChannelStatus({ running: true, rawStatus: '连接错误' }), '异常')
  assert.equal(normalizeChannelStatus({ running: true, rawStatus: '缺少依赖' }), '异常')
  assert.equal(normalizeChannelStatus({ running: false, provisioningStatus: '等待扫码' }), '连接中')
  assert.equal(normalizeChannelStatus({ running: false, provisioningStatus: '扫码失败' }), '异常')
})
