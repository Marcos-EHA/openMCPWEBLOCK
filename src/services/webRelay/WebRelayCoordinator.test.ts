import { describe, expect, test } from 'bun:test'
import {
  runCoordinatedWebTask,
  type WebRelayCoordinatorEvent,
} from './WebRelayCoordinator.js'
import type { AgentState } from './orchestration/types.js'
import { sharedActivityJournal } from '../observability/SharedActivityJournal.js'

const agents: AgentState[] = [
  {
    agentId: 'relay-primary',
    platformId: 'chatgpt',
    role: 'primary',
    sessionMode: 'clean',
    instanceId: 'instance-primary',
    status: 'ready',
    activeExecutions: 0,
    unknownExecutions: 0,
    createdAt: 1,
  },
  {
    agentId: 'relay-worker-2',
    platformId: 'chatgpt',
    role: 'worker-2',
    sessionMode: 'clean',
    instanceId: 'instance-worker-2',
    status: 'ready',
    activeExecutions: 0,
    unknownExecutions: 0,
    createdAt: 2,
  },
  {
    agentId: 'manual-user',
    platformId: 'chatgpt',
    role: 'manual-user-1',
    sessionMode: 'clean',
    instanceId: 'instance-manual',
    status: 'ready',
    activeExecutions: 0,
    unknownExecutions: 0,
    createdAt: 3,
  },
]

describe('runCoordinatedWebTask', () => {
  test('assigns tasks to authenticated Master workers on their own platform', async () => {
    const masterWorker: AgentState = {
      agentId: 'master-session:claude-worker',
      platformId: 'claude',
      role: 'worker-master-claude-worker',
      sessionMode: 'authenticated',
      masterSessionSourceId: 'claude-worker',
      instanceId: 'master-session:claude-worker',
      status: 'ready',
      activeExecutions: 0,
      unknownExecutions: 0,
      createdAt: 4,
    }
    const calls: Array<{ agentId: string; platformId: string }> = []
    const result = await runCoordinatedWebTask({
      prompt: 'Compara el comportamiento en dos plataformas',
      platformId: 'chatgpt',
      agents: [agents[0]!, masterWorker],
      allowCrossPlatformAgents: true,
      onEvent: () => {},
      sendPrompt: async (prompt, platformId, agentId) => {
        calls.push({ agentId, platformId })
        if (agentId === 'relay-primary' && calls.length === 1) {
          return JSON.stringify({
            tasks: [{
              agentId: 'master-session:claude-worker',
              prompt: 'Analiza el comportamiento en Claude.',
            }],
          })
        }
        return prompt.includes('TAREA DEL USUARIO')
          ? 'Plan enviado'
          : prompt.includes('RESULTADOS DE LOS WORKERS')
            ? 'Revisión final'
            : 'Resultado desde Claude'
      },
    })

    expect(result.workerResponses).toMatchObject([{
      agentId: 'master-session:claude-worker',
      response: 'Resultado desde Claude',
    }])
    expect(calls.map(call => [call.agentId, call.platformId])).toEqual([
      ['relay-primary', 'chatgpt'],
      ['master-session:claude-worker', 'claude'],
      ['relay-primary', 'chatgpt'],
    ])
  })

  test('routes a selected Master worker directly through its registered Master source', async () => {
    const masterWorker: AgentState = {
      agentId: 'master-session:claude-worker',
      platformId: 'claude',
      role: 'worker-master-claude-worker',
      sessionMode: 'authenticated',
      masterSessionSourceId: 'claude-worker',
      instanceId: 'master-session:claude-worker',
      status: 'ready',
      activeExecutions: 0,
      unknownExecutions: 0,
      createdAt: 5,
    }
    const calls: string[] = []
    const result = await runCoordinatedWebTask({
      prompt: 'Inspecciona esta parte',
      platformId: 'chatgpt',
      agents: [masterWorker],
      directAgentId: masterWorker.agentId,
      allowCrossPlatformAgents: true,
      sendPrompt: async (prompt, platformId, agentId) => {
        calls.push(`${platformId}:${agentId}:${prompt}`)
        return 'Respuesta Master'
      },
    })

    expect(result.directResponse).toBe('Respuesta Master')
    expect(calls).toEqual([
      'claude:master-session:claude-worker:Inspecciona esta parte',
    ])
  })

  test('uses the primary as coordinator, assigns a distinct task, and asks it to review worker output', async () => {
    const calls: Array<{ agentId: string; prompt: string }> = []
    const events: WebRelayCoordinatorEvent[] = []
    const beforeSequence = sharedActivityJournal.latestSequence
    const result = await runCoordinatedWebTask({
      prompt: 'Investiga la arquitectura',
      platformId: 'chatgpt',
      agents,
      onEvent: event => events.push(event),
      sendPrompt: async (prompt, _platformId, agentId) => {
        calls.push({ agentId, prompt })
        if (calls.length === 1) {
          return JSON.stringify({
            tasks: [{ agentId: 'relay-worker-2', prompt: 'Revisa los puntos de entrada.' }],
          })
        }
        if (agentId === 'relay-worker-2') return 'Encontré dos entrypoints.'
        return 'El avance confirma dos entrypoints.'
      },
    })

    expect(result.coordinatorId).toBe('relay-primary')
    expect(result.workerResponses).toEqual([
      {
        agentId: 'relay-worker-2',
        task: 'Revisa los puntos de entrada.',
        response: 'Encontré dos entrypoints.',
      },
    ])
    expect(result.reviewResponse).toBe('El avance confirma dos entrypoints.')
    expect(calls.map(call => call.agentId)).toEqual([
      'relay-primary',
      'relay-worker-2',
      'relay-primary',
    ])
    expect(events.filter(event => event.type === 'agent-ready').slice(0, 2)).toEqual([
      { type: 'agent-ready', agentId: 'relay-primary', role: 'coordinador' },
      { type: 'agent-ready', agentId: 'relay-worker-2', role: 'worker' },
    ])
    expect(events).toContainEqual(expect.objectContaining({
      type: 'worker-started',
      agentId: 'relay-worker-2',
    }))
    expect(events).toContainEqual(expect.objectContaining({
      type: 'worker-response',
      agentId: 'relay-worker-2',
    }))
    const activity = sharedActivityJournal.read({
      afterSequence: beforeSequence,
      agentIds: ['relay-worker-2'],
      sources: ['coordinator'],
    }).events
    expect(activity.map(event => event.event)).toContain('coordinator:worker-started')
    expect(activity.some(event => event.details?.responseLength === 'Encontré dos entrypoints.'.length)).toBe(true)
    expect(JSON.stringify(activity)).not.toContain('Encontré dos entrypoints.')
  })

  test('uses the selected secondary coordinator and excludes every coordinator candidate from workers', async () => {
    const secondary: AgentState = {
      ...agents[0]!, agentId: 'relay-orchestrator-2',
      role: 'orchestrator-2', instanceId: 'instance-orchestrator-2',
    }
    const calls: Array<{ agentId: string; prompt: string }> = []
    const beforeSequence = sharedActivityJournal.latestSequence
    const workerResponse = 'Worker found two entrypoints.'
    const result = await runCoordinatedWebTask({
      prompt: 'Investiga la arquitectura', platformId: 'chatgpt',
      agents: [...agents, secondary], coordinatorAgentId: secondary.agentId,
      sendPrompt: async (prompt, _platformId, agentId) => {
        calls.push({ agentId, prompt })
        if (calls.length === 1) return JSON.stringify({
          tasks: [{ agentId: 'relay-worker-2', prompt: 'Revisa los puntos de entrada.' }],
        })
        return agentId === 'relay-worker-2' ? workerResponse : 'Review complete'
      },
    })
    expect(result.coordinatorId).toBe(secondary.agentId)
    expect(result.workerResponses.map(response => response.agentId)).toEqual(['relay-worker-2'])
    expect(calls.map(call => call.agentId)).toEqual([secondary.agentId, 'relay-worker-2', secondary.agentId])
    expect(calls[0]?.prompt).toContain('openmcp_read_activity')
    expect(calls[0]?.prompt).toContain('openmcp_watch_activity')
    const activity = sharedActivityJournal.read({
      afterSequence: beforeSequence, agentIds: ['relay-worker-2'], sources: ['coordinator'],
    }).events
    expect(activity.some(event => event.details?.responseLength === workerResponse.length)).toBe(true)
    expect(JSON.stringify(activity)).not.toContain(workerResponse)
  })

  test('does not send a malformed or incomplete plan to workers', async () => {
    const calls: string[] = []
    await expect(runCoordinatedWebTask({
      prompt: 'Revisa el proyecto',
      platformId: 'chatgpt',
      agents,
      sendPrompt: async (_prompt, _platformId, agentId) => {
        calls.push(agentId)
        return '{"tasks":[]}'
      },
    })).rejects.toThrow('no asignó una tarea a cada worker')
    expect(calls).toEqual(['relay-primary'])
  })

  test('keeps going after a worker failure and returns an explicit partial outcome', async () => {
    const calls: string[] = []
    const events: WebRelayCoordinatorEvent[] = []
    const result = await runCoordinatedWebTask({
      prompt: 'Compara dos módulos',
      platformId: 'chatgpt',
      agents,
      onEvent: event => events.push(event),
      sendPrompt: async (_prompt, _platformId, agentId) => {
        calls.push(agentId)
        if (calls.length === 1) {
          return JSON.stringify({
            tasks: [{ agentId: 'relay-worker-2', prompt: 'Compara los módulos.' }],
          })
        }
        if (agentId === 'relay-worker-2') throw new Error('La instancia se desconectó')
        return 'La tarea del worker falló; vuelve a conectarla antes de continuar.'
      },
    })

    expect(calls).toEqual(['relay-primary', 'relay-worker-2', 'relay-primary'])
    expect(result.workerResponses[0]?.error).toContain('se desconectó')
    expect(result.reviewResponse).toContain('falló')
    expect(events.some(event => event.type === 'worker-error')).toBe(true)
    expect(events.some(event => event.type === 'review-response')).toBe(true)
  })

  test('sends a direct task when only one configured agent is available', async () => {
    const calls: string[] = []
    const result = await runCoordinatedWebTask({
      prompt: 'Responde esto',
      platformId: 'chatgpt',
      agents: agents.slice(0, 1),
      sendPrompt: async (_prompt, _platformId, agentId) => {
        calls.push(agentId)
        return 'Respuesta directa'
      },
    })
    expect(result).toMatchObject({
      dispatchMode: 'direct',
      directAgentId: 'relay-primary',
      directResponse: 'Respuesta directa',
    })
    expect(calls).toEqual(['relay-primary'])
  })

  test('routes directly to a worker when no coordinator was launched', async () => {
    const calls: string[] = []
    const result = await runCoordinatedWebTask({
      prompt: 'Revisa esto',
      platformId: 'chatgpt',
      agents: agents.slice(1, 2),
      sendPrompt: async (prompt, _platformId, agentId) => {
        calls.push(`${agentId}:${prompt}`)
        return 'Worker responde directamente'
      },
    })

    expect(result).toMatchObject({
      dispatchMode: 'direct',
      directAgentId: 'relay-worker-2',
      directResponse: 'Worker responde directamente',
    })
    expect(calls).toEqual(['relay-worker-2:Revisa esto'])
  })

  test('uses an API brain to coordinate one or more Relay workers without a coordinator Relay', async () => {
    const worker = agents[1]!
    const prompts: string[] = []
    const events: WebRelayCoordinatorEvent[] = []
    const result = await runCoordinatedWebTask({
      prompt: 'Investiga el comportamiento',
      platformId: 'chatgpt',
      agents: [worker],
      orchestratorBrain: 'api',
      generateCoordinatorResponse: async prompt => {
        prompts.push(prompt)
        return prompts.length === 1
          ? JSON.stringify({
            tasks: [{ agentId: worker.agentId, prompt: 'Analiza el flujo real.' }],
          })
          : 'Revisión del resultado del worker.'
      },
      onEvent: event => events.push(event),
      sendPrompt: async (_prompt, _platformId, agentId) => {
        expect(agentId).toBe(worker.agentId)
        return 'El flujo procesa la respuesta.'
      },
    })

    expect(result).toMatchObject({
      dispatchMode: 'coordinated',
      coordinatorId: 'orchestrator-api',
      workerResponses: [{ agentId: worker.agentId, response: 'El flujo procesa la respuesta.' }],
      reviewResponse: 'Revisión del resultado del worker.',
    })
    expect(prompts).toHaveLength(2)
    expect(events.some(event => event.type === 'planning-started')).toBe(true)
    expect(events.some(event => event.type === 'review-response')).toBe(true)
    const started = events.find(event => event.type === 'task-started')
    const finished = events.find(event => event.type === 'task-finished')
    expect(started?.taskId).toBeTruthy()
    expect(finished).toMatchObject({ taskId: started?.taskId, status: 'complete' })
  })

  test('requires a ready Relay worker for API-based coordination', async () => {
    await expect(runCoordinatedWebTask({
      prompt: 'Investiga el comportamiento',
      platformId: 'chatgpt',
      agents: [],
      orchestratorBrain: 'api',
      generateCoordinatorResponse: async () => 'No debe ejecutarse',
      sendPrompt: async () => 'No debe ejecutarse',
    })).rejects.toThrow('al menos un worker Web Relay listo')
  })

  test('routes to an explicitly selected worker instead of starting coordination', async () => {
    const calls: string[] = []
    const result = await runCoordinatedWebTask({
      prompt: 'Inspecciona el contrato',
      platformId: 'chatgpt',
      agents,
      coordinatorAgentId: 'relay-primary',
      directAgentId: 'relay-worker-2',
      sendPrompt: async (prompt, _platformId, agentId) => {
        calls.push(`${agentId}:${prompt}`)
        return 'Respuesta del worker'
      },
    })

    expect(result.dispatchMode).toBe('direct')
    expect(result.directAgentId).toBe('relay-worker-2')
    expect(calls).toEqual(['relay-worker-2:Inspecciona el contrato'])
  })

  test('rejects a worker selected as coordinator before dispatching any prompt', async () => {
    const calls: string[] = []
    await expect(runCoordinatedWebTask({
      prompt: 'Revisa esto', platformId: 'chatgpt', agents,
      coordinatorAgentId: 'relay-worker-2',
      sendPrompt: async (_prompt, _platformId, agentId) => {
        calls.push(agentId)
        return 'Unexpected dispatch'
      },
    })).rejects.toThrow('relay-worker-2')
    expect(calls).toEqual([])
  })

  test('routes work to an authenticated worker under a dedicated clean coordinator', async () => {
    const calls: string[] = []
    const mixedSessionAgents = agents.map(agent => agent.agentId === 'relay-worker-2'
      ? { ...agent, sessionMode: 'authenticated' as const } : agent)
    const result = await runCoordinatedWebTask({
      prompt: 'Revisa esto', platformId: 'chatgpt', agents: mixedSessionAgents,
      coordinatorAgentId: 'relay-primary',
      sendPrompt: async (_prompt, _platformId, agentId) => {
        calls.push(agentId)
        if (calls.length === 1) return JSON.stringify({
          tasks: [{ agentId: 'relay-worker-2', prompt: 'Inspect the entrypoint.' }],
        })
        return 'Resultado'
      },
    })
    expect(result.coordinatorId).toBe('relay-primary')
    expect(result.workerResponses).toEqual([{
      agentId: 'relay-worker-2', task: 'Inspect the entrypoint.', response: 'Resultado',
    }])
    expect(calls).toEqual(['relay-primary', 'relay-worker-2', 'relay-primary'])
  })

  test('reports a stale selected coordinator rather than silently selecting another instance', async () => {
    await expect(runCoordinatedWebTask({
      prompt: 'Revisa esto',
      platformId: 'chatgpt',
      agents,
      coordinatorAgentId: 'removed-agent',
      sendPrompt: async () => 'no debe ejecutarse',
    })).rejects.toThrow('removed-agent')
  })
})
