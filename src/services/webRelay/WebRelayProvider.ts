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

import { randomUUID } from 'crypto'
import { getCurrentProjectConfig } from '../../utils/config.js'
import { getWebPlatformById } from '../../utils/webPlatforms.js'
import {
  CDPConnection,
  launchChrome,
  killChrome,
  isDebugPortActive,
} from './ChromeCDP.js'
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
  MAX_TOOL_LOOPS,
} from './WebToolBridge.js'
import { MCPSSEServer } from '../mcpServer/MCPSSEServer.js'
import { adaptToolsForMCP } from '../mcpServer/ToolAdapter.js'
import { runStartupCheck, formatCheckResult } from './StartupChecker.js'
// @ts-ignore — ws types not installed in this project
import { WebSocket } from 'ws'

// ─── Types ──────────────────────────────────────────────────────────

type Message = {
  type: string
  message: { role: string; content: any }
  [key: string]: unknown
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
const MCP_PORT = 9334

/**
 * Configure SA extension to connect to our MCPSSEServer via StreamableHTTP.
 * This sets chrome.storage.local in the SA service worker context, then reloads SA.
 */
async function configureSAForMCP(): Promise<boolean> {
  try {
    const targets = await fetch('http://127.0.0.1:9222/json').then(r => r.json())
    const sw = targets.find((t: any) => t.url?.includes(SA_EXTENSION_ID) && t.type === 'service_worker')
    if (!sw?.webSocketDebuggerUrl) {
      console.log('[WebRelay] SA service worker not found, skipping config')
      return false
    }

    const ws = new WebSocket(sw.webSocketDebuggerUrl)
    await new Promise<void>((r, j) => { ws.on('open', r); ws.on('error', j); setTimeout(j, 5000) })

    // Set storage config — includes Push Content Mode and system prompt
    await new Promise<void>((resolve, reject) => {
      const h = (d: any) => { const m = JSON.parse(d.toString()); if (m.id === 1) { ws.off('message', h); resolve() } }
      ws.on('message', h)
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
        expression: `new Promise(r => chrome.storage.local.set({
          mcpServerUrl: 'http://localhost:${MCP_PORT}/mcp',
          mcpConnectionType: 'streamable-http',
          pushContentMode: true,
          enableToolExecution: true,
          systemPrompt: 'You are a helpful assistant connected to openMCPWEBLOCK tools via MCP. Execute tool calls when requested and return results.',
          autoConnect: true
        }, () => r('ok')))`,
        awaitPromise: true, returnByValue: true,
      }}))
      setTimeout(reject, 5000)
    })

    // Reload SA to pick up new config
    ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: 'chrome.runtime.reload()' } }))
    ws.close()
    console.log('[WebRelay] SA configured → StreamableHTTP on port', MCP_PORT, '+ Push Content Mode ON')
    return true
  } catch (err: any) {
    console.log('[WebRelay] SA config failed:', err.message)
    return false
  }
}

// ─── State ──────────────────────────────────────────────────────────

let cdp: CDPConnection | null = null
let mcpServer: MCPSSEServer | null = null
let operatingMode: 'sa' | 'cdp' | null = null
let initialized = false
let toolsRegistered = false

// ─── Initialization ─────────────────────────────────────────────────

async function ensureInitialized(): Promise<'sa' | 'cdp'> {
  if (initialized && operatingMode) return operatingMode

  // Run startup check
  const check = await runStartupCheck()
  console.log(formatCheckResult(check))

  // Start MCP server (tools registered dynamically on first query)
  if (!mcpServer && check.mcpServer.portAvailable) {
    mcpServer = new MCPSSEServer({ port: MCP_PORT })
    mcpServer.registerTools([]) // relay tools only — real tools added on first query
    await mcpServer.start()
    console.log('[WebRelay] MCP Server started (tools pending)')
  }

  // Determine mode based on check results
  if (check.recommendation === 'sa_mode') {
    operatingMode = 'sa'
    console.log('[WebRelay] Operating in SA mode (safe, extension-based)')
    // Configure SA to connect to our MCP server via StreamableHTTP
    await sleep(2000) // Wait for SA service worker to initialize
    await configureSAForMCP()
    await sleep(4000) // Wait for SA to reload and reconnect
  } else if (check.chrome.debugPortActive) {
    operatingMode = 'cdp'
    console.log('[WebRelay] Operating in CDP fallback mode (⚠ detection risk)')
  } else {
    // Try to launch Chrome
    const config = getCurrentProjectConfig()
    const platformId = config.selectedWebPlatform
    const platform = platformId ? getWebPlatformById(platformId) : null
    const url = platform?.url ?? 'https://chatgpt.com'

    try {
      await launchChrome(url, 'Default')
      // Re-check: launchChrome now auto-installs SA via pipe,
      // so we may be in SA mode after all
      const recheck = await runStartupCheck()
      if (recheck.superAssistant.installed && recheck.login.detected) {
        operatingMode = 'sa'
        console.log('[WebRelay] SA installed during launch — operating in SA mode')
        // Configure SA to connect to our MCP server via StreamableHTTP
        await sleep(2000) // Wait for SA service worker to initialize
        await configureSAForMCP()
        await sleep(4000) // Wait for SA to reload and reconnect
      } else {
        operatingMode = 'cdp'
      }
    } catch {
      throw new Error(
        'Cannot connect to Chrome. Please launch Chrome with:\n' +
        '  chrome.exe --remote-debugging-port=9222\n' +
        'Or let openMCPWEBLOCK launch Chrome automatically.'
      )
    }
  }

  initialized = true
  return operatingMode!
}

async function ensureCDP(platformUrl: string): Promise<CDPConnection> {
  if (cdp) {
    try {
      // Check if still connected
      await cdp.evaluate('1')
      return cdp
    } catch {
      cdp.close()
      cdp = null
    }
  }

  cdp = new CDPConnection()

  // Try to connect to a tab with the platform URL
  const tab = await cdp.connectToUrl(new URL(platformUrl).hostname)

  if (!tab) {
    // No matching tab found — navigate to it
    await cdp.navigate(platformUrl)
  }

  return cdp
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
    mode = await ensureInitialized()
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
      responseText = await handleSAMode(userPrompt, platform, rawTools, signal)
    } else {
      responseText = await handleCDPMode(userPrompt, platform, rawTools, signal)
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
): Promise<string> {
  if (!mcpServer) {
    throw new Error('MCP SSE Server not running')
  }

  // SA handles tool definitions and execution — we just send the prompt
  // via MCP relay and wait for the response

  // Send prompt via relay channel
  mcpServer.sendPrompt(prompt, platform.id)

  // Also send via CDP as fallback (SA will use insertText if relay isn't set up yet)
  const conn = await ensureCDP(platform.url)
  const adapter = getAdapter(platform.saAdapter ?? platform.id)

  const insertScript = buildInsertScript(adapter, prompt)
  await conn.evaluate(insertScript)
  await sleep(500)
  await conn.evaluate(adapter.submitForm)

  // Wait for SA to process and respond via relay
  // Simultaneously monitor via CDP as fallback
  const response = await Promise.race([
    mcpServer.waitForResponse(90000),
    waitForCDPResponse(conn, adapter, signal, 90),
  ])

  if (typeof response === 'string') {
    return response // CDP response
  }
  if (response && 'text' in response) {
    return response.text // MCP relay response
  }

  throw new Error('Timeout waiting for response')
}

// ─── CDP Fallback Mode Handler ──────────────────────────────────────

async function handleCDPMode(
  prompt: string,
  platform: any,
  rawTools: any[],
  signal?: AbortSignal,
): Promise<string> {
  const conn = await ensureCDP(platform.url)
  const adapter = getAdapter(platform.saAdapter ?? platform.id)

  // Inject bridge script for tool detection
  await conn.evaluate(getBridgeScript())

  // Prepare tools
  const webTools = filterToolsForWebMode(rawTools as any[])
  const toolDefs = webTools.length > 0 ? formatToolDefsForInjection(webTools as any) : ''
  const fullPrompt = toolDefs ? `${toolDefs}\n\n${prompt}` : prompt

  // Send prompt
  const msgCountBefore = await getAssistantMsgCount(conn)
  const insertScript = buildInsertScript(adapter, fullPrompt)
  await conn.evaluate(insertScript)
  await sleep(500)
  await conn.evaluate(adapter.submitForm)

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
      const result = await executeToolCall(call, webTools as any[])
      results.push({ name: result.name, output: result.output, isError: result.isError })
    }

    // Inject results
    const resultMessage = formatToolResultMessage(results)
    await conn.evaluate(buildInsertScript(adapter, resultMessage))
    await sleep(500)
    await conn.evaluate(adapter.submitForm)

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

async function getAssistantMsgCount(conn: CDPConnection): Promise<number> {
  return Number(await conn.evaluate(
    `document.querySelectorAll('[data-message-author-role="assistant"]').length`
  )) || 0
}

async function getLastAssistantText(conn: CDPConnection): Promise<string | null> {
  const text = await conn.evaluate(`
    (function() {
      var msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
      for (var i = msgs.length - 1; i >= 0; i--) {
        var md = msgs[i].querySelector('.markdown, .prose');
        var t = md ? md.innerText : msgs[i].innerText;
        if (t && t.trim().length > 0) return t;
      }
      return null;
    })()
  `)
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
    const curCount = await getAssistantMsgCount(conn)
    if (gen === true) started = true
    if (curCount > prevCount && gen !== true && (started || Date.now() - start > 12000)) {
      await sleep(800)
      return getLastAssistantText(conn)
    }
    await sleep(500)
  }

  const finalCount = await getAssistantMsgCount(conn)
  return finalCount > prevCount ? getLastAssistantText(conn) : null
}

async function waitForCDPResponse(
  conn: CDPConnection,
  adapter: ReturnType<typeof getAdapter>,
  signal?: AbortSignal,
  maxWaitSec: number = 60,
): Promise<string | null> {
  const startCount = await getAssistantMsgCount(conn)
  return waitForNewAssistantMessage(conn, adapter, startCount, signal, maxWaitSec)
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
    return config.mcpExecutionMode === 'web' && !!config.selectedWebPlatform
  } catch { return false }
}

export function shutdownWebRelay(): void {
  if (cdp) { cdp.close(); cdp = null }
  if (mcpServer) { mcpServer.stop(); mcpServer = null }
  initialized = false
  toolsRegistered = false
  operatingMode = null
  killChrome()
}
