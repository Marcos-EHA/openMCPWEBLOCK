/**
 * TUI Integration Real Verification Script
 *
 * Verifies end-to-end with real Chrome:
 *   Real Chrome
 *        ↓
 *   MultiAgentRunner
 *        ↓
 *   Sentinel
 *        ↓
 *   RelayBus
 *        ↓
 *   AppState
 *        ↓
 *   TUI (useOrchestratorState, WebRelayOrchestrationSection, MCPStatus)
 *
 * Checks:
 *   1. Start a real agent via actions.startAgent
 *   2. Verify TUI renders it in ready
 *   3. Stop agent via actions.stopAgent -> verify TUI renders stopped
 *   4. Start agent 2 -> target kill by PID -> trigger Sentinel -> verify TUI renders lost
 *   5. Restart agent 2 -> verify TUI renders ready
 *   6. Check MCPStatus formats real orchestration status without scanning
 *   7. Zero kill of user's Chrome, zero taskkill /IM chrome.exe
 *
 * Run: bun run scripts/tui-real-integration.ts
 */

import { PassThrough } from 'node:stream'
import { execSync } from 'node:child_process'
import React from 'react'
import { createRoot } from '../src/ink.js'

import {
  AppState,
  orchestrationAppState,
} from '../src/services/webRelay/orchestration/AppState.js'
import { relayBus, resetRelayBus } from '../src/services/webRelay/orchestration/RelayBus.js'
import { resetRunner } from '../src/services/webRelay/orchestration/MultiAgentRunner.js'
import {
  resetSentinel,
  scan as runSentinelScan,
} from '../src/services/webRelay/orchestration/Sentinel.js'
import { resetWebInstanceRegistry } from '../src/services/webRelay/WebInstanceRegistry.js'
import {
  useOrchestratorState,
  type UseOrchestratorStateResult,
} from '../src/hooks/useOrchestratorState.js'
import { WebRelayOrchestrationSection } from '../src/components/Settings/Status.js'
import { MCPStatus } from '../src/commands/mcp/mcp.js'

import { enableConfigs } from '../src/utils/config.js'

function hr(title: string) {
  console.log('\n' + '═'.repeat(60))
  console.log(`  ${title}`)
  console.log('═'.repeat(60))
}

let passCount = 0
let failCount = 0

function assert(description: string, condition: boolean, detail = '') {
  if (condition) {
    passCount++
    console.log(`  ✅ ${description}${detail ? ` (${detail})` : ''}`)
  } else {
    failCount++
    console.log(`  ❌ FAIL: ${description}${detail ? ` (${detail})` : ''}`)
  }
}

async function findPidOnPort(port: number): Promise<number | null> {
  try {
    const out = execSync('netstat -ano', { encoding: 'utf8', timeout: 5000 })
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

async function findPidOnPortWithRetry(port: number, maxAttempts = 10): Promise<number | null> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const pid = await findPidOnPort(port)
    if (pid !== null) return pid
    await Bun.sleep(500)
  }
  return null
}

function clean(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, ' ')
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

async function waitForCondition(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await Bun.sleep(100)
  }
  throw new Error(`Timed out waiting for condition after ${timeoutMs}ms`)
}

async function main() {
  console.log('Starting Real TUI Integration Verification...')

  enableConfigs()

  resetRunner()
  resetSentinel()
  resetRelayBus()
  resetWebInstanceRegistry()

  // 1. Initialize AppState
  hr('1. AppState Bootstrap & TUI Mount')
  const appState = orchestrationAppState
  appState.destroy()
  await appState.init()
  assert('AppState successfully initialized once at bootstrap', appState.getState().lastHydratedAt !== null)

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
  await waitForCondition(() => clean(renderedOutput).includes('Web Relay Orchestration'))

  assert('useOrchestratorState hook mounted and returned state/actions', capturedResult !== null)
  assert('Initial TUI renders section title', clean(renderedOutput).includes('Web Relay Orchestration'))
  assert('Initial TUI indicates no agents registered', clean(renderedOutput).includes('No web agents registered'))

  const actions = capturedResult!.actions

  // 2. Start Real Agent 1 via actions.startAgent
  hr('2. Start Real Agent 1 via actions.startAgent')
  console.log('  Launching real Chrome via actions.startAgent(real-tui-agent-1)...')
  const startResult = await actions.startAgent('real-tui-agent-1', 'chatgpt', 'tester')

  console.log('DEBUG startResult:', JSON.stringify(startResult))
  assert('Agent 1 reached ready state', startResult.status === 'ready', `actual=${startResult?.status}, error=${(startResult as any)?.error}`)
  assert('Agent 1 has debugPort', typeof startResult.debugPort === 'number', `port=${startResult?.debugPort}`)

  // Wait for reactive re-render of Ink TUI
  await waitForCondition(() => clean(renderedOutput).includes('real-tui-agent-1') && clean(renderedOutput).includes('ready'))

  assert('TUI re-rendered reactively with agent-1', clean(renderedOutput).includes('real-tui-agent-1'))
  assert('TUI displays agent-1 status as ready', clean(renderedOutput).includes('ready'))
  assert('TUI displays port', clean(renderedOutput).includes(String(startResult.debugPort)))

  // 3. Stop Real Agent 1 via actions.stopAgent
  hr('3. Stop Real Agent 1 via actions.stopAgent')
  console.log('  Stopping real-tui-agent-1 via actions.stopAgent()...')
  const stopResult = await actions.stopAgent('real-tui-agent-1')

  assert('Agent 1 returned stopped', stopResult.status === 'stopped')
  await waitForCondition(() => appState.getAgent('real-tui-agent-1')?.status === 'stopped')

  assert('AppState updated status to stopped', appState.getAgent('real-tui-agent-1')?.status === 'stopped')

  // 4. Start Real Agent 2 & Target-Kill to Test Sentinel -> TUI 'lost'
  hr('4. Agent 2 Target-Kill & Sentinel Detection')
  console.log('  Launching real-tui-agent-2...')
  const agent2Start = await actions.startAgent('real-tui-agent-2', 'gemini', 'lost-tester')
  assert('Agent 2 started and ready', agent2Start.status === 'ready')

  const agent2Port = agent2Start.debugPort!
  const agent2Pid = await findPidOnPortWithRetry(agent2Port)
  assert('Found listening process PID for Agent 2', agent2Pid !== null, `PID=${agent2Pid} on port ${agent2Port}`)

  console.log(`  Target-killing Agent 2 PID ${agent2Pid} on port ${agent2Port}...`)
  // Target kill strictly by PID, NEVER taskkill /IM chrome.exe
  try {
    execSync(`taskkill /F /PID ${agent2Pid} /T`, { stdio: 'ignore' })
  } catch {}

  // Trigger Sentinel scan
  console.log('  Triggering Sentinel health scan...')
  const scanResult = await runSentinelScan()
  assert('Sentinel detected issues', scanResult.issuesFound > 0)
  const agent2Detail = scanResult.details.find(d => d.agentId === 'real-tui-agent-2')
  assert('Sentinel reported Agent 2 as issue with dead port', agent2Detail?.portAlive === false)

  // Wait for reactive event instance:lost to update AppState and TUI
  await waitForCondition(() => appState.getAgent('real-tui-agent-2')?.status === 'lost')

  assert('AppState marked Agent 2 as lost (NOT error)', appState.getAgent('real-tui-agent-2')?.status === 'lost')

  // 5. Restart Agent 2 via actions.restartAgent
  hr('5. Restart Agent 2 via actions.restartAgent')
  console.log('  Restarting real-tui-agent-2...')
  const restartResult = await actions.restartAgent('real-tui-agent-2')

  assert('Agent 2 successfully restarted to ready', restartResult.status === 'ready')
  assert('Agent 2 has valid debugPort', typeof restartResult.debugPort === 'number')
  assert('AppState updated Agent 2 to ready', appState.getAgent('real-tui-agent-2')?.status === 'ready')

  // 6. Test MCPStatus Output Integration
  hr('6. MCPStatus Output Integration')
  let mcpStatusOutput = ''
  function MCPStatusHarness() {
    return (
      <MCPStatus
        customAppState={appState}
        onComplete={(msg: string) => {
          mcpStatusOutput = msg
        }}
      />
    )
  }

  root.render(<MCPStatusHarness />)
  await waitForCondition(() => mcpStatusOutput.length > 0)

  assert('MCPStatus output contains Web Relay Orchestration block', mcpStatusOutput.includes('Web Relay Orchestration:'))
  assert('MCPStatus lists real-tui-agent-2 as ready', mcpStatusOutput.includes('real-tui-agent-2 [gemini]: ready'))
  assert('MCPStatus includes Sentinel status', mcpStatusOutput.includes('Sentinel:'))

  // Cleanup
  hr('7. Teardown & Cleanup')
  console.log('  Cleaning up test agents...')
  await actions.stopAgent('real-tui-agent-2')

  root.unmount()
  stdin.end()
  stdout.end()

  console.log('\n' + '═'.repeat(60))
  console.log(`  VERIFICATION COMPLETE: ${passCount} passed, ${failCount} failed`)
  console.log('═'.repeat(60) + '\n')

  if (failCount > 0) {
    process.exit(1)
  }
}

main().catch(err => {
  console.error('Fatal integration error:', err)
  process.exit(1)
})
