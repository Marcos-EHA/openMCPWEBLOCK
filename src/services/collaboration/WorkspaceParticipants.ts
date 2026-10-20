import { randomUUID } from 'crypto'

export type WorkspaceParticipantStatus = 'online' | 'busy' | 'idle' | 'offline'
export type WorkspaceTaskStatus = 'pending' | 'claimed' | 'completed' | 'failed'

export interface WorkspaceParticipant {
  id: string
  provider: string
  displayName: string
  capabilities: string[]
  status: WorkspaceParticipantStatus
  activity?: string
  registeredAt: number
  lastSeenAt: number
}

export interface WorkspaceTask {
  id: string
  participantId: string
  collaborationId?: string
  prompt: string
  status: WorkspaceTaskStatus
  createdAt: number
  claimedAt?: number
  completedAt?: number
  response?: string
  error?: string
}

export interface WorkspaceMessage {
  id: string
  participantId: string
  displayName: string
  text: string
  timestamp: number
}

export type WorkspaceParticipantEvent =
  | { type: 'participant'; participant: WorkspaceParticipant }
  | { type: 'task'; task: WorkspaceTask }
  | { type: 'message'; message: WorkspaceMessage }

const HEARTBEAT_TIMEOUT_MS = 60_000
const MAX_TASKS = 500
const MAX_MESSAGES = 500

function requireText(value: string, field: string, maxLength: number): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${field} must contain between 1 and ${maxLength} characters.`)
  }
  return normalized
}

function copyParticipant(participant: WorkspaceParticipant, now: number): WorkspaceParticipant {
  const status = now - participant.lastSeenAt > HEARTBEAT_TIMEOUT_MS &&
    (participant.status === 'online' || participant.status === 'busy')
    ? 'offline'
    : participant.status
  return { ...participant, status, capabilities: [...participant.capabilities] }
}

export class WorkspaceParticipants {
  private participants = new Map<string, WorkspaceParticipant>()
  private tasks: WorkspaceTask[] = []
  private messages: WorkspaceMessage[] = []
  private listeners = new Set<(event: WorkspaceParticipantEvent) => void>()

  constructor(private readonly now: () => number = Date.now) {}

  join(input: {
    id: string
    provider: string
    displayName: string
    capabilities?: string[]
  }): WorkspaceParticipant {
    const id = requireText(input.id, 'id', 100)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(id)) {
      throw new Error('id may contain only letters, numbers, ".", "_", ":", and "-".')
    }
    const provider = requireText(input.provider, 'provider', 60)
    const displayName = requireText(input.displayName, 'displayName', 100)
    if (input.capabilities !== undefined && !Array.isArray(input.capabilities)) {
      throw new Error('capabilities must be an array of strings.')
    }
    const capabilities = [...new Set((input.capabilities ?? []).map(capability =>
      requireText(capability, 'capability', 100),
    ))].slice(0, 30)
    const previous = this.participants.get(id)
    const timestamp = this.now()
    const participant: WorkspaceParticipant = {
      id,
      provider,
      displayName,
      capabilities,
      status: 'online',
      registeredAt: previous?.registeredAt ?? timestamp,
      lastSeenAt: timestamp,
    }
    this.participants.set(id, participant)
    this.notify({ type: 'participant', participant: copyParticipant(participant, timestamp) })
    return copyParticipant(participant, timestamp)
  }

  updatePresence(input: {
    id: string
    status: WorkspaceParticipantStatus
    activity?: string
  }): WorkspaceParticipant {
    const participant = this.requireParticipant(input.id)
    if (!['online', 'busy', 'idle', 'offline'].includes(input.status)) {
      throw new Error('status must be online, busy, idle, or offline.')
    }
    const activity = input.activity === undefined
      ? undefined
      : requireText(input.activity, 'activity', 200)
    participant.status = input.status
    participant.activity = activity
    participant.lastSeenAt = this.now()
    const copy = copyParticipant(participant, participant.lastSeenAt)
    this.notify({ type: 'participant', participant: copy })
    return copy
  }

  listParticipants(): WorkspaceParticipant[] {
    const now = this.now()
    return [...this.participants.values()]
      .map(participant => copyParticipant(participant, now))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  }

  listMessages(limit = 100, afterTimestamp = 0): WorkspaceMessage[] {
    return this.messages
      .filter(message => message.timestamp > afterTimestamp)
      .slice(-limit)
      .map(message => ({ ...message }))
  }

  listTasks(limit = 100): WorkspaceTask[] {
    return this.tasks.slice(-limit).map(task => ({ ...task }))
  }

  postMessage(participantId: string, text: string): WorkspaceMessage {
    const participant = this.requireParticipant(participantId)
    const message: WorkspaceMessage = {
      id: randomUUID(),
      participantId: participant.id,
      displayName: participant.displayName,
      text: requireText(text, 'text', 4000),
      timestamp: this.now(),
    }
    this.messages.push(message)
    if (this.messages.length > MAX_MESSAGES) this.messages.splice(0, this.messages.length - MAX_MESSAGES)
    participant.lastSeenAt = message.timestamp
    participant.status = 'online'
    this.notify({ type: 'message', message })
    return { ...message }
  }

  assignTask(participantId: string, prompt: string): WorkspaceTask {
    return this.assignTaskToParticipants([participantId], prompt)[0]
  }

  assignTaskToParticipants(participantIds: string[], prompt: string): WorkspaceTask[] {
    if (!Array.isArray(participantIds) || participantIds.length === 0 || participantIds.length > 20) {
      throw new Error('Select between 1 and 20 IDE participants.')
    }
    const uniqueIds = [...new Set(participantIds.map(id => requireText(id, 'participantId', 100)))]
    if (uniqueIds.length !== participantIds.length) {
      throw new Error('IDE participant IDs must be unique.')
    }
    const normalizedPrompt = requireText(prompt, 'prompt', 8000)
    const participants = uniqueIds.map(id => {
      const participant = this.requireParticipant(id)
      if (copyParticipant(participant, this.now()).status === 'offline') {
        throw new Error(`Workspace participant "${id}" is offline.`)
      }
      return participant
    })
    const collaborationId = participants.length > 1 ? randomUUID() : undefined
    const createdAt = this.now()
    const tasks = participants.map(participant => ({
      id: randomUUID(),
      participantId: participant.id,
      collaborationId,
      prompt: normalizedPrompt,
      status: 'pending' as const,
      createdAt,
    }))
    this.tasks.push(...tasks)
    if (this.tasks.length > MAX_TASKS) this.tasks.splice(0, this.tasks.length - MAX_TASKS)
    for (const task of tasks) this.notify({ type: 'task', task: { ...task } })
    return tasks.map(task => ({ ...task }))
  }

  claimTasks(participantId: string): WorkspaceTask[] {
    const participant = this.requireParticipant(participantId)
    const timestamp = this.now()
    participant.status = 'busy'
    participant.activity = 'working on workspace task'
    participant.lastSeenAt = timestamp
    this.notify({
      type: 'participant',
      participant: copyParticipant(participant, timestamp),
    })
    const tasks = this.tasks.filter(task =>
      task.participantId === participantId && task.status === 'pending',
    )
    for (const task of tasks) {
      task.status = 'claimed'
      task.claimedAt = timestamp
      this.notify({ type: 'task', task: { ...task } })
    }
    return tasks.map(task => ({ ...task }))
  }

  completeTask(input: {
    participantId: string
    taskId: string
    response?: string
    error?: string
  }): WorkspaceTask {
    const task = this.tasks.find(item =>
      item.id === input.taskId && item.participantId === input.participantId,
    )
    if (!task) throw new Error(`Task "${input.taskId}" is not assigned to "${input.participantId}".`)
    if (task.status !== 'claimed') throw new Error(`Task "${input.taskId}" is not claimed.`)
    if (Boolean(input.response?.trim()) === Boolean(input.error?.trim())) {
      throw new Error('Provide exactly one non-empty response or error.')
    }
    task.status = input.error ? 'failed' : 'completed'
    task.response = input.response?.trim()
    task.error = input.error?.trim()
    task.completedAt = this.now()
    const participant = this.requireParticipant(input.participantId)
    participant.status = 'online'
    participant.activity = undefined
    participant.lastSeenAt = task.completedAt
    this.notify({ type: 'task', task: { ...task } })
    this.notify({
      type: 'participant',
      participant: copyParticipant(participant, participant.lastSeenAt),
    })
    if (task.response || task.error) {
      this.postMessage(
        participant.id,
        task.error ? `Task failed: ${task.error}` : `Task completed: ${task.response}`,
      )
    }
    return { ...task }
  }

  subscribe(listener: (event: WorkspaceParticipantEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private requireParticipant(id: string): WorkspaceParticipant {
    const participant = this.participants.get(requireText(id, 'id', 100))
    if (!participant) throw new Error(`Workspace participant "${id}" has not joined.`)
    return participant
  }

  private notify(event: WorkspaceParticipantEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[WorkspaceParticipants] Listener error:', error)
      }
    }
  }
}

export const workspaceParticipants = new WorkspaceParticipants()
