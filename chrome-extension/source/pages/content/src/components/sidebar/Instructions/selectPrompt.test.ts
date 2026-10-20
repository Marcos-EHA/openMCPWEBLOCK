import { describe, expect, test } from 'bun:test';
import { selectActiveInstructionPrompt, selectInstructionPrompt } from './selectPrompt';
import originalSuperAssistantPrompt from './originalSuperAssistantPrompt.txt?raw';

const prompts = {
  original: originalSuperAssistantPrompt,
  jsonl: 'updated prompt',
  claude: 'Claude-specific prompt',
  custom: 'user prompt',
  agentDynamic: 'dynamic agent prompt',
};

describe('selectInstructionPrompt', () => {
  test('selects the original SuperAssistant prompt', () => {
    expect(selectInstructionPrompt('original', prompts)).toBe(originalSuperAssistantPrompt);
    expect(originalSuperAssistantPrompt).toContain('[SuperAssistant Operational Instructions][IMPORTANT]');
    expect(originalSuperAssistantPrompt).toContain('User Interaction Starts here:');
    expect(originalSuperAssistantPrompt).not.toContain('"type": "function_call_start"');
    expect(originalSuperAssistantPrompt).not.toContain('"type": "parameter"');
    expect(originalSuperAssistantPrompt).not.toContain('```jsonl');
    expect(originalSuperAssistantPrompt).not.toContain('function_name');
    expect(originalSuperAssistantPrompt).toContain('The DOM observer reads the response');
    expect(originalSuperAssistantPrompt).toContain('In each parameter event, use the type property to identify parameter');
    expect(originalSuperAssistantPrompt).toContain('or a nested parameters object');
    expect(originalSuperAssistantPrompt).toContain('use the type property to identify function_call_start');
    expect(originalSuperAssistantPrompt).toContain('key for the exact argument name');
    expect(originalSuperAssistantPrompt).toContain('Do not use event instead of type');
    expect(originalSuperAssistantPrompt).not.toContain('Parameters for the function should be included as a "parameters" object');
  });

  test('selects the updated JSONL prompt', () => {
    expect(selectInstructionPrompt('jsonl', prompts)).toBe('updated prompt');
  });

  test('selects the Claude-specific prompt', () => {
    expect(selectInstructionPrompt('claude', prompts)).toBe('Claude-specific prompt');
  });

  test('uses only the user prompt in custom mode', () => {
    expect(selectInstructionPrompt('custom', prompts)).toBe('user prompt');
    expect(selectInstructionPrompt('custom', { ...prompts, custom: '' })).toBe('');
  });

  test('uses the explicitly selected source in Guest image mode', () => {
    expect(selectInstructionPrompt('guest-image', prompts, 'jsonl')).toBe('updated prompt');
    expect(selectInstructionPrompt('guest-image', prompts, 'claude')).toBe('Claude-specific prompt');
    expect(selectInstructionPrompt('guest-image', prompts, 'custom')).toBe('user prompt');
    expect(selectInstructionPrompt('guest-image', prompts, 'agent-dynamic')).toBe('dynamic agent prompt');
  });

  test('keeps the dynamic agent prompt independent of the selected prompt source', () => {
    expect(selectActiveInstructionPrompt('original', prompts, 'original', true)).toBe('dynamic agent prompt');
    expect(selectActiveInstructionPrompt('guest-image', prompts, 'jsonl', false)).toBe('updated prompt');
  });
});
