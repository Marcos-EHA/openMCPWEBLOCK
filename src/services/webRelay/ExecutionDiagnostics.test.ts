import { describe, expect, test } from 'bun:test'
import { parseExecutionDiagnostics } from './ExecutionDiagnostics.js'

const prefix = 'mcp:execution-diagnostic:v1:'

describe('parseExecutionDiagnostics', () => {
  test('returns ordered allow-listed metadata and excludes conversation content', () => {
    const result = parseExecutionDiagnostics({
      [`${prefix}later`]: {
        timestamp: '2026-10-08T12:00:02.000Z',
        event: 'EXECUTION_COMPLETION',
        callId: 'call-2',
        toolName: 'Read',
        success: true,
        userMessage: 'private prompt',
        responseText: 'private response',
        command: 'private command',
      },
      [`${prefix}earlier`]: {
        timestamp: '2026-10-08T12:00:01.000Z',
        event: 'START_EXECUTION_REQUEST',
        executionIdPresent: true,
        pageVisibility: 'hidden',
        pageHasFocus: false,
      },
      'other-extension-key': {
        timestamp: '2026-10-08T12:00:00.000Z',
        event: 'MUST_NOT_APPEAR',
      },
      [`${prefix}invalid-time`]: {
        timestamp: 'not-a-time',
        event: 'MUST_NOT_APPEAR',
      },
      [`${prefix}monitor`]: {
        timestamp: '2026-10-08T12:00:03.000Z',
        event: 'OBSERVER_MONITORING_STARTED',
        targetSelectors: ['pre', 'code'],
        streamingContainerSelectors: ['pre', 'code'],
        monitoringEnabled: true,
        responseText: 'must not appear',
      },
      [`${prefix}stream-noise`]: {
        timestamp: '2026-10-08T12:00:04.000Z',
        event: 'STREAM_INTERVAL_CREATED',
        nodeId: 'private-node-id',
      },
    })

    expect(result).toEqual([
      {
        timestamp: '2026-10-08T12:00:01.000Z',
        event: 'START_EXECUTION_REQUEST',
        executionIdPresent: true,
        pageVisibility: 'hidden',
        pageHasFocus: false,
      },
      {
        timestamp: '2026-10-08T12:00:02.000Z',
        event: 'EXECUTION_COMPLETION',
        callId: 'call-2',
        toolName: 'Read',
        success: true,
      },
      {
        timestamp: '2026-10-08T12:00:03.000Z',
        event: 'OBSERVER_MONITORING_STARTED',
        targetSelectors: ['pre', 'code'],
        streamingContainerSelectors: ['pre', 'code'],
        monitoringEnabled: true,
      },
    ])
  })

  test('rejects out-of-range event limits explicitly', () => {
    expect(() => parseExecutionDiagnostics({}, 0)).toThrow(
      'Execution diagnostic limit must be between 1 and 100.',
    )
  })
})
