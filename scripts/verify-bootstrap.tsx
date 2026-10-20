/**
 * verify-bootstrap.tsx
 *
 * Verifies Gate 6 Requirements:
 * 1. Real Bootstrap flow:
 *      launchRepl()
 *          ↓
 *      orchestrationAppState.init()
 *          ↓
 *      <App> -> REPL
 * 2. Status & MCP Status rendering
 * 3. Degraded Bootstrap:
 *      Backend down / query failure -> REPL still launches cleanly
 */

import { mock } from 'bun:test'

// Stub internal unbundled modules for standalone runner
mock.module('@ant/claude-for-chrome-mcp', () => ({
  BROWSER_TOOLS: [],
  default: {},
}))

import React from 'react'
import { PassThrough } from 'node:stream'
import { launchRepl } from '../src/replLauncher.js'
import { orchestrationAppState, AppState } from '../src/services/webRelay/orchestration/AppState.js'
import { relayBus, resetRelayBus } from '../src/services/webRelay/orchestration/RelayBus.js'
import { resetRunner } from '../src/services/webRelay/orchestration/MultiAgentRunner.js'
import { resetSentinel } from '../src/services/webRelay/orchestration/Sentinel.js'
import { resetWebInstanceRegistry } from '../src/services/webRelay/WebInstanceRegistry.js'
import { WebRelayOrchestrationSection } from '../src/components/Settings/Status.js'
import { MCPStatus } from '../src/commands/mcp/mcp.js'
import { createRoot } from '../src/ink.js'
import { enableConfigs } from '../src/utils/config.js'

let passed = 0
let failed = 0

function assert(description: string, condition: boolean, detail = '') {
  if (condition) {
    passed++
    console.log(`  ✅ ${description}${detail ? ` (${detail})` : ''}`)
  } else {
    failed++
    console.log(`  ❌ FAIL: ${description}${detail ? ` (${detail})` : ''}`)
  }
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

async function waitForCondition(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await Bun.sleep(50)
  }
  throw new Error(`Timed out waiting for condition after ${timeoutMs}ms`)
}

async function main() {
  console.log('═'.repeat(60))
  console.log('  GATE 6: REAL & DEGRADED BOOTSTRAP VERIFICATION')
  console.log('═'.repeat(60) + '\n')

  enableConfigs()

  // ───────────────────────────────────────────────────────────────────────────
  // PART 1: Real Bootstrap Flow via launchRepl()
  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 1. Testing Real Bootstrap Flow ---')
  resetRunner()
  resetSentinel()
  resetRelayBus()
  resetWebInstanceRegistry()
  orchestrationAppState.destroy()

  let renderAndRunCalled = false
  let capturedElement: React.ReactNode = null

  const dummyRoot: any = {
    render: () => {},
    unmount: () => {},
    waitUntilExit: async () => {},
    clear: () => {},
  }

  const dummyAppProps: any = {
    getFpsMetrics: () => undefined,
    stats: undefined,
    initialState: {} as any,
  }

  const dummyReplProps: any = {}

  const mockRenderAndRun = async (root: any, element: React.ReactNode) => {
    renderAndRunCalled = true
    capturedElement = element
  }

  // Execute real launchRepl()
  await launchRepl(dummyRoot, dummyAppProps, dummyReplProps, mockRenderAndRun)

  assert('launchRepl completed without exception', true)
  assert('renderAndRun was invoked by launchRepl', renderAndRunCalled === true)
  assert('orchestrationAppState was hydrated during bootstrap', orchestrationAppState.getState().lastHydratedAt !== null)
  assert('Captured React element contains App and REPL', capturedElement !== null && React.isValidElement(capturedElement))
  assert(
    'Startup bootstrap leaves saved Web Relay agents stopped until the user launches them',
    Object.keys(orchestrationAppState.getState().agents).length === 0,
  )

  // ───────────────────────────────────────────────────────────────────────────
  // PART 2: Status & MCPStatus Rendering with Hydrated State
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n--- 2. Testing /status and /mcp status Rendering ---')

  const { stdout, stdin } = createTestStreams()
  let renderedOutput = ''
  stdout.on('data', chunk => {
    renderedOutput += chunk.toString()
  })

  const inkRoot = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  // Render WebRelayOrchestrationSection (/status component)
  inkRoot.render(<WebRelayOrchestrationSection customAppState={orchestrationAppState} />)
  await waitForCondition(() => clean(renderedOutput).includes('Web Relay Orchestration'))

  assert('/status component rendered successfully', clean(renderedOutput).includes('Web Relay Orchestration'))
  assert('/status displays system health', clean(renderedOutput).includes('System Health:'))
  assert('/status displays sentinel status', clean(renderedOutput).includes('Sentinel:'))
  assert('/status displays agent count', clean(renderedOutput).includes('Agents'))

  // Render MCPStatus (/mcp status component)
  let mcpOutput = ''
  inkRoot.render(
    <MCPStatus
      customAppState={orchestrationAppState}
      onComplete={(msg: string) => {
        mcpOutput = msg
      }}
    />
  )
  await waitForCondition(() => mcpOutput.length > 0)

  assert('/mcp status component rendered successfully', mcpOutput.includes('Web Relay Orchestration:'))
  assert('/mcp status includes Sentinel block', mcpOutput.includes('Sentinel:'))

  inkRoot.unmount()
  stdin.end()
  stdout.end()

  // ───────────────────────────────────────────────────────────────────────────
  // PART 3: Degraded Bootstrap (MCP down / Query failure / Degraded State)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n--- 3. Testing Degraded Bootstrap Scenarios ---')

  // Scenario A: Backend queries fail during hydrate (e.g. MCP down)
  const degradedBus: any = {
    subscribe: () => () => {},
    emit: () => {},
    send: async () => {},
    query: async (q: any) => {
      if (q.name === 'system:health') {
        return {
          status: 'degraded',
          mcpServerReachable: false,
          activeAgentsCount: 0,
          lostAgentsCount: 0,
          errorAgentsCount: 0,
        }
      }
      if (q.name === 'agent:list') return []
      if (q.name === 'sentinel:status') {
        return { agentsChecked: 0, issuesFound: 1, details: [] }
      }
      throw new Error('MCP server at :3006 unreachable')
    },
  }

  const degradedAppState = new AppState({ bus: degradedBus, autoInit: false })
  await degradedAppState.init()

  assert('Degraded AppState init() succeeds without throwing', degradedAppState.getState().lastHydratedAt !== null)
  assert('Degraded AppState reflects degraded system health', degradedAppState.getState().systemHealth?.status === 'degraded')
  assert('Degraded AppState shows MCP unreachable', degradedAppState.getState().systemHealth?.mcpServerReachable === false)

  // Test that TUI renders the degraded state cleanly
  const degradedStreams = createTestStreams()
  let degradedRendered = ''
  degradedStreams.stdout.on('data', chunk => {
    degradedRendered += chunk.toString()
  })

  const degradedRoot = await createRoot({
    stdout: degradedStreams.stdout as unknown as NodeJS.WriteStream,
    stdin: degradedStreams.stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  degradedRoot.render(<WebRelayOrchestrationSection customAppState={degradedAppState} />)
  await waitForCondition(() => clean(degradedRendered).includes('Web Relay Orchestration'))

  assert('TUI renders cleanly in degraded state', clean(degradedRendered).includes('degraded'))

  degradedRoot.unmount()
  degradedStreams.stdin.end()
  degradedStreams.stdout.end()

  // Scenario B: Fatal crash inside orchestration init() in launchRepl
  console.log('\n--- 4. Testing launchRepl Resilience Against Catastrophic Orchestration Failure ---')
  let resilientRenderCalled = false
  const catastrophicRenderAndRun = async () => {
    resilientRenderCalled = true
  }

  // Force orchestrationAppState.init to reject violently
  const originalInit = orchestrationAppState.init
  orchestrationAppState.init = async () => {
    throw new Error('Fatal socket failure / bus corruption')
  }

  let launchReplException: any = null
  try {
    await launchRepl(dummyRoot, dummyAppProps, dummyReplProps, catastrophicRenderAndRun)
  } catch (e) {
    launchReplException = e
  } finally {
    orchestrationAppState.init = originalInit
  }

  assert('launchRepl never throws even when orchestration fails', launchReplException === null)
  assert('REPL still launches (renderAndRun called) during catastrophic backend failure', resilientRenderCalled === true)

  resetSentinel()
  console.log('\n' + '═'.repeat(60))
  console.log(`  BOOTSTRAP VERIFICATION RESULT: ${passed} passed, ${failed} failed`)
  console.log('═'.repeat(60) + '\n')

  if (failed > 0) {
    process.exit(1)
  }
}

main().catch(err => {
  resetSentinel()
  console.error('Fatal bootstrap test error:', err)
  process.exit(1)
})
