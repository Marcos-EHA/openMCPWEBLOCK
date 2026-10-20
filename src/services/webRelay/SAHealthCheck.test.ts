import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const cdpControl = {
  tabs: [
    { id: 'other-tab', url: 'https://example.com', title: 'Other', webSocketDebuggerUrl: 'ws://debug/other', type: 'page' },
    { id: 'platform-tab', url: 'https://chatgpt.com/', title: 'ChatGPT', webSocketDebuggerUrl: 'ws://debug/platform', type: 'page' },
  ],
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
    pluginRegistry: null,
    pageVisibility: 'hidden',
    pageHasFocus: false,
  } as unknown,
  pluginRegistry: {
    isInitialized: true,
    activePlugin: 'ChatGPTAdapter',
    plugins: ['remote-config-plugin', 'sidebar-plugin', 'ChatGPTAdapter'],
    factories: [
      'gemini-adapter', 'github-copilot-adapter', 'claude-adapter',
      'arena-adapter', 'deepseek-adapter', 'chathub-adapter', 'grok-adapter',
      'perplexity-adapter', 'aistudio-adapter', 'openrouter-adapter', 't3chat-adapter',
      'mistralchat-adapter', 'kimi-adapter', 'z-adapter', 'qwen-adapter',
      'chatx-adapter',
    ],
  },
  connectedTabId: null as string | null,
  closed: false,
  failEvaluation: false,
  expression: '',
  expressions: [] as string[],
  expressions: [] as string[],
}

mock.module('./ChromeCDP.js', () => ({
  CDPConnection: class {
    async listTabs() {
      return cdpControl.tabs
    }

    async connect(tabId: string) {
      cdpControl.connectedTabId = tabId
    }

    async listExecutionContexts() {
      return [{
        id: 4,
        name: 'MCP SuperAssistant',
        origin: 'chrome-extension://sa-extension-id',
      }]
    }

    getCurrentTabId() {
      return cdpControl.connectedTabId
    }

    async evaluate(expression: string) {
      cdpControl.expression = expression
      cdpControl.expressions.push(expression)
      cdpControl.expressions.push(expression)
      if (cdpControl.failEvaluation) throw new Error('CDP evaluation failed')
      if (expression.includes('window.pluginRegistry')) return cdpControl.pluginRegistry
      return cdpControl.snapshot
    }

    close() {
      cdpControl.closed = true
    }
  },
}))

import { inspectSAConfiguration } from './SAHealthCheck.js'

beforeEach(() => {
  cdpControl.connectedTabId = null
  cdpControl.closed = false
  cdpControl.failEvaluation = false
  cdpControl.expression = ''
  cdpControl.expressions = []
  cdpControl.expressions = []
  cdpControl.pluginRegistry.activePlugin = 'ChatGPTAdapter'
  cdpControl.pluginRegistry.plugins = ['remote-config-plugin', 'sidebar-plugin', 'ChatGPTAdapter']
  cdpControl.tabs = [
    { id: 'other-tab', url: 'https://example.com', title: 'Other', webSocketDebuggerUrl: 'ws://debug/other', type: 'page' },
    { id: 'platform-tab', url: 'https://chatgpt.com/', title: 'ChatGPT', webSocketDebuggerUrl: 'ws://debug/platform', type: 'page' },
  ]
})

afterEach(() => {
  mock.restore()
})

describe('inspectSAConfiguration', () => {
  test('inspects the platform tab and closes the CDP connection', async () => {
    const result = await inspectSAConfiguration(9222, 'chatgpt', undefined, 'sa-extension-id')

    expect(cdpControl.connectedTabId).toBe('platform-tab')
    expect(cdpControl.closed).toBe(true)
    expect(result).toEqual({
      ...cdpControl.snapshot,
      pluginRegistry: {
        initialized: true,
        activePlugin: 'ChatGPTAdapter',
        plugins: ['remote-config-plugin', 'sidebar-plugin', 'ChatGPTAdapter'],
        factories: cdpControl.pluginRegistry.factories,
      },
    })
    expect(result?.pageVisibility).toBe('hidden')
    expect(result?.pageHasFocus).toBe(false)
    expect(result).toMatchObject({
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
      },
    })
    const expressions = cdpControl.expressions.join('\n')
    expect(expressions).toContain('document.visibilityState')
    expect(expressions).toContain('document.hasFocus()')
    expect(expressions).toContain('#mcp-sidebar-shadow-host')
    expect(expressions).toContain('window.pluginRegistry')
    expect(expressions).toContain('closest(\'form, [data-testid*="composer"], #inputfielddiv\')')
  })

  test('requires the core plugins, all adapter factories, and the active platform adapter', async () => {
    const { checkSAPluginRegistry } = await import('./SAHealthCheck.js')

    const complete = checkSAPluginRegistry({
      initialized: cdpControl.pluginRegistry.isInitialized,
      activePlugin: cdpControl.pluginRegistry.activePlugin,
      plugins: cdpControl.pluginRegistry.plugins,
      factories: cdpControl.pluginRegistry.factories,
    }, 'chatgpt')
    expect(complete.ready).toBe(true)

    const platformAdapters = [
      ['chatgpt', 'chatgpt-adapter', 'ChatGPTAdapter'],
      ['gemini', 'gemini-adapter', 'GeminiAdapter'],
      ['grok', 'grok-adapter', 'GrokAdapter'],
      ['perplexity', 'perplexity-adapter', 'PerplexityAdapter'],
      ['deepseek', 'deepseek-adapter', 'DeepSeekAdapter'],
      ['kimi', 'kimi-adapter', 'KimiAdapter'],
      ['qwen', 'qwen-adapter', 'QwenAdapter'],
      ['chathub', 'chathub-adapter', 'ChatHubAdapter'],
      ['claude', 'claude-adapter', 'ClaudeAdapter'],
      ['arena', 'arena-adapter', 'ArenaAdapter'],
      ['zai', 'z-adapter', 'ZAdapter'],
      ['aistudio', 'aistudio-adapter', 'AIStudioAdapter'],
      ['chatx', 'chatx-adapter', 'ChatXAdapter'],
    ] as const
    const allFactories = [...cdpControl.pluginRegistry.factories, 'chatgpt-adapter']
    for (const [platformId, activeFactory, activePlugin] of platformAdapters) {
      const platformRegistry = {
        initialized: true,
        activePlugin,
        plugins: ['remote-config-plugin', 'sidebar-plugin', activePlugin],
        factories: allFactories.filter(factory => factory !== activeFactory),
      }
      expect(checkSAPluginRegistry(platformRegistry, platformId).ready).toBe(true)

      const noActivePlugin = checkSAPluginRegistry({
        ...platformRegistry,
        activePlugin: null,
        plugins: ['remote-config-plugin', 'sidebar-plugin'],
      }, platformId)
      expect(noActivePlugin.ready).toBe(false)
      expect(noActivePlugin.missingFactories).toContain(activeFactory)
    }

    const incomplete = checkSAPluginRegistry({
      initialized: true,
      activePlugin: null,
      plugins: ['sidebar-plugin'],
      factories: ['chatgpt-adapter'],
    }, 'chatgpt')
    expect(incomplete).toMatchObject({
      ready: false,
      activePlugin: null,
      expectedAdapter: 'ChatGPTAdapter',
      missingCorePlugins: ['remote-config-plugin'],
      missingFactories: expect.arrayContaining(['gemini-adapter', 'qwen-adapter']),
    })
  })

  test('detects compact buttons by their shared accessible label on Z.ai', async () => {
    cdpControl.tabs = [
      { id: 'zai-tab', url: 'https://chat.z.ai/', title: 'Z.ai', webSocketDebuggerUrl: 'ws://debug/zai', type: 'page' },
    ]

    const result = await inspectSAConfiguration(9402, 'zai')

    expect(cdpControl.connectedTabId).toBe('zai-tab')
    expect(cdpControl.expressions.join('\n')).toContain(
      '#mcp-popover-container button[aria-label^="MCP Settings"]',
    )
    expect(result?.compactButtonVisible).toBe(true)
  })

  test('inspects the ChatX page and its adapter registry', async () => {
    cdpControl.tabs = [
      { id: 'chatx-tab', url: 'https://chatx.ai/es/gpt', title: 'ChatX', webSocketDebuggerUrl: 'ws://debug/chatx', type: 'page' },
    ]
    cdpControl.pluginRegistry.activePlugin = 'ChatXAdapter'
    cdpControl.pluginRegistry.plugins = ['remote-config-plugin', 'sidebar-plugin', 'ChatXAdapter']

    const result = await inspectSAConfiguration(9410, 'chatx')

    expect(cdpControl.connectedTabId).toBe('chatx-tab')
    expect(result?.pluginRegistry?.activePlugin).toBe('ChatXAdapter')
    expect(cdpControl.expressions.join('\n')).toContain('#inputfielddiv')
    expect((await import('./SAHealthCheck.js')).checkSAPluginRegistry({
      initialized: true,
      activePlugin: 'ChatXAdapter',
      plugins: ['remote-config-plugin', 'sidebar-plugin', 'ChatXAdapter'],
      factories: [...cdpControl.pluginRegistry.factories, 'chatgpt-adapter'],
    }, 'chatx').ready).toBe(true)
  })

  test('inspects only the explicitly selected platform target', async () => {
    cdpControl.tabs = [
      { id: 'first-chatgpt-tab', url: 'https://chatgpt.com/', title: 'ChatGPT', webSocketDebuggerUrl: 'ws://debug/first', type: 'page' },
      { id: 'selected-chatgpt-tab', url: 'https://chat.openai.com/', title: 'ChatGPT', webSocketDebuggerUrl: 'ws://debug/selected', type: 'page' },
    ]

    await inspectSAConfiguration(9222, 'chatgpt', 'selected-chatgpt-tab')

    expect(cdpControl.connectedTabId).toBe('selected-chatgpt-tab')
    expect(cdpControl.closed).toBe(true)
  })

  test('does not fall back to another platform target if the selected target disappeared', async () => {
    cdpControl.tabs = [
      { id: 'other-chatgpt-tab', url: 'https://chatgpt.com/', title: 'ChatGPT', webSocketDebuggerUrl: 'ws://debug/other', type: 'page' },
    ]

    const result = await inspectSAConfiguration(9222, 'chatgpt', 'selected-chatgpt-tab')

    expect(result).toBeNull()
    expect(cdpControl.connectedTabId).toBeNull()
    expect(cdpControl.closed).toBe(true)
  })

  test('does not attach to an unrelated tab when the platform is absent', async () => {
    cdpControl.tabs = [cdpControl.tabs[0]!]

    const result = await inspectSAConfiguration(9222, 'chatgpt')

    expect(result).toBeNull()
    expect(cdpControl.connectedTabId).toBeNull()
    expect(cdpControl.closed).toBe(true)
  })

  test('rejects malformed preference data and still closes CDP', async () => {
    cdpControl.snapshot = { mcpEnabled: 'yes' }

    await expect(inspectSAConfiguration(9222, 'chatgpt')).rejects.toThrow(
      'SuperAssistant preferences are missing or have an unsupported shape.',
    )

    expect(cdpControl.closed).toBe(true)
  })

  test('propagates inspection failures and closes CDP', async () => {
    cdpControl.failEvaluation = true

    await expect(inspectSAConfiguration(9222, 'chatgpt')).rejects.toThrow('CDP evaluation failed')
    expect(cdpControl.closed).toBe(true)
  })
})
