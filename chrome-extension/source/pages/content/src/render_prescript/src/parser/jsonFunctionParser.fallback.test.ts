import { describe, expect, test } from 'bun:test';

(globalThis as any).window = {
  location: { href: 'https://chatgpt.com/c/test-conversation' },
};

const { extractJSONParameters } = await import('./jsonFunctionParser');

describe('extractJSONParameters fallback unescaping', () => {
  test('keeps escaped backslashes before n and t in a Windows path (single-line objects)', () => {
    const content = String.raw`{"type":"function_call_start","name":"Read","call_id":1} {"type":"parameter","key":"file_path","value":"C:\\new\\table.txt"} {"type":"function_call_end","call_id":1}`;

    expect(extractJSONParameters(content)).toEqual({ file_path: 'C:\\new\\table.txt' });
  });

  test('single-line and line-per-object payloads give identical parameters', () => {
    const value = 'C:\\new\\report\\tmp\\readme.md';
    const objects = [
      '{"type":"function_call_start","name":"Read","call_id":2}',
      JSON.stringify({ type: 'parameter', key: 'file_path', value }),
      '{"type":"function_call_end","call_id":2}',
    ];

    expect(extractJSONParameters(objects.join('\n'))).toEqual({ file_path: value });
    expect(extractJSONParameters(objects.join(' '))).toEqual({ file_path: value });
  });
});
