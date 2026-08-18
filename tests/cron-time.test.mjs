import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextOccurrence, parseAbsoluteAt, parseTimeOfDay } from '../lib/core/cron-time.js'

const iso = (ms) => new Date(ms).toISOString()

test('parseTimeOfDay：合法与非法', () => {
  assert.equal(parseTimeOfDay('09:00'), 540)
  assert.equal(parseTimeOfDay('9:05'), 545)
  assert.equal(parseTimeOfDay('00:00'), 0)
  assert.equal(parseTimeOfDay('23:59'), 1439)
  assert.equal(parseTimeOfDay('24:00'), undefined)
  assert.equal(parseTimeOfDay('09:60'), undefined)
  assert.equal(parseTimeOfDay(''), undefined)
  assert.equal(parseTimeOfDay('9点'), undefined)
})

test('当天未来时刻：HK 08-17 00:00Z（本地 08:00）→ 09:00 本地 = 01:00Z', () => {
  assert.equal(
    iso(nextOccurrence({ time: '09:00', days: [], tz: 'Asia/Hong_Kong' }, Date.UTC(2026, 7, 17, 0, 0))),
    '2026-08-17T01:00:00.000Z',
  )
})

test('当天已过：HK 08-17 02:00Z（本地 10:00）→ 次日 09:00 本地', () => {
  assert.equal(
    iso(nextOccurrence({ time: '09:00', days: [], tz: 'Asia/Hong_Kong' }, Date.UTC(2026, 7, 17, 2, 0))),
    '2026-08-18T01:00:00.000Z',
  )
})

test('恰好等于目标时刻：返回下一个（严格大于）', () => {
  assert.equal(
    iso(nextOccurrence({ time: '09:00', days: [], tz: 'Asia/Hong_Kong' }, Date.UTC(2026, 7, 17, 1, 0))),
    '2026-08-18T01:00:00.000Z',
  )
})

test('星期过滤：从周六起，周一~五 → 下周一', () => {
  assert.equal(
    iso(nextOccurrence({ time: '09:00', days: [1, 2, 3, 4, 5], tz: 'Asia/Hong_Kong' }, Date.UTC(2026, 7, 15, 0, 0))),
    '2026-08-17T01:00:00.000Z',
  )
})

test('UTC 时区：09:00 UTC 即 09:00Z', () => {
  assert.equal(
    iso(nextOccurrence({ time: '09:00', days: [], tz: 'UTC' }, Date.UTC(2026, 7, 17, 0, 0))),
    '2026-08-17T09:00:00.000Z',
  )
})

test('DST 间隙：NY 2026-03-08 02:30 不存在 → 跳过到 03-09', () => {
  // from 已过 03-07 02:30 EST（07:30Z），下一触发应跳过 03-08 的间隙
  assert.equal(
    iso(nextOccurrence({ time: '02:30', days: [], tz: 'America/New_York' }, Date.UTC(2026, 2, 7, 8, 0))),
    '2026-03-09T06:30:00.000Z',
  )
})

test('DST 重叠：NY 2026-11-01 01:30 出现两次 → 取较早瞬时 05:30Z', () => {
  assert.equal(
    iso(nextOccurrence({ time: '01:30', days: [], tz: 'America/New_York' }, Date.UTC(2026, 9, 31, 6, 0))),
    '2026-11-01T05:30:00.000Z',
  )
})

test('无效计划：非法 time 返回 undefined', () => {
  assert.equal(nextOccurrence({ time: 'bad', days: [] }, Date.UTC(2026, 7, 17)), undefined)
  assert.equal(nextOccurrence({ time: '25:00', days: [] }, Date.UTC(2026, 7, 17)), undefined)
})

test('无匹配星期：7 天内没有允许日仍可越过', () => {
  // days 只有周日，from 是周一 → 下周日
  assert.equal(
    iso(nextOccurrence({ time: '09:00', days: [7], tz: 'Asia/Hong_Kong' }, Date.UTC(2026, 7, 17, 0, 0))),
    '2026-08-23T01:00:00.000Z',
  )
})

test('parseAbsoluteAt：带偏移的 ISO 时刻', () => {
  assert.equal(parseAbsoluteAt('2026-09-18T09:00:00+08:00'), Date.parse('2026-09-18T09:00:00+08:00'))
  assert.equal(parseAbsoluteAt('2026-09-18T01:00:00Z'), Date.parse('2026-09-18T01:00:00Z'))
})

test('parseAbsoluteAt：本地时刻配合 tz 按 IANA 解释', () => {
  assert.equal(parseAbsoluteAt('2026-09-18T09:00:00', 'Asia/Hong_Kong'), Date.UTC(2026, 8, 18, 1, 0, 0))
  assert.equal(parseAbsoluteAt('2026-09-18T09:00', 'Asia/Hong_Kong'), Date.UTC(2026, 8, 18, 1, 0, 0))
})

test('parseAbsoluteAt：非法输入', () => {
  assert.equal(parseAbsoluteAt('2026-09-18T09:00:00'), undefined) // 本地形式缺 tz
  assert.equal(parseAbsoluteAt('2026-13-40T09:00:00', 'Asia/Hong_Kong'), undefined) // 月份非法
  assert.equal(parseAbsoluteAt('随便写', 'Asia/Hong_Kong'), undefined)
  assert.equal(parseAbsoluteAt(''), undefined)
})
