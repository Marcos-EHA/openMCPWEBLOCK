import { describe, expect, test } from 'bun:test'
import type { AgentState } from './orchestration/types.js'
import {
  getMinimumRelayCount,
  isWebCoordinatorRole,
  resolveRelayLaunchCoordination,
  selectConfiguredReadyRelays,
  selectStartupReadyRelays,
} from './launchPolicy.js'

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: 'relay-1',
    platformId: 'chatgpt',
    status: 'ready',
    debugPort: 9222,
    sessionMode: 'authenticated',
    activeExecutions: 0,
    unknownExecutions: 0,
    createdAt: 1,
    ...overrides,
  }
}

describe('Web Relay launch policy', () => {
  test('recognizes the primary and numbered Web coordinator candidate roles', () => {
    expect(isWebCoordinatorRole('primary')).toBe(true)
    expect(isWebCoordinatorRole('orchestrator-2')).toBe(true)
    expect(isWebCoordinatorRole('worker-2')).toBe(false)
    expect(isWebCoordinatorRole(undefined)).toBe(false)
  })

  test('keeps ready instances matching their requested session mode', () => {
    const ready = makeAgent()
    const failed = makeAgent({ agentId: 'relay-2', status: 'error', debugPort: undefined })

    expect(selectStartupReadyRelays([ready, failed], [
      { agentId: 'relay-1', sessionMode: 'authenticated' },
      { agentId: 'relay-2', sessionMode: 'authenticated' },
    ])).toEqual([ready])
  })

  test('excludes instances without a port or with mismatched session metadata', () => {
    const noPort = makeAgent({ agentId: 'relay-2', debugPort: undefined })
    const wrongMode = makeAgent({ agentId: 'relay-3', sessionMode: 'clean' })

    expect(selectStartupReadyRelays([noPort, wrongMode], [
      { agentId: 'relay-2', sessionMode: 'authenticated' },
      { agentId: 'relay-3', sessionMode: 'authenticated' },
    ])).toEqual([])
  })

  test('requires a coordinator and worker only when launching a coordinator', () => {
    expect(getMinimumRelayCount('agent')).toBe(2)
    expect(getMinimumRelayCount('agent', false)).toBe(1)
    expect(getMinimumRelayCount('user')).toBe(1)
  })

  test('requires an API or Web orchestrator in Agent conversations', () => {
    expect(resolveRelayLaunchCoordination({
      purpose: 'agent',
      orchestratorBrain: 'api',
    })).toEqual({ coordinateTasks: true, launchCoordinator: false })

    expect(resolveRelayLaunchCoordination({
      purpose: 'agent',
      orchestratorBrain: 'web',
    })).toEqual({ coordinateTasks: true, launchCoordinator: true })

    expect(() => resolveRelayLaunchCoordination({
      purpose: 'agent',
      orchestratorBrain: 'api',
      coordinateTasks: false,
    })).toThrow('Agent mode always requires an orchestrator')

    expect(() => resolveRelayLaunchCoordination({
      purpose: 'agent',
      orchestratorBrain: 'web',
      launchCoordinator: false,
    })).toThrow('requires a dedicated Relay coordinator')
  })

  test('keeps User conversations manual and rejects coordinator requests', () => {
    expect(resolveRelayLaunchCoordination({
      purpose: 'user',
      orchestratorBrain: 'api',
    })).toEqual({ coordinateTasks: false, launchCoordinator: false })

    expect(() => resolveRelayLaunchCoordination({
      purpose: 'user',
      orchestratorBrain: 'web',
      coordinateTasks: true,
    })).toThrow('does not launch an orchestrator')
  })

  test('keeps manual and Sentinel guest instances outside the Workspace worker pool', () => {
    const configured = makeAgent({ agentId: 'configured', role: 'primary' })
    const manual = makeAgent({ agentId: 'manual', role: 'manual-user-1' })
    const sentinelGuest = makeAgent({
      agentId: 'sentinel-chatgpt-guest-1',
      role: 'sentinel-guest-1',
    })

    expect(selectConfiguredReadyRelays(
      [configured, manual, sentinelGuest],
      ['configured', 'manual', 'sentinel-chatgpt-guest-1'],
    )).toEqual([configured])
    expect(selectConfiguredReadyRelays([configured, manual], [])).toEqual([])
  })
})
