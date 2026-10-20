import { afterEach, describe, expect, test } from 'bun:test'
import { isSameOriginRequest, WebUIServer } from './WebUIServer.js'
import { WorkspaceParticipants } from '../collaboration/WorkspaceParticipants.js'

describe('WebUIServer same-origin Master prompt guard', () => {
  test('accepts same-origin requests addressed to localhost', () => {
    expect(isSameOriginRequest({
      headers: { origin: 'http://localhost:3007', host: 'localhost:3007' },
    })).toBe(true)
  })

  test('accepts same-origin requests addressed to loopback IP', () => {
    expect(isSameOriginRequest({
      headers: { origin: 'http://127.0.0.1:3007', host: '127.0.0.1:3007' },
    })).toBe(true)
  })

  test('rejects a DNS-rebinding hostname even when Origin matches Host', () => {
    expect(isSameOriginRequest({
      headers: { origin: 'http://attacker.example:3007', host: 'attacker.example:3007' },
    })).toBe(false)
  })

  test('rejects cross-origin and missing-Origin requests', () => {
    expect(isSameOriginRequest({
      headers: { origin: 'http://attacker.example', host: 'localhost:3007' },
    })).toBe(false)
    expect(isSameOriginRequest({
      headers: { host: 'localhost:3007' },
    })).toBe(false)
  })
})

describe('WebUIServer IDE workspace participation API', () => {
  const servers: WebUIServer[] = []

  afterEach(() => {
    for (const server of servers.splice(0)) server.stop()
  })

  test('serves platform-specific local chat recognition results', async () => {
    const server = new WebUIServer(0, '127.0.0.1')
    servers.push(server)
    const scans: Array<string | undefined> = []
    const result = {
      platformId: 'antigravity',
      platformName: 'Antigravity',
      conversations: [{
        id: 'chat-id',
        title: 'Recognized chat',
        lastActiveAt: 123,
        projectPath: 'C:\\project',
        isCurrentProject: true,
        isActive: false,
      }],
      scannedAt: 456,
    }
    server.setHandlers({
      onLocalConversations: async platformId => {
        scans.push(platformId)
        return result
      },
    })
    await server.start()
    const url = `http://127.0.0.1:${server.getListeningPort()}`

    const response = await fetch(`${url}/api/workspace/local-conversations?platform=antigravity`, {
      headers: { Origin: url },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(result)
    expect(scans).toEqual(['antigravity'])
  })

  test('opens a requested local Antigravity conversation through the same-origin API', async () => {
    const server = new WebUIServer(0, '127.0.0.1')
    servers.push(server)
    const opened: Array<[string, string]> = []
    server.setHandlers({
      onLocalConversationOpen: async (instanceId, conversationId) => {
        opened.push([instanceId, conversationId])
        return { conversationId: conversationId === 'new' ? '' : conversationId, model: 'Gemini 3.8' }
      },
    })
    await server.start()
    const url = `http://127.0.0.1:${server.getListeningPort()}`

    const response = await fetch(`${url}/api/workspace/local-conversation/open`, {
      method: 'POST',
      headers: { Origin: url, 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceId: 'local-antigravity-1', conversationId: 'chat-id' }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ conversationId: 'chat-id', model: 'Gemini 3.8' })
    expect(opened).toEqual([['local-antigravity-1', 'chat-id']])
  })

  test('passes the selected local conversation to prompt dispatch and validates its type', async () => {
    const server = new WebUIServer(0, '127.0.0.1')
    servers.push(server)
    const prompts: Array<[string, string, string | undefined, string | undefined]> = []
    server.setHandlers({
      onLocalPrompt: async (instanceId, prompt, conversationId, expectedModel) => {
        prompts.push([instanceId, prompt, conversationId, expectedModel])
        return { ok: true, delivery: 'submitted', durationMs: 1 }
      },
    })
    await server.start()
    const url = `http://127.0.0.1:${server.getListeningPort()}`
    const headers = { Origin: url, 'Content-Type': 'application/json' }

    const response = await fetch(`${url}/api/workspace/local-prompt`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        instanceId: 'local-antigravity-1',
        prompt: 'continue',
        conversationId: 'chat-id',
        expectedModel: 'Claude Opus 4.6',
      }),
    })
    const malformed = await fetch(`${url}/api/workspace/local-prompt`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ instanceId: 'local-antigravity-1', prompt: 'continue', conversationId: 42 }),
    })
    const malformedModel = await fetch(`${url}/api/workspace/local-prompt`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        instanceId: 'local-antigravity-1',
        prompt: 'continue',
        conversationId: 'chat-id',
        expectedModel: 42,
      }),
    })

    expect(response.status).toBe(200)
    expect(malformed.status).toBe(400)
    expect(malformedModel.status).toBe(400)
    expect(prompts).toEqual([['local-antigravity-1', 'continue', 'chat-id', 'Claude Opus 4.6']])
  })

  test('loads and sends an instance-scoped chat through same-origin routes', async () => {
    const server = new WebUIServer(0, '127.0.0.1')
    servers.push(server)
    const sends: Array<[string, string, string | undefined]> = []
    const message = {
      id: 'message-1',
      instanceId: 'relay-one',
      conversationId: 'main',
      role: 'assistant' as const,
      text: 'response',
      timestamp: 123,
    }
    server.setHandlers({
      onInstanceChatContext: async instanceId => {
        expect(instanceId).toBe('relay-one')
        return { conversationId: 'chat-123' }
      },
      onInstanceChatHistory: async (instanceId, conversationId, limit) => {
        expect([instanceId, conversationId, limit]).toEqual(['relay-one', 'main', 200])
        return [message]
      },
      onInstanceChatSend: async (instanceId, text, conversationId) => {
        sends.push([instanceId, text, conversationId])
        return { ok: true, messages: [message] }
      },
    })
    await server.start()
    const url = `http://127.0.0.1:${server.getListeningPort()}`
    const originHeaders = { Origin: url, 'Content-Type': 'application/json' }

    const history = await fetch(`${url}/api/workspace/instance-chat?instanceId=relay-one&conversationId=main`, {
      headers: { Origin: url },
    })
    const context = await fetch(`${url}/api/workspace/instance-chat/context?instanceId=relay-one`, {
      headers: { Origin: url },
    })
    const sent = await fetch(`${url}/api/workspace/instance-chat`, {
      method: 'POST',
      headers: originHeaders,
      body: JSON.stringify({ instanceId: 'relay-one', text: 'hello', conversationId: 'main' }),
    })
    const invalid = await fetch(`${url}/api/workspace/instance-chat`, {
      method: 'POST',
      headers: originHeaders,
      body: JSON.stringify({ instanceId: 'relay-one', text: '', conversationId: 'main' }),
    })
    const crossOrigin = await fetch(`${url}/api/workspace/instance-chat`, {
      method: 'POST',
      headers: { ...originHeaders, Origin: 'http://attacker.example' },
      body: JSON.stringify({ instanceId: 'relay-one', text: 'hello' }),
    })

    expect(history.status).toBe(200)
    expect(context.status).toBe(200)
    expect(await context.json()).toEqual({ conversationId: 'chat-123' })
    expect(await history.json()).toEqual({ messages: [message] })
    expect(sent.status).toBe(200)
    expect(await sent.json()).toEqual({ ok: true, messages: [message] })
    expect(invalid.status).toBe(400)
    expect(crossOrigin.status).toBe(403)
    expect(sends).toEqual([['relay-one', 'hello', 'main']])
  })

  test('serves bounded local Workspace activity for the launch alerts panel', async () => {
    const server = new WebUIServer(0, '127.0.0.1')
    servers.push(server)
    const requests: Array<[number, number]> = []
    server.setHandlers({
      onWorkspaceActivityRequest: async (afterSequence, limit) => {
        requests.push([afterSequence, limit])
        return { events: [], nextSequence: 12, truncated: false, retainedInMemory: true }
      },
    })
    await server.start()
    const url = `http://127.0.0.1:${server.getListeningPort()}`

    const response = await fetch(`${url}/api/workspace/activity?afterSequence=4&limit=20`, {
      headers: { Origin: url },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      events: [],
      nextSequence: 12,
      truncated: false,
      retainedInMemory: true,
    })
    expect(requests).toEqual([[4, 20]])
  })

  test('serves per-instance launch history only to same-origin requests', async () => {
    const server = new WebUIServer(0, '127.0.0.1')
    servers.push(server)
    const requests: Array<[string, number]> = []
    const event = {
      id: 'event-1',
      instanceId: 'relay-one',
      status: 'failed' as const,
      detail: 'SuperAssistant did not become ready',
      timestamp: 123,
    }
    server.setHandlers({
      onInstanceLaunchHistory: async (instanceId, limit) => {
        requests.push([instanceId, limit])
        return [event]
      },
    })
    await server.start()
    const url = `http://127.0.0.1:${server.getListeningPort()}`

    const response = await fetch(`${url}/api/workspace/instance-history?instanceId=relay-one&limit=20`, {
      headers: { Origin: url },
    })
    const malformed = await fetch(`${url}/api/workspace/instance-history?instanceId=relay-one&limit=101`, {
      headers: { Origin: url },
    })
    const crossOrigin = await fetch(`${url}/api/workspace/instance-history?instanceId=relay-one`, {
      headers: { Origin: 'http://attacker.example' },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ events: [event] })
    expect(malformed.status).toBe(400)
    expect(crossOrigin.status).toBe(403)
    expect(requests).toEqual([['relay-one', 20]])
  })

  test('rejects cross-origin and malformed Workspace activity requests', async () => {
    const server = new WebUIServer(0, '127.0.0.1')
    servers.push(server)
    server.setHandlers({ onWorkspaceActivityRequest: async () => ({ events: [] }) })
    await server.start()
    const url = `http://127.0.0.1:${server.getListeningPort()}`

    const crossOrigin = await fetch(`${url}/api/workspace/activity`, {
      headers: { Origin: 'http://attacker.example' },
    })
    expect(crossOrigin.status).toBe(403)

    const malformed = await fetch(`${url}/api/workspace/activity?afterSequence=-1&limit=101`, {
      headers: { Origin: url },
    })
    expect(malformed.status).toBe(400)
  })

  test('awaits Master launch and returns its success or failure to the HTTP client', async () => {
    const server = new WebUIServer(0, '127.0.0.1')
    servers.push(server)
    const launches: unknown[] = []
    server.setHandlers({
      onLaunch: async launch => {
        launches.push(launch)
        if (launch.masterSessionSourceIds?.includes('account-two')) {
          throw new Error('Master profile could not be opened.')
        }
      },
    })
    await server.start()
    const url = `http://127.0.0.1:${server.getListeningPort()}`
    const headers = { Origin: url, 'Content-Type': 'application/json' }

    const success = await fetch(`${url}/api/launch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        target: 'master',
        platformId: 'master',
        masterSessionSourceIds: ['account-one'],
      }),
    })
    expect(success.status).toBe(200)
    expect(await success.json()).toEqual({ ok: true })

    const failure = await fetch(`${url}/api/launch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        target: 'master',
        platformId: 'master',
        masterSessionSourceIds: ['account-two'],
      }),
    })
    expect(failure.status).toBe(500)
    expect(await failure.json()).toEqual({ error: 'Error: Master profile could not be opened.' })

    const crossOrigin = await fetch(`${url}/api/launch`, {
      method: 'POST',
      headers: { Origin: 'http://attacker.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: 'master',
        platformId: 'master',
        masterSessionSourceIds: ['account-one'],
      }),
    })
    expect(crossOrigin.status).toBe(403)
    expect(launches).toHaveLength(2)
  })

  test('guards instance-management actions by origin and reports action failures', async () => {
    const server = new WebUIServer(0, '127.0.0.1')
    servers.push(server)
    const actions: Array<{ action: string; agentId: string }> = []
    server.setHandlers({
      onAction: async (action, agentId) => {
        actions.push({ action, agentId })
        if (action === 'restart') throw new Error('Restart failed.')
      },
    })
    await server.start()
    const url = `http://127.0.0.1:${server.getListeningPort()}`
    const headers = { Origin: url, 'Content-Type': 'application/json' }

    const crossOrigin = await fetch(`${url}/api/action`, {
      method: 'POST',
      headers: { ...headers, Origin: 'http://attacker.example' },
      body: JSON.stringify({ action: 'close', agentId: 'master-session:account-one' }),
    })
    expect(crossOrigin.status).toBe(403)
    expect(actions).toHaveLength(0)

    const close = await fetch(`${url}/api/action`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'close', agentId: 'master-session:account-one' }),
    })
    expect(close.status).toBe(200)
    expect(await close.json()).toEqual({ ok: true })

    const restart = await fetch(`${url}/api/action`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'restart', agentId: 'relay-one' }),
    })
    expect(restart.status).toBe(500)
    expect(await restart.json()).toEqual({ error: 'Error: Restart failed.' })
    expect(actions).toEqual([
      { action: 'close', agentId: 'master-session:account-one' },
      { action: 'restart', agentId: 'relay-one' },
    ])
  })

  test('persists Master session restoration preferences through the local settings API', async () => {
    const server = new WebUIServer(0, '127.0.0.1')
    servers.push(server)
    const updates: Array<{
      restorePreviousMasterWorkers: boolean
      resumePreviousMasterSession: boolean
      saveCleanContext: boolean
      captureWebConversations: boolean
      sentinelAutoReview: boolean
      sentinelReviewAgentIds: string[]
    }> = []
    server.setHandlers({
      onWorkspaceSettingsUpdate: async settings => {
        updates.push(settings)
        if (settings.resumePreviousMasterSession) throw new Error('Settings could not be saved.')
      },
    })

    await server.start()
    const url = `http://127.0.0.1:${server.getListeningPort()}`
    const headers = { Origin: url, 'Content-Type': 'application/json' }

    const crossOrigin = await fetch(`${url}/api/workspace/settings`, {
      method: 'POST',
      headers: { ...headers, Origin: 'http://attacker.example' },
      body: JSON.stringify({ resumePreviousMasterSession: true }),
    })
    expect(crossOrigin.status).toBe(403)

    const invalid = await fetch(`${url}/api/workspace/settings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        restorePreviousMasterWorkers: true,
        resumePreviousMasterSession: 'yes',
      }),
    })
    expect(invalid.status).toBe(400)

    const fresh = await fetch(`${url}/api/workspace/settings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        restorePreviousMasterWorkers: false,
        resumePreviousMasterSession: false,
        saveCleanContext: true,
        captureWebConversations: false,
        sentinelAutoReview: true,
        sentinelReviewAgentIds: ['relay-a'],
      }),
    })
    expect(fresh.status).toBe(200)
    expect(await fresh.json()).toEqual({ ok: true })

    const failedSave = await fetch(`${url}/api/workspace/settings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        restorePreviousMasterWorkers: true,
        resumePreviousMasterSession: true,
        saveCleanContext: false,
        captureWebConversations: false,
        sentinelAutoReview: false,
        sentinelReviewAgentIds: [],
      }),
    })
    expect(failedSave.status).toBe(500)
    expect(await failedSave.json()).toEqual({ error: 'Error: Settings could not be saved.' })
    expect(updates).toEqual([
      { restorePreviousMasterWorkers: false, resumePreviousMasterSession: false, saveCleanContext: true, captureWebConversations: false, sentinelAutoReview: true, sentinelReviewAgentIds: ['relay-a'] },
      { restorePreviousMasterWorkers: true, resumePreviousMasterSession: true, saveCleanContext: false, captureWebConversations: false, sentinelAutoReview: false, sentinelReviewAgentIds: [] },
    ])
  })

  test('exposes and explicitly clears shared Workspace context through same-origin endpoints', async () => {
    const server = new WebUIServer(0, '127.0.0.1')
    servers.push(server)
    const requests: Array<[number, number]> = []
    let cleared = false
    server.setHandlers({
      onWorkspaceContextRequest: async (offset, limit) => {
        requests.push([offset, limit])
        return { eventCount: 4, events: [] }
      },
      onWorkspaceContextClear: async () => {
        cleared = true
      },
    })
    await server.start()
    const url = `http://127.0.0.1:${server.getListeningPort()}`
    const originHeaders = { Origin: url }

    const denied = await fetch(`${url}/api/workspace/context`, {
      headers: { Origin: 'http://attacker.example' },
    })
    expect(denied.status).toBe(403)

    const invalidRange = await fetch(`${url}/api/workspace/context?offset=-1`, {
      headers: originHeaders,
    })
    expect(invalidRange.status).toBe(400)

    const page = await fetch(`${url}/api/workspace/context?offset=2&limit=5`, {
      headers: originHeaders,
    })
    expect(page.status).toBe(200)
    expect(await page.json()).toEqual({ eventCount: 4, events: [] })
    expect(requests).toEqual([[2, 5]])

    const clear = await fetch(`${url}/api/workspace/context`, {
      method: 'DELETE',
      headers: originHeaders,
    })
    expect(clear.status).toBe(200)
    expect(cleared).toBe(true)
  })

  test('registers the IDE and publishes its messages to the workspace registry', async () => {
    const participants = new WorkspaceParticipants()
    const server = new WebUIServer(0, '127.0.0.1')
    servers.push(server)
    server.setHandlers({
      onWorkspaceJoin: participant => participants.join(participant),
      onWorkspacePresence: presence => participants.updatePresence(presence),
      onWorkspaceMessage: message => participants.postMessage(message.id, message.text),
    })
    await server.start()
    const url = `http://127.0.0.1:${server.getListeningPort()}`
    const headers = {
      Origin: url,
      'Content-Type': 'application/json',
    }

    const joined = await fetch(`${url}/api/workspace/join`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        id: 'vscode-copilot',
        provider: 'copilot',
        displayName: 'Copilot en VS Code',
        capabilities: ['code', 'review'],
      }),
    })
    expect(joined.status).toBe(200)
    expect(await joined.json()).toMatchObject({ id: 'vscode-copilot', status: 'online' })

    const posted = await fetch(`${url}/api/workspace/message`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'vscode-copilot', text: 'Estoy participando en el workspace.' }),
    })
    expect(posted.status).toBe(200)
    expect(await posted.json()).toMatchObject({
      participantId: 'vscode-copilot',
      text: 'Estoy participando en el workspace.',
    })
    expect(participants.listMessages()).toHaveLength(1)
  })

  test('requires same-origin and explicit consent for Sentinel workspace monitoring', async () => {
    const server = new WebUIServer(0, '127.0.0.1')
    servers.push(server)
    const inspected: string[] = []
    const suggestions: string[] = []
    const chats: string[] = []
    const storedMessages: Array<{
      id: string
      instanceId: string
      conversationId: string
      role: 'user' | 'assistant' | 'status' | 'error'
      text: string
      timestamp: number
    }> = []
    let scanCount = 0
    server.setHandlers({
      onSentinelScan: async () => {
        scanCount++
        return { agentsChecked: 1, issuesFound: 0 }
      },
      onSentinelConversationReview: async agentId => {
        inspected.push(agentId)
        return 'Revisión solicitada.'
      },
      onSentinelChatHistory: async () => storedMessages,
      onSentinelChat: async text => {
        chats.push(text)
        storedMessages.push({
          id: `user-${storedMessages.length}`,
          instanceId: 'sentinel',
          conversationId: 'main',
          role: 'user',
          text,
          timestamp: Date.now(),
        }, {
          id: `assistant-${storedMessages.length + 1}`,
          instanceId: 'sentinel',
          conversationId: 'main',
          role: 'assistant',
          text: 'Hola. Puedo ayudarte con UX y explicar las acciones disponibles de Sentinel.',
          timestamp: Date.now(),
        })
        return { messages: storedMessages }
      },
      onSentinelChatEvent: async text => {
        storedMessages.push({
          id: `status-${storedMessages.length}`,
          instanceId: 'sentinel',
          conversationId: 'main',
          role: 'status',
          text,
          timestamp: Date.now(),
        })
        return storedMessages
      },
      onSentinelSuggestion: async text => {
        suggestions.push(text)
        return 'Sugerencia opcional.'
      },
    })
    await server.start()
    const url = `http://127.0.0.1:${server.getListeningPort()}`
    const headers = { Origin: url, 'Content-Type': 'application/json' }

    const history = await fetch(`${url}/api/workspace/sentinel-chat`, { headers: { Origin: url } })
    expect(history.status).toBe(200)
    expect(await history.json()).toEqual({ messages: [] })

    const scan = await fetch(`${url}/api/workspace/sentinel-scan`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    expect(scan.status).toBe(200)
    expect(await scan.json()).toEqual({ agentsChecked: 1, issuesFound: 0 })

    const denied = await fetch(`${url}/api/workspace/sentinel-inspect`, {
      method: 'POST',
      headers: { ...headers, Origin: 'http://attacker.example' },
      body: JSON.stringify({ agentId: 'relay-1', userConfirmed: true }),
    })
    expect(denied.status).toBe(403)

    const unconfirmed = await fetch(`${url}/api/workspace/sentinel-inspect`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ agentId: 'relay-1', userConfirmed: false }),
    })
    expect(unconfirmed.status).toBe(400)

    const inspect = await fetch(`${url}/api/workspace/sentinel-inspect`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ agentId: 'relay-1', userConfirmed: true }),
    })
    expect(inspect.status).toBe(200)
    expect(await inspect.json()).toEqual({ suggestion: 'Revisión solicitada.' })

    const chat = await fetch(`${url}/api/workspace/sentinel-chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: 'Hola Sentinel, ¿qué puedes hacer?' }),
    })
    expect(chat.status).toBe(200)
    expect(await chat.json()).toEqual({
      messages: storedMessages,
    })
    expect(storedMessages.map(message => message.role)).toEqual(['user', 'assistant'])

    const tooLongChat = await fetch(`${url}/api/workspace/sentinel-chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: 'x'.repeat(4001) }),
    })
    expect(tooLongChat.status).toBe(400)

    const actionEvent = await fetch(`${url}/api/workspace/sentinel-chat/event`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: 'Lanzamiento confirmado.' }),
    })
    expect(actionEvent.status).toBe(200)
    expect((await actionEvent.json() as { messages: typeof storedMessages }).messages.at(-1)?.role).toBe('status')

    const suggestion = await fetch(`${url}/api/workspace/sentinel-suggestion`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: 'El Workspace no muestra el estado de monitoreo.' }),
    })
    expect(suggestion.status).toBe(200)
    expect(await suggestion.json()).toEqual({ suggestion: 'Sugerencia opcional.' })

    const tooLong = await fetch(`${url}/api/workspace/sentinel-suggestion`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: 'x'.repeat(4001) }),
    })
    expect(tooLong.status).toBe(400)
    expect(scanCount).toBe(1)
    expect(inspected).toEqual(['relay-1'])
    expect(chats).toEqual(['Hola Sentinel, ¿qué puedes hacer?'])
    expect(suggestions).toEqual(['El Workspace no muestra el estado de monitoreo.'])
  })

  test('does not replay stale agent lifecycle updates to reconnecting workspaces', async () => {
    const server = new WebUIServer(0, '127.0.0.1')
    servers.push(server)
    await server.start()
    server.broadcast({
      type: 'agent-update',
      timestamp: Date.now(),
      data: { agentId: 'old-agent', status: 'ready' },
    })
    server.broadcast({
      type: 'master-update',
      timestamp: Date.now(),
      data: { sourceId: 'old-master' },
    })
    server.broadcast({
      type: 'conversation',
      timestamp: Date.now(),
      data: { text: 'Keep workspace conversation history.' },
    })

    const url = `ws://127.0.0.1:${server.getListeningPort()}`
    const catchupPromise = new Promise<{ type: string; events: Array<{ type: string }> }>((resolve, reject) => {
      const socket = new WebSocket(url)
      socket.onerror = () => reject(new Error('WebSocket connection failed.'))
      socket.onmessage = event => {
        socket.close()
        resolve(JSON.parse(String(event.data)))
      }
    })
    const catchup = await catchupPromise

    expect(catchup.type).toBe('catchup')
    expect(catchup.events.map(event => event.type)).toEqual(['conversation'])
  })

  test('rejects cross-origin and malformed participant requests', async () => {
    const server = new WebUIServer(0, '127.0.0.1')
    servers.push(server)
    server.setHandlers({
      onWorkspaceJoin: () => ({ id: 'unexpected' }),
    })
    await server.start()
    const url = `http://127.0.0.1:${server.getListeningPort()}`

    const crossOrigin = await fetch(`${url}/api/workspace/join`, {
      method: 'POST',
      headers: { Origin: 'http://attacker.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'attacker', provider: 'web', displayName: 'Attacker' }),
    })
    expect(crossOrigin.status).toBe(403)

    const malformed = await fetch(`${url}/api/workspace/join`, {
      method: 'POST',
      headers: { Origin: url, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'vscode-copilot', capabilities: ['code', 1] }),
    })
    expect(malformed.status).toBe(400)
  })

  test('assigns, claims, and completes IDE workspace tasks over the local API', async () => {
    const participants = new WorkspaceParticipants()
    participants.join({ id: 'vscode-agent', provider: 'copilot', displayName: 'VS Code' })
    participants.join({ id: 'cursor-agent', provider: 'cursor', displayName: 'Cursor' })
    const events: string[] = []
    participants.subscribe(event => events.push(event.type))

    const server = new WebUIServer(0, '127.0.0.1')
    servers.push(server)
    server.setHandlers({
      onWorkspaceAssign: assignment =>
        participants.assignTaskToParticipants(assignment.participantIds, assignment.prompt),
      onWorkspaceClaim: participantId => participants.claimTasks(participantId),
      onWorkspaceComplete: completion => participants.completeTask(completion),
    })
    await server.start()
    const url = `http://127.0.0.1:${server.getListeningPort()}`
    const headers = { Origin: url, 'Content-Type': 'application/json' }

    const assigned = await fetch(`${url}/api/workspace/assign`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        participantIds: ['vscode-agent', 'cursor-agent'],
        prompt: 'Review the shared implementation',
      }),
    })
    expect(assigned.status).toBe(200)
    const tasks = await assigned.json() as Array<{
      id: string
      participantId: string
      collaborationId: string
      status: string
    }>
    expect(tasks).toHaveLength(2)
    expect(tasks[0].collaborationId).toBeTruthy()
    expect(tasks[1].collaborationId).toBe(tasks[0].collaborationId)

    const claimed = await fetch(`${url}/api/workspace/claim`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ participantId: 'vscode-agent' }),
    })
    expect(claimed.status).toBe(200)
    expect(await claimed.json()).toMatchObject([{ id: tasks[0].id, status: 'claimed' }])

    const completed = await fetch(`${url}/api/workspace/complete`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        participantId: 'vscode-agent',
        taskId: tasks[0].id,
        response: 'Review completed.',
      }),
    })
    expect(completed.status).toBe(200)
    expect(await completed.json()).toMatchObject({
      id: tasks[0].id,
      status: 'completed',
      response: 'Review completed.',
    })
    expect(events).toContain('task')
    expect(events).toContain('participant')
    expect(events).toContain('message')

    const invalidAssignment = await fetch(`${url}/api/workspace/assign`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        participantIds: ['vscode-agent', 'vscode-agent'],
        prompt: 'Duplicate target',
      }),
    })
    expect(invalidAssignment.status).toBe(400)
    expect(await invalidAssignment.json()).toMatchObject({ error: 'IDE participant IDs must be unique.' })
  })

  test('preserves flexible Relay and Master launch requests with optional worker registration', async () => {
    const launches: unknown[] = []
    const server = new WebUIServer(0, '127.0.0.1')
    servers.push(server)
    server.setHandlers({
      onLaunch: async launch => { launches.push(launch) },
    })
    await server.start()
    const url = `http://127.0.0.1:${server.getListeningPort()}`
    for (const viewUrl of [url, `${url}/?view=canvas`]) {
      const page = await fetch(viewUrl)
      expect(page.status).toBe(200)
      const html = await page.text()
      expect(html).toContain('/launchDialog.js')
      expect(html).toContain("d.type==='master-update'")
      expect(html).toContain('function updateMasterWorkerPanels')
      expect(html).toContain("master.workspaceWorker?'relay:master-session:'+master.id:'master:'+master.id")
      expect(html).toContain('Continuar donde lo dejaste en las Master Sessions')
      expect(html).toContain('Restaurar el registro anterior de Masters worker')
      expect(html).toContain('Relay Clean sigue usando un perfil aislado')
      expect(html).toContain('Incluir mensajes visibles de las instancias web (Clean y Master)')
      expect(html).toContain('instance-kind-badge')
      expect(html).toContain('instance-coordinator')
      expect(html).toContain('Orquestador Web')
      expect(html).toContain('severity-critical')
      expect(html).toContain('Análisis de IA pendiente')
      expect(html).toContain('panel-close')
      expect(html).toContain('panelAction')
      expect(html).toContain('Se conservarán el perfil, las credenciales y su registro como worker')
      expect(html).toContain('Detenida · configuración conservada')
      expect(html).toContain('Sesión no verificada')
      expect(html).toContain('Requiere iniciar sesión')
      expect(html).toContain('Alertas de lanzamiento')
      expect(html).toContain('Asignar revisión a IDEs seleccionadas')
      expect(html).toContain('openmcp_read_activity')
    }
    const launchScript = await fetch(`${url}/launchDialog.js`)
    expect(launchScript.status).toBe(200)
    const launchDialog = await launchScript.text()
    expect(launchDialog).toContain('window.createLaunchDialog')
    expect(launchDialog).toContain('Toda Master Session abierta integra y verifica SuperAssistant')
    expect(launchDialog).toContain('Registrar las Master seleccionadas como workers de Workspace')
    expect(launchDialog).not.toContain('Solo abrir la cuenta, sin SA')
    expect(launchDialog).toContain('Lanzar workers Relay — SA obligatorio')
    expect(launchDialog).toContain('Puedes decidir por separado si también la registras como worker de Workspace')
    expect(launchDialog).toContain('Abrir con SA y registrar workers')
    expect(launchDialog).toContain('debe pasar la preparación y verificación de SuperAssistant')
    expect(launchDialog).toContain('Cerebro API — sin Relay dedicado')
    expect(launchDialog).toContain('Cerebro Web — asignar un Relay como orquestador')
    expect(launchDialog).toContain('Número de workers')
    expect(launchDialog).toContain('Sesión de cada worker')
    expect(launchDialog).toContain('Sesión del orquestador Web')
    expect(launchDialog).toContain('Orquestadores Web candidatos')
    expect(launchDialog).toContain('Para una tarea se elige un coordinador')
    expect(launchDialog).toContain('modo Agente siempre hay orquestación')
    expect(launchDialog).toContain('modo Usuario, las ventanas son manuales')
    expect(launchDialog).toContain('monitor ya se inicia con la aplicación')
    expect(launchDialog).toContain('Sentinel no consume una instancia de esta lista')
    expect(launchDialog).toContain('Importar desde Chrome (copia aislada)')
    expect(launchDialog).toContain(
      'Autorizo copiar datos a un perfil Relay separado y que OpenMCP solicite el cierre normal de Chrome si sigue abierto',
    )
    expect(launchDialog).toContain('launchCoordinator')
    expect(launchDialog).toContain('Cada candidato es una Relay adicional')
    expect(launchDialog).not.toContain('La primera instancia será el orquestador Web')
    expect(launchDialog).not.toContain('Solo workers — envío directo')

    const relayLaunch = await fetch(`${url}/api/launch`, {
      method: 'POST',
      headers: { Origin: url, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: 'relay',
        platformId: 'chatgpt',
        purpose: 'agent',
        count: 2,
        instances: [
          { sessionMode: 'clean' },
          { sessionMode: 'authenticated', masterSessionSourceId: 'account-two' },
        ],
      }),
    })
    expect(relayLaunch.status).toBe(200)
    expect(await relayLaunch.json()).toEqual({ ok: true })

    const chromeProfileLaunch = await fetch(`${url}/api/launch`, {
      method: 'POST',
      headers: { Origin: url, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: 'relay',
        platformId: 'chatgpt',
        purpose: 'user',
        count: 1,
        allowChromeProfileCopy: true,
        instances: [{ sessionMode: 'chrome-profile', chromeProfileDirectory: 'Profile 2' }],
      }),
    })
    expect(chromeProfileLaunch.status).toBe(200)
    expect(await chromeProfileLaunch.json()).toEqual({ ok: true })

    const masterLaunch = await fetch(`${url}/api/launch`, {
      method: 'POST',
      headers: { Origin: url, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: 'master',
        platformId: 'master',
        masterSessionSourceIds: ['account-one', 'account-two'],
        registerAsWorkspaceWorker: true,
      }),
    })
    expect(masterLaunch.status).toBe(200)
    expect(await masterLaunch.json()).toEqual({ ok: true })

    const masterWithoutWorkerRegistration = await fetch(`${url}/api/launch`, {
      method: 'POST',
      headers: { Origin: url, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: 'master',
        platformId: 'master',
        masterSessionSourceIds: ['account-one'],
        registerAsWorkspaceWorker: false,
      }),
    })
    expect(masterWithoutWorkerRegistration.status).toBe(200)
    expect(await masterWithoutWorkerRegistration.json()).toEqual({ ok: true })

    const legacyLaunch = await fetch(`${url}/api/launch`, {
      method: 'POST',
      headers: { Origin: url, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platformId: 'gemini',
        count: 2,
        purpose: 'agent',
        sessionMode: 'clean',
      }),
    })
    expect(legacyLaunch.status).toBe(200)
    expect(await legacyLaunch.json()).toEqual({ ok: true })

    const workerOnlyLaunch = await fetch(`${url}/api/launch`, {
      method: 'POST',
      headers: { Origin: url, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: 'relay',
        platformId: 'chatgpt',
        purpose: 'agent',
        launchCoordinator: false,
        count: 1,
        instances: [{ sessionMode: 'clean' }],
      }),
    })
    expect(workerOnlyLaunch.status).toBe(200)
    expect(await workerOnlyLaunch.json()).toEqual({ ok: true })

    const apiCoordinatorLaunch = await fetch(`${url}/api/launch`, {
      method: 'POST',
      headers: { Origin: url, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: 'relay',
        platformId: 'chatgpt',
        purpose: 'agent',
        coordinateTasks: true,
        orchestratorBrain: 'api',
        launchCoordinator: false,
        count: 1,
        instances: [{ sessionMode: 'clean' }],
      }),
    })
    expect(apiCoordinatorLaunch.status).toBe(200)
    expect(await apiCoordinatorLaunch.json()).toEqual({ ok: true })
    expect(launches).toEqual([
      {
        target: 'relay',
        platformId: 'chatgpt',
        purpose: 'agent',
        count: 2,
        instances: [
          { sessionMode: 'clean' },
          { sessionMode: 'authenticated', masterSessionSourceId: 'account-two' },
        ],
      },
      {
        target: 'relay',
        platformId: 'chatgpt',
        purpose: 'user',
        count: 1,
        allowChromeProfileCopy: true,
        instances: [{ sessionMode: 'chrome-profile', chromeProfileDirectory: 'Profile 2' }],
      },
      {
        target: 'master',
        platformId: 'master',
        masterSessionSourceIds: ['account-one', 'account-two'],
        registerAsWorkspaceWorker: true,
      },
      {
        target: 'master',
        platformId: 'master',
        masterSessionSourceIds: ['account-one'],
        registerAsWorkspaceWorker: false,
      },
      {
        platformId: 'gemini',
        count: 2,
        purpose: 'agent',
        sessionMode: 'clean',
      },
      {
        target: 'relay',
        platformId: 'chatgpt',
        purpose: 'agent',
        launchCoordinator: false,
        count: 1,
        instances: [{ sessionMode: 'clean' }],
      },
      {
        target: 'relay',
        platformId: 'chatgpt',
        purpose: 'agent',
        coordinateTasks: true,
        orchestratorBrain: 'api',
        launchCoordinator: false,
        count: 1,
        instances: [{ sessionMode: 'clean' }],
      },
    ])

    const malformed = await fetch(`${url}/api/launch`, {
      method: 'POST',
      headers: { Origin: url, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: 'relay',
        platformId: 'chatgpt',
        instances: [{ sessionMode: 'unknown' }],
      }),
    })
    expect(malformed.status).toBe(400)

    const malformedCoordinator = await fetch(`${url}/api/launch`, {
      method: 'POST',
      headers: { Origin: url, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: 'relay',
        platformId: 'chatgpt',
        purpose: 'agent',
        launchCoordinator: 'false',
      }),
    })
    expect(malformedCoordinator.status).toBe(400)

    const malformedCoordinatorCount = await fetch(`${url}/api/launch`, {
      method: 'POST',
      headers: { Origin: url, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: 'relay',
        platformId: 'chatgpt',
        purpose: 'agent',
        coordinatorCount: 20,
      }),
    })
    expect(malformedCoordinatorCount.status).toBe(400)

    const malformedBrain = await fetch(`${url}/api/launch`, {
      method: 'POST',
      headers: { Origin: url, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: 'relay',
        platformId: 'chatgpt',
        purpose: 'agent',
        orchestratorBrain: 'mcp',
      }),
    })
    expect(malformedBrain.status).toBe(400)

    const malformedMasterWorkerRegistration = await fetch(`${url}/api/launch`, {
      method: 'POST',
      headers: { Origin: url, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: 'master',
        platformId: 'master',
        masterSessionSourceIds: ['account-one'],
        registerAsWorkspaceWorker: 'enabled',
      }),
    })
    expect(malformedMasterWorkerRegistration.status).toBe(400)
  })
})
