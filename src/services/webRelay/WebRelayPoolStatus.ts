import type { AgentState } from './orchestration/types.js'
import { isRoutableWebRelayAgent } from './isRoutableWebRelayAgent.js'
import { isWebCoordinatorRole, isWorkspacePoolRelay } from './launchPolicy.js'

export type WebRelayPoolIssue = 'empty-pool' | 'no-coordinator' | 'missing-worker'

export interface WebRelayPoolStatus {
  configuredCount: number
  availableAgents: AgentState[]
  coordinators: AgentState[]
  coordinator?: AgentState
  workerCount: number
  unavailableCount: number
  issue?: WebRelayPoolIssue
}

export function getWebRelayPoolStatus(
  agents: AgentState[],
  platformId: string,
  configuredAgentIds: ReadonlySet<string>,
  coordinatorAgentId?: string,
  orchestratorBrain: 'api' | 'web' = 'web',
): WebRelayPoolStatus {
  const excludedIds = new Set(
    agents.filter(agent => !isWorkspacePoolRelay(agent)).map(agent => agent.agentId),
  )
  const workspaceConfiguredIds = new Set(
    [...configuredAgentIds].filter(agentId => !excludedIds.has(agentId)),
  )
  const availableAgents = agents.filter(agent =>
    workspaceConfiguredIds.has(agent.agentId) &&
    isWorkspacePoolRelay(agent) &&
    isRoutableWebRelayAgent(agent, platformId),
  )
  const coordinators = availableAgents.filter(agent => isWebCoordinatorRole(agent.role))
  const coordinator = orchestratorBrain === 'api'
    ? undefined
    : coordinatorAgentId
      ? coordinators.find(agent => agent.agentId === coordinatorAgentId) ??
        coordinators.find(agent => agent.role === 'primary') ??
        coordinators[0]
      : coordinators.find(agent => agent.role === 'primary') ?? coordinators[0]
  const workerCount = orchestratorBrain === 'api'
    ? availableAgents.length
    : availableAgents.filter(agent => !isWebCoordinatorRole(agent.role)).length
  const issue: WebRelayPoolIssue | undefined =
    availableAgents.length === 0
      ? 'empty-pool'
      : orchestratorBrain === 'api'
        ? undefined
        : coordinators.length === 0
          ? 'no-coordinator'
          : workerCount === 0
            ? 'missing-worker'
            : undefined

  return {
    configuredCount: workspaceConfiguredIds.size,
    availableAgents,
    coordinators,
    coordinator,
    workerCount,
    unavailableCount: workspaceConfiguredIds.size - availableAgents.length,
    issue,
  }
}
