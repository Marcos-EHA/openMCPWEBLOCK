import { randomUUID } from 'node:crypto'
import type { OrchestratorTool } from './GeminiOrchestrator.js'
import type { AgentSessionMode, AgentState } from '../webRelay/orchestration/types.js'
import { sharedActivityJournal, type SharedActivitySource } from '../observability/SharedActivityJournal.js'
import {
  initializeSharedActivitySources,
  recordRelayExecutionActivity,
} from '../observability/SharedActivitySources.js'

export const MAX_SENTINEL_LAUNCH_COUNT = 5

export type SentinelInstanceEvent =
  | { type: 'launch-started'; agentId: string; index: number; total: number }
  | { type: 'instance-ready'; agentId: string; index: number; total: number }
  | { type: 'request-started'; agentId: string; prompt: string }
  | { type: 'response'; agentId: string; response: string }
  | { type: 'request-error'; agentId: string; error: string }
  | { type: 'stop-started'; agentId: string }
  | { type: 'instance-stopped'; agentId: string }

export interface SentinelInstanceToolDependencies {
  getPlatform: () => { id: string; name: string } | undefined
  getAgents: () => Record<string, AgentState>
  startAgent: (
    agentId: string,
    platformId: string,
    role: string,
    sessionMode: AgentSessionMode,
  ) => Promise<AgentState>
  stopAgent: (agentId: string) => Promise<AgentState>
  removeAgent: (agentId: string) => Promise<void>
  prepareAgent: (debugPort: number, extensionId?: string) => Promise<unknown>
  persistAgents: (agentIds: string[], platformId: string) => void
  persistStoppedAgents: (agentIds: string[]) => void
  sendPrompt: (prompt: string, platformId: string, agentId: string) => Promise<string>
  onInstanceEvent?: (event: SentinelInstanceEvent) => void
}

export function createSentinelInstanceTools(
  dependencies: SentinelInstanceToolDependencies,
): OrchestratorTool[] {
  const emitInstanceEvent = (event: SentinelInstanceEvent): void => {
    const details: Record<string, string | number | boolean | null> = { phase: event.type }
    if ('index' in event) details.index = event.index
    if ('total' in event) details.total = event.total
    if ('prompt' in event) details.promptLength = event.prompt.length
    if ('response' in event) details.responseLength = event.response.length
    if ('error' in event) details.errorPresent = event.error.length > 0
    sharedActivityJournal.append({
      source: 'sentinel',
      event: `sentinel-instance:${event.type}`,
      agentId: event.agentId,
      details,
    })
    dependencies.onInstanceEvent?.(event)
  }

  return [{
    name: 'launch_guest_web_instances',
    description:
      'Lanza de 1 a 5 instancias Web Relay nuevas de la plataforma actualmente seleccionada, ' +
      'en perfiles guest/clean con SuperAssistant preparado. Nunca usa ni modifica la sesión maestra. ' +
      'Usa esta herramienta solo cuando el usuario pida claramente lanzar instancias y haya indicado cuántas.',
    parameters: {
      type: 'object',
      properties: {
        count: {
          type: 'integer',
          description: `Cantidad de instancias guest/clean que se solicita lanzar (1-${MAX_SENTINEL_LAUNCH_COUNT}).`,
        },
      },
      required: ['count'],
    },
    execute: async args => {
      const count = args.count
      if (
        typeof count !== 'number' ||
        !Number.isInteger(count) ||
        count < 1 ||
        count > MAX_SENTINEL_LAUNCH_COUNT
      ) {
        throw new Error(`La cantidad debe ser un entero entre 1 y ${MAX_SENTINEL_LAUNCH_COUNT}.`)
      }

      const platform = dependencies.getPlatform()
      if (!platform) {
        throw new Error('No hay una plataforma Web Relay válida seleccionada. Configúrala desde [⚙ Instancias].')
      }

      const occupiedIds = new Set(Object.keys(dependencies.getAgents()))
      const launched: AgentState[] = []

      try {
        while (launched.length < count) {
          const agentId = `sentinel-${platform.id}-guest-${randomUUID()}`
          if (occupiedIds.has(agentId)) continue
          occupiedIds.add(agentId)

          emitInstanceEvent({
            type: 'launch-started',
            agentId,
            index: launched.length + 1,
            total: count,
          })
          const agent = await dependencies.startAgent(
            agentId,
            platform.id,
            `sentinel-guest-${launched.length + 1}`,
            'clean',
          )
          launched.push(agent)

          if (agent.status !== 'ready' || agent.sessionMode !== 'clean' || !agent.debugPort) {
            throw new Error(
              `${agentId} no quedó listo como perfil guest/clean ` +
              `(estado ${agent.status}, sesión ${agent.sessionMode ?? 'desconocida'}).`,
            )
          }
          await dependencies.prepareAgent(agent.debugPort, agent.saExtensionId)
          emitInstanceEvent({
            type: 'instance-ready',
            agentId,
            index: launched.length,
            total: count,
          })
        }

        const agentIds = launched.map(agent => agent.agentId)
        dependencies.persistAgents(agentIds, platform.id)
        return `Listo: lancé ${agentIds.length} instancia(s) invitada(s) de ${platform.name}, ` +
          `con SuperAssistant preparado y sesión guest/clean. IDs: ${agentIds.join(', ')}. ` +
          'No se usó ni modificó la sesión maestra.'
      } catch (error) {
        const cleanupResults = await Promise.allSettled(
          launched.map(agent => dependencies.stopAgent(agent.agentId)),
        )
        const cleanupFailures = cleanupResults.flatMap((result, index) =>
          result.status === 'rejected'
            ? [`${launched[index]!.agentId}: ${String(result.reason)}`]
            : result.value.status !== 'stopped'
              ? [`${launched[index]!.agentId}: detención no confirmada (${result.value.status})`]
              : [],
        )
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(
          cleanupFailures.length > 0
            ? `${message} No se pudo limpiar: ${cleanupFailures.join('; ')}.`
            : `${message} Las instancias iniciadas por esta operación se detuvieron.`,
        )
      }
    },
  }, {
    name: 'list_guest_web_instances',
    description:
      'Lista el estado de las instancias guest/clean de Sentinel conocidas por el runner de esta sesión. ' +
      'No enumera todas las ventanas Chrome del dispositivo: instancias abiertas desde otro proceso pueden no aparecer ni ser gestionables aquí. ' +
      'Úsala para saber a qué instancias puede enviar una consulta o cuáles puede detener.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const platform = dependencies.getPlatform()
      if (!platform) throw new Error('No hay una plataforma Web Relay válida seleccionada.')
      const agents = Object.values(dependencies.getAgents())
        .filter(agent =>
          agent.platformId === platform.id &&
          agent.sessionMode === 'clean' &&
          agent.agentId.startsWith(`sentinel-${platform.id}-guest-`),
        )
        .sort((left, right) => left.agentId.localeCompare(right.agentId))
      if (agents.length === 0) {
        return `No hay instancias guest/clean de Sentinel registradas para ${platform.name} en esta sesión. ` +
          'Ventanas abiertas desde otro proceso pueden no aparecer ni ser gestionables aquí.'
      }
      return `${agents.length} instancia(s) guest/clean registradas en esta sesión de OpenMCPWEBLOCK:\n` +
        agents.map(agent =>
          `${agent.agentId}: ${agent.status}${agent.status === 'ready'
            ? ` (disponible; CDP ${agent.debugPort ?? 'desconocido'})`
            : ''}`,
        ).join('\n') +
        '\nNota: ventanas abiertas desde otro proceso pueden no aparecer ni ser gestionables aquí.'
    },
  }, {
    name: 'ask_guest_web_instances',
    description:
      'Envía una tarea de seguimiento a una o más instancias Web Relay guest/clean listas. ' +
      'Si el usuario pide analizar una carpeta/código, usa una primera tarea de reconocimiento de solo lectura ' +
      '(estructura, README y manifiestos; evita .env, secretos y credenciales); espera su respuesta visible y úsala ' +
      'para decidir la siguiente tarea específica. Puedes llamar esta herramienta otra vez con la nueva tarea. ' +
      'No pidas confirmación adicional para una ruta y análisis de solo lectura que el usuario ya pidió. ' +
      'Las respuestas completas se muestran por separado al usuario; no las reemplaces con una síntesis. ' +
      'No envíes información privada o contenido del proyecto que el usuario no haya pedido analizar. ' +
      'Si se omiten IDs, usa las instancias invitadas listas registradas en esta sesión (máximo 5).',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Instrucción/tarea específica para esta fase del análisis delegado.' },
        agentIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'IDs opcionales de instancias guest/clean específicas; si se omite, usar todas las listas.',
        },
      },
      required: ['prompt'],
    },
    execute: async args => {
      const prompt = args.prompt
      if (typeof prompt !== 'string' || !prompt.trim()) {
        throw new Error('La pregunta a enviar a las instancias no puede estar vacía.')
      }
      if (prompt.length > 12_000) {
        throw new Error('La pregunta excede el límite de 12000 caracteres para Web Relay.')
      }
      const platform = dependencies.getPlatform()
      if (!platform) throw new Error('No hay una plataforma Web Relay válida seleccionada.')

      const requestedIds = args.agentIds
      let requestedAgentIds: string[] | undefined
      if (requestedIds !== undefined) {
        if (
          !Array.isArray(requestedIds) ||
          requestedIds.some(agentId => typeof agentId !== 'string') ||
          requestedIds.length === 0 ||
          requestedIds.length > MAX_SENTINEL_LAUNCH_COUNT
        ) {
          throw new Error(`agentIds debe contener de 1 a ${MAX_SENTINEL_LAUNCH_COUNT} IDs de instancia válidos.`)
        }
        requestedAgentIds = requestedIds.filter((agentId): agentId is string => typeof agentId === 'string')
      }

      const configuredIds = new Set(
        Object.values(dependencies.getAgents())
          .filter(agent =>
            agent.platformId === platform.id &&
            agent.sessionMode === 'clean' &&
            agent.status === 'ready' &&
            agent.agentId.startsWith(`sentinel-${platform.id}-guest-`),
          )
          .map(agent => agent.agentId),
      )
      const agentIds = requestedAgentIds === undefined
        ? [...configuredIds]
        : [...new Set(requestedAgentIds)]
      if (agentIds.some(agentId => !configuredIds.has(agentId))) {
        throw new Error('Solo se pueden consultar instancias guest/clean listas de Sentinel en la plataforma seleccionada.')
      }
      if (agentIds.length === 0) {
        throw new Error(`No hay instancias guest/clean listas para ${platform.name}. Lanza una primero.`)
      }

      const results: string[] = []
      for (const agentId of agentIds) {
        emitInstanceEvent({
          type: 'request-started',
          agentId,
          prompt: prompt.trim(),
        })
        try {
          const response = await dependencies.sendPrompt(prompt.trim(), platform.id, agentId)
          emitInstanceEvent({ type: 'response', agentId, response })
          results.push(`Respuesta de ${agentId}:\n${response}`)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          emitInstanceEvent({ type: 'request-error', agentId, error: detail })
          results.push(`Error consultando ${agentId}: ${detail}`)
        }
      }
      return results.join('\n\n')
    },
  }, {
    name: 'stop_guest_web_instances',
    description:
      'Detiene las instancias Web Relay guest/clean creadas y gestionadas por Sentinel para la plataforma seleccionada. ' +
      'Usa esta herramienta solo si el usuario pide detener/cerrar las instancias. ' +
      'Nunca detiene perfiles autenticados ni la sesión maestra.',
    parameters: {
      type: 'object',
      properties: {
        agentIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'IDs opcionales a detener; si se omite, detiene todas las instancias guest de Sentinel.',
        },
      },
    },
    execute: async args => {
      const platform = dependencies.getPlatform()
      if (!platform) throw new Error('No hay una plataforma Web Relay válida seleccionada.')
      const managed = Object.values(dependencies.getAgents()).filter(agent =>
        agent.platformId === platform.id &&
        agent.sessionMode === 'clean' &&
        agent.agentId.startsWith(`sentinel-${platform.id}-guest-`) &&
        agent.status !== 'stopped',
      )
      const requestedIds = args.agentIds
      let requestedAgentIds: string[] | undefined
      if (requestedIds !== undefined) {
        if (
          !Array.isArray(requestedIds) ||
          requestedIds.some(agentId => typeof agentId !== 'string') ||
          requestedIds.length === 0 ||
          requestedIds.length > MAX_SENTINEL_LAUNCH_COUNT
        ) {
          throw new Error(`agentIds debe contener de 1 a ${MAX_SENTINEL_LAUNCH_COUNT} IDs válidos.`)
        }
        requestedAgentIds = requestedIds.filter((agentId): agentId is string => typeof agentId === 'string')
      }
      const chosen = requestedAgentIds === undefined
        ? managed
        : managed.filter(agent => requestedAgentIds.includes(agent.agentId))
      if (requestedAgentIds !== undefined && chosen.length !== new Set(requestedAgentIds).size) {
        throw new Error('Solo se pueden detener instancias guest/clean de Sentinel; se rechazó la selección.')
      }
      if (chosen.length === 0) return `No hay instancias guest de Sentinel activas para ${platform.name}.`

      const stopped: string[] = []
      for (const agent of chosen) {
        emitInstanceEvent({ type: 'stop-started', agentId: agent.agentId })
        const result = await dependencies.stopAgent(agent.agentId)
        if (result.status !== 'stopped') {
          throw new Error(`No se confirmó la detención de ${agent.agentId} (estado ${result.status}).`)
        }
        dependencies.persistStoppedAgents([agent.agentId])
        await dependencies.removeAgent(agent.agentId)
        emitInstanceEvent({ type: 'instance-stopped', agentId: agent.agentId })
        stopped.push(agent.agentId)
      }
      return `Detuve ${stopped.length} instancia(s) guest de ${platform.name}: ${stopped.join(', ')}. La sesión maestra no se tocó.`
    },
  }, {
    name: 'openmcp_read_activity',
    description:
      'Lee la misma bitácora estructurada que comparten Sentinel, coordinador y workers: etapas MCP, ejecución, ' +
      'salud y coordinación. Usa afterSequence para continuar desde el último cursor. Opcionalmente consulta hasta ' +
      '10 relays registrados para importar su telemetría técnica reciente. No incluye prompts, respuestas, argumentos ni chats.',
    parameters: {
      type: 'object',
      properties: {
        afterSequence: { type: 'integer', description: 'Cursor; devuelve eventos posteriores.' },
        limit: { type: 'integer', description: 'Límite de eventos 1-200; predeterminado 100.' },
        agentIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'IDs exactos de relays registrados a consultar por CDP (máximo 10).',
        },
        sources: {
          type: 'array',
          items: { type: 'string', enum: ['mcp', 'orchestration', 'sentinel', 'collaboration', 'coordinator', 'execution'] },
        },
      },
    },
    execute: async args => {
      await initializeSharedActivitySources()
      const afterSequence = args.afterSequence ?? 0
      const limit = args.limit ?? 100
      if (typeof afterSequence !== 'number' || !Number.isSafeInteger(afterSequence) || afterSequence < 0) {
        throw new Error('afterSequence debe ser un entero seguro no negativo.')
      }
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new Error('limit debe ser un entero entre 1 y 200.')
      }
      const requestedAgentIds = args.agentIds
      if (
        requestedAgentIds !== undefined &&
        (!Array.isArray(requestedAgentIds) || requestedAgentIds.length > 10 ||
          requestedAgentIds.some(id => typeof id !== 'string' || id.trim().length === 0))
      ) {
        throw new Error('agentIds debe contener hasta 10 IDs no vacíos.')
      }
      const sourceValues = args.sources
      const availableSources: SharedActivitySource[] = [
        'mcp',
        'orchestration',
        'sentinel',
        'collaboration',
        'coordinator',
        'execution',
      ]
      if (
        sourceValues !== undefined &&
        (!Array.isArray(sourceValues) || sourceValues.length === 0 ||
          sourceValues.some(source =>
            typeof source !== 'string' || !availableSources.includes(source as SharedActivitySource),
          ))
      ) {
        throw new Error(`sources solo acepta: ${availableSources.join(', ')}.`)
      }
      const agentIds = requestedAgentIds
        ? [...new Set(requestedAgentIds.map(id => (id as string).trim()))]
        : undefined
      if (agentIds) {
        const currentAgents = dependencies.getAgents()
        for (const agentId of agentIds) {
          if (!currentAgents[agentId]) {
            throw new Error(`Sentinel no puede consultar el Relay no registrado "${agentId}".`)
          }
        }
        const { readAgentExecutionActivity } = await import('../webRelay/orchestration/Sentinel.js')
        await Promise.all(agentIds.map(async agentId => {
          const snapshot = await readAgentExecutionActivity(agentId)
          if (!snapshot.available) {
            sharedActivityJournal.appendOnce(
              `sentinel-relay-unavailable\u0000${agentId}\u0000${snapshot.unavailableReason ?? 'unknown'}`,
              {
                source: 'execution',
                event: 'relay:activity-unavailable',
                agentId,
                details: { reason: snapshot.unavailableReason ?? 'unknown' },
              },
            )
            return
          }
          for (const event of snapshot.events) recordRelayExecutionActivity(agentId, event)
        }))
      }
      return JSON.stringify({
        capturedAt: new Date().toISOString(),
        ...sharedActivityJournal.read({
          afterSequence,
          limit,
          ...(agentIds ? { agentIds } : {}),
          ...(sourceValues ? { sources: sourceValues as SharedActivitySource[] } : {}),
        }),
      })
    },
  }]
}
