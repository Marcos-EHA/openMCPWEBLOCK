import { describe, expect, test } from 'bun:test';
import { isClaudeSubmitButtonReady } from './claude.adapter';

describe('isClaudeSubmitButtonReady', () => {
  const readyButton = {
    disabled: false,
    hasLayoutBox: true,
    display: 'flex',
    visibility: 'visible',
  };

  test('accepts an enabled layouted send button when a tab is hidden', () => {
    expect(
      isClaudeSubmitButtonReady({
        ...readyButton,
        visibility: 'hidden',
        pageVisibility: 'hidden',
      }),
    ).toBe(true);
  });

  test('does not accept a CSS-hidden button in a visible tab', () => {
    expect(
      isClaudeSubmitButtonReady({
        ...readyButton,
        visibility: 'hidden',
        pageVisibility: 'visible',
      }),
    ).toBe(false);
  });

  test('rejects disabled buttons', () => {
    expect(
      isClaudeSubmitButtonReady({
        ...readyButton,
        disabled: true,
        pageVisibility: 'hidden',
      }),
    ).toBe(false);
  });

  test('rejects buttons without a layout box', () => {
    expect(
      isClaudeSubmitButtonReady({
        ...readyButton,
        hasLayoutBox: false,
        pageVisibility: 'hidden',
      }),
    ).toBe(false);
  });

  test('rejects display-none buttons', () => {
    expect(
      isClaudeSubmitButtonReady({
        ...readyButton,
        display: 'none',
        pageVisibility: 'hidden',
      }),
    ).toBe(false);
  });
});
