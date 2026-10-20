import { CDPConnection } from './ChromeCDP.js'
import { getWebPlatformById } from '../../utils/webPlatforms.js'

export interface SAConfigurationSnapshot {
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
  pluginRegistry: SAPluginRegistrySnapshot | null
  pageVisibility: 'visible' | 'hidden' | 'unknown'
  pageHasFocus: boolean | null
}

export interface SAPluginRegistrySnapshot {
  initialized: boolean
  activePlugin: string | null
  plugins: string[]
  factories: string[]
}

export interface SAPluginRegistryReadiness {
  ready: boolean
  initialized: boolean
  activePlugin: string | null
  expectedAdapter: string | null
  missingCorePlugins: string[]
  missingFactories: string[]
}

const REQUIRED_CORE_PLUGINS = ['remote-config-plugin', 'sidebar-plugin'] as const

const REQUIRED_BUILT_IN_FACTORIES = [
  'gemini-adapter',
  'github-copilot-adapter',
  'chatgpt-adapter',
  'claude-adapter',
  'arena-adapter',
  'chatx-adapter',
  'deepseek-adapter',
  'chathub-adapter',
  'grok-adapter',
  'perplexity-adapter',
  'aistudio-adapter',
  'openrouter-adapter',
  't3chat-adapter',
  'mistralchat-adapter',
  'kimi-adapter',
  'z-adapter',
  'qwen-adapter',
] as const

const PLATFORM_ADAPTERS: Record<string, { factory: string; plugin: string }> = {
  chatgpt: { factory: 'chatgpt-adapter', plugin: 'ChatGPTAdapter' },
  gemini: { factory: 'gemini-adapter', plugin: 'GeminiAdapter' },
  grok: { factory: 'grok-adapter', plugin: 'GrokAdapter' },
  perplexity: { factory: 'perplexity-adapter', plugin: 'PerplexityAdapter' },
  deepseek: { factory: 'deepseek-adapter', plugin: 'DeepSeekAdapter' },
  kimi: { factory: 'kimi-adapter', plugin: 'KimiAdapter' },
  qwen: { factory: 'qwen-adapter', plugin: 'QwenAdapter' },
  chathub: { factory: 'chathub-adapter', plugin: 'ChatHubAdapter' },
  chatx: { factory: 'chatx-adapter', plugin: 'ChatXAdapter' },
  claude: { factory: 'claude-adapter', plugin: 'ClaudeAdapter' },
  arena: { factory: 'arena-adapter', plugin: 'ArenaAdapter' },
  zai: { factory: 'z-adapter', plugin: 'ZAdapter' },
  aistudio: { factory: 'aistudio-adapter', plugin: 'AIStudioAdapter' },
}

export function checkSAPluginRegistry(
  registry: SAPluginRegistrySnapshot | null,
  platformId: string,
): SAPluginRegistryReadiness {
  const platformAdapter = PLATFORM_ADAPTERS[platformId]
  const expectedAdapter = platformAdapter?.plugin ?? null
  const plugins = registry?.plugins ?? []
  const factories = registry?.factories ?? []
  const missingCorePlugins = REQUIRED_CORE_PLUGINS.filter(name => !plugins.includes(name))
  const activeAdapterInitialized = platformAdapter !== undefined &&
    registry?.activePlugin === platformAdapter.plugin &&
    plugins.includes(platformAdapter.plugin)
  const missingFactories = REQUIRED_BUILT_IN_FACTORIES.filter(name =>
    !factories.includes(name) &&
    !(activeAdapterInitialized && name === platformAdapter?.factory),
  )
  const ready = registry?.initialized === true &&
    expectedAdapter !== null &&
    registry.activePlugin === expectedAdapter &&
    plugins.includes(expectedAdapter) &&
    missingCorePlugins.length === 0 &&
    missingFactories.length === 0

  return {
    ready,
    initialized: registry?.initialized === true,
    activePlugin: registry?.activePlugin ?? null,
    expectedAdapter,
    missingCorePlugins,
    missingFactories,
  }
}

function isNullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === 'boolean'
}

function parsePluginRegistry(value: unknown): SAPluginRegistrySnapshot | null {
  if (value === null) return null
  if (!value || typeof value !== 'object') return null
  const snapshot = value as Record<string, unknown>
  if (
    typeof snapshot.isInitialized !== 'boolean' ||
    !(snapshot.activePlugin === null || typeof snapshot.activePlugin === 'string') ||
    !Array.isArray(snapshot.plugins) ||
    !snapshot.plugins.every(name => typeof name === 'string') ||
    !Array.isArray(snapshot.factories) ||
    !snapshot.factories.every(name => typeof name === 'string')
  ) return null
  return {
    initialized: snapshot.isInitialized,
    activePlugin: snapshot.activePlugin,
    plugins: snapshot.plugins,
    factories: snapshot.factories,
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms.`)), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function parseSnapshot(value: unknown): SAConfigurationSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const snapshot = value as Record<string, unknown>
  const mcpEnabled = snapshot.mcpEnabled
  const pushContentMode = snapshot.pushContentMode
  const autoInsert = snapshot.autoInsert
  const autoSubmit = snapshot.autoSubmit
  const autoExecute = snapshot.autoExecute
  const sidebarVisible = snapshot.sidebarVisible
  const compactButtonInComposer = snapshot.compactButtonInComposer
  const compactButtonWidth = snapshot.compactButtonWidth
  const compactButtonHeight = snapshot.compactButtonHeight
  const compactButtonLabelVisible = snapshot.compactButtonLabelVisible
  const sidebarCollapsed = snapshot.sidebarCollapsed
  const sidebarWidth = snapshot.sidebarWidth
  const pluginRegistry = parsePluginRegistry(snapshot.pluginRegistry)
  const pageVisibility = snapshot.pageVisibility
  const pageHasFocus = snapshot.pageHasFocus
  if (
    !isNullableBoolean(mcpEnabled) ||
    !isNullableBoolean(pushContentMode) ||
    !isNullableBoolean(autoInsert) ||
    !isNullableBoolean(autoSubmit) ||
    !isNullableBoolean(autoExecute) ||
    !isNullableBoolean(sidebarVisible) ||
    !isNullableBoolean(compactButtonInComposer) ||
    !(compactButtonWidth === null || (typeof compactButtonWidth === 'number' && Number.isFinite(compactButtonWidth))) ||
    !(compactButtonHeight === null || (typeof compactButtonHeight === 'number' && Number.isFinite(compactButtonHeight))) ||
    !isNullableBoolean(compactButtonLabelVisible) ||
    !isNullableBoolean(sidebarCollapsed) ||
    !(sidebarWidth === null || (typeof sidebarWidth === 'number' && Number.isFinite(sidebarWidth))) ||
    (pageVisibility !== 'visible' && pageVisibility !== 'hidden' && pageVisibility !== 'unknown') ||
    !isNullableBoolean(pageHasFocus)
  ) return null
  if (typeof snapshot.compactButtonVisible !== 'boolean') return null
  if (snapshot.pluginRegistry !== null && pluginRegistry === null) return null
  return {
    mcpEnabled,
    pushContentMode,
    autoInsert,
    autoSubmit,
    autoExecute,
    sidebarVisible,
    compactButtonVisible: snapshot.compactButtonVisible,
    compactButtonInComposer,
    compactButtonWidth,
    compactButtonHeight,
    compactButtonLabelVisible,
    sidebarCollapsed,
    sidebarWidth,
    pluginRegistry,
    pageVisibility,
    pageHasFocus,
  }
}

const inspectExpression = `(() => {
  const storeKey = 'mcp-super-assistant-ui-store';
  let state;
  try {
    state = JSON.parse(localStorage.getItem(storeKey) || '{}').state;
  } catch {
    return null;
  }
  if (!state || typeof state !== 'object') return null;
  const preferences = state.preferences && typeof state.preferences === 'object'
    ? state.preferences
    : {};
  const roots = [document];
  for (let index = 0; index < roots.length; index++) {
    for (const element of roots[index].querySelectorAll('*')) {
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
  const button = roots.flatMap(root => [
    ...root.querySelectorAll('#mcp-popover-container button[aria-label^="MCP Settings"]')
  ]).find(element => {
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return bounds.width > 0 && bounds.height > 0 &&
      style.display !== 'none' && style.visibility !== 'hidden';
  });
  const container = button?.closest('#mcp-popover-container');
  const buttonBounds = button?.getBoundingClientRect();
  const buttonText = container?.querySelector('.mcp-chatgpt-button-text');
  const buttonTextStyle = buttonText ? getComputedStyle(buttonText) : null;
  const sidebar = document.querySelector('#mcp-sidebar-shadow-host')?.shadowRoot?.querySelector('.sidebar');
  const sidebarBounds = sidebar?.getBoundingClientRect();
  const sidebarWidth = sidebarBounds ? sidebarBounds.width : null;
  return {
    mcpEnabled: typeof state.mcpEnabled === 'boolean' ? state.mcpEnabled : null,
    pushContentMode: typeof preferences.isPushMode === 'boolean' ? preferences.isPushMode : null,
    autoInsert: typeof preferences.autoInsert === 'boolean' ? preferences.autoInsert : null,
    autoSubmit: typeof preferences.autoSubmit === 'boolean' ? preferences.autoSubmit : null,
    autoExecute: typeof preferences.autoExecute === 'boolean' ? preferences.autoExecute : null,
    sidebarVisible: typeof state.sidebar?.isVisible === 'boolean' ? state.sidebar.isVisible : null,
    compactButtonVisible: Boolean(button),
    compactButtonInComposer: container
      ? Boolean(container.closest('form, [data-testid*="composer"], #inputfielddiv'))
      : null,
    compactButtonWidth: buttonBounds ? buttonBounds.width : null,
    compactButtonHeight: buttonBounds ? buttonBounds.height : null,
    compactButtonLabelVisible: buttonText
      ? buttonTextStyle?.display !== 'none' && buttonTextStyle?.visibility !== 'hidden'
      : null,
    sidebarCollapsed: sidebar
      ? Boolean(sidebar.classList.contains('collapsed') && sidebarWidth !== null && sidebarWidth <= 56)
      : null,
    sidebarWidth,
    pluginRegistry: null,
    pageVisibility: document.visibilityState === 'visible' ? 'visible' :
      document.visibilityState === 'hidden' ? 'hidden' : 'unknown',
    pageHasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() : null
  };
})()`

const inspectPluginRegistryExpression = `(() => {
  const registry = window.pluginRegistry;
  if (!registry || typeof registry.getDebugInfo !== 'function') return null;
  const info = registry.getDebugInfo();
  return {
    isInitialized: info?.isInitialized === true,
    activePlugin: typeof info?.activePlugin === 'string' ? info.activePlugin : null,
    plugins: Array.isArray(info?.plugins) ? info.plugins : null,
    factories: Array.isArray(info?.factories) ? info.factories : null
  };
})()`

export async function inspectSAConfiguration(
  debugPort: number,
  platformId: string,
  targetId?: string,
  extensionId?: string,
): Promise<SAConfigurationSnapshot | null> {
  const platform = getWebPlatformById(platformId)
  if (!platform) {
    throw new Error(`Unknown web platform "${platformId}" while inspecting SuperAssistant.`)
  }
  const expectedHost = new URL(platform.url).hostname
  const isPlatformHost = (url: string): boolean => {
    try {
      const hostname = new URL(url).hostname
      if (hostname === expectedHost || hostname.endsWith(`.${expectedHost}`)) return true
      return platformId === 'chatgpt' &&
        (hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com') ||
         hostname === 'chat.openai.com' || hostname.endsWith('.openai.com'))
    } catch {
      return false
    }
  }
  const connection = new CDPConnection(debugPort)
  try {
    const tabs = await withTimeout(connection.listTabs(), 4000, 'CDP tab discovery')
    const target = tabs.find(tab =>
      (targetId === undefined || tab.id === targetId) && isPlatformHost(tab.url),
    )
    if (!target) return null

    await withTimeout(connection.connect(target.id), 4000, 'CDP page connection')
    if (targetId !== undefined && connection.getCurrentTabId() !== targetId) {
      throw new Error('CDP connected to a different page while inspecting SuperAssistant.')
    }
    const snapshot: unknown = await withTimeout(
      connection.evaluate(inspectExpression),
      4000,
      'SuperAssistant preference inspection',
    )
    const parsed = parseSnapshot(snapshot)
    if (!parsed) {
      throw new Error('SuperAssistant preferences are missing or have an unsupported shape.')
    }
    const contexts = await withTimeout(
      connection.listExecutionContexts(),
      4000,
      'SuperAssistant plugin-context discovery',
    )
    const pluginContexts = contexts.filter(context => {
      const contextExtensionId = context.origin?.match(/^chrome-extension:\/\/([^/]+)/)?.[1]
      return extensionId
        ? contextExtensionId === extensionId
        : Boolean(contextExtensionId && /superassistant/i.test(context.name ?? ''))
    })
    for (const context of pluginContexts) {
      const registrySnapshot: unknown = await withTimeout(
        connection.evaluate(inspectPluginRegistryExpression, context.id),
        4000,
        'SuperAssistant plugin registry inspection',
      )
      if (registrySnapshot !== null) {
        parsed.pluginRegistry = parsePluginRegistry(registrySnapshot)
        if (!parsed.pluginRegistry) {
          throw new Error('SuperAssistant plugin registry has an unsupported shape.')
        }
        break
      }
    }
    return parsed
  } finally {
    connection.close()
  }
}
