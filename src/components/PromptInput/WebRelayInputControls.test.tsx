import { afterEach, describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import React from 'react'
import { createRoot } from '../../ink.js'
import { WebRelayInputControls } from './PromptInputFooter.js'
import { setComposerDestination } from '../../services/geminiOrchestrator/sentinelComposerMode.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  setComposerDestination('assistant')
})

async function renderControls(columns = 180): Promise<{
  output: () => string
  close: () => void
}> {
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
  ;(stdout as unknown as { columns: number }).columns = columns

  let rendered = ''
  stdout.on('data', chunk => { rendered += chunk.toString() })
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  root.render(<WebRelayInputControls onQuickAction={() => {}} />)

  return {
    output: () => rendered.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, ''),
    close: () => {
      root.unmount()
      stdin.end()
      stdout.end()
    },
  }
}

async function waitForOutput(output: () => string, expected: string): Promise<void> {
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    if (output().includes(expected)) return
    await Bun.sleep(10)
  }
  throw new Error(`Expected TUI footer to render "${expected}".`)
}

describe('WebRelayInputControls', () => {
  test('distinguishes Web coordinator from Gemini Sentinel and exposes destination actions', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input) === 'http://127.0.0.1:3006/status') return new Response('{}')
      return Response.json({ available: true })
    }) as typeof fetch

    const view = await renderControls()
    try {
      await waitForOutput(view.output, '[Puente MCP :3006 ON]')
      expect(view.output()).toContain('pool 0/0 listo')
      expect(view.output()).toContain('[◆ Sentinel · Gemini]')
      expect(view.output()).toContain('coordinador API')
      expect(view.output()).toContain('[OpenMCP]')
      expect(view.output()).toContain('[+ Lanzar/configurar]')
    } finally {
      view.close()
    }
  })

  test('distinguishes an unreachable server from an incompatible relay API', async () => {
    globalThis.fetch = (async () => { throw new Error('offline') }) as typeof fetch
    const offlineView = await renderControls()
    try {
      await waitForOutput(offlineView.output, '[Puente MCP :3006 OFF]')
    } finally {
      offlineView.close()
    }

    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input) === 'http://127.0.0.1:3006/status') return new Response('{}')
      return Response.json({ available: false })
    }) as typeof fetch
    const incompatibleView = await renderControls()
    try {
      await waitForOutput(incompatibleView.output, '[Puente MCP :3006 ACTUALIZAR]')
    } finally {
      incompatibleView.close()
    }
  })

  test('uses abbreviated controls when terminal width is limited', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input) === 'http://127.0.0.1:3006/status') return new Response('{}')
      return Response.json({ available: true })
    }) as typeof fetch

    const view = await renderControls(80)
    try {
      await waitForOutput(view.output, '[MCP ON]')
      expect(view.output()).toContain('[Web API 0/0]')
      expect(view.output()).toContain('[◆ Gemini]')
      expect(view.output()).toContain('[CLI]')
      expect(view.output()).toContain('[+ Web]')
      expect(view.output()).not.toContain('Destino del mensaje')
      expect(view.output()).not.toContain('[Destino:')
    } finally {
      view.close()
    }
  })

  test('keeps compact footer controls on stable separate rows', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input) === 'http://127.0.0.1:3006/status') return new Response('{}')
      return Response.json({ available: true })
    }) as typeof fetch

    const view = await renderControls(80)
    try {
      await waitForOutput(view.output, '[MCP ON]')
      const lines = view.output().split(/\r?\n/u).filter(line => line.trim())
      const webLine = lines.findIndex(line => line.includes('[Web '))
      const sentinelLine = lines.findIndex(line => line.includes('[◆ Gemini]'))
      expect(webLine).toBeGreaterThan(-1)
      expect(sentinelLine).toBeGreaterThan(webLine)
      expect(lines.every(line => line.length <= 80)).toBe(true)
      expect(view.output()).not.toContain('Destino del mensaje')
      expect(view.output()).not.toContain('[Destino:')
    } finally {
      view.close()
    }
  })

  test('keeps footer labels within very narrow terminal width without a destination legend', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input) === 'http://127.0.0.1:3006/status') return new Response('{}')
      return Response.json({ available: true })
    }) as typeof fetch

    const view = await renderControls(50)
    try {
      await waitForOutput(view.output, '[MCP ON]')
      const lines = view.output().split(/\r?\n/u).filter(line => line.trim())
      expect(lines.every(line => line.length <= 50)).toBe(true)
      expect(view.output()).toContain('[Web API 0/0]')
      expect(view.output()).not.toContain('Destino del mensaje')
      expect(view.output()).not.toContain('[Destino:')
    } finally {
      view.close()
    }
  })
})
