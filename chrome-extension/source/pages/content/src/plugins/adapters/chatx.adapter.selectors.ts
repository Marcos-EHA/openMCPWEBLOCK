export const CHATX_INPUT_SELECTOR = 'textarea#prompt';
export const CHATX_SEND_BUTTON_SELECTOR = 'button#sendchat_btn';
export const CHATX_COMPOSER_SELECTOR = '#inputfielddiv';

export type ChatXInsertionPoint = { container: Element; insertAfter: Element };

function isVisible(element: Element): boolean {
  const style = window.getComputedStyle(element);
  const bounds = element.getBoundingClientRect();
  return style.display !== 'none' && style.visibility !== 'hidden' &&
    bounds.width > 0 && bounds.height > 0;
}

export function findChatXInsertionPoint(doc: Document = document): ChatXInsertionPoint | null {
  const input = Array.from(doc.querySelectorAll<HTMLTextAreaElement>(CHATX_INPUT_SELECTOR))
    .find(isVisible);
  const composer = input?.closest(CHATX_COMPOSER_SELECTOR);
  const sendButton = Array.from(
    composer?.querySelectorAll<HTMLButtonElement>(CHATX_SEND_BUTTON_SELECTOR) ?? [],
  ).find(isVisible);
  if (!sendButton?.parentElement) return null;
  return { container: sendButton.parentElement, insertAfter: sendButton };
}
