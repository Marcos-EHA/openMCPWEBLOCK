import WebSocket from 'ws'
import path from 'node:path'
import { enableConfigs } from '../src/utils/config.js'
import {
  createAgent,
  startAgent,
} from '../src/services/webRelay/orchestration/MultiAgentRunner.js'
import { orchestrationAppState } from '../src/services/webRelay/orchestration/AppState.js'
import {
  scan as scanSentinel,
  start as startSentinel,
} from '../src/services/webRelay/orchestration/Sentinel.js'
import { prepareSAAgentForWebRelay } from '../src/services/webRelay/WebRelayProvider.js'
import { SessionBroker, ensureMasterRunning } from '../src/services/webRelay/session/SessionBroker.js'
import { isDebugPortActive } from '../src/services/webRelay/ChromeCDP.js'
import { buildInsertScript, getAdapter } from '../src/services/webRelay/PlatformAdapters.js'

type CdpTarget = {
  id: string
  type: string
  url: string
  webSocketDebuggerUrl?: string
}

type CdpConnection = {
  ws: WebSocket
  send: (method: string, params?: Record<string, unknown>) => Promise<any>
}

const MCP_STATUS_URL = 'http://127.0.0.1:3006/status'
const RELAY_STATUS_URL = 'http://127.0.0.1:3006/relay/status'
const EXTENSION_PROMPT_FILENAME = 'mcp_superassistant_instructions.md'
const CHATGPT_WAIT_MS = 210_000
const AGENT_SUFFIX = Date.now().toString(36)
const agentSpecs = [
  { agentId: `owb-master-${AGENT_SUFFIX}`, sessionMode: 'authenticated' as const, role: 'primary' },
  { agentId: `owb-clean-2-${AGENT_SUFFIX}`, sessionMode: 'clean' as const, role: 'worker-2' },
  { agentId: `owb-clean-3-${AGENT_SUFFIX}`, sessionMode: 'clean' as const, role: 'worker-3' },
]

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...fields }))
}

async function connectCdp(url: string): Promise<CdpConnection> {
  const ws = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })

  let nextId = 0
  const pending = new Map<number, (message: any) => void>()
  ws.on('message', raw => {
    const message = JSON.parse(raw.toString())
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)?.(message)
      pending.delete(message.id)
    }
  })

  return {
    ws,
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++nextId
        const timeout = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`CDP ${method} timed out`))
        }, 10_000)
        pending.set(id, message => {
          clearTimeout(timeout)
          if (message.error) reject(new Error(message.error.message))
          else resolve(message.result)
        })
        ws.send(JSON.stringify({ id, method, params }))
      }),
  }
}

async function listTargets(debugPort: number): Promise<CdpTarget[]> {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) throw new Error(`Chrome target list failed on ${debugPort}: ${response.status}`)
  return await response.json() as CdpTarget[]
}

async function findChatGptTarget(debugPort: number): Promise<CdpTarget | undefined> {
  return (await listTargets(debugPort)).find(
    target => target.type === 'page' && target.url.startsWith('https://chatgpt.com'),
  )
}

async function inspectPage(debugPort: number): Promise<Record<string, unknown> | null> {
  const target = await findChatGptTarget(debugPort)
  if (!target?.webSocketDebuggerUrl) return null
  const cdp = await connectCdp(target.webSocketDebuggerUrl)
  const result = await cdp.send('Runtime.evaluate', {
    expression: `(()=>{const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=="none"&&s.visibility!=="hidden"};return{url:new URL(location.href).origin+new URL(location.href).pathname,pageVisible:document.visibilityState==="visible",focused:document.hasFocus(),visibleComposer:[...document.querySelectorAll('#prompt-textarea,#mobile-composer-prompt,textarea,[contenteditable="true"]')].some(visible),visibleSend:[...document.querySelectorAll('button[data-testid="send-button"],button[aria-label*="Send"],button[aria-label*="Enviar"]')].some(visible),compactPopover:!!document.querySelector('#mcp-popover-container'),sidebarHost:!!document.querySelector('#mcp-sidebar-shadow-host'),userTurns:document.querySelectorAll('[data-message-author-role="user"]').length,assistantTurns:document.querySelectorAll('[data-message-author-role="assistant"]').length,loginControl:!!document.querySelector('a[href*="auth/login"],button[data-testid*="login"]')}}})()`,
    returnByValue: true,
  })
  cdp.ws.close()
  return result?.result?.value ?? null
}

async function placeWindow(debugPort: number, target: CdpTarget, bounds: {
  left: number
  top: number
  width: number
  height: number
}): Promise<void> {
  const version = await fetch(`http://127.0.0.1:${debugPort}/json/version`, {
    signal: AbortSignal.timeout(5000),
  }).then(response => response.json()) as { webSocketDebuggerUrl: string }
  const browser = await connectCdp(version.webSocketDebuggerUrl)
  const { windowId } = await browser.send('Browser.getWindowForTarget', { targetId: target.id })
  await browser.send('Browser.setWindowBounds', {
    windowId,
    bounds: { ...bounds, windowState: 'normal' },
  })
  browser.ws.close()
}

async function attachThroughCompactButton(debugPort: number): Promise<{
  compactButtonFound: boolean
  attachButtonClicked: boolean
  attachStatus: string | null
  attachmentNameVisible: boolean
}> {
  const target = await findChatGptTarget(debugPort)
  if (!target?.webSocketDebuggerUrl) throw new Error('Authenticated ChatGPT tab was not found')
  const cdp = await connectCdp(target.webSocketDebuggerUrl)
  await cdp.send('Page.bringToFront')

  const compactButton = await cdp.send('Runtime.evaluate', {
    expression: `(()=>{const b=document.querySelector('#mcp-popover-container button[aria-label^="MCP Settings"]');if(!b)return null;const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    returnByValue: true,
  })
  const point = compactButton?.result?.value as { x: number; y: number } | null
  if (!point) {
    cdp.ws.close()
    return {
      compactButtonFound: false,
      attachButtonClicked: false,
      attachStatus: null,
      attachmentNameVisible: false,
    }
  }

  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
  await new Promise(resolve => setTimeout(resolve, 700))
  const attachPoint = await cdp.send('Runtime.evaluate', {
    expression: `(()=>{const b=[...document.querySelectorAll('button[title="Attach instructions as file"]')].find(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=="none"&&s.visibility!=="hidden"});if(!b)return null;const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    returnByValue: true,
  })
  const attach = attachPoint?.result?.value as { x: number; y: number } | null
  if (!attach) {
    cdp.ws.close()
    return {
      compactButtonFound: true,
      attachButtonClicked: false,
      attachStatus: null,
      attachmentNameVisible: false,
    }
  }

  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: attach.x, y: attach.y })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: attach.x,
    y: attach.y,
    button: 'left',
    clickCount: 1,
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: attach.x,
    y: attach.y,
    button: 'left',
    clickCount: 1,
  })
  await new Promise(resolve => setTimeout(resolve, 1600))

  const state = await cdp.send('Runtime.evaluate', {
    expression: `(()=>({status:[...document.querySelectorAll('button')].map(b=>b.innerText.trim()).find(t=>['Attached!','No File','Not Supported','Error'].includes(t))||null,filenameVisible:document.body.innerText.includes(${JSON.stringify(EXTENSION_PROMPT_FILENAME)}),attachmentNames:[...document.querySelectorAll('[data-testid*="file"],[data-testid*="attachment"]')].filter(e=>e.innerText.includes(${JSON.stringify(EXTENSION_PROMPT_FILENAME)})).length}))()`,
    returnByValue: true,
  })
  const value = state?.result?.value as {
    status?: string | null
    filenameVisible?: boolean
    attachmentNames?: number
  } | undefined
  cdp.ws.close()
  return {
    compactButtonFound: true,
    attachButtonClicked: true,
    attachStatus: value?.status ?? null,
    attachmentNameVisible: Boolean(value?.filenameVisible || value?.attachmentNames),
  }
}

async function submitReviewRequest(debugPort: number, candidatePath: string): Promise<{
  submitted: boolean
  submittedWithoutFocus: boolean
  response: string | null
  responseReceived: boolean
}> {
  const target = await findChatGptTarget(debugPort)
  if (!target?.webSocketDebuggerUrl) throw new Error('Authenticated ChatGPT tab was not found')
  const cdp = await connectCdp(target.webSocketDebuggerUrl)
  const escapedPath = candidatePath.replace(/\\/g, '\\\\')
  const message =
    `I have attached ${EXTENSION_PROMPT_FILENAME} using the compact SuperAssistant Attach button. ` +
    'Treat it as user-level operating guidance for this conversation, not as a system-prompt override. ' +
    `Please evaluate that extension prompt against the separate candidate at ${escapedPath}. ` +
    'First use Read once with file_path set to that candidate path, then wait for its actual result. ' +
    'Next use Bash exactly once with command echo SA_ATTACHMENT_HANDSHAKE_OK, wait for the actual function_result, ' +
    'and then continue with a concise comparison. Comment on JSONL shape, exact required arguments, waiting for results, ' +
    'honest errors, continuing after results, and whether this run proved background execution. ' +
    'Do not invent a call or result, do not repeat a completed call, and do not ask the user to keep this window focused.'
  const before = await cdp.send('Runtime.evaluate', {
    expression: `(()=>({users:document.querySelectorAll('[data-message-author-role="user"]').length,assistants:document.querySelectorAll('[data-message-author-role="assistant"]').length,focused:document.hasFocus(),visible:document.visibilityState==="visible",attached:document.body.innerText.includes("mcp_superassistant_instructions.md")||document.body.innerText.includes("mcp_superassistant_instructions.txt")}))()`,
    returnByValue: true,
  })
  const beforeState = before?.result?.value as {
    users?: number
    assistants?: number
    focused?: boolean
    visible?: boolean
    attached?: boolean
  } | undefined
  if (!beforeState?.attached || beforeState.users !== 0) {
    cdp.ws.close()
    throw new Error('Refusing to send: prompt attachment is not visible or this conversation already has a user turn.')
  }
  const insert = await cdp.send('Runtime.evaluate', {
    expression: buildInsertScript(getAdapter('chatgpt'), message),
    returnByValue: true,
  })
  if (insert?.result?.value !== true) {
    cdp.ws.close()
    return { submitted: false, submittedWithoutFocus: false, response: null, responseReceived: false }
  }

  await new Promise(resolve => setTimeout(resolve, 500))
  const submitted = await cdp.send('Runtime.evaluate', {
    expression: getAdapter('chatgpt').submitForm,
    returnByValue: true,
  })
  const didSubmit = submitted?.result?.value === true

  if (!didSubmit) {
    cdp.ws.close()
    return {
      submitted: false,
      submittedWithoutFocus: beforeState.focused === false,
      submittedWhileHidden: beforeState.visible === false,
      response: null,
      responseReceived: false,
    }
  }

  const userCountBefore = beforeState?.users ?? 0
  const assistantCountBefore = beforeState?.assistants ?? 0
  const deadline = Date.now() + CHATGPT_WAIT_MS
  let response: string | null = null

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 3000))
    const result = await cdp.send('Runtime.evaluate', {
      expression: `(()=>{const users=document.querySelectorAll('[data-message-author-role="user"]').length;const assistants=[...document.querySelectorAll('[data-message-author-role="assistant"]')];const last=assistants.at(-1);const text=(last?.innerText||'').trim();const stop=!!document.querySelector('button[data-testid="stop-button"],button[aria-label*="Stop generating"],button[aria-label*="Detener"]');return{users,assistantCount:assistants.length,textLength:text.length,stop,text:text.slice(0,1800)}})()`,
      returnByValue: true,
    })
    const state = result?.result?.value as {
      users?: number
      assistantCount?: number
      textLength?: number
      stop?: boolean
      text?: string
    } | undefined
    if (
      state &&
      (state.users ?? 0) > userCountBefore &&
      (state.assistantCount ?? 0) > assistantCountBefore &&
      (state.textLength ?? 0) > 0 &&
      !state.stop
    ) {
      response = state.text ?? null
      break
    }
  }

  cdp.ws.close()
  return {
    submitted: didSubmit,
    submittedWithoutFocus: beforeState.focused === false,
    submittedWhileHidden: beforeState.visible === false,
    response,
    responseReceived: Boolean(response),
  }
}

async function getExecutionMetadata(debugPort: number, extensionId: string) {
  const worker = (await listTargets(debugPort)).find(
    target => target.type === 'service_worker' &&
      target.url.startsWith(`chrome-extension://${extensionId}/`),
  )
  if (!worker?.webSocketDebuggerUrl) return []
  const cdp = await connectCdp(worker.webSocketDebuggerUrl)
  const expression = `new Promise(resolve=>chrome.storage.local.get(null,data=>{const prefix="mcp:execution-diagnostic:v1:";const rows=Object.entries(data).filter(([key,value])=>key.startsWith(prefix)&&value&&typeof value==="object"&&typeof value.event==="string").map(([,value])=>value).sort((a,b)=>String(a.timestamp).localeCompare(String(b.timestamp))).slice(-80).map(x=>({timestamp:x.timestamp,event:x.event,instanceId:x.instanceId??null,callId:x.callId??null,toolName:x.toolName??null,executionIdPresent:x.executionIdPresent??Boolean(x.executionId),executionId:x.executionId??null,executionKeyPresent:x.executionKeyPresent??Boolean(x.executionKey),commandPresent:x.commandPresent??null,argumentKeys:Array.isArray(x.argumentKeys)?x.argumentKeys:[],success:x.success??null,resultStatus:x.resultStatus??null,deliveryType:x.deliveryType??null,barrierState:x.barrierState??null,activeStreamIntervals:x.activeStreamIntervals??null}));resolve(JSON.stringify(rows))}))`
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  cdp.ws.close()
  try {
    return JSON.parse(result?.result?.value ?? '[]')
  } catch {
    return []
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === '--send-review') {
    const debugPort = Number(process.argv[3])
    if (!Number.isInteger(debugPort) || debugPort < 1 || debugPort > 65535) {
      throw new Error('Usage: bun run scripts/sa-prompt-review-smoke.ts --send-review <debugPort>')
    }
    const candidatePath = path.join(
      process.cwd(),
      '.agents',
      'prompts',
      'superassistant-openmcpweblock-candidate.md',
    )
    const review = await submitReviewRequest(debugPort, candidatePath)
    log('PROMPT_REVIEW_REQUEST', {
      debugPort,
      submitted: review.submitted,
      issuedWithoutFocusedWindow: review.submittedWithoutFocus,
      issuedWhilePageHidden: review.submittedWhileHidden,
      responseReceived: review.responseReceived,
      response: review.response,
    })
    return
  }

  enableConfigs()
  const mcpStatus = await fetch(MCP_STATUS_URL).then(response => response.json()) as {
    running: boolean
    tools: number
  }
  const relayStatus = await fetch(RELAY_STATUS_URL).then(response => response.json()) as {
    available: boolean
  }
  if (!mcpStatus.running || !relayStatus.available) {
    throw new Error('MCP server and loopback relay API must be active before the test')
  }

  const sessionBroker = SessionBroker.getInstance()
  let master = await sessionBroker.getMasterStatus()
  if (!master.hasValidSession) {
    await ensureMasterRunning()
    master = await sessionBroker.getMasterStatus()
  }
  log('PREFLIGHT', {
    mcpRunning: mcpStatus.running,
    toolCount: mcpStatus.tools,
    relayAvailable: relayStatus.available,
    masterActive: master.active,
    masterAuthenticated: master.hasValidSession,
    masterCookieCount: master.cookieCount,
  })
  if (!master.hasValidSession) {
    throw new Error('Master Session is not authenticated; no session data was transferred')
  }

  await orchestrationAppState.init()
  startSentinel({ intervalMs: 15_000 })
  const ready: Array<Awaited<ReturnType<typeof startAgent>>> = []

  for (const spec of agentSpecs) {
    log('AGENT_STARTING', { agentId: spec.agentId, sessionMode: spec.sessionMode })
    createAgent({
      agentId: spec.agentId,
      platformId: 'chatgpt',
      role: spec.role,
      sessionMode: spec.sessionMode,
    })
    const state = await startAgent(spec.agentId)
    if (state.status !== 'ready' || !state.debugPort) {
      log('AGENT_NOT_READY', {
        agentId: spec.agentId,
        status: state.status,
        error: state.error ?? null,
      })
      continue
    }

    try {
      await prepareSAAgentForWebRelay(state.debugPort, state.saExtensionId)
    } catch (error) {
      log('SA_PREPARATION_FAILED', {
        agentId: spec.agentId,
        debugPort: state.debugPort,
        error: error instanceof Error ? error.message : String(error),
      })
      continue
    }

    ready.push(state)
    log('AGENT_READY', {
      agentId: state.agentId,
      instanceId: state.instanceId,
      debugPort: state.debugPort,
      sessionMode: state.sessionMode,
      saLoaded: Boolean(state.saExtensionId),
      ui: await inspectPage(state.debugPort),
    })
  }

  const sentinel = await scanSentinel()
  log('SENTINEL_INITIAL_SCAN', {
    healthy: sentinel.healthy,
    agentsChecked: sentinel.agentsChecked,
    issuesFound: sentinel.issuesFound,
    details: sentinel.details,
  })

  const auth = ready.find(agent => agent.sessionMode === 'authenticated')
  if (auth?.debugPort) {
    const pairedTargets = await Promise.all(
      ready.map(async agent => ({
        agent,
        target: agent.debugPort ? await findChatGptTarget(agent.debugPort) : undefined,
      })),
    )
    for (const { agent, target } of pairedTargets) {
      if (!agent.debugPort || !target) continue
      const bounds = agent.agentId === auth.agentId
        ? { left: 0, top: 0, width: 900, height: 768 }
        : {
            left: 900,
            top: agent.role === 'worker-2' ? 0 : 384,
            width: 466,
            height: 384,
          }
      await placeWindow(agent.debugPort, target, bounds)
    }

    const attachment = await attachThroughCompactButton(auth.debugPort)
    log('COMPACT_ATTACH_TEST', { agentId: auth.agentId, ...attachment })

    if (attachment.attachButtonClicked && attachment.attachmentNameVisible) {
      const candidatePath = path.join(
        process.cwd(),
        '.agents',
        'prompts',
        'superassistant-openmcpweblock-candidate.md',
      )
      const review = await submitReviewRequest(auth.debugPort, candidatePath)
      log('PROMPT_REVIEW_REQUEST', {
        agentId: auth.agentId,
        submitted: review.submitted,
        issuedWithoutFocusedWindow: review.submittedWithoutFocus,
        responseReceived: review.responseReceived,
        response: review.response,
      })

      if (auth.saExtensionId) {
        const records = await getExecutionMetadata(
          auth.debugPort,
          auth.saExtensionId,
        )
        log('AUTH_EXECUTION_METADATA', { recordCount: records.length, records })
      }
    }
  }

  log('VISIBLE_TEST_POOL_READY', {
    agentIds: ready.map(agent => agent.agentId),
    authenticatedAgentReady: Boolean(auth),
    cleanAgentCount: ready.filter(agent => agent.sessionMode === 'clean').length,
    saSource: 'chrome-extension/source/dist',
    note: 'Master Session supplies auth only. Each relay must independently load and verify the repo SA extension. A separate CLI does not share this controller process registry.',
  })

  while (ready.some(agent => agent.debugPort)) {
    let activeAgents = 0
    for (const agent of ready) {
      if (agent.debugPort && await isDebugPortActive(agent.debugPort)) activeAgents++
    }
    if (activeAgents === 0) break
    await new Promise(resolve => setTimeout(resolve, 5000))
  }

  log('TEST_POOL_CLOSED')
}

await main()
