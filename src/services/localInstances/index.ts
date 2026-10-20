export { LocalInstanceManager, getLocalInstanceManager } from './LocalInstanceManager.js'
export type { LocalInstance, LocalInstanceStatus, LocalInstanceEvent } from './LocalInstanceManager.js'
export {
  detectAllLocalPlatforms,
  getInstalledLocalPlatforms,
  detectLocalPlatform,
  waitForRunningLocalProcess,
} from './LocalInstanceDetector.js'
export {
  getClaudeDesktopMCPStatus,
  registerOpenMCPInClaudeDesktop,
  unregisterOpenMCPFromClaudeDesktop,
  isOpenMCPRegistered,
} from './ClaudeDesktopMCPConfig.js'
export {
  sendLocalPrompt,
  supportsDirectExecution,
  getInteractionMethod,
} from './LocalInteractionBridge.js'
export type { LocalPromptResult } from './LocalInteractionBridge.js'
export {
  scanAllConversations,
  scanPlatformConversations,
} from './LocalConversationDetector.js'
export type { LocalConversation, ConversationScanResult } from './LocalConversationDetector.js'
