import type { AgentState } from './orchestration/types.js'

export interface RequestedRelay {
  agentId: string
  sessionMode: AgentState['sessionMode']
}

export interface RelayLaunchCoordinationOptions {
  purpose: 'agent' | 'user'
  orchestratorBrain: 'api' | 'web'
  coordinateTasks?: boolean
  launchCoordinator?: boolean
}

export interface RelayLaunchCoordination {
  coordinateTasks: boolean
  launchCoordinator: boolean
}

export function isWebCoordinatorRole(role: string | undefined): boolean {
  return role === 'primary' || /^orchestrator-\d+$/.test(role ?? '')
}

export function resolveRelayLaunchCoordination(
  options: RelayLaunchCoordinationOptions,
): RelayLaunchCoordination {
  const { purpose, orchestratorBrain } = options
  if (purpose === 'user') {
    if (options.coordinateTasks === true || options.launchCoordinator === true) {
      throw new Error('User mode is for manual conversations and does not launch an orchestrator.')
    }
    return { coordinateTasks: false, launchCoordinator: false }
  }

  if (orchestratorBrain === 'web' && options.launchCoordinator === false) {
    throw new Error('The Web orchestrator requires a dedicated Relay coordinator.')
  }
  if (orchestratorBrain === 'api' && options.launchCoordinator === true) {
    throw new Error('The API orchestrator does not reserve a Relay; all launched instances are workers.')
  }
  const coordinateTasks = options.coordinateTasks ?? (
    orchestratorBrain === 'api' || options.launchCoordinator !== false
  )
  if (!coordinateTasks) {
    throw new Error('Agent mode always requires an orchestrator. Choose the API brain or launch a dedicated Web coordinator.')
  }
  return {
    coordinateTasks,
    launchCoordinator: orchestratorBrain === 'web',
  }
}

export function isWorkspacePoolRelay(agent: AgentState): boolean {
  return !agent.role?.startsWith('manual-user-') &&
    !agent.role?.startsWith('sentinel-guest-') &&
    !agent.agentId.startsWith('sentinel-')
}

export function selectStartupReadyRelays(
  states: AgentState[],
  requestedRelays: RequestedRelay[],
): AgentState[] {
  const requestedById = new Map(requestedRelays.map(relay => [relay.agentId, relay]))
  return states.filter(state =>
    state.status === 'ready' &&
    Boolean(state.debugPort) &&
    state.sessionMode === requestedById.get(state.agentId)?.sessionMode,
  )
}

export function selectConfiguredReadyRelays(
  states: AgentState[],
  configuredAgentIds: string[],
): AgentState[] {
  const configuredIds = new Set(configuredAgentIds)
  return states.filter(state =>
    state.status === 'ready' &&
    isWorkspacePoolRelay(state) &&
    configuredIds.has(state.agentId),
  )
}

export function getMinimumRelayCount(
  purpose: 'agent' | 'user',
  launchCoordinator = true,
): number {
  return purpose === 'agent' && launchCoordinator ? 2 : 1
}
