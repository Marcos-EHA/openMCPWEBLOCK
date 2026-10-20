import { afterEach, describe, expect, test } from 'bun:test'
import type { AgentState } from './orchestration/types.js'
import {
  applyWebRelayActivityEvent,
  finishWebRelayActivity,
  getWebRelayActivitySnapshot,
  resetWebRelayActivityForTests,
  startWebRelayActivity,
} from './WebRelayActivityStore.js'

const agents: AgentState[] = [
  {
    agentId: 'coordinator',
    platformId: 'chatgpt',
    role: 'primary',
    sessionMode: 'clean',
    instanceId: 'instance-coordinator',
    status: 'ready',
    activeExecutions: 0,
    unknownExecutions: 0,
    createdAt: 1,
  },
  {
    agentId: 'worker',
    platformId: 'chatgpt',
    role: 'worker-2',
    sessionMode: 'clean',
    instanceId: 'instance-worker',
    status: 'ready',
    activeExecutions: 0,
    unknownExecutions: 0,
    createdAt: 2,
  },
  {
    agentId: 'other-platform',
    platformId: 'claude',
    role: 'worker-3',
    sessionMode: 'clean',
    instanceId: 'instance-other-platform',
    status: 'ready',
    activeExecutions: 0,
    unknownExecutions: 0,
    createdAt: 3,
  },
]

afterEach(resetWebRelayActivityForTests)

describe('WebRelayActivityStore', () => {
  test('tracks coordinator and worker stages separately and retains task history', () => {
    const taskId = startWebRelayActivity('Analiza el proyecto', 'chatgpt', [
      ...agents,
      {
        agentId: 'authenticated-worker',
        platformId: 'chatgpt',
        role: 'worker-3',
        sessionMode: 'authenticated',
        instanceId: 'instance-authenticated-worker',
        status: 'ready',
        activeExecutions: 0,
        unknownExecutions: 0,
        createdAt: 4,
      },
    ])
    applyWebRelayActivityEvent(taskId, { type: 'planning-started', agentId: 'coordinator' })
    applyWebRelayActivityEvent(taskId, {
      type: 'worker-started',
      agentId: 'worker',
      prompt: 'Inspecciona el flujo de entrada',
    })
    applyWebRelayActivityEvent(taskId, {
      type: 'worker-response',
      agentId: 'worker',
      response: 'El flujo comienza en PromptInput.',
    })
    finishWebRelayActivity(taskId)

    const [task] = getWebRelayActivitySnapshot()
    expect(task?.status).toBe('complete')
    expect(task?.agents[0]).toMatchObject({ role: 'coordinator', status: 'complete' })
    expect(task?.agents[1]).toMatchObject({
      role: 'worker',
      status: 'complete',
      response: 'El flujo comienza en PromptInput.',
    })
    expect(task?.agents.map(agent => agent.agentId)).toContain('authenticated-worker')

    startWebRelayActivity('Siguiente tarea', 'chatgpt', agents)
    expect(getWebRelayActivitySnapshot()).toHaveLength(2)
  })

  test('marks active requests failed and leaves unstarted workers idle', () => {
    const taskId = startWebRelayActivity('Analiza el proyecto', 'chatgpt', agents)
    finishWebRelayActivity(taskId, { error: 'El coordinador no devolvió un plan JSON válido.' })

    const [task] = getWebRelayActivitySnapshot()
    expect(task?.status).toBe('failed')
    expect(task?.agents.map(agent => agent.status)).toEqual(['idle', 'idle'])
    expect(task?.error).toContain('plan JSON')
  })
})
