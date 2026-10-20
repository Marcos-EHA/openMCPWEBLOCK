import type { WebExecution } from '../types/messages';

export interface ExecutionActivitySnapshot {
  running: number;
  uncertain: number;
}

type ActivityRecord = {
  revision?: number;
  terminal: boolean;
  uncertain: boolean;
};

/** Presentation only: never dispatches, retries, or delivers tool results. */
export class ExecutionActivity {
  private records = new Map<string, ActivityRecord>();
  private listeners = new Set<() => void>();
  private snapshot: ExecutionActivitySnapshot = { running: 0, uncertain: 0 };

  getSnapshot = (): ExecutionActivitySnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  track(id: string): void {
    if (!id || this.records.has(id)) return;
    this.records.set(id, { terminal: false, uncertain: false });
    this.emit();
  }

  forget(id: string): void {
    if (this.records.delete(id)) this.emit();
  }

  markUncertain(id: string): void {
    const previous = this.records.get(id);
    if (!previous || previous.terminal) return;
    this.records.set(id, { ...previous, uncertain: true });
    this.emit();
  }

  observe(execution: Pick<WebExecution, 'executionId' | 'status' | 'revision' | 'livenessUnknown' | 'unknownOutcome'>): void {
    const id = execution.executionId;
    if (!id) return;
    const previous = this.records.get(id);
    // Ignore broadcasts belonging to executions this client did not initiate or adopt.
    if (!previous) return;
    const revision = typeof execution.revision === 'number' && Number.isFinite(execution.revision)
      ? execution.revision : undefined;
    if (previous.revision !== undefined && (revision === undefined || revision < previous.revision)) return;
    const terminal = ['success', 'error', 'cancelled'].includes(execution.status);
    if (previous.terminal && !terminal) return;
    const uncertain = Boolean(execution.unknownOutcome || execution.livenessUnknown);
    this.records.set(id, { revision: revision ?? previous.revision, terminal, uncertain });
    // Retain a bounded number of settled identities to reject delayed updates.
    if (this.records.size > 500) {
      for (const [key, record] of this.records) {
        if (record.terminal && !record.uncertain) this.records.delete(key);
        if (this.records.size <= 500) break;
      }
    }
    this.emit();
  }

  private emit(): void {
    let running = 0;
    let uncertain = 0;
    for (const record of this.records.values()) {
      if (record.uncertain) uncertain++;
      else if (!record.terminal) running++;
    }
    if (running === this.snapshot.running && uncertain === this.snapshot.uncertain) return;
    this.snapshot = { running, uncertain };
    for (const listener of this.listeners) listener();
  }
}

export const executionActivity = new ExecutionActivity();
