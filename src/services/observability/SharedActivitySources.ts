import { sharedActivityJournal } from './SharedActivityJournal.js'
import type { ExecutionDiagnosticEvent } from '../webRelay/ExecutionDiagnostics.js'

let initialization: Promise<void> | undefined

function recordLifecycleEvent(event: {
  name: string
  payload: Record<string, unknown>
}): void {
  const payload = event.payload
  const agentId = typeof payload.agentId === 'string' ? payload.agentId : undefined
  const instanceId = typeof payload.instanceId === 'string' ? payload.instanceId : undefined
  const executionId = typeof payload.executionId === 'string' ? payload.executionId : undefined
  const details: Record<string, string | number | boolean | null> = {}

  for (const key of [
    'from',
    'to',
    'status',
    'alive',
    'phase',
    'severity',
    'code',
    'healthy',
    'agentsChecked',
    'issuesFound',
    'scannedAt',
  ] as const) {
    const value = payload[key]
    if (
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) details[key] = value
  }
  if (typeof payload.error === 'string') details.errorPresent = true
  if (typeof payload.platformId === 'string') details.platformId = payload.platformId
  if (typeof payload.role === 'string') details.role = payload.role
  if (typeof payload.debugPort === 'number') details.debugPort = payload.debugPort
  if (typeof payload.reason === 'string') details.reason = payload.reason.slice(0, 200)

  sharedActivityJournal.append({
    source: event.name.startsWith('sentinel:') ? 'sentinel' :
      event.name.startsWith('execution:') ? 'execution' : 'orchestration',
    event: event.name,
    agentId,
    instanceId,
    executionId,
    details,
  })
  if (event.name === 'sentinel:scan' && Array.isArray(payload.details)) {
    for (const check of payload.details) {
      if (typeof check !== 'object' || check === null || Array.isArray(check)) continue
      const state = check as Record<string, unknown>
      if (typeof state.agentId !== 'string') continue
      const detail: Record<string, string | number | boolean | null> = {}
      for (const key of ['portAlive', 'swActive', 'mcpAlive'] as const) {
        const value = state[key]
        if (typeof value === 'boolean' || value === null) detail[key] = value
      }
      const configuration = state.saConfiguration
      if (typeof configuration === 'object' && configuration !== null && !Array.isArray(configuration)) {
        const config = configuration as Record<string, unknown>
        for (const key of [
          'mcpEnabled',
          'pushContentMode',
          'autoInsert',
          'autoSubmit',
          'autoExecute',
          'sidebarVisible',
          'compactButtonVisible',
          'pageHasFocus',
        ] as const) {
          const value = config[key]
          if (typeof value === 'boolean' || value === null) detail[key] = value
        }
        if (
          config.pageVisibility === 'visible' ||
          config.pageVisibility === 'hidden' ||
          config.pageVisibility === 'unknown'
        ) detail.pageVisibility = config.pageVisibility
      }
      if (Array.isArray(state.diagnostics)) {
        const codes = state.diagnostics.flatMap(item =>
          typeof item === 'object' && item !== null && 'code' in item && typeof item.code === 'string'
            ? [item.code.slice(0, 100)]
            : [],
        )
        if (codes.length > 0) detail.diagnosticCodes = codes.slice(0, 12).join(',')
      }
      sharedActivityJournal.append({
        source: 'sentinel',
        event: 'sentinel:agent-health',
        agentId: state.agentId,
        details: detail,
      })
    }
  }
}

export function recordRelayExecutionActivity(
  agentId: string,
  event: ExecutionDiagnosticEvent,
): void {
  const key = [
    'relay-activity',
    agentId,
    event.timestamp,
    event.event,
    event.callId ?? '',
    event.toolName ?? '',
    event.resultStatus ?? '',
    event.success === undefined ? '' : String(event.success),
  ].join('\u0000')
  sharedActivityJournal.appendOnce(key, {
    source: 'execution',
    event: `relay:${event.event}`,
    agentId,
    details: {
      timestamp: event.timestamp,
      ...(event.callId ? { callId: event.callId } : {}),
      ...(event.toolName ? { toolName: event.toolName } : {}),
      ...(event.success !== undefined ? { success: event.success } : {}),
      ...(event.executionIdPresent !== undefined ? { executionIdPresent: event.executionIdPresent } : {}),
      ...(event.executionKeyPresent !== undefined ? { executionKeyPresent: event.executionKeyPresent } : {}),
      ...(event.resultStatus ? { resultStatus: event.resultStatus } : {}),
      ...(event.pageVisibility ? { pageVisibility: event.pageVisibility } : {}),
      ...(event.pageHasFocus !== undefined ? { pageHasFocus: event.pageHasFocus } : {}),
      ...(event.buildMarker ? { buildMarker: event.buildMarker } : {}),
    },
  })
}

export function initializeSharedActivitySources(): Promise<void> {
  if (initialization) return initialization
  initialization = Promise.all([
    import('../webRelay/orchestration/MultiAgentRunner.js'),
    import('../webRelay/orchestration/Sentinel.js'),
    import('../collaboration/CollaborationStore.js'),
    import('../collaboration/WorkspaceParticipants.js'),
  ]).then(([runner, sentinel, collaboration, workspace]) => {
    for (const agent of runner.listAgents()) {
      sharedActivityJournal.append({
        source: 'orchestration',
        event: 'observer:initial-agent-state',
        agentId: agent.agentId,
        instanceId: agent.instanceId,
        details: {
          platformId: agent.platformId,
          status: agent.status,
          role: agent.role ?? null,
          debugPort: agent.debugPort ?? null,
        },
      })
    }
    runner.onLifecycleEvent(event => {
      recordLifecycleEvent({
        name: event.name,
        payload: event.payload as unknown as Record<string, unknown>,
      })
    })
    const lastHeartbeat = new Map<string, boolean>()
    sentinel.onSentinelEvent(event => {
      if (event.name === 'sentinel:heartbeat') {
        const { agentId, alive } = event.payload
        if (lastHeartbeat.get(agentId) === alive) return
        lastHeartbeat.set(agentId, alive)
      }
      recordLifecycleEvent({
        name: event.name,
        payload: event.payload as unknown as Record<string, unknown>,
      })
    })

    const lastEntries = new Map(
      collaboration.collaborationStore.getAll().map(entry => [entry.id, JSON.stringify(entry)]),
    )
    collaboration.collaborationStore.subscribe(entries => {
      for (const entry of entries) {
        const serialized = JSON.stringify(entry)
        if (lastEntries.get(entry.id) === serialized) continue
        lastEntries.set(entry.id, serialized)
        const details: Record<string, string | number | boolean | null> = {
          entryId: entry.id,
          entryType: entry.type,
        }
        if ('workerId' in entry) details.workerId = entry.workerId
        if ('callId' in entry) details.callId = entry.callId
        if ('status' in entry) details.status = entry.status
        sharedActivityJournal.append({
          source: 'collaboration',
          event: `collaboration:${entry.type}`,
          agentId: 'workerId' in entry ? entry.workerId : undefined,
          details,
        })
      }
    })

    workspace.workspaceParticipants.subscribe(event => {
      const base = {
        source: 'collaboration' as const,
        agentId: event.type === 'participant'
          ? event.participant.id
          : event.type === 'task'
            ? event.task.participantId
            : event.message.participantId,
      }
      if (event.type === 'participant') {
        sharedActivityJournal.append({
          ...base,
          event: 'workspace:participant-presence',
          details: {
            provider: event.participant.provider,
            status: event.participant.status,
            capabilityCount: event.participant.capabilities.length,
          },
        })
      } else if (event.type === 'task') {
        sharedActivityJournal.append({
          ...base,
          event: 'workspace:task-status',
          details: {
            taskId: event.task.id,
            status: event.task.status,
          },
        })
      } else {
        sharedActivityJournal.append({
          ...base,
          event: 'workspace:participant-message',
          details: { messageId: event.message.id },
        })
      }
    })
  }).catch(error => {
    initialization = undefined
    throw error
  })
  return initialization
}
