export const CHATGPT_SUBMIT_BUTTON_SELECTORS = [
  'button[data-testid="send-button"]',
  'button[data-testid="fruitjuice-send-button"]',
  'button[data-testid*="composer-submit" i]',
  'button[data-testid*="send" i]',
  'button[aria-label*="send message" i]',
  'button[aria-label*="send prompt" i]',
  'button[aria-label*="send" i]',
  'button[aria-label*="enviar mensaje" i]',
  'button[aria-label*="enviar" i]',
];

export function isChatGPTSubmitButtonLabel(ariaLabel: string | null, testId: string | null): boolean {
  const label = ariaLabel?.trim().toLocaleLowerCase() ?? '';
  const normalizedTestId = testId?.trim().toLocaleLowerCase() ?? '';

  return normalizedTestId === 'send-button' ||
    normalizedTestId === 'fruitjuice-send-button' ||
    normalizedTestId.includes('composer-submit') ||
    normalizedTestId.includes('send') ||
    label.includes('send message') ||
    label.includes('send prompt') ||
    label === 'send' ||
    label.includes('enviar mensaje') ||
    label.includes('enviar prompt') ||
    label === 'enviar';
}

export function findChatGPTSubmitButton(
  root: ParentNode,
  isVisible: (button: HTMLButtonElement) => boolean,
): HTMLButtonElement | null {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
    .find(button => isVisible(button) &&
      isChatGPTSubmitButtonLabel(
        button.getAttribute('aria-label'),
        button.getAttribute('data-testid'),
      )) ?? null;
}
