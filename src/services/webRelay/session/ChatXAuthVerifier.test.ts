import { describe, expect, test } from 'bun:test'
import {
  classifyChatXAuth,
  hasActiveChatXAuthCookie,
} from './ChatXAuthVerifier.js'
import type { SessionCookieParam } from './SessionBroker.js'

describe('ChatX Master Session verification', () => {
  test('recognizes an active ChatX auth cookie only on the ChatX domain', () => {
    const cookie = (domain: string, name = 'session-token', expires?: number): SessionCookieParam => ({
      name,
      value: 'redacted-test-value',
      domain,
      path: '/',
      secure: true,
      httpOnly: true,
      expires,
    })

    expect(hasActiveChatXAuthCookie([cookie('.chatx.ai')])).toBe(true)
    expect(hasActiveChatXAuthCookie([cookie('chatx.ai.attacker.example')])).toBe(false)
    expect(hasActiveChatXAuthCookie([cookie('.chatx.ai', 'csrf-token')])).toBe(false)
    expect(hasActiveChatXAuthCookie([cookie('.chatx.ai', 'session-token', Math.floor(Date.now() / 1000) - 1)])).toBe(false)
  })

  test('requires an active ChatX page, no visible login UI, an auth cookie, and a composer', () => {
    const page = { isChatXPage: true, hasLoginElements: false, hasComposer: true }

    expect(classifyChatXAuth(true, page, 3)).toMatchObject({
      status: 'authenticated',
      hasValidSession: true,
      cookieCount: 3,
    })
    expect(classifyChatXAuth(false, page).status).toBe('unverified')
    expect(classifyChatXAuth(true, { ...page, hasLoginElements: true }).status).toBe('loginRequired')
    expect(classifyChatXAuth(true, { ...page, hasComposer: false }).status).toBe('unverified')
    expect(classifyChatXAuth(true, { ...page, isChatXPage: false }).status).toBe('unverified')
  })
})
