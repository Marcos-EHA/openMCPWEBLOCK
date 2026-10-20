#!/usr/bin/env bun
/**
 * SA CDP LoadUnpacked — Final validation before fixing ChromeCDP.
 *
 * Tests:
 *   1. Identity validation via chrome.runtime from SW context
 *   2. Persistence after Chrome restart
 *   3. Two startup cycles
 *   4. Guest mode analysis (already answered: no --guest flag)
 *
 * Run: bun run scripts/sa-cdp-validation.ts
 * Port: 9240
 */

import path from 'path'
import fs from 'fs'
import { execSync } from 'child_process'

const LOCALAPPDATA = process.env.LOCALAPPDATA ?? ''
const RELAY_ROOT = path.join(LOCALAPPDATA, 'openMCPWEBLOCK', 'chrome-agents')
const SA_CWS_ID = 'kngiafgkdnlkgmefdafaibkibegkcaef'
const TEST_PORT = 9240
const LOCAL_SA = path.join(process.cwd(), 'chrome-extension', 'source', 'dist')

function log(s: string, ...a: any[]) { console.log(`\n[${s}]`, ...a) }
function ev(l: string, v: any) { console.log(`  ${l}: ${typeof v === 'object' ? JSON.stringify(v, null, 2) : v}`) }
function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }

function clearLocks(dir: string) {
  for (const n of ['SingletonLock', 'SingletonCookie', 'lockfile']) {
    for (const b of [dir, path.join(dir, 'Default')]) {
      try { fs.rmSync(path.join(b, n), { force: true, recursive: true }) } catch {}
    }
  }
}

async function findPidOnPort(port: number): Promise<number | null> {
  try {
    const out = execSync(`netstat -ano | findstr ":${port}" | findstr LISTENING`, { encoding: 'utf8', timeout: 5000 }).trim()
    for (const line of out.split('\n').filter(Boolean)) {
      const parts = line.trim().split(/\s+/)
      if (!parts[1]?.endsWith(`:${port}`)) continue
      const pid = parseInt(parts[parts.length - 1]!, 10)
      if (pid > 0) return pid
    }
    return null
  } catch { return null }
}

async function killTestPort(): Promise<void> {
  const pid = await findPidOnPort(TEST_PORT)
  if (!pid) return
  try {
    const check = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8', timeout: 5000 })
    if (!check.toLowerCase().includes('chrome.exe')) { console.warn(`PID ${pid} is not chrome`); return }
    execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore', timeout: 10000 })
  } catch {}
  for (let i = 0; i < 15; i++) { if (!(await findPidOnPort(TEST_PORT))) return; await sleep(500) }
}

async function isPortActive(port: number): Promise<boolean> {
  try { return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) })).ok }
  catch { return false }
}

async function fetchTargets(port: number): Promise<any[]> {
  try { return await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(3000) })).json() as any[] }
  catch { return [] }
}

function findChrome(): string {
  for (const c of [
    path.join(process.env.PROGRAMFILES ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]) { if (c && fs.existsSync(c)) return c }
  throw new Error('Chrome not found')
}

function freshRelay(name: string): string {
  const dir = path.join(RELAY_ROOT, name)
  try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  fs.mkdirSync(path.join(dir, 'Default'), { recursive: true })
  return dir
}

async function launchChrome(relayDir: string, url = 'about:blank'): Promise<boolean> {
  clearLocks(relayDir)
  const { spawn } = await import('child_process')
  const proc = spawn(findChrome(), [
    `--remote-debugging-port=${TEST_PORT}`, `--user-data-dir=${relayDir}`,
    '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', url,
  ], { detached: true, stdio: 'ignore', shell: false })
  proc.unref()
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) { if (await isPortActive(TEST_PORT)) return true; await sleep(1000) }
  return false
}

// ─── CDP WebSocket helper ────────────────────────────────────────────────────

async function connectCDP(): Promise<{
  send: (method: string, params?: any) => Promise<any>
  close: () => void
}> {
  const { WebSocket } = await import('ws')
  const ver = await fetch(`http://127.0.0.1:${TEST_PORT}/json/version`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()) as any
  if (!ver?.webSocketDebuggerUrl) throw new Error('no webSocketDebuggerUrl')

  const ws = new WebSocket(ver.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve); ws.on('error', reject)
    setTimeout(() => reject(new Error('WS timeout')), 10000)
  })

  let msgId = 1
  const send = (method: string, params: any = {}): Promise<any> => {
    return new Promise((resolve, reject) => {
      const id = msgId++
      const timeout = setTimeout(() => reject(new Error(`${method} timeout (15s)`)), 15000)
      const handler = (data: any) => {
        try {
          const msg = JSON.parse(data.toString())
          if (msg.id === id) {
            ws.off('message', handler); clearTimeout(timeout)
            if (msg.error) reject(new Error(`${msg.error.message} (code ${msg.error.code})`))
            else resolve(msg.result)
          }
        } catch {}
      }
      ws.on('message', handler)
      ws.send(JSON.stringify({ id, method, params }))
    })
  }
  return { send, close: () => ws.close() }
}

// Connect to a specific target by targetId (for SW inspection)
async function connectToTarget(targetId: string): Promise<{
  send: (method: string, params?: any) => Promise<any>
  close: () => void
}> {
  const { WebSocket } = await import('ws')
  const wsUrl = `ws://127.0.0.1:${TEST_PORT}/devtools/page/${targetId}`
  const ws = new WebSocket(wsUrl)
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve); ws.on('error', reject)
    setTimeout(() => reject(new Error('WS target timeout')), 10000)
  })

  let msgId = 1
  const send = (method: string, params: any = {}): Promise<any> => {
    return new Promise((resolve, reject) => {
      const id = msgId++
      const timeout = setTimeout(() => reject(new Error(`${method} timeout`)), 15000)
      const handler = (data: any) => {
        try {
          const msg = JSON.parse(data.toString())
          if (msg.id === id) {
            ws.off('message', handler); clearTimeout(timeout)
            if (msg.error) reject(new Error(`${msg.error.message}`))
            else resolve(msg.result)
          }
        } catch {}
      }
      ws.on('message', handler)
      ws.send(JSON.stringify({ id, method, params }))
    })
  }
  return { send, close: () => ws.close() }
}

// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═══════════════════════════════════════════════════════════')
  console.log('  SA CDP LoadUnpacked — Final Validation')
  console.log('═══════════════════════════════════════════════════════════')

  await killTestPort()
  const relay = freshRelay('cdp-validation')

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 1: Identity Validation
  // ═══════════════════════════════════════════════════════════════════════

  log('PHASE 1', '═══ Identity Validation ═══')
  ev('Step 1', 'Launch Chrome (clean profile)')
  const started = await launchChrome(relay, 'about:blank')
  if (!started) { console.error('FATAL: Chrome failed to start'); process.exit(1) }
  ev('Chrome', 'STARTED')

  await sleep(3000)
  ev('Step 2', 'Connect CDP WebSocket')
  const cdp = await connectCDP()
  ev('CDP', 'CONNECTED')

  ev('Step 3', `Extensions.loadUnpacked(${LOCAL_SA})`)
  const loadResult = await cdp.send('Extensions.loadUnpacked', { path: LOCAL_SA })
  const loadedId = loadResult?.id ?? null
  ev('loadUnpacked result', loadResult)
  ev('Extension ID', loadedId)

  await sleep(3000)

  ev('Step 4', 'Find SW target for loaded extension')
  const targets = await fetchTargets(TEST_PORT)
  const swTarget = targets.find((t: any) =>
    t.type === 'service_worker' && t.url?.includes(`chrome-extension://${loadedId}/`)
  )
  ev('SW target found', !!swTarget)
  if (swTarget) {
    ev('SW url', swTarget.url)
    ev('SW id (targetId)', swTarget.id)
    ev('SW title', swTarget.title)
    ev('SW webSocketDebuggerUrl', swTarget.webSocketDebuggerUrl ? 'PRESENT' : 'MISSING')
  }

  // Step 5: Connect to SW and inspect chrome.runtime
  ev('Step 5', 'Connect to SW target and inspect identity via Runtime.evaluate')
  let runtimeId = 'UNKNOWN'
  let manifestName = 'UNKNOWN'
  let manifestVersion = 'UNKNOWN'
  if (swTarget) {
    try {
      const swCdp = await connectToTarget(swTarget.id)

      // Get chrome.runtime.id
      const idResult = await swCdp.send('Runtime.evaluate', {
        expression: 'chrome.runtime.id',
        returnByValue: true,
      })
      runtimeId = idResult?.result?.value ?? 'EVAL_FAILED'
      ev('chrome.runtime.id', runtimeId)

      // Get manifest name
      const nameResult = await swCdp.send('Runtime.evaluate', {
        expression: 'chrome.runtime.getManifest().name',
        returnByValue: true,
      })
      manifestName = nameResult?.result?.value ?? 'EVAL_FAILED'
      ev('chrome.runtime.getManifest().name', manifestName)

      // Get manifest version
      const versionResult = await swCdp.send('Runtime.evaluate', {
        expression: 'chrome.runtime.getManifest().version',
        returnByValue: true,
      })
      manifestVersion = versionResult?.result?.value ?? 'EVAL_FAILED'
      ev('chrome.runtime.getManifest().version', manifestVersion)

      // Get full manifest for detailed inspection
      const fullManifest = await swCdp.send('Runtime.evaluate', {
        expression: 'JSON.stringify(chrome.runtime.getManifest())',
        returnByValue: true,
      })
      if (fullManifest?.result?.value) {
        const m = JSON.parse(fullManifest.result.value)
        ev('manifest.manifest_version', m.manifest_version)
        ev('manifest.key', m.key ? 'PRESENT (CWS)' : 'ABSENT (local build)')
        ev('manifest.update_url', m.update_url ?? 'ABSENT (local build)')
      }

      swCdp.close()
    } catch (e: any) {
      ev('SW inspection error', e.message)
      // Try alternative: connect via browser CDP + Target.attachToTarget
      log('FALLBACK', 'Trying Target.attachToTarget')
      try {
        const attach = await cdp.send('Target.attachToTarget', {
          targetId: swTarget.id,
          flatten: true,
        })
        ev('Attached session', attach?.sessionId)
        if (attach?.sessionId) {
          const idResult = await cdp.send('Runtime.evaluate', {
            expression: 'chrome.runtime.id',
            returnByValue: true,
          })
          runtimeId = idResult?.result?.value ?? 'ATTACH_EVAL_FAILED'
          ev('chrome.runtime.id (via attach)', runtimeId)
        }
      } catch (e2: any) {
        ev('Attach fallback error', e2.message)
      }
    }
  }

  // Identity summary
  log('IDENTITY CONFIRMED', '')
  ev('Extension ID from loadUnpacked', loadedId)
  ev('chrome.runtime.id', runtimeId)
  ev('IDs match', loadedId === runtimeId)
  ev('manifest.name', manifestName)
  ev('manifest.version', manifestVersion)
  ev('Is SA local (not CWS)', loadedId !== SA_CWS_ID)
  ev('Name matches expected', manifestName === 'MCP SuperAssistant')

  cdp.close()

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 2: Persistence Test
  // ═══════════════════════════════════════════════════════════════════════

  log('PHASE 2', '═══ Persistence After Chrome Restart ═══')
  ev('Step 1', 'Kill Chrome')
  await killTestPort()
  await sleep(3000)
  clearLocks(relay)

  // Check what's in the relay dir after Chrome close
  ev('Step 2', 'Check relay dir after Chrome close')
  const extDir = path.join(relay, 'Default', 'Extensions')
  if (fs.existsSync(extDir)) {
    const exts = fs.readdirSync(extDir, { withFileTypes: true }).filter(d => d.isDirectory())
    ev('Extensions/ entries', exts.length)
    for (const e of exts) {
      const versions = fs.readdirSync(path.join(extDir, e.name), { withFileTypes: true }).filter(d => d.isDirectory())
      for (const v of versions) {
        const mp = path.join(extDir, e.name, v.name, 'manifest.json')
        if (fs.existsSync(mp)) {
          try {
            const m = JSON.parse(fs.readFileSync(mp, 'utf-8'))
            ev(`  ${e.name}/${v.name}`, `"${m.name}" v${m.version}`)
          } catch {}
        }
      }
    }
  } else {
    ev('Extensions/ dir', 'NOT FOUND')
  }

  // Check Preferences for extension registration
  const prefsPath = path.join(relay, 'Default', 'Preferences')
  if (fs.existsSync(prefsPath)) {
    try {
      const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'))
      const extSettings = prefs?.extensions?.settings ?? {}
      const saEntries = Object.entries(extSettings).filter(([_, s]: [string, any]) =>
        s.manifest?.name?.includes('SuperAssistant') || s.manifest?.name?.includes('MCP')
      )
      ev('SA entries in Preferences', saEntries.length)
      for (const [id, s] of saEntries) {
        const settings = s as any
        ev(`  ${id}`, `"${settings.manifest?.name}" v${settings.manifest?.version} state=${settings.state} location=${settings.location}`)
      }
    } catch {}
  }

  ev('Step 3', 'Restart Chrome with same relay dir')
  const restarted = await launchChrome(relay, 'about:blank')
  ev('Chrome restarted', restarted)

  if (restarted) {
    await sleep(5000)
    const targets2 = await fetchTargets(TEST_PORT)
    const saSW2 = targets2.filter((t: any) =>
      t.type === 'service_worker' && t.url?.includes(`chrome-extension://${loadedId}/`)
    )
    ev('SA SW with original ID active after restart', saSW2.length)

    // Also check for any SA-like SW
    const anySA = targets2.filter((t: any) =>
      t.type === 'service_worker' && (
        t.url?.includes(SA_CWS_ID) ||
        t.url?.includes(loadedId ?? 'NOID')
      )
    )
    ev('Any SA SW (CWS or local) after restart', anySA.length)
    for (const t of anySA) {
      ev(`  SW`, t.url)
    }

    const persisted = saSW2.length > 0
    log('PERSISTENCE RESULT', persisted ? 'YES — SA local PERSISTS after restart' : 'NO — SA local did NOT persist, loadUnpacked needed each startup')

    // If persisted, verify identity again
    if (persisted) {
      try {
        const cdp2 = await connectToTarget(saSW2[0].id)
        const idCheck = await cdp2.send('Runtime.evaluate', {
          expression: 'chrome.runtime.id',
          returnByValue: true,
        })
        ev('chrome.runtime.id after restart', idCheck?.result?.value)
        ev('Same ID as before?', idCheck?.result?.value === loadedId)
        cdp2.close()
      } catch (e: any) {
        ev('Could not verify identity after restart', e.message)
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 3: Second Startup Cycle
    // ═══════════════════════════════════════════════════════════════════════

    log('PHASE 3', '═══ Second Startup Cycle ═══')
    ev('Step 1', 'Kill Chrome (second time)')
    await killTestPort()
    await sleep(3000)
    clearLocks(relay)

    ev('Step 2', 'Start Chrome (third launch, same relay)')
    const started3 = await launchChrome(relay, 'about:blank')
    ev('Chrome started (3rd)', started3)

    if (started3) {
      await sleep(5000)
      const targets3 = await fetchTargets(TEST_PORT)
      const saSW3 = targets3.filter((t: any) =>
        t.type === 'service_worker' && t.url?.includes(`chrome-extension://${loadedId}/`)
      )
      ev('SA SW active (3rd launch)', saSW3.length)

      if (saSW3.length === 0 && loadedId) {
        ev('SA NOT PERSISTED', 'Need to loadUnpacked again')
        ev('Step 3', 'Calling Extensions.loadUnpacked again')
        try {
          const cdp3 = await connectCDP()
          const load3 = await cdp3.send('Extensions.loadUnpacked', { path: LOCAL_SA })
          ev('loadUnpacked result (2nd time)', load3)
          ev('Extension ID (2nd load)', load3?.id)
          ev('Same ID as first load?', load3?.id === loadedId)

          await sleep(3000)
          const targets3b = await fetchTargets(TEST_PORT)
          const saSW3b = targets3b.filter((t: any) =>
            t.type === 'service_worker' && t.url?.includes(`chrome-extension://${load3?.id}/`)
          )
          ev('SA SW active after reload', saSW3b.length)
          cdp3.close()
        } catch (e: any) {
          ev('loadUnpacked failed on 2nd try', e.message)
        }
      } else {
        ev('SA PERSISTED through 2 restarts', 'No need to reload')
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 4: Guest Mode Analysis
  // ═══════════════════════════════════════════════════════════════════════

  log('PHASE 4', '═══ Guest Mode Analysis ═══')
  ev('DEFAULT_CHROME_PROFILE', 'guest (line 35 of ChromeCDP.ts)')
  ev('isGuest determination', 'profileDir === "guest" || options?.guestMode === true || DEFAULT="guest"')
  ev('When isGuest=true', 'syncProfileToRelay is SKIPPED. Only mkdir Default/')
  ev('Chrome args', 'NO --guest flag. Uses --user-data-dir=<relay> with empty Default/')
  ev('Conclusion', 'NOT Chrome Guest Mode. Just a clean isolated profile.')
  ev('Extensions installable?', 'YES — Extensions.loadUnpacked works on isolated profiles')
  ev('Extensions persist?', '(see Phase 2 result above)')

  // ═══════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════════════

  console.log('\n═══════════════════════════════════════════════════════════')
  console.log('  FINAL ANSWERS')
  console.log('═══════════════════════════════════════════════════════════\n')
  console.log('  1. ¿SA local persiste después de reiniciar? → see PHASE 2')
  console.log('  2. ¿Hay que ejecutar loadUnpacked cada startup? → see PHASE 3')
  console.log('  3. ¿OpenMCPWEBLOCK usa Guest real? → NO. Perfil limpio aislado.')
  console.log('  4. ¿Puede el perfil limpio tener SA? → YES (loadUnpacked works)')
  console.log('  5. ¿El ID de loadUnpacked identifica el SW? → see PHASE 1')
  console.log('  6. ¿Qué cambio mínimo necesita ChromeCDP? → based on persistence')

  console.log('\nDone.')

  await killTestPort()
}

main().catch(async (err) => {
  console.error('\nFATAL:', err)
  await killTestPort()
  process.exit(1)
})
