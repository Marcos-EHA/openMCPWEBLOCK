/**
 * TaskOrchestrator
 * Central coordinator for multi-agent task execution and consensus generation.
 */

import { AgentPool } from './AgentPool.js';
import { ResponseCollector } from './ResponseCollector.js';
import { ConsensusEngine } from '../consensus/ConsensusEngine.js';
import { SharedMemoryStore } from '../memory/SharedMemoryStore.js';
import type {
  AgentConfig,
  AgentResponse,
  ConsensusResult,
  SharedContext,
} from '../types/index.js';

export interface TaskOrchestratorOptions {
  agentPool?: AgentPool;
  responseCollector?: ResponseCollector;
  consensusEngine?: ConsensusEngine;
  memoryStore?: SharedMemoryStore;
  defaultTimeoutMs?: number;
}

export class TaskOrchestrator {
  private agentPool: AgentPool;
  private collector: ResponseCollector;
  private consensusEngine: ConsensusEngine;
  private memoryStore: SharedMemoryStore;
  private defaultTimeoutMs: number;

  constructor(options: TaskOrchestratorOptions = {}) {
    this.agentPool = options.agentPool ?? new AgentPool();
    this.collector = options.responseCollector ?? new ResponseCollector();
    this.consensusEngine = options.consensusEngine ?? new ConsensusEngine();
    this.memoryStore = options.memoryStore ?? new SharedMemoryStore();
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
  }

  /**
   * Delegate task across all configured agents concurrently
   */
  async delegateTask(
    task: string,
    agents: AgentConfig[],
    context?: SharedContext
  ): Promise<AgentResponse[]> {
    this.collector.clear();

    const promises = agents.map(async config => {
      const adapter = this.agentPool.registerAgent(config);
      const timeoutMs = config.timeoutMs ?? this.defaultTimeoutMs;

      const timeoutPromise = new Promise<AgentResponse>((_, reject) =>
        setTimeout(() => reject(new Error(`Agent ${config.id} timed out after ${timeoutMs}ms`)), timeoutMs)
      );

      const runPromise = adapter.sendPrompt(task, context);
      const response = await Promise.race([runPromise, timeoutPromise]);
      this.collector.addResponse(response);
      return response;
    });

    return Promise.all(promises);
  }

  /**
   * Wait or retrieve collected responses
   */
  async collectResponses(): Promise<AgentResponse[]> {
    return this.collector.getCollectedResponses();
  }

  /**
   * Detect if a response is complete
   */
  isResponseComplete(response: string): boolean {
    return this.collector.isResponseComplete(response);
  }

  /**
   * Generate consensus from responses
   */
  generateConsensus(responses: AgentResponse[]): ConsensusResult {
    return this.consensusEngine.generateConsensus(responses);
  }

  /**
   * Full end-to-end convenience workflow: delegate -> collect -> consensus -> save
   */
  async runConsensusTask(
    sessionId: string,
    task: string,
    agents: AgentConfig[],
    initialContext?: Partial<SharedContext>
  ): Promise<ConsensusResult> {
    const session = this.memoryStore.createSession(sessionId, task, initialContext);
    const responses = await this.delegateTask(task, agents, session.sharedContext);

    for (const r of responses) {
      this.memoryStore.recordAgentResponse(sessionId, r);
    }

    const consensus = this.generateConsensus(responses);
    this.memoryStore.saveConsensus(sessionId, consensus);
    return consensus;
  }

  getMemoryStore(): SharedMemoryStore {
    return this.memoryStore;
  }
}
