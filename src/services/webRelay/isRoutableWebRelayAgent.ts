import type { AgentState } from './orchestration/types.js'

export function isRoutableWebRelayAgent(
  agent: AgentState,
  platformId?: string,
): boolean {
  return (!platformId || agent.platformId === platformId) &&
    agent.status === 'ready' &&
    Boolean(agent.instanceId) &&
    (agent.sessionMode === 'clean' || agent.sessionMode === 'authenticated' ||
      agent.sessionMode === 'chrome-profile') &&
    !agent.role?.startsWith('manual-user-')
}
