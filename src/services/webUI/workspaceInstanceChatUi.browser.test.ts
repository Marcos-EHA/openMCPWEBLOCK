import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import puppeteer, { type Browser } from 'puppeteer-core'

let browser: Browser
let server: ReturnType<typeof Bun.serve>
const messages = new Map<string, Array<Record<string, unknown>>>()
const sent: Array<{ instanceId: string; text: string; conversationId: string }> = []
const sentinelChats: string[] = []
const sentinelThread: Array<Record<string, unknown>> = []
const confirmedSentinelLaunches: Array<Record<string, unknown>> = []
let failSentinelHistoryRequest = false
const base = import.meta.dir

beforeAll(async () => {
  const executablePath = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].find(path => path && existsSync(path))
  if (!executablePath) throw new Error('Chrome unavailable for isolated Workspace chat tests.')
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/launchDialog.js') {
        return new Response(readFileSync(join(base, 'launchDialog.js')), {
          headers: { 'content-type': 'application/javascript' },
        })
      }
      if (url.pathname === '/workspaceLayout.js') {
        return new Response(readFileSync(join(base, 'workspaceLayout.js')), {
          headers: { 'content-type': 'application/javascript' },
        })
      }
      if (url.pathname === '/api/status') {
        return Response.json({
          agents: [{
            agentId: 'relay-fixture',
            role: 'worker-chatgpt',
            status: 'ready',
            platformId: 'chatgpt',
            sessionMode: 'authenticated',
            inWebRelayPool: true,
          }],
          masterSessions: [],
          localInstances: [],
          workspaceParticipants: [],
          workspaceTasks: [],
          workspaceMessages: [],
        })
      }
      if (url.pathname === '/api/canvas') {
        return Response.json({
          snapshot: { findings: 0, activeWorkers: 0 },
          convergence: [],
          divergence: [],
          pendingRequests: [],
          openIssues: [],
          findings: [],
        })
      }
      if (url.pathname === '/api/workspace/activity') {
        return Response.json({ events: [], nextSequence: 0, truncated: false })
      }
      if (url.pathname === '/api/workspace/instance-history') {
        return Response.json({
          events: [{
            id: 'launch-1',
            instanceId: 'relay-fixture',
            status: 'failed',
            detail: 'Respuesta de lanzamiento fixture',
            timestamp: 1_800_000_000_000,
          }],
        })
      }
      if (url.pathname === '/api/workspace/instance-chat/context') {
        return Response.json({ conversationId: 'chat-fixture' })
      }
      if (url.pathname === '/api/workspace/instance-chat') {
        const instanceId = url.searchParams.get('instanceId') || ''
        const conversationId = url.searchParams.get('conversationId') || 'main'
        const key = `${instanceId}\0${conversationId}`
        if (request.method === 'GET') return Response.json({ messages: messages.get(key) || [] })
        const body = await request.json() as { instanceId: string; text: string; conversationId: string }
        sent.push(body)
        const history = [
          { id: 'user-1', instanceId, conversationId, role: 'user', text: body.text, timestamp: 1 },
          { id: 'assistant-1', instanceId, conversationId, role: 'assistant', text: 'Respuesta fixture', timestamp: 2 },
        ]
        messages.set(key, history)
        return Response.json({ ok: true, response: 'Respuesta fixture', messages: history })
      }
      if (url.pathname === '/api/workspace/sentinel-chat') {
        if (request.method === 'GET') {
          if (failSentinelHistoryRequest) return Response.json({ error: 'History fixture unavailable' }, { status: 503 })
          return Response.json({ messages: sentinelThread })
        }
        const body = await request.json() as { text: string }
        sentinelChats.push(body.text)
        sentinelThread.push(
          { id: 'sentinel-user-'+sentinelThread.length, instanceId: 'sentinel', conversationId: 'main', role: 'user', text: body.text, timestamp: Date.now() },
          { id: 'sentinel-assistant-'+sentinelThread.length, instanceId: 'sentinel', conversationId: 'main', role: 'assistant', text: 'Hola. Puedo conversar y explicar las acciones disponibles de Sentinel.', timestamp: Date.now() },
        )
        const launchProposal = /lanz|inici|despl/i.test(body.text)
          ? { target: 'relay', platformId: 'chatgpt', count: 1, purpose: 'agent', registerAsWorkspaceWorker: true }
          : null
        return Response.json({ messages: sentinelThread, ...(launchProposal?{launchProposal}:{}) })
      }
      if (url.pathname === '/api/workspace/sentinel-chat/event' && request.method === 'POST') {
        const body=await request.json() as {text:string}
        sentinelThread.push({
          id:'sentinel-status-'+sentinelThread.length,instanceId:'sentinel',conversationId:'main',
          role:'status',text:body.text,timestamp:Date.now(),
        })
        return Response.json({messages:sentinelThread})
      }
      if (url.pathname === '/api/launch' && request.method === 'POST') {
        const body=await request.json() as Record<string,unknown>
        confirmedSentinelLaunches.push(body)
        return Response.json({
          operation:{id:body.requestId,status:'succeeded',createdAt:Date.now(),target:'relay',platformId:body.platformId},
        },{status:202})
      }
      if (url.pathname === '/api/launch-operations') {
        return Response.json({
          operation:{id:url.searchParams.get('id'),status:'succeeded',createdAt:Date.now(),target:'relay',platformId:'chatgpt'},
        })
      }
      const file = url.searchParams.get('view') === 'canvas' ? 'workspace-canvas.html' : 'workspace.html'
      return new Response(readFileSync(join(base, file)), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    },
  })
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--disable-background-networking', '--disable-sync', '--no-first-run'],
  })
}, 30000)

afterAll(async () => {
  await browser?.close()
  await server?.stop(true)
})

describe('Workspace instance chat experience', () => {
  for (const canvas of [false, true]) {
    test(`shows and restores the persistent Sentinel conversation (${canvas ? 'Canvas' : 'Clásica'})`, async () => {
      sentinelChats.length = 0
      sentinelThread.length = 0
      const page = await browser.newPage()
      try {
        await page.evaluateOnNewDocument(() => {
          class LocalWebSocket {
            readyState = 0
            onopen: (() => void) | null = null
            onclose: (() => void) | null = null
            onmessage: ((event: { data: string }) => void) | null = null
            constructor() {
              Object.defineProperty(window, '__workspaceSocket', { configurable: true, value: this })
              setTimeout(() => {
                this.readyState = 1
                this.onopen?.()
              }, 0)
            }
            send() {}
            close() {}
          }
          Object.defineProperty(window, 'WebSocket', { configurable: true, value: LocalWebSocket })
        })
        await page.goto(`http://127.0.0.1:${server.port}/${canvas ? '?view=canvas' : ''}`)
        await page.waitForFunction(() => document.querySelector('#conn')?.textContent === 'Conectado')
        await page.evaluate(() => {
          let confirmationCount = 0
          window.confirm = () => {
            confirmationCount++
            return false
          }
          Reflect.set(window, '__confirmationCount', () => confirmationCount)
          const prompt = document.querySelector<HTMLTextAreaElement>('[data-sentinel-chat-input]')!
          prompt.value = 'Hola Sentinel, ¿qué puedes hacer?'
          const form=prompt.closest('form')!
          form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))
        })
        await page.waitForFunction(() => document.body.textContent
          ?.includes('Puedo conversar y explicar las acciones disponibles de Sentinel.') === true)

        expect(sentinelChats).toEqual(['Hola Sentinel, ¿qué puedes hacer?'])
        const result = await page.evaluate(() => ({
          confirmationCount: (Reflect.get(window, '__confirmationCount') as () => number)(),
          conversation: document.body.textContent || '',
        }))
        expect(result.confirmationCount).toBe(0)
        expect(result.conversation).toContain('Hola Sentinel, ¿qué puedes hacer?')
        expect(result.conversation).not.toContain('[Sugerencia sobre el mensaje seleccionado]')
        expect(sentinelThread.map(message=>message.role)).toEqual(['user','assistant'])
        await page.reload()
        await page.waitForFunction(() => document.querySelector('[data-sentinel-chat-history]')?.textContent
          ?.includes('Hola Sentinel, ¿qué puedes hacer?') === true)
        expect(await page.$eval('[data-sentinel-chat-history]',element=>element.textContent))
          .toContain('Puedo conversar y explicar las acciones disponibles de Sentinel.')
      } finally {
        await page.close()
      }
    })
  }

  for (const canvas of [false, true]) {
    test(`requires confirmation for a Sentinel-proposed launch (${canvas ? 'Canvas' : 'Clásica'})`, async () => {
      sentinelThread.length=0
      confirmedSentinelLaunches.length=0
      const page=await browser.newPage()
      try{
        await page.evaluateOnNewDocument(()=>{
          class LocalWebSocket {
            readyState=0
            onopen:(()=>void)|null=null
            onclose:(()=>void)|null=null
            onmessage:((event:{data:string})=>void)|null=null
            constructor(){setTimeout(()=>{this.readyState=1;this.onopen?.()},0)}
            send(){}
            close(){}
          }
          Object.defineProperty(window,'WebSocket',{configurable:true,value:LocalWebSocket})
        })
        await page.goto(`http://127.0.0.1:${server.port}/${canvas?'?view=canvas':''}`)
        await page.waitForFunction(()=>document.querySelector('#conn')?.textContent==='Conectado')
        await page.evaluate(() => Reflect.get(window, 'workspaceLayout').preset('work'))
        await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('[data-sentinel-chat-history]')]
          .some(history => history.getClientRects().length > 0))
        await page.evaluate(()=>{
          window.confirm=()=>true
          const input=document.querySelector<HTMLTextAreaElement>('[data-sentinel-chat-input]')!
          input.value='Lanza un Relay ChatGPT'
          input.closest('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))
        })
        await page.waitForSelector('.sentinel-launch-proposal button')
        expect(confirmedSentinelLaunches).toHaveLength(0)
        await page.evaluate(()=>{
          const button=[...document.querySelectorAll<HTMLButtonElement>('.sentinel-launch-proposal button')]
            .find(item=>item.getClientRects().length>0)
          if(!button)throw new Error('Visible confirmation action was not rendered.')
          button.click()
        })
        await page.waitForFunction(()=>document.querySelector('[data-sentinel-chat-status]')?.textContent
          ?.includes('Lanzamiento completado')===true)
        expect(confirmedSentinelLaunches).toHaveLength(1)
        expect(confirmedSentinelLaunches[0]).toMatchObject({
          target:'relay',platformId:'chatgpt',count:1,purpose:'agent',registerAsWorkspaceWorker:true,
        })
        expect(sentinelThread.at(-1)?.role).toBe('status')
        expect(sentinelThread.at(-1)?.text).toContain('Lanzamiento completado')
      }finally{await page.close()}
    })
  }

  for (const canvas of [false, true]) {
    test(`keeps the Sentinel card usable when history is unavailable (${canvas ? 'Canvas' : 'Clásica'})`, async () => {
      sentinelThread.length = 0
      failSentinelHistoryRequest = true
      const page = await browser.newPage()
      try {
        await page.evaluateOnNewDocument(() => {
          class LocalWebSocket {
            readyState = 0
            onopen: (() => void) | null = null
            onclose: (() => void) | null = null
            onmessage: ((event: { data: string }) => void) | null = null
            constructor() {
              setTimeout(() => {
                this.readyState = 1
                this.onopen?.()
              }, 0)
            }
            send() {}
            close() {}
          }
          Object.defineProperty(window, 'WebSocket', { configurable: true, value: LocalWebSocket })
        })
        await page.goto(`http://127.0.0.1:${server.port}/${canvas ? '?view=canvas' : ''}`)
        await page.waitForFunction(() => document.querySelector('[data-sentinel-chat-status]')?.textContent
          ?.includes('Puedes enviar un mensaje nuevo.') === true)
        expect(await page.$eval('[data-sentinel-chat-send]', button => (button as HTMLButtonElement).disabled))
          .toBe(false)
        await page.evaluate(() => {
          const input = document.querySelector<HTMLTextAreaElement>('[data-sentinel-chat-input]')!
          input.value = 'Saludo desde la tarjeta'
          input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
        })
        await page.waitForFunction(() => document.querySelector('[data-sentinel-chat-history]')?.textContent
          ?.includes('Puedo conversar y explicar las acciones disponibles de Sentinel.') === true)
        expect(sentinelChats).toContain('Saludo desde la tarjeta')
      } finally {
        failSentinelHistoryRequest = false
        await page.close()
      }
    })
  }

  for (const canvas of [false, true]) {
    test(`sends from the bottom composer with Workspace WebSocket disconnected (${canvas ? 'Canvas' : 'Clásica'})`, async () => {
      sentinelThread.length = 0
      sentinelChats.length = 0
      const page = await browser.newPage()
      try {
        await page.evaluateOnNewDocument(() => {
          class LocalWebSocket {
            readyState = 0
            onopen: (() => void) | null = null
            onclose: (() => void) | null = null
            onmessage: ((event: { data: string }) => void) | null = null
            constructor() {
              Reflect.set(window, '__workspaceSocket', this)
              setTimeout(() => {
                this.readyState = 1
                this.onopen?.()
              }, 0)
            }
            send() {}
            close() {
              this.readyState = 3
              this.onclose?.()
            }
          }
          Object.defineProperty(window, 'WebSocket', { configurable: true, value: LocalWebSocket })
        })
        await page.goto(`http://127.0.0.1:${server.port}/${canvas ? '?view=canvas' : ''}`)
        await page.waitForFunction(() => document.querySelector('#conn')?.textContent === 'Conectado')
        await page.evaluate(() => {
          Reflect.get(window, '__workspaceSocket').close()
          const destination = document.querySelector<HTMLSelectElement>('#destination')!
          destination.value = 'sentinel'
          destination.dispatchEvent(new Event('change', { bubbles: true }))
          const prompt = document.querySelector<HTMLInputElement>('#prompt')!
          prompt.value = 'Saludo desde el compositor inferior'
          document.querySelector<HTMLButtonElement>('#inputbar button[onclick="send()"]')!.click()
        })
        await page.waitForFunction(() => document.querySelector('[data-sentinel-chat-history]')?.textContent
          ?.includes('Puedo conversar y explicar las acciones disponibles de Sentinel.') === true)
        expect(sentinelChats).toEqual(['Saludo desde el compositor inferior'])
        expect(await page.$eval('#conn', element => element.textContent)).toBe('Desconectado')
      } finally {
        await page.close()
      }
    })
  }

  for (const canvas of [false, true]) {
    test(`sends and reflects the response in the exact instance card (${canvas ? 'Canvas' : 'Clásica'})`, async () => {
      messages.clear()
      sent.length = 0
      const page = await browser.newPage()
      try {
        await page.setViewport({ width: 1440, height: 1000 })
        await page.evaluateOnNewDocument(() => {
          class LocalWebSocket {
            readyState = 0
            onopen: (() => void) | null = null
            onclose: (() => void) | null = null
            onmessage: ((event: { data: string }) => void) | null = null
            constructor() {
              Object.defineProperty(window, '__workspaceSocket', { configurable: true, value: this })
              setTimeout(() => {
                this.readyState = 1
                this.onopen?.()
              }, 0)
            }
            send() {}
            close() {
              this.readyState = 3
              this.onclose?.()
            }
          }
          Object.defineProperty(window, 'WebSocket', { configurable: true, value: LocalWebSocket })
        })
        await page.goto(`http://127.0.0.1:${server.port}/${canvas ? '?view=canvas' : ''}`)
        await page.waitForSelector('.instance-chat-panel')
        await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('.instance-chat-panel')]
          .some(panel => panel.dataset.instanceChatId === 'relay-fixture' && panel.dataset.contextReady === 'true'))
        await page.evaluate(() => Reflect.get(window, 'workspaceLayout').preset('work'))
        await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('.instance-chat-panel')]
          .some(panel => panel.dataset.instanceChatId === 'relay-fixture' && panel.getClientRects().length > 0))
        expect(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.instance-chat-panel')]
          .some(panel => panel.dataset.instanceChatId === 'relay-fixture' && panel.getClientRects().length > 0))).toBe(true)
        await page.evaluate(() => {
          const panel = [...document.querySelectorAll<HTMLElement>('.instance-chat-panel')]
            .find(element => element.dataset.instanceChatId === 'relay-fixture' && element.getClientRects().length > 0)
          if (!panel) throw new Error('No visible instance chat card was rendered.')
          const input = panel.querySelector<HTMLTextAreaElement>('.instance-chat-input')!
          input.value = 'Continúa este trabajo'
          input.dispatchEvent(new Event('input', { bubbles: true }))
          panel.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
        })
        await page.waitForFunction(() =>
          [...document.querySelectorAll('.instance-chat-history')]
            .some(history => history.textContent?.includes('Respuesta fixture')),
        )

        expect(sent).toEqual([{
          instanceId: 'relay-fixture',
          text: 'Continúa este trabajo',
          conversationId: 'chat-fixture',
        }])
        const historyText = await page.evaluate(() =>
          document.querySelector<HTMLElement>('[data-instance-chat-id="relay-fixture"] .instance-chat-history')?.textContent)
        expect(historyText).toContain('Continúa este trabajo')
        expect(historyText).toContain('Respuesta fixture')
        await page.locator('[data-instance-launch-history] summary').click()
        await page.waitForFunction(() =>
          document.querySelector('[data-instance-launch-history-list]')?.textContent
            ?.includes('Respuesta de lanzamiento fixture') === true,
        )
      } finally {
        await page.close()
      }
    })
  }
})
