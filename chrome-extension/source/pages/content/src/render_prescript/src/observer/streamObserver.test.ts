import { afterEach, describe, expect, test } from 'bun:test';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    location: {
      href: 'https://chatgpt.com/c/test-conversation',
      hostname: 'chatgpt.com',
    },
    addEventListener() {},
  },
});

const { CONFIG } = await import('../core/config');
const { getActiveStreamIntervalCount, monitorNode } = await import('./streamObserver');

const originalDebug = CONFIG.debug;
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalMutationObserver = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver');

describe('monitorNode interval lifecycle', () => {
  afterEach(() => {
    CONFIG.debug = originalDebug;
    if (originalWindow) {
      Object.defineProperty(globalThis, 'window', originalWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
    if (originalDocument) {
      Object.defineProperty(globalThis, 'document', originalDocument);
    } else {
      Reflect.deleteProperty(globalThis, 'document');
    }
    if (originalMutationObserver) {
      Object.defineProperty(globalThis, 'MutationObserver', originalMutationObserver);
    } else {
      Reflect.deleteProperty(globalThis, 'MutationObserver');
    }
  });

  test('cleans up its interval once a JSONL function call is complete', async () => {
    CONFIG.debug = false;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        body: { contains: () => true },
        querySelector: () => null,
      },
    });
    Object.defineProperty(globalThis, 'MutationObserver', {
      configurable: true,
      value: class {
        observe() {}
      },
    });

    const node = {
      tagName: 'PRE',
      textContent: [
        '{"type":"function_call_start","name":"Bash","call_id":"interval-test"}',
        '{"type":"parameter","key":"command","value":"echo test"}',
        '{"type":"function_call_end","call_id":"interval-test"}',
      ].join('\n'),
      setAttribute() {},
    } as unknown as HTMLElement;

    monitorNode(node, 'complete-jsonl-block');
    expect(getActiveStreamIntervalCount()).toBe(1);

    await new Promise(resolve => setTimeout(resolve, 1100));

    expect(getActiveStreamIntervalCount()).toBe(0);
  });

  test('keeps monitoring incomplete calls until their source node is detached', async () => {
    CONFIG.debug = false;
    let nodeIsConnected = true;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        body: { contains: () => nodeIsConnected },
        querySelector: () => null,
      },
    });
    Object.defineProperty(globalThis, 'MutationObserver', {
      configurable: true,
      value: class {
        observe() {}
      },
    });

    const node = {
      tagName: 'PRE',
      textContent: '{"type":"function_call_start","name":"Bash","call_id":"incomplete-test"}',
      setAttribute() {},
    } as unknown as HTMLElement;

    monitorNode(node, 'incomplete-jsonl-block');
    await new Promise(resolve => setTimeout(resolve, 1100));

    expect(getActiveStreamIntervalCount()).toBe(1);

    nodeIsConnected = false;
    await new Promise(resolve => setTimeout(resolve, 1100));

    expect(getActiveStreamIntervalCount()).toBe(0);
  });
});
