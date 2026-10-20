import type { ToolDefinition } from './MCPSSEServer.js'
import { WebSocket } from 'ws'
import {
  sharedActivityJournal,
  type SharedActivitySource,
} from '../observability/SharedActivityJournal.js'
import {
  initializeSharedActivitySources,
  recordRelayExecutionActivity,
} from '../observability/SharedActivitySources.js'
import { MCP_PORT } from './mcpPort.js'
import type { AgentState } from '../webRelay/orchestration/types.js'
import type { SAConfigurationSnapshot } from '../webRelay/SAHealthCheck.js'
import type { ExecutionDiagnosticEvent } from '../webRelay/ExecutionDiagnostics.js'
import { summarizeConversationFlow } from '../webRelay/ConversationFlowDiagnostics.js'

function requireAgentId(args: Record<string, unknown>): string {
  if (typeof args.agentId !== 'string' || args.agentId.trim().length === 0) {
    throw new Error('agentId must be a non-empty string.')
  }
  return args.agentId.trim()
}

const ACTIVITY_SOURCES: SharedActivitySource[] = [
  'mcp',
  'orchestration',
  'sentinel',
  'collaboration',
  'coordinator',
  'execution',
]

type CdpTarget = {
  id?: string
  type?: string
  title?: string
  url?: string
  webSocketDebuggerUrl?: string
}

type CdpExecutionContext = {
  id: number
  name?: string
  origin?: string
  auxData?: { isDefault?: boolean; frameId?: string }
}

function requireInstanceSelector(args: Record<string, unknown>):
  | { agentId: string }
  | { sourceId: string } {
  const agentId = typeof args.agentId === 'string' ? args.agentId.trim() : ''
  const sourceId = typeof args.sourceId === 'string' ? args.sourceId.trim() : ''
  if (Boolean(agentId) === Boolean(sourceId)) {
    throw new Error('Provide exactly one non-empty agentId or sourceId.')
  }
  return agentId ? { agentId } : { sourceId }
}

async function getCdpTargets(debugPort: number): Promise<CdpTarget[]> {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
    signal: AbortSignal.timeout(3000),
  })
  if (!response.ok) {
    throw new Error(`Chrome CDP on port ${debugPort} returned HTTP ${response.status}.`)
  }
  const targets = await response.json() as unknown
  if (!Array.isArray(targets)) {
    throw new Error(`Chrome CDP on port ${debugPort} returned an invalid target list.`)
  }
  return targets.filter((target): target is CdpTarget =>
    Boolean(target && typeof target === 'object'),
  )
}

async function getMasterSessionTargets(debugPort: number): Promise<CdpTarget[]> {
  return (await getCdpTargets(debugPort)).filter(target => target.type === 'page')
}

function isPlatformPage(url: string, hostname: string, platformId?: string): boolean {
  try {
    const actualHost = new URL(url).hostname
    if (actualHost === hostname || actualHost.endsWith(`.${hostname}`)) return true
    if (platformId !== 'chatgpt') return false
    return actualHost === 'chatgpt.com' || actualHost.endsWith('.chatgpt.com') ||
      actualHost === 'chat.openai.com' || actualHost.endsWith('.openai.com')
  } catch {
    return false
  }
}

function isRelayPlatformPage(url: string, platformId: string, hostname: string): boolean {
  return isPlatformPage(url, hostname, platformId)
}

async function inspectRelayRuntime(agent: AgentState, executionEvents: ExecutionDiagnosticEvent[]) {
  const diagnostics: Array<{ severity: 'error' | 'warning' | 'info'; code: string; message: string }> = []
  let chromeProfile: {
    copy: {
      copied: boolean
      profileMatches: boolean | null
      copiedAt: number | null
      cookieDatabase: 'unchanged' | 'changed' | 'missing' | 'not-recorded' | 'unavailable'
      cookieDatabaseReadIssue?: string
    } | null
    authentication: {
      status: string
      hasSessionCookie: boolean
      reason: string
    } | null
  } | null = null
  const page: {
    available: boolean
    reason?: string
    platformTabCount: number
    origin?: string
    hasSuperAssistantDom?: boolean
    hasComposerCandidate?: boolean
    isLoggedInHeuristic?: boolean
    isGenerating?: boolean
    visibility?: string
    focused?: boolean
  } = { available: false, platformTabCount: 0 }
  let superAssistant: {
    extensionId: string | null
    configuration: SAConfigurationSnapshot | null
    serviceWorkerActive: boolean | null
    executionContextPresent: boolean
    runtimeMessagingAvailable: boolean | null
    inspectionError?: string
  } = {
    extensionId: agent.saExtensionId ?? null,
    configuration: null,
    serviceWorkerActive: null,
    executionContextPresent: false,
    runtimeMessagingAvailable: null,
  }
  const mcpServer: {
    scope: 'process-wide'
    available: boolean
    connections: number | null
    tools: number | null
    error?: string
  } = { scope: 'process-wide', available: false, connections: null, tools: null }
  let platformTargetId: string | undefined
  let conversationFlow: ReturnType<typeof summarizeConversationFlow>['summary'] | null = null

  if (agent.debugPort === undefined) {
    page.reason = 'Relay has no registered Chrome debug port.'
    diagnostics.push({
      severity: 'error',
      code: 'missing-debug-port',
      message: page.reason,
    })
  } else {
    if (agent.sessionMode === 'chrome-profile' && agent.platformId === 'chatgpt') {
      const [{ verifyChatGPTAuth }, { inspectRelayChromeProfileCopy, isDebugPortActive }] = await Promise.all([
        import('../webRelay/session/ChatGPTAuthVerifier.js'),
        import('../webRelay/ChromeCDP.js'),
      ])
      const [cdpActive, copy] = await Promise.all([
        isDebugPortActive(agent.debugPort),
        agent.instanceId && agent.chromeProfileDirectory
          ? Promise.resolve(inspectRelayChromeProfileCopy(agent.instanceId, agent.chromeProfileDirectory))
          : Promise.resolve(null),
      ])
      const auth = cdpActive
        ? await verifyChatGPTAuth(agent.debugPort, { timeoutMs: 1500, pollIntervalMs: 250 })
        : null
      chromeProfile = {
        copy,
        authentication: auth
          ? {
            status: auth.status,
            hasSessionCookie: auth.hasSessionCookie,
            reason: auth.reason,
          }
          : {
            status: 'unknown',
            hasSessionCookie: false,
            reason: 'Relay CDP is unavailable; authentication could not be verified.',
          },
      }
      if (auth && auth.status !== 'authenticated') {
        const copyChanged = copy?.cookieDatabase === 'changed'
        diagnostics.push({
          severity: 'warning',
          code: copyChanged
            ? 'chrome-profile-session-not-inherited'
            : 'chrome-profile-login-required',
          message: copyChanged
            ? 'The isolated Chrome cookie database changed after launch and has no active ChatGPT session cookie. Signing in to normal Chrome does not sign in to this isolated Relay. Sign in in the Relay window, or use a persistent Master Session; do not repeat the profile copy as a login fix.'
            : 'This isolated Chrome Relay has no verified ChatGPT session. Its login is separate from normal Chrome; sign in in the Relay window or use a persistent Master Session.',
        })
      }
      if (copy?.cookieDatabaseReadIssue) {
        diagnostics.push({
          severity: 'info',
          code: 'chrome-profile-cookie-database-unavailable',
          message: copy.cookieDatabaseReadIssue,
        })
      }
    }
    const [
      { CDPConnection },
      { getWebPlatformById },
      { checkSAPluginRegistry, inspectSAConfiguration },
    ] = await Promise.all([
      import('../webRelay/ChromeCDP.js'),
      import('../../utils/webPlatforms.js'),
      import('../webRelay/SAHealthCheck.js'),
    ])
    const platform = getWebPlatformById(agent.platformId)
    if (!platform) throw new Error(`Unsupported Relay platform "${agent.platformId}".`)
    const hostname = new URL(platform.url).hostname
    const connection = new CDPConnection(agent.debugPort)
    try {
      const targets = await getCdpTargets(agent.debugPort)
      const platformTabs = targets.filter(target =>
        target.type === 'page' &&
        /^https?:\/\//.test(target.url ?? '') &&
        isRelayPlatformPage(target.url ?? '', agent.platformId, hostname),
      )
      page.platformTabCount = platformTabs.length
      if (agent.saExtensionId) {
        superAssistant.serviceWorkerActive = targets.some(target =>
          target.type === 'service_worker' &&
          target.url?.startsWith(`chrome-extension://${agent.saExtensionId}/`),
        )
      }
      if (platformTabs.length === 0) {
        page.reason = `No ${agent.platformId} page is open in this Relay.`
        diagnostics.push({
          severity: 'error',
          code: 'platform-tab-not-found',
          message: page.reason,
        })
      } else if (platformTabs.length > 1) {
        page.reason = `Found ${platformTabs.length} ${agent.platformId} pages; refusing to select one arbitrarily.`
        diagnostics.push({
          severity: 'error',
          code: 'multiple-platform-tabs',
          message: page.reason,
        })
      } else {
        const tab = platformTabs[0]!
        if (!tab.id) throw new Error('Platform page target has no CDP target ID.')
        platformTargetId = tab.id
        await connection.connect(tab.id)
        const state = await connection.checkPageState()
        const contexts = await connection.listExecutionContexts()
        const saContext = contexts.find(context => {
          const contextExtensionId = context.origin?.match(
            /^chrome-extension:\/\/([^/]+)/,
          )?.[1]
          return agent.saExtensionId
            ? contextExtensionId === agent.saExtensionId
            : Boolean(contextExtensionId && /superassistant/i.test(context.name ?? ''))
        })
        superAssistant.executionContextPresent = Boolean(saContext)
        if (saContext) {
          superAssistant.extensionId = saContext.origin?.match(/^chrome-extension:\/\/([^/]+)/)?.[1] ??
            superAssistant.extensionId
          if (superAssistant.extensionId) {
            superAssistant.serviceWorkerActive = targets.some(target =>
              target.type === 'service_worker' &&
              target.url?.startsWith(`chrome-extension://${superAssistant.extensionId}/`),
            )
          }
          superAssistant.runtimeMessagingAvailable =
            await connection.evaluate(
              `typeof chrome !== 'undefined' && typeof chrome.runtime?.sendMessage === 'function'`,
              saContext.id,
            ) === true
        }
        page.available = true
        page.origin = new URL(tab.url ?? '').origin
        page.hasSuperAssistantDom = state.hasSA
        page.hasComposerCandidate = state.hasInput
        page.isLoggedInHeuristic = state.isLoggedIn
        page.isGenerating = state.isGenerating
        page.visibility = await connection.evaluate('document.visibilityState') ?? 'unknown'
        page.focused = await connection.evaluate('document.hasFocus()') === true

        if (!state.hasSA) {
          diagnostics.push({
            severity: 'error',
            code: 'sa-dom-not-mounted',
            message: 'SuperAssistant content is not mounted in the selected platform page.',
          })
        }
        if (!superAssistant.executionContextPresent) {
          diagnostics.push({
            severity: 'error',
            code: 'sa-execution-context-not-found',
            message: 'No SuperAssistant isolated execution context was found in the platform page.',
          })
        } else if (superAssistant.runtimeMessagingAvailable !== true) {
          diagnostics.push({
            severity: 'error',
            code: 'sa-runtime-messaging-unavailable',
            message: 'The SuperAssistant page context exists but Chrome runtime messaging is unavailable.',
          })
        }
        if (!state.hasInput) {
          diagnostics.push({
            severity: 'warning',
            code: 'platform-composer-not-detected',
            message: 'No text input/composer candidate is currently present; account or page readiness may be required.',
          })
        }
      }
    } catch (error) {
      page.reason = error instanceof Error ? error.message : String(error)
      diagnostics.push({
        severity: 'error',
        code: 'page-inspection-failed',
        message: page.reason,
      })
    } finally {
      connection.close()
    }

    if (!platformTargetId) {
      superAssistant.inspectionError =
        'SA settings were not inspected because no unique platform page was selected.'
      diagnostics.push({
        severity: 'warning',
        code: 'sa-configuration-not-inspected',
        message: superAssistant.inspectionError,
      })
    } else {
      try {
        superAssistant.configuration = await inspectSAConfiguration(
          agent.debugPort,
          agent.platformId,
          platformTargetId,
          agent.saExtensionId,
        )
        if (!superAssistant.configuration) {
          superAssistant.inspectionError = 'The selected platform page was unavailable for the SA settings inspection.'
        } else {
          const settings = superAssistant.configuration
          const pluginReadiness = checkSAPluginRegistry(
            settings.pluginRegistry,
            agent.platformId,
          )
          if (!pluginReadiness.ready) {
            diagnostics.push({
              severity: 'error',
              code: 'sa-plugin-registry-incomplete',
              message: `SuperAssistant plugin registry is incomplete: ${JSON.stringify(pluginReadiness)}.`,
            })
          }
          const enabled = settings.mcpEnabled === true &&
            settings.pushContentMode === true &&
            settings.autoInsert === true &&
            settings.autoSubmit === true &&
            settings.autoExecute === true &&
            settings.sidebarVisible === true &&
            settings.compactButtonVisible
          if (!enabled) {
            diagnostics.push({
              severity: 'error',
              code: 'sa-configuration-incomplete',
              message: 'One or more persisted settings or the visible compact SuperAssistant button are not confirmed.',
            })
          }
          if (agent.platformId === 'chatgpt' && settings.compactButtonVisible) {
            const compact = settings.compactButtonInComposer === true &&
              settings.compactButtonWidth !== null &&
              settings.compactButtonHeight !== null &&
              settings.compactButtonWidth <= 40 &&
              settings.compactButtonHeight <= 40 &&
              settings.compactButtonLabelVisible === false
            if (!compact) {
              diagnostics.push({
                severity: 'error',
                code: 'sa-chatgpt-button-not-compact',
                message: 'The ChatGPT SuperAssistant button is visible but its compact in-composer layout is not confirmed.',
              })
            }
          }
          if (settings.sidebarVisible === true && settings.sidebarCollapsed === false) {
            diagnostics.push({
              severity: 'error',
              code: 'sa-sidebar-not-collapsed',
              message: `The SuperAssistant sidebar is expanded (observed width: ${settings.sidebarWidth ?? 'unknown'}px).`,
            })
          }
          if (settings.sidebarVisible === true && settings.sidebarCollapsed === null) {
            diagnostics.push({
              severity: 'warning',
              code: 'sa-sidebar-layout-unobserved',
              message: 'The sidebar is configured as visible, but its rendered collapsed state and width could not be inspected.',
            })
          }
        }
      } catch (error) {
        superAssistant.inspectionError = error instanceof Error ? error.message : String(error)
        diagnostics.push({
          severity: 'error',
          code: 'sa-inspection-failed',
          message: superAssistant.inspectionError,
        })
      }
    }
    if (superAssistant.serviceWorkerActive === false) {
      diagnostics.push({
        severity: 'warning',
        code: 'sa-service-worker-inactive',
        message: 'No SuperAssistant service worker target is active; an idle MV3 worker may be suspended.',
      })
    }
    try {
      const { inspectConversationFlowSurface } = await import('../webRelay/ChromeCDP.js')
      const surface = await inspectConversationFlowSurface(agent.debugPort, agent.platformId)
      const analysis = summarizeConversationFlow(
        surface,
        executionEvents,
        superAssistant.configuration?.autoExecute ?? null,
      )
      conversationFlow = analysis.summary
      diagnostics.push(...analysis.diagnostics)
      if (!surface.available) {
        diagnostics.push({
          severity: 'warning',
          code: 'conversation-flow-surface-unavailable',
          message: surface.reason ?? 'Could not inspect the platform conversation surface.',
        })
      }
    } catch (error) {
      diagnostics.push({
        severity: 'warning',
        code: 'conversation-flow-inspection-failed',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  try {
    const response = await fetch(`http://127.0.0.1:${MCP_PORT}/status`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) {
      mcpServer.error = `HTTP ${response.status}`
    } else {
      const status = await response.json() as { running?: unknown; connections?: unknown; tools?: unknown }
      mcpServer.available = status.running === true
      mcpServer.connections = typeof status.connections === 'number' ? status.connections : null
      mcpServer.tools = typeof status.tools === 'number' ? status.tools : null
      if (!mcpServer.available) mcpServer.error = 'MCP server did not report running=true.'
    }
  } catch (error) {
    mcpServer.error = error instanceof Error ? error.message : String(error)
  }
  if (!mcpServer.available) {
    diagnostics.push({
      severity: 'error',
      code: 'mcp-server-unavailable',
      message: `The process-wide MCP server is unavailable: ${mcpServer.error ?? 'no status response'}`,
    })
  }

  return {
    capturedAt: new Date().toISOString(),
    identity: {
      agentId: agent.agentId,
      instanceId: agent.instanceId ?? null,
      platformId: agent.platformId,
      role: agent.role ?? null,
      status: agent.status,
      sessionMode: agent.sessionMode ?? null,
      debugPort: agent.debugPort ?? null,
      saExtensionId: agent.saExtensionId ?? null,
    },
    page,
    ...(chromeProfile ? { chromeProfile } : {}),
    superAssistant,
    conversationFlow,
    mcpServer,
    diagnostics,
    limits: [
      'MCP connection count is process-wide and is not proof that this Relay has an active SA MCP connection.',
      'A visible composer is a readiness signal, not proof that an end-to-end tool call succeeds.',
      'No prompt, tool call, conversation text, argument, cookie, or credential was read or sent.',
    ],
  }
}

async function readMasterSessionInventory() {
  const [
    { listMasterSessionSources },
    { findActiveMasterPort },
    { getWebPlatformById },
  ] = await Promise.all([
    import('../webRelay/session/MasterSessionRegistry.js'),
    import('../webRelay/session/SessionBroker.js'),
    import('../../utils/webPlatforms.js'),
  ])
  const sources = listMasterSessionSources()
  return Promise.all(sources.map(async source => {
    try {
      const debugPort = await findActiveMasterPort(source.id)
      if (debugPort === null) {
        return {
          sourceId: source.id,
          name: source.name,
          platformId: source.platformId,
          profileDir: source.profileDir,
          active: false,
          debugPort: source.debugPort,
          tabs: [],
        }
      }
      const platform = getWebPlatformById(source.platformId)
      if (!platform) throw new Error(`Unsupported Master Session platform "${source.platformId}".`)
      const hostname = new URL(platform.url).hostname
      const targets = await getMasterSessionTargets(debugPort)
      return {
        sourceId: source.id,
        name: source.name,
        platformId: source.platformId,
        profileDir: source.profileDir,
        active: true,
        debugPort,
        tabs: targets.filter(target => /^https?:\/\//.test(target.url ?? '')).slice(0, 20).map(target => ({
          title: target.title ?? '',
          url: target.url ?? '',
          platformMatch: isPlatformPage(target.url ?? '', hostname, source.platformId),
        })),
      }
    } catch (error) {
      return {
        sourceId: source.id,
        name: source.name,
        platformId: source.platformId,
        profileDir: source.profileDir,
        active: null,
        debugPort: source.debugPort,
        tabs: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }))
}

function sendCdpCommand(
  socket: WebSocket,
  id: number,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('message', onMessage)
      reject(new Error(`Timed out during CDP ${method}.`))
    }, 5000)
    const onMessage = (data: Buffer | ArrayBuffer | Buffer[]) => {
      let response: Record<string, any>
      try {
        response = JSON.parse(data.toString()) as Record<string, any>
      } catch {
        return
      }
      if (response.id !== id) return
      clearTimeout(timeout)
      socket.off('message', onMessage)
      if (response.error) {
        reject(new Error(`CDP ${method} failed: ${String(response.error.message ?? 'unknown error')}`))
      } else {
        resolve(response)
      }
    }
    socket.on('message', onMessage)
    socket.send(JSON.stringify({ id, method, params }), error => {
      if (!error) return
      clearTimeout(timeout)
      socket.off('message', onMessage)
      reject(new Error(`Could not send CDP ${method}: ${error.message}`))
    })
  })
}

async function inspectMasterSession(sourceId: string, includeConversation: boolean) {
  const [
    { getMasterSessionSource },
    { findActiveMasterPort },
    { getWebPlatformById },
  ] = await Promise.all([
    import('../webRelay/session/MasterSessionRegistry.js'),
    import('../webRelay/session/SessionBroker.js'),
    import('../../utils/webPlatforms.js'),
  ])
  const source = getMasterSessionSource(sourceId)
  const debugPort = await findActiveMasterPort(sourceId)
  const base = {
    sourceId: source.id,
    name: source.name,
    platformId: source.platformId,
    profileDir: source.profileDir,
    configuredDebugPort: source.debugPort,
    active: debugPort !== null,
  }
  if (debugPort === null) {
    return { ...base, debugPort: null, tabs: [], observation: null, reason: 'Master Session Chrome is not running.' }
  }

  const platform = getWebPlatformById(source.platformId)
  if (!platform) throw new Error(`Unsupported Master Session platform "${source.platformId}".`)
  const hostname = new URL(platform.url).hostname
  const targets = await getMasterSessionTargets(debugPort)
  const pages = targets.filter(target => /^https?:\/\//.test(target.url ?? ''))
  const page = pages.find(target => isPlatformPage(target.url ?? '', hostname, source.platformId))
  const tabs = pages.slice(0, 20).map(target => ({
    title: target.title ?? '',
    url: target.url ?? '',
    platformMatch: isPlatformPage(target.url ?? '', hostname, source.platformId),
  }))
  if (!page?.webSocketDebuggerUrl) {
    return {
      ...base,
      debugPort,
      tabs,
      observation: null,
      reason: `No ${source.platformId} page is open on the verified Master Session.`,
    }
  }

  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out connecting to Chrome CDP on port ${debugPort}.`)), 5000)
    socket.once('open', () => {
      clearTimeout(timeout)
      resolve()
    })
    socket.once('error', error => {
      clearTimeout(timeout)
      reject(new Error(`Could not connect to Chrome CDP on port ${debugPort}: ${error.message}`))
    })
  })

  const contexts: CdpExecutionContext[] = []
  const onContext = (data: Buffer | ArrayBuffer | Buffer[]) => {
    try {
      const message = JSON.parse(data.toString()) as {
        method?: string
        params?: { context?: CdpExecutionContext }
      }
      if (message.method === 'Runtime.executionContextCreated' && message.params?.context) {
        contexts.push(message.params.context)
      }
    } catch {
      // Non-JSON protocol frames are not execution-context events.
    }
  }
  socket.on('message', onContext)
  let commandId = 0
  const evaluate = async (expression: string, contextId?: number): Promise<unknown> => {
    const response = await sendCdpCommand(socket, ++commandId, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      ...(contextId !== undefined ? { contextId } : {}),
    })
    const result = response.result as { exceptionDetails?: { text?: string }; result?: { value?: unknown } } | undefined
    if (result?.exceptionDetails) {
      throw new Error(`CDP page inspection failed: ${result.exceptionDetails.text ?? 'evaluation error'}`)
    }
    return result?.result?.value
  }

  try {
    await sendCdpCommand(socket, ++commandId, 'Runtime.enable')
    const pageState = await evaluate(`(() => {
      const composer = document.querySelector('[contenteditable="true"], textarea, [role="textbox"]');
      const pageText = ${includeConversation}
        ? String(document.querySelector('main')?.innerText ?? document.body?.innerText ?? '').slice(0, 12000)
        : undefined;
      return {
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        visibility: document.visibilityState,
        focused: document.hasFocus(),
        hasComposer: Boolean(composer),
        superAssistantUI: {
          popoverContainer: Boolean(document.getElementById('mcp-popover-container')),
          mcpButton: Boolean(document.querySelector('#mcp-popover-container button')),
          popoverStyles: Boolean(document.getElementById('mcp-popover-styles')),
        },
        ...(pageText !== undefined ? { pageText } : {}),
      };
    })()`)
    const assistantContext = contexts.find(context =>
      /superassistant/i.test(context.name ?? '') &&
      context.origin?.startsWith('chrome-extension://'),
    )
    const extension = assistantContext
      ? await evaluate(`(() => {
          const manifest = chrome.runtime.getManifest();
          return {
            extensionId: chrome.runtime.id,
            name: manifest.name,
            version: manifest.version,
            registry: window.pluginRegistry?.getDebugInfo?.() ?? null,
          };
        })()`, assistantContext.id)
      : null
    const extensionId = assistantContext?.origin?.match(/^chrome-extension:\/\/([^/]+)/)?.[1]
    const serviceWorkerActive = Boolean(extensionId && targets.some(target =>
      target.type === 'service_worker' &&
      target.url?.startsWith(`chrome-extension://${extensionId}/`),
    ))
    let conversationFlow: ReturnType<typeof summarizeConversationFlow>['summary'] & {
      executionActivityAvailable: boolean
      diagnostics: ReturnType<typeof summarizeConversationFlow>['diagnostics']
    } | null = null
    try {
      const { inspectConversationFlowSurface, readRecentExecutionDiagnostics } =
        await import('../webRelay/ChromeCDP.js')
      const [surface, executionEvents] = await Promise.all([
        inspectConversationFlowSurface(debugPort, source.platformId),
        extensionId && /^[a-p]{32}$/u.test(extensionId)
          ? readRecentExecutionDiagnostics(debugPort, extensionId, 100)
          : Promise.resolve(null),
      ])
      const analysis = summarizeConversationFlow(surface, executionEvents ?? [], null)
      conversationFlow = {
        ...analysis.summary,
        executionActivityAvailable: executionEvents !== null,
        diagnostics: analysis.diagnostics,
      }
    } catch (error) {
      conversationFlow = {
        observer: {
          status: 'unknown',
          targetSelectors: null,
          streamingContainerSelectors: null,
          lastTransitionAt: null,
        },
        surface: {
          available: false,
          reason: error instanceof Error ? error.message : String(error),
          platformTabCount: pages.length,
        },
        recentExecutionEvents: [],
        latestParsedCall: null,
        executionActivityAvailable: false,
        diagnostics: [{
          severity: 'warning',
          code: 'conversation-flow-inspection-failed',
          message: error instanceof Error ? error.message : String(error),
        }],
      }
    }
    return {
      ...base,
      debugPort,
      tabs,
      observation: {
        page: pageState,
        conversationFlow,
        superAssistant: {
          executionContextPresent: Boolean(assistantContext),
          serviceWorkerActive,
          extension,
        },
      },
    }
  } finally {
    socket.off('message', onContext)
    socket.close()
  }
}

function parseActivityFilters(args: Record<string, unknown>): {
  afterSequence: number
  agentIds?: string[]
  limit: number
  sources?: SharedActivitySource[]
} {
  const afterSequence = args.afterSequence ?? 0
  const limit = args.limit ?? 100
  if (typeof afterSequence !== 'number' || !Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    throw new Error('afterSequence must be a non-negative safe integer.')
  }
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error('limit must be an integer between 1 and 200.')
  }
  const agentIds = args.agentIds
  if (
    agentIds !== undefined &&
    (!Array.isArray(agentIds) || agentIds.length > 10 ||
      agentIds.some(id => typeof id !== 'string' || id.trim().length === 0))
  ) {
    throw new Error('agentIds must contain at most 10 non-empty strings.')
  }
  const sources = args.sources
  if (
    sources !== undefined &&
    (!Array.isArray(sources) || sources.length === 0 ||
      sources.some(source => typeof source !== 'string' || !ACTIVITY_SOURCES.includes(source as SharedActivitySource)))
  ) {
    throw new Error(`sources must be a non-empty list from: ${ACTIVITY_SOURCES.join(', ')}.`)
  }
  return {
    afterSequence: afterSequence as number,
    limit,
    ...(agentIds ? { agentIds: [...new Set(agentIds.map(id => (id as string).trim()))] } : {}),
    ...(sources ? { sources: [...new Set(sources as SharedActivitySource[])] } : {}),
  }
}

async function pollSelectedRelays(agentIds: string[]): Promise<void> {
  if (agentIds.length === 0) return
  const [
    { listAgents },
    { readAgentExecutionActivity },
  ] = await Promise.all([
    import('../webRelay/orchestration/MultiAgentRunner.js'),
    import('../webRelay/orchestration/Sentinel.js'),
  ])
  const registeredAgents = listAgents()
  await Promise.all(agentIds.map(async agentId => {
    const agent = registeredAgents.find(item => item.agentId === agentId)
    if (!agent) throw new Error(`Activity observer cannot read unregistered agent "${agentId}".`)
    const snapshot = await readAgentExecutionActivity(agentId)
    if (!snapshot.available) {
      sharedActivityJournal.appendOnce(
        `relay-activity-unavailable\u0000${agentId}\u0000${snapshot.unavailableReason ?? 'unknown'}`,
        {
          source: 'execution',
          event: 'relay:activity-unavailable',
          agentId,
          instanceId: agent.instanceId,
          details: { reason: snapshot.unavailableReason ?? 'unknown' },
        },
      )
      return
    }
    for (const event of snapshot.events) recordRelayExecutionActivity(agentId, event)
  }))
}

function matchesActivityFilters(
  event: { sequence: number; agentId?: string; source: SharedActivitySource },
  filters: ReturnType<typeof parseActivityFilters>,
): boolean {
  return event.sequence > filters.afterSequence &&
    (!filters.agentIds || (event.agentId !== undefined && filters.agentIds.includes(event.agentId))) &&
    (!filters.sources || filters.sources.includes(event.source))
}

async function waitForActivityChange(
  filters: ReturnType<typeof parseActivityFilters>,
  waitSeconds: number,
  selectedAgentIds: string[],
): Promise<void> {
  let pollInProgress = false
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let unsubscribe: (() => void) | undefined
  const hasResult = (): boolean => {
    const result = sharedActivityJournal.read(filters)
    return result.events.length > 0 || result.truncated
  }

  if (hasResult()) return
  return new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      if (timeout) clearTimeout(timeout)
      if (pollTimer) clearInterval(pollTimer)
      unsubscribe?.()
      resolve()
    }
    unsubscribe = sharedActivityJournal.subscribe(event => {
      if (matchesActivityFilters(event, filters)) finish()
    })
    if (hasResult()) {
      finish()
      return
    }
    const poll = async (): Promise<void> => {
      if (pollInProgress) return
      pollInProgress = true
      try {
        await pollSelectedRelays(selectedAgentIds)
        if (hasResult()) finish()
      } catch (error) {
        if (timeout) clearTimeout(timeout)
        if (pollTimer) clearInterval(pollTimer)
        unsubscribe?.()
        reject(error)
      } finally {
        pollInProgress = false
      }
    }
    void poll()
    pollTimer = setInterval(() => { void poll() }, 1500)
    timeout = setTimeout(finish, waitSeconds * 1000)
  })
}

export function getSentinelMCPTools(): ToolDefinition[] {
  return [
    {
      name: 'openmcp_read_activity',
      description: 'Read the shared, structured OpenMCP activity journal used by Sentinel, the coordinator, and workers. Includes partial or failed Relay launch warnings (relay:launch-warning and relay:launch-instance-failure). Returns bounded metadata events with a cursor; excludes prompts, model responses, tool arguments, and conversation content. Filters can scope by exact agent IDs and event source.',
      inputSchema: {
        type: 'object',
        properties: {
          afterSequence: { type: 'number', description: 'Return events after this cursor; omit or use 0 for the retained journal.' },
          limit: { type: 'number', description: 'Maximum events (1-200; defaults to 100).' },
          agentIds: { type: 'array', items: { type: 'string' }, description: 'Optional exact agent IDs (maximum 10).' },
          sources: { type: 'array', items: { type: 'string', enum: ACTIVITY_SOURCES }, description: 'Optional sources: mcp, orchestration, sentinel, collaboration, coordinator, execution.' },
        },
      },
      execute: async args => {
        await initializeSharedActivitySources()
        const filters = parseActivityFilters(args)
        if (filters.agentIds) await pollSelectedRelays(filters.agentIds)
        return JSON.stringify({
          capturedAt: new Date().toISOString(),
          ...sharedActivityJournal.read(filters),
        })
      },
    },
    {
      name: 'openmcp_watch_activity',
      description: 'Wait 1-20 seconds for shared OpenMCP activity and return structured events plus a cursor. Multiple callers (Sentinel, coordinator, workers) can use this same feed. Optionally poll up to 10 selected Relay instances for SuperAssistant execution-stage metadata every 1.5 seconds. No prompts, responses, tool arguments, or conversation text are collected.',
      inputSchema: {
        type: 'object',
        properties: {
          afterSequence: { type: 'number', description: 'Return only events after this cursor.' },
          waitSeconds: { type: 'number', description: 'Wait 1-20 seconds (defaults to 10).' },
          limit: { type: 'number', description: 'Maximum events to return (1-200; defaults to 100).' },
          agentIds: { type: 'array', items: { type: 'string' }, description: 'Optional exact registered agent IDs to monitor (maximum 10).' },
          sources: { type: 'array', items: { type: 'string', enum: ACTIVITY_SOURCES }, description: 'Optional event source filter.' },
        },
      },
      execute: async args => {
        await initializeSharedActivitySources()
        const filters = parseActivityFilters(args)
        const waitSeconds = args.waitSeconds ?? 10
        if (typeof waitSeconds !== 'number' || !Number.isInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > 20) {
          throw new Error('waitSeconds must be an integer between 1 and 20.')
        }
        if ((filters.agentIds?.length ?? 0) > 10) {
          throw new Error('agentIds must contain at most 10 non-empty strings for a live watch.')
        }
        const selectedAgentIds = filters.agentIds ?? []
        await pollSelectedRelays(selectedAgentIds)
        await waitForActivityChange(filters, waitSeconds, selectedAgentIds)
        return JSON.stringify({
          capturedAt: new Date().toISOString(),
          ...sharedActivityJournal.read(filters),
        })
      },
    },
    {
      name: 'sentinel_watch_interactions',
      description: 'Wait up to 20 seconds for live OpenMCP agent lifecycle, execution, Sentinel, or worker/coordinator collaboration events, then return the events observed. This is an in-memory long-poll, not a permanent subscription; call again to keep watching. Optionally poll recent SuperAssistant technical events for up to 10 selected agent IDs. Rendered ChatGPT text is excluded unless includeConversation=true and exactly one agentId is selected.',
      inputSchema: {
        type: 'object',
        properties: {
          waitSeconds: {
            type: 'number',
            description: 'How long to watch before returning (1-20 seconds; defaults to 10).',
          },
          agentIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional exact registered agent IDs to monitor for new SuperAssistant execution events (maximum 10).',
          },
          includeHeartbeats: {
            type: 'boolean',
            description: 'Include routine Sentinel heartbeat events. Defaults to false.',
          },
          includeConversation: {
            type: 'boolean',
            description: 'Explicitly include changes in the rendered conversation for the one selected ChatGPT Relay. Defaults to false.',
          },
        },
      },
      execute: async args => {
        const waitSeconds = args.waitSeconds ?? 10
        if (typeof waitSeconds !== 'number' || !Number.isInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > 20) {
          throw new Error('waitSeconds must be an integer between 1 and 20.')
        }
        const includeHeartbeats = args.includeHeartbeats ?? false
        if (typeof includeHeartbeats !== 'boolean') {
          throw new Error('includeHeartbeats must be a boolean.')
        }
        const includeConversation = args.includeConversation ?? false
        if (typeof includeConversation !== 'boolean') {
          throw new Error('includeConversation must be a boolean.')
        }
        const agentIds = args.agentIds ?? []
        if (
          !Array.isArray(agentIds) ||
          agentIds.length > 10 ||
          agentIds.some(agentId => typeof agentId !== 'string' || agentId.trim().length === 0)
        ) {
          throw new Error('agentIds must contain at most 10 non-empty strings.')
        }

        const requestedAgents = [...new Set(agentIds.map(agentId => agentId.trim()))]
        if (includeConversation && requestedAgents.length !== 1) {
          throw new Error('includeConversation requires exactly one selected agentId.')
        }
        const [
          { onLifecycleEvent, listAgents },
          { onSentinelEvent, readAgentExecutionActivity, readAgentConversation },
          { collaborationStore },
        ] = await Promise.all([
          import('../webRelay/orchestration/MultiAgentRunner.js'),
          import('../webRelay/orchestration/Sentinel.js'),
          import('../collaboration/CollaborationStore.js'),
        ])
        const previousConversation = new Map<string, Array<{ role: 'user' | 'assistant'; text: string }>>()
        const previousUnavailableReason = new Map<string, string>()
        for (const agentId of requestedAgents) {
          const agent = listAgents().find(item => item.agentId === agentId)
          if (!agent) {
            throw new Error(`Sentinel cannot watch unregistered agent "${agentId}".`)
          }
          if (includeConversation && agent.platformId !== 'chatgpt') {
            throw new Error('Live conversation watching currently supports ChatGPT Relays only.')
          }
        }

        const events: Array<{ source: string; timestamp: string; data: unknown }> = []
        let truncated = false
        const push = (source: string, data: unknown): void => {
          if (!watching) return
          if (events.length >= 100) {
            truncated = true
            return
          }
          events.push({ source, timestamp: new Date().toISOString(), data })
        }
        const lastCollaborationEntries = new Map(
          collaborationStore.getAll().map(entry => [entry.id, JSON.stringify(entry)]),
        )
        let stopLifecycle: (() => void) | undefined
        let stopSentinel: (() => void) | undefined
        let stopCollaboration: (() => void) | undefined
        let activityTimer: ReturnType<typeof setInterval> | undefined
        let timeout: ReturnType<typeof setTimeout> | undefined
        let activityReadInProgress = false
        let activityPoll: Promise<void> = Promise.resolve()
        let watching = true
        const seenActivity = new Map<string, Set<string>>()
        const startedAt = Date.now()

        try {
          await new Promise<void>(resolve => {
            stopLifecycle = onLifecycleEvent(event => {
              const agentId = 'agentId' in event.payload ? event.payload.agentId : undefined
              if (requestedAgents.length > 0 && agentId && !requestedAgents.includes(agentId)) return
              push('orchestration', event)
            })
            stopSentinel = onSentinelEvent(event => {
              if (event.name === 'sentinel:heartbeat' && !includeHeartbeats) return
              const agentId = 'agentId' in event.payload ? event.payload.agentId : undefined
              if (requestedAgents.length > 0 && agentId && !requestedAgents.includes(agentId)) return
              push('sentinel', event)
            })
            stopCollaboration = collaborationStore.subscribe(entries => {
              for (const entry of entries) {
                const current = JSON.stringify(entry)
                if (lastCollaborationEntries.get(entry.id) === current) continue
                lastCollaborationEntries.set(entry.id, current)
                push('collaboration', { change: 'created-or-updated', entry })
              }
            })

            if (requestedAgents.length > 0) {
              const pollActivity = async (): Promise<void> => {
                if (activityReadInProgress || events.length >= 100) return
                activityReadInProgress = true
                try {
                  for (const agentId of requestedAgents) {
                    if (!watching) break
                    const snapshot = await readAgentExecutionActivity(agentId)
                    const seen = seenActivity.get(agentId) ?? new Set<string>()
                    seenActivity.set(agentId, seen)
                    for (const activity of snapshot.events) {
                      const key = `${activity.timestamp}\u0000${activity.event}\u0000${activity.callId ?? ''}`
                      if (seen.has(key)) continue
                      seen.add(key)
                      push('execution-activity', { agentId, ...activity })
                    }
                  }
                  if (watching && includeConversation) {
                    const agentId = requestedAgents[0]!
                    const conversation = await readAgentConversation(agentId)
                    const previous = previousConversation.get(agentId)
                    if (conversation.available) {
                      previousUnavailableReason.delete(agentId)
                      const messages = conversation.messages
                      if (!previous || JSON.stringify(previous) !== JSON.stringify(messages)) {
                        let commonPrefixLength = 0
                        if (previous) {
                          while (
                            commonPrefixLength < previous.length &&
                            commonPrefixLength < messages.length &&
                            previous[commonPrefixLength]?.role === messages[commonPrefixLength]?.role &&
                            previous[commonPrefixLength]?.text === messages[commonPrefixLength]?.text
                          ) {
                            commonPrefixLength += 1
                          }
                        }
                        push('conversation', {
                          agentId,
                          messages: messages.slice(commonPrefixLength),
                          reset: previous !== undefined && commonPrefixLength < previous.length,
                          truncated: conversation.truncated,
                          capturedAt: conversation.capturedAt,
                          pageVisibility: conversation.pageVisibility,
                          pageHasFocus: conversation.pageHasFocus,
                        })
                        previousConversation.set(agentId, messages)
                      }
                    } else {
                      const reason = conversation.unavailableReason ?? 'unavailable'
                      if (previousUnavailableReason.get(agentId) !== reason) {
                        push('conversation-unavailable', { agentId, reason })
                        previousUnavailableReason.set(agentId, reason)
                      }
                    }
                  }
                } catch (error) {
                  push('activity-read-error', {
                    agentIds: requestedAgents,
                    error: error instanceof Error ? error.message : String(error),
                  })
                } finally {
                  activityReadInProgress = false
                }
              }
              activityPoll = pollActivity()
              activityTimer = setInterval(() => {
                if (!activityReadInProgress) activityPoll = pollActivity()
              }, 2000)
            }
            timeout = setTimeout(resolve, waitSeconds * 1000)
          })
        } finally {
          if (timeout) clearTimeout(timeout)
          if (activityTimer) clearInterval(activityTimer)
          stopLifecycle?.()
          stopSentinel?.()
          stopCollaboration?.()
          watching = false
          // CDP reads are independent read-only requests; do not extend the MCP wait deadline for an in-flight poll.
        }
        return JSON.stringify({
          capturedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
          truncated,
          events,
        })
      },
    },
    {
      name: 'sentinel_get_orchestration_state',
      description: 'Read the shared OpenMCP view: registered workers/agents, recent launch warnings/failures, the latest Sentinel health scan (including passive conversation-observer and tool-execution-flow checks), and collaboration findings, requests, issues, coordinator evaluations, and Sentinel observations.',
      inputSchema: {
        type: 'object',
        properties: {
          entryLimit: {
            type: 'number',
            description: 'Maximum recent collaboration entries to include (1-50; defaults to 20).',
          },
        },
      },
      execute: async args => {
        const requestedLimit = args.entryLimit ?? 20
        if (typeof requestedLimit !== 'number' || !Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 50) {
          throw new Error('entryLimit must be an integer between 1 and 50.')
        }
        const [
          { listAgents },
          { getLastScanResult },
          { collaborationStore },
        ] = await Promise.all([
          import('../webRelay/orchestration/MultiAgentRunner.js'),
          import('../webRelay/orchestration/Sentinel.js'),
          import('../collaboration/CollaborationStore.js'),
        ])
        const launchActivity = sharedActivityJournal.read({
          afterSequence: 0,
          limit: 200,
          sources: ['orchestration'],
        })
        const launchEvents = launchActivity.events
          .filter(event =>
            event.event === 'relay:launch-warning' ||
            event.event === 'relay:launch-instance-failure',
          )
          .slice(-20)
        return JSON.stringify({
          capturedAt: new Date().toISOString(),
          agents: listAgents().map(agent => ({
            agentId: agent.agentId,
            platformId: agent.platformId,
            role: agent.role ?? null,
            status: agent.status,
            sessionMode: agent.sessionMode ?? null,
            masterSessionSourceId: agent.masterSessionSourceId ?? null,
            instanceId: agent.instanceId ?? null,
            debugPort: agent.debugPort ?? null,
            activeExecutions: agent.activeExecutions,
            unknownExecutions: agent.unknownExecutions,
            lastHeartbeat: agent.lastHeartbeat ?? null,
          })),
          sentinel: getLastScanResult(),
          launchEvents,
          collaboration: {
            snapshot: collaborationStore.getSnapshot(),
            recentEntries: collaborationStore.getAll().slice(-requestedLimit),
          },
        })
      },
    },
    {
      name: 'sentinel_list_instances',
      description: 'List registered Web Relay agents and every configured Master Session, including verified active profile/port mappings and open page titles/URLs. Master Sessions are included even when they are not in the worker pool.',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => {
        const { listAgents } = await import('../webRelay/orchestration/MultiAgentRunner.js')
        const agents = listAgents().map(agent => ({
          agentId: agent.agentId,
          platformId: agent.platformId,
          role: agent.role ?? null,
          status: agent.status,
          sessionMode: agent.sessionMode ?? null,
          masterSessionSourceId: agent.masterSessionSourceId ?? null,
          instanceId: agent.instanceId ?? null,
          debugPort: agent.debugPort ?? null,
          activeExecutions: agent.activeExecutions,
          unknownExecutions: agent.unknownExecutions,
          lastHeartbeat: agent.lastHeartbeat ?? null,
        }))
        const masterSessions = await readMasterSessionInventory()
        return JSON.stringify({
          capturedAt: new Date().toISOString(),
          agents,
          masterSessions,
          instances: [
            ...agents.map(agent => ({ kind: 'web-relay' as const, ...agent })),
            ...masterSessions.map(source => ({ kind: 'master-session' as const, ...source })),
          ],
        })
      },
    },
    {
      name: 'sentinel_inspect_instance',
      description: 'Inspect exactly one registered Web Relay (agentId) or registered Master Session (sourceId). For a Relay, call sentinel_list_instances first to discover its current agentId/instanceId/status, then inspect by exact agentId; if status is sa_preparing, retry after launch preparation completes. Inspection includes page/composer readiness, SuperAssistant observer selector/activity state, structural detection of complete unrendered tool-call blocks, bounded tool-execution lifecycle metadata, UI/preferences, plugin registry, runtime messaging, process-wide MCP health, and recent technical activity. For chrome-profile ChatGPT Relays it also reports the Relay authentication state and whether Chrome rewrote the copied cookie database after launch; this distinguishes login required in the isolated Relay from an MCP/SuperAssistant failure. No cookie values are read or returned. It does not read page text or tool arguments by default. Set includeConversation=true only when the user explicitly authorizes a bounded page-text snapshot.',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'Exact registered OpenMCP agent ID.' },
          sourceId: { type: 'string', description: 'Exact registered Master Session source ID.' },
          includeConversation: {
            type: 'boolean',
            description: 'Include a bounded page-text snapshot for an authorized Relay or Master Session. Defaults to false.',
          },
        },
        oneOf: [
          { required: ['agentId'], not: { required: ['sourceId'] } },
          { required: ['sourceId'], not: { required: ['agentId'] } },
        ],
      },
      execute: async args => {
        const selector = requireInstanceSelector(args)
        if (args.includeConversation !== undefined && typeof args.includeConversation !== 'boolean') {
          throw new Error('includeConversation must be a boolean when provided.')
        }
        if ('sourceId' in selector) {
          const masterSession = await inspectMasterSession(
            selector.sourceId,
            args.includeConversation === true,
          )
          return JSON.stringify({
            capturedAt: new Date().toISOString(),
            masterSession,
          })
        }
        const { agentId } = selector
        const [{ listAgents }, { readAgentExecutionActivity, readAgentConversation }] = await Promise.all([
          import('../webRelay/orchestration/MultiAgentRunner.js'),
          import('../webRelay/orchestration/Sentinel.js'),
        ])
        const agent = listAgents().find(item => item.agentId === agentId)
        if (!agent) {
          throw new Error(`Sentinel cannot inspect unregistered agent "${agentId}".`)
        }
        const activity = await readAgentExecutionActivity(agentId)
        const [conversation, diagnostic] = await Promise.all([
          args.includeConversation === true ? readAgentConversation(agentId) : Promise.resolve(undefined),
          inspectRelayRuntime(agent, activity.events),
        ])
        return JSON.stringify({
          capturedAt: new Date().toISOString(),
          agent: {
            agentId: agent.agentId,
            platformId: agent.platformId,
            role: agent.role ?? null,
            status: agent.status,
            sessionMode: agent.sessionMode ?? null,
            masterSessionSourceId: agent.masterSessionSourceId ?? null,
            instanceId: agent.instanceId ?? null,
            debugPort: agent.debugPort ?? null,
            activeExecutions: agent.activeExecutions,
            unknownExecutions: agent.unknownExecutions,
            lastHeartbeat: agent.lastHeartbeat ?? null,
          },
          diagnostic,
          activity,
          ...(conversation ? { conversation } : {}),
        })
      },
    },
    {
      name: 'sentinel_capture_instance_view',
      description: 'Capture and return one JPEG viewport from an explicitly selected, ready OpenMCP Relay. Use only after the user explicitly authorizes visual capture. This is read-only: it does not focus, navigate, reload, or persist the page image.',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: {
            type: 'string',
            description: 'Exact registered OpenMCP Relay agent ID to capture.',
          },
          userApproved: {
            type: 'boolean',
            description: 'Must be true only after the user explicitly approves capturing this selected Relay.',
          },
        },
        required: ['agentId', 'userApproved'],
      },
      execute: async args => {
        const agentId = requireAgentId(args)
        if (args.userApproved !== true) {
          throw new Error('Visual capture requires explicit user approval (userApproved=true).')
        }
        const { listAgents } = await import('../webRelay/orchestration/MultiAgentRunner.js')
        const agent = listAgents().find(item => item.agentId === agentId)
        if (!agent) {
          throw new Error(`Sentinel cannot capture unregistered agent "${agentId}".`)
        }
        if (agent.status !== 'ready') {
          throw new Error(`Relay "${agentId}" is not ready for visual capture (status: ${agent.status}).`)
        }
        if (agent.debugPort === undefined) {
          throw new Error(`Relay "${agentId}" has no registered Chrome debug port.`)
        }

        const { captureRelayScreenshot } = await import('../webRelay/ChromeCDP.js')
        const screenshot = await captureRelayScreenshot(
          agent.agentId,
          agent.debugPort,
          agent.platformId,
        )
        return {
          content: [
            {
              type: 'text',
              text: `Captured the current ${screenshot.platformId} viewport for Relay "${screenshot.agentId}" at ${screenshot.capturedAt}.`,
            },
            {
              type: 'image',
              data: screenshot.data,
              mimeType: screenshot.mimeType,
            },
          ],
        }
      },
    },
  ]
}
