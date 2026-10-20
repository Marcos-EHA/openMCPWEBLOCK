#!/usr/bin/env bun
/**
 * SA Launcher — Isolated experiments (Gate B, phase 2).
 *
 * Run: bun run scripts/sa-isolated-tests.ts
 *
 * Each test runs SEQUENTIALLY with NO other test Chrome alive.
 * Uses port 9240 exclusively.
 */

import path from 'path'
import fs from 'fs'
import { execSync } from 'child_process'
import crypto from 'crypto'

const LOCALAPPDATA = process.env.LOCALAPPDATA ?? ''
const CHROME_USER_DATA = path.join(LOCALAPPDATA, 'Google', 'Chrome', 'User Data')
const RELAY_ROOT = path.join(LOCALAPPDATA, 'openMCPWEBLOCK', 'chrome-agents')
const SA_CWS_ID = 'kngiafgkdnlkgmefdafaibkibegkcaef'
const TEST_PORT = 9240
const LOCAL_SA = path.join(process.cwd(), 'chrome-extension', 'source', 'dist')
const CWS_SA_PATH = path.join(CHROME_USER_DATA, 'Default', 'Extensions', SA_CWS_ID)

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(s: string, ...a: any[]) { console.log(`\n[${s}]`, ...a) }
function ev(l: string, v: any) { console.log(`  ${l}: ${typeof v === 'object' ? JSON.stringify(v) : v}`) }
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
    if (!check.toLowerCase().includes('chrome.exe')) return
    execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore', timeout: 10000 })
  } catch {}
  for (let i = 0; i < 15; i++) {
    if (!(await findPidOnPort(TEST_PORT))) return
    await sleep(500)
  }
}

async function isPortActive(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) })
    return r.ok
  } catch { return false }
}

async function fetchTargets(port: number): Promise<any[]> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(3000) })
    return await r.json() as any[]
  } catch { return [] }
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

function copyDirCounted(src: string, dst: string): { ok: number; fail: string[] } {
  fs.mkdirSync(dst, { recursive: true })
  let ok = 0; const fail: string[] = []
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name)
    if (e.isDirectory()) { const sub = copyDirCounted(s, d); ok += sub.ok; fail.push(...sub.fail) }
    else { try { fs.copyFileSync(s, d); ok++ } catch (err: any) { fail.push(`${s}: ${err.code}`) } }
  }
  return { ok, fail }
}

function syncProfileToRelayAudited(profileName: string, relayDir: string): { ok: number; fail: string[] } {
  const src = path.join(CHROME_USER_DATA, profileName)
  const dst = path.join(relayDir, 'Default')
  fs.mkdirSync(dst, { recursive: true })
  let totalOk = 0; const totalFail: string[] = []

  // Profile files
  for (const f of ['Preferences', 'Secure Preferences', 'Login Data', 'Web Data']) {
    try {
      const s = path.join(src, f)
      if (fs.existsSync(s)) { fs.copyFileSync(s, path.join(dst, f)); totalOk++ }
    } catch (e: any) { totalFail.push(`${f}: ${e.code}`) }
  }
  // Local State
  try {
    const s = path.join(CHROME_USER_DATA, 'Local State')
    if (fs.existsSync(s)) { fs.copyFileSync(s, path.join(relayDir, 'Local State')); totalOk++ }
  } catch (e: any) { totalFail.push(`Local State: ${e.code}`) }

  // Extensions
  const srcExt = path.join(src, 'Extensions')
  const dstExt = path.join(dst, 'Extensions')
  if (fs.existsSync(srcExt)) {
    if (fs.existsSync(dstExt)) fs.rmSync(dstExt, { recursive: true, force: true })
    const r = copyDirCounted(srcExt, dstExt)
    totalOk += r.ok; totalFail.push(...r.fail)
  }
  return { ok: totalOk, fail: totalFail }
}

function hashFile(p: string): string {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').substring(0, 16) } catch { return 'ERROR' }
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

function inspectSATargets(targets: any[]): { saTargets: any[]; saSW: any[] } {
  const saTargets = targets.filter((t: any) =>
    t.url?.includes(SA_CWS_ID) ||
    String(t.title || '').includes('SuperAssistant') ||
    String(t.title || '').includes('MCP SuperAssistant') ||
    t.url?.includes('mcpsuperassistant')
  )
  const saSW = saTargets.filter((t: any) => t.type === 'service_worker')
  return { saTargets, saSW }
}

// ─── loadUnpackedViaPipe ─────────────────────────────────────────────────────

async function pipeInstall(relayDir: string, saDir: string): Promise<{ ok: boolean; id: string | null; err?: string }> {
  let pup: any
  try { pup = await import('puppeteer-core'); if (pup.default) pup = pup.default }
  catch (e: any) { return { ok: false, id: null, err: `no puppeteer: ${e.message}` } }

  clearLocks(relayDir)
  let browser: any = null
  try {
    browser = await pup.launch({
      executablePath: findChrome(), pipe: true, userDataDir: relayDir,
      args: ['--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling'],
      headless: false, timeout: 45000,
    })
    const cdp = await browser.target().createCDPSession()
    const res = await cdp.send('Extensions.loadUnpacked', { path: saDir })
    return { ok: true, id: res?.id ?? null }
  } catch (e: any) { return { ok: false, id: null, err: e.message } }
  finally {
    const pid = browser?.process()?.pid
    try { if (browser) await Promise.race([browser.close(), sleep(5000)]) } catch {}
    if (pid) { try { execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore' }) } catch {} }
    await sleep(2000); clearLocks(relayDir)
  }
}

// ─── CDP WebSocket loadUnpacked on running Chrome ────────────────────────────

async function cdpLoadUnpacked(debugPort: number, saDir: string): Promise<{
  ok: boolean; id: string | null; allExtensions?: any[]; err?: string
}> {
  const { WebSocket } = await import('ws')
  try {
    const ver = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()) as any
    if (!ver?.webSocketDebuggerUrl) return { ok: false, id: null, err: 'no webSocketDebuggerUrl' }

    const ws = new WebSocket(ver.webSocketDebuggerUrl)
    await new Promise<void>((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })

    let msgId = 1
    const send = (method: string, params: any = {}): Promise<any> => {
      return new Promise((resolve, reject) => {
        const id = msgId++
        const timeout = setTimeout(() => reject(new Error(`${method} timeout`)), 15000)
        const handler = (data: any) => {
          try {
            const msg = JSON.parse(data.toString())
            if (msg.id === id) {
              ws.off('message', handler)
              clearTimeout(timeout)
              if (msg.error) reject(new Error(msg.error.message))
              else resolve(msg.result)
            }
          } catch {}
        }
        ws.on('message', handler)
        ws.send(JSON.stringify({ id, method, params }))
      })
    }

    // Load unpacked
    const loadResult = await send('Extensions.loadUnpacked', { path: saDir })
    const extId = loadResult?.id ?? null

    // Try to get all extensions
    let allExtensions: any[] = []
    try {
      const extResult = await send('Extensions.getAll', {})
      allExtensions = extResult?.extensions ?? []
    } catch { /* getAll may not exist */ }

    ws.close()
    return { ok: true, id: extId, allExtensions }
  } catch (e: any) {
    return { ok: false, id: null, err: e.message }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═══════════════════════════════════════════════════════════')
  console.log('  SA LAUNCHER — Isolated Experiments (Gate B Phase 2)')
  console.log('═══════════════════════════════════════════════════════════')

  // Pre-check: is user's Chrome running?
  const userChromePids = (() => {
    try {
      const ps = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /FO CSV /NH', { encoding: 'utf8', timeout: 5000 })
      return ps.split('\n').filter(l => l.includes('chrome.exe')).length
    } catch { return 0 }
  })()
  log('PRE-CHECK', `User Chrome processes: ${userChromePids}`)
  if (userChromePids > 0) {
    log('PRE-CHECK', '⚠ User Chrome is running. Tests will proceed but pipe install may be affected.')
    log('PRE-CHECK', '  Close Chrome manually for cleanest isolation, but DO NOT use taskkill /IM.')
  }

  // Kill any leftover test Chrome
  await killTestPort()

  const results: { test: string; variable: string; result: string }[] = []

  // ═══════════════════════════════════════════════════════════════════════
  // TEST B-SOLO: pipe install with NO other test Chrome
  // ═══════════════════════════════════════════════════════════════════════

  log('TEST B-SOLO', '═══ Pipe install, profile without SA, no other test Chrome ═══')
  {
    const relay = freshRelay('iso-b-solo')
    // Sync profile WITHOUT SA extension
    const src = path.join(CHROME_USER_DATA, 'Default')
    const dst = path.join(relay, 'Default')
    for (const f of ['Preferences', 'Secure Preferences', 'Login Data', 'Web Data']) {
      try { const s = path.join(src, f); if (fs.existsSync(s)) fs.copyFileSync(s, path.join(dst, f)) } catch {}
    }
    try { fs.copyFileSync(path.join(CHROME_USER_DATA, 'Local State'), path.join(relay, 'Local State')) } catch {}
    // Copy all extensions EXCEPT SA CWS
    const srcExt = path.join(src, 'Extensions')
    if (fs.existsSync(srcExt)) {
      const dstExt = path.join(dst, 'Extensions')
      fs.mkdirSync(dstExt, { recursive: true })
      for (const e of fs.readdirSync(srcExt, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name === SA_CWS_ID) continue
        copyDirCounted(path.join(srcExt, e.name), path.join(dstExt, e.name))
      }
    }

    ev('SA in relay before pipe', 'NO (SA CWS excluded from sync)')
    ev('Other test Chrome alive', 'NO')

    const pipeResult = await pipeInstall(relay, LOCAL_SA)
    ev('Pipe result', pipeResult.ok ? 'SUCCESS' : 'FAILED')
    ev('Extension ID from pipe', pipeResult.id)
    if (pipeResult.err) ev('Error', pipeResult.err)

    if (pipeResult.ok) {
      // Verify SA was installed in the relay dir
      const detect = (() => {
        const extDir = path.join(dst, 'Extensions')
        if (!fs.existsSync(extDir)) return null
        for (const ext of fs.readdirSync(extDir, { withFileTypes: true })) {
          if (!ext.isDirectory()) continue
          for (const ver of fs.readdirSync(path.join(extDir, ext.name), { withFileTypes: true })) {
            if (!ver.isDirectory()) continue
            const mp = path.join(extDir, ext.name, ver.name, 'manifest.json')
            if (!fs.existsSync(mp)) continue
            try {
              const m = JSON.parse(fs.readFileSync(mp, 'utf-8'))
              if (m.name?.includes('MCP') || m.name?.includes('SuperAssistant')) {
                return { id: ext.name, name: m.name, version: m.version }
              }
            } catch {}
          }
        }
        return null
      })()
      ev('SA in relay after pipe', detect ? `YES — id=${detect.id} name="${detect.name}" v${detect.version}` : 'NOT FOUND')

      // Launch final Chrome and check
      const started = await launchChrome(relay, 'about:blank')
      ev('Chrome final started', started)
      if (started) {
        await sleep(5000)
        const targets = await fetchTargets(TEST_PORT)
        const { saTargets, saSW } = inspectSATargets(targets)
        ev('SA targets', saTargets.length)
        ev('SA SW active', saSW.length)
        for (const t of saSW) ev('  SW', `${t.url} — "${t.title}"`)
        results.push({ test: 'B-solo', variable: 'pipe sin otro Chrome', result: saSW.length > 0 ? `✅ SA SW ACTIVE (id from pipe: ${pipeResult.id})` : `⚠️ SA present but SW not active` })
      } else {
        results.push({ test: 'B-solo', variable: 'pipe sin otro Chrome', result: '❌ Chrome failed to start after pipe' })
      }
    } else {
      results.push({ test: 'B-solo', variable: 'pipe sin otro Chrome', result: `❌ Pipe FAILED: ${pipeResult.err?.substring(0, 80)}` })
    }
    await killTestPort(); await sleep(2000)
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TEST C-SOLO: clean profile, pipe install
  // ═══════════════════════════════════════════════════════════════════════

  log('TEST C-SOLO', '═══ Pipe install, completely clean profile ═══')
  {
    const relay = freshRelay('iso-c-solo')
    ev('Profile', 'EMPTY (no sync)')
    const pipeResult = await pipeInstall(relay, LOCAL_SA)
    ev('Pipe result', pipeResult.ok ? 'SUCCESS' : 'FAILED')
    ev('Extension ID', pipeResult.id)
    if (pipeResult.err) ev('Error', pipeResult.err)

    if (pipeResult.ok) {
      const started = await launchChrome(relay, 'about:blank')
      ev('Chrome started', started)
      if (started) {
        await sleep(5000)
        const targets = await fetchTargets(TEST_PORT)
        const { saSW } = inspectSATargets(targets)
        ev('SA SW active', saSW.length)
        results.push({ test: 'C-solo', variable: 'profile limpio', result: saSW.length > 0 ? '✅ SA SW ACTIVE' : '⚠️ SA not active' })
      } else {
        results.push({ test: 'C-solo', variable: 'profile limpio', result: '❌ Chrome failed to start' })
      }
    } else {
      // Try launching Chrome anyway to see if it starts
      const started = await launchChrome(relay, 'about:blank')
      ev('Chrome started (no SA)', started)
      results.push({ test: 'C-solo', variable: 'profile limpio', result: `❌ Pipe FAILED: ${pipeResult.err?.substring(0, 80)}` })
    }
    await killTestPort(); await sleep(2000)
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TEST C-PREINIT: pre-initialized profile, then pipe install
  // ═══════════════════════════════════════════════════════════════════════

  log('TEST C-PREINIT', '═══ Pre-initialized profile, then pipe install ═══')
  {
    const relay = freshRelay('iso-c-preinit')
    ev('Step 1', 'Launch Chrome to initialize the profile')
    const initStarted = await launchChrome(relay, 'about:blank')
    ev('Init Chrome started', initStarted)
    if (initStarted) {
      await sleep(5000) // Let Chrome fully initialize
      ev('Step 2', 'Kill init Chrome')
      await killTestPort()
      await sleep(3000)
      clearLocks(relay)

      ev('Step 3', 'Run loadUnpackedViaPipe on initialized profile')
      const pipeResult = await pipeInstall(relay, LOCAL_SA)
      ev('Pipe result', pipeResult.ok ? 'SUCCESS' : 'FAILED')
      ev('Extension ID', pipeResult.id)
      if (pipeResult.err) ev('Error', pipeResult.err)

      if (pipeResult.ok) {
        ev('Step 4', 'Launch final Chrome')
        const finalStarted = await launchChrome(relay, 'about:blank')
        ev('Final Chrome started', finalStarted)
        if (finalStarted) {
          await sleep(5000)
          const targets = await fetchTargets(TEST_PORT)
          const { saSW } = inspectSATargets(targets)
          ev('SA SW active', saSW.length)
          for (const t of saSW) ev('  SW', t.url)
          results.push({ test: 'C-preinit', variable: 'profile inicializado', result: saSW.length > 0 ? '✅ SA SW ACTIVE' : '⚠️ SA not active' })
        } else {
          results.push({ test: 'C-preinit', variable: 'profile inicializado', result: '❌ Final Chrome failed' })
        }
      } else {
        results.push({ test: 'C-preinit', variable: 'profile inicializado', result: `❌ Pipe FAILED: ${pipeResult.err?.substring(0, 80)}` })
      }
    } else {
      results.push({ test: 'C-preinit', variable: 'profile inicializado', result: '❌ Init Chrome failed to start' })
    }
    await killTestPort(); await sleep(2000)
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TEST E: Extensions.loadUnpacked on FINAL Chrome via CDP WebSocket
  // ═══════════════════════════════════════════════════════════════════════

  log('TEST E', '═══ Extensions.loadUnpacked on running Chrome via CDP WebSocket ═══')
  {
    const relay = freshRelay('iso-e-cdp')
    ev('Step 1', 'Launch Chrome with debug port (clean profile)')
    const started = await launchChrome(relay, 'about:blank')
    ev('Chrome started', started)

    if (started) {
      await sleep(3000)
      ev('Step 2', 'Connect via CDP WebSocket and call Extensions.loadUnpacked')
      const loadResult = await cdpLoadUnpacked(TEST_PORT, LOCAL_SA)
      ev('loadUnpacked result', loadResult.ok ? 'SUCCESS' : 'FAILED')
      ev('Extension ID', loadResult.id)
      if (loadResult.err) ev('Error', loadResult.err)
      if (loadResult.allExtensions?.length) {
        ev('Extensions.getAll count', loadResult.allExtensions.length)
        for (const ext of loadResult.allExtensions) {
          ev(`  ext`, `id=${ext.id} name="${ext.name}" enabled=${ext.enabled}`)
        }
      }

      if (loadResult.ok) {
        await sleep(3000)
        ev('Step 3', 'Inspect targets after loadUnpacked')
        const targets = await fetchTargets(TEST_PORT)
        const { saTargets, saSW } = inspectSATargets(targets)
        ev('SA targets after load', saTargets.length)
        ev('SA SW active', saSW.length)
        for (const t of saSW) {
          const idMatch = t.url?.match(/chrome-extension:\/\/([a-z]+)\//)
          ev('  SW', `${t.url} — id=${idMatch?.[1]} matches_CWS=${idMatch?.[1] === SA_CWS_ID}`)
        }
        results.push({ test: 'E-cdp', variable: 'loadUnpacked sobre Chrome final', result: saSW.length > 0 ? `✅ SA SW ACTIVE (id=${loadResult.id})` : `⚠️ Loaded but SW not active` })
      } else {
        results.push({ test: 'E-cdp', variable: 'loadUnpacked sobre Chrome final', result: `❌ loadUnpacked FAILED: ${loadResult.err?.substring(0, 80)}` })
      }
    } else {
      results.push({ test: 'E-cdp', variable: 'loadUnpacked sobre Chrome final', result: '❌ Chrome failed to start' })
    }
    await killTestPort(); await sleep(2000)
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TEST 5: SA local vs SA CWS comparison
  // ═══════════════════════════════════════════════════════════════════════

  log('TEST 5', '═══ Physical comparison: SA local build vs SA CWS ═══')
  {
    ev('Local SA path', LOCAL_SA)
    const cwsVersions = (() => {
      if (!fs.existsSync(CWS_SA_PATH)) return []
      return fs.readdirSync(CWS_SA_PATH, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
    })()
    const cwsLatest = cwsVersions.length > 0 ? path.join(CWS_SA_PATH, cwsVersions[cwsVersions.length - 1]!) : null
    ev('CWS SA path', cwsLatest ?? 'NOT FOUND')

    if (cwsLatest && fs.existsSync(LOCAL_SA)) {
      // Compare manifests
      const localManifest = JSON.parse(fs.readFileSync(path.join(LOCAL_SA, 'manifest.json'), 'utf-8'))
      const cwsManifest = JSON.parse(fs.readFileSync(path.join(cwsLatest, 'manifest.json'), 'utf-8'))

      log('MANIFEST COMPARISON', '')
      const fields = ['name', 'version', 'manifest_version', 'description'] as const
      for (const f of fields) {
        const l = localManifest[f], c = cwsManifest[f]
        ev(`  ${f}`, `local="${l}" | cws="${c}" | ${l === c ? 'MATCH' : 'DIFFER'}`)
      }
      ev('  background.service_worker', `local="${localManifest.background?.service_worker}" | cws="${cwsManifest.background?.service_worker}"`)
      ev('  key (CWS signing)', `local=${localManifest.key ? 'YES' : 'NO'} | cws=${cwsManifest.key ? 'YES' : 'NO'}`)
      ev('  update_url', `local=${localManifest.update_url ? 'YES' : 'NO'} | cws=${cwsManifest.update_url ? 'YES' : 'NO'}`)

      // Compare key files
      log('FILE COMPARISON', '')
      const keyFiles = ['background.js', 'manifest.json']
      // Also find content scripts
      const localFiles = new Set<string>()
      const cwsFiles = new Set<string>()
      const scanDir = (dir: string, rel: string, set: Set<string>) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = rel ? `${rel}/${e.name}` : e.name
          if (e.isDirectory()) { if (e.name !== '_metadata' && e.name !== 'node_modules') scanDir(path.join(dir, e.name), p, set) }
          else set.add(p)
        }
      }
      scanDir(LOCAL_SA, '', localFiles)
      scanDir(cwsLatest, '', cwsFiles)

      ev('Local file count', localFiles.size)
      ev('CWS file count', cwsFiles.size)

      const onlyLocal = [...localFiles].filter(f => !cwsFiles.has(f))
      const onlyCWS = [...cwsFiles].filter(f => !localFiles.has(f))
      const common = [...localFiles].filter(f => cwsFiles.has(f))

      if (onlyLocal.length > 0) ev('Only in local', onlyLocal.slice(0, 10).join(', ') + (onlyLocal.length > 10 ? ` ... +${onlyLocal.length - 10}` : ''))
      if (onlyCWS.length > 0) ev('Only in CWS', onlyCWS.slice(0, 10).join(', ') + (onlyCWS.length > 10 ? ` ... +${onlyCWS.length - 10}` : ''))

      // Compare hashes of common files
      let matching = 0, differing = 0
      const differingFiles: string[] = []
      for (const f of common) {
        const lh = hashFile(path.join(LOCAL_SA, f))
        const ch = hashFile(path.join(cwsLatest, f))
        if (lh === ch) matching++
        else { differing++; differingFiles.push(f) }
      }
      ev('Common files matching hash', matching)
      ev('Common files DIFFERING hash', differing)
      if (differingFiles.length > 0) {
        ev('Differing files', differingFiles.slice(0, 15).join(', '))
      }

      // Conclusion
      log('SA IDENTITY', '')
      ev('Same artifact?', differing === 0 && onlyLocal.length === 0 && onlyCWS.length === 0 ? 'YES (identical)' : 'NO (different builds)')
      ev('Same name', localManifest.name === cwsManifest.name ? 'YES' : 'NO')
      ev('Same version', localManifest.version === cwsManifest.version ? 'YES' : 'NO')
      ev('CWS has signing key', cwsManifest.key ? 'YES' : 'NO')
      ev('Local has signing key', localManifest.key ? 'NO (unsigned/unpacked)' : 'NO')
      ev('CWS extension ID', SA_CWS_ID)
      ev('Local extension ID', 'DYNAMIC (Chrome assigns based on path when loaded unpacked)')
    } else {
      ev('Comparison', 'SKIPPED — one or both SA paths not found')
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TEST 8: syncProfileToRelay audit
  // ═══════════════════════════════════════════════════════════════════════

  log('TEST 8', '═══ syncProfileToRelay audit ═══')
  {
    const relay = freshRelay('iso-sync-audit')
    const result = syncProfileToRelayAudited('Default', relay)
    ev('Files copied successfully', result.ok)
    ev('Files FAILED to copy', result.fail.length)
    if (result.fail.length > 0) {
      log('SYNC FAILURES', '')
      for (const f of result.fail) ev('  FAIL', f)
    }

    // Check coherence
    const hasExtDir = fs.existsSync(path.join(relay, 'Default', 'Extensions'))
    const hasSecPrefs = fs.existsSync(path.join(relay, 'Default', 'Secure Preferences'))
    const hasPrefs = fs.existsSync(path.join(relay, 'Default', 'Preferences'))
    ev('Extensions/ exists', hasExtDir)
    ev('Secure Preferences exists', hasSecPrefs)
    ev('Preferences exists', hasPrefs)
    ev('Coherent state', hasExtDir && hasSecPrefs && hasPrefs ? 'YES' : 'POTENTIALLY INCOHERENT')
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════════════

  console.log('\n═══════════════════════════════════════════════════════════')
  console.log('  ISOLATED EXPERIMENTS — RESULTS')
  console.log('═══════════════════════════════════════════════════════════\n')

  console.log('| Test | Variable aislada | Resultado |')
  console.log('|------|-----------------|-----------|')
  for (const r of results) {
    console.log(`| ${r.test} | ${r.variable} | ${r.result} |`)
  }

  console.log('\nDone.')
}

main().catch(async (err) => {
  console.error('\nFATAL:', err)
  await killTestPort()
  process.exit(1)
})
