import type { AgentState } from './orchestration/types.js'
import type { WebRelayCoordinatorEvent } from './WebRelayCoordinator.js'
import { isRoutableWebRelayAgent } from './isRoutableWebRelayAgent.js'

export type WebRelayActivityStatus = 'running' | 'complete' | 'partial' | 'failed'
export type WebRelayAgentActivityStatus = 'waiting' | 'working' | 'complete' | 'error' | 'idle'

export interface WebRelayAgentActivity {
  agentId: string
  role: 'coordinator' | 'worker'
  status: WebRelayAgentActivityStatus
  stage: string
  task?: string
  response?: string
  error?: string
}

export interface WebRelayTaskActivity {
  taskId: string
  prompt: string
  startedAt: number
  status: WebRelayActivityStatus
  agents: WebRelayAgentActivity[]
  error?: string
}

const MAX_RETAINED_TASKS = 20
let taskCounter = 0
let activities: WebRelayTaskActivity[] = []
const listeners = new Set<() => void>()

function publish(next: WebRelayTaskActivity[]): void {
  activities = next
  for (const listener of listeners) listener()
}

export function getWebRelayActivitySnapshot(): WebRelayTaskActivity[] {
  return activities
}

export function subscribeToWebRelayActivity(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function startWebRelayActivity(
  prompt: string,
  platformId: string,
  agents: AgentState[],
): string {
  const readyAgents = agents.filter(agent => isRoutableWebRelayAgent(agent, platformId))
  const taskId = `web-task-${Date.now()}-${++taskCounter}`
  const task: WebRelayTaskActivity = {
    taskId,
    prompt,
    startedAt: Date.now(),
    status: 'running',
    agents: readyAgents.map(agent => ({
      agentId: agent.agentId,
      role: agent.role === 'primary' ? 'coordinator' : 'worker',
      status: 'waiting',
      stage: agent.role === 'primary' ? 'Esperando coordinación' : 'Esperando asignación',
    })),
  }
  publish([task, ...activities].slice(0, MAX_RETAINED_TASKS))
  return taskId
}

function updateAgent(
  task: WebRelayTaskActivity,
  agentId: string,
  update: Partial<WebRelayAgentActivity>,
): WebRelayTaskActivity {
  return {
    ...task,
    agents: task.agents.map(agent =>
      agent.agentId === agentId ? { ...agent, ...update } : agent,
    ),
  }
}

export function applyWebRelayActivityEvent(
  taskId: string,
  event: WebRelayCoordinatorEvent,
): void {
  publish(activities.map(task => {
    if (task.taskId !== taskId) return task
    switch (event.type) {
      case 'agent-ready':
        return updateAgent(task, event.agentId, {
          role: event.role === 'coordinador' ? 'coordinator' : 'worker',
          status: 'waiting',
          stage: event.role === 'coordinador' ? 'Coordinador listo' : 'Worker listo',
        })
      case 'planning-started':
        return updateAgent(task, event.agentId, {
          status: 'working',
          stage: 'Planificando asignaciones',
        })
      case 'plan-ready':
        return updateAgent(task, event.agentId, {
          status: 'waiting',
          stage: 'Plan listo · delegando tareas',
        })
      case 'direct-response':
        return updateAgent(task, event.agentId, {
          status: 'complete',
          stage: 'Respuesta recibida',
          response: event.response,
        })
      case 'worker-started':
        return updateAgent(task, event.agentId, {
          status: 'working',
          stage: 'Trabajando en su asignación',
          task: event.prompt,
          error: undefined,
        })
      case 'worker-response':
        return updateAgent(task, event.agentId, {
          status: 'complete',
          stage: 'Respuesta recibida',
          response: event.response,
        })
      case 'worker-error':
        return updateAgent(task, event.agentId, {
          status: 'error',
          stage: 'Falló la consulta',
          error: event.error,
        })
      case 'review-started':
        return updateAgent(task, event.agentId, {
          status: 'working',
          stage: 'Revisando los avances',
        })
      case 'review-response':
        return updateAgent(task, event.agentId, {
          status: 'complete',
          stage: 'Seguimiento del coordinador',
          response: event.response,
        })
      case 'review-error':
        return updateAgent(task, event.agentId, {
          status: 'error',
          stage: 'Falló la revisión',
          error: event.error,
        })
    }
  }))
}

export function finishWebRelayActivity(
  taskId: string,
  outcome: { error?: string; partial?: boolean } = {},
): void {
  publish(activities.map(task => {
    if (task.taskId !== taskId) return task
    const agentStatus = outcome.error ? 'idle' : 'complete'
    return {
      ...task,
      status: outcome.error ? 'failed' : outcome.partial ? 'partial' : 'complete',
      error: outcome.error,
      agents: task.agents.map(agent =>
        agent.status === 'waiting' || agent.status === 'working'
        ? { ...agent, status: agentStatus, stage: outcome.error ? 'No ejecutado' : 'Finalizado' }
        : agent,
      ),
    }
  }))
}

export function resetWebRelayActivityForTests(): void {
  taskCounter = 0
  publish([])
}
