import { describe, expect, mock, test } from 'bun:test'
import { createMasterSessionConversation } from './MasterSessionConversation.js'

const source = {
  id: 'test-master',
  name: 'Test Master',
  profileDir: 'master-session-test',
  debugPort: 9400,
  platformId: 'claude' as const,
}

function makeConversation(overrides: {
  port?: number | null
  authenticated?: boolean
} = {}) {
  const getMasterSessionSource = mock(() => source)
  const findActiveMasterPort = mock(async () => overrides.port === undefined ? source.debugPort : overrides.port)
  const getMasterSessionStatus = mock(async () => ({
    hasValidSession: overrides.authenticated ?? true,
  }))
  const sendPrompt = mock(async () => 'response')
  const send = createMasterSessionConversation({
    findActiveMasterPort,
    getMasterSessionSource,
    getMasterSessionStatus,
    sendPrompt,
  })
  return { send, findActiveMasterPort, getMasterSessionStatus, sendPrompt }
}

describe('MasterSessionConversation', () => {
  test('routes an authenticated direct message to its selected Master without Relay fallback', async () => {
    const { send, sendPrompt } = makeConversation()
    expect(await send(source.id, '  hola  ')).toBe('response')
    expect(sendPrompt).toHaveBeenCalledWith('hola', source.platformId, source.id, source.debugPort)
  })

  test('explains how to open an inactive Master without silently starting or navigating it', async () => {
    const { send, sendPrompt } = makeConversation({ port: null })
    await expect(send(source.id, 'hola')).rejects.toThrow(
      'Open it with /mcp master-session open test-master',
    )
    expect(sendPrompt).not.toHaveBeenCalled()
  })

  test('does not send to a Master without an authenticated platform session', async () => {
    const { send, sendPrompt } = makeConversation({ authenticated: false })
    await expect(send(source.id, 'hola')).rejects.toThrow('is not authenticated')
    expect(sendPrompt).not.toHaveBeenCalled()
  })

  test('rejects empty messages before querying the selected Master', async () => {
    const { send, findActiveMasterPort } = makeConversation()
    await expect(send(source.id, '  ')).rejects.toThrow('A non-empty prompt is required')
    expect(findActiveMasterPort).not.toHaveBeenCalled()
  })
})
