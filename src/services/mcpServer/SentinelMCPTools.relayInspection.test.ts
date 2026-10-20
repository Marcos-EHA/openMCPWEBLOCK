import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const relay = {
  agentId: 'diagnostic-relay',
  platformId: 'chatgpt',
  role: 'manual-user-1',
  status: 'ready',
  sessionMode: 'clean',
  instanceId: 'instance-diagnostic',
  saExtensionId: 'sa-extension-id',
  debugPort: 9222,
  activeExecutions: 0,
  unknownExecutions: 0,
  createdAt: Date.now(),
}

const cdpControl = {
  tabs: [
    {
      id: 'chatgpt-tab',
      url: 'https://chatgpt.com/',
      title: 'ChatGPT',
      webSocketDebuggerUrl: 'ws://debug/chatgpt',
      type: 'page',
    },
  ],
  contexts: [{
    id: 4,
    name: 'MCP SuperAssistant',
    origin: 'chrome-extension://sa-extension-id',
  }],
  runtimeMessagingAvailable: true,
  connectError: null as string | null,
  closed: false,
  conversationFlowSurface: {
    available: true,
    platformTabCount: 1,
    preElementCount: 0,
    codeElementCount: 0,
    completeFunctionCallCandidateCount: 0,
    renderedFunctionCallCount: 0,
    executableFunctionCallCount: 0,
    unrenderedFunctionCallCount: 0,
    candidateTags: [],
  },
}

const masterSessionState = {
  sources: [] as Array<{
    id: string
    name: string
    platformId: string
    profileDir: string
    debugPort: number
  }>,
  activeDebugPort: null as number | null,
  platformUrl: 'https://chat.openai.com/',
}

const activity = {
  agentId: relay.agentId,
  available: true,
  events: [],
}

const completePluginRegistry = {
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
}

const saConfiguration: {
  mcpEnabled: boolean
  pushContentMode: boolean
  autoInsert: boolean
  autoSubmit: boolean
  autoExecute: boolean
  sidebarVisible: boolean
  compactButtonVisible: boolean
  compactButtonInComposer: boolean | null
  compactButtonWidth: number | null
  compactButtonHeight: number | null
  compactButtonLabelVisible: boolean | null
  sidebarCollapsed: boolean | null
  sidebarWidth: number | null
  pluginRegistry: typeof completePluginRegistry | null
  pageVisibility: string
  pageHasFocus: boolean
} = {
  mcpEnabled: true,
  pushContentMode: true,
  autoInsert: true,
  autoSubmit: true,
  autoExecute: true,
  sidebarVisible: true,
  compactButtonVisible: false,
  compactButtonInComposer: false,
  compactButtonWidth: null,
  compactButtonHeight: null,
  compactButtonLabelVisible: null,
  sidebarCollapsed: true,
  sidebarWidth: 56,
  pluginRegistry: completePluginRegistry,
  pageVisibility: 'hidden',
  pageHasFocus: false,
}

mock.module('../webRelay/orchestration/MultiAgentRunner.js', () => ({
  listAgents: () => [relay],
}))

mock.module('../webRelay/orchestration/Sentinel.js', () => ({
  readAgentExecutionActivity: async () => activity,
  readAgentConversation: async () => {
    throw new Error('Conversation should not be read by default')
  },
}))

mock.module('../webRelay/ChromeCDP.js', () => ({
  inspectConversationFlowSurface: async () => cdpControl.conversationFlowSurface,
  CDPConnection: class {
    async listTabs() {
      return cdpControl.tabs
    }

    async connect() {
      if (cdpControl.connectError) throw new Error(cdpControl.connectError)
    }

    async checkPageState() {
      return {
        hasSA: false,
        hasInput: false,
        isLoggedIn: false,
        platform: 'chatgpt',
        isGenerating: false,
        url: 'https://chatgpt.com/',
      }
    }

    async listExecutionContexts() {
      return cdpControl.contexts
    }

    async evaluate(expression: string, contextId?: number) {
      if (contextId === 4) return cdpControl.runtimeMessagingAvailable
      return expression === 'document.visibilityState' ? 'hidden' : false
    }

    close() {
      cdpControl.closed = true
    }
  },
}))

mock.module('../webRelay/SAHealthCheck.js', () => ({
  inspectSAConfiguration: async () => saConfiguration,
  checkSAPluginRegistry: (registry: typeof completePluginRegistry | null, platformId: string) => {
    const expectedAdapter = platformId === 'chatgpt' ? 'ChatGPTAdapter' : null
    return {
      ready: registry?.initialized === true &&
        registry.activePlugin === expectedAdapter &&
        registry.plugins.includes('remote-config-plugin') &&
        registry.plugins.includes('sidebar-plugin') &&
        registry.factories.length === 16,
      initialized: registry?.initialized === true,
      activePlugin: registry?.activePlugin ?? null,
      expectedAdapter,
      missingCorePlugins: registry?.plugins.includes('remote-config-plugin') &&
        registry.plugins.includes('sidebar-plugin') ? [] : ['required-core-plugin'],
      missingFactories: registry?.factories.length === 16 ? [] : ['built-in-factories'],
    }
  },
}))

mock.module('../webRelay/session/MasterSessionRegistry.js', () => ({
  listMasterSessionSources: () => masterSessionState.sources,
}))

mock.module('../webRelay/session/SessionBroker.js', () => ({
  findActiveMasterPort: async () => masterSessionState.activeDebugPort,
}))

mock.module('../../utils/webPlatforms.js', () => ({
  getWebPlatformById: () => ({ url: masterSessionState.platformUrl }),
}))

import { getSentinelMCPTools } from './SentinelMCPTools.js'

const originalFetch = globalThis.fetch

beforeEach(() => {
  cdpControl.closed = false
  cdpControl.tabs = [
    {
      id: 'chatgpt-tab',
      url: 'https://chatgpt.com/',
      title: 'ChatGPT',
      webSocketDebuggerUrl: 'ws://debug/chatgpt',
      type: 'page',
    },
  ]
  cdpControl.contexts = [{
    id: 4,
    name: 'MCP SuperAssistant',
    origin: 'chrome-extension://sa-extension-id',
  }]
  cdpControl.runtimeMessagingAvailable = true
  cdpControl.connectError = null
  cdpControl.conversationFlowSurface = {
    available: true,
    platformTabCount: 1,
    preElementCount: 0,
    codeElementCount: 0,
    completeFunctionCallCandidateCount: 0,
    renderedFunctionCallCount: 0,
    executableFunctionCallCount: 0,
    unrenderedFunctionCallCount: 0,
    candidateTags: [],
  }
  activity.events = []
  masterSessionState.sources = []
  masterSessionState.activeDebugPort = null
  masterSessionState.platformUrl = 'https://chat.openai.com/'
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith('/json/list')) {
      return new Response(JSON.stringify([
        ...cdpControl.tabs,
        {
          id: 'sa-worker',
          type: 'service_worker',
          url: 'chrome-extension://sa-extension-id/background.js',
        },
      ]), { status: 200 })
    }
    return new Response(JSON.stringify({
      running: true,
      connections: 3,
      tools: 44,
    }), { status: 200 })
  }) as typeof fetch
})

describe('sentinel_list_instances Master platform matching', () => {
  test('recognizes chatgpt.com when the registered ChatGPT URL is chat.openai.com', async () => {
    masterSessionState.sources = [{
      id: 'carlos',
      name: 'Carlos',
      platformId: 'chatgpt',
      profileDir: 'master-sessions/carlos',
      debugPort: 9405,
    }]
    masterSessionState.activeDebugPort = 9405
    cdpControl.tabs = [{
      id: 'master-chatgpt-tab',
      url: 'https://chatgpt.com/c/active',
      title: 'ChatGPT',
      webSocketDebuggerUrl: 'ws://debug/master-chatgpt',
      type: 'page',
    }]

    const inventory = JSON.parse(await listInstancesTool().execute({}))
    expect(inventory.masterSessions).toMatchObject([{
      sourceId: 'carlos',
      active: true,
      debugPort: 9405,
      tabs: [{
        url: 'https://chatgpt.com/c/active',
        platformMatch: true,
      }],
    }])
  })
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.assign(saConfiguration, {
    compactButtonVisible: false,
    compactButtonInComposer: false,
    compactButtonWidth: null,
    compactButtonHeight: null,
    compactButtonLabelVisible: null,
    sidebarCollapsed: true,
    sidebarWidth: 56,
    pluginRegistry: completePluginRegistry,
  })
  mock.restore()
})

function inspectTool() {
  const found = getSentinelMCPTools().find(candidate => candidate.name === 'sentinel_inspect_instance')
  if (!found) throw new Error('sentinel_inspect_instance is not registered.')
  return found
}

function listInstancesTool() {
  const found = getSentinelMCPTools().find(candidate => candidate.name === 'sentinel_list_instances')
  if (!found) throw new Error('sentinel_list_instances is not registered.')
  return found
}

describe('sentinel_inspect_instance Relay diagnostics', () => {
  test('lets an MCP client discover a registered Relay and inspect it by agentId', async () => {
    const listTool = getSentinelMCPTools().find(candidate => candidate.name === 'sentinel_list_instances')
    if (!listTool) throw new Error('sentinel_list_instances is not registered.')
    const inventory = JSON.parse(await listTool.execute({}))
    const discovered = inventory.agents.find((item: { agentId: string }) =>
      item.agentId === relay.agentId,
    )

    expect(discovered).toMatchObject({
      agentId: relay.agentId,
      instanceId: relay.instanceId,
      debugPort: relay.debugPort,
      status: 'ready',
    })

    const result = JSON.parse(await inspectTool().execute({ agentId: discovered.agentId }))
    expect(result.diagnostic.identity).toMatchObject({
      agentId: relay.agentId,
      instanceId: relay.instanceId,
    })
  })

  test('returns correlated read-only layers without reading conversation content', async () => {
    const result = JSON.parse(await inspectTool().execute({ agentId: relay.agentId }))

    expect(result.diagnostic.identity).toMatchObject({
      agentId: relay.agentId,
      instanceId: relay.instanceId,
      debugPort: 9222,
      status: 'ready',
    })
    expect(result.diagnostic.page).toMatchObject({
      available: true,
      platformTabCount: 1,
      origin: 'https://chatgpt.com',
      hasSuperAssistantDom: false,
      hasComposerCandidate: false,
      visibility: 'hidden',
      focused: false,
    })
    expect(result.diagnostic.superAssistant.configuration.compactButtonVisible).toBe(false)
    expect(result.diagnostic.superAssistant.configuration).toMatchObject({
      compactButtonInComposer: false,
      compactButtonWidth: null,
      compactButtonHeight: null,
      compactButtonLabelVisible: null,
      sidebarCollapsed: true,
      sidebarWidth: 56,
      pluginRegistry: completePluginRegistry,
    })
    expect(result.diagnostic.superAssistant).toMatchObject({
      serviceWorkerActive: true,
      executionContextPresent: true,
      runtimeMessagingAvailable: true,
    })
    expect(result.diagnostic.mcpServer).toMatchObject({
      scope: 'process-wide',
      available: true,
      connections: 3,
      tools: 44,
    })
    expect(result.diagnostic.diagnostics.map((item: { code: string }) => item.code)).toContain(
      'sa-dom-not-mounted',
    )
    expect(result.diagnostic.limits).toContain(
      'MCP connection count is process-wide and is not proof that this Relay has an active SA MCP connection.',
    )
    expect(result).not.toHaveProperty('conversation')
    expect(cdpControl.closed).toBe(true)
  })

  test('does not choose arbitrarily when multiple platform tabs are open', async () => {
    cdpControl.tabs.push({
      id: 'second-chatgpt-tab',
      url: 'https://chat.openai.com/',
      title: 'ChatGPT',
      webSocketDebuggerUrl: 'ws://debug/second-chatgpt',
      type: 'page',
    })

    const result = JSON.parse(await inspectTool().execute({ agentId: relay.agentId }))

    expect(result.diagnostic.page).toMatchObject({
      available: false,
      platformTabCount: 2,
    })
    expect(result.diagnostic.diagnostics).toContainEqual(expect.objectContaining({
      code: 'multiple-platform-tabs',
    }))
    expect(result.diagnostic.superAssistant.configuration).toBeNull()
    expect(result.diagnostic.diagnostics).toContainEqual(expect.objectContaining({
      code: 'sa-configuration-not-inspected',
    }))
    expect(cdpControl.closed).toBe(true)
  })

  test('distinguishes an installed extension worker from a missing page execution context', async () => {
    cdpControl.contexts = []

    const result = JSON.parse(await inspectTool().execute({ agentId: relay.agentId }))

    expect(result.diagnostic.superAssistant).toMatchObject({
      serviceWorkerActive: true,
      executionContextPresent: false,
      runtimeMessagingAvailable: null,
    })
    expect(result.diagnostic.diagnostics).toContainEqual(expect.objectContaining({
      code: 'sa-execution-context-not-found',
      severity: 'error',
    }))
    expect(result.diagnostic.diagnostics).not.toContainEqual(expect.objectContaining({
      code: 'sa-service-worker-inactive',
    }))
    expect(cdpControl.closed).toBe(true)
  })

  test('reports unavailable messaging from a present SuperAssistant context', async () => {
    cdpControl.runtimeMessagingAvailable = false

    const result = JSON.parse(await inspectTool().execute({ agentId: relay.agentId }))

    expect(result.diagnostic.superAssistant.executionContextPresent).toBe(true)
    expect(result.diagnostic.superAssistant.runtimeMessagingAvailable).toBe(false)
    expect(result.diagnostic.diagnostics).toContainEqual(expect.objectContaining({
      code: 'sa-runtime-messaging-unavailable',
      severity: 'error',
    }))
    expect(cdpControl.closed).toBe(true)
  })

  test('reports visible but non-compact ChatGPT control and expanded sidebar', async () => {
    Object.assign(saConfiguration, {
      compactButtonVisible: true,
      compactButtonInComposer: false,
      compactButtonWidth: 128,
      compactButtonHeight: 40,
      compactButtonLabelVisible: true,
      sidebarCollapsed: false,
      sidebarWidth: 280,
    })

    const result = JSON.parse(await inspectTool().execute({ agentId: relay.agentId }))
    const codes = result.diagnostic.diagnostics.map((item: { code: string }) => item.code)

    expect(codes).toContain('sa-chatgpt-button-not-compact')
    expect(codes).toContain('sa-sidebar-not-collapsed')
  })

  test('reports when SA UI exists but platform plugins are missing', async () => {
    saConfiguration.pluginRegistry = null

    const result = JSON.parse(await inspectTool().execute({ agentId: relay.agentId }))

    expect(result.diagnostic.superAssistant.configuration.pluginRegistry).toBeNull()
    expect(result.diagnostic.diagnostics).toContainEqual(expect.objectContaining({
      code: 'sa-plugin-registry-incomplete',
      severity: 'error',
    }))
  })

  test('reports a visible complete tool-call block that SA did not render or target', async () => {
    cdpControl.conversationFlowSurface = {
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
    activity.events = [{
      timestamp: new Date().toISOString(),
      event: 'OBSERVER_MONITORING_STARTED',
      monitoringEnabled: true,
      targetSelectors: ['pre'],
      streamingContainerSelectors: ['pre'],
    }]

    const result = JSON.parse(await inspectTool().execute({ agentId: relay.agentId }))

    expect(result.diagnostic.conversationFlow.surface).toMatchObject({
      completeFunctionCallCandidateCount: 1,
      unrenderedFunctionCallCount: 1,
    })
    expect(result.diagnostic.diagnostics.map((item: { code: string }) => item.code)).toContain(
      'conversation-observer-selector-mismatch',
    )
  })

  test('preserves partial inspection failures instead of returning a false success', async () => {
    cdpControl.connectError = 'CDP websocket unavailable'

    const result = JSON.parse(await inspectTool().execute({ agentId: relay.agentId }))

    expect(result.diagnostic.page).toMatchObject({
      available: false,
      reason: 'CDP websocket unavailable',
    })
    expect(result.diagnostic.diagnostics).toContainEqual(expect.objectContaining({
      code: 'page-inspection-failed',
      severity: 'error',
      message: 'CDP websocket unavailable',
    }))
    expect(result.diagnostic.mcpServer.available).toBe(true)
    expect(cdpControl.closed).toBe(true)
  })
})
