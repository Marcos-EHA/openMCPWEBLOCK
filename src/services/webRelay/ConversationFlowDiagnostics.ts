import type { ConversationFlowSurface } from './ChromeCDP.js'
import type { ExecutionDiagnosticEvent } from './ExecutionDiagnostics.js'

export interface ConversationFlowSummary {
  observer: {
    status: 'active' | 'stopped' | 'unknown'
    targetSelectors: string[] | null
    streamingContainerSelectors: string[] | null
    lastTransitionAt: string | null
  }
  surface: ConversationFlowSurface
  recentExecutionEvents: Array<{
    timestamp: string
    event: string
    callId?: string
    toolName?: string
    success?: boolean
    executionIdPresent?: boolean
    executionKeyPresent?: boolean
    resultStatus?: string
    reason?: string
  }>
  latestParsedCall: {
    timestamp: string
    callId?: string
    toolName?: string
    stages: string[]
  } | null
}

export interface ConversationFlowDiagnostic {
  severity: 'error' | 'warning'
  code: string
  message: string
}

const CALL_STAGE_PATTERN = /^(?:JSONL_PARSER_OUTPUT|AUTO_EXECUTION_|START_EXECUTION_|GET_EXECUTION_|HANDLE_EMPTY$)/u

export function summarizeConversationFlow(
  surface: ConversationFlowSurface,
  events: ExecutionDiagnosticEvent[],
  autoExecuteEnabled: boolean | null,
  now = Date.now(),
): { summary: ConversationFlowSummary; diagnostics: ConversationFlowDiagnostic[] } {
  const transitions = events.filter(event =>
    event.event === 'OBSERVER_MONITORING_STARTED' || event.event === 'STREAM_MONITORING_STOPPED',
  )
  const lastTransition = transitions.at(-1)
  const observerStatus = lastTransition?.event === 'OBSERVER_MONITORING_STARTED' &&
      lastTransition.monitoringEnabled === true
    ? 'active'
    : lastTransition?.event === 'STREAM_MONITORING_STOPPED'
      ? 'stopped'
      : 'unknown'
  const latestParsed = [...events].reverse().find(event => event.event === 'JSONL_PARSER_OUTPUT')
  const callEvents = latestParsed?.callId
    ? events.filter(event => event.callId === latestParsed.callId && CALL_STAGE_PATTERN.test(event.event))
    : []
  const latestParsedCall = latestParsed
    ? {
        timestamp: latestParsed.timestamp,
        ...(latestParsed.callId ? { callId: latestParsed.callId } : {}),
        ...(latestParsed.toolName ? { toolName: latestParsed.toolName } : {}),
        stages: callEvents.map(event => event.event),
      }
    : null

  const summary: ConversationFlowSummary = {
    observer: {
      status: observerStatus,
      targetSelectors: lastTransition?.event === 'OBSERVER_MONITORING_STARTED'
        ? lastTransition.targetSelectors ?? null
        : null,
      streamingContainerSelectors: lastTransition?.event === 'OBSERVER_MONITORING_STARTED'
        ? lastTransition.streamingContainerSelectors ?? null
        : null,
      lastTransitionAt: lastTransition?.timestamp ?? null,
    },
    surface,
    recentExecutionEvents: events.slice(-30).map(event => ({
      timestamp: event.timestamp,
      event: event.event,
      ...(event.callId ? { callId: event.callId } : {}),
      ...(event.toolName ? { toolName: event.toolName } : {}),
      ...(event.success !== undefined ? { success: event.success } : {}),
      ...(event.executionIdPresent !== undefined ? { executionIdPresent: event.executionIdPresent } : {}),
      ...(event.executionKeyPresent !== undefined ? { executionKeyPresent: event.executionKeyPresent } : {}),
      ...(event.resultStatus ? { resultStatus: event.resultStatus } : {}),
      ...(event.reason ? { reason: event.reason } : {}),
    })),
    latestParsedCall,
  }
  const diagnostics: ConversationFlowDiagnostic[] = []

  if (surface.available && (surface.completeFunctionCallCandidateCount ?? 0) > 0) {
    if ((surface.unrenderedFunctionCallCount ?? 0) > 0) {
      diagnostics.push({
        severity: 'error',
        code: 'conversation-call-not-rendered',
        message: 'A complete tool-call block is present in the visible page DOM but has no SuperAssistant execution block.',
      })
    }
    const hasCodeCandidate = surface.candidateTags?.includes('CODE') === true
    const observedCode = summary.observer.targetSelectors?.some(selector =>
      /(^|[\s,>])code(?:$|[\s,.[#:])/iu.test(selector),
    ) === true
    if (hasCodeCandidate && summary.observer.status === 'active' && !observedCode) {
      diagnostics.push({
        severity: 'error',
        code: 'conversation-observer-selector-mismatch',
        message: 'A complete tool-call block is rendered in a code element that the active SuperAssistant observer does not target.',
      })
    }
    if (summary.observer.status === 'unknown') {
      diagnostics.push({
        severity: 'warning',
        code: 'conversation-observer-unverified',
        message: 'A tool-call block is visible, but this extension has not reported whether its response observer is active.',
      })
    } else if (summary.observer.status === 'stopped') {
      diagnostics.push({
        severity: 'error',
        code: 'conversation-observer-stopped',
        message: 'A tool-call block is visible while the SuperAssistant response observer is stopped.',
      })
    }
  }

  if (latestParsedCall) {
    const ageMs = now - Date.parse(latestParsedCall.timestamp)
    const hasExecutionStart = latestParsedCall.stages.some(stage => stage.startsWith('START_EXECUTION_'))
    const hasAutoExecutionSkip = callEvents.some(event =>
      event.event === 'AUTO_EXECUTION_SKIPPED' &&
      (event.reason === 'disabled_by_settings' || event.reason === 'already_executed'),
    )
    if (ageMs >= 10_000 && autoExecuteEnabled === true &&
        !hasExecutionStart && !hasAutoExecutionSkip) {
      diagnostics.push({
        severity: 'error',
        code: 'conversation-call-not-dispatched',
        message: `SuperAssistant parsed tool call${latestParsedCall.toolName ? ` "${latestParsedCall.toolName}"` : ''}, but no MCP execution start was recorded.`,
      })
    }
  }

  return { summary, diagnostics }
}
