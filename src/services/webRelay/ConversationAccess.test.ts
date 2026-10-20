import { describe, expect, test } from 'bun:test'
import { ConversationAccess, ConversationBusyError, browserConversationResource } from './ConversationAccess.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

const owner = (instanceId: string) => ({ instanceId, operation: 'test conversation' })

describe('conversation access', () => {
  test('rejects a second alias of the same browser before dispatch', async () => {
    const access = new ConversationAccess()
    const gate = deferred()
    const resource = browserConversationResource(9405)
    const first = access.run([resource], owner('master-session:a'), () => gate.promise)
    let dispatched = false
    try {
      await expect(access.run([resource], owner('relay:a'), async () => { dispatched = true })).rejects.toBeInstanceOf(ConversationBusyError)
      expect(dispatched).toBe(false)
      expect(access.getOwner(resource)?.instanceId).toBe('master-session:a')
    } finally {
      gate.resolve()
      await first
    }
    expect(access.getOwner(resource)).toBeUndefined()
    expect(await access.run([resource], owner('relay:a'), async () => 'ready')).toBe('ready')
  })

  test('allows independent browsers to run concurrently', async () => {
    const access = new ConversationAccess()
    const gate = deferred()
    const first = access.run([browserConversationResource(9405)], owner('a'), () => gate.promise)
    try {
      expect(await access.run([browserConversationResource(9406)], owner('b'), async () => 'parallel')).toBe('parallel')
      expect(access.getOwner(browserConversationResource(9405))).toBeDefined()
    } finally {
      gate.resolve()
      await first
    }
  })

  test('reserves multiple resources atomically', async () => {
    const access = new ConversationAccess()
    const gate = deferred()
    const first = access.run(['relay:shared-response-channel'], owner('a'), () => gate.promise)
    try {
      await expect(access.run(['browser:b', 'relay:shared-response-channel'], owner('b'), async () => 'unreachable')).rejects.toBeInstanceOf(ConversationBusyError)
      expect(access.getOwner('browser:b')).toBeUndefined()
    } finally {
      gate.resolve()
      await first
    }
  })

  test('releases resources after a rejected operation without swallowing the error', async () => {
    const access = new ConversationAccess()
    const failure = new Error('operation failed')
    await expect(access.run(['browser:a'], owner('a'), async () => { throw failure })).rejects.toBe(failure)
    expect(access.getOwner('browser:a')).toBeUndefined()
  })

  test('rejects invalid browser identities', () => {
    for (const port of [0, -1, 65536, 1.5, NaN]) {
      expect(() => browserConversationResource(port)).toThrow()
    }
  })
})
