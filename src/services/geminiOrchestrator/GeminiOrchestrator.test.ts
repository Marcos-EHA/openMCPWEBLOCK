import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GeminiOrchestrator } from './GeminiOrchestrator.js'

const originalFetch = globalThis.fetch
const originalGeminiKey = process.env.GEMINI_API_KEY
const originalSentinelKey = process.env.CENTINELA_API_KEY
const originalGeminiModel = process.env.GEMINI_MODEL
const tempDirs: string[] = []

function createTempProject(envContents?: string): string {
  const projectDir = mkdtempSync(join(tmpdir(), 'openmcp-gemini-test-'))
  tempDirs.push(projectDir)
  if (envContents !== undefined) {
    writeFileSync(join(projectDir, '.env'), envContents, 'utf8')
  }
  return projectDir
}

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY
  else process.env.GEMINI_API_KEY = originalGeminiKey
  if (originalSentinelKey === undefined) delete process.env.CENTINELA_API_KEY
  else process.env.CENTINELA_API_KEY = originalSentinelKey
  if (originalGeminiModel === undefined) delete process.env.GEMINI_MODEL
  else process.env.GEMINI_MODEL = originalGeminiModel
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('GeminiOrchestrator configuration', () => {
  test('loads the local Gemini key and model without embedding a fallback credential', () => {
    delete process.env.GEMINI_API_KEY
    delete process.env.CENTINELA_API_KEY
    delete process.env.GEMINI_MODEL
    const projectDir = createTempProject('GEMINI_API_KEY=local-test-key\nGEMINI_MODEL=gemini-test-model\n')

    const assistant = new GeminiOrchestrator({ projectDir })

    expect(assistant.isConfigured).toBe(true)
    expect(assistant.model).toBe('gemini-test-model')
  })

  test('fails clearly without a configured key and does not issue a request', async () => {
    delete process.env.GEMINI_API_KEY
    delete process.env.CENTINELA_API_KEY
    delete process.env.GEMINI_MODEL
    const projectDir = createTempProject()
    let requests = 0
    globalThis.fetch = (async () => {
      requests++
      return new Response('{}')
    }) as typeof fetch
    const assistant = new GeminiOrchestrator({ projectDir })

    expect(assistant.isConfigured).toBe(false)
    await expect(assistant.chat('hola')).rejects.toThrow('configura GEMINI_API_KEY o CENTINELA_API_KEY')
    expect(requests).toBe(0)
  })

  test('uses the configured model endpoint and keeps a successful response in chat', async () => {
    delete process.env.GEMINI_API_KEY
    delete process.env.CENTINELA_API_KEY
    delete process.env.GEMINI_MODEL
    const projectDir = createTempProject('CENTINELA_API_KEY=local-test-key\nGEMINI_MODEL=gemini-test-model\n')
    let requestedUrl = ''
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedUrl = String(input)
      return Response.json({
        candidates: [{ content: { parts: [{ text: 'Hola, soy Sentinel.' }] } }],
      })
    }) as typeof fetch
    const assistant = new GeminiOrchestrator({ projectDir })

    const response = await assistant.chat('Hola')

    expect(new URL(requestedUrl).pathname).toContain('/models/gemini-test-model:generateContent')
    expect(new URL(requestedUrl).searchParams.get('key')).toBe('local-test-key')
    expect(response.text).toBe('Hola, soy Sentinel.')
  })

  test('restores persisted text turns before sending the next conversation message', async () => {
    delete process.env.GEMINI_API_KEY
    delete process.env.CENTINELA_API_KEY
    delete process.env.GEMINI_MODEL
    const projectDir = createTempProject('GEMINI_API_KEY=local-test-key\n')
    let requestBody: { contents?: Array<{ role: string; parts: Array<{ text?: string }> }> } | undefined
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as typeof requestBody
      return Response.json({
        candidates: [{ content: { parts: [{ text: 'Continuemos.' }] } }],
      })
    }) as typeof fetch
    const assistant = new GeminiOrchestrator({ projectDir })
    assistant.setConversationHistory([
      { role: 'user', text: 'Hola' },
      { role: 'assistant', text: 'Hola, ¿en qué ayudo?' },
    ])

    await assistant.chat('Quiero continuar')

    expect(requestBody?.contents).toEqual([
      { role: 'user', parts: [{ text: 'Hola' }] },
      { role: 'model', parts: [{ text: 'Hola, ¿en qué ayudo?' }] },
      { role: 'user', parts: [{ text: 'Quiero continuar' }] },
    ])
  })

  test('executes a registered operational tool call and returns the follow-up response', async () => {
    delete process.env.GEMINI_API_KEY
    delete process.env.CENTINELA_API_KEY
    delete process.env.GEMINI_MODEL
    const projectDir = createTempProject('GEMINI_API_KEY=local-test-key\n')
    const requestBodies: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      if (requestBodies.length === 1) {
        return Response.json({
          candidates: [{
            content: {
              parts: [{ functionCall: { name: 'launch_guest_web_instances', args: { count: 2 } } }],
            },
          }],
        })
      }
      return Response.json({
        candidates: [{ content: { parts: [{ text: 'Ya lancé las dos instancias guest.' }] } }],
      })
    }) as typeof fetch

    let launchedCount = 0
    const assistant = new GeminiOrchestrator({ projectDir })
    assistant.registerTool({
      name: 'launch_guest_web_instances',
      description: 'Launch clean guest instances.',
      parameters: {
        type: 'OBJECT',
        properties: { count: { type: 'INTEGER' } },
        required: ['count'],
      },
      execute: async args => {
        launchedCount = Number(args.count)
        return `Started ${launchedCount} guest instances.`
      },
    })

    const response = await assistant.chat('Lanza dos instancias invitadas.')

    expect(launchedCount).toBe(2)
    expect(response.toolCalls).toEqual(['launch_guest_web_instances'])
    expect(response.text).toBe('Ya lancé las dos instancias guest.')
    expect(requestBodies).toHaveLength(2)
    expect(requestBodies[0]?.tools).toBeDefined()
    expect(JSON.stringify(requestBodies[1]?.contents)).toContain('Started 2 guest instances.')
  })

  test('pauses repeated requests after a 429 instead of calling Gemini again', async () => {
    delete process.env.GEMINI_API_KEY
    delete process.env.CENTINELA_API_KEY
    delete process.env.GEMINI_MODEL
    const projectDir = createTempProject('GEMINI_API_KEY=local-test-key\n')
    let requests = 0
    globalThis.fetch = (async () => {
      requests++
      return Response.json(
        { error: { message: 'Quota exceeded.' } },
        { status: 429, headers: { 'retry-after': '120' } },
      )
    }) as typeof fetch
    const assistant = new GeminiOrchestrator({ projectDir })

    await expect(assistant.chat('Hola')).rejects.toThrow('pausará nuevas solicitudes durante 2 minutos')
    await expect(assistant.chat('¿Sigues ahí?')).rejects.toThrow('está en pausa tras un límite')

    expect(requests).toBe(1)
  })

  test('caps a tool-using chat at three Gemini requests', async () => {
    delete process.env.GEMINI_API_KEY
    delete process.env.CENTINELA_API_KEY
    delete process.env.GEMINI_MODEL
    const projectDir = createTempProject('GEMINI_API_KEY=local-test-key\n')
    let requests = 0
    let executions = 0
    globalThis.fetch = (async () => {
      requests++
      return Response.json({
        candidates: [{
          content: {
            parts: [{ functionCall: { name: 'repeat_tool', args: {} } }],
          },
        }],
      })
    }) as typeof fetch
    const assistant = new GeminiOrchestrator({ projectDir })
    assistant.registerTool({
      name: 'repeat_tool',
      description: 'Test tool.',
      parameters: { type: 'OBJECT', properties: {} },
      execute: async () => {
        executions++
        return 'ok'
      },
    })

    const response = await assistant.chat('Continúa el flujo')

    expect(requests).toBe(3)
    expect(executions).toBe(3)
    expect(response.text).toContain('máximo de tool rounds')
  })

  test('falls back from an unavailable configured 3.8 model and reports actionable API errors', async () => {
    delete process.env.GEMINI_API_KEY
    delete process.env.CENTINELA_API_KEY
    delete process.env.GEMINI_MODEL
    const projectDir = createTempProject('GEMINI_API_KEY=local-test-key\nGEMINI_MODEL=gemini-3.8-flash\n')
    const requestedModels: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input))
      const model = url.pathname.split('/models/')[1]?.split(':')[0] ?? ''
      requestedModels.push(model)
      if (model === 'gemini-3.8-flash') {
        return Response.json({ error: { message: 'Model is not available.' } }, { status: 404 })
      }
      return Response.json({
        candidates: [{ content: { parts: [{ text: 'Sentinel está disponible.' }] } }],
      })
    }) as typeof fetch

    const response = await new GeminiOrchestrator({ projectDir }).chat('¿Estás disponible?')

    expect(requestedModels).toEqual(['gemini-3.8-flash', 'gemini-2.5-flash'])
    expect(response.text).toBe('Sentinel está disponible.')

    globalThis.fetch = (async () =>
      Response.json({ error: { message: 'API key not valid.' } }, { status: 400 })) as typeof fetch
    await expect(new GeminiOrchestrator({ projectDir }).chat('Hola')).rejects.toThrow(
      'Gemini API 400: API key not valid.',
    )
  })

  test('falls back when Gemini reports an unsupported model with HTTP 400', async () => {
    delete process.env.GEMINI_API_KEY
    delete process.env.CENTINELA_API_KEY
    delete process.env.GEMINI_MODEL
    const projectDir = createTempProject('GEMINI_API_KEY=local-test-key\nGEMINI_MODEL=gemini-3.8-flash\n')
    const requestedModels: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input))
      const model = url.pathname.split('/models/')[1]?.split(':')[0] ?? ''
      requestedModels.push(model)
      if (model === 'gemini-3.8-flash') {
        return Response.json({ error: { message: 'Model gemini-3.8-flash is not supported.' } }, { status: 400 })
      }
      return Response.json({
        candidates: [{ content: { parts: [{ text: 'Chat listo.' }] } }],
      })
    }) as typeof fetch

    const response = await new GeminiOrchestrator({ projectDir }).chat('Hola')

    expect(requestedModels).toEqual(['gemini-3.8-flash', 'gemini-2.5-flash'])
    expect(response.text).toBe('Chat listo.')
  })
})
