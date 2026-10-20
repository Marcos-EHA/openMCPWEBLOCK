import { recordExecutionDiagnostic } from '@extension/shared/lib/execution-diagnostics';

export function dispatchToolExecutionComplete(dispatch: () => void): void {
  dispatch();
}

export class ExecutionResultDeliveryGate {
  private readonly inFlight = new Set<string>();
  private readonly delivered = new Set<string>();

  begin(executionId: string, callId?: string): boolean {
    const identity = executionId.trim();
    const rejected = !identity || this.inFlight.has(identity) || this.delivered.has(identity);
    if (rejected) {
      recordExecutionDiagnostic('DELIVERY_RESERVE_REJECTED', {
        ...(identity ? { executionId: identity } : {}),
        executionIdPresent: Boolean(identity),
        callId,
        deliveryType: 'automatic',
        barrierState: this.getState(identity),
      });
      return false;
    }

    this.inFlight.add(identity);
    recordExecutionDiagnostic('DELIVERY_RESERVED', {
      executionId: identity,
      executionIdPresent: true,
      callId,
      deliveryType: 'automatic',
      barrierState: this.getState(identity),
    });
    return true;
  }

  complete(executionId: string, callId?: string): void {
    const identity = executionId.trim();
    if (!identity) return;

    this.inFlight.delete(identity);
    this.delivered.add(identity);
    recordExecutionDiagnostic('DELIVERY_MARKED_DELIVERED', {
      executionId: identity,
      executionIdPresent: true,
      callId,
      deliveryType: 'automatic',
      barrierState: this.getState(identity),
    });
  }

  release(executionId: string, callId?: string): void {
    const identity = executionId.trim();
    if (!identity) return;

    this.inFlight.delete(identity);
    recordExecutionDiagnostic('DELIVERY_RELEASED_AFTER_FAILURE', {
      executionId: identity,
      executionIdPresent: true,
      callId,
      deliveryType: 'automatic',
      barrierState: this.getState(identity),
    });
  }

  getState(executionId: string): 'in_flight' | 'delivered' | 'available' {
    const identity = executionId.trim();
    if (this.inFlight.has(identity)) return 'in_flight';
    if (this.delivered.has(identity)) return 'delivered';
    return 'available';
  }
}
