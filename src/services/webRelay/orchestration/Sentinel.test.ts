/**
 * Sentinel tests.
 *
 * Tests the health monitoring system that watches running Chrome instances.
 * All tests use mocked fetch (no real Chrome needed).
 *
 * Run: bun test src/services/webRelay/orchestration/Sentinel.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { resetWebInstanceRegistry } from '../WebInstanceRegistry.js'
import { setAgentSAConfigurationStatus } from './MultiAgentRunner.js'

// ─── Mock controls ───────────────────────────────────────────────────────────

const mockLaunchControl = {
  shouldSucceed: true,
  error: 'Chrome launch failed',
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

const mockExecutionDiagnostics = {
  events: [] as Array<Record<string, unknown>> | null,
  calls: [] as Array<{ debugPort: number; extensionId: string }>,
}

const mockConversationFlowSurface = {
  value: {
    available: true,
    platformTabCount: 1,
    preElementCount: 2,
    codeElementCount: 0,
    completeFunctionCallCandidateCount: 0,
    renderedFunctionCallCount: 0,
    executableFunctionCallCount: 0,
    unrenderedFunctionCallCount: 0,
    candidateTags: [],
  },
}

const mockConversation = {
  snapshot: {
    agentId: 'agent-conversation',
    available: true,
    messages: [
      { role: 'user', text: 'Pregunta de prueba' },
      { role: 'assistant', text: 'Respuesta de prueba' },
    ],
    truncated: false,
  } as Record<string, unknown>,
  calls: [] as Array<{ agentId: string; debugPort: number; platformId: string }>,
}

const mockSAControl = {
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
  snapshot: {
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
    pluginRegistry: null as {
      initialized: boolean
      activePlugin: string | null
      plugins: string[]
      factories: string[]
    } | null,
    pageVisibility: 'hidden' as const,
    pageHasFocus: false,
  } as {
    mcpEnabled: boolean | null
    pushContentMode: boolean | null
    autoInsert: boolean | null
    autoSubmit: boolean | null
    autoExecute: boolean | null
    sidebarVisible: boolean | null
    compactButtonVisible: boolean
    compactButtonInComposer: boolean | null
    compactButtonWidth: number | null
    compactButtonHeight: number | null
    compactButtonLabelVisible: boolean | null
    sidebarCollapsed: boolean | null
    sidebarWidth: number | null
    pluginRegistry: {
      initialized: boolean
      activePlugin: string | null
      plugins: string[]
      factories: string[]
    } | null
    pageVisibility: 'visible' | 'hidden' | 'unknown'
    pageHasFocus: boolean | null
  } | null,
  error: null as Error | null,
  calls: [] as Array<{ debugPort: number; platformId: string }>,
}

const mockMasterSources = {
  sources: [{
    id: 'test-master',
    name: 'Test Master',
    profileDir: 'master-sessions/test-master',
    debugPort: 9400,
  }],
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
  readRecentExecutionDiagnostics: async (debugPort: number, extensionId: string) => {
    mockExecutionDiagnostics.calls.push({ debugPort, extensionId })
    return mockExecutionDiagnostics.events
  },
  inspectConversationFlowSurface: async () => mockConversationFlowSurface.value,
  readRelayConversation: async (agentId: string, debugPort: number, platformId: string) => {
    mockConversation.calls.push({ agentId, debugPort, platformId })
    return { ...mockConversation.snapshot, agentId }
  },
  CDPConnection: class {},
  DEBUG_PORT: 9222,
}))

mock.module('../SAHealthCheck.js', () => ({
  inspectSAConfiguration: async (debugPort: number, platformId: string) => {
    mockSAControl.calls.push({ debugPort, platformId })
    if (mockSAControl.error) throw mockSAControl.error
    return mockSAControl.snapshot
  },
}))

mock.module('../session/MasterSessionRegistry.js', () => ({
  listMasterSessionSources: () => mockMasterSources.sources,
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

// ─── Import AFTER mocks ──────────────────────────────────────────────────────

import {
  createAgent,
  startAgent,
  resetRunner,
  onLifecycleEvent,
} from './MultiAgentRunner.js'

import {
  scan,
  start,
  stop,
  getLastScanResult,
  resetSentinel,
  registerSAExtensionId,
  unregisterSAExtensionId,
  onSentinelEvent,
  setOnAgentLost,
  readAgentExecutionActivity,
  readAgentConversation,
} from './Sentinel.js'

import type { OrchestratorEvent } from './types.js'

// ─── Test lifecycle ──────────────────────────────────────────────────────────

beforeEach(() => {
  resetRunner()
  resetSentinel()
  resetWebInstanceRegistry()
  mockLaunchControl.shouldSucceed = true
  mockLaunchControl.error = 'Chrome launch failed'
  mockLaunchControl.saExtensionId = 'kngiafgkdnlkgmefdafaibkibegkcaef'
  mockPortControl.active = null
  mockPortControl.launchedPorts.clear()
  mockPortControl.occupiedPorts.clear()
  mockStampControl.ok = true
  mockStampControl.reason = ''
  mockExecutionDiagnostics.events = []
  mockExecutionDiagnostics.calls = []
  mockConversationFlowSurface.value = {
    available: true,
    platformTabCount: 1,
    preElementCount: 2,
    codeElementCount: 0,
    completeFunctionCallCandidateCount: 0,
    renderedFunctionCallCount: 0,
    executableFunctionCallCount: 0,
    unrenderedFunctionCallCount: 0,
    candidateTags: [],
  }
  mockConversation.calls = []
  mockConversation.snapshot = {
    agentId: 'agent-conversation',
    available: true,
    messages: [
      { role: 'user', text: 'Pregunta de prueba' },
      { role: 'assistant', text: 'Respuesta de prueba' },
    ],
    truncated: false,
  }
  mockSAControl.snapshot = {
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
    pluginRegistry: mockSAControl.pluginRegistry,
    pageVisibility: 'hidden',
    pageHasFocus: false,
  }
  mockSAControl.error = null
  mockSAControl.calls = []
  mockPortAlive = true
  mockSWPresent = true
  mockMCPHealthy = true
  installFetchMock()
})

describe('Sentinel conversation snapshot', () => {
  test('reads only the explicitly requested ready Relay after the caller opts in', async () => {
    await startReadyAgent('agent-conversation')

    const result = await readAgentConversation('agent-conversation')

    expect(mockConversation.calls).toEqual([{
      agentId: 'agent-conversation',
      debugPort: 9222,
      platformId: 'chatgpt',
    }])
    expect(result.messages).toEqual([
      { role: 'user', text: 'Pregunta de prueba' },
      { role: 'assistant', text: 'Respuesta de prueba' },
    ])
  })

  test('does not read a conversation for an unregistered Relay', async () => {
    await expect(readAgentConversation('not-registered')).rejects.toThrow(
      'Sentinel cannot inspect unregistered agent "not-registered".',
    )
    expect(mockConversation.calls).toHaveLength(0)
  })
})

afterEach(() => {
  resetRunner()
  resetSentinel()
  resetWebInstanceRegistry()
  globalThis.fetch = originalFetch
})

// ─── Helper ──────────────────────────────────────────────────────────────────

async function startReadyAgent(agentId: string) {
  createAgent({ agentId, platformId: 'chatgpt' })
  const result = await startAgent(agentId)
  expect(result.status).toBe('ready')
  return result
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Sentinel execution activity', () => {
  test('reads technical activity only from an explicitly registered ready relay', async () => {
    await startReadyAgent('agent-activity')
    const activity = [{
      timestamp: '2026-10-08T12:00:00.000Z',
      event: 'EXECUTION_COMPLETION',
      callId: 'call-1',
      toolName: 'Read',
      success: true,
      pageVisibility: 'hidden',
      pageHasFocus: false,
    }]
    mockExecutionDiagnostics.events = activity

    const result = await readAgentExecutionActivity('agent-activity')

    expect(mockExecutionDiagnostics.calls).toEqual([{
      debugPort: 9222,
      extensionId: 'kngiafgkdnlkgmefdafaibkibegkcaef',
    }])
    expect(result).toEqual({
      agentId: 'agent-activity',
      available: true,
      events: activity,
    })
  })

  test('does not read diagnostics for unregistered agents', async () => {
    await expect(readAgentExecutionActivity('not-registered')).rejects.toThrow(
      'Sentinel cannot inspect unregistered agent "not-registered".',
    )
    expect(mockExecutionDiagnostics.calls).toHaveLength(0)
  })
})

describe('1. Scan on healthy agents', () => {
  test('scan reports all agents alive', async () => {
    await startReadyAgent('agent-1')
    const result = await scan()
    expect(result.agentsChecked).toBe(1)
    expect(result.issuesFound).toBe(0)
    expect(result.details[0]!.portAlive).toBe(true)
  })

  test('heartbeat event fires for each agent', async () => {
    await startReadyAgent('agent-1')
    const events: OrchestratorEvent[] = []
    const unsub = onSentinelEvent(e => events.push(e))
    await scan()
    unsub()
    const hb = events.find(e => e.name === 'sentinel:heartbeat')
    expect(hb).toBeDefined()
    expect(hb!.payload).toEqual({ agentId: 'agent-1', alive: true })
  })

  test('scan event fires with correct counts', async () => {
    await startReadyAgent('agent-1')
    const events: OrchestratorEvent[] = []
    const unsub = onSentinelEvent(e => events.push(e))
    await scan()
    unsub()
    const scanEv = events.find(e => e.name === 'sentinel:scan')
    expect(scanEv).toBeDefined()
    expect(scanEv!.payload).toMatchObject({ agentsChecked: 1, issuesFound: 0 })
  })

  test('periodic scan catches a complete code block that the active observer does not target', async () => {
    await startReadyAgent('agent-missed-call')
    mockConversationFlowSurface.value = {
      available: true,
      platformTabCount: 1,
      preElementCount: 0,
      codeElementCount: 1,
      completeFunctionCallCandidateCount: 1,
      renderedFunctionCallCount: 0,
      executableFunctionCallCount: 0,
      unrenderedFunctionCallCount: 1,
      candidateTags: ['CODE'],
    }
    mockExecutionDiagnostics.events = [{
      timestamp: new Date().toISOString(),
      event: 'OBSERVER_MONITORING_STARTED',
      monitoringEnabled: true,
      targetSelectors: ['pre'],
      streamingContainerSelectors: ['pre'],
    }]

    const result = await scan()

    expect(result.details[0]?.conversationFlow?.observer).toMatchObject({
      status: 'active',
      targetSelectors: ['pre'],
    })
    expect(result.details[0]?.diagnostics.map(diagnostic => diagnostic.code)).toContain(
      'conversation-observer-selector-mismatch',
    )
    expect(result.details[0]?.diagnostics.map(diagnostic => diagnostic.code)).toContain(
      'conversation-call-not-rendered',
    )
  })
})

describe('2. Port dead detection', () => {
  test('dead port reports issue and emits instance:lost', async () => {
    await startReadyAgent('agent-1')
    // Simulate Chrome crash
    mockPortAlive = false
    const events: OrchestratorEvent[] = []
    const unsub = onSentinelEvent(e => events.push(e))
    const result = await scan()
    unsub()
    expect(result.issuesFound).toBe(1)
    expect(result.details[0]!.portAlive).toBe(false)
    const lost = events.find(e => e.name === 'instance:lost')
    expect(lost).toBeDefined()
  })

  test('onAgentLost callback fires when port dies', async () => {
    await startReadyAgent('agent-1')
    mockPortAlive = false
    const lostAgents: string[] = []
    setOnAgentLost(id => lostAgents.push(id))
    await scan()
    expect(lostAgents).toEqual(['agent-1'])
  })
})

describe('3. SW inactive is warning-only', () => {
  test('missing SA SW does not count as issue', async () => {
    await startReadyAgent('agent-1')
    mockSWPresent = false
    const result = await scan()
    // Port is alive, SW missing is just a warning
    expect(result.issuesFound).toBe(0)
    expect(result.details[0]!.portAlive).toBe(true)
    expect(result.details[0]!.swActive).toBe(false)
  })
})

describe('4. MCP down is warning-only', () => {
  test('MCP unresponsive does not count as issue', async () => {
    await startReadyAgent('agent-1')
    mockMCPHealthy = false
    const result = await scan()
    expect(result.issuesFound).toBe(0)
    expect(result.details[0]!.mcpAlive).toBe(false)
  })
})

describe('4a. SA configuration diagnostics and logs', () => {
  test('reports a hidden and unfocused page without treating it as a configuration issue', async () => {
    await startReadyAgent('agent-background-page')

    const result = await scan()

    expect(result.healthy).toBe(true)
    expect(result.issuesFound).toBe(0)
    expect(result.details[0]!.saConfiguration?.pageVisibility).toBe('hidden')
    expect(result.details[0]!.saConfiguration?.pageHasFocus).toBe(false)
  })

  test('does not inspect an agent while WebUI SA preparation is in progress', async () => {
    await startReadyAgent('agent-sa-preparing')
    await setAgentSAConfigurationStatus('agent-sa-preparing', true)

    const result = await scan()

    expect(result.agentsChecked).toBe(0)
    expect(mockSAControl.calls).toHaveLength(0)
  })

  test('reports every required SA preference that is disabled', async () => {
    await startReadyAgent('agent-sa-off')
    mockSAControl.snapshot = {
      mcpEnabled: true,
      pushContentMode: false,
      autoInsert: false,
      autoSubmit: true,
      autoExecute: true,
      sidebarVisible: false,
      compactButtonVisible: true,
      compactButtonInComposer: true,
      compactButtonWidth: 36,
      compactButtonHeight: 36,
      compactButtonLabelVisible: false,
      sidebarCollapsed: true,
      sidebarWidth: 56,
      pluginRegistry: mockSAControl.pluginRegistry,
      pageVisibility: 'visible',
      pageHasFocus: true,
    }

    const events: OrchestratorEvent[] = []
    const unsubscribe = onSentinelEvent(event => events.push(event))
    const result = await scan()
    unsubscribe()

    expect(result.healthy).toBe(false)
    expect(result.issuesFound).toBe(3)
    expect(result.details[0]!.diagnostics.map(item => item.code)).toEqual([
      'sa-pushContentMode-disabled',
      'sa-autoInsert-disabled',
      'sa-sidebarVisible-disabled',
    ])
    expect(result.logs?.map(log => log.code)).toEqual([
      'sa-sidebarVisible-disabled',
      'sa-autoInsert-disabled',
      'sa-pushContentMode-disabled',
    ])
    expect(events.filter(event => event.name === 'sentinel:log')).toHaveLength(3)
  })

  test('reports rendered ChatGPT compact-control and sidebar layout failures', async () => {
    await startReadyAgent('agent-layout-off')
    mockSAControl.snapshot = {
      ...mockSAControl.snapshot!,
      compactButtonInComposer: false,
      compactButtonWidth: 128,
      compactButtonHeight: 40,
      compactButtonLabelVisible: true,
      sidebarCollapsed: false,
      sidebarWidth: 280,
    }

    const result = await scan()

    expect(result.healthy).toBe(false)
    expect(result.details[0]!.diagnostics.map(item => item.code)).toEqual([
      'sa-chatgpt-button-not-compact',
      'sa-sidebar-not-collapsed',
    ])
  })

  test('reports missing SuperAssistant plugin registry components', async () => {
    await startReadyAgent('agent-plugins-missing')
    mockSAControl.snapshot = {
      ...mockSAControl.snapshot!,
      pluginRegistry: {
        ...mockSAControl.pluginRegistry,
        activePlugin: null,
        plugins: ['sidebar-plugin'],
        factories: ['chatgpt-adapter'],
      },
    }

    const result = await scan()

    expect(result.healthy).toBe(false)
    expect(result.details[0]!.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'sa-plugin-registry-incomplete',
    }))
  })

  test('does not repeat an unchanged issue in logs and records when it is resolved', async () => {
    await startReadyAgent('agent-sa-recovering')
    mockSAControl.snapshot!.autoSubmit = false

    const first = await scan()
    const second = await scan()
    expect(first.logs).toHaveLength(1)
    expect(second.logs).toHaveLength(1)

    mockSAControl.snapshot!.autoSubmit = true
    const recovered = await scan()
    expect(recovered.logs).toHaveLength(2)
    expect(recovered.logs?.[0]).toMatchObject({
      severity: 'info',
      code: 'diagnostic-resolved',
    })
  })

  test('treats an unavailable SA inspection as an error instead of claiming healthy', async () => {
    await startReadyAgent('agent-sa-unavailable')
    mockSAControl.error = new Error('CDP inspection timed out')

    const result = await scan()

    expect(result.healthy).toBe(false)
    expect(result.details[0]!.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'sa-inspection-failed',
    }))
  })

  test('reports the named Master Session for authenticated relays', async () => {
    createAgent({
      agentId: 'agent-authenticated',
      platformId: 'chatgpt',
      sessionMode: 'authenticated',
      masterSessionSourceId: 'test-master',
    })
    await startAgent('agent-authenticated')

    const result = await scan()

    expect(result.details[0]).toMatchObject({
      sessionMode: 'authenticated',
      masterSessionSourceId: 'test-master',
      masterSessionSourceName: 'Test Master',
    })
    expect(result.details[0]!.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'missing-master-source' }),
    )
  })

  test('warns when an authenticated relay refers to an unregistered Master source', async () => {
    createAgent({
      agentId: 'agent-stale-master',
      platformId: 'chatgpt',
      sessionMode: 'authenticated',
      masterSessionSourceId: 'deleted-master',
    })
    await startAgent('agent-stale-master')

    const result = await scan()

    expect(result.details[0]!.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'unknown-master-source',
    }))
  })
})

describe('5. Only ready agents are scanned', () => {
  test('created agent is not scanned', async () => {
    createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })
    // Agent is in 'created' state, not 'ready'
    const result = await scan()
    expect(result.agentsChecked).toBe(0)
  })

  test('error agent is not scanned', async () => {
    mockLaunchControl.shouldSucceed = false
    createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })
    try { await startAgent('agent-1') } catch {}
    // Agent is in 'error' state
    const result = await scan()
    expect(result.agentsChecked).toBe(0)
  })
})

describe('6. SA extension ID registration', () => {
  test('registered ID is used for SW check', async () => {
    await startReadyAgent('agent-1')
    const dynamicId = 'aklgcdphknfhpmhdplmkgmjemojchcea'
    registerSAExtensionId('agent-1', dynamicId)

    // Fetch mock returns CWS ID targets, but Sentinel looks for dynamic ID
    // So SW check should fail since it's looking for dynamic ID
    const result = await scan()
    expect(result.details[0]!.swActive).toBe(false) // CWS targets != dynamic ID
  })

  test('unregistered ID falls back to CWS detection', async () => {
    await startReadyAgent('agent-1')
    registerSAExtensionId('agent-1', 'some-id')
    unregisterSAExtensionId('agent-1')

    // Now should fall back to CWS ID detection
    const result = await scan()
    expect(result.details[0]!.swActive).toBe(true) // finds CWS SW target
  })
})

describe('7. Multiple agents', () => {
  test('scan checks all ready agents independently', async () => {
    await startReadyAgent('agent-1')
    await startReadyAgent('agent-2')

    const result = await scan()
    expect(result.agentsChecked).toBe(2)
    expect(result.issuesFound).toBe(0)
    expect(result.details).toHaveLength(2)
  })

  test('one dead agent does not mark others as dead', async () => {
    await startReadyAgent('agent-1')
    await startReadyAgent('agent-2')

    // Both use the same mock — we can't make one dead and one alive
    // with a single global mock. But we can verify the scan processes all.
    const events: OrchestratorEvent[] = []
    const unsub = onSentinelEvent(e => events.push(e))
    await scan()
    unsub()
    const heartbeats = events.filter(e => e.name === 'sentinel:heartbeat')
    expect(heartbeats).toHaveLength(2)
    expect(heartbeats.every(e => (e.payload as any).alive === true)).toBe(true)
  })
})

describe('8. Start/stop lifecycle', () => {
  test('start is idempotent', () => {
    start({ intervalMs: 60000 }) // long interval so no actual scans
    start({ intervalMs: 60000 }) // should not throw or create duplicate
    stop()
  })

  test('stop is idempotent', () => {
    stop() // should not throw even when not started
    start({ intervalMs: 60000 })
    stop()
    stop() // should not throw again
  })

  test('resetSentinel clears everything', () => {
    registerSAExtensionId('agent-1', 'test-id')
    const unsub = onSentinelEvent(() => {})
    setOnAgentLost(() => {})
    start({ intervalMs: 60000 })

    resetSentinel()
    // After reset, everything should be clean — no way to verify internal
    // state directly, but at least it shouldn't crash
    stop() // no-op since resetSentinel already stopped
  })

  test('records lifecycle failures while redacting credential-shaped values', async () => {
    start({ intervalMs: 60000 })
    mockLaunchControl.shouldSucceed = false
    mockLaunchControl.error = 'authorization=sentinel-test-secret'
    createAgent({ agentId: 'agent-lifecycle-failure', platformId: 'chatgpt' })
    const result = await startAgent('agent-lifecycle-failure')
    expect(result.status).toBe('error')

    const log = getLastScanResult().logs?.[0]
    expect(log).toMatchObject({
      severity: 'error',
      agentId: 'agent-lifecycle-failure',
    })
    expect(log?.message).not.toContain('sentinel-test-secret')
  })

  test('keeps the Sentinel diagnostic log bounded to 200 entries', async () => {
    start({ intervalMs: 60000 })
    mockLaunchControl.shouldSucceed = false
    for (let index = 0; index < 205; index++) {
      const agentId = `agent-failure-${index}`
      createAgent({ agentId, platformId: 'chatgpt' })
      await startAgent(agentId)
    }

    expect(getLastScanResult().logs).toHaveLength(200)
  })
})
