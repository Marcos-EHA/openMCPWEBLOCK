import { sendWebPromptToMaster } from '../WebRelayProvider.js'
import { findActiveMasterPort, SessionBroker } from './SessionBroker.js'
import { getMasterSessionSource } from './MasterSessionRegistry.js'
import { randomUUID } from 'node:crypto'
import {
  getWorkspaceContextInstruction,
  workspaceContextJournal,
} from '../WorkspaceContextJournal.js'

interface MasterSessionConversationDependencies {
  findActiveMasterPort: (sourceId: string) => Promise<number | null>
  getMasterSessionSource: typeof getMasterSessionSource
  getMasterSessionStatus: (sourceId: string) => Promise<{ hasValidSession: boolean; reason?: string }>
  sendPrompt: (
    prompt: string,
    platformId: string,
    sourceId: string,
    debugPort: number,
  ) => Promise<string>
}

export function createMasterSessionConversation(dependencies: MasterSessionConversationDependencies) {
  return async function sendMasterSessionPrompt(sourceId: string, prompt: string): Promise<string> {
    const normalizedPrompt = prompt.trim()
    if (!normalizedPrompt) {
      throw new Error('A non-empty prompt is required for a Master Session conversation.')
    }

    const source = dependencies.getMasterSessionSource(sourceId)
    const taskId = randomUUID()
    const generation = workspaceContextJournal.getGeneration()
    const promptWithContext = `${normalizedPrompt}${getWorkspaceContextInstruction()}`
    try {
      const debugPort = await dependencies.findActiveMasterPort(sourceId)
      if (debugPort === null) {
        throw new Error(
          `Master Session "${source.name}" (${source.id}) is not open. ` +
          `Open it with /mcp master-session open ${source.id}, then try the message again.`,
        )
      }

      const status = await dependencies.getMasterSessionStatus(sourceId)
      if (!status.hasValidSession) {
        throw new Error(
          `Master Session "${source.name}" (${source.id}) is not authenticated. ` +
          `${status.reason ?? 'Sign in to the platform in that Master window, then retry.'}`,
        )
      }

      workspaceContextJournal.record({
        type: 'agent-task',
        source: 'master-session',
        role: 'user',
        platformId: source.platformId,
        agentId: `master-session:${source.id}`,
        taskId,
        text: promptWithContext,
      }, generation)
      const response = await dependencies.sendPrompt(
        promptWithContext,
        source.platformId,
        source.id,
        debugPort,
      )
      workspaceContextJournal.record({
        type: 'agent-message',
        source: 'master-session',
        role: 'assistant',
        platformId: source.platformId,
        agentId: `master-session:${source.id}`,
        taskId,
        text: response,
      }, generation)
      return response
    } catch (error) {
      workspaceContextJournal.record({
        type: 'agent-error',
        source: 'master-session',
        role: 'system',
        platformId: source.platformId,
        agentId: `master-session:${source.id}`,
        taskId,
        text: error instanceof Error ? error.message : String(error),
        success: false,
      }, generation)
      throw error
    }
  }
}

export const sendMasterSessionPrompt = createMasterSessionConversation({
  findActiveMasterPort,
  getMasterSessionSource,
  getMasterSessionStatus: sourceId => SessionBroker.getInstance().getMasterStatus(sourceId),
  sendPrompt: sendWebPromptToMaster,
})
