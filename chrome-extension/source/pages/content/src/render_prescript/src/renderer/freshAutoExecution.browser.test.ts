import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;
let temporary: string;
let bundle: string;
let url: string;
const fixture = '<main id="chat"><div data-message-author-role="user" data-message-id="old-user">old request</div><div data-message-author-role="assistant"><pre><code id="old-call">historical call</code></pre></div></main><form onsubmit="return false"><textarea id="prompt-textarea"></textarea><button type="button" data-testid="send-button" id="send">Send</button></form>';

beforeAll(async () => {
  const chrome = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].find(candidate => candidate && existsSync(candidate));
  if (!chrome) throw new Error('Chrome executable unavailable for the isolated DOM regression test.');
  temporary = mkdtempSync(join(tmpdir(), 'openmcp-fresh-turn-'));
  const entry = join(temporary, 'entry.ts');
  const source = fileURLToPath(new URL('./freshAutoExecution.ts', import.meta.url));
  writeFileSync(entry, `import * as gate from ${JSON.stringify(source)}; window.__freshGate = gate;`);
  const built = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'iife' });
  if (!built.success) throw new Error(built.logs.map(log => log.message).join('\n'));
  bundle = await built.outputs[0]!.text();
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(fixture, { headers: { 'content-type': 'text/html' } }) });
  url = `http://127.0.0.1:${server.port}/c/test`;
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--no-default-browser-check'] });
  page = await browser.newPage();
}, 30000);

beforeEach(async () => {
  await page.goto(url);
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => (window as any).__freshGate.startFreshCallTracking());
});

afterAll(async () => {
  await browser?.close();
  await server?.stop(true);
  if (temporary) rmSync(temporary, { recursive: true, force: true });
});

describe('fresh auto-execution DOM regression', () => {
  it('recognizes ChatGPT accessible user headings without author attributes', async () => {
    const isolated = await browser.newPage();
    await isolated.setRequestInterception(true);
    isolated.on('request', request => {
      if (request.isNavigationRequest() && request.frame() === isolated.mainFrame()) {
        void request.respond({ status: 200, contentType: 'text/html', body: '<main id="chat"></main><form onsubmit="return false"><div class="ProseMirror" contenteditable="true" role="textbox"></div><button id="send" type="submit" aria-label="Enviar">Enviar</button></form>' });
      } else {
        void request.abort();
      }
    });
    try {
      for (const label of ['Tú dijiste:', 'You said:']) {
        await isolated.goto('https://chatgpt.com/c/local-fixture');
        await isolated.addScriptTag({ content: bundle });
        const result = await isolated.evaluate((roleLabel) => {
          const gate = (window as any).__freshGate;
          const chat = document.getElementById('chat')!;
          const user = (body: string) => '<section data-talvt-turn-state="complete"><div><h4 class="sr-only">' + roleLabel + '</h4><div>' + body + '</div></div></section>';
          chat.innerHTML = user('old request') + '<pre><code id="old-call">old call</code></pre>';
          gate.startFreshCallTracking();
          const initialBlocked = gate.freshAutoExecutionToken(document.getElementById('old-call'), 'old') === null;
          document.querySelector('.ProseMirror')!.textContent = 'fresh request';
          document.getElementById('send')!.click();
          chat.insertAdjacentHTML('beforeend', '<pre><code id="late-call">late history</code></pre>' + user('fresh request<pre><code id="quoted-call">quoted call</code></pre>') + '<div><h4 class="sr-only">ChatGPT dijo:</h4><div><pre><code id="fresh-call">fresh call</code></pre></div></div>');
          const token = gate.freshAutoExecutionToken(document.getElementById('fresh-call'), 'fresh');
          const freshAllowed = gate.isFreshAutoExecutionAllowed(token);
          const oldBlocked = gate.freshAutoExecutionToken(document.getElementById('old-call'), 'old') === null;
          const lateBlocked = gate.freshAutoExecutionToken(document.getElementById('late-call'), 'late') === null;
          const quotedBlocked = gate.freshAutoExecutionToken(document.getElementById('quoted-call'), 'quoted') === null;
          gate.stopFreshCallTracking();
          gate.startFreshCallTracking();
          return { initialBlocked, freshAllowed, oldBlocked, lateBlocked, quotedBlocked, restartBlocked: !gate.isFreshAutoExecutionAllowed(token) };
        }, label);
        expect(result).toEqual({ initialBlocked: true, freshAllowed: true, oldBlocked: true, lateBlocked: true, quotedBlocked: true, restartBlocked: true });
      }
    } finally {
      await isolated.close();
    }
  });
  it('blocks initial and asynchronously loaded history without a submission', async () => {
    const result = await page.evaluate(() => {
      const gate = (window as any).__freshGate;
      const initial = gate.freshAutoExecutionToken(document.getElementById('old-call'), 'old');
      document.getElementById('chat')!.insertAdjacentHTML('beforeend', '<pre><code id="late">late history</code></pre>');
      const late = gate.freshAutoExecutionToken(document.getElementById('late'), 'late');
      return { initial: initial === null, late: late === null };
    });
    expect(result).toEqual({ initial: true, late: true });
  });

  it('allows a new automated submission response while excluding old and quoted calls', async () => {
    const result = await page.evaluate(() => {
      const gate = (window as any).__freshGate;
      (document.getElementById('prompt-textarea') as HTMLTextAreaElement).value = 'fresh request';
      document.getElementById('send')!.setAttribute('data-testid', 'fruitjuice-send-button');
      document.getElementById('send')!.click();
      document.getElementById('chat')!.insertAdjacentHTML('beforeend', '<pre><code id="old-late">old hydrated call</code></pre><div data-message-author-role="user" data-message-id="new-user">fresh request<pre><code id="quoted">quoted call</code></pre></div><div data-message-author-role="assistant"><pre><code id="new-call">new call</code></pre></div>');
      const fresh = gate.freshAutoExecutionToken(document.getElementById('new-call'), 'fresh');
      return {
        fresh: gate.isFreshAutoExecutionAllowed(fresh),
        old: gate.freshAutoExecutionToken(document.getElementById('old-call'), 'old') === null,
        late: gate.freshAutoExecutionToken(document.getElementById('old-late'), 'late') === null,
        quoted: gate.freshAutoExecutionToken(document.getElementById('quoted'), 'quoted') === null,
      };
    });
    expect(result).toEqual({ fresh: true, old: true, late: true, quoted: true });
  });

  it('allows the first fresh turn when a new chat receives its conversation URL', async () => {
    const result = await page.evaluate(() => {
      const gate = (window as any).__freshGate;
      document.getElementById('chat')!.innerHTML = '';
      history.replaceState({}, '', '/');
      (document.getElementById('prompt-textarea') as HTMLTextAreaElement).value = 'first request';
      document.getElementById('send')!.click();
      history.replaceState({}, '', '/c/new-conversation');
      document.getElementById('chat')!.insertAdjacentHTML('beforeend', '<div data-message-author-role="user" data-message-id="first-user">first request</div><pre><code id="first-call">new call</code></pre>');
      const token = gate.freshAutoExecutionToken(document.getElementById('first-call'), 'first');
      return gate.isFreshAutoExecutionAllowed(token);
    });
    expect(result).toBe(true);
  });

  it('cancels a delayed call after conversation navigation, including return to the old conversation', async () => {
    const result = await page.evaluate(() => {
      const gate = (window as any).__freshGate;
      const composer = document.getElementById('prompt-textarea') as HTMLTextAreaElement;
      composer.value = 'fresh request';
      composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      document.getElementById('chat')!.insertAdjacentHTML('beforeend', '<div data-message-author-role="user" data-message-id="new-user">fresh request</div><pre><code id="new-call">new call</code></pre>');
      const token = gate.freshAutoExecutionToken(document.getElementById('new-call'), 'fresh');
      const before = gate.isFreshAutoExecutionAllowed(token);
      history.pushState({}, '', '/c/other');
      const elsewhere = gate.isFreshAutoExecutionAllowed(token);
      history.pushState({}, '', '/c/test');
      return { before, elsewhere, returned: gate.isFreshAutoExecutionAllowed(token) };
    });
    expect(result).toEqual({ before: true, elsewhere: false, returned: false });
  });

  it('invalidates pending calls on pause and permits a subsequent fresh submission', async () => {
    const result = await page.evaluate(() => {
      const gate = (window as any).__freshGate;
      const composer = document.getElementById('prompt-textarea') as HTMLTextAreaElement;
      const chat = document.getElementById('chat')!;
      composer.value = 'first fresh request';
      document.getElementById('send')!.click();
      chat.insertAdjacentHTML('beforeend', '<div data-message-author-role="user" data-message-id="pause-user">first fresh request</div><pre><code id="pending-call">pending call</code></pre>');
      const pending = document.getElementById('pending-call')!;
      const token = gate.freshAutoExecutionToken(pending, 'pending');
      const before = gate.isFreshAutoExecutionAllowed(token);
      document.dispatchEvent(new Event('mcp:auto-execution-paused'));
      const paused = gate.isFreshAutoExecutionAllowed(token);
      const rearmed = gate.freshAutoExecutionToken(pending, 'pending') !== null;
      composer.value = 'second fresh request';
      document.getElementById('send')!.click();
      chat.insertAdjacentHTML('beforeend', '<div data-message-author-role="user" data-message-id="resume-user">second fresh request</div><pre><code id="next-call">next call</code></pre>');
      const next = gate.freshAutoExecutionToken(document.getElementById('next-call'), 'next');
      return { before, paused, rearmed, nextAllowed: gate.isFreshAutoExecutionAllowed(next), oldAllowed: gate.isFreshAutoExecutionAllowed(token) };
    });
    expect(result).toEqual({ before: true, paused: false, rearmed: false, nextAllowed: true, oldAllowed: false });
  });

  it('does not resume a pending call after observer restart', async () => {
    const result = await page.evaluate(() => {
      const gate = (window as any).__freshGate;
      (document.getElementById('prompt-textarea') as HTMLTextAreaElement).value = 'fresh request';
      document.getElementById('send')!.click();
      document.getElementById('chat')!.insertAdjacentHTML('beforeend', '<div data-message-author-role="user" data-message-id="new-user">fresh request</div><pre><code id="new-call">new call</code></pre>');
      const token = gate.freshAutoExecutionToken(document.getElementById('new-call'), 'fresh');
      const before = gate.isFreshAutoExecutionAllowed(token);
      gate.stopFreshCallTracking();
      gate.startFreshCallTracking();
      return { before, after: gate.isFreshAutoExecutionAllowed(token), resumed: gate.freshAutoExecutionToken(document.getElementById('new-call'), 'fresh') !== null };
    });
    expect(result).toEqual({ before: true, after: false, resumed: false });
  });
});
