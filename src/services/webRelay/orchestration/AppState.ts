/**
 * AppState — Pure projection and presentation-orchestration state store for OpenMCPWEBLOCK.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCHITECTURAL ROLE & INVARIANTS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. DIRECTION OF DATA FLOW (Strict Single-Direction Layering):
 *
 *      WebInstanceRegistry / ChromeCDP
 *                    │
 *                    ▼
 *            MultiAgentRunner
 *                    │
 *                    ▼
 *                Sentinel
 *                    │
 *                    ▼
 *                RelayBus
 *                    │
 *                    ▼
 *                AppState
 *                    │
 *                    ▼
 *              future TUI
 *
 * 2. STRICT BOUNDARY:
 *    AppState NEVER directly touches:
 *      - ChromeCDP
 *      - WebInstanceRegistry
 *      - ExecutionRegistry
 *      - fetch() to MCP or endpoints
 *      - Sentinel.scan()
 *      - Chrome process APIs
 *    ALL interaction MUST go exclusively through RelayBus.
 *
 * 3. NO POLLING:
 *    AppState does NOT run interval polling to update the UI.
 *    It hydrates once via initial read-only queries, and thereafter updates
 *    strictly reactively in response to events flowing through RelayBus.
 *
 * 4. PURE PROJECTION REDUCER:
 *    State changes are applied through an explicit, auditable reducer function:
 *      applyEvent(state, event) -> newState
 *    making it trivial to know which event produced any given state change.
 *
 * 5. SEPARATION OF CONCERNS:
 *    - AgentState (lifecycle, instance binding, debug port) is never mixed
 *      with ExecutionSnapshot (execution outcome, tool results).
 *    - Sentinel events (e.g. instance:lost) are treated as authoritative facts;
 *      AppState never attempts to re-diagnose or guess instance death.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type {
  AgentState,
  AgentSessionMode,
  ExecutionSnapshot,
  EventEntry,
  SystemHealth,
  SentinelActivitySnapshot,
  SentinelConversationSnapshot,
  SentinelScanResult,
  OrchestratorEvent,
  Command,
  AgentRecoveryResult,
  AgentRecoveryPurpose,
} from './types.js'

import {
  RelayBus,
  relayBus as defaultRelayBus,
} from './RelayBus.js'

// ─── AppState Types ──────────────────────────────────────────────────────────

export interface AppStateData {
  /** Map of registered agents keyed by agentId. */
  agents: Record<string, AgentState>
  /** Map of execution snapshots keyed by executionId. */
  executions: Record<string, ExecutionSnapshot>
  /** ID of the currently selected agent in the UI. */
  selectedAgentId: string | null
  /** Latest scan result from Sentinel (read-only cached). */
  sentinel: SentinelScanResult | null
  /** Current system-wide health snapshot. */
  systemHealth: SystemHealth | null
  /** Ring buffer of recent orchestrator events. */
  events: EventEntry[]
  /** Maximum number of events retained in memory. */
  maxEvents: number
  /** Most recent error message. */
  lastError: string | null
  /** Timestamp when state was last initialized or hydrated. */
  lastHydratedAt: number | null
}

export type AppStateListener = (state: AppStateData) => void

/**
 * Create initial empty state data.
 */
export function createInitialAppStateData(maxEvents = 200): AppStateData {
  return {
    agents: {},
    executions: {},
    selectedAgentId: null,
    sentinel: null,
    systemHealth: null,
    events: [],
    maxEvents,
    lastError: null,
    lastHydratedAt: null,
  }
}

// ─── Pure Event Reducer ──────────────────────────────────────────────────────

let eventCounter = 0

/**
 * Pure projection reducer. Applies an incoming OrchestratorEvent to the state
 * and returns the updated state.
 *
 * Answering: "Which event produced this state change?" is directly traceable here.
 */
export function applyEvent(
  state: AppStateData,
  event: OrchestratorEvent,
  timestamp = Date.now(),
): AppStateData {
  eventCounter++
  const eventId = `ev-${timestamp}-${eventCounter}`

  // 1. Build an auditable EventEntry for the ring buffer
  const entry: EventEntry = {
    id: eventId,
    timestamp,
    name: event.name,
    severity: 'severity' in event.payload ? event.payload.severity : undefined,
    code: 'code' in event.payload ? event.payload.code : undefined,
    agentId: 'agentId' in event.payload ? (event.payload as any).agentId : undefined,
    instanceId: 'instanceId' in event.payload ? (event.payload as any).instanceId : undefined,
    executionId: 'executionId' in event.payload ? (event.payload as any).executionId : undefined,
    detail: 'message' in event.payload ? (event.payload as any).message :
            'error' in event.payload ? (event.payload as any).error :
            'reason' in event.payload ? (event.payload as any).reason :
            'to' in event.payload ? `to: ${(event.payload as any).to}` : undefined,
  }

  // Ring buffer eviction
  const nextEvents = [entry, ...state.events]
  if (nextEvents.length > state.maxEvents) {
    nextEvents.length = state.maxEvents
  }

  const nextAgents = { ...state.agents }
  const nextExecutions = { ...state.executions }
  let nextLastError = state.lastError
  let nextSentinel = state.sentinel ? { ...state.sentinel } : null

  switch (event.name) {
    case 'agent:created': {
      const { agentId, platformId, role, sessionMode, masterSessionSourceId } = event.payload
      const existing = nextAgents[agentId]
      nextAgents[agentId] = existing
        ? {
            ...existing,
            role: role ?? existing.role,
            sessionMode: sessionMode ?? existing.sessionMode,
            masterSessionSourceId: masterSessionSourceId ?? existing.masterSessionSourceId,
          }
        : {
            agentId,
            platformId,
            role,
            sessionMode,
            masterSessionSourceId,
            status: 'created',
            activeExecutions: 0,
            unknownExecutions: 0,
            createdAt: timestamp,
          }
      break
    }

    case 'instance:bound': {
      const { agentId, instanceId, debugPort } = event.payload
      const current = nextAgents[agentId]
      if (current) {
        nextAgents[agentId] = {
          ...current,
          instanceId,
          debugPort,
        }
      }
      break
    }

    case 'agent:lifecycle': {
      const { agentId, to, error } = event.payload
      const current = nextAgents[agentId]
      if (current) {
        nextAgents[agentId] = {
          ...current,
          status: to,
          error: error ?? (to === 'error' ? current.error : undefined),
        }
      }
      if (error) {
        nextLastError = error
      }
      break
    }

    case 'agent:stopped': {
      const { agentId } = event.payload
      const current = nextAgents[agentId]
      if (current) {
        nextAgents[agentId] = {
          ...current,
          status: 'stopped',
          instanceId: undefined,
          debugPort: undefined,
        }
      }
      break
    }

    case 'agent:error': {
      const { agentId, error } = event.payload
      const current = nextAgents[agentId]
      if (current) {
        nextAgents[agentId] = {
          ...current,
          status: 'error',
          error,
        }
      }
      nextLastError = error
      break
    }

    case 'instance:lost': {
      const { agentId, instanceId } = event.payload
      // Target agent explicitly, or match by instanceId
      const targetId = agentId ?? Object.values(nextAgents).find(a => a.instanceId === instanceId)?.agentId
      if (targetId && nextAgents[targetId]) {
        nextAgents[targetId] = {
          ...nextAgents[targetId],
          status: 'lost',
        }
      }
      break
    }

    case 'sentinel:heartbeat': {
      const { agentId, alive } = event.payload
      const current = nextAgents[agentId]
      if (current && alive) {
        nextAgents[agentId] = {
          ...current,
          lastHeartbeat: timestamp,
        }
      }
      break
    }

    case 'sentinel:scan': {
      const { agentsChecked, issuesFound, healthy, scannedAt, details, logs } = event.payload
      nextSentinel = {
        healthy: healthy ?? (issuesFound === 0),
        agentsChecked,
        issuesFound,
        ...(scannedAt === undefined ? {} : { scannedAt }),
        details: details ?? nextSentinel?.details ?? [],
        logs: logs ?? nextSentinel?.logs ?? [],
      }
      break
    }

    case 'sentinel:log': {
      if (nextSentinel) {
        nextSentinel = {
          ...nextSentinel,
          logs: [event.payload, ...(nextSentinel.logs ?? [])].slice(0, 200),
        }
      }
      break
    }

    case 'execution:update': {
      const { agentId, executionId, status } = event.payload
      nextExecutions[executionId] = {
        ...nextExecutions[executionId],
        executionId,
        agentId,
        status,
      }
      // Recompute active executions count for this agent
      const currentAgent = nextAgents[agentId]
      if (currentAgent) {
        const activeCount = Object.values(nextExecutions).filter(
          e => e.agentId === agentId && (e.status === 'running'),
        ).length
        nextAgents[agentId] = {
          ...currentAgent,
          activeExecutions: activeCount,
        }
      }
      break
    }

    case 'execution:unknown': {
      const { agentId, executionId, reason } = event.payload
      nextExecutions[executionId] = {
        ...nextExecutions[executionId],
        executionId,
        agentId,
        status: 'unknown',
        unknownOutcome: true,
        unknownReason: reason,
      }
      const currentAgent = nextAgents[agentId]
      if (currentAgent) {
        const unknownCount = Object.values(nextExecutions).filter(
          e => e.agentId === agentId && e.unknownOutcome && !e.unknownAcknowledgedAt,
        ).length
        nextAgents[agentId] = {
          ...currentAgent,
          unknownExecutions: unknownCount,
        }
      }
      break
    }

    default:
      // Unknown events pass through to ring buffer without mutating domain projections
      break
  }

  return {
    ...state,
    agents: nextAgents,
    executions: nextExecutions,
    events: nextEvents,
    lastError: nextLastError,
    sentinel: nextSentinel,
  }
}

// ─── AppState Store Class ────────────────────────────────────────────────────

export interface AppStateOptions {
  bus?: RelayBus
  initialState?: Partial<AppStateData>
  maxEvents?: number
  autoInit?: boolean
}

export class AppState {
  private bus: RelayBus
  private state: AppStateData
  private listeners = new Set<AppStateListener>()
  private unsubBus: (() => void) | null = null

  // Reconciliation tracking: records timestamp of most recent event applied per agent.
  // Prevents slow initial queries from overwriting fresher event-driven state.
  private agentLastEventTime = new Map<string, number>()
  private initPromise: Promise<void> | null = null
  private isInitialized = false

  constructor(options?: AppStateOptions) {
    this.bus = options?.bus ?? defaultRelayBus
    this.state = {
      ...createInitialAppStateData(options?.maxEvents ?? 200),
      ...options?.initialState,
    }

    // Immediately attach bus listener so no events are ever missed from creation
    this.attachBus()

    if (options?.autoInit !== false) {
      void this.init()
    }
  }

  /**
   * Initialize AppState:
   * 1. Idempotent: safe against concurrent or repeated invocations.
   * 2. Immediately subscribe to RelayBus so no in-flight events are missed.
   * 3. Perform initial read-only queries to hydrate existing state without side-effects.
   * 4. Reconcile query responses safely against any events that arrived during query execution.
   */
  public async init(): Promise<void> {
    if (this.isInitialized) return
    if (this.initPromise) return this.initPromise
    this.attachBus()
    this.initPromise = (async () => {
      try {
        await this.hydrate()
        this.isInitialized = true
      } finally {
        this.initPromise = null
      }
    })()
    return this.initPromise
  }

  /**
   * Attach listener to RelayBus events.
   */
  private attachBus(): void {
    if (this.unsubBus) return
    this.unsubBus = this.bus.subscribe(event => {
      this.handleEvent(event)
    })
  }

  /**
   * Execute initial read-only queries and hydrate state without creating side-effects.
   */
  public async hydrate(): Promise<void> {
    const hydrationStartTime = Date.now()

    try {
      const [agentList, sentinelStatus, systemHealth] = await Promise.all([
        this.bus.query({ type: 'query', name: 'agent:list' }),
        this.bus.query({ type: 'query', name: 'sentinel:status' }),
        this.bus.query({ type: 'query', name: 'system:health' }),
      ])

      // Reconcile agents: do not overwrite an agent if a newer event already updated it
      const nextAgents = { ...this.state.agents }
      for (const hydratedAgent of agentList) {
        const lastEventAt = this.agentLastEventTime.get(hydratedAgent.agentId) ?? 0
        if (lastEventAt >= hydrationStartTime) {
          // An event arrived while query was in-flight — retain the fresher event state
          continue
        }
        nextAgents[hydratedAgent.agentId] = { ...hydratedAgent }
      }

      this.state = {
        ...this.state,
        agents: nextAgents,
        sentinel: sentinelStatus ?? this.state.sentinel,
        systemHealth: systemHealth ?? this.state.systemHealth,
        lastHydratedAt: Date.now(),
      }

      // If an agent exists and none is selected, select the first
      if (!this.state.selectedAgentId && agentList.length > 0) {
        this.state.selectedAgentId = agentList[0]!.agentId
      }

      this.notify()
    } catch (err: any) {
      this.state.lastError = `Hydration failed: ${err.message}`
      this.notify()
    }
  }

  /**
   * Ingest an event from RelayBus, apply the pure reducer, and notify UI listeners.
   */
  private handleEvent(event: OrchestratorEvent): void {
    const now = Date.now()

    // Track reconciliation timestamp if event is agent-scoped
    if ('agentId' in event.payload && (event.payload as any).agentId) {
      this.agentLastEventTime.set((event.payload as any).agentId, now)
    }

    this.state = applyEvent(this.state, event, now)
    this.notify()
  }

  /**
   * Notify all registered UI listeners.
   */
  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.state)
      } catch (err) {
        console.error('[AppState] Listener error:', err)
      }
    }
  }

  // ─── Public Queries & Getters (Read-Only) ───────────────────────────────────

  public getState(): AppStateData {
    return this.state
  }

  public getAgent(agentId: string): AgentState | null {
    return this.state.agents[agentId] ?? null
  }

  public listAgents(): AgentState[] {
    return Object.values(this.state.agents)
  }

  public getSelectedAgent(): AgentState | null {
    if (!this.state.selectedAgentId) return null
    return this.state.agents[this.state.selectedAgentId] ?? null
  }

  public getSelectedAgentId(): string | null {
    return this.state.selectedAgentId
  }

  public getSentinelStatus(): SentinelScanResult | null {
    return this.state.sentinel
  }

  public getSystemHealth(): SystemHealth | null {
    return this.state.systemHealth
  }

  public getRecentEvents(limit?: number): EventEntry[] {
    if (!limit) return this.state.events
    return this.state.events.slice(0, limit)
  }

  public getLastError(): string | null {
    return this.state.lastError
  }

  public getExecution(executionId: string): ExecutionSnapshot | null {
    return this.state.executions[executionId] ?? null
  }

  public listExecutions(agentId?: string): ExecutionSnapshot[] {
    const all = Object.values(this.state.executions)
    if (!agentId) return all
    return all.filter(e => e.agentId === agentId)
  }

  // ─── UI Actions (Local State) ──────────────────────────────────────────────

  public selectAgent(agentId: string | null): void {
    if (agentId !== null && !this.state.agents[agentId]) {
      // Allow selection of registered agents or null
      return
    }
    this.state = {
      ...this.state,
      selectedAgentId: agentId,
    }
    this.notify()
  }

  public clearLastError(): void {
    this.state = {
      ...this.state,
      lastError: null,
    }
    this.notify()
  }

  // ─── Commands (Dispatched Strictly via RelayBus) ───────────────────────────

  public async startAgent(
    agentId: string,
    platformId: string,
    role?: string,
    sessionMode?: AgentSessionMode,
    masterSessionSourceId?: string,
    chromeProfileDirectory?: string,
  ): Promise<AgentState> {
    const result = await this.bus.send({
      type: 'command',
      name: 'agent:start',
      payload: {
        agentId,
        platformId,
        ...(role ? { role } : {}),
        ...(sessionMode ? { sessionMode } : {}),
        ...(masterSessionSourceId ? { masterSessionSourceId } : {}),
        ...(chromeProfileDirectory ? { chromeProfileDirectory } : {}),
      },
    })
    return result as AgentState
  }

  public async recoverExistingAgents(
    platformId: string,
    sessionMode: AgentSessionMode,
    purpose: AgentRecoveryPurpose,
  ): Promise<AgentRecoveryResult> {
    return this.bus.send({
      type: 'command',
      name: 'agent:recover-existing',
      payload: { platformId, sessionMode, purpose },
    })
  }

  public async stopAgent(agentId: string): Promise<AgentState> {
    const result = await this.bus.send({
      type: 'command',
      name: 'agent:stop',
      payload: { agentId },
    })
    return result as AgentState
  }

  public async restartAgent(agentId: string): Promise<AgentState> {
    const result = await this.bus.send({
      type: 'command',
      name: 'agent:restart',
      payload: { agentId },
    })
    return result as AgentState
  }

  public async scanSentinel(): Promise<SentinelScanResult> {
    return this.bus.query({ type: 'query', name: 'sentinel:scan' })
  }

  public async readSentinelActivity(agentId: string): Promise<SentinelActivitySnapshot> {
    return this.bus.query({
      type: 'query',
      name: 'sentinel:activity',
      payload: { agentId },
    })
  }

  public async readSentinelConversation(agentId: string): Promise<SentinelConversationSnapshot> {
    return this.bus.query({
      type: 'query',
      name: 'sentinel:conversation',
      payload: { agentId },
    })
  }

  public async removeAgent(agentId: string): Promise<void> {
    await this.bus.send({
      type: 'command',
      name: 'agent:remove',
      payload: { agentId },
    })

    // Optimistically or reactively update selection if removed agent was selected
    if (this.state.selectedAgentId === agentId) {
      this.state.selectedAgentId = null
      this.notify()
    }
  }

  public async acknowledgeUnknown(executionId: string, agentId: string): Promise<void> {
    await this.bus.send({
      type: 'command',
      name: 'execution:acknowledge-unknown',
      payload: { executionId, agentId },
    })
  }

  /**
   * Generic command dispatcher through RelayBus.
   */
  public async send<C extends Command>(command: C): Promise<any> {
    return this.bus.send(command)
  }

  // ─── Subscriptions & Teardown ──────────────────────────────────────────────

  public subscribe(listener: AppStateListener): () => void {
    this.listeners.add(listener)
    // Immediately publish current state upon subscription
    try {
      listener(this.state)
    } catch (err) {
      console.error('[AppState] Initial subscription listener error:', err)
    }
    return () => {
      this.listeners.delete(listener)
    }
  }

  public destroy(): void {
    if (this.unsubBus) {
      this.unsubBus()
      this.unsubBus = null
    }
    this.listeners.clear()
    this.agentLastEventTime.clear()
    this.isInitialized = false
    this.initPromise = null
  }
}

/**
 * Canonical singleton instance for the interactive TUI session.
 * Created with autoInit: false so that it can be explicitly hydrated
 * once at application bootstrap.
 */
export const orchestrationAppState = new AppState({ autoInit: false })
