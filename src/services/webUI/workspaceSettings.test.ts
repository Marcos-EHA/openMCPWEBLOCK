import { describe, expect, test } from 'bun:test'
import type { ProjectConfig } from '../../utils/config.js'
import {
  applyWorkspaceSettings,
  startWorkspaceSession,
  updateMasterWorkerRegistrations,
} from './workspaceSettings.js'

function baseConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    allowedTools: [],
    mcpContextUris: [],
    projectOnboardingSeenCount: 0,
    ...overrides,
  }
}

describe('Workspace session restoration settings', () => {
  test('hides previous Master workers while preserving their restorable registration', () => {
    const fresh = applyWorkspaceSettings(baseConfig({
      webRelayMasterSessionIds: ['master-one', 'master-two'],
    }), {
      restorePreviousMasterWorkers: false,
      resumePreviousMasterSession: false,
      saveCleanContext: false,
      captureWebConversations: false,
      sentinelAutoReview: false,
      sentinelReviewAgentIds: [],
    })

    expect(fresh.webRelayMasterSessionIds).toEqual([])
    expect(fresh.webRelayPreviousMasterSessionIds).toEqual(['master-one', 'master-two'])
    expect(fresh.webRelayRestorePreviousMasterWorkers).toBe(false)
  })

  test('restores saved Master worker registrations without relaunching Chrome', () => {
    const restored = applyWorkspaceSettings(baseConfig({
      webRelayMasterSessionIds: [],
      webRelayPreviousMasterSessionIds: ['master-one', 'master-two'],
      webRelayRestorePreviousMasterWorkers: false,
    }), {
      restorePreviousMasterWorkers: true,
      resumePreviousMasterSession: true,
      saveCleanContext: false,
      captureWebConversations: false,
      sentinelAutoReview: false,
      sentinelReviewAgentIds: [],
    })

    expect(restored.webRelayMasterSessionIds).toEqual(['master-one', 'master-two'])
    expect(restored.webRelayRestorePreviousMasterWorkers).toBe(true)
    expect(restored.webRelayResumePreviousMasterSession).toBe(true)
  })

  test('keeps the existing Master worker pool when only the tab restore preference changes', () => {
    const updated = applyWorkspaceSettings(baseConfig({
      webRelayMasterSessionIds: ['master-one'],
      webRelayRestorePreviousMasterWorkers: true,
    }), {
      restorePreviousMasterWorkers: true,
      resumePreviousMasterSession: true,
      saveCleanContext: true,
      captureWebConversations: false,
      sentinelAutoReview: true,
      sentinelReviewAgentIds: ['relay-a', 'relay-b', 'relay-a'],
    })

    expect(updated.webRelayMasterSessionIds).toEqual(['master-one'])
    expect(updated.webRelaySaveCleanContext).toBe(true)
    expect(updated.webRelaySentinelReviewAgentIds).toEqual(['relay-a', 'relay-b'])
    expect(updated.webRelaySentinelAutoReview).toBe(true)
  })

  test('starts fresh on the next Workspace boot while preserving a reversible registration snapshot', () => {
    const startup = startWorkspaceSession(baseConfig({
      webRelayMasterSessionIds: ['master-one'],
      webRelayPreviousMasterSessionIds: ['master-old'],
      webRelayRestorePreviousMasterWorkers: false,
    }))

    expect(startup.webRelayMasterSessionIds).toEqual([])
    expect(startup.webRelayPreviousMasterSessionIds).toEqual(['master-old', 'master-one'])
  })

  test('updates active and saved Master worker registrations independently of SA preparation', () => {
    const prepared = updateMasterWorkerRegistrations(baseConfig({
      webRelayMasterSessionIds: ['master-one'],
      webRelayPreviousMasterSessionIds: ['master-one'],
    }), ['master-one', 'master-two'], ['master-two'])
    expect(prepared.webRelayMasterSessionIds).toEqual(['master-two'])
    expect(prepared.webRelayPreviousMasterSessionIds).toEqual(['master-two'])

    const accountOnly = updateMasterWorkerRegistrations(prepared, ['master-two'], [])
    expect(accountOnly.webRelayMasterSessionIds).toEqual([])
    expect(accountOnly.webRelayPreviousMasterSessionIds).toEqual([])
  })

  test('preserves legacy worker registrations when the restore setting has not been customized', () => {
    const legacy = baseConfig({ webRelayMasterSessionIds: ['master-one'] })
    expect(startWorkspaceSession(legacy)).toBe(legacy)
  })
})
