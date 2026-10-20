import { describe, expect, test } from 'bun:test'
import { WorkspaceParticipants } from './WorkspaceParticipants.js'

describe('WorkspaceParticipants', () => {
  test('registers IDE agents, tracks heartbeat status, and reports stale agents offline', () => {
    let now = 1000
    const workspace = new WorkspaceParticipants(() => now)
    const participant = workspace.join({
      id: 'vscode-copilot',
      provider: 'copilot',
      displayName: 'Copilot in VS Code',
      capabilities: ['code', 'review'],
    })
    expect(participant.status).toBe('online')
    expect(workspace.updatePresence({ id: participant.id, status: 'busy', activity: 'reviewing' }).activity)
      .toBe('reviewing')

    now += 61_000
    expect(workspace.listParticipants()[0].status).toBe('offline')
    expect(workspace.join({
      id: participant.id,
      provider: 'copilot',
      displayName: participant.displayName,
    }).status).toBe('online')
  })

  test('routes tasks only to the selected participant and returns completion state', () => {
    const workspace = new WorkspaceParticipants()
    workspace.join({ id: 'cursor-agent', provider: 'cursor', displayName: 'Cursor' })
    workspace.join({ id: 'claude-code', provider: 'claude-code', displayName: 'Claude Code' })

    const task = workspace.assignTask('cursor-agent', 'Review the workspace API')
    expect(workspace.claimTasks('claude-code')).toEqual([])
    expect(workspace.claimTasks('cursor-agent').map(item => item.id)).toEqual([task.id])
    expect(workspace.claimTasks('cursor-agent')).toEqual([])
    expect(workspace.completeTask({
      participantId: 'cursor-agent',
      taskId: task.id,
      response: 'API reviewed.',
    })).toMatchObject({ status: 'completed', response: 'API reviewed.' })
  })

  test('assigns one task per online participant under a shared collaboration ID', () => {
    const workspace = new WorkspaceParticipants()
    workspace.join({ id: 'vscode-agent', provider: 'copilot', displayName: 'VS Code' })
    workspace.join({ id: 'cursor-agent', provider: 'cursor', displayName: 'Cursor' })

    const tasks = workspace.assignTaskToParticipants(
      ['vscode-agent', 'cursor-agent'],
      'Review the shared implementation',
    )

    expect(tasks).toHaveLength(2)
    expect(new Set(tasks.map(task => task.id)).size).toBe(2)
    expect(tasks.map(task => task.participantId)).toEqual(['vscode-agent', 'cursor-agent'])
    expect(tasks.map(task => task.collaborationId)).toEqual([
      expect.any(String),
      tasks[0].collaborationId,
    ])
    expect(tasks[0].collaborationId).toBeTruthy()
    expect(tasks.every(task => task.status === 'pending' && task.prompt === 'Review the shared implementation')).toBe(true)
  })

  test('rejects duplicate or offline group targets without partially assigning tasks', () => {
    const workspace = new WorkspaceParticipants()
    workspace.join({ id: 'online-agent', provider: 'copilot', displayName: 'Online' })
    workspace.join({ id: 'offline-agent', provider: 'cursor', displayName: 'Offline' })
    workspace.updatePresence({ id: 'offline-agent', status: 'offline' })

    expect(() => workspace.assignTaskToParticipants(
      ['online-agent', 'online-agent'],
      'Review the shared implementation',
    )).toThrow('IDs must be unique')
    expect(() => workspace.assignTaskToParticipants(
      ['online-agent', 'offline-agent'],
      'Review the shared implementation',
    )).toThrow('is offline')
    expect(workspace.listTasks()).toEqual([])
    expect(() => workspace.assignTaskToParticipants([], 'No recipients')).toThrow('between 1 and 20')
    expect(() => workspace.assignTaskToParticipants(
      Array.from({ length: 21 }, (_, index) => `agent-${index}`),
      'Too many recipients',
    )).toThrow('between 1 and 20')
  })

  test('rejects offline task targets and completion by a different participant', () => {
    const workspace = new WorkspaceParticipants()
    workspace.join({ id: 'agent-one', provider: 'test', displayName: 'Agent One' })
    workspace.join({ id: 'agent-two', provider: 'test', displayName: 'Agent Two' })
    workspace.updatePresence({ id: 'agent-one', status: 'offline' })
    expect(() => workspace.assignTask('agent-one', 'Do work')).toThrow('is offline')

    workspace.updatePresence({ id: 'agent-one', status: 'online' })
    const task = workspace.assignTask('agent-one', 'Do work')
    workspace.claimTasks('agent-one')
    expect(() => workspace.completeTask({
      participantId: 'agent-two',
      taskId: task.id,
      response: 'Not allowed',
    })).toThrow('is not assigned')
  })

  test('publishes workspace messages to subscribers and limits message sizes', () => {
    const workspace = new WorkspaceParticipants()
    const participant = workspace.join({
      id: 'antigravity',
      provider: 'antigravity',
      displayName: 'Antigravity',
    })
    const events: string[] = []
    workspace.subscribe(event => events.push(event.type))
    const message = workspace.postMessage(participant.id, 'Findings ready.')
    expect(workspace.listMessages()).toContainEqual(message)
    expect(events).toEqual(['message'])
    expect(() => workspace.postMessage(participant.id, ' '.repeat(4001))).toThrow('text must contain')
  })
})
