/**
 * TUIIntegration.test.tsx — Unit and Invariant Test Suite for TUI Orchestration Integration.
 *
 * Covers:
 * 1. useOrchestratorState Hook:
 *    - Stable snapshot reference for useSyncExternalStore
 *    - Reactive update when AppState changes (pure event-driven)
 *    - Clean unsubscribe on unmount
 *    - Idempotent init() — no repeated hydration on component mount/unmount
 * 2. Commands Delegation:
 *    - startAgent, stopAgent, restartAgent, removeAgent, selectAgent, acknowledgeUnknown
 *    - Delegated strictly through AppState methods
 * 3. Status Component (WebRelayOrchestrationSection):
 *    - ready agent rendering
 *    - lost agent rendering (never transformed to error)
 *    - error agent rendering
 *    - multiple isolated agents
 * 4. MCP Status Component (MCPStatus):
 *    - Web Relay Orchestration block included in output
 *    - Zero calls to Sentinel.scan()
 * 5. Isolation:
 *    - Agent A lost does not mutate Agent B ready state
 * 6. Architectural Non-Contamination Check (Static Analysis):
 *    - TUI files never import ChromeCDP, WebInstanceRegistry, MultiAgentRunner,
 *      Sentinel, RelayBus, or ExecutionRegistry directly.
 */

import { PassThrough } from 'node:stream'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import React, { useEffect, useState } from 'react'
import { createRoot, Box, Text } from '../../../ink.js'

import {
  AppState,
  type AppStateData,
  createInitialAppStateData,
} from './AppState.js'
import type { RelayBus } from './RelayBus.js'
import type { AgentState, OrchestratorEvent } from './types.js'
import {
  useOrchestratorState,
  type UseOrchestratorStateResult,
} from '../../../hooks/useOrchestratorState.js'
import {
  WebRelayOrchestrationSection,
  getLifecycleColor,
} from '../../../components/Settings/Status.js'
import { call as callMcpCommand, MCPStatus } from '../../../commands/mcp/mcp.js'

// ─── Test Helpers ────────────────────────────────────────────────────────────

function createTestStreams() {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  return { stdout, stdin }
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for condition after ${timeoutMs}ms`)
}

function createMockBus() {
  const listeners = new Set<(event: OrchestratorEvent) => void>()
  const sentCommands: any[] = []
  const queriesReceived: any[] = []

  return {
    sentCommands,
    queriesReceived,
    listeners,
    subscribe(fn: (event: OrchestratorEvent) => void) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    emit(event: OrchestratorEvent) {
      for (const fn of listeners) fn(event)
    },
    async send(cmd: any) {
      sentCommands.push(cmd)
      if (cmd.name === 'agent:start') {
        return {
          agentId: cmd.payload.agentId,
          platformId: cmd.payload.platformId,
          role: cmd.payload.role,
          status: 'ready',
          instanceId: 'inst-test',
          debugPort: 9222,
          registeredAt: Date.now(),
          lastStatusChange: Date.now(),
          activeExecutions: 0,
          unknownExecutions: 0,
        } as AgentState
      }
      if (cmd.name === 'agent:stop') {
        return {
          agentId: cmd.payload.agentId,
          platformId: 'test',
          status: 'stopped',
          registeredAt: Date.now(),
          lastStatusChange: Date.now(),
          activeExecutions: 0,
          unknownExecutions: 0,
        } as AgentState
      }
      if (cmd.name === 'agent:restart') {
        return {
          agentId: cmd.payload.agentId,
          platformId: 'test',
          status: 'ready',
          instanceId: 'inst-restarted',
          debugPort: 9223,
          registeredAt: Date.now(),
          lastStatusChange: Date.now(),
          activeExecutions: 0,
          unknownExecutions: 0,
        } as AgentState
      }
      return undefined
    },
    async query(q: any) {
      queriesReceived.push(q)
      if (q.name === 'agent:list') return []
      if (q.name === 'sentinel:status') {
        return {
          healthy: true,
          agentsChecked: 2,
          issuesFound: 0,
          unhealthyAgents: [],
          timestamp: Date.now(),
        }
      }
      if (q.name === 'sentinel:scan') {
        return {
          healthy: true,
          agentsChecked: 2,
          issuesFound: 0,
          details: [],
        }
      }
      if (q.name === 'system:health') {
        return {
          status: 'healthy',
          mcpConnected: true,
          activeAgents: 2,
          totalAgents: 2,
          unhealthyServices: [],
          timestamp: Date.now(),
        }
      }
      return null
    },
  }
}

// ─── 1. Hook Tests ───────────────────────────────────────────────────────────

describe('1. useOrchestratorState Hook', () => {
  let mockBus: ReturnType<typeof createMockBus>
  let testAppState: AppState

  beforeEach(() => {
    mockBus = createMockBus()
    testAppState = new AppState({ bus: mockBus as unknown as RelayBus, autoInit: false })
  })

  afterEach(() => {
    testAppState.destroy()
  })

  test('snapshot reference stability: consecutive renders without change return exact same reference', async () => {
    const snapshots: AppStateData[] = []

    function Harness(): React.ReactNode {
      const { state } = useOrchestratorState(testAppState)
      snapshots.push(state)
      return <Text>Agents: {Object.keys(state.agents).length}</Text>
    }

    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })

    root.render(<Harness />)
    await Bun.sleep(20)

    // Re-render without state change
    root.render(<Harness />)
    await Bun.sleep(20)

    root.unmount()
    stdin.end()
    stdout.end()

    expect(snapshots.length).toBeGreaterThanOrEqual(2)
    // Both snapshots must be the exact same object reference
    expect(snapshots[0]).toBe(snapshots[1]!)
  })

  test('reactive updates: hook re-renders when AppState receives event from bus', async () => {
    const states: AppStateData[] = []

    function Harness(): React.ReactNode {
      const { state } = useOrchestratorState(testAppState)
      states.push(state)
      return <Text>Count: {Object.keys(state.agents).length}</Text>
    }

    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })

    root.render(<Harness />)
    await Bun.sleep(20)

    expect(states[states.length - 1]!.agents['agent-1']).toBeUndefined()

    // Emit event through bus
    mockBus.emit({
      type: 'event',
      name: 'agent:created',
      payload: {
        agentId: 'agent-1',
        platformId: 'chatgpt',
      },
    })

    await waitForCondition(() => states.some(s => !!s.agents['agent-1']))

    root.unmount()
    stdin.end()
    stdout.end()

    const lastState = states[states.length - 1]!
    expect(lastState.agents['agent-1']).toBeDefined()
    expect(lastState.agents['agent-1']!.status).toBe('created')
  })

  test('unsubscribe cleanup: unmounted component unregisters listener cleanly', async () => {
    let renderCount = 0

    function Harness(): React.ReactNode {
      const { state } = useOrchestratorState(testAppState)
      renderCount++
      return <Text>{Object.keys(state.agents).length}</Text>
    }

    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })

    root.render(<Harness />)
    await Bun.sleep(20)
    const countBeforeUnmount = renderCount

    root.unmount()
    await Bun.sleep(20)

    // Emit events after unmount
    mockBus.emit({
      type: 'event',
      name: 'agent:created',
      payload: { agentId: 'agent-2', platformId: 'gemini' },
    })
    await Bun.sleep(30)

    stdin.end()
    stdout.end()

    // No re-renders must have occurred after unmount
    expect(renderCount).toBe(countBeforeUnmount)
  })

  test('idempotent init(): mounting and unmounting components does not trigger repeated hydrations', async () => {
    let hydrationCount = 0
    const originalHydrate = testAppState.hydrate.bind(testAppState)
    testAppState.hydrate = async () => {
      hydrationCount++
      return originalHydrate()
    }

    // Call init() once at bootstrap
    await testAppState.init()
    expect(hydrationCount).toBe(1)

    function Harness(): React.ReactNode {
      useOrchestratorState(testAppState)
      return <Text>Mounted</Text>
    }

    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })

    // Mount and unmount 5 times
    for (let i = 0; i < 5; i++) {
      root.render(<Harness />)
      await Bun.sleep(15)
      // Call init() concurrently or repeatedly
      await testAppState.init()
    }

    root.unmount()
    stdin.end()
    stdout.end()

    // Hydration must strictly have executed only 1 time
    expect(hydrationCount).toBe(1)
  })
})

// ─── 2. Commands Delegation ──────────────────────────────────────────────────

describe('2. Commands Delegation through AppState', () => {
  let mockBus: ReturnType<typeof createMockBus>
  let testAppState: AppState

  beforeEach(() => {
    mockBus = createMockBus()
    testAppState = new AppState({ bus: mockBus as unknown as RelayBus, autoInit: false })
  })

  afterEach(() => {
    testAppState.destroy()
  })

  test('actions.startAgent, stopAgent, restartAgent, removeAgent, selectAgent delegate to AppState', async () => {
    let capturedActions: UseOrchestratorStateResult['actions'] | null = null

    function Harness(): React.ReactNode {
      const { actions } = useOrchestratorState(testAppState)
      capturedActions = actions
      return <Text>Ready</Text>
    }

    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })

    root.render(<Harness />)
    await Bun.sleep(20)

    expect(capturedActions).not.toBeNull()
    const actions = capturedActions!

    // 1. startAgent
    await actions.startAgent('agent-1', 'chatgpt', 'coder')
    expect(mockBus.sentCommands).toContainEqual({
      type: 'command',
      name: 'agent:start',
      payload: { agentId: 'agent-1', platformId: 'chatgpt', role: 'coder' },
    })

    // 2. stopAgent
    await actions.stopAgent('agent-1')
    expect(mockBus.sentCommands).toContainEqual({
      type: 'command',
      name: 'agent:stop',
      payload: { agentId: 'agent-1' },
    })

    // 3. restartAgent
    await actions.restartAgent('agent-1')
    expect(mockBus.sentCommands).toContainEqual({
      type: 'command',
      name: 'agent:restart',
      payload: { agentId: 'agent-1' },
    })

    // 4. selectAgent (local UI presentation state in AppState)
    // Pre-populate agent in state so selectAgent accepts it
    mockBus.emit({
      type: 'event',
      name: 'agent:created',
      payload: { agentId: 'agent-1', platformId: 'chatgpt' },
    })
    actions.selectAgent('agent-1')
    expect(testAppState.getSelectedAgentId()).toBe('agent-1')

    // 5. acknowledgeUnknown
    const scanResult = await actions.scanSentinel()
    expect(scanResult.healthy).toBe(true)
    expect(mockBus.queriesReceived).toContainEqual({
      type: 'query',
      name: 'sentinel:scan',
    })

    // 6. acknowledgeUnknown
    await actions.acknowledgeUnknown('exec-1', 'agent-1')
    expect(mockBus.sentCommands).toContainEqual({
      type: 'command',
      name: 'execution:acknowledge-unknown',
      payload: { executionId: 'exec-1', agentId: 'agent-1' },
    })

    // 7. removeAgent
    await actions.removeAgent('agent-1')
    expect(mockBus.sentCommands).toContainEqual({
      type: 'command',
      name: 'agent:remove',
      payload: { agentId: 'agent-1' },
    })

    root.unmount()
    stdin.end()
    stdout.end()
  })
})

// ─── 3. Status Component Integration ─────────────────────────────────────────

describe('3. WebRelayOrchestrationSection Component', () => {
  let mockBus: ReturnType<typeof createMockBus>
  let testAppState: AppState

  beforeEach(() => {
    mockBus = createMockBus()
    testAppState = new AppState({ bus: mockBus as unknown as RelayBus, autoInit: false })
  })

  afterEach(() => {
    testAppState.destroy()
  })

  test('lifecycle colors are strictly distinguished: ready is green, lost is magenta, error is red', () => {
    expect(getLifecycleColor('ready')).toBe('green')
    expect(getLifecycleColor('lost')).toBe('magenta')
    expect(getLifecycleColor('error')).toBe('red')
    expect(getLifecycleColor('stopped')).toBeUndefined()
    expect(getLifecycleColor('starting')).toBe('yellow')
    expect(getLifecycleColor('chrome_ready')).toBe('yellow')
  })

  test('renders ready, lost, error and multiple agents without transforming lost to error', async () => {
    let outputText = ''
    const { stdout, stdin } = createTestStreams()
    stdout.on('data', chunk => {
      outputText += chunk.toString()
    })

    // Set up 3 distinct agents:
    // Agent 1: ready
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
      name: 'agent:lifecycle',
      payload: { agentId: 'agent-1', from: 'created', to: 'ready' },
    })

    // Agent 2: lost (Sentinel detected death)
    mockBus.emit({
      type: 'event',
      name: 'agent:created',
      payload: { agentId: 'agent-2', platformId: 'gemini' },
    })
    mockBus.emit({
      type: 'event',
      name: 'instance:bound',
      payload: { agentId: 'agent-2', instanceId: 'inst-2', debugPort: 9223 },
    })
    mockBus.emit({
      type: 'event',
      name: 'agent:lifecycle',
      payload: { agentId: 'agent-2', from: 'created', to: 'ready' },
    })
    mockBus.emit({
      type: 'event',
      name: 'instance:lost',
      payload: { instanceId: 'inst-2', agentId: 'agent-2' },
    })

    // Agent 3: error
    mockBus.emit({
      type: 'event',
      name: 'agent:created',
      payload: { agentId: 'agent-3', platformId: 'grok' },
    })
    mockBus.emit({
      type: 'event',
      name: 'agent:error',
      payload: { agentId: 'agent-3', error: 'Failed to bind port' },
    })

    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })

    root.render(<WebRelayOrchestrationSection customAppState={testAppState} />)
    await Bun.sleep(50)

    root.unmount()
    stdin.end()
    stdout.end()

    // Assert state content
    const state = testAppState.getState()
    expect(state.agents['agent-1']!.status).toBe('ready')
    expect(state.agents['agent-2']!.status).toBe('lost') // NOT transformed to error!
    expect(state.agents['agent-3']!.status).toBe('error')

    // Assert that output renders all 3 agents
    expect(outputText).toContain('Web Relay Orchestration')
    expect(outputText).toContain('agent-1 [chatgpt]')
    expect(outputText).toContain('ready')
    expect(outputText).toContain('agent-2 [gemini]')
    expect(outputText).toContain('lost')
    expect(outputText).toContain('agent-3 [grok]')
    expect(outputText).toContain('error')
  })
})

// ─── 4. MCP Status Integration ───────────────────────────────────────────────

describe('4. MCPStatus Component Integration', () => {
  test('/mcp sentinel opens the Sentinel console', async () => {
    const consoleView = await callMcpCommand(() => {}, {}, 'sentinel')
    expect(React.isValidElement(consoleView)).toBe(true)
  })

  test('/mcp set-mode web opens the instance and platform setup flow', async () => {
    const setupView = await callMcpCommand(() => {}, {}, 'set-mode web')
    expect(React.isValidElement(setupView)).toBe(true)
  })

  test('/mcp ask opens the coordinated Web Relay task runner', async () => {
    const taskView = await callMcpCommand(() => {}, {}, 'ask inspect the project')
    expect(React.isValidElement(taskView)).toBe(true)
    if (!React.isValidElement<{ task: string }>(taskView)) throw new Error('Expected the Web Relay task runner.')
    expect(taskView.props.task).toBe('inspect the project')
  })

  let mockBus: ReturnType<typeof createMockBus>
  let testAppState: AppState

  beforeEach(() => {
    mockBus = createMockBus()
    testAppState = new AppState({ bus: mockBus as unknown as RelayBus, autoInit: false })
  })

  afterEach(() => {
    testAppState.destroy()
  })

  test('MCPStatus formats Web Relay Orchestration block without executing Sentinel.scan()', async () => {
    // Populate sentinel scan result in AppState (from query or prior event)
    mockBus.emit({
      type: 'event',
      name: 'sentinel:scan',
      payload: {
        agentsChecked: 2,
        issuesFound: 0,
      },
    })
    mockBus.emit({
      type: 'event',
      name: 'agent:created',
      payload: {
        agentId: 'agent-mcp',
        platformId: 'chatgpt',
        role: 'primary',
        sessionMode: 'clean',
      },
    })
    mockBus.emit({
      type: 'event',
      name: 'instance:bound',
      payload: { agentId: 'agent-mcp', instanceId: 'inst-mcp', debugPort: 9222 },
    })
    mockBus.emit({
      type: 'event',
      name: 'agent:lifecycle',
      payload: { agentId: 'agent-mcp', from: 'created', to: 'ready' },
    })

    let completedMessage = ''
    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })

    root.render(
      <MCPStatus
        customAppState={testAppState}
        onComplete={(msg: string) => {
          completedMessage = msg
        }}
      />,
    )

    await waitForCondition(() => completedMessage.length > 0)

    root.unmount()
    stdin.end()
    stdout.end()

    expect(completedMessage).toContain('Web Relay Orchestration:')
    expect(completedMessage).toContain('Sentinel: healthy (2 checked, 0 issues)')
    expect(completedMessage).toContain('agent-mcp [chatgpt, agent, role primary]: ready, clean session')
    expect(completedMessage).toContain('port: 9222')
    expect(completedMessage).toContain('instance: inst-mcp')

    // Confirm that NO scan commands or scan queries were triggered
    const scanCommands = mockBus.sentCommands.filter(c => c.name?.includes('scan'))
    const scanQueries = mockBus.queriesReceived.filter(q => q.name === 'sentinel:scan')
    expect(scanCommands.length).toBe(0)
    expect(scanQueries.length).toBe(0)
  })
})

// ─── 5. Isolation ────────────────────────────────────────────────────────────

describe('5. Multi-Agent Isolation in TUI', () => {
  let mockBus: ReturnType<typeof createMockBus>
  let testAppState: AppState

  beforeEach(() => {
    mockBus = createMockBus()
    testAppState = new AppState({ bus: mockBus as unknown as RelayBus, autoInit: false })
  })

  afterEach(() => {
    testAppState.destroy()
  })

  test('Agent A lost leaves Agent B strictly ready with no identity mixing', () => {
    // Initialize Agent A and B to ready
    mockBus.emit({
      type: 'event',
      name: 'agent:created',
      payload: { agentId: 'agent-A', platformId: 'chatgpt' },
    })
    mockBus.emit({
      type: 'event',
      name: 'instance:bound',
      payload: { agentId: 'agent-A', instanceId: 'inst-A', debugPort: 9222 },
    })
    mockBus.emit({
      type: 'event',
      name: 'agent:lifecycle',
      payload: { agentId: 'agent-A', from: 'created', to: 'ready' },
    })

    mockBus.emit({
      type: 'event',
      name: 'agent:created',
      payload: { agentId: 'agent-B', platformId: 'gemini' },
    })
    mockBus.emit({
      type: 'event',
      name: 'instance:bound',
      payload: { agentId: 'agent-B', instanceId: 'inst-B', debugPort: 9223 },
    })
    mockBus.emit({
      type: 'event',
      name: 'agent:lifecycle',
      payload: { agentId: 'agent-B', from: 'created', to: 'ready' },
    })

    // Both are ready
    expect(testAppState.getAgent('agent-A')!.status).toBe('ready')
    expect(testAppState.getAgent('agent-B')!.status).toBe('ready')

    // Kill Agent A
    mockBus.emit({
      type: 'event',
      name: 'instance:lost',
      payload: { instanceId: 'inst-A', agentId: 'agent-A' },
    })

    const agentA = testAppState.getAgent('agent-A')!
    const agentB = testAppState.getAgent('agent-B')!

    expect(agentA.status).toBe('lost')
    expect(agentA.instanceId).toBe('inst-A')
    expect(agentA.debugPort).toBe(9222)

    // Agent B is completely untouched
    expect(agentB.status).toBe('ready')
    expect(agentB.instanceId).toBe('inst-B')
    expect(agentB.debugPort).toBe(9223)
  })
})

// ─── 6. Architectural Non-Contamination Check ────────────────────────────────

describe('6. Architectural Non-Contamination Check (Static Analysis)', () => {
  const forbiddenModules = [
    'ChromeCDP',
    'WebInstanceRegistry',
    'MultiAgentRunner',
    'Sentinel',
    'RelayBus',
    'ExecutionRegistry',
  ]

  const tuiFiles = [
    resolve(process.cwd(), 'src/hooks/useOrchestratorState.ts'),
    resolve(process.cwd(), 'src/components/Settings/Status.tsx'),
    resolve(process.cwd(), 'src/commands/mcp/mcp.tsx'),
  ]

  for (const filePath of tuiFiles) {
    test(`TUI file does not directly import infrastructure: ${filePath.split('\\').pop()}`, () => {
      const content = readFileSync(filePath, 'utf-8')

      for (const forbidden of forbiddenModules) {
        // Regex matches `import ... from '...forbidden...'`
        const importRegex = new RegExp(`from\\s+['"][^'"]*${forbidden}(\\.[a-z]+)?['"]`, 'g')
        const matches = content.match(importRegex)

        expect(matches).toBeNull()
      }
    })
  }
})
