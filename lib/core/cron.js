/**
 * 聊天级定时任务注册表（im_cron）：绑定 chatId 而非 sessionId，
 * 因此与 /new 轮换、会话死活无关——提醒的是「人」，不是「会话」。
 *
 * - 持久化：$DSH_HOME/dsh-im-gateway/cron.json（与 channels.json 同范式）
 * - nextRunAt 是派生投影：添加/触发后用 cron-time 纯函数重算，tick 只读表
 * - 错过策略：catchUp=false 时启动/触发后前跳（跳过错过）；true 时补跑最近一次
 * - 防重入：running 标志 + tick 重叠保护
 * @module dsh-im-gateway/core/cron
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nextOccurrence, parseAbsoluteAt, parseTimeOfDay } from './cron-time.js';
const VALID_DAYS = new Set([1, 2, 3, 4, 5, 6, 7]);
export class CronRegistry {
    options;
    file;
    tasks = new Map();
    ticking = false;
    disposed = false;
    seq = 0;
    constructor(options) {
        this.options = options;
        this.file = join(options.stateDir, 'cron.json');
        this.load();
    }
    // ── 持久化 ──────────────────────────────────────────────
    load() {
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(this.file, 'utf8'));
        }
        catch {
            return; // 文件缺失或损坏：从空表开始（不拖垮网关）
        }
        const now = this.now();
        for (const raw of parsed.tasks ?? []) {
            if (!raw || typeof raw.id !== 'string' || typeof raw.channelId !== 'string')
                continue;
            const task = { ...raw };
            // 启动时修正派生的 nextRunAt：过期且不补跑 → 前跳；过期且补跑 → 保留（下次 tick 触发最近一次）
            if (task.enabled && typeof task.nextRunAt === 'number' && task.nextRunAt <= now && !this.options.catchUp) {
                if (task.oneShot) {
                    // 一次性提醒已错过且不补跑：直接丢弃（没有"下一次"）
                    this.options.log(`[cron] ${task.id} 一次性提醒已错过（catchUp=false），丢弃`);
                    continue;
                }
                const next = nextOccurrence({ time: task.time, days: task.days ?? [], tz: task.tz }, now);
                if (next !== undefined)
                    task.nextRunAt = next;
            }
            this.tasks.set(task.id, task);
        }
    }
    save() {
        try {
            mkdirSync(this.options.stateDir, { recursive: true });
            writeFileSync(this.file, JSON.stringify({ tasks: [...this.tasks.values()] }, null, 2));
        }
        catch (err) {
            this.options.log(`[cron] 状态落盘失败: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    now() {
        return this.options.now?.() ?? Date.now();
    }
    // ── 任务管理（工具/API 调用）────────────────────────────
    /** 添加任务：at（一次性）与 time（周期）二选一，校验合法性并预计算 nextRunAt。 */
    addTask(input) {
        if (input.prompt.trim() === '')
            return { ok: false, error: '提醒内容不能为空' };
        const mode = input.mode === 'task' ? 'task' : 'remind';
        const now = this.now();
        // 一次性（at）：绝对时刻 → nextRunAt；触发成功后移除
        if (input.at !== undefined && input.at !== '') {
            const atEpoch = parseAbsoluteAt(input.at, input.tz);
            if (atEpoch === undefined)
                return { ok: false, error: `无效的 at 时刻：${input.at}（需带时区偏移如 2026-09-18T09:00:00+08:00，或本地时刻配合 tz）` };
            if (atEpoch <= now)
                return { ok: false, error: 'at 必须晚于当前时间' };
            this.seq += 1;
            const task = {
                id: `cron:${input.channelId}:${input.chatId}:${now}:${this.seq}`,
                channelId: input.channelId,
                chatId: input.chatId,
                time: '00:00',
                days: [],
                ...(input.tz ? { tz: input.tz } : {}),
                mode,
                prompt: input.prompt.trim(),
                ...(input.workspace ? { workspace: input.workspace } : {}),
                enabled: true,
                oneShot: true,
                nextRunAt: atEpoch,
                createdAt: now,
            };
            this.tasks.set(task.id, task);
            this.save();
            this.options.log(`[cron] 已添加一次性 ${mode} 任务 ${task.id}：${input.at} → ${input.channelId}:${input.chatId}`);
            return { ok: true, task };
        }
        // 周期（time+days）
        if (input.time === undefined || parseTimeOfDay(input.time) === undefined) {
            return { ok: false, error: `需提供 time（"HH:MM" 周期）或 at（一次性时刻），当前 time=${input.time ?? '（空）'}` };
        }
        const days = (input.days ?? []).filter((d) => VALID_DAYS.has(d));
        const next = nextOccurrence({ time: input.time, days, tz: input.tz }, now);
        if (next === undefined)
            return { ok: false, error: `无法计算下一次触发时刻（time=${input.time}, days=[${days.join(',')}], tz=${input.tz ?? '默认'}）` };
        this.seq += 1;
        const task = {
            id: `cron:${input.channelId}:${input.chatId}:${now}:${this.seq}`,
            channelId: input.channelId,
            chatId: input.chatId,
            time: input.time,
            days,
            ...(input.tz ? { tz: input.tz } : {}),
            mode,
            prompt: input.prompt.trim(),
            ...(input.workspace ? { workspace: input.workspace } : {}),
            enabled: true,
            nextRunAt: next,
            createdAt: now,
        };
        this.tasks.set(task.id, task);
        this.save();
        this.options.log(`[cron] 已添加 ${mode} 任务 ${task.id}：${input.time} ${days.length ? '星期' + days.join(',') : '每天'} → ${input.channelId}:${input.chatId}`);
        return { ok: true, task };
    }
    /** 全部任务（按创建时间排序）。 */
    list() {
        return [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt);
    }
    /** 删除任务；不存在返回 false。 */
    remove(id) {
        const existed = this.tasks.delete(id);
        if (existed)
            this.save();
        return existed;
    }
    /** 启用/停用任务；不存在返回 false。 */
    setEnabled(id, enabled) {
        const task = this.tasks.get(id);
        if (!task)
            return false;
        task.enabled = enabled;
        if (enabled && !task.oneShot) {
            const next = nextOccurrence({ time: task.time, days: task.days ?? [], tz: task.tz }, this.now());
            if (next !== undefined)
                task.nextRunAt = next;
        }
        this.save();
        return true;
    }
    // ── 触发 ────────────────────────────────────────────────
    /** 扫描并触发到期任务（由外部定时器驱动，重叠保护在内部）。 */
    async tick() {
        if (this.disposed || this.ticking)
            return;
        this.ticking = true;
        try {
            const now = this.now();
            for (const task of this.list()) {
                if (!task.enabled || task.running || task.nextRunAt > now)
                    continue;
                if (task.mode === 'task') {
                    if (!this.options.runTask) {
                        this.options.log(`[cron] ${task.id} 为 task 模式，尚未实现，跳过`);
                        task.running = true;
                        task.lastRunAt = now;
                        task.nextRunAt = this.advance(task, now);
                        task.running = false;
                        this.save();
                        continue;
                    }
                    await this.runTaskEntry(task, now);
                    continue;
                }
                await this.runRemind(task, now);
            }
        }
        finally {
            this.ticking = false;
        }
    }
    async runRemind(task, now) {
        task.running = true;
        try {
            const ok = await this.options.send(task.channelId, task.chatId, task.prompt);
            if (!ok) {
                // 送达失败：保持 nextRunAt 不变，下个 tick 重试
                this.options.log(`[cron] ${task.id} 发送失败（渠道不可达？），下轮重试`);
                return;
            }
            task.lastRunAt = now;
            if (task.oneShot) {
                this.tasks.delete(task.id);
                this.options.log(`[cron] ${task.id} 一次性提醒已触发并移除`);
            }
            else {
                task.nextRunAt = this.advance(task, now);
            }
            this.options.log(`[cron] ${task.id} 已提醒 ${task.channelId}:${task.chatId}`);
        }
        finally {
            task.running = false;
            this.save();
        }
    }
    async runTaskEntry(task, now) {
        task.running = true;
        try {
            await this.options.runTask(task);
            task.lastRunAt = now;
            task.nextRunAt = this.advance(task, now);
        }
        finally {
            task.running = false;
            this.save();
        }
    }
    /** 触发后推进 nextRunAt；错过且不补跑时直接从当前时刻前跳。 */
    advance(task, now) {
        const next = nextOccurrence({ time: task.time, days: task.days ?? [], tz: task.tz }, now);
        if (next === undefined)
            return task.nextRunAt; // 计划不可达（理论不会发生）：保留现值
        if (next <= now) {
            // 触发被延迟跨过了下一个时刻：补跑则立刻再触发（保留），否则前跳到未来
            return this.options.catchUp ? next : (nextOccurrence({ time: task.time, days: task.days ?? [], tz: task.tz }, now) ?? next);
        }
        return next;
    }
    dispose() {
        this.disposed = true;
    }
}
//# sourceMappingURL=cron.js.map