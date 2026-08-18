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
import type { CronTask } from './types.js';
export interface CronRegistryOptions {
    /** 状态落盘目录。 */
    stateDir: string;
    log: (line: string) => void;
    /** 发送提醒到目标聊天；返回是否送达成功。 */
    send: (channelId: string, chatId: string, text: string) => Promise<boolean>;
    /** 执行 task 模式任务；缺省时 task 条目被跳过并记日志（预留）。 */
    runTask?: (task: CronTask) => Promise<void>;
    /** 错过触发时刻后是否补跑最近一次（默认 false：前跳跳过）。 */
    catchUp: boolean;
    /** 时钟注入（测试用）；缺省 Date.now。 */
    now?: () => number;
}
export interface AddCronInput {
    channelId: string;
    chatId: string;
    /** 周期提醒：本地时刻 "HH:MM"；与 at 二选一。 */
    time?: string;
    /** 一次性提醒：ISO 8601 绝对时刻（带时区偏移，或本地时刻配合 tz）；与 time 二选一。 */
    at?: string;
    /** 星期 1=周一 … 7=周日；缺省每天。 */
    days?: number[];
    /** IANA 时区；缺省进程默认。 */
    tz?: string;
    mode?: 'remind' | 'task';
    prompt: string;
    workspace?: string;
}
export type AddCronResult = {
    ok: true;
    task: CronTask;
} | {
    ok: false;
    error: string;
};
export declare class CronRegistry {
    private readonly options;
    private readonly file;
    private readonly tasks;
    private ticking;
    private disposed;
    private seq;
    constructor(options: CronRegistryOptions);
    private load;
    private save;
    private now;
    /** 添加任务：at（一次性）与 time（周期）二选一，校验合法性并预计算 nextRunAt。 */
    addTask(input: AddCronInput): AddCronResult;
    /** 全部任务（按创建时间排序）。 */
    list(): CronTask[];
    /** 删除任务；不存在返回 false。 */
    remove(id: string): boolean;
    /** 启用/停用任务；不存在返回 false。 */
    setEnabled(id: string, enabled: boolean): boolean;
    /** 扫描并触发到期任务（由外部定时器驱动，重叠保护在内部）。 */
    tick(): Promise<void>;
    private runRemind;
    private runTaskEntry;
    /** 触发后推进 nextRunAt；错过且不补跑时直接从当前时刻前跳。 */
    private advance;
    dispose(): void;
}
//# sourceMappingURL=cron.d.ts.map