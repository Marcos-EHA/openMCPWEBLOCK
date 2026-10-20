import { describe, expect, test } from 'bun:test'
import { getWorkspaceMCPTools } from './WorkspaceMCPTools.js'

function findTool(name: string) {
  const tool = getWorkspaceMCPTools().find(candidate => candidate.name === name)
  if (!tool) throw new Error(`Missing workspace tool "${name}".`)
  return tool
}

describe('WorkspaceMCPTools', () => {
  test('provides generic workspace access to instances for IDE clients', async () => {
    const tools = getWorkspaceMCPTools()
    expect(tools.map(tool => tool.name)).toEqual([
      'workspace_join',
      'workspace_update_presence',
      'workspace_get_state',
      'workspace_list_instances',
      'workspace_inspect_instance',
      'workspace_send_instance_prompt',
      'workspace_list_local_conversations',
      'workspace_open_local_conversation',
      'workspace_send_local_prompt',
      'workspace_assign_task',
      'workspace_poll_tasks',
      'workspace_complete_task',
      'workspace_post_message',
      'workspace_read_messages',
    ])
    expect(findTool('workspace_inspect_instance').inputSchema).toMatchObject({
      oneOf: [
        { required: ['agentId'] },
        { required: ['sourceId'] },
      ],
    })
    expect(findTool('workspace_send_local_prompt').inputSchema).toMatchObject({
      required: ['instanceId', 'conversationId', 'expectedModel', 'prompt', 'userApproved'],
    })
    await expect(findTool('workspace_send_instance_prompt').execute({
      sourceId: 'master-not-selected',
      prompt: 'hello',
      userApproved: false,
    })).rejects.toThrow('requires explicit user approval')
    await expect(findTool('workspace_send_local_prompt').execute({
      instanceId: 'local-antigravity-not-selected',
      conversationId: 'chat-id',
      expectedModel: 'Claude Opus 4.6',
      prompt: 'continue',
      userApproved: false,
    })).rejects.toThrow('requires explicit user approval')
  })

  test('supports IDE registration, workspace task delivery, completion, and messages', async () => {
    const id = `workspace-tool-test-${Date.now()}`
    const joined = JSON.parse(await findTool('workspace_join').execute({
      id,
      provider: 'vscode-copilot',
      displayName: 'Copilot in VS Code',
      capabilities: ['code', 'review'],
    }))
    expect(joined).toMatchObject({ id, status: 'online', capabilities: ['code', 'review'] })

    const task = JSON.parse(await findTool('workspace_assign_task').execute({
      participantId: id,
      prompt: 'Review this change',
    }))
    const tasks = JSON.parse(await findTool('workspace_poll_tasks').execute({ participantId: id }))
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ id: task.id, status: 'claimed' })

    const completed = JSON.parse(await findTool('workspace_complete_task').execute({
      participantId: id,
      taskId: task.id,
      response: 'Review complete.',
    }))
    expect(completed).toMatchObject({ status: 'completed', response: 'Review complete.' })
    const messages = JSON.parse(await findTool('workspace_read_messages').execute({ limit: 10 }))
    expect(messages.some((message: { participantId: string; text: string }) =>
      message.participantId === id && message.text.includes('Review complete.'),
    )).toBe(true)
  })

  test('rejects malformed workspace payloads rather than coercing them', async () => {
    await expect(findTool('workspace_join').execute({
      id: 'invalid-workspace-agent',
      provider: 'test',
      displayName: 'Invalid',
      capabilities: ['valid', 42],
    })).rejects.toThrow('capabilities must be an array of strings')
    await expect(findTool('workspace_read_messages').execute({ limit: 101 }))
      .rejects.toThrow('limit must be an integer')
  })
})
