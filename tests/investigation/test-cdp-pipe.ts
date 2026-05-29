/**
 * Extensions.loadUnpacked via pipe transport
 * Chrome pipe uses stdio fd 3 (read from Chrome) and fd 4 (write to Chrome)
 * Messages are separated by \0
 */
import { spawn, execSync } from 'child_process'

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

const SA_DIR = `${process.env.LOCALAPPDATA}\\openMCPWEBLOCK\\sa-extension`
const UD = `${process.env.LOCALAPPDATA}\\openMCPWEBLOCK\\chrome-debug`

console.log('=== Pipe CDP Test ===\n')

// Kill Chrome
try { execSync('taskkill /IM chrome.exe /F', { stdio: 'ignore' }) } catch {}
await sleep(2000)

// Launch Chrome with pipe
const chrome = spawn(
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  [
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    `--user-data-dir=${UD}`,
    '--no-first-run',
    '--disable-gpu',
    'about:blank',
  ],
  {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
  }
)

console.log('Chrome PID:', chrome.pid)

chrome.on('error', (e) => console.log('Chrome error:', e.message))
chrome.stderr?.on('data', (d: Buffer) => {
  const line = d.toString().trim()
  if (line.includes('Extension') || line.includes('extension') || line.includes('pipe')) {
    console.log('[stderr]', line.substring(0, 200))
  }
})

await sleep(4000)

// The pipe streams
const pipeIn = chrome.stdio[3] // Read FROM Chrome
const pipeOut = chrome.stdio[4] // Write TO Chrome

if (!pipeIn || !pipeOut) {
  console.log('ERROR: Pipe streams not available')
  console.log('stdio available:', chrome.stdio?.map((s, i) => `[${i}]: ${s ? typeof s : 'null'}`).join(', '))
  chrome.kill()
  process.exit(1)
}

let msgId = 0
let buffer = ''

function sendPipe(method: string, params?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    const msg = JSON.stringify({ id, method, params })
    
    const timeout = setTimeout(() => {
      (pipeIn as any).removeListener('data', onData)
      reject(new Error(`Timeout waiting for response to ${method}`))
    }, 15000)
    
    function onData(chunk: Buffer) {
      buffer += chunk.toString()
      // Messages are \0-separated
      while (buffer.includes('\0')) {
        const idx = buffer.indexOf('\0')
        const message = buffer.substring(0, idx)
        buffer = buffer.substring(idx + 1)
        
        if (!message.trim()) continue
        try {
          const data = JSON.parse(message)
          if (data.id === id) {
            clearTimeout(timeout);
            (pipeIn as any).removeListener('data', onData)
            resolve(data)
            return
          }
        } catch (e) {
          // Not JSON, skip
        }
      }
    }
    
    (pipeIn as any).on('data', onData)
    ;(pipeOut as any).write(msg + '\0')
  })
}

try {
  // 1. Browser version
  console.log('\n1. Browser.getVersion...')
  const ver = await sendPipe('Browser.getVersion')
  console.log('   Product:', ver.result?.product)
  console.log('   Protocol:', ver.result?.protocolVersion)
  
  // 2. Load SA extension
  console.log(`\n2. Extensions.loadUnpacked("${SA_DIR}")...`)
  const load = await sendPipe('Extensions.loadUnpacked', { path: SA_DIR })
  console.log('   Result:', JSON.stringify(load, null, 2))
  
  if (load.result?.id) {
    console.log(`\n   🎉 SA LOADED! Extension ID: ${load.result.id}`)
    
    // 3. Verify
    console.log('\n3. Extensions.getExtensions...')
    const exts = await sendPipe('Extensions.getExtensions')
    console.log('   Extensions:', JSON.stringify(exts.result, null, 2))
  }
} catch (e: any) {
  console.log('Error:', e.message)
} finally {
  chrome.kill()
  await sleep(1000)
}

process.exit(0)
