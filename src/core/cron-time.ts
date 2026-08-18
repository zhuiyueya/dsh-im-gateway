/**
 * 定时时间计算（纯函数）：把「本地时间 + 星期 + IANA 时区」换算成下一个触发时刻。
 *
 * 与 dsh-schedule 同一纪律：日历计算确定且纯，生产用平台墙钟、测试注入样本；
 * 夏令时（DST）间隙（本地墙钟不存在）跳过该候选日，重叠（重复的小时）取较早的瞬时。
 * @module dsh-im-gateway/core/cron-time
 */

/** 定时计划：本地 24 小时制时刻 + 星期集合 + 时区。 */
export interface CronSchedule {
  /** 本地 24 小时制 "HH:MM"（允许 "H:MM"）。 */
  time: string
  /** 星期集合，1=周一 … 7=周日；空数组表示每天。 */
  days: number[]
  /** IANA 时区（如 Asia/Hong_Kong）；缺省用进程默认时区。 */
  tz?: string
}

/** 解析 "HH:MM" 为当天分钟数（0..1439）；非法返回 undefined。 */
export function parseTimeOfDay(time: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (!m) return undefined
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (hour > 23 || minute > 59) return undefined
  return hour * 60 + minute
}

/** 默认时区：进程 TZ 或系统时区；均缺失时回退 UTC。 */
function defaultTimeZone(): string {
  const env = process.env.TZ
  if (env) return env
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone
  return resolved || 'UTC'
}

function formatter(tz: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
}

interface WallClock {
  y: number
  mo: number
  d: number
  h: number
  mi: number
  /** 1=周一 … 7=周日。 */
  weekday: number
}

/** epochMs 在 tz 下的墙钟（y/mo/d/h/mi 均为该时区的本地日历字段）。 */
function wallClock(epochMs: number, tz: string): WallClock {
  const parts = formatter(tz).formatToParts(new Date(epochMs))
  const get = (type: string): number => {
    const p = parts.find((part) => part.type === type)
    return Number(p?.value ?? '0')
  }
  const y = get('year')
  const mo = get('month')
  const d = get('day')
  const h = get('hour')
  const mi = get('minute')
  // 星期是日历日期属性，与时刻无关：用该日期的 UTC 编码推 JS 星期再映射 1=周一。
  const jsDay = new Date(Date.UTC(y, mo - 1, d)).getUTCDay()
  const weekday = ((jsDay + 6) % 7) + 1
  return { y, mo, d, h, mi, weekday }
}

/** tz 下 epochMs 的 UTC 偏移（ms）：本地墙钟（视为 UTC）≈ epochMs + offset。 */
function offsetAt(epochMs: number, tz: string): number {
  const { y, mo, d, h, mi } = wallClock(epochMs, tz)
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, 0)
  return asUtc - epochMs
}

/**
 * 本地墙钟 → epoch（两遍法收敛 DST 偏移）。
 * 重叠（两次偏移不同）取较早的瞬时；间隙（换算回来对不上）返回 undefined。
 */
function zonedEpoch(y: number, mo: number, d: number, h: number, mi: number, tz: string, s = 0): number | undefined {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s)
  const off1 = offsetAt(guess, tz)
  const cand = guess - off1
  const off2 = offsetAt(cand, tz)
  if (off1 === off2) return cand
  const cand2 = guess - off2
  const chosen = Math.min(cand, cand2)
  const back = wallClock(chosen, tz)
  if (back.y !== y || back.mo !== mo || back.d !== d || back.h !== h || back.mi !== mi) return undefined
  return chosen
}

/** 绝对时刻（ISO 8601 本地形式，无时区）的正则。 */
const LOCAL_AT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/

/**
 * 解析一次性提醒的绝对时刻：
 * - 带显式时区偏移（Z 或 ±HH:MM）→ 直接按偏移换算（如 2026-09-18T09:00:00+08:00）
 * - 无偏移的本地形式 → 必须配合 IANA tz 按该时区解释（DST 间隙返回 undefined）
 * 非法输入返回 undefined。
 */
export function parseAbsoluteAt(at: string, tz?: string): number | undefined {
  const trimmed = at.trim()
  const withOffset = Date.parse(trimmed)
  if (Number.isFinite(withOffset) && /Z|[+-]\d{2}:\d{2}$/.test(trimmed)) return withOffset
  const m = LOCAL_AT_RE.exec(trimmed)
  if (m && tz) {
    const y = Number(m[1])
    const mo = Number(m[2])
    const d = Number(m[3])
    const h = Number(m[4])
    const mi = Number(m[5])
    const s = Number(m[6] ?? 0)
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return undefined
    return zonedEpoch(y, mo, d, h, mi, tz, s)
  }
  return undefined
}

/**
 * 计算 schedule 在 fromEpochMs 之后（严格大于）的下一个触发时刻（UTC epoch ms）。
 * 无效计划或 366 天内无匹配返回 undefined；DST 间隙的候选日会被跳过。
 */
export function nextOccurrence(schedule: CronSchedule, fromEpochMs: number): number | undefined {
  const minutes = parseTimeOfDay(schedule.time)
  if (minutes === undefined) return undefined
  const tz = schedule.tz ?? defaultTimeZone()
  const days = [...new Set(schedule.days.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort((a, b) => a - b)
  const { y, mo, d } = wallClock(fromEpochMs, tz)
  const hour = Math.floor(minutes / 60)
  const minute = minutes % 60

  for (let offset = 0; offset <= 366; offset += 1) {
    const dateMs = Date.UTC(y, mo - 1, d + offset)
    const parts = new Date(dateMs)
    const yy = parts.getUTCFullYear()
    const mm = parts.getUTCMonth() + 1
    const dd = parts.getUTCDate()
    const wd = ((parts.getUTCDay() + 6) % 7) + 1
    if (days.length > 0 && !days.includes(wd)) continue
    const at = zonedEpoch(yy, mm, dd, hour, minute, tz)
    if (at === undefined) continue // DST 间隙：跳过该候选日
    if (at > fromEpochMs) return at
    // 当天目标时刻已过（含恰好相等）：继续下一个匹配日
  }
  return undefined
}
