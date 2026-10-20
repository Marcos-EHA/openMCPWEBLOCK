import type { SimpleTool } from '../mcpServer/ToolAdapter.js'
import { workspaceParticipants } from './WorkspaceParticipants.js'
import { collaborationStore } from './CollaborationStore.js'

function requiredText(args: Record<string, unknown>, key: string, maxLength: number): string {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw new Error(`${key} must be a non-empty string no longer than ${maxLength} characters.`)
  }
  return value.trim()
}

function optionalText(args: Record<string, unknown>, key: string, maxLength: number): string | undefined {
  if (args[key] === undefined) return undefined
  if (typeof args[key] !== 'string') throw new Error(`${key} must be a string.`)
  return requiredText(args, key, maxLength)
}

async function callInstanceTool(
  toolName: 'sentinel_list_instances' | 'sentinel_inspect_instance',
  args: Record<string, unknown>,
): Promise<string> {
  const { getSentinelMCPTools } = await import('../mcpServer/SentinelMCPTools.js')
  const tool = getSentinelMCPTools().find(candidate => candidate.name === toolName)
  if (!tool) throw new Error(`Required OpenMCP instance tool "${toolName}" is not registered.`)
  const result = await tool.execute(args)
  if (typeof result === 'string') return result
  const text = result.content.find(block => block.type === 'text')
  if (text?.type === 'text') return text.text
  throw new Error(`OpenMCP instance tool "${toolName}" returned no text result.`)
}

export function getWorkspaceMCPTools(): SimpleTool[] {
  return [
    {
      name: 'workspace_join',
      description:
        'Register this IDE agent as a live participant in the shared OpenMCP workspace. ' +
        'Use a stable, provider-prefixed id (for example "vscode-copilot" or "cursor-reviewer"), ' +
        'then call workspace_poll_tasks periodically to receive work assigned from the workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Stable participant id, unique among connected IDE agents.' },
          provider: { type: 'string', description: 'IDE or agent provider, e.g. vscode-copilot, cursor, claude-code, antigravity.' },
          displayName: { type: 'string', description: 'Human-readable name shown in the workspace.' },
          capabilities: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional short list of capabilities such as code, review, terminal, or browser.',
          },
        },
        required: ['id', 'provider', 'displayName'],
      },
      execute: async args => {
        if (args.capabilities !== undefined &&
          (!Array.isArray(args.capabilities) || args.capabilities.some(item => typeof item !== 'string'))) {
          throw new Error('capabilities must be an array of strings.')
        }
        const capabilities = Array.isArray(args.capabilities)
          ? args.capabilities.filter((item): item is string => typeof item === 'string')
          : undefined
        return JSON.stringify(workspaceParticipants.join({
          id: requiredText(args, 'id', 100),
          provider: requiredText(args, 'provider', 60),
          displayName: requiredText(args, 'displayName', 100),
          capabilities,
        }))
      },
    },
    {
      name: 'workspace_update_presence',
      description: 'Update this registered IDE participant status/activity; refresh periodically to stay online.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['online', 'busy', 'idle', 'offline'] },
          activity: { type: 'string', description: 'Short public activity label, not private prompt or response content.' },
        },
        required: ['id', 'status'],
      },
      execute: async args => {
        if (typeof args.status !== 'string') throw new Error('status is required.')
        return JSON.stringify(workspaceParticipants.updatePresence({
          id: requiredText(args, 'id', 100),
          status: args.status as 'online' | 'busy' | 'idle' | 'offline',
          activity: optionalText(args, 'activity', 200),
        }))
      },
    },
    {
      name: 'workspace_get_state',
      description:
        'Read the shared workspace: connected IDE participants, Relay and Master instances, ' +
        'recent collaboration findings/requests/issues, and recent workspace messages.',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => {
        const instances = await callInstanceTool('sentinel_list_instances', {})
        return JSON.stringify({
          capturedAt: new Date().toISOString(),
          participants: workspaceParticipants.listParticipants(),
          messages: workspaceParticipants.listMessages(50),
          tasks: workspaceParticipants.listTasks(50),
          instances: typeof instances === 'string' ? JSON.parse(instances) : instances,
          collaboration: {
            snapshot: collaborationStore.getSnapshot(),
            recentEntries: collaborationStore.getAll().slice(-50),
          },
        })
      },
    },
    {
      name: 'workspace_list_instances',
      description:
        'List every registered OpenMCP Web Relay and Master Session, including verified ports and open platform tabs. ' +
        'This generic workspace tool is available to IDE agents as well as web workers.',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => callInstanceTool('sentinel_list_instances', {}),
    },
    {
      name: 'workspace_inspect_instance',
      description:
        'Inspect exactly one registered Relay (agentId) or Master Session (sourceId). ' +
        'Page conversation content is excluded unless includeConversation=true is explicitly supplied.',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: { type: 'string' },
          sourceId: { type: 'string' },
          includeConversation: { type: 'boolean' },
        },
        oneOf: [
          { required: ['agentId'], not: { required: ['sourceId'] } },
          { required: ['sourceId'], not: { required: ['agentId'] } },
        ],
      },
      execute: async args => callInstanceTool('sentinel_inspect_instance', args),
    },
    {
      name: 'workspace_send_instance_prompt',
      description:
        'Send one user-authorized prompt to an exact registered Relay or Master Session and wait for its response. ' +
        'Requires userApproved=true because the platform may trigger connected MCP tools. Never substitutes another instance.',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'Exact registered Relay agent ID.' },
          sourceId: { type: 'string', description: 'Exact registered Master Session source ID.' },
          prompt: { type: 'string' },
          userApproved: { type: 'boolean', description: 'Must be true only after the user approves this message.' },
        },
        required: ['prompt', 'userApproved'],
        oneOf: [
          { required: ['agentId'], not: { required: ['sourceId'] } },
          { required: ['sourceId'], not: { required: ['agentId'] } },
        ],
      },
      execute: async args => {
        if (args.userApproved !== true) {
          throw new Error('Sending a prompt to a web instance requires explicit user approval.')
        }
        const prompt = requiredText(args, 'prompt', 8000)
        const agentId = optionalText(args, 'agentId', 100)
        const sourceId = optionalText(args, 'sourceId', 100)
        if (Boolean(agentId) === Boolean(sourceId)) {
          throw new Error('Provide exactly one registered agentId or Master Session sourceId.')
        }
        if (sourceId) {
          const { sendMasterSessionPrompt } = await import('../webRelay/session/MasterSessionConversation.js')
          return sendMasterSessionPrompt(sourceId, prompt)
        }

        const { listAgents } = await import('../webRelay/orchestration/MultiAgentRunner.js')
        const agent = listAgents().find(item => item.agentId === agentId)
        if (!agent || agent.status !== 'ready') {
          throw new Error(`Relay "${agentId}" is not registered and ready.`)
        }
        const { sendWebPrompt } = await import('../webRelay/WebRelayProvider.js')
        return sendWebPrompt(prompt, agent.platformId, agent.agentId)
      },
    },
    {
      name: 'workspace_list_local_conversations',
      description:
        'List indexed conversations for one exact, ready local Antigravity instance. ' +
        'Models are marked unverified until workspace_open_local_conversation loads that chat in Antigravity.',
      inputSchema: {
        type: 'object',
        properties: {
          instanceId: { type: 'string', description: 'Exact local Antigravity instance ID.' },
        },
        required: ['instanceId'],
      },
      execute: async args => {
        const instanceId = requiredText(args, 'instanceId', 100)
        const { getLocalInstanceManager } = await import('../localInstances/LocalInstanceManager.js')
        const instance = getLocalInstanceManager().getInstance(instanceId)
        if (!instance || instance.platformId !== 'antigravity' || instance.status !== 'ready') {
          throw new Error(`Local Antigravity instance "${instanceId}" is not registered and ready.`)
        }
        const { scanPlatformConversations } = await import('../localInstances/LocalConversationDetector.js')
        return JSON.stringify(await scanPlatformConversations('antigravity', process.cwd(), 100))
      },
    },
    {
      name: 'workspace_open_local_conversation',
      description:
        'Load one indexed conversation in an exact local Antigravity instance and return the model shown by Antigravity. ' +
        'Use this before sending so the orchestrator does not guess which model the conversation uses.',
      inputSchema: {
        type: 'object',
        properties: {
          instanceId: { type: 'string', description: 'Exact local Antigravity instance ID.' },
          conversationId: { type: 'string', description: 'Conversation ID from workspace_list_local_conversations.' },
        },
        required: ['instanceId', 'conversationId'],
      },
      execute: async args => {
        const instanceId = requiredText(args, 'instanceId', 100)
        const conversationId = requiredText(args, 'conversationId', 128)
        const { getLocalInstanceManager } = await import('../localInstances/LocalInstanceManager.js')
        const instance = getLocalInstanceManager().getInstance(instanceId)
        if (!instance || instance.platformId !== 'antigravity' || instance.status !== 'ready') {
          throw new Error(`Local Antigravity instance "${instanceId}" is not registered and ready.`)
        }
        const { openAntigravityConversation } = await import('../localInstances/AntigravityController.js')
        return JSON.stringify(await openAntigravityConversation(instance, conversationId))
      },
    },
    {
      name: 'workspace_send_local_prompt',
      description:
        'Send one explicitly user-approved prompt to a selected conversation in one exact local Antigravity instance. ' +
        'Supply the model returned by workspace_open_local_conversation as expectedModel. Returns the real agent response when captured; ' +
        'if it is still pending, do not resend because the prompt may already have been delivered.',
      inputSchema: {
        type: 'object',
        properties: {
          instanceId: { type: 'string', description: 'Exact local Antigravity instance ID.' },
          conversationId: { type: 'string', description: 'Exact conversation ID returned or opened in Antigravity.' },
          expectedModel: { type: 'string', description: 'Model returned by the most recent workspace_open_local_conversation call.' },
          prompt: { type: 'string', description: 'Prompt text to send verbatim.' },
          userApproved: { type: 'boolean', description: 'Must be true only after the user approves sending this exact prompt.' },
        },
        required: ['instanceId', 'conversationId', 'expectedModel', 'prompt', 'userApproved'],
      },
      execute: async args => {
        if (args.userApproved !== true) {
          throw new Error('Sending a prompt to a local Antigravity conversation requires explicit user approval.')
        }
        const instanceId = requiredText(args, 'instanceId', 100)
        const conversationId = requiredText(args, 'conversationId', 128)
        const expectedModel = requiredText(args, 'expectedModel', 200)
        const prompt = requiredText(args, 'prompt', 8000)
        const { sendLocalPrompt } = await import('../localInstances/LocalInteractionBridge.js')
        const result = await sendLocalPrompt(instanceId, prompt, conversationId, expectedModel)
        if (!result.ok) throw new Error(result.error || 'The local Antigravity prompt could not be sent.')
        return JSON.stringify(result)
      },
    },
    {
      name: 'workspace_assign_task',
      description: 'Assign a task to a registered, online IDE participant in this workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          participantId: { type: 'string' },
          prompt: { type: 'string' },
        },
        required: ['participantId', 'prompt'],
      },
      execute: async args => JSON.stringify(workspaceParticipants.assignTask(
        requiredText(args, 'participantId', 100),
        requiredText(args, 'prompt', 8000),
      )),
    },
    {
      name: 'workspace_poll_tasks',
      description: 'Claim and return pending tasks assigned specifically to this IDE participant.',
      inputSchema: {
        type: 'object',
        properties: { participantId: { type: 'string' } },
        required: ['participantId'],
      },
      execute: async args => JSON.stringify(workspaceParticipants.claimTasks(
        requiredText(args, 'participantId', 100),
      )),
    },
    {
      name: 'workspace_complete_task',
      description: 'Return the result or an explicit error for a task claimed by this IDE participant.',
      inputSchema: {
        type: 'object',
        properties: {
          participantId: { type: 'string' },
          taskId: { type: 'string' },
          response: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['participantId', 'taskId'],
      },
      execute: async args => JSON.stringify(workspaceParticipants.completeTask({
        participantId: requiredText(args, 'participantId', 100),
        taskId: requiredText(args, 'taskId', 100),
        response: optionalText(args, 'response', 12_000),
        error: optionalText(args, 'error', 2000),
      })),
    },
    {
      name: 'workspace_post_message',
      description: 'Post a message to the shared workspace conversation as this registered IDE participant.',
      inputSchema: {
        type: 'object',
        properties: {
          participantId: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['participantId', 'text'],
      },
      execute: async args => JSON.stringify(workspaceParticipants.postMessage(
        requiredText(args, 'participantId', 100),
        requiredText(args, 'text', 4000),
      )),
    },
    {
      name: 'workspace_read_messages',
      description: 'Read recent shared workspace messages, optionally after a timestamp.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Maximum number of messages (1-100; defaults to 50).' },
          afterTimestamp: { type: 'number', description: 'Return only messages newer than this epoch timestamp.' },
        },
      },
      execute: async args => {
        const limit = args.limit ?? 50
        const afterTimestamp = args.afterTimestamp ?? 0
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) {
          throw new Error('limit must be an integer between 1 and 100.')
        }
        if (typeof afterTimestamp !== 'number' || !Number.isFinite(afterTimestamp) || afterTimestamp < 0) {
          throw new Error('afterTimestamp must be a non-negative number.')
        }
        return JSON.stringify(workspaceParticipants.listMessages(limit, afterTimestamp))
      },
    },
  ]
}
