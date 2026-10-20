import { describe, expect, test } from 'bun:test';
import {
  ExecutionResultDeliveryGate,
  dispatchToolExecutionComplete,
} from './executionResultDelivery';

describe('ExecutionResultDeliveryGate', () => {
  test('suppresses concurrent and repeated delivery for one execution', () => {
    const gate = new ExecutionResultDeliveryGate();

    expect(gate.begin('execution-1')).toBe(true);
    expect(gate.begin('execution-1')).toBe(false);
    gate.complete('execution-1');
    expect(gate.begin('execution-1')).toBe(false);
  });

  test('allows distinct executions even when their call ids are reused', () => {
    const gate = new ExecutionResultDeliveryGate();

    expect(gate.begin('execution-1')).toBe(true);
    gate.complete('execution-1');
    expect(gate.begin('execution-2')).toBe(true);
    gate.complete('execution-2');
  });

  test('allows distinct calls to be delivered independently', () => {
    const gate = new ExecutionResultDeliveryGate();

    expect(gate.begin('execution-call-1')).toBe(true);
    expect(gate.begin('execution-call-2')).toBe(true);
  });

  test('allows retry after delivery did not complete', () => {
    const gate = new ExecutionResultDeliveryGate();

    expect(gate.begin('execution-1')).toBe(true);
    gate.release('execution-1');
    expect(gate.begin('execution-1')).toBe(true);
  });
});

describe('dispatchToolExecutionComplete', () => {
  test('dispatches immediately in the current task', () => {
    let dispatched = false;

    dispatchToolExecutionComplete(() => {
      dispatched = true;
    });

    expect(dispatched).toBe(true);
  });
});
