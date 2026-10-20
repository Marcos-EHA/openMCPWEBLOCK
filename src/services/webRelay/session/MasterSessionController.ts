import { navigateRelayPage } from '../ChromeCDP.js'
import { ensureMasterSessionRunning, hasRestorableMasterPage, SessionBroker } from './SessionBroker.js'
import { getMasterSessionSource, type MasterSessionSource } from './MasterSessionRegistry.js'
import { getWebPlatformById } from '../../../utils/webPlatforms.js'

export interface MasterSessionOpenOptions {
  resumePreviousConversation?: boolean
}

interface MasterSessionControllerDependencies {
  ensureMasterSessionRunning: (
    sourceId: string,
    options?: { restorePreviousSession?: boolean },
  ) => Promise<number>
  getMasterSessionSource: typeof getMasterSessionSource
  getPlatformUrl: (platformId: string) => string | undefined
  hasRestorablePlatformPage: (
    debugPort: number,
    platformId: MasterSessionSource['platformId'],
  ) => Promise<boolean>
  navigateRelayPage: (debugPort: number, url: string) => Promise<void>
  getMasterSessionStatus: (sourceId: string) => Promise<{ hasValidSession: boolean }>
  prepareSuperAssistant: (debugPort: number, platformId: string) => Promise<void>
}

type MasterSessionOpenResult = {
  sourceId: string
  sourceName: string
  debugPort: number
  authenticated: boolean
  superAssistantReady: boolean
}

export function createMasterSessionController(dependencies: MasterSessionControllerDependencies) {
  const openingSources = new Map<string, Promise<MasterSessionOpenResult>>()

  async function launchMasterSessionSource(
    sourceId: string,
    options: MasterSessionOpenOptions,
  ): Promise<MasterSessionOpenResult> {
    const source = dependencies.getMasterSessionSource(sourceId)
    const resumePreviousConversation = options.resumePreviousConversation === true
    const debugPort = await dependencies.ensureMasterSessionRunning(sourceId, {
      restorePreviousSession: resumePreviousConversation,
    })
    const platformUrl = dependencies.getPlatformUrl(source.platformId)
    if (!platformUrl) throw new Error(`Unsupported Master Session platform "${source.platformId}".`)

    const hasPreviousPlatformPage = resumePreviousConversation &&
      await dependencies.hasRestorablePlatformPage(debugPort, source.platformId)
    if (!hasPreviousPlatformPage) {
      await dependencies.navigateRelayPage(debugPort, platformUrl)
    }
    await dependencies.prepareSuperAssistant(debugPort, source.platformId)

    const status = await dependencies.getMasterSessionStatus(sourceId)
    return {
      sourceId,
      sourceName: source.name,
      debugPort,
      authenticated: status.hasValidSession,
      superAssistantReady: true,
    }
  }

  return {
    openMasterSessionSource(
      sourceId: string,
      options: MasterSessionOpenOptions = {},
    ): Promise<MasterSessionOpenResult> {
      const openKey = [
        sourceId,
        options.resumePreviousConversation === true ? 'restore' : 'fresh',
      ].join(':')
      const pending = openingSources.get(openKey)
      if (pending) return pending

      const opening = launchMasterSessionSource(sourceId, options).finally(() => {
        if (openingSources.get(openKey) === opening) openingSources.delete(openKey)
      })
      openingSources.set(openKey, opening)
      return opening
    },
  }
}

const masterSessionController = createMasterSessionController({
  ensureMasterSessionRunning,
  getMasterSessionSource,
  getPlatformUrl: platformId => getWebPlatformById(platformId)?.url,
  hasRestorablePlatformPage: hasRestorableMasterPage,
  navigateRelayPage,
  getMasterSessionStatus: sourceId => SessionBroker.getInstance().getMasterStatus(sourceId),
  prepareSuperAssistant: async (debugPort, platformId) => {
    const { prepareSAAgentForWebRelay } = await import('../WebRelayProvider.js')
    await prepareSAAgentForWebRelay(debugPort, undefined, platformId)
  },
})

export const { openMasterSessionSource } = masterSessionController
