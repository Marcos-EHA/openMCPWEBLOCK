import {
  getPageWsUrl,
  isAllowedDomainForPlatform,
  sendCdpCommand,
  type SessionCookieParam,
} from './SessionBroker.js'

export type ChatXAuthStatus = 'authenticated' | 'loginRequired' | 'unverified'

export interface ChatXAuthResult {
  status: ChatXAuthStatus
  hasValidSession: boolean
  cookieCount: number
  reason: string
}

interface ChatXDomInspection {
  isChatXPage: boolean
  hasLoginElements: boolean
  hasComposer: boolean
}

export function hasActiveChatXAuthCookie(cookies: SessionCookieParam[]): boolean {
  const now = Date.now()
  return cookies.some(cookie =>
    isAllowedDomainForPlatform(cookie.domain, 'chatx') &&
    /(?:session|auth|token)/i.test(cookie.name) &&
    !/csrf/i.test(cookie.name) &&
    Boolean(cookie.value) &&
    (!cookie.expires || cookie.expires <= 0 || cookie.expires * 1000 > now),
  )
}

export function classifyChatXAuth(
  hasAuthCookie: boolean,
  dom: ChatXDomInspection,
  cookieCount = 0,
): ChatXAuthResult {
  if (!dom.isChatXPage) {
    return {
      status: 'unverified',
      hasValidSession: false,
      cookieCount,
      reason: 'The active Master tab is not the ChatX chat page.',
    }
  }

  if (dom.hasLoginElements) {
    return {
      status: 'loginRequired',
      hasValidSession: false,
      cookieCount,
      reason: 'ChatX sign-in controls are visible in the active tab.',
    }
  }

  if (hasAuthCookie && dom.hasComposer) {
    return {
      status: 'authenticated',
      hasValidSession: true,
      cookieCount,
      reason: 'An active ChatX auth cookie and chat composer are available.',
    }
  }

  return {
    status: 'unverified',
    hasValidSession: false,
    cookieCount,
    reason: hasAuthCookie
      ? 'A ChatX auth cookie exists, but the chat composer is not available yet.'
      : 'OpenMCP could not verify an active ChatX auth cookie; sign-in state is unknown.',
  }
}

export async function verifyChatXAuth(debugPort: number): Promise<ChatXAuthResult> {
  const wsUrl = await getPageWsUrl(debugPort, 'chatx.ai')
  await sendCdpCommand(wsUrl, 'Network.enable')
  const cookieResult = await sendCdpCommand<{ cookies: SessionCookieParam[] }>(
    wsUrl,
    'Network.getCookies',
    { urls: ['https://chatx.ai'] },
  )
  const cookies = (cookieResult?.cookies ?? [])
    .filter(cookie => isAllowedDomainForPlatform(cookie.domain, 'chatx'))

  const expression = `(() => {
    const visible = element => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return bounds.width > 0 && bounds.height > 0 &&
        style.display !== 'none' && style.visibility !== 'hidden';
    };
    const loginSelectors = [
      'a[href*="/login"]',
      'a[href*="/sign-in"]',
      'button[aria-label*="sign in" i]',
      'button[aria-label*="log in" i]',
      '[data-testid*="login"]'
    ];
    const hasLoginElements = loginSelectors.some(selector =>
      [...document.querySelectorAll(selector)].some(visible)
    ) || [...document.querySelectorAll('button, a')].some(element => {
      const text = (element.textContent || '').trim().toLowerCase();
      return visible(element) &&
        ['sign in', 'log in', 'login', 'iniciar sesión', 'iniciar sesion', 'registrarse'].includes(text);
    });
    const hasComposer = [...document.querySelectorAll('textarea#prompt')]
      .some(element => visible(element) && !element.disabled && !element.readOnly);
    return {
      isChatXPage: location.hostname === 'chatx.ai',
      hasLoginElements,
      hasComposer
    };
  })()`
  const domResult = await sendCdpCommand<{ result?: { value?: ChatXDomInspection } }>(
    wsUrl,
    'Runtime.evaluate',
    { expression, returnByValue: true },
  )
  if (!domResult?.result?.value) {
    throw new Error('Runtime.evaluate returned no ChatX DOM inspection result.')
  }

  return classifyChatXAuth(
    hasActiveChatXAuthCookie(cookies),
    domResult.result.value,
    cookies.length,
  )
}
