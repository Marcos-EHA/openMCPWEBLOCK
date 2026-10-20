import { describe, expect, test } from 'bun:test'
import { summarizeConversationFlow } from './ConversationFlowDiagnostics.js'
import type { ConversationFlowSurface } from './ChromeCDP.js'
import type { ExecutionDiagnosticEvent } from './ExecutionDiagnostics.js'

const surface: ConversationFlowSurface = {
  available: true,
  platformTabCount: 1,
  preElementCount: 0,
  codeElementCount: 4,
  completeFunctionCallCandidateCount: 1,
  renderedFunctionCallCount: 0,
  executableFunctionCallCount: 0,
  unrenderedFunctionCallCount: 1,
  candidateTags: ['CODE'],
}

describe('summarizeConversationFlow', () => {
  test('detects a complete code-block call missed by the active observer selectors', () => {
    const result = summarizeConversationFlow(surface, [{
      timestamp: '2026-10-13T08:00:00.000Z',
      event: 'OBSERVER_MONITORING_STARTED',
      monitoringEnabled: true,
      targetSelectors: ['pre'],
      streamingContainerSelectors: ['pre'],
    }], true)

    expect(result.diagnostics.map(item => item.code)).toEqual([
      'conversation-call-not-rendered',
      'conversation-observer-selector-mismatch',
    ])
    expect(result.summary.observer).toMatchObject({
      status: 'active',
      targetSelectors: ['pre'],
    })
    expect(JSON.stringify(result)).not.toContain('command')
  })

  test('does not report a selector mismatch after code nodes are included', () => {
    const result = summarizeConversationFlow(surface, [{
      timestamp: '2026-10-13T08:00:00.000Z',
      event: 'OBSERVER_MONITORING_STARTED',
      monitoringEnabled: true,
      targetSelectors: ['pre', 'code'],
      streamingContainerSelectors: ['pre', 'code'],
    }], true)

    expect(result.diagnostics.map(item => item.code)).toEqual([
      'conversation-call-not-rendered',
    ])
  })

  test('identifies a parsed call that did not reach MCP execution', () => {
    const events: ExecutionDiagnosticEvent[] = [{
      timestamp: '2026-10-13T08:00:00.000Z',
      event: 'JSONL_PARSER_OUTPUT',
      callId: 'call-1',
      toolName: 'ListDir',
    }]
    const result = summarizeConversationFlow({
      available: true,
      platformTabCount: 1,
      completeFunctionCallCandidateCount: 0,
    }, events, true, Date.parse('2026-10-13T08:00:11.000Z'))

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'conversation-call-not-dispatched',
    }))
    expect(result.summary.latestParsedCall).toMatchObject({
      callId: 'call-1',
      toolName: 'ListDir',
      stages: ['JSONL_PARSER_OUTPUT'],
    })
  })
})
