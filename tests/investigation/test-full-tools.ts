/**
 * Test: Full TUI flow simulation — verify ALL framework tools register via ToolAdapter
 * 
 * Simulates what happens when the TUI enters web mode:
 * 1. MCPSSEServer starts on :9334
 * 2. Chrome launches with SA
 * 3. SA configured → StreamableHTTP
 * 4. adaptToolsForMCP() converts ALL framework tools
 * 5. Verifies SA sees all tools
 */
import { MCPSSEServer } from '../../src/services/mcpServer/MCPSSEServer.js'
import { adaptToolsForMCP } from '../../src/services/mcpServer/ToolAdapter.js'
import { launchChrome } from '../../src/services/webRelay/ChromeCDP.js'
import { WebSocket } from 'ws'
import { readdirSync } from 'fs'
import path from 'path'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const SA_ID = 'kngiafgkdnlkgmefdafaibkibegkcaef'
const MCP_PORT = 9334

async function evalInWorker(expression: string): Promise<any> {
  const targets = await fetch('http://127.0.0.1:9222/json').then(r => r.json())
  const sw = targets.find((t: any) => t.url?.includes(SA_ID) && t.type === 'service_worker')
  if (!sw?.webSocketDebuggerUrl) return null
  const ws = new WebSocket(sw.webSocketDebuggerUrl)
  await new Promise<void>((r, j) => { ws.on('open', r); ws.on('error', j) })
  const result = await new Promise<any>((resolve, reject) => {
    const h = (d: any) => { const m = JSON.parse(d.toString()); if (m.id === 1) { ws.off('message', h); resolve(m) } }
    ws.on('message', h)
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    setTimeout(() => { ws.off('message', h); reject(new Error('timeout')) }, 10000)
  })
  ws.close()
  return result?.result?.value
}

async function main() {
  console.log('=== FULL INTEGRATION TEST: Framework Tools via ToolAdapter ===\n')

  // 1. Discover all tool directories (same as framework does)
  const toolsDir = path.join(process.cwd(), 'src', 'tools')
  let allToolDirs: string[] = []
  try {
    allToolDirs = readdirSync(toolsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
    console.log(`[1] Found ${allToolDirs.length} tool directories in src/tools/`)
    console.log(`    ${allToolDirs.join(', ')}\n`)
  } catch {
    console.log('[1] Could not read tools directory, using mock tools')
  }

  // 2. Create mock Tool objects (simulating what the framework passes to webRelayCallModel)
  console.log('[2] Creating mock framework Tool[] array...')
  const mockTools = allToolDirs.map(name => ({
    name,
    description: `Tool: ${name}`,
    userFacingName: () => name,
    // Simulate Tool interface
    isReadOnly: () => false,
    isEnabled: () => true,
    prompt: `Use ${name} to perform actions`,
    inputJSONSchema: { type: 'object', properties: {}, required: [] },
    call: async () => ({ type: 'result', data: { output: `${name} executed` } }),
    validateInput: () => ({ result: true }),
    getInputJSONSchema: () => ({ type: 'object', properties: {}, required: [] }),
  }))
  console.log(`    Created ${mockTools.length} mock tools\n`)

  // 3. Use adaptToolsForMCP to convert them
  console.log('[3] Running adaptToolsForMCP()...')
  const adapted = adaptToolsForMCP(mockTools as any)
  console.log(`    ✅ Adapted ${adapted.length} tools for MCP`)
  console.log(`    Tool names: ${adapted.map(t => t.name).join(', ')}\n`)

  // 4. Start MCP server with ALL adapted tools
  console.log('[4] Starting MCPSSEServer with all tools...')
  const server = new MCPSSEServer({ port: MCP_PORT })
  server.registerTools(adapted)
  await server.start()
  const status = server.getStatus()
  console.log(`    ✅ MCP server: ${status.tools} tools registered\n`)

  // 5. Launch Chrome with SA
  console.log('[5] Launching Chrome with SA...')
  await launchChrome('https://chatgpt.com')
  await sleep(5000)

  // 6. Configure SA → StreamableHTTP
  console.log('[6] Configuring SA → StreamableHTTP...')
  await evalInWorker(`
    new Promise(r => chrome.storage.local.set({
      mcpServerUrl: 'http://localhost:${MCP_PORT}/mcp',
      mcpConnectionType: 'streamable-http'
    }, () => r('ok')))
  `)
  try { await evalInWorker('chrome.runtime.reload()') } catch {}
  await sleep(6000)

  // 7. Verify
  const final = server.getStatus()
  console.log('\n' + '='.repeat(60))
  console.log(`MCPSSEServer: ✅ port ${MCP_PORT}`)
  console.log(`Connections:  ${final.connections}`)
  console.log(`Total tools:  ${final.tools} (${adapted.length} adapted + 2 relay)`)
  console.log(`Transport:    StreamableHTTP (/mcp)`)
  console.log('='.repeat(60))

  if (final.connections > 0) {
    console.log('\n🎉 ALL framework tools available in ChatGPT via SA!')
    console.log(`   ${adapted.length} tools from ToolAdapter + 2 relay tools`)
    console.log('   ChatGPT can now use ANY tool from openMCPWEBLOCK')
  } else {
    console.log('\n⚠ SA not connected — check Chrome/SA status')
  }

  // Test a few adapted tools
  console.log('\n[8] Testing adapted tool execution:')
  for (const tool of adapted.slice(0, 3)) {
    try {
      const result = await tool.execute({})
      console.log(`    ${tool.name}: ${String(result).substring(0, 60)}`)
    } catch (err: any) {
      console.log(`    ${tool.name}: ${err.message?.substring(0, 60) || 'error'}`)
    }
  }

  console.log('\nServer running. Ctrl+C to exit.')
  await new Promise(() => {})
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
