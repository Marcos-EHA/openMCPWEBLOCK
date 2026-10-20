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
  type CallToolResult,
  ListToolsRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js'
import { URL } from 'url'
import { getOpenWeblockCoreTools } from './ToolAdapter.js'
import { getSentinelMCPTools } from './SentinelMCPTools.js'
import { MCP_PORT } from './mcpPort.js'
import { sharedActivityJournal } from '../observability/SharedActivityJournal.js'
import { initializeSharedActivitySources } from '../observability/SharedActivitySources.js'
import { workspaceContextJournal, getWorkspaceContextMCPTools } from '../webRelay/WorkspaceContextJournal.js'

const EXECUTION_DIAGNOSTICS_ENABLED = true
const EXECUTION_DIAGNOSTIC_COLLECTOR = 'http://127.0.0.1:3011/v1/execution-diagnostic'
let nextDiagnosticDispatchId = 0

function recordToolDispatchDiagnostic(
  event: string,
  fields: {
    dispatcherId: string
    toolName: string
    commandPresent: boolean
    argumentKeys: string[]
  },
): void {
  if (!EXECUTION_DIAGNOSTICS_ENABLED) return

  const payload = {
    timestamp: new Date().toISOString(),
    event,
    ...fields,
    executionIdPresent: false,
    executionKeyPresent: false,
  }
  void fetch(EXECUTION_DIAGNOSTIC_COLLECTOR, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify(payload),
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(1500),
  }).catch(() => undefined)
}

// ─── Types ──────────────────────────────────────────────────────────

export interface MCPSSEServerOptions {
  port?: number
  hostname?: string
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>  // JSON Schema format
  execute: (args: Record<string, unknown>) => Promise<
    string | Pick<CallToolResult, 'content' | 'isError'>
  >
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
  private streamableTransports: Map<string, StreamableHTTPServerTransport> = new Map()
  private lastStreamableSessionId: string | null = null
  private tools: ToolDefinition[] = []
  private isRunning = false

  // Relay channel for TUI ↔ browser communication
  private pendingPrompt: RelayMessage | null = null
  private pendingResponse: RelayMessage | null = null
  private responseResolvers: Array<(msg: RelayMessage) => void> = []

  constructor(options?: MCPSSEServerOptions) {
    this.port = options?.port ?? MCP_PORT
    this.hostname = options?.hostname ?? '127.0.0.1'
    // Pre-register openweblock core tools so server is immediately operational
    this.registerTools([
      ...getOpenWeblockCoreTools() as unknown as ToolDefinition[],
      ...getSentinelMCPTools(),
      ...getWorkspaceContextMCPTools() as ToolDefinition[],
    ])
  }

  /**
   * Register tools from openMCPWEBLOCK for MCP clients to use.
   * Merges with existing tools so core tools are preserved.
   */
  registerTools(tools: ToolDefinition[]): void {
    const existing = new Map<string, ToolDefinition>()
    for (const t of this.tools) {
      existing.set(t.name, t)
    }
    for (const t of tools) {
      existing.set(t.name, t)
    }
    // Ensure built-in relay tools are registered
    if (!existing.has('relay_get_pending_prompt')) {
      existing.set('relay_get_pending_prompt', {
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
      })
    }
    if (!existing.has('relay_send_response')) {
      existing.set('relay_send_response', {
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
      })
    }
    this.tools = Array.from(existing.values())
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
      const argumentKeys = args && typeof args === 'object' && !Array.isArray(args)
        ? Object.keys(args)
        : []
      const diagnosticFields = {
        dispatcherId: `mcp-dispatch-${++nextDiagnosticDispatchId}`,
        toolName: name,
        commandPresent: Object.prototype.hasOwnProperty.call(args || {}, 'command'),
        argumentKeys,
      }
      recordToolDispatchDiagnostic('MCP_TOOL_DISPATCHER_INPUT', diagnosticFields)
      const tool = this.tools.find(t => t.name === name)
      if (!tool) {
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        }
      }
      const startedAt = Date.now()
      const isActivityQuery = name === 'openmcp_read_activity' || name === 'openmcp_watch_activity'
      const isWorkspaceContextQuery = name.startsWith('workspace_context_') || name === 'workspace_task_trace'
      const shouldRecordContext = !isActivityQuery && !isWorkspaceContextQuery
      const contextCallId = randomUUID()
      const contextGeneration = workspaceContextJournal.getGeneration()
      if (shouldRecordContext) {
        try {
          workspaceContextJournal.record({
            type: 'tool-call',
            source: 'mcp',
            role: 'tool',
            callId: contextCallId,
            toolName: name,
            arguments: args || {},
          }, contextGeneration)
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `Tool was not executed because its call could not be saved to the enabled Workspace context journal: ${String(error)}`,
            }],
            isError: true,
          }
        }
      }
      let result: string | Pick<CallToolResult, 'content' | 'isError'>
      try {
        recordToolDispatchDiagnostic('MCP_TOOL_ADAPTER_ENTRY', diagnosticFields)
        if (!isActivityQuery) {
          sharedActivityJournal.append({
            source: 'mcp',
            event: 'mcp:tool-dispatch',
            details: {
              dispatcherId: diagnosticFields.dispatcherId,
              toolName: diagnosticFields.toolName,
              argumentKeys: diagnosticFields.argumentKeys.join(',').slice(0, 200),
            },
          })
        }
        result = await tool.execute(args || {})
        if (!isActivityQuery) {
          sharedActivityJournal.append({
            source: 'mcp',
            event: 'mcp:tool-complete',
            details: {
              dispatcherId: diagnosticFields.dispatcherId,
              toolName: diagnosticFields.toolName,
              durationMs: Date.now() - startedAt,
              success: typeof result === 'string' || result.isError !== true,
              resultType: typeof result === 'string' ? 'text' : 'structured',
            },
          })
        }
      } catch (err: any) {
        if (!isActivityQuery) {
          sharedActivityJournal.append({
            source: 'mcp',
            event: 'mcp:tool-error',
            details: {
              dispatcherId: diagnosticFields.dispatcherId,
              toolName: diagnosticFields.toolName,
              durationMs: Date.now() - startedAt,
              errorName: err instanceof Error ? err.name : 'UnknownError',
            },
          })
        }
        if (shouldRecordContext) {
          try {
            workspaceContextJournal.record({
              type: 'tool-error',
              source: 'mcp',
              role: 'tool',
              callId: contextCallId,
              toolName: name,
              arguments: args || {},
              text: err?.message ?? String(err),
              success: false,
              durationMs: Date.now() - startedAt,
            }, contextGeneration)
          } catch (journalError) {
            return {
              content: [{
                type: 'text',
                text: `Tool failed (${err?.message ?? String(err)}); its failure could not be saved to the Workspace context journal (${String(journalError)}).`,
              }],
              isError: true,
            }
          }
        }
        return { content: [{ type: 'text', text: `Error: ${err?.message ?? String(err)}` }], isError: true }
      }
      if (shouldRecordContext) {
        try {
          workspaceContextJournal.record({
            type: 'tool-result',
            source: 'mcp',
            role: 'tool',
            callId: contextCallId,
            toolName: name,
            result,
            success: typeof result === 'string' || result.isError !== true,
            durationMs: Date.now() - startedAt,
          }, contextGeneration)
        } catch (error) {
          const resultText = typeof result === 'string' ? result : JSON.stringify(result)
          return {
            content: [{
              type: 'text',
              text: `Tool execution completed, but its result could not be saved to the enabled Workspace context journal. The operation may have taken effect. Result: ${resultText}`,
            }],
            isError: true,
          }
        }
      }
      if (typeof result !== 'string') return result
      return { content: [{ type: 'text', text: result }] }
    })

    return server
  }

  // ─── HTTP Server ────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.isRunning) return
    await initializeSharedActivitySources()

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
    for (const [, transport] of this.streamableTransports) {
      try { await transport.close() } catch { /* ignore */ }
    }
    this.streamableTransports.clear()
    this.lastStreamableSessionId = null
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
      connections: this.sseTransports.size + this.streamableTransports.size,
      tools: this.tools.length,
    }
  }

  // ─── StreamableHTTP Request Handler ───────────────────────────

  private async handleStreamableRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    }
    const bodyStr = Buffer.concat(chunks).toString('utf-8')
    let parsedBody: any = undefined
    try {
      if (bodyStr) parsedBody = JSON.parse(bodyStr)
    } catch { /* ignore */ }

    const isInit = parsedBody ? (Array.isArray(parsedBody) ? parsedBody.some(isInitializeRequest) : isInitializeRequest(parsedBody)) : false

    let sessionId = req.headers['mcp-session-id'] as string | undefined

    // Only fallback to lastSessionId if this is NOT an initialize request
    if (!sessionId && !isInit && this.lastStreamableSessionId) {
      sessionId = this.lastStreamableSessionId
      req.headers['mcp-session-id'] = sessionId
      if (req.rawHeaders) {
        req.rawHeaders.push('mcp-session-id', sessionId)
      }
    }

    let transport = (sessionId && !isInit) ? this.streamableTransports.get(sessionId) : undefined

    if (!transport || isInit) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          this.lastStreamableSessionId = sid
          this.streamableTransports.set(sid, transport!)
          console.log(`[MCP] StreamableHTTP session initialized: ${sid}`)
        },
      })
      transport.onclose = () => {
        const sid = transport!.sessionId
        if (sid) {
          this.streamableTransports.delete(sid)
          if (this.lastStreamableSessionId === sid) {
            this.lastStreamableSessionId = null
          }
        }
      }
      const srv = this.createServerForConnection()
      await srv.connect(transport)
    }

    await transport.handleRequest(req, res, parsedBody)
  }

  // ─── Request Handler ──────────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', '*')
    res.setHeader('Access-Control-Expose-Headers', '*')

    if (req.method === 'OPTIONS') {
      res.writeHead(204); res.end(); return
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`)
    console.log(`[MCP] ${req.method} ${url.pathname}${url.search}`)

    // Health probe endpoints
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ok')
      return
    }

    if (url.pathname.startsWith('/relay/')) {
      const remoteAddress = req.socket.remoteAddress
      const isLoopback = remoteAddress === '127.0.0.1' ||
        remoteAddress === '::1' ||
        remoteAddress === '::ffff:127.0.0.1'
      if (!isLoopback || req.headers.origin) {
        res.writeHead(403)
        res.end('Forbidden')
        return
      }

      if (req.method === 'GET' && url.pathname === '/relay/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ available: true }))
        return
      }

      if (req.method === 'POST' && url.pathname === '/relay/prompt') {
        try {
          const chunks: Buffer[] = []
          for await (const chunk of req) {
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
          }
          const input = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
            text?: unknown
            platform?: unknown
          }
          if (typeof input.text !== 'string' || input.text.trim().length === 0) {
            res.writeHead(400, { 'Content-Type': 'text/plain' })
            res.end('A non-empty text field is required')
            return
          }
          this.sendPrompt(
            input.text,
            typeof input.platform === 'string' ? input.platform : undefined,
          )
          res.writeHead(202, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ queued: true }))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          res.writeHead(400, { 'Content-Type': 'text/plain' })
          res.end(`Invalid relay prompt: ${message}`)
        }
        return
      }

      if (req.method === 'GET' && url.pathname === '/relay/response') {
        const requestedTimeout = Number(url.searchParams.get('timeoutMs'))
        const timeoutMs = Number.isFinite(requestedTimeout)
          ? Math.min(Math.max(Math.trunc(requestedTimeout), 1), 120_000)
          : 90_000
        const response = await this.waitForResponse(timeoutMs)
        if (!response) {
          res.writeHead(204)
          res.end()
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(response))
        return
      }

      res.writeHead(404)
      res.end('Not Found')
      return
    }

    // StreamableHTTP endpoint (preferred by SA)
    if (url.pathname === '/mcp' || url.pathname === '/') {
      await this.handleStreamableRequest(req, res)
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
