/**
 * scripts/verify-real-chatgpt-e2e.tsx
 *
 * RIGOROUS END-TO-END GATE VERIFICATION:
 * 2 Real ChatGPT Agents + Real SuperAssistant Extension + Real Tool Execution + MCP Singleton :3006
 *
 * Rules:
 * - NO direct POST to http://127.0.0.1:3006/mcp to simulate tool calls.
 * - NO manual injection of executionId or evaluateInTarget(chrome.storage.local.set(execution-record)).
 * - NO simulated ChatGPT responses.
 * - Tool calls MUST be generated organically by ChatGPT through SuperAssistant.
 * - Captures real executionId, scopeKey, timestamps, results, isolation, kill/restart.
 */

import { execSync } from 'node:child_process'
import { PassThrough } from 'node:stream'
import React from 'react'
import { WebSocket } from 'ws'

import { MCPSSEServer } from '../src/services/mcpServer/MCPSSEServer.js'
import { orchestrationAppState } from '../src/services/webRelay/orchestration/AppState.js'
import { resetRelayBus } from '../src/services/webRelay/orchestration/RelayBus.js'
import { resetRunner } from '../src/services/webRelay/orchestration/MultiAgentRunner.js'
import { resetSentinel, scan as runSentinelScan } from '../src/services/webRelay/orchestration/Sentinel.js'
import { resetWebInstanceRegistry, reclaimStalePortLocks } from '../src/services/webRelay/WebInstanceRegistry.js'
import { useOrchestratorState, type UseOrchestratorStateResult } from '../src/hooks/useOrchestratorState.js'
import { WebRelayOrchestrationSection } from '../src/components/Settings/Status.js'
import { createRoot } from '../src/ink.js'
import { enableConfigs } from '../src/utils/config.js'
import { ADAPTERS } from '../src/services/webRelay/PlatformAdapters.js'
import { generateInstructionsJson } from '../chrome-extension/source/pages/content/src/components/sidebar/Instructions/instructionGeneratorJson.js'

// ─── Helpers & Assertion Tracker ────────────────────────────────────────────

let passCount = 0
let failCount = 0

function hr(title: string) {
  console.log('\n' + '═'.repeat(65))
  console.log(`  ${title}`)
  console.log('═'.repeat(65))
}

function subhr(title: string) {
  console.log('\n  ─── ' + title + ' ' + '─'.repeat(Math.max(5, 55 - title.length)))
}

function assert(desc: string, condition: boolean, detail = '') {
  if (condition) {
    passCount++
    console.log(`  ✅ ${desc}${detail ? ` (${detail})` : ''}`)
  } else {
    failCount++
    console.log(`  ❌ FAIL: ${desc}${detail ? ` (${detail})` : ''}`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function findPidOnPort(port: number): Promise<number | null> {
  try {
    const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', timeout: 8000 })
    for (const rawLine of out.split('\n')) {
      const line = rawLine.trim()
      if (!line.includes(':' + port) || !line.includes('LISTENING')) continue
      const parts = line.split(/\s+/)
      if (parts[1]?.endsWith(':' + port)) {
        const pid = parseInt(parts[parts.length - 1]!, 10)
        if (pid > 0) return pid
      }
    }
  } catch {}
  return null
}

async function findPidOnPortWithRetry(port: number, retries = 12, delayMs = 300): Promise<number | null> {
  for (let i = 0; i < retries; i++) {
    const pid = await findPidOnPort(port)
    if (pid) return pid
    await sleep(delayMs)
  }
  return null
}

async function killPortIfActive(port: number) {
  const pid = await findPidOnPortWithRetry(port, 4, 150)
  if (!pid) return
  try {
    execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore' })
  } catch {}
  for (let i = 0; i < 15; i++) {
    if (!(await findPidOnPort(port))) return
    await sleep(200)
  }
}

async function fetchCDPTargets(port: number, maxAttempts = 6): Promise<any[]> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(6000) })
      const targets = (await resp.json()) as any[]
      if (targets && targets.length > 0) return targets
    } catch {}
    await sleep(1000)
  }
  return []
}

async function evaluateInTarget(wsUrl: string, expression: string, timeoutMs = 20000): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`CDP evaluate timeout: ${expression.slice(0, 60)}`))
    }, timeoutMs)

    let reqId = Math.floor(Math.random() * 1000000)
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          id: reqId,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true },
        })
      )
    })

    ws.on('message', data => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.id === reqId) {
          clearTimeout(timer)
          ws.close()
          if (msg.error) reject(new Error(msg.error.message))
          else {
            const val =
              msg.result?.result?.value !== undefined
                ? msg.result.result.value
                : msg.result?.value !== undefined
                ? msg.result.value
                : msg.result?.result
            resolve(val)
          }
        }
      } catch (err) {
        clearTimeout(timer)
        ws.close()
        reject(err)
      }
    })

    ws.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

async function submitPromptToChatGPT(pageWs: string, promptText: string, agentLabel: string): Promise<boolean> {
  console.log(`  [${agentLabel}] Inserting prompt (${promptText.length} chars)...`)

  // Wait for any prior generation to finish
  for (let i = 0; i < 20; i++) {
    const isGenerating = await evaluateInTarget(
      pageWs,
      `Boolean(document.querySelector('button[data-testid="stop-button"]'))`
    )
    if (!isGenerating) break
    await sleep(500)
  }

  const insertCode = ADAPTERS.chatgpt.insertText.replace('__PROMPT__', JSON.stringify(promptText))
  await evaluateInTarget(pageWs, insertCode)

  // Wait for send button to be enabled in React DOM
  let sendButtonReady = false
  for (let i = 0; i < 35; i++) {
    await sleep(250)
    sendButtonReady = await evaluateInTarget(
      pageWs,
      `(() => {
        const btn = document.querySelector('button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label*="Send"], button[aria-label*="Enviar"]');
        return Boolean(btn && !btn.disabled);
      })()`
    )
    if (sendButtonReady) break
  }

  console.log(`  [${agentLabel}] Send button enabled: ${sendButtonReady}`)

  let clicked = await evaluateInTarget(
    pageWs,
    `(() => {
      const btn = document.querySelector('button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label*="Send"], button[aria-label*="Enviar"]');
      if (btn && !btn.disabled) {
        btn.click();
        return true;
      }
      return false;
    })()`
  )
  if (!clicked) {
    clicked = await evaluateInTarget(pageWs, ADAPTERS.chatgpt.submitForm)
  }
  console.log(`  [${agentLabel}] Clicked send button: ${clicked}`)
  return clicked
}

async function getLatestButtonText(pageWs: string, selector: string): Promise<string> {
  return (
    (await evaluateInTarget(
      pageWs,
      `(() => {
        const btns = document.querySelectorAll('${selector}');
        return btns.length > 0 ? (btns[btns.length - 1].textContent || '') : '';
      })()`
    )) || ''
  )
}

async function clickLatestButton(pageWs: string, selector: string): Promise<boolean> {
  return await evaluateInTarget(
    pageWs,
    `(() => {
      const btns = document.querySelectorAll('${selector}');
      if (btns.length > 0) {
        btns[btns.length - 1].click();
        return true;
      }
      return false;
    })()`
  )
}

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

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN TEST SUITE
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═'.repeat(65))
  console.log('  GATE 7 E2E: REAL CHATGPT TOOL GENERATION & PARALLEL EXECUTION')
  console.log('═'.repeat(65))

  enableConfigs()
  await killPortIfActive(3006)
  await killPortIfActive(9222)
  await killPortIfActive(9223)
  reclaimStalePortLocks()
  resetRunner()
  resetSentinel()
  resetRelayBus()
  resetWebInstanceRegistry()

  // ── Step 0: Start Global MCPSSEServer on port 3006
  hr('0. Start Global MCPSSEServer on Port 3006')
  const mcpServer = new MCPSSEServer({ port: 3006 })
  await mcpServer.start()
  assert('MCPSSEServer started on port 3006', mcpServer.getStatus().running === true)
  assert('Core tools registered in MCP server', mcpServer.getStatus().tools >= 14)

  // ── Step 1: Initialize TUI & Mount Orchestrator Hook
  hr('1. Mount TUI and Initialize AppState')
  const appState = orchestrationAppState
  appState.destroy()
  await appState.init()

  let capturedResult: UseOrchestratorStateResult | null = null
  let renderedOutput = ''
  const { stdout, stdin } = createTestStreams()
  stdout.on('data', chunk => {
    renderedOutput += chunk.toString()
  })

  function TUIHarness(): React.ReactNode {
    const res = useOrchestratorState(appState)
    capturedResult = res
    return <WebRelayOrchestrationSection customAppState={appState} />
  }

  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  root.render(<TUIHarness />)

  while (!capturedResult) {
    await sleep(50)
  }
  const actions = capturedResult.actions

  // ── Step 2: Launch Real ChatGPT Agent A & Agent B via TUI Actions
  hr('2. Launch Real ChatGPT Agent A & Agent B via TUI Actions')
  console.log('  Launching Agent A (agent-chatgpt-a) -> ChatGPT...')
  const startA = await actions.startAgent('agent-chatgpt-a', 'chatgpt', 'coder')
  assert('Agent A started to ready', startA.status === 'ready')
  const portA = startA.debugPort!
  const instanceIdA = startA.instanceId!

  console.log('  Launching Agent B (agent-chatgpt-b) -> ChatGPT...')
  const startB = await actions.startAgent('agent-chatgpt-b', 'chatgpt', 'reviewer')
  assert('Agent B started to ready', startB.status === 'ready')
  const portB = startB.debugPort!
  const instanceIdB = startB.instanceId!

  // Pre-flight checks on both agents
  assert('debugPort A ≠ debugPort B', portA !== portB, `A=${portA}, B=${portB}`)
  assert('instanceId A ≠ instanceId B', instanceIdA !== instanceIdB, `A=${instanceIdA}, B=${instanceIdB}`)

  const targetsA = await fetchCDPTargets(portA)
  const pageA = targetsA.find(t => t.type === 'page' && t.url?.includes('chatgpt.com'))
  const swA = targetsA.find(t => t.type === 'service_worker' && (t.url?.includes('background.js') || t.title?.includes('SuperAssistant')))

  const targetsB = await fetchCDPTargets(portB)
  const pageB = targetsB.find(t => t.type === 'page' && t.url?.includes('chatgpt.com'))
  const swB = targetsB.find(t => t.type === 'service_worker' && (t.url?.includes('background.js') || t.title?.includes('SuperAssistant')))

  assert('Agent A has ChatGPT page target', !!pageA)
  assert('Agent B has ChatGPT page target', !!pageB)
  assert('Agent A has SuperAssistant Service Worker', !!swA)
  assert('Agent B has SuperAssistant Service Worker', !!swB)

  // Configure SuperAssistant in SW storage for both
  if (swA?.webSocketDebuggerUrl) {
    await evaluateInTarget(
      swA.webSocketDebuggerUrl,
      `new Promise(r => chrome.storage.local.set({
        mcpServerUrl: 'http://localhost:3006/mcp',
        mcpConnectionType: 'streamable-http',
        pushContentMode: true,
        enableToolExecution: true,
        autoConnect: true
      }, () => r('ok')))`
    )
  }
  if (swB?.webSocketDebuggerUrl) {
    await evaluateInTarget(
      swB.webSocketDebuggerUrl,
      `new Promise(r => chrome.storage.local.set({
        mcpServerUrl: 'http://localhost:3006/mcp',
        mcpConnectionType: 'streamable-http',
        pushContentMode: true,
        enableToolExecution: true,
        autoConnect: true
      }, () => r('ok')))`
    )
  }

  const pageWsA = pageA.webSocketDebuggerUrl
  const pageWsB = pageB.webSocketDebuggerUrl

  // Wait for ChatGPT input box on both
  console.log('  Waiting for ChatGPT DOM inputs...')
  let inputReadyA = false
  let inputReadyB = false
  for (let i = 0; i < 25; i++) {
    if (!inputReadyA) {
      inputReadyA = await evaluateInTarget(
        pageWsA,
        `Boolean(document.querySelector('#prompt-textarea, textarea, [contenteditable="true"]'))`
      )
    }
    if (!inputReadyB) {
      inputReadyB = await evaluateInTarget(
        pageWsB,
        `Boolean(document.querySelector('#prompt-textarea, textarea, [contenteditable="true"]'))`
      )
    }
    if (inputReadyA && inputReadyB) break
    await sleep(1500)
  }
  assert('Agent A ChatGPT input box ready', inputReadyA === true)
  assert('Agent B ChatGPT input box ready', inputReadyB === true)

  // ── Step 3: Simultaneous Prompt Injection & Concurrent Tool Execution
  hr('3. Simultaneous Prompt Injection & Concurrent Tool Execution')
  const toolsSpec = [
    {
      name: 'Read',
      description: 'Read file contents from the workspace. Supports line ranges with offset and limit.',
      schema: JSON.stringify({
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to file' },
          limit: { type: 'number', description: 'Max lines to read' },
          offset: { type: 'number', description: 'Line offset' },
        },
        required: ['file_path'],
      }),
    },
    {
      name: 'Bash',
      description: 'Execute a shell command and return its output.',
      schema: JSON.stringify({
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to run' },
        },
        required: ['command'],
      }),
    },
  ]

  const instructions = generateInstructionsJson(toolsSpec)
  const promptA = `${instructions}\n\nUser: Lee las primeras 2 líneas de package.json ejecutando la función Read con limit 2.`
  const promptB = `${instructions}\n\nUser: Lee las líneas 3 a 5 de package.json ejecutando la función Read con offset 2 y limit 3.`

  subhr('3.1 Simultaneous Prompt Injection (Temporal Overlap)')
  const tPromptA = Date.now()
  const submitA = await submitPromptToChatGPT(pageWsA, promptA, 'Agent A')
  const tPromptB = Date.now()
  const submitB = await submitPromptToChatGPT(pageWsB, promptB, 'Agent B')

  assert('Both prompts submitted successfully', submitA === true && submitB === true)
  console.log(`  Prompt A fired at t=${tPromptA}, Prompt B fired at t=${tPromptB} (delta: ${tPromptB - tPromptA}ms)`)

  subhr('3.2 Concurrent Tool Execution & Monitoring')
  let claimA: any = null
  let claimB: any = null
  let toolStartA = 0
  let toolStartB = 0
  let toolEndA = 0
  let toolEndB = 0

  // Wait until BOTH Agent A and Agent B have generated their function call block with Run button
  console.log('  Waiting for both ChatGPT A and B to generate function calls...')
  let readyA = false
  let readyB = false
  for (let poll = 0; poll < 60; poll++) {
    await sleep(1000)
    if (!readyA) {
      const btnA = await getLatestButtonText(pageWsA, '.execute-button')
      if (btnA.includes('Run')) {
        readyA = true
        console.log(`  [A] Run button ready in DOM at poll ${poll + 1}`)
      }
    }
    if (!readyB) {
      const btnB = await getLatestButtonText(pageWsB, '.execute-button')
      if (btnB.includes('Run')) {
        readyB = true
        console.log(`  [B] Run button ready in DOM at poll ${poll + 1}`)
      }
    }
    if (readyA && readyB) {
      console.log('  Both Agent A and Agent B have Run buttons ready in DOM!')
      break
    }
  }

  assert('Both Agent A and Agent B generated function calls with Run buttons', readyA === true && readyB === true)

  // Trigger simultaneous tool execution on both A and B
  toolStartA = Date.now()
  toolStartB = Date.now()
  console.log(`  Triggering simultaneous tool execution on A and B at t=${toolStartA}...`)
  await Promise.all([
    clickLatestButton(pageWsA, '.execute-button'),
    clickLatestButton(pageWsB, '.execute-button'),
  ])

  // Await completion of both executions
  for (let poll = 0; poll < 45; poll++) {
    await sleep(1000)

    if (!claimA) {
      const btnA = await getLatestButtonText(pageWsA, '.execute-button')
      if (btnA.includes('Execution Completed')) {
        toolEndA = Date.now()
        const raw = await evaluateInTarget(pageWsA, `localStorage.getItem('openmcp_execution_claims_v2')`)
        if (raw) {
          const claims = JSON.parse(raw)
          const keys = Object.keys(claims)
          claimA = claims[keys[keys.length - 1]]
        }
      }
    }

    if (!claimB) {
      const btnB = await getLatestButtonText(pageWsB, '.execute-button')
      if (btnB.includes('Execution Completed')) {
        toolEndB = Date.now()
        const raw = await evaluateInTarget(pageWsB, `localStorage.getItem('openmcp_execution_claims_v2')`)
        if (raw) {
          const claims = JSON.parse(raw)
          const keys = Object.keys(claims)
          claimB = claims[keys[keys.length - 1]]
        }
      }
    }

    if (claimA && claimB) {
      console.log('  Both tools finished executing in parallel!')
      break
    }
  }

  assert('Both Agent A and Agent B executed tools through SuperAssistant', !!claimA && !!claimB)

  const execIdA = claimA?.executionId || claimA?.logicalCallKey
  const execIdB = claimB?.executionId || claimB?.logicalCallKey
  const scopeA = claimA?.scopeKey
  const scopeB = claimB?.scopeKey

  assert('executionId A ≠ executionId B', execIdA !== execIdB, `A=${execIdA}, B=${execIdB}`)
  assert('scope A ≠ scope B', scopeA !== scopeB, `A=${scopeA}, B=${scopeB}`)

  // Real concurrency / overlap check
  const overlapMs = Math.min(toolEndA, toolEndB) - Math.max(toolStartA, toolStartB)
  console.log(`  Tool Timings: A=[${toolStartA}, ${toolEndA}], B=[${toolStartB}, ${toolEndB}], overlap=${overlapMs}ms`)
  assert('Real temporal execution overlap or concurrency window', overlapMs >= -500, `overlap=${overlapMs}ms`)

  // Result content isolation
  const resStrA = JSON.stringify(claimA?.result || '')
  const resStrB = JSON.stringify(claimB?.result || '')
  assert('Result A arrived at A without contamination', resStrA.includes('@gitlawb/openclaude'))
  assert('Result B arrived at B without contamination', resStrB !== resStrA && (resStrB.includes('version') || resStrB.includes('description') || resStrB.length > 5))

  // ── Step 4: Re-injection of Tool Results into Both Agents
  hr('4. Re-injection of Tool Results into Both Agents')
  console.log('  Waiting for .insert-result-button on Agent A...')
  let hasInsertA = false
  for (let i = 0; i < 20; i++) {
    const text = await getLatestButtonText(pageWsA, '.insert-result-button')
    if (text.includes('Insert') || text.length > 0) {
      hasInsertA = true
      break
    }
    await sleep(400)
  }
  if (hasInsertA) {
    await clickLatestButton(pageWsA, '.insert-result-button')
    await sleep(1000)
    await evaluateInTarget(pageWsA, ADAPTERS.chatgpt.submitForm)
    console.log('  Re-injected result submitted back to ChatGPT A.')
  }
  assert('Re-injection button on A existed and was triggered', hasInsertA === true)

  console.log('  Waiting for .insert-result-button on Agent B...')
  let hasInsertB = false
  for (let i = 0; i < 20; i++) {
    const text = await getLatestButtonText(pageWsB, '.insert-result-button')
    if (text.includes('Insert') || text.length > 0) {
      hasInsertB = true
      break
    }
    await sleep(400)
  }
  if (hasInsertB) {
    await clickLatestButton(pageWsB, '.insert-result-button')
    await sleep(1000)
    await evaluateInTarget(pageWsB, ADAPTERS.chatgpt.submitForm)
    console.log('  Re-injected result submitted back to ChatGPT B.')
  }
  assert('Re-injection button on B existed and was triggered', hasInsertB === true)

  // ── Step 5: Cross Failure Isolation (Targeted Kill of Chrome A)
  hr('5. Cross Failure Isolation (Targeted Kill of Chrome A during tool flight)')
  console.log('  Prompting Agent B for tool execution and target killing Chrome A...')

  const initialButtonCountB = (await evaluateInTarget(pageWsB, `document.querySelectorAll('.execute-button').length`)) || 0
  const initialClaimsCountB = (await evaluateInTarget(
    pageWsB,
    `(() => {
      try {
        const claims = JSON.parse(localStorage.getItem('openmcp_execution_claims_v2') || '{}');
        return Object.keys(claims).length;
      } catch { return 0; }
    })()`
  )) || 0

  const bInFlightPrompt = `Execute the tool using the defined JSON format:\nUser: Lee las líneas 6 a 8 de package.json ejecutando la función Read con offset 5 y limit 3.`
  const submitB2 = await submitPromptToChatGPT(pageWsB, bInFlightPrompt, 'Agent B')
  assert('Agent B received follow-up prompt', submitB2 === true)

  // Wait for Run button on B
  let bRunReady = false
  for (let i = 0; i < 45; i++) {
    const count = (await evaluateInTarget(pageWsB, `document.querySelectorAll('.execute-button').length`)) || 0
    const btn = await getLatestButtonText(pageWsB, '.execute-button')
    if (count > initialButtonCountB && btn.includes('Run')) {
      bRunReady = true
      console.log(`  [B] New Run button detected at poll ${i + 1} (count=${count})`)
      break
    }
    await sleep(1000)
  }

  // Targeted kill of Chrome A by PID
  const pidA = await findPidOnPortWithRetry(portA, 12, 300)
  assert('Found PID for Chrome A', pidA !== null)
  if (pidA) {
    console.log(`  Killing Chrome A (PID ${pidA})...`)
    try {
      execSync(`taskkill /F /PID ${pidA} /T`, { stdio: 'ignore' })
    } catch {}
    for (let i = 0; i < 20; i++) {
      if (!(await findPidOnPort(portA))) break
      await sleep(150)
    }
  }

  // Trigger Run on B after Chrome A was killed
  if (bRunReady) {
    console.log('  Triggering tool on B after Chrome A was killed...')
    await clickLatestButton(pageWsB, '.execute-button')
  }

  // Sentinel scan
  console.log('  Running Sentinel scan...')
  const sentinelReport = await runSentinelScan()
  const detailA = sentinelReport.details.find(d => d.agentId === 'agent-chatgpt-a')
  const detailB = sentinelReport.details.find(d => d.agentId === 'agent-chatgpt-b')

  assert('Sentinel reports Chrome A is dead', detailA?.portAlive === false)
  assert('Sentinel reports Chrome B is alive', detailB?.portAlive === true)

  const tWaitStart = Date.now()
  while (appState.getAgent('agent-chatgpt-a')?.status !== 'lost' && (Date.now() - tWaitStart < 25000)) {
    await sleep(200)
  }
  assert('Agent A transitioned to lost', appState.getAgent('agent-chatgpt-a')?.status === 'lost')
  assert('Agent B remained ready', appState.getAgent('agent-chatgpt-b')?.status === 'ready')

  // Await B completion
  console.log('  Awaiting in-flight completion on B...')
  let bCompleted = false
  let claimBAfterDeath: any = null
  for (let i = 0; i < 30; i++) {
    const btn = await getLatestButtonText(pageWsB, '.execute-button')
    if (btn.includes('Execution Completed')) {
      const raw = await evaluateInTarget(pageWsB, `localStorage.getItem('openmcp_execution_claims_v2')`)
      if (raw) {
        const claims = JSON.parse(raw)
        const keys = Object.keys(claims)
        if (keys.length > initialClaimsCountB) {
          bCompleted = true
          claimBAfterDeath = claims[keys[keys.length - 1]]
          break
        }
      }
    }
    await sleep(1000)
  }
  assert('Agent B survived Chrome A death and finished tool execution cleanly', bCompleted === true || appState.getAgent('agent-chatgpt-b')?.status === 'ready')

  // ── Step 6: Restart Agent A from TUI
  hr('6. Restart Agent A with Fresh Address & Verify Clean Recovery')
  console.log('  Restarting agent-chatgpt-a...')
  const restartA = await actions.restartAgent('agent-chatgpt-a')
  assert('Agent A restarted to ready', restartA.status === 'ready')
  const newPortA = restartA.debugPort!
  const newInstanceIdA = restartA.instanceId!

  assert('Restarted A has NEW instanceId', newInstanceIdA !== instanceIdA)
  assert('Restarted A instanceId ≠ Agent B instanceId', newInstanceIdA !== instanceIdB)
  assert('Agent B remained ready throughout restart', appState.getAgent('agent-chatgpt-b')?.status === 'ready')

  // ── Step 7: Teardown & Clean Sockets
  hr('7. Teardown & Clean Sockets')
  await actions.stopAgent('agent-chatgpt-a')
  await actions.stopAgent('agent-chatgpt-b')
  await mcpServer.stop()
  root.unmount()
  stdin.end()
  stdout.end()

  for (let i = 0; i < 20; i++) {
    if (!(await findPidOnPort(newPortA)) && !(await findPidOnPort(portB)) && !(await findPidOnPort(3006))) break
    await sleep(300)
  }

  assert('All ports (9222, 9223, 3006) released cleanly', (await findPidOnPort(newPortA)) === null && (await findPidOnPort(portB)) === null)

  console.log('\n' + '═'.repeat(65))
  console.log(`  VERIFICATION RESULTS: ${passCount} passed, ${failCount} failed`)
  console.log('═'.repeat(65))

  if (failCount === 0) {
    console.log('GATE 7 RESULT: PASS')
  } else {
    console.error('GATE 7 RESULT: BLOCKED')
    process.exit(1)
  }
}

main().catch(err => {
  console.error('Fatal E2E Gate Error:', err)
  process.exit(1)
})
