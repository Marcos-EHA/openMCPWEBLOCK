import { describe, expect, test } from 'bun:test'
import type { SessionCookieParam } from './SessionBroker.js'
import { classifyZaiAuth, hasActiveZaiAuthCookie } from './ZaiAuthVerifier.js'

const activeCookie = (overrides: Partial<SessionCookieParam> = {}): SessionCookieParam => ({
  name: 'access_token',
  value: 'redacted-test-value',
  domain: '.chat.z.ai',
  path: '/',
  secure: true,
  httpOnly: true,
  ...overrides,
})

describe('Z.ai authentication verification', () => {
  test('recognizes an active non-CSRF auth cookie scoped to Z.ai', () => {
    expect(hasActiveZaiAuthCookie([activeCookie()])).toBe(true)
  })

  test('rejects CSRF, expired, empty, and unrelated-domain cookies', () => {
    expect(hasActiveZaiAuthCookie([activeCookie({ name: 'csrf-token' })])).toBe(false)
    expect(hasActiveZaiAuthCookie([activeCookie({ expires: Date.now() / 1000 - 60 })])).toBe(false)
    expect(hasActiveZaiAuthCookie([activeCookie({ value: '' })])).toBe(false)
    expect(hasActiveZaiAuthCookie([activeCookie({ domain: 'attacker.example' })])).toBe(false)
  })

  test('requires the Z.ai page and chat composer in addition to an auth cookie', () => {
    expect(classifyZaiAuth(true, {
      isZaiPage: true,
      hasLoginElements: false,
      hasComposer: true,
    }).status).toBe('authenticated')
    expect(classifyZaiAuth(true, {
      isZaiPage: true,
      hasLoginElements: false,
      hasComposer: false,
    }).status).toBe('unverified')
    expect(classifyZaiAuth(true, {
      isZaiPage: false,
      hasLoginElements: false,
      hasComposer: true,
    }).status).toBe('unverified')
  })

  test('reports login-required only when sign-in controls are visible', () => {
    const result = classifyZaiAuth(false, {
      isZaiPage: true,
      hasLoginElements: true,
      hasComposer: false,
    })
    expect(result.status).toBe('loginRequired')
    expect(result.hasValidSession).toBe(false)
  })
})
