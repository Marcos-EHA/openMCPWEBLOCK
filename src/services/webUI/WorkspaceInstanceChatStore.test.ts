import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceInstanceChatStore } from './WorkspaceInstanceChatStore.js'

describe('WorkspaceInstanceChatStore', () => {
  let directory = ''

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'workspace-instance-chat-'))
  })

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  test('persists messages across store instances and isolates instance conversations', async () => {
    const filePath = join(directory, 'chats.jsonl')
    const firstStore = new WorkspaceInstanceChatStore(filePath)
    const userMessage = await firstStore.append({
      instanceId: 'relay-one',
      conversationId: 'main',
      role: 'user',
      text: 'hello',
      timestamp: 100,
    })
    await firstStore.append({
      instanceId: 'relay-one',
      conversationId: 'main',
      role: 'assistant',
      text: 'world',
      timestamp: 101,
    })
    await firstStore.append({
      instanceId: 'relay-two',
      conversationId: 'main',
      role: 'assistant',
      text: 'other instance',
      timestamp: 102,
    })

    const reopenedStore = new WorkspaceInstanceChatStore(filePath)
    expect(await reopenedStore.list('relay-one', 'main')).toHaveLength(2)
    expect(await reopenedStore.list('relay-two', 'main')).toHaveLength(1)
    expect(await reopenedStore.list('relay-one', 'other')).toEqual([])
    expect(userMessage.id).toBeString()
  })

  test('moves a provisional conversation into the identified local chat', async () => {
    const store = new WorkspaceInstanceChatStore(join(directory, 'chats.jsonl'))
    await store.append({
      instanceId: 'local-antigravity-1',
      conversationId: 'new',
      role: 'user',
      text: 'continue',
    })

    await store.moveConversation('local-antigravity-1', 'new', 'chat-123')

    expect(await store.list('local-antigravity-1', 'new')).toEqual([])
    expect((await store.list('local-antigravity-1', 'chat-123'))[0]?.text).toBe('continue')
  })
})
