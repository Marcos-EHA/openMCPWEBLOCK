/**
 * SessionManager
 * Manages the lifecycle and retention of consensus sessions.
 */

import { SharedMemoryStore } from './SharedMemoryStore.js';
import type { MemorySession } from '../types/index.js';

export interface SessionManagerOptions {
  maxSessions?: number;
  sessionTtlMs?: number;
}

export class SessionManager {
  private memoryStore: SharedMemoryStore;
  private maxSessions: number;
  private sessionTtlMs: number;

  constructor(memoryStore?: SharedMemoryStore, options: SessionManagerOptions = {}) {
    this.memoryStore = memoryStore ?? new SharedMemoryStore();
    this.maxSessions = options.maxSessions ?? 10; // Default: retain last 10 sessions (per architecture spec)
    this.sessionTtlMs = options.sessionTtlMs ?? 24 * 60 * 60 * 1000; // 24 hours
  }

  getStore(): SharedMemoryStore {
    return this.memoryStore;
  }

  createSession(task: string): MemorySession {
    const sessionId = `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    return this.memoryStore.createSession(sessionId, task);
  }

  getSession(sessionId: string): MemorySession | undefined {
    return this.memoryStore.getSession(sessionId);
  }
}
