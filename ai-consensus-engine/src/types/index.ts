/**
 * Types & Interfaces for AI-Consensus-Engine
 * Based on ARQUITECTURA_MULTI_AGENTE_CONSENSO.md
 */

export type AgentPlatform = 'chatgpt' | 'gemini' | 'grok' | string;

export interface AgentConfig {
  id: string;
  platform: AgentPlatform;
  role: string;
  systemPrompt?: string;
  profileDir?: string;
  debugPort?: number;
  saExtensionId?: string;
  timeoutMs?: number;
}

export interface AgentResponse {
  agentId: string;
  platform: AgentPlatform;
  content: string;
  confidence?: number;
  rawResponse?: unknown;
  timestamp: number;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export interface SimilarityScore {
  overall: number; // 0.0 - 1.0
  lexical: number;
  semantic?: number;
  details?: Record<string, number>;
}

export interface KeyPoint {
  id: string;
  text: string;
  supportedBy: string[]; // agent IDs
  agreementRatio: number; // e.g. 3/3 = 1.0, 2/3 = 0.67
  topic?: string;
}

export interface Divergence {
  topic: string;
  opinions: Record<string, string>; // agentId -> opinion
  significance: 'low' | 'medium' | 'high' | 'critical';
}

export interface ConsensusResult {
  consensus: string;
  confidence: number; // 0.0 - 1.0
  keyPoints: KeyPoint[];
  agreement: Record<string, string>; // topic/point -> e.g. "3/3 de acuerdo"
  divergences: Divergence[];
  responses: AgentResponse[];
  traceability: Record<string, string>; // agentId -> original response snippet or link
  timestamp: number;
}

export interface SharedContext {
  keyFacts: string[];
  assumptions: string[];
  previousDecisions: string[];
  additionalData?: Record<string, unknown>;
}

export interface MemorySession {
  sessionId: string;
  task: string;
  sharedContext: SharedContext;
  agentResponses: Record<string, AgentResponse>;
  consensus?: ConsensusResult;
  createdAt: number;
  updatedAt: number;
}

export interface AgentAdapter {
  readonly platform: AgentPlatform;
  sendPrompt(prompt: string, context?: SharedContext): Promise<AgentResponse>;
  isAvailable(): Promise<boolean>;
  close?(): Promise<void>;
}
