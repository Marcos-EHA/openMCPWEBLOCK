import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import { runSAStartupAutomationControls, type SAAutomationEvaluator } from './SAStartupAutomationControls.js'

let browser: Browser | undefined
let page: Page
let server: ReturnType<typeof Bun.serve> | undefined
const storageKey = 'mcp-super-assistant-ui-store'

beforeAll(async () => {
  const executablePath = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].find(candidate => candidate && existsSync(candidate))
  if (!executablePath) throw new Error('Chrome executable unavailable')
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('<!doctype html><html><body></body></html>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }),
  })
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'],
  })
  page = await browser.newPage()
}, 30_000)

beforeEach(async () => {
  await page.goto(server!.url.href, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => localStorage.clear())
})

afterAll(async () => {
  await browser?.close()
  server?.stop(true)
})

async function installFixture(options: {
  enabled?: boolean
  restore?: boolean
  remountOnce?: boolean
  portalDelayMs?: number
  initiallyOpen?: boolean
  disableAutoExecute?: boolean
  omitSidebarInitially?: boolean
  sidebarInitiallyVisible?: boolean
} = {}) {
  await page.evaluate(opts => {
    const key = 'mcp-super-assistant-ui-store'
    const enabled = opts.enabled === true
    const state: any = opts.restore ? JSON.parse(localStorage.getItem(key)!).state : {
      mcpEnabled: enabled,
      preferences: {
        isPushMode: enabled, autoInsert: enabled, autoSubmit: enabled,
        autoExecute: enabled, isMinimized: enabled,
      },
      sidebar: {
        isVisible: opts.sidebarInitiallyVisible ?? true,
        isMinimized: enabled,
      },
    }
    const stats = {
      opens: 0, closes: 0, shows: 0, minimizes: 0,
      compactLayouts: 0,
      changes: { mcpEnabled: 0, isPushMode: 0, autoInsert: 0, autoSubmit: 0, autoExecute: 0 } as Record<string, number>,
    }
    let open = opts.initiallyOpen === true
    let remounted = false
    let firstSidebarRender = true
    const persist = () => localStorage.setItem(key, JSON.stringify({ state }))
    persist()
    document.body.innerHTML = '<form><div id="mcp-popover-container"></div></form><div id="mcp-sidebar-shadow-host"></div>'
    const mount = document.getElementById('mcp-popover-container')!
    const shadow = document.getElementById('mcp-sidebar-shadow-host')!.attachShadow({ mode: 'open' })
    let trigger: HTMLButtonElement

    function renderSidebar() {
      shadow.innerHTML = ''
      if (opts.omitSidebarInitially && firstSidebarRender) {
        firstSidebarRender = false
        return
      }
      firstSidebarRender = false
      const pushEnabled = state.preferences.isPushMode === true
      const compactWidth = state.sidebar.isMinimized ? 56 : state.sidebar.width || 320
      document.documentElement.classList.toggle('push-mode-enabled', pushEnabled)
      document.documentElement.classList.toggle('sidebar-collapsed', pushEnabled && state.sidebar.isMinimized)
      if (pushEnabled) document.documentElement.style.setProperty('--sidebar-width-mcp', compactWidth + 'px')
      else document.documentElement.style.removeProperty('--sidebar-width-mcp')
      shadow.querySelector('#fixture-sidebar-width')?.remove()
      const sidebar = document.createElement('div')
      sidebar.className = 'sidebar' + (state.sidebar.isMinimized ? ' collapsed' : '')
      sidebar.style.cssText = 'position:fixed;right:0;top:0;height:150px;background:#ddd;'
      sidebar.style.width = state.sidebar.isMinimized ? '56px' : '320px'
      sidebar.style.display = state.mcpEnabled && state.sidebar.isVisible ? 'block' : 'none'
      const minimize = document.createElement('button')
      minimize.type = 'button'
      minimize.setAttribute('aria-label', state.sidebar.isMinimized ? 'Expand sidebar' : 'Minimize sidebar')
      minimize.textContent = state.sidebar.isMinimized ? 'Expand' : 'Minimize'
      minimize.addEventListener('click', () => {
        state.sidebar.isMinimized = !state.sidebar.isMinimized
        state.preferences.isMinimized = state.sidebar.isMinimized
        stats.minimizes++
        persist()
        renderSidebar()
      })
      sidebar.appendChild(minimize)
      const push = document.createElement('button')
      push.type = 'button'
      push.setAttribute('role', 'switch')
      push.setAttribute('aria-checked', String(state.preferences.isPushMode))
      const accessibleLabel = document.createElement('span')
      accessibleLabel.className = 'sr-only'
      accessibleLabel.textContent = 'Push Content Mode'
      push.appendChild(accessibleLabel)
      push.addEventListener('click', () => {
        state.preferences.isPushMode = !state.preferences.isPushMode
        stats.changes.isPushMode++
        persist()
        renderSidebar()
      })
      sidebar.appendChild(push)
      shadow.appendChild(sidebar)
    }

    function renderPanel() {
      document.querySelector('.mcp-popover')?.remove()
      trigger.setAttribute('aria-expanded', String(open))
      if (!open) return
      const panel = document.createElement('section')
      panel.className = 'mcp-popover'
      panel.style.cssText = 'position:fixed;left:20px;top:60px;width:260px;background:white;padding:10px;'
      const inputs = [
        ['mcp-toggle', 'mcpEnabled'],
        ['auto-insert-toggle', 'autoInsert'],
        ['auto-submit-toggle', 'autoSubmit'],
        ['auto-execute-toggle', 'autoExecute'],
      ]
      for (const [id, property] of inputs) {
        const item = document.createElement('label')
        item.className = 'mcp-toggle-item'
        item.style.display = 'block'
        const input = document.createElement('input')
        input.type = 'checkbox'
        input.id = id!
        input.checked = property === 'mcpEnabled' ? state.mcpEnabled : state.preferences[property!]
        input.disabled = property !== 'mcpEnabled' && (!state.mcpEnabled ||
          (property === 'autoExecute' && opts.disableAutoExecute === true))
        input.addEventListener('change', () => {
          if (property === 'mcpEnabled') state.mcpEnabled = input.checked
          else state.preferences[property!] = input.checked
          stats.changes[property!]++
          persist()
          renderPanel()
          renderSidebar()
        })
        item.append(input, property!)
        panel.appendChild(item)
      }
      const close = document.createElement('button')
      close.type = 'button'
      close.className = 'mcp-close-button'
      close.textContent = 'Close'
      close.addEventListener('click', () => {
        stats.closes++
        open = false
        renderPanel()
      })
      panel.append(close)
      const hideSidebar = document.createElement('button')
      hideSidebar.type = 'button'
      hideSidebar.className = 'mcp-hide-sidebar'
      hideSidebar.textContent = 'Hide sidebar'
      hideSidebar.addEventListener('click', () => {
        state.sidebar.isVisible = false
        persist()
        renderSidebar()
      })
      panel.append(hideSidebar)
      document.body.appendChild(panel)
    }

    function mountButton() {
      mount.innerHTML = ''
      trigger = document.createElement('button')
      trigger.type = 'button'
      trigger.setAttribute('data-testid', 'mcp-settings-button')
      trigger.setAttribute('aria-expanded', 'false')
      trigger.textContent = 'MCP'
      trigger.addEventListener('click', () => {
        stats.opens++
        if (opts.remountOnce && !remounted) {
          remounted = true
          mountButton()
          return
        }
        trigger.setAttribute('aria-expanded', 'true')
        const show = () => { open = true; renderPanel() }
        if (opts.portalDelayMs) setTimeout(show, opts.portalDelayMs)
        else show()
      })
      mount.appendChild(trigger)
    }
    ;(window as any).activeSidebarManager = {
      show: async () => {
        stats.shows++
        state.sidebar.isVisible = true
        persist()
        renderSidebar()
      },
      setPushContentMode: (pushMode: boolean, width: number, collapsed: boolean) => {
        stats.compactLayouts++
        if (pushMode && collapsed) {
          document.documentElement.classList.add('sidebar-collapsed')
          document.documentElement.style.setProperty('--sidebar-width-mcp', width + 'px')
        }
      },
    }
    ;(window as any).__saFixture = { stats, state }
    mountButton()
    renderPanel()
    renderSidebar()
  }, options)
}

const evaluate: SAAutomationEvaluator = async <T>(expression: string) => await page.evaluate(expression) as T
const run = (configure: boolean, timeoutMs = 2_500) => runSAStartupAutomationControls(evaluate, {
  platformId: 'chatgpt', configure, timeoutMs, pollIntervalMs: 40,
})
const stats = () => page.evaluate(() => (window as any).__saFixture.stats)

describe('SuperAssistant startup automation controls', () => {
  test('uses live actions and retains their state after a document reload', async () => {
    await installFixture()
    await run(true)
    const configured = await stats()
    expect(Object.values(configured.changes)).toEqual([1, 1, 1, 1, 1])
    expect(configured.shows).toBe(0)
    expect(configured.minimizes).toBe(1)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await installFixture({ restore: true })
    await run(false)
    const verified = await stats()
    expect(Object.values(verified.changes)).toEqual([0, 0, 0, 0, 0])
    expect(verified.shows).toBe(0)
    expect(verified.minimizes).toBe(0)
  })

  test('reopens settings when the initial trigger is replaced during startup', async () => {
    await installFixture({ enabled: true, remountOnce: true })
    await run(false)
    expect((await stats()).opens).toBe(2)
    expect((await stats()).closes).toBe(1)
  })

  test('waits for an expanded trigger to mount its portal without toggling it again', async () => {
    await installFixture({ enabled: true, portalDelayMs: 180 })
    await run(false)
    expect((await stats()).opens).toBe(1)
  })

  test('waits for the sidebar to mount without throwing during UI inspection', async () => {
    await installFixture({ enabled: true, omitSidebarInitially: true })
    const error = await run(true, 1200).then(() => undefined, reason => reason)
    if (error) {
      const fixture = await page.evaluate(() => (window as any).__saFixture.stats)
      throw new Error(`${String(error)}; fixture state: ${JSON.stringify(fixture)}`)
    }
    expect((await stats()).shows).toBe(1)
    expect(await page.evaluate(() => Boolean(
      document.querySelector('#mcp-sidebar-shadow-host')?.shadowRoot?.querySelector('.sidebar'),
    ))).toBe(true)
  }, 15_000)

  test('preserves a sidebar hidden by the saved user preference during launch setup', async () => {
    await installFixture({ enabled: true, sidebarInitiallyVisible: false })
    await run(true)
    expect((await stats()).shows).toBe(0)
    expect(await page.evaluate(() => JSON.parse(
      localStorage.getItem('mcp-super-assistant-ui-store')!,
    ).state.sidebar.isVisible)).toBe(false)
  })

  test('does not reopen a dismissed settings panel after it was verified', async () => {
    await installFixture({ enabled: true })
    let evaluations = 0
    const dismissAfterVerification: SAAutomationEvaluator = async <T>(expression: string) => {
      const result = await page.evaluate(expression) as T
      evaluations++
      if (evaluations === 2) await page.click('.mcp-close-button')
      return result
    }
    await runSAStartupAutomationControls(dismissAfterVerification, {
      platformId: 'chatgpt',
      configure: true,
      timeoutMs: 1200,
      pollIntervalMs: 40,
    })
    expect((await stats()).opens).toBe(1)
    expect(await page.$('.mcp-popover')).toBeNull()
  })

  test('does not show the sidebar again when the user hides it during launch setup', async () => {
    await installFixture({ enabled: true })
    let evaluations = 0
    const hideAfterFirstInspection: SAAutomationEvaluator = async <T>(expression: string) => {
      const result = await page.evaluate(expression) as T
      evaluations++
      if (evaluations === 2) await page.click('.mcp-hide-sidebar')
      return result
    }
    await runSAStartupAutomationControls(hideAfterFirstInspection, {
      platformId: 'chatgpt',
      configure: true,
      timeoutMs: 1200,
      pollIntervalMs: 40,
    })
    expect((await stats()).shows).toBe(0)
    expect(await page.evaluate(() => JSON.parse(
      localStorage.getItem('mcp-super-assistant-ui-store')!,
    ).state.sidebar.isVisible)).toBe(false)
  })

  test('fails verification when saved preferences disagree with enabled controls', async () => {
    await installFixture({ enabled: true })
    await page.evaluate(key => {
      const saved = JSON.parse(localStorage.getItem(key)!)
      saved.state.preferences.autoExecute = false
      localStorage.setItem(key, JSON.stringify(saved))
    }, storageKey)
    const failure = await run(false, 300).then(() => null, error => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('verification after reload')
    expect(Object.values((await stats()).changes)).toEqual([0, 0, 0, 0, 0])
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).state.preferences.autoExecute, storageKey)).toBe(false)
  })

  test('preserves a panel that was already open and does not toggle enabled options', async () => {
    await installFixture({ enabled: true, initiallyOpen: true })
    await run(true)
    expect((await stats()).opens).toBe(0)
    expect((await stats()).closes).toBe(0)
    expect(Object.values((await stats()).changes)).toEqual([0, 0, 0, 0, 0])
    expect(await page.$('.mcp-popover')).not.toBeNull()
  })

  test('does not mark a disabled automation control ready', async () => {
    await installFixture({ disableAutoExecute: true })
    const failure = await run(true, 700).then(() => null, error => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('configuration through the interface')
    expect((await stats()).changes.autoExecute).toBe(0)
    expect(await page.evaluate(() => (window as any).__saFixture.state.preferences.autoExecute)).toBe(false)
  })

  test('accepts the fully applied compact layout while its measured width is mid-transition', async () => {
    await installFixture({ enabled: true })
    await page.evaluate(() => {
      const shadow = document.getElementById('mcp-sidebar-shadow-host')!.shadowRoot!
      const width = document.createElement('style')
      width.id = 'fixture-sidebar-width'
      width.textContent = '.sidebar { transition: width 500ms linear !important; }'
      shadow.appendChild(width)
      const sidebar = shadow.querySelector('.sidebar') as HTMLElement
      sidebar.style.width = '320px'
      void sidebar.getBoundingClientRect().width
      sidebar.style.width = '56px'
    })
    await run(false)
    const sidebar = await page.evaluate(() => {
      const element = document.querySelector('#mcp-sidebar-shadow-host')
        ?.shadowRoot?.querySelector('.sidebar') as HTMLElement | null | undefined
      return {
        width: element?.getBoundingClientRect().width,
        computedWidth: getComputedStyle(element!).width,
        configuredWidth: element?.style.width,
        collapsed: element?.classList.contains('collapsed'),
      }
    })
    expect(sidebar).toEqual({ width: 56, computedWidth: '56px', configuredWidth: '56px', collapsed: true })
    await page.evaluate(() => document.getElementById('mcp-sidebar-shadow-host')!
      .shadowRoot!.querySelector('#fixture-sidebar-width')!.remove())
    await run(false)
  })

  test('reapplies compact Push layout when the sidebar is compact but document layout styles are stale', async () => {
    await installFixture({ enabled: true })
    await page.evaluate(() => {
      document.documentElement.classList.remove('sidebar-collapsed')
      document.documentElement.style.removeProperty('--sidebar-width-mcp')
    })
    await run(false)
    expect((await stats()).compactLayouts).toBe(1)
    expect(await page.evaluate(() => ({
      collapsed: document.documentElement.classList.contains('sidebar-collapsed'),
      width: document.documentElement.style.getPropertyValue('--sidebar-width-mcp'),
    }))).toEqual({ collapsed: true, width: '56px' })
  })
})
