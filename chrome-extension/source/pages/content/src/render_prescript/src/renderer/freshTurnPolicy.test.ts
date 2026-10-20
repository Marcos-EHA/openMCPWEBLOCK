import { describe, expect, it } from 'bun:test';
import { FreshTurnPolicy } from './freshTurnPolicy';

describe('fresh-turn auto-execution policy', () => {
  it('never authorizes initial history or late history without a fresh submission', () => {
    const policy = new FreshTurnPolicy();
    expect(policy.observe('initial', 'chat:a', true)).toBeNull();
    expect(policy.observe('hydrated-later', 'chat:a', true)).toBeNull();
  });
  it('allows a proven new response after a fresh submission', () => {
    const policy = new FreshTurnPolicy();
    const generation = policy.beginTurn('chat:a');
    expect(policy.observe('new-call', 'chat:a', true)).toBe(generation);
    expect(policy.permits('new-call', 'chat:a', generation)).toBe(true);
  });
  it('does not turn an old observed call into a new call on a later submission', () => {
    const policy = new FreshTurnPolicy();
    policy.observe('old-call', 'chat:a', false);
    policy.beginTurn('chat:a');
    expect(policy.observe('old-call', 'chat:a', true)).toBeNull();
  });
  it('rejects history while a new turn is active', () => {
    const policy = new FreshTurnPolicy();
    policy.beginTurn('chat:a');
    expect(policy.observe('history', 'chat:a', false)).toBeNull();
  });
  it('invalidates delayed actions when the conversation changes', () => {
    const policy = new FreshTurnPolicy();
    const generation = policy.beginTurn('chat:a');
    policy.observe('call', 'chat:a', true);
    expect(policy.permits('call', 'chat:b', generation)).toBe(false);
    policy.reset();
    expect(policy.permits('call', 'chat:a', generation)).toBe(false);
  });
  it('does not carry automatic permission to the next submitted turn', () => {
    const policy = new FreshTurnPolicy();
    const generation = policy.beginTurn('chat:a');
    policy.observe('call', 'chat:a', true);
    policy.beginTurn('chat:a');
    expect(policy.permits('call', 'chat:a', generation)).toBe(false);
    expect(policy.observe('call', 'chat:a', true)).toBeNull();
  });
  it('keeps independent tab sessions isolated without resuming an old call', () => {
    const first = new FreshTurnPolicy();
    first.beginTurn('chat:a');
    first.observe('call', 'chat:a', true);
    const reopened = new FreshTurnPolicy();
    expect(reopened.observe('call', 'chat:a', true)).toBeNull();
  });
});
