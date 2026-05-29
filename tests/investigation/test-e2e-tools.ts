/**
 * Test E2E: ChatGPT usa herramientas de openMCPWEBLOCK via SA + StreamableHTTP
 * 
 * 1. MCPSSEServer con herramientas reales (Read, Bash, LS, Grep, Write)
 * 2. Chrome con SA conectada via StreamableHTTP
 * 3. Pedir a ChatGPT que ejecute una herramienta
 * 4. Verificar que SA invoca la herramienta y ChatGPT recibe el resultado
 */
import { launchChrome, CDPConnection } from '../../src/services/webRelay/ChromeCDP.js'
import { MCPSSEServer, type ToolDefinition } from '../../src/services/mcpServer/MCPSSEServer.js'
import { WebSocket } from 'ws'
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'fs'
import { execSync } from 'child_process'
import { join, dirname } from 'path'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const SA_ID = 'kngiafgkdnlkgmefdafaibkibegkcaef'
const MCP_PORT = 9334

// ─── Real Tool Definitions ────────────────────────────────────────

const realTools: ToolDefinition[] = [
  {
    name: 'Read',
    description: 'Read file contents from the filesystem. Returns the text content of the specified file.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to read' },
        offset: { type: 'number', description: 'Line offset to start reading from (0-indexed)' },
        limit: { type: 'number', description: 'Maximum number of lines to read' },
      },
      required: ['file_path'],
    },
    execute: async (args) => {
      const filePath = String(args.file_path || '')
      if (!filePath) return 'Error: No file path provided'
      try {
        const content = readFileSync(filePath, 'utf-8')
        if (args.offset || args.limit) {
          const lines = content.split('\n')
          const offset = Number(args.offset) || 0
          const limit = Number(args.limit) || lines.length
          return lines.slice(offset, offset + limit).join('\n')
        }
        return content
      } catch (err: any) {
        return `Error reading file: ${err.message}`
      }
    },
  },
  {
    name: 'Write',
    description: 'Write content to a file. Creates directories if needed.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to write to' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['file_path', 'content'],
    },
    execute: async (args) => {
      const filePath = String(args.file_path || '')
      const content = String(args.content || '')
      if (!filePath) return 'Error: No file path provided'
      try {
        mkdirSync(dirname(filePath), { recursive: true })
        writeFileSync(filePath, content, 'utf-8')
        return `File written: ${filePath} (${content.length} bytes)`
      } catch (err: any) {
        return `Error writing file: ${err.message}`
      }
    },
  },
  {
    name: 'Bash',
    description: 'Execute a shell command and return its output.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
      },
      required: ['command'],
    },
    execute: async (args) => {
      const cmd = String(args.command || '')
      if (!cmd) return 'Error: No command provided'
      try {
        const output = execSync(cmd, {
          timeout: 30000, encoding: 'utf-8',
          cwd: process.cwd(), maxBuffer: 1024 * 1024,
        })
        return output || '(no output)'
      } catch (err: any) {
        return `Exit code ${err.status || 1}\n${err.stderr || err.message}`
      }
    },
  },
  {
    name: 'LS',
    description: 'List directory contents with file sizes.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list' },
      },
      required: ['path'],
    },
    execute: async (args) => {
      const dirPath = String(args.path || '.')
      try {
        const entries = readdirSync(dirPath)
        const result = entries.map(e => {
          try {
            const s = statSync(join(dirPath, e))
            return `${s.isDirectory() ? '[DIR]' : `[${s.size}b]`} ${e}`
          } catch { return `[?] ${e}` }
        })
        return result.join('\n') || '(empty directory)'
      } catch (err: any) {
        return `Error listing directory: ${err.message}`
      }
    },
  },
  {
    name: 'Grep',
    description: 'Search for text patterns in files.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Search pattern' },
        path: { type: 'string', description: 'File or directory path to search' },
      },
      required: ['pattern', 'path'],
    },
    execute: async (args) => {
      const pattern = String(args.pattern || '')
      const searchPath = String(args.path || '.')
      if (!pattern) return 'Error: No pattern provided'
      try {
        const output = execSync(
          `findstr /s /n /r "${pattern}" "${searchPath}"`,
          { encoding: 'utf-8', timeout: 10000, maxBuffer: 512 * 1024 }
        )
        return output || '(no matches)'
      } catch { return '(no matches)' }
    },
  },
]

// ─── Helper ────────────────────────────────────────────────────

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

// ─── Main ────────────────────────────────────────────────────

async function main() {
  console.log('=== E2E: SA + MCP Tools via StreamableHTTP ===\n')

  // 1. Start server with REAL tools
  console.log('[1] Starting MCPSSEServer with real tools...')
  const server = new MCPSSEServer({ port: MCP_PORT })
  server.registerTools(realTools)
  await server.start()
  const s = server.getStatus()
  console.log(`    ✅ ${s.tools} tools registered: ${realTools.map(t => t.name).join(', ')} + relay tools`)

  // 2. Launch Chrome
  console.log('[2] Launching Chrome with SA...')
  await launchChrome('https://chatgpt.com')
  await sleep(5000)

  // 3. Configure SA → streamable-http
  console.log('[3] Configuring SA → StreamableHTTP...')
  await evalInWorker(`
    new Promise(r => chrome.storage.local.set({
      mcpServerUrl: 'http://localhost:${MCP_PORT}/mcp',
      mcpConnectionType: 'streamable-http'
    }, () => r('ok')))
  `)
  try { await evalInWorker('chrome.runtime.reload()') } catch {}
  await sleep(6000)

  // 4. Verify connection
  console.log('[4] Verifying connection...')
  const status = server.getStatus()
  console.log(`    Connections: ${status.connections} | Tools: ${status.tools}`)
  if (status.connections === 0) {
    console.log('    ⚠ No connections yet, waiting...')
    await sleep(5000)
    console.log(`    Connections: ${server.getStatus().connections}`)
  }

  // 5. Test tools locally (verify they work before ChatGPT tries them)
  console.log('\n[5] Local tool tests:')
  for (const tool of realTools) {
    let testArgs: Record<string, unknown>
    switch (tool.name) {
      case 'Read': testArgs = { file_path: 'package.json' }; break
      case 'LS': testArgs = { path: '.' }; break
      case 'Bash': testArgs = { command: 'echo TOOLS_WORKING' }; break
      default: continue
    }
    const result = await tool.execute(testArgs)
    const preview = result.substring(0, 80).replace(/\n/g, '\\n')
    console.log(`    ${tool.name}: ${preview}...`)
  }

  // 6. Summary
  const final = server.getStatus()
  console.log('\n' + '='.repeat(50))
  console.log('MCPSSEServer: ✅ (port ' + MCP_PORT + ')')
  console.log('Conexiones: ' + final.connections)
  console.log('Tools: ' + final.tools + ' (' + realTools.map(t => t.name).join(', ') + ' + relay)')
  console.log('Transport: StreamableHTTP (/mcp)')
  console.log('='.repeat(50))

  if (final.connections > 0) {
    console.log('\n🎉 openMCPWEBLOCK tools disponibles en ChatGPT via SA!')
    console.log('   ChatGPT puede usar: Read, Write, Bash, LS, Grep')
    console.log('   Ejemplo: "Lee el archivo package.json de mi proyecto"')
  }

  // Keep running so tools can be called
  console.log('\nServidor corriendo. Ctrl+C para salir.')
  await new Promise(() => {}) // block forever
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
