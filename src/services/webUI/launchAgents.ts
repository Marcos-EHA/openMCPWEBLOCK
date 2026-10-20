import { randomUUID } from 'crypto'
import { relayBus } from '../webRelay/orchestration/RelayBus.js'
import { prepareSAAgentForWebRelay, verifyWebRelayStartup } from '../webRelay/WebRelayProvider.js'
import { closeMasterSession, SessionBroker } from '../webRelay/session/SessionBroker.js'
import { verifyChatGPTAuth } from '../webRelay/session/ChatGPTAuthVerifier.js'
import { openMasterSessionSource } from '../webRelay/session/MasterSessionController.js'
import { getMasterSessionSource } from '../webRelay/session/MasterSessionRegistry.js'
import {
  closeChromeBeforeProfileCopy,
  listChromeProfileSources,
} from '../webRelay/session/ChromeProfileRegistry.js'
import { getMinimumRelayCount, isWebCoordinatorRole, selectStartupReadyRelays } from '../webRelay/launchPolicy.js'
import type { AgentState } from '../webRelay/orchestration/types.js'
import { sharedActivityJournal } from '../observability/SharedActivityJournal.js'
import { workspaceInstanceLaunchHistoryStore } from './WorkspaceInstanceLaunchHistoryStore.js'

interface LaunchOpts {
  platformId: string
  purpose: 'agent' | 'user'
  launchCoordinator?: boolean
  coordinatorCount?: number
  count: number
  sessionModes: string[]
  masterSessionSourceIds?: Array<string | undefined>
  chromeProfileDirectories?: Array<string | undefined>
  allowChromeProfileCopy?: boolean
  onProgress?: (msg: string) => void
}

interface LaunchResult {
  success: boolean
  readyAgents: AgentState[]
  failures: string[]
  error?: string
}

const MAX_BATCH = 3

export async function launchWebRelayAgents(opts: LaunchOpts): Promise<LaunchResult> {
  const {
    platformId,
    purpose,
    count,
    sessionModes,
    masterSessionSourceIds = [],
    chromeProfileDirectories = [],
    allowChromeProfileCopy = false,
    onProgress,
  } = opts
  const requestedCoordinatorCount = purpose === 'agent' && opts.launchCoordinator !== false
    ? opts.coordinatorCount ?? 1
    : 0
  if (!Number.isInteger(requestedCoordinatorCount) || requestedCoordinatorCount < 0 ||
    requestedCoordinatorCount >= count) {
    return {
      success: false,
      readyAgents: [],
      failures: [],
      error: 'El lanzamiento debe reservar al menos un Relay worker además de los orquestadores Web.',
    }
  }
  if (purpose === 'agent' && opts.launchCoordinator !== false && requestedCoordinatorCount === 0) {
    return {
      success: false,
      readyAgents: [],
      failures: [],
      error: 'El cerebro Web requiere al menos un candidato a orquestador.',
    }
  }
  const launchCoordinator = requestedCoordinatorCount > 0
  const failures: string[] = []
  const attempted: string[] = []
  const openedMasterSources: string[] = []
  const say = (m: string) => { if (onProgress) onProgress(m) }

  const stopViaBus = async (agentId: string) => {
    try { await relayBus.send({ type: 'command', name: 'agent:stop', payload: { agentId } }) } catch { }
  }

  try {
    if (launchCoordinator) {
      const existingCoordinator = (await relayBus.query({
        type: 'query',
        name: 'agent:list',
      })).find(agent =>
        isWebCoordinatorRole(agent.role) &&
        agent.status !== 'stopped' &&
        agent.status !== 'error',
      )
      if (existingCoordinator) {
        throw new Error(
          `Ya existe un pool con orquestador Web registrado (${existingCoordinator.agentId}, ` +
          `estado ${existingCoordinator.status}). Detén o retira ese pool antes de lanzar otro.`,
        )
      }
    }

    // Master Session validation
    const authIds = [...new Set(masterSessionSourceIds.filter(Boolean))] as string[]
    for (const sid of authIds) {
      say('Validando Master Session: ' + sid)
      const src = getMasterSessionSource(sid)
      if (src.platformId !== platformId) throw new Error('Master Session ' + src.name + ' no es para ' + platformId)
      let st = await SessionBroker.getInstance().getMasterStatus(sid)
      let openedForTransfer = false
      if (!st.active) {
        say('Abriendo ' + src.name)
        await openMasterSessionSource(sid)
        openedForTransfer = true
        openedMasterSources.push(sid)
        st = await SessionBroker.getInstance().getMasterStatus(sid)
      }
      if (!st.hasValidSession) {
        if (openedForTransfer) openedMasterSources.splice(openedMasterSources.indexOf(sid), 1)
        throw new Error('Master Session ' + src.name + ' no autenticada')
      }
    }
    if (sessionModes.includes('chrome-profile') && !allowChromeProfileCopy) {
      throw new Error('Confirma la copia aislada del perfil local de Chrome antes de lanzar.')
    }
    const availableChromeProfiles = sessionModes.some(mode => mode === 'chrome-profile')
      ? listChromeProfileSources()
      : []
    for (let index = 0; index < count; index++) {
      if (sessionModes[index] !== 'chrome-profile') continue
      if (platformId !== 'chatgpt') {
        throw new Error('Los perfiles locales de Chrome solo están disponibles para ChatGPT.')
      }
      const profileId = chromeProfileDirectories[index]
      if (!profileId || !availableChromeProfiles.some(profile => profile.id === profileId)) {
        throw new Error(`Selecciona un perfil local de Chrome válido para la instancia ${index + 1}.`)
      }
    }
    const selectedChromeProfileIds = sessionModes.flatMap((mode, index) => {
      const profileId = chromeProfileDirectories[index]
      return mode === 'chrome-profile' && profileId ? [profileId] : []
    })
    for (const profileId of new Set(selectedChromeProfileIds)) {
      await closeChromeBeforeProfileCopy(profileId)
    }

    // Launch plan
    const plan = Array.from({ length: count }, (_, i) => {
      const isCoordinator = i < requestedCoordinatorCount
      const workerIndex = i - requestedCoordinatorCount
      const profileIndex = i
      return {
        agentId: 'web-' + platformId + '-' + purpose + '-' + randomUUID(),
        mode: sessionModes[profileIndex] || 'clean',
        sourceId: masterSessionSourceIds[profileIndex],
        chromeProfileDirectory: chromeProfileDirectories[profileIndex],
        role: purpose === 'user'
          ? 'manual-user-' + (i + 1)
          : isCoordinator
            ? i === 0 ? 'primary' : `orchestrator-${i + 1}`
            : 'worker-' + (workerIndex + 1),
      }
    })
    const states: AgentState[] = []
    const prepared: AgentState[] = []
    const coordinatorPlan = launchCoordinator
      ? plan.filter(instance => isWebCoordinatorRole(instance.role))
      : []
    const workerPlan = launchCoordinator
      ? plan.filter(instance => !isWebCoordinatorRole(instance.role))
      : plan
    const batchSize = launchCoordinator || plan.some(instance =>
      instance.mode === 'authenticated' || instance.mode === 'chrome-profile',
    )
      ? 1
      : MAX_BATCH

    const startPlan = async (instances: typeof plan): Promise<void> => {
      for (let index = 0; index < instances.length; index += batchSize) {
        const batch = instances.slice(index, index + batchSize)
        attempted.push(...batch.map(instance => instance.agentId))
        const results = await Promise.allSettled(batch.map(async instance => {
          say('Iniciando ' + instance.role + ': ' + instance.agentId)
          await workspaceInstanceLaunchHistoryStore.append({
            instanceId: instance.agentId,
            status: 'starting',
            detail: `Inicio solicitado · ${instance.role} · ${platformId}`,
          })
          const state = await relayBus.send({
            type: 'command',
            name: 'agent:start',
            payload: {
              agentId: instance.agentId,
              platformId,
              role: instance.role,
              sessionMode: instance.mode as any,
              ...(instance.sourceId ? { masterSessionSourceId: instance.sourceId } : {}),
              ...(instance.chromeProfileDirectory
                ? { chromeProfileDirectory: instance.chromeProfileDirectory }
                : {}),
            },
          }) as AgentState
          say(instance.agentId + ': ' + state.status)
          if (state.status !== 'ready' || !state.debugPort) {
            await workspaceInstanceLaunchHistoryStore.append({
              instanceId: instance.agentId,
              status: 'failed',
              detail: `Inicio detenido en ${state.status}${state.error ? ` · ${state.error}` : ''}`,
            })
          }
          return state
        }))
        for (const [batchIndex, result] of results.entries()) {
          const instance = batch[batchIndex]!
          const roleLabel = isWebCoordinatorRole(instance.role)
            ? `orquestador Web ${instance.role}`
            : instance.role
          if (result.status === 'rejected') {
            failures.push(`${roleLabel} (${instance.agentId}) failed to start: ${String(result.reason)}`)
            await workspaceInstanceLaunchHistoryStore.append({
              instanceId: instance.agentId,
              status: 'failed',
              detail: `No se pudo iniciar · ${String(result.reason)}`,
            })
            continue
          }
          states.push(result.value)
          if (result.value.status !== 'ready' ||
            result.value.sessionMode !== instance.mode ||
            !result.value.debugPort) {
            failures.push(
              `${roleLabel} (${instance.agentId}) did not pass startup gates ` +
              `(status ${result.value.status}, session ${result.value.sessionMode ?? 'unknown'}).` +
              (result.value.error ? ` ${result.value.error}` : ''),
            )
          }
        }
      }
    }

    const selectReady = (instances: typeof plan): AgentState[] => {
      const ids = new Set(instances.map(instance => instance.agentId))
      return selectStartupReadyRelays(
        states.filter(state => ids.has(state.agentId)),
        instances.map(instance => ({ agentId: instance.agentId, sessionMode: instance.mode as any })),
      )
    }

    const stopUnavailable = async (instances: typeof plan, readyAgents: AgentState[]): Promise<void> => {
      const readyIds = new Set(readyAgents.map(agent => agent.agentId))
      for (const instance of instances) {
        if (!readyIds.has(instance.agentId)) await stopViaBus(instance.agentId)
      }
    }

    const prepareAgents = async (agents: AgentState[]): Promise<AgentState[]> => {
      const preparedAgents: AgentState[] = []
      for (const agent of agents) {
        await relayBus.send({
          type: 'command',
          name: 'agent:sa-preparation-status',
          payload: { agentId: agent.agentId, preparing: true },
        })
        if (!agent.debugPort) {
          await workspaceInstanceLaunchHistoryStore.append({
            instanceId: agent.agentId,
            status: 'failed',
            detail: 'La instancia inició sin puerto de depuración.',
          })
          failures.push(
            `${isWebCoordinatorRole(agent.role) ? 'orquestador Web' : agent.role ?? 'Relay'} ` +
            `(${agent.agentId}): sin puerto de depuración`,
          )
          await stopViaBus(agent.agentId)
          continue
        }
        try {
          say('SA en puerto ' + agent.debugPort)
          await workspaceInstanceLaunchHistoryStore.append({
            instanceId: agent.agentId,
            status: 'preparing',
            detail: `Preparando SuperAssistant · puerto ${agent.debugPort}`,
          })
          await prepareSAAgentForWebRelay(agent.debugPort, agent.saExtensionId, platformId)
          if (agent.sessionMode === 'chrome-profile') {
            const auth = await verifyChatGPTAuth(agent.debugPort, {
              timeoutMs: 3000,
              pollIntervalMs: 500,
            })
            if (auth.status !== 'authenticated') {
              const usageInstruction = purpose === 'user'
                ? 'Inicia sesión en esa ventana Relay antes de usar ChatGPT'
                : 'Inicia sesión en esa ventana Relay antes de enviar tareas'
              failures.push(
                `${agent.role ?? 'Relay'} (${agent.agentId}): ChatGPT requiere inicio de sesión ` +
                `en la ventana Chrome de Relay (${auth.status}: ${auth.reason}). La sesión de Chrome normal ` +
                'y la aplicación ChatGPT no se comparten con esta copia aislada. La instancia quedó abierta; ' +
                `${usageInstruction}, o usa una Master Session persistente.`,
              )
            }
          }
          if (purpose === 'agent') {
            say(agent.agentId + ': enviando instrucciones iniciales y esperando confirmacion')
            await verifyWebRelayStartup(agent)
            say(agent.agentId + ': instrucciones iniciales confirmadas; herramientas pendientes de validacion operativa')
          }
          preparedAgents.push(await relayBus.send({
            type: 'command',
            name: 'agent:sa-preparation-status',
            payload: { agentId: agent.agentId, preparing: false },
          }) as AgentState)
          await workspaceInstanceLaunchHistoryStore.append({
            instanceId: agent.agentId,
            status: 'ready',
            detail: `Lista · ${agent.role ?? 'Relay'} · puerto ${agent.debugPort}`,
          })
        } catch (error) {
          await workspaceInstanceLaunchHistoryStore.append({
            instanceId: agent.agentId,
            status: 'failed',
            detail: `Falló la preparación · ${String(error)}`,
          })
          failures.push(
            `${isWebCoordinatorRole(agent.role) ? 'orquestador Web' : agent.role ?? 'Relay'} ` +
            `(${agent.agentId}, puerto ${agent.debugPort}): falló la preparación de SuperAssistant: ${String(error)}`,
          )
          await stopViaBus(agent.agentId)
        }
      }
      return preparedAgents
    }

    if (launchCoordinator) {
      await startPlan(coordinatorPlan)
      const readyCoordinators = selectReady(coordinatorPlan)
      await stopUnavailable(coordinatorPlan, readyCoordinators)
      const preparedCoordinators = await prepareAgents(readyCoordinators)
      if (preparedCoordinators.length === 0) {
        throw new Error(
          `0/${coordinatorPlan.length} candidatos a orquestador Web pasaron los gates de inicio y SuperAssistant; ` +
          'el coordinador Web no pasó la preparación de SuperAssistant.',
        )
      }
      prepared.push(...preparedCoordinators)
    }

    await startPlan(workerPlan)
    const readyWorkers = selectReady(workerPlan)
    await stopUnavailable(workerPlan, readyWorkers)
    prepared.push(...await prepareAgents(readyWorkers))

    const min = getMinimumRelayCount(purpose, launchCoordinator)
    const hasPreparedCoordinator = !launchCoordinator ||
      prepared.some(agent => isWebCoordinatorRole(agent.role))
    const hasPreparedWorker = !launchCoordinator ||
      prepared.some(agent => !isWebCoordinatorRole(agent.role))
    if (prepared.length < min || !hasPreparedCoordinator || !hasPreparedWorker) {
      throw new Error(
        prepared.length + '/' + count + ' preparados (min ' + min + ')' +
        (!hasPreparedCoordinator
          ? '; el coordinador Web no pasó el gate de inicio'
          : !hasPreparedWorker
            ? '; ningún worker pasó la preparación de SuperAssistant'
            : ''),
      )
    }

    say('Listo: ' + prepared.length + ' agentes operativos')
    await closeTemporarilyOpenedMasterSources(openedMasterSources, failures)
    recordLaunchWarnings(platformId, purpose, 'partial', failures)
    return { success: true, readyAgents: prepared, failures }

  } catch (err) {
    for (const id of attempted) await stopViaBus(id)
    await closeTemporarilyOpenedMasterSources(openedMasterSources, failures)
    recordLaunchWarnings(platformId, purpose, 'failed', failures, String(err))
    const detail = failures.length ? `\nDetalles:\n${failures.join('\n')}` : ''
    return { success: false, readyAgents: [], failures, error: `${String(err)}${detail}` }
  }
}

async function closeTemporarilyOpenedMasterSources(
  sourceIds: string[],
  failures: string[],
): Promise<void> {
  for (const sourceId of [...sourceIds].reverse()) {
    try {
      await closeMasterSession(sourceId)
    } catch (error) {
      const source = getMasterSessionSource(sourceId)
      failures.push(
        `No se pudo cerrar la Master Session temporal "${source.name}" (${sourceId}): ` +
        `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  sourceIds.length = 0
}

function recordLaunchWarnings(
  platformId: string,
  purpose: LaunchOpts['purpose'],
  status: 'partial' | 'failed',
  failures: string[],
  summary?: string,
): void {
  if (failures.length === 0 && !summary) return
  sharedActivityJournal.append({
    source: 'orchestration',
    event: 'relay:launch-warning',
    details: {
      platformId,
      purpose,
      status,
      failureCount: failures.length,
      ...(summary ? { summary } : {}),
    },
  })
  for (const failure of failures) {
    sharedActivityJournal.append({
      source: 'orchestration',
      event: 'relay:launch-instance-failure',
      details: { platformId, purpose, failure },
    })
  }
}

const activeAgentRestarts = new Map<string, Promise<AgentState>>()

export function restartWebRelayAgent(
  agent: AgentState,
  onProgress?: (message: string) => void,
): Promise<AgentState> {
  const active = activeAgentRestarts.get(agent.agentId)
  if (active) return active

  const operation = restartWebRelayAgentOnce(agent, onProgress)
  let pending!: Promise<AgentState>
  pending = operation.finally(() => {
    if (activeAgentRestarts.get(agent.agentId) === pending) {
      activeAgentRestarts.delete(agent.agentId)
    }
  })
  activeAgentRestarts.set(agent.agentId, pending)
  return pending
}

async function restartWebRelayAgentOnce(
  agent: AgentState,
  onProgress?: (message: string) => void,
): Promise<AgentState> {
  const say = (message: string) => onProgress?.(message)
  let openedMasterSourceId: string | undefined
  let operationError: unknown
  let restartedAgent: AgentState | undefined

  try {
    await workspaceInstanceLaunchHistoryStore.append({
      instanceId: agent.agentId,
      status: 'restarting',
      detail: `Reinicio solicitado · ${agent.role ?? 'Relay'} · ${agent.platformId}`,
    })
    if (agent.sessionMode === 'authenticated') {
      const sourceId = agent.masterSessionSourceId ?? 'loco-verde'
      const source = getMasterSessionSource(sourceId)
      if (source.platformId !== agent.platformId) {
        throw new Error(
          `Master Session "${source.name}" no es para la plataforma ${agent.platformId}.`,
        )
      }
      let status = await SessionBroker.getInstance().getMasterStatus(sourceId)
      let openedForTransfer = false
      if (!status.active) {
        say(`Abriendo temporalmente Master Session "${source.name}" para transferir la sesión.`)
        await openMasterSessionSource(sourceId)
        openedForTransfer = true
        openedMasterSourceId = sourceId
        status = await SessionBroker.getInstance().getMasterStatus(sourceId)
      }
      if (!status.hasValidSession) {
        if (openedForTransfer) openedMasterSourceId = undefined
        throw new Error(
          `Master Session "${source.name}" no está autenticada. Inicia sesión en su perfil y vuelve a reiniciar.`,
        )
      }
    }

    say(`Reiniciando ${isWebCoordinatorRole(agent.role) ? `orquestador Web ${agent.role}` : agent.role ?? 'Relay'}...`)
    restartedAgent = await relayBus.send({
      type: 'command',
      name: 'agent:restart',
      payload: { agentId: agent.agentId },
    }) as AgentState
    if (restartedAgent.status !== 'ready' || !restartedAgent.debugPort) {
      throw new Error(
        `El Relay quedó en estado ${restartedAgent.status}` +
        (restartedAgent.error ? `: ${restartedAgent.error}` : '.'),
      )
    }

    await relayBus.send({
      type: 'command',
      name: 'agent:sa-preparation-status',
      payload: { agentId: agent.agentId, preparing: true },
    })
    say(`Preparando SuperAssistant en el puerto ${restartedAgent.debugPort}...`)
    await workspaceInstanceLaunchHistoryStore.append({
      instanceId: agent.agentId,
      status: 'preparing',
      detail: `Preparando SuperAssistant · puerto ${restartedAgent.debugPort}`,
    })
    await prepareSAAgentForWebRelay(
      restartedAgent.debugPort,
      restartedAgent.saExtensionId,
      restartedAgent.platformId,
    )
    if (!restartedAgent.role?.startsWith('manual-user-') &&
        !restartedAgent.role?.startsWith('sentinel-guest-') &&
        !restartedAgent.agentId.startsWith('sentinel-')) {
      say(restartedAgent.agentId + ': verificando instrucciones iniciales tras el reinicio')
      await verifyWebRelayStartup(restartedAgent)
      say(restartedAgent.agentId + ': instrucciones iniciales confirmadas')
    }
    restartedAgent = await relayBus.send({
      type: 'command',
      name: 'agent:sa-preparation-status',
      payload: { agentId: agent.agentId, preparing: false },
    }) as AgentState
    await workspaceInstanceLaunchHistoryStore.append({
      instanceId: agent.agentId,
      status: 'ready',
      detail: `Reinicio completo · ${restartedAgent.role ?? 'Relay'} · puerto ${restartedAgent.debugPort}`,
    })
  } catch (error) {
    operationError = error
    await workspaceInstanceLaunchHistoryStore.append({
      instanceId: agent.agentId,
      status: 'failed',
      detail: `Falló el reinicio · ${String(error)}`,
    })
    if (restartedAgent?.status === 'ready' || restartedAgent?.status === 'sa_preparing' || restartedAgent?.status === 'startup_verifying') {
      try {
        await relayBus.send({
          type: 'command',
          name: 'agent:stop',
          payload: { agentId: agent.agentId },
        })
      } catch (stopError) {
        operationError = new Error(
          `${error instanceof Error ? error.message : String(error)}; además, no se pudo detener ` +
          `el Relay incompletamente preparado: ${stopError instanceof Error ? stopError.message : String(stopError)}`,
        )
      }
    }
  }

  if (openedMasterSourceId) {
    try {
      await closeMasterSession(openedMasterSourceId)
    } catch (closeError) {
      const source = getMasterSessionSource(openedMasterSourceId)
      const cleanupMessage =
        `No se pudo cerrar la Master Session temporal "${source.name}" (${openedMasterSourceId}): ` +
        `${closeError instanceof Error ? closeError.message : String(closeError)}`
      operationError = new Error(
        operationError
          ? `${operationError instanceof Error ? operationError.message : String(operationError)}; ${cleanupMessage}`
          : cleanupMessage,
      )
    }
  }

  if (operationError) {
    throw operationError instanceof Error
      ? operationError
      : new Error(String(operationError))
  }
  if (!restartedAgent) throw new Error(`No se recibió estado al reiniciar ${agent.agentId}.`)
  return restartedAgent
}