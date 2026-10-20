/**
 * integration.ts — Conecta RelayBus y ActivityStore con SentinelCurator.
 * 
 * Este es el puente entre el sistema existente y la superficie de colaboración.
 * Traduce eventos crudos del RelayBus en CuratorEvents que el curador entiende.
 */

import { SentinelCurator, getSentinelCurator } from './SentinelCurator.js'
import { CuratorEvent, makeFriendlyName } from './types.js'
import type { OrchestratorEvent } from '../webRelay/orchestration/types.js'
import type { WebRelayTaskActivity, WebRelayAgentActivity } from '../webRelay/WebRelayActivityStore.js'

// ─── Traducción de eventos del RelayBus ──────────────────────────────────────

function relayBusEventToCurator(event: OrchestratorEvent): CuratorEvent | null {
  const agentName = 'agentId' in event.payload 
    ? makeFriendlyName(String(event.payload.agentId)) 
    : 'Unknown'

  switch (event.name) {
    case 'agent:created':
      return {
        type: 'agent-status',
        agentId: String((event.payload as any).agentId || ''),
        agentName,
        status: 'created',
      }

    case 'agent:lifecycle': {
      const p = event.payload as { agentId: string; from: string; to: string }
      return {
        type: 'agent-status',
        agentId: p.agentId,
        agentName: makeFriendlyName(p.agentId),
        status: p.to,
      }
    }

    case 'agent:error': {
      const p = event.payload as { agentId: string; error: string; phase?: string }
      return {
        type: 'anomaly-detected',
        agentId: p.agentId,
        agentName: makeFriendlyName(p.agentId),
        kind: 'wrong-tool', // Aproximación; el kind real dependería del error
        description: p.error,
      }
    }

    case 'instance:lost': {
      const p = event.payload as { instanceId: string; agentId?: string }
      return {
        type: 'anomaly-detected',
        agentId: p.agentId || '',
        agentName: p.agentId ? makeFriendlyName(p.agentId) : 'Unknown',
        kind: 'lost',
        description: `Instancia perdida: ${p.instanceId}`,
      }
    }

    case 'execution:unknown': {
      const p = event.payload as { agentId: string; executionId: string; reason: string }
      return {
        type: 'anomaly-detected',
        agentId: p.agentId,
        agentName: makeFriendlyName(p.agentId),
        kind: 'no-dispatch',
        description: p.reason,
      }
    }

    case 'execution:update': {
      const p = event.payload as { agentId: string; executionId: string; status: string }
      if (p.status === 'success') {
        return {
          type: 'worker-responded',
          taskId: '', // Se llenará desde ActivityStore
          agentId: p.agentId,
          agentName: makeFriendlyName(p.agentId),
          response: 'Ejecución completada exitosamente',
        }
      }
      return null
    }

    case 'sentinel:heartbeat':
    case 'sentinel:log':
    case 'sentinel:scan':
      // Estos eventos son de monitoreo interno, no llegan al usuario
      return null

    default:
      return null
  }
}

// ─── Traducción de ActivityStore ─────────────────────────────────────────────

function activityToCurator(task: WebRelayTaskActivity): CuratorEvent[] {
  const events: CuratorEvent[] = []

  // Task started
  if (task.status === 'running') {
    events.push({
      type: 'task-started',
      taskId: task.taskId,
      taskTitle: task.prompt,
    })
  }

  // Workers
  for (const agent of task.agents) {
    const agentName = makeFriendlyName(agent.agentId)

    if (agent.status === 'working' && agent.stage === 'Trabajando en su asignación') {
      events.push({
        type: 'worker-started',
        taskId: task.taskId,
        agentId: agent.agentId,
        agentName,
        subTask: agent.task || 'Subtarea asignada',
      })
    }

    if (agent.status === 'complete') {
      events.push({
        type: 'worker-responded',
        taskId: task.taskId,
        agentId: agent.agentId,
        agentName,
        response: agent.response || 'Completado',
      })
    }

    if (agent.status === 'error') {
      events.push({
        type: 'worker-error',
        taskId: task.taskId,
        agentId: agent.agentId,
        agentName,
        error: agent.error || 'Error desconocido',
      })
    }
  }

  // Task finished
  if (task.status === 'complete' || task.status === 'partial' || task.status === 'failed') {
    events.push({
      type: 'task-finished',
      taskId: task.taskId,
      result: task.status === 'complete' ? 'Completado exitosamente' : task.error,
    })
  }

  return events
}

// ─── Integración principal ────────────────────────────────────────────────────

export interface CollaborationIntegration {
  curator: SentinelCurator
  disconnect: () => void
}

/**
 * Inicializar la superficie de colaboración conectándola al sistema existente.
 * 
 * Uso:
 * ```typescript
 * import { initializeCollaboration } from './services/collaboration/integration.js'
 * 
 * const collab = initializeCollaboration({
 *   relayBus,        // instancia de RelayBus
 *   activityStore,   // instancia de WebRelayActivityStore
 * })
 * 
 * // Más tarde...
 * collab.disconnect()
 * ```
 */
export function initializeCollaboration(options: {
  relayBus?: { subscribe: (fn: (event: any) => void) => () => void }
  activityStore?: { 
    subscribe: (fn: () => void) => () => void
    getSnapshot: () => WebRelayTaskActivity[]
  }
  curatorConfig?: Parameters<SentinelCurator['updateConfig']>[0]
}): CollaborationIntegration {
  
  const curator = getSentinelCurator(options.curatorConfig)
  const unsubscribers: Array<() => void> = []

  // Conectar RelayBus
  if (options.relayBus) {
    const unsub = options.relayBus.subscribe((event: OrchestratorEvent) => {
      const curatorEvent = relayBusEventToCurator(event)
      if (curatorEvent) {
        curator.ingest(curatorEvent)
      }
    })
    unsubscribers.push(unsub)
  }

  // Conectar ActivityStore
  if (options.activityStore) {
    const unsub = options.activityStore.subscribe(() => {
      const snapshot = options.activityStore!.getSnapshot()
      for (const task of snapshot) {
        const events = activityToCurator(task)
        for (const ev of events) {
          curator.ingest(ev)
        }
      }
    })
    unsubscribers.push(unsub)
  }

  // Conectar CollaborationStore (overwrite space) → SentinelCurator (lienzo TUI)
  import('./CollaborationStore.js').then(({ collaborationStore }) => {
    const unsub = collaborationStore.subscribe((entries) => {
      const latest = entries[entries.length - 1]
      if (!latest) return

      if (latest.type === 'finding') {
        curator.ingest({
          type: 'task-progress',
          taskId: `collab-${latest.workerId}`,
          completed: entries.filter(e => e.type === 'finding').length,
          total: 0,
          currentActivity: `[${latest.workerPlatform}] ${latest.topic}: ${latest.finding}`,
        })
      } else if (latest.type === 'issue') {
        curator.ingest({
          type: 'anomaly-detected',
          agentId: latest.workerId,
          agentName: latest.workerPlatform,
          kind: latest.severity === 'alta' ? 'no-dispatch' : 'timeout',
          description: latest.description,
        })
      } else if (latest.type === 'request' && latest.status === 'pending') {
        curator.ingest({
          type: 'task-progress',
          taskId: `collab-${latest.workerId}`,
          completed: entries.filter(e => e.type === 'request').length,
          total: 0,
          currentActivity: `[${latest.workerPlatform}] Solicita: ${latest.need}`,
        })
      }
    })
    unsubscribers.push(unsub)
  }).catch(() => {})

  return {
    curator,
    disconnect: () => {
      for (const unsub of unsubscribers) {
        try {
          unsub()
        } catch {
          // Ignorar errores de desconexión
        }
      }
    },
  }
}

// ─── Export público ───────────────────────────────────────────────────────────

export { SentinelCurator, getSentinelCurator }
export { CollaborationSurface } from '../../components/CollaborationSurface.js'
export * from './types.js'