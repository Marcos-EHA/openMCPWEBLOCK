import { describe, expect, test } from 'bun:test'
// @ts-ignore — ws types are not installed in this workspace
import { WebSocket, WebSocketServer } from 'ws'
import {
  getWebConversationIdFromUrl,
  waitForPageReloadReady,
  waitForSAExecutionContext,
} from './WebRelayProvider.js'

describe('Web conversation identity', () => {
  test('extracts ChatGPT conversation IDs from regular and GPT URLs', () => {
    expect(getWebConversationIdFromUrl('chatgpt', 'https://chatgpt.com/c/chat-123'))
      .toBe('chat-123')
    expect(getWebConversationIdFromUrl('chatgpt', 'https://chatgpt.com/g/gpt-456/c/chat-789?model=gpt'))
      .toBe('chat-789')
  })

  test('uses a provisional ID for a new ChatGPT chat and main for other web platforms', () => {
    expect(getWebConversationIdFromUrl('chatgpt', 'https://chatgpt.com/')).toBe('new')
    expect(getWebConversationIdFromUrl('claude', 'https://claude.ai/chat/chat-123')).toBe('main')
  })
})

function waitForServerListening(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.once('listening', resolve)
  })
}

function connectWebSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url)
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

function closeServer(server: WebSocketServer): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()))
}

function closeWebSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve()
  return new Promise(resolve => {
    socket.once('close', resolve)
    socket.close()
  })
}

describe('SuperAssistant execution-context refresh', () => {
  test('refreshes Runtime before looking for contexts on a reused page session', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    const methods: string[] = []
    let runtimeEnabled = true
    server.on('connection', socket => {
      socket.on('message', raw => {
        const message = JSON.parse(raw.toString()) as { id: number; method: string; params?: { expression?: string } }
        methods.push(message.method)
        if (message.method === 'Runtime.disable') runtimeEnabled = false
        if (message.method === 'Runtime.enable' && !runtimeEnabled) {
          runtimeEnabled = true
          socket.send(JSON.stringify({
            method: 'Runtime.executionContextCreated',
            params: {
              context: {
                id: 42,
                name: 'MCP SuperAssistant',
                origin: 'chrome-extension://test-extension',
              },
            },
          }))
        }
        socket.send(JSON.stringify({
          id: message.id,
          result: message.method === 'Runtime.evaluate'
            ? { result: { value: message.params?.expression?.includes('chrome.runtime?.sendMessage') === true } }
            : {},
        }))
      })
    })
    await waitForServerListening(server)
    const address = server.address()
    if (!address || typeof address === 'string') {
      await closeServer(server)
      throw new Error('Could not bind fake CDP WebSocket server')
    }

    const page = await connectWebSocket(`ws://127.0.0.1:${address.port}`)
    try {
      const contextId = await waitForSAExecutionContext(page, 'test-extension', 1000)
      expect(contextId).toBe(42)

      expect(methods).toEqual(['Runtime.disable', 'Runtime.enable', 'Runtime.evaluate'])
    } finally {
      await closeWebSocket(page)
      await closeServer(server)
    }
  })

  test('accepts a navigated, DOM-ready page when loadEventFired is delayed', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    server.on('connection', socket => {
      socket.on('message', raw => {
        const message = JSON.parse(raw.toString()) as { id: number; method: string }
        if (message.method !== 'Page.reload') return
        socket.send(JSON.stringify({
          method: 'Page.domContentEventFired',
          params: { timestamp: 1 },
        }))
        socket.send(JSON.stringify({
          method: 'Page.frameNavigated',
          params: { frame: { id: 'chatx-main', url: 'https://chatx.ai/es/gpt' } },
        }))
        socket.send(JSON.stringify({ id: message.id, result: {} }))
      })
    })
    await waitForServerListening(server)
    const address = server.address()
    if (!address || typeof address === 'string') {
      await closeServer(server)
      throw new Error('Could not bind fake CDP WebSocket server')
    }

    const page = await connectWebSocket(`ws://127.0.0.1:${address.port}`)
    try {
      await waitForPageReloadReady(page, 'chatx', 5000)
    } finally {
      await closeWebSocket(page)
      await closeServer(server)
    }
  })

  test('reports which reload milestone is missing when the page never reaches DOM-ready', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    server.on('connection', socket => {
      socket.on('message', raw => {
        const message = JSON.parse(raw.toString()) as { id: number; method: string }
        if (message.method !== 'Page.reload') return
        socket.send(JSON.stringify({ id: message.id, result: {} }))
      })
    })
    await waitForServerListening(server)
    const address = server.address()
    if (!address || typeof address === 'string') {
      await closeServer(server)
      throw new Error('Could not bind fake CDP WebSocket server')
    }

    const page = await connectWebSocket(`ws://127.0.0.1:${address.port}`)
    try {
      const error = await waitForPageReloadReady(page, 'chatx', 1000).then(
        () => undefined,
        (reason: unknown) => reason,
      )
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain(
        'acknowledged=true, topFrameNavigated=false, domContentLoaded=false',
      )
    } finally {
      await closeWebSocket(page)
      await closeServer(server)
    }
  })

})
