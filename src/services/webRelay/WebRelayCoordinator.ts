import type { AgentState } from './orchestration/types.js'
import { isRoutableWebRelayAgent } from './isRoutableWebRelayAgent.js'
import { isWebCoordinatorRole } from './launchPolicy.js'
import { sharedActivityJournal } from '../observability/SharedActivityJournal.js'
import { randomUUID } from 'node:crypto'
import {
  getWorkspaceContextInstruction,
  workspaceContextJournal,
} from './WorkspaceContextJournal.js'
import {
  API_ORCHESTRATOR_AGENT_ID,
  generateApiOrchestratorResponse,
} from './ApiOrchestratorBrain.js'

const MAX_AGENT_TASK_LENGTH = 12_000

export type WebRelayCoordinatorEvent =
  | { type: 'agent-ready'; agentId: string; role: 'coordinador' | 'worker' }
  | { type: 'planning-started'; agentId: string }
  | { type: 'plan-ready'; agentId: string; response: string }
  | { type: 'direct-response'; agentId: string; response: string }
  | { type: 'worker-started'; agentId: string; prompt: string }
  | { type: 'worker-response'; agentId: string; response: string }
  | { type: 'worker-error'; agentId: string; error: string }
  | { type: 'review-started'; agentId: string }
  | { type: 'review-response'; agentId: string; response: string }
  | { type: 'review-error'; agentId: string; error: string }
  | { type: 'task-started'; agentId: string; taskId: string }
  | { type: 'task-finished'; agentId: string; taskId: string; status: 'complete' | 'partial' | 'failed'; error?: string }

export interface WebRelayCoordinatorDependencies {
  prompt: string
  platformId: string
  agents: AgentState[]
  coordinatorAgentId?: string
  directAgentId?: string
  orchestratorBrain?: 'api' | 'web'
  generateCoordinatorResponse?: (prompt: string) => Promise<string>
  allowCrossPlatformAgents?: boolean
  sendPrompt: (prompt: string, platformId: string, agentId: string) => Promise<string>
  onEvent?: (event: WebRelayCoordinatorEvent) => void
}

export interface WebRelayAgentResponse {
  agentId: string
  task: string
  response?: string
  error?: string
}

export interface WebRelayCoordinatorResult {
  dispatchMode: 'coordinated' | 'direct'
  coordinatorId: string
  directAgentId?: string
  directResponse?: string
  planningResponse?: string
  workerResponses: WebRelayAgentResponse[]
  reviewResponse?: string
  reviewError?: string
}

interface CoordinatorPlan {
  tasks: Array<{ agentId: string; prompt: string }>
}

function parseCoordinatorPlan(response: string, workerIds: string[]): CoordinatorPlan {
  const jsonStart = response.indexOf('{')
  const jsonEnd = response.lastIndexOf('}')
  if (jsonStart < 0 || jsonEnd <= jsonStart) {
    throw new Error(`El coordinador no devolvió un plan JSON válido. Respuesta recibida:\n${response}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(response.slice(jsonStart, jsonEnd + 1))
  } catch (error) {
    throw new Error(
      `No se pudo interpretar el plan del coordinador: ${error instanceof Error ? error.message : String(error)}\n` +
      `Respuesta recibida:\n${response}`,
    )
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('tasks' in parsed) ||
    !Array.isArray(parsed.tasks)
  ) {
    throw new Error(`El plan del coordinador debe tener un arreglo "tasks". Respuesta recibida:\n${response}`)
  }

  const requestedIds = new Set(workerIds)
  const assignedIds = new Set<string>()
  const tasks: CoordinatorPlan['tasks'] = []
  for (const task of parsed.tasks) {
    if (
      typeof task !== 'object' ||
      task === null ||
      !('agentId' in task) ||
      typeof task.agentId !== 'string' ||
      !('prompt' in task) ||
      typeof task.prompt !== 'string' ||
      !task.prompt.trim()
    ) {
      throw new Error(`El plan contiene una asignación sin agentId o prompt válido. Respuesta recibida:\n${response}`)
    }
    if (!requestedIds.has(task.agentId)) {
      throw new Error(`El coordinador asignó una tarea a una instancia no-worker: ${task.agentId}.`)
    }
    if (assignedIds.has(task.agentId)) {
      throw new Error(`El coordinador asignó más de una tarea a ${task.agentId}.`)
    }
    if (task.prompt.length > MAX_AGENT_TASK_LENGTH) {
      throw new Error(`La tarea asignada a ${task.agentId} excede ${MAX_AGENT_TASK_LENGTH} caracteres.`)
    }
    assignedIds.add(task.agentId)
    tasks.push({ agentId: task.agentId, prompt: task.prompt.trim() })
  }

  const missingIds = workerIds.filter(agentId => !assignedIds.has(agentId))
  if (missingIds.length > 0) {
    throw new Error(`El coordinador no asignó una tarea a cada worker. Sin tarea: ${missingIds.join(', ')}.`)
  }
  return { tasks }
}

export async function runCoordinatedWebTask({
  prompt,
  platformId,
  agents,
  coordinatorAgentId,
  directAgentId,
  orchestratorBrain = 'web',
  generateCoordinatorResponse,
  allowCrossPlatformAgents = false,
  sendPrompt,
  onEvent,
}: WebRelayCoordinatorDependencies): Promise<WebRelayCoordinatorResult> {
  const emit = (event: WebRelayCoordinatorEvent): void => {
    const details: Record<string, string | number | boolean | null> = {
      phase: event.type,
    }
    if ('role' in event) details.role = event.role
    if ('response' in event) details.responseLength = event.response.length
    if ('prompt' in event) details.promptLength = event.prompt.length
    if ('error' in event) details.errorPresent = event.error.length > 0
    if ('taskId' in event) details.taskId = event.taskId
    if ('status' in event) details.status = event.status
    sharedActivityJournal.append({
      source: 'coordinator',
      event: `coordinator:${event.type}`,
      agentId: event.agentId,
      details,
    })
    onEvent?.(event)
  }

  const normalizedPrompt = prompt.trim()
  if (!normalizedPrompt) throw new Error('Escribe una tarea para el equipo Web Relay.')
  if (normalizedPrompt.length > MAX_AGENT_TASK_LENGTH) {
    throw new Error(`La tarea excede el límite de ${MAX_AGENT_TASK_LENGTH} caracteres.`)
  }

  const readyAgents = agents.filter(agent =>
    isRoutableWebRelayAgent(agent, allowCrossPlatformAgents ? undefined : platformId),
  )
  if (readyAgents.length === 0) {
    if (orchestratorBrain === 'api') {
      throw new Error('El cerebro API necesita al menos un worker Web Relay listo.')
    }
    throw new Error('No hay agentes Web Relay listos en el pool. Lanza o reconecta instancias con /mcp set-mode web.')
  }

  const workspaceTaskId = randomUUID()
  const journalGeneration = workspaceContextJournal.getGeneration()
  const contextInstruction = getWorkspaceContextInstruction()
  const coordinatorId = orchestratorBrain === 'api'
    ? API_ORCHESTRATOR_AGENT_ID
    : coordinatorAgentId ??
      readyAgents.find(agent => agent.role === 'primary')?.agentId ??
      readyAgents.find(agent => isWebCoordinatorRole(agent.role))?.agentId ??
      readyAgents[0]!.agentId
  workspaceContextJournal.record({
    type: 'task-started',
    source: 'workspace',
    role: 'user',
    platformId,
    taskId: workspaceTaskId,
  }, journalGeneration)
  emit({ type: 'task-started', agentId: coordinatorId, taskId: workspaceTaskId })
  const finishTask = (
    status: 'complete' | 'partial' | 'failed',
    agentId: string,
    error?: string,
  ): void => {
    workspaceContextJournal.record({
      type: 'task-finished',
      source: 'workspace',
      role: 'system',
      platformId,
      agentId,
      taskId: workspaceTaskId,
      success: status === 'complete',
      ...(error ? { text: error } : {}),
    }, journalGeneration)
    emit({
      type: 'task-finished',
      agentId,
      taskId: workspaceTaskId,
      status,
      ...(error ? { error } : {}),
    })
  }
  const sendTrackedPrompt = async (
    message: string,
    targetPlatformId: string,
    agentId: string,
  ): Promise<string> => {
    const promptWithContext = message.length + contextInstruction.length <= MAX_AGENT_TASK_LENGTH
      ? `${message}${contextInstruction}`
      : message
    workspaceContextJournal.record({
      type: 'agent-task',
      source: 'web-relay',
      role: 'user',
      platformId: targetPlatformId,
      agentId,
      taskId: workspaceTaskId,
      text: promptWithContext,
    }, journalGeneration)
    try {
      const response = await sendPrompt(promptWithContext, targetPlatformId, agentId)
      workspaceContextJournal.record({
        type: 'agent-message',
        source: 'web-relay',
        role: 'assistant',
        platformId: targetPlatformId,
        agentId,
        taskId: workspaceTaskId,
        text: response,
      }, journalGeneration)
      return response
    } catch (error) {
      workspaceContextJournal.record({
        type: 'agent-error',
        source: 'web-relay',
        role: 'system',
        platformId: targetPlatformId,
        agentId,
        taskId: workspaceTaskId,
        text: error instanceof Error ? error.message : String(error),
        success: false,
      }, journalGeneration)
      throw error
    }

  }

  if (directAgentId) {
    const target = readyAgents.find(agent => agent.agentId === directAgentId)
    if (!target) {
      throw new Error(`El Relay seleccionado (${directAgentId}) no está listo o no pertenece al pool Web Relay de ${platformId}.`)
    }
    emit({ type: 'agent-ready', agentId: target.agentId, role: isWebCoordinatorRole(target.role) ? 'coordinador' : 'worker' })
    try {
      const response = await sendTrackedPrompt(normalizedPrompt, target.platformId, target.agentId)
      emit({ type: 'direct-response', agentId: target.agentId, response })
      finishTask('complete', target.agentId)
      return {
        dispatchMode: 'direct',
        coordinatorId: target.agentId,
        directAgentId: target.agentId,
        directResponse: response,
        workerResponses: [],
      }
    } catch (error) {
      finishTask('failed', target.agentId, error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  const apiBrain = orchestratorBrain === 'api'
  const coordinator = apiBrain
    ? undefined
    : coordinatorAgentId
      ? readyAgents.find(agent => agent.agentId === coordinatorAgentId && isWebCoordinatorRole(agent.role))
      : readyAgents.find(agent => agent.role === 'primary') ??
        readyAgents.find(agent => isWebCoordinatorRole(agent.role))
  if (!apiBrain && coordinatorAgentId && !coordinator) {
    throw new Error(`La instancia coordinadora seleccionada (${coordinatorAgentId}) no está lista o no pertenece al pool Web Relay de ${platformId}.`)
  }
  const workers = coordinator
    ? readyAgents.filter(agent => !isWebCoordinatorRole(agent.role))
    : apiBrain
      ? readyAgents.filter(agent => !agent.role?.startsWith('manual-user-'))
      : []
  if (apiBrain && workers.length === 0) {
    throw new Error('El cerebro API necesita al menos un worker Web Relay listo.')
  }
  if (!apiBrain && coordinatorAgentId && workers.length === 0) {
    throw new Error('El coordinador Web seleccionado necesita al menos un worker Web Relay listo.')
  }
  if (!apiBrain && (!coordinator || workers.length === 0)) {
    const target = coordinator ?? readyAgents[0]!
    emit({ type: 'agent-ready', agentId: target.agentId, role: isWebCoordinatorRole(target.role) ? 'coordinador' : 'worker' })
    try {
      const response = await sendTrackedPrompt(normalizedPrompt, target.platformId, target.agentId)
      emit({ type: 'direct-response', agentId: target.agentId, response })
      finishTask('complete', target.agentId)
      return {
        dispatchMode: 'direct',
        coordinatorId: target.agentId,
        directAgentId: target.agentId,
        directResponse: response,
        workerResponses: [],
      }
    } catch (error) {
      finishTask('failed', target.agentId, error instanceof Error ? error.message : String(error))
      throw error
    }
  }
  const activeCoordinatorId = apiBrain ? API_ORCHESTRATOR_AGENT_ID : coordinator!.agentId
  const runCoordinatorPrompt = async (message: string): Promise<string> => {
    if (!apiBrain) {
      return sendTrackedPrompt(message, coordinator!.platformId, coordinator!.agentId)
    }
    const messageWithContext = message.length + contextInstruction.length <= MAX_AGENT_TASK_LENGTH
      ? `${message}${contextInstruction}`
      : message
    workspaceContextJournal.record({
      type: 'agent-task',
      source: 'workspace',
      role: 'user',
      platformId: 'api',
      agentId: API_ORCHESTRATOR_AGENT_ID,
      taskId: workspaceTaskId,
      text: messageWithContext,
    }, journalGeneration)
    try {
      const response = await (generateCoordinatorResponse ?? generateApiOrchestratorResponse)(messageWithContext)
      workspaceContextJournal.record({
        type: 'agent-message',
        source: 'workspace',
        role: 'assistant',
        platformId: 'api',
        agentId: API_ORCHESTRATOR_AGENT_ID,
        taskId: workspaceTaskId,
        text: response,
      }, journalGeneration)
      return response
    } catch (error) {
      workspaceContextJournal.record({
        type: 'agent-error',
        source: 'workspace',
        role: 'system',
        platformId: 'api',
        agentId: API_ORCHESTRATOR_AGENT_ID,
        taskId: workspaceTaskId,
        text: error instanceof Error ? error.message : String(error),
        success: false,
      }, journalGeneration)
      throw error
    }
  }
  emit({ type: 'agent-ready', agentId: activeCoordinatorId, role: 'coordinador' })
  for (const worker of workers) {
    emit({ type: 'agent-ready', agentId: worker.agentId, role: 'worker' })
  }
  const result: WebRelayCoordinatorResult = {
    dispatchMode: 'coordinated',
    coordinatorId: activeCoordinatorId,
    workerResponses: [],
  }

  emit({ type: 'planning-started', agentId: activeCoordinatorId })
  const toolAccessGuidance = apiBrain
    ? 'No tienes acceso a herramientas ni puedes inspeccionar el estado runtime. No afirmes que consultaste herramientas.'
    : 'Si la solicitud requiere diagnosticar el estado vivo de los relays, puedes consultar las herramientas ' +
      'openmcp_read_activity u openmcp_watch_activity para obtener eventos estructurados compartidos. No incluyas ' +
      'contenido de prompts, respuestas ni argumentos de herramientas en hallazgos de telemetría.'
  const planningPrompt =
    'Actúas como coordinador de un equipo Web Relay. Divide la tarea solicitada en una instrucción concreta y ' +
    'complementaria para CADA worker disponible. No ejecutes la tarea todavía. Devuelve únicamente JSON válido con ' +
    'esta forma: {"tasks":[{"agentId":"ID_EXACTO","prompt":"instrucción"}]}. ' +
    'No inventes IDs; usa cada worker una sola vez y no te asignes trabajo. La instrucción debe respetar el alcance ' +
    'y las restricciones de la petición original.\n\n' +
    `TAREA DEL USUARIO:\n${normalizedPrompt}\n\n` +
    `WORKERS DISPONIBLES:\n${workers.map(worker => `${worker.agentId} (rol ${worker.role ?? 'worker'})`).join('\n')}\n\n` +
    toolAccessGuidance
  let planningResponse: string
  let plan: CoordinatorPlan
  try {
    planningResponse = await runCoordinatorPrompt(planningPrompt)
    result.planningResponse = planningResponse
    emit({ type: 'plan-ready', agentId: activeCoordinatorId, response: planningResponse })
    plan = parseCoordinatorPlan(planningResponse, workers.map(worker => worker.agentId))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    workspaceContextJournal.record({
      type: 'agent-error',
      source: 'workspace',
      role: 'system',
      platformId: apiBrain ? 'api' : coordinator!.platformId,
      agentId: activeCoordinatorId,
      taskId: workspaceTaskId,
      text: detail,
      success: false,
    }, journalGeneration)
    finishTask('failed', activeCoordinatorId, detail)
    throw error
  }

  for (const task of plan.tasks) {
    emit({ type: 'worker-started', agentId: task.agentId, prompt: task.prompt })
    try {
      const worker = workers.find(agent => agent.agentId === task.agentId)!
      const response = await sendTrackedPrompt(task.prompt, worker.platformId, task.agentId)
      result.workerResponses.push({ agentId: task.agentId, task: task.prompt, response })
      emit({ type: 'worker-response', agentId: task.agentId, response })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      result.workerResponses.push({ agentId: task.agentId, task: task.prompt, error: detail })
      emit({ type: 'worker-error', agentId: task.agentId, error: detail })
    }
  }

  emit({ type: 'review-started', agentId: activeCoordinatorId })
  const reviewPrompt =
    'Supervisa el avance de tu equipo y entrega el siguiente paso recomendado al usuario. Distingue hechos de ' +
    'incertidumbres, señala discrepancias y no afirmes que una tarea fallida se completó. Conserva las respuestas ' +
    'originales de los workers como fuente; tu respuesta debe ser seguimiento, no una síntesis que las sustituya. ' +
    (apiBrain
      ? 'No tienes acceso a herramientas ni puedes verificar el estado runtime; distingue hechos reportados de inferencias.\n\n'
      : 'Si necesitas verificar el estado operativo, puedes consultar las herramientas openmcp_read_activity u ' +
        'openmcp_watch_activity disponibles en el MCP compartido. Distingue eventos observados de inferencias.\n\n') +
    `TAREA ORIGINAL:\n${normalizedPrompt}\n\n` +
    `PLAN QUE PROPUSISTE:\n${planningResponse}\n\n` +
    `RESULTADOS DE LOS WORKERS:\n${result.workerResponses.map(item =>
      `--- ${item.agentId} ---\nTarea: ${item.task}\n` +
      (item.response !== undefined ? `Respuesta:\n${item.response}` : `Error:\n${item.error}`),
    ).join('\n\n')}`

  try {
    result.reviewResponse = await runCoordinatorPrompt(reviewPrompt)
    emit({
      type: 'review-response',
      agentId: activeCoordinatorId,
      response: result.reviewResponse,
    })
  } catch (error) {
    result.reviewError = error instanceof Error ? error.message : String(error)
    emit({ type: 'review-error', agentId: activeCoordinatorId, error: result.reviewError })
  }

  const failedWorkers = result.workerResponses.filter(item => item.error !== undefined).length
  finishTask(
    failedWorkers || result.reviewError ? 'partial' : 'complete',
    activeCoordinatorId,
    failedWorkers || result.reviewError
      ? `${failedWorkers} worker(s) failed${result.reviewError ? '; review failed' : ''}.`
      : undefined,
  )
  return result
}
