async function testLoadUnpacked() {
  const EXT_DIR = 'C:\\Users\\elias\\Gits\\openMCPWEBLOCK\\chrome-extension\\source\\dist'
  const targets = await fetch('http://127.0.0.1:9226/json/list').then(r => r.json())
  const extPage = targets.find((t: any) => t.url.includes('chrome://extensions'))
  if (!extPage) {
    console.error('No chrome://extensions page found')
    return
  }

  const ws = new WebSocket(extPage.webSocketDebuggerUrl)
  await new Promise(r => { ws.onopen = () => r(null) })

  // Enable Developer Mode first via updateProfileConfiguration
  const setDevModeExpr = `(async () => {
    return new Promise(resolve => {
      chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, () => {
        chrome.developerPrivate.getProfileConfiguration(cfg => resolve(cfg));
      });
    });
  })()`

  ws.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression: setDevModeExpr, awaitPromise: true, returnByValue: true }
  }))

  const devModeRes = await new Promise(res => {
    ws.onmessage = (e: MessageEvent) => {
      const d = JSON.parse(e.data)
      if (d.id === 1) res(d.result?.result?.value)
    }
  })
  console.log('Developer Mode Status:', JSON.stringify(devModeRes))

  // Now check loadUnpacked or loadDirectory
  // Let's inspect the signature of loadUnpacked or loadDirectory
  const inspectMethodsExpr = `(() => {
    return {
      loadUnpackedLen: chrome.developerPrivate.loadUnpacked.length,
      loadDirectoryLen: chrome.developerPrivate.loadDirectory.length,
    };
  })()`

  ws.send(JSON.stringify({
    id: 2,
    method: 'Runtime.evaluate',
    params: { expression: inspectMethodsExpr, returnByValue: true }
  }))

  const inspectRes = await new Promise(res => {
    const handler = (e: MessageEvent) => {
      const d = JSON.parse(e.data)
      if (d.id === 2) {
        ws.removeEventListener('message', handler)
        res(d.result?.result?.value)
      }
    }
    ws.addEventListener('message', handler)
  })
  console.log('Method lengths:', JSON.stringify(inspectRes))

  ws.close()
}

testLoadUnpacked().catch(console.error)
