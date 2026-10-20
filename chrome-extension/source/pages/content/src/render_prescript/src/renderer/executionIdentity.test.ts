import { recoverExecutionId } from './executionIdentity';

describe('recoverExecutionId', () => {
  const request = {
    executionKey: 'instance:call-1',
    callId: 'call-1',
    functionName: 'Read',
    contentSignature: 'signature-1',
  };
  const record = {
    executionId: 'exec-1',
    ...request,
  };

  test('recovers identity only for the exact execution request', () => {
    expect(recoverExecutionId(record, request)).toBe('exec-1');
  });

  test('rejects an execution from another address', () => {
    expect(recoverExecutionId({ ...record, executionKey: 'other:call-1' }, request)).toBeNull();
  });

  test('rejects a reused call id for another tool', () => {
    expect(recoverExecutionId({ ...record, functionName: 'Bash' }, request)).toBeNull();
  });

  test('rejects a different or missing content signature when the request has one', () => {
    expect(recoverExecutionId({ ...record, contentSignature: 'signature-2' }, request)).toBeNull();
    expect(
      recoverExecutionId(
        {
          executionId: 'exec-1',
          executionKey: request.executionKey,
          callId: request.callId,
          functionName: request.functionName,
        },
        request,
      ),
    ).toBeNull();
  });

  test('rejects records that still have no stable execution id', () => {
    expect(recoverExecutionId({ ...record, executionId: undefined }, request)).toBeNull();
    expect(recoverExecutionId({ ...record, executionId: '  ' }, request)).toBeNull();
  });
});
