import { describe, expect, test } from 'bun:test'
import {
  openAntigravityConversation,
  sendAntigravityPrompt,
  type AntigravityCDPConnection,
  type AntigravityControllerDependencies,
} from './AntigravityController.js'
import type { LocalInstance } from './LocalInstanceManager.js'

function createInstance(overrides: Partial<LocalInstance> = {}): LocalInstance {
  return {
    id: 'local-antigravity-test',
    platformId: 'antigravity',
    platformName: 'Antigravity',
    status: 'ready',
    pid: 1234,
    createdAt: 1,
    workspaceWorker: false,
    attached: true,
    ...overrides,
  }
}

function createHarness(model = 'Gemini 3.8') {
  let path = '/'
  let selectedModel = model
  let changeModelAfterPromptValidation = false
  let responseAvailable = true
  let clicked = false
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = []
  const evaluated: string[] = []
  let closed = false
  const connection: AntigravityCDPConnection = {
    listTabs: async () => [{ id: 'app-tab', url: 'https://127.0.0.1:57341/' }],
    connect: async () => {},
    send: async (method, params) => {
      sent.push({ method, params })
      if (method === 'Page.navigate' && typeof params?.url === 'string') {
        path = new URL(params.url).pathname
      }
      return {}
    },
    evaluate: async expression => {
      evaluated.push(expression)
      if (expression.includes('button.click()')) {
        const expectedModel = expression.match(/trim\(\)!==("(?:[^"\\]|\\.)*")/)?.[1]
        if (expectedModel && JSON.parse(expectedModel) !== selectedModel) return 'model-changed'
        if (path === '/') path = '/c/generated-chat'
        clicked = true
        return 'clicked'
      }
      if (expression.includes('selector?.getAttribute')) return `Select model, current: ${selectedModel}`
      if (expression.includes('querySelectorAll') && expression.includes('Agent response')) {
        return JSON.stringify({
          text: clicked && responseAvailable ? 'Actual Antigravity answer.' : '',
          isGenerating: false,
        })
      }
      if (expression.includes('editor.textContent?.trim()')) return true
      if (expression.includes('document.activeElement===editor')) return true
      if (expression.includes('textContent ===')) {
        if (changeModelAfterPromptValidation) selectedModel = 'Claude Opus 4.6'
        return true
      }
      if (expression.includes('button.disabled')) return true
      if (expression.includes('textContent?.trim() ===')) return true
      if (expression.includes('const match=location.pathname')) {
        return path.match(/^\/c\/([a-zA-Z0-9_-]{1,128})$/)?.[1] ?? ''
      }
      if (expression.includes('location.pathname.match')) return /^\/c\/[a-zA-Z0-9_-]{1,128}$/.test(path)
      if (expression.includes('location.pathname')) return true
      if (expression.includes('Boolean(document.querySelector')) return true
      return false
    },
    close: () => { closed = true },
  }
  const overrides: Partial<AntigravityControllerDependencies> = {
    readDevToolsPort: () => 57339,
    getPortOwner: async () => 1234,
    createConnection: () => connection,
    hasConversation: async () => true,
    responseTimeoutMs: 20,
    responseStableMs: 0,
    responsePollIntervalMs: 1,
  }
  return {
    connection,
    overrides,
    sent,
    evaluated,
    setChangeModelAfterPromptValidation(value: boolean) { changeModelAfterPromptValidation = value },
    setResponseAvailable(value: boolean) { responseAvailable = value },
    get clicked() { return clicked },
    get closed() { return closed },
    get path() { return path },
  }
}

describe('Antigravity direct conversation control', () => {
  test('opens only the selected, indexed conversation and reports the visible model', async () => {
    const harness = createHarness()
    const state = await openAntigravityConversation(createInstance(), 'chat-123', harness.overrides)

    expect(state).toEqual({ conversationId: 'chat-123', model: 'Gemini 3.8' })
    expect(harness.sent).toContainEqual({
      method: 'Page.navigate',
      params: { url: 'https://127.0.0.1:57341/c/chat-123' },
    })
    expect(harness.closed).toBe(true)
  })

  test('does not navigate to a conversation missing from the local history index', async () => {
    const harness = createHarness()
    const overrides = { ...harness.overrides, hasConversation: async () => false }

    await expect(openAntigravityConversation(createInstance(), 'missing-id', overrides))
      .rejects.toThrow('not present in Antigravity history')
    expect(harness.sent.some(call => call.method === 'Page.navigate')).toBe(false)
  })

  test('refuses a DevTools port owned by another process', async () => {
    const harness = createHarness()
    const overrides = { ...harness.overrides, getPortOwner: async () => 5678 }

    await expect(openAntigravityConversation(createInstance(), 'chat-123', overrides))
      .rejects.toThrow('not the selected instance')
    expect(harness.closed).toBe(false)
  })

  test('sends with the model actually selected for the conversation', async () => {
    const harness = createHarness('Claude Opus 4.6')
    const result = await sendAntigravityPrompt(
      createInstance(), 'chat-123', 'Exact prompt', 'Claude Opus 4.6', harness.overrides,
    )

    expect(result.model).toBe('Claude Opus 4.6')
    expect(result.response).toBe('Actual Antigravity answer.')
  })

  test('does not send if the loaded conversation model differs from the last verified model', async () => {
    const harness = createHarness('Claude Opus 4.6')

    await expect(sendAntigravityPrompt(
      createInstance(), 'chat-123', 'Exact prompt', 'Gemini 3.8', harness.overrides,
    )).rejects.toThrow('last verified with "Gemini 3.8"')
    expect(harness.sent.some(call => call.method === 'Input.insertText')).toBe(false)
  })

  test('does not click send if the selected model changes while preparing the prompt', async () => {
    const harness = createHarness()
    harness.setChangeModelAfterPromptValidation(true)

    await expect(sendAntigravityPrompt(createInstance(), 'chat-123', 'Exact prompt', 'Gemini 3.8', harness.overrides))
      .rejects.toThrow('model-changed')
    expect(harness.clicked).toBe(false)
  })

  test('enters the exact prompt and clicks send only for the selected chat model', async () => {
    const harness = createHarness()
    const result = await sendAntigravityPrompt(
      createInstance(), 'chat-123', 'Exact prompt', 'Gemini 3.8', harness.overrides,
    )

    expect(result).toEqual({
      conversationId: 'chat-123',
      model: 'Gemini 3.8',
      delivery: 'submitted',
      responseStatus: 'received',
      response: 'Actual Antigravity answer.',
    })
    expect(harness.sent).toContainEqual({
      method: 'Input.insertText',
      params: { text: 'Exact prompt' },
    })
    expect(harness.evaluated.some(expression => expression.includes('button.click()'))).toBe(true)
    expect(harness.path).toBe('/c/chat-123')
  })

  test('remembers the ID Antigravity assigns after the first message in a new chat', async () => {
    const harness = createHarness()
    const result = await sendAntigravityPrompt(
      createInstance(), 'new', 'First message', 'Gemini 3.8', harness.overrides,
    )

    expect(result).toEqual({
      conversationId: 'generated-chat',
      model: 'Gemini 3.8',
      delivery: 'submitted',
      responseStatus: 'received',
      response: 'Actual Antigravity answer.',
    })
    expect(harness.sent.some(call => call.method === 'Page.navigate' &&
      call.params?.url === 'https://127.0.0.1:57341/')).toBe(true)
  })

  test('reports a submitted prompt as pending instead of inventing a response', async () => {
    const harness = createHarness()
    harness.setResponseAvailable(false)
    const result = await sendAntigravityPrompt(
      createInstance(), 'chat-123', 'Exact prompt', 'Gemini 3.8', harness.overrides,
    )

    expect(result.delivery).toBe('submitted')
    expect(result.responseStatus).toBe('pending')
    expect(result.response).toBeUndefined()
    expect(result.verificationError).toContain('did not show a stable agent response')
  })
})
