import { describe, expect, test } from 'bun:test';
import { findAutoExecutionTarget } from './autoExecutionTarget';

describe('findAutoExecutionTarget', () => {
  const identity = {
    functionName: 'Read',
    callId: 'call-1',
    contentSignature: 'signature-1',
  };

  test('prefers the matching duplicate that has an execute button', () => {
    const selected = findAutoExecutionTarget(
      [
        {
          target: 'hidden-duplicate-with-button',
          ...identity,
          hasExecuteButton: true,
          isVisible: false,
          executeButtonEnabled: true,
        },
        {
          target: 'visible-card-with-disabled-button',
          ...identity,
          hasExecuteButton: true,
          isVisible: true,
          executeButtonEnabled: false,
        },
        {
          target: 'visible-executable-card',
          ...identity,
          hasExecuteButton: true,
          isVisible: true,
          executeButtonEnabled: true,
        },
      ],
      identity,
    );

    expect(selected).toBe('visible-executable-card');
  });

  test('does not select an executable card for a different call signature', () => {
    const selected = findAutoExecutionTarget(
      [
        {
          target: 'different-call',
          ...identity,
          contentSignature: 'signature-2',
          hasExecuteButton: true,
          isVisible: true,
          executeButtonEnabled: true,
        },
      ],
      identity,
    );

    expect(selected).toBeNull();
  });

  test('does not select a matching visible card when its execute control is absent', () => {
    const selected = findAutoExecutionTarget(
      [
        {
          target: 'card-without-button',
          ...identity,
          hasExecuteButton: false,
          isVisible: true,
          executeButtonEnabled: false,
        },
      ],
      identity,
    );

    expect(selected).toBeNull();
  });
});
