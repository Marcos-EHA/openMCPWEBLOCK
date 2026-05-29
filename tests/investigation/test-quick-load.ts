// Test Extensions.loadUnpacked via port with --enable-unsafe-extension-debugging
const version = await fetch('http://127.0.0.1:9222/json/version').then(r => r.json())
console.log('Browser:', version.Browser)

const ws = new WebSocket(version.webSocketDebuggerUrl)
let id = 0

function cdp(m: string, p?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const myId = ++id
    const timeout = setTimeout(() => reject(new Error('timeout')), 10000)
    const h = (e: MessageEvent) => {
      const d = JSON.parse(e.data)
      if (d.id === myId) {
        clearTimeout(timeout)
        ws.removeEventListener('message', h)
        resolve(d)
      }
    }
    ws.addEventListener('message', h)
    ws.send(JSON.stringify({ id: myId, method: m, params: p }))
  })
}

await new Promise<void>(r => { ws.onopen = () => r() })

const saDir = `${process.env.LOCALAPPDATA}\\openMCPWEBLOCK\\sa-extension`

// 1. Try Extensions.loadUnpacked
console.log('\n1. Extensions.loadUnpacked...')
const r1 = await cdp('Extensions.loadUnpacked', { path: saDir })
console.log('   Result:', JSON.stringify(r1))

// 2. Try Extensions.getExtensions
console.log('\n2. Extensions.getExtensions...')
const r2 = await cdp('Extensions.getExtensions')
console.log('   Result:', JSON.stringify(r2))

// 3. List all available CDP domains and their commands
console.log('\n3. Checking Extensions domain in protocol...')
const protocol = await fetch('http://127.0.0.1:9222/json/protocol').then(r => r.json())
const extDomain = protocol.domains.find((d: any) => d.domain === 'Extensions')
if (extDomain) {
  console.log('   Commands:')
  for (const cmd of extDomain.commands || []) {
    const params = (cmd.parameters || []).map((p: any) => `${p.name}:${p.type || p.$ref}`).join(', ')
    console.log(`     ${cmd.name}(${params})`)
  }
  // Check if there are any experimental flags
  console.log('   experimental:', extDomain.experimental)
  console.log('   deprecated:', extDomain.deprecated)
}

ws.close()
process.exit(0)
