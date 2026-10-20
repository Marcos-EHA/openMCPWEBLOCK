/**
 * index.ts — Exports públicos para la superficie de colaboración.
 */

export {
  SurfaceMode,
  CuratedContent,
  CuratedItem,
  CuratedItemStatus,
  CuratedMessage,
  CuratedAnomaly,
  SurfaceConfig,
  UserProfile,
  DetailLevel,
  DEFAULT_CONFIG,
  CuratorEvent,
  formatElapsed,
  makeFriendlyName,
} from './types.js'

export {
  SentinelCurator,
  getSentinelCurator,
} from './SentinelCurator.js'

export {
  initializeCollaboration,
  CollaborationIntegration,
} from './integration.js'

export { CollaborationSurface } from '../../components/CollaborationSurface.js'