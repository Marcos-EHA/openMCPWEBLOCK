import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceInstanceLaunchHistoryStore } from './WorkspaceInstanceLaunchHistoryStore.js'

describe('WorkspaceInstanceLaunchHistoryStore', () => {
  let directory = ''

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'workspace-instance-launch-history-'))
  })

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  test('persists dated events across restarts and isolates instances', async () => {
    const filePath = join(directory, 'events.jsonl')
    const store = new WorkspaceInstanceLaunchHistoryStore(filePath)
    await store.append({
      instanceId: 'relay-one',
      status: 'starting',
      detail: 'Launch requested',
      timestamp: 100,
    })
    await store.append({
      instanceId: 'relay-one',
      status: 'failed',
      detail: 'Extension did not become ready',
      timestamp: 101,
    })
    await store.append({
      instanceId: 'relay-two',
      status: 'ready',
      detail: 'Started',
      timestamp: 102,
    })

    const restored = new WorkspaceInstanceLaunchHistoryStore(filePath)
    expect(await restored.list('relay-one')).toMatchObject([
      { status: 'failed', detail: 'Extension did not become ready', timestamp: 101 },
      { status: 'starting', detail: 'Launch requested', timestamp: 100 },
    ])
    expect(await restored.list('relay-two')).toHaveLength(1)
  })

  test('rejects invalid instance identifiers, limits and oversized details', async () => {
    const store = new WorkspaceInstanceLaunchHistoryStore(join(directory, 'events.jsonl'))
    await expect(store.list('')).rejects.toThrow('instanceId')
    await expect(store.list('relay-one', 101)).rejects.toThrow('limit')
    await expect(store.append({
      instanceId: 'relay-one',
      status: 'failed',
      detail: 'x'.repeat(4_001),
    })).rejects.toThrow('cannot exceed')
  })
})
