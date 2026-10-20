/**
 * scripts/test-real-chatgpt-single.ts
 *
 * Test 1: Single Real ChatGPT Agent + Real SuperAssistant + Real MCP
 *
 * Observes the complete chain:
 * prompt -> ChatGPT -> function call -> SA -> MCP -> Read -> resultado -> ChatGPT
 */

import { WebSocket } from 'ws'
import { MCPSSEServer } from '../src/services/mcpServer/MCPSSEServer.js'
import {
  createAgent,
  startAgent,
  stopAgent,
  resetRunner,
} from '../src/services/webRelay/orchestration/MultiAgentRunner.js'
import { resetWebInstanceRegistry, reclaimStalePortLocks } from '../src/services/webRelay/WebInstanceRegistry.js'
import { resetSentinel } from '../src/services/webRelay/orchestration/Sentinel.js'
import { resetRelayBus } from '../src/services/webRelay/orchestration/RelayBus.js'
import { ADAPTERS } from '../src/services/webRelay/PlatformAdapters.js'
import { formatSuperAssistantPrompt } from '../src/services/webRelay/WebToolBridge.js'
import { enableConfigs } from '../src/utils/config.js'

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function fetchCDPTargets(port: number): Promise<any[]> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(5000) })
    return (await res.json()) as any[]
  } catch {
    return []
  }
}

async function evaluateInTarget(wsUrl: string, expression: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`Evaluate timeout for expression: ${expression.slice(0, 50)}`))
    }, 15000)

    let reqId = 1
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
            const val = msg.result?.result?.value !== undefined
              ? msg.result.result.value
              : (msg.result?.value !== undefined ? msg.result.value : msg.result?.result)
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

async function main() {
  console.log('═'.repeat(65))
  console.log('  EXPERIMENT 1: SINGLE REAL CHATGPT AGENT E2E EXECUTION')
  console.log('═'.repeat(65))

  enableConfigs()
  reclaimStalePortLocks()
  resetRunner()
  resetSentinel()
  resetRelayBus()
  resetWebInstanceRegistry()

  // 1. Start Global MCPSSEServer on port 3006
  console.log('\n1. Starting MCPSSEServer on port 3006...')
  const mcpServer = new MCPSSEServer({ port: 3006 })
  await mcpServer.start()
  console.log(`   MCP server running: ${mcpServer.getStatus().running}, tools: ${mcpServer.getStatus().tools}`)

  // 2. Launch single agent via MultiAgentRunner
  console.log('\n2. Launching real Chrome agent (agent-chatgpt-single)...')
  createAgent({ agentId: 'agent-chatgpt-single', platformId: 'chatgpt', role: 'assistant' })
  const agentState = await startAgent('agent-chatgpt-single')
  console.log(`   Agent status: ${agentState.status}, port: ${agentState.debugPort}, instanceId: ${agentState.instanceId}`)

  if (agentState.status !== 'ready' || !agentState.debugPort) {
    console.error('❌ Failed to reach ready state. Aborting.')
    await mcpServer.stop()
    process.exit(1)
  }

  const port = agentState.debugPort
  const targets = await fetchCDPTargets(port)
  console.log(`   CDP Targets discovered: ${targets.length}`)

  const pageTarget = targets.find(t => t.type === 'page' && t.url?.includes('chatgpt.com'))
  const swTarget = targets.find(t => t.type === 'service_worker' && (t.url?.includes('background.js') || t.title?.includes('SuperAssistant')))

  console.log(`   Page target: ${pageTarget ? pageTarget.title + ' (' + pageTarget.url + ')' : 'NOT FOUND'}`)
  console.log(`   SW target: ${swTarget ? swTarget.url : 'NOT FOUND'}`)

  if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
    console.error('❌ ChatGPT page target not found or missing WebSocket URL.')
    await stopAgent('agent-chatgpt-single')
    await mcpServer.stop()
    process.exit(1)
  }

  // 3. Configure SuperAssistant in Chrome storage if SW target is available
  if (swTarget?.webSocketDebuggerUrl) {
    console.log('\n3. Ensuring SuperAssistant configuration in Service Worker...')
    await evaluateInTarget(
      swTarget.webSocketDebuggerUrl,
      `new Promise(r => chrome.storage.local.set({
        mcpServerUrl: 'http://localhost:3006/mcp',
        mcpConnectionType: 'streamable-http',
        pushContentMode: true,
        enableToolExecution: true,
        autoConnect: true,
        autoExecute: true,
        autoInsert: true,
        autoSubmit: true
      }, () => r('configured')))`
    )
    console.log('   SuperAssistant storage configured for auto-execute and :3006.')
  }

  // 4. Wait for ChatGPT page DOM to be interactive
  console.log('\n4. Checking ChatGPT DOM readiness...')
  const pageWs = pageTarget.webSocketDebuggerUrl

  let domReady = false
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const readyState = await evaluateInTarget(pageWs, 'document.readyState')
      const hasInput = await evaluateInTarget(
        pageWs,
        `Boolean(document.querySelector('#prompt-textarea, textarea, [contenteditable="true"]'))`
      )
      console.log(`   Attempt ${attempt + 1}: readyState=${readyState}, hasInput=${hasInput}`)
      if (hasInput) {
        domReady = true
        break
      }
    } catch (e: any) {
      console.log(`   Attempt ${attempt + 1} evaluate failed: ${e.message}`)
    }
    await sleep(2000)
  }

  if (!domReady) {
    console.error('❌ ChatGPT input box not found in DOM after 60s.')
    await stopAgent('agent-chatgpt-single')
    await mcpServer.stop()
    process.exit(1)
  }

  // 5. Build prompt with SuperAssistant instructions using SuperAssistant's canonical generator
  console.log('\n5. Preparing prompt with SuperAssistant instructions...')
  const { generateInstructionsJson } = await import(
    '../chrome-extension/source/pages/content/src/components/sidebar/Instructions/instructionGeneratorJson.js'
  )
  const tools = [
    {
      name: 'Read',
      description: 'Read file contents from the workspace',
      schema: JSON.stringify({
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to file' },
          limit: { type: 'number', description: 'Max lines to read' },
        },
        required: ['file_path'],
      }),
    },
  ]

  const instructions = generateInstructionsJson(tools)
  const promptWithInstructions = `${instructions}\n\nUser: Lee las primeras 2 líneas de package.json ejecutando la función Read.`
  console.log(`   Prompt formatted with canonical SuperAssistant instructions (length: ${promptWithInstructions.length} chars).`)

  // 6. Insert prompt into ChatGPT and click send
  console.log('\n6. Inserting prompt into ChatGPT DOM...')
  const adapter = ADAPTERS.chatgpt

  const escapedPrompt = JSON.stringify(promptWithInstructions)
  const insertCode = adapter.insertText.replace('__PROMPT__', escapedPrompt)
  const insertResult = await evaluateInTarget(pageWs, insertCode)
  console.log(`   Insert result: ${insertResult}`)

  await sleep(1000)

  console.log('   Clicking send button...')
  const submitResult = await evaluateInTarget(pageWs, adapter.submitForm)
  console.log(`   Submit result: ${submitResult}`)

  // 7. Monitor ChatGPT generation and SuperAssistant tool execution
  console.log('\n7. Monitoring ChatGPT response stream & tool execution...')
  const startTime = Date.now()
  let detectedFunctionCall = false
  let toolExecuted = false
  let realExecutionId: string | null = null

  for (let poll = 0; poll < 60; poll++) {
    await sleep(2000)
    const elapsed = Math.round((Date.now() - startTime) / 1000)

    try {
      const isGen = await evaluateInTarget(pageWs, adapter.isGenerating)
      const currentResp = (await evaluateInTarget(pageWs, adapter.extractResponse)) || ''
      const hasFunctionBlock = await evaluateInTarget(
        pageWs,
        `Boolean(document.querySelector('.function-block, [data-block-id]'))`
      )

      // Check claims / execution in page window
      const executionClaims = await evaluateInTarget(
        pageWs,
        `(() => {
          try {
            return window.sessionStorage ? Object.keys(window.sessionStorage) : [];
          } catch { return []; }
        })()`
      )

      // Check storage in SW
      let swClaims: any = null
      if (swTarget?.webSocketDebuggerUrl) {
        swClaims = await evaluateInTarget(
          swTarget.webSocketDebuggerUrl,
          `new Promise(r => chrome.storage.local.get(null, r))`
        )
      }

      // Look for real execution records
      const execKeys = swClaims ? Object.keys(swClaims).filter(k => k.startsWith('mcp:execution-record:') || k.startsWith('openmcp_execution_claims')) : []
      if (execKeys.length > 0) {
        realExecutionId = execKeys[0]
      }

      console.log(
        `   [+${elapsed}s] generating=${isGen}, hasFunctionBlock=${hasFunctionBlock}, responseLen=${currentResp.length}, swExecKeys=${execKeys.length}`
      )

      if (currentResp.length > 0 && poll % 5 === 0) {
        console.log(`     Snippet: ${currentResp.slice(0, 150).replace(/\n/g, ' ')}...`)
      }

      if (hasFunctionBlock) {
        detectedFunctionCall = true
        const buttonText = (await evaluateInTarget(pageWs, `document.querySelector('.execute-button')?.textContent || ''`)) || ''
        console.log(`   Execute button in DOM: "${buttonText}"`)

        if (buttonText.includes('Run') && !toolExecuted) {
          console.log('   >>> Triggering .execute-button click in ChatGPT page...')
          toolExecuted = true
          await evaluateInTarget(pageWs, `document.querySelector('.execute-button')?.click()`)
        }

        const resultsText = (await evaluateInTarget(pageWs, `document.querySelector('.function-results-panel')?.textContent || ''`)) || ''
        if (buttonText.includes('Execution Completed')) {
          const claimsRaw = await evaluateInTarget(pageWs, `localStorage.getItem('openmcp_execution_claims_v2')`)
          console.log('\n   🎉 E2E TOOL EXECUTION COMPLETED THROUGH CHATGPT + SA + MCP!')
          console.log('   openmcp_execution_claims_v2:', claimsRaw)

          // Click insert button to re-inject result back to ChatGPT
          const hasInsert = await evaluateInTarget(pageWs, `Boolean(document.querySelector('.insert-button'))`)
          if (hasInsert) {
            console.log('   >>> Clicking .insert-button to re-inject tool result into ChatGPT...')
            await evaluateInTarget(pageWs, `document.querySelector('.insert-button')?.click()`)
            await sleep(1000)
            await evaluateInTarget(pageWs, adapter.submitForm)
            console.log('   >>> Re-injected tool result submitted back to ChatGPT!')
          }
          break
        }
      }
    } catch (pollErr: any) {
      console.log(`   Poll error at +${elapsed}s: ${pollErr.message}`)
    }
  }

  // 8. Inspect final state in extension storage
  console.log('\n8. Final forensic inspection of storage...')
  if (swTarget?.webSocketDebuggerUrl) {
    const allStorage = await evaluateInTarget(
      swTarget.webSocketDebuggerUrl,
      `new Promise(r => chrome.storage.local.get(null, r))`
    )
    console.log('   Storage keys in Service Worker:', Object.keys(allStorage || {}))
    for (const [k, v] of Object.entries(allStorage || {})) {
      if (k.includes('execution') || k.includes('claim') || k.includes('mcp')) {
        console.log(`     • ${k}:`, JSON.stringify(v).slice(0, 200))
      }
    }
  }

  // 9. Teardown
  console.log('\n9. Teardown...')
  await stopAgent('agent-chatgpt-single')
  await mcpServer.stop()
  console.log('Done.')
}

main().catch(err => {
  console.error('Fatal error in test-real-chatgpt-single:', err)
  process.exit(1)
})
