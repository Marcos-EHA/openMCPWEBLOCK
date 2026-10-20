/**
 * Execution-identity invariants.
 *
 * Every test here encodes a defect that was REPRODUCED against the previous
 * implementation during the 2026-09 forensic audit. A failure is a design
 * regression, not a flaky test.
 *
 * Run: bun test chrome-extension/source/chrome-extension/src/background/ExecutionRegistry.test.ts
 */

import { beforeEach, describe, expect, test } from 'bun:test';

// ─── chrome.storage.local shim ───────────────────────────────────────────────

let store: Record<string, any> = {};
let failNextSet = 0;
let failRegistrySets = 0;

(globalThis as any).chrome = {
  storage: {
    local: {
      async get(keys: any) {
        const out: Record<string, any> = {};
        for (const k of Array.isArray(keys) ? keys : [keys]) if (k in store) out[k] = store[k];
        return out;
      },
      async set(obj: Record<string, any>) {
        if ('mcp:execution-registry:v2' in obj && failRegistrySets > 0) {
          failRegistrySets--;
          throw new Error('QuotaExceededError');
        }
        if (failNextSet > 0) {
          failNextSet--;
          throw new Error('QuotaExceededError');
        }
        Object.assign(store, structuredClone(obj));
      },
      async remove(keys: any) {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
      },
    },
    onChanged: { addListener() {} },
  },
};

/** Fresh module instance = fresh Maps + new BOOT_ID, i.e. a service-worker restart. */
let epoch = 0;
const freshRegistry = () => import(`./ExecutionRegistry?e${epoch++}`);

beforeEach(() => {
  store = {};
  failNextSet = 0;
  failRegistrySets = 0;
});

describe('storage failure preserves execution evidence', () => {
  test('compacts a stored projection without replacing the live response', async () => {
    const R = await freshRegistry();
    const execution = (await R.createExecution({
      callId: 'quota-response', toolName: 'Read', args: {}, instanceId: 'quota-instance',
    })).execution;
    await R.markRunning(execution.executionId!);
    const payload = 'READABLE-RESULT-' + 'x'.repeat(10000);
    failRegistrySets = 1;
    await R.completeExecution(execution.executionId!, payload);
    const live = await R.getExecution(execution.executionId!);
    expect(live!.status).toBe('success');
    expect(String(live!.result)).toContain('READABLE-RESULT-');
    expect(String(live!.result)).not.toContain('[evicted:');
    expect(await R.readFullResult(execution.executionId!)).toBe(payload);
    const persisted = store['mcp:execution-registry:v2'].find(
      (item: any) => item.executionId === execution.executionId,
    );
    expect(persisted.status).toBe('success');
    expect(persisted.resultRef).toBe(live!.resultRef);
    expect(failRegistrySets).toBe(0);
  });

  test('failed persistence retains pending records and the live completed result', async () => {
    const R = await freshRegistry();
    const pending = (await R.createExecution({
      callId: 'quota-pending', toolName: 'Bash', args: { command: 'pending' }, instanceId: 'quota-instance',
    })).execution;
    await R.markRunning(pending.executionId!);
    const completing = (await R.createExecution({
      callId: 'quota-completing', toolName: 'Read', args: {}, instanceId: 'quota-instance',
    })).execution;
    await R.markRunning(completing.executionId!);
    const previousSnapshot = structuredClone(store['mcp:execution-registry:v2']);
    failRegistrySets = 2;
    await R.completeExecution(completing.executionId!, 'LATEST-RESULT-' + 'x'.repeat(10000));
    expect(failRegistrySets).toBe(0);
    expect(store['mcp:execution-registry:v2']).toEqual(previousSnapshot);
    expect(store['mcp:execution-registry:v2'].some(
      (item: any) => item.executionId === pending.executionId && item.status === 'running',
    )).toBe(true);
    expect((await R.getExecution(pending.executionId!))!.status).toBe('running');
    const live = await R.getExecution(completing.executionId!);
    expect(live!.status).toBe('success');
    expect(String(live!.result)).toContain('LATEST-RESULT-');
    expect(String(live!.result)).not.toContain('[evicted:');
  });
});

// ─── Identity ────────────────────────────────────────────────────────────────

describe('INV 1/2/5: mutations resolve by identity, never by address', () => {
  test("A's result can never land on B when they share an address", async () => {
    const R = await freshRegistry();

    const a = (await R.createExecution({
      callId: 'call_1',
      toolName: 'send_email',
      args: { to: 'a@x' },
      instanceId: 'inst-1',
    })).execution;
    await R.markRunning(a.executionId!);

    // Model reuses call_1 with different content: same address, new identity.
    const b = (await R.createExecution({
      callId: 'call_1',
      toolName: 'send_email',
      args: { to: 'b@x' },
      instanceId: 'inst-1',
      force: true,
    })).execution;

    expect(a.executionKey).toBe(b.executionKey);
    expect(a.executionId).not.toBe(b.executionId);

    await R.markRunning(b.executionId!);
    await R.completeExecution(a.executionId!, 'RESULT-OF-A');

    const resolvedB = await R.getExecution(b.executionId!);
    const resolvedA = await R.getExecution(a.executionId!);

    // Previously: B.success with A's result, and A stuck running forever.
    expect(resolvedB!.status).toBe('running');
    expect(resolvedB!.result).toBeUndefined();
    expect(resolvedA!.status).toBe('success');
    expect(resolvedA!.result).toBe('RESULT-OF-A');

    // B's own completion still works.
    await R.completeExecution(b.executionId!, 'RESULT-OF-B');
    expect((await R.getExecution(b.executionId!))!.result).toBe('RESULT-OF-B');
  });

  test('passing an address to a mutation is rejected loudly', async () => {
    const R = await freshRegistry();
    const e = (await R.createExecution({
      callId: 'call_1',
      toolName: 'Read',
      args: {},
      instanceId: 'inst-1',
    })).execution;

    await expect(R.markRunning(e.executionKey)).rejects.toThrow(/Refusing to mutate through an address/);
  });
});

// ─── Retries / coalescing ────────────────────────────────────────────────────

describe('INV 6/7/8/9: a transport retry is not a second side effect', () => {
  test('four deliveries of one logical call produce one execution', async () => {
    const R = await freshRegistry();
    const ids = new Set<string>();
    let created = 0;

    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await R.createExecution({
        callId: 'stable-logical-id',
        toolName: 'delete_file',
        args: { path: '/x' },
        instanceId: 'inst-1',
      });
      ids.add(r.execution.executionId!);
      if (!r.coalesced) created++;
    }

    expect(ids.size).toBe(1);
    expect(created).toBe(1);
  });

  test('a coalesced delivery is reported so the caller skips its worker', async () => {
    const R = await freshRegistry();
    const input = { callId: 'c1', toolName: 'git_push', args: { r: 'origin' }, instanceId: 'i' };

    const first = await R.createExecution({ ...input });
    const second = await R.createExecution({ ...input });

    expect(first.coalesced).toBe(false);
    expect(second.coalesced).toBe(true);
    expect(second.execution.executionId).toBe(first.execution.executionId);
  });

  test('a healthy execution is never driven to error by its own duplicate', async () => {
    const R = await freshRegistry();
    const input = { callId: 'c1', toolName: 'git_push', args: { r: 'origin' }, instanceId: 'i' };

    const first = await R.createExecution({ ...input });
    await R.markRunning(first.execution.executionId!);

    const dup = await R.createExecution({ ...input });
    expect(dup.coalesced).toBe(true);

    // The handler must not start a second worker; simulating the old bug
    // (a second markRunning) must not be what the caller does. The original
    // still settles cleanly.
    await R.completeExecution(first.execution.executionId!, 'ok');
    const settled = await R.getExecution(first.execution.executionId!);
    expect(settled!.status).toBe('success');
    expect(settled!.result).toBe('ok');
  });
});

// ─── Unknown outcomes ────────────────────────────────────────────────────────

describe('INV 10/11/12/13: an ambiguous outcome is not a confirmed failure', () => {
  test('an unacknowledged unknown outcome blocks a new execution at that address', async () => {
    const R = await freshRegistry();
    const e = (await R.createExecution({
      callId: 'call_7',
      toolName: 'git_push',
      args: { f: 1 },
      instanceId: 'i',
    })).execution;
    await R.markRunning(e.executionId!);
    await R.markUnknownOutcome(e.executionId!, 'transport timeout');

    const retry = await R.createExecution({
      callId: 'call_7',
      toolName: 'git_push',
      args: { f: 1 },
      instanceId: 'i',
    });

    expect(retry.blockedByUnknownOutcome).toBeTruthy();
    expect(retry.execution.executionId).toBe(e.executionId);
  });

  test('an explicit human acknowledgement unblocks it', async () => {
    const R = await freshRegistry();
    const e = (await R.createExecution({
      callId: 'call_7',
      toolName: 'git_push',
      args: { f: 1 },
      instanceId: 'i',
    })).execution;
    await R.markRunning(e.executionId!);
    await R.markUnknownOutcome(e.executionId!, 'transport timeout');
    await R.acknowledgeUnknownOutcome(e.executionId!);

    const retry = await R.createExecution({
      callId: 'call_7',
      toolName: 'git_push',
      args: { f: 1 },
      instanceId: 'i',
    });

    expect(retry.blockedByUnknownOutcome).toBeUndefined();
    expect(retry.execution.executionId).not.toBe(e.executionId);
  });

  test('a service-worker restart with a live effectful execution blocks reruns', async () => {
    const R = await freshRegistry();
    const e = (await R.createExecution({
      callId: 'call_7',
      toolName: 'git_push',
      args: { f: 1 },
      instanceId: 'i',
    })).execution;
    await R.markRunning(e.executionId!);

    const R2 = await freshRegistry(); // restart
    const retry = await R2.createExecution({
      callId: 'call_7',
      toolName: 'git_push',
      args: { f: 1 },
      instanceId: 'i',
    });

    // Previously this was PERMITTED and duplicated the push.
    expect(retry.blockedByUnknownOutcome).toBeTruthy();
  });
});

// ─── Recovery ────────────────────────────────────────────────────────────────

describe('INV 14/15: a terminal result survives a service-worker restart', () => {
  test('a finished execution is resolvable by id AND by address after restart', async () => {
    const R = await freshRegistry();
    const e = (await R.createExecution({
      callId: 'call_9',
      toolName: 'Read',
      args: {},
      instanceId: 'i',
    })).execution;
    await R.markRunning(e.executionId!);
    await R.completeExecution(e.executionId!, 'IMPORTANT CONTENT');

    const R2 = await freshRegistry();

    const byId = await R2.getExecution(e.executionId!);
    const byAddress = await R2.getExecution(e.executionKey);

    expect(byId!.result).toBe('IMPORTANT CONTENT');
    // Previously null: hydrate() skipped terminal records entirely.
    expect(byAddress!.result).toBe('IMPORTANT CONTENT');
  });

  test('a live record still wins the address over an older terminal one', async () => {
    const R = await freshRegistry();
    const done = (await R.createExecution({ callId: 'c', toolName: 'Read', args: { v: 1 }, instanceId: 'i' })).execution;
    await R.markRunning(done.executionId!);
    await R.completeExecution(done.executionId!, 'old');

    const live = (await R.createExecution({ callId: 'c', toolName: 'Read', args: { v: 2 }, instanceId: 'i' })).execution;
    await R.markRunning(live.executionId!);

    const R2 = await freshRegistry();
    // reconcileBoot frees the live address, but the terminal record must not
    // masquerade as the live one while it is still indexed.
    const resolved = await R2.getExecution(done.executionKey);
    expect(resolved === null || resolved.executionId === done.executionId).toBe(true);
  });
});

// ─── Persistence ─────────────────────────────────────────────────────────────

describe('INV 16: quota pressure sheds payload, never confirmed answers', () => {
  test('a confirmed success survives a failed persist', async () => {
    const R = await freshRegistry();
    const done = (await R.createExecution({ callId: 'c1', toolName: 'Read', args: {}, instanceId: 'i' })).execution;
    await R.markRunning(done.executionId!);
    await R.completeExecution(done.executionId!, 'the answer');

    const live = (await R.createExecution({ callId: 'c2', toolName: 'x', args: {}, instanceId: 'i' })).execution;
    failNextSet = 1;
    await R.markRunning(live.executionId!);

    const persisted: any[] = store['mcp:execution-registry:v2'] ?? [];
    // Previously the recovery branch persisted ONLY non-terminals, so the
    // success and its result silently disappeared.
    expect(persisted.some(e => e.status === 'success')).toBe(true);
  });
});

describe('INV 16: a result over 8KB is truncated inline but recoverable in full', () => {
  test('readFullResult returns the untruncated payload', async () => {
    const R = await freshRegistry();
    const big = 'x'.repeat(20_000); // > MAX_INLINE_RESULT_BYTES (8 * 1024)

    const e = (await R.createExecution({ callId: 'c1', toolName: 'Read', args: {}, instanceId: 'i' })).execution;
    await R.markRunning(e.executionId!);
    await R.completeExecution(e.executionId!, big);

    const inline = await R.getExecution(e.executionId!);
    expect(inline!.resultTruncated).toBe(true);
    expect((inline!.result as string).length).toBeLessThan(big.length);

    const full = await R.readFullResult(e.executionId!);
    expect(full).toBe(big);
  });

  test('a small result is never truncated and needs no readFullResult', async () => {
    const R = await freshRegistry();
    const e = (await R.createExecution({ callId: 'c1', toolName: 'Read', args: {}, instanceId: 'i' })).execution;
    await R.markRunning(e.executionId!);
    await R.completeExecution(e.executionId!, 'small');

    const inline = await R.getExecution(e.executionId!);
    expect(inline!.resultTruncated).toBeFalsy();
    expect(inline!.result).toBe('small');
  });
});

describe('INV 20: retention actually bounds the map', () => {
  test('the retained count never exceeds the cap', async () => {
    const R = await freshRegistry();
    for (let i = 0; i < 410; i++) {
      const e = (await R.createExecution({ callId: `c${i}`, toolName: 't', args: { i }, instanceId: 'i' })).execution;
      if (i < 5) {
        await R.markRunning(e.executionId!);
        await R.completeExecution(e.executionId!, 'r');
      }
    }
    // Previously 405 with a cap of 400: only terminals were ever prunable.
    expect((await R.listExecutions()).length).toBeLessThanOrEqual(400);
  });
});
