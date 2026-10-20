/**
 * ChatGPTAuthVerifier.ts
 *
 * Dedicated multi-layered verifier for ChatGPT authentication state.
 *
 * Layers:
 *   Layer A: Non-expired session cookie in CDP Network cookie jar (__Secure-next-auth.session-token).
 *   Layer B: Absence of login buttons/links/dialogs in the DOM.
 *   Layer C: Positive presence of user account indicator (avatar/profile button) OR authenticated composer.
 *   Layer D: Robust composition — does NOT depend solely on [data-testid="composer-plus-btn"].
 *
 * Classification:
 *   - 'authenticated': Layer A passed, Layer B passed, Layer C passed.
 *   - 'loginRequired': Login buttons/dialogs detected OR no valid session cookie found.
 *   - 'unknown': Page still loading/rendering (no login elements, but no account/composer yet).
 */

import { getPageWsUrl, sendCdpCommand, type SessionCookieParam, isAllowedDomain, classifyCookies } from './SessionBroker.js'

export type AuthVerificationStatus = 'authenticated' | 'loginRequired' | 'unknown'

export interface DomInspectionResult {
  hasLoginElements: boolean
  loginDetail?: string
  hasAccountIndicator: boolean
  accountDetail?: string
  hasComposer: boolean
  hasPlusBtn: boolean
  url: string
  title: string
}

export interface AuthVerificationResult {
  status: AuthVerificationStatus
  hasSessionCookie: boolean
  hasLoginElements: boolean
  hasAccountIndicator: boolean
  hasComposer: boolean
  hasPlusBtn: boolean
  reason: string
  url?: string
}

/**
 * Check if the browser network cookie jar on debugPort contains a valid session token.
 */
export async function checkNetworkSessionCookie(debugPort: number): Promise<boolean> {
  try {
    const wsUrl = await getPageWsUrl(debugPort)
    await sendCdpCommand(wsUrl, 'Network.enable')
    const result = await sendCdpCommand<{ cookies: SessionCookieParam[] }>(wsUrl, 'Network.getCookies', {
      urls: ['https://chatgpt.com', 'https://openai.com'],
    })
    const cookies = (result?.cookies || []).filter(c => isAllowedDomain(c.domain))
    const classification = classifyCookies(cookies)
    return classification.hasValidSession
  } catch {
    return false
  }
}

/**
 * Inspect the ChatGPT DOM via Runtime.evaluate for login and authenticated indicators.
 */
export async function inspectDomAuth(debugPort: number): Promise<DomInspectionResult> {
  const wsUrl = await getPageWsUrl(debugPort, 'chatgpt')

  const expr = `(() => {
    // 1. Negative indicators (Login prompts / buttons)
    const loginSelectors = [
      'button[data-testid="login-button"]',
      'button[data-testid="welcome-login-button"]',
      'a[href*="/login"]',
      'a[href*="/auth/login"]',
      '[data-testid="auth-login-button"]',
      '[data-testid="login-dialog"]',
    ];
    let hasLoginElements = false;
    let loginDetail = null;

    for (const sel of loginSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        hasLoginElements = true;
        loginDetail = sel;
        break;
      }
    }

    if (!hasLoginElements) {
      const buttons = Array.from(document.querySelectorAll('button, a'));
      for (const b of buttons) {
        const txt = (b.textContent || '').trim().toLowerCase();
        if (txt === 'log in' || txt === 'iniciar sesión' || txt === 'sign up' || txt === 'registrarse') {
          hasLoginElements = true;
          loginDetail = 'text:' + txt;
          break;
        }
      }
    }

    // 2. Positive account / identity indicators
    const accountSelectors = [
      '[data-testid="profile-button"]',
      '[data-testid="user-menu-button"]',
      'button[aria-label*="User profile" i]',
      'button[aria-label*="Perfil" i]',
      'button[aria-label*="Cuenta" i]',
      'img[alt*="avatar" i]',
      'img[alt*="user" i]',
      '[data-testid="accounts-profile-button"]',
    ];
    let hasAccountIndicator = false;
    let accountDetail = null;

    for (const sel of accountSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        hasAccountIndicator = true;
        accountDetail = sel;
        break;
      }
    }

    // 3. Composer / input indicators
    const composerSelectors = [
      '#prompt-textarea',
      '#mobile-composer-prompt',
      'textarea[data-id="root"]',
      'div[contenteditable="true"]',
    ];
    let hasComposer = false;
    for (const sel of composerSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        hasComposer = true;
        break;
      }
    }

    const plusBtn = document.querySelector('[data-testid="composer-plus-btn"]');
    const hasPlusBtn = Boolean(plusBtn);

    return {
      hasLoginElements,
      loginDetail,
      hasAccountIndicator,
      accountDetail,
      hasComposer,
      hasPlusBtn,
      url: window.location.href,
      title: document.title,
    };
  })()`

  const evalResult = await sendCdpCommand<{ result?: { value?: DomInspectionResult } }>(
    wsUrl,
    'Runtime.evaluate',
    { expression: expr, returnByValue: true },
  )

  const val = evalResult?.result?.value
  if (!val) {
    throw new Error('Runtime.evaluate returned no DOM inspection value')
  }
  return val
}

/**
 * Pure classification logic combining Layer A (cookies) and DOM signals.
 */
export function classifyAuth(
  hasSessionCookie: boolean,
  dom: DomInspectionResult,
): AuthVerificationResult {
  if (!hasSessionCookie) {
    return {
      status: 'loginRequired',
      hasSessionCookie: false,
      hasLoginElements: dom.hasLoginElements,
      hasAccountIndicator: dom.hasAccountIndicator,
      hasComposer: dom.hasComposer,
      hasPlusBtn: dom.hasPlusBtn,
      reason: 'No non-expired session cookie found in browser network jar',
      url: dom.url,
    }
  }

  if (dom.hasLoginElements) {
    return {
      status: 'loginRequired',
      hasSessionCookie: true,
      hasLoginElements: true,
      hasAccountIndicator: dom.hasAccountIndicator,
      hasComposer: dom.hasComposer,
      hasPlusBtn: dom.hasPlusBtn,
      reason: `Login element detected on page (${dom.loginDetail || 'login button/link'})`,
      url: dom.url,
    }
  }

  if (dom.hasAccountIndicator || (dom.hasComposer && !dom.hasLoginElements)) {
    return {
      status: 'authenticated',
      hasSessionCookie: true,
      hasLoginElements: false,
      hasAccountIndicator: dom.hasAccountIndicator,
      hasComposer: dom.hasComposer,
      hasPlusBtn: dom.hasPlusBtn,
      reason: dom.hasAccountIndicator
        ? `Account indicator verified (${dom.accountDetail})`
        : 'Authenticated composer available without login elements',
      url: dom.url,
    }
  }

  return {
    status: 'unknown',
    hasSessionCookie: true,
    hasLoginElements: false,
    hasAccountIndicator: false,
    hasComposer: false,
    hasPlusBtn: false,
    reason: 'Page still rendering (no login elements or authenticated indicators yet)',
    url: dom.url,
  }
}

/**
 * Polling verification of ChatGPT authentication on debugPort.
 */
export async function verifyChatGPTAuth(
  debugPort: number,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<AuthVerificationResult> {
  const timeoutMs = options.timeoutMs ?? 25000
  const pollIntervalMs = options.pollIntervalMs ?? 1500
  const deadline = Date.now() + timeoutMs

  let lastResult: AuthVerificationResult = {
    status: 'unknown',
    hasSessionCookie: false,
    hasLoginElements: false,
    hasAccountIndicator: false,
    hasComposer: false,
    hasPlusBtn: false,
    reason: 'Initial check',
  }

  // First check cookie layer
  const hasCookie = await checkNetworkSessionCookie(debugPort)
  if (!hasCookie) {
    return {
      status: 'loginRequired',
      hasSessionCookie: false,
      hasLoginElements: false,
      hasAccountIndicator: false,
      hasComposer: false,
      hasPlusBtn: false,
      reason: 'No active session token cookie present in relay cookie jar',
    }
  }

  while (Date.now() < deadline) {
    try {
      const dom = await inspectDomAuth(debugPort)
      const current = classifyAuth(hasCookie, dom)
      lastResult = current

      if (current.status === 'authenticated') {
        return current
      }

      if (current.status === 'loginRequired') {
        // If login elements appear, do one short debounce retry
        await new Promise(r => setTimeout(r, 1000))
        const recheckDom = await inspectDomAuth(debugPort)
        const recheck = classifyAuth(hasCookie, recheckDom)
        if (recheck.status === 'loginRequired') {
          return recheck
        }
      }
    } catch {
      // Page might still be navigating / connecting
    }

    await new Promise(r => setTimeout(r, pollIntervalMs))
  }

  return {
    ...lastResult,
    status: lastResult.status === 'authenticated' ? 'authenticated' : 'unknown',
    reason: lastResult.status === 'unknown'
      ? `Timed out after ${timeoutMs}ms waiting for ChatGPT authentication signals`
      : lastResult.reason,
  }
}
