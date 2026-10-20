#!/usr/bin/env bun
/**
 * SA Isolated Tests — Phase 2b: Tests that DON'T require puppeteer pipe.
 *
 * Tests B-solo and C-solo CONFIRMED: loadUnpackedViaPipe CANNOT work
 * when user's Chrome is running (ProcessSingleton conflict).
 *
 * This script runs:
 *   E: Extensions.loadUnpacked on running Chrome via CDP WebSocket
 *   5: SA local vs SA CWS physical comparison
 *   8: syncProfileToRelay audit
 *
 * Run: bun run scripts/sa-isolated-2b.ts
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

function hashFile(p: string): string {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').substring(0, 16) }
  catch { return 'ERROR' }
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

function inspectSATargets(targets: any[]) {
  const saTargets = targets.filter((t: any) =>
    t.url?.includes(SA_CWS_ID) ||
    String(t.title || '').includes('SuperAssistant') ||
    String(t.title || '').includes('MCP SuperAssistant') ||
    t.url?.includes('mcpsuperassistant')
  )
  return { saTargets, saSW: saTargets.filter((t: any) => t.type === 'service_worker') }
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

// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═══════════════════════════════════════════════════════════')
  console.log('  SA ISOLATED TESTS — Phase 2b (no puppeteer pipe needed)')
  console.log('═══════════════════════════════════════════════════════════')

  await killTestPort()

  // ═══════════════════════════════════════════════════════════════════════
  // TEST E: Extensions.loadUnpacked on FINAL Chrome via CDP WebSocket
  // ═══════════════════════════════════════════════════════════════════════

  log('TEST E', '═══ Extensions.loadUnpacked on running Chrome via CDP WebSocket ═══')
  log('TEST E', 'This does NOT use puppeteer. It launches Chrome normally, then')
  log('TEST E', 'connects via WebSocket CDP to call Extensions.loadUnpacked.')
  {
    const relay = freshRelay('iso-e-cdp')
    ev('Step 1', 'Launch Chrome with debug port (clean profile, no sync)')
    const started = await launchChrome(relay, 'about:blank')
    ev('Chrome started', started)

    if (started) {
      await sleep(3000)
      ev('Step 2', 'Connect via CDP WebSocket')

      const { WebSocket } = await import('ws')
      try {
        const ver = await fetch(`http://127.0.0.1:${TEST_PORT}/json/version`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()) as any
        ev('webSocketDebuggerUrl', ver?.webSocketDebuggerUrl ? 'OBTAINED' : 'MISSING')

        if (ver?.webSocketDebuggerUrl) {
          const ws = new WebSocket(ver.webSocketDebuggerUrl)
          await new Promise<void>((resolve, reject) => {
            ws.on('open', resolve)
            ws.on('error', reject)
            setTimeout(() => reject(new Error('WS connect timeout')), 10000)
          })
          ev('WebSocket', 'CONNECTED')

          let msgId = 1
          const send = (method: string, params: any = {}): Promise<any> => {
            return new Promise((resolve, reject) => {
              const id = msgId++
              const timeout = setTimeout(() => reject(new Error(`${method} timeout (15s)`)), 15000)
              const handler = (data: any) => {
                try {
                  const msg = JSON.parse(data.toString())
                  if (msg.id === id) {
                    ws.off('message', handler)
                    clearTimeout(timeout)
                    if (msg.error) reject(new Error(`${msg.error.message} (code ${msg.error.code})`))
                    else resolve(msg.result)
                  }
                } catch {}
              }
              ws.on('message', handler)
              ws.send(JSON.stringify({ id, method, params }))
            })
          }

          ev('Step 3', `Extensions.loadUnpacked(${LOCAL_SA})`)
          try {
            const loadResult = await send('Extensions.loadUnpacked', { path: LOCAL_SA })
            ev('loadUnpacked SUCCESS', `Extension ID: ${loadResult?.id}`)

            // Wait for SW to start
            await sleep(3000)

            // Check targets
            ev('Step 4', 'Inspect targets after loadUnpacked')
            const targets = await fetchTargets(TEST_PORT)
            const allSW = targets.filter((t: any) => t.type === 'service_worker')
            const { saTargets, saSW } = inspectSATargets(targets)
            ev('Total targets', targets.length)
            ev('Total SW', allSW.length)
            ev('SA targets', saTargets.length)
            ev('SA SW active', saSW.length)

            for (const t of allSW) {
              const isSA = saTargets.includes(t)
              const idMatch = t.url?.match(/chrome-extension:\/\/([a-z]+)\//)
              ev(`  SW ${isSA ? '★SA★' : '    '}`, `id=${idMatch?.[1]} url=${t.url}`)
            }

            for (const t of saSW) {
              const idMatch = t.url?.match(/chrome-extension:\/\/([a-z]+)\//)
              ev('SA SW extension ID', idMatch?.[1])
              ev('Matches CWS ID?', idMatch?.[1] === SA_CWS_ID ? 'YES' : 'NO (local/dynamic)')
              ev('SA SW title', t.title)
            }

            // Try Extensions.getAll if available
            try {
              const allExt = await send('Extensions.getAll', {})
              if (allExt?.extensions) {
                ev('Step 5', 'Extensions.getAll results')
                for (const ext of allExt.extensions) {
                  ev(`  ext`, `id=${ext.id} name="${ext.name}" enabled=${ext.enabled} version=${ext.version}`)
                }
              }
            } catch (e: any) {
              ev('Extensions.getAll', `Not available: ${e.message}`)
            }

            // Check: did loadUnpacked persist in Extensions/ dir?
            ev('Step 6', 'Check if SA persisted in relay Extensions/')
            const extDir = path.join(relay, 'Default', 'Extensions')
            if (fs.existsSync(extDir)) {
              const exts = fs.readdirSync(extDir, { withFileTypes: true }).filter(d => d.isDirectory())
              ev('Extensions in relay', exts.map(e => e.name).join(', ') || 'NONE')
              for (const ext of exts) {
                const versions = fs.readdirSync(path.join(extDir, ext.name), { withFileTypes: true }).filter(d => d.isDirectory())
                for (const ver of versions) {
                  const mp = path.join(extDir, ext.name, ver.name, 'manifest.json')
                  if (fs.existsSync(mp)) {
                    try {
                      const m = JSON.parse(fs.readFileSync(mp, 'utf-8'))
                      ev(`  ${ext.name}/${ver.name}`, `"${m.name}" v${m.version}`)
                    } catch {}
                  }
                }
              }
            } else {
              ev('Extensions dir', 'NOT FOUND (expected for unpacked loaded via CDP)')
            }

          } catch (e: any) {
            ev('loadUnpacked FAILED', e.message)
            ev('NOTE', 'Extensions.loadUnpacked may require --remote-debugging-pipe transport')
            ev('NOTE', 'Chrome may only allow this over pipe, not over port/WebSocket')
          }

          ws.close()
        }
      } catch (e: any) {
        ev('CDP connection error', e.message)
      }
    } else {
      ev('Chrome failed to start', 'CANNOT run test')
    }
    await killTestPort()
    await sleep(2000)
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
    ev('CWS versions found', cwsVersions.join(', ') || 'NONE')

    if (cwsLatest && fs.existsSync(LOCAL_SA)) {
      const localManifest = JSON.parse(fs.readFileSync(path.join(LOCAL_SA, 'manifest.json'), 'utf-8'))
      const cwsManifest = JSON.parse(fs.readFileSync(path.join(cwsLatest, 'manifest.json'), 'utf-8'))

      log('MANIFEST', '')
      for (const f of ['name', 'version', 'manifest_version', 'description']) {
        const l = (localManifest as any)[f], c = (cwsManifest as any)[f]
        ev(`  ${f}`, `local="${l}" | cws="${c}" | ${l === c ? '✅ MATCH' : '❌ DIFFER'}`)
      }
      ev('  background.service_worker', `local="${localManifest.background?.service_worker}" | cws="${cwsManifest.background?.service_worker}" | ${localManifest.background?.service_worker === cwsManifest.background?.service_worker ? '✅' : '❌'}`)
      ev('  key (CWS signing)', `local=${localManifest.key ? 'HAS KEY' : 'NO KEY'} | cws=${cwsManifest.key ? 'HAS KEY' : 'NO KEY'}`)
      ev('  update_url', `local=${localManifest.update_url ?? 'NONE'} | cws=${cwsManifest.update_url ?? 'NONE'}`)

      // Deep comparison: permissions
      const lPerms = JSON.stringify(localManifest.permissions?.sort() ?? [])
      const cPerms = JSON.stringify(cwsManifest.permissions?.sort() ?? [])
      ev('  permissions', lPerms === cPerms ? '✅ MATCH' : `❌ DIFFER\n    local: ${lPerms}\n    cws:   ${cPerms}`)

      // File-level comparison
      log('FILES', '')
      const localFiles = new Map<string, string>()
      const cwsFiles = new Map<string, string>()
      const scanDir = (dir: string, rel: string, map: Map<string, string>) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = rel ? `${rel}/${e.name}` : e.name
          if (e.isDirectory()) {
            if (e.name !== '_metadata' && e.name !== 'node_modules') scanDir(path.join(dir, e.name), p, map)
          } else {
            map.set(p, hashFile(path.join(dir, e.name)))
          }
        }
      }
      scanDir(LOCAL_SA, '', localFiles)
      scanDir(cwsLatest, '', cwsFiles)

      ev('Local file count', localFiles.size)
      ev('CWS file count', cwsFiles.size)

      const onlyLocal = [...localFiles.keys()].filter(f => !cwsFiles.has(f))
      const onlyCWS = [...cwsFiles.keys()].filter(f => !localFiles.has(f))
      const common = [...localFiles.keys()].filter(f => cwsFiles.has(f))
      let matching = 0, differing = 0
      const differingFiles: string[] = []
      for (const f of common) {
        if (localFiles.get(f) === cwsFiles.get(f)) matching++
        else { differing++; differingFiles.push(f) }
      }

      ev('Common files', common.length)
      ev('  Identical hash', matching)
      ev('  Different hash', differing)
      if (onlyLocal.length > 0) ev('Only in local', onlyLocal.slice(0, 15).join(', ') + (onlyLocal.length > 15 ? ` +${onlyLocal.length - 15} more` : ''))
      if (onlyCWS.length > 0) ev('Only in CWS', onlyCWS.slice(0, 15).join(', ') + (onlyCWS.length > 15 ? ` +${onlyCWS.length - 15} more` : ''))
      if (differingFiles.length > 0) ev('Differing files', differingFiles.slice(0, 15).join(', '))

      log('SA IDENTITY SUMMARY', '')
      ev('Same manifest name', localManifest.name === cwsManifest.name)
      ev('Same manifest version', localManifest.version === cwsManifest.version)
      ev('Same artifact (all files identical)', differing === 0 && onlyLocal.length === 0 && onlyCWS.length === 0)
      ev('CWS extension ID', `${SA_CWS_ID} (fixed, derived from CWS signing key)`)
      ev('Local extension ID', 'DYNAMIC (assigned by Chrome at loadUnpacked time, derived from path)')
      ev('CWS has signing key', cwsManifest.key ? `YES: ${cwsManifest.key.substring(0, 40)}...` : 'NO')
      ev('CWS has update_url', cwsManifest.update_url ?? 'NO')

      // Verifiable identity
      log('VERIFIABLE IDENTITY', '')
      ev('What uniquely identifies SA CWS', `Extension ID ${SA_CWS_ID} (derived from key in manifest)`)
      ev('What uniquely identifies SA local', 'manifest.name="MCP SuperAssistant" + no key + no update_url')
      ev('What distinguishes from OTHER extension', 'manifest.name must contain "SuperAssistant" or "MCP SuperAssistant"')
      ev('Can we verify version match?', 'YES via manifest.version comparison')
      ev('Can we verify build match?', differing === 0 ? 'YES (hashes match, same build)' : `NO (${differing} files differ — may be different builds of same version)`)
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TEST 8: syncProfileToRelay audit
  // ═══════════════════════════════════════════════════════════════════════

  log('TEST 8', '═══ syncProfileToRelay audit ═══')
  {
    const relay = freshRelay('iso-sync-audit')
    const src = path.join(CHROME_USER_DATA, 'Default')
    const dst = path.join(relay, 'Default')
    fs.mkdirSync(dst, { recursive: true })

    let totalOk = 0; const totalFail: string[] = []

    // Profile files
    for (const f of ['Preferences', 'Secure Preferences', 'Login Data', 'Web Data']) {
      try {
        const s = path.join(src, f)
        if (fs.existsSync(s)) { fs.copyFileSync(s, path.join(dst, f)); totalOk++; ev(`${f}`, 'COPIED') }
        else ev(`${f}`, 'NOT FOUND in source')
      } catch (e: any) { totalFail.push(`${f}: ${e.code}`); ev(`${f}`, `FAILED: ${e.code}`) }
    }

    // Local State
    try {
      const ls = path.join(CHROME_USER_DATA, 'Local State')
      if (fs.existsSync(ls)) { fs.copyFileSync(ls, path.join(relay, 'Local State')); totalOk++; ev('Local State', 'COPIED') }
    } catch (e: any) { totalFail.push(`Local State: ${e.code}`); ev('Local State', `FAILED: ${e.code}`) }

    // Cookies
    try {
      const ck = path.join(src, 'Cookies')
      if (fs.existsSync(ck)) { fs.copyFileSync(ck, path.join(dst, 'Cookies')); totalOk++; ev('Cookies', 'COPIED') }
      else ev('Cookies', 'NOT FOUND')
    } catch (e: any) { totalFail.push(`Cookies: ${e.code}`); ev('Cookies', `FAILED: ${e.code} — file likely locked by running Chrome`) }

    // Network/Cookies
    try {
      const nc = path.join(src, 'Network', 'Cookies')
      if (fs.existsSync(nc)) {
        fs.mkdirSync(path.join(dst, 'Network'), { recursive: true })
        fs.copyFileSync(nc, path.join(dst, 'Network', 'Cookies')); totalOk++; ev('Network/Cookies', 'COPIED')
      }
    } catch (e: any) { totalFail.push(`Network/Cookies: ${e.code}`); ev('Network/Cookies', `FAILED: ${e.code}`) }

    // Extensions
    const srcExt = path.join(src, 'Extensions')
    if (fs.existsSync(srcExt)) {
      const dstExt = path.join(dst, 'Extensions')
      if (fs.existsSync(dstExt)) fs.rmSync(dstExt, { recursive: true, force: true })
      const r = copyDirCounted(srcExt, dstExt)
      totalOk += r.ok; totalFail.push(...r.fail)
      ev('Extensions copied', r.ok)
      ev('Extensions FAILED', r.fail.length)
      if (r.fail.length > 0) {
        for (const f of r.fail.slice(0, 20)) ev('  FAIL', f)
      }
    }

    log('SYNC AUDIT SUMMARY', '')
    ev('Total files copied', totalOk)
    ev('Total files FAILED', totalFail.length)
    ev('Failure rate', totalFail.length > 0 ? `${((totalFail.length / (totalOk + totalFail.length)) * 100).toFixed(1)}%` : '0%')

    // Check coherence
    const hasExt = fs.existsSync(path.join(dst, 'Extensions'))
    const hasSP = fs.existsSync(path.join(dst, 'Secure Preferences'))
    const hasP = fs.existsSync(path.join(dst, 'Preferences'))
    ev('Extensions/ present', hasExt)
    ev('Secure Preferences present', hasSP)
    ev('Preferences present', hasP)
    ev('Coherent state', hasExt && hasSP && hasP ? 'YES' : 'POTENTIALLY INCOHERENT')

    // Can partial failure leave incoherent state?
    ev('Risk', totalFail.length > 0
      ? 'YES — Extensions may have copied partially. Secure Preferences references extensions that may be missing.'
      : 'LOW — all files copied successfully. Incoherence only if Chrome modifies files between reads.'
    )

    // Cleanup
    try { fs.rmSync(relay, { recursive: true, force: true }) } catch {}
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FINAL SUMMARY
  // ═══════════════════════════════════════════════════════════════════════

  console.log('\n═══════════════════════════════════════════════════════════')
  console.log('  ALL ISOLATED EXPERIMENTS — FINAL RESULTS')
  console.log('═══════════════════════════════════════════════════════════\n')

  console.log('| Test | Variable | Result |')
  console.log('|------|----------|--------|')
  console.log('| B-solo | pipe sin otro Chrome test (user Chrome running) | ❌ FAILED: ProcessSingleton conflict |')
  console.log('| C-solo | profile limpio (user Chrome running) | ❌ FAILED: ProcessSingleton conflict |')
  console.log('| E | Extensions.loadUnpacked sobre Chrome final (CDP WS) | (see above) |')
  console.log('')
  console.log('CONFIRMED: loadUnpackedViaPipe() CANNOT work when user Chrome is running.')
  console.log('This is a fundamental limitation of puppeteer pipe transport + Chrome ProcessSingleton.')
  console.log('')

  console.log('Done.')
}

main().catch(async (err) => {
  console.error('\nFATAL:', err)
  await killTestPort()
  process.exit(1)
})
