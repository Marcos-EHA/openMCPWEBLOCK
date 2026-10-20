export interface AutoExecutionCandidate<T> {
  target: T;
  functionName: string | null;
  callId: string | null;
  contentSignature: string | null;
  hasExecuteButton: boolean;
  isVisible: boolean;
  executeButtonEnabled: boolean;
}

export interface AutoExecutionIdentity {
  functionName: string;
  callId: string;
  contentSignature: string;
}

export const findAutoExecutionTarget = <T>(
  candidates: readonly AutoExecutionCandidate<T>[],
  identity: AutoExecutionIdentity,
): T | null => {
  const candidate = candidates.find(
    item =>
      item.hasExecuteButton &&
      item.isVisible &&
      item.executeButtonEnabled &&
      item.functionName === identity.functionName &&
      item.callId === identity.callId &&
      item.contentSignature === identity.contentSignature,
  );

  return candidate?.target ?? null;
};
