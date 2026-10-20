import { describe, expect, test } from 'bun:test';
import { isChatGPTSubmitButtonLabel } from './chatgptSubmitButton';

describe('isChatGPTSubmitButtonLabel', () => {
  test('recognizes the Spanish ChatGPT send button without a test id', () => {
    expect(isChatGPTSubmitButtonLabel('Enviar mensaje', null)).toBe(true);
  });

  test('recognizes English and data-testid send buttons', () => {
    expect(isChatGPTSubmitButtonLabel('Send message', null)).toBe(true);
    expect(isChatGPTSubmitButtonLabel(null, 'composer-submit-button')).toBe(true);
  });

  test('does not treat a stop-generation button as a send button', () => {
    expect(isChatGPTSubmitButtonLabel('Detener la generación', null)).toBe(false);
    expect(isChatGPTSubmitButtonLabel('Stop generating', null)).toBe(false);
  });
});
