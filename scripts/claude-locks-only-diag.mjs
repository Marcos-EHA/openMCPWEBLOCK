const [wsA, wsB] = [process.argv[2], process.argv[3]];
function connect(url) { return new Promise((resolve, reject) => { const ws = new WebSocket(url); ws.onopen = () => resolve(ws); ws.onerror = reject; }); }
function cdp(ws, method, params = {}) {
  return new Promise(resolve => {
    const id = Math.floor(Math.random() * 1e9);
    const handler = e => { const d = JSON.parse(e.data); if (d.id === id) { ws.removeEventListener('message', handler); resolve(d); } };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { ws.removeEventListener('message', handler); resolve({ timeout: true }); }, 6000);
  });
}
function ev(ws, expr) { return cdp(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); }

const a = await connect(wsA);
const b = await connect(wsB);
await new Promise(r => setTimeout(r, 300));

console.log('does navigator.locks exist?', (await ev(a, `typeof navigator.locks`)).result?.result?.value);

console.log('\n=== plain lock acquire/release test, no storage involved ===');
const exprA = `navigator.locks.request('diag-lock', {mode:'exclusive'}, async () => { await new Promise(r=>setTimeout(r,50)); return 'A-done'; })`;
const exprB = `navigator.locks.request('diag-lock', {mode:'exclusive'}, async () => { await new Promise(r=>setTimeout(r,50)); return 'B-done'; })`;
const [ra, rb] = await Promise.all([ev(a, exprA), ev(b, exprB)]);
console.log('A result:', JSON.stringify(ra.result), ra.timeout ? '(TIMED OUT)' : '');
console.log('B result:', JSON.stringify(rb.result), rb.timeout ? '(TIMED OUT)' : '');

a.close(); b.close();
process.exit(0);
