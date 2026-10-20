import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'

let browser: Browser
let page: Page
const source = readFileSync(new URL('./launchDialog.js', import.meta.url), 'utf8')
beforeAll(async () => {
  const executablePath = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].find(path => path && existsSync(path))
  if (!executablePath) throw new Error('Chrome executable unavailable')
  browser = await puppeteer.launch({ executablePath, headless: true,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'],
  })
}, 30000)
afterAll(async () => { await browser?.close() })
beforeEach(async () => {
  page = await browser.newPage()
  await page.setRequestInterception(true)
  page.on('request', request => {
    void request.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body></body></html>' })
  })
  await page.goto('http://127.0.0.1:39999/test')
  await page.evaluate(() => {
    localStorage.clear()
    const state = { operations: [] as any[], posts: [] as any[], failHistory: false }
    ;(window as any).__launchTest = state
    window.fetch = async (input, init) => {
      const url = String(input)
      if (url === '/api/status') return new Response(JSON.stringify({
        platforms: [
          { id: 'chatgpt', name: 'ChatGPT' },
          {
            id: 'chatx',
            name: 'ChatX',
            description: 'ChatX web chat; choose an available model in ChatX. Gemini 3.8 Flash may require registration',
          },
        ],
        masterSessions: [{
          id: 'astra-gpt', name: 'Astra GPT', platformId: 'chatx',
          debugPort: 9400, active: false, authenticated: false,
        }], chromeProfiles: [],
        localPlatforms: [{
          id: 'antigravity', name: 'Antigravity', description: 'Google Antigravity',
          installed: true, launchMethod: 'spawn',
        }],
      }), { status: 200 })
      if (url === '/api/launch-operations') {
        if (state.failHistory) throw new Error('simulated connection loss')
        return new Response(JSON.stringify({ operations: state.operations }), { status: 200 })
      }
      if (url === '/api/launch?async=1') {
        const body = JSON.parse(String(init?.body))
        state.posts.push(body)
        const operation = { id: body.requestId, status: 'running', createdAt: Date.now() }
        state.operations = [operation]
        return new Response(JSON.stringify({ operation }), { status: 202 })
      }
      throw new Error('Unexpected test request: ' + url)
    }
  })
  await page.addScriptTag({ content: source })
})
afterEach(async () => { await page?.close() })
async function open() { await page.evaluate(() => (window as any).createLaunchDialog()) }
async function text() { return page.$eval('#launch-modal', node => node.textContent || '') }
async function disabled() { return page.$eval('#launch-submit', node => (node as HTMLButtonElement).disabled) }

describe('recoverable launch dialog', () => {
  test('reopening shows the running operation without resending it', async () => {
    await page.evaluate(() => { (window as any).__launchTest.operations = [
      { id: 'running-request-0001', status: 'running', createdAt: Date.now() - 5000 },
    ] })
    await open()
    await page.waitForFunction(() => document.querySelector('#launch-modal')?.textContent?.includes('running-request-0001'))
    expect(await disabled()).toBe(true)
    await page.click('#launch-cancel')
    expect(await page.$('#launch-modal')).toBeNull()
    await open()
    await page.waitForFunction(() => document.querySelector('#launch-modal')?.textContent?.includes('running-request-0001'))
    expect(await disabled()).toBe(true)
    expect(await page.evaluate(() => (window as any).__launchTest.posts.length)).toBe(0)
  })

  test('unknown outcomes remain visible and block another launch', async () => {
    await page.evaluate(() => { (window as any).__launchTest.operations = [
      { id: 'unknown-request-001', status: 'unknown', createdAt: Date.now(), error: 'Inspect existing instances.' },
    ] })
    await open()
    await page.waitForFunction(() => document.querySelector('#launch-modal')?.textContent?.includes('Resultado desconocido'))
    expect(await disabled()).toBe(true)
    expect(await text()).toContain('Inspect existing instances.')
  })

  test('local launch history hides unrelated ChatX failures and names matching launches', async () => {
    await page.evaluate(() => { (window as any).__launchTest.operations = [
      {
        id: 'old-chatx-failure-001', target: 'relay', platformId: 'chatx',
        status: 'failed', createdAt: Date.now() - 60000, error: 'Old ChatX failure.',
      },
      {
        id: 'antigravity-launch-001', target: 'local', platformId: 'antigravity',
        status: 'succeeded', createdAt: Date.now() - 30000, finishedAt: Date.now() - 29000,
      },
    ] })
    await open()
    await page.waitForFunction(() => document.querySelector('#launch-local-platform option[value="antigravity"]'))
    await page.select('#launch-target', 'local')
    await page.select('#launch-local-platform', 'antigravity')
    await page.waitForFunction(() => document.querySelector('#launch-modal')?.textContent?.includes('antigravity-launch-001'))
    const status = await page.$eval('[role="status"]', node => node.textContent || '')
    expect(status).toContain('Instancia local · Antigravity')
    expect(status).not.toContain('old-chatx-failure-001')
    expect(status).not.toContain('Old ChatX failure.')
  })

  test('an unrelated unconfirmed launch remains visible and blocks new launch', async () => {
    await page.evaluate(() => { (window as any).__launchTest.operations = [
      {
        id: 'chatx-running-request-01', target: 'relay', platformId: 'chatx',
        status: 'running', createdAt: Date.now(),
      },
    ] })
    await open()
    await page.waitForFunction(() => document.querySelector('#launch-local-platform option[value="antigravity"]'))
    await page.select('#launch-target', 'local')
    await page.select('#launch-local-platform', 'antigravity')
    await page.waitForFunction(() => document.querySelector('#launch-modal')?.textContent?.includes('chatx-running-request-01'))
    expect(await disabled()).toBe(true)
    expect(await text()).toContain('Relay · ChatX')
  })

  test('recovers a locally saved request using exactly the original identity', async () => {
    await page.evaluate(() => localStorage.setItem('workspace.pending-launch.v1', JSON.stringify({
      id: 'saved-request-00001', payload: { platformId: 'chatgpt', purpose: 'user', count: 1 },
    })))
    await open()
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Recuperar solicitud pendiente'))
    expect(await disabled()).toBe(true)
    await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Recuperar solicitud pendiente')?.click())
    await page.waitForFunction(() => localStorage.getItem('workspace.pending-launch.v1') === null)
    expect(await page.evaluate(() => (window as any).__launchTest.posts)).toEqual([
      { platformId: 'chatgpt', purpose: 'user', count: 1, requestId: 'saved-request-00001' },
    ])
    expect(await disabled()).toBe(true)
  })

  test('connection loss blocks launch, then a confirmed completion enables it', async () => {
    await page.evaluate(() => { (window as any).__launchTest.failHistory = true })
    await open()
    await page.waitForFunction(() => document.querySelector('#launch-error')?.textContent?.includes('simulated connection loss'))
    expect(await disabled()).toBe(true)
    await page.evaluate(() => {
      const state = (window as any).__launchTest
      state.failHistory = false
      state.operations = [{ id: 'finished-request-001', status: 'succeeded', createdAt: Date.now(), finishedAt: Date.now() }]
      ;[...document.querySelectorAll('button')].find(button => button.textContent === 'Consultar estado')?.click()
    })
    await page.waitForFunction(() => document.querySelector('#launch-modal')?.textContent?.includes('Completado'))
    expect(await disabled()).toBe(false)
    expect(await page.evaluate(() => (window as any).__launchTest.posts.length)).toBe(0)
  })

  test('Antigravity launch explains that model choice remains per conversation', async () => {
    await open()
    await page.waitForFunction(() => document.querySelector('#launch-local-platform option[value="antigravity"]'))
    await page.select('#launch-target', 'local')
    await page.select('#launch-local-platform', 'antigravity')
    const modelHelp = await page.$eval('#launch-local-model-help', node => ({
      hidden: (node as HTMLElement).hidden,
      text: node.textContent || '',
    }))
    expect(modelHelp.hidden).toBe(false)
    expect(modelHelp.text).toContain('Gemini 3.8')
    expect(modelHelp.text).toContain('no puede preseleccionarlo ni verificarlo')
  })

  test('exposes ChatX in the Web Relay launch selector and shows its model-selection guidance', async () => {
    await open()
    await page.waitForFunction(() => document.querySelector('#launch-platform option[value="chatx"]'))
    await page.select('#launch-platform', 'chatx')
    const platformHelp = await page.$eval('#launch-platform-help', node => node.textContent || '')
    expect(platformHelp).toContain('choose an available model in ChatX')
    expect(platformHelp).toContain('Gemini 3.8 Flash may require registration')
  })

  test('lists a ChatX Master source and submits its source ID in the Master-only launch', async () => {
    await open()
    await page.waitForFunction(() => document.querySelector('#launch-target'))
    await page.select('#launch-target', 'master')
    await page.waitForFunction(() => document.querySelector('#launch-masters input[value="astra-gpt"]'))
    expect(await text()).toContain('ChatX')
    expect(await text()).toContain('ChatGPT y Claude')

    await page.click('#launch-masters input[value="astra-gpt"]')
    await page.click('#launch-submit')
    await page.waitForFunction(() => (window as any).__launchTest.posts.length > 0)
    expect(await page.evaluate(() => (window as any).__launchTest.posts[0])).toMatchObject({
      target: 'master',
      masterSessionSourceIds: ['astra-gpt'],
    })
  })
})
