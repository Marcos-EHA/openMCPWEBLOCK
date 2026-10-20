import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;
let temporary: string;
let url: string;

beforeAll(async () => {
  const chrome = [process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].find(candidate => candidate && existsSync(candidate));
  if (!chrome) throw new Error('Chrome executable unavailable.');
  temporary = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.hold-test-'));
  const entry = join(temporary, 'entry.tsx');
  const hook = fileURLToPath(new URL('./useHoldAction.ts', import.meta.url));
  writeFileSync(entry, `import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useHoldAction } from ${JSON.stringify(hook)};
function Fixture() {
  const [enabled, setEnabled] = useState(true);
  const [holds, setHolds] = useState(0);
  const [clicks, setClicks] = useState(0);
  const hold = useHoldAction(enabled, () => setHolds(n => n + 1));
  return <><button id="target" style={{ margin: 40, width: 160, height: 60 }}
    onPointerDown={hold.onPointerDown} onPointerUp={hold.cancel}
    onPointerLeave={hold.cancel} onPointerCancel={hold.cancel} onBlur={hold.cancel}
    onKeyDown={hold.onKeyDown} onKeyUp={hold.onKeyUp}
    onClick={() => { if (!hold.consumeClick()) setClicks(n => n + 1); }}
    data-progress={hold.progress}>MCP</button>
    <button id="disable" onClick={() => setEnabled(false)}>Disable hold</button>
    <output id="state">{JSON.stringify({ holds, clicks })}</output></>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);`);
  const built = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"production"' } });
  if (!built.success) throw new Error(built.logs.map(log => log.message).join('\n'));
  const bundle = await built.outputs[0]!.text();
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request =>
    new URL(request.url).pathname === '/bundle.js'
      ? new Response(bundle, { headers: { 'content-type': 'application/javascript' } })
      : new Response('<!doctype html><div id="root"></div><script src="/bundle.js"></script>', { headers: { 'content-type': 'text/html' } }),
  });
  url = `http://127.0.0.1:${server.port}`;
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] });
  page = await browser.newPage();
}, 30000);

beforeEach(async () => { await page.goto(url); await page.waitForSelector('#target'); });
afterAll(async () => {
  await browser?.close();
  await server?.stop(true);
  if (temporary) rmSync(temporary, { recursive: true, force: true });
});
const state = () => page.$eval('#state', node => JSON.parse(node.textContent!));
const heldOnce = () => page.waitForFunction(() => JSON.parse(document.getElementById('state')!.textContent!).holds === 1);

 describe('compact icon hold interaction', () => {
  it('preserves short clicks and consumes the click following a completed hold', async () => {
    await page.click('#target');
    expect(await state()).toEqual({ holds: 0, clicks: 1 });
    await page.hover('#target');
    await page.mouse.down();
    await heldOnce();
    await page.mouse.up();
    expect(await state()).toEqual({ holds: 1, clicks: 1 });
    await page.click('#target');
    expect(await state()).toEqual({ holds: 1, clicks: 2 });
  });

  it('cancels a pending hold when the pointer leaves', async () => {
    await page.hover('#target');
    await page.mouse.down();
    await page.waitForFunction(() => Number(document.getElementById('target')!.getAttribute('data-progress')) > 0);
    await page.mouse.move(5, 5);
    await page.mouse.up();
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1100)));
    expect(await state()).toEqual({ holds: 0, clicks: 0 });
    expect(await page.$eval('#target', node => Number(node.getAttribute('data-progress')))).toBe(0);
  });

  it('supports short and held Space presses and normal keyboard access when disabled', async () => {
    await page.focus('#target');
    await page.keyboard.press('Space');
    expect(await state()).toEqual({ holds: 0, clicks: 1 });
    await page.keyboard.down('Space');
    await heldOnce();
    await page.keyboard.up('Space');
    expect(await state()).toEqual({ holds: 1, clicks: 1 });
    await page.click('#disable');
    await page.focus('#target');
    await page.keyboard.press('Space');
    await page.keyboard.press('Enter');
    expect(await state()).toEqual({ holds: 1, clicks: 3 });
  });
});
