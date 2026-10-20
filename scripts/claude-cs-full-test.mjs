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

console.log('seeding 300 bulk claims into chrome.storage.local...');
await ev(a, `
  (async () => {
    const bulk = {};
    for (let i = 0; i < 300; i++) {
      bulk['bulk-' + i] = { logicalCallKey: 'bulk-' + i, scopeKey: 't', functionName: 'f', callId: 'b'+i, contentSignature: 's', status: 'running', timestamp: Date.now(), params: { padding: 'x'.repeat(200) } };
    }
    await window.csSet('openmcp_execution_claims_v2_cstest', JSON.stringify(bulk));
    return 'seeded';
  })()
`);

let losses = 0;
const N = 15;
for (let i = 0; i < N; i++) {
  const freshKey = `diag${i}-fresh`;
  const oldKey = `diag${i}-old`;
  const realNow = Date.now();

  await ev(a, `
    (async () => {
      const raw = await window.csGet('openmcp_execution_claims_v2_cstest');
      const claims = raw ? JSON.parse(raw) : {};
      claims[${JSON.stringify(oldKey)}] = {logicalCallKey:${JSON.stringify(oldKey)},scopeKey:'t',functionName:'f',callId:'o',contentSignature:'s',status:'success',timestamp: ${realNow - 10 * 24 * 60 * 60 * 1000}};
      claims[${JSON.stringify(freshKey)}] = {logicalCallKey:${JSON.stringify(freshKey)},scopeKey:'t',functionName:'f',callId:'k',contentSignature:'s',status:'running',timestamp: Date.now()};
      await window.csSet('openmcp_execution_claims_v2_cstest', JSON.stringify(claims));
    })()
  `);

  const exprA = `Promise.resolve(window.updateClaimCS(${JSON.stringify(freshKey)}, {status:'success', result:'IMPORTANT-RESULT'})).then(r=>JSON.stringify(r)).catch(e=>'ERROR:'+e.message)`;
  const exprB = `Promise.resolve(window.pruneCS()).then(r=>JSON.stringify(r)).catch(e=>'ERROR:'+e.message)`;
  const [ra, rb] = await Promise.all([ev(a, exprA), ev(b, exprB)]);
  if (i < 3) console.log(`    [debug] updateClaimCS returned: ${ra.result?.result?.value}   pruneCS returned: ${rb.result?.result?.value}`);

  const readBack = await ev(a, `window.csGet('openmcp_execution_claims_v2_cstest')`);
  const claims = JSON.parse(readBack.result?.result?.value || '{}');
  const updateSurvived = claims[freshKey]?.status === 'success' && claims[freshKey]?.result === 'IMPORTANT-RESULT';
  const oldWasPruned = !(oldKey in claims);
  const lost = !updateSurvived;
  if (lost) losses++;
  console.log(`  round ${i}: fresh.status=${claims[freshKey]?.status ?? 'MISSING'} fresh.result=${claims[freshKey]?.result ?? '-'}  old_pruned=${oldWasPruned}  ${lost ? '<<< UPDATE LOST' : 'ok'}`);
}
console.log(`\n${losses}/${N} rounds lost the concurrent update (chrome.storage.local + navigator.locks).`);

a.close(); b.close();
process.exit(0);
