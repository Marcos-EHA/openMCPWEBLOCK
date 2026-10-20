const wsUrl = process.argv[2];
const ws = new WebSocket(wsUrl);
ws.onopen = async () => {
  ws.send(JSON.stringify({ id: 1, method: 'Page.enable' }));
  await new Promise(r => setTimeout(r, 300));
  ws.send(JSON.stringify({ id: 2, method: 'Page.reload' }));
  await new Promise(r => setTimeout(r, 1500));
  ws.close();
  process.exit(0);
};
