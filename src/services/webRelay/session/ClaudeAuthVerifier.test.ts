import { describe, expect, test } from 'bun:test'
import { classifyClaudeAuth } from './ClaudeAuthVerifier.js'

describe('ClaudeAuthVerifier', () => {
  test('requires a session cookie and rejects visible login UI', () => {
    expect(classifyClaudeAuth(false, {
      hasLoginElements: false,
      hasAccountIndicator: false,
      hasComposer: true,
    }).status).toBe('loginRequired')

    expect(classifyClaudeAuth(true, {
      hasLoginElements: true,
      hasAccountIndicator: false,
      hasComposer: false,
    }).status).toBe('loginRequired')
  })

  test('accepts account or composer evidence only with a session cookie', () => {
    expect(classifyClaudeAuth(true, {
      hasLoginElements: false,
      hasAccountIndicator: true,
      hasComposer: false,
    }).status).toBe('authenticated')
    expect(classifyClaudeAuth(true, {
      hasLoginElements: false,
      hasAccountIndicator: false,
      hasComposer: true,
    }).status).toBe('authenticated')
  })

  test('leaves a cookie-only page unknown while it renders', () => {
    expect(classifyClaudeAuth(true, {
      hasLoginElements: false,
      hasAccountIndicator: false,
      hasComposer: false,
    }).status).toBe('unknown')
  })
})
