const [wsA, wsB] = [process.argv[2], process.argv[3]];
function connect(url) { return new Promise((resolve, reject) => { const ws = new WebSocket(url); ws.onopen = () => resolve(ws); ws.onerror = reject; }); }
function cdp(ws, method, params = {}) {
  return new Promise(resolve => {
    const id = Math.floor(Math.random() * 1e9);
    const handler = e => { const d = JSON.parse(e.data); if (d.id === id) { ws.removeEventListener('message', handler); resolve(d); } };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { ws.removeEventListener('message', handler); resolve({ timeout: true }); }, 8000);
  });
}
function ev(ws, expr) { return cdp(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); }

const a = await connect(wsA);
const b = await connect(wsB);
await new Promise(r => setTimeout(r, 500));

console.log('=== chrome.storage.local: immediate cross-tab read after write, NO lock, 30 rounds ===');
let staleReads = 0;
const N = 30;
for (let i = 0; i < N; i++) {
  const key = 'propagation-test-' + i;
  const value = 'value-' + i + '-' + Math.random();
  await ev(a, `window.csSet(${JSON.stringify(key)}, ${JSON.stringify(value)})`);
  const rb = await ev(b, `window.csGet(${JSON.stringify(key)})`);
  const seen = rb.result?.result?.value;
  const stale = seen !== value;
  if (stale) staleReads++;
  console.log(`${i}: wrote "${value.slice(0,24)}" from A, B immediately read "${String(seen).slice(0,24)}"  ${stale ? '<<< STALE' : 'ok'}`);
}
console.log(`\n${staleReads}/${N} immediate cross-tab reads were stale (chrome.storage.local, no lock).`);

a.close(); b.close();
process.exit(0);
