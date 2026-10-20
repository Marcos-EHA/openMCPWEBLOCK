/**
 * SessionBroker.test.ts
 *
 * Mandatory unit tests for clean relay profile, SessionBroker, ChatGPTAuthVerifier,
 * lifecycle gates, and isolation invariants.
 *
 * Run: bun test src/services/webRelay/session/SessionBroker.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  buildMasterSessionLaunchArgs,
  classifyCookies,
  classifyCookiesForPlatform,
  chromeCommandLineMatchesProfile,
  getListeningPid,
  isAllowedDomain,
  isAllowedDomainForPlatform,
  getMasterProfileDir,
  hasRestorableMasterPage,
  type SessionCookieParam,
} from './SessionBroker.js'
import type { MasterSessionSource } from './MasterSessionRegistry.js'
import {
  classifyAuth,
  type DomInspectionResult,
} from './ChatGPTAuthVerifier.js'
import {
  createWebInstance,
  getWebInstance,
  releaseWebInstance,
  resetWebInstanceRegistry,
} from '../WebInstanceRegistry.js'
import {
  createAgent,
  startAgent,
  stopAgent,
  getAgent,
  onLifecycleEvent,
} from '../orchestration/MultiAgentRunner.js'

describe('A. Relay Limpio (No personal profile artifacts copied)', () => {
  const testRelayDir = path.join(os.tmpdir(), 'openmcp-test-clean-relay-' + Date.now())

  beforeEach(() => {
    fs.mkdirSync(path.join(testRelayDir, 'Default'), { recursive: true })
  })

  afterEach(() => {
    try {
      fs.rmSync(testRelayDir, { recursive: true, force: true })
    } catch {}
  })

  test('relay profile directory contains no personal Chrome artifacts', () => {
    const forbidden = [
      'Preferences',
      'Secure Preferences',
      'Login Data',
      'Web Data',
      'Local State',
      'History',
      'Cookies',
    ]

    const defaultDir = path.join(testRelayDir, 'Default')
    for (const file of forbidden) {
      expect(fs.existsSync(path.join(defaultDir, file))).toBe(false)
      expect(fs.existsSync(path.join(testRelayDir, file))).toBe(false)
    }
  })
})

describe('B. SessionBroker Cookie Filtering & Classification', () => {
  test('finds the PID for the requested CDP port in netstat output', () => {
    const output = [
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    127.0.0.1:9227         0.0.0.0:0              LISTENING       30308',
      '  TCP    [::1]:9400            [::]:0                 LISTENING       9912',
      '  TCP    127.0.0.1:19455       0.0.0.0:0              LISTENING       7012',
    ].join('\r\n')
    expect(getListeningPid(output, 9227)).toBe('30308')
    expect(getListeningPid(output, 9400)).toBe('9912')
    expect(getListeningPid(output, 9455)).toBeNull()
    expect(getListeningPid(output, 19455)).toBe('7012')
    expect(getListeningPid(output, 9228)).toBeNull()
  })

  test('accepts multiple listening addresses owned by one PID and rejects ambiguous ports', () => {
    const oneOwner = [
      '  TCP    127.0.0.1:9455         0.0.0.0:0              LISTENING       30308',
      '  TCP    [::1]:9455             [::]:0                 LISTENING       30308',
    ].join('\r\n')
    const multipleOwners = [
      oneOwner,
      '  TCP    0.0.0.0:9455           0.0.0.0:0              LISTENING       9912',
    ].join('\r\n')
    expect(getListeningPid(oneOwner, 9455)).toBe('30308')
    expect(getListeningPid(multipleOwners, 9455)).toBeNull()
  })

  test('validates that a Master Session CDP port belongs to its registered profile', () => {
    const expectedProfile = 'C:\\Users\\test\\AppData\\Local\\openMCPWEBLOCK\\master-session'
    expect(chromeCommandLineMatchesProfile(
      '"C:\\Program Files\\Google\\Chrome\\chrome.exe" --remote-debugging-port=9227 ' +
      '--user-data-dir="C:\\Users\\test\\AppData\\Local\\openMCPWEBLOCK\\master-session"',
      expectedProfile,
      9227,
    )).toBe(true)
    expect(chromeCommandLineMatchesProfile(
      'chrome.exe --remote-debugging-port=9227 ' +
      '--user-data-dir=C:\\Users\\test\\AppData\\Local\\openMCPWEBLOCK\\master-session-other',
      expectedProfile,
      9227,
    )).toBe(false)
    expect(chromeCommandLineMatchesProfile(
      'chrome.exe --remote-debugging-port=9228 ' +
      '--user-data-dir=C:\\Users\\test\\AppData\\Local\\openMCPWEBLOCK\\master-session',
      expectedProfile,
      9227,
    )).toBe(false)
  })

  test('domain filter strictly permits only OpenAI / ChatGPT domains', () => {
    expect(isAllowedDomain('chatgpt.com')).toBe(true)
    expect(isAllowedDomain('.chatgpt.com')).toBe(true)
    expect(isAllowedDomain('auth.openai.com')).toBe(true)
    expect(isAllowedDomain('.openai.com')).toBe(true)
    expect(isAllowedDomain('oaistatic.com')).toBe(true)
    expect(isAllowedDomain('.oaiusercontent.com')).toBe(true)

    // Rejects third-party tracking / unrelated domains
    expect(isAllowedDomain('google.com')).toBe(false)
    expect(isAllowedDomain('doubleclick.net')).toBe(false)
    expect(isAllowedDomain('facebook.com')).toBe(false)
    expect(isAllowedDomain('malicious-chatgpt.com')).toBe(false)
  })

  test('Claude session classification is isolated to the Claude domain and sessionKey cookie', () => {
    expect(isAllowedDomainForPlatform('.claude.ai', 'claude')).toBe(true)
    expect(isAllowedDomainForPlatform('anthropic.com', 'claude')).toBe(false)
    expect(isAllowedDomainForPlatform('chatgpt.com', 'claude')).toBe(false)
    expect(isAllowedDomainForPlatform('claude.ai.attacker.example', 'claude')).toBe(false)

    const cookies: SessionCookieParam[] = [
      {
        name: 'sessionKey',
        value: 'redacted-test-value',
        domain: '.claude.ai',
        path: '/',
        secure: true,
        httpOnly: true,
        expires: Math.floor(Date.now() / 1000) + 3600,
      },
      {
        name: 'sessionKey',
        value: 'untrusted-domain-value',
        domain: 'attacker.example',
        path: '/',
        secure: true,
        httpOnly: true,
      },
      {
        name: '__Secure-next-auth.session-token',
        value: 'openai-token',
        domain: '.chatgpt.com',
        path: '/',
        secure: true,
        httpOnly: true,
      },
    ]
    const classification = classifyCookiesForPlatform(cookies, 'claude')
    expect(classification.hasValidSession).toBe(true)
    expect(classification.sessionCookies.map(cookie => cookie.domain)).toEqual(['.claude.ai'])
    expect(classifyCookiesForPlatform(cookies.slice(1), 'claude').hasValidSession).toBe(false)
  })

  test('Z.ai cookie-domain filtering stays isolated; authentication uses its dedicated verifier', () => {
    expect(isAllowedDomainForPlatform('.chat.z.ai', 'zai')).toBe(true)
    expect(isAllowedDomainForPlatform('z.ai.attacker.example', 'zai')).toBe(false)
    expect(isAllowedDomainForPlatform('chatgpt.com', 'zai')).toBe(false)

    const cookies: SessionCookieParam[] = [{
      name: 'session',
      value: 'redacted-test-value',
      domain: '.chat.z.ai',
      path: '/',
      secure: true,
      httpOnly: true,
    }]
    const classification = classifyCookiesForPlatform(cookies, 'zai')
    expect(classification.hasValidSession).toBe(false)
    expect(classification.sessionCookies).toHaveLength(0)
  })

  test('ChatX Master Session cookies stay restricted to ChatX and launch its GPT page', () => {
    expect(isAllowedDomainForPlatform('.chatx.ai', 'chatx')).toBe(true)
    expect(isAllowedDomainForPlatform('chatx.ai.attacker.example', 'chatx')).toBe(false)
    expect(isAllowedDomainForPlatform('chatgpt.com', 'chatx')).toBe(false)

    const source: MasterSessionSource = {
      id: 'chatx-master',
      name: 'ChatX Master',
      profileDir: 'master-sessions/chatx-master',
      debugPort: 9400,
      platformId: 'chatx',
    }
    expect(buildMasterSessionLaunchArgs(source, 'C:\\test\\chatx-master')).toContain('https://chatx.ai/es/gpt')
  })

  test('distinguishes CSRF vs genuine session-token and rejects CSRF alone', () => {
    const csrfOnlyCookies: SessionCookieParam[] = [
      {
        name: '__Host-next-auth.csrf-token',
        value: 'csrf-secret-12345|some-hash',
        domain: 'chatgpt.com',
        path: '/',
        secure: true,
        httpOnly: true,
      },
    ]

    const classification = classifyCookies(csrfOnlyCookies)
    expect(classification.csrfCookies).toHaveLength(1)
    expect(classification.sessionCookies).toHaveLength(0)
    expect(classification.hasValidSession).toBe(false) // CSRF alone is NEVER authenticated
  })

  test('accepts valid session-token cookie with non-expired timestamp', () => {
    const validCookies: SessionCookieParam[] = [
      {
        name: '__Host-next-auth.csrf-token',
        value: 'csrf-val',
        domain: 'chatgpt.com',
        path: '/',
        secure: true,
        httpOnly: true,
      },
      {
        name: '__Secure-next-auth.session-token',
        value: 'session-jwt-token-xyz',
        domain: '.chatgpt.com',
        path: '/',
        secure: true,
        httpOnly: true,
        expires: Math.floor(Date.now() / 1000) + 86400, // 24 hours in the future
      },
    ]

    const classification = classifyCookies(validCookies)
    expect(classification.csrfCookies).toHaveLength(1)
    expect(classification.sessionCookies).toHaveLength(1)
    expect(classification.hasValidSession).toBe(true)
  })

  test('detects expired session token as invalid session', () => {
    const expiredCookies: SessionCookieParam[] = [
      {
        name: '__Secure-next-auth.session-token',
        value: 'expired-jwt-token',
        domain: '.chatgpt.com',
        path: '/',
        secure: true,
        httpOnly: true,
        expires: Math.floor(Date.now() / 1000) - 3600, // 1 hour in the past
      },
    ]

    const classification = classifyCookies(expiredCookies)
    expect(classification.sessionCookies).toHaveLength(1)
    expect(classification.hasValidSession).toBe(false) // Expired!
  })
})

describe('Master Session workspace restoration', () => {
  const source: MasterSessionSource = {
    id: 'test-master',
    name: 'Test Master',
    profileDir: 'master-sessions/test-master',
    debugPort: 9400,
    platformId: 'chatgpt',
  }

  test('launches into the previous Chrome session only when explicitly requested', () => {
    const freshArgs = buildMasterSessionLaunchArgs(source, 'C:\\test\\master')
    const restoreArgs = buildMasterSessionLaunchArgs(source, 'C:\\test\\master', true)

    expect(freshArgs).toContain('--new-window')
    expect(freshArgs).toContain('https://chatgpt.com/')
    expect(freshArgs).not.toContain('--restore-last-session')
    expect(restoreArgs).toContain('--restore-last-session')
    expect(restoreArgs).not.toContain('--new-window')
    expect(restoreArgs).not.toContain('https://chatgpt.com/')
  })

  test('recognizes an existing page for the selected Master platform', async () => {
    const fakeChrome = Bun.serve({
      port: 0,
      fetch: () => Response.json([
        { type: 'page', url: 'https://chatgpt.com/c/previous-conversation' },
        { type: 'page', url: 'https://example.com/' },
      ]),
    })
    const debugPort = fakeChrome.port
    if (debugPort === undefined) throw new Error('Fake Chrome server did not acquire a port.')
    try {
      expect(await hasRestorableMasterPage(debugPort, 'chatgpt')).toBe(true)
      expect(await hasRestorableMasterPage(debugPort, 'claude')).toBe(false)
    } finally {
      fakeChrome.stop()
    }
  })
})

describe('D. ChatGPTAuthVerifier Multi-layer Classification', () => {
  const baseDom: DomInspectionResult = {
    hasLoginElements: false,
    hasAccountIndicator: false,
    hasComposer: false,
    hasPlusBtn: false,
    url: 'https://chatgpt.com/',
    title: 'ChatGPT',
  }

  test('Layer A failure: returns loginRequired when no session cookie exists', () => {
    const dom = { ...baseDom, hasComposer: true }
    const result = classifyAuth(false, dom)
    expect(result.status).toBe('loginRequired')
    expect(result.hasSessionCookie).toBe(false)
  })

  test('Layer B failure: returns loginRequired when login button is visible even if cookie exists', () => {
    const dom: DomInspectionResult = {
      ...baseDom,
      hasLoginElements: true,
      loginDetail: 'button[data-testid="login-button"]',
      hasComposer: false,
    }
    const result = classifyAuth(true, dom)
    expect(result.status).toBe('loginRequired')
    expect(result.hasLoginElements).toBe(true)
  })

  test('Layer C success: returns authenticated when session cookie exists and account indicator is visible', () => {
    const dom: DomInspectionResult = {
      ...baseDom,
      hasLoginElements: false,
      hasAccountIndicator: true,
      accountDetail: '[data-testid="profile-button"]',
      hasComposer: true,
      hasPlusBtn: true,
    }
    const result = classifyAuth(true, dom)
    expect(result.status).toBe('authenticated')
    expect(result.hasAccountIndicator).toBe(true)
  })

  test('Layer C success without plus button: authenticated composer without login elements passes', () => {
    const dom: DomInspectionResult = {
      ...baseDom,
      hasLoginElements: false,
      hasAccountIndicator: false,
      hasComposer: true,
      hasPlusBtn: false, // Plus button missing or delayed in A/B test
    }
    const result = classifyAuth(true, dom)
    expect(result.status).toBe('authenticated')
  })

  test('Layer D unknown: returns unknown when page is still loading with no indicators', () => {
    const dom: DomInspectionResult = {
      ...baseDom,
      hasLoginElements: false,
      hasAccountIndicator: false,
      hasComposer: false,
      hasPlusBtn: false,
    }
    const result = classifyAuth(true, dom)
    expect(result.status).toBe('unknown')
  })
})

describe('G. Profile & Storage Isolation', () => {
  beforeEach(() => {
    resetWebInstanceRegistry()
  })

  afterEach(() => {
    resetWebInstanceRegistry()
  })

  test('master-session and agent relays use strictly separated directory trees', () => {
    const masterDir = getMasterProfileDir()
    const instA = createWebInstance('chatgpt', 'agent-a')
    const instB = createWebInstance('chatgpt', 'agent-b')

    expect(masterDir).toContain('master-session')
    expect(instA.profileDir).not.toBe(masterDir)
    expect(instB.profileDir).not.toBe(masterDir)
    expect(instA.profileDir).not.toBe(instB.profileDir)

    expect(instA.profileDir).toContain(instA.instanceId)
    expect(instB.profileDir).toContain(instB.instanceId)
  })
})
