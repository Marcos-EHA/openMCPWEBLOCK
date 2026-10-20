import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { LaunchRequest } from './WebUIServer.js'

export type LaunchOperationStatus = 'running' | 'succeeded' | 'failed' | 'unknown'
export interface LaunchOperation {
  id: string
  status: LaunchOperationStatus
  createdAt: number
  target: NonNullable<LaunchRequest['target']>
  platformId: string
  finishedAt?: number
  error?: string
  persistenceError?: string
}
interface StoredLaunchOperation extends LaunchOperation { request: LaunchRequest }
const VALID_ID = /^[a-zA-Z0-9_-]{16,80}$/
const MAX_OPERATIONS = 2000

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}'
  }
  return JSON.stringify(value) ?? 'null'
}

/** Owns launch request identity independently of any HTTP connection. */
export class LaunchOperations {
  private readonly operations = new Map<string, StoredLaunchOperation>()

  constructor(private readonly directory?: string) {
    if (!directory) return
    mkdirSync(directory, { recursive: true })
    for (const file of readdirSync(directory).filter(name => name.endsWith('.json'))) {
      const value = JSON.parse(readFileSync(join(directory, file), 'utf8')) as StoredLaunchOperation
      if (!value || !VALID_ID.test(value.id) || file !== value.id + '.json' ||
        !value.request || typeof value.request.platformId !== 'string' ||
        !Number.isFinite(value.createdAt) ||
        !['running', 'succeeded', 'failed', 'unknown'].includes(value.status)) {
        throw new Error('Invalid saved launch operation: ' + file)
      }
      if (value.status === 'running') {
        value.status = 'unknown'
        value.error = 'Workspace restarted before the launch outcome was confirmed. Inspect existing instances before launching again.'
        this.persist(value)
      }
      this.operations.set(value.id, value)
    }
  }

  private persist(operation: StoredLaunchOperation): void {
    if (!this.directory) return
    const destination = join(this.directory, operation.id + '.json')
    const temporary = destination + '.' + randomUUID() + '.tmp'
    try {
      writeFileSync(temporary, JSON.stringify(operation), { encoding: 'utf8', flag: 'wx' })
      renameSync(temporary, destination)
    } finally {
      try { unlinkSync(temporary) } catch { /* Renamed successfully, or no temporary file was created. */ }
    }
  }

  get(id: string): LaunchOperation | undefined {
    const operation = this.operations.get(id)
    if (!operation) return undefined
    const { request: _request, ...publicOperation } = operation
    return {
      ...publicOperation,
      target: operation.request.target ?? 'relay',
      platformId: operation.request.platformId,
    }
  }

  list(): LaunchOperation[] {
    return [...this.operations.values()].sort((a, b) => b.createdAt - a.createdAt)
      .map(operation => this.get(operation.id)!)
  }

  start(id: string, request: LaunchRequest, run: (request: LaunchRequest) => Promise<void>): LaunchOperation {
    if (!VALID_ID.test(id)) throw new Error('A valid launch request ID is required.')
    const existing = this.operations.get(id)
    if (existing) {
      if (canonical(existing.request) !== canonical(request)) {
        throw new Error('This launch request ID already belongs to different settings.')
      }
      return this.get(id)!
    }
    if ([...this.operations.values()].some(item => item.status === 'running' || item.status === 'unknown')) {
      throw new Error('A launch is running or has an unconfirmed outcome. Inspect that operation before starting another.')
    }
    if (this.operations.size >= MAX_OPERATIONS) {
      throw new Error('Launch history is full. Archive and reconcile it before accepting more launches.')
    }
    const operation: StoredLaunchOperation = {
      id,
      status: 'running',
      createdAt: Date.now(),
      target: request.target ?? 'relay',
      platformId: request.platformId,
      request: structuredClone(request),
    }
    // A failed initial save must prevent every side effect.
    this.persist(operation)
    this.operations.set(id, operation)
    void Promise.resolve().then(async () => {
      try {
        await run(structuredClone(operation.request))
        operation.status = 'succeeded'
      } catch (error) {
        operation.status = 'failed'
        operation.error = error instanceof Error ? error.message : String(error)
      }
      operation.finishedAt = Date.now()
      try {
        this.persist(operation)
      } catch (error) {
        // The on-disk running record will become unknown after restart.
        operation.status = 'unknown'
        operation.persistenceError = error instanceof Error ? error.message : String(error)
        operation.error = 'The final launch outcome could not be saved. Inspect existing instances before retrying.'
      }
    })
    return this.get(id)!
  }
}
