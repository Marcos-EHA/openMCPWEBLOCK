/**
 * @openmcp/ai-consensus-engine
 * Multi-Agent AI Consensus Engine for openMCPWEBLOCK
 */

// Types
export * from './types/index.js';

// Utils
export { TextComparison } from './utils/TextComparison.js';
export { DOMAutomation } from './utils/DOMAutomation.js';

// Memory
export { SharedMemoryStore } from './memory/SharedMemoryStore.js';
export { SessionManager } from './memory/SessionManager.js';

// Adapters
export { ChatGPTAdapter } from './adapters/ChatGPTAdapter.js';
export { GeminiAdapter } from './adapters/GeminiAdapter.js';
export { GrokAdapter } from './adapters/GrokAdapter.js';

// Consensus
export { SimilarityAnalyzer } from './consensus/SimilarityAnalyzer.js';
export { KeyPointExtractor } from './consensus/KeyPointExtractor.js';
export { ConfidenceCalculator } from './consensus/ConfidenceCalculator.js';
export { ConsensusEngine } from './consensus/ConsensusEngine.js';

// Orchestrator
export { AgentPool } from './orchestrator/AgentPool.js';
export { ResponseCollector } from './orchestrator/ResponseCollector.js';
export { TaskOrchestrator } from './orchestrator/TaskOrchestrator.js';
