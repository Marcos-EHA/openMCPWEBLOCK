/**
 * SharedMemoryStore
 * Implements shared context and state across all agents in a consensus session.
 */

import type { SharedContext, AgentResponse, ConsensusResult, MemorySession } from '../types/index.js';

export class SharedMemoryStore {
  private sessions = new Map<string, MemorySession>();

  /**
   * Create or initialize a new session
   */
  createSession(sessionId: string, task: string, initialContext?: Partial<SharedContext>): MemorySession {
    const session: MemorySession = {
      sessionId,
      task,
      sharedContext: {
        keyFacts: initialContext?.keyFacts ?? [],
        assumptions: initialContext?.assumptions ?? [],
        previousDecisions: initialContext?.previousDecisions ?? [],
        additionalData: initialContext?.additionalData ?? {},
      },
      agentResponses: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * Get an existing session by ID
   */
  getSession(sessionId: string): MemorySession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Add a key fact to the session's shared context
   */
  addKeyFact(sessionId: string, fact: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (!session.sharedContext.keyFacts.includes(fact)) {
      session.sharedContext.keyFacts.push(fact);
      session.updatedAt = Date.now();
    }
  }

  /**
   * Record an agent response into the session
   */
  recordAgentResponse(sessionId: string, response: AgentResponse): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.agentResponses[response.agentId] = response;
    session.updatedAt = Date.now();
  }

  /**
   * Save consensus result for the session
   */
  saveConsensus(sessionId: string, consensus: ConsensusResult): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.consensus = consensus;
    session.updatedAt = Date.now();
  }

  /**
   * Export all sessions or a single session to JSON string
   */
  exportSessionJSON(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    return JSON.stringify(session, null, 2);
  }

  /**
   * Clear all sessions
   */
  clear(): void {
    this.sessions.clear();
  }
}
