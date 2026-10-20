import {
  getPageWsUrl,
  isAllowedDomainForPlatform,
  sendCdpCommand,
  type SessionCookieParam,
} from './SessionBroker.js'

export type ZaiAuthStatus = 'authenticated' | 'loginRequired' | 'unverified'

export interface ZaiAuthResult {
  status: ZaiAuthStatus
  hasValidSession: boolean
  cookieCount: number
  reason: string
}

interface ZaiDomInspection {
  isZaiPage: boolean
  hasLoginElements: boolean
  hasComposer: boolean
}

export function hasActiveZaiAuthCookie(cookies: SessionCookieParam[]): boolean {
  const now = Date.now()
  return cookies.some(cookie =>
    isAllowedDomainForPlatform(cookie.domain, 'zai') &&
    /(?:session|auth|token)/i.test(cookie.name) &&
    !/csrf/i.test(cookie.name) &&
    Boolean(cookie.value) &&
    (!cookie.expires || cookie.expires <= 0 || cookie.expires * 1000 > now),
  )
}

export function classifyZaiAuth(
  hasAuthCookie: boolean,
  dom: ZaiDomInspection,
  cookieCount = 0,
): ZaiAuthResult {
  if (!dom.isZaiPage) {
    return {
      status: 'unverified',
      hasValidSession: false,
      cookieCount,
      reason: 'The active Master tab is not the Z.ai chat page.',
    }
  }

  if (dom.hasLoginElements) {
    return {
      status: 'loginRequired',
      hasValidSession: false,
      cookieCount,
      reason: 'Z.ai sign-in controls are visible in the active tab.',
    }
  }

  if (hasAuthCookie && dom.hasComposer) {
    return {
      status: 'authenticated',
      hasValidSession: true,
      cookieCount,
      reason: 'An active Z.ai auth cookie and chat composer are available.',
    }
  }

  return {
    status: 'unverified',
    hasValidSession: false,
    cookieCount,
    reason: hasAuthCookie
      ? 'Z.ai auth cookie exists, but the chat composer is not available yet.'
      : 'OpenMCP could not verify an active Z.ai auth cookie; sign-in state is unknown.',
  }
}

export async function verifyZaiAuth(debugPort: number): Promise<ZaiAuthResult> {
  const wsUrl = await getPageWsUrl(debugPort, 'chat.z.ai')
  await sendCdpCommand(wsUrl, 'Network.enable')
  const cookieResult = await sendCdpCommand<{ cookies: SessionCookieParam[] }>(
    wsUrl,
    'Network.getCookies',
    { urls: ['https://chat.z.ai'] },
  )
  const cookies = (cookieResult?.cookies ?? [])
    .filter(cookie => isAllowedDomainForPlatform(cookie.domain, 'zai'))

  const expression = `(() => {
    const visible = element => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return bounds.width > 0 && bounds.height > 0 &&
        style.display !== 'none' && style.visibility !== 'hidden';
    };
    const loginSelectors = [
      'a[href*="/login"]',
      'button[aria-label*="Sign in" i]',
      'button[aria-label*="Log in" i]',
      '[data-testid*="login"]'
    ];
    const hasLoginElements = loginSelectors.some(selector =>
      [...document.querySelectorAll(selector)].some(visible)
    ) || [...document.querySelectorAll('button, a')].some(element => {
      const text = (element.textContent || '').trim().toLowerCase();
      return visible(element) &&
        (text === 'sign in' || text === 'log in' || text === 'login' ||
          text === '登录' || text === '登入');
    });
    const hasComposer = [...document.querySelectorAll('textarea#chat-input')]
      .some(visible);
    return {
      isZaiPage: location.origin === 'https://chat.z.ai',
      hasLoginElements,
      hasComposer
    };
  })()`
  const domResult = await sendCdpCommand<{ result?: { value?: ZaiDomInspection } }>(
    wsUrl,
    'Runtime.evaluate',
    { expression, returnByValue: true },
  )
  if (!domResult?.result?.value) {
    throw new Error('Runtime.evaluate returned no Z.ai DOM inspection result.')
  }

  return classifyZaiAuth(
    hasActiveZaiAuthCookie(cookies),
    domResult.result.value,
    cookies.length,
  )
}
