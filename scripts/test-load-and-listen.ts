async function main() {
  const ver = await fetch('http://127.0.0.1:9222/json/version').then(r => r.json())
  const bws = new WebSocket(ver.webSocketDebuggerUrl)
  await new Promise(r => bws.onopen = () => r(null))

  bws.onmessage = (ev) => {
    const d = JSON.parse(ev.data)
    if (d.method) {
      console.log(`[EVENT] ${d.method}:`, JSON.stringify(d.params || {}))
    }
  }

  let id = 1
  function send(method: string, params: any = {}): Promise<any> {
    const curId = id++
    return new Promise((resolve, reject) => {
      const h = (ev: MessageEvent) => {
        const d = JSON.parse(ev.data)
        if (d.id === curId) {
          bws.removeEventListener('message', h)
          if (d.error) reject(new Error(JSON.stringify(d.error)))
          else resolve(d.result)
        }
      }
      bws.addEventListener('message', h)
      bws.send(JSON.stringify({ id: curId, method, params }))
    })
  }

  await send('Target.setDiscoverTargets', { discover: true })

  console.log('Sending Extensions.loadUnpacked...')
  try {
    const res = await send('Extensions.loadUnpacked', {
      path: 'C:\\Users\\elias\\Gits\\openMCPWEBLOCK\\chrome-extension\\source\\dist'
    })
    console.log('Extensions.loadUnpacked result:', res)
  } catch (err: any) {
    console.error('Extensions.loadUnpacked error:', err.message)
  }

  await new Promise(r => setTimeout(r, 4000))
  bws.close()
}

main().catch(console.error)
