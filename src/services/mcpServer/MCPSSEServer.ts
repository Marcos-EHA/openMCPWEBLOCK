/**
 * MCPSSEServer — MCP Server over StreamableHTTP + SSE fallback for SuperAssistant.
 *
 * This server exposes openMCPWEBLOCK's tools (Read, Bash, Edit, Write, etc.)
 * via the standard MCP protocol, allowing SA or any MCP client
 * to connect and execute tools.
 *
 * Supports two transports:
 *   StreamableHTTP (preferred) — POST /mcp (request/response in same HTTP transaction)
 *   SSE (legacy)              — GET /sse + POST /messages
 *
 * StreamableHTTP is required for Chrome MV3 Service Workers which cannot
 * maintain persistent SSE connections.
 *
 * Usage:
 *   const server = new MCPSSEServer({ port: 9334 });
 *   server.registerTools(tools);
 *   await server.start();
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { randomUUID } from 'crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { URL } from 'url'

// ─── Types ──────────────────────────────────────────────────────────

export interface MCPSSEServerOptions {
  port: number
  hostname?: string
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>  // JSON Schema format
  execute: (args: Record<string, unknown>) => Promise<string>
}

interface RelayMessage {
  type: 'prompt' | 'response'
  text: string
  platform?: string
  timestamp: number
}

// ─── Server ─────────────────────────────────────────────────────────

export class MCPSSEServer {
  private port: number
  private hostname: string
  private httpServer: ReturnType<typeof createServer> | null = null
  private sseTransports: Map<string, SSEServerTransport> = new Map()
  private streamableTransport: StreamableHTTPServerTransport | null = null
  private streamableServer: Server | null = null
  private tools: ToolDefinition[] = []
  private isRunning = false

  // Relay channel for TUI ↔ browser communication
  private pendingPrompt: RelayMessage | null = null
  private pendingResponse: RelayMessage | null = null
  private responseResolvers: Array<(msg: RelayMessage) => void> = []

  constructor(options: MCPSSEServerOptions) {
    this.port = options.port
    this.hostname = options.hostname ?? '127.0.0.1'
  }

  /**
   * Register tools from openMCPWEBLOCK for MCP clients to use.
   */
  registerTools(tools: ToolDefinition[]): void {
    this.tools = [
      ...tools,
      // Built-in relay tools
      {
        name: 'relay_get_pending_prompt',
        description: 'Check if there is a pending prompt from openclaude TUI to send to the AI',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => {
          if (this.pendingPrompt) {
            const p = this.pendingPrompt
            this.pendingPrompt = null
            return JSON.stringify(p)
          }
          return JSON.stringify({ type: 'none' })
        },
      },
      {
        name: 'relay_send_response',
        description: 'Send the AI response from the browser back to openclaude TUI',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The AI response text' },
            platform: { type: 'string', description: 'Platform name' },
          },
          required: ['text'],
        },
        execute: async (args: Record<string, unknown>) => {
          const msg: RelayMessage = {
            type: 'response',
            text: String(args.text || ''),
            platform: String(args.platform || 'unknown'),
            timestamp: Date.now(),
          }
          this.pendingResponse = msg
          for (const r of this.responseResolvers) r(msg)
          this.responseResolvers = []
          return 'Response received by openclaude'
        },
      },
    ]
  }

  // ─── Relay API (called from WebRelayProvider) ───────────────────

  sendPrompt(text: string, platform?: string): void {
    this.pendingPrompt = { type: 'prompt', text, platform, timestamp: Date.now() }
  }

  waitForResponse(timeoutMs: number = 120000): Promise<RelayMessage | null> {
    if (this.pendingResponse) {
      const resp = this.pendingResponse
      this.pendingResponse = null
      return Promise.resolve(resp)
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.responseResolvers.indexOf(resolve as any)
        if (idx >= 0) this.responseResolvers.splice(idx, 1)
        resolve(null)
      }, timeoutMs)
      this.responseResolvers.push((msg: RelayMessage) => {
        clearTimeout(timer)
        resolve(msg)
      })
    })
  }

  // ─── Create a low-level Server for each SSE connection ────────

  private createServerForConnection(): Server {
    const server = new Server(
      { name: 'openMCPWEBLOCK', version: '0.7.0' },
      { capabilities: { tools: {} } }
    )

    // Handle tools/list
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: this.tools.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as any,
        })),
      }
    })

    // Handle tools/call
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params
      const tool = this.tools.find(t => t.name === name)
      if (!tool) {
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        }
      }
      try {
        const result = await tool.execute(args || {})
        return {
          content: [{ type: 'text', text: result }],
        }
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: `Error: ${err?.message ?? String(err)}` }],
          isError: true,
        }
      }
    })

    return server
  }

  // ─── HTTP Server ────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.isRunning) return

    return new Promise((resolve, reject) => {
      this.httpServer = createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          console.error('[MCP SSE] Request error:', err)
          if (!res.headersSent) {
            res.writeHead(500)
            res.end('Internal Server Error')
          }
        })
      })

      this.httpServer.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`[MCP SSE] Port ${this.port} already in use`)
        }
        reject(err)
      })

      this.httpServer.listen(this.port, this.hostname, () => {
        this.isRunning = true
        console.log(`[MCP SSE] Server listening on http://${this.hostname}:${this.port}`)
        console.log(`[MCP] SA connect URL (StreamableHTTP): http://${this.hostname}:${this.port}/mcp`)
        console.log(`[MCP] SA connect URL (SSE legacy): http://${this.hostname}:${this.port}/sse`)
        console.log(`[MCP SSE] Tools registered: ${this.tools.length}`)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return
    for (const [, transport] of this.sseTransports) {
      try { await transport.close() } catch { /* ignore */ }
    }
    this.sseTransports.clear()
    if (this.streamableTransport) {
      try { await this.streamableTransport.close() } catch { /* ignore */ }
    }
    return new Promise((resolve) => {
      if (this.httpServer) {
        this.httpServer.close(() => { this.isRunning = false; resolve() })
      } else { resolve() }
    })
  }

  getStatus(): { running: boolean; port: number; connections: number; tools: number } {
    return {
      running: this.isRunning,
      port: this.port,
      connections: this.sseTransports.size + (this.streamableTransport ? 1 : 0),
      tools: this.tools.length,
    }
  }

  // ─── Request Handler ──────────────────────────────────────────

  // ─── Initialize StreamableHTTP transport ────────────────────────

  private async initStreamableTransport(): Promise<void> {
    this.streamableTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    })
    this.streamableServer = this.createServerForConnection()
    await this.streamableServer.connect(this.streamableTransport)
    console.log('[MCP] StreamableHTTP transport initialized')
  }

  // ─── Request Handler ──────────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id')
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id')

    if (req.method === 'OPTIONS') {
      res.writeHead(204); res.end(); return
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`)
    console.log(`[MCP] ${req.method} ${url.pathname}${url.search}`)

    // StreamableHTTP endpoint (preferred by SA)
    if (url.pathname === '/mcp' || url.pathname === '/') {
      if (!this.streamableTransport) {
        await this.initStreamableTransport()
      }
      await this.streamableTransport!.handleRequest(req, res)
      return
    }

    // Legacy SSE endpoints
    if (req.method === 'GET' && url.pathname === '/sse') {
      await this.handleSSEConnect(req, res)
      return
    }

    if (req.method === 'POST' && url.pathname === '/messages') {
      await this.handleMessage(req, res, url)
      return
    }

    if (req.method === 'GET' && url.pathname === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(this.getStatus()))
      return
    }

    console.log(`[MCP] 404: ${req.method} ${url.pathname}`)
    res.writeHead(404); res.end('Not Found')
  }

  private async handleSSEConnect(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    console.log('[MCP SSE] New SSE connection')
    const transport = new SSEServerTransport('/messages', res)
    const sessionId = transport.sessionId
    this.sseTransports.set(sessionId, transport)

    transport.onclose = () => {
      console.log(`[MCP SSE] Connection closed: ${sessionId}`)
      this.sseTransports.delete(sessionId)
    }

    const server = this.createServerForConnection()
    await server.connect(transport)
    console.log(`[MCP SSE] Connected: ${sessionId} (${this.sseTransports.size} active)`)
  }

  private async handleMessage(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const sessionId = url.searchParams.get('sessionId')
    console.log(`[MCP SSE] POST /messages sessionId=${sessionId} content-type=${req.headers['content-type']}`)
    if (!sessionId) { res.writeHead(400); res.end('Missing sessionId'); return }

    const transport = this.sseTransports.get(sessionId)
    if (!transport) {
      console.log(`[MCP SSE] Session not found: ${sessionId}. Active: ${[...this.sseTransports.keys()].join(', ')}`)
      res.writeHead(404); res.end('Session not found'); return
    }

    const body = await new Promise<string>((resolve) => {
      let data = ''
      req.on('data', (chunk) => { data += chunk })
      req.on('end', () => resolve(data))
    })

    console.log(`[MCP SSE] POST body: ${body.substring(0, 200)}`)

    try {
      const parsed = JSON.parse(body)
      await transport.handlePostMessage(req, res, parsed)
      console.log(`[MCP SSE] POST handled OK, status=${res.statusCode}`)
    } catch (err: any) {
      console.error('[MCP SSE] Error handling message:', err?.message || err)
      if (!res.headersSent) { res.writeHead(400); res.end('Invalid JSON') }
    }
  }
}
