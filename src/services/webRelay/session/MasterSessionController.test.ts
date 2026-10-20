import { describe, expect, mock, test } from 'bun:test'
import { createMasterSessionController } from './MasterSessionController.js'

describe('MasterSessionController', () => {
  const createController = () => {
    const sequence: string[] = []
    const source = {
      id: 'test-master',
      name: 'Test Master',
      profileDir: 'master-session-test',
      debugPort: 9400,
      platformId: 'claude' as const,
    }
    const ensureMasterSessionRunning = mock(async () => source.debugPort)
    const getPlatformUrl = mock(() => 'https://claude.ai/')
    const hasRestorablePlatformPage = mock(async () => false)
    const navigateRelayPage = mock(async () => { sequence.push('navigate') })
    const getMasterSessionStatus = mock(async () => {
      sequence.push('status')
      return { hasValidSession: true }
    })
    const prepareSuperAssistant = mock(async () => { sequence.push('prepare-sa') })
    const controller = createMasterSessionController({
      ensureMasterSessionRunning,
      getMasterSessionSource: () => source,
      getPlatformUrl,
      hasRestorablePlatformPage,
      navigateRelayPage,
      getMasterSessionStatus,
      prepareSuperAssistant,
    })
    return {
      controller,
      source,
      ensureMasterSessionRunning,
      getPlatformUrl,
      hasRestorablePlatformPage,
      navigateRelayPage,
      getMasterSessionStatus,
      prepareSuperAssistant,
      sequence,
    }
  }

  test('prepares and verifies SuperAssistant for a default Master Session open', async () => {
    const deps = createController()

    const result = await deps.controller.openMasterSessionSource(deps.source.id)

    expect(deps.ensureMasterSessionRunning).toHaveBeenCalledWith(deps.source.id, {
      restorePreviousSession: false,
    })
    expect(deps.getPlatformUrl).toHaveBeenCalledWith(deps.source.platformId)
    expect(deps.navigateRelayPage).toHaveBeenCalledWith(deps.source.debugPort, 'https://claude.ai/')
    expect(deps.getMasterSessionStatus).toHaveBeenCalledWith(deps.source.id)
    expect(deps.prepareSuperAssistant).toHaveBeenCalledWith(deps.source.debugPort, deps.source.platformId)
    expect(result).toEqual({
      sourceId: deps.source.id,
      sourceName: deps.source.name,
      debugPort: deps.source.debugPort,
      authenticated: true,
      superAssistantReady: true,
    })
  })

  test('prepares SuperAssistant before checking authentication or reporting success', async () => {
    const deps = createController()

    const result = await deps.controller.openMasterSessionSource(deps.source.id)

    expect(deps.prepareSuperAssistant).toHaveBeenCalledWith(deps.source.debugPort, deps.source.platformId)
    expect(deps.getMasterSessionStatus).toHaveBeenCalledWith(deps.source.id)
    expect(deps.sequence).toEqual(['navigate', 'prepare-sa', 'status'])
    expect(result.superAssistantReady).toBe(true)
  })

  test('does not report the Master Session ready when SuperAssistant preparation fails', async () => {
    const deps = createController()
    deps.prepareSuperAssistant.mockRejectedValue(new Error('SA setup failed'))

    await expect(deps.controller.openMasterSessionSource(deps.source.id))
      .rejects.toThrow('SA setup failed')
    expect(deps.getMasterSessionStatus).not.toHaveBeenCalled()
  })

  test('preserves the previous platform tab when session restoration is enabled', async () => {
    const deps = createController()
    deps.hasRestorablePlatformPage.mockResolvedValue(true)

    const result = await deps.controller.openMasterSessionSource(deps.source.id, {
      resumePreviousConversation: true,
    })

    expect(deps.ensureMasterSessionRunning).toHaveBeenCalledWith(deps.source.id, {
      restorePreviousSession: true,
    })
    expect(deps.hasRestorablePlatformPage).toHaveBeenCalledWith(deps.source.debugPort, deps.source.platformId)
    expect(deps.navigateRelayPage).not.toHaveBeenCalled()
    expect(deps.prepareSuperAssistant).toHaveBeenCalledWith(deps.source.debugPort, deps.source.platformId)
    expect(result.superAssistantReady).toBe(true)
  })

  test('opens the platform home page when no restorable platform tab exists', async () => {
    const deps = createController()

    await deps.controller.openMasterSessionSource(deps.source.id, {
      resumePreviousConversation: true,
    })

    expect(deps.navigateRelayPage).toHaveBeenCalledWith(deps.source.debugPort, 'https://claude.ai/')
  })
})
