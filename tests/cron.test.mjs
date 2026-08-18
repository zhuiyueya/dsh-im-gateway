import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CronRegistry } from '../lib/core/cron.js'

const TZ = 'Asia/Hong_Kong'
const iso = (ms) => new Date(ms).toISOString()

/** 可推进时钟（同一实例内模拟时间流逝，避免跨实例加载的前跳语义干扰）。 */
function makeClock(initial) {
  let t = initial
  return { now: () => t, set: (v) => { t = v } }
}

function makeRegistry({ catchUp = false, send, clock } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'cron-test-'))
  const sent = []
  const registry = new CronRegistry({
    stateDir,
    log: () => undefined,
    catchUp,
    send: send ?? (async (channelId, chatId, text) => { sent.push({ channelId, chatId, text }); return true }),
    now: clock ? clock.now : () => Date.UTC(2026, 7, 17, 0, 0),
  })
  return { registry, stateDir, sent }
}

function teardown(stateDir) {
  rmSync(stateDir, { recursive: true, force: true })
}

test('addTask：计算 nextRunAt（HK 09:00 → 01:00Z）', () => {
  const { registry, stateDir } = makeRegistry()
  try {
    const r = registry.addTask({ channelId: 'wechat', chatId: 'c1', time: '09:00', tz: TZ, prompt: '喝水' })
    assert.equal(r.ok, true)
    if (r.ok) {
      assert.equal(iso(r.task.nextRunAt), '2026-08-17T01:00:00.000Z')
      assert.equal(r.task.mode, 'remind')
      assert.equal(r.task.enabled, true)
    }
    assert.equal(registry.list().length, 1)
  } finally { teardown(stateDir) }
})

test('addTask：非法时刻 / 空文案被拒绝', () => {
  const { registry, stateDir } = makeRegistry()
  try {
    assert.equal(registry.addTask({ channelId: 'w', chatId: 'c', time: 'bad', prompt: 'x' }).ok, false)
    assert.equal(registry.addTask({ channelId: 'w', chatId: 'c', time: '09:00', prompt: '   ' }).ok, false)
    assert.equal(registry.list().length, 0)
  } finally { teardown(stateDir) }
})

test('持久化往返：新 registry 读到同一任务', () => {
  const { registry, stateDir } = makeRegistry()
  try {
    const r = registry.addTask({ channelId: 'w', chatId: 'c', time: '09:00', tz: TZ, prompt: '喝水' })
    assert.ok(r.ok)
    const again = new CronRegistry({ stateDir, log: () => undefined, catchUp: false, send: async () => true, now: () => Date.UTC(2026, 7, 17, 0, 0) })
    const tasks = again.list()
    assert.equal(tasks.length, 1)
    if (r.ok) assert.equal(tasks[0].id, r.task.id)
    assert.equal(iso(tasks[0].nextRunAt), '2026-08-17T01:00:00.000Z')
  } finally { teardown(stateDir) }
})

test('tick：未到期不触发，到点触发并推进 nextRunAt', async () => {
  const clock = makeClock(Date.UTC(2026, 7, 17, 0, 0))
  const { registry, stateDir, sent } = makeRegistry({ clock })
  try {
    registry.addTask({ channelId: 'w', chatId: 'c', time: '08:30', tz: TZ, prompt: '吃药' }) // nextRunAt 00:30Z
    await registry.tick() // now=00:00Z 未到期
    assert.equal(sent.length, 0)
    clock.set(Date.UTC(2026, 7, 17, 0, 31)) // 08:31 本地
    await registry.tick()
    assert.equal(sent.length, 1)
    assert.equal(sent[0].text, '吃药')
    const task = registry.list()[0]
    assert.equal(task.lastRunAt, Date.UTC(2026, 7, 17, 0, 31))
    assert.equal(iso(task.nextRunAt), '2026-08-18T00:30:00.000Z') // 次日 08:30 本地
    // 落盘同步
    const persisted = JSON.parse(readFileSync(join(stateDir, 'cron.json'), 'utf8'))
    assert.equal(persisted.tasks[0].lastRunAt, Date.UTC(2026, 7, 17, 0, 31))
  } finally { teardown(stateDir) }
})

test('发送失败：nextRunAt 保持不变，下轮重试', async () => {
  const clock = makeClock(Date.UTC(2026, 7, 17, 0, 0))
  let fail = true
  const { registry, stateDir } = makeRegistry({ clock, send: async () => !fail })
  try {
    registry.addTask({ channelId: 'w', chatId: 'c', time: '08:30', tz: TZ, prompt: '吃药' }) // nextRunAt 08-17 00:30Z
    clock.set(Date.UTC(2026, 7, 17, 0, 31))
    await registry.tick() // 发送失败
    let task = registry.list()[0]
    assert.equal(task.nextRunAt, Date.UTC(2026, 7, 17, 0, 30)) // 未推进
    assert.equal(task.lastRunAt, undefined)
    fail = false
    clock.set(Date.UTC(2026, 7, 17, 0, 32))
    await registry.tick() // 重试成功
    task = registry.list()[0]
    assert.equal(iso(task.nextRunAt), '2026-08-18T00:30:00.000Z')
    assert.equal(task.lastRunAt, Date.UTC(2026, 7, 17, 0, 32))
  } finally { teardown(stateDir) }
})

test('catchUp=false：加载时过期任务前跳（跳过错过）', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cron-test-'))
  try {
    const first = new CronRegistry({ stateDir, log: () => undefined, catchUp: false, send: async () => true, now: () => Date.UTC(2026, 7, 16, 1, 0) })
    first.addTask({ channelId: 'w', chatId: 'c', time: '09:00', tz: TZ, prompt: '喝水' }) // nextRunAt 08-17 01:00Z
    // 模拟网关停机到 08-18：加载时 nextRunAt 已过期 → 前跳到 08-18 01:00Z
    const again = new CronRegistry({ stateDir, log: () => undefined, catchUp: false, send: async () => true, now: () => Date.UTC(2026, 7, 18, 0, 0) })
    const task = again.list()[0]
    assert.equal(iso(task.nextRunAt), '2026-08-18T01:00:00.000Z')
  } finally { teardown(stateDir) }
})

test('catchUp=true：加载时过期任务保留，首个 tick 补跑最近一次', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cron-test-'))
  try {
    const first = new CronRegistry({ stateDir, log: () => undefined, catchUp: true, send: async () => true, now: () => Date.UTC(2026, 7, 16, 1, 0) })
    first.addTask({ channelId: 'w', chatId: 'c', time: '09:00', tz: TZ, prompt: '喝水' })
    const sent = []
    const again = new CronRegistry({ stateDir, log: () => undefined, catchUp: true, send: async (c, chat, t) => { sent.push(t); return true }, now: () => Date.UTC(2026, 7, 18, 0, 0) })
    await again.tick()
    assert.equal(sent.length, 1) // 补跑最近一次
    const task = again.list()[0]
    assert.equal(iso(task.nextRunAt), '2026-08-18T01:00:00.000Z') // 补跑后推进到当天 09:00 本地（还在未来）
  } finally { teardown(stateDir) }
})

test('remove / setEnabled', () => {
  const { registry, stateDir } = makeRegistry()
  try {
    const r = registry.addTask({ channelId: 'w', chatId: 'c', time: '09:00', prompt: '喝水' })
    assert.ok(r.ok)
    if (!r.ok) return
    assert.equal(registry.remove('no-such'), false)
    assert.equal(registry.setEnabled(r.task.id, false), true)
    assert.equal(registry.list()[0].enabled, false)
    assert.equal(registry.remove(r.task.id), true)
    assert.equal(registry.list().length, 0)
  } finally { teardown(stateDir) }
})

test('task 模式且无 runTask：跳过并记日志，不阻塞 remind', async () => {
  const clock = makeClock(Date.UTC(2026, 7, 17, 0, 0))
  const { registry, stateDir, sent } = makeRegistry({ clock })
  try {
    registry.addTask({ channelId: 'w', chatId: 'c', time: '08:30', tz: TZ, prompt: '生成报告', mode: 'task' })
    registry.addTask({ channelId: 'w', chatId: 'c', time: '08:30', tz: TZ, prompt: '喝水' })
    clock.set(Date.UTC(2026, 7, 17, 0, 31))
    await registry.tick()
    assert.deepEqual(sent.map((s) => s.text), ['喝水']) // task 被跳过，remind 正常触发
  } finally { teardown(stateDir) }
})

test('重叠保护：tick 未完成时不重入', async () => {
  const clock = makeClock(Date.UTC(2026, 7, 17, 0, 0))
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const { registry, stateDir, sent } = makeRegistry({ clock, send: async (c, chat, t) => { await gate; sent.push(t); return true } })
  try {
    registry.addTask({ channelId: 'w', chatId: 'c', time: '08:30', tz: TZ, prompt: '吃药' })
    clock.set(Date.UTC(2026, 7, 17, 0, 31))
    const first = registry.tick() // 卡在 send 的 gate 上
    const second = registry.tick() // 应直接返回（ticking=true）
    await Promise.resolve()
    release()
    await Promise.all([first, second])
    assert.equal(sent.length, 1)
  } finally { teardown(stateDir) }
})

test('一次性 at：创建 oneShot 任务，nextRunAt 精确', () => {
  const clock = makeClock(Date.UTC(2026, 7, 17, 0, 0))
  const { registry, stateDir } = makeRegistry({ clock })
  try {
    const r = registry.addTask({ channelId: 'w', chatId: 'c', at: '2026-09-18T09:00:00+08:00', prompt: '拿证件' })
    assert.equal(r.ok, true)
    if (r.ok) {
      assert.equal(r.task.oneShot, true)
      assert.equal(iso(r.task.nextRunAt), '2026-09-18T01:00:00.000Z')
    }
  } finally { teardown(stateDir) }
})

test('一次性 at：过去时刻被拒绝；本地时刻缺 tz 被拒绝', () => {
  const clock = makeClock(Date.UTC(2026, 7, 17, 0, 0))
  const { registry, stateDir } = makeRegistry({ clock })
  try {
    assert.equal(registry.addTask({ channelId: 'w', chatId: 'c', at: '2026-08-01T09:00:00+08:00', prompt: 'x' }).ok, false)
    assert.equal(registry.addTask({ channelId: 'w', chatId: 'c', at: '2026-09-18T09:00:00', prompt: 'x' }).ok, false)
    // 本地时刻 + tz 合法
    assert.equal(registry.addTask({ channelId: 'w', chatId: 'c', at: '2026-09-18T09:00:00', tz: TZ, prompt: 'x' }).ok, true)
  } finally { teardown(stateDir) }
})

test('一次性触发成功后任务被移除', async () => {
  const clock = makeClock(Date.UTC(2026, 7, 17, 0, 0))
  const { registry, stateDir, sent } = makeRegistry({ clock })
  try {
    const r = registry.addTask({ channelId: 'w', chatId: 'c', at: '2026-08-17T08:30:00+08:00', prompt: '洗澡' })
    assert.ok(r.ok)
    clock.set(Date.UTC(2026, 7, 17, 0, 31))
    await registry.tick()
    assert.deepEqual(sent.map((s) => s.text), ['洗澡'])
    assert.equal(registry.list().length, 0) // 已移除
    const persisted = JSON.parse(readFileSync(join(stateDir, 'cron.json'), 'utf8'))
    assert.equal(persisted.tasks.length, 0)
  } finally { teardown(stateDir) }
})

test('错过的一次性提醒（catchUp=false）加载时丢弃', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cron-test-'))
  try {
    const first = new CronRegistry({ stateDir, log: () => undefined, catchUp: false, send: async () => true, now: () => Date.UTC(2026, 7, 16, 0, 0) })
    first.addTask({ channelId: 'w', chatId: 'c', at: '2026-08-17T01:00:00+08:00', prompt: '洗澡' }) // nextRunAt 08-17 00:00Z
    const again = new CronRegistry({ stateDir, log: () => undefined, catchUp: false, send: async () => true, now: () => Date.UTC(2026, 7, 18, 0, 0) })
    assert.equal(again.list().length, 0) // 已过期且不补跑 → 丢弃
  } finally { teardown(stateDir) }
})
