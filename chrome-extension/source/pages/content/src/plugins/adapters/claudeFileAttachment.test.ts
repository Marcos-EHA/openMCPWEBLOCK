import { describe, expect, test } from 'bun:test';
import { findClaudeFileInput } from './claudeFileAttachment';

describe('findClaudeFileInput', () => {
  const promptFile = { name: 'superassistant-instructions.txt', type: 'text/plain' };

  test('selects an enabled Claude file input that accepts a text prompt', () => {
    const inputs = [
      { accept: '.pdf,.png', disabled: false },
      { accept: '.txt,.md', disabled: false },
    ];

    expect(findClaudeFileInput(inputs, promptFile)).toBe(inputs[1]);
  });

  test('does not select disabled or incompatible file inputs', () => {
    const inputs = [
      { accept: '.txt,.md', disabled: true },
      { accept: '.pdf,.png', disabled: false },
    ];

    expect(findClaudeFileInput(inputs, promptFile)).toBeNull();
  });

  test('accepts a matching extension when a prompt input omits MIME metadata', () => {
    const inputs = [{ accept: '.txt', disabled: false }];

    expect(findClaudeFileInput(inputs, { name: 'prompt.txt', type: '' })).toBe(inputs[0]);
  });
});
