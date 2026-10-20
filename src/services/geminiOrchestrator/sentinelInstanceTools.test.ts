import { describe, expect, test } from 'bun:test'
import type { AgentState } from '../webRelay/orchestration/types.js'
import {
  createSentinelInstanceTools,
  MAX_SENTINEL_LAUNCH_COUNT,
  type SentinelInstanceEvent,
} from './sentinelInstanceTools.js'
import { sharedActivityJournal } from '../observability/SharedActivityJournal.js'

function readyAgent(agentId: string, sessionMode: 'clean' | 'authenticated' = 'clean'): AgentState {
  return {
    agentId,
    platformId: 'chatgpt',
    sessionMode,
    status: 'ready',
    debugPort: 9222,
    activeExecutions: 0,
    unknownExecutions: 0,
    createdAt: 0,
  }
}

describe('Sentinel instance tools', () => {
  test('Sentinel reads the shared runtime activity feed with a cursor', async () => {
    const tools = createSentinelInstanceTools({
      getPlatform: () => ({ id: 'chatgpt', name: 'ChatGPT' }),
      getAgents: () => ({}),
      startAgent: async agentId => readyAgent(agentId),
      stopAgent: async agentId => ({ ...readyAgent(agentId), status: 'stopped' }),
      removeAgent: async () => {},
      prepareAgent: async () => true,
      persistAgents: () => {},
      persistStoppedAgents: () => {},
      sendPrompt: async () => 'respuesta',
    })
    const readActivity = tools.find(tool => tool.name === 'openmcp_read_activity')
    expect(readActivity).toBeDefined()
    const afterSequence = sharedActivityJournal.latestSequence
    sharedActivityJournal.append({
      source: 'execution',
      event: 'relay:test-runtime-event',
      agentId: 'relay-test',
      details: { callId: 'call-test', success: true },
    })
    const result = JSON.parse(await readActivity!.execute({
      afterSequence,
      sources: ['execution'],
      limit: 10,
    })) as {
      events: Array<{ event: string; details?: Record<string, unknown> }>
      nextSequence: number
    }
    expect(result.events).toContainEqual(expect.objectContaining({
      event: 'relay:test-runtime-event',
      details: { callId: 'call-test', success: true },
    }))
    expect(result.nextSequence).toBeGreaterThan(afterSequence)
  })

  test('launches the requested number only as clean guests and persists the result', async () => {
    const started: Array<{ agentId: string; sessionMode: string }> = []
    const events: Array<{ type: string; agentId: string; index: number }> = []
    let persisted: string[] = []
    const tools = createSentinelInstanceTools({
      getPlatform: () => ({ id: 'chatgpt', name: 'ChatGPT' }),
      getAgents: () => ({ 'sentinel-chatgpt-guest-1': readyAgent('sentinel-chatgpt-guest-1') }),
      startAgent: async (agentId, _platformId, _role, sessionMode) => {
        started.push({ agentId, sessionMode })
        return readyAgent(agentId, sessionMode)
      },
      stopAgent: async agentId => ({ ...readyAgent(agentId), status: 'stopped' }),
      removeAgent: async () => {},
      prepareAgent: async () => true,
      persistAgents: agentIds => { persisted = agentIds },
      persistStoppedAgents: () => {},
      sendPrompt: async (_prompt, _platformId, agentId) => `respuesta de ${agentId}`,
      onInstanceEvent: event => {
        if (event.type === 'launch-started' || event.type === 'instance-ready') {
          events.push({ type: event.type, agentId: event.agentId, index: event.index })
        }
      },
    })

    const result = await tools[0]!.execute({ count: 2 })

    expect(started).toHaveLength(2)
    expect(new Set(started.map(agent => agent.agentId)).size).toBe(2)
    expect(started.every(agent =>
      /^sentinel-chatgpt-guest-[0-9a-f-]{36}$/.test(agent.agentId) && agent.sessionMode === 'clean',
    )).toBe(true)
    expect(persisted).toEqual(started.map(agent => agent.agentId))
    expect(events.filter(event => event.type === 'launch-started').map(event => event.index)).toEqual([1, 2])
    expect(events.filter(event => event.type === 'instance-ready').map(event => event.index)).toEqual([1, 2])
    expect(result).toContain('No se usó ni modificó la sesión maestra')
  })

  test('rejects unspecified, fractional, and over-limit quantities before launch', async () => {
    let launchCount = 0
    const tools = createSentinelInstanceTools({
      getPlatform: () => ({ id: 'chatgpt', name: 'ChatGPT' }),
      getAgents: () => ({}),
      startAgent: async agentId => {
        launchCount += 1
        return readyAgent(agentId)
      },
      stopAgent: async agentId => ({ ...readyAgent(agentId), status: 'stopped' }),
      removeAgent: async () => {},
      prepareAgent: async () => true,
      persistAgents: () => {},
      persistStoppedAgents: () => {},
      sendPrompt: async () => 'respuesta',
    })

    for (const count of [undefined, 1.5, MAX_SENTINEL_LAUNCH_COUNT + 1]) {
      await expect(tools[0]!.execute({ count })).rejects.toThrow('entero entre 1')
    }
    expect(launchCount).toBe(0)
  })

  test('stops started agents if readiness or SuperAssistant setup fails', async () => {
    const stopped: string[] = []
    let persisted = false
    const tools = createSentinelInstanceTools({
      getPlatform: () => ({ id: 'chatgpt', name: 'ChatGPT' }),
      getAgents: () => ({}),
      startAgent: async agentId => readyAgent(agentId, 'authenticated'),
      stopAgent: async agentId => {
        stopped.push(agentId)
        return { ...readyAgent(agentId), status: 'stopped' }
      },
      removeAgent: async () => {},
      prepareAgent: async () => true,
      persistAgents: () => { persisted = true },
      persistStoppedAgents: () => {},
      sendPrompt: async () => 'respuesta',
    })

    await expect(tools[0]!.execute({ count: 1 })).rejects.toThrow('no quedó listo')
    expect(stopped).toHaveLength(1)
    expect(stopped[0]).toMatch(/^sentinel-chatgpt-guest-/)
    expect(persisted).toBe(false)
  })

  test('cleans up a ready guest when SuperAssistant preparation fails', async () => {
    const stopped: string[] = []
    const tools = createSentinelInstanceTools({
      getPlatform: () => ({ id: 'chatgpt', name: 'ChatGPT' }),
      getAgents: () => ({}),
      startAgent: async agentId => readyAgent(agentId),
      stopAgent: async agentId => {
        stopped.push(agentId)
        return { ...readyAgent(agentId), status: 'stopped' }
      },
      removeAgent: async () => {},
      prepareAgent: async () => { throw new Error('SA no respondió') },
      persistAgents: () => {},
      persistStoppedAgents: () => {},
      sendPrompt: async () => 'respuesta',
    })

    await expect(tools[0]!.execute({ count: 1 })).rejects.toThrow('SA no respondió')
    expect(stopped).toHaveLength(1)
    expect(stopped[0]).toMatch(/^sentinel-chatgpt-guest-/)
  })

  test('sends a prompt sequentially to ready managed guests and returns each response', async () => {
    const sent: string[] = []
    const events: SentinelInstanceEvent[] = []
    const agents = {
      'sentinel-chatgpt-guest-1': readyAgent('sentinel-chatgpt-guest-1'),
      'sentinel-chatgpt-guest-2': readyAgent('sentinel-chatgpt-guest-2'),
      'other-chatgpt-guest-1': readyAgent('other-chatgpt-guest-1'),
      'sentinel-chatgpt-auth-1': readyAgent('sentinel-chatgpt-auth-1', 'authenticated'),
    }
    const tools = createSentinelInstanceTools({
      getPlatform: () => ({ id: 'chatgpt', name: 'ChatGPT' }),
      getAgents: () => agents,
      startAgent: async agentId => readyAgent(agentId),
      stopAgent: async agentId => ({ ...readyAgent(agentId), status: 'stopped' }),
      removeAgent: async () => {},
      prepareAgent: async () => true,
      persistAgents: () => {},
      persistStoppedAgents: () => {},
      sendPrompt: async (_prompt, _platformId, agentId) => {
        sent.push(agentId)
        return `resultado-${agentId}`
      },
      onInstanceEvent: event => { events.push(event) },
    })

    const response = await tools.find(tool => tool.name === 'ask_guest_web_instances')!
      .execute({ prompt: 'Compara dos soluciones.' })

    expect(sent).toEqual(['sentinel-chatgpt-guest-1', 'sentinel-chatgpt-guest-2'])
    expect(response).toContain('resultado-sentinel-chatgpt-guest-1')
    expect(response).toContain('resultado-sentinel-chatgpt-guest-2')
    expect(events).toEqual([
      { type: 'request-started', agentId: 'sentinel-chatgpt-guest-1', prompt: 'Compara dos soluciones.' },
      { type: 'response', agentId: 'sentinel-chatgpt-guest-1', response: 'resultado-sentinel-chatgpt-guest-1' },
      { type: 'request-started', agentId: 'sentinel-chatgpt-guest-2', prompt: 'Compara dos soluciones.' },
      { type: 'response', agentId: 'sentinel-chatgpt-guest-2', response: 'resultado-sentinel-chatgpt-guest-2' },
    ])
  })

  test('stops and forgets only explicitly managed clean guests', async () => {
    const stopped: string[] = []
    const removed: string[] = []
    let persisted: string[] = []
    const tools = createSentinelInstanceTools({
      getPlatform: () => ({ id: 'chatgpt', name: 'ChatGPT' }),
      getAgents: () => ({
        'sentinel-chatgpt-guest-1': readyAgent('sentinel-chatgpt-guest-1'),
        'user-chatgpt-guest-1': readyAgent('user-chatgpt-guest-1'),
        'sentinel-chatgpt-auth-1': readyAgent('sentinel-chatgpt-auth-1', 'authenticated'),
      }),
      startAgent: async agentId => readyAgent(agentId),
      stopAgent: async agentId => {
        stopped.push(agentId)
        return { ...readyAgent(agentId), status: 'stopped' }
      },
      removeAgent: async agentId => { removed.push(agentId) },
      prepareAgent: async () => true,
      persistAgents: () => {},
      persistStoppedAgents: agentIds => { persisted = agentIds },
      sendPrompt: async () => 'respuesta',
    })

    const response = await tools.find(tool => tool.name === 'stop_guest_web_instances')!
      .execute({})

    expect(stopped).toEqual(['sentinel-chatgpt-guest-1'])
    expect(removed).toEqual(['sentinel-chatgpt-guest-1'])
    expect(persisted).toEqual(['sentinel-chatgpt-guest-1'])
    expect(response).toContain('La sesión maestra no se tocó')
  })

  test('does not send a prompt to authenticated or unmanaged agents', async () => {
    let sent = 0
    const tools = createSentinelInstanceTools({
      getPlatform: () => ({ id: 'chatgpt', name: 'ChatGPT' }),
      getAgents: () => ({
        'sentinel-chatgpt-auth-1': readyAgent('sentinel-chatgpt-auth-1', 'authenticated'),
      }),
      startAgent: async agentId => readyAgent(agentId),
      stopAgent: async agentId => ({ ...readyAgent(agentId), status: 'stopped' }),
      removeAgent: async () => {},
      prepareAgent: async () => true,
      persistAgents: () => {},
      persistStoppedAgents: () => {},
      sendPrompt: async () => {
        sent++
        return 'respuesta'
      },
    })

    await expect(
      tools.find(tool => tool.name === 'ask_guest_web_instances')!
        .execute({ prompt: 'Consulta privada.', agentIds: ['sentinel-chatgpt-auth-1'] }),
    ).rejects.toThrow('Solo se pueden consultar instancias guest/clean listas')
    expect(sent).toBe(0)
  })
})
