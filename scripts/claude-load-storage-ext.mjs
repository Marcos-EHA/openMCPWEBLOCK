const debugPort = 9342;
const extDir = 'C:\\Users\\elias\\AppData\\Local\\Temp\\claude-storage-ext';

const ver = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then(r => r.json());
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1000000);
    const handler = e => {
      const msg = JSON.parse(e.data);
      if (msg.id === id) {
        ws.removeEventListener('message', handler);
        if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
try {
  const res = await send('Extensions.loadUnpacked', { path: extDir });
  console.log('LOADED. Extension ID:', res?.id);
} catch (err) {
  console.log('FAILED:', err.message);
}
ws.close();
process.exit(0);
