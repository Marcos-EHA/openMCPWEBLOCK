import { describe, expect, test } from 'bun:test'
import {
  createStartupHandshakePrompt,
  performStartupHandshake,
  validateStartupHandshakeResponse,
} from './StartupHandshake.js'

const target = {
  agentId: 'worker-1', instanceId: 'browser-1',
  platformId: 'chatgpt', role: 'worker-1',
}
const acknowledgement = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  type: 'workspace-startup-ack', handshakeId: 'attempt-1', ...target, ...overrides,
})

describe('Workspace startup handshake', () => {
  test('accepts a matching complete acknowledgement, including a JSON fence', () => {
    expect(() => validateStartupHandshakeResponse(acknowledgement(), target, 'attempt-1')).not.toThrow()
    expect(() => validateStartupHandshakeResponse('```json\n' + acknowledgement() + '\n```', target, 'attempt-1')).not.toThrow()
  })

  test('rejects responses from another attempt, agent, instance, platform or role', () => {
    for (const key of ['handshakeId', 'agentId', 'instanceId', 'platformId', 'role']) {
      expect(() => validateStartupHandshakeResponse(
        acknowledgement({ [key]: 'different' }), target, 'attempt-1',
      )).toThrow('does not match')
    }
  })

  test('rejects partial, explanatory and unexpected acknowledgement payloads', () => {
    for (const response of ['', '{', 'Ready', 'Explanation: ' + acknowledgement(), '[]', 'null',
      acknowledgement({ toolsVerified: true }), acknowledgement({ type: 'other' })]) {
      expect(() => validateStartupHandshakeResponse(response, target, 'attempt-1')).toThrow()
    }
    expect(() => validateStartupHandshakeResponse('x'.repeat(4097), target, 'attempt-1')).toThrow('limit')
  })

  test('provides distinct role instructions without claiming verified tool access', () => {
    const workerPrompt = createStartupHandshakePrompt(target, 'attempt-1')
    const coordinatorPrompt = createStartupHandshakePrompt({ ...target, role: 'primary' }, 'attempt-2')
    expect(workerPrompt).toContain('Tu rol es worker')
    expect(coordinatorPrompt).toContain('Tu rol es coordinar')
    expect(workerPrompt).toContain('no ejecutes herramientas')
    expect(coordinatorPrompt).toContain('no afirmes haberlas probado')
    expect(() => createStartupHandshakePrompt({ ...target, instanceId: '' }, 'attempt-1')).toThrow('instanceId')
  })

  test('records evidence only after a correlated response and uses a fresh attempt ID', async () => {
    const attempts: string[] = []
    const send = async (prompt: string) => {
      const expected = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2))
      attempts.push(expected.handshakeId)
      return JSON.stringify(expected)
    }
    const first = await performStartupHandshake(target, send)
    const second = await performStartupHandshake(target, send)
    expect(first).toMatchObject({ ...target, status: 'instructions-acknowledged' })
    expect(first.completedAt).toBeGreaterThanOrEqual(first.startedAt)
    expect(first.handshakeId).not.toBe(second.handshakeId)
    expect(attempts).toHaveLength(2)
  })

  test('propagates send failures without retrying', async () => {
    let sends = 0
    const failure = new Error('Completion unconfirmed')
    await expect(performStartupHandshake(target, async () => {
      sends++
      throw failure
    })).rejects.toBe(failure)
    expect(sends).toBe(1)
  })

  test('does not accept an old acknowledgement or retry after a mismatched response', async () => {
    let sends = 0
    await expect(performStartupHandshake(target, async () => {
      sends++
      return acknowledgement()
    })).rejects.toThrow('does not match')
    expect(sends).toBe(1)
  })
})
