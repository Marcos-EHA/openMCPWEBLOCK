/**
 * Diagnóstico: ¿Por qué SA se desconecta inmediatamente de MCPSSEServer?
 * 
 * Hipótesis:
 * 1. Error en el handshake MCP (version mismatch)
 * 2. SSE response format issue  
 * 3. Service Worker lifecycle killing the connection
 * 4. CORS issue from extension context
 * 
 * Usa un servidor HTTP raw para ver exactamente qué hace SA.
 */
import { createServer } from 'http'
import { launchChrome } from './src/services/webRelay/ChromeCDP.js'
import { WebSocket } from 'ws'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const SA_ID = 'kngiafgkdnlkgmefdafaibkibegkcaef'
const PORT = 9334

async function main() {
  console.log('=== Diagnóstico SA SSE ===\n')
  
  let sessionCounter = 0

  // Raw HTTP server to see exactly what SA sends
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`)
    
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    
    if (req.method === 'OPTIONS') {
      res.writeHead(204); res.end(); return
    }

    console.log(`\n>>> ${req.method} ${req.url}`)
    console.log(`    Headers: ${JSON.stringify(req.headers).substring(0, 200)}`)

    if (req.method === 'GET' && url.pathname === '/sse') {
      sessionCounter++
      const sessionId = `session-${sessionCounter}`
      console.log(`    [SSE] Starting stream for session: ${sessionId}`)
      
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })
      
      // Send the endpoint event (MCP SSE protocol)
      const endpointMsg = `event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`
      res.write(endpointMsg)
      console.log(`    [SSE] Sent endpoint event: /messages?sessionId=${sessionId}`)
      
      // Keep connection alive
      const keepAlive = setInterval(() => {
        try {
          res.write(': keepalive\n\n')
        } catch {
          clearInterval(keepAlive)
        }
      }, 15000)

      req.on('close', () => {
        console.log(`    [SSE] Client disconnected: ${sessionId}`)
        clearInterval(keepAlive)
      })
      
      return
    }

    if (req.method === 'POST' && url.pathname === '/messages') {
      const sessionId = url.searchParams.get('sessionId')
      console.log(`    [POST] Session: ${sessionId}`)
      
      let body = ''
      req.on('data', chunk => body += chunk)
      req.on('end', () => {
        console.log(`    [POST] Body: ${body.substring(0, 500)}`)
        
        try {
          const msg = JSON.parse(body)
          console.log(`    [POST] JSON-RPC method: ${msg.method}, id: ${msg.id}`)
          
          // Respond to initialize
          if (msg.method === 'initialize') {
            const response = {
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'openMCPWEBLOCK', version: '0.7.0' }
              }
            }
            console.log(`    [POST] Responding to initialize`)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(response))
            return
          }

          // Respond to notifications/initialized  
          if (msg.method === 'notifications/initialized') {
            console.log(`    [POST] Got initialized notification`)
            res.writeHead(200)
            res.end()
            return
          }

          // Respond to tools/list
          if (msg.method === 'tools/list') {
            const response = {
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                tools: [
                  {
                    name: 'Read',
                    description: 'Read file contents',
                    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
                  },
                  {
                    name: 'Bash',
                    description: 'Execute shell command',
                    inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
                  }
                ]
              }
            }
            console.log(`    [POST] Responding to tools/list with 2 tools`)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(response))
            return
          }

          // Default response
          console.log(`    [POST] Unknown method: ${msg.method}`)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }))
        } catch (e: any) {
          console.log(`    [POST] Parse error: ${e.message}`)
          res.writeHead(400)
          res.end('Bad Request')
        }
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ running: true, sessions: sessionCounter }))
      return
    }

    res.writeHead(404); res.end('Not Found')
  })

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Diagnostic server on http://127.0.0.1:${PORT}`)
  })

  // Launch Chrome with SA
  console.log('Launching Chrome...')
  await launchChrome('https://chatgpt.com')
  await sleep(5000)

  // Verify SA config points to us
  const targets = await fetch('http://127.0.0.1:9222/json').then(r => r.json())
  const saWorker = targets.find((t: any) => t.url?.includes(SA_ID))
  console.log('SA worker:', saWorker ? 'found' : 'NOT FOUND')

  // Monitor for 30 seconds
  console.log('\n--- Monitoring for 30s ---\n')
  await sleep(30000)
  
  console.log('\n--- Done ---')
  process.exit(0)
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
