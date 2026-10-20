import { describe, expect, test } from 'bun:test';

(globalThis as any).window = {
  location: { href: 'https://chatgpt.com/c/test-conversation' },
};

const { CONFIG } = await import('../core/config');
const { extractJSONFunctionInfo, extractJSONParameters } = await import('./jsonFunctionParser');

describe('ChatGPT function block selectors', () => {
  test('observes code elements as well as pre elements', () => {
    expect(CONFIG.targetSelectors).toEqual(['pre', 'code']);
    expect(CONFIG.streamingContainerSelectors).toEqual(['pre', 'code']);
  });
});

describe('extractJSONFunctionInfo', () => {
  test('recognizes the reported no-argument Chrome pages call as complete metadata', () => {
    const content = [
      '{"type":"function_call_start","name":"chrome-devtools-mcp.list_pages","call_id":1}',
      '{"type":"description","text":"Consultar las pestañas abiertas de Chrome para comprobar la conexión con SuperAssistant."}',
      '{"type":"function_call_end","call_id":1}',
    ].join('\n');

    expect(extractJSONFunctionInfo(content)).toEqual({
      functionName: 'chrome-devtools-mcp.list_pages',
      callId: '1',
      description: 'Consultar las pestañas abiertas de Chrome para comprobar la conexión con SuperAssistant.',
    });
    expect(extractJSONParameters(content)).toEqual({});
  });
});

describe('extractJSONParameters', () => {
  test('preserves the command parameter from the documented JSONL format', () => {
    const content = [
      '{"type":"function_call_start","name":"Bash","call_id":"call-15"}',
      '{"type":"parameter","key":"command","value":"Get-Location"}',
      '{"type":"function_call_end","call_id":"call-15"}',
    ].join('\n');

    expect(extractJSONParameters(content)).toEqual({ command: 'Get-Location' });
  });

  test('keeps independent parameters from separate JSONL lines', () => {
    const content = [
      '{"type":"function_call_start","name":"Bash","call_id":"call-16"}',
      '{"type":"parameter","key":"command","value":"Get-Location"}',
      '{"type":"parameter","key":"cwd","value":"C:\\\\project"}',
      '{"type":"function_call_end","call_id":"call-16"}',
    ].join('\n');

    expect(extractJSONParameters(content)).toEqual({
      command: 'Get-Location',
      cwd: 'C:\\project',
    });
  });
});
