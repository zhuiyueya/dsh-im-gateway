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
    time: string;
    /** 星期集合，1=周一 … 7=周日；空数组表示每天。 */
    days: number[];
    /** IANA 时区（如 Asia/Hong_Kong）；缺省用进程默认时区。 */
    tz?: string;
}
/** 解析 "HH:MM" 为当天分钟数（0..1439）；非法返回 undefined。 */
export declare function parseTimeOfDay(time: string): number | undefined;
/**
 * 解析一次性提醒的绝对时刻：
 * - 带显式时区偏移（Z 或 ±HH:MM）→ 直接按偏移换算（如 2026-09-18T09:00:00+08:00）
 * - 无偏移的本地形式 → 必须配合 IANA tz 按该时区解释（DST 间隙返回 undefined）
 * 非法输入返回 undefined。
 */
export declare function parseAbsoluteAt(at: string, tz?: string): number | undefined;
/**
 * 计算 schedule 在 fromEpochMs 之后（严格大于）的下一个触发时刻（UTC epoch ms）。
 * 无效计划或 366 天内无匹配返回 undefined；DST 间隙的候选日会被跳过。
 */
export declare function nextOccurrence(schedule: CronSchedule, fromEpochMs: number): number | undefined;
//# sourceMappingURL=cron-time.d.ts.map