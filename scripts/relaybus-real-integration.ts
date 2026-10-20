#!/usr/bin/env bun
/**
 * Real Integration Test for RelayBus (End-to-End Gate Verification)
 *
 * Covers:
 *   1. Full RelayBus lifecycle: send(agent:start) -> real Chrome -> ready -> events received
 *   2. Real agent:status and agent:list queries returning verified instance data
 *   3. Controlled stop: send(agent:stop) -> process cleanup -> agent:stopped event
 *   4. Sentinel integration: kill real Chrome via PID -> Sentinel detects loss -> instance:lost crosses RelayBus
 *   5. Pure side-effect-free queries: multiple sentinel:status calls produce zero events and zero state changes
 *   6. Concurrency serialization: start then stop concurrently without race
 *   7. Error preservation: intentional failure preserves exact underlying diagnostic
 *
 * Run: bun run scripts/relaybus-real-integration.ts
 */

import { execSync } from 'child_process'
import {
  RelayBus,
  send,
  query,
  subscribe,
  resetRelayBus,
} from '../src/services/webRelay/orchestration/RelayBus.js'
import {
  resetRunner,
  listAgents,
  getAgentStatus,
} from '../src/services/webRelay/orchestration/MultiAgentRunner.js'
import {
  resetSentinel,
  scan as runSentinelScan,
  getLastScanResult,
  registerSAExtensionId,
} from '../src/services/webRelay/orchestration/Sentinel.js'
import { resetWebInstanceRegistry } from '../src/services/webRelay/WebInstanceRegistry.js'
import type { OrchestratorEvent } from '../src/services/webRelay/orchestration/types.js'

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

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
    await sleep(500)
  }
  return null
}

async function killChromePid(pid: number) {
  try {
    const taskInfo = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
      encoding: 'utf8',
      timeout: 5000,
    })
    if (!taskInfo.toLowerCase().includes('chrome.exe')) {
      console.log(`  PID ${pid} is not chrome.exe, skipping kill`)
      return
    }
    execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore', timeout: 10000 })
  } catch {}
}

async function main() {
  console.log('Starting RelayBus Real Integration Gate Verification...')

  resetRunner()
  resetSentinel()
  resetRelayBus()
  resetWebInstanceRegistry()

  // ══════════════════════════════════════════════════════════════════
  // SCENARIO 1: Real Agent Lifecycle & Event Propagation via RelayBus
  // ══════════════════════════════════════════════════════════════════
  hr('SCENARIO 1: Start Agent -> Real Chrome -> Event Delivery -> Status Query')

  const receivedEvents: OrchestratorEvent[] = []
  const unsub = subscribe(e => {
    receivedEvents.push(e)
    console.log(`    [RelayBus Event] ${e.name} ${e.name === 'agent:lifecycle' ? '-> ' + (e.payload as any).to : ''}`)
  })

  console.log('  Dispatching agent:start via RelayBus.send()...')
  const startResult = await send({
    type: 'command',
    name: 'agent:start',
    payload: { agentId: 'real-bus-agent-1', platformId: 'chatgpt' },
  })

  assert('agent:start returned state', !!startResult)
  assert('Agent reached ready state', startResult.status === 'ready', `status=${startResult.status}`)
  assert('Debug port was allocated', typeof startResult.debugPort === 'number', `port=${startResult.debugPort}`)
  assert('InstanceId was assigned', typeof startResult.instanceId === 'string', `instanceId=${startResult.instanceId}`)

  // Verify real Chrome process is listening on the assigned debug port
  const allocatedPort = startResult.debugPort!
  const chromePid = await findPidOnPortWithRetry(allocatedPort)
  assert('Real Chrome process found listening on debug port', chromePid !== null, `PID=${chromePid} on port ${allocatedPort}`)

  // Verify events arrived through RelayBus
  const eventNames = receivedEvents.map(e => e.name)
  assert('agent:created event received via RelayBus', eventNames.includes('agent:created'))
  assert('instance:bound event received via RelayBus', eventNames.includes('instance:bound'))

  const lifecycleEvents = receivedEvents
    .filter(e => e.name === 'agent:lifecycle')
    .map(e => (e.payload as any).to)

  assert('Lifecycle progressed through chrome_ready', lifecycleEvents.includes('chrome_ready'))
  assert('Lifecycle progressed through extension_loading', lifecycleEvents.includes('extension_loading'))
  assert('Lifecycle progressed through ready', lifecycleEvents.includes('ready'))

  // Verify Query: agent:status
  const statusQuery = await query({
    type: 'query',
    name: 'agent:status',
    payload: { agentId: 'real-bus-agent-1' },
  })

  assert('agent:status query returned real state', statusQuery !== null)
  assert('agent:status matches start state', statusQuery?.status === 'ready')
  assert('agent:status matches debugPort', statusQuery?.debugPort === allocatedPort)

  // Verify Query: agent:list
  const listQuery = await query({
    type: 'query',
    name: 'agent:list',
  })
  assert('agent:list query contains agent', listQuery.some(a => a.agentId === 'real-bus-agent-1'))

  // ══════════════════════════════════════════════════════════════════
  // SCENARIO 2: Pure Read-Only Query (sentinel:status) - Zero Side Effects
  // ══════════════════════════════════════════════════════════════════
  hr('SCENARIO 2: Query sentinel:status (Side-Effect-Free Invariant)')

  const eventCountBefore = receivedEvents.length

  const sStatus1 = await query({
    type: 'query',
    name: 'sentinel:status',
  })
  const sStatus2 = await query({
    type: 'query',
    name: 'sentinel:status',
  })
  const sStatus3 = await query({
    type: 'query',
    name: 'sentinel:status',
  })

  assert('sentinel:status query is non-null', sStatus1 !== null)
  assert('Consecutive sentinel:status queries return identical result', JSON.stringify(sStatus1) === JSON.stringify(sStatus2))
  assert('Zero events emitted by sentinel:status query calls', receivedEvents.length === eventCountBefore, `delta=${receivedEvents.length - eventCountBefore}`)

  // ══════════════════════════════════════════════════════════════════
  // SCENARIO 3: Sentinel Loss Detection via RelayBus
  // ══════════════════════════════════════════════════════════════════
  hr('SCENARIO 3: Kill Chrome Process -> Sentinel Scan -> instance:lost via RelayBus')

  if (chromePid) {
    console.log(`  Terminating target Chrome PID ${chromePid} on port ${allocatedPort}...`)
    await killChromePid(chromePid)
    await sleep(2000)

    // Run Sentinel scan to inspect reality
    console.log('  Running Sentinel scan...')
    await runSentinelScan()

    // Check if instance:lost reached RelayBus subscribers
    const lostEvent = receivedEvents.find(e => e.name === 'instance:lost')
    assert('instance:lost event emitted and received via RelayBus', lostEvent !== null && lostEvent !== undefined)
    assert('instance:lost references correct agentId', (lostEvent?.payload as any)?.agentId === 'real-bus-agent-1')

    // Query agent:status
    const statusPostKill = await query({
      type: 'query',
      name: 'agent:status',
      payload: { agentId: 'real-bus-agent-1' },
    })
    console.log(`  Post-kill agent status: ${statusPostKill?.status}`)
    assert('agent:status reflects lost state after Sentinel detection', statusPostKill?.status === 'lost', `status=${statusPostKill?.status}`)
  }

  // ══════════════════════════════════════════════════════════════════
  // SCENARIO 4: Controlled Stop via RelayBus
  // ══════════════════════════════════════════════════════════════════
  hr('SCENARIO 4: Stop Agent via RelayBus.send(agent:stop)')

  const stopResult = await send({
    type: 'command',
    name: 'agent:stop',
    payload: { agentId: 'real-bus-agent-1' },
  })

  assert('agent:stop returned stopped status', stopResult.status === 'stopped')
  assert('agent:stopped event received via RelayBus', receivedEvents.some(e => e.name === 'agent:stopped'))

  // ══════════════════════════════════════════════════════════════════
  // SCENARIO 5: Concurrency and Serialization Preservation
  // ══════════════════════════════════════════════════════════════════
  hr('SCENARIO 5: RelayBus Concurrency - Agent Mutex Serialization')

  // Calling start then immediate stop concurrently on same agent
  console.log('  Dispatching concurrent start and stop on agent-concurrent...')
  const pStart = send({
    type: 'command',
    name: 'agent:start',
    payload: { agentId: 'agent-concurrent', platformId: 'chatgpt' },
  })
  const pStop = send({
    type: 'command',
    name: 'agent:stop',
    payload: { agentId: 'agent-concurrent' },
  })

  const [resStart, resStop] = await Promise.all([pStart, pStop])
  assert('First operation in chain reached ready', resStart.status === 'ready')
  assert('Second serialized operation reached stopped', resStop.status === 'stopped')

  const finalConcurrentStatus = await query({
    type: 'query',
    name: 'agent:status',
    payload: { agentId: 'agent-concurrent' },
  })
  assert('Final state is stopped without race corruption', finalConcurrentStatus?.status === 'stopped')

  // ══════════════════════════════════════════════════════════════════
  // SCENARIO 6: Error Detail Fidelity
  // ══════════════════════════════════════════════════════════════════
  hr('SCENARIO 6: Error Detail Preservation (No Generic Wrapping)')

  // Attempting to remove an agent while it is running must throw the exact error
  // First start a fresh agent
  await send({
    type: 'command',
    name: 'agent:start',
    payload: { agentId: 'agent-err-test', platformId: 'chatgpt' },
  })

  let caughtErrorMsg = ''
  try {
    await send({
      type: 'command',
      name: 'agent:remove',
      payload: { agentId: 'agent-err-test' },
    })
  } catch (err: any) {
    caughtErrorMsg = err.message
  }

  assert(
    'Exact MultiAgentRunner error preserved without RelayBus wrapper',
    caughtErrorMsg.includes('Cannot remove agent agent-err-test in status ready. Stop it first.'),
    `caught: "${caughtErrorMsg}"`
  )

  // Clean up err test agent
  await send({
    type: 'command',
    name: 'agent:stop',
    payload: { agentId: 'agent-err-test' },
  })

  // Clean up subscriber
  unsub()

  // ══════════════════════════════════════════════════════════════════
  // SUMMARY
  // ══════════════════════════════════════════════════════════════════
  hr(`RESULTS: ${passCount} PASS / ${failCount} FAIL`)

  if (failCount > 0) {
    console.error(`\n❌ RelayBus Gate Integration Verification FAILED with ${failCount} errors.`)
    process.exit(1)
  } else {
    console.log('\n🎉 ALL REAL INTEGRATION CHECKS PASSED FOR RELAYBUS!')
    process.exit(0)
  }
}

main().catch(err => {
  console.error('\nFATAL ERROR in real integration test:', err)
  process.exit(1)
})
