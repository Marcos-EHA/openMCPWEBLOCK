import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LaunchOperations } from './LaunchOperations.js'
import { WebUIServer } from './WebUIServer.js'

const directories: string[] = []
const servers: WebUIServer[] = []
const request = { platformId: 'chatgpt', purpose: 'user' as const, count: 1 }
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'workspace-launch-test-'))
  directories.push(path)
  return path
}
afterEach(() => {
  for (const server of servers.splice(0)) server.stop()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('recoverable launch operations', () => {
  test('repeated request identity dispatches only once and retains completion', async () => {
    const operations = new LaunchOperations(directory())
    let calls = 0
    let finish!: () => void
    const run = async () => { calls++; await new Promise<void>(resolve => { finish = resolve }) }
    const id = 'test-launch-request-0001'
    expect(operations.start(id, request, run).status).toBe('running')
    operations.start(id, { count: 1, purpose: 'user', platformId: 'chatgpt' }, run)
    await tick()
    expect(calls).toBe(1)
    finish()
    await tick()
    expect(operations.get(id)?.status).toBe('succeeded')
    operations.start(id, request, run)
    await tick()
    expect(calls).toBe(1)
  })

  test('completed history survives restart without exposing request contents', async () => {
    const path = directory()
    const operations = new LaunchOperations(path)
    operations.start('test-launch-request-0002', request, async () => {})
    await tick()
    const restored = new LaunchOperations(path)
    expect(restored.get('test-launch-request-0002')?.status).toBe('succeeded')
    expect(restored.get('test-launch-request-0002')).toMatchObject({
      target: 'relay',
      platformId: 'chatgpt',
    })
    expect(restored.list()[0]).not.toHaveProperty('request')
  })

  test('restart converts unfinished work to unknown and prevents another launch', async () => {
    const path = directory()
    const operations = new LaunchOperations(path)
    let finish!: () => void
    operations.start('test-launch-request-0003', request, async () => {
      await new Promise<void>(resolve => { finish = resolve })
    })
    await tick()
    const restored = new LaunchOperations(path)
    expect(restored.get('test-launch-request-0003')?.status).toBe('unknown')
    let calls = 0
    expect(() => restored.start('test-launch-request-0004', request, async () => { calls++ }))
      .toThrow('unconfirmed outcome')
    expect(calls).toBe(0)
    finish()
    await tick()
  })

  test('rejects reused identities with different settings and overlapping new launches', async () => {
    const operations = new LaunchOperations()
    let finish!: () => void
    operations.start('test-launch-request-0005', request, async () => {
      await new Promise<void>(resolve => { finish = resolve })
    })
    await tick()
    expect(() => operations.start('test-launch-request-0005', { ...request, count: 2 }, async () => {}))
      .toThrow('different settings')
    expect(() => operations.start('test-launch-request-0006', request, async () => {}))
      .toThrow('running')
    finish()
    await tick()
  })

  test('does not dispatch when the initial durable save fails', async () => {
    const path = directory()
    const operations = new LaunchOperations(path)
    rmSync(path, { recursive: true })
    writeFileSync(path, 'not a directory')
    let calls = 0
    expect(() => operations.start('test-launch-request-0007', request, async () => { calls++ })).toThrow()
    await tick()
    expect(calls).toBe(0)
    expect(operations.list()).toHaveLength(0)
  })

  test('retains handler failures without automatically retrying', async () => {
    const path = directory()
    const operations = new LaunchOperations(path)
    operations.start('test-launch-request-0008', request, async () => { throw new Error('preparation failed') })
    await tick()
    expect(new LaunchOperations(path).get('test-launch-request-0008')).toMatchObject({
      status: 'failed', error: 'preparation failed',
    })
  })

  test('HTTP acknowledges before completion and exposes protected recoverable status', async () => {
    const server = new WebUIServer(0, '127.0.0.1', directory())
    servers.push(server)
    let calls = 0
    let finish!: () => void
    server.setHandlers({ onLaunch: async () => {
      calls++
      await new Promise<void>(resolve => { finish = resolve })
    } })
    await server.start()
    const url = 'http://127.0.0.1:' + server.getListeningPort()
    const headers = { Origin: url, 'Content-Type': 'application/json' }
    const id = 'test-http-launch-request-01'
    const send = () => fetch(url + '/api/launch?async=1', {
      method: 'POST', headers, body: JSON.stringify({ ...request, requestId: id }),
      signal: AbortSignal.timeout(3000),
    })
    try {
      const accepted = await send()
      expect(accepted.status).toBe(202)
      expect((await accepted.json()).operation).toMatchObject({ id, status: 'running' })
      expect((await send()).status).toBe(202)
      expect(calls).toBe(1)
      const state = await fetch(url + '/api/launch-operations?id=' + id, { headers })
      expect((await state.json()).operation.status).toBe('running')
      const forbidden = await fetch(url + '/api/launch-operations', { headers: { Origin: 'http://other.invalid' } })
      expect(forbidden.status).toBe(403)
      const missing = await fetch(url + '/api/launch-operations?id=missing', { headers })
      expect(missing.status).toBe(404)
    } finally {
      finish?.()
      await tick()
    }
    const completed = await fetch(url + '/api/launch-operations?id=' + id, { headers })
    expect((await completed.json()).operation.status).toBe('succeeded')
  })
})
