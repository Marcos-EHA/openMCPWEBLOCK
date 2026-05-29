/**
 * Test Extensions.loadUnpacked via --remote-debugging-pipe
 * 
 * Pipe uses stdin/stdout file descriptors 3 and 4.
 * We spawn Chrome with pipe mode and communicate directly.
 */
import { spawn } from 'child_process'
import * as net from 'net'
import * as fs from 'fs'

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

const SA_DIR = `${process.env.LOCALAPPDATA}\\openMCPWEBLOCK\\sa-extension`
const UD = `${process.env.LOCALAPPDATA}\\openMCPWEBLOCK\\chrome-debug`

console.log('=== Extensions.loadUnpacked via Pipe ===\n')

// Kill existing Chrome
try { require('child_process').execSync('taskkill /IM chrome.exe /F', { stdio: 'ignore' }) } catch {}
await sleep(2000)

// Launch Chrome with --remote-debugging-pipe
// Pipe transport uses stdio fd 3 (read) and fd 4 (write)
const chrome = spawn(
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  [
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    `--user-data-dir=${UD}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  {
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
  }
)

console.log('Chrome launched with pipe (PID:', chrome.pid, ')')

// fd 3 = read from Chrome, fd 4 = write to Chrome
const pipeRead = chrome.stdio[3] as NodeJS.ReadableStream
const pipeWrite = chrome.stdio[4] as NodeJS.WritableStream

if (!pipeRead || !pipeWrite) {
  console.log('ERROR: Could not get pipe streams')
  console.log('stdio:', chrome.stdio?.map((s, i) => `${i}: ${s ? 'exists' : 'null'}`))
  chrome.kill()
  process.exit(1)
}

await sleep(3000)

let msgId = 1
let buffer = ''

// CDP over pipe uses \0 as message separator
function sendCDPPipe(method: string, params?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = msgId++
    const msg = JSON.stringify({ id, method, params }) + '\0'
    
    const handler = (chunk: Buffer) => {
      buffer += chunk.toString()
      const messages = buffer.split('\0')
      buffer = messages.pop() || ''
      
      for (const m of messages) {
        if (!m.trim()) continue
        try {
          const data = JSON.parse(m)
          if (data.id === id) {
            pipeRead.removeListener('data', handler)
            resolve(data)
          }
        } catch {}
      }
    }
    
    pipeRead.on('data', handler)
    pipeWrite.write(msg)
    
    // Timeout
    setTimeout(() => {
      pipeRead.removeListener('data', handler)
      reject(new Error('Timeout'))
    }, 10000)
  })
}

try {
  // 1. Test basic connectivity
  console.log('\n1. Testing pipe connection...')
  const ver = await sendCDPPipe('Browser.getVersion')
  console.log('   Browser:', ver.result?.product)
  
  // 2. Try Extensions.loadUnpacked
  console.log('\n2. Extensions.loadUnpacked...')
  const loadResult = await sendCDPPipe('Extensions.loadUnpacked', {
    path: SA_DIR,
  })
  console.log('   Result:', JSON.stringify(loadResult, null, 2))

  if (loadResult.result) {
    console.log('\n   🎉 SUCCESS! Extension loaded!')
    console.log('   Extension ID:', loadResult.result.id)
  }
  
  // 3. Check extensions
  console.log('\n3. Extensions.getExtensions...')
  const exts = await sendCDPPipe('Extensions.getExtensions')
  console.log('   Result:', JSON.stringify(exts, null, 2))

} catch (e: any) {
  console.log('Error:', e.message)
}

// Cleanup
chrome.kill()
process.exit(0)
