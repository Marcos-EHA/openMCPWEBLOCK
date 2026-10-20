import puppeteer from 'puppeteer-core';

const extensionId = 'aklgcdphknfhpmhdplmkgmjemojchcea';
const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9405' });
try {
  const targets = browser.targets().filter(target => target.type() === 'page' && target.url().startsWith('https://chatgpt.com/'));
  if (targets.length !== 1) throw new Error(`Expected one ChatGPT tab; found ${targets.length}. No page modified.`);
  const target = targets[0];
  const page = await target.page();
  const pageState = await page.evaluate(() => {
    const visible = node => node.getClientRects().length > 0;
    const editors = [...document.querySelectorAll('#prompt-textarea, #mobile-composer-prompt, .ProseMirror[contenteditable="true"], textarea')].filter(visible);
    const draftPresent = editors.some(node => String('value' in node ? node.value : node.textContent || '').trim().length > 0);
    const stopControlPresent = [...document.querySelectorAll('button')].some(button => visible(button) && (/stop.*(generat|stream)|detener.*(gener|respuesta)/i.test(button.getAttribute('aria-label') || '') || button.getAttribute('data-testid') === 'stop-button'));
    const icon = document.querySelector('.mcp-hold-control');
    return { editorCount: editors.length, draftPresent, stopControlPresent, newIconLoaded: Boolean(icon), executionState: icon?.getAttribute('data-execution-state') ?? null, paused: icon?.getAttribute('data-auto-paused') ?? null };
  });
  console.log(JSON.stringify({ pageState }, null, 2));
  const client = await target.createCDPSession();
  try {
    const contexts = new Map();
    client.on('Runtime.executionContextCreated', ({ context }) => contexts.set(context.id, context));
    await client.send('Runtime.enable');
    const context = [...contexts.values()].find(item => item.origin === `chrome-extension://${extensionId}`);
    if (!context) throw new Error('Expected extension context not found. No page modified.');
    const result = await client.send('Runtime.evaluate', {
      contextId: context.id,
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const manifest = chrome.runtime.getManifest();
        const response = await fetch(chrome.runtime.getURL('content/index.iife.js'));
        if (!response.ok) throw new Error('Cannot read extension content bundle: ' + response.status);
        const bundle = await response.text();
        return { extensionId: chrome.runtime.id, name: manifest.name, version: manifest.version,
          servedBundleHasHoldControl: bundle.includes('mcp-hold-control'),
          servedBundleHasActivityIndicator: bundle.includes('data-execution-state'),
          automation: window.__mcpAutomationState ? { autoExecute: window.__mcpAutomationState.autoExecute, autoInsert: window.__mcpAutomationState.autoInsert, autoSubmit: window.__mcpAutomationState.autoSubmit } : null };
      })()`,
    });
    console.log(JSON.stringify({ extension: result.result.value ?? null, error: result.exceptionDetails?.text ?? null }, null, 2));
  } finally { await client.detach(); }
} finally { await browser.disconnect(); }
