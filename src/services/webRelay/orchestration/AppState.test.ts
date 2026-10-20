/**
 * AppState Unit & Integration Tests
 *
 * Verifies:
 *   1. Initialization & Hydration:
 *      - Hydrates existing agents via agent:list
 *      - Hydrates Sentinel status via sentinel:status (side-effect-free)
 *      - Hydrates system health via system:health
 *   2. Event Projections (via applyEvent and RelayBus.subscribe):
 *      - agent:created, instance:bound, agent:lifecycle, agent:stopped, agent:error
 *      - instance:lost (authoritative from Sentinel)
 *      - sentinel:heartbeat and sentinel:scan
 *      - execution:update and execution:unknown (maintaining separate execution dimension)
 *   3. Commands Routing:
 *      - All commands (start, stop, restart, remove, acknowledge) go strictly through RelayBus.send()
 *      - No direct calls to MultiAgentRunner or WebInstanceRegistry
 *   4. State Integrity:
 *      - Two agents remain completely isolated (ports, instanceIds, status)
 *      - Loss of Agent A does not mutate Agent B
 *      - Execution events update execution snapshots and counts without overwriting AgentState lifecycle
 *   5. Race Reconciliation:
 *      - Event arrives while initial query is in-flight; newer event state is NOT regressed by query response
 *
 * Run: bun test src/services/webRelay/orchestration/AppState.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import type {
  AgentState,
  OrchestratorEvent,
  Command,
  OrchestratorQuery,
  QueryResult,
  SystemHealth,
} from './types.js'

import type { SentinelScanResult } from './types.js'

import {
  AppState,
  applyEvent,
  createInitialAppStateData,
} from './AppState.js'

import { RelayBus } from './RelayBus.js'
import { isRoutableWebRelayAgent } from '../isRoutableWebRelayAgent.js'

// ─── Mock RelayBus for controlled unit testing ───────────────────────────────

class MockRelayBus {
  public sentCommands: Command[] = []
  public executedQueries: OrchestratorQuery[] = []
  public subscribers = new Set<(event: OrchestratorEvent) => void>()

  public mockAgents: AgentState[] = []
  public mockSentinel: SentinelScanResult | null = null
  public mockHealth: SystemHealth | null = null

  public subscribe(sub: (event: OrchestratorEvent) => void): () => void {
    this.subscribers.add(sub)
    return () => {
      this.subscribers.delete(sub)
    }
  }

  public emit(event: OrchestratorEvent): void {
    for (const s of this.subscribers) {
      s(event)
    }
  }

  public async send<C extends Command>(command: C): Promise<any> {
    this.sentCommands.push(command)
    if (command.name === 'agent:start') {
      const { agentId, platformId, role } = command.payload
      return {
        agentId,
        platformId,
        role,
        status: 'ready',
        activeExecutions: 0,
        unknownExecutions: 0,
        createdAt: Date.now(),
      } as AgentState
    }
    if (command.name === 'agent:stop') {
      return {
        agentId: command.payload.agentId,
        platformId: 'test',
        status: 'stopped',
        activeExecutions: 0,
        unknownExecutions: 0,
        createdAt: Date.now(),
      } as AgentState
    }
    if (command.name === 'agent:remove') {
      return undefined
    }
    return {}
  }

  public async query<Q extends OrchestratorQuery>(query: Q): Promise<QueryResult<Q>> {
    this.executedQueries.push(query)
    if (query.name === 'agent:list') {
      return this.mockAgents as QueryResult<Q>
    }
    if (query.name === 'sentinel:status') {
      return this.mockSentinel as QueryResult<Q>
    }
    if (query.name === 'sentinel:scan') {
      return this.mockSentinel as QueryResult<Q>
    }
    if (query.name === 'system:health') {
      return this.mockHealth as QueryResult<Q>
    }
    return null as QueryResult<Q>
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. INITIALIZATION & HYDRATION
// ═════════════════════════════════════════════════════════════════════════════

describe('1. Initialization & Hydration', () => {
  test('hydrates agents, sentinel status, and system health via RelayBus.query()', async () => {
    const mockBus = new MockRelayBus()
    mockBus.mockAgents = [
      {
        agentId: 'agent-alpha',
        platformId: 'chatgpt',
        status: 'ready',
        instanceId: 'inst-1',
        debugPort: 9222,
        activeExecutions: 0,
        unknownExecutions: 0,
        createdAt: 1000,
      },
    ]
    mockBus.mockSentinel = {
      agentsChecked: 1,
      issuesFound: 0,
      details: [{
        agentId: 'agent-alpha',
        debugPort: 9222,
        portAlive: true,
        swActive: true,
        mcpAlive: true,
        diagnostics: [],
      }],
    }
    mockBus.mockHealth = {
      mcpServerRunning: true,
      totalAgents: 1,
      runningAgents: 1,
      deadInstances: 0,
      unknownOutcomes: 0,
      timestamp: 2000,
    }

    const appState = new AppState({ bus: mockBus as unknown as RelayBus, autoInit: false })
    expect(appState.listAgents()).toHaveLength(0)

    await appState.init()

    // Verifies queries were sent through bus
    const queryNames = mockBus.executedQueries.map(q => q.name)
    expect(queryNames).toContain('agent:list')
    expect(queryNames).toContain('sentinel:status')
    expect(queryNames).toContain('system:health')

    // Verifies state was populated
    const agent = appState.getAgent('agent-alpha')
    expect(agent).not.toBeNull()
    expect(agent!.status).toBe('ready')
    expect(agent!.debugPort).toBe(9222)

    expect(appState.getSelectedAgentId()).toBe('agent-alpha')
    expect(appState.getSentinelStatus()?.agentsChecked).toBe(1)
    expect(appState.getSystemHealth()?.mcpServerRunning).toBe(true)
    expect(appState.getState().lastHydratedAt).not.toBeNull()

    appState.destroy()
  })

  test('notifies subscribers upon initialization and initial subscription', async () => {
    const mockBus = new MockRelayBus()
    const appState = new AppState({ bus: mockBus as unknown as RelayBus, autoInit: false })

    let notifiedCount = 0
    const unsub = appState.subscribe(() => {
      notifiedCount++
    })

    // Subscription immediately emits current state (count = 1)
    expect(notifiedCount).toBe(1)

    await appState.init()
    // Hydration triggers notification (count = 2)
    expect(notifiedCount).toBe(2)

    unsub()
    appState.destroy()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. EVENT PROJECTIONS
// ═════════════════════════════════════════════════════════════════════════════

describe('2. Event Projections', () => {
  let mockBus: MockRelayBus
  let appState: AppState

  beforeEach(async () => {
    mockBus = new MockRelayBus()
    appState = new AppState({ bus: mockBus as unknown as RelayBus, autoInit: false })
    await appState.init()
  })

  afterEach(() => {
    appState.destroy()
  })

  test('projects agent:created and adds to agent map', () => {
    mockBus.emit({
      type: 'event',
      name: 'agent:created',
      payload: { agentId: 'agent-new', platformId: 'gemini' },
    })

    const agent = appState.getAgent('agent-new')
    expect(agent).not.toBeNull()
    expect(agent!.status).toBe('created')
    expect(agent!.platformId).toBe('gemini')
  })

  test('preserves agent routing metadata so a started clean agent is eligible for Web Relay', () => {
    mockBus.emit({
      type: 'event',
      name: 'agent:created',
      payload: {
        agentId: 'web-agent',
        platformId: 'chatgpt',
        role: 'primary',
        sessionMode: 'clean',
      },
    })
    mockBus.emit({
      type: 'event',
      name: 'instance:bound',
      payload: { agentId: 'web-agent', instanceId: 'web-inst-1', debugPort: 9222 },
    })
    mockBus.emit({
      type: 'event',
      name: 'agent:lifecycle',
      payload: { agentId: 'web-agent', from: 'starting', to: 'ready' },
    })

    const agent = appState.getAgent('web-agent')!
    expect(agent.role).toBe('primary')
    expect(agent.sessionMode).toBe('clean')
    expect(isRoutableWebRelayAgent(agent, 'chatgpt')).toBe(true)
  })

  test('projects instance:bound and sets instanceId and debugPort', () => {
    mockBus.emit({
      type: 'event',
      name: 'agent:created',
      payload: { agentId: 'agent-1', platformId: 'chatgpt' },
    })

    mockBus.emit({
      type: 'event',
      name: 'instance:bound',
      payload: { agentId: 'agent-1', instanceId: 'web-inst-123', debugPort: 9230 },
    })

    const agent = appState.getAgent('agent-1')
    expect(agent!.instanceId).toBe('web-inst-123')
    expect(agent!.debugPort).toBe(9230)
  })

  test('projects agent:lifecycle transitions in order', () => {
    mockBus.emit({
      type: 'event',
      name: 'agent:created',
      payload: { agentId: 'agent-1', platformId: 'chatgpt' },
    })

    const statuses = ['chrome_ready', 'session_ready', 'extension_loading', 'service_worker_ready', 'mcp_ready', 'sa_preparing', 'ready'] as const
    for (const status of statuses) {
      mockBus.emit({
        type: 'event',
        name: 'agent:lifecycle',
        payload: { agentId: 'agent-1', from: 'starting', to: status },
      })
      expect(appState.getAgent('agent-1')!.status).toBe(status)
    }
  })

  test('projects agent:stopped and clears instance bindings', () => {
    mockBus.emit({
      type: 'event',
      name: 'agent:created',
      payload: { agentId: 'agent-1', platformId: 'chatgpt' },
    })
    mockBus.emit({
      type: 'event',
      name: 'instance:bound',
      payload: { agentId: 'agent-1', instanceId: 'inst-1', debugPort: 9222 },
    })
    mockBus.emit({
      type: 'event',
      name: 'agent:stopped',
      payload: { agentId: 'agent-1' },
    })

    const agent = appState.getAgent('agent-1')
    expect(agent!.status).toBe('stopped')
    expect(agent!.instanceId).toBeUndefined()
    expect(agent!.debugPort).toBeUndefined()
  })

  test('projects agent:error and updates lastError', () => {
    mockBus.emit({
      type: 'event',
      name: 'agent:created',
      payload: { agentId: 'agent-1', platformId: 'chatgpt' },
    })
    mockBus.emit({
      type: 'event',
      name: 'agent:error',
      payload: { agentId: 'agent-1', error: 'SA load failed: manifest not found' },
    })

    const agent = appState.getAgent('agent-1')
    expect(agent!.status).toBe('error')
    expect(agent!.error).toBe('SA load failed: manifest not found')
    expect(appState.getLastError()).toBe('SA load failed: manifest not found')
  })

  test('projects instance:lost from Sentinel to mark agent as lost', () => {
    mockBus.emit({
      type: 'event',
      name: 'agent:created',
      payload: { agentId: 'agent-1', platformId: 'chatgpt' },
    })
    mockBus.emit({
      type: 'event',
      name: 'agent:lifecycle',
      payload: { agentId: 'agent-1', from: 'starting', to: 'ready' },
    })

    mockBus.emit({
      type: 'event',
      name: 'instance:lost',
      payload: { agentId: 'agent-1', instanceId: 'inst-1' },
    })

    const agent = appState.getAgent('agent-1')
    expect(agent!.status).toBe('lost')
  })

  test('projects sentinel:heartbeat to update lastHeartbeat timestamp', () => {
    mockBus.emit({
      type: 'event',
      name: 'agent:created',
      payload: { agentId: 'agent-1', platformId: 'chatgpt' },
    })

    expect(appState.getAgent('agent-1')!.lastHeartbeat).toBeUndefined()

    mockBus.emit({
      type: 'event',
      name: 'sentinel:heartbeat',
      payload: { agentId: 'agent-1', alive: true },
    })

    expect(appState.getAgent('agent-1')!.lastHeartbeat).toBeGreaterThan(0)
  })

  test('projects sentinel:scan to update sentinel summary counts', () => {
    // Seed initial sentinel state
    mockBus.mockSentinel = { agentsChecked: 0, issuesFound: 0, details: [] }
    appState.getState().sentinel = { agentsChecked: 0, issuesFound: 0, details: [] }

    mockBus.emit({
      type: 'event',
      name: 'sentinel:scan',
      payload: { agentsChecked: 3, issuesFound: 1 },
    })

    const sentinel = appState.getSentinelStatus()
    expect(sentinel?.agentsChecked).toBe(3)
    expect(sentinel?.issuesFound).toBe(1)
  })

  test('projects detailed Sentinel checks and keeps diagnostic events in the log ring', () => {
    const log = {
      id: 'sentinel-test-1',
      timestamp: 1234,
      severity: 'error' as const,
      code: 'sa-autoSubmit-disabled',
      agentId: 'relay-1',
      message: 'Auto Submit is disabled.',
    }
    mockBus.emit({
      type: 'event',
      name: 'sentinel:scan',
      payload: {
        agentsChecked: 1,
        issuesFound: 1,
        healthy: false,
        scannedAt: 1234,
        details: [{
          agentId: 'relay-1',
          debugPort: 9222,
          portAlive: true,
          swActive: null,
          mcpAlive: true,
          sessionMode: 'authenticated',
          masterSessionSourceId: 'loco-verde',
          saConfiguration: null,
          diagnostics: [{
            severity: 'error',
            code: 'sa-autoSubmit-disabled',
            message: 'Auto Submit is disabled.',
          }],
        }],
        logs: [log],
      },
    })

    expect(appState.getSentinelStatus()?.details[0]?.masterSessionSourceId).toBe('loco-verde')
    expect(appState.getSentinelStatus()?.logs?.[0]).toEqual(log)

    mockBus.emit({ type: 'event', name: 'sentinel:log', payload: log })
    const recentLog = appState.getRecentEvents()[0]
    expect(recentLog?.severity).toBe('error')
    expect(recentLog?.code).toBe('sa-autoSubmit-disabled')
    expect(recentLog?.detail).toBe('Auto Submit is disabled.')
  })

  test('appends events to recent events ring buffer with maxEvents eviction', () => {
    for (let i = 0; i < 250; i++) {
      mockBus.emit({
        type: 'event',
        name: 'sentinel:heartbeat',
        payload: { agentId: 'agent-1', alive: true },
      })
    }

    const events = appState.getRecentEvents()
    expect(events.length).toBe(200) // maxEvents capped at 200
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. COMMANDS ROUTING
// ═════════════════════════════════════════════════════════════════════════════

describe('3. Commands Routing', () => {
  let mockBus: MockRelayBus
  let appState: AppState

  beforeEach(() => {
    mockBus = new MockRelayBus()
    appState = new AppState({ bus: mockBus as unknown as RelayBus, autoInit: false })
  })

  afterEach(() => {
    appState.destroy()
  })

  test('startAgent dispatches agent:start through RelayBus.send', async () => {
    const res = await appState.startAgent('agent-1', 'chatgpt', 'researcher')

    expect(res.status).toBe('ready')
    expect(mockBus.sentCommands).toHaveLength(1)
    expect(mockBus.sentCommands[0]).toEqual({
      type: 'command',
      name: 'agent:start',
      payload: { agentId: 'agent-1', platformId: 'chatgpt', role: 'researcher' },
    })
  })

  test('startAgent dispatches the selected Master Session source', async () => {
    await appState.startAgent('agent-auth', 'chatgpt', 'researcher', 'authenticated', 'cuenta-norte')

    expect(mockBus.sentCommands[0]).toEqual({
      type: 'command',
      name: 'agent:start',
      payload: {
        agentId: 'agent-auth',
        platformId: 'chatgpt',
        role: 'researcher',
        sessionMode: 'authenticated',
        masterSessionSourceId: 'cuenta-norte',
      },
    })
  })

  test('recoverExistingAgents dispatches its platform, purpose, and session classification', async () => {
    await appState.recoverExistingAgents('chatgpt', 'clean', 'agent')

    expect(mockBus.sentCommands).toEqual([
      {
        type: 'command',
        name: 'agent:recover-existing',
        payload: { platformId: 'chatgpt', sessionMode: 'clean', purpose: 'agent' },
      },
    ])
  })

  test('stopAgent dispatches agent:stop through RelayBus.send', async () => {
    await appState.stopAgent('agent-1')

    expect(mockBus.sentCommands).toHaveLength(1)
    expect(mockBus.sentCommands[0]).toEqual({
      type: 'command',
      name: 'agent:stop',
      payload: { agentId: 'agent-1' },
    })
  })

  test('restartAgent dispatches agent:restart through RelayBus.send', async () => {
    await appState.restartAgent('agent-1')

    expect(mockBus.sentCommands).toHaveLength(1)
    expect(mockBus.sentCommands[0]).toEqual({
      type: 'command',
      name: 'agent:restart',
      payload: { agentId: 'agent-1' },
    })
  })

  test('scanSentinel requests a live scan through RelayBus.query', async () => {
    mockBus.mockSentinel = {
      healthy: true,
      agentsChecked: 1,
      issuesFound: 0,
      details: [],
    }

    const result = await appState.scanSentinel()

    expect(result.healthy).toBe(true)
    expect(mockBus.executedQueries).toEqual([
      { type: 'query', name: 'sentinel:scan' },
    ])
  })

  test('removeAgent dispatches agent:remove through RelayBus.send', async () => {
    await appState.removeAgent('agent-1')

    expect(mockBus.sentCommands).toHaveLength(1)
    expect(mockBus.sentCommands[0]).toEqual({
      type: 'command',
      name: 'agent:remove',
      payload: { agentId: 'agent-1' },
    })
  })

  test('acknowledgeUnknown dispatches execution:acknowledge-unknown through RelayBus.send', async () => {
    await appState.acknowledgeUnknown('exec-42', 'agent-1')

    expect(mockBus.sentCommands).toHaveLength(1)
    expect(mockBus.sentCommands[0]).toEqual({
      type: 'command',
      name: 'execution:acknowledge-unknown',
      payload: { executionId: 'exec-42', agentId: 'agent-1' },
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. INTEGRITY & ISOLATION
// ═════════════════════════════════════════════════════════════════════════════

describe('4. Integrity & Isolation', () => {
  let mockBus: MockRelayBus
  let appState: AppState

  beforeEach(() => {
    mockBus = new MockRelayBus()
    appState = new AppState({ bus: mockBus as unknown as RelayBus, autoInit: false })
  })

  afterEach(() => {
    appState.destroy()
  })

  test('two agents remain completely separated and do not cross identities', () => {
    mockBus.emit({
      type: 'event',
      name: 'agent:created',
      payload: { agentId: 'agent-A', platformId: 'chatgpt' },
    })
    mockBus.emit({
      type: 'event',
      name: 'agent:created',
      payload: { agentId: 'agent-B', platformId: 'gemini' },
    })
    mockBus.emit({
      type: 'event',
      name: 'instance:bound',
      payload: { agentId: 'agent-A', instanceId: 'inst-A', debugPort: 9250 },
    })
    mockBus.emit({
      type: 'event',
      name: 'instance:bound',
      payload: { agentId: 'agent-B', instanceId: 'inst-B', debugPort: 9251 },
    })

    const a = appState.getAgent('agent-A')
    const b = appState.getAgent('agent-B')

    expect(a!.instanceId).toBe('inst-A')
    expect(b!.instanceId).toBe('inst-B')
    expect(a!.debugPort).toBe(9250)
    expect(b!.debugPort).toBe(9251)
    expect(a!.platformId).toBe('chatgpt')
    expect(b!.platformId).toBe('gemini')
  })

  test('lost status on Agent A does not mutate Agent B', () => {
    mockBus.emit({
      type: 'event',
      name: 'agent:created',
      payload: { agentId: 'agent-A', platformId: 'chatgpt' },
    })
    mockBus.emit({
      type: 'event',
      name: 'agent:created',
      payload: { agentId: 'agent-B', platformId: 'gemini' },
    })
    mockBus.emit({
      type: 'event',
      name: 'agent:lifecycle',
      payload: { agentId: 'agent-A', from: 'starting', to: 'ready' },
    })
    mockBus.emit({
      type: 'event',
      name: 'agent:lifecycle',
      payload: { agentId: 'agent-B', from: 'starting', to: 'ready' },
    })

    // Kill/lost Agent A
    mockBus.emit({
      type: 'event',
      name: 'instance:lost',
      payload: { agentId: 'agent-A', instanceId: 'inst-A' },
    })

    expect(appState.getAgent('agent-A')!.status).toBe('lost')
    expect(appState.getAgent('agent-B')!.status).toBe('ready')
  })

  test('execution events update executions map without overwriting AgentState lifecycle', () => {
    mockBus.emit({
      type: 'event',
      name: 'agent:created',
      payload: { agentId: 'agent-A', platformId: 'chatgpt' },
    })
    mockBus.emit({
      type: 'event',
      name: 'agent:lifecycle',
      payload: { agentId: 'agent-A', from: 'starting', to: 'ready' },
    })

    // Execution update event
    mockBus.emit({
      type: 'event',
      name: 'execution:update',
      payload: { agentId: 'agent-A', executionId: 'exec-1', status: 'running' },
    })

    // Execution unknown event
    mockBus.emit({
      type: 'event',
      name: 'execution:unknown',
      payload: { agentId: 'agent-A', executionId: 'exec-2', reason: 'browser crashed during run' },
    })

    const agent = appState.getAgent('agent-A')
    // Agent status MUST remain ready — NOT overwritten by execution status
    expect(agent!.status).toBe('ready')
    expect(agent!.activeExecutions).toBe(1)
    expect(agent!.unknownExecutions).toBe(1)

    // Separate execution dimension is correctly recorded
    const exec1 = appState.getExecution('exec-1')
    const exec2 = appState.getExecution('exec-2')
    expect(exec1?.status).toBe('running')
    expect(exec2?.unknownOutcome).toBe(true)
    expect(exec2?.unknownReason).toBe('browser crashed during run')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 5. RECONCILIATION & RACE SAFETY
// ═════════════════════════════════════════════════════════════════════════════

describe('5. Reconciliation & Race Safety', () => {
  test('event arriving while initial query is in-flight is NOT regressed by query response', async () => {
    const mockBus = new MockRelayBus()

    // Simulate slow query: delay agent:list query response
    let resolveQuery: (agents: AgentState[]) => void
    const slowQueryPromise = new Promise<AgentState[]>(resolve => {
      resolveQuery = resolve
    })

    mockBus.query = async (q: OrchestratorQuery) => {
      if (q.name === 'agent:list') {
        return slowQueryPromise as any
      }
      return null as any
    }

    const appState = new AppState({ bus: mockBus as unknown as RelayBus, autoInit: false })

    // Start initialization (attaches subscription immediately, launches query)
    const initPromise = appState.init()

    // While query is pending in-flight, an event arrives updating agent to 'ready'
    mockBus.emit({
      type: 'event',
      name: 'agent:created',
      payload: { agentId: 'agent-race', platformId: 'chatgpt' },
    })
    mockBus.emit({
      type: 'event',
      name: 'agent:lifecycle',
      payload: { agentId: 'agent-race', from: 'starting', to: 'ready' },
    })

    // At this moment, state reflects event-driven 'ready'
    expect(appState.getAgent('agent-race')!.status).toBe('ready')

    // Now resolve the older, slower query that returns stale 'starting'
    resolveQuery!([
      {
        agentId: 'agent-race',
        platformId: 'chatgpt',
        status: 'starting', // STALE status from before event arrived
        activeExecutions: 0,
        unknownExecutions: 0,
        createdAt: 500,
      },
    ])

    await initPromise

    // Invariant: The newer event state ('ready') was NOT regressed by the stale query response!
    const finalAgent = appState.getAgent('agent-race')
    expect(finalAgent!.status).toBe('ready')

    appState.destroy()
  })
})
