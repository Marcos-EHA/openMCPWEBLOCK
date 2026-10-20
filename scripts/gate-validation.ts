#!/usr/bin/env bun
/**
 * Gate validation script — validates the corrected ChromeCDP launcher.
 * 
 * Gates 1-6: real Chrome launches, SA installation, identity verification.
 * Port range: 9250-9252 (avoids user Chrome & previous test ports).
 *
 * Run: bun run scripts/gate-validation.ts
 */

import path from 'path'
import fs from 'fs'
import { execSync, spawn } from 'child_process'

const LOCALAPPDATA = process.env.LOCALAPPDATA ?? ''
const RELAY_ROOT = path.join(LOCALAPPDATA, 'openMCPWEBLOCK', 'chrome-agents')
const SA_CWS_ID = 'kngiafgkdnlkgmefdafaibkibegkcaef'
const LOCAL_SA = path.join(process.cwd(), 'chrome-extension', 'source', 'dist')
const CHROME_USER_DATA = path.join(LOCALAPPDATA, 'Google', 'Chrome', 'User Data')

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(ctx: string, msg: string = '') { console.log(`\n[${ctx}] ${msg}`) }
function ev(k: string, v: any) { console.log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`) }
function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }

function clearLocks(dir: string) {
  for (const n of ['SingletonLock', 'SingletonCookie', 'lockfile']) {
    for (const b of [dir, path.join(dir, 'Default')]) {
      try { fs.rmSync(path.join(b, n), { force: true, recursive: true }) } catch {}
    }
  }
}

async function pidOnPort(port: number): Promise<number | null> {
  try {
    const out = execSync(`netstat -ano | findstr ":${port}" | findstr LISTENING`, { encoding: 'utf8', timeout: 5000 }).trim()
    for (const l of out.split('\n').filter(Boolean)) {
      const p = l.trim().split(/\s+/)
      if (!p[1]?.endsWith(`:${port}`)) continue
      const pid = parseInt(p[p.length - 1]!, 10)
      if (pid > 0) return pid
    }
  } catch {}
  return null
}

async function killPort(port: number) {
  const pid = await pidOnPort(port)
  if (!pid) return
  try {
    const check = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8', timeout: 5000 })
    if (!check.toLowerCase().includes('chrome.exe')) return
    execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore', timeout: 10000 })
  } catch {}
  for (let i = 0; i < 20; i++) { if (!(await pidOnPort(port))) return; await sleep(500) }
}

async function portActive(port: number): Promise<boolean> {
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

async function launchChrome(relayDir: string, port: number, url = 'about:blank'): Promise<boolean> {
  clearLocks(relayDir)
  const proc = spawn(findChrome(), [
    `--remote-debugging-port=${port}`, `--user-data-dir=${relayDir}`,
    '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', url,
  ], { detached: true, stdio: 'ignore', shell: false })
  proc.unref()
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) { if (await portActive(port)) return true; await sleep(1000) }
  return false
}

// ─── CDP WebSocket ───────────────────────────────────────────────────────────

async function cdpSend(port: number, method: string, params: any = {}): Promise<any> {
  const { WebSocket } = await import('ws')
  const ver = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()) as any
  if (!ver?.webSocketDebuggerUrl) throw new Error('no webSocketDebuggerUrl')
  const ws = new WebSocket(ver.webSocketDebuggerUrl)
  await new Promise<void>((res, rej) => { ws.on('open', res); ws.on('error', rej); setTimeout(() => rej(new Error('WS timeout')), 10000) })
  const result = await new Promise<any>((res, rej) => {
    const to = setTimeout(() => rej(new Error(`${method} timeout`)), 15000)
    ws.on('message', (data: any) => {
      try { const m = JSON.parse(data.toString()); if (m.id === 1) { clearTimeout(to); m.error ? rej(new Error(m.error.message)) : res(m.result) } } catch {}
    })
    ws.send(JSON.stringify({ id: 1, method, params }))
  })
  ws.close()
  return result
}

async function inspectSW(port: number, targetId: string): Promise<{ runtimeId: string; name: string; version: string } | null> {
  const { WebSocket } = await import('ws')
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/${targetId}`)
    await new Promise<void>((res, rej) => { ws.on('open', res); ws.on('error', rej); setTimeout(() => rej(new Error('timeout')), 8000) })
    let id = 1
    const send = (method: string, params: any = {}): Promise<any> => new Promise((res, rej) => {
      const mid = id++
      const to = setTimeout(() => rej(new Error(`${method} timeout`)), 10000)
      const h = (data: any) => { try { const m = JSON.parse(data.toString()); if (m.id === mid) { ws.off('message', h); clearTimeout(to); m.error ? rej(new Error(m.error.message)) : res(m.result) } } catch {} }
      ws.on('message', h)
      ws.send(JSON.stringify({ id: mid, method, params }))
    })
    const rid = (await send('Runtime.evaluate', { expression: 'chrome.runtime.id', returnByValue: true }))?.result?.value
    const name = (await send('Runtime.evaluate', { expression: 'chrome.runtime.getManifest().name', returnByValue: true }))?.result?.value
    const version = (await send('Runtime.evaluate', { expression: 'chrome.runtime.getManifest().version', returnByValue: true }))?.result?.value
    ws.close()
    return { runtimeId: rid, name, version }
  } catch { return null }
}

function copyProfileWithoutSA(relayDir: string) {
  const src = path.join(CHROME_USER_DATA, 'Default')
  const dst = path.join(relayDir, 'Default')
  fs.mkdirSync(dst, { recursive: true })
  for (const f of ['Preferences', 'Secure Preferences', 'Login Data', 'Web Data']) {
    try { if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(dst, f)) } catch {}
  }
  try { fs.copyFileSync(path.join(CHROME_USER_DATA, 'Local State'), path.join(relayDir, 'Local State')) } catch {}
  const srcExt = path.join(src, 'Extensions')
  if (fs.existsSync(srcExt)) {
    const dstExt = path.join(dst, 'Extensions')
    fs.mkdirSync(dstExt, { recursive: true })
    for (const e of fs.readdirSync(srcExt, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === SA_CWS_ID) continue
      copyDir(path.join(srcExt, e.name), path.join(dstExt, e.name))
    }
  }
}

function copyDir(src: string, dst: string) {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name)
    if (e.isDirectory()) copyDir(s, d)
    else try { fs.copyFileSync(s, d) } catch {}
  }
}

function syncProfileWithSA(relayDir: string) {
  const src = path.join(CHROME_USER_DATA, 'Default')
  const dst = path.join(relayDir, 'Default')
  fs.mkdirSync(dst, { recursive: true })
  for (const f of ['Preferences', 'Secure Preferences', 'Login Data', 'Web Data']) {
    try { if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(dst, f)) } catch {}
  }
  try { fs.copyFileSync(path.join(CHROME_USER_DATA, 'Local State'), path.join(relayDir, 'Local State')) } catch {}
  const srcExt = path.join(src, 'Extensions')
  if (fs.existsSync(srcExt)) {
    const dstExt = path.join(dst, 'Extensions')
    if (fs.existsSync(dstExt)) fs.rmSync(dstExt, { recursive: true, force: true })
    copyDir(srcExt, dstExt)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═══════════════════════════════════════════════════════════')
  console.log('  GATE VALIDATION — ChromeCDP Launcher Fix')
  console.log('═══════════════════════════════════════════════════════════')

  const results: { gate: string; test: string; pass: boolean; detail: string }[] = []

  // ─── GATE 2: Clean profile, loadSAViaCDP ──────────────────────────────
  log('GATE 2', '═══ Clean profile → loadSAViaCDP → verify identity ═══')
  const PORT_A = 9250
  {
    await killPort(PORT_A)
    const relay = freshRelay('gate2-clean')
    ev('Relay', relay)
    ev('SA source', LOCAL_SA)

    const started = await launchChrome(relay, PORT_A)
    ev('Chrome started', started)
    if (!started) { results.push({ gate: 'G2', test: 'Chrome launch', pass: false, detail: 'Chrome failed to start' }); }
    else {
      await sleep(3000)
      // Load SA via CDP
      let extId: string | null = null
      try {
        const res = await cdpSend(PORT_A, 'Extensions.loadUnpacked', { path: LOCAL_SA })
        extId = res?.id ?? null
        ev('loadUnpacked extensionId', extId)
      } catch (e: any) {
        ev('loadUnpacked FAILED', e.message)
      }

      if (extId) {
        results.push({ gate: 'G2', test: 'loadUnpacked', pass: true, detail: `extensionId=${extId}` })

        await sleep(3000)
        // Find SA SW target
        const targets = await fetchTargets(PORT_A)
        const swTarget = targets.find((t: any) => t.type === 'service_worker' && t.url?.includes(`chrome-extension://${extId}/`))
        ev('SA SW found', !!swTarget)
        ev('SA SW url', swTarget?.url)

        if (swTarget) {
          results.push({ gate: 'G2', test: 'SW target', pass: true, detail: swTarget.url })
          // Inspect identity via Runtime.evaluate
          const identity = await inspectSW(PORT_A, swTarget.id)
          ev('chrome.runtime.id', identity?.runtimeId)
          ev('manifest.name', identity?.name)
          ev('manifest.version', identity?.version)
          ev('IDs match', identity?.runtimeId === extId)
          ev('Name correct', identity?.name === 'MCP SuperAssistant')

          results.push({
            gate: 'G2', test: 'Identity', pass:
              identity?.runtimeId === extId &&
              identity?.name === 'MCP SuperAssistant' &&
              identity?.version === '0.6.0',
            detail: `id=${identity?.runtimeId} name="${identity?.name}" v=${identity?.version}`
          })
        } else {
          results.push({ gate: 'G2', test: 'SW target', pass: false, detail: 'SW not found after loadUnpacked' })
        }
      } else {
        results.push({ gate: 'G2', test: 'loadUnpacked', pass: false, detail: 'No extensionId returned' })
      }
    }
    await killPort(PORT_A)
    await sleep(2000)
  }

  // ─── GATE 3: Profile WITH SA CWS ──────────────────────────────────────
  log('GATE 3', '═══ Profile with SA CWS → verify which SA is active ═══')
  {
    await killPort(PORT_A)
    const relay = freshRelay('gate3-cws')
    syncProfileWithSA(relay)
    ev('Profile synced with SA CWS', 'YES')

    const started = await launchChrome(relay, PORT_A)
    ev('Chrome started', started)
    if (!started) { results.push({ gate: 'G3', test: 'Chrome launch', pass: false, detail: 'failed' }); }
    else {
      await sleep(5000)
      const targets = await fetchTargets(PORT_A)
      const allSW = targets.filter((t: any) => t.type === 'service_worker')
      // Find SA by CWS ID
      const cwsSW = allSW.find((t: any) => t.url?.includes(`chrome-extension://${SA_CWS_ID}/`))
      ev('CWS SA SW found', !!cwsSW)
      if (cwsSW) {
        ev('CWS SW url', cwsSW.url)
        const identity = await inspectSW(PORT_A, cwsSW.id)
        ev('chrome.runtime.id', identity?.runtimeId)
        ev('manifest.name', identity?.name)
        ev('manifest.version', identity?.version)
        ev('Is CWS?', identity?.runtimeId === SA_CWS_ID)
        results.push({
          gate: 'G3', test: 'CWS SA identity', pass:
            identity?.runtimeId === SA_CWS_ID &&
            identity?.name === 'MCP SuperAssistant',
          detail: `id=${identity?.runtimeId} name="${identity?.name}" v=${identity?.version}`
        })
      } else {
        // Check for any SA-like SW
        const anySA = allSW.find((t: any) => t.url?.includes('SuperAssistant') || t.url?.includes('mcpsuperassistant'))
        ev('Any SA SW', !!anySA)
        results.push({ gate: 'G3', test: 'CWS SA identity', pass: false, detail: `CWS SW not found. Total SWs: ${allSW.length}` })
      }
    }
    await killPort(PORT_A)
    await sleep(2000)
  }

  // ─── GATE 4: Two agents simultaneously ────────────────────────────────
  log('GATE 4', '═══ Two simultaneous agents with SA ═══')
  const PORT_B = 9251
  {
    await killPort(PORT_A); await killPort(PORT_B)
    const relayA = freshRelay('gate4-agent-a')
    const relayB = freshRelay('gate4-agent-b')

    ev('Agent A', `relay=${relayA} port=${PORT_A}`)
    ev('Agent B', `relay=${relayB} port=${PORT_B}`)

    // Launch both
    const [startedA, startedB] = await Promise.all([
      launchChrome(relayA, PORT_A),
      launchChrome(relayB, PORT_B),
    ])
    ev('Chrome A started', startedA)
    ev('Chrome B started', startedB)

    if (startedA && startedB) {
      await sleep(3000)
      // Load SA on both
      let idA: string | null = null, idB: string | null = null
      try { idA = (await cdpSend(PORT_A, 'Extensions.loadUnpacked', { path: LOCAL_SA }))?.id ?? null } catch (e: any) { ev('A loadUnpacked err', e.message) }
      try { idB = (await cdpSend(PORT_B, 'Extensions.loadUnpacked', { path: LOCAL_SA }))?.id ?? null } catch (e: any) { ev('B loadUnpacked err', e.message) }
      ev('SA-A extensionId', idA)
      ev('SA-B extensionId', idB)

      results.push({ gate: 'G4', test: 'Both loaded', pass: !!idA && !!idB, detail: `A=${idA} B=${idB}` })

      await sleep(3000)

      // Verify SWs
      const tA = await fetchTargets(PORT_A)
      const tB = await fetchTargets(PORT_B)
      const swA = tA.find((t: any) => t.type === 'service_worker' && idA && t.url?.includes(`chrome-extension://${idA}/`))
      const swB = tB.find((t: any) => t.type === 'service_worker' && idB && t.url?.includes(`chrome-extension://${idB}/`))
      ev('SW-A found', !!swA)
      ev('SW-B found', !!swB)
      results.push({ gate: 'G4', test: 'SWs independent', pass: !!swA && !!swB, detail: `A=${swA?.url} B=${swB?.url}` })

      // Verify A has NO targets from B
      const crossA = tA.find((t: any) => idB && t.url?.includes(`chrome-extension://${idB}/`))
      const crossB = tB.find((t: any) => idA && t.url?.includes(`chrome-extension://${idA}/`))
      results.push({ gate: 'G4', test: 'Isolation', pass: !crossA && !crossB, detail: `cross-A=${!!crossA} cross-B=${!!crossB}` })

      // Stop A, verify B still works
      log('GATE 4', 'Stopping Agent A...')
      await killPort(PORT_A)
      await sleep(2000)
      const bStillUp = await portActive(PORT_B)
      ev('B still active after A killed', bStillUp)
      if (bStillUp) {
        const tB2 = await fetchTargets(PORT_B)
        const swB2 = tB2.find((t: any) => t.type === 'service_worker' && idB && t.url?.includes(`chrome-extension://${idB}/`))
        results.push({ gate: 'G4', test: 'Kill A no affect B', pass: !!swB2, detail: `B SW still active=${!!swB2}` })
      } else {
        results.push({ gate: 'G4', test: 'Kill A no affect B', pass: false, detail: 'B went down' })
      }

      // Restart A, verify B unaffected
      log('GATE 4', 'Restarting Agent A...')
      clearLocks(relayA)
      const restartedA = await launchChrome(relayA, PORT_A)
      ev('A restarted', restartedA)
      if (restartedA) {
        const bAfterRestart = await portActive(PORT_B)
        results.push({ gate: 'G4', test: 'Restart A no affect B', pass: bAfterRestart, detail: `B active=${bAfterRestart}` })
      }
    } else {
      results.push({ gate: 'G4', test: 'Both launch', pass: false, detail: `A=${startedA} B=${startedB}` })
    }
    await killPort(PORT_A); await killPort(PORT_B)
    await sleep(2000)
  }

  // ─── GATE 5: Forced failure ───────────────────────────────────────────
  log('GATE 5', '═══ Forced failure: invalid SA path ═══')
  {
    await killPort(PORT_A)
    const relay = freshRelay('gate5-fail')
    const started = await launchChrome(relay, PORT_A)
    ev('Chrome started', started)
    if (started) {
      await sleep(2000)
      const badPath = path.join(process.cwd(), 'nonexistent-sa-dir-12345')
      try {
        const res = await cdpSend(PORT_A, 'Extensions.loadUnpacked', { path: badPath })
        ev('loadUnpacked with bad path', res)
        results.push({ gate: 'G5', test: 'Bad path fails', pass: false, detail: `Unexpected success: ${JSON.stringify(res)}` })
      } catch (e: any) {
        ev('loadUnpacked error (expected)', e.message)
        results.push({ gate: 'G5', test: 'Bad path fails', pass: true, detail: `Error: ${e.message}` })
      }
      // Verify Chrome is still running (no crash)
      const stillUp = await portActive(PORT_A)
      results.push({ gate: 'G5', test: 'Chrome survives', pass: stillUp, detail: `still active=${stillUp}` })
    }
    await killPort(PORT_A)
    await sleep(2000)
  }

  // ─── GATE 6: Audit detectSAInProfile ──────────────────────────────────
  log('GATE 6', '═══ Audit: detectSAInProfile usage in launch flow ═══')
  {
    // Read ChromeCDP.ts and check if detectSAInProfile is still used as launch authority
    const cdpSource = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'webRelay', 'ChromeCDP.ts'), 'utf-8')
    
    // Check launchChrome for detectSAInProfile calls
    const launchSection = cdpSource.substring(
      cdpSource.indexOf('export async function launchChrome'),
      cdpSource.indexOf('function syncProfileToRelay')
    )
    const detectCalls = (launchSection.match(/detectSAInProfile/g) || []).length
    ev('detectSAInProfile calls in launchChrome()', detectCalls)
    
    // Check launchChromeInstance
    const instanceSection = cdpSource.substring(
      cdpSource.indexOf('async function launchChromeInstance'),
      cdpSource.indexOf('async function isSAServiceWorkerActive')
    )
    const detectCallsInstance = (instanceSection.match(/detectSAInProfile/g) || []).length
    ev('detectSAInProfile calls in launchChromeInstance()', detectCallsInstance)
    
    // Check if --load-extension is still used
    const loadExtCalls = (cdpSource.match(/--load-extension/g) || []).length
    const disableExtCalls = (cdpSource.match(/--disable-extensions-except/g) || []).length
    ev('--load-extension remaining', loadExtCalls)
    ev('--disable-extensions-except remaining', disableExtCalls)
    
    const noDetectInLaunch = detectCalls === 0
    const noDetectInInstance = detectCallsInstance === 0
    const noLoadExt = loadExtCalls === 0
    const noDisableExt = disableExtCalls === 0
    
    results.push({
      gate: 'G6', test: 'No detectSAInProfile in launch flow',
      pass: noDetectInLaunch && noDetectInInstance,
      detail: `launchChrome=${detectCalls} launchInstance=${detectCallsInstance}`
    })
    results.push({
      gate: 'G6', test: 'No --load-extension flags',
      pass: noLoadExt && noDisableExt,
      detail: `--load-ext=${loadExtCalls} --disable-ext=${disableExtCalls}`
    })
  }

  // ═══════════════════════════════════════════════════════════════════════
  // RESULTS
  // ═══════════════════════════════════════════════════════════════════════

  console.log('\n═══════════════════════════════════════════════════════════')
  console.log('  GATE VALIDATION RESULTS')
  console.log('═══════════════════════════════════════════════════════════\n')

  console.log('| Gate | Test | Pass | Detail |')
  console.log('|------|------|------|--------|')
  for (const r of results) {
    console.log(`| ${r.gate} | ${r.test} | ${r.pass ? '✅' : '❌'} | ${r.detail} |`)
  }

  const allPass = results.every(r => r.pass)
  const failCount = results.filter(r => !r.pass).length
  console.log(`\n${allPass ? '✅ ALL GATES PASS' : `❌ ${failCount} FAILURES`}`)
  console.log('\nDone.')
}

main().catch(async (err) => {
  console.error('\nFATAL:', err)
  try { await killPort(9250) } catch {}
  try { await killPort(9251) } catch {}
  process.exit(1)
})
