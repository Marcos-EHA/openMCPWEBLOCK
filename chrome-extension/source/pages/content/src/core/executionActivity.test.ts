import { describe, expect, it } from 'bun:test';
import { ExecutionActivity } from './executionActivity';

describe('execution activity projection', () => {
  it('keeps other executions visible when one finishes', () => {
    const activity = new ExecutionActivity();
    activity.track('a');
    activity.track('b');
    expect(activity.getSnapshot()).toEqual({ running: 2, uncertain: 0 });
    activity.observe({ executionId: 'a', status: 'success', revision: 2 });
    expect(activity.getSnapshot()).toEqual({ running: 1, uncertain: 0 });
    activity.observe({ executionId: 'b', status: 'error', revision: 2 });
    expect(activity.getSnapshot()).toEqual({ running: 0, uncertain: 0 });
  });

  it('does not revive settled executions from delayed updates or repeated tracking', () => {
    const activity = new ExecutionActivity();
    activity.track('a');
    activity.observe({ executionId: 'a', status: 'success', revision: 4 });
    activity.observe({ executionId: 'a', status: 'running', revision: 3 });
    activity.observe({ executionId: 'a', status: 'running' });
    activity.track('a');
    expect(activity.getSnapshot()).toEqual({ running: 0, uncertain: 0 });
  });

  it('shows uncertainty until a newer confirmed result arrives', () => {
    const activity = new ExecutionActivity();
    activity.track('a');
    activity.observe({ executionId: 'a', status: 'running', revision: 2, livenessUnknown: true });
    expect(activity.getSnapshot()).toEqual({ running: 0, uncertain: 1 });
    activity.observe({ executionId: 'a', status: 'running', revision: 1 });
    expect(activity.getSnapshot()).toEqual({ running: 0, uncertain: 1 });
    activity.observe({ executionId: 'a', status: 'success', revision: 3 });
    expect(activity.getSnapshot()).toEqual({ running: 0, uncertain: 0 });
  });

  it('does not mistake a terminal unknown outcome for confirmed completion', () => {
    const activity = new ExecutionActivity();
    activity.track('a');
    activity.observe({ executionId: 'a', status: 'error', revision: 2, unknownOutcome: true });
    expect(activity.getSnapshot()).toEqual({ running: 0, uncertain: 1 });
  });

  it('ignores unrelated execution broadcasts and retains stable snapshots', () => {
    const activity = new ExecutionActivity();
    const initial = activity.getSnapshot();
    activity.observe({ executionId: 'other-tab', status: 'running', revision: 1 });
    expect(activity.getSnapshot()).toBe(initial);
    let notifications = 0;
    const unsubscribe = activity.subscribe(() => notifications++);
    activity.track('a');
    activity.track('a');
    activity.markUncertain('a');
    expect(notifications).toBe(2);
    expect(activity.getSnapshot()).toEqual({ running: 0, uncertain: 1 });
    unsubscribe();
    activity.forget('a');
    expect(notifications).toBe(2);
    expect(activity.getSnapshot()).toEqual({ running: 0, uncertain: 0 });
  });
});
