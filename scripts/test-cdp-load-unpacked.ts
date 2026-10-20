async function testCdpLoadUnpacked() {
  const EXT_DIR = 'C:\\Users\\elias\\Gits\\openMCPWEBLOCK\\chrome-extension\\source\\dist'
  const ver = await fetch('http://127.0.0.1:9226/json/version').then(r => r.json())
  console.log('Browser WS:', ver.webSocketDebuggerUrl)

  const ws = new WebSocket(ver.webSocketDebuggerUrl)
  await new Promise(r => { ws.onopen = () => r(null) })

  // Send Extensions.loadUnpacked at browser level
  ws.send(JSON.stringify({
    id: 1,
    method: 'Extensions.loadUnpacked',
    params: { path: EXT_DIR }
  }))

  const res = await new Promise(res => {
    ws.onmessage = (e: MessageEvent) => {
      const d = JSON.parse(e.data)
      if (d.id === 1) res(d)
    }
  })
  console.log('Extensions.loadUnpacked result:', JSON.stringify(res))

  ws.close()
}

testCdpLoadUnpacked().catch(console.error)
