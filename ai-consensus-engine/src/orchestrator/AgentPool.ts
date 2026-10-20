/**
 * AgentPool
 * Manages active agent instances and their platform adapters
 */

import type { AgentAdapter, AgentConfig } from '../types/index.js';
import { ChatGPTAdapter } from '../adapters/ChatGPTAdapter.js';
import { GeminiAdapter } from '../adapters/GeminiAdapter.js';
import { GrokAdapter } from '../adapters/GrokAdapter.js';

export class AgentPool {
  private adapters = new Map<string, AgentAdapter>();

  /**
   * Register or instantiate an adapter for an agent config
   */
  registerAgent(config: AgentConfig): AgentAdapter {
    let adapter: AgentAdapter;
    switch (config.platform) {
      case 'chatgpt':
        adapter = new ChatGPTAdapter(config);
        break;
      case 'gemini':
        adapter = new GeminiAdapter(config);
        break;
      case 'grok':
        adapter = new GrokAdapter(config);
        break;
      default:
        // Default to ChatGPT adapter if unspecified
        adapter = new ChatGPTAdapter(config);
        break;
    }
    this.adapters.set(config.id, adapter);
    return adapter;
  }

  getAdapter(agentId: string): AgentAdapter | undefined {
    return this.adapters.get(agentId);
  }

  getAllAdapters(): AgentAdapter[] {
    return Array.from(this.adapters.values());
  }

  async closeAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      if (adapter.close) {
        await adapter.close();
      }
    }
    this.adapters.clear();
  }
}
