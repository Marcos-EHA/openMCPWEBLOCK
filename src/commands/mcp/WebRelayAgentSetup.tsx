import React, { useEffect, useState } from 'react'
import { randomUUID } from 'node:crypto'
import { Select } from '../../components/CustomSelect/index.js'
import { Box, Text, useInput } from '../../ink.js'
import { useOrchestratorState, type OrchestratorActions } from '../../hooks/useOrchestratorState.js'
import type { AgentSessionMode, AgentState } from '../../services/webRelay/orchestration/types.js'
import { prepareSAAgentForWebRelay } from '../../services/webRelay/WebRelayProvider.js'
import { setWebAgentComposerMode } from '../../services/geminiOrchestrator/sentinelComposerMode.js'
import { saveCurrentProjectConfig } from '../../utils/config.js'
import { getWebPlatformById } from '../../utils/webPlatforms.js'
import { getMasterSessionSource, listMasterSessionSources } from '../../services/webRelay/session/MasterSessionRegistry.js'
import { openMasterSessionSource } from '../../services/webRelay/session/MasterSessionController.js'
import { closeMasterSession, SessionBroker } from '../../services/webRelay/session/SessionBroker.js'
import { verifyChatGPTAuth } from '../../services/webRelay/session/ChatGPTAuthVerifier.js'
import { getMinimumRelayCount, isWebCoordinatorRole, selectStartupReadyRelays } from '../../services/webRelay/launchPolicy.js'
import {
  closeChromeBeforeProfileCopy,
  listChromeProfileSources,
  type ChromeProfileSource,
} from '../../services/webRelay/session/ChromeProfileRegistry.js'

const MAX_WEB_RELAY_AGENTS = 20
const MAX_CONCURRENT_AGENT_STARTS = 3

async function stopAttemptedAgents(
  actions: Pick<OrchestratorActions, 'stopAgent'>,
  agentIds: string[],
): Promise<string[]> {
  const failures: string[] = []
  for (const agentId of [...agentIds].reverse()) {
    try {
      const stopped = await actions.stopAgent(agentId)
      if (stopped.status !== 'stopped') {
        failures.push(`${agentId}: quedó ${stopped.status}${stopped.error ? ` (${stopped.error})` : ''}`)
      }
    } catch (error) {
      failures.push(`${agentId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return failures
}

async function closeTemporaryMasterSources(sourceIds: string[]): Promise<string[]> {
  const failures: string[] = []
  const sourcesToClose = sourceIds.splice(0).reverse()
  for (const sourceId of sourcesToClose) {
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
  return failures
}

interface WebRelayAgentSetupProps {
  platformId: string
  onComplete: (message: string) => void
  chromeProfilePreset?: boolean
}

export function WebRelayAgentSetup({
  platformId,
  onComplete,
  chromeProfilePreset = false,
}: WebRelayAgentSetupProps) {
  const platform = getWebPlatformById(platformId)
  const supportsMasterSession = platformId === 'chatgpt' || platformId === 'claude'
  const { actions } = useOrchestratorState()
  const [step, setStep] = useState<
    'purpose' | 'brain' | 'orchestrator-count' | 'count' | 'coordinator-session' | 'coordinator-account' |
    'coordinator-chrome-profile' | 'session' | 'account' | 'chrome-profile' |
    'profile-copy-consent' | 'starting' | 'preparing'
  >('purpose')
  const [purpose, setPurpose] = useState<'agent' | 'user'>('agent')
  const [orchestratorBrain, setOrchestratorBrain] = useState<'api' | 'web'>('api')
  const [coordinatorCount, setCoordinatorCount] = useState(1)
  const [agentCount, setAgentCount] = useState(0)
  const [coordinatorSessionMode, setCoordinatorSessionMode] = useState<AgentSessionMode>('clean')
  const [coordinatorMasterSessionSourceId, setCoordinatorMasterSessionSourceId] = useState<string>()
  const [coordinatorChromeProfileDirectory, setCoordinatorChromeProfileDirectory] = useState<string>()
  const [sessionModes, setSessionModes] = useState<AgentSessionMode[]>([])
  const [masterSessionSourceIds, setMasterSessionSourceIds] = useState<Array<string | undefined>>([])
  const [chromeProfileDirectories, setChromeProfileDirectories] = useState<Array<string | undefined>>([])
  const [availableChromeProfiles, setAvailableChromeProfiles] = useState<ChromeProfileSource[]>([])
  const [chromeProfileError, setChromeProfileError] = useState<string | null>(null)
  const [profileCopyApproved, setProfileCopyApproved] = useState(false)
  const [progress, setProgress] = useState<AgentState[]>([])
  const [startupFailures, setStartupFailures] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  const canUseChromeProfile = platformId === 'chatgpt' && process.platform === 'win32'
  const beginChromeProfileSelection = (nextStep: 'chrome-profile' | 'coordinator-chrome-profile') => {
    try {
      const profiles = listChromeProfileSources()
      setAvailableChromeProfiles(profiles)
      setChromeProfileError(
        profiles.length > 0
          ? null
          : 'No se encontraron perfiles Chrome en la ubicación estándar de Windows. Comprueba que Chrome esté instalado y tenga un perfil creado.',
      )
      setStep(nextStep)
    } catch (profileError) {
      setAvailableChromeProfiles([])
      setChromeProfileError(
        `No se pudieron leer los perfiles locales de Chrome: ${
          profileError instanceof Error ? profileError.message : String(profileError)
        }`,
      )
      setStep(nextStep)
    }
  }

  const continueAfterWorkerSessions = (nextModes: AgentSessionMode[]) => {
    if (nextModes.length < agentCount) {
      if (chromeProfilePreset) {
        beginChromeProfileSelection('chrome-profile')
      } else {
        setStep('session')
      }
      return
    }
    const hasChromeProfile = coordinatorSessionMode === 'chrome-profile' ||
      nextModes.includes('chrome-profile')
    setStep(hasChromeProfile ? 'profile-copy-consent' : 'starting')
  }

  useInput((_input, key) => {
    if (step === 'purpose' && key.tab) {
      setPurpose(current => current === 'agent' ? 'user' : 'agent')
    } else if (step === 'purpose' && key.return) {
      setStep(purpose === 'agent' ? 'brain' : 'count')
    } else if (step === 'purpose' && key.escape) {
      onComplete('Web mode setup cancelled')
    } else if (step === 'brain' && key.escape) {
      setStep('purpose')
    } else if (step === 'orchestrator-count' && key.escape) {
      setStep('brain')
    }
  })

  useEffect(() => {
    if (step !== 'starting' || !platform) return

    let cancelled = false
    let finished = false
    const attemptedAgentIds: string[] = []
    const openedMasterSources: string[] = []
    const launchCoordinator = purpose === 'agent' && orchestratorBrain === 'web'
    const requestedCoordinatorCount = launchCoordinator ? coordinatorCount : 0
    const launchCount = agentCount + requestedCoordinatorCount
    const startConfiguredAgents = async () => {
      const states: AgentState[] = []

      try {
        const launchPlan = [
          ...Array.from({ length: requestedCoordinatorCount }, (_, index) => ({
            agentId: `web-${platformId}-${purpose}-${randomUUID()}`,
            sessionMode: coordinatorSessionMode,
            masterSessionSourceId: coordinatorMasterSessionSourceId,
            chromeProfileDirectory: coordinatorChromeProfileDirectory,
            role: index === 0 ? 'primary' : `orchestrator-${index + 1}`,
          })),
          ...Array.from({ length: agentCount }, (_, index) => ({
            agentId: `web-${platformId}-${purpose}-${randomUUID()}`,
            sessionMode: sessionModes[index] ?? 'clean',
            masterSessionSourceId: masterSessionSourceIds[index],
            chromeProfileDirectory: chromeProfileDirectories[index],
            role: purpose === 'user' ? `manual-user-${index + 1}` : `worker-${index + 1}`,
          })),
        ]

        const selectedSourceIds = [...new Set(
          launchPlan
            .filter(instance => instance.sessionMode === 'authenticated')
            .map(instance => instance.masterSessionSourceId ?? 'loco-verde'),
        )]
        for (const sourceId of selectedSourceIds) {
          const source = getMasterSessionSource(sourceId)
          if (source.platformId !== platformId) {
            throw new Error(
              `La fuente Master Session "${source.name}" es para ${source.platformId}, no para ${platformId}.`,
            )
          }
          let status = await SessionBroker.getInstance().getMasterStatus(sourceId)
          let openedForTransfer = false
          if (!status.active) {
            try {
              await openMasterSessionSource(sourceId)
              openedForTransfer = true
              openedMasterSources.push(sourceId)
            } catch (error) {
              const source = getMasterSessionSource(sourceId)
              throw new Error(
                `No se pudo abrir Master Session "${source.name}" (${source.id}): ` +
                `${error instanceof Error ? error.message : String(error)}`,
              )
            }
            status = await SessionBroker.getInstance().getMasterStatus(sourceId)
          }
          if (!status.hasValidSession) {
            if (openedForTransfer) {
              openedMasterSources.splice(openedMasterSources.indexOf(sourceId), 1)
            }
            const detail = status.active && status.reason?.startsWith('Error reading Master cookies:')
              ? `No se pudo verificar la sesión: ${status.reason}`
              : status.active
                ? `Chrome está abierto, pero no contiene una sesión ${platform.name} válida. ${status.reason ?? ''}`
              : 'No se pudo abrir Chrome con CDP para esa fuente.'
            throw new Error(
              `La fuente Master Session "${source.name}" (${source.id}) no está autenticada. ${detail} ` +
              `La ventana Master Session queda abierta para que inicies sesión; después vuelve a ejecutar /mcp set-mode web.`,
            )
          }
        }
        const hasChromeProfile = launchPlan.some(instance => instance.sessionMode === 'chrome-profile')
        if (hasChromeProfile && !profileCopyApproved) {
          throw new Error('Debes autorizar la copia aislada del perfil Chrome antes de lanzar.')
        }
        for (const instance of launchPlan) {
          if (instance.sessionMode !== 'chrome-profile' || !instance.chromeProfileDirectory) continue
          try {
            await closeChromeBeforeProfileCopy(instance.chromeProfileDirectory)
          } catch (preflightError) {
            setProfileCopyApproved(false)
            setChromeProfileError(
              preflightError instanceof Error
                ? preflightError.message
                : `No se pudo preparar Chrome para la copia: ${String(preflightError)}`,
            )
            setStep(isWebCoordinatorRole(instance.role) ? 'coordinator-chrome-profile' : 'chrome-profile')
            finished = true
            return
          }
        }

        const completedStates: Array<AgentState | undefined> = Array(launchPlan.length)
        const outcomes: PromiseSettledResult<AgentState>[] = []
        const batchSize = launchCoordinator ||
          launchPlan.some(instance =>
            instance.sessionMode === 'authenticated' || instance.sessionMode === 'chrome-profile',
          )
          ? 1
          : MAX_CONCURRENT_AGENT_STARTS
        for (let startIndex = 0; startIndex < launchPlan.length; startIndex += batchSize) {
          const batch = launchPlan.slice(startIndex, startIndex + batchSize)
          attemptedAgentIds.push(...batch.map(instance => instance.agentId))
          const batchOutcomes = await Promise.allSettled(batch.map(async (instance, batchIndex) => {
            const state = await actions.startAgent(
              instance.agentId,
              platformId,
              instance.role,
              instance.sessionMode,
              instance.masterSessionSourceId,
              instance.chromeProfileDirectory,
            )
            completedStates[startIndex + batchIndex] = state
            if (!cancelled) {
              setProgress(completedStates.filter((item): item is AgentState => item !== undefined))
            }
            return state
          }))
          outcomes.push(...batchOutcomes)
          if (cancelled) {
            await closeTemporaryMasterSources(openedMasterSources)
            return
          }
        }

        states.push(...completedStates.filter((state): state is AgentState => state !== undefined))
        const failures = outcomes.flatMap((outcome, index) => {
          const instance = launchPlan[index]
          if (outcome.status === 'rejected') {
            return [`${instance.agentId} failed to start: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`]
          }

          const state = outcome.value
          const instanceFailures: string[] = []
          if (state.status !== 'ready' || state.sessionMode !== instance.sessionMode) {
            instanceFailures.push(
              `${state.agentId} did not pass startup gates (status ${state.status}, ` +
              `session ${state.sessionMode ?? 'unknown'}). ${state.error ?? ''}`.trim(),
            )
          }
          if (!state.debugPort) {
            if (state.status === 'ready') {
              instanceFailures.push(`${instance.agentId} is ready without a Chrome debug port.`)
            }
          }
          return instanceFailures
        })
        const readyStates = selectStartupReadyRelays(states, launchPlan)
        const readyIds = new Set(readyStates.map(agent => agent.agentId))
        const failedStartIds = launchPlan
          .filter(instance => !readyIds.has(instance.agentId))
          .map(instance => instance.agentId)
        const startupCleanupFailures = await stopAttemptedAgents(actions, failedStartIds)
        if (startupCleanupFailures.length > 0) {
          failures.push(`Failed Relay cleanup: ${startupCleanupFailures.join('; ')}`)
        }
        const minimumReadyAgents = getMinimumRelayCount(purpose, launchCoordinator)
        const hasCoordinator = !launchCoordinator || readyStates.some(agent => isWebCoordinatorRole(agent.role))
        if (readyStates.length < minimumReadyAgents || !hasCoordinator) {
          throw new Error(
            `${readyStates.length}/${launchCount} instances passed startup; ` +
            `${minimumReadyAgents} are required.` +
            `${hasCoordinator ? '' : ' The Web coordinator Relay did not pass startup.'} ` +
            failures.join('\n'),
          )
        }

        failures.push(...await closeTemporaryMasterSources(openedMasterSources))
        setStartupFailures(failures)
        setProgress(readyStates)
        finished = true
        setStep('preparing')
      } catch (startError) {
        const message = startError instanceof Error ? startError.message : String(startError)
        const cleanupFailures = await stopAttemptedAgents(actions, attemptedAgentIds)
        const masterCleanupFailures = await closeTemporaryMasterSources(openedMasterSources)
        finished = true
        const startedCount = states.filter(agent => agent.status === 'ready').length
        setError([message, ...masterCleanupFailures].join('\n'))
        onComplete(
          `Web Relay setup failed while launching ${platform.name}: ${[message, ...masterCleanupFailures].join('\n')}\n` +
          `Result: ${startedCount}/${launchCount} requested instance(s) passed startup before failure. ` +
          `${purpose === 'agent' ? 'Web mode was not enabled. ' : ''}` +
          (attemptedAgentIds.length === 0
            ? 'No Web Relay instances were launched; the Master Session window, if opened, was left available for sign-in.'
            : cleanupFailures.length === 0
              ? 'All instances started by this attempt were stopped.'
            : `Some temporary instances could not be stopped: ${cleanupFailures.join('; ')}`),
        )
      }
    }

    void startConfiguredAgents()
    return () => {
      cancelled = true
      if (!finished) void stopAttemptedAgents(actions, attemptedAgentIds)
      if (!finished) void closeTemporaryMasterSources(openedMasterSources)
    }
  }, [actions, agentCount, chromeProfileDirectories, coordinatorChromeProfileDirectory, coordinatorCount, coordinatorMasterSessionSourceId, coordinatorSessionMode, masterSessionSourceIds, onComplete, orchestratorBrain, platform, platformId, profileCopyApproved, purpose, sessionModes, step])

  useEffect(() => {
    if (step !== 'preparing' || !platform) return

    let cancelled = false
    let finished = false
    const launchCoordinator = purpose === 'agent' && orchestratorBrain === 'web'
    const requestedCoordinatorCount = launchCoordinator ? coordinatorCount : 0
    const launchCount = agentCount + requestedCoordinatorCount
    const prepareConfiguredAgents = async () => {
      const agentIds = progress.map(agent => agent.agentId)
      try {
        const preparedAgents: AgentState[] = []
        const preparationFailures: string[] = []
        const profileLoginWarnings: string[] = []
        const profileLoginWarningAgentIds = new Set<string>()
        for (const agent of progress) {
          if (!agent.debugPort) {
            preparationFailures.push(`${agent.agentId}: ready without a Chrome debug port.`)
            await actions.stopAgent(agent.agentId)
            continue
          }
          try {
            await prepareSAAgentForWebRelay(agent.debugPort, agent.saExtensionId, platformId)
            preparedAgents.push(agent)
            if (agent.sessionMode === 'chrome-profile') {
              try {
                const auth = await verifyChatGPTAuth(agent.debugPort, {
                  timeoutMs: 3000,
                  pollIntervalMs: 500,
                })
                if (auth.status !== 'authenticated') {
                  profileLoginWarningAgentIds.add(agent.agentId)
                  profileLoginWarnings.push(
                    `${agent.agentId}: ChatGPT no confirmó una sesión autenticada (${auth.status}). ` +
                    'El inicio de sesión de Chrome normal o de la aplicación ChatGPT no se comparte con la copia aislada. ' +
                    (purpose === 'user'
                      ? 'Completa el inicio de sesión en la ventana Chrome de Relay antes de usar ChatGPT, o usa una Master Session.'
                      : 'Completa el inicio de sesión en la ventana Chrome de Relay antes de enviar tareas, o usa una Master Session.'),
                  )
                }
              } catch (authError) {
                profileLoginWarningAgentIds.add(agent.agentId)
                profileLoginWarnings.push(
                  `${agent.agentId}: no se pudo comprobar el inicio de sesión de ChatGPT: ` +
                  `${authError instanceof Error ? authError.message : String(authError)}. ` +
                  (purpose === 'user'
                    ? 'Comprueba la ventana Chrome de Relay antes de usar ChatGPT; su sesión es independiente de Chrome normal y de la aplicación ChatGPT.'
                    : 'Comprueba la ventana Chrome de Relay antes de enviar tareas; su sesión es independiente de Chrome normal y de la aplicación ChatGPT.'),
                )
              }
            }
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            preparationFailures.push(
              `SuperAssistant preparation failed for ${agent.agentId} on port ${agent.debugPort}: ${detail}`,
            )
            const stopped = await actions.stopAgent(agent.agentId)
            if (stopped.status !== 'stopped') {
              preparationFailures.push(
                `Could not stop failed Relay ${agent.agentId}: ${stopped.error ?? stopped.status}`,
              )
            }
          }
        }
        if (cancelled) return

        const minimumPreparedAgents = getMinimumRelayCount(purpose, launchCoordinator)
        const hasPreparedCoordinator = !launchCoordinator ||
          preparedAgents.some(agent => isWebCoordinatorRole(agent.role))
        if (preparedAgents.length < minimumPreparedAgents || !hasPreparedCoordinator) {
          const cleanupFailures = await stopAttemptedAgents(
            actions,
            preparedAgents.map(agent => agent.agentId),
          )
          const failureDetails = [...startupFailures, ...preparationFailures]
          if (cleanupFailures.length > 0) {
            failureDetails.push(`Cleanup failures: ${cleanupFailures.join('; ')}`)
          }
          throw new Error(
            `${preparedAgents.length}/${launchCount} instances passed SuperAssistant preparation; ` +
            `${minimumPreparedAgents} are required.` +
            `${hasPreparedCoordinator ? '' : ' The Web coordinator Relay did not pass SuperAssistant preparation.'} ` +
            failureDetails.join('\n'),
          )
        }

        if (purpose === 'agent') {
          saveCurrentProjectConfig(config => ({
            ...config,
            mcpExecutionMode: 'web',
            selectedWebPlatform: platformId,
            webRelayCoordinationEnabled: true,
            webRelayOrchestratorBrain: orchestratorBrain,
            webRelayAgentIds: preparedAgents.map(agent => agent.agentId),
            webRelayCoordinatorAgentId: launchCoordinator
              ? preparedAgents.find(agent => agent.role === 'primary')?.agentId ??
                preparedAgents.find(agent => isWebCoordinatorRole(agent.role))?.agentId
              : undefined,
            webRelayAgentProfiles: preparedAgents.map(agent => ({
              agentId: agent.agentId,
              sessionMode: agent.sessionMode ?? 'clean',
              ...(agent.masterSessionSourceId
                ? { masterSessionSourceId: agent.masterSessionSourceId }
                : {}),
              ...(agent.chromeProfileDirectory
                ? { chromeProfileDirectory: agent.chromeProfileDirectory }
                : {}),
            })),
          }))
          setWebAgentComposerMode(true)
        }

        const details = preparedAgents
          .map(agent =>
            `  ${isWebCoordinatorRole(agent.role) ? `Web coordinator candidate ${agent.role}` : agent.role ?? 'Relay'} (${agent.agentId}): ` +
            `${profileLoginWarningAgentIds.has(agent.agentId) ? 'ChatGPT authentication needs attention' : 'ready'}, ${agent.sessionMode ?? 'clean'} session` +
            (agent.masterSessionSourceId
              ? ` from ${getMasterSessionSource(agent.masterSessionSourceId).name}`
              : '') + ', ' +
            (agent.chromeProfileDirectory
              ? ` copied from Chrome ${agent.chromeProfileDirectory}, `
              : '') +
            `SA ${agent.saExtensionId ? 'detected' : 'ID unavailable'}, port ${agent.debugPort ?? 'unknown'}`,
          )
          .join('\n')
        finished = true
        const completionSummary = purpose === 'agent'
          ? `Web agent mode ready: ${preparedAgents.length}/${launchCount} ${platform.name} instance(s) passed startup and SuperAssistant gates.`
          : profileLoginWarnings.length > 0
            ? `Manual user windows launched: ${preparedAgents.length}/${launchCount} ${platform.name} instance(s) passed startup and SuperAssistant gates; ` +
              `ChatGPT authentication needs attention for ${profileLoginWarnings.length} instance(s) before use.`
            : `Manual user mode ready: ${preparedAgents.length}/${launchCount} ${platform.name} instance(s) passed startup and SuperAssistant gates.`
        onComplete(
          `${completionSummary}\n` +
          `${details}\n` +
          'SA MCP, Push Content Mode, Auto Insert, Auto Submit, and Auto Execute were verified before enabling chat.\n' +
          ([...startupFailures, ...preparationFailures].length > 0
            ? `Unavailable instances were excluded from this launch:\n${[...startupFailures, ...preparationFailures].join('\n')}\n`
            : '') +
          (profileLoginWarnings.length > 0
            ? `Perfil Chrome: se requiere atención antes de usar:\n${profileLoginWarnings.join('\n')}\n`
            : '') +
          (purpose === 'agent'
            ? launchCoordinator
              ? `${preparedAgents.filter(agent => isWebCoordinatorRole(agent.role)).length} Web coordinator candidate(s) are available; one is selected per task and the others can be chosen as alternatives. They are separate from workers. Sentinel (Gemini) remains independent. Slash commands remain local.\n`
              : 'Agent conversation is coordinated by the configured API model; it does not consume a Web instance, and all launched instances are workers. Select a worker directly when desired. Sentinel (Gemini) remains independent. Slash commands remain local.\n'
            : 'These Chrome windows are for your manual use and are not added to the Web Relay request pool.\n') +
          'Clean profiles receive no Master Session cookies. Authenticated profiles use the account and quota of their selected source; profiles bound to the same source share that account. Chrome-profile sessions are isolated copies and do not sync back to normal Chrome; Windows Chrome cookies may be application-bound, so the auth check can ask you to sign in once in the visible copy, after which the Relay keeps that sign-in.\n' +
          'Use /mcp status to inspect agent and Sentinel health.',
        )
      } catch (prepareError) {
        const message = prepareError instanceof Error ? prepareError.message : String(prepareError)
        const cleanupFailures = await stopAttemptedAgents(actions, agentIds)
        finished = true
        setError(message)
        onComplete(
          `Web Relay setup failed while preparing ${platform.name}: ${message}\n` +
          `Result: ${progress.length}/${launchCount} requested instance(s) prepared; the pool was not registered. ` +
          `${purpose === 'agent' ? 'Web mode was not enabled. ' : ''}` +
          (cleanupFailures.length === 0
            ? 'All instances started by this attempt were stopped.'
            : `Some temporary instances could not be stopped: ${cleanupFailures.join('; ')}`) +
          '\nCheck the session and SuperAssistant error above, then run /mcp set-mode web again.',
        )
      }
    }

    void prepareConfiguredAgents()
    return () => {
      cancelled = true
      if (!finished) void stopAttemptedAgents(actions, progress.map(agent => agent.agentId))
    }
  }, [actions, agentCount, coordinatorCount, onComplete, orchestratorBrain, platform, platformId, progress, purpose, sessionModes, startupFailures, step])

  if (!platform) {
    return <Text color="red">Unknown web platform: {platformId}</Text>
  }
  const requestedRelayCount = agentCount +
  (purpose === 'agent' && orchestratorBrain === 'web' ? coordinatorCount : 0)

  if (step === 'purpose') {
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">Prepare a {platform.name} Web instance</Text>
        <Text>
          Platform: {platform.name} Web
          {platformId === 'chatgpt'
            ? ' — model selection stays inside ChatGPT'
            : platformId === 'arena'
              ? ' — choose the Direct model in each Arena window'
              : ''}
        </Text>
        <Text dimColor>
          {supportsMasterSession
            ? 'Choose what this instance is for. Account session is a separate choice.'
            : platformId === 'arena'
              ? 'Arena instances use clean profiles; select a model manually in each window after launch.'
              : platformId === 'zai'
                ? 'Z.ai instances use clean profiles; sign in separately in each window.'
              : platformId === 'aistudio'
                ? 'Google AI Studio instances use clean profiles; sign in with Google in each window.'
              : 'Choose what this instance is for. This platform uses clean browser profiles.'}
        </Text>
        <Box
          flexDirection="column"
          onClick={() => {
            setPurpose('agent')
            setStep('brain')
          }}
        >
          <Text color={purpose === 'agent' ? 'cyan' : undefined}>
            {purpose === 'agent' ? '›' : ' '} Conversación Agente — coordinador + workers
          </Text>
          <Text dimColor>   Elige cerebro API o dedica una Relay como coordinador Web. Sentinel (Gemini) es independiente.</Text>
        </Box>
        <Box
          flexDirection="column"
          onClick={() => {
            setPurpose('user')
            setStep('count')
          }}
        >
          <Text color={purpose === 'user' ? 'cyan' : undefined}>
            {purpose === 'user' ? '›' : ' '} Conversación Usuario — ventana {platform.name} para uso manual
          </Text>
          <Text dimColor>   Abre ventanas manuales sin coordinador ni tareas del Workspace.</Text>
        </Box>
        <Text dimColor>Tab cambia el tipo de conversación · Enter continúa · Esc cancela</Text>
      </Box>
    )
  }

  if (step === 'brain') {
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">Elige el cerebro del coordinador para la conversación Agente</Text>
        <Text dimColor>
          API no consume una Relay y necesita al menos un worker. Web añade una Relay coordinadora al número de workers seleccionado.
        </Text>
        <Select
          options={[
            {
              label: 'Cerebro API — coordina sin Relay dedicada',
              value: 'api' as const,
              description: 'Las instancias Relay lanzadas son workers; mínimo una.',
            },
            {
              label: 'Cerebro Web — una Relay será el coordinador',
              value: 'web' as const,
              description: 'Se añade una Relay coordinadora aparte del número de workers seleccionado; mínimo un worker.',
            },
          ]}
          defaultValue={orchestratorBrain}
          onChange={(value: 'api' | 'web' | undefined) => {
            if (!value) return
            setOrchestratorBrain(value)
            if (value === 'web') {
              setCoordinatorCount(current => Math.max(1, current))
              setStep('orchestrator-count')
            } else {
              setCoordinatorCount(0)
              setStep('count')
            }
          }}
          onCancel={() => setStep('purpose')}
          visibleOptionCount={2}
        />
      </Box>
    )
  }

  if (step === 'orchestrator-count') {
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">How many Web orchestrator candidates should be launched?</Text>
        <Text dimColor>
          One candidate coordinates each task. The others remain available to select as alternatives; they do not count as workers.
        </Text>
        <Select
          options={Array.from({ length: MAX_WEB_RELAY_AGENTS - 1 }, (_, index) => {
            const count = index + 1
            return {
              label: `${count} ${count === 1 ? 'orchestrator candidate' : 'orchestrator candidates'}`,
              value: count,
            }
          })}
          defaultValue={Math.max(1, coordinatorCount)}
          visibleOptionCount={7}
          onChange={(count: number) => {
            setCoordinatorCount(count)
            setStep('count')
          }}
          onCancel={() => setStep('brain')}
        />
      </Box>
    )
  }

  if (step === 'count') {
    const launchCoordinator = purpose === 'agent' && orchestratorBrain === 'web'
    const minimumCount = 1
    const requestedCoordinatorCount = launchCoordinator ? coordinatorCount : 0
    const maximumWorkerCount = MAX_WEB_RELAY_AGENTS - requestedCoordinatorCount
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">
          {purpose === 'agent'
            ? launchCoordinator ? 'Prepare Web coordinator + workers' : 'Prepare workers for API coordinator'
            : `Prepare manual ${platform.name} windows`}
        </Text>
        <Text>
          Platform: {platform.name} Web
          {platformId === 'chatgpt'
            ? ' — choose the model inside ChatGPT'
            : platformId === 'arena'
              ? ' — choose the Direct model inside Arena'
              : ''}
        </Text>
        {platformId === 'chatgpt' && (
          <Text dimColor>
            ChatGPT controls the model inside its own web interface; OpenMCPWEBLOCK does not change that selection.
          </Text>
        )}
        <Text bold>
          {purpose === 'agent' ? 'How many worker instances should be launched?' : 'How many manual instances should be launched?'} ({minimumCount}-{maximumWorkerCount})
        </Text>
        <Text dimColor>
          {canUseChromeProfile
            ? 'Después de elegir la cantidad, selecciona “Importar desde Chrome (copia aislada)”. La copia puede requerir iniciar sesión en su propia ventana Relay.'
            : supportsMasterSession
            ? purpose === 'agent'
              ? launchCoordinator
                ? 'The Web orchestrator candidates are extra Relays. They share the selected coordinator session; choose each worker session separately.'
                : 'The API coordinator plans and reviews without using a Relay. Every launched Relay is a worker; choose a session for each.'
              : 'User instances are for manual use only; choose Guest or a named Master Session source for each.'
            : purpose === 'agent'
              ? launchCoordinator
                ? `${requestedCoordinatorCount} Web orchestrator candidate(s) are extra Relays; each shares a clean session. The selected count below is workers.`
                : 'The API coordinator plans and reviews without using a Relay; all launched Relays are workers with clean browser profiles.'
              : 'User instances are for manual use only and use clean browser profiles.'}
        </Text>
        {platformId === 'arena' && (
          <Text dimColor>
            Each Arena window starts in Direct mode. Choose the desired model manually in every instance.
          </Text>
        )}
        {platformId === 'zai' && (
          <Text dimColor>
            Each Z.ai window starts at the chat home. Sign in and open the desired conversation in each window.
          </Text>
        )}
        {platformId === 'aistudio' && (
          <Text dimColor>
            Each AI Studio window uses a clean profile. Sign in with Google before using the prompt composer.
          </Text>
        )}
        <Select
          options={Array.from({ length: maximumWorkerCount - minimumCount + 1 }, (_, index) => {
            const count = index + minimumCount
            return {
              label: `${count} ${count === 1 ? 'instance' : 'instances'}`,
              value: count,
            }
          })}
          defaultValue={minimumCount}
          visibleOptionCount={7}
          onChange={(count: number) => {
            setError(null)
            setAgentCount(count)
            if (chromeProfilePreset) {
              setCoordinatorSessionMode('chrome-profile')
              setSessionModes([])
              setMasterSessionSourceIds([])
              setChromeProfileDirectories([])
              if (launchCoordinator) {
                beginChromeProfileSelection('coordinator-chrome-profile')
              } else {
                beginChromeProfileSelection('chrome-profile')
              }
            } else if (!supportsMasterSession) {
              setSessionModes(Array.from({ length: count }, () => 'clean'))
              setStep('starting')
            } else if (launchCoordinator) {
              setStep('coordinator-session')
            } else {
              setStep('session')
            }
          }}
          onCancel={() => onComplete('Web mode setup cancelled')}
        />
        {error && <Text color="red">{error}</Text>}
      </Box>
    )
  }

  if (step === 'coordinator-session') {
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">{platform?.name} Web coordinator candidates: choose their session</Text>
        <Text dimColor>
          All {coordinatorCount} candidates use the selected session type; each gets its own isolated Relay profile. En ChatGPT para Windows puedes copiar un perfil Chrome local.
        </Text>
        <Select
          options={[
            {
              label: 'Guest / clean — no Master Session cookies',
              value: 'clean' as const,
              description: 'Each coordinator uses its own clean Relay profile, separate from every worker.',
            },
            ...(supportsMasterSession ? [{
              label: 'Authenticated — share Master Session account',
              value: 'authenticated' as const,
              description: 'Each coordinator gets its own Relay profile using the selected Master Session source.',
            }] : []),
            ...(canUseChromeProfile ? [{
              label: 'Importar desde Chrome (copia aislada)',
              value: 'chrome-profile' as const,
              description: 'Copia datos de sitio seleccionados una vez a un perfil Relay; Chrome debe estar cerrado y la copia no se sincroniza.',
            }] : []),
          ]}
          onChange={(value: AgentSessionMode | undefined) => {
            if (!value) return
            setCoordinatorSessionMode(value)
            setCoordinatorMasterSessionSourceId(undefined)
            setCoordinatorChromeProfileDirectory(undefined)
            if (value === 'authenticated') {
              setStep('coordinator-account')
            } else if (value === 'chrome-profile') {
              beginChromeProfileSelection('coordinator-chrome-profile')
            } else {
              setStep('session')
            }
          }}
          onCancel={() => onComplete('Web mode setup cancelled')}
          visibleOptionCount={3}
        />
      </Box>
    )
  }

  if (step === 'coordinator-chrome-profile' || step === 'chrome-profile') {
    const isCoordinator = step === 'coordinator-chrome-profile'
    const instanceNumber = sessionModes.length + 1
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">
          {platform?.name} {isCoordinator ? 'Web coordinator candidates' : `${purpose === 'agent' ? 'worker' : 'instance'} ${instanceNumber} of ${agentCount}`}: choose a local Chrome profile
        </Text>
        <Text dimColor>
          Elige un perfil local para crear una copia aislada. Tras tu autorización, OpenMCP comprobará el perfil y solicitará el cierre normal de Chrome si sigue abierto.
          El perfil original no se comparte ni modifica. Iniciar sesión en Chrome normal o en la aplicación ChatGPT no inicia sesión en esta copia.
        </Text>
        {chromeProfileError && (
          <Text color="yellow">
            {chromeProfileError}
            {availableChromeProfiles.length > 0
              ? ' Resuelve el problema y vuelve a seleccionar el perfil para reintentar. Esc cancela sin lanzar instancias.'
              : ' Resuelve el problema y vuelve a ejecutar /mcp set-mode web.'}
          </Text>
        )}
        {availableChromeProfiles.length > 0 && (
            <Select
              options={availableChromeProfiles.map(profile => ({
                label: `${profile.name} (${profile.id})`,
                value: profile.id,
                description: `Copy data from "${profile.name}" to an isolated Relay; it may require login in the Relay window.`,
              }))}
              onChange={(profileId: string | undefined) => {
                if (!profileId) return
                if (!availableChromeProfiles.some(profile => profile.id === profileId)) {
                  setChromeProfileError('El perfil Chrome seleccionado ya no está disponible.')
                  return
                }
                setChromeProfileError(null)
                if (isCoordinator) {
                  setCoordinatorChromeProfileDirectory(profileId)
                  if (chromeProfilePreset) {
                    beginChromeProfileSelection('chrome-profile')
                  } else {
                    setStep('session')
                  }
                  return
                }
                const nextDirectories = [...chromeProfileDirectories]
                nextDirectories[instanceNumber - 1] = profileId
                setChromeProfileDirectories(nextDirectories)
                const nextModes = [...sessionModes]
                nextModes[instanceNumber - 1] = 'chrome-profile'
                setSessionModes(nextModes)
                setMasterSessionSourceIds(previous => {
                  const next = [...previous]
                  next[instanceNumber - 1] = undefined
                  return next
                })
                continueAfterWorkerSessions(nextModes)
              }}
              onCancel={() => onComplete('Web mode setup cancelled')}
              visibleOptionCount={Math.min(8, availableChromeProfiles.length)}
            />
        )}
      </Box>
    )
  }

  if (step === 'coordinator-account') {
    const sources = listMasterSessionSources().filter(source => source.platformId === platformId)
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">
          {platform?.name} Web coordinator candidates: choose their Master Session account
        </Text>
        <Text dimColor>
          Every coordinator candidate gets an isolated Relay profile from this Master source. Worker accounts are selected separately.
        </Text>
        {sources.length === 0
          ? <Text color="yellow">No Master Session sources are registered for {platform?.name}. Create one with /mcp master-session add --platform {platformId} &lt;name&gt;.</Text>
          : (
            <Select
              options={sources.map(source => ({
                label: `${source.name} (${source.id})`,
                value: source.id,
                description: `Use the isolated ${platform?.name} Master Session profile "${source.name}" for all ${coordinatorCount} coordinator candidates.`,
              }))}
              onChange={(sourceId: string | undefined) => {
                if (!sourceId) return
                setCoordinatorMasterSessionSourceId(sourceId)
                setStep('session')
              }}
              onCancel={() => onComplete('Web mode setup cancelled')}
              visibleOptionCount={Math.min(8, sources.length)}
            />
          )}
      </Box>
    )
  }

  if (step === 'session') {
    const configuredCount = sessionModes.length + 1
    const sessionLabel = purpose === 'agent' ? 'worker' : 'instance'
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">
          {platform?.name} Web {sessionLabel} {configuredCount} of {agentCount}: choose its session
        </Text>
        <Select
          options={[
            {
              label: purpose === 'agent'
                ? 'Guest / clean — no Master Session cookies'
                : 'Guest / clean — no account session (recommended)',
              value: 'clean' as const,
              description: purpose === 'agent'
                ? 'Does not copy Master Session cookies; each window opens in its own clean browser profile.'
                : 'Isolated browser profile without Master Session cookies; anonymous access may be limited by the platform.',
            },
            ...(supportsMasterSession ? [{
              label: 'Authenticated — share Master Session account',
              value: 'authenticated' as const,
              description: purpose === 'agent'
                ? 'Transfers the authenticated session to each isolated Relay profile. Instances share the same account and usage quota.'
                : 'Transfers the authenticated session to this isolated Relay profile; the Master remains a separate browser profile.',
            }] : []),
            ...(canUseChromeProfile ? [{
              label: 'Importar desde Chrome (copia aislada)',
              value: 'chrome-profile' as const,
              description: 'Copia datos de sitio seleccionados una vez a este perfil Relay separado. Cierra Chrome normal; la copia no se sincroniza.',
            }] : []),
          ]}
          onChange={(value: AgentSessionMode | undefined) => {
            if (!value) return
            const nextModes = [...sessionModes, value]
            setSessionModes(nextModes)
            if (value === 'clean') {
              setMasterSessionSourceIds(previous => [...previous, undefined])
              setChromeProfileDirectories(previous => [...previous, undefined])
              continueAfterWorkerSessions(nextModes)
            } else if (value === 'authenticated') {
              setStep('account')
            } else if (value === 'chrome-profile') {
              beginChromeProfileSelection('chrome-profile')
            }
          }}
          onCancel={() => onComplete('Web mode setup cancelled')}
          visibleOptionCount={3}
        />
      </Box>
    )
  }

  if (step === 'account') {
    const sources = listMasterSessionSources().filter(source => source.platformId === platformId)
    const instanceNumber = sessionModes.length
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">
          {platform?.name} {purpose === 'agent' ? 'worker' : 'instance'} {instanceNumber} of {agentCount}: choose its Master Session account
        </Text>
        <Text dimColor>Each authenticated instance is bound to one source for {platform?.name}. Check /mcp master-session for status; create one with /mcp master-session add --platform {platformId} &lt;name&gt;.</Text>
        {sources.length === 0
          ? <Text color="yellow">No Master Session sources are registered for {platform?.name}. Create one with the command above.</Text>
          : (
            <Select
              options={sources.map(source => ({
                label: `${source.name} (${source.id})`,
                value: source.id,
                description: `Use the isolated ${platform?.name} Master Session profile "${source.name}".`,
              }))}
              onChange={(sourceId: string | undefined) => {
                if (!sourceId) return
                setMasterSessionSourceIds(previous => {
                  const next = [...previous]
                  next[instanceNumber - 1] = sourceId
                  return next
                })
                setChromeProfileDirectories(previous => [...previous, undefined])
                continueAfterWorkerSessions(sessionModes)
              }}
              onCancel={() => onComplete('Web mode setup cancelled')}
              visibleOptionCount={Math.min(8, sources.length)}
            />
          )}
      </Box>
    )
  }

  if (step === 'profile-copy-consent') {
    return (
      <Box flexDirection="column">
        <Text bold color="yellow">¿Autorizar la copia de datos del perfil local de Chrome?</Text>
        <Text>
          OpenMCP copiará cookies y datos de sitios seleccionados a un perfil Relay separado. Si Chrome normal sigue abierto, OpenMCP le solicitará un cierre normal y esperará antes de copiar. Esto puede cerrar todas sus ventanas; guarda tu trabajo primero. Si Chrome no se cierra, no se forzará su terminación y el asistente explicará cómo reintentar.
        </Text>
        <Text dimColor>
          Aunque el perfil original ya tenga una sesión abierta, Chrome puede impedir reutilizar sus cookies cifradas en la copia. Si ocurre, inicia sesión en la ventana Chrome de Relay (no en Chrome normal ni en la aplicación ChatGPT). Después, esa sesión persiste localmente en el Relay y no se sincroniza con el perfil original. No se copian historial, contraseñas, marcadores ni extensiones.
        </Text>
        <Select
          options={[
            { label: 'Sí, copiar y solicitar el cierre normal de Chrome si hace falta', value: 'authorize' },
            { label: 'Cancelar lanzamiento', value: 'cancel' },
          ]}
          onChange={(value: string | undefined) => {
            if (value === 'authorize') {
              setProfileCopyApproved(true)
              setStep('starting')
            } else {
              onComplete('Web mode setup cancelled: Chrome profile copy was not authorized')
            }
          }}
          onCancel={() => onComplete('Web mode setup cancelled')}
          visibleOptionCount={2}
        />
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        {step === 'preparing'
          ? 'Preparing SuperAssistant on every instance'
          : purpose === 'agent' ? 'Starting Web Relay agents' : `Opening manual ${platform.name} windows`}
      </Text>
      <Text dimColor>
        {step === 'preparing'
          ? `Verifying SuperAssistant settings on ${progress.length} ready instance(s); only fully prepared instances will be kept.`
          : `Launching ${requestedRelayCount} Relay(s) for ${agentCount} worker(s)` +
            (requestedRelayCount > agentCount ? ` plus ${requestedRelayCount - agentCount} Web coordinator candidate(s)` : '') +
            ` in batches of up to ${MAX_CONCURRENT_AGENT_STARTS}; usable instances will be retained if an individual launch fails.`}
      </Text>
      {progress.map(agent => (
        <Text key={agent.agentId}>
          {agent.agentId}: {agent.status}{agent.debugPort ? ` — port ${agent.debugPort}` : ''}
        </Text>
      ))}
      {error && <Text color="red">{error}</Text>}
    </Box>
  )
}
