/**
 * contracts.ts — Minimal implementation of V5 contracts for testing.
 * This is TEST infrastructure, not production code.
 * 
 * Implements just enough of CanonicalEvent, EventStore, and TaskState
 * to exercise the 10 fixtures of Puerta 5.
 */

// ─── CanonicalEvent (from V5 §1) ─────────────────────────────────────────────

export type EventSource = 'relaybus' | 'activitystore' | 'coordinator' | 'user'

export interface CanonicalEvent {
  eventId: string
  schemaVersion: string
  source: EventSource
  eventName: string
  timestamp: number
  taskId?: string
  agentId?: string
  executionId?: string
  causationId?: string
  actor: 'user' | 'system' | 'agent' | 'sentinel'
  sequence: number
  payload: unknown
}

// ─── TaskState (from V5 §5) ─────────────────────────────────────────────────

export interface TaskState {
  taskId: string
  prompt: string
  status: 'pending' | 'running' | 'complete' | 'partial' | 'failed' | 'incomplete'
  startedAt: number
  updatedAt: number
  coordinator?: { agentId: string; status: string }
  workers: Array<{
    agentId: string
    status: string
    task?: string
    response?: string
    error?: string
  }>
  attention: AttentionItem[]
  automation: {
    mcp: boolean
    autoInsert: boolean
    autoSubmit: boolean
    autoExecute: boolean
  }
  result?: string
  evidence: Array<{
    executionId: string
    agentId: string
    timestamp: number
    summary: string
  }>
  errors: Array<{
    agentId: string
    phase: string
    message: string
    timestamp: number
  }>
  potentiallyIncomplete?: boolean
}

// ─── AttentionItem (from V5 §4) ─────────────────────────────────────────────

export type AttentionLifecycle =
  | 'detected'
  | 'acknowledged'
  | 'action-required'
  | 'in-progress'
  | 'resolved'
  | 'expired'

export type AttentionAction =
  | 'investigate' | 'retry' | 'stop' | 'recover'
  | 'approve' | 'deny' | 'ignore' | 'escalate'

export interface AttentionItem {
  attentionId: string
  eventId: string
  lifecycle: AttentionLifecycle
  title: string
  description: string
  agentId?: string
  taskId?: string
  availableActions: AttentionAction[]
  history: Array<{
    at: number
    from: AttentionLifecycle
    to: AttentionLifecycle
    by: 'user' | 'system' | 'agent'
    action?: AttentionAction
  }>
}

// ─── EventStore (minimal reducer for testing) ──────────────────────────────

export interface EventStoreState {
  tasks: Map<string, TaskState>
  agents: Map<string, { agentId: string; status: string; platformId?: string }>
  attention: Map<string, AttentionItem>
  unknownEvents: Array<{ eventId: string; eventName: string; schemaVersion: string; reason: string }>
  deduplicatedEvents: Array<{ eventId: string; count: number }>
  truncationWarnings: Array<{ line: number; partial: string }>
  sequenceGaps: Array<{ source: string; missing: number[] }>
}

export function createEmptyEventStoreState(): EventStoreState {
  return {
    tasks: new Map(),
    agents: new Map(),
    attention: new Map(),
    unknownEvents: [],
    deduplicatedEvents: [],
    truncationWarnings: [],
    sequenceGaps: [],
  }
}

/**
 * Parse a JSONL string into events.
 * Handles truncation (ignores incomplete last line).
 */
export function parseEventsJsonl(jsonl: string): { events: CanonicalEvent[]; warnings: Array<{ line: number; partial: string }> } {
  const lines = jsonl.split('\n').filter(l => l.trim().length > 0)
  const events: CanonicalEvent[] = []
  const warnings: Array<{ line: number; partial: string }> = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    try {
      const parsed = JSON.parse(line) as CanonicalEvent
      // Basic validation
      if (!parsed.eventId || !parsed.eventName || typeof parsed.timestamp !== 'number') {
        warnings.push({ line: i + 1, partial: line.substring(0, 50) })
        continue
      }
      events.push(parsed)
    } catch {
      // Incomplete or malformed line — record warning, don't crash
      warnings.push({ line: i + 1, partial: line.substring(0, 50) })
    }
  }

  return { events, warnings }
}

/**
 * Reorder events according to the V5 contract:
 * 1. Group by source
 * 2. Within each source: sort by sequence
 * 3. Between sources: sort by timestamp
 * 4. Ties: sort by eventId (deterministic)
 */
export function reorderEvents(events: CanonicalEvent[]): CanonicalEvent[] {
  // Group by source
  const bySource = new Map<string, CanonicalEvent[]>()
  for (const ev of events) {
    const list = bySource.get(ev.source) ?? []
    list.push(ev)
    bySource.set(ev.source, list)
  }

  // Sort within each source by sequence
  for (const [source, list] of bySource) {
    list.sort((a, b) => a.sequence - b.sequence)
    // Detect sequence gaps
    const sequences = list.map(e => e.sequence)
    const gaps: number[] = []
    for (let i = 1; i < sequences.length; i++) {
      const expected = sequences[i - 1] + 1
      if (sequences[i] > expected) {
        for (let gap = expected; gap < sequences[i]; gap++) {
          gaps.push(gap)
        }
      }
    }
    // Note: gaps are detected but events are still processed
  }

  // Flatten with inter-source ordering by timestamp
  const result: CanonicalEvent[] = []
  const iterators = new Map<string, CanonicalEvent[]>()
  for (const [source, list] of bySource) {
    iterators.set(source, [...list]) // copy
  }

  // Merge sort by timestamp across sources
  while (true) {
    let earliest: { source: string; event: CanonicalEvent } | null = null
    for (const [source, list] of iterators) {
      if (list.length > 0) {
        const candidate = list[0]
        if (!earliest || candidate.timestamp < earliest.event.timestamp ||
            (candidate.timestamp === earliest.event.timestamp && candidate.eventId < earliest.event.eventId)) {
          earliest = { source, event: candidate }
        }
      }
    }
    if (!earliest) break
    result.push(earliest.event)
    const list = iterators.get(earliest.source)
    if (list) list.shift()
  }

  return result
}

/**
 * Reduce events to state. This is the core contract being tested.
 */
export function reduceEvents(events: CanonicalEvent[]): EventStoreState {
  const state = createEmptyEventStoreState()
  const processed = new Set<string>() // for dedup

  // First: reorder according to contract
  const ordered = reorderEvents(events)

  for (const ev of ordered) {
    // Dedup check
    if (processed.has(ev.eventId)) {
      const existing = state.deduplicatedEvents.find(d => d.eventId === ev.eventId)
      if (existing) {
        existing.count++
      } else {
        state.deduplicatedEvents.push({ eventId: ev.eventId, count: 2 })
      }
      continue // Skip duplicate
    }
    processed.add(ev.eventId)

    // Schema version check
    if (ev.schemaVersion !== '1') {
      state.unknownEvents.push({
        eventId: ev.eventId,
        eventName: ev.eventName,
        schemaVersion: ev.schemaVersion,
        reason: 'unknown-schemaVersion',
      })
      continue
    }

    // Guard: null/undefined payload — record but don't process
    if (ev.payload === null || ev.payload === undefined) {
      state.unknownEvents.push({
        eventId: ev.eventId,
        eventName: ev.eventName,
        schemaVersion: ev.schemaVersion,
        reason: 'null-payload',
      })
      continue
    }

    // Guard: non-object payload (string, number, etc.)
    if (typeof ev.payload !== 'object') {
      state.unknownEvents.push({
        eventId: ev.eventId,
        eventName: ev.eventName,
        schemaVersion: ev.schemaVersion,
        reason: 'invalid-payload-type',
      })
      continue
    }

    // Dispatch by eventName
    switch (ev.eventName) {
      case 'agent:created': {
        const p = ev.payload as { agentId: string; platformId: string }
        if (!p.agentId) continue // Malformed: missing required field
        state.agents.set(p.agentId, {
          agentId: p.agentId,
          status: 'created',
          platformId: p.platformId,
        })
        break
      }

      case 'agent:lifecycle': {
        const p = ev.payload as { agentId: string; from: string; to: string; error?: string }
        const agent = state.agents.get(p.agentId)
        if (agent) {
          agent.status = p.to
        }
        break
      }

      case 'agent:error': {
        const p = ev.payload as { agentId: string; error: string; phase?: string }
        const agent = state.agents.get(p.agentId)
        if (agent) {
          agent.status = 'error'
        }
        break
      }

      case 'task:started': {
        const p = ev.payload as { prompt: string }
        if (ev.taskId) {
          const task: TaskState = {
            taskId: ev.taskId,
            prompt: p.prompt,
            status: 'running',
            startedAt: ev.timestamp,
            updatedAt: ev.timestamp,
            workers: [],
            attention: [],
            automation: { mcp: true, autoInsert: true, autoSubmit: true, autoExecute: true },
            evidence: [],
            errors: [],
          }
          state.tasks.set(ev.taskId, task)
        }
        break
      }

      case 'task:finished': {
        const p = ev.payload as { result?: string; partial?: boolean; error?: string }
        if (ev.taskId) {
          const task = state.tasks.get(ev.taskId)
          if (task) {
            if (p.error) {
              task.status = 'failed'
            } else if (p.partial) {
              task.status = 'partial'
            } else {
              task.status = 'complete'
            }
            task.result = p.result
            task.updatedAt = ev.timestamp
          }
        }
        break
      }

      case 'worker:started': {
        const p = ev.payload as { prompt: string }
        if (ev.taskId && ev.agentId) {
          const task = state.tasks.get(ev.taskId)
          if (task) {
            task.workers.push({
              agentId: ev.agentId,
              status: 'working',
              task: p.prompt,
            })
            task.updatedAt = ev.timestamp
          }
        }
        break
      }

      case 'worker:responded': {
        const p = ev.payload as { response: string }
        if (ev.taskId && ev.agentId) {
          const task = state.tasks.get(ev.taskId)
          if (task) {
            const worker = task.workers.find(w => w.agentId === ev.agentId)
            if (worker) {
              worker.status = 'complete'
              worker.response = p.response
            }
            task.updatedAt = ev.timestamp
          }
        }
        break
      }

      case 'execution:unknown': {
        const p = ev.payload as { reason: string }
        if (ev.taskId && ev.agentId) {
          const attentionId = `att-${ev.eventId}`
          const item: AttentionItem = {
            attentionId,
            eventId: ev.eventId,
            lifecycle: 'detected',
            title: 'Resultado desconocido',
            description: p.reason,
            agentId: ev.agentId,
            taskId: ev.taskId,
            availableActions: ['investigate', 'retry', 'stop', 'recover'],
            history: [{
              at: ev.timestamp,
              from: 'detected',
              to: 'detected',
              by: 'system',
            }],
          }
          state.attention.set(attentionId, item)
        }
        break
      }

      case 'user:acknowledged': {
        const p = ev.payload as { attentionId: string }
        const item = state.attention.get(p.attentionId)
        if (item && item.lifecycle === 'detected') {
          item.lifecycle = 'acknowledged'
          item.history.push({
            at: ev.timestamp,
            from: 'detected',
            to: 'acknowledged',
            by: 'user',
          })
        }
        break
      }

      case 'user:action': {
        const p = ev.payload as { attentionId: string; action: AttentionAction }
        const item = state.attention.get(p.attentionId)
        if (item && (item.lifecycle === 'acknowledged' || item.lifecycle === 'detected')) {
          // CRITICAL: capture 'from' BEFORE mutating lifecycle
          const fromLifecycle = item.lifecycle
          item.lifecycle = 'action-required'
          item.history.push({
            at: ev.timestamp,
            from: fromLifecycle,
            to: 'action-required',
            by: 'user',
            action: p.action,
          })
          // If action is retry, move to in-progress
          if (p.action === 'retry') {
            item.lifecycle = 'in-progress'
            item.history.push({
              at: ev.timestamp,
              from: 'action-required',
              to: 'in-progress',
              by: 'user',
              action: p.action,
            })
          }
        }
        break
      }

      case 'execution:update': {
        const p = ev.payload as { status: string }
        if (ev.taskId && ev.agentId) {
          // If this resolves an unknown execution, update attention
          if (p.status === 'success') {
            for (const [id, item] of state.attention) {
              if (item.taskId === ev.taskId && item.agentId === ev.agentId && item.lifecycle !== 'resolved' && item.lifecycle !== 'expired') {
                // CRITICAL: capture 'from' BEFORE mutating lifecycle
                const fromLifecycle = item.lifecycle
                item.lifecycle = 'resolved'
                item.history.push({
                  at: ev.timestamp,
                  from: fromLifecycle,
                  to: 'resolved',
                  by: 'system',
                })
              }
            }
          }
          // Add evidence
          const task = state.tasks.get(ev.taskId)
          if (task && p.status === 'success') {
            task.evidence.push({
              executionId: ev.executionId ?? 'unknown',
              agentId: ev.agentId,
              timestamp: ev.timestamp,
              summary: 'Success',
            })
          }
        }
        break
      }

      default: {
        // Unknown eventName — record but don't crash
        state.unknownEvents.push({
          eventId: ev.eventId,
          eventName: ev.eventName,
          schemaVersion: ev.schemaVersion,
          reason: 'unknown-eventName',
        })
        break
      }
    }
  }

  return state
}

/**
 * Load events from a JSONL string and reduce them.
 * This is the main entry point for testing.
 */
export function loadAndReduce(jsonl: string): { state: EventStoreState; warnings: Array<{ line: number; partial: string }> } {
  const { events, warnings } = parseEventsJsonl(jsonl)
  const state = reduceEvents(events)
  return { state, warnings }
}

/**
 * Deep equality check for determinism testing.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false
    }
    return true
  }

  if (typeof a === 'object' && typeof b === 'object') {
    if (a instanceof Map && b instanceof Map) {
      if (a.size !== b.size) return false
      for (const [key, val] of a) {
        if (!b.has(key)) return false
        if (!deepEqual(val, b.get(key))) return false
      }
      return true
    }
    const keysA = Object.keys(a as object)
    const keysB = Object.keys(b as object)
    if (keysA.length !== keysB.length) return false
    for (const key of keysA) {
      if (!keysB.includes(key)) return false
      if (!deepEqual((a as any)[key], (b as any)[key])) return false
    }
    return true
  }

  return false
}

/**
 * Serialize state to a comparable JSON string (for determinism check).
 */
export function serializeState(state: EventStoreState): string {
  const tasks: any = {}
  for (const [id, task] of state.tasks) {
    tasks[id] = task
  }
  const agents: any = {}
  for (const [id, agent] of state.agents) {
    agents[id] = agent
  }
  const attention: any = {}
  for (const [id, item] of state.attention) {
    attention[id] = item
  }
  return JSON.stringify({
    tasks,
    agents,
    attention,
    unknownEvents: state.unknownEvents,
    deduplicatedEvents: state.deduplicatedEvents,
    truncationWarnings: state.truncationWarnings,
    sequenceGaps: state.sequenceGaps,
  }, null, 2)
}