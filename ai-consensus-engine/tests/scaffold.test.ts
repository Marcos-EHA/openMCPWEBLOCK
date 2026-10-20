import { describe, it, expect } from 'bun:test';
import {
  TextComparison,
  DOMAutomation,
  SharedMemoryStore,
  SessionManager,
  ChatGPTAdapter,
  GeminiAdapter,
  GrokAdapter,
  SimilarityAnalyzer,
  KeyPointExtractor,
  ConfidenceCalculator,
  ConsensusEngine,
  AgentPool,
  ResponseCollector,
  TaskOrchestrator,
  type AgentConfig,
  type AgentResponse,
} from '../src/index.js';

describe('ai-consensus-engine scaffold verification', () => {
  describe('Utils', () => {
    it('computes lexical similarity correctly', () => {
      const score = TextComparison.compare('hello world', 'hello world');
      expect(score.overall).toBe(1.0);
      expect(score.lexical).toBe(1.0);

      const diffScore = TextComparison.compare('hello world', 'goodbye universe');
      expect(diffScore.lexical).toBe(0.0);
      expect(diffScore.overall).toBeLessThan(0.3);
    });

    it('cleans extracted DOM text correctly', () => {
      const cleaned = DOMAutomation.cleanExtractedText('  hello \u00a0 world\r\nline 2   ');
      expect(cleaned).toBe('hello world\nline 2');
    });
  });

  describe('Memory Store & SessionManager', () => {
    it('creates and updates sessions in SharedMemoryStore', () => {
      const store = new SharedMemoryStore();
      const session = store.createSession('test-session', 'Analyze trends', {
        keyFacts: ['Trend A is growing'],
      });

      expect(session.sessionId).toBe('test-session');
      expect(session.sharedContext.keyFacts).toEqual(['Trend A is growing']);

      store.addKeyFact('test-session', 'Trend B is emerging');
      expect(store.getSession('test-session')?.sharedContext.keyFacts.length).toBe(2);

      const response: AgentResponse = {
        agentId: 'agent-1',
        platform: 'chatgpt',
        content: 'Analysis 1',
        timestamp: Date.now(),
      };
      store.recordAgentResponse('test-session', response);
      expect(store.getSession('test-session')?.agentResponses['agent-1']).toBeDefined();

      const exported = store.exportSessionJSON('test-session');
      expect(exported).toContain('Analyze trends');
    });

    it('manages sessions via SessionManager', () => {
      const manager = new SessionManager();
      const session = manager.createSession('General consensus task');
      expect(session.sessionId).toContain('session-');
      expect(manager.getSession(session.sessionId)).toBeDefined();
    });
  });

  describe('Adapters', () => {
    it('initializes adapters with appropriate platforms and responds', async () => {
      const chatgpt = new ChatGPTAdapter({ id: 'cg-1', platform: 'chatgpt', role: 'tech' });
      const gemini = new GeminiAdapter({ id: 'gem-1', platform: 'gemini', role: 'writer' });
      const grok = new GrokAdapter({ id: 'grk-1', platform: 'grok', role: 'critic' });

      expect(chatgpt.platform).toBe('chatgpt');
      expect(gemini.platform).toBe('gemini');
      expect(grok.platform).toBe('grok');

      const res = await chatgpt.sendPrompt('Test prompt');
      expect(res.agentId).toBe('cg-1');
      expect(res.content).toContain('Test prompt');
    });
  });

  describe('Consensus Engine', () => {
    it('extracts key points and calculates confidence', () => {
      const engine = new ConsensusEngine();

      const responses: AgentResponse[] = [
        {
          agentId: 'a1',
          platform: 'chatgpt',
          content: 'TypeScript and Rust are leading backend technologies in 2026.',
          timestamp: Date.now(),
        },
        {
          agentId: 'a2',
          platform: 'gemini',
          content: 'TypeScript and Rust are dominating backend systems in 2026.',
          timestamp: Date.now(),
        },
        {
          agentId: 'a3',
          platform: 'grok',
          content: 'Python remains strong while Rust gains adoption.',
          timestamp: Date.now(),
        },
      ];

      const result = engine.generateConsensus(responses);
      expect(result.confidence).toBeGreaterThanOrEqual(0.3);
      expect(result.confidence).toBeLessThanOrEqual(1.0);
      expect(result.responses.length).toBe(3);
      expect(result.traceability['a1']).toBeDefined();
      expect(result.traceability['a2']).toBeDefined();
      expect(result.traceability['a3']).toBeDefined();
    });
  });

  describe('TaskOrchestrator', () => {
    it('runs end-to-end consensus flow', async () => {
      const orchestrator = new TaskOrchestrator();

      const agents: AgentConfig[] = [
        { id: 'agent-1', platform: 'chatgpt', role: 'researcher' },
        { id: 'agent-2', platform: 'gemini', role: 'summarizer' },
        { id: 'agent-3', platform: 'grok', role: 'validator' },
      ];

      const result = await orchestrator.runConsensusTask(
        'sess-e2e',
        'Compare microservices vs monolith in 2026',
        agents,
        { keyFacts: ['Latency matters'] }
      );

      expect(result.responses.length).toBe(3);
      expect(result.confidence).toBeGreaterThan(0.3);
      expect(orchestrator.getMemoryStore().getSession('sess-e2e')?.consensus).toBeDefined();
    });
  });
});
