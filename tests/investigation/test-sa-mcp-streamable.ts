/**
 * Test v4: SA → MCPSSEServer via StreamableHTTP
 * 
 * Hallazgo: SSE no funciona en Chrome Service Workers (conexión muere).
 * Solución: Usar StreamableHTTP (request/response en misma transacción HTTP).
 * 
 * 1. Lanzar MCPSSEServer (ahora con soporte StreamableHTTP en /mcp)
 * 2. Configurar SA para usar streamable-http en http://localhost:9334/mcp
 * 3. Recargar SA
 * 4. Verificar conexión persistente
 */
import { launchChrome } from './src/services/webRelay/ChromeCDP.js'
import { MCPSSEServer } from './src/services/mcpServer/MCPSSEServer.js'
import { WebSocket } from 'ws'

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
  console.log('=== SA → MCPSSEServer via StreamableHTTP ===\n')

  // 1. Start server
  console.log('[1] Starting MCPSSEServer (SSE + StreamableHTTP)...')
  const server = new MCPSSEServer({ port: MCP_PORT })
  server.registerTools([])
  await server.start()
  console.log('    ✅ Server running')

  // 2. Launch Chrome
  console.log('[2] Launching Chrome with SA...')
  await launchChrome('https://chatgpt.com')
  await sleep(6000)
  console.log('    ✅ Chrome running')

  // 3. Configure SA for streamable-http
  console.log('[3] Configuring SA → streamable-http on port', MCP_PORT, '...')
  const saved = await evalInWorker(`
    new Promise(r => chrome.storage.local.set({
      mcpServerUrl: 'http://localhost:${MCP_PORT}/mcp',
      mcpConnectionType: 'streamable-http'
    }, () => r('saved')))
  `)
  console.log('    Storage:', saved)

  const verified = await evalInWorker(`
    new Promise(r => chrome.storage.local.get(['mcpServerUrl', 'mcpConnectionType'], d => r(JSON.stringify(d))))
  `)
  console.log('    Verified:', verified)

  // 4. Reload SA to pick up new config
  console.log('[4] Reloading SA...')
  try { await evalInWorker('chrome.runtime.reload()') } catch {}
  await sleep(6000)
  console.log('    SA reloaded')

  // 5. Monitor
  console.log('\n[5] Monitoring (30s)...\n')
  let maxConn = 0
  for (let i = 0; i < 15; i++) {
    const s = server.getStatus()
    maxConn = Math.max(maxConn, s.connections)
    console.log(`  [${(i*2).toString().padStart(2)}s] connections=${s.connections} tools=${s.tools}`)
    await sleep(2000)
  }

  // 6. Test: query SA for connection status from a page context
  console.log('\n[6] Checking SA status from page...')
  try {
    const cdpTargets = await fetch('http://127.0.0.1:9222/json').then(r => r.json())
    const chatPage = cdpTargets.find((t: any) => t.url?.includes('chatgpt.com') && t.type === 'page')
    if (chatPage?.webSocketDebuggerUrl) {
      const ws = new WebSocket(chatPage.webSocketDebuggerUrl)
      await new Promise<void>((r, j) => { ws.on('open', r); ws.on('error', j) })
      
      // Check if SA sidebar is visible
      const saCheck = await new Promise<any>((resolve) => {
        const h = (d: any) => { const m = JSON.parse(d.toString()); if (m.id === 1) { ws.off('message', h); resolve(m) } }
        ws.on('message', h)
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
          expression: `document.querySelector('[class*="mcp"], [id*="mcp"], [data-mcp]')?.textContent?.substring(0, 100) || 'No MCP UI found'`,
          returnByValue: true
        }}))
        setTimeout(() => resolve(null), 5000)
      })
      console.log('    SA UI:', saCheck?.result?.result?.value)
      ws.close()
    }
  } catch (e: any) {
    console.log('    Check failed:', e.message)
  }

  // Summary
  const final = server.getStatus()
  console.log('\n' + '='.repeat(50))
  console.log('MCPSSEServer:', final.running ? '✅' : '❌')
  console.log('Conexiones:', final.connections, maxConn > 0 ? '✅' : '❌')
  console.log('Tools:', final.tools)
  console.log('Transport: StreamableHTTP')
  console.log('='.repeat(50))

  if (maxConn > 0 || final.connections > 0) {
    console.log('\n🎉 SA conectada via StreamableHTTP!')
  } else {
    console.log('\n⚠ Conexión no persistente detectada')
  }

  process.exit(0)
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
