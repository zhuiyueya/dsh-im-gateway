import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDiscordChannel } from '../lib/channels/discord.js'

const waitForImmediate = () => new Promise((resolve) => setImmediate(resolve))

test('Discord 忽略自身和其他机器人的消息，只注入真实用户消息', async () => {
  const originalFetch = globalThis.fetch
  const originalWebSocket = globalThis.WebSocket
  const received = []
  let socket

  class MockWebSocket {
    onopen
    onmessage
    onclose
    onerror

    constructor() {
      socket = this
    }

    send() {}
    close() {}
  }

  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.endsWith('/gateway/bot')) return Response.json({ url: 'ws://discord.test' })
    throw new Error(`unexpected URL: ${url}`)
  }
  globalThis.WebSocket = MockWebSocket

  const channel = createDiscordChannel({ token: 'bot-token' }, () => {})
  assert.ok(channel)
  channel.setMessageHandler((message) => received.push(message))

  try {
    await channel.start()
    socket.onmessage?.({
      data: JSON.stringify({ op: 0, t: 'READY', d: { user: { id: 'self-bot' } } }),
    })
    socket.onmessage?.({
      data: JSON.stringify({
        op: 0,
        t: 'MESSAGE_CREATE',
        d: { id: 'self-message', channel_id: 'channel', content: 'agent reply', author: { id: 'self-bot', username: 'gateway' } },
      }),
    })
    socket.onmessage?.({
      data: JSON.stringify({
        op: 0,
        t: 'MESSAGE_CREATE',
        d: { id: 'other-bot-message', channel_id: 'channel', content: 'bot reply', author: { id: 'other-bot', username: 'other', bot: true } },
      }),
    })
    socket.onmessage?.({
      data: JSON.stringify({
        op: 0,
        t: 'MESSAGE_CREATE',
        d: { id: 'user-message', channel_id: 'channel', content: 'hello', author: { id: 'user', username: 'tester', bot: false } },
      }),
    })
    await waitForImmediate()

    assert.deepEqual(received, [{
      chatId: 'channel',
      userId: 'user',
      username: 'tester',
      text: 'hello',
      context: { guild: true },
    }])
  } finally {
    await channel.stop()
    globalThis.fetch = originalFetch
    globalThis.WebSocket = originalWebSocket
  }
})
