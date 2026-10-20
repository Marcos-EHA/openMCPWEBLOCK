export type SharedActivitySource =
  | 'mcp'
  | 'orchestration'
  | 'sentinel'
  | 'collaboration'
  | 'coordinator'
  | 'execution'

export type SharedActivityValue = string | number | boolean | null

export interface SharedActivityEvent {
  sequence: number
  timestamp: string
  source: SharedActivitySource
  event: string
  agentId?: string
  instanceId?: string
  executionId?: string
  details?: Record<string, SharedActivityValue>
}

export interface SharedActivityQuery {
  afterSequence?: number
  limit?: number
  agentIds?: string[]
  sources?: SharedActivitySource[]
}

export interface SharedActivityResult {
  events: SharedActivityEvent[]
  nextSequence: number
  oldestSequence: number
  truncated: boolean
}

const DEFAULT_CAPACITY = 2_000
const MAX_FIELD_LENGTH = 256
type ActivityListener = (event: SharedActivityEvent) => void

function optionalIdentity(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim()
  return normalized ? normalized.slice(0, MAX_FIELD_LENGTH) : undefined
}

function normalizeDetails(
  details: Record<string, SharedActivityValue> | undefined,
): Record<string, SharedActivityValue> | undefined {
  if (!details) return undefined
  const normalized: Record<string, SharedActivityValue> = {}
  for (const [key, value] of Object.entries(details).slice(0, 24)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    if (
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      value === null ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      normalized[key.slice(0, 64)] =
        typeof value === 'string' ? value.slice(0, MAX_FIELD_LENGTH) : value
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

export class SharedActivityJournal {
  private sequence = 0
  private readonly events: SharedActivityEvent[] = []
  private readonly listeners = new Set<ActivityListener>()
  private readonly dedupeKeys = new Set<string>()
  private readonly dedupeOrder: string[] = []

  constructor(private readonly capacity = DEFAULT_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('Shared activity journal capacity must be a positive integer.')
    }
  }

  get latestSequence(): number {
    return this.sequence
  }

  append(input: Omit<SharedActivityEvent, 'sequence' | 'timestamp'> & { timestamp?: string }): SharedActivityEvent {
    const eventName = input.event.trim()
    if (!eventName) throw new Error('Shared activity event name must not be empty.')
    const agentId = optionalIdentity(input.agentId)
    const instanceId = optionalIdentity(input.instanceId)
    const executionId = optionalIdentity(input.executionId)
    const details = normalizeDetails(input.details)
    const event: SharedActivityEvent = {
      sequence: ++this.sequence,
      timestamp: input.timestamp ?? new Date().toISOString(),
      source: input.source,
      event: eventName.slice(0, MAX_FIELD_LENGTH),
      ...(agentId ? { agentId } : {}),
      ...(instanceId ? { instanceId } : {}),
      ...(executionId ? { executionId } : {}),
      ...(details ? { details } : {}),
    }
    this.events.push(event)
    if (this.events.length > this.capacity) this.events.shift()
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[SharedActivityJournal] Listener failed:', error)
      }
    }
    return event
  }

  appendOnce(
    key: string,
    input: Omit<SharedActivityEvent, 'sequence' | 'timestamp'> & { timestamp?: string },
  ): SharedActivityEvent | null {
    if (!key) throw new Error('Shared activity deduplication key must not be empty.')
    if (this.dedupeKeys.has(key)) return null
    this.dedupeKeys.add(key)
    this.dedupeOrder.push(key)
    while (this.dedupeOrder.length > this.capacity * 2) {
      const expired = this.dedupeOrder.shift()
      if (expired) this.dedupeKeys.delete(expired)
    }
    return this.append(input)
  }

  subscribe(listener: ActivityListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  read(query: SharedActivityQuery = {}): SharedActivityResult {
    const afterSequence = query.afterSequence ?? 0
    const limit = query.limit ?? 100
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new RangeError('afterSequence must be a non-negative safe integer.')
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new RangeError('limit must be an integer between 1 and 200.')
    }
    const oldestSequence = this.events[0]?.sequence ?? this.sequence + 1
    const allowedAgents = query.agentIds ? new Set(query.agentIds) : undefined
    const allowedSources = query.sources ? new Set(query.sources) : undefined
    const events = this.events
      .filter(event =>
        event.sequence > afterSequence &&
        (!allowedAgents || (event.agentId !== undefined && allowedAgents.has(event.agentId))) &&
        (!allowedSources || allowedSources.has(event.source)),
      )
      .slice(0, limit)
      .map(event => ({
        ...event,
        ...(event.details ? { details: { ...event.details } } : {}),
      }))
    return {
      events,
      nextSequence: this.sequence,
      oldestSequence,
      truncated: afterSequence < oldestSequence - 1,
    }
  }
}

export const sharedActivityJournal = new SharedActivityJournal()
