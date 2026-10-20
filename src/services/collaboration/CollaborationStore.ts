/**
 * CollaborationStore — The "overwrite space" (espacio de sobreescritura).
 *
 * A living document that gets updated when workers make collaboration tool calls.
 * Unlike raw worker responses, this stores structured, confirmed findings linked
 * to specific tool calls for traceability.
 *
 * Read by:
 *   - Orchestrator: to evaluate progress, detect cross-pollination needs
 *   - Sentinel: to detect gaps, launch supplementary workers
 *   - User: via workspace (web) or lienzo (TUI)
 *
 * Written by:
 *   - Workers: via report_finding, request_info, flag_issue tool calls
 *   - Orchestrator: via orchestrator_evaluation entries
 *   - Sentinel: via sentinel_observation entries
 */

// ─── Types ──────────────────────────────────────────────────────────

export type FindingConfidence = 'alta' | 'media' | 'baja'

export interface CollaborationFinding {
  id: string
  type: 'finding'
  workerId: string
  workerPlatform: string
  topic: string
  finding: string
  confidence: FindingConfidence
  sources: number
  timestamp: number
  callId: string
}

export interface CollaborationRequest {
  id: string
  type: 'request'
  workerId: string
  workerPlatform: string
  need: string
  reason: string
  status: 'pending' | 'fulfilled' | 'unfulfillable'
  fulfilledBy?: string
  fulfilledWith?: string
  timestamp: number
  callId: string
}

export interface CollaborationIssue {
  id: string
  type: 'issue'
  workerId: string
  workerPlatform: string
  description: string
  severity: 'alta' | 'media' | 'baja'
  status: 'open' | 'resolved' | 'dismissed'
  resolvedBy?: string
  timestamp: number
  callId: string
}

export interface OrchestratorEvaluation {
  id: string
  type: 'orchestrator_evaluation'
  evaluation: string
  action?: string
  relatedFindings: string[]
  timestamp: number
}

export interface SentinelObservation {
  id: string
  type: 'sentinel_observation'
  observation: string
  action?: string
  workersLaunched?: string[]
  timestamp: number
}

export type CollaborationEntry =
  | CollaborationFinding
  | CollaborationRequest
  | CollaborationIssue
  | OrchestratorEvaluation
  | SentinelObservation

// ─── Store ──────────────────────────────────────────────────────────

type StoreListener = (entries: CollaborationEntry[]) => void

let nextEntryId = 0

class CollaborationStoreImpl {
  private entries: CollaborationEntry[] = []
  private listeners: Set<StoreListener> = new Set()
  private topicIndex: Map<string, CollaborationEntry[]> = new Map()
  private workerIndex: Map<string, CollaborationEntry[]> = new Map()

  // ─── Write Operations ───────────────────────────────────────────

  addFinding(params: {
    workerId: string
    workerPlatform: string
    topic: string
    finding: string
    confidence: FindingConfidence
    sources?: number
    callId: string
  }): CollaborationFinding {
    const entry: CollaborationFinding = {
      id: `finding-${++nextEntryId}`,
      type: 'finding',
      workerId: params.workerId,
      workerPlatform: params.workerPlatform,
      topic: params.topic,
      finding: params.finding,
      confidence: params.confidence,
      sources: params.sources ?? 0,
      timestamp: Date.now(),
      callId: params.callId,
    }
    this.addEntry(entry)
    return entry
  }

  addRequest(params: {
    workerId: string
    workerPlatform: string
    need: string
    reason: string
    callId: string
  }): CollaborationRequest {
    const entry: CollaborationRequest = {
      id: `request-${++nextEntryId}`,
      type: 'request',
      workerId: params.workerId,
      workerPlatform: params.workerPlatform,
      need: params.need,
      reason: params.reason,
      status: 'pending',
      timestamp: Date.now(),
      callId: params.callId,
    }
    this.addEntry(entry)
    return entry
  }

  addIssue(params: {
    workerId: string
    workerPlatform: string
    description: string
    severity: 'alta' | 'media' | 'baja'
    callId: string
  }): CollaborationIssue {
    const entry: CollaborationIssue = {
      id: `issue-${++nextEntryId}`,
      type: 'issue',
      workerId: params.workerId,
      workerPlatform: params.workerPlatform,
      description: params.description,
      severity: params.severity,
      status: 'open',
      timestamp: Date.now(),
      callId: params.callId,
    }
    this.addEntry(entry)
    return entry
  }

  addOrchestratorEvaluation(params: {
    evaluation: string
    action?: string
    relatedFindings?: string[]
  }): OrchestratorEvaluation {
    const entry: OrchestratorEvaluation = {
      id: `orch-eval-${++nextEntryId}`,
      type: 'orchestrator_evaluation',
      evaluation: params.evaluation,
      action: params.action,
      relatedFindings: params.relatedFindings ?? [],
      timestamp: Date.now(),
    }
    this.addEntry(entry)
    return entry
  }

  addSentinelObservation(params: {
    observation: string
    action?: string
    workersLaunched?: string[]
  }): SentinelObservation {
    const entry: SentinelObservation = {
      id: `sentinel-obs-${++nextEntryId}`,
      type: 'sentinel_observation',
      observation: params.observation,
      action: params.action,
      workersLaunched: params.workersLaunched,
      timestamp: Date.now(),
    }
    this.addEntry(entry)
    return entry
  }

  fulfillRequest(requestId: string, fulfilledBy: string, data: string): boolean {
    const entry = this.entries.find(
      e => e.id === requestId && e.type === 'request',
    ) as CollaborationRequest | undefined
    if (!entry || entry.status !== 'pending') return false

    entry.status = 'fulfilled'
    entry.fulfilledBy = fulfilledBy
    entry.fulfilledWith = data
    this.notify()
    return true
  }

  resolveIssue(issueId: string, resolvedBy: string): boolean {
    const entry = this.entries.find(
      e => e.id === issueId && e.type === 'issue',
    ) as CollaborationIssue | undefined
    if (!entry || entry.status !== 'open') return false

    entry.status = 'resolved'
    entry.resolvedBy = resolvedBy
    this.notify()
    return true
  }

  // ─── Read Operations ────────────────────────────────────────────

  getAll(): CollaborationEntry[] {
    return [...this.entries]
  }

  getByType<T extends CollaborationEntry['type']>(
    type: T,
  ): Extract<CollaborationEntry, { type: T }>[] {
    return this.entries.filter(e => e.type === type) as any
  }

  getByWorker(workerId: string): CollaborationEntry[] {
    return this.workerIndex.get(workerId) ?? []
  }

  getByTopic(topic: string): CollaborationEntry[] {
    return this.topicIndex.get(topic.toLowerCase()) ?? []
  }

  getFindings(): CollaborationFinding[] {
    return this.getByType('finding')
  }

  getPendingRequests(): CollaborationRequest[] {
    return this.getByType('request').filter(r => r.status === 'pending')
  }

  getOpenIssues(): CollaborationIssue[] {
    return this.getByType('issue').filter(i => i.status === 'open')
  }

  /** Topics covered with high-confidence findings from multiple workers */
  getConvergence(): Array<{ topic: string; findings: CollaborationFinding[]; workerCount: number }> {
    const byTopic = new Map<string, CollaborationFinding[]>()
    for (const finding of this.getFindings()) {
      const key = finding.topic.toLowerCase()
      if (!byTopic.has(key)) byTopic.set(key, [])
      byTopic.get(key)!.push(finding)
    }

    const convergence: Array<{ topic: string; findings: CollaborationFinding[]; workerCount: number }> = []
    for (const [topic, findings] of byTopic) {
      const uniqueWorkers = new Set(findings.map(f => f.workerId))
      if (uniqueWorkers.size >= 2) {
        convergence.push({ topic, findings, workerCount: uniqueWorkers.size })
      }
    }
    return convergence.sort((a, b) => b.workerCount - a.workerCount)
  }

  /** Topics where workers report different findings */
  getDivergence(): Array<{ topic: string; findings: CollaborationFinding[] }> {
    const byTopic = new Map<string, CollaborationFinding[]>()
    for (const finding of this.getFindings()) {
      const key = finding.topic.toLowerCase()
      if (!byTopic.has(key)) byTopic.set(key, [])
      byTopic.get(key)!.push(finding)
    }

    const divergence: Array<{ topic: string; findings: CollaborationFinding[] }> = []
    for (const [topic, findings] of byTopic) {
      const uniqueWorkers = new Set(findings.map(f => f.workerId))
      // At least 2 different workers reported on same topic
      if (uniqueWorkers.size >= 2) {
        // Check if findings differ meaningfully (different content)
        const uniqueFindings = new Set(findings.map(f => f.finding.toLowerCase().trim()))
        if (uniqueFindings.size > 1) {
          divergence.push({ topic, findings })
        }
      }
    }
    return divergence
  }

  getSnapshot(): CollaborationSnapshot {
    const findings = this.getFindings()
    const requests = this.getByType('request')
    const issues = this.getByType('issue')
    const orchestratorEvals = this.getByType('orchestrator_evaluation')
    const sentinelObs = this.getByType('sentinel_observation')

    const uniqueWorkers = new Set<string>()
    for (const entry of this.entries) {
      if ('workerId' in entry) uniqueWorkers.add(entry.workerId)
    }

    return {
      totalEntries: this.entries.length,
      findings: findings.length,
      pendingRequests: requests.filter(r => r.status === 'pending').length,
      openIssues: issues.filter(i => i.status === 'open').length,
      orchestratorEvaluations: orchestratorEvals.length,
      sentinelObservations: sentinelObs.length,
      activeWorkers: uniqueWorkers.size,
      convergenceTopics: this.getConvergence().length,
      divergenceTopics: this.getDivergence().length,
      lastUpdate: this.entries.length > 0
        ? Math.max(...this.entries.map(e => e.timestamp))
        : 0,
    }
  }

  // ─── Subscription ───────────────────────────────────────────────

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  // ─── Clear ──────────────────────────────────────────────────────

  clear(): void {
    this.entries = []
    this.topicIndex.clear()
    this.workerIndex.clear()
    this.notify()
  }

  // ─── Internal ───────────────────────────────────────────────────

  private addEntry(entry: CollaborationEntry): void {
    this.entries.push(entry)

    // Index by worker
    if ('workerId' in entry) {
      const workerId = entry.workerId
      if (!this.workerIndex.has(workerId)) this.workerIndex.set(workerId, [])
      this.workerIndex.get(workerId)!.push(entry)
    }

    // Index by topic
    if ('topic' in entry) {
      const key = entry.topic.toLowerCase()
      if (!this.topicIndex.has(key)) this.topicIndex.set(key, [])
      this.topicIndex.get(key)!.push(entry)
    }

    this.notify()
  }

  private notify(): void {
    const snapshot = [...this.entries]
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (err) {
        console.error('[CollaborationStore] Listener error:', err)
      }
    }
  }
}

export interface CollaborationSnapshot {
  totalEntries: number
  findings: number
  pendingRequests: number
  openIssues: number
  orchestratorEvaluations: number
  sentinelObservations: number
  activeWorkers: number
  convergenceTopics: number
  divergenceTopics: number
  lastUpdate: number
}

// ─── Singleton ────────────────────────────────────────────────────

export const collaborationStore = new CollaborationStoreImpl()
