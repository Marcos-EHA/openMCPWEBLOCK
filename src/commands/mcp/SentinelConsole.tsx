import React, { useRef, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { Select } from '../../components/CustomSelect/select.js'
import { useOrchestratorState } from '../../hooks/useOrchestratorState.js'
import type {
  AgentState,
  SentinelActivitySnapshot,
  SentinelConversationSnapshot,
  SentinelScanResult,
} from '../../services/webRelay/orchestration/types.js'
import { prepareSAAgentForWebRelay } from '../../services/webRelay/WebRelayProvider.js'
import { GeminiOrchestrator } from '../../services/geminiOrchestrator/GeminiOrchestrator.js'
import { getCurrentProjectConfig, saveCurrentProjectConfig } from '../../utils/config.js'
import { getWebPlatformById } from '../../utils/webPlatforms.js'
import { setSentinelComposerMode } from '../../services/geminiOrchestrator/sentinelComposerMode.js'
import {
  CLAUDE_COMPACT_CONTROL_EVIDENCE,
  CLAUDE_EXECUTION_IDENTITY_DIAGNOSIS_EVIDENCE,
  CLAUDE_HIDDEN_TEXT_RESPONSE_EVIDENCE,
  CHATGPT_HIDDEN_EXECUTION_EVIDENCE,
  CHATGPT_AUTO_EXECUTION_DIAGNOSIS,
  CHATGPT_AUTO_EXECUTION_EVIDENCE,
  SENTINEL_EVIDENCE_MENU_OPTION,
} from '../../services/webRelay/orchestration/SentinelEvidence.js'

const MAX_GEMINI_LAUNCH = 5

function reportScan(result: SentinelScanResult): string {
  const detail = result.details.length > 0
    ? result.details.map(item => {
      const sa = item.saConfiguration
      const saReady = sa?.inspected === true &&
        sa.mcpEnabled === true &&
        sa.pushContentMode === true &&
        sa.autoInsert === true &&
        sa.autoSubmit === true &&
        sa.autoExecute === true &&
        sa.sidebarVisible === true &&
        sa.compactButtonVisible === true
      return `  ${item.agentId} [${item.sessionMode ?? 'sesión desconocida'}${item.masterSessionSourceId ? ` · Master ${item.masterSessionSourceName ?? item.masterSessionSourceId}` : ''}]: ` +
        `Chrome ${item.portAlive ? 'OK' : 'caído'}, ` +
        `SA ${saReady ? 'configuración lista' : sa?.inspected ? 'requiere atención' : 'sin verificar'}, ` +
        `pestaña ${sa?.pageVisibility ?? 'sin medir'}/foco ${sa?.pageHasFocus === null || sa?.pageHasFocus === undefined ? 'sin medir' : sa.pageHasFocus ? 'sí' : 'no'}, ` +
        `MCP ${item.mcpAlive === null ? 'no comprobado' : item.mcpAlive ? 'OK' : 'inactivo'}` +
        (item.diagnostics.length > 0
          ? `\n${item.diagnostics.map(diagnostic =>
            `    ${diagnostic.severity.toUpperCase()} [${diagnostic.code}]: ${diagnostic.message}`,
          ).join('\n')}`
          : '\n    Sin incidencias de configuración detectadas.')
    }).join('\n')
    : '  No hay agentes listos registrados para comprobar.'
  return `Sentinel: ${result.healthy ? 'sin incidencias' : `${result.issuesFound} incidencia(s)`}; ${result.agentsChecked} agente(s) comprobado(s). La visibilidad/foco son una instantánea de la pestaña, no una prueba de ejecución desatendida ni del estado foreground de Windows.\n${detail}`
}

function formatActivity(snapshot: SentinelActivitySnapshot): string {
  if (!snapshot.available) {
    const reason = snapshot.unavailableReason === 'agent-not-ready'
      ? 'El Relay no está listo o no tiene puerto CDP.'
      : snapshot.unavailableReason === 'missing-extension-id'
        ? 'No hay una identidad de extensión SuperAssistant registrada para este Relay.'
        : 'El service worker de SuperAssistant no está disponible en este Relay.'
    return `Sentinel no pudo leer actividad de ${snapshot.agentId}: ${reason}`
  }
  if (snapshot.events.length === 0) {
    return `Relay ${snapshot.agentId}: no hay eventos técnicos recientes. No se leyó contenido de la conversación.`
  }
  const rows = snapshot.events.map(event => {
    const details = [
      event.toolName ? `herramienta ${event.toolName}` : undefined,
      event.callId ? `callId ${event.callId}` : undefined,
      typeof event.success === 'boolean' ? `resultado ${event.success ? 'correcto' : 'fallido'}` : undefined,
      event.resultStatus ? `estado ${event.resultStatus}` : undefined,
      event.pageVisibility ? `pestaña ${event.pageVisibility}` : undefined,
      typeof event.pageHasFocus === 'boolean' ? `foco ${event.pageHasFocus ? 'sí' : 'no'}` : undefined,
    ].filter(Boolean)
    return `  ${new Date(event.timestamp).toLocaleTimeString()} ${event.event}${details.length > 0 ? ` · ${details.join(' · ')}` : ''}`
  })
  return `Actividad técnica de ${snapshot.agentId} (últimos ${snapshot.events.length} eventos; sin texto de mensajes ni respuestas):\n${rows.join('\n')}`
}

function conversationUnavailableReason(snapshot: SentinelConversationSnapshot): string {
  switch (snapshot.unavailableReason) {
    case 'agent-not-ready':
      return 'El Relay no está listo o no tiene puerto CDP.'
    case 'unsupported-platform':
      return 'La lectura de contenido solo está implementada para ChatGPT.'
    case 'no-platform-tab':
      return 'No se encontró una pestaña ChatGPT en ese Relay.'
    case 'multiple-platform-tabs':
      return 'Hay varias pestañas ChatGPT; cierra las que no correspondan y vuelve a consultar.'
    default:
      return 'El snapshot no está disponible.'
  }
}

export function SentinelConsole({
  onComplete,
  initialStep = 'menu',
}: {
  onComplete: (message: string) => void
  initialStep?: 'menu' | 'recover-purpose'
}): React.ReactNode {
  const recoveryFlow = initialStep === 'recover-purpose'
  const { state, actions } = useOrchestratorState()
  const [step, setStep] = useState<'menu' | 'count' | 'working' | 'model' | 'evidence' | 'activity-agent' | 'activity' | 'conversation-agent' | 'conversation-consent' | 'conversation' | 'recover-purpose' | 'recover-mode' | 'recover-result'>(initialStep)
  const [recoveryPurpose, setRecoveryPurpose] = useState<'agent' | 'user' | 'infer' | null>(null)
  const [activitySnapshot, setActivitySnapshot] = useState<SentinelActivitySnapshot | null>(null)
  const [conversationAgentId, setConversationAgentId] = useState<string | null>(null)
  const [conversationSnapshot, setConversationSnapshot] = useState<SentinelConversationSnapshot | null>(null)
  const busyRef = useRef(false)
  const [messages, setMessages] = useState<string[]>([
    recoveryFlow
      ? 'Buscaremos instancias Web Relay abiertas y verificaremos su identidad antes de adjuntarlas. No se enviarán mensajes a Sentinel ni se abrirán o cerrarán ventanas.'
      : 'Esta pantalla configura Sentinel. Para hablar, activa Sentinel y escribe en la barra de entrada.',
  ])
  const config = getCurrentProjectConfig()
  const platformId = config.selectedWebPlatform || 'chatgpt'
  const platform = getWebPlatformById(platformId)
  const managedPrefix = `sentinel-${platformId}-guest-`
  const managedGuests = Object.values(state.agents)
    .filter(agent =>
      agent.platformId === platformId &&
      agent.sessionMode === 'clean' &&
      !agent.role?.startsWith('manual-user-'),
    )
    .sort((left, right) => left.agentId.localeCompare(right.agentId))
  const registeredAgents = Object.values(state.agents)
    .sort((left, right) => left.agentId.localeCompare(right.agentId))

  const appendMessage = (message: string) => {
    setMessages(previous => [...previous, message].slice(-12))
  }

  const runOperation = async (operation: () => Promise<void>): Promise<void> => {
    if (busyRef.current) return
    const returnStep = step
    busyRef.current = true
    setStep('working')
    try {
      await operation()
    } catch (error) {
      appendMessage(`Operación fallida: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      busyRef.current = false
      setStep(recoveryFlow
        ? 'recover-result'
        : returnStep === 'model' || returnStep === 'count' ? returnStep : 'menu')
    }
  }

  const launchGuests = async (count: number): Promise<void> => {
    if (!platform) throw new Error(`La plataforma configurada «${platformId}» no existe.`)

    const launched: AgentState[] = []
    const occupiedIds = new Set(Object.keys(state.agents))
    let candidate = 1
    try {
      while (launched.length < count) {
        const agentId = `${managedPrefix}${candidate++}`
        if (occupiedIds.has(agentId)) continue
        occupiedIds.add(agentId)
        appendMessage(`Preparando invitado ${launched.length + 1}/${count} (${platform.name}) como perfil clean…`)
        const agent = await actions.startAgent(
          agentId,
          platformId,
          `sentinel-guest-${launched.length + 1}`,
          'clean',
        )
        if (agent.status !== 'ready' || agent.sessionMode !== 'clean' || !agent.debugPort) {
          const cleanup = await actions.stopAgent(agentId)
          if (cleanup.status !== 'stopped') {
            throw new Error(
              `${agentId} falló la verificación (estado ${agent.status}, ` +
              `sesión ${agent.sessionMode ?? 'desconocida'}) y la detención no se confirmó (${cleanup.status}).`,
            )
          }
          throw new Error(
            `${agentId} no pasó la verificación de sesión guest/SA (estado ${agent.status}, ` +
            `sesión ${agent.sessionMode ?? 'desconocida'}); detenerlo devolvió estado ${cleanup.status}.`,
          )
        }
        launched.push(agent)
        await prepareSAAgentForWebRelay(agent.debugPort, agent.saExtensionId, platformId)
      }

      const launchedIds = launched.map(agent => agent.agentId)
      saveCurrentProjectConfig(current => ({
        ...current,
        mcpExecutionMode: 'web',
        selectedWebPlatform: platformId,
        webRelayAgentIds: [...new Set([...(current.webRelayAgentIds ?? []), ...launchedIds])],
        webRelayAgentProfiles: [
          ...(current.webRelayAgentProfiles ?? []).filter(profile => !launchedIds.includes(profile.agentId)),
          ...launchedIds.map(agentId => ({ agentId, sessionMode: 'clean' as const })),
        ],
      }))
    } catch (error) {
      const cleanupResults = await Promise.allSettled(launched.map(agent => actions.stopAgent(agent.agentId)))
      const cleanupFailures = cleanupResults.flatMap((result, index) =>
        result.status === 'rejected'
          ? [`${launched[index]!.agentId}: ${String(result.reason)}`]
          : result.value.status !== 'stopped'
            ? [`${launched[index]!.agentId}: stop returned ${result.value.status}`]
            : [],
      )
      const originalMessage = error instanceof Error ? error.message : String(error)
      throw new Error(
        cleanupFailures.length > 0
          ? `${originalMessage}. No se pudo completar la limpieza de: ${cleanupFailures.join('; ')}`
          : `${originalMessage}. Los agentes guest iniciados por esta orden se detuvieron.`,
      )
    }

    appendMessage(
      `Listo: ${launched.length} invitado(s) ${platform.name} preparados con SuperAssistant, sesión clean y puerto CDP verificado. ` +
      'La sesión maestra autenticada no se clonó ni se modificó.',
    )
  }

  const stopGuests = async (): Promise<void> => {
    const activeGuests = managedGuests.filter(agent => agent.status !== 'stopped')
    if (activeGuests.length === 0) {
      appendMessage(`No hay agentes guest/clean activos para ${platform?.name ?? platformId}.`)
      return
    }
    const stopped: string[] = []
    for (const agent of activeGuests) {
      const result = await actions.stopAgent(agent.agentId)
      if (result.status !== 'stopped') {
        throw new Error(`No se confirmó la detención de ${agent.agentId} (estado ${result.status}).`)
      }
      stopped.push(agent.agentId)
      saveCurrentProjectConfig(current => ({
        ...current,
        webRelayAgentIds: (current.webRelayAgentIds ?? []).filter(id => id !== agent.agentId),
        webRelayAgentProfiles: (current.webRelayAgentProfiles ?? []).filter(profile => profile.agentId !== agent.agentId),
      }))
    }
    appendMessage(`Detenidos ${stopped.length} agente(s) guest: ${stopped.join(', ')}. La sesión maestra no se tocó.`)
  }

  const recoverInstances = async (sessionMode: 'clean' | 'authenticated'): Promise<void> => {
    if (!recoveryPurpose) throw new Error('Elige primero si las ventanas se usarán como agentes o como ventanas manuales.')
    const result = await actions.recoverExistingAgents(platformId, sessionMode, recoveryPurpose)
    if (result.adopted.length > 0) {
      const recoveredIds = result.adopted.map(agent => agent.agentId)
      const relayAgentIds = sessionMode === 'clean' && recoveryPurpose !== 'user'
        ? result.adopted
          .filter(agent => !agent.role?.startsWith('manual-user-'))
          .map(agent => agent.agentId)
        : []
      saveCurrentProjectConfig(current => ({
        ...current,
        ...(relayAgentIds.length > 0 ? { mcpExecutionMode: 'web' as const } : {}),
        selectedWebPlatform: platformId,
        webRelayAgentIds: [
          ...new Set([
            ...(current.webRelayAgentIds ?? []).filter(id => !recoveredIds.includes(id)),
            ...relayAgentIds,
          ]),
        ],
        webRelayAgentProfiles: [
          ...(current.webRelayAgentProfiles ?? []).filter(profile => !recoveredIds.includes(profile.agentId)),
          ...relayAgentIds.map(agentId => ({ agentId, sessionMode: 'clean' as const })),
        ],
      }))
    }

    const recovered = result.adopted.length > 0
      ? `Reconectadas ${result.adopted.length} instancia(s) (${recoveryPurpose === 'infer' ? 'propósito identificado automáticamente' : recoveryPurpose === 'agent' ? 'agentes' : 'ventanas manuales'}, ${sessionMode}): ${result.adopted.map(agent => `${agent.agentId} (puerto ${agent.debugPort})`).join(', ')}.` +
        (sessionMode === 'clean' && recoveryPurpose === 'agent'
          ? ' Añadidas al pool Web Relay.'
          : sessionMode === 'clean' && recoveryPurpose === 'infer'
            ? ' Los perfiles identificados como agentes clean se añadieron al pool; las ventanas manuales quedaron fuera.'
          : ' Registradas sin incluirlas en el pool de tareas Web Relay.')
      : `No se reconectó ninguna instancia ${platform?.name ?? platformId}. Se revisaron ${result.cdpPortsScanned} puertos CDP (${result.cdpPortsFound} respondieron y ${result.matchingIdentitiesFound} tenían identidad SA para esta plataforma).`
    const skipped = result.skipped.length > 0
      ? `\nNo adjuntadas:\n${result.skipped.map(item => `  • ${item}`).join('\n')}`
      : ''
    appendMessage(`${recovered}${skipped}`)
  }

  const readRelayActivity = async (agentId: string): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setStep('working')
    try {
      const snapshot = await actions.readSentinelActivity(agentId)
      setActivitySnapshot(snapshot)
      appendMessage(formatActivity(snapshot))
      setStep('activity')
    } catch (error) {
      appendMessage(`No se pudo leer actividad técnica de ${agentId}: ${error instanceof Error ? error.message : String(error)}`)
      setStep('activity-agent')
    } finally {
      busyRef.current = false
    }
  }

  const readConversationSnapshot = async (): Promise<void> => {
    if (!conversationAgentId || busyRef.current) return
    busyRef.current = true
    setStep('working')
    try {
      const snapshot = await actions.readSentinelConversation(conversationAgentId)
      setConversationSnapshot(snapshot)
      setStep('conversation')
    } catch (error) {
      appendMessage(`No se pudo leer el snapshot de ${conversationAgentId}: ${error instanceof Error ? error.message : String(error)}`)
      setStep('conversation-consent')
    } finally {
      busyRef.current = false
    }
  }

  const sentinel = state.sentinel
  const recentSentinelLogs = state.events
    .filter(event => event.name === 'sentinel:log')
    .slice(0, 8)
  const sentinelAssistant = new GeminiOrchestrator({
    model: config.sentinelModel,
    systemPrompt: 'Sentinel model configuration check.',
  })
  const showDashboard = !recoveryFlow && step !== 'evidence'
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{recoveryFlow
        ? 'Web Relay · Reconectar instancias abiertas'
        : step === 'evidence'
          ? 'Sentinel · Evidencia del flujo MCP'
          : 'Sentinel · Consola operativa'}</Text>
      {showDashboard && (
        <>
          <Text>Chat Gemini: {sentinelAssistant.isConfigured ? 'configurado' : 'falta configurar la clave'} · modelo {sentinelAssistant.model}</Text>
          <Text dimColor>Activa ◆ Sentinel y escribe aquí abajo. El monitor de actividad solo muestra metadatos técnicos del Relay; no lee texto de chats ni respuestas.</Text>
        </>
      )}
      {(recoveryFlow || showDashboard) && <Text>{recoveryFlow ? 'Plataforma Web Relay' : 'Modelo'}: {platform?.name ?? platformId}{!recoveryFlow ? ` · modo: ${config.mcpExecutionMode ?? 'api'}` : ''}</Text>}
      {showDashboard && <Text>Sesión maestra autenticada: independiente; esta consola no la clona, inicia ni verifica.</Text>}
      {showDashboard && <Text>
        Agentes relay registrados: {registeredAgents.length === 0
          ? 'ninguno'
          : registeredAgents.map(agent =>
            `${agent.agentId} [${agent.status}, ${agent.sessionMode ?? 'sesión sin dato'}, ` +
            `${agent.sessionMode === 'authenticated' ? `Master ${agent.masterSessionSourceId ?? 'sin fuente'}, ` : ''}` +
            `CDP ${agent.debugPort ?? '—'}]`,
          ).join(' · ')}
      </Text>}
      {showDashboard && <Text>
        Agentes guest/clean de esta plataforma: {managedGuests.length === 0
          ? 'ninguno'
          : managedGuests.map(agent => `${agent.agentId} [${agent.status}, ${agent.sessionMode ?? 'sin dato'}, CDP ${agent.debugPort ?? '—'}]`).join(' · ')}
      </Text>}
      {showDashboard && <Text>
        Último escaneo: {sentinel
          ? `${sentinel.healthy ? 'saludable' : 'con incidencias'} · ${sentinel.agentsChecked} revisados · ${sentinel.issuesFound} incidencias`
          : 'aún no ejecutado'}
      </Text>}
      {showDashboard && <Box flexDirection="column">
        <Text bold>Logs recientes de Sentinel (máximo 8)</Text>
        {recentSentinelLogs.length > 0
          ? recentSentinelLogs.map(entry => (
            <Text key={entry.id} color={entry.severity === 'error' ? 'red' : entry.severity === 'warning' ? 'yellow' : undefined}>
              {new Date(entry.timestamp).toLocaleTimeString()} {entry.severity?.toUpperCase() ?? 'INFO'} [{entry.code ?? entry.name}]{entry.agentId ? ` ${entry.agentId}` : ''}{entry.detail ? `: ${entry.detail}` : ''}
            </Text>
          ))
          : <Text dimColor>Sin errores o advertencias registrados todavía.</Text>}
      </Box>}
      {messages.map((message, index) => (
        <Text key={`${index}-${message}`} color={index === messages.length - 1 ? 'cyan' : undefined}>{message}</Text>
      ))}
      {step === 'working' ? (
        <Text dimColor>{recoveryFlow ? 'Buscando puertos CDP e identidades de SuperAssistant; espera…' : 'Sentinel está ejecutando la operación; espera a que termine…'}</Text>
      ) : step === 'recover-result' ? (
        <Box flexDirection="column" gap={1}>
          <Text bold>Resultado de la reconexión Web Relay</Text>
          <Select
            options={[{ label: 'Cerrar', value: 'close' }]}
            onChange={() => onComplete(messages.slice(1).join('\n'))}
            onCancel={() => onComplete(messages.slice(1).join('\n'))}
          />
          <Text dimColor>↑/↓ y Enter para cerrar</Text>
        </Box>
      ) : step === 'model' ? (
        <Box flexDirection="column" gap={1}>
          <Text bold>Elige el modelo de Gemini para Sentinel</Text>
          <Select
            options={[
              { label: 'Gemini 2.5 Flash (recomendado)', value: 'gemini-2.5-flash', description: 'Modelo rápido y compatible.' },
              { label: 'Gemini 2.5 Pro', value: 'gemini-2.5-pro', description: 'Modelo más capaz; puede consumir más cuota.' },
              { label: 'Modelo desde GEMINI_MODEL', value: '__environment__', description: `Usar el modelo configurado actualmente: ${process.env.GEMINI_MODEL || 'gemini-3.8-flash'}.` },
            ]}
            onChange={value => {
              saveCurrentProjectConfig(current => ({
                ...current,
                sentinelModel: value === '__environment__' ? undefined : value,
              }))
              appendMessage(
                value === '__environment__'
                  ? 'Sentinel usará el modelo GEMINI_MODEL configurado en el entorno.'
                  : `Modelo de Sentinel guardado: ${value}.`,
              )
              setStep('menu')
            }}
            onCancel={() => setStep('menu')}
          />
        </Box>
      ) : step === 'evidence' ? (
        <Box flexDirection="column" gap={1}>
          <Text bold>Sentinel · Evidencia y diagnóstico del flujo MCP</Text>
          <Text>{CHATGPT_AUTO_EXECUTION_EVIDENCE.title} · {CHATGPT_AUTO_EXECUTION_EVIDENCE.date}</Text>
          <Text color="yellow">Conclusión: {CHATGPT_AUTO_EXECUTION_EVIDENCE.conclusion}</Text>
          <Text>Diagnóstico actual [{CHATGPT_AUTO_EXECUTION_DIAGNOSIS.code}, {CHATGPT_AUTO_EXECUTION_DIAGNOSIS.confidence}]: {CHATGPT_AUTO_EXECUTION_DIAGNOSIS.summary}</Text>
          <Text>Comprobación recomendada: {CHATGPT_AUTO_EXECUTION_DIAGNOSIS.nextCheck}</Text>
          <Text bold>Observado</Text>
          {CHATGPT_AUTO_EXECUTION_EVIDENCE.observed.map(item => (
            <Text key={item}>• {item}</Text>
          ))}
          <Text bold>No demostrado</Text>
          {CHATGPT_AUTO_EXECUTION_EVIDENCE.notProven.map(item => (
            <Text key={item}>• {item}</Text>
          ))}
          <Text>Protocolo pendiente: {CHATGPT_AUTO_EXECUTION_EVIDENCE.nextCheck}</Text>
          <Text dimColor>El escaneo de salud solo verifica CDP, SuperAssistant y MCP; no ejecuta herramientas ni certifica el foco de una conversación.</Text>
          <Text bold>{CHATGPT_HIDDEN_EXECUTION_EVIDENCE.title} · {CHATGPT_HIDDEN_EXECUTION_EVIDENCE.date}</Text>
          <Text color="yellow">Conclusión: {CHATGPT_HIDDEN_EXECUTION_EVIDENCE.conclusion}</Text>
          <Text bold>Observado</Text>
          {CHATGPT_HIDDEN_EXECUTION_EVIDENCE.observed.map(item => (
            <Text key={item}>• {item}</Text>
          ))}
          <Text bold>No demostrado</Text>
          {CHATGPT_HIDDEN_EXECUTION_EVIDENCE.notProven.map(item => (
            <Text key={item}>• {item}</Text>
          ))}
          <Text>Próxima comprobación: {CHATGPT_HIDDEN_EXECUTION_EVIDENCE.nextCheck}</Text>
          <Text bold>{CLAUDE_COMPACT_CONTROL_EVIDENCE.title} · {CLAUDE_COMPACT_CONTROL_EVIDENCE.date}</Text>
          <Text color="yellow">Conclusión: {CLAUDE_COMPACT_CONTROL_EVIDENCE.conclusion}</Text>
          <Text bold>Observado</Text>
          {CLAUDE_COMPACT_CONTROL_EVIDENCE.observed.map(item => (
            <Text key={item}>• {item}</Text>
          ))}
          <Text bold>No demostrado</Text>
          {CLAUDE_COMPACT_CONTROL_EVIDENCE.notProven.map(item => (
            <Text key={item}>• {item}</Text>
          ))}
          <Text>Próxima comprobación: {CLAUDE_COMPACT_CONTROL_EVIDENCE.nextCheck}</Text>
          <Text bold>{CLAUDE_HIDDEN_TEXT_RESPONSE_EVIDENCE.title} · {CLAUDE_HIDDEN_TEXT_RESPONSE_EVIDENCE.date}</Text>
          <Text color="yellow">Conclusión: {CLAUDE_HIDDEN_TEXT_RESPONSE_EVIDENCE.conclusion}</Text>
          <Text bold>Observado</Text>
          {CLAUDE_HIDDEN_TEXT_RESPONSE_EVIDENCE.observed.map(item => (
            <Text key={item}>• {item}</Text>
          ))}
          <Text bold>No demostrado</Text>
          {CLAUDE_HIDDEN_TEXT_RESPONSE_EVIDENCE.notProven.map(item => (
            <Text key={item}>• {item}</Text>
          ))}
          <Text>Próxima comprobación: {CLAUDE_HIDDEN_TEXT_RESPONSE_EVIDENCE.nextCheck}</Text>
          <Text bold>{CLAUDE_EXECUTION_IDENTITY_DIAGNOSIS_EVIDENCE.title} · {CLAUDE_EXECUTION_IDENTITY_DIAGNOSIS_EVIDENCE.date}</Text>
          <Text color="yellow">Conclusión: {CLAUDE_EXECUTION_IDENTITY_DIAGNOSIS_EVIDENCE.conclusion}</Text>
          <Text bold>Observado</Text>
          {CLAUDE_EXECUTION_IDENTITY_DIAGNOSIS_EVIDENCE.observed.map(item => (
            <Text key={item}>• {item}</Text>
          ))}
          <Text bold>No demostrado</Text>
          {CLAUDE_EXECUTION_IDENTITY_DIAGNOSIS_EVIDENCE.notProven.map(item => (
            <Text key={item}>• {item}</Text>
          ))}
          <Text>Próxima comprobación: {CLAUDE_EXECUTION_IDENTITY_DIAGNOSIS_EVIDENCE.nextCheck}</Text>
          <Select
            options={[
              { label: 'Volver a Sentinel', value: 'back' },
              { label: 'Escanear configuración SA ahora', value: 'scan' },
            ]}
            onChange={(value: string) => {
              if (value === 'back') {
                setStep('menu')
              } else {
                void runOperation(async () => appendMessage(reportScan(await actions.scanSentinel())))
              }
            }}
            onCancel={() => setStep('menu')}
          />
          <Text dimColor>↑/↓ para elegir · Enter para ejecutar · Esc para volver</Text>
        </Box>
      ) : step === 'count' ? (
        <Box flexDirection="column" gap={1}>
          <Text bold>¿Cuántos perfiles invitados quieres lanzar? Máximo 20 por operación.</Text>
          <Select
            options={Array.from({ length: 20 }, (_, index) => ({
              label: `${index + 1} invitado(s) guest · ${platform?.name ?? platformId}`,
              value: String(index + 1),
            }))}
            onChange={value => { void runOperation(() => launchGuests(Number(value))) }}
            onCancel={() => setStep('menu')}
          />
          <Text dimColor>Enter para confirmar · Esc para volver</Text>
        </Box>
      ) : step === 'activity-agent' ? (
        <Box flexDirection="column" gap={1}>
          <Text bold>¿De qué Relay registrado quieres ver la actividad técnica reciente?</Text>
          <Text dimColor>Se consultan eventos MCP y estados de ejecución de la extensión. No se accede al texto de la conversación, argumentos ni respuestas.</Text>
          {registeredAgents.filter(agent => agent.status === 'ready').length > 0 ? (
            <Select
              options={[
                ...registeredAgents
                  .filter(agent => agent.status === 'ready')
                  .map(agent => ({
                    label: `${agent.agentId} · CDP ${agent.debugPort ?? '—'}`,
                    value: agent.agentId,
                    description: `${agent.platformId} · ${agent.sessionMode ?? 'sesión sin dato'}`,
                  })),
                { label: 'Volver', value: '__back' },
              ]}
              onChange={value => {
                if (value === '__back') setStep('menu')
                else void readRelayActivity(value)
              }}
              onCancel={() => setStep('menu')}
            />
          ) : (
            <>
              <Text dimColor>No hay Relays registrados en estado ready para consultar.</Text>
              <Select
                options={[{ label: 'Volver', value: '__back' }]}
                onChange={() => setStep('menu')}
                onCancel={() => setStep('menu')}
              />
            </>
          )}
          <Text dimColor>↑/↓ para elegir · Enter para consultar · Esc para volver</Text>
        </Box>
      ) : step === 'activity' ? (
        <Box flexDirection="column" gap={1}>
          <Text bold>Actividad técnica del Relay</Text>
          {activitySnapshot && <Text>{formatActivity(activitySnapshot)}</Text>}
          <Select
            options={[
              { label: 'Elegir otro Relay', value: 'another' },
              { label: 'Volver a Sentinel', value: 'back' },
            ]}
            onChange={value => setStep(value === 'another' ? 'activity-agent' : 'menu')}
            onCancel={() => setStep('menu')}
          />
          <Text dimColor>Esta vista no muestra el texto de mensajes, argumentos ni respuestas.</Text>
        </Box>
      ) : step === 'conversation-agent' ? (
        <Box flexDirection="column" gap={1}>
          <Text bold>Selecciona la instancia ChatGPT que autorizas consultar</Text>
          <Text dimColor>Solo se ofrecen Relays registrados y listos. No se inspecciona ninguna Master Session ni otra pestaña.</Text>
          {registeredAgents.filter(agent => agent.status === 'ready' && agent.platformId === 'chatgpt').length === 0 && (
            <Text dimColor>No hay un Relay ChatGPT registrado y listo. Una ventana Master no se adopta automáticamente.</Text>
          )}
          <Select
            options={[
              ...registeredAgents
                .filter(agent => agent.status === 'ready' && agent.platformId === 'chatgpt')
                .map(agent => ({
                  label: `${agent.agentId} · CDP ${agent.debugPort ?? '—'}`,
                  value: agent.agentId,
                  description: `${agent.sessionMode ?? 'sesión sin dato'}${agent.masterSessionSourceId ? ` · Master ${agent.masterSessionSourceId}` : ''}`,
                })),
              { label: 'Volver', value: '__back' },
            ]}
            onChange={agentId => {
              if (agentId === '__back') {
                setStep('menu')
              } else {
                setConversationAgentId(agentId)
                setConversationSnapshot(null)
                setStep('conversation-consent')
              }
            }}
            onCancel={() => setStep('menu')}
          />
        </Box>
      ) : step === 'conversation-consent' ? (
        <Box flexDirection="column" gap={1}>
          <Text bold>Autorizar snapshot visible de la conversación</Text>
          <Text>
            Relay: {conversationAgentId ?? 'ninguno'}. Al continuar, Sentinel leerá el texto renderizado de la única pestaña ChatGPT de ese Relay y lo mostrará en esta terminal.
          </Text>
          <Text dimColor>
            Alcance: hasta 30 mensajes visibles, 2.000 caracteres por mensaje. Snapshot puntual; no se persiste, no se envía a Gemini ni al colector y no se leen otras pestañas. La salida visible de la terminal queda bajo el control de OpenMCP/tu entorno.
          </Text>
          <Select
            options={[
              { label: 'Autorizar y mostrar snapshot', value: 'authorize' },
              { label: 'Cancelar', value: 'cancel' },
            ]}
            onChange={value => {
              if (value === 'authorize') void readConversationSnapshot()
              else {
                setConversationAgentId(null)
                setStep('menu')
              }
            }}
            onCancel={() => {
              setConversationAgentId(null)
              setStep('menu')
            }}
          />
        </Box>
      ) : step === 'conversation' ? (
        <Box flexDirection="column" gap={1}>
          <Text bold>
            {conversationSnapshot?.available
              ? `Snapshot de conversación · ${conversationSnapshot.agentId} · ${conversationSnapshot.messages.length} mensajes`
              : `Snapshot no disponible · ${conversationSnapshot?.agentId ?? conversationAgentId ?? 'Relay'}`}
          </Text>
          {conversationSnapshot && !conversationSnapshot.available && (
            <Text color="yellow">{conversationUnavailableReason(conversationSnapshot)}</Text>
          )}
          {conversationSnapshot?.available && conversationSnapshot.messages.length === 0 && (
            <Text dimColor>No se encontraron mensajes renderizados en la conversación actual.</Text>
          )}
          {conversationSnapshot?.available && conversationSnapshot.messages.map((message, index) => (
            <Box key={`${conversationSnapshot.capturedAt ?? 'snapshot'}-${index}`} flexDirection="column">
              <Text bold color={message.role === 'user' ? 'cyan' : 'green'}>
                {message.role === 'user' ? 'Tú' : 'Asistente'}
              </Text>
              <Text>{message.text}</Text>
            </Box>
          ))}
          {conversationSnapshot?.truncated && (
            <Text color="yellow">Snapshot limitado a los 30 mensajes más recientes y 2.000 caracteres por mensaje.</Text>
          )}
          {conversationSnapshot?.capturedAt && (
            <Text dimColor>Capturado {new Date(conversationSnapshot.capturedAt).toLocaleTimeString()}. Para ver cambios nuevos, actualiza manualmente.</Text>
          )}
          <Select
            options={[
              { label: 'Actualizar snapshot', value: 'refresh' },
              { label: 'Borrar de la vista y volver', value: 'clear' },
            ]}
            onChange={value => {
              if (value === 'refresh') void readConversationSnapshot()
              else {
                setConversationSnapshot(null)
                setConversationAgentId(null)
                setStep('menu')
              }
            }}
            onCancel={() => {
              setConversationSnapshot(null)
              setConversationAgentId(null)
              setStep('menu')
            }}
          />
        </Box>
      ) : step === 'recover-mode' ? (
        <Box flexDirection="column" gap={1}>
          <Text bold>¿Qué tipo de sesión tienen los perfiles que quieres reconectar?</Text>
          <Text dimColor>Esto solo clasifica las instancias para OpenMCPWEBLOCK; no copia, transfiere ni modifica cookies. Si el perfil ya tiene una clasificación guardada, debe coincidir.</Text>
          <Select
            options={[
              { label: 'Guest / clean', value: 'clean', description: 'Sin sesión autenticada; pueden entrar al pool de agentes Web Relay.' },
              { label: 'Autenticada', value: 'authenticated', description: 'Perfil con sesión iniciada; se registra separado y no entra al pool guest.' },
            ]}
            onChange={value => {
              if (value === 'clean' || value === 'authenticated') {
                void runOperation(() => recoverInstances(value))
              }
            }}
            onCancel={() => setStep('recover-purpose')}
          />
          <Text dimColor>Solo se adjuntan perfiles con identidad SA válida. Si otro proceso OpenMCP sigue activo, no se toma el control.</Text>
        </Box>
      ) : step === 'recover-purpose' ? (
        <Box flexDirection="column" gap={1}>
          <Text bold>¿Cómo quieres usar las instancias recuperadas?</Text>
          <Text dimColor>La elección se aplica a los perfiles encontrados de la plataforma seleccionada. Los perfiles nuevos ya guardan su propósito; los antiguos requieren esta confirmación.</Text>
          <Select
            options={[
              { label: 'Separar automáticamente (recomendado)', value: 'infer', description: 'Usa la identidad persistida y los IDs web-chatgpt-agent/user; perfiles ambiguos se omiten.' },
              { label: 'Modo agente', value: 'agent', description: 'Perfiles clean se añaden al pool para tareas Web Relay.' },
              { label: 'Modo usuario / manual', value: 'user', description: 'Ventanas independientes; OpenMCPWEBLOCK no les enviará tareas.' },
            ]}
            onChange={value => {
              if (value === 'agent' || value === 'user' || value === 'infer') {
                setRecoveryPurpose(value)
                setStep('recover-mode')
              }
            }}
            onCancel={() => setStep('menu')}
          />
        </Box>
      ) : (
        <Box flexDirection="column" gap={1}>
          <Text bold>¿Qué necesitas que haga Sentinel?</Text>
          <Select
            options={[
              { label: 'Comprobar salud ahora', value: 'scan', description: 'Escanea Chrome, SA y MCP de los agentes listos.' },
              { label: 'Ver actividad técnica de un Relay', value: 'activity', description: 'Muestra eventos de ejecución sin inspeccionar el texto del chat.' },
              { label: 'Ver snapshot de conversación (ChatGPT)', value: 'conversation', description: 'Lee y muestra mensajes tras confirmación explícita; snapshot local, no persistido.' },
              SENTINEL_EVIDENCE_MENU_OPTION,
              { label: 'Reconectar instancias ya abiertas', value: 'recover', description: 'Adopta perfiles con identidad SA; no lanza Chrome ni modifica sus sesiones.' },
              { label: 'Preparar agentes invitados', value: 'launch', description: 'Lanza perfiles guest clean con SA; no copia la sesión maestra.' },
              { label: 'Detener agentes guest/clean', value: 'stop', description: 'No detiene sesiones autenticadas ni la sesión maestra.' },
              { label: 'Activar Sentinel en la barra de entrada', value: 'chat', description: 'El próximo mensaje normal irá a Sentinel. No lo envía a una instancia web.' },
              { label: 'Configurar modelo de Sentinel', value: 'model', description: 'Elegir Gemini 2.5 Flash recomendado, 2.5 Pro o el modelo del entorno.' },
              { label: 'Cerrar consola', value: 'exit' },
            ]}
            onChange={value => {
              if (value === 'scan') {
                void runOperation(async () => appendMessage(reportScan(await actions.scanSentinel())))
              } else if (value === 'activity') {
                setStep('activity-agent')
              } else if (value === 'conversation') {
                setStep('conversation-agent')
              } else if (value === 'evidence') {
                setStep('evidence')
              } else if (value === 'launch') {
                setStep('count')
              } else if (value === 'recover') {
                setStep('recover-purpose')
              } else if (value === 'stop') {
                void runOperation(stopGuests)
              } else if (value === 'chat') {
                setSentinelComposerMode(true)
                onComplete('Sentinel quedó seleccionado. Escribe tu mensaje normal en la barra de entrada; se enviará a Gemini, no a la instancia web.')
              } else if (value === 'model') {
                setStep('model')
              } else {
                onComplete('Consola de Sentinel cerrada.')
              }
            }}
            onCancel={() => onComplete('Consola de Sentinel cerrada.')}
          />
          <Text dimColor>↑/↓ para elegir · Enter para ejecutar · Esc para salir</Text>
        </Box>
      )}
    </Box>
  )
}
