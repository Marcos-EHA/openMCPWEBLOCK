#!/usr/bin/env bun
/**
 * SA Launcher Gate B — Empirical investigation of 4 scenarios.
 *
 * Run: bun run scripts/sa-gate-b.ts
 *
 * Tests each scenario with a REAL Chrome launch, inspecting the full chain:
 *   prepareSAExtension → syncProfile → detectSA → loadUnpacked → Chrome → SW
 *
 * Uses ports 9230-9234 to avoid conflicts with user Chrome or other tests.
 * Each scenario gets its own relay dir. Cleanup kills only by port PID.
 */

import path from 'path'
import fs from 'fs'
import { execSync } from 'child_process'

// ─── Config ──────────────────────────────────────────────────────────────────

const LOCALAPPDATA = process.env.LOCALAPPDATA ?? ''
const CHROME_USER_DATA = path.join(LOCALAPPDATA, 'Google', 'Chrome', 'User Data')
const RELAY_ROOT = path.join(LOCALAPPDATA, 'openMCPWEBLOCK', 'chrome-agents')
const SA_CWS_ID = 'kngiafgkdnlkgmefdafaibkibegkcaef'

const BASE_PORT = 9230
const SCENARIOS = ['A', 'B', 'C', 'D'] as const

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(section: string, ...args: any[]) {
  console.log(`\n[${section}]`, ...args)
}
function evidence(label: string, value: any) {
  const str = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)
  console.log(`  ${label}: ${str}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function findPidOnPort(port: number): Promise<number | null> {
  try {
    const out = execSync(
      `netstat -ano | findstr ":${port}" | findstr LISTENING`,
      { encoding: 'utf8', timeout: 5000 },
    ).trim()
    for (const line of out.split('\n').filter(Boolean)) {
      const parts = line.trim().split(/\s+/)
      const addr = parts[1] ?? ''
      if (!addr.endsWith(`:${port}`)) continue
      const pid = parseInt(parts[parts.length - 1]!, 10)
      if (pid > 0) return pid
    }
    return null
  } catch { return null }
}

async function killPort(port: number): Promise<void> {
  const pid = await findPidOnPort(port)
  if (!pid) return
  try {
    // Verify it's chrome.exe before killing
    const check = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8', timeout: 5000 })
    if (!check.toLowerCase().includes('chrome.exe')) {
      console.warn(`  ⚠ PID ${pid} on port ${port} is NOT chrome.exe — skipping kill`)
      return
    }
    execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore', timeout: 10000 })
  } catch {}
  // Wait for port to free
  for (let i = 0; i < 10; i++) {
    if (!(await findPidOnPort(port))) return
    await sleep(500)
  }
}

async function fetchTargets(port: number): Promise<any[]> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(3000) })
    return await resp.json() as any[]
  } catch { return [] }
}

async function isPortActive(port: number): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) })
    return resp.ok
  } catch { return false }
}

function copyDirRecursive(src: string, dst: string): { copied: number; failed: string[] } {
  fs.mkdirSync(dst, { recursive: true })
  let copied = 0
  const failed: string[] = []
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name)
    const dstPath = path.join(dst, entry.name)
    if (entry.isDirectory()) {
      const sub = copyDirRecursive(srcPath, dstPath)
      copied += sub.copied
      failed.push(...sub.failed)
    } else {
      try {
        fs.copyFileSync(srcPath, dstPath)
        copied++
      } catch (e: any) {
        failed.push(`${srcPath}: ${e.code || e.message}`)
      }
    }
  }
  return { copied, failed }
}

// ─── Detect SA in a profile's Extensions/ ────────────────────────────────────

interface SADetection {
  found: boolean
  extensionId: string | null
  version: string | null
  manifestName: string | null
  manifestVersion: string | null
  sourcePath: string | null
  hasBackgroundSW: boolean
}

function detectSADetailed(profilePath: string): SADetection {
  const result: SADetection = {
    found: false, extensionId: null, version: null,
    manifestName: null, manifestVersion: null, sourcePath: null,
    hasBackgroundSW: false,
  }
  const extDir = path.join(profilePath, 'Extensions')
  if (!fs.existsSync(extDir)) return result
  try {
    for (const ext of fs.readdirSync(extDir, { withFileTypes: true })) {
      if (!ext.isDirectory()) continue
      const extPath = path.join(extDir, ext.name)
      for (const ver of fs.readdirSync(extPath, { withFileTypes: true })) {
        if (!ver.isDirectory()) continue
        const mp = path.join(extPath, ver.name, 'manifest.json')
        if (!fs.existsSync(mp)) continue
        try {
          const content = fs.readFileSync(mp, 'utf-8')
          const manifest = JSON.parse(content)
          if (content.includes('MCP') || content.includes('SuperAssistant') || content.includes('mcp-superassistant')) {
            result.found = true
            result.extensionId = ext.name
            result.version = ver.name
            result.manifestName = manifest.name
            result.manifestVersion = manifest.version
            result.sourcePath = path.join(extPath, ver.name)
            result.hasBackgroundSW = manifest.background?.service_worker === 'background.js'
            return result
          }
        } catch {}
      }
    }
  } catch {}
  return result
}

// ─── Check Secure Preferences extension state ────────────────────────────────

interface SecPrefExtState {
  present: boolean
  state?: number
  path?: string
  wasInstalledByDefault?: boolean
  disableReasons?: number
  fromWebstore?: boolean
  location?: number
}

function checkSecurePrefsExtension(profilePath: string, extId: string): SecPrefExtState {
  const spPath = path.join(profilePath, 'Secure Preferences')
  if (!fs.existsSync(spPath)) return { present: false }
  try {
    const sp = JSON.parse(fs.readFileSync(spPath, 'utf-8'))
    const settings = sp?.extensions?.settings?.[extId]
    if (!settings) return { present: false }
    return {
      present: true,
      state: settings.state,
      path: settings.path,
      wasInstalledByDefault: settings.was_installed_by_default,
      disableReasons: settings.disable_reasons,
      fromWebstore: settings.from_webstore,
      location: settings.location,
    }
  } catch {
    return { present: false }
  }
}

// ─── Check MAC hash validity indicator ───────────────────────────────────────

function checkMACPresence(profilePath: string): {
  hasProtectionMAC: boolean
  extensionsMAC: boolean
  superMAC: boolean
} {
  const spPath = path.join(profilePath, 'Secure Preferences')
  if (!fs.existsSync(spPath)) return { hasProtectionMAC: false, extensionsMAC: false, superMAC: false }
  try {
    const sp = JSON.parse(fs.readFileSync(spPath, 'utf-8'))
    return {
      hasProtectionMAC: !!sp?.protection?.macs,
      extensionsMAC: !!sp?.protection?.macs?.extensions?.settings,
      superMAC: !!sp?.protection?.super_mac,
    }
  } catch {
    return { hasProtectionMAC: false, extensionsMAC: false, superMAC: false }
  }
}

// ─── Find Chrome ─────────────────────────────────────────────────────────────

function findChrome(): string {
  const candidates = [
    path.join(process.env.PROGRAMFILES ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c
  }
  throw new Error('Chrome not found')
}

// ─── Find SA source (same logic as ChromeCDP.findSASourcePath) ───────────────

function findSASource(): string | null {
  const envPath = process.env.OPENMCP_SA_PATH
  if (envPath && fs.existsSync(path.join(envPath, 'manifest.json'))) return envPath
  const candidates = [
    path.join(process.cwd(), 'chrome-extension', 'source', 'dist'),
    path.join(process.cwd(), 'chrome-extension', 'dist'),
    path.join(process.cwd(), '..', 'MCP-SuperAssistant', 'dist'),
  ]
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'manifest.json'))) return c
  }
  return null
}

// ─── Launch Chrome and wait for debug port ───────────────────────────────────

function clearSingletonLocks(dir: string): void {
  for (const name of ['SingletonLock', 'SingletonCookie', 'lockfile']) {
    for (const base of [dir, path.join(dir, 'Default')]) {
      try { fs.rmSync(path.join(base, name), { force: true, recursive: true }) } catch {}
    }
  }
}

async function launchChromeForTest(
  relayDir: string,
  debugPort: number,
  url: string = 'about:blank',
): Promise<boolean> {
  const chromePath = findChrome()

  // Clear singleton locks (puppeteer pipe install may have left stale ones)
  clearSingletonLocks(relayDir)

  const args = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${relayDir}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    url,
  ]

  // Launch detached (same as ChromeCDP)
  const { spawn } = await import('child_process')
  const proc = spawn(chromePath, args, { detached: true, stdio: 'ignore', shell: false })
  proc.unref()

  // Wait for debug port
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    if (await isPortActive(debugPort)) return true
    await sleep(1000)
  }
  return false
}

// ─── Run loadUnpackedViaPipe (same as ChromeCDP) ─────────────────────────────

async function tryLoadUnpackedViaPipe(
  relayDir: string,
  saDir: string,
): Promise<{ success: boolean; extensionId: string | null; error?: string }> {
  let puppeteer: any
  try {
    puppeteer = await import('puppeteer-core')
    if (puppeteer.default) puppeteer = puppeteer.default
  } catch (e: any) {
    return { success: false, extensionId: null, error: `puppeteer-core not available: ${e.message}` }
  }

  const chromePath = findChrome()
  let browser: any = null

  // Clear any stale locks from previous pipe installs
  clearSingletonLocks(relayDir)

  try {
    browser = await puppeteer.launch({
      executablePath: chromePath,
      pipe: true,
      userDataDir: relayDir,
      args: [
        '--enable-unsafe-extension-debugging',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
      ],
      headless: false,
      timeout: 40000,
    })

    const cdp = await browser.target().createCDPSession()
    const res = await cdp.send('Extensions.loadUnpacked', { path: saDir })
    return { success: true, extensionId: res?.id ?? null }
  } catch (e: any) {
    return { success: false, extensionId: null, error: e.message }
  } finally {
    const pid = browser?.process()?.pid
    try {
      if (browser) await Promise.race([browser.close(), sleep(4000)])
    } catch {}
    if (pid) {
      try { execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore' }) } catch {}
    }
    await sleep(1500)
    // Clear locks left by the temporary Chrome
    clearSingletonLocks(relayDir)
  }
}

// ─── Inspect Chrome's extension state via CDP ────────────────────────────────

async function inspectExtensions(debugPort: number): Promise<{
  allSWTargets: any[]
  saTargets: any[]
  saSWTargets: any[]
  totalTargets: number
}> {
  const targets = await fetchTargets(debugPort)
  const allSWTargets = targets.filter(t => t.type === 'service_worker')
  const saTargets = targets.filter(t =>
    t.url?.includes(SA_CWS_ID) ||
    String(t.title || '').includes('SuperAssistant') ||
    String(t.title || '').includes('MCP SuperAssistant') ||
    t.url?.includes('mcpsuperassistant')
  )
  const saSWTargets = saTargets.filter(t => t.type === 'service_worker')
  return { allSWTargets, saTargets, saSWTargets, totalTargets: targets.length }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIOS
// ═══════════════════════════════════════════════════════════════════════════════

interface ScenarioResult {
  scenario: string
  description: string
  saSource: string | null
  profileSynced: boolean
  syncDetails: { copied: number; failed: string[] } | null
  detectSABeforePipe: SADetection
  loadUnpackedRan: boolean
  loadUnpackedResult: { success: boolean; extensionId: string | null; error?: string } | null
  detectSAAfterPipe: SADetection
  chromeStarted: boolean
  secPrefState: SecPrefExtState | null
  macPresence: { hasProtectionMAC: boolean; extensionsMAC: boolean; superMAC: boolean } | null
  extensionInChrome: { saTargets: any[]; saSWTargets: any[]; allSWTargets: any[] } | null
  conclusion: string
}

const results: ScenarioResult[] = []

async function runScenario(
  label: string,
  description: string,
  port: number,
  setup: (relayDir: string) => void | Promise<void>,
): Promise<ScenarioResult> {
  const relayDir = path.join(RELAY_ROOT, `gate-b-${label.toLowerCase()}`)
  log(`SCENARIO ${label}`, description)
  evidence('Relay dir', relayDir)
  evidence('Debug port', port)

  // Ensure clean relay dir
  try { if (fs.existsSync(relayDir)) fs.rmSync(relayDir, { recursive: true, force: true }) } catch {}
  fs.mkdirSync(path.join(relayDir, 'Default'), { recursive: true })

  const result: ScenarioResult = {
    scenario: label,
    description,
    saSource: null,
    profileSynced: false,
    syncDetails: null,
    detectSABeforePipe: { found: false, extensionId: null, version: null, manifestName: null, manifestVersion: null, sourcePath: null, hasBackgroundSW: false },
    loadUnpackedRan: false,
    loadUnpackedResult: null,
    detectSAAfterPipe: { found: false, extensionId: null, version: null, manifestName: null, manifestVersion: null, sourcePath: null, hasBackgroundSW: false },
    chromeStarted: false,
    secPrefState: null,
    macPresence: null,
    extensionInChrome: null,
    conclusion: '',
  }

  try {
    // Step 1: Find SA source
    result.saSource = findSASource()
    evidence('SA source', result.saSource)

    // Step 2: Setup (profile sync or clean)
    await setup(relayDir)

    // Step 3: detectSAInProfile BEFORE pipe
    result.detectSABeforePipe = detectSADetailed(path.join(relayDir, 'Default'))
    log(`${label} DETECT BEFORE PIPE`, '')
    evidence('SA found', result.detectSABeforePipe.found)
    if (result.detectSABeforePipe.found) {
      evidence('Extension ID', result.detectSABeforePipe.extensionId)
      evidence('Manifest name', result.detectSABeforePipe.manifestName)
      evidence('Version', result.detectSABeforePipe.manifestVersion)
      evidence('Has background SW', result.detectSABeforePipe.hasBackgroundSW)
    }

    // Step 4: Check Secure Preferences before launch
    if (result.detectSABeforePipe.extensionId) {
      result.secPrefState = checkSecurePrefsExtension(
        path.join(relayDir, 'Default'),
        result.detectSABeforePipe.extensionId,
      )
      result.macPresence = checkMACPresence(path.join(relayDir, 'Default'))
      log(`${label} SECURE PREFS`, '')
      evidence('SA in Secure Prefs', result.secPrefState.present)
      if (result.secPrefState.present) {
        evidence('state', result.secPrefState.state)
        evidence('path', result.secPrefState.path)
        evidence('from_webstore', result.secPrefState.fromWebstore)
        evidence('location', result.secPrefState.location)
        evidence('disable_reasons', result.secPrefState.disableReasons)
      }
      evidence('Has protection MAC', result.macPresence.hasProtectionMAC)
      evidence('Extensions MAC', result.macPresence.extensionsMAC)
      evidence('Super MAC', result.macPresence.superMAC)
    }

    // Step 5: loadUnpackedViaPipe if SA not detected
    if (!result.detectSABeforePipe.found && result.saSource) {
      log(`${label} PIPE INSTALL`, 'SA not in relay — running loadUnpackedViaPipe...')
      result.loadUnpackedRan = true
      result.loadUnpackedResult = await tryLoadUnpackedViaPipe(relayDir, result.saSource)
      evidence('Pipe result', result.loadUnpackedResult.success ? 'SUCCESS' : 'FAILED')
      evidence('Extension ID from pipe', result.loadUnpackedResult.extensionId)
      if (result.loadUnpackedResult.error) {
        evidence('Error', result.loadUnpackedResult.error)
      }

      // Re-detect after pipe
      result.detectSAAfterPipe = detectSADetailed(path.join(relayDir, 'Default'))
      log(`${label} DETECT AFTER PIPE`, '')
      evidence('SA found', result.detectSAAfterPipe.found)
      if (result.detectSAAfterPipe.found) {
        evidence('Extension ID', result.detectSAAfterPipe.extensionId)
        evidence('Manifest name', result.detectSAAfterPipe.manifestName)
        evidence('Version', result.detectSAAfterPipe.manifestVersion)
        evidence('Source path', result.detectSAAfterPipe.sourcePath)
      }
    } else if (result.detectSABeforePipe.found) {
      log(`${label} PIPE INSTALL`, 'SKIPPED — detectSAInProfile returned true')
      result.loadUnpackedRan = false
    } else {
      log(`${label} PIPE INSTALL`, 'SKIPPED — no SA source available')
    }

    // Step 6: Launch Chrome
    log(`${label} CHROME LAUNCH`, `Launching on port ${port}...`)
    result.chromeStarted = await launchChromeForTest(relayDir, port, 'https://chatgpt.com')
    evidence('Chrome started', result.chromeStarted)

    if (result.chromeStarted) {
      // Wait for extensions to settle
      await sleep(5000)

      // Step 7: Inspect what Chrome actually has
      const inspection = await inspectExtensions(port)
      result.extensionInChrome = inspection
      log(`${label} CHROME TARGETS`, '')
      evidence('Total targets', inspection.totalTargets)
      evidence('Total SW targets', inspection.allSWTargets.length)
      evidence('SA targets found', inspection.saTargets.length)
      evidence('SA SW targets found', inspection.saSWTargets.length)

      for (const t of inspection.allSWTargets) {
        const isSA = inspection.saTargets.includes(t)
        evidence(`  SW ${isSA ? '★SA★' : '    '}`, `${t.url} — "${t.title}"`)
      }

      if (inspection.saTargets.length > 0) {
        for (const t of inspection.saTargets) {
          // Extract extension ID from URL
          const idMatch = t.url?.match(/chrome-extension:\/\/([a-z]+)\//)
          evidence('SA target type', t.type)
          evidence('SA target URL', t.url)
          evidence('SA target title', t.title)
          evidence('SA extension ID in Chrome', idMatch?.[1] ?? 'UNKNOWN')
          evidence('Matches CWS ID?', idMatch?.[1] === SA_CWS_ID ? 'YES' : 'NO (dynamic/local)')
        }
      }

      // Step 8: Check Secure Preferences AFTER Chrome launch
      // Chrome may have modified them (disabled extensions, updated MAC)
      const postLaunchSP = path.join(relayDir, 'Default', 'Secure Preferences')
      if (fs.existsSync(postLaunchSP)) {
        try {
          const sp = JSON.parse(fs.readFileSync(postLaunchSP, 'utf-8'))
          const extSettings = sp?.extensions?.settings ?? {}
          // Find ALL SA-like entries
          for (const [id, settings] of Object.entries(extSettings)) {
            const s = settings as any
            const name = s.manifest?.name ?? ''
            if (name.includes('MCP') || name.includes('SuperAssistant')) {
              log(`${label} POST-LAUNCH SECURE PREFS`, `Extension ${id}`)
              evidence('Name', name)
              evidence('State', s.state)
              evidence('Disable reasons', s.disable_reasons)
              evidence('From webstore', s.from_webstore)
              evidence('Location', s.location)
              evidence('Path', s.path)
            }
          }
        } catch {}
      }

      // Determine conclusion
      if (inspection.saSWTargets.length > 0) {
        const swUrl = inspection.saSWTargets[0].url ?? ''
        const isCWS = swUrl.includes(SA_CWS_ID)
        result.conclusion = isCWS
          ? 'SA CWS SW ACTIVE — extension from Chrome Web Store is operational'
          : 'SA LOCAL SW ACTIVE — extension from local build/pipe install is operational'
      } else if (inspection.saTargets.length > 0) {
        result.conclusion = 'SA PRESENT BUT SW NOT ACTIVE — extension loaded but service worker did not start'
      } else {
        result.conclusion = 'SA NOT PRESENT — no SA targets found in Chrome'
      }
    } else {
      result.conclusion = 'CHROME FAILED TO START'
    }

    evidence('CONCLUSION', result.conclusion)
  } catch (e: any) {
    result.conclusion = `ERROR: ${e.message}`
    evidence('ERROR', e.message)
  } finally {
    // Cleanup: kill Chrome on this port
    await killPort(port)
    await sleep(1000)
  }

  return result
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════')
  console.log('  SA LAUNCHER GATE B — Empirical Investigation')
  console.log('═══════════════════════════════════════════════════════════')

  // Kill any leftover Chrome on our test ports
  for (let p = BASE_PORT; p < BASE_PORT + 5; p++) {
    await killPort(p)
  }

  // ─── Scenario A: Profile with SA CWS ──────────────────────────────
  const resultA = await runScenario('A', 'Profile with SA CWS (Default)', BASE_PORT, (relayDir) => {
    // Sync Default profile (which has SA CWS installed)
    const srcProfile = path.join(CHROME_USER_DATA, 'Default')
    const dstProfile = path.join(relayDir, 'Default')

    // Sync profile files (same as syncProfileToRelay)
    for (const file of ['Preferences', 'Secure Preferences', 'Login Data', 'Web Data']) {
      try {
        const src = path.join(srcProfile, file)
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dstProfile, file))
      } catch (e: any) { evidence(`  Sync ${file}`, `FAILED: ${e.code}`) }
    }
    // Sync Local State
    try {
      const src = path.join(CHROME_USER_DATA, 'Local State')
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(relayDir, 'Local State'))
    } catch {}

    // Sync Extensions/ with detailed logging
    const srcExt = path.join(srcProfile, 'Extensions')
    const dstExt = path.join(dstProfile, 'Extensions')
    if (fs.existsSync(srcExt)) {
      const details = copyDirRecursive(srcExt, dstExt)
      evidence('Extensions sync copied', details.copied)
      if (details.failed.length > 0) {
        evidence('Extensions sync FAILURES', details.failed.length)
        for (const f of details.failed.slice(0, 10)) {
          evidence('  Failed', f)
        }
      }
    }
  })
  results.push(resultA)

  // ─── Scenario B: Profile WITHOUT SA ────────────────────────────────
  const resultB = await runScenario('B', 'Profile without SA (Default minus SA ext)', BASE_PORT + 1, (relayDir) => {
    const srcProfile = path.join(CHROME_USER_DATA, 'Default')
    const dstProfile = path.join(relayDir, 'Default')

    // Sync profile files
    for (const file of ['Preferences', 'Secure Preferences', 'Login Data', 'Web Data']) {
      try {
        const src = path.join(srcProfile, file)
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dstProfile, file))
      } catch {}
    }
    try {
      const src = path.join(CHROME_USER_DATA, 'Local State')
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(relayDir, 'Local State'))
    } catch {}

    // Sync Extensions/ but SKIP SA
    const srcExt = path.join(srcProfile, 'Extensions')
    const dstExt = path.join(dstProfile, 'Extensions')
    if (fs.existsSync(srcExt)) {
      fs.mkdirSync(dstExt, { recursive: true })
      for (const ext of fs.readdirSync(srcExt, { withFileTypes: true })) {
        if (!ext.isDirectory()) continue
        if (ext.name === SA_CWS_ID) {
          evidence('  Skipped SA CWS extension', ext.name)
          continue
        }
        copyDirRecursive(path.join(srcExt, ext.name), path.join(dstExt, ext.name))
      }
    }
  })
  results.push(resultB)

  // ─── Scenario C: Clean/guest profile ───────────────────────────────
  const resultC = await runScenario('C', 'Clean profile (no sync, empty relay)', BASE_PORT + 2, (_relayDir) => {
    // Nothing to set up — relay dir was already created with just Default/
    evidence('Profile sync', 'NONE (clean relay)')
  })
  results.push(resultC)

  // ─── Scenario D: Profile with different SA ─────────────────────────
  // We simulate this by copying the CWS SA but modifying the manifest
  const resultD = await runScenario('D', 'Profile with modified SA (simulated different version)', BASE_PORT + 3, (relayDir) => {
    const srcProfile = path.join(CHROME_USER_DATA, 'Default')
    const dstProfile = path.join(relayDir, 'Default')

    // Sync profile files
    for (const file of ['Preferences', 'Secure Preferences', 'Login Data', 'Web Data']) {
      try {
        const src = path.join(srcProfile, file)
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dstProfile, file))
      } catch {}
    }
    try {
      const src = path.join(CHROME_USER_DATA, 'Local State')
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(relayDir, 'Local State'))
    } catch {}

    // Copy SA CWS extension but modify manifest to simulate different version
    const srcSA = path.join(srcProfile, 'Extensions', SA_CWS_ID)
    const dstSA = path.join(dstProfile, 'Extensions', SA_CWS_ID)
    if (fs.existsSync(srcSA)) {
      copyDirRecursive(srcSA, dstSA)
      // Find and modify manifest
      for (const ver of fs.readdirSync(dstSA, { withFileTypes: true })) {
        if (!ver.isDirectory()) continue
        const mp = path.join(dstSA, ver.name, 'manifest.json')
        if (fs.existsSync(mp)) {
          try {
            const manifest = JSON.parse(fs.readFileSync(mp, 'utf-8'))
            manifest.version = '0.0.1-modified'
            manifest.name = 'Modified SA (not OpenMCPWEBLOCK)'
            fs.writeFileSync(mp, JSON.stringify(manifest, null, 2))
            evidence('Modified SA manifest', `version=${manifest.version} name="${manifest.name}"`)
          } catch {}
        }
      }
    }
    // Also copy other extensions
    const srcExt = path.join(srcProfile, 'Extensions')
    if (fs.existsSync(srcExt)) {
      for (const ext of fs.readdirSync(srcExt, { withFileTypes: true })) {
        if (!ext.isDirectory() || ext.name === SA_CWS_ID) continue
        copyDirRecursive(
          path.join(srcExt, ext.name),
          path.join(dstProfile, 'Extensions', ext.name),
        )
      }
    }
  })
  results.push(resultD)

  // ═══════════════════════════════════════════════════════════════════════
  // SUMMARY MATRIX
  // ═══════════════════════════════════════════════════════════════════════

  console.log('\n═══════════════════════════════════════════════════════════')
  console.log('  GATE B RESULTS MATRIX')
  console.log('═══════════════════════════════════════════════════════════\n')

  const header = '| Scenario | SA source | detectSA pre-pipe | loadUnpacked | detectSA post-pipe | ID final | SW active | Conclusion |'
  const sep =    '|----------|-----------|-------------------|--------------|--------------------|-----------|-----------|-|'
  console.log(header)
  console.log(sep)

  for (const r of results) {
    const saSource = r.saSource ? path.basename(r.saSource) : 'NONE'
    const detectPre = r.detectSABeforePipe.found
      ? `YES (${r.detectSABeforePipe.extensionId?.substring(0,8)}...)`
      : 'NO'
    const pipeRan = !r.loadUnpackedRan ? 'SKIP'
      : r.loadUnpackedResult?.success ? `YES → ${r.loadUnpackedResult.extensionId?.substring(0,8) ?? '?'}...`
      : `FAIL: ${r.loadUnpackedResult?.error?.substring(0,30)}`
    const detectPost = r.loadUnpackedRan
      ? (r.detectSAAfterPipe.found ? `YES (${r.detectSAAfterPipe.extensionId?.substring(0,8)}...)` : 'NO')
      : '-'
    const idFinal = r.extensionInChrome?.saTargets?.[0]?.url?.match(/chrome-extension:\/\/([a-z]+)\//)?.[1]?.substring(0,12) ?? 'NONE'
    const swActive = r.extensionInChrome?.saSWTargets?.length
      ? `YES (${r.extensionInChrome.saSWTargets.length})`
      : 'NO'
    const conclusion = r.conclusion.substring(0, 50)

    console.log(`| ${r.scenario} | ${saSource} | ${detectPre} | ${pipeRan} | ${detectPost} | ${idFinal}... | ${swActive} | ${conclusion} |`)
  }

  // ─── Secure Preferences analysis ─────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════')
  console.log('  SECURE PREFERENCES & MAC ANALYSIS')
  console.log('═══════════════════════════════════════════════════════════\n')

  for (const r of results) {
    if (r.secPrefState) {
      console.log(`  ${r.scenario}: state=${r.secPrefState.state} disabled=${r.secPrefState.disableReasons} webstore=${r.secPrefState.fromWebstore} MAC=${r.macPresence?.extensionsMAC}`)
    } else if (r.macPresence) {
      console.log(`  ${r.scenario}: No SA in SecPrefs. MAC present=${r.macPresence.hasProtectionMAC}`)
    } else {
      console.log(`  ${r.scenario}: No Secure Preferences data`)
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════')
  console.log('  IDENTITY DISTINGUISHING EVIDENCE')
  console.log('═══════════════════════════════════════════════════════════\n')

  console.log('  1. SA CWS from user profile:')
  console.log(`     Extension ID:  ${SA_CWS_ID}`)
  console.log(`     Manifest name: "MCP SuperAssistant"`)
  console.log(`     from_webstore: true`)
  console.log('')
  console.log('  2. SA local build from OpenMCPWEBLOCK:')
  const localSA = findSASource()
  if (localSA) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(localSA, 'manifest.json'), 'utf-8'))
      console.log(`     Extension ID:  DYNAMIC (assigned by Chrome based on path)`)
      console.log(`     Manifest name: "${m.name}"`)
      console.log(`     Version:       ${m.version}`)
      console.log(`     Source:        ${localSA}`)
      console.log(`     from_webstore: false`)
    } catch {}
  }
  console.log('')
  console.log('  3. Distinguishing: CWS ID present → (1). Dynamic ID + title match → (2).')
  console.log('     Different name/version → (3) incompatible. No SA targets → (4) absent.')

  console.log('\nDone.')
}

main().catch(async (err) => {
  console.error('\nFATAL:', err)
  // Emergency cleanup
  for (let p = BASE_PORT; p < BASE_PORT + 5; p++) {
    await killPort(p)
  }
  process.exit(1)
})
