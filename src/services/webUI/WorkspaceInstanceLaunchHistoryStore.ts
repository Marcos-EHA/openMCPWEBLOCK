import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type WorkspaceInstanceLaunchStatus =
  | 'starting'
  | 'preparing'
  | 'restarting'
  | 'ready'
  | 'stopped'
  | 'failed'

export interface WorkspaceInstanceLaunchEvent {
  id: string
  instanceId: string
  status: WorkspaceInstanceLaunchStatus
  detail: string
  timestamp: number
}

const MAX_EVENTS = 5_000
const MAX_PER_INSTANCE = 100
const MAX_DETAIL_LENGTH = 4_000

function defaultStorePath(): string {
  const appData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  const projectKey = createHash('sha256').update(process.cwd()).digest('hex').slice(0, 20)
  return join(appData, 'openMCPWEBLOCK', 'workspace-instance-launch-history', `${projectKey}.jsonl`)
}

function isLaunchEvent(value: unknown): value is WorkspaceInstanceLaunchEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as Partial<WorkspaceInstanceLaunchEvent>
  return typeof event.id === 'string' &&
    typeof event.instanceId === 'string' &&
    ['starting', 'preparing', 'restarting', 'ready', 'stopped', 'failed'].includes(event.status ?? '') &&
    typeof event.detail === 'string' &&
    Number.isSafeInteger(event.timestamp)
}

export class WorkspaceInstanceLaunchHistoryStore {
  private events: WorkspaceInstanceLaunchEvent[] = []
  private initialized = false
  private queue: Promise<void> = Promise.resolve()

  constructor(private filePath = defaultStorePath()) {}

  resetForTests(filePath = this.filePath): void {
    this.filePath = filePath
    this.events = []
    this.initialized = false
    this.queue = Promise.resolve()
  }

  async list(instanceId: string, limit = MAX_PER_INSTANCE): Promise<WorkspaceInstanceLaunchEvent[]> {
    if (!instanceId.trim() || instanceId.length > 150) {
      throw new TypeError('instanceId must contain between 1 and 150 characters.')
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PER_INSTANCE) {
      throw new RangeError(`limit must be between 1 and ${MAX_PER_INSTANCE}.`)
    }
    await this.runExclusive(async () => this.initialize())
    return this.events
      .filter(event => event.instanceId === instanceId)
      .slice(-limit)
      .reverse()
      .map(event => ({ ...event }))
  }

  async append(input: Omit<WorkspaceInstanceLaunchEvent, 'id' | 'timestamp'> & { timestamp?: number }): Promise<WorkspaceInstanceLaunchEvent> {
    if (!input.instanceId.trim() || input.instanceId.length > 150) {
      throw new TypeError('instanceId must contain between 1 and 150 characters.')
    }
    if (input.detail.length > MAX_DETAIL_LENGTH) {
      throw new RangeError(`Launch event details cannot exceed ${MAX_DETAIL_LENGTH} characters.`)
    }
    const event: WorkspaceInstanceLaunchEvent = {
      ...input,
      id: randomUUID(),
      timestamp: input.timestamp ?? Date.now(),
    }
    await this.runExclusive(async () => {
      await this.initialize()
      this.events.push(event)
      this.events = this.events.slice(-MAX_EVENTS)
      await this.persist()
    })
    return { ...event }
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
      for (const line of contents.split('\n').filter(Boolean)) {
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch (error) {
          throw new Error(`Invalid persisted instance launch event: ${String(error)}`)
        }
        if (!isLaunchEvent(parsed)) throw new Error('Invalid persisted instance launch event shape.')
        this.events.push(parsed)
      }
      this.events = this.events.slice(-MAX_EVENTS)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.initialized = true
  }

  private async persist(): Promise<void> {
    const serialized = this.events.map(event => JSON.stringify(event)).join('\n') + '\n'
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, this.filePath)
  }
}

export const workspaceInstanceLaunchHistoryStore = new WorkspaceInstanceLaunchHistoryStore()
