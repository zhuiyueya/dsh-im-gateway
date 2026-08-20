import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ImGateway } from '../lib/core/gateway.js'

/** 极简 mock ctx：只实现 gateway 用到的表面。 */
function makeCtx() {
  const listeners = new Map()
  const agents = new Map()
  const sessions = new Map()
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {}, debug: () => {} }),
    on: (event, cb) => {
      const list = listeners.get(event) ?? []
      list.push(cb)
      listeners.set(event, list)
      return () => {
        const l = listeners.get(event) ?? []
        listeners.set(event, l.filter((f) => f !== cb))
      }
    },
    agents: {
      create: async (opts) => {
        const agent = {
          id: String(opts.sessionId),
          session: { id: opts.sessionId, header: { cwd: opts.meta?.cwd } },
          followup: () => {},
          inbox: {},
        }
        agent.followup = (msg) => {
          const record = { sessionId: String(opts.sessionId), msg }
          agents.set(String(opts.sessionId), { agent, record })
        }
        return { agent, dispose: async () => agents.delete(String(opts.sessionId)) }
      },
      get: (id) => agents.get(String(id))?.agent,
      resume: async (opts) => {
        const sid = String(opts.resumeSessionId)
        // 记录 resume 选项（测试断言 agentOptions 必须传递）
        ctx._resumeOpts = opts
        const agent = {
          id: sid,
          session: { id: opts.resumeSessionId, header: { cwd: '/resumed-cwd' } },
          followup: () => {},
          inbox: {},
        }
        agent.followup = (msg) => {
          const record = { sessionId: sid, msg }
          agents.set(sid, { agent, record })
        }
        return { agent, dispose: async () => agents.delete(sid) }
      },
    },
    sessionQuery: {
      listSessions: async () => [],
      readTitleSnapshots: async () => [],
    },
    userQuestions: {
      ask: (request) => new Promise((resolve, reject) => {
        ctx._questionRequest = request
        ctx._resolveQuestion = resolve
        request.signal?.addEventListener('abort', () => reject(new Error('web question aborted')), { once: true })
      }),
    },
    _listeners: listeners,
    _agents: agents,
  }
  // agentPresets：resume/create 的 setup 会调用 mount（mock 记录）
  ctx.agentPresets = {
    mount: async (agentCtx, presetId) => {
      ctx._mountedPresets = [...(ctx._mountedPresets ?? []), presetId]
    },
  }
  return ctx
}

/** mock 渠道：记录发送的消息。 */
function makeChannel(id = 'test') {
  const sent = []
  const channel = {
    id,
    label: 'Test',
    maxMessageLength: 100,
    handler: undefined,
    start: async () => {},
    stop: async () => {},
    send: async (chatId, text) => { sent.push({ chatId, text }) },
    setMessageHandler: (h) => { channel.handler = h },
    status: () => 'running',
  }
  return { channel, sent }
}

const baseConfig = {
  channels: {},
  sessionMode: 'per-chat',
  cwd: process.cwd(),
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  agentPreset: 'standard',
  allowAllUsers: true,
  allowedUserIds: {},
  mergeTimeoutSecs: 1,
  longInputAckChars: 180,
  approvalTimeoutSecs: 5,
  questionTimeoutSecs: 1,
  summaryOnTurnEnd: false,
  stateDir: '/tmp',
}

test('消息注入 per-chat 会话', async () => {
  const ctx = makeCtx()
  const gw = new ImGateway(ctx, { config: baseConfig, stateDir: '/tmp', log: () => {} })
  const { channel } = makeChannel()
  gw.register(channel)

  await channel.handler({ chatId: 'c1', userId: 'u1', text: '你好!!' })
  const keys = [...ctx._agents.keys()]
  assert.equal(keys.length, 1, '应创建 agent')
  const agent = ctx._agents.get(keys[0])
  assert.ok(agent.record.msg.content[0].text, '你好')
  // source 必须是 user：Web 端只把 user 来源渲染为用户气泡
  assert.equal(agent.record.msg.source.kind, 'user')

  gw.dispose()
})

test('命令 /status 不创建会话', async () => {
  const ctx = makeCtx()
  const gw = new ImGateway(ctx, { config: baseConfig, stateDir: '/tmp', log: () => {} })
  const { channel, sent } = makeChannel()
  gw.register(channel)

  await channel.handler({ chatId: 'c1', userId: 'u1', text: '/status' })
  assert.equal(ctx._agents.size, 0)
  assert.ok(sent[0].text.includes('会话模式'))

  gw.dispose()
})

test('重启后无内存会话时 /new 仍立即创建新会话', async () => {
  const ctx = makeCtx()
  const gw = new ImGateway(ctx, { config: baseConfig, stateDir: '/tmp', log: () => {} })
  const { channel, sent } = makeChannel()
  gw.register(channel)

  await channel.handler({ chatId: 'c1', userId: 'u1', text: '/new' })
  const created = sent.find((s) => s.text.includes('已开启全新会话'))
  assert.ok(created, '/new 应立即创建并返回新会话')
  const sessionId = created.text.match(/im:test:c1:\d+/)?.[0]
  assert.ok(sessionId, '回复应包含新会话 id')

  await channel.handler({ chatId: 'c1', userId: 'u1', text: '/status' })
  assert.ok(sent.some((s) => s.text.includes(`绑定会话：${sessionId}`)), '/status 应显示新绑定会话')

  gw.dispose()
})

test('未注入 workspaceRegistry 时 /new 仍正常工作', async () => {
  const ctx = makeCtx()
  Object.defineProperty(ctx, 'workspaceRegistry', {
    configurable: true,
    get() {
      throw new Error('cannot get property "workspaceRegistry" without inject')
    },
  })
  const gw = new ImGateway(ctx, { config: baseConfig, stateDir: '/tmp', log: () => {} })
  const { channel, sent } = makeChannel()
  gw.register(channel)

  await channel.handler({ chatId: 'c1', userId: 'u1', text: '/new' })
  assert.ok(sent.some((s) => s.text.includes('已开启全新会话')), '未注入 workspaceRegistry 也应回复 /new')

  gw.dispose()
})

test('白名单拦截非授权用户', async () => {
  const ctx = makeCtx()
  const cfg = { ...baseConfig, allowAllUsers: false, allowedUserIds: { test: ['u1'] } }
  const gw = new ImGateway(ctx, { config: cfg, stateDir: '/tmp', log: () => {} })
  const { channel, sent } = makeChannel()
  gw.register(channel)

  await channel.handler({ chatId: 'c1', userId: 'evil', text: '你好!!' })
  assert.equal(ctx._agents.size, 0)
  assert.ok(sent[0].text.includes('未授权'))

  await channel.handler({ chatId: 'c1', userId: 'u1', text: '你好!!' })
  assert.equal(ctx._agents.size, 1)

  gw.dispose()
})

test('渠道本地授权（微信扫码用户）优先于全局白名单', async () => {
  const ctx = makeCtx()
  // 全局白名单为空 + allowAllUsers=false（模拟用户没配全局白名单）
  const cfg = { ...baseConfig, allowAllUsers: false, allowedUserIds: {} }
  const gw = new ImGateway(ctx, { config: cfg, stateDir: '/tmp', log: () => {} })
  const { channel, sent } = makeChannel()
  // 微信语义：扫码用户 u1 被渠道授权，u2 被渠道拒绝
  channel.authorizes = (userId) => (userId === 'u1' ? true : userId === 'u2' ? false : undefined)
  gw.register(channel)

  // u1（渠道授权）→ 放行
  await channel.handler({ chatId: 'c1', userId: 'u1', text: '你好!!' })
  assert.equal(ctx._agents.size, 1, '渠道授权用户应放行')

  // u2（渠道拒绝）→ 拦截
  await channel.handler({ chatId: 'c2', userId: 'u2', text: '你好!!' })
  assert.equal(ctx._agents.size, 1, '渠道拒绝用户应拦截')
  assert.ok(sent.some((s) => s.text.includes('未授权')))

  // u3（渠道未表态）→ 走全局白名单 → 拦截
  await channel.handler({ chatId: 'c3', userId: 'u3', text: '你好!!' })
  assert.equal(ctx._agents.size, 1, '未授权用户应拦截')

  gw.dispose()
})

test('未授权用户触发 onUnauthorized 回调并收到引导文案', async () => {
  const ctx = makeCtx()
  const seen = []
  const cfg = { ...baseConfig, allowAllUsers: false, allowedUserIds: {} }
  const gw = new ImGateway(ctx, { config: cfg, stateDir: '/tmp', log: () => {} })
  gw.setUnauthorizedHandler((channelId, msg) => {
    seen.push({ channelId, userId: msg.userId, username: msg.username })
    return '⛔ 未授权：请先批准。'
  })
  const { channel, sent } = makeChannel()
  gw.register(channel)

  await channel.handler({ chatId: 'c1', userId: 'u-new', username: '小明', text: '你好!!' })
  assert.equal(seen.length, 1, '应登记待授权请求')
  assert.equal(seen[0].channelId, 'test')
  assert.equal(seen[0].userId, 'u-new')
  assert.equal(seen[0].username, '小明')
  assert.ok(sent.some((s) => s.text.includes('请先批准')), '应返回自定义引导文案')
  assert.equal(ctx._agents.size, 0, '未授权用户不应创建会话')

  gw.dispose()
})

test('addAuthorizedUser 后用户放行', async () => {
  const ctx = makeCtx()
  const cfg = { ...baseConfig, allowAllUsers: false, allowedUserIds: {} }
  const gw = new ImGateway(ctx, { config: cfg, stateDir: '/tmp', log: () => {} })
  const { channel } = makeChannel()
  gw.register(channel)

  // 先拦截
  await channel.handler({ chatId: 'c1', userId: 'u9', text: '你好!!' })
  assert.equal(ctx._agents.size, 0)

  // UI 批准后放行
  gw.addAuthorizedUser('test', 'u9')
  await channel.handler({ chatId: 'c1', userId: 'u9', text: '你好!!' })
  assert.equal(ctx._agents.size, 1)

  gw.dispose()
})

test('assistant/message 事件回发渠道', async () => {
  const ctx = makeCtx()
  const gw = new ImGateway(ctx, { config: baseConfig, stateDir: '/tmp', log: () => {} })
  const { channel, sent } = makeChannel()
  gw.register(channel)

  await channel.handler({ chatId: 'c1', userId: 'u1', text: 'hello!!' })
  const sessionId = [...ctx._agents.keys()][0]
  const session = { id: sessionId, events: [] }
  const event = {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '回复内容' }] } },
  }
  const cb = ctx._listeners.get('session/event')[0]
  cb(session, event)
  assert.ok(sent.some((s) => s.text === '回复内容'))

  gw.dispose()
})

test('媒体消息：图片走 attachments → image block 注入', async () => {
  const ctx = makeCtx()
  // mock attachments 服务
  ctx.attachments = {
    saveImage: async (input) => ({ attachmentId: 'att-1', mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1, name: input.name }),
  }
  const gw = new ImGateway(ctx, { config: baseConfig, stateDir: '/tmp', log: () => {} })
  const { channel } = makeChannel()
  gw.register(channel)

  await channel.handler({
    chatId: 'c1',
    userId: 'u1',
    text: '',
    media: [{ kind: 'image', path: 'fake.jpg', mediaType: 'image/jpeg', name: 'a.jpg' }],
  })
  // 文件不存在 → readFile 失败，降级为路径说明
  const keys = [...ctx._agents.keys()]
  assert.equal(keys.length, 1)
  const agent = ctx._agents.get(keys[0])
  const blocks = agent.record.msg.content
  assert.ok(blocks.some((b) => b.type === 'text' && b.text.includes('用户发来图片')), '应降级为文本说明')

  gw.dispose()
})

test('媒体消息：图片字节直传（attachments 可用）', async () => {
  const ctx = makeCtx()
  const saved = []
  ctx.attachments = {
    saveImage: async (input) => {
      saved.push(input)
      return { attachmentId: 'att-1', mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1, name: input.name }
    },
  }
  const gw = new ImGateway(ctx, { config: baseConfig, stateDir: '/tmp', log: () => {} })
  const { channel } = makeChannel()
  gw.register(channel)

  const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
  await channel.handler({
    chatId: 'c1',
    userId: 'u1',
    text: '看图',
    media: [{ kind: 'image', data: fakePng, mediaType: 'image/png', name: 'p.png' }],
  })
  const keys = [...ctx._agents.keys()]
  const agent = ctx._agents.get(keys[0])
  const blocks = agent.record.msg.content
  assert.ok(blocks.some((b) => b.type === 'image'), '应有 image block')
  assert.equal(saved.length, 1)
  assert.equal(saved[0].mediaType, 'image/png')

  gw.dispose()
})

test('媒体消息：文件/视频 → 路径说明注入', async () => {
  const ctx = makeCtx()
  const gw = new ImGateway(ctx, { config: baseConfig, stateDir: '/tmp', log: () => {} })
  const { channel } = makeChannel()
  gw.register(channel)

  await channel.handler({
    chatId: 'c1',
    userId: 'u1',
    text: '',
    media: [{ kind: 'file', path: '/tmp/report.pdf', name: 'report.pdf', mediaType: 'application/pdf' }],
  })
  const keys = [...ctx._agents.keys()]
  const agent = ctx._agents.get(keys[0])
  const blocks = agent.record.msg.content
  assert.ok(blocks.some((b) => b.type === 'text' && b.text.includes('/tmp/report.pdf')), '应注明文件路径')

  gw.dispose()
})

test('im_send_file 工具：把文件发给关联渠道', async () => {
  const ctx = makeCtx()
  const sentMedia = []
  const { channel } = makeChannel()
  channel.sendMedia = async (chatId, filePath, caption) => { sentMedia.push({ chatId, filePath, caption }) }
  const gw = new ImGateway(ctx, { config: baseConfig, stateDir: '/tmp', log: () => {} })
  gw.register(channel)

  // 建立会话
  await channel.handler({ chatId: 'c1', userId: 'u1', text: 'hello!!' })
  const sessionId = [...ctx._agents.keys()][0]

  const result = await gw.sendFileToChats('/tmp/a.png', '截图', undefined, sessionId)
  assert.equal(result.ok, true)
  assert.equal(sentMedia.length, 1)
  assert.equal(sentMedia[0].chatId, 'c1')
  assert.equal(sentMedia[0].filePath, '/tmp/a.png')
  assert.equal(sentMedia[0].caption, '截图')

  gw.dispose()
})

test('im_send_file 工具：无关联会话时报错', async () => {
  const ctx = makeCtx()
  const gw = new ImGateway(ctx, { config: baseConfig, stateDir: '/tmp', log: () => {} })
  const result = await gw.sendFileToChats('/tmp/a.png', undefined, undefined, 'no-such-session')
  assert.equal(result.ok, false)
  gw.dispose()
})

test('/workspace 切换工作区：后续新会话使用新 cwd', async () => {
  const { mkdirSync, rmSync } = await import('node:fs')
  mkdirSync('/tmp/imgw-ws', { recursive: true })
  const ctx = makeCtx()
  const saved = []
  const gw = new ImGateway(ctx, {
    config: baseConfig,
    stateDir: '/tmp',
    log: () => {},
    workspaceStore: {
      load: () => [],
      save: (entries) => { saved.push(entries) },
    },
  })
  const { channel, sent } = makeChannel()
  gw.register(channel)

  // 切换工作区
  await channel.handler({ chatId: 'c1', userId: 'u1', text: '/workspace /tmp/imgw-ws' })
  assert.ok(sent.some((s) => s.text.includes('/tmp/imgw-ws')), '应返回切换成功')
  assert.equal(saved.length, 1, '应持久化工作区偏好')
  assert.equal(saved[0][0][1], '/tmp/imgw-ws')

  // 新会话使用新工作区
  await channel.handler({ chatId: 'c1', userId: 'u1', text: 'hello!!' })
  const keys = [...ctx._agents.keys()]
  const agent = ctx._agents.get(keys[0])
  assert.equal(agent.agent.session.header.cwd, '/tmp/imgw-ws', '新会话应在新工作区')

  // /status 显示工作区
  await channel.handler({ chatId: 'c1', userId: 'u1', text: '/status' })
  assert.ok(sent.some((s) => s.text.includes('/tmp/imgw-ws')))

  gw.dispose()
  rmSync('/tmp/imgw-ws', { recursive: true, force: true })
})

test('新会话登记到宿主 workspace，Web 端不进入未分组', async () => {
  const ctx = makeCtx()
  const attached = []
  let created = false
  ctx.workspaceRegistry = {
    resolveByPath: async (path) => {
      assert.equal(path, baseConfig.cwd)
      return { attachSession: async (sessionId) => { attached.push(String(sessionId)) } }
    },
    create: async () => {
      created = true
      return { attachSession: async () => {} }
    },
  }
  const gw = new ImGateway(ctx, { config: baseConfig, stateDir: '/tmp', log: () => {} })
  const { channel } = makeChannel()
  gw.register(channel)

  await channel.handler({ chatId: 'c1', userId: 'u1', text: 'hello!!' })
  const sessionId = [...ctx._agents.keys()][0]
  assert.deepEqual(attached, [sessionId], '新会话应挂到已有 workspace')
  assert.equal(created, false, '已有 workspace 时不应重复创建')

  gw.dispose()
})

test('/workspace 不存在的目录报错', async () => {
  const ctx = makeCtx()
  const gw = new ImGateway(ctx, { config: baseConfig, stateDir: '/tmp', log: () => {} })
  const { channel, sent } = makeChannel()
  gw.register(channel)

  await channel.handler({ chatId: 'c1', userId: 'u1', text: '/workspace /nonexistent-dir-xyz-123' })
  assert.ok(sent.some((s) => s.text.includes('目录不存在')))

  gw.dispose()
})

test('/sessions 列出会话（mock sessionQuery）', async () => {
  const ctx = makeCtx()
  ctx.sessionQuery = {
    listSessions: async () => [
      { header: { id: 'session-a', createdAt: Date.now() - 60_000, cwd: '/ws1' }, live: true, persisted: true },
      { header: { id: 'session-b', createdAt: Date.now() - 3600_000, cwd: '/ws2' }, live: false, persisted: true },
    ],
    readTitleSnapshots: async () => [
      { sessionId: 'session-a', status: 'fulfilled', value: { session: {}, title: { title: '我的任务' } } },
      { sessionId: 'session-b', status: 'fulfilled', value: { session: {} } },
    ],
  }
  const gw = new ImGateway(ctx, { config: baseConfig, stateDir: '/tmp', log: () => {} })
  const { channel, sent } = makeChannel()
  gw.register(channel)

  // 默认 = 当前聊天工作区（baseConfig.cwd，mock 会话不在该工作区 → 空提示）
  await channel.handler({ chatId: 'c1', userId: 'u1', text: '/sessions' })
  const empty = sent.find((s) => s.text.includes('该工作区没有会话'))
  assert.ok(empty, '默认按当前工作区过滤')

  // all = 全部
  await channel.handler({ chatId: 'c1', userId: 'u1', text: '/sessions all' })
  const reply = sent.find((s) => s.text.includes('📋 全部会话'))
  assert.ok(reply, '应返回全部会话列表')
  assert.ok(reply.text.includes('session-a'), '应包含会话 id')
  assert.ok(reply.text.includes('我的任务'), '应包含标题')
  assert.ok(reply.text.includes('/ws1'), '应包含工作区')

  // 按工作区过滤
  await channel.handler({ chatId: 'c1', userId: 'u1', text: '/sessions /ws2' })
  const filtered = sent.find((s) => s.text.includes('📋 会话（当前工作区 /ws2）'))
  assert.ok(filtered, '应按工作区过滤')
  assert.ok(filtered.text.includes('session-b'), '应包含该工作区会话')
  assert.ok(!filtered.text.includes('session-a'), '不应包含其他工作区会话')

  gw.dispose()
})

test('/continue 继续已有会话（resume）', async () => {
  const ctx = makeCtx()
  const gw = new ImGateway(ctx, { config: baseConfig, stateDir: '/tmp', log: () => {} })
  const { channel, sent } = makeChannel()
  gw.register(channel)

  await channel.handler({ chatId: 'c1', userId: 'u1', text: '/continue session-abc-123' })
  const reply = sent.find((s) => s.text.includes('已继续会话'))
  assert.ok(reply, '应返回继续成功')
  assert.ok(reply.text.includes('session-abc-123'))
  // resume 必须带 agentOptions（provider/model），否则 prompt 组装缺 {{model}}
  assert.ok(ctx._resumeOpts?.agentOptions, 'resume 应传 agentOptions')
  assert.equal(ctx._resumeOpts.agentOptions.provider, 'deepseek-official')
  assert.equal(ctx._resumeOpts.agentOptions.model, 'deepseek-v4-flash')

  // 之后的消息进入被继续的会话
  await channel.handler({ chatId: 'c1', userId: 'u1', text: '继续工作!!' })
  const agent = ctx._agents.get('session-abc-123')
  assert.ok(agent, '应使用 resumed 会话')
  assert.equal(agent.record.msg.content[0].text, '继续工作')

  gw.dispose()
})

test('/continue 复用到 live agent（Web 正打开的会话）时消息仍能注入', async () => {
  const ctx = makeCtx()
  const gw = new ImGateway(ctx, { config: baseConfig, stateDir: '/tmp', log: () => {} })
  const { channel, sent } = makeChannel()
  gw.register(channel)

  // 模拟：Web 已持有该会话的 live agent
  const liveAgent = {
    id: 'session-live-1',
    session: { id: 'session-live-1', header: { cwd: '/ws-live' } },
    followup: () => {},
    inbox: {},
  }
  const records = []
  liveAgent.followup = (msg) => { records.push(msg) }
  ctx.agents.get = (id) => (String(id) === 'session-live-1' ? liveAgent : undefined)

  // continue 应复用（不 resume）
  await channel.handler({ chatId: 'c1', userId: 'u1', text: '/continue session-live-1' })
  const reply = sent.find((s) => s.text.includes('已继续会话'))
  assert.ok(reply, '应返回继续成功')
  assert.equal(ctx._resumeOpts, undefined, 'live agent 存在时不应 resume')

  // 消息必须注入到 live agent
  await channel.handler({ chatId: 'c1', userId: 'u1', text: '还记得我们之前聊了什么吗!!' })
  assert.equal(records.length, 1, '消息应注入 live agent')
  assert.equal(records[0].content[0].text, '还记得我们之前聊了什么吗')

  gw.dispose()
})

test('approval/request 推送到渠道并远程批准', async () => {
  const ctx = makeCtx()
  const gw = new ImGateway(ctx, { config: baseConfig, stateDir: '/tmp', log: () => {} })
  const { channel, sent } = makeChannel()
  gw.register(channel)

  await channel.handler({ chatId: 'c1', userId: 'u1', text: '请执行任务!!' })
  const sessionId = [...ctx._agents.keys()][0]

  const cb = ctx._listeners.get('approval/request')[0]
  let nextCalled = false
  const p = cb(
    { agent: { session: { id: sessionId } }, toolName: 'tool-bash', reason: '执行命令' },
    async () => { nextCalled = true; return 'unavailable' },
  )
  // 等待推送
  await new Promise((r) => setTimeout(r, 30))
  assert.ok(sent.some((s) => s.text.includes('批准请求')))
  // 用户在 IM 回复「批准」
  await channel.handler({ chatId: 'c1', userId: 'u1', text: '批准' })
  const outcome = await p
  assert.equal(outcome, 'allowed-once')
  assert.equal(nextCalled, false)

  gw.dispose()
})

test('approval/request 无关联会话时委托 next', async () => {
  const ctx = makeCtx()
  const gw = new ImGateway(ctx, { config: baseConfig, stateDir: '/tmp', log: () => {} })
  const { channel } = makeChannel()
  gw.register(channel)

  const cb = ctx._listeners.get('approval/request')[0]
  let nextCalled = false
  const outcome = await cb(
    { agent: { session: { id: 'no-such-session' } }, toolName: 'x' },
    async () => { nextCalled = true; return 'unavailable' },
  )
  assert.equal(outcome, 'unavailable')
  assert.equal(nextCalled, true)

  gw.dispose()
})

test('多端共享会话：两个 chat 继续同一会话，上下文互见、输出双向广播', async () => {
  const ctx = makeCtx()
  const gw = new ImGateway(ctx, { config: baseConfig, stateDir: '/tmp', log: () => {} })
  const { channel: wechat, sent: wechatSent } = makeChannel('wechat')
  const { channel: feishu, sent: feishuSent } = makeChannel('feishu')
  gw.register(wechat)
  gw.register(feishu)

  // 微信创建会话
  await wechat.handler({ chatId: 'wx-1', userId: 'u1', text: '第一轮：微信的消息!!' })
  const sessionId = [...ctx._agents.keys()][0]

  // 飞书 continue 同一会话
  await feishu.handler({ chatId: 'fs-1', userId: 'u2', text: `/continue ${sessionId}` })
  assert.ok(feishuSent.some((s) => s.text.includes('已继续会话')), '飞书应继续同一会话')

  // 飞书发消息 → 进入同一会话（与微信消息同 inbox 队列）
  await feishu.handler({ chatId: 'fs-1', userId: 'u2', text: '第二轮：飞书的消息!!' })
  const agent = ctx._agents.get(sessionId)
  const texts = ctx._agents.get(sessionId).record ? [ctx._agents.get(sessionId).record.msg.content[0].text] : []
  // 两条消息都在会话里（followup 被调用两次）
  assert.ok(agent, '会话存在')
  assert.equal(agent.record.msg.content[0].text, '第二轮：飞书的消息', '飞书消息注入同一会话')

  // 出站广播：assistant 输出应同时发到微信和飞书两个 chat
  const session = { id: sessionId, events: [] }
  const event = { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '广播回复' }] } } }
  const cb = ctx._listeners.get('session/event')[0]
  cb(session, event)
  assert.ok(wechatSent.some((s) => s.text === '广播回复'), '微信应收到回复')
  assert.ok(feishuSent.some((s) => s.text === '广播回复'), '飞书应收到回复')

  gw.dispose()
})

test('重启后自动恢复上次会话（chatSessionStore）', async () => {
  const ctx = makeCtx()
  const saved = []
  const gw = new ImGateway(ctx, {
    config: baseConfig,
    stateDir: '/tmp',
    log: () => {},
    chatSessionStore: {
      load: () => ({ 'test:c1': 'session-prev-1' }),
      save: (sessions) => { saved.push(sessions) },
    },
  })
  const { channel, sent } = makeChannel()
  gw.register(channel)

  // 模拟重启：chatSessionStore 里有上次绑定的会话 → 首次消息应恢复而不是新建
  await channel.handler({ chatId: 'c1', userId: 'u1', text: '继续上次!!' })
  assert.equal(ctx._resumeOpts?.resumeSessionId, 'session-prev-1', '应 resume 上次会话')
  const agent = ctx._agents.get('session-prev-1')
  assert.ok(agent, '消息进入上次会话')
  assert.equal(agent.record.msg.content[0].text, '继续上次')

  gw.dispose()
})

test('重启后 /status 命令也触发会话恢复', async () => {
  const ctx = makeCtx()
  const gw = new ImGateway(ctx, {
    config: baseConfig,
    stateDir: '/tmp',
    log: () => {},
    chatSessionStore: {
      load: () => ({ 'test:c1': 'session-prev-9' }),
      save: () => {},
    },
  })
  const { channel, sent } = makeChannel()
  gw.register(channel)

  // 重启后第一条是命令：应先恢复绑定，/status 显示真实会话
  await channel.handler({ chatId: 'c1', userId: 'u1', text: '/status' })
  assert.equal(ctx._resumeOpts?.resumeSessionId, 'session-prev-9', '命令也应触发恢复')
  const reply = sent.find((s) => s.text.includes('绑定会话'))
  assert.ok(reply, '/status 应有回复')
  assert.ok(reply.text.includes('session-prev-9'), '/status 应显示恢复的会话')

  gw.dispose()
})

test('ask_user_question 同步到 IM，IM 选择恢复等待中的 ask', async () => {
  const ctx = makeCtx()
  const originalAsk = ctx.userQuestions.ask
  const gw = new ImGateway(ctx, { config: baseConfig, stateDir: '/tmp', log: () => {} })
  const { channel, sent } = makeChannel('qqbot')
  gw.register(channel)
  await channel.handler({ chatId: 'c1', userId: 'u1', text: '先建立会话!!' })
  const { agent } = [...ctx._agents.values()][0]

  const answerPromise = ctx.userQuestions.ask({
    agent,
    questions: [{ id: 'mode', question: '请选择模式', options: [{ label: '快速' }, { label: '完整' }] }],
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(sent.map((item) => item.text).join('\n'), /请选择模式/)
  assert.match(sent.map((item) => item.text).join('\n'), /2\) 完整/)

  await channel.handler({ chatId: 'c1', userId: 'u1', text: '2' })
  assert.deepEqual(await answerPromise, { answers: [{ id: 'mode', selected: ['完整'] }] })
  assert.match(sent.map((item) => item.text).join('\n'), /已选择：完整/)

  gw.dispose()
  assert.equal(ctx.userQuestions.ask, originalAsk, 'dispose 应恢复原始 Web provider ask')
})

test('网页先回答 ask_user_question 时同步通知 IM', async () => {
  const ctx = makeCtx()
  const gw = new ImGateway(ctx, { config: baseConfig, stateDir: '/tmp', log: () => {} })
  const { channel, sent } = makeChannel('wechat')
  gw.register(channel)
  await channel.handler({ chatId: 'c1', userId: 'u1', text: '先建立会话!!' })
  const { agent } = [...ctx._agents.values()][0]

  const answerPromise = ctx.userQuestions.ask({
    agent,
    questions: [{ id: 'confirm', question: '是否继续？', options: [{ label: '继续' }, { label: '取消' }] }],
  })
  await new Promise((resolve) => setImmediate(resolve))
  ctx._resolveQuestion({ answers: [{ id: 'confirm', selected: ['继续'] }] })
  assert.deepEqual(await answerPromise, { answers: [{ id: 'confirm', selected: ['继续'] }] })
  assert.match(sent.map((item) => item.text).join('\n'), /已在网页端回答：继续/)

  gw.dispose()
})
