import type { SentinelConversationSnapshot } from './orchestration/types.js'

const MAX_MESSAGES = 30
const MAX_MESSAGE_CHARACTERS = 2000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseRelayConversationSnapshot(
  agentId: string,
  value: unknown,
): SentinelConversationSnapshot {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new Error('Relay returned an invalid conversation snapshot.')
  }

  const messages: SentinelConversationSnapshot['messages'] = []
  for (const message of value.messages) {
    if (
      !isRecord(message) ||
      (message.role !== 'user' && message.role !== 'assistant') ||
      typeof message.text !== 'string' ||
      message.text.length > MAX_MESSAGE_CHARACTERS
    ) {
      throw new Error('Relay returned a malformed conversation message.')
    }
    const text = message.text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ')
    messages.push({ role: message.role, text })
  }
  if (messages.length > MAX_MESSAGES) {
    throw new Error('Relay returned more conversation messages than the snapshot limit.')
  }

  const capturedAt = value.capturedAt
  if (
    typeof capturedAt !== 'string' ||
    capturedAt.length > 64 ||
    !Number.isFinite(Date.parse(capturedAt))
  ) {
    throw new Error('Relay returned an invalid conversation snapshot timestamp.')
  }
  const pageVisibility = value.pageVisibility === 'visible' ||
      value.pageVisibility === 'hidden' ||
      value.pageVisibility === 'unknown'
    ? value.pageVisibility
    : undefined
  const pageHasFocus = typeof value.pageHasFocus === 'boolean' || value.pageHasFocus === null
    ? value.pageHasFocus
    : undefined

  return {
    agentId,
    available: true,
    messages,
    truncated: value.truncated === true,
    capturedAt,
    ...(pageVisibility ? { pageVisibility } : {}),
    ...(pageHasFocus !== undefined ? { pageHasFocus } : {}),
  }
}
