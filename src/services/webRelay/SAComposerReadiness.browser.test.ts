import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import { SA_COMPOSER_BUTTON_SELECTOR, SA_COMPOSER_READINESS_SCRIPT } from './SAComposerReadiness.js'

let browser: Browser | undefined
let page: Page
beforeAll(async () => {
  const executablePath = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].find(path => path && existsSync(path))
  if (!executablePath) throw new Error('Chrome executable unavailable')
  browser = await puppeteer.launch({
    executablePath, headless: true,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'],
  })
  page = await browser.newPage()
}, 30000)
afterAll(async () => { await browser?.close() })

async function inspect(html: string) {
  await page.setContent('<style>button{box-sizing:border-box;width:32px;height:32px}</style>' + html)
  return page.evaluate(SA_COMPOSER_READINESS_SCRIPT)
}
function composer(attributes: string, style = '') {
  return '<form><div id="mcp-popover-container"><button type="button" ' + attributes +
    ' style="' + style + '">M</button></div></form>'
}

describe('SuperAssistant composer readiness', () => {
  test('finds the stable identifier independently of translated labels', async () => {
    expect(await inspect(composer('data-testid="mcp-settings-button" aria-label="Parametres"')))
      .toMatchObject({ buttonPresent: true, compact: true, insideComposer: true, visible: true })
    await page.$eval(SA_COMPOSER_BUTTON_SELECTOR, button => {
      button.addEventListener('click', () => { button.setAttribute('data-clicked', 'true') })
      ;(button as HTMLButtonElement).click()
    })
    expect(await page.$eval(SA_COMPOSER_BUTTON_SELECTOR, button => button.getAttribute('data-clicked'))).toBe('true')
  })

  test('accepts the current Spanish label without the new identifier', async () => {
    expect(await inspect(composer('aria-label="Ajustes MCP. Sin ejecuciones activas"')))
      .toMatchObject({ buttonPresent: true, compact: true, insideComposer: true, visible: true })
  })

  test('accepts the legacy English label', async () => {
    expect(await inspect(composer('aria-label="MCP Settings. Connected"')))
      .toMatchObject({ buttonPresent: true, compact: true, insideComposer: true, visible: true })
  })

  test('does not report a nonexistent button as compact or visible', async () => {
    expect(await inspect('<form><div id="mcp-popover-container"></div></form>'))
      .toMatchObject({ buttonPresent: false, compact: false, insideComposer: false, visible: false })
  })

  test('keeps a hidden button unavailable', async () => {
    expect(await inspect(composer('data-testid="mcp-settings-button"', 'display:none')))
      .toMatchObject({ buttonPresent: true, visible: false })
  })

  test('does not accept a floating button as inside the composer', async () => {
    expect(await inspect('<div id="mcp-popover-container"><button data-testid="mcp-settings-button">M</button></div>'))
      .toMatchObject({ buttonPresent: true, visible: true, insideComposer: false })
  })

  test('recognizes ChatX controls inside its non-form composer', async () => {
    expect(await inspect('<div id="inputfielddiv" style="position:relative;width:500px;height:90px">' +
      '<div id="mcp-popover-container"><button data-testid="mcp-settings-button">M</button></div>' +
      '<textarea id="prompt"></textarea></div>'))
      .toMatchObject({ buttonPresent: true, visible: true, insideComposer: true })
  })

  test('accepts an in-flow control across narrow, normal and wide viewports', async () => {
    try {
      await inspect('<form style="display:flex;align-items:center;max-width:680px">' +
        '<span style="display:contents"><button type="button">+</button>' +
        '<div id="mcp-popover-container" style="display:inline-flex;flex-shrink:0;margin-left:2px">' +
        '<button data-testid="mcp-settings-button">M</button></div></span>' +
        '<textarea style="min-width:0;flex:1"></textarea></form>')
      for (const width of [375, 800, 1440, 375]) {
        await page.setViewport({ width, height: 600 })
        expect(await page.evaluate(SA_COMPOSER_READINESS_SCRIPT)).toMatchObject({
          buttonPresent: true, compact: true, inViewport: true, insideComposer: true, visible: true,
        })
      }
    } finally {
      await page.setViewport({ width: 800, height: 600 })
    }
  })

  test('rejects an offscreen button even when it has dimensions and belongs to a form', async () => {
    expect(await inspect(composer('data-testid="mcp-settings-button"', 'position:fixed;left:2000px;top:20px')))
      .toMatchObject({ buttonPresent: true, compact: true, inViewport: false, insideComposer: false, visible: false })
  })

  test('rejects a button displaced outside its composer while still on screen', async () => {
    expect(await inspect('<form style="position:relative;width:200px;height:50px">' +
      '<div id="mcp-popover-container"><button data-testid="mcp-settings-button" ' +
      'style="position:absolute;left:300px;top:0">M</button></div></form>'))
      .toMatchObject({ buttonPresent: true, inViewport: true, visible: true, insideComposer: false })
  })

  test('keeps an expanded control distinct from a compact one', async () => {
    expect(await inspect(composer('data-testid="mcp-settings-button"', 'width:140px;height:60px')))
      .toMatchObject({ buttonPresent: true, visible: true, insideComposer: true, compact: false })
  })
})
