import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type WorkspaceInstanceChatRole = 'user' | 'assistant' | 'status' | 'error'

export interface WorkspaceInstanceChatMessage {
  id: string
  instanceId: string
  conversationId: string
  role: WorkspaceInstanceChatRole
  text: string
  timestamp: number
  model?: string
}

const MAX_MESSAGES = 1_000
const MAX_PER_CONVERSATION = 200
const MAX_TEXT_LENGTH = 50_000

function defaultStorePath(): string {
  const appData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  const projectKey = createHash('sha256').update(process.cwd()).digest('hex').slice(0, 20)
  return join(appData, 'openMCPWEBLOCK', 'workspace-instance-chats', `${projectKey}.jsonl`)
}

function isChatMessage(value: unknown): value is WorkspaceInstanceChatMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Partial<WorkspaceInstanceChatMessage>
  return typeof message.id === 'string' &&
    typeof message.instanceId === 'string' &&
    typeof message.conversationId === 'string' &&
    ['user', 'assistant', 'status', 'error'].includes(message.role ?? '') &&
    typeof message.text === 'string' &&
    Number.isSafeInteger(message.timestamp) &&
    (message.model === undefined || typeof message.model === 'string')
}

export class WorkspaceInstanceChatStore {
  private messages: WorkspaceInstanceChatMessage[] = []
  private initialized = false
  private needsCompaction = false
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath = defaultStorePath()) {}

  async list(instanceId: string, conversationId = 'main', limit = MAX_PER_CONVERSATION): Promise<WorkspaceInstanceChatMessage[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PER_CONVERSATION) {
      throw new RangeError(`limit must be between 1 and ${MAX_PER_CONVERSATION}.`)
    }
    await this.runExclusive(async () => this.initialize())
    return this.messages
      .filter(message => message.instanceId === instanceId && message.conversationId === conversationId)
      .slice(-limit)
      .map(message => ({ ...message }))
  }

  async append(input: Omit<WorkspaceInstanceChatMessage, 'id' | 'timestamp'> & { timestamp?: number }): Promise<WorkspaceInstanceChatMessage> {
    if (!input.instanceId.trim() || input.instanceId.length > 150) {
      throw new TypeError('instanceId must contain between 1 and 150 characters.')
    }
    if (!input.conversationId.trim() || input.conversationId.length > 200) {
      throw new TypeError('conversationId must contain between 1 and 200 characters.')
    }
    if (input.text.length > MAX_TEXT_LENGTH) {
      throw new RangeError(`Chat messages cannot exceed ${MAX_TEXT_LENGTH} characters.`)
    }
    const message: WorkspaceInstanceChatMessage = {
      ...input,
      id: randomUUID(),
      timestamp: input.timestamp ?? Date.now(),
    }
    await this.runExclusive(async () => {
      await this.initialize()
      this.messages.push(message)
      if (this.needsCompaction || this.messages.length > MAX_MESSAGES) {
        this.trimHistory()
        await this.persist()
        this.needsCompaction = false
      } else {
        await appendFile(this.filePath, `${JSON.stringify(message)}\n`, { encoding: 'utf8', mode: 0o600 })
      }
    })
    return { ...message }
  }

  async moveConversation(instanceId: string, fromConversationId: string, toConversationId: string): Promise<void> {
    if (fromConversationId === toConversationId) return
    await this.runExclusive(async () => {
      await this.initialize()
      this.messages = this.messages.map(message =>
        message.instanceId === instanceId && message.conversationId === fromConversationId
          ? { ...message, conversationId: toConversationId }
          : message,
      )
      this.trimHistory()
      await this.persist()
      this.needsCompaction = false
    })
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue
    let release!: () => void
    this.queue = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return
    await mkdir(dirname(this.filePath), { recursive: true })
    try {
      const contents = await readFile(this.filePath, 'utf8')
      const lines = contents.split('\n').filter(Boolean)
      for (const line of lines) {
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch (error) {
          throw new Error(`Invalid persisted Workspace chat record: ${String(error)}`)
        }
        if (!isChatMessage(parsed)) throw new Error('Invalid persisted Workspace chat record shape.')
        this.messages.push(parsed)
      }
      if (this.messages.length > MAX_MESSAGES) {
        this.trimHistory()
        this.needsCompaction = true
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.initialized = true
  }

  private trimHistory(): void {
    this.messages = this.messages.slice(-MAX_MESSAGES)
  }

  private async persist(): Promise<void> {
    const serialized = this.messages.map(message => JSON.stringify(message)).join('\n') + (this.messages.length ? '\n' : '')
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, this.filePath)
  }
}

export const workspaceInstanceChatStore = new WorkspaceInstanceChatStore()
