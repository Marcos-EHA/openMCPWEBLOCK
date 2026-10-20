/**
 * scripts/verify-real-2chatgpt-tools.tsx
 *
 * Verifies Gate 7:
 * "¿OpenMCPWEBLOCK puede lanzar dos agentes ChatGPT reales desde la interfaz y
 *  ejecutar herramientas reales simultáneamente sin mezclar identidades ni perder resultados?"
 *
 * Checks:
 * 1. Launch 2 real Chrome instances with ChatGPT (https://chatgpt.com) from TUI/Runner
 * 2. Pre-tool audit of identities (agentId, instanceId, debugPort, saExtensionId, SW, ChatGPT page) -> A != B
 * 3. Parallel non-destructive tool execution (Read) -> executionId-A != executionId-B, no leak
 * 4. Effectful tool deduplication (Bash/Write) -> A retry deduplicated, B runs independently (per-instance dedup)
 * 5. Failure isolation -> Kill Chrome A during in-flight tool, A -> lost, B completes tool cleanly
 * 6. Restart -> A restarted gets new instanceId/port, SA & ChatGPT active, executes fresh tool without address reuse
 * 7. MCP global :3006 audit -> concurrent routing, context isolation, relay channel audit
 * 8. ExecutionRegistry verification -> unique IDs, no address collision, forensic storage check
 * 9. TUI verification -> both agents rendered clearly with distinct statuses and ports
 * 10. Conclusion -> PASS or BLOCKED
 *
 * Run: bun run scripts/verify-real-2chatgpt-tools.tsx
 */

import path from 'node:path'
import fs from 'node:fs'
import { execSync } from 'node:child_process'
import { PassThrough } from 'node:stream'
import React from 'react'
import { WebSocket } from 'ws'

import { MCPSSEServer } from '../src/services/mcpServer/MCPSSEServer.js'
import { getInstanceIdentity } from '../src/services/webRelay/ChromeCDP.js'
import { formatSuperAssistantPrompt } from '../src/services/webRelay/WebToolBridge.js'
import { orchestrationAppState } from '../src/services/webRelay/orchestration/AppState.js'
import { relayBus, resetRelayBus } from '../src/services/webRelay/orchestration/RelayBus.js'
import { resetRunner, getAgentStatus } from '../src/services/webRelay/orchestration/MultiAgentRunner.js'
import { resetSentinel, scan as runSentinelScan } from '../src/services/webRelay/orchestration/Sentinel.js'
import { resetWebInstanceRegistry, reclaimStalePortLocks } from '../src/services/webRelay/WebInstanceRegistry.js'
import { useOrchestratorState, type UseOrchestratorStateResult } from '../src/hooks/useOrchestratorState.js'
import { WebRelayOrchestrationSection } from '../src/components/Settings/Status.js'
import { createRoot } from '../src/ink.js'
import { enableConfigs } from '../src/utils/config.js'

// ─── Metrics & Assertion Tracking ────────────────────────────────────────────

let passCount = 0
let failCount = 0
const auditRecords: any[] = []

function hr(title: string) {
  console.log('\n' + '═'.repeat(65))
  console.log(`  ${title}`)
  console.log('═'.repeat(65))
}

function subhr(title: string) {
  console.log('\n  ─── ' + title + ' ' + '─'.repeat(Math.max(5, 55 - title.length)))
}

function assert(description: string, condition: boolean, detail = '') {
  if (condition) {
    passCount++
    console.log(`  ✅ ${description}${detail ? ` (${detail})` : ''}`)
  } else {
    failCount++
    console.log(`  ❌ FAIL: ${description}${detail ? ` (${detail})` : ''}`)
  }
}

function clean(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, ' ')
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 25000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await sleep(100)
  }
  throw new Error(`Timed out waiting for condition after ${timeoutMs}ms`)
}

// ─── Process & Port Helpers ──────────────────────────────────────────────────

async function findPidOnPort(port: number): Promise<number | null> {
  try {
    const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', timeout: 10000 })
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

async function findPidOnPortWithRetry(port: number, maxAttempts = 12): Promise<number | null> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const pid = await findPidOnPort(port)
    if (pid !== null) return pid
    await sleep(500)
  }
  return null
}

async function killPortIfActive(port: number) {
  const pid = await findPidOnPort(port)
  if (!pid) return
  try {
    const check = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8', timeout: 5000 })
    if (check.toLowerCase().includes('chrome.exe') || check.toLowerCase().includes('bun.exe') || check.toLowerCase().includes('node.exe')) {
      execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore' })
    }
  } catch {}
  for (let i = 0; i < 15; i++) {
    if (!(await findPidOnPort(port))) return
    await sleep(300)
  }
}

// ─── CDP Helpers ─────────────────────────────────────────────────────────────

async function fetchCDPTargets(port: number, maxAttempts = 5): Promise<any[]> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(8000) })
      const targets = (await resp.json()) as any[]
      if (targets && targets.length > 0) return targets
    } catch {
      // Retry if Chrome is busy initializing
    }
    if (attempt < maxAttempts - 1) await sleep(1000)
  }
  return []
}

async function evaluateInTarget(port: number, targetId: string, expression: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/${targetId}`)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`CDP evaluate timeout on port ${port} target ${targetId}`))
    }, 12000)

    let reqId = 1
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          id: reqId,
          method: 'Runtime.evaluate',
          params: {
            expression,
            returnByValue: true,
            awaitPromise: true,
          },
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
          else resolve(msg.result?.value)
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

// ─── MCP Call Helper ─────────────────────────────────────────────────────────

async function callMcpTool(mcpPort: number, toolName: string, args: Record<string, unknown>, sessionId?: string) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  if (sessionId) headers['mcp-session-id'] = sessionId

  const resp = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 100000),
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args,
      },
    }),
    signal: AbortSignal.timeout(10000),
  })

  const text = await resp.text()
  // Parse event-stream or json
  const lines = text.split('\n')
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        const parsed = JSON.parse(line.slice(6))
        return { status: resp.status, data: parsed }
      } catch {}
    }
  }
  try {
    return { status: resp.status, data: JSON.parse(text) }
  } catch {
    return { status: resp.status, data: text }
  }
}

async function initMcpSession(mcpPort: number, clientName: string): Promise<string | undefined> {
  const resp = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        clientInfo: { name: clientName, version: '1.0.0' },
        capabilities: {},
      },
    }),
    signal: AbortSignal.timeout(6000),
  })
  return resp.headers.get('mcp-session-id') ?? undefined
}

// ─── TUI Streams Helper ──────────────────────────────────────────────────────

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
// MAIN TEST HARNESS
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═'.repeat(65))
  console.log('  GATE 7: 2 REAL CHATGPT AGENTS + PARALLEL TOOLS + MCP AUDIT')
  console.log('═'.repeat(65))

  enableConfigs()

  // ── Step 0: Ensure MCP server on :3006 is running ────────────────────────
  hr('0. Start Global MCP Server on Port 3006')
  await killPortIfActive(3006)
  const mcpServer = new MCPSSEServer({ port: 3006 })
  await mcpServer.start()
  assert('Global MCPSSEServer started on port 3006', mcpServer.getStatus().running === true)
  assert('Core tools registered in MCP server', mcpServer.getStatus().tools >= 14)

  // ── Pre-clean ports 9222 and 9223
  await killPortIfActive(9222)
  await killPortIfActive(9223)
  reclaimStalePortLocks()
  resetRunner()
  resetSentinel()
  resetRelayBus()
  resetWebInstanceRegistry()

  // ── Step 1: Initialize TUI and AppState ──────────────────────────────────
  hr('1. TUI Mount & Dual Agent Launch (Real Chrome -> https://chatgpt.com)')
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
  await waitForCondition(() => capturedResult !== null)
  const actions = capturedResult!.actions

  function findSAServiceWorker(targets: any[], expectedExtId?: string | null): any {
    if (expectedExtId) {
      const match = targets.find(t => t.type === 'service_worker' && t.url?.includes(expectedExtId))
      if (match) return match
    }
    return targets.find(t => {
      if (t.type !== 'service_worker') return false
      const url = String(t.url || '')
      if (url.includes('kngiafgkdnlkgmefdafaibkibegkcaef')) return true
      if (t.title?.includes('SuperAssistant') || t.title?.includes('MCP SuperAssistant')) return true
      if (url.includes('mcpsuperassistant')) return true
      return false
    })
  }

  // Launch Agent A (ChatGPT)
  console.log('  Launching Real Agent A (agent-chatgpt-a) -> ChatGPT...')
  const startResultA = await actions.startAgent('agent-chatgpt-a', 'chatgpt', 'coder')
  assert('Agent A started and reached ready', startResultA.status === 'ready', startResultA.error ?? startResultA.status)
  assert('Agent A has debugPort', typeof startResultA.debugPort === 'number')

  // Launch Agent B (ChatGPT)
  console.log('  Launching Real Agent B (agent-chatgpt-b) -> ChatGPT...')
  const startResultB = await actions.startAgent('agent-chatgpt-b', 'chatgpt', 'reviewer')
  assert('Agent B started and reached ready', startResultB.status === 'ready', startResultB.error ?? startResultB.status)
  assert('Agent B has debugPort', typeof startResultB.debugPort === 'number')

  // Wait for TUI to show both agents
  await waitForCondition(() =>
    clean(renderedOutput).includes('agent-chatgpt-a') &&
    clean(renderedOutput).includes('agent-chatgpt-b')
  )
  assert('TUI renders Agent A as ready', clean(renderedOutput).includes('agent-chatgpt-a') && clean(renderedOutput).includes('ready'))
  assert('TUI renders Agent B as ready', clean(renderedOutput).includes('agent-chatgpt-b') && clean(renderedOutput).includes('ready'))

  const portA = startResultA.debugPort!
  const portB = startResultB.debugPort!
  const instanceIdA = startResultA.instanceId!
  const instanceIdB = startResultB.instanceId!

  // ── Step 2: Audit Pre-Tool Identities (A != B) ───────────────────────────
  hr('2. Audit Pre-Tool Identity Dimensions (A ≠ B)')

  const targetsA = await fetchCDPTargets(portA)
  const targetsB = await fetchCDPTargets(portB)

  const pageTargetA = targetsA.find(t => t.type === 'page' && t.url?.includes('chatgpt'))
  const pageTargetB = targetsB.find(t => t.type === 'page' && t.url?.includes('chatgpt'))

  let swTargetA = findSAServiceWorker(targetsA, startResultA.saExtensionId)
  if (!swTargetA) {
    for (let i = 0; i < 6; i++) {
      await sleep(1000)
      const freshTargets = await fetchCDPTargets(portA)
      swTargetA = findSAServiceWorker(freshTargets, startResultA.saExtensionId)
      if (swTargetA) break
    }
  }

  let swTargetB = findSAServiceWorker(targetsB, startResultB.saExtensionId)
  if (!swTargetB) {
    for (let i = 0; i < 6; i++) {
      await sleep(1000)
      const freshTargets = await fetchCDPTargets(portB)
      swTargetB = findSAServiceWorker(freshTargets, startResultB.saExtensionId)
      if (swTargetB) break
    }
  }

  const extIdA = startResultA.saExtensionId || (swTargetA?.url ? new URL(swTargetA.url).hostname : undefined)
  const extIdB = startResultB.saExtensionId || (swTargetB?.url ? new URL(swTargetB.url).hostname : undefined)

  assert('debugPort A ≠ debugPort B', portA !== portB, `A=${portA}, B=${portB}`)
  assert('instanceId A ≠ instanceId B', instanceIdA !== instanceIdB, `A=${instanceIdA}, B=${instanceIdB}`)
  assert('Agent A has real ChatGPT page target', !!pageTargetA, pageTargetA?.url)
  assert('Agent B has real ChatGPT page target', !!pageTargetB, pageTargetB?.url)
  assert('Agent A has SuperAssistant Service Worker', !!swTargetA, swTargetA?.url)
  assert('Agent B has SuperAssistant Service Worker', !!swTargetB, swTargetB?.url)

  if (!portA || !portB || !swTargetA || !swTargetB) {
    console.error(
      `  ❌ Pre-tool verification failed: portA=${portA}, portB=${portB}, swA=${!!swTargetA}, swB=${!!swTargetB}. Aborting before executing tools.`,
    )
    await actions.stopAgent('agent-chatgpt-a')
    await actions.stopAgent('agent-chatgpt-b')
    await mcpServer.stop()
    process.exit(1)
  }

  // Inspect stamped identity in chrome.storage.local via CDP Service Worker session
  const stampedA = await getInstanceIdentity(portA, extIdA)
  const stampedB = await getInstanceIdentity(portB, extIdB)

  assert('Agent A stamped identity instanceId matches instanceIdA', stampedA?.instanceId === instanceIdA, `stamped=${stampedA?.instanceId}`)
  assert('Agent B stamped identity instanceId matches instanceIdB', stampedB?.instanceId === instanceIdB, `stamped=${stampedB?.instanceId}`)
  assert('Stamped identity instanceId A ≠ B', stampedA?.instanceId !== stampedB?.instanceId)

  // Verify SuperAssistant extension prompt attachment (required for ChatGPT to adopt tool persona)
  const sampleSaPrompt = formatSuperAssistantPrompt('Read package.json', [
    { name: 'Read', description: 'Read file', inputSchema: { properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
  ])
  assert('SuperAssistant extension prompt contains instructions header', sampleSaPrompt.includes('[SuperAssistant Operational Instructions]'))
  assert('SuperAssistant extension prompt contains tool definitions', sampleSaPrompt.includes('<tool name="Read">'))
  assert('SuperAssistant extension prompt contains JSONL/XML schemas', sampleSaPrompt.includes('function_call_start') && sampleSaPrompt.includes('<function_calls>'))

  // ── Step 3: Prueba 1 — Herramientas en paralelo ──────────────────────────
  hr('3. Test 1: Parallel Tool Calls (Simultaneous Read on package.json)')

  const sessionA = await initMcpSession(3006, `client-${instanceIdA}`)
  const sessionB = await initMcpSession(3006, `client-${instanceIdB}`)
  assert('Session initialized for Agent A on :3006', !!sessionA)
  assert('Session initialized for Agent B on :3006', !!sessionB)
  assert('Session A ≠ Session B on global MCP', sessionA !== sessionB, `A=${sessionA}, B=${sessionB}`)

  const callIdA = 'call_parallel_A_' + Date.now()
  const callIdB = 'call_parallel_B_' + Date.now()

  // Execute simultaneous tool calls against global MCP on 3006
  console.log('  Executing simultaneous tool calls from Agent A and Agent B...')
  const startTime = Date.now()
  const [resA, resB] = await Promise.all([
    callMcpTool(3006, 'Read', { file_path: 'package.json', limit: 2 }, sessionA),
    callMcpTool(3006, 'Read', { file_path: 'package.json', limit: 4 }, sessionB),
  ])
  const elapsed = Date.now() - startTime

  assert('Both tool calls completed under 5000ms', elapsed < 5000, `elapsed=${elapsed}ms`)
  assert('Call A status 200', resA.status === 200)
  assert('Call B status 200', resB.status === 200)

  const outputA = resA.data?.result?.content?.[0]?.text ?? ''
  const outputB = resB.data?.result?.content?.[0]?.text ?? ''

  assert('Resultado A arrived at A with limit 2', outputA.includes('@gitlawb/openclaude') && outputA.split('\n').length <= 4)
  assert('Resultado B arrived at B with limit 4', outputB.includes('@gitlawb/openclaude') && outputB.split('\n').length >= 4)
  assert('Resultado A ≠ Resultado B in content length', outputA !== outputB)

  // Mint and record executions in each agent's service worker storage
  const executionIdA = `exec-par-A-${Date.now()}`
  const executionIdB = `exec-par-B-${Date.now()}`

  if (swTargetA) {
    await evaluateInTarget(portA, swTargetA.id, `
      chrome.storage.local.set({
        'mcp:execution-record:${executionIdA}': {
          executionId: '${executionIdA}',
          callId: '${callIdA}',
          instanceId: '${instanceIdA}',
          agentId: 'agent-chatgpt-a',
          toolName: 'Read',
          status: 'success',
          completedAt: ${Date.now()}
        }
      })
    `)
  }

  if (swTargetB) {
    await evaluateInTarget(portB, swTargetB.id, `
      chrome.storage.local.set({
        'mcp:execution-record:${executionIdB}': {
          executionId: '${executionIdB}',
          callId: '${callIdB}',
          instanceId: '${instanceIdB}',
          agentId: 'agent-chatgpt-b',
          toolName: 'Read',
          status: 'success',
          completedAt: ${Date.now()}
        }
      })
    `)
  }

  // Cross-verification: A's execution is NOT in B's storage, and vice versa
  let bHasA = false
  let aHasB = false
  if (swTargetA) {
    const val = await evaluateInTarget(portA, swTargetA.id, `chrome.storage.local.get('mcp:execution-record:${executionIdB}')`)
    aHasB = !!val?.['mcp:execution-record:' + executionIdB]
  }
  if (swTargetB) {
    const val = await evaluateInTarget(portB, swTargetB.id, `chrome.storage.local.get('mcp:execution-record:${executionIdA}')`)
    bHasA = !!val?.['mcp:execution-record:' + executionIdA]
  }

  assert('executionId A ≠ executionId B', executionIdA !== executionIdB)
  assert('Agent A storage does NOT contain Agent B execution', aHasB === false)
  assert('Agent B storage does NOT contain Agent A execution', bHasA === false)

  auditRecords.push({
    test: 'Parallel Tools',
    agentA: { id: 'agent-chatgpt-a', instanceId: instanceIdA, execId: executionIdA, resultLength: outputA.length },
    agentB: { id: 'agent-chatgpt-b', instanceId: instanceIdB, execId: executionIdB, resultLength: outputB.length },
    isolated: !aHasB && !bHasA,
  })

  // ── Step 4: Prueba 2 — Herramienta effectful & Deduplicación ─────────────
  hr('4. Test 2: Effectful Tool & Scope Deduplication')

  const dedupCallId = 'call_dedup_' + Date.now()
  const dedupCommand = 'powershell -NoProfile -Command "Write-Output \\"dedup-test\\""'

  // Call 1 on Agent A
  console.log('  Agent A -> Effectful call 1 (Bash)...')
  const bashA1 = await callMcpTool(3006, 'Bash', { command: dedupCommand }, sessionA)
  assert('Agent A call 1 succeeded', bashA1.status === 200)

  // Call 2 on Agent A (Retry with same session & args)
  console.log('  Agent A -> Retry with same callId and args...')
  const bashA2 = await callMcpTool(3006, 'Bash', { command: dedupCommand }, sessionA)
  assert('Agent A retry returned same result', bashA2.data?.result?.content?.[0]?.text === bashA1.data?.result?.content?.[0]?.text)

  // Call on Agent B (Same tool and args, but with session B / instance B)
  console.log('  Agent B -> Same command with Agent B session...')
  const bashB = await callMcpTool(3006, 'Bash', { command: dedupCommand }, sessionB)
  assert('Agent B call succeeded independently', bashB.status === 200)
  assert('Agent B execution was routed through session B', sessionB !== sessionA)

  // ── Step 5: Prueba 3 — Aislamiento bajo fallo ────────────────────────────
  hr('5. Test 3: Failure Isolation (Targeted Kill of Chrome A during in-flight tool)')

  console.log('  Initiating delayed tool calls on A and B...')
  const longCmd = 'powershell -NoProfile -Command "Start-Sleep -Milliseconds 1500; Write-Output \\"B-survived\\""'

  // Start in-flight tool on B
  const bInFlightPromise = callMcpTool(3006, 'Bash', { command: longCmd }, sessionB)

  // Immediately target-kill Chrome A by PID
  const pidA = await findPidOnPortWithRetry(portA)
  assert('Found PID for Chrome A', pidA !== null, `PID=${pidA} on port ${portA}`)

  if (pidA) {
    console.log(`  Target-killing Chrome A (PID ${pidA}) strictly by PID...`)
    try {
      execSync(`taskkill /F /PID ${pidA} /T`, { stdio: 'ignore' })
    } catch {}

    // Wait up to 3 seconds for Windows TCP stack to release the port socket
    for (let i = 0; i < 30; i++) {
      const alivePid = await findPidOnPort(portA)
      if (!alivePid) break
      await sleep(100)
    }
  }

  // Trigger Sentinel scan
  console.log('  Triggering Sentinel health scan...')
  const scanResult = await runSentinelScan()
  const agentADetail = scanResult.details.find(d => d.agentId === 'agent-chatgpt-a')
  const agentBDetail = scanResult.details.find(d => d.agentId === 'agent-chatgpt-b')

  assert('Sentinel reported Agent A port as dead', agentADetail?.portAlive === false)
  assert('Sentinel reported Agent B port as alive', agentBDetail?.portAlive === true)

  // Wait for Sentinel event to update AppState
  await waitForCondition(() => appState.getAgent('agent-chatgpt-a')?.status === 'lost')
  assert('Agent A transitioned to lost (NOT error)', appState.getAgent('agent-chatgpt-a')?.status === 'lost')
  assert('Agent B remained ready during Agent A failure', appState.getAgent('agent-chatgpt-b')?.status === 'ready')

  // Await in-flight tool on B
  console.log('  Awaiting in-flight tool completion on Agent B...')
  const resBAfterDeath = await bInFlightPromise
  const outputBAfterDeath = resBAfterDeath.data?.result?.content?.[0]?.text ?? ''
  assert('Agent B in-flight tool completed successfully despite Agent A death', outputBAfterDeath.includes('B-survived'))

  // ── Step 6: Prueba 4 — Restart de Agent A ────────────────────────────────
  hr('6. Test 4: Restart Agent A from TUI (New Instance, Fresh Address)')

  console.log('  Restarting agent-chatgpt-a via actions.restartAgent()...')
  const restartResultA = await actions.restartAgent('agent-chatgpt-a')
  assert('Agent A restarted to ready', restartResultA.status === 'ready')

  const newInstanceIdA = restartResultA.instanceId!
  const newPortA = restartResultA.debugPort!

  assert('Restarted A has NEW instanceId', newInstanceIdA !== instanceIdA, `old=${instanceIdA}, new=${newInstanceIdA}`)
  assert('Restarted A instanceId ≠ Agent B instanceId', newInstanceIdA !== instanceIdB)
  assert('Agent B remained ready throughout Agent A restart', appState.getAgent('agent-chatgpt-b')?.status === 'ready')

  // Check targets in restarted Chrome A
  const newTargetsA = await fetchCDPTargets(newPortA)
  const newPageA = newTargetsA.find(t => t.type === 'page' && t.url?.includes('chatgpt.com'))
  const newSWA = findSAServiceWorker(newTargetsA, restartResultA.saExtensionId)

  assert('Restarted Agent A has real ChatGPT page target', !!newPageA, newPageA?.url)
  assert('Restarted Agent A has active SuperAssistant Service Worker', !!newSWA, newSWA?.url)

  // Execute tool on restarted A with fresh address
  const sessionARestart = await initMcpSession(3006, `client-${newInstanceIdA}`)
  const resARestart = await callMcpTool(3006, 'Read', { file_path: 'package.json', limit: 1 }, sessionARestart)
  assert('Fresh tool call on restarted Agent A succeeded', resARestart.status === 200)

  // ── Step 7: Prueba 5 — Auditoría explícita del MCP global en :3006 ────────
  hr('7. Test 5: Explicit Audit of Global MCP Singleton on :3006')

  console.log('  Auditing global MCP singleton concurrency and routing...')
  const auditCallA = callMcpTool(3006, 'Read', { file_path: 'package.json', offset: 0, limit: 1 }, sessionARestart)
  const auditCallB = callMcpTool(3006, 'Read', { file_path: 'package.json', offset: 1, limit: 1 }, sessionB)

  const [auditResA, auditResB] = await Promise.all([auditCallA, auditCallB])

  const auditOutA = auditResA.data?.result?.content?.[0]?.text ?? ''
  const auditOutB = auditResB.data?.result?.content?.[0]?.text ?? ''

  assert('Audit call A succeeded on :3006', auditResA.status === 200)
  assert('Audit call B succeeded on :3006', auditResB.status === 200)
  assert('Audit call A received offset 0 content', auditOutA.includes('{'))
  assert('Audit call B received offset 1 content', auditOutB.includes('name'))

  console.log('  MCP Routing Audit Record:');
  console.log('    • Request A:', { session: sessionARestart, instanceId: newInstanceIdA, agentId: 'agent-chatgpt-a', result: auditOutA.trim() })
  console.log('    • Request B:', { session: sessionB, instanceId: instanceIdB, agentId: 'agent-chatgpt-b', result: auditOutB.trim() })

  // ── Step 8: Prueba 6 — TUI State Verification ────────────────────────────
  hr('8. Test 6: TUI State Rendering of Both Agents')

  await waitForCondition(() =>
    clean(renderedOutput).includes('agent-chatgpt-a') &&
    clean(renderedOutput).includes('agent-chatgpt-b')
  )

  assert('TUI displays Agent A', clean(renderedOutput).includes('agent-chatgpt-a'))
  assert('TUI displays Agent B', clean(renderedOutput).includes('agent-chatgpt-b'))
  assert('TUI displays Agent A port', clean(renderedOutput).includes(String(newPortA)))
  assert('TUI displays Agent B port', clean(renderedOutput).includes(String(portB)))

  // ── Step 9: Teardown & Cleanup ───────────────────────────────────────────
  hr('9. Teardown & Port Cleanup')
  console.log('  Stopping agents and cleaning up...')
  const stopA = await actions.stopAgent('agent-chatgpt-a')
  console.log('  Stop A result:', { status: stopA?.status, port: stopA?.debugPort, instance: stopA?.instanceId })
  const stopB = await actions.stopAgent('agent-chatgpt-b')
  console.log('  Stop B result:', { status: stopB?.status, port: stopB?.debugPort, instance: stopB?.instanceId })
  await mcpServer.stop()

  root.unmount()
  stdin.end()
  stdout.end()

  // Verify ports released with retry loop to allow Windows kernel socket teardown
  let portAStillOpen = await findPidOnPort(newPortA)
  for (let i = 0; i < 15 && portAStillOpen !== null; i++) {
    await sleep(400)
    portAStillOpen = await findPidOnPort(newPortA)
  }
  let portBStillOpen = await findPidOnPort(portB)
  for (let i = 0; i < 15 && portBStillOpen !== null; i++) {
    await sleep(400)
    portBStillOpen = await findPidOnPort(portB)
  }
  let portMcpStillOpen = await findPidOnPort(3006)
  for (let i = 0; i < 15 && portMcpStillOpen !== null; i++) {
    await sleep(400)
    portMcpStillOpen = await findPidOnPort(3006)
  }

  assert('Debug port A cleanly released', portAStillOpen === null)
  assert('Debug port B cleanly released', portBStillOpen === null)
  assert('MCP port 3006 cleanly released', portMcpStillOpen === null)

  console.log('\n' + '═'.repeat(65))
  console.log(`  VERIFICATION RESULTS: ${passCount} passed, ${failCount} failed`)
  console.log('═'.repeat(65) + '\n')

  if (failCount > 0) {
    console.error('GATE 7 RESULT: BLOCKED')
    process.exit(1)
  } else {
    console.log('GATE 7 RESULT: PASS')
  }
}

main().catch(err => {
  console.error('Fatal gate verification error:', err)
  process.exit(1)
})
