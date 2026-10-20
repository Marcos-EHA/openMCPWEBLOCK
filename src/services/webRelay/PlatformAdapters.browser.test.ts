import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'

let browser: Browser | undefined
let page: Page
let temporary: string | undefined

beforeAll(async () => {
  const chrome = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].find(candidate => candidate && existsSync(candidate))
  if (!chrome) throw new Error('Chrome executable unavailable for adapter DOM tests')
  temporary = mkdtempSync(join(tmpdir(), 'openmcp-adapter-dom-'))
  const entry = join(temporary, 'entry.ts')
  const source = fileURLToPath(new URL('./PlatformAdapters.ts', import.meta.url))
  const chatxSelectors = fileURLToPath(new URL('../../../chrome-extension/source/pages/content/src/plugins/adapters/chatx.adapter.selectors.ts', import.meta.url))
  writeFileSync(entry, `import { getAdapter } from ${JSON.stringify(source)};
import { findChatXInsertionPoint } from ${JSON.stringify(chatxSelectors)};
window.__adapters = { chatgpt: getAdapter('chatgpt'), chatx: getAdapter('chatx') };
window.__findChatXInsertionPoint = findChatXInsertionPoint;`)
  const built = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'iife' })
  if (!built.success) throw new Error(built.logs.map(log => log.message).join('\n'))
  browser = await puppeteer.launch({
    executablePath: chrome, headless: true,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--no-default-browser-check'],
  })
  page = await browser.newPage()
  await page.addScriptTag({ content: await built.outputs[0]!.text() })
}, 30000)

afterAll(async () => {
  await browser?.close()
  if (temporary) rmSync(temporary, { recursive: true, force: true })
})

async function inspect(html: string, platform = 'chatgpt') {
  return page.evaluate(({ markup, platformId }) => {
    document.body.innerHTML = markup
    const adapter = (window as any).__adapters[platformId]
    return {
      count: document.querySelectorAll(adapter.assistantMessageSelector).length,
      text: Function(`return (${adapter.extractResponse})`)(),
    }
  }, { markup: html, platformId: platform })
}

describe('ChatGPT response DOM compatibility', () => {
  test('reads legacy assistant messages and excludes user messages', async () => {
    expect(await inspect('<div data-message-author-role="user">User request</div><div data-message-author-role="assistant"><div class="markdown">Legacy answer</div></div>'))
      .toEqual({ count: 1, text: 'Legacy answer' })
  })

  test('reads current final-assistant containers without legacy author attributes', async () => {
    expect(await inspect('<div data-talvt-turn-state><h4>You said:</h4><div>User request</div></div><div data-local-conversation-final-assistant><div class="MarkdownRoot-example">Current answer</div></div>'))
      .toEqual({ count: 1, text: 'Current answer' })
  })

  test('counts a nested legacy message only once inside a current container', async () => {
    expect(await inspect('<div data-local-conversation-final-assistant><div data-message-author-role="assistant"><div class="markdown">Nested answer</div></div></div>'))
      .toEqual({ count: 1, text: 'Nested answer' })
  })

  test('recognizes assistant turns identified by data-turn', async () => {
    expect(await inspect(
      '<div data-turn="user">User request</div><div data-turn="assistant"><div class="markdown">Assistant answer</div></div>',
    )).toEqual({ count: 1, text: 'Assistant answer' })
  })

  test('reads ChatGPT assistant containers used by the workspace conversation capture', async () => {
    expect(await inspect(
      '<main><div data-testid="user-message">User request</div>' +
      '<div data-testid="assistant-message"><div class="markdown">Assistant answer</div></div></main>',
    )).toEqual({ count: 1, text: 'Assistant answer' })
    expect(await inspect(
      '<main><div data-testid="user-message">User request</div>' +
      '<div data-test-id="model-response"><div>Model response</div></div></main>',
    )).toEqual({ count: 1, text: 'Model response' })
  })

  test('extracts only the assistant markdown from the current completed turn structure', async () => {
    expect(await inspect(
      '<main><div data-talvt-turn-state="complete">' +
      '<div class="group/user-message"><div data-user-message-bubble="true">User prompt that must not be returned</div></div>' +
      '<div data-content-search-unit-key="fallback-turn-0:1:assistant">' +
      '<div data-markdown-text-style="assistant-message"><p>Assistant response only</p></div>' +
      '</div><div class="turn-action-controls"><button aria-label="Regenerar respuesta"></button></div>' +
      '</div></main>',
    )).toEqual({ count: 1, text: 'Assistant response only' })
  })

  test('returns the latest answer across legacy and current structures', async () => {
    expect(await inspect('<div data-message-author-role="assistant">Previous answer</div><div data-message-author-role="user">Next request</div><div data-local-conversation-final-assistant>Latest answer</div>'))
      .toEqual({ count: 2, text: 'Latest answer' })
  })

  test('returns no assistant response when only user content exists', async () => {
    expect(await inspect('<div data-message-author-role="user"><pre>Quoted tool call</pre></div>'))
      .toEqual({ count: 0, text: null })
  })
})

describe('ChatX Web Relay DOM compatibility', () => {
  test('inserts text into ChatX prompt and submits through its send button', async () => {
    const result = await page.evaluate(() => {
      document.body.innerHTML = '<div id="inputfielddiv"><textarea id="prompt"></textarea>' +
        '<div><button id="sendchat_btn">Send</button></div></div>'
      const adapter = (window as any).__adapters.chatx
      const prompt = 'ChatX "relay" prompt'
      const inserted = Function(`return (${adapter.insertText.replace(/__PROMPT__/g, JSON.stringify(prompt))})`)()
      const input = document.querySelector<HTMLTextAreaElement>('#prompt')!
      let submitted = false
      document.querySelector('#sendchat_btn')!.addEventListener('click', () => { submitted = true })
      const sent = Function(`return (${adapter.submitForm})`)()
      return { inserted, value: input.value, sent, submitted }
    })
    expect(result).toEqual({
      inserted: true,
      value: 'ChatX "relay" prompt',
      sent: true,
      submitted: true,
    })
  })

  test('finds the compact-control insertion point next to ChatX send', async () => {
    const result = await page.evaluate(() => {
      document.body.innerHTML = '<div id="inputfielddiv"><textarea id="prompt"></textarea>' +
        '<div class="inputmodel"><button id="sendchat_btn">Send</button></div></div>'
      const point = (window as any).__findChatXInsertionPoint()
      return {
        container: point?.container.className,
        after: (point?.insertAfter as HTMLElement | undefined)?.id,
      }
    })
    expect(result).toEqual({ container: 'inputmodel', after: 'sendchat_btn' })
  })

  test('reads only rendered assistant answer containers and ignores user turns', async () => {
    expect(await inspect(
      '<div id="chat_conversation"><div class="lasthumanchat"><p>User question</p>' +
      '<div id="chat_content"><div class="chatanswer"></div><div id="conversionsdiv">' +
      '<div class="markdown">Assistant answer</div></div></div></div></div>',
      'chatx',
    )).toEqual({ count: 1, text: 'Assistant answer' })
    expect(await inspect(
      '<div id="chat_conversation"><div class="lasthumanchat"><p>User-only content</p></div></div>',
      'chatx',
    )).toEqual({ count: 0, text: null })
  })

  test('detects ChatX generation indicators only while visible', async () => {
    const result = await page.evaluate(() => {
      document.body.innerHTML = '<div id="typing" style="display:none">Thinking</div>'
      const adapter = (window as any).__adapters.chatx
      const hidden = Function(`return (${adapter.isGenerating})`)()
      document.querySelector('#typing')!.setAttribute('style', 'display:block')
      const visible = Function(`return (${adapter.isGenerating})`)()
      return { hidden, visible }
    })
    expect(result).toEqual({ hidden: false, visible: true })
  })
})
