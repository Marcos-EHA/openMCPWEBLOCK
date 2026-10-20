import { afterEach, describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import React from 'react'
import { createRoot } from '../../ink.js'
import {
  applyWebRelayActivityEvent,
  finishWebRelayActivity,
  resetWebRelayActivityForTests,
  startWebRelayActivity,
} from '../../services/webRelay/WebRelayActivityStore.js'
import type { AgentState } from '../../services/webRelay/orchestration/types.js'
import { WebRelayActivityPanel } from './WebRelayActivityPanel.js'

const agents: AgentState[] = [
  {
    agentId: 'coordinator',
    platformId: 'chatgpt',
    role: 'primary',
    sessionMode: 'clean',
    instanceId: 'instance-coordinator',
    status: 'ready',
    activeExecutions: 0,
    unknownExecutions: 0,
    createdAt: 1,
  },
  {
    agentId: 'worker',
    platformId: 'chatgpt',
    role: 'worker-2',
    sessionMode: 'clean',
    instanceId: 'instance-worker',
    status: 'ready',
    activeExecutions: 0,
    unknownExecutions: 0,
    createdAt: 2,
  },
]

afterEach(resetWebRelayActivityForTests)

describe('WebRelayActivityPanel', () => {
  test('shows an independent status card for coordinator and worker and updates after completion', async () => {
    const stdout = new PassThrough()
    const stdin = new PassThrough() as PassThrough & {
      isTTY: boolean
      setRawMode: (mode: boolean) => void
      ref: () => void
      unref: () => void
    }
    stdin.isTTY = true
    stdin.setRawMode = () => {}
    stdin.ref = () => {}
    stdin.unref = () => {}
    ;(stdout as unknown as { columns: number }).columns = 110

    let output = ''
    stdout.on('data', chunk => { output += chunk.toString() })
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })
    root.render(<WebRelayActivityPanel />)

    try {
      const taskId = startWebRelayActivity('Revisa la arquitectura', 'chatgpt', agents)
      applyWebRelayActivityEvent(taskId, { type: 'planning-started', agentId: 'coordinator' })
      applyWebRelayActivityEvent(taskId, {
        type: 'worker-started',
        agentId: 'worker',
        prompt: 'Revisa la capa de entrada',
      })
      await Bun.sleep(30)
      let visible = output.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '')
      expect(visible).toContain('Coordinador · coordinator · Planificando asignaciones')
      expect(visible).toContain('Worker · worker · Trabajando en su asignación')
      expect(visible).toContain('Revisa la capa de entrada')

      applyWebRelayActivityEvent(taskId, {
        type: 'worker-response',
        agentId: 'worker',
        response: 'Encontré tres capas.',
      })
      finishWebRelayActivity(taskId)
      await Bun.sleep(30)
      visible = output.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '')
      expect(visible).toContain('Lienzo de agentes · completa')
      expect(visible).toContain('Respuesta recibida')
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }
  })
})
