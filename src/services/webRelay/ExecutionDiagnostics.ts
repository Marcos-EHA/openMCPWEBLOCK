export interface ExecutionDiagnosticEvent {
  timestamp: string
  event: string
  callId?: string
  toolName?: string
  success?: boolean
  executionIdPresent?: boolean
  executionKeyPresent?: boolean
  resultStatus?: string
  pageVisibility?: 'visible' | 'hidden' | 'unknown'
  pageHasFocus?: boolean | null
  buildMarker?: string
  targetSelectors?: string[]
  streamingContainerSelectors?: string[]
  monitoringEnabled?: boolean
  activeStreamIntervals?: number
  reason?: string
}

const TRACE_STORAGE_PREFIX = 'mcp:execution-diagnostic:v1:'
const RELEVANT_EVENT_PATTERN =
  /^(?:OBSERVER_MONITORING_STARTED|STREAM_MONITORING_STOPPED|JSONL_PARSER_OUTPUT|AUTO_EXECUTION_|START_EXECUTION_|GET_EXECUTION_|HANDLE_EMPTY$|EXECUTION_|RESULT_COMPLETION_|RESULT_DISPLAY$|RESULT_INSERTION_|AUTO_SUBMIT_|DELIVERY_)/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length <= 256 ? value : undefined
}

function optionalStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key]
  if (!Array.isArray(value) || value.length > 20) return undefined
  if (value.some(item => typeof item !== 'string' || item.length > 128)) return undefined
  return value as string[]
}

export function parseExecutionDiagnostics(
  storage: unknown,
  limit = 25,
): ExecutionDiagnosticEvent[] {
  if (!isRecord(storage)) return []
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('Execution diagnostic limit must be between 1 and 100.')
  }

  return Object.entries(storage)
    .filter(([key, value]) =>
      key.startsWith(TRACE_STORAGE_PREFIX) &&
      isRecord(value) &&
      typeof value.timestamp === 'string' &&
      value.timestamp.length <= 64 &&
      Number.isFinite(Date.parse(value.timestamp)) &&
      typeof value.event === 'string' &&
      RELEVANT_EVENT_PATTERN.test(value.event),
    )
    .map(([, value]) => {
      const record = value as Record<string, unknown>
      const pageVisibility = record.pageVisibility === 'visible' ||
          record.pageVisibility === 'hidden' ||
          record.pageVisibility === 'unknown'
        ? record.pageVisibility
        : undefined
      const event: ExecutionDiagnosticEvent = {
        timestamp: record.timestamp as string,
        event: (record.event as string).slice(0, 128),
      }
      const callId = optionalString(record, 'callId')
      const toolName = optionalString(record, 'toolName')
      const resultStatus = optionalString(record, 'resultStatus')
      const buildMarker = optionalString(record, 'buildMarker')
      const reason = optionalString(record, 'reason')
      const targetSelectors = optionalStringArray(record, 'targetSelectors')
      const streamingContainerSelectors = optionalStringArray(record, 'streamingContainerSelectors')
      if (callId !== undefined) event.callId = callId
      if (toolName !== undefined) event.toolName = toolName
      if (typeof record.success === 'boolean') event.success = record.success
      if (typeof record.executionIdPresent === 'boolean') {
        event.executionIdPresent = record.executionIdPresent
      }
      if (typeof record.executionKeyPresent === 'boolean') {
        event.executionKeyPresent = record.executionKeyPresent
      }
      if (resultStatus !== undefined) event.resultStatus = resultStatus
      if (pageVisibility !== undefined) event.pageVisibility = pageVisibility
      if (typeof record.pageHasFocus === 'boolean' || record.pageHasFocus === null) {
        event.pageHasFocus = record.pageHasFocus
      }
      if (buildMarker !== undefined) event.buildMarker = buildMarker
      if (reason !== undefined) event.reason = reason
      if (targetSelectors !== undefined) event.targetSelectors = targetSelectors
      if (streamingContainerSelectors !== undefined) {
        event.streamingContainerSelectors = streamingContainerSelectors
      }
      if (typeof record.monitoringEnabled === 'boolean') {
        event.monitoringEnabled = record.monitoringEnabled
      }
      if (typeof record.activeStreamIntervals === 'number' &&
          Number.isInteger(record.activeStreamIntervals) && record.activeStreamIntervals >= 0) {
        event.activeStreamIntervals = record.activeStreamIntervals
      }
      return event
    })
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .slice(-limit)
}
