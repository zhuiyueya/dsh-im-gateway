/**
 * dsh-im-gateway 核心类型：统一 IM 渠道契约。
 *
 * 每个渠道（Telegram / Discord / 飞书 / 微信 / QQ …）实现 {@link ChannelAdapter}，
 * 由 {@link ImGateway} 统一负责：会话路由、白名单、命令、审批桥、分片投递。
 * @module dsh-im-gateway/core/types
 */

/** 媒体附件：渠道层负责下载/解密/转码，网关负责桥接给 agent。 */
export interface ImMedia {
  /** 图片（解码字节或已落盘路径）｜语音转文字｜文件｜视频。 */
  kind: 'image' | 'voice-text' | 'file' | 'video'
  /** 图片：解码后的字节（网关走 ctx.attachments.saveImage → image block）。 */
  data?: Uint8Array
  mediaType?: string
  name?: string
  /** 语音转文字内容（服务端提供时优先于文件）。 */
  text?: string
  /** 文件/视频/已落盘的图片：本地路径。 */
  path?: string
}

/** 统一入站消息：渠道层把各自的消息归一成这个形状交给网关。 */
export interface ImMessage {
  /** 渠道内唯一的会话标识（私聊 id / 群 id / 话题 id，字符串化）。 */
  chatId: string
  /** 发送者 id（字符串化），白名单与审计用；群消息为发言者本人。 */
  userId?: string
  /** 发送者显示名（可选，用于日志）。 */
  username?: string
  /** 消息文本（文本类消息；纯媒体消息可为空）。 */
  text: string
  /** 渠道特定上下文，回复时原样回传（如 iLink context_token）。 */
  context?: Record<string, unknown>
  /** 媒体附件（图片/语音转文字/文件/视频）。 */
  media?: ImMedia[]
}

/** 渠道发送选项。 */
export interface SendOptions {
  /** 打字指示等状态动作（渠道不支持时忽略）。 */
  action?: 'typing'
}

/** 渠道适配器契约：一个渠道 = 一个 adapter。 */
export interface ChannelAdapter {
  /** 渠道 id（小写连字符，如 `telegram`、`feishu`）。 */
  readonly id: string
  /** 渠道展示名（如 `Telegram`）。 */
  readonly label: string
  /** 单条消息长度上限（字符），网关按此分片。 */
  readonly maxMessageLength: number
  /** 启动（建立连接 / 开始轮询 / 扫码登录）。重复调用应幂等。 */
  start(): void | Promise<void>
  /** 停止并释放资源。重复调用应幂等。 */
  stop(): void | Promise<void>
  /** 发送文本到指定 chat（网关已按 maxMessageLength 分片，每片调用一次）。 */
  send(chatId: string, text: string, options?: SendOptions): Promise<void>
  /** 打字指示（可选）。 */
  sendAction?(chatId: string, action: 'typing'): Promise<void>
  /** 发送媒体文件（图片/视频/文档），caption 可选；渠道不支持时抛错。 */
  sendMedia?(chatId: string, filePath: string, caption?: string): Promise<void>
  /** 登录二维码 URL（扫码类渠道；未在扫码/无二维码时返回 undefined）。 */
  loginUrl?(): string | undefined
  /**
   * 渠道本地授权判定（如微信扫码用户自动授权）：
   * true=该用户已被渠道内部授权（放行）；false=渠道明确拒绝；undefined=由网关全局白名单决定。
   */
  authorizes?(userId: string): boolean | undefined
  /** 注册入站消息处理器（网关在 start 前调用一次）。 */
  setMessageHandler(handler: (msg: ImMessage) => void | Promise<void>): void
  /** 当前状态摘要（用于 `/status` 命令），如登录态/扫码链接。 */
  status?(): string
}

/** 网关对渠道的运行时句柄。 */
export interface ChannelRuntime {
  readonly channel: ChannelAdapter
  /** 是否已完成登录/就绪（未就绪时入站消息仍会缓存并转发）。 */
  ready: boolean
  /** 渠道当前状态文本（登录/轮询/错误）。 */
  statusText: string
}

/** 网关配置（schema 在 index.ts 中声明，此处为纯类型）。 */
export interface ImGatewayConfig {
  /** 每个渠道的启用开关与凭据；未配置的渠道保持关闭。 */
  channels: {
    telegram?: ChannelConfig & { token?: string }
    discord?: ChannelConfig & { token?: string }
    slack?: ChannelConfig & { token?: string; appToken?: string }
    feishu?: ChannelConfig & { appId?: string; appSecret?: string }
    wechat?: ChannelConfig
    qqbot?: ChannelConfig & { appId?: string; appSecret?: string }
    whatsapp?: ChannelConfig
    signal?: ChannelConfig & { cli?: string; phone?: string }
    msteams?: ChannelConfig & { appId?: string; appPassword?: string }
    line?: ChannelConfig & { channelSecret?: string; channelToken?: string }
    matrix?: ChannelConfig & { homeserver?: string; userId?: string; accessToken?: string }
    mattermost?: ChannelConfig & { serverUrl?: string; token?: string }
    googlechat?: ChannelConfig & { webhookUrl?: string }
    irc?: ChannelConfig & { server?: string; nick?: string; password?: string }
    twitch?: ChannelConfig & { channel?: string; token?: string }
    nostr?: ChannelConfig & { relays?: string[]; privateKey?: string }
    nextcloud?: ChannelConfig & { serverUrl?: string; user?: string; password?: string }
    synology?: ChannelConfig & { webhookUrl?: string }
    tlon?: ChannelConfig
    zalo?: ChannelConfig & { accessToken?: string }
    yuanbao?: ChannelConfig
    imessage?: ChannelConfig & { imsgPath?: string }
    voice?: ChannelConfig
  }
  /** 会话模式：per-chat（每聊天一个 agent 会话，默认）| bound（绑定现有会话）。 */
  sessionMode: 'per-chat' | 'bound'
  /** agent 工作目录。 */
  cwd: string
  /** agent provider（默认跟随 dsh agent-default-model）。 */
  provider: string
  /** agent 模型（默认跟随 dsh agent-default-model）。 */
  model: string
  /** 创建会话使用的 agent preset（默认 standard；必须挂 preset 才有核心工具）。 */
  agentPreset: string
  /** 全局放行所有用户（仅开发）。 */
  allowAllUsers: boolean
  /** 全局白名单：{ channelId: string[] } 或扁平数组（匹配任意渠道 userId）。 */
  allowedUserIds: Record<string, string[]>
  /** 手机多段输入合并窗口（秒）。 */
  mergeTimeoutSecs: number
  /** 合并缓冲达到该字符数先回执「收到，处理中」。 */
  longInputAckChars: number
  /** 审批超时（秒），超时转回本机批准体系。 */
  approvalTimeoutSecs: number
  /** 交互式提问在 IM 侧的回答窗口（秒）；超时后仍可在网页回答。 */
  questionTimeoutSecs: number
  /** 每轮结束是否推送摘要。 */
  summaryOnTurnEnd: boolean
  /** im_cron 定时器 tick 间隔（秒）。 */
  cronTickIntervalSecs: number
  /** im_cron 同时执行的 task 任务数上限（remind 不受限）。 */
  cronMaxConcurrent: number
  /** 网关错过触发时刻后是否补跑最近一次（默认 false：跳过）。 */
  cronCatchUp: boolean
  /** 状态/登录文件的落盘目录（默认 $DSH_HOME/dsh-im-gateway）。 */
  stateDir: string
}

/** 渠道通用配置（每个渠道在 enabled 时才会被启动）。 */
export interface ChannelConfig {
  enabled?: boolean
}

/** 聊天级定时任务（im_cron）：绑定 chatId 而非 sessionId，与会话轮换无关。 */
export interface CronTask {
  /** 稳定 id，永不复用。 */
  id: string
  channelId: string
  chatId: string
  /** 本地时刻 "HH:MM"。 */
  time: string
  /** 星期 1=周一 … 7=周日；空数组=每天。 */
  days: number[]
  /** IANA 时区；缺省用进程默认时区。 */
  tz?: string
  /** remind=到点直推文案；task=一次性 agent 会话执行（预留）。 */
  mode: 'remind' | 'task'
  /** remind 模式的提醒文案 / task 模式的任务描述。 */
  prompt: string
  /** task 模式的工作目录（缺省用 chat 偏好/全局 cwd）。 */
  workspace?: string
  enabled: boolean
  /** 预计算的下一触发时刻（UTC epoch ms）。 */
  nextRunAt: number
  /** 一次性提醒（at 创建）：触发成功后任务即被移除。 */
  oneShot?: boolean
  lastRunAt?: number
  /** 运行中标志（防重入）。 */
  running?: boolean
  createdAt: number
}
