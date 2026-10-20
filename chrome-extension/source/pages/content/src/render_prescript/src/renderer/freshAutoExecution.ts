import { CONFIG } from '../core/config';
import { CHATGPT_SUBMIT_BUTTON_SELECTORS } from '../../../plugins/adapters/chatgptSubmitButton';
import { FreshTurnPolicy } from './freshTurnPolicy';

const COMPOSER = '#prompt-textarea, #mobile-composer-prompt, [contenteditable="true"][data-placeholder], .ProseMirror[contenteditable="true"], textarea';
const SEND = ['button[type="submit"]', 'button[title="Send" i]', ...CHATGPT_SUBMIT_BUTTON_SELECTORS].join(', ');
const USER = '[data-message-author-role="user"], [data-testid="user-message"], [data-test-id="user-query"], user-query, [data-author="user"], [data-turn-role="User"], [aria-label="Your message"], [data-role="user"]';
const policy = new FreshTurnPolicy();
let listening = false;
let baseline = new WeakSet<Element>();
let active: {
  scope: string;
  text: string;
  users: Set<Element>;
  userIds: Set<string>;
  submittedAt: number;
  allowNewConversation: boolean;
} | null = null;

export interface FreshAutoExecutionToken {
  key: string;
  generation: number;
  scope: string;
  source: Element;
  user: Element;
}

function scope(): string { return `${location.origin}${location.pathname}`; }
function normalize(text: string): string { return text.replace(/\s+/g, ' ').trim(); }
function reset(): void { policy.reset(); active = null; }
function userId(node: Element): string {
  return node.getAttribute('data-message-id') || node.getAttribute('data-turn-id') || node.id || '';
}
function users(): Element[] {
  const selectors = [USER, ...(CONFIG.function_result_selector ?? [])];
  const nodes = new Set<Element>();
  for (const selector of selectors) {
    try {
      document.querySelectorAll(selector).forEach(node => {
        if (!node.closest('input, textarea, [contenteditable="true"], .function-block')) nodes.add(node);
      });
    } catch { /* An unsupported selector cannot grant execution eligibility. */ }
  }
  // ChatGPT can expose message roles through accessible headings instead of data attributes.
  if (location.hostname === 'chatgpt.com' || location.hostname === 'chat.openai.com') {
    document.querySelectorAll('h4.sr-only').forEach(heading => {
      if (heading.closest('pre, code, blockquote, .function-block, input, textarea, [contenteditable="true"]')) return;
      const label = normalize(heading.textContent || '');
      if (!/^(?:you|you said|tú|tú dijiste|dijiste|usuario)\s*:?$/i.test(label)) return;
      const message = heading.parentElement;
      // Require the observed heading + message-body structure inside a conversation turn.
      if (!message || !message.closest('[data-talvt-turn-state]')) return;
      if (message.children.length !== 2 || message.firstElementChild !== heading) return;
      const body = heading.nextElementSibling;
      if (!body || !normalize(body.textContent || '')) return;
      nodes.add(message);
    });
  }
  return [...nodes].sort((a, b) => {
    const position = a.compareDocumentPosition(b);
    return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : position & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
  });
}
function snapshotBlocks(): void {
  baseline = new WeakSet<Element>();
  document.querySelectorAll('pre, code, .function-block, main p').forEach(node => baseline.add(node));
}
function composerFor(target: Element | null): HTMLElement | null {
  const direct = target?.closest<HTMLElement>(COMPOSER);
  if (direct) return direct;
  const root = target?.closest('form') || document;
  return Array.from(root.querySelectorAll<HTMLElement>(COMPOSER)).find(node => node.getClientRects().length > 0) || null;
}
function beginSubmission(target: Element | null): void {
  const composer = composerFor(target);
  if (!composer) return;
  const text = normalize('value' in composer ? String((composer as HTMLTextAreaElement).value) : composer.textContent || '');
  if (!text) return;
  const currentScope = scope();
  if (active?.scope === currentScope && active.text === text && Date.now() - active.submittedAt < 500) return;
  const existingUsers = users();
  snapshotBlocks();
  policy.beginTurn(currentScope);
  active = {
    scope: currentScope,
    text,
    users: new Set(existingUsers),
    userIds: new Set(existingUsers.map(userId).filter(Boolean)),
    submittedAt: Date.now(),
    allowNewConversation: existingUsers.length === 0 && /\/(?:new|app)?\/?$/.test(location.pathname),
  };
}
function onClick(event: MouseEvent): void {
  const target = event.target instanceof Element ? event.target : null;
  const link = target?.closest<HTMLAnchorElement>('a[href]');
  if (link) {
    const destination = new URL(link.href, location.href);
    if (`${destination.origin}${destination.pathname}` !== scope()) reset();
  }
  const button = target?.closest<HTMLButtonElement>(SEND);
  if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true') beginSubmission(button);
}
function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.isComposing || event.defaultPrevented) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(COMPOSER)) beginSubmission(target);
}
function onSubmit(event: SubmitEvent): void {
  beginSubmission(event.target instanceof Element ? event.target : null);
}
function currentUserBoundary(source: Element): Element | null {
  if (!active || !source.isConnected || source.closest('textarea, input, [contenteditable="true"]')) return null;
  const currentScope = scope();
  if (active.scope !== currentScope) {
    if (!active.allowNewConversation || Date.now() - active.submittedAt > 15000 ||
        !policy.moveNewConversationScope(active.scope, currentScope)) {
      reset();
      return null;
    }
    active.scope = currentScope;
    active.allowNewConversation = false;
  }
  const user = users().at(-1);
  if (!user || active.users.has(user) || (userId(user) && active.userIds.has(userId(user)))) return null;
  if (!normalize(user.textContent || '').includes(active.text) || user.contains(source)) return null;
  if (!(user.compareDocumentPosition(source) & Node.DOCUMENT_POSITION_FOLLOWING)) return null;
  if (baseline.has(source) || (source.closest('pre') && baseline.has(source.closest('pre')!))) return null;
  return user;
}

export function startFreshCallTracking(): void {
  if (listening || typeof document === 'undefined') return;
  reset();
  snapshotBlocks();
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('submit', onSubmit, true);
  document.addEventListener('mcp:auto-execution-paused', reset);
  window.addEventListener('popstate', reset);
  window.addEventListener('hashchange', reset);
  listening = true;
}

export function stopFreshCallTracking(): void {
  reset();
  if (!listening) return;
  document.removeEventListener('click', onClick, true);
  document.removeEventListener('keydown', onKeyDown, true);
  document.removeEventListener('submit', onSubmit, true);
  document.removeEventListener('mcp:auto-execution-paused', reset);
  window.removeEventListener('popstate', reset);
  window.removeEventListener('hashchange', reset);
  listening = false;
}

export function freshAutoExecutionToken(source: Element, identity: string): FreshAutoExecutionToken | null {
  const user = currentUserBoundary(source);
  const currentScope = scope();
  const key = JSON.stringify([currentScope, identity]);
  const generation = policy.observe(key, currentScope, Boolean(user));
  if (generation === null || !user) return null;
  return { key, generation, scope: currentScope, source, user };
}

export function isFreshAutoExecutionAllowed(token: FreshAutoExecutionToken | null | undefined): boolean {
  if (!token || !listening || !token.source.isConnected || !token.user.isConnected) return false;
  const user = currentUserBoundary(token.source);
  return user === token.user && policy.permits(token.key, scope(), token.generation);
}
