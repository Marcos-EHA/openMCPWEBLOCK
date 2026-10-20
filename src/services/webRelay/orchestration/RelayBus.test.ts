/**
 * RelayBus tests — Pure transport verification for Commands, Events, and Queries.
 *
 * Verifies:
 *   1. Commands: start, duplicate start, stop, restart, remove, error propagation, execution commands.
 *   2. Events: runner lifecycle (instance:bound, ready, etc.), sentinel events (heartbeat, scan, instance:lost), no synthetic events.
 *   3. Queries: agent:list, agent:status, sentinel:status, system:health, execution routing.
 *   4. Concurrency: preserves per-agent serialization without introducing races.
 *
 * Run: bun test src/services/webRelay/orchestration/RelayBus.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { resetWebInstanceRegistry } from '../WebInstanceRegistry.js'

// ─── Mock controls ───────────────────────────────────────────────────────────

const mockLaunchControl = {
  shouldSucceed: true,
  error: 'Chrome launch failed: connection timeout',
  saExtensionId: 'kngiafgkdnlkgmefdafaibkibegkcaef' as string | undefined,
}

const mockPortControl = {
  active: null as boolean | null,
  launchedPorts: new Set<number>(),
  occupiedPorts: new Set<number>(),
}

const mockStampControl = {
  ok: true,
  reason: '',
}

const mockExecutionActivity = {
  events: [] as Array<Record<string, unknown>> | null,
}
const mockConversationSnapshot = {
  agentId: 'agent-1',
  available: true,
  messages: [{ role: 'assistant', text: 'Respuesta de prueba' }],
  truncated: false,
}

// ─── Mock ChromeCDP ──────────────────────────────────────────────────────────

mock.module('../ChromeCDP.js', () => ({
  isDebugPortActive: async (port?: number) => {
    if (mockPortControl.active !== null) return mockPortControl.active
    return port !== undefined && (
      mockPortControl.launchedPorts.has(port) ||
      mockPortControl.occupiedPorts.has(port)
    )
  },
  launchChrome: async (_url: string, _profile?: string, opts?: any) => {
    if (!mockLaunchControl.shouldSucceed) throw new Error(mockLaunchControl.error)
    if (typeof opts?.debugPort === 'number') mockPortControl.launchedPorts.add(opts.debugPort)
    return { saExtensionId: mockLaunchControl.saExtensionId }
  },
  navigateRelayPage: async () => {},
  stampInstanceIdentity: async (_port: number, _identity: any) => {
    if (mockStampControl.ok) return { ok: true as const }
    return { ok: false as const, reason: mockStampControl.reason }
  },
  readRecentExecutionDiagnostics: async () => mockExecutionActivity.events,
  readRelayConversation: async (agentId: string) => ({
    ...mockConversationSnapshot,
    agentId,
  }),
  CDPConnection: class {},
  DEBUG_PORT: 9222,
}))

mock.module('../SAHealthCheck.js', () => ({
  inspectSAConfiguration: async () => ({
    mcpEnabled: true,
    pushContentMode: true,
    autoInsert: true,
    autoSubmit: true,
    autoExecute: true,
    sidebarVisible: true,
    compactButtonVisible: true,
    compactButtonInComposer: true,
    compactButtonWidth: 36,
    compactButtonHeight: 36,
    compactButtonLabelVisible: false,
    sidebarCollapsed: true,
    sidebarWidth: 56,
    pluginRegistry: {
      initialized: true,
      activePlugin: 'ChatGPTAdapter',
      plugins: ['remote-config-plugin', 'sidebar-plugin', 'ChatGPTAdapter'],
      factories: [
        'gemini-adapter', 'github-copilot-adapter', 'chatgpt-adapter', 'claude-adapter',
        'arena-adapter', 'deepseek-adapter', 'chathub-adapter', 'grok-adapter',
        'perplexity-adapter', 'aistudio-adapter', 'openrouter-adapter', 't3chat-adapter',
        'mistralchat-adapter', 'kimi-adapter', 'z-adapter', 'qwen-adapter',
        'chatx-adapter',
      ],
    },
    pageVisibility: 'hidden',
    pageHasFocus: false,
  }),
}))

// ─── Fetch controls ──────────────────────────────────────────────────────────

let mockPortAlive = true
let mockSWPresent = true
let mockMCPHealthy = true

const originalFetch = globalThis.fetch
function installFetchMock() {
  globalThis.fetch = (async (url: string | URL | Request, _init?: any) => {
    const urlStr = typeof url === 'string' ? url : url.toString()
    if (urlStr.includes('/json/version')) {
      if (!mockPortAlive) throw new Error('connection refused')
      return new Response(JSON.stringify({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/test',
      }), { status: 200 })
    }
    if (urlStr.includes('/json')) {
      if (!mockPortAlive) throw new Error('connection refused')
      const targets: any[] = []
      if (mockSWPresent) {
        targets.push({
          type: 'service_worker',
          url: 'chrome-extension://kngiafgkdnlkgmefdafaibkibegkcaef/background.js',
          title: 'MCP SuperAssistant',
        })
      }
      targets.push({ type: 'page', url: 'https://chatgpt.com', title: 'ChatGPT' })
      return new Response(JSON.stringify(targets), { status: 200 })
    }
    if (urlStr.includes('/healthz')) {
      if (mockMCPHealthy) return new Response('ok', { status: 200 })
      return new Response('', { status: 503 })
    }
    return new Response('', { status: 404 })
  }) as typeof fetch
}

// ─── Imports AFTER mocks ─────────────────────────────────────────────────────

import { listAgents, resetRunner } from './MultiAgentRunner.js'
import { resetSentinel, scan } from './Sentinel.js'
import {
  RelayBus,
  relayBus,
  send,
  query,
  subscribe,
  resetRelayBus,
  type ExecutionAdapter,
} from './RelayBus.js'
import type { OrchestratorEvent } from './types.js'

// ─── Test Lifecycle ──────────────────────────────────────────────────────────

beforeEach(() => {
  resetRunner()
  resetSentinel()
  resetRelayBus()
  resetWebInstanceRegistry()
  mockLaunchControl.shouldSucceed = true
  mockLaunchControl.error = 'Chrome launch failed: connection timeout'
  mockLaunchControl.saExtensionId = 'kngiafgkdnlkgmefdafaibkibegkcaef'
  mockPortControl.active = null
  mockPortControl.launchedPorts.clear()
  mockPortControl.occupiedPorts.clear()
  mockStampControl.ok = true
  mockStampControl.reason = ''
  mockExecutionActivity.events = []
  mockPortAlive = true
  mockSWPresent = true
  mockMCPHealthy = true
  installFetchMock()
})

afterEach(() => {
  resetRunner()
  resetSentinel()
  resetRelayBus()
  resetWebInstanceRegistry()
  globalThis.fetch = originalFetch
})

// ═════════════════════════════════════════════════════════════════════════════
// 1. COMMANDS ROUTING
// ═════════════════════════════════════════════════════════════════════════════

describe('1. Commands Routing', () => {
  test('agent:recover-existing scans for running browsers without requiring a launch', async () => {
    const result = await send({
      type: 'command',
      name: 'agent:recover-existing',
      payload: { platformId: 'chatgpt', sessionMode: 'clean', purpose: 'agent' },
    })

    expect(result).toEqual({
      adopted: [],
      skipped: [],
      cdpPortsScanned: 101,
      cdpPortsFound: 0,
      matchingIdentitiesFound: 0,
    })
    expect(listAgents()).toEqual([])
  })

  test('agent:start starts agent and reaches ready status', async () => {
    const state = await send({
      type: 'command',
      name: 'agent:start',
      payload: { agentId: 'agent-1', platformId: 'chatgpt' },
    })

    expect(state.agentId).toBe('agent-1')
    expect(state.status).toBe('ready')
    expect(state.debugPort).toBeDefined()
  })

  test('SA preflight is a busy lifecycle phase and returns to ready only after success', async () => {
    await send({
      type: 'command',
      name: 'agent:start',
      payload: { agentId: 'agent-sa-preflight', platformId: 'chatgpt' },
    })

    const preparing = await send({
      type: 'command',
      name: 'agent:sa-preparation-status',
      payload: { agentId: 'agent-sa-preflight', preparing: true },
    })
    expect(preparing.status).toBe('sa_preparing')

    const ready = await send({
      type: 'command',
      name: 'agent:sa-preparation-status',
      payload: { agentId: 'agent-sa-preflight', preparing: false },
    })
    expect(ready.status).toBe('ready')
  })

  test('startup verification stays busy until preparation completes', async () => {
    const { setAgentStartupVerificationStatus } = await import('./MultiAgentRunner.js')
    const agentId = 'startup-verification-complete'
    await send({ type: 'command', name: 'agent:start', payload: { agentId, platformId: 'chatgpt' } })
    await expect(setAgentStartupVerificationStatus(agentId)).rejects.toThrow('SA preparation')
    await send({ type: 'command', name: 'agent:sa-preparation-status', payload: { agentId, preparing: true } })
    const verifying = await setAgentStartupVerificationStatus(agentId)
    expect(verifying.status).toBe('startup_verifying')
    const ready = await send({ type: 'command', name: 'agent:sa-preparation-status', payload: { agentId, preparing: false } })
    expect(ready.status).toBe('ready')
  })

  test('can stop an agent while its startup acknowledgement is pending', async () => {
    const { setAgentStartupVerificationStatus } = await import('./MultiAgentRunner.js')
    const agentId = 'startup-verification-stop'
    await send({ type: 'command', name: 'agent:start', payload: { agentId, platformId: 'chatgpt' } })
    await send({ type: 'command', name: 'agent:sa-preparation-status', payload: { agentId, preparing: true } })
    await setAgentStartupVerificationStatus(agentId)
    const stopped = await send({ type: 'command', name: 'agent:stop', payload: { agentId } })
    expect(stopped.status).toBe('stopped')
    await expect(send({ type: 'command', name: 'agent:sa-preparation-status', payload: { agentId, preparing: false } })).rejects.toThrow()
  })

  test('duplicate agent:start is idempotent and non-disruptive', async () => {
    const state1 = await send({
      type: 'command',
      name: 'agent:start',
      payload: { agentId: 'agent-1', platformId: 'chatgpt' },
    })
    const state2 = await send({
      type: 'command',
      name: 'agent:start',
      payload: { agentId: 'agent-1', platformId: 'chatgpt' },
    })

    expect(state1.status).toBe('ready')
    expect(state2.status).toBe('ready')
    expect(state2.instanceId).toBe(state1.instanceId)
  })

  test('rejects a second Web coordinator while the first is registered or starting', async () => {
    const firstStart = send({
      type: 'command',
      name: 'agent:start',
      payload: { agentId: 'coordinator-1', platformId: 'chatgpt', role: 'primary', sessionMode: 'clean' },
    })
    const duplicateStart = send({
      type: 'command',
      name: 'agent:start',
      payload: { agentId: 'coordinator-2', platformId: 'chatgpt', role: 'primary', sessionMode: 'authenticated' },
    })

    const [firstResult, duplicateResult] = await Promise.allSettled([firstStart, duplicateStart])

    expect(firstResult.status).toBe('fulfilled')
    if (firstResult.status === 'fulfilled') expect(firstResult.value.status).toBe('ready')
    expect(duplicateResult.status).toBe('rejected')
    if (duplicateResult.status === 'rejected') {
      expect(String(duplicateResult.reason)).toContain('Web coordinator "coordinator-1" is already registered')
    }
    expect(listAgents().filter(agent => agent.role === 'primary').map(agent => agent.agentId))
      .toEqual(['coordinator-1'])
    expect(listAgents().some(agent => agent.agentId === 'coordinator-2')).toBe(false)
  })

  test('allows distinct coordinator candidates in the same Web orchestration pool', async () => {
    const coordinators = await Promise.all([
      send({
        type: 'command',
        name: 'agent:start',
        payload: { agentId: 'coordinator-1', platformId: 'chatgpt', role: 'primary', sessionMode: 'clean' },
      }),
      send({
        type: 'command',
        name: 'agent:start',
        payload: { agentId: 'coordinator-2', platformId: 'chatgpt', role: 'orchestrator-2', sessionMode: 'clean' },
      }),
    ])

    expect(coordinators.map(agent => agent.status)).toEqual(['ready', 'ready'])
    expect(listAgents().filter(agent => agent.role === 'primary' || agent.role === 'orchestrator-2'))
      .toHaveLength(2)
  })

  test('allows a replacement Web coordinator after the existing one is stopped', async () => {
    await send({
      type: 'command',
      name: 'agent:start',
      payload: { agentId: 'coordinator-1', platformId: 'chatgpt', role: 'primary', sessionMode: 'clean' },
    })
    await send({
      type: 'command',
      name: 'agent:stop',
      payload: { agentId: 'coordinator-1' },
    })

    const replacement = await send({
      type: 'command',
      name: 'agent:start',
      payload: { agentId: 'coordinator-2', platformId: 'chatgpt', role: 'primary', sessionMode: 'clean' },
    })

    expect(replacement.status).toBe('ready')
    expect(listAgents().filter(agent => agent.role === 'primary' && agent.status === 'ready'))
      .toHaveLength(1)
    expect(replacement.agentId).toBe('coordinator-2')
  })

  test('agent:stop transitions agent to stopped status', async () => {
    await send({
      type: 'command',
      name: 'agent:start',
      payload: { agentId: 'agent-1', platformId: 'chatgpt' },
    })

    const stoppedState = await send({
      type: 'command',
      name: 'agent:stop',
      payload: { agentId: 'agent-1' },
    })

    expect(stoppedState.status).toBe('stopped')
    expect(stoppedState.instanceId).toBeUndefined()
  })

  test('agent:restart stops and restarts agent with clean state', async () => {
    await send({
      type: 'command',
      name: 'agent:start',
      payload: { agentId: 'agent-1', platformId: 'chatgpt' },
    })

    const restartedState = await send({
      type: 'command',
      name: 'agent:restart',
      payload: { agentId: 'agent-1' },
    })

    expect(restartedState.status).toBe('ready')
    expect(restartedState.debugPort).toBeDefined()
  })

  test('agent:remove removes a stopped agent registration', async () => {
    await send({
      type: 'command',
      name: 'agent:start',
      payload: { agentId: 'agent-1', platformId: 'chatgpt' },
    })
    await send({
      type: 'command',
      name: 'agent:stop',
      payload: { agentId: 'agent-1' },
    })

    await send({
      type: 'command',
      name: 'agent:remove',
      payload: { agentId: 'agent-1' },
    })

    const status = await query({
      type: 'query',
      name: 'agent:status',
      payload: { agentId: 'agent-1' },
    })
    expect(status).toBeNull()
  })

  test('agent:remove throws if agent is still running', async () => {
    await send({
      type: 'command',
      name: 'agent:start',
      payload: { agentId: 'agent-1', platformId: 'chatgpt' },
    })

    expect(
      send({
        type: 'command',
        name: 'agent:remove',
        payload: { agentId: 'agent-1' },
      }),
    ).rejects.toThrow('Cannot remove agent agent-1 in status ready. Stop it first.')
  })

  test('error propagation: underlying failure details are preserved', async () => {
    mockLaunchControl.shouldSucceed = false
    mockLaunchControl.error = 'Chrome launch failed: user data dir locked'

    const state = await send({
      type: 'command',
      name: 'agent:start',
      payload: { agentId: 'agent-1', platformId: 'chatgpt' },
    })

    expect(state.status).toBe('error')
    expect(state.error).toContain('Chrome launch failed: user data dir locked')
  })

  test('execution commands route to registered ExecutionAdapter', async () => {
    let handled = false
    const mockAdapter: ExecutionAdapter = {
      executeCommand: async cmd => {
        if (cmd.name === 'execution:acknowledge-unknown') {
          handled = true
        }
      },
      query: async () => [],
    }

    relayBus.setExecutionAdapter(mockAdapter)

    await send({
      type: 'command',
      name: 'execution:acknowledge-unknown',
      payload: { executionId: 'exec-1', agentId: 'agent-1' },
    })

    expect(handled).toBe(true)
  })

  test('execution commands throw if no ExecutionAdapter is registered', async () => {
    expect(
      send({
        type: 'command',
        name: 'execution:acknowledge-unknown',
        payload: { executionId: 'exec-1', agentId: 'agent-1' },
      }),
    ).rejects.toThrow('[RelayBus] No ExecutionAdapter registered')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. EVENTS ROUTING (NO SYNTHETIC EVENTS)
// ═════════════════════════════════════════════════════════════════════════════

describe('2. Events Routing', () => {
  test('forwards runner lifecycle events in correct sequence', async () => {
    const receivedEvents: OrchestratorEvent[] = []
    const unsub = subscribe(e => receivedEvents.push(e))

    await send({
      type: 'command',
      name: 'agent:start',
      payload: { agentId: 'agent-1', platformId: 'chatgpt', role: 'primary', sessionMode: 'clean' },
    })

    unsub()

    const eventNames = receivedEvents.map(e => {
      if (e.name === 'agent:lifecycle') {
        return `lifecycle:${e.payload.to}`
      }
      return e.name
    })

    // Must include the real runner events in sequence
    expect(eventNames).toContain('agent:created')
    expect(eventNames).toContain('instance:bound')
    expect(eventNames).toContain('lifecycle:chrome_ready')
    expect(eventNames).toContain('lifecycle:session_ready')
    expect(eventNames).toContain('lifecycle:extension_loading')
    expect(eventNames).toContain('lifecycle:service_worker_ready')
    expect(eventNames).toContain('lifecycle:mcp_ready')
    expect(eventNames).toContain('lifecycle:ready')
    expect(receivedEvents.find(event => event.name === 'agent:created')).toMatchObject({
      payload: { agentId: 'agent-1', platformId: 'chatgpt', role: 'primary', sessionMode: 'clean' },
    })

    // RelayBus must NOT have invented any extra events
    for (const e of receivedEvents) {
      expect(['agent:created', 'instance:bound', 'agent:lifecycle']).toContain(e.name)
    }
  })

  test('forwards sentinel heartbeat, scan, and instance:lost events', async () => {
    await send({
      type: 'command',
      name: 'agent:start',
      payload: { agentId: 'agent-1', platformId: 'chatgpt' },
    })

    const receivedEvents: OrchestratorEvent[] = []
    const unsub = subscribe(e => receivedEvents.push(e))

    // Healthy scan
    await scan()

    const heartbeat = receivedEvents.find(e => e.name === 'sentinel:heartbeat')
    const scanEv = receivedEvents.find(e => e.name === 'sentinel:scan')
    expect(heartbeat).toBeDefined()
    expect(scanEv).toBeDefined()

    // Port death scan
    mockPortAlive = false
    await scan()

    const lost = receivedEvents.find(e => e.name === 'instance:lost')
    expect(lost).toBeDefined()
    expect((lost?.payload as any).agentId).toBe('agent-1')

    unsub()
  })

  test('unsubscribing stops receiving events', async () => {
    const events: OrchestratorEvent[] = []
    const unsub = subscribe(e => events.push(e))

    await send({
      type: 'command',
      name: 'agent:start',
      payload: { agentId: 'agent-1', platformId: 'chatgpt' },
    })

    const countBefore = events.length
    expect(countBefore).toBeGreaterThan(0)

    unsub()

    await send({
      type: 'command',
      name: 'agent:stop',
      payload: { agentId: 'agent-1' },
    })

    expect(events.length).toBe(countBefore)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. QUERIES ROUTING
// ═════════════════════════════════════════════════════════════════════════════

describe('3. Queries Routing', () => {
  test('agent:list returns all agents', async () => {
    await send({
      type: 'command',
      name: 'agent:start',
      payload: { agentId: 'agent-1', platformId: 'chatgpt' },
    })
    await send({
      type: 'command',
      name: 'agent:start',
      payload: { agentId: 'agent-2', platformId: 'gemini' },
    })

    const list = await query({
      type: 'query',
      name: 'agent:list',
    })

    expect(list).toHaveLength(2)
    const ids = list.map(a => a.agentId)
    expect(ids).toContain('agent-1')
    expect(ids).toContain('agent-2')
  })

  test('agent:status returns specific agent state or null', async () => {
    await send({
      type: 'command',
      name: 'agent:start',
      payload: { agentId: 'agent-1', platformId: 'chatgpt' },
    })

    const found = await query({
      type: 'query',
      name: 'agent:status',
      payload: { agentId: 'agent-1' },
    })
    expect(found).not.toBeNull()
    expect(found!.agentId).toBe('agent-1')
    expect(found!.status).toBe('ready')

    const notFound = await query({
      type: 'query',
      name: 'agent:status',
      payload: { agentId: 'nonexistent' },
    })
    expect(notFound).toBeNull()
  })

  test('sentinel:status returns last known result without triggering scan or side effects', async () => {
    await send({
      type: 'command',
      name: 'agent:start',
      payload: { agentId: 'agent-1', platformId: 'chatgpt' },
    })

    // Before any scan, returns initial clean status
    const initialStatus = await query({
      type: 'query',
      name: 'sentinel:status',
    })
    expect(initialStatus.agentsChecked).toBe(0)

    // Run a real scan to populate Sentinel's lastScanResult
    await scan()

    // Now sentinel:status returns that cached scan result
    const events: OrchestratorEvent[] = []
    const unsub = subscribe(e => events.push(e))

    const cachedStatus1 = await query({
      type: 'query',
      name: 'sentinel:status',
    })
    const cachedStatus2 = await query({
      type: 'query',
      name: 'sentinel:status',
    })

    unsub()

    expect(cachedStatus1.agentsChecked).toBe(1)
    expect(cachedStatus1.issuesFound).toBe(0)
    expect(cachedStatus1.details[0]!.agentId).toBe('agent-1')
    expect(cachedStatus1.details[0]!.portAlive).toBe(true)

    // Side-effect-free guarantee: zero events emitted by query calls
    expect(events).toHaveLength(0)
    expect(cachedStatus2).toEqual(cachedStatus1)
  })

  test('sentinel:scan runs a health check and returns its result', async () => {
    await send({
      type: 'command',
      name: 'agent:start',
      payload: { agentId: 'agent-1', platformId: 'chatgpt' },
    })
    const events: OrchestratorEvent[] = []
    const unsub = subscribe(event => events.push(event))

    const result = await query({ type: 'query', name: 'sentinel:scan' })

    unsub()
    expect(result.agentsChecked).toBe(1)
    expect(result.issuesFound).toBe(0)
    expect(result.details[0]!.agentId).toBe('agent-1')
    expect(events.some(event => event.name === 'sentinel:scan')).toBe(true)
  })

  test('sentinel:activity reads technical events for the selected registered Relay', async () => {
    await send({
      type: 'command',
      name: 'agent:start',
      payload: { agentId: 'agent-1', platformId: 'chatgpt' },
    })
    mockExecutionActivity.events = [{
      timestamp: '2026-10-08T12:00:00.000Z',
      event: 'EXECUTION_COMPLETION',
      toolName: 'Read',
      success: true,
    }]

    const result = await query({
      type: 'query',
      name: 'sentinel:activity',
      payload: { agentId: 'agent-1' },
    })

    expect(result).toEqual({
      agentId: 'agent-1',
      available: true,
      events: mockExecutionActivity.events,
    })
  })

  test('sentinel:conversation routes a consented snapshot query to the selected Relay', async () => {
    await send({
      type: 'command',
      name: 'agent:start',
      payload: { agentId: 'agent-1', platformId: 'chatgpt' },
    })

    const result = await query({
      type: 'query',
      name: 'sentinel:conversation',
      payload: { agentId: 'agent-1' },
    })

    expect(result).toEqual(mockConversationSnapshot)
  })

  test('system:health aggregates MCP and agent metrics correctly', async () => {
    await send({
      type: 'command',
      name: 'agent:start',
      payload: { agentId: 'agent-1', platformId: 'chatgpt' },
    })

    const health = await query({
      type: 'query',
      name: 'system:health',
    })

    expect(health.totalAgents).toBe(1)
    expect(health.runningAgents).toBe(1)
    expect(health.deadInstances).toBe(0)
    expect(health.mcpServerRunning).toBe(true)
    expect(health.timestamp).toBeGreaterThan(0)
  })

  test('execution queries route to registered ExecutionAdapter', async () => {
    const mockAdapter: ExecutionAdapter = {
      executeCommand: async () => {},
      query: async q => {
        if (q.name === 'execution:list') {
          return [
            {
              executionId: 'exec-1',
              status: 'running',
              agentId: q.payload.agentId,
            },
          ]
        }
        return null
      },
    }

    relayBus.setExecutionAdapter(mockAdapter)

    const list = await query({
      type: 'query',
      name: 'execution:list',
      payload: { agentId: 'agent-1' },
    })

    expect(list).toHaveLength(1)
    expect(list[0]!.executionId).toBe('exec-1')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. CONCURRENCY & SERIALIZATION
// ═════════════════════════════════════════════════════════════════════════════

describe('4. Concurrency & Serialization', () => {
  test('RelayBus preserves per-agent mutex serialization', async () => {
    // Send start then immediately stop without awaiting in between
    const pStart = send({
      type: 'command',
      name: 'agent:start',
      payload: { agentId: 'agent-1', platformId: 'chatgpt' },
    })

    const pStop = send({
      type: 'command',
      name: 'agent:stop',
      payload: { agentId: 'agent-1' },
    })

    const [startResult, stopResult] = await Promise.all([pStart, pStop])

    expect(startResult.status).toBe('ready')
    expect(stopResult.status).toBe('stopped')

    const finalStatus = await query({
      type: 'query',
      name: 'agent:status',
      payload: { agentId: 'agent-1' },
    })
    expect(finalStatus!.status).toBe('stopped')
  })

  test('concurrent operations on different agents proceed independently', async () => {
    const [agentA, agentB] = await Promise.all([
      send({
        type: 'command',
        name: 'agent:start',
        payload: { agentId: 'agent-A', platformId: 'chatgpt' },
      }),
      send({
        type: 'command',
        name: 'agent:start',
        payload: { agentId: 'agent-B', platformId: 'gemini' },
      }),
    ])

    expect(agentA.status).toBe('ready')
    expect(agentB.status).toBe('ready')
    expect(agentA.instanceId).not.toBe(agentB.instanceId)
    expect(agentA.debugPort).not.toBe(agentB.debugPort)
  })
})
