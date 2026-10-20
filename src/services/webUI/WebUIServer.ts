import { createServer, type IncomingMessage, type ServerResponse } from 'http'
// @ts-ignore — ws types are not installed in this project
import { WebSocketServer, WebSocket } from 'ws'
import { randomUUID } from 'crypto'
import { LaunchOperations } from './LaunchOperations.js'
import { readFileSync, existsSync } from 'fs'
import { networkInterfaces } from 'os'
import { isIP } from 'net'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import type { WorkspaceInstanceChatMessage } from './WorkspaceInstanceChatStore.js'
import type { WorkspaceInstanceLaunchEvent } from './WorkspaceInstanceLaunchHistoryStore.js'

const PORT = process.env.OPENMCP_WEBUI_PORT === undefined ? 3007 : Number(process.env.OPENMCP_WEBUI_PORT)
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('OPENMCP_WEBUI_PORT must be an integer between 1 and 65535.')
}
const HOST = '0.0.0.0'

// Load workspace HTML views from separate files
const __dirname = dirname(fileURLToPath(import.meta.url))
const WORKSPACE_HTML = readFileSync(join(__dirname, 'workspace.html'), 'utf8')
const canvasPath = join(__dirname, 'workspace-canvas.html')
const WORKSPACE_CANVAS_HTML = existsSync(canvasPath) ? readFileSync(canvasPath, 'utf8') : null

interface WebClient { id: string; ws: WebSocket; connectedAt: number; sameOrigin: boolean }
interface AgentEvent { type: string; timestamp: number; data: any }
type PromptTarget = { agentId?: string; masterSessionSourceId?: string; workspaceParticipantId?: string }
export interface LaunchRequest {
  target?: 'relay' | 'master' | 'local'
  platformId: string
  count?: number
  purpose?: 'agent' | 'user'
  /** Whether Agent mode should plan/review tasks instead of routing directly. */
  coordinateTasks?: boolean
  /** Orchestrator inference provider; independent of MCP execution mode. */
  orchestratorBrain?: 'api' | 'web'
  launchCoordinator?: boolean
  coordinatorCount?: number
  sessionMode?: 'clean' | 'authenticated' | 'chrome-profile'
  masterSessionSourceId?: string
  chromeProfileDirectory?: string
  allowChromeProfileCopy?: boolean
  instances?: Array<{
    sessionMode: 'clean' | 'authenticated' | 'chrome-profile'
    masterSessionSourceId?: string
    chromeProfileDirectory?: string
  }>
  masterSessionSourceIds?: string[]
  registerAsWorkspaceWorker?: boolean
  /** Legacy launch flag; SA preparation is now mandatory and this only requests worker registration. */
  prepareSuperAssistant?: boolean
}

export function isSameOriginRequest(req: Pick<IncomingMessage, 'headers'>): boolean {
  const origin = req.headers.origin
  const host = req.headers.host
  if (typeof origin !== 'string' || typeof host !== 'string') return false
  try {
    const parsedOrigin = new URL(origin)
    const requestHost = new URL(`http://${host}`)
    const hostname = requestHost.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    const isLoopback = hostname === 'localhost' || hostname === '::1' ||
      (isIP(hostname) === 4 && hostname.startsWith('127.'))
    const isLocalInterface = isIP(hostname) !== 0 && Object.values(networkInterfaces())
      .flatMap(interfaces => interfaces ?? [])
      .some(address => address.address.toLowerCase() === hostname)

    return (parsedOrigin.protocol === 'http:' || parsedOrigin.protocol === 'https:') &&
      parsedOrigin.host.toLowerCase() === requestHost.host.toLowerCase() &&
      (isLoopback || isLocalInterface)
  } catch {
    return false
  }
}

function isSameOriginReadRequest(req: Pick<IncomingMessage, 'headers'>): boolean {
  if (typeof req.headers.origin === 'string') return isSameOriginRequest(req)
  const host = req.headers.host
  const referer = req.headers.referer
  if (typeof host !== 'string' || typeof referer !== 'string') return false
  try {
    const parsedReferer = new URL(referer)
    if (parsedReferer.host.toLowerCase() !== host.toLowerCase()) return false
    return isSameOriginRequest({
      headers: { ...req.headers, origin: parsedReferer.origin },
    })
  } catch {
    return false
  }
}

export class WebUIServer {
  private httpServer: ReturnType<typeof createServer> | null = null
  private wss: WebSocketServer | null = null
  private clients = new Map<string, WebClient>()
  private eventHistory: AgentEvent[] = []
  private isRunning = false
  private readonly launchOperations: LaunchOperations

  constructor(
    private readonly port = PORT,
    private readonly host = HOST,
    launchOperationDirectory?: string,
  ) {
    this.launchOperations = new LaunchOperations(launchOperationDirectory)
  }

  private handlers: {
    onPrompt?: (
      text: string,
      agentId?: string,
      masterSessionSourceId?: string,
      workspaceParticipantId?: string,
    ) => Promise<void>
    onLaunch?: (launch: LaunchRequest) => Promise<void>
    onAction?: (action: string, agentId: string) => Promise<void>
    onWorkspaceSettingsUpdate?: (settings: {
      restorePreviousMasterWorkers: boolean
      resumePreviousMasterSession: boolean
      saveCleanContext: boolean
      captureWebConversations: boolean
      sentinelAutoReview: boolean
      sentinelReviewAgentIds: string[]
    }) => Promise<void>
    onWorkspaceContextRequest?: (offset: number, limit: number) => Promise<unknown>
    onWorkspaceContextClear?: () => Promise<void>
    onWorkspaceActivityRequest?: (afterSequence: number, limit: number) => Promise<unknown>
    onStatusRequest?: () => Promise<any>
    onWorkspaceJoin?: (participant: {
      id: string
      provider: string
      displayName: string
      capabilities?: string[]
    }) => unknown
    onWorkspacePresence?: (presence: {
      id: string
      status: 'online' | 'busy' | 'idle' | 'offline'
      activity?: string
    }) => unknown
    onWorkspaceMessage?: (message: { id: string; text: string }) => unknown
    onSentinelChatHistory?: () => Promise<WorkspaceInstanceChatMessage[]>
    onSentinelChatEvent?: (text: string) => Promise<WorkspaceInstanceChatMessage[]>
    onSentinelChat?: (text: string) => Promise<{
      messages: WorkspaceInstanceChatMessage[]
      launchProposal?: LaunchRequest
    }>
    onSentinelSuggestion?: (text: string) => Promise<string>
    onSentinelScan?: () => Promise<unknown>
    onSentinelConversationReview?: (agentId: string) => Promise<string>
    onWorkspaceAssign?: (assignment: { participantIds: string[]; prompt: string }) => unknown
    onWorkspaceClaim?: (participantId: string) => unknown
    onWorkspaceComplete?: (completion: {
      participantId: string
      taskId: string
      response?: string
      error?: string
    }) => unknown
    onLocalPrompt?: (
      instanceId: string,
      prompt: string,
      conversationId?: string,
      expectedModel?: string,
    ) => Promise<{
      ok: boolean
      response?: string
      error?: string
      delivery?: 'submitted' | 'unknown'
      model?: string
      conversationId?: string
      responseStatus?: 'received' | 'pending'
      verificationError?: string
      durationMs: number
    }>
    onLocalConversationOpen?: (instanceId: string, conversationId: string) => Promise<{
      conversationId: string
      model: string
    }>
    onLocalAccountUpdate?: (instanceId: string, account: {
      accountLabel?: string
      accountId?: string
      conversationId?: string
    }) => unknown
    onLocalConversations?: (platformId?: string) => Promise<unknown>
    onInstanceChatHistory?: (
      instanceId: string,
      conversationId: string,
      limit: number,
    ) => Promise<WorkspaceInstanceChatMessage[]>
    onInstanceChatContext?: (instanceId: string) => Promise<{ conversationId: string }>
    onInstanceLaunchHistory?: (
      instanceId: string,
      limit: number,
    ) => Promise<WorkspaceInstanceLaunchEvent[]>
    onInstanceChatSend?: (
      instanceId: string,
      text: string,
      conversationId?: string,
      expectedModel?: string,
    ) => Promise<{
      ok: boolean
      messages?: WorkspaceInstanceChatMessage[]
      error?: string
      response?: string
      delivery?: 'submitted' | 'unknown'
      responseStatus?: 'received' | 'pending'
      model?: string
      conversationId?: string
      persistenceWarning?: string
    }>
  } = {}

  setHandlers(h: typeof this.handlers): void {
    this.handlers = { ...this.handlers, ...h }
  }

  broadcast(event: AgentEvent): void {
    if (!this.isRunning) return
    this.eventHistory.push(event)
    if (this.eventHistory.length > 500) this.eventHistory = this.eventHistory.slice(-500)
    const msg = JSON.stringify(event)
    for (const [id, c] of this.clients) {
      if (c.ws.readyState === WebSocket.OPEN) {
        try { c.ws.send(msg) } catch { this.clients.delete(id) }
      }
    }
  }

  broadcastLocal(event: AgentEvent): void {
    if (!this.isRunning) return
    const msg = JSON.stringify(event)
    for (const [id, client] of this.clients) {
      if (!client.sameOrigin || client.ws.readyState !== WebSocket.OPEN) continue
      try {
        client.ws.send(msg)
      } catch {
        this.clients.delete(id)
      }
    }
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.isRunning) { resolve(); return }

      this.httpServer = createServer((req, res) => this.handleHttp(req, res))
      this.wss = new WebSocketServer({ server: this.httpServer })

      this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
        const id = randomUUID()
        this.clients.set(id, { id, ws, connectedAt: Date.now(), sameOrigin: isSameOriginRequest(req) })

        const catchupEvents = this.eventHistory
          .filter(event => event.type !== 'agent-update' && event.type !== 'master-update')
          .slice(-50)
        const catchup = JSON.stringify({ type: 'catchup', events: catchupEvents, timestamp: Date.now() })
        ws.send(catchup)

        ws.on('message', (data: Buffer) => {
          try { this.handleWsMsg(id, JSON.parse(data.toString())) } catch { }
        })
        ws.on('close', () => this.clients.delete(id))
        ws.on('error', () => this.clients.delete(id))
      })

      this.httpServer.listen(this.port, this.host, () => {
        this.isRunning = true
        console.log('[WebUI] http://localhost:' + this.getListeningPort())
        resolve()
      })
      this.httpServer.on('error', reject)
    })
  }

  stop(): void {
    if (this.wss) { for (const [, c] of this.clients) { try { c.ws.close() } catch { } } this.wss.close() }
    if (this.httpServer) this.httpServer.close()
    this.isRunning = false
    this.clients.clear()
  }

  getListeningPort(): number {
    const address = this.httpServer?.address()
    return address && typeof address === 'object' ? address.port : this.port
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const rawUrl = req.url || '/'
    const method = req.method || 'GET'
    const parsedUrl = new URL(rawUrl, `http://${req.headers.host || 'localhost'}`)
    const pathname = parsedUrl.pathname
    const viewParam = parsedUrl.searchParams.get('view')

    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    if (pathname === '/api/launch-operations' && method === 'GET') {
      res.setHeader('Cache-Control', 'no-store')
      if (!isSameOriginReadRequest(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Launch history requires a same-origin local request.' }))
        return
      }
      const id = parsedUrl.searchParams.get('id')
      const operation = id ? this.launchOperations.get(id) : undefined
      res.writeHead(id && !operation ? 404 : 200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(id
        ? operation ? { operation } : { error: 'Launch operation not found.' }
        : { operations: this.launchOperations.list() }))
      return
    }

    if (pathname === '/' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      if (viewParam === 'canvas' && WORKSPACE_CANVAS_HTML) {
        res.end(WORKSPACE_CANVAS_HTML)
      } else {
        res.end(WORKSPACE_HTML)
      }
    } else if ((pathname === '/launchDialog.js' || pathname === '/workspaceLayout.js') && method === 'GET') {
      try {
        const dialogJs = readFileSync(join(__dirname, pathname.slice(1)), 'utf8')
        res.writeHead(200, { 'Content-Type': 'application/javascript' })
        res.end(dialogJs)
      } catch {
        res.writeHead(404)
        res.end()
      }
    } else if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', port: PORT, clients: this.clients.size }))
    } else if (pathname === '/api/workspace/activity' && method === 'GET') {
      if (!isSameOriginReadRequest(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Workspace activity requires a same-origin local Web UI request.' }))
        return
      }
      if (!this.handlers.onWorkspaceActivityRequest) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Workspace activity is not available.' }))
        return
      }
      const afterSequence = Number(parsedUrl.searchParams.get('afterSequence') ?? 0)
      const limit = Number(parsedUrl.searchParams.get('limit') ?? 100)
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 ||
        !Number.isInteger(limit) || limit < 1 || limit > 100) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'afterSequence must be non-negative and limit must be between 1 and 100.' }))
        return
      }
      void this.handlers.onWorkspaceActivityRequest(afterSequence, limit).then(activity => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(activity))
      }).catch(error => {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      })
    } else if (pathname === '/api/status' && this.handlers.onStatusRequest) {
      void this.handlers.onStatusRequest().then(s => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(s))
      }).catch(e => {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(e) }))
      })
    } else if (pathname === '/api/workspace/local-conversations' && method === 'GET') {
      if (!isSameOriginReadRequest(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Local conversation scanning requires a same-origin local request.' }))
        return
      }
      if (!this.handlers.onLocalConversations) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Local conversation scanning is not available.' }))
        return
      }
      const platformFilter = parsedUrl.searchParams.get('platform') || undefined
      void this.handlers.onLocalConversations(platformFilter).then(result => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      }).catch(error => {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      })
    } else if (pathname === '/api/workspace/sentinel-chat' && method === 'GET') {
      if (!isSameOriginReadRequest(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Sentinel chat history requires a same-origin local request.' }))
        return
      }
      if (!this.handlers.onSentinelChatHistory) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Sentinel chat history is not available.' }))
        return
      }
      void this.handlers.onSentinelChatHistory().then(messages => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ messages }))
      }).catch(error => {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      })
    } else if (pathname === '/api/workspace/instance-chat' && method === 'GET') {
      if (!isSameOriginReadRequest(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Instance chat history requires a same-origin local request.' }))
        return
      }
      const instanceId = parsedUrl.searchParams.get('instanceId')?.trim()
      const conversationId = parsedUrl.searchParams.get('conversationId')?.trim() || 'main'
      const limit = Number(parsedUrl.searchParams.get('limit') ?? 200)
      if (!instanceId || instanceId.length > 150 || conversationId.length > 200 ||
        !Number.isInteger(limit) || limit < 1 || limit > 200) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'instanceId and a valid conversationId/limit are required.' }))
        return
      }
      if (!this.handlers.onInstanceChatHistory) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Instance chat history is not available.' }))
        return
      }
      void this.handlers.onInstanceChatHistory(instanceId, conversationId, limit).then(messages => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ messages }))
      }).catch(error => {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      })
    } else if (pathname === '/api/workspace/instance-chat/context' && method === 'GET') {
      if (!isSameOriginReadRequest(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Instance chat context requires a same-origin local request.' }))
        return
      }
      const instanceId = parsedUrl.searchParams.get('instanceId')?.trim()
      if (!instanceId || instanceId.length > 150) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'A valid instanceId is required.' }))
        return
      }
      if (!this.handlers.onInstanceChatContext) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Instance chat context is not available.' }))
        return
      }
      void this.handlers.onInstanceChatContext(instanceId).then(context => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(context))
      }).catch(error => {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      })
    } else if (pathname === '/api/workspace/instance-history' && method === 'GET') {
      if (!isSameOriginReadRequest(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Instance history requires a same-origin local request.' }))
        return
      }
      const instanceId = parsedUrl.searchParams.get('instanceId')?.trim() ?? ''
      const limit = Number(parsedUrl.searchParams.get('limit') ?? 30)
      if (!instanceId || instanceId.length > 150 ||
        !Number.isInteger(limit) || limit < 1 || limit > 100) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'instanceId and a limit between 1 and 100 are required.' }))
        return
      }
      if (!this.handlers.onInstanceLaunchHistory) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Instance launch history is not available.' }))
        return
      }
      void this.handlers.onInstanceLaunchHistory(instanceId, limit).then(events => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ events }))
      }).catch(error => {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      })
    } else if (pathname.startsWith('/api/workspace/') &&
      pathname !== '/api/workspace/settings' &&
      method === 'POST') {
      if (!isSameOriginRequest(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Workspace participant requests require a same-origin local Web UI request.' }))
        return
      }
      this.readBody(req, body => {
        const fail = (statusCode: number, error: string) => {
          res.writeHead(statusCode, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error }))
        }
        const succeed = (result: unknown) => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        }
        if (pathname === '/api/workspace/instance-chat') {
          if (!this.handlers.onInstanceChatSend) {
            fail(503, 'Instance chat sending is not available.')
            return
          }
          if (typeof body.instanceId !== 'string' || !body.instanceId.trim() ||
            body.instanceId.length > 150 ||
            typeof body.text !== 'string' || !body.text.trim() || body.text.length > 8000 ||
            (body.conversationId !== undefined &&
              (typeof body.conversationId !== 'string' || !body.conversationId.trim() || body.conversationId.length > 200)) ||
            (body.expectedModel !== undefined &&
              (typeof body.expectedModel !== 'string' || body.expectedModel.length > 200))) {
            fail(400, 'instanceId, text, and optional conversationId/expectedModel are invalid.')
            return
          }
          void this.handlers.onInstanceChatSend(
            body.instanceId.trim(),
            body.text.trim(),
            typeof body.conversationId === 'string' ? body.conversationId.trim() : undefined,
            typeof body.expectedModel === 'string' ? body.expectedModel.trim() : undefined,
          ).then(result => {
            res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result))
          }).catch(error => fail(500, error instanceof Error ? error.message : String(error)))
          return
        }
        if (pathname === '/api/workspace/sentinel-scan') {
          if (!this.handlers.onSentinelScan) {
            fail(503, 'Sentinel monitoring is not available.')
            return
          }
          void this.handlers.onSentinelScan().then(succeed, error =>
            fail(500, error instanceof Error ? error.message : String(error)),
          )
          return
        }
        if (pathname === '/api/workspace/sentinel-inspect') {
          if (!this.handlers.onSentinelConversationReview) {
            fail(503, 'Sentinel conversation inspection is not available.')
            return
          }
          if (body.userConfirmed !== true || typeof body.agentId !== 'string' ||
            !body.agentId.trim() || body.agentId.length > 100) {
            fail(400, 'A registered agentId and explicit user confirmation are required.')
            return
          }
          void this.handlers.onSentinelConversationReview(body.agentId.trim()).then(
            suggestion => succeed({ suggestion }),
            error => fail(500, error instanceof Error ? error.message : String(error)),
          )
          return
        }
        if (pathname === '/api/workspace/sentinel-chat') {
          if (!this.handlers.onSentinelChat) {
            fail(503, 'Sentinel conversation is not available.')
            return
          }
          if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4000) {
            fail(400, 'text must contain between 1 and 4000 characters.')
            return
          }
          void this.handlers.onSentinelChat(body.text.trim()).then(
            result => succeed(result),
            error => fail(500, error instanceof Error ? error.message : String(error)),
          )
          return
        }
        if (pathname === '/api/workspace/sentinel-chat/event') {
          if (!this.handlers.onSentinelChatEvent) {
            fail(503, 'Sentinel chat event storage is not available.')
            return
          }
          if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 1000) {
            fail(400, 'text must contain between 1 and 1000 characters.')
            return
          }
          void this.handlers.onSentinelChatEvent(body.text.trim()).then(
            messages => succeed({ messages }),
            error => fail(500, error instanceof Error ? error.message : String(error)),
          )
          return
        }
        if (pathname === '/api/workspace/sentinel-suggestion') {
          if (!this.handlers.onSentinelSuggestion) {
            fail(503, 'Sentinel suggestions are not available.')
            return
          }
          if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4000) {
            fail(400, 'text must contain between 1 and 4000 characters.')
            return
          }
          void this.handlers.onSentinelSuggestion(body.text.trim()).then(
            suggestion => succeed({ suggestion }),
            error => fail(500, error instanceof Error ? error.message : String(error)),
          )
          return
        }
        try {
          if (pathname === '/api/workspace/join' && this.handlers.onWorkspaceJoin) {
            if (typeof body.id !== 'string' || typeof body.provider !== 'string' ||
              typeof body.displayName !== 'string' ||
              (body.capabilities !== undefined &&
                (!Array.isArray(body.capabilities) || body.capabilities.some((item: unknown) => typeof item !== 'string')))) {
              fail(400, 'id, provider, displayName, and an optional string[] capabilities are required.')
              return
            }
            succeed(this.handlers.onWorkspaceJoin({
              id: body.id,
              provider: body.provider,
              displayName: body.displayName,
              capabilities: body.capabilities,
            }))
          } else if (pathname === '/api/workspace/presence' && this.handlers.onWorkspacePresence) {
            if (typeof body.id !== 'string' ||
              !['online', 'busy', 'idle', 'offline'].includes(body.status) ||
              (body.activity !== undefined && typeof body.activity !== 'string')) {
              fail(400, 'id and a valid status are required; activity must be a string when provided.')
              return
            }
            succeed(this.handlers.onWorkspacePresence({
              id: body.id,
              status: body.status,
              activity: body.activity,
            }))
          } else if (pathname === '/api/workspace/message' && this.handlers.onWorkspaceMessage) {
            if (typeof body.id !== 'string' || typeof body.text !== 'string') {
              fail(400, 'id and text are required.')
              return
            }
            succeed(this.handlers.onWorkspaceMessage({ id: body.id, text: body.text }))
          } else if (pathname === '/api/workspace/assign' && this.handlers.onWorkspaceAssign) {
            if (!Array.isArray(body.participantIds) ||
              body.participantIds.length === 0 ||
              body.participantIds.length > 20 ||
              body.participantIds.some((id: unknown) => typeof id !== 'string') ||
              typeof body.prompt !== 'string') {
              fail(400, 'participantIds (1-20 strings) and prompt are required.')
              return
            }
            succeed(this.handlers.onWorkspaceAssign({
              participantIds: body.participantIds,
              prompt: body.prompt,
            }))
          } else if (pathname === '/api/workspace/claim' && this.handlers.onWorkspaceClaim) {
            if (typeof body.participantId !== 'string') {
              fail(400, 'participantId is required.')
              return
            }
            succeed(this.handlers.onWorkspaceClaim(body.participantId))
          } else if (pathname === '/api/workspace/complete' && this.handlers.onWorkspaceComplete) {
            if (typeof body.participantId !== 'string' || typeof body.taskId !== 'string' ||
              (body.response !== undefined && typeof body.response !== 'string') ||
              (body.error !== undefined && typeof body.error !== 'string')) {
              fail(400, 'participantId and taskId are required; response/error must be strings.')
              return
            }
            succeed(this.handlers.onWorkspaceComplete({
              participantId: body.participantId,
              taskId: body.taskId,
              response: body.response,
              error: body.error,
            }))
          } else if (pathname === '/api/workspace/local-conversation/open') {
            if (typeof body.instanceId !== 'string' || typeof body.conversationId !== 'string') {
              fail(400, 'instanceId and conversationId are required.')
              return
            }
            if (!this.handlers.onLocalConversationOpen) {
              fail(503, 'Local conversation opening is not available.')
              return
            }
            void this.handlers.onLocalConversationOpen(body.instanceId, body.conversationId).then(succeed, error =>
              fail(500, error instanceof Error ? error.message : String(error)),
            )
          } else if (pathname === '/api/workspace/local-prompt' && this.handlers.onLocalPrompt) {
            if (typeof body.instanceId !== 'string' || typeof body.prompt !== 'string' ||
              (body.conversationId !== undefined && typeof body.conversationId !== 'string')) {
              fail(400, 'instanceId and prompt are required; conversationId must be a string when provided.')
              return
            }
            if (body.expectedModel !== undefined && typeof body.expectedModel !== 'string') {
              fail(400, 'expectedModel must be a string when provided.')
              return
            }
            void this.handlers.onLocalPrompt(body.instanceId, body.prompt, body.conversationId, body.expectedModel).then(result => {
              res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify(result))
            }).catch(error => {
              fail(500, error instanceof Error ? error.message : String(error))
            })
          } else if (pathname === '/api/workspace/local-account') {
            if (typeof body.instanceId !== 'string') {
              fail(400, 'instanceId is required.')
              return
            }
            if (this.handlers.onLocalAccountUpdate) {
              try {
                succeed(this.handlers.onLocalAccountUpdate(body.instanceId, {
                  accountLabel: body.accountLabel,
                  accountId: body.accountId,
                  conversationId: body.conversationId,
                }))
              } catch (e) {
                fail(500, e instanceof Error ? e.message : String(e))
              }
            } else {
              fail(503, 'Local account update not available.')
            }
          } else {
            fail(404, 'Workspace endpoint not found')
          }
        } catch (error) {
          fail(400, error instanceof Error ? error.message : String(error))
        }
      })
    } else if (pathname === '/api/prompt' && method === 'POST') {
      this.readBody(req, (body) => {
        if (this.handlers.onPrompt && body.text) {
          if ((body.masterSessionSourceId || body.workspaceParticipantId) && !isSameOriginRequest(req)) {
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Direct Master or IDE task requests require a same-origin Web UI request.' }))
            return
          }
          void this.handlers.onPrompt(
            body.text,
            body.agentId,
            body.masterSessionSourceId,
            body.workspaceParticipantId,
          ).then(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true }))
          }).catch(e => {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: String(e) }))
          })
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'text required' }))
        }
      })
    } else if (pathname === '/api/launch' && method === 'POST') {
      if (!isSameOriginRequest(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Launch requests require a same-origin local Web UI request.' }))
        return
      }
      this.readBody(req, (body) => {
        if (this.handlers.onLaunch && typeof body.platformId === 'string') {
          if (body.target !== undefined && body.target !== 'relay' && body.target !== 'master' && body.target !== 'local') {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'target must be relay, master, or local.' }))
            return
          }
          if (body.launchCoordinator !== undefined && typeof body.launchCoordinator !== 'boolean') {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'launchCoordinator must be a boolean when provided.' }))
            return
          }
          if (body.coordinatorCount !== undefined &&
            (!Number.isInteger(body.coordinatorCount) || body.coordinatorCount < 1 || body.coordinatorCount > 19)) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'coordinatorCount must be an integer between 1 and 19.' }))
            return
          }
          if (body.coordinateTasks !== undefined && typeof body.coordinateTasks !== 'boolean') {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'coordinateTasks must be a boolean when provided.' }))
            return
          }
          if (body.orchestratorBrain !== undefined &&
            body.orchestratorBrain !== 'api' && body.orchestratorBrain !== 'web') {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'orchestratorBrain must be api or web when provided.' }))
            return
          }
          if (body.prepareSuperAssistant !== undefined && typeof body.prepareSuperAssistant !== 'boolean') {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'prepareSuperAssistant must be a boolean when provided.' }))
            return
          }
          if (body.registerAsWorkspaceWorker !== undefined &&
            typeof body.registerAsWorkspaceWorker !== 'boolean') {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'registerAsWorkspaceWorker must be a boolean when provided.' }))
            return
          }
          if (body.instances !== undefined &&
            (!Array.isArray(body.instances) || body.instances.some((instance: any) =>
              !instance || !['clean', 'authenticated', 'chrome-profile'].includes(instance.sessionMode) ||
              (instance.masterSessionSourceId !== undefined && typeof instance.masterSessionSourceId !== 'string') ||
              (instance.chromeProfileDirectory !== undefined && typeof instance.chromeProfileDirectory !== 'string')))) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'instances must contain valid session settings.' }))
            return
          }
          if (body.allowChromeProfileCopy !== undefined && typeof body.allowChromeProfileCopy !== 'boolean') {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'allowChromeProfileCopy must be a boolean when provided.' }))
            return
          }
          if (body.chromeProfileDirectory !== undefined && typeof body.chromeProfileDirectory !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'chromeProfileDirectory must be a string when provided.' }))
            return
          }
          if (body.masterSessionSourceIds !== undefined &&
            (!Array.isArray(body.masterSessionSourceIds) ||
              body.masterSessionSourceIds.some((id: unknown) => typeof id !== 'string'))) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'masterSessionSourceIds must be a string array.' }))
            return
          }
          if (parsedUrl.searchParams.get('async') === '1') {
            if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(body.requestId)) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'A valid launch request ID is required.' }))
              return
            }
            try {
              const { requestId, ...request } = body
              const handler = this.handlers.onLaunch
              const operation = this.launchOperations.start(requestId, request as LaunchRequest, handler)
              res.writeHead(202, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
              res.end(JSON.stringify({ operation }))
            } catch (error) {
              res.writeHead(409, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
            }
            return
          }
          void this.handlers.onLaunch(body as LaunchRequest).then(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true }))
          }).catch(e => {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: String(e) }))
          })
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'platformId required' }))
        }
      })
    } else if (pathname === '/api/action' && method === 'POST') {
      if (!isSameOriginRequest(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Cross-origin action requests are not allowed.' }))
        return
      }
      this.readBody(req, (body) => {
        if (this.handlers.onAction && body.action && body.agentId) {
          void this.handlers.onAction(body.action, body.agentId).then(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true }))
          }).catch(e => {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: String(e) }))
          })
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'action and agentId required' }))
        }
      })
    } else if (pathname === '/api/workspace/context' && method === 'GET') {
      if (!isSameOriginReadRequest(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Workspace context requires a same-origin local Web UI request.' }))
        return
      }
      if (!this.handlers.onWorkspaceContextRequest) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Workspace context is unavailable.' }))
        return
      }
      const offset = Number(parsedUrl.searchParams.get('offset') ?? 0)
      const limit = Number(parsedUrl.searchParams.get('limit') ?? 25)
      if (!Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(limit) || limit < 1) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'offset must be non-negative and limit must be positive integers.' }))
        return
      }
      void this.handlers.onWorkspaceContextRequest(offset, limit).then(context => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(context))
      }).catch(error => {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(error) }))
      })
    } else if (pathname === '/api/workspace/context' && method === 'DELETE') {
      if (!isSameOriginRequest(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Workspace context deletion requires a same-origin local Web UI request.' }))
        return
      }
      if (!this.handlers.onWorkspaceContextClear) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Workspace context deletion is unavailable.' }))
        return
      }
      void this.handlers.onWorkspaceContextClear().then(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      }).catch(error => {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(error) }))
      })
    } else if (pathname === '/api/workspace/settings' && method === 'POST') {
      if (!isSameOriginRequest(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Workspace settings require a same-origin local Web UI request.' }))
        return
      }
      this.readBody(req, body => {
        if (
          typeof body.restorePreviousMasterWorkers !== 'boolean' ||
          typeof body.resumePreviousMasterSession !== 'boolean' ||
          typeof body.saveCleanContext !== 'boolean' ||
          typeof body.captureWebConversations !== 'boolean' ||
          typeof body.sentinelAutoReview !== 'boolean' ||
          !Array.isArray(body.sentinelReviewAgentIds) ||
          body.sentinelReviewAgentIds.length > 100 ||
          body.sentinelReviewAgentIds.some((id: unknown) => typeof id !== 'string' || !id.trim())
        ) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            error: 'Workspace settings require valid booleans and a bounded sentinelReviewAgentIds string array.',
          }))
          return
        }
        if (!this.handlers.onWorkspaceSettingsUpdate) {
          res.writeHead(503, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Workspace settings are unavailable.' }))
          return
        }
        void this.handlers.onWorkspaceSettingsUpdate({
          restorePreviousMasterWorkers: body.restorePreviousMasterWorkers,
          resumePreviousMasterSession: body.resumePreviousMasterSession,
          saveCleanContext: body.saveCleanContext,
          captureWebConversations: body.captureWebConversations,
          sentinelAutoReview: body.sentinelAutoReview,
          sentinelReviewAgentIds: [...new Set(body.sentinelReviewAgentIds as string[])],
        }).then(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        }).catch(error => {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: String(error) }))
        })
      })
    } else if (pathname === '/api/canvas') {
      // Collaboration overwrite space — read by workspace UI
      import('../collaboration/CollaborationStore.js').then(({ collaborationStore }) => {
        const response = {
          snapshot: collaborationStore.getSnapshot(),
          findings: collaborationStore.getFindings(),
          pendingRequests: collaborationStore.getPendingRequests(),
          openIssues: collaborationStore.getOpenIssues(),
          convergence: collaborationStore.getConvergence(),
          divergence: collaborationStore.getDivergence(),
          entries: collaborationStore.getAll(),
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(response))
      }).catch((e) => {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(e) }))
      })
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
    }
  }

  private readBody(req: IncomingMessage, cb: (body: any) => void): void {
    let data = ''
    req.on('data', (c: Buffer) => { data += c.toString() })
    req.on('end', () => {
      try { cb(JSON.parse(data)) } catch { cb({}) }
    })
  }

  private handleWsMsg(clientId: string, msg: any): void {
    switch (msg.type) {
      case 'prompt':
        if (this.handlers.onPrompt && msg.text) {
          const client = this.clients.get(clientId)
          if ((msg.masterSessionSourceId || msg.workspaceParticipantId) && !client?.sameOrigin) {
            client?.ws.send(JSON.stringify({
              type: 'conversation',
              timestamp: Date.now(),
              data: { role: 'sentinel', text: '✗ Direct Master and IDE task requests are accepted only from the same-origin Web UI.' },
            }))
            return
          }
          void this.handlers.onPrompt(msg.text, msg.agentId, msg.masterSessionSourceId, msg.workspaceParticipantId)
        }
        break
      case 'launch':
        if (this.handlers.onLaunch && typeof msg.platformId === 'string') {
          const client = this.clients.get(clientId)
          if (msg.coordinateTasks !== undefined && typeof msg.coordinateTasks !== 'boolean') {
            client?.ws.send(JSON.stringify({
              type: 'conversation',
              timestamp: Date.now(),
              data: { role: 'sentinel', text: '✗ Launch failed: coordinateTasks must be a boolean when provided.' },
            }))
            break
          }
          if (msg.orchestratorBrain !== undefined &&
            msg.orchestratorBrain !== 'api' && msg.orchestratorBrain !== 'web') {
            client?.ws.send(JSON.stringify({
              type: 'conversation',
              timestamp: Date.now(),
              data: { role: 'sentinel', text: '✗ Launch failed: orchestratorBrain must be api or web when provided.' },
            }))
            break
          }
          if (msg.launchCoordinator !== undefined && typeof msg.launchCoordinator !== 'boolean') {
            client?.ws.send(JSON.stringify({
              type: 'conversation',
              timestamp: Date.now(),
              data: { role: 'sentinel', text: '✗ Launch failed: launchCoordinator must be a boolean when provided.' },
            }))
            break
          }
          if (msg.coordinatorCount !== undefined &&
            (!Number.isInteger(msg.coordinatorCount) || msg.coordinatorCount < 1 || msg.coordinatorCount > 19)) {
            client?.ws.send(JSON.stringify({
              type: 'conversation',
              timestamp: Date.now(),
              data: { role: 'sentinel', text: '✗ Launch failed: coordinatorCount must be an integer between 1 and 19.' },
            }))
            break
          }
          if (msg.registerAsWorkspaceWorker !== undefined &&
            typeof msg.registerAsWorkspaceWorker !== 'boolean') {
            client?.ws.send(JSON.stringify({
              type: 'conversation',
              timestamp: Date.now(),
              data: { role: 'sentinel', text: '✗ Launch failed: registerAsWorkspaceWorker must be a boolean when provided.' },
            }))
            break
          }
          void this.handlers.onLaunch(msg as LaunchRequest).catch(error => {
            const client = this.clients.get(clientId)
            client?.ws.send(JSON.stringify({
              type: 'conversation',
              timestamp: Date.now(),
              data: { role: 'sentinel', text: '✗ Launch failed: ' + String(error) },
            }))
          })
        }
        break
      case 'action':
        if (this.handlers.onAction && msg.action && msg.agentId) {
          void this.handlers.onAction(msg.action, msg.agentId).catch(error => {
            const client = this.clients.get(clientId)
            client?.ws.send(JSON.stringify({
              type: 'conversation',
              timestamp: Date.now(),
              data: { role: 'sentinel', text: '✗ Action failed: ' + String(error) },
            }))
          })
        }
        break
      case 'ping':
        const c = this.clients.get(clientId)
        if (c) c.ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }))
        break
    }
  }
}

export function getWebUIPort(): number {
  return PORT
}

let instance: WebUIServer | null = null
export function getWebUIServer(): WebUIServer {
  if (!instance) instance = new WebUIServer(PORT, HOST, join(process.cwd(), '.openmcp', 'workspace-launches'))
  return instance
}