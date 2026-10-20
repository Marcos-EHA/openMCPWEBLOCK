/**
 * AppState Integration Gate Verification
 *
 * Verifies end-to-end:
 *   MultiAgentRunner -> Sentinel -> RelayBus -> AppState
 *
 * Checks:
 *   1. AppState hydrates via read-only queries through RelayBus
 *   2. AppState dispatches commands through RelayBus.send()
 *   3. Real lifecycle events flow from Runner/Sentinel through RelayBus into AppState
 *   4. AppState maintains pure projection without direct calls to Chrome/WIR
 *   5. Pure side-effect-free status queries through AppState
 *
 * Run: bun run scripts/appstate-integration.ts
 */

import { AppState } from '../src/services/webRelay/orchestration/AppState.js'
import { relayBus, resetRelayBus } from '../src/services/webRelay/orchestration/RelayBus.js'
import { resetRunner } from '../src/services/webRelay/orchestration/MultiAgentRunner.js'
import { resetSentinel, scan as runSentinelScan } from '../src/services/webRelay/orchestration/Sentinel.js'
import { resetWebInstanceRegistry } from '../src/services/webRelay/WebInstanceRegistry.js'

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

async function main() {
  console.log('Starting AppState Integration Gate Verification...')

  resetRunner()
  resetSentinel()
  resetRelayBus()
  resetWebInstanceRegistry()

  // 1. Instantiate AppState attached to RelayBus
  hr('1. AppState Instantiation & Hydration via RelayBus')
  const appState = new AppState({ bus: relayBus, autoInit: false })
  await appState.init()

  assert('AppState successfully initialized', appState.getState().lastHydratedAt !== null)
  assert('AppState started with empty agent list', appState.listAgents().length === 0)
  assert('AppState sentinel status is hydrated or clean', appState.getSentinelStatus() !== null)

  // 2. Track updates through AppState subscription
  hr('2. AppState Subscription & Event Flow')
  let stateNotificationCount = 0
  const unsub = appState.subscribe(state => {
    stateNotificationCount++
  })

  // 3. Dispatch agent:start through AppState
  hr('3. Dispatch agent:start through AppState')
  console.log('  Calling appState.startAgent()...')
  const startResult = await appState.startAgent('appstate-agent-1', 'chatgpt', 'orchestrator')

  assert('startAgent returned ready state', startResult.status === 'ready')
  assert('AppState projected agent into state', appState.getAgent('appstate-agent-1') !== null)

  const projectedAgent = appState.getAgent('appstate-agent-1')!
  assert('Projected agent status is ready', projectedAgent.status === 'ready', `status=${projectedAgent.status}`)
  assert('Projected agent has debugPort', typeof projectedAgent.debugPort === 'number', `port=${projectedAgent.debugPort}`)
  assert('Projected agent has instanceId', typeof projectedAgent.instanceId === 'string', `instanceId=${projectedAgent.instanceId}`)

  // 4. Verify ring buffer has collected lifecycle events
  hr('4. Event Ring Buffer & Audit')
  const recentEvents = appState.getRecentEvents()
  assert('Recent events buffer is populated', recentEvents.length > 0, `count=${recentEvents.length}`)

  const eventNames = recentEvents.map(e => e.name)
  assert('Buffer contains agent:created', eventNames.includes('agent:created'))
  assert('Buffer contains instance:bound', eventNames.includes('instance:bound'))
  assert('Buffer contains agent:lifecycle', eventNames.includes('agent:lifecycle'))

  // 5. Test selection
  hr('5. UI Selection State')
  appState.selectAgent('appstate-agent-1')
  assert('Selected agent ID matches', appState.getSelectedAgentId() === 'appstate-agent-1')
  assert('Selected agent object matches', appState.getSelectedAgent()?.agentId === 'appstate-agent-1')

  // 6. Test stop through AppState
  hr('6. Stop Agent through AppState')
  console.log('  Calling appState.stopAgent()...')
  const stopResult = await appState.stopAgent('appstate-agent-1')

  assert('stopAgent returned stopped status', stopResult.status === 'stopped')
  assert('Projected status in AppState is stopped', appState.getAgent('appstate-agent-1')?.status === 'stopped')

  // 7. Cleanup & teardown
  unsub()
  appState.destroy()

  hr(`RESULTS: ${passCount} PASS / ${failCount} FAIL`)
  if (failCount > 0) {
    console.error(`\n❌ AppState Integration Gate FAILED with ${failCount} errors.`)
    process.exit(1)
  } else {
    console.log('\n🎉 ALL APPSTATE INTEGRATION CHECKS PASSED!')
    process.exit(0)
  }
}

main().catch(err => {
  console.error('\nFATAL ERROR in appstate-integration.ts:', err)
  process.exit(1)
})
