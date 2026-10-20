import { describe, expect, test } from 'bun:test'
import type { AgentState } from './orchestration/types.js'
import { isRoutableWebRelayAgent } from './isRoutableWebRelayAgent.js'

function agent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: 'web-agent',
    platformId: 'chatgpt',
    role: 'worker-2',
    sessionMode: 'clean',
    instanceId: 'instance-1',
    status: 'ready',
    activeExecutions: 0,
    unknownExecutions: 0,
    createdAt: 1,
    ...overrides,
  }
}

describe('isRoutableWebRelayAgent', () => {
  test('accepts explicitly configured clean and authenticated agent sessions', () => {
    expect(isRoutableWebRelayAgent(agent())).toBe(true)
    expect(isRoutableWebRelayAgent(agent({ sessionMode: 'authenticated' }))).toBe(true)
  })

  test('excludes unready, unbound, unclassified, and manual-user windows', () => {
    expect(isRoutableWebRelayAgent(agent({ status: 'starting' }))).toBe(false)
    expect(isRoutableWebRelayAgent(agent({ instanceId: undefined }))).toBe(false)
    expect(isRoutableWebRelayAgent(agent({ sessionMode: undefined }))).toBe(false)
    expect(isRoutableWebRelayAgent(agent({ role: 'manual-user-1' }))).toBe(false)
  })

  test('can restrict routing to a platform', () => {
    expect(isRoutableWebRelayAgent(agent(), 'chatgpt')).toBe(true)
    expect(isRoutableWebRelayAgent(agent(), 'claude')).toBe(false)
  })
})
