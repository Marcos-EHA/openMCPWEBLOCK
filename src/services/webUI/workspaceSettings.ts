import type { ProjectConfig } from '../../utils/config.js'

export interface WorkspaceSettings {
  restorePreviousMasterWorkers: boolean
  resumePreviousMasterSession: boolean
  saveCleanContext: boolean
  captureWebConversations: boolean
  sentinelAutoReview: boolean
  sentinelReviewAgentIds: string[]
}

export function updateMasterWorkerRegistrations(
  config: ProjectConfig,
  selectedSourceIds: string[],
  preparedSourceIds: string[],
): ProjectConfig {
  const currentWorkerIds = config.webRelayMasterSessionIds ?? []
  const previousWorkerIds = config.webRelayPreviousMasterSessionIds ?? currentWorkerIds
  const selected = new Set(selectedSourceIds)

  return {
    ...config,
    webRelayMasterSessionIds: [
      ...currentWorkerIds.filter(id => !selected.has(id)),
      ...preparedSourceIds,
    ],
    webRelayPreviousMasterSessionIds: [
      ...previousWorkerIds.filter(id => !selected.has(id)),
      ...preparedSourceIds,
    ],
  }
}

export function applyWorkspaceSettings(
  config: ProjectConfig,
  settings: WorkspaceSettings,
): ProjectConfig {
  const currentWorkerIds = [...new Set(config.webRelayMasterSessionIds ?? [])]
  let previousWorkerIds = [...new Set(
    config.webRelayPreviousMasterSessionIds ?? currentWorkerIds,
  )]
  const wasRestoringWorkers = config.webRelayRestorePreviousMasterWorkers !== false
  let nextWorkerIds = currentWorkerIds

  if (settings.restorePreviousMasterWorkers !== wasRestoringWorkers) {
    if (settings.restorePreviousMasterWorkers) {
      nextWorkerIds = previousWorkerIds
    } else {
      previousWorkerIds = [...new Set([...previousWorkerIds, ...currentWorkerIds])]
      nextWorkerIds = []
    }
  }

  return {
    ...config,
    webRelayMasterSessionIds: nextWorkerIds,
    webRelayPreviousMasterSessionIds: previousWorkerIds,
    webRelayRestorePreviousMasterWorkers: settings.restorePreviousMasterWorkers,
    webRelayResumePreviousMasterSession: settings.resumePreviousMasterSession,
    webRelaySaveCleanContext: settings.saveCleanContext,
    webRelayCaptureWebConversations: settings.captureWebConversations,
    webRelaySentinelAutoReview: settings.sentinelAutoReview,
    webRelaySentinelReviewAgentIds: [...new Set(settings.sentinelReviewAgentIds)],
  }
}

export function startWorkspaceSession(config: ProjectConfig): ProjectConfig {
  if (config.webRelayRestorePreviousMasterWorkers !== false) return config

  const currentWorkerIds = [...new Set(config.webRelayMasterSessionIds ?? [])]
  if (currentWorkerIds.length === 0) return config

  return {
    ...config,
    webRelayMasterSessionIds: [],
    webRelayPreviousMasterSessionIds: [...new Set([
      ...(config.webRelayPreviousMasterSessionIds ?? []),
      ...currentWorkerIds,
    ])],
  }
}
