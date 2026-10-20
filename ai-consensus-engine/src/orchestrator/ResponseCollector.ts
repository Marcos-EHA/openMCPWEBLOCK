/**
 * ResponseCollector
 * Handles parallel collection of responses, completion detection, and timeouts
 */

import type { AgentResponse } from '../types/index.js';

export class ResponseCollector {
  private responses = new Map<string, AgentResponse>();

  addResponse(response: AgentResponse): void {
    this.responses.set(response.agentId, response);
  }

  isResponseComplete(responseContent: string): boolean {
    if (!responseContent || responseContent.trim().length === 0) return false;
    // Check basic completion heuristic: not ending in unclosed codeblock or ellipsis
    const trimmed = responseContent.trim();
    if (trimmed.endsWith('...') || trimmed.endsWith('…')) return false;
    return true;
  }

  getCollectedResponses(): AgentResponse[] {
    return Array.from(this.responses.values());
  }

  hasAllResponses(expectedAgentIds: string[]): boolean {
    return expectedAgentIds.every(id => this.responses.has(id));
  }

  clear(): void {
    this.responses.clear();
  }
}
