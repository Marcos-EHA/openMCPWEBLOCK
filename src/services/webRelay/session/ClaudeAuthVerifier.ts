import {
  classifyCookiesForPlatform,
  getPageWsUrl,
  sendCdpCommand,
  type SessionCookieParam,
} from './SessionBroker.js'

export type ClaudeAuthStatus = 'authenticated' | 'loginRequired' | 'unknown'

export interface ClaudeAuthResult {
  status: ClaudeAuthStatus
  hasSessionCookie: boolean
  hasLoginElements: boolean
  hasAccountIndicator: boolean
  hasComposer: boolean
  reason: string
}

interface ClaudeDomInspection {
  hasLoginElements: boolean
  hasAccountIndicator: boolean
  hasComposer: boolean
}

export function classifyClaudeAuth(
  hasSessionCookie: boolean,
  dom: ClaudeDomInspection,
): ClaudeAuthResult {
  if (!hasSessionCookie) {
    return {
      status: 'loginRequired',
      hasSessionCookie: false,
      hasLoginElements: dom.hasLoginElements,
      hasAccountIndicator: dom.hasAccountIndicator,
      hasComposer: dom.hasComposer,
      reason: 'No active Claude session cookie found in the browser cookie jar.',
    }
  }

  if (dom.hasLoginElements) {
    return {
      status: 'loginRequired',
      hasSessionCookie: true,
      hasLoginElements: true,
      hasAccountIndicator: dom.hasAccountIndicator,
      hasComposer: dom.hasComposer,
      reason: 'Claude login UI is visible.',
    }
  }

  if (dom.hasAccountIndicator || dom.hasComposer) {
    return {
      status: 'authenticated',
      hasSessionCookie: true,
      hasLoginElements: false,
      hasAccountIndicator: dom.hasAccountIndicator,
      hasComposer: dom.hasComposer,
      reason: dom.hasAccountIndicator
        ? 'Claude account indicator is visible.'
        : 'Claude composer is available and no login UI is visible.',
    }
  }

  return {
    status: 'unknown',
    hasSessionCookie: true,
    hasLoginElements: false,
    hasAccountIndicator: false,
    hasComposer: false,
    reason: 'Claude page is still rendering; no authenticated UI is visible yet.',
  }
}

async function checkClaudeSessionCookie(debugPort: number): Promise<boolean> {
  const wsUrl = await getPageWsUrl(debugPort, 'claude.ai')
  await sendCdpCommand(wsUrl, 'Network.enable')
  const result = await sendCdpCommand<{ cookies: SessionCookieParam[] }>(wsUrl, 'Network.getCookies', {
    urls: ['https://claude.ai'],
  })
  return classifyCookiesForPlatform(result?.cookies ?? [], 'claude').hasValidSession
}

async function inspectClaudeDom(debugPort: number): Promise<ClaudeDomInspection> {
  const wsUrl = await getPageWsUrl(debugPort, 'claude.ai')
  const expression = `(() => {
    const visible = element => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return bounds.width > 0 && bounds.height > 0 &&
        style.display !== 'none' && style.visibility !== 'hidden';
    };
    const loginSelectors = [
      'a[href*="/login"]',
      'button[data-testid*="login"]',
      'button[aria-label*="Sign in" i]',
      '[data-testid*="login-dialog"]'
    ];
    const hasLoginElements = loginSelectors.some(selector =>
      [...document.querySelectorAll(selector)].some(visible)
    ) || [...document.querySelectorAll('button, a')].some(element => {
      const text = (element.textContent || '').trim().toLowerCase();
      return visible(element) && (text === 'log in' || text === 'sign in' || text === 'iniciar sesión');
    });
    const accountSelectors = [
      '[data-testid="user-menu-trigger"]',
      '[data-testid="user-menu-button"]',
      'button[aria-label*="Account" i]',
      'button[aria-label*="Profile" i]'
    ];
    const hasAccountIndicator = accountSelectors.some(selector =>
      [...document.querySelectorAll(selector)].some(visible)
    );
    const hasComposer = [...document.querySelectorAll(
      'div[contenteditable="true"], textarea, [data-testid="chat-input"]'
    )].some(visible);
    return { hasLoginElements, hasAccountIndicator, hasComposer };
  })()`
  const result = await sendCdpCommand<{ result?: { value?: ClaudeDomInspection } }>(
    wsUrl,
    'Runtime.evaluate',
    { expression, returnByValue: true },
  )
  if (!result?.result?.value) {
    throw new Error('Runtime.evaluate returned no Claude DOM inspection result.')
  }
  return result.result.value
}

export async function verifyClaudeAuth(
  debugPort: number,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<ClaudeAuthResult> {
  const timeoutMs = options.timeoutMs ?? 25_000
  const pollIntervalMs = options.pollIntervalMs ?? 1_500
  const hasSessionCookie = await checkClaudeSessionCookie(debugPort)
  if (!hasSessionCookie) {
    return classifyClaudeAuth(false, {
      hasLoginElements: false,
      hasAccountIndicator: false,
      hasComposer: false,
    })
  }

  const deadline = Date.now() + timeoutMs
  let lastResult = classifyClaudeAuth(true, {
    hasLoginElements: false,
    hasAccountIndicator: false,
    hasComposer: false,
  })
  while (Date.now() < deadline) {
    lastResult = classifyClaudeAuth(true, await inspectClaudeDom(debugPort))
    if (lastResult.status !== 'unknown') return lastResult
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }
  return lastResult
}
