import { afterEach, describe, expect, test } from 'bun:test';
import { persistExecutionDiagnostic, recordExecutionDiagnostic } from './execution-diagnostics';

const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');

afterEach(() => {
  if (originalChrome) Object.defineProperty(globalThis, 'chrome', originalChrome);
  else Reflect.deleteProperty(globalThis, 'chrome');
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else Reflect.deleteProperty(globalThis, 'document');
});

function installStorage(usedBytes = 0) {
  const entries: Record<string, any> = {};
  const writes: Record<string, unknown>[] = [];
  const messages: Array<{ payload: Record<string, unknown> }> = [];
  const local = {
    QUOTA_BYTES: 10 * 1024 * 1024,
    getBytesInUse: async (_keys: unknown) => usedBytes,
    set: async (entry: Record<string, unknown>) => {
      writes.push(structuredClone(entry));
      Object.assign(entries, structuredClone(entry));
    },
  };
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      storage: { local },
      runtime: {
        id: 'test-extension',
        getManifest: () => ({ version: '1.0.0' }),
        sendMessage: (message: { payload: Record<string, unknown> }, callback: (response: { success: boolean }) => void) => {
          messages.push(message);
          callback({ success: true });
        },
      },
    },
  });
  return { entries, writes, messages, local };
}

describe('bounded execution diagnostics', () => {
  test('records visibility and focus and filters both local and forwarded fields', async () => {
    const { writes, messages } = installStorage();
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { visibilityState: 'hidden', hasFocus: () => false },
    });
    recordExecutionDiagnostic('START_EXECUTION_REQUEST', {
      callId: 'call-1', unapprovedField: 'must-not-be-stored',
    });
    // Allow the asynchronous storage capacity check to finish.
    await new Promise(resolve => setTimeout(resolve, 0));
    const savedRecord = Object.values(writes[0] ?? {})[0];
    expect(savedRecord).toMatchObject({
      event: 'START_EXECUTION_REQUEST', callId: 'call-1',
      pageVisibility: 'hidden', pageHasFocus: false,
    });
    expect(messages[0]?.payload).toMatchObject({ pageVisibility: 'hidden', pageHasFocus: false });
    expect(savedRecord).not.toHaveProperty('unapprovedField');
    expect(messages[0]?.payload).not.toHaveProperty('unapprovedField');
  });

  test('concurrent samples use at most 256 slots and leave existing records intact', async () => {
    const { entries } = installStorage();
    entries['mcp:execution-registry:v2'] = [{ executionId: 'pending', status: 'running' }];
    entries['mcp:execution-diagnostic:v1:legacy-event'] = { event: 'legacy' };
    const results = await Promise.all(Array.from({ length: 600 }, (_, index) =>
      persistExecutionDiagnostic({ event: 'sample', index }),
    ));
    expect(results.every(Boolean)).toBe(true);
    const slots = Object.keys(entries).filter(key => key.startsWith('mcp:execution-diagnostic:v1:slot-'));
    expect(slots).toHaveLength(256);
    expect(entries['mcp:execution-registry:v2']).toEqual([{ executionId: 'pending', status: 'running' }]);
    expect(entries['mcp:execution-diagnostic:v1:legacy-event']).toEqual({ event: 'legacy' });
  });

  test('skips writes when storage has no reserved headroom', async () => {
    const { writes } = installStorage(8 * 1024 * 1024);
    expect(await persistExecutionDiagnostic({ event: 'sample' })).toBe(false);
    expect(writes).toHaveLength(0);
  });

  test('checks encoded bytes rather than JavaScript character count', async () => {
    const { writes } = installStorage();
    const record = { event: 'sample', reason: '\u00e9'.repeat(2100) };
    expect(JSON.stringify(record).length).toBeLessThan(4096);
    expect(await persistExecutionDiagnostic(record)).toBe(false);
    expect(writes).toHaveLength(0);
  });

  test('does not write when storage usage cannot be measured', async () => {
    const { local, writes } = installStorage();
    local.getBytesInUse = async () => { throw new Error('storage unavailable'); };
    await expect(persistExecutionDiagnostic({ event: 'sample' })).rejects.toThrow('storage unavailable');
    expect(writes).toHaveLength(0);
  });
});
