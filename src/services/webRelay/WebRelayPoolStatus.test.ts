import { describe, expect, test } from 'bun:test'
import type { AgentState } from './orchestration/types.js'
import { getWebRelayPoolStatus } from './WebRelayPoolStatus.js'

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
    agentId: 'coordinator-2',
    platformId: 'chatgpt',
    role: 'orchestrator-2',
    sessionMode: 'clean',
    instanceId: 'instance-coordinator-2',
    status: 'ready',
    activeExecutions: 0,
    unknownExecutions: 0,
    createdAt: 6,
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
    agentId: 'manual',
    platformId: 'chatgpt',
    role: 'manual-user-1',
    sessionMode: 'clean',
    instanceId: 'instance-manual',
    status: 'ready',
    activeExecutions: 0,
    unknownExecutions: 0,
    createdAt: 3,
  },
  {
    agentId: 'sentinel-chatgpt-guest-1',
    platformId: 'chatgpt',
    role: 'sentinel-guest-1',
    sessionMode: 'clean',
    instanceId: 'instance-sentinel-guest',
    status: 'ready',
    activeExecutions: 0,
    unknownExecutions: 0,
    createdAt: 5,
  },
  {
    agentId: 'other-platform',
    platformId: 'gemini',
    role: 'worker-3',
    sessionMode: 'clean',
    instanceId: 'instance-other',
    status: 'ready',
    activeExecutions: 0,
    unknownExecutions: 0,
    createdAt: 4,
  },
]

describe('getWebRelayPoolStatus', () => {
  test('counts only configured, routable agents for the selected platform', () => {
    const status = getWebRelayPoolStatus(
      agents,
      'chatgpt',
      new Set(['coordinator', 'coordinator-2', 'worker', 'manual', 'sentinel-chatgpt-guest-1', 'other-platform', 'stopped-agent']),
    )

    expect(status).toMatchObject({
      configuredCount: 5,
      coordinator: agents[0],
      workerCount: 1,
      unavailableCount: 2,
      issue: undefined,
    })
    expect(status.availableAgents.map(agent => agent.agentId)).toEqual(['coordinator', 'coordinator-2', 'worker'])
    expect(status.coordinators.map(agent => agent.agentId)).toEqual(['coordinator', 'coordinator-2'])
  })

  test('reports an empty eligible pool even when unrelated ready instances exist', () => {
    const status = getWebRelayPoolStatus(
      agents,
      'chatgpt',
      new Set(['manual', 'other-platform', 'stopped-agent']),
    )

    expect(status.availableAgents).toEqual([])
    expect(status.issue).toBe('empty-pool')
  })

  test('reports missing coordinator and worker requirements separately', () => {
    const noPrimary = getWebRelayPoolStatus(agents.slice(2, 3), 'chatgpt', new Set(['worker']))
    expect(noPrimary.issue).toBe('no-coordinator')

    const noWorker = getWebRelayPoolStatus(
      agents.slice(0, 2),
      'chatgpt',
      new Set(['coordinator', 'coordinator-2']),
    )
    expect(noWorker.issue).toBe('missing-worker')
  })

  test('honors a selected secondary coordinator without counting other coordinators as workers', () => {
    const status = getWebRelayPoolStatus(
      agents,
      'chatgpt',
      new Set(['coordinator', 'coordinator-2', 'worker']),
      'coordinator-2',
    )

    expect(status.coordinator?.agentId).toBe('coordinator-2')
    expect(status.workerCount).toBe(1)
    expect(status.issue).toBeUndefined()
  })

  test('treats every configured Relay as a worker when coordination uses the API brain', () => {
    const status = getWebRelayPoolStatus(
      agents.slice(1, 2),
      'chatgpt',
      new Set(['worker']),
      undefined,
      'api',
    )

    expect(status).toMatchObject({
      coordinator: undefined,
      workerCount: 1,
      issue: undefined,
    })
  })
})
