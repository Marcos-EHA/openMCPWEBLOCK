export interface ExecutionIdentityRecord {
  executionId?: unknown;
  executionKey?: unknown;
  callId?: unknown;
  functionName?: unknown;
  contentSignature?: unknown;
}

export interface ExecutionIdentityRequest {
  executionKey: string;
  callId: string;
  functionName: string;
  contentSignature?: string;
}

export const recoverExecutionId = (
  record: ExecutionIdentityRecord | null | undefined,
  request: ExecutionIdentityRequest,
): string | null => {
  if (!record || record.executionKey !== request.executionKey) return null;
  if (String(record.callId) !== request.callId) return null;
  if (record.functionName !== request.functionName) return null;
  if (request.contentSignature && record.contentSignature !== request.contentSignature) return null;

  return typeof record.executionId === 'string' && record.executionId.trim()
    ? record.executionId
    : null;
};
