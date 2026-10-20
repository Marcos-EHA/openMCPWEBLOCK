import { describe, expect, it } from 'vitest'
import { parseRelayConversationSnapshot } from './RelayConversationSnapshot.js'

describe('parseRelayConversationSnapshot', () => {
  it('accepts bounded user and assistant messages with page state', () => {
    expect(parseRelayConversationSnapshot('relay-1', {
      messages: [{ role: 'user', text: 'Question' }, { role: 'assistant', text: 'Answer' }],
      truncated: false,
      capturedAt: '2026-10-08T12:00:00.000Z',
      pageVisibility: 'visible',
      pageHasFocus: true,
    })).toEqual({
      agentId: 'relay-1',
      available: true,
      messages: [{ role: 'user', text: 'Question' }, { role: 'assistant', text: 'Answer' }],
      truncated: false,
      capturedAt: '2026-10-08T12:00:00.000Z',
      pageVisibility: 'visible',
      pageHasFocus: true,
    })
  })

  it('rejects missing, ambiguous, or malformed snapshots', () => {
    expect(() => parseRelayConversationSnapshot('relay-1', null)).toThrow(/invalid conversation snapshot/i)
    expect(() => parseRelayConversationSnapshot('relay-1', { messages: [{}] })).toThrow(/malformed conversation message/i)
    expect(() => parseRelayConversationSnapshot('relay-1', {
      messages: [{ role: 'system', text: 'not allowed' }],
      capturedAt: '2026-10-08T12:00:00.000Z',
    })).toThrow(/malformed conversation message/i)
  })

  it('enforces message and character limits', () => {
    expect(() => parseRelayConversationSnapshot('relay-1', {
      messages: Array.from({ length: 31 }, () => ({ role: 'user', text: 'x' })),
      capturedAt: '2026-10-08T12:00:00.000Z',
    })).toThrow(/more conversation messages/i)
    expect(() => parseRelayConversationSnapshot('relay-1', {
      messages: [{ role: 'assistant', text: 'x'.repeat(2001) }],
      capturedAt: '2026-10-08T12:00:00.000Z',
    })).toThrow(/malformed conversation message/i)
  })

  it('removes terminal control characters from rendered message text', () => {
    const snapshot = parseRelayConversationSnapshot('relay-1', {
      messages: [{ role: 'assistant', text: 'before\u001b[31mafter\u0007' }],
      capturedAt: '2026-10-08T12:00:00.000Z',
    })
    expect(snapshot.messages[0]?.text).toBe('before [31mafter ')
  })
})
