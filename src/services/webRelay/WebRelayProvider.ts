import { runSAStartupAutomationControls } from './SAStartupAutomationControls.js'
import { SA_COMPOSER_BUTTON_SELECTOR, SA_COMPOSER_READINESS_SCRIPT } from './SAComposerReadiness.js'
/**
 * WebRelayProvider — Unified web relay with SA mode + CDP fallback.
 *
 * Two operating modes:
 *
 * SA MODE (preferred, safe):
 *   TUI → MCP SSE Server → SA extension → ChatGPT → SA tools → MCP → TUI
 *   - All DOM interaction through SA's isolated extension context
 *   - No ban risk, persistent across navigation
 *   - CDP only used for initial navigation + verification
 *
 * CDP FALLBACK (when SA not available):
 *   TUI → CDP inject → ChatGPT → BridgeScript → CDP → TUI
 *   - Direct DOM manipulation via CDP Runtime.evaluate
 *   - Ban risk warning shown to user
 *   - Functional but less safe
 */

import { conversationAccess, browserConversationResource } from './ConversationAccess.js'
import { performStartupHandshake, type StartupHandshakeEvidence } from './StartupHandshake.js'
import { randomUUID } from 'crypto'
import { getCurrentProjectConfig } from '../../utils/config.js'
import { getAgentId } from '../../utils/teammate.js'
import {
  createWebInstance,
  getWebInstance,
  listWebInstances,
  updateWebInstance,
  reclaimStalePortLocks,
} from './WebInstanceRegistry.js'
import { listAgents, setAgentStartupVerificationStatus } from './orchestration/MultiAgentRunner.js'
import { getWebPlatformById } from '../../utils/webPlatforms.js'
import { isRoutableWebRelayAgent } from './isRoutableWebRelayAgent.js'
import {
  CDPConnection,
  launchChrome,
  killChrome,
  ensureSAExtensionLoaded,
  findExistingSAExtensionContext,
  waitForPlatformPageTarget,
  isDebugPortActive,
  stampInstanceIdentity,
} from './ChromeCDP.js'
import {
  checkSAPluginRegistry,
  inspectSAConfiguration,
} from './SAHealthCheck.js'
import { getAdapter, buildInsertScript } from './PlatformAdapters.js'
import {
  getBridgeScript,
  CHECK_PENDING_CALLS,
  formatToolResultMessage,
  formatToolDefsForInjection,
} from './BridgeScript.js'
import {
  executeToolCall,
  filterToolsForWebMode,
  formatSuperAssistantPrompt,
  MAX_TOOL_LOOPS,
} from './WebToolBridge.js'
import { applicationMCPServer as mcpServer, startApplicationMCPBridge } from '../mcpServer/ApplicationMCPBridge.js'
import { MCP_PORT } from '../mcpServer/mcpPort.js'
import { adaptToolsForMCP, getOpenWeblockCoreTools } from '../mcpServer/ToolAdapter.js'
import { runStartupCheck, formatCheckResult } from './StartupChecker.js'
// @ts-ignore — ws types not installed in this project
import { WebSocket } from 'ws'

// ─── Types ──────────────────────────────────────────────────────────

type Message = {
  type: string
  message: { role: string; content: any }
  [key: string]: unknown
}

async function hasExternalRelayControlApi(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${MCP_PORT}/relay/status`, {
      signal: AbortSignal.timeout(1500),
    })
    if (!response.ok) return false
    const status = await response.json() as { available?: unknown }
    return status.available === true
  } catch {
    return false
  }
}

async function sendRelayPrompt(text: string, platform: string): Promise<void> {
  if (mcpServer) {
    mcpServer.sendPrompt(text, platform)
    return
  }

  const response = await fetch(`http://127.0.0.1:${MCP_PORT}/relay/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, platform }),
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) {
    throw new Error(`MCP relay rejected the prompt (${response.status})`)
  }
}

async function waitForRelayResponse(timeoutMs: number): Promise<{ text: string; platform?: string } | null> {
  if (mcpServer) return mcpServer.waitForResponse(timeoutMs)

  const response = await fetch(
    `http://127.0.0.1:${MCP_PORT}/relay/response?timeoutMs=${timeoutMs}`,
    { signal: AbortSignal.timeout(timeoutMs + 5000) },
  )
  if (response.status === 204) return null
  if (!response.ok) {
    throw new Error(`MCP relay response request failed (${response.status})`)
  }
  return await response.json() as { text: string; platform?: string }
}

type StreamEvent = { type: string; [key: string]: unknown }

type AssistantMessage = {
  type: 'assistant'
  message: { role: 'assistant'; content: Array<{ type: string; text: string }> }
  costUSD: number
  durationMs: number
  requestId: string
  model: string
  [key: string]: unknown
}

type SystemAPIErrorMessage = {
  type: 'system'
  message: { content: string }
}

interface WebRelayCallModelParams {
  messages: Message[]
  systemPrompt: any
  thinkingConfig: any
  tools: any[]
  signal: AbortSignal
  options: any
}

// ─── SA Configuration ───────────────────────────────────────────────

const SA_EXTENSION_ID = 'kngiafgkdnlkgmefdafaibkibegkcaef'
const DEBUG_PORT = 9222

/**
 * Configure SA extension to connect to our MCP server via Streamable HTTP.
 * Connects via the isolated page context of the AI platform or service worker storage.
 */
async function configureSAForMCP(
  debugPort: number = DEBUG_PORT,
  extensionId?: string,
  platformId?: string,
  reloadBeforeConfiguration = false,
): Promise<boolean> {
  try {
    const selectedPlatformId = platformId ?? getCurrentProjectConfig().selectedWebPlatform ?? 'chatgpt'
    const selectedPlatform = getWebPlatformById(selectedPlatformId)
    if (platformId && !selectedPlatform) {
      throw new Error(`Unknown web platform "${platformId}" for SuperAssistant configuration`)
    }
    const page = await waitForPlatformPageTarget(debugPort, selectedPlatformId)

    if (page?.webSocketDebuggerUrl) {
      const pageWs = new WebSocket(page.webSocketDebuggerUrl)
      await new Promise<void>((r, j) => { pageWs.on('open', r); pageWs.on('error', j); setTimeout(j, 5000) })

      if (reloadBeforeConfiguration) {
        await enablePageEvents(pageWs, selectedPlatformId)
        await waitForPageReloadReady(pageWs, selectedPlatformId)
      }

      const saContextId = await waitForSAExecutionContext(pageWs, extensionId)

      if (saContextId) {
        const serverConfigUpdated = await new Promise<boolean>((resolve, reject) => {
          const id = 101
          const timeout = setTimeout(() => {
            pageWs.off('message', h)
            reject(new Error('Timed out while updating SA MCP server configuration'))
          }, 5000)
          const h = (d: any) => {
            try {
              const m = JSON.parse(d.toString())
              if (m.id !== id) return
              clearTimeout(timeout)
              pageWs.off('message', h)
              if (m.error) {
                reject(new Error(m.error.message || 'SA rejected the MCP server configuration'))
                return
              }
              resolve(
                m.result?.result?.value?.success === true &&
                m.result?.result?.value?.payload?.success === true,
              )
            } catch (error) {
              pageWs.off('message', h)
              reject(error)
            }
          }
          pageWs.on('message', h)
          pageWs.send(JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: {
              contextId: saContextId,
              expression: `
                new Promise((resolve) => {
                  chrome.runtime.sendMessage({
                    type: 'mcp:update-server-config',
                    payload: {
                      config: {
                        uri: 'http://localhost:${MCP_PORT}/mcp',
                        connectionType: 'streamable-http'
                      }
                    }
                  }, resolve);
                })
              `,
              awaitPromise: true,
              returnByValue: true
            }
          }))
        })

        if (!serverConfigUpdated) {
          pageWs.close()
          throw new Error('SuperAssistant did not accept the MCP server configuration')
        }

        let preferencesConfigured: boolean
        try {
          preferencesConfigured = await configureSAAutomationPreferences(
            pageWs,
            saContextId,
            selectedPlatformId,
            debugPort,
            extensionId,
            page.id,
          )
        } finally {
          pageWs.close()
        }
        if (!preferencesConfigured) {
          throw new Error('SuperAssistant did not persist the required automation preferences')
        }
        console.log('[WebRelay] SA configured via isolated context → StreamableHTTP on port', MCP_PORT)
        return true
      }
      pageWs.close()
    }

    throw new Error(
      `SuperAssistant content execution context was not found on Chrome port ${debugPort}; ` +
      'refusing to write unrecognized service-worker storage keys.',
    )
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`SA/MCP setup failed on Chrome port ${debugPort}: ${detail}`)
  }
}

export async function waitForSAExecutionContext(
  pageWs: WebSocket,
  extensionId?: string,
  timeoutMs = 15_000,
): Promise<number | null> {
  const extensionOrigins = [extensionId, SA_EXTENSION_ID]
    .filter((value): value is string => Boolean(value))
    .map(value => `chrome-extension://${value}`)

  return new Promise<number | null>((resolve, reject) => {
    const pendingProbes = new Map<number, number>()
    const probedContexts = new Set<number>()
    let nextProbeId = 1000
    const cleanup = () => {
      clearTimeout(timeout)
      pageWs.off('message', onMessage)
      pageWs.off('error', onError)
      pageWs.off('close', onClose)
    }
    const timeout = setTimeout(() => {
      cleanup()
      resolve(null)
    }, timeoutMs)
    const onMessage = (data: any) => {
      try {
        const message = JSON.parse(data.toString())
        if (typeof message.id === 'number' && pendingProbes.has(message.id)) {
          const contextId = pendingProbes.get(message.id)
          pendingProbes.delete(message.id)
          if (contextId === undefined) return
          if (
            !message.error &&
            message.result?.result?.value === true
          ) {
            cleanup()
            resolve(contextId)
          }
          return
        }
        if (message.id === 98) {
          if (message.error) {
            cleanup()
            reject(new Error(message.error.message || 'Could not reset the CDP Runtime domain'))
            return
          }
          pageWs.send(JSON.stringify({ id: 99, method: 'Runtime.enable' }))
          return
        }
        if (message.id === 99) {
          if (message.error) {
            cleanup()
            reject(new Error(message.error.message || 'Could not enable the CDP Runtime domain'))
          }
          return
        }
        if (message.method !== 'Runtime.executionContextCreated') return
        const context = message.params?.context
        if (
          typeof context?.id === 'number' &&
          !probedContexts.has(context.id) &&
          typeof context.origin === 'string' &&
          extensionOrigins.some(origin =>
            context.origin === origin || context.origin.startsWith(`${origin}/`),
          )
        ) {
          // Claude may expose several extension worlds; only the usable content context has runtime messaging.
          probedContexts.add(context.id)
          const probeId = nextProbeId++
          pendingProbes.set(probeId, context.id)
          pageWs.send(JSON.stringify({
            id: probeId,
            method: 'Runtime.evaluate',
            params: {
              contextId: context.id,
              expression: `typeof chrome !== 'undefined' && typeof chrome.runtime?.sendMessage === 'function'`,
              returnByValue: true,
            },
          }))
        }
      } catch (error) {
        cleanup()
        reject(error)
      }
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onClose = () => {
      cleanup()
      reject(new Error('CDP connection closed while waiting for the SuperAssistant page context'))
    }

    pageWs.on('message', onMessage)
    pageWs.on('error', onError)
    pageWs.on('close', onClose)
    pageWs.send(JSON.stringify({ id: 98, method: 'Runtime.disable' }))
  })
}

async function configureSAAutomationPreferences(
  pageWs: WebSocket,
  contextId: number,
  platformId: string,
  debugPort: number,
  extensionId?: string,
  targetId?: string,
): Promise<boolean> {
  await waitForSAInstanceConnection(pageWs, contextId, debugPort)
  await waitForCompactComposerButton(pageWs, platformId)
  await verifySAAutomationControls(pageWs, platformId, contextId, true)

  await enablePageEvents(pageWs, platformId)
  await waitForPageReloadReady(pageWs, platformId)
  const reloadedSaContextId = await waitForSAExecutionContext(pageWs, extensionId)
  if (reloadedSaContextId === null) {
    pageWs.close()
    throw new Error(
      `SuperAssistant execution context did not return on the ${platformId} page after reload.`,
    )
  }
  await waitForSAInstanceConnection(pageWs, reloadedSaContextId, debugPort)
  await waitForCompactComposerButton(pageWs, platformId)
  await verifySAAutomationControls(pageWs, platformId, reloadedSaContextId, false)
  await waitForSAPluginRegistry(debugPort, platformId, extensionId, targetId)
  return true
}

async function waitForSAInstanceConnection(
  pageWs: WebSocket,
  contextId: number,
  debugPort: number,
  timeoutMs = 20_000,
): Promise<void> {
  const result = await new Promise<{ connected: boolean; detail?: string }>((resolve, reject) => {
    const id = 203
    const timeout = setTimeout(() => {
      pageWs.off('message', handler)
      reject(new Error(`Timed out checking this Chrome instance's SuperAssistant connection on port ${debugPort}.`))
    }, timeoutMs + 5_000)
    const handler = (data: any) => {
      try {
        const message = JSON.parse(data.toString())
        if (message.id !== id) return
        clearTimeout(timeout)
        pageWs.off('message', handler)
        if (message.error) {
          reject(new Error(message.error.message || 'Could not query this instance’s SuperAssistant connection.'))
          return
        }
        const value = message.result?.result?.value
        if (!value || typeof value !== 'object' || typeof value.connected !== 'boolean') {
          reject(new Error('This instance returned an invalid SuperAssistant connection status.'))
          return
        }
        resolve(value)
      } catch (error) {
        clearTimeout(timeout)
        pageWs.off('message', handler)
        reject(error)
      }
    }
    pageWs.on('message', handler)
    pageWs.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: {
        contextId,
        expression: `new Promise(resolve => {
          const deadline = Date.now() + ${timeoutMs};
          const check = () => {
            chrome.runtime.sendMessage(
              { type: 'mcp:get-connection-status', payload: {} },
              response => {
                const runtimeError = chrome.runtime.lastError?.message;
                if (!runtimeError && response?.success === true &&
                    response.payload?.isConnected === true) {
                  resolve({ connected: true });
                  return;
                }
                if (Date.now() >= deadline) {
                  resolve({
                    connected: false,
                    detail: runtimeError || response?.error ||
                      response?.payload?.status || 'disconnected'
                  });
                  return;
                }
                setTimeout(check, 500);
              }
            );
          };
          check();
        })`,
        awaitPromise: true,
        returnByValue: true,
      },
    }))
  })

  if (!result.connected) {
    throw new Error(
      `SuperAssistant controls are present, but this Chrome instance's own extension did not confirm an MCP connection ` +
      `on Chrome port ${debugPort} (${result.detail ?? 'disconnected'}).`,
    )
  }
}

async function waitForSAPluginRegistry(
  debugPort: number,
  platformId: string,
  extensionId?: string,
  targetId?: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastReadiness: ReturnType<typeof checkSAPluginRegistry> | undefined

  while (Date.now() < deadline) {
    const snapshot = await inspectSAConfiguration(
      debugPort,
      platformId,
      targetId,
      extensionId,
    )
    if (!snapshot) {
      throw new Error(
        `Could not inspect SuperAssistant plugin registry on the selected ${platformId} page.`,
      )
    }
    lastReadiness = checkSAPluginRegistry(snapshot.pluginRegistry, platformId)
    if (lastReadiness.ready) return
    await sleep(500)
  }

  throw new Error(
    `SuperAssistant plugin registry did not become complete on ${platformId} within ${timeoutMs}ms. ` +
    `Last observed readiness: ${JSON.stringify(lastReadiness ?? { ready: false })}. ` +
    'The Relay will not be marked ready with missing core plugins, adapter factories, or platform adapter.',
  )
}

async function enablePageEvents(pageWs: WebSocket, platformId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pageWs.off('message', handler)
      reject(new Error(`Timed out while enabling ${platformId} page events`))
    }, 5000)
    const handler = (data: any) => {
      try {
        const message = JSON.parse(data.toString())
        if (message.id !== 203) return
        clearTimeout(timeout)
        pageWs.off('message', handler)
        if (message.error) {
          reject(new Error(message.error.message || `Could not enable ${platformId} page events`))
          return
        }
        resolve()
      } catch (error) {
        clearTimeout(timeout)
        pageWs.off('message', handler)
        reject(error)
      }
    }
    pageWs.on('message', handler)
    pageWs.send(JSON.stringify({ id: 203, method: 'Page.enable' }))
  })
}

export async function waitForPageReloadReady(
  pageWs: WebSocket,
  platformId: string,
  timeoutMs = 30_000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let topFrameNavigated = false
    let domContentLoaded = false
    let reloadAcknowledged = false
    const cleanup = () => {
      clearTimeout(timeout)
      pageWs.off('message', handler)
      pageWs.off('error', onError)
      pageWs.off('close', onClose)
    }
    const finishIfReady = () => {
      if (!topFrameNavigated || !domContentLoaded || !reloadAcknowledged) return
      cleanup()
      resolve()
    }
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(
        `${platformId} page did not reach the post-reload DOM-ready state within ${timeoutMs}ms ` +
        `(acknowledged=${reloadAcknowledged}, topFrameNavigated=${topFrameNavigated}, ` +
        `domContentLoaded=${domContentLoaded}).`,
      ))
    }, timeoutMs)
    const onError = (error: Error) => {
      cleanup()
      reject(new Error(`CDP failed while waiting for ${platformId} page reload: ${error.message}`))
    }
    const onClose = () => {
      cleanup()
      reject(new Error(`CDP closed while waiting for ${platformId} page reload`))
    }
    const handler = (data: any) => {
      try {
        const message = JSON.parse(data.toString())
        if (message.id === 204) {
          if (message.error) {
            cleanup()
            reject(new Error(message.error.message || `Could not reload ${platformId} after configuring SA`))
            return
          }
          reloadAcknowledged = true
          finishIfReady()
          return
        }
        if (
          message.method === 'Page.frameNavigated' &&
          !message.params?.frame?.parentId &&
          /^https?:\/\//.test(String(message.params?.frame?.url || ''))
        ) {
          topFrameNavigated = true
          finishIfReady()
          return
        }
        if (message.method === 'Page.domContentEventFired') {
          domContentLoaded = true
          finishIfReady()
        }
      } catch (error) {
        cleanup()
        reject(error)
      }
    }
    pageWs.on('message', handler)
    pageWs.on('error', onError)
    pageWs.on('close', onClose)
    pageWs.send(JSON.stringify({ id: 204, method: 'Page.reload' }))
  })
}

async function verifySAAutomationControls(
  pageWs: WebSocket,
  platformId: string,
  contextId: number,
  configure: boolean,
  timeoutMs = 15_000,
): Promise<void> {
  let requestId = 300
  const evaluate = async <T>(expression: string): Promise<T | undefined> => {
    const id = requestId++
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pageWs.off('message', handler)
        reject(new Error('Timed out while verifying rendered SuperAssistant automation controls'))
      }, 3000)
      const handler = (data: any) => {
        try {
          const message = JSON.parse(data.toString())
          if (message.id !== id) return
          clearTimeout(timeout)
          pageWs.off('message', handler)
          if (message.error) {
            reject(new Error(message.error.message || 'Could not inspect SuperAssistant automation controls'))
            return
          }
          if (message.result?.exceptionDetails) {
            const details = message.result.exceptionDetails
            const exception = details.exception
            const description = typeof exception?.description === 'string'
              ? exception.description
              : typeof exception?.value === 'string'
                ? exception.value
                : undefined
            const location = Number.isInteger(details.lineNumber)
              ? ` at expression line ${details.lineNumber + 1}` +
                (Number.isInteger(details.columnNumber) ? `, column ${details.columnNumber + 1}` : '')
              : ''
            const detail = [details.text, description].filter(
              (value): value is string => typeof value === 'string' && value.length > 0,
            ).join(': ').slice(0, 1200)
            reject(new Error(
              `SuperAssistant UI inspection raised a JavaScript exception${location}` +
              (detail ? `: ${detail}` : ''),
            ))
            return
          }
          resolve(message.result?.result?.value as T | undefined)
        } catch (error) {
          clearTimeout(timeout)
          pageWs.off('message', handler)
          reject(error)
        }
      }
      pageWs.on('message', handler)
      pageWs.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { returnByValue: true, awaitPromise: true, contextId, expression },
      }))
    })
  }

  await runSAStartupAutomationControls(evaluate, { platformId, configure, timeoutMs })
}

async function waitForCompactComposerButton(
  pageWs: WebSocket,
  platformId: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let requestId = 204
  let lastState: {
    readyState: string
    visibilityState: string
    buttonPresent: boolean
    compact: boolean
    insideComposer: boolean
    visible: boolean
    width: number
    height: number
  } | undefined

  while (Date.now() < deadline) {
    const state = await new Promise<typeof lastState>((resolve, reject) => {
      const id = requestId++
      const timeout = setTimeout(() => {
        pageWs.off('message', handler)
        reject(new Error('Timed out while checking the compact SuperAssistant composer button'))
      }, 3000)
      const handler = (data: any) => {
        try {
          const message = JSON.parse(data.toString())
          if (message.id !== id) return
          clearTimeout(timeout)
          pageWs.off('message', handler)
          if (message.error) {
            reject(new Error(message.error.message || 'Could not inspect the compact SuperAssistant button'))
            return
          }
          resolve(message.result?.result?.value)
        } catch (error) {
          clearTimeout(timeout)
          pageWs.off('message', handler)
          reject(error)
        }
      }
      pageWs.on('message', handler)
      pageWs.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: {
          returnByValue: true,
          expression: SA_COMPOSER_READINESS_SCRIPT,
        },
      }))
    })

    const compactComposerReady = platformId !== 'chatgpt' ||
      (state?.compact === true && state.insideComposer)
    if (state?.visible && compactComposerReady) return
    if (state) lastState = state
    await sleep(500)
  }

  throw new Error(
    `SuperAssistant compact composer control was not ready on the ${platformId} page within ${timeoutMs}ms. ` +
    `Last observed state: ${JSON.stringify(lastState ?? { ready: false })}. ` +
    'The agent will not be marked ready without its compact interface.',
  )
}

export async function prepareSAAgentForWebRelay(
  debugPort: number,
  extensionId?: string,
  platformId?: string,
): Promise<void> {
  const preparationKey = await getSAContextPreparationKey(debugPort, platformId)

  if (!mcpServer && !(await hasExternalRelayControlApi())) {
    let serverResponds = false
    try {
      const response = await fetch(`http://127.0.0.1:${MCP_PORT}/healthz`, {
        signal: AbortSignal.timeout(1500),
      })
      serverResponds = response.ok
    } catch {
      serverResponds = false
    }

    if (serverResponds) {
      throw new Error(
        `MCP server on :${MCP_PORT} is running an older build without the local relay API. ` +
        'Restart scripts/start-mcp-server.ts before preparing Web Relay agents.',
      )
    }

    await startApplicationMCPBridge()
  }

  const extension = extensionId
    ? await findExistingSAExtensionContext(debugPort, platformId) ?? {
      extensionId,
      requiresPageReload: true,
    }
    : await ensureSAExtensionLoaded(debugPort, platformId)
  if (extensionId && extension.extensionId !== extensionId) {
    throw new Error(
      `The active SuperAssistant page context (${extension.extensionId}) does not match the loaded extension (${extensionId}).`,
    )
  }
  const configured = await configureSAForMCP(
    debugPort,
    extension.extensionId,
    platformId,
    extension.requiresPageReload,
  )
  if (!configured) {
    throw new Error(
      `Could not configure SuperAssistant on Chrome port ${debugPort}. ` +
      'Verify its extension service worker and selected platform tab are available, and confirm the compact MCP button appears in the composer before chat starts.',
    )
  }

  await waitForSAConnection()
  const preparedInstance = listWebInstances().find(
    instance => instance.debugPort === debugPort && instance.status !== 'stopped',
  )
  if (preparedInstance) {
    runtimeStates.set(preparedInstance.instanceId, {
      operatingMode: 'sa',
      initialized: true,
    })
  }
  if (preparationKey) preparedSAContexts.add(preparationKey)
}

const preparedSAContexts = new Set<string>()

async function getSAContextPreparationKey(debugPort: number, platformId?: string): Promise<string | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, {
      signal: AbortSignal.timeout(1500),
    })
    if (!response.ok) return undefined
    const version = await response.json() as { webSocketDebuggerUrl?: unknown }
    if (typeof version.webSocketDebuggerUrl !== 'string') return undefined
    return `${debugPort}\0${platformId ?? ''}\0${version.webSocketDebuggerUrl}`
  } catch {
    return undefined
  }
}

async function waitForSAConnection(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastState = 'no status response'

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${MCP_PORT}/status`, {
        signal: AbortSignal.timeout(1500),
      })
      if (response.ok) {
        const status = await response.json() as {
          connections?: unknown
          tools?: unknown
        }
        const connections = Number(status.connections)
        const tools = Number(status.tools)
        lastState = `connections=${connections}, tools=${tools}`
        if (connections > 0 && tools > 0) return
      } else {
        lastState = `HTTP ${response.status}`
      }
    } catch (error) {
      lastState = error instanceof Error ? error.message : String(error)
    }

    await sleep(500)
  }

  throw new Error(
    `SuperAssistant did not establish an MCP connection with tools on :${MCP_PORT} within ${timeoutMs}ms (${lastState}).`,
  )
}

// ─── State ──────────────────────────────────────────────────────────

const cdpConnections = new Map<string, CDPConnection>()
// The MCP server is owned by the application lifecycle, independently of browser instances.
type WebRelayRuntimeState = {
  operatingMode: 'sa' | 'cdp' | null
  initialized: boolean
}

const runtimeStates = new Map<string, WebRelayRuntimeState>()


let toolsRegistered = false

const MAIN_WEB_AGENT_KEY = 'web-relay-main'

// NOTE (corrección forense): reclaimStalePortLocks() quedó definida en
// WebInstanceRegistry.ts pero nunca se invocaba desde ningún punto de
// arranque real. Sin esto, un lock de puerto sobrevive en disco a un proceso
// muerto para siempre — el propio mecanismo pensado para sobrevivir a un
// reinicio del CLI (D2/C2) se convierte él mismo en el recurso que se agota.
// Se ejecuta una sola vez por proceso, en el primer punto donde se resuelve
// una instancia (justo antes de que pueda asignarse un puerto nuevo).
let staleLocksReclaimed = false
function reclaimStaleLocksOnce(): void {
  if (staleLocksReclaimed) return
  staleLocksReclaimed = true
  try {
    const reclaimed = reclaimStalePortLocks()
    if (reclaimed > 0) {
      console.log(`[WebRelay] Reclaimed ${reclaimed} stale port lock(s) left by dead process(es)`)
    }
  } catch (err) {
    console.error('[WebRelay] Failed to reclaim stale port locks:', err)
  }
}

function resolveWebInstance(
  platformId: string,
  agentId?: string,
): ReturnType<typeof createWebInstance> {
  reclaimStaleLocksOnce()
  const config = getCurrentProjectConfig()
  const preparedAgentIds = config.webRelayAgentIds
  if (agentId) {
    if (!preparedAgentIds?.includes(agentId)) {
      throw new Error(`Web Relay agent ${agentId} is not in the configured agent pool.`)
    }
    const agent = listAgents().find(candidate =>
      candidate.agentId === agentId && isRoutableWebRelayAgent(candidate, platformId),
    )
    if (!agent?.instanceId) {
      throw new Error(`Configured Web Relay agent ${agentId} is not ready for ${platformId}.`)
    }
    const instance = getWebInstance(agent.instanceId)
    if (!instance) {
      throw new Error(`Configured Web Relay agent ${agentId} has no registered Chrome instance.`)
    }
    return instance
  }
  if (preparedAgentIds?.length) {
    const preparedAgents = preparedAgentIds
      .map(agentId => listAgents().find(agent => agent.agentId === agentId))
      .filter((agent): agent is NonNullable<typeof agent> =>
        Boolean(agent && isRoutableWebRelayAgent(agent, platformId)),
      )
    const selectedAgent = preparedAgents[0]
    if (!selectedAgent?.instanceId) {
      const statuses = preparedAgentIds.map(agentId => {
        const agent = listAgents().find(candidate => candidate.agentId === agentId)
        return `${agentId}: ${agent?.status ?? 'not registered'}`
      })
      throw new Error(
        `No configured ${platformId} Web Relay agent is ready. ${statuses.join('; ')}`,
      )
    }
    const preparedInstance = getWebInstance(selectedAgent.instanceId)
    if (!preparedInstance) {
      throw new Error(
        `Configured Web Relay agent ${selectedAgent.agentId} has no registered Chrome instance.`,
      )
    }
    return preparedInstance
  }

  // NOTE (reconciliacion, ver docs/ADR): antes se fabricaba aqui una clave
  // compuesta `${logicalAgentId}:${platformId}` y se pasaba como si fuera el
  // agentId puro a createWebInstance()/getWebInstanceForAgent(), contaminando
  // WebInstance.agentId con la plataforma (un agente lógico debe poder tener
  // una instancia por plataforma sin que esa composición se filtre al campo
  // público). agentId ahora es siempre el agente lógico puro; platformId es
  // siempre la plataforma por separado. La necesidad de negocio original
  // (una instancia por agente+plataforma) se resuelve buscando entre TODAS
  // las instancias del agente por su platformId, en vez de indexar por una
  // clave compuesta — WebInstanceRegistry sigue sin tocarse.
  const logicalAgentId = getAgentId() ?? MAIN_WEB_AGENT_KEY
  const existing = listWebInstances().find(
    i => i.agentId === logicalAgentId && i.platformId === platformId && i.status !== 'stopped',
  )
  if (existing) return existing
  return createWebInstance(platformId, logicalAgentId)
}


// ─── Initialization ─────────────────────────────────────────────────

async function ensureInitialized(webInstance: ReturnType<typeof createWebInstance>): Promise<'sa' | 'cdp'> {
  const key = webInstance.instanceId
  const state = runtimeStates.get(key) ?? { operatingMode: null, initialized: false }
  if (state.initialized && state.operatingMode) return state.operatingMode
  runtimeStates.set(key, state)

  // Run startup check on this instance's debug port
  const check = await runStartupCheck(webInstance.debugPort)
  console.log(formatCheckResult(check))

  // Start MCP server (pre-configured with openweblock core tools)
  if (!mcpServer && check.mcpServer.portAvailable) {
    await startApplicationMCPBridge()
    console.log('[WebRelay] MCP Server started with openweblock core tools')
  }

  // Determine mode based on check results
  if (check.recommendation === 'sa_mode' || check.superAssistant.installed) {
    state.operatingMode = 'sa'
    console.log('[WebRelay] Operating in SA mode (extension detected)')
    if (!mcpServer && !(await hasExternalRelayControlApi())) {
      throw new Error(
        `MCP is listening on :${MCP_PORT}, but its relay control API is unavailable. ` +
        'Restart it with the current scripts/start-mcp-server.ts build before using Web mode.',
      )
    }
    // Configure SA to connect to our MCP server via StreamableHTTP
    await sleep(1000)
    const agent = listAgents().find(candidate => candidate.instanceId === webInstance.instanceId)
    if (!(await configureSAForMCP(webInstance.debugPort, agent?.saExtensionId, webInstance.platformId))) {
      throw new Error(`SuperAssistant configuration failed on Chrome port ${webInstance.debugPort}.`)
    }
    await waitForSAConnection()
    await sleep(2000)
  } else if (check.chrome.debugPortActive) {
    state.operatingMode = 'cdp'
    console.log('[WebRelay] Operating in CDP fallback mode (⚠ detection risk)')
  } else {
    // Try to launch Chrome
    const config = getCurrentProjectConfig()
    const platformId = config.selectedWebPlatform
    const platform = platformId ? getWebPlatformById(platformId) : null
    const url = platform?.url ?? 'https://chatgpt.com'
    const sessionMode = listAgents().find(
      agent => agent.instanceId === webInstance.instanceId,
    )?.sessionMode ?? 'clean'

    try {
      // NOTE (cierre de huecos, ver docs/EXECUTION_FORENSIC_STATE.md §Multi-Agent
      // Launch Validation): antes se forzaba SIEMPRE guestMode:true aqui. Guest
      // esta confirmado GUEST-BLOCKED-CHROME en esta version de Chrome (153.x):
      // Extensions.loadUnpacked nunca completa la instalacion real, ni via CDP
      // crudo ni via puppeteer-core, verificado en tres sesiones independientes.
      // La ruta no-guest (sincronizar el perfil Default real, que ya tiene SA
      // genuinamente instalada) es la unica que hoy lleva un Service Worker
      // real hasta el final -- asi que es la que el entry point real usa por
      // defecto ahora. Guest queda disponible como capacidad de launchChrome()
      // para cuando una version futura de Chrome relaje esta restriccion, pero
      // ya no es lo que la produccion real invoca.
      await launchChrome(url, 'Default', {
        instanceId: webInstance.instanceId,
        debugPort: webInstance.debugPort,
        sessionMode,
      })

      // Estampar identidad durable en el service worker de SA para esta
      // instancia, verificado con lectura de vuelta (ver ChromeCDP.
      // stampInstanceIdentity). Sin esto, ExecutionRegistry solo puede
      // aislar agentes de forma accidental via el BOOT_ID de cada worker
      // — real mientras ese worker viva, pero no sobrevive a que MV3 lo
      // mate por inactividad, y es inutilizable para que Sentinel u otro
      // orquestador se dirija de forma estable a este mismo agente mas
      // tarde. No bloqueante: si el sello falla, la instancia sigue
      // operando con el aislamiento accidental de hoy, degradado pero
      // funcional, y el fallo queda en log en vez de silencioso.
      const stampResult = await stampInstanceIdentity(webInstance.debugPort, {
        instanceId: webInstance.instanceId,
        agentId: webInstance.agentId,
        platformId: webInstance.platformId,
        profileDir: webInstance.profileDir,
      })
      if (stampResult.ok) {
        console.log(`[WebRelay] Instance identity stamped for ${webInstance.instanceId}`)
      } else {
        console.warn(`[WebRelay] Could not stamp instance identity for ${webInstance.instanceId}: ${stampResult.reason}`)
      }
      // Re-check: launchChrome now auto-installs SA via Browser CDP
      const recheck = await runStartupCheck(webInstance.debugPort)
      if (recheck.superAssistant.installed) {
        state.operatingMode = 'sa'
        console.log('[WebRelay] SA installed during launch — operating in SA mode')
        await sleep(1000)
        const agent = listAgents().find(candidate => candidate.instanceId === webInstance.instanceId)
        if (!(await configureSAForMCP(webInstance.debugPort, agent?.saExtensionId, webInstance.platformId))) {
          throw new Error(`SuperAssistant configuration failed on Chrome port ${webInstance.debugPort}.`)
        }
        await waitForSAConnection()
        await sleep(2000)
      } else {
        state.operatingMode = 'cdp'
      }
    } catch (err: any) {
      throw new Error(
        `Cannot connect to Chrome on port ${webInstance.debugPort}: ${err.message}`
      )
    }
  }

  state.initialized = true
  return state.operatingMode!
}

async function ensureCDP(
  platformUrl: string,
  webInstance: Pick<ReturnType<typeof createWebInstance>, 'instanceId' | 'debugPort' | 'platformId'>,
): Promise<CDPConnection> {
  const key = webInstance.instanceId
  const existing = cdpConnections.get(key)

  if (existing) {
    try {
      // Check if still connected
      await existing.evaluate('1')
      return existing
    } catch {
      existing.close()
      cdpConnections.delete(key)
    }
  }

  const connection = new CDPConnection(webInstance.debugPort)

  // Try to connect to a tab with the platform URL
  const tab = await connection.connectToUrl(new URL(platformUrl).hostname)

  if (!tab) {
    // No matching tab found — navigate to it
    await connection.navigate(platformUrl)
  }

  cdpConnections.set(key, connection)
  return connection
}

async function evaluatePromptAction(
  connection: CDPConnection,
  expression: string,
  phase: 'insertion' | 'submission',
): Promise<unknown> {
  const result = await connection.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (result?.exceptionDetails) {
    const details = result.exceptionDetails
    const kind = details.exception?.className ?? 'JavaScriptError'
    throw new Error(`Web prompt ${phase} failed (${kind}, line ${details.lineNumber ?? 'unknown'}).`)
  }
  return result?.result?.value
}

export async function insertAndSubmit(
  connection: CDPConnection,
  adapter: ReturnType<typeof getAdapter>,
  prompt: string,
): Promise<void> {
  const inserted = await evaluatePromptAction(connection, buildInsertScript(adapter, prompt), 'insertion')
  if (inserted !== true) {
    const diagnostic = await connection.evaluate(SA_COMPOSER_READINESS_SCRIPT)
      .catch(() => ({ unavailable: true }))
    throw new Error('Could not find a visible input field for the web prompt. Editor state: ' + JSON.stringify(diagnostic))
  }

  await sleep(500)
  const submitted = await evaluatePromptAction(connection, adapter.submitForm, 'submission')
  if (submitted !== true) {
    throw new Error('Could not submit the prompt through the web interface')
  }
}

// ─── Main Provider ──────────────────────────────────────────────────

export async function* webRelayCallModel({
  messages,
  systemPrompt,
  thinkingConfig,
  tools: rawTools,
  signal,
  options,
}: WebRelayCallModelParams): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  // 1. Get config & platform
  const config = getCurrentProjectConfig()
  const platformId = config.selectedWebPlatform
  if (!platformId) {
    yield createError('No web platform selected. Use /mcp set-mode web to select one.')
    return
  }
  const platform = getWebPlatformById(platformId)
  if (!platform) {
    yield createError(`Unknown platform: ${platformId}`)
    return
  }
  let webInstance: ReturnType<typeof createWebInstance>
  try {
    webInstance = resolveWebInstance(platformId)
  } catch (error) {
    yield createError(error instanceof Error ? error.message : String(error))
    return
  }

  // 2. Register real tools from framework (once)
  if (!toolsRegistered && mcpServer && rawTools?.length > 0) {
    try {
      const adapted = adaptToolsForMCP(rawTools as any)
      mcpServer.registerTools(adapted)
      toolsRegistered = true
      console.log(`[WebRelay] Registered ${adapted.length + 2} tools with MCP server (${adapted.map(t => t.name).join(', ')})`)
    } catch (err: any) {
      console.error('[WebRelay] Tool registration failed:', err.message)
    }
  }

  // 3. Extract prompt
  const userPrompt = extractPrompt(messages)
  if (!userPrompt) {
    yield createError('Could not extract user prompt from messages')
    return
  }

  // 4. Initialize
  let mode: 'sa' | 'cdp'
  try {
    mode = await ensureInitialized(webInstance)
  } catch (err: any) {
    yield createError(err.message)
    return
  }

  yield { type: 'stream_request_start' } as StreamEvent
  const startTime = Date.now()

  // 5. Dispatch to mode handler
  let responseText: string
  try {
    if (mode === 'sa') {
      responseText = await handleSAMode(userPrompt, platform, rawTools, signal, webInstance)
    } else {
      responseText = await handleCDPMode(userPrompt, platform, rawTools, signal, webInstance)
    }
  } catch (err: any) {
    yield createError(`[${mode}] ${err.message}`)
    return
  }

  if (!responseText) {
    yield createError(`No response from ${platform.name}`)
    return
  }

  // 6. Return response
  yield {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: responseText }],
    },
    costUSD: 0,
    durationMs: Date.now() - startTime,
    requestId: `web-${randomUUID()}`,
    model: `${platform.name} (Web ${mode.toUpperCase()})`,
  } as AssistantMessage
}

// ─── SA Mode Handler ────────────────────────────────────────────────

async function handleSAMode(
  prompt: string,
  platform: any,
  rawTools: any[],
  signal?: AbortSignal,
  webInstance?: Pick<ReturnType<typeof createWebInstance>, 'instanceId' | 'debugPort' | 'platformId'>,
  useDirectInstanceResponse = false,
): Promise<string> {
  const instance = webInstance ?? resolveWebInstance(platform.id)
  const resources = [browserConversationResource(instance.debugPort)]
  if (!useDirectInstanceResponse) resources.push('relay:shared-response-channel')
  return conversationAccess.run(
    resources,
    { instanceId: instance.instanceId, operation: 'conversación SA' },
    () => handleSAModeWithAccess(prompt, platform, rawTools, signal, instance, useDirectInstanceResponse),
  )
}

async function handleSAModeWithAccess(
  prompt: string,
  platform: any,
  rawTools: any[],
  signal?: AbortSignal,
  webInstance?: Pick<ReturnType<typeof createWebInstance>, 'instanceId' | 'debugPort' | 'platformId'>,
  useDirectInstanceResponse = false,
): Promise<string> {
  if (!useDirectInstanceResponse && !mcpServer && !(await hasExternalRelayControlApi())) {
    throw new Error(
      'MCP server is not available in this process and its external relay control API is unavailable.',
    )
  }

  // SA handles tool definitions and execution — we just send the prompt
  // via MCP relay and wait for the response

  // Format prompt with SA extension instructions so ChatGPT knows how to act as SuperAssistant
  const webTools = getSuperAssistantPromptTools(rawTools)
  const fullPrompt = formatSuperAssistantPrompt(prompt, webTools)

  // Send prompt via relay channel
  if (!useDirectInstanceResponse) {
    await sendRelayPrompt(fullPrompt, platform.id)
  }

  // Also send via CDP as fallback (SA will use insertText if relay isn't set up yet)
  const instance = webInstance ?? resolveWebInstance(platform.id)
  const conn = await ensureCDP(platform.url, instance)
  const adapter = getAdapter(platform.saAdapter ?? platform.id)
  const previousAssistantCount = await getAssistantMsgCount(conn, adapter)

  await insertAndSubmit(conn, adapter, fullPrompt)

  // Wait for SA to process and respond via relay
  // Simultaneously monitor via CDP as fallback
  const response = useDirectInstanceResponse
    ? await waitForNewAssistantMessage(conn, adapter, previousAssistantCount, signal, 90)
    : await Promise.race([
      waitForRelayResponse(90000),
      waitForNewAssistantMessage(conn, adapter, previousAssistantCount, signal, 90),
    ])

  if (typeof response === 'string') {
    return response // CDP response
  }
  if (response && 'text' in response) {
    return response.text // MCP relay response
  }

  throw new Error('Timeout waiting for response')
}

function getSuperAssistantPromptTools(rawTools: any[]): Array<{
  name: string
  description?: string
  inputSchema?: {
    properties?: Record<string, { type?: string; description?: string }>
    required?: string[]
  }
}> {
  const tools = rawTools.length > 0
    ? adaptToolsForMCP(filterToolsForWebMode(rawTools))
    : getOpenWeblockCoreTools().filter(tool =>
      ['Read', 'ListDir', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'].includes(tool.name),
    )
  return tools.map(tool => {
    const properties: Record<string, { type?: string; description?: string }> = {}
    const schemaProperties = tool.inputSchema.properties
    if (schemaProperties && typeof schemaProperties === 'object' && !Array.isArray(schemaProperties)) {
      for (const [name, definition] of Object.entries(schemaProperties)) {
        if (!definition || typeof definition !== 'object' || Array.isArray(definition)) continue
        const property = definition as Record<string, unknown>
        properties[name] = {
          type: typeof property.type === 'string' ? property.type : undefined,
          description: typeof property.description === 'string' ? property.description : undefined,
        }
      }
    }
    const required = Array.isArray(tool.inputSchema.required)
      ? tool.inputSchema.required.filter((name): name is string => typeof name === 'string')
      : undefined
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: { properties, required },
    }
  })
}

// ─── CDP Fallback Mode Handler ──────────────────────────────────────

async function handleCDPMode(
  prompt: string,
  platform: any,
  rawTools: any[],
  signal?: AbortSignal,
  webInstance?: ReturnType<typeof createWebInstance>,
): Promise<string> {
  const instance = webInstance ?? resolveWebInstance(platform.id)
  return conversationAccess.run(
    [browserConversationResource(instance.debugPort)],
    { instanceId: instance.instanceId, operation: 'conversación CDP' },
    () => handleCDPModeWithAccess(prompt, platform, rawTools, signal, instance),
  )
}

async function handleCDPModeWithAccess(
  prompt: string,
  platform: any,
  rawTools: any[],
  signal?: AbortSignal,
  webInstance?: ReturnType<typeof createWebInstance>,
): Promise<string> {
  const instance = webInstance ?? resolveWebInstance(platform.id)
  const conn = await ensureCDP(platform.url, instance)
  const adapter = getAdapter(platform.saAdapter ?? platform.id)

  // Inject bridge script for tool detection
  await conn.evaluate(getBridgeScript())

  // Prepare tools
  const webTools = filterToolsForWebMode(rawTools as any[])
  const toolDefs = webTools.length > 0 ? formatToolDefsForInjection(webTools as any) : ''
  const fullPrompt = toolDefs ? `${toolDefs}\n\n${prompt}` : prompt

  // Send prompt
  const msgCountBefore = await getAssistantMsgCount(conn, adapter)
  await insertAndSubmit(conn, adapter, fullPrompt)

  // Tool loop
  let fullResponseText = ''
  let loopCount = 0

  while (loopCount < MAX_TOOL_LOOPS) {
    loopCount++

    const responseText = await waitForNewAssistantMessage(
      conn, adapter, msgCountBefore + loopCount - 1, signal
    )
    if (!responseText) {
      if (fullResponseText) break
      throw new Error('No response received')
    }

    // Check for pending tool calls
    await sleep(500)
    const pendingRaw = await conn.evaluate(CHECK_PENDING_CALLS)
    let pendingCalls: Array<{id: string, name: string, input: Record<string, any>}> = []
    try { pendingCalls = JSON.parse(String(pendingRaw) || '[]') } catch {}

    if (pendingCalls.length === 0) {
      fullResponseText = responseText
        .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, '')
        .replace(/<tool_use>[\s\S]*?<\/tool_use>/g, '')
        .trim()
      break
    }

    // Execute tools
    const results: Array<{name: string, output: string, isError: boolean}> = []
    for (const call of pendingCalls) {
      // Scope de-duplication to THIS instance. Without the third argument the
      // dedup map is shared across every agent in the process, so agent A's
      // `Bash` call would suppress agent B's identical one.
      const result = await executeToolCall(call, webTools as any[], instance.instanceId)
      results.push({ name: result.name, output: result.output, isError: result.isError })
    }

    // Inject results
    const resultMessage = formatToolResultMessage(results)
    await insertAndSubmit(conn, adapter, resultMessage)

    const cleanPart = responseText
      .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, '')
      .replace(/<tool_use>[\s\S]*?<\/tool_use>/g, '')
      .trim()
    if (cleanPart) fullResponseText += (fullResponseText ? '\n' : '') + cleanPart

    await sleep(300)
  }

  return fullResponseText
}

// ─── Response Detection ─────────────────────────────────────────────

async function getAssistantMsgCount(
  conn: CDPConnection,
  adapter: ReturnType<typeof getAdapter>,
): Promise<number> {
  const selector = adapter.assistantMessageSelector ??
    '[data-message-role="assistant"], [data-message-author-role="assistant"]'
  return Number(await conn.evaluate(
    `document.querySelectorAll(${JSON.stringify(selector)}).length`
  )) || 0
}

async function getLastAssistantText(
  conn: CDPConnection,
  adapter: ReturnType<typeof getAdapter>,
): Promise<string | null> {
  const text = await conn.evaluate(adapter.extractResponse)
  return text && text !== 'null' ? String(text) : null
}

async function waitForNewAssistantMessage(
  conn: CDPConnection,
  adapter: ReturnType<typeof getAdapter>,
  prevCount: number,
  signal?: AbortSignal,
  maxWaitSec: number = 60,
): Promise<string | null> {
  const start = Date.now()
  let started = false

  while (Date.now() - start < maxWaitSec * 1000) {
    if (signal?.aborted) return null
    const gen = await conn.evaluate(adapter.isGenerating)
    const curCount = await getAssistantMsgCount(conn, adapter)
    if (gen === true) started = true
    if (curCount > prevCount && gen !== true && (started || Date.now() - start > 12000)) {
      await sleep(800)
      return getLastAssistantText(conn, adapter)
    }
    await sleep(500)
  }

  const finalCount = await getAssistantMsgCount(conn, adapter)
  let domDiagnostics: unknown = 'unavailable'
  try {
    domDiagnostics = await conn.evaluate(`(function() {
      const count = selector => document.querySelectorAll(selector).length
      return {
        host: location.hostname,
        assistantRole: count('[data-message-author-role="assistant"]'),
        messageRole: count('[data-message-role="assistant"]'),
        turnRole: count('[data-turn="assistant"]'),
        testIdAssistant: count('[data-testid="assistant-message"]'),
        testIdModelResponse: count('[data-test-id="model-response"]'),
        markdownAssistant: count('[data-markdown-text-style="assistant-message"]'),
        completedTurns: count('[data-talvt-turn-state="complete"]'),
        conversationTurns: count('[data-testid^="conversation-turn-"]'),
        adapterAssistantCandidates: count(${JSON.stringify(adapter.assistantMessageSelector ?? '[data-message-role="assistant"], [data-message-author-role="assistant"]')}),
      }
    })()`)
  } catch (error) {
    domDiagnostics = error instanceof Error ? error.message : String(error)
  }
  throw new Error(
    `Timed out waiting for a completed assistant response after ${maxWaitSec}s ` +
    `(assistant messages: ${prevCount} -> ${finalCount}; DOM candidates: ${JSON.stringify(domDiagnostics)}). ` +
    'Completion is unconfirmed; do not automatically resend the prompt.',
  )
}

// ─── Helpers ────────────────────────────────────────────────────────

function extractPrompt(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.type === 'user') {
      const content = msg.message.content
      if (typeof content === 'string') return content
      if (Array.isArray(content)) {
        const parts = content.filter((b: any) => b.type === 'text').map((b: any) => b.text)
        if (parts.length > 0) return parts.join('\n')
      }
    }
  }
  return null
}

function createError(message: string): SystemAPIErrorMessage {
  return { type: 'system', message: { content: `[Web Relay] ${message}` } }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

export function isWebRelayModeActive(): boolean {
  try {
    const config = getCurrentProjectConfig()
    const active = config.mcpExecutionMode === 'web' && !!config.selectedWebPlatform
    console.log('[WebRelay] isWebRelayModeActive:', { mode: config.mcpExecutionMode, platform: config.selectedWebPlatform, active })
    return active
  } catch (err: any) {
    console.error('[WebRelay] isWebRelayModeActive error:', err?.message)
    return false
  }
}

/**
 * Programmatic helper to send a prompt directly to the web platform (ChatGPT, Claude, etc.)
 * and await the generated response.
 */
export async function verifyWebRelayStartup(agent: {
  agentId: string
  instanceId?: string
  debugPort?: number
  platformId: string
  role?: string
}): Promise<StartupHandshakeEvidence> {
  if (!agent.instanceId || !agent.debugPort || !agent.role) {
    throw new Error('Startup verification requires an instance, debug port and explicit role')
  }
  const instance = listWebInstances().find(item =>
    item.instanceId === agent.instanceId && item.agentId === agent.agentId &&
    item.debugPort === agent.debugPort && item.platformId === agent.platformId &&
    item.status !== 'stopped' && item.status !== 'error',
  )
  if (!instance) throw new Error('Startup verification target no longer matches the registered browser')
  const runtime = runtimeStates.get(instance.instanceId)
  if (!runtime?.initialized || runtime.operatingMode !== 'sa') {
    throw new Error('SuperAssistant must be prepared on this instance before startup verification')
  }
  const platform = getWebPlatformById(agent.platformId)
  if (!platform) throw new Error(`Unknown startup platform: ${agent.platformId}`)
  await setAgentStartupVerificationStatus(agent.agentId)
  return performStartupHandshake({
    agentId: agent.agentId,
    instanceId: instance.instanceId,
    platformId: agent.platformId,
    role: agent.role,
  }, prompt => handleSAMode(prompt, platform, [], undefined, instance, true))
}

export async function sendWebPrompt(
  prompt: string,
  platformId?: string,
  agentId?: string,
): Promise<string> {
  const config = getCurrentProjectConfig()
  const targetPlatformId = platformId || config.selectedWebPlatform || 'chatgpt'
  const platform = getWebPlatformById(targetPlatformId)
  if (!platform) {
    throw new Error(`Plataforma web desconocida: ${targetPlatformId}`)
  }

  const webInstance = resolveWebInstance(platform.id, agentId)
  const mode = await ensureInitialized(webInstance)
  if (mode === 'sa') {
    return await handleSAMode(prompt, platform, [], undefined, webInstance, Boolean(agentId))
  } else {
    return await handleCDPMode(prompt, platform, [], undefined, webInstance)
  }
}

export async function sendWebPromptToMaster(
  prompt: string,
  platformId: string,
  sourceId: string,
  debugPort: number,
): Promise<string> {
  const platform = getWebPlatformById(platformId)
  if (!platform) {
    throw new Error(`Plataforma web desconocida: ${platformId}`)
  }

  const preparationKey = await getSAContextPreparationKey(debugPort, platformId)
  if (!preparationKey || !preparedSAContexts.has(preparationKey)) {
    try {
      await prepareSAAgentForWebRelay(debugPort, undefined, platformId)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (detail.includes('SuperAssistant content execution context was not found')) {
        throw new Error(
          `${detail} The Master was not reloaded and no unrecognized storage keys were written. ` +
          'Save any draft, then open the Master platform page again to let SuperAssistant initialize; retry only after its composer control appears.',
        )
      }
      throw error
    }
  }
  const target = {
    instanceId: `master-session:${sourceId}`,
    debugPort,
    platformId,
  }
  return handleSAMode(prompt, platform, [], undefined, target, true)
}

export function getWebConversationIdFromUrl(platformId: string, pageUrl: string): string {
  if (platformId !== 'chatgpt') return 'main'
  const url = new URL(pageUrl)
  const conversation = url.pathname.match(/(?:^|\/)c\/([^/]+)(?:\/|$)/)?.[1]
  return conversation ?? 'new'
}

export async function getActiveWebConversationId(debugPort: number, platformId: string): Promise<string> {
  const platform = getWebPlatformById(platformId)
  if (!platform) throw new Error(`Plataforma web desconocida: ${platformId}`)
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
    signal: AbortSignal.timeout(4000),
  })
  if (!response.ok) throw new Error(`Could not inspect Chrome tabs on port ${debugPort}: HTTP ${response.status}`)
  const targets = await response.json() as Array<{ type?: unknown; url?: unknown }>
  const platformHost = new URL(platform.url).hostname
  const page = targets.find(target => {
    if (target.type !== 'page' || typeof target.url !== 'string') return false
    try {
      const hostname = new URL(target.url).hostname
      return hostname === platformHost || hostname.endsWith(`.${platformHost}`) ||
        (platformId === 'chatgpt' && (
          hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com') ||
          hostname === 'chat.openai.com' || hostname.endsWith('.openai.com')
        ))
    } catch {
      return false
    }
  })
  if (!page || typeof page.url !== 'string') {
    throw new Error(`No ${platformId} page found on Chrome port ${debugPort} while resolving the current conversation.`)
  }
  return getWebConversationIdFromUrl(platformId, page.url)
}

export function shutdownWebRelay(): void {
  for (const connection of cdpConnections.values()) connection.close()
  cdpConnections.clear()
  runtimeStates.clear()
  preparedSAContexts.clear()
  // Closing Relay instances leaves the application-owned extension connection available.

  toolsRegistered = false

  killChrome()
}
