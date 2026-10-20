/**
 * GeminiAdapter
 * Web relay adapter for Google Gemini (Pro / Advanced)
 */

import type { AgentAdapter, AgentConfig, AgentResponse, SharedContext } from '../types/index.js';

export class GeminiAdapter implements AgentAdapter {
  readonly platform = 'gemini';
  readonly targetUrl = 'https://gemini.google.com';

  constructor(public readonly config: AgentConfig) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async sendPrompt(prompt: string, context?: SharedContext): Promise<AgentResponse> {
    const startTime = Date.now();
    // Stub implementation for scaffolding: in actual execution, routed via WebRelay / ChromeCDP
    return {
      agentId: this.config.id,
      platform: this.platform,
      content: `[Gemini Response to: ${prompt}]`,
      confidence: 0.92,
      timestamp: Date.now(),
      durationMs: Date.now() - startTime,
      metadata: { role: this.config.role, contextUsed: Boolean(context) },
    };
  }

  async close(): Promise<void> {
    // Cleanup if needed
  }
}
