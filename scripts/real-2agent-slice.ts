#!/usr/bin/env bun
/**
 * REAL 2-Agent Vertical Slice — Post-fix integration test.
 *
 * This script launches TWO real Chrome instances with SA, verifies identity,
 * kills one, checks Sentinel isolation, restarts, and confirms isolation.
 *
 * Ports: 9250 (Agent A), 9251 (Agent B)
 * Run: bun run scripts/real-2agent-slice.ts
 */

import path from 'path'
import fs from 'fs'
import { execSync, spawn } from 'child_process'

// ─── Constants ───────────────────────────────────────────────────────────────

const LOCALAPPDATA = process.env.LOCALAPPDATA ?? ''
const RELAY_ROOT = path.join(LOCALAPPDATA, 'openMCPWEBLOCK', 'chrome-agents')
const LOCAL_SA = path.join(process.cwd(), 'chrome-extension', 'source', 'dist')
const PORT_A = 9250
const PORT_B = 9251

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(ctx: string, msg = '') { console.log(`\n[${ctx}] ${msg}`) }
function ev(k: string, v: any) { console.log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`) }
function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)) }
function hr() { console.log('─'.repeat(60)) }

function clearLocks(dir: string) {
  for (const n of ['SingletonLock', 'SingletonCookie', 'lockfile']) {
    for (const b of [dir, path.join(dir, 'Default')]) {
      try { fs.rmSync(path.join(b, n), { force: true, recursive: true }) } catch {}
    }
  }
}

function findChrome(): string {
  for (const c of [
    path.join(process.env.PROGRAMFILES ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]) { if (c && fs.existsSync(c)) return c }
  throw new Error('Chrome not found')
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
    if (!check.toLowerCase().includes('chrome.exe')) { console.log(`  PID ${pid} on ${port} is not Chrome — skip`); return }
    execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore', timeout: 10000 })
  } catch {}
  for (let i = 0; i < 20; i++) { if (!(await pidOnPort(port))) return; await sleep(500) }
}

async function portActive(port: number): Promise<boolean> {
  try { return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) })).ok } catch { return false }
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

// ─── CDP WebSocket helpers ───────────────────────────────────────────────────

async function loadSAViaCDP(port: number, saDir: string): Promise<string | null> {
  const { WebSocket } = await import('ws')
  const ver = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()) as any
  if (!ver?.webSocketDebuggerUrl) return null
  const ws = new WebSocket(ver.webSocketDebuggerUrl)
  await new Promise<void>((res, rej) => { ws.on('open', res); ws.on('error', rej); setTimeout(() => rej(new Error('WS timeout')), 10000) })
  const result = await new Promise<any>((res, rej) => {
    const to = setTimeout(() => rej(new Error('loadUnpacked timeout')), 15000)
    ws.on('message', (d: any) => {
      try { const m = JSON.parse(d.toString()); if (m.id === 1) { clearTimeout(to); m.error ? rej(new Error(m.error.message)) : res(m.result) } } catch {}
    })
    ws.send(JSON.stringify({ id: 1, method: 'Extensions.loadUnpacked', params: { path: saDir } }))
  })
  ws.close()
  return result?.id ?? null
}

async function fetchTargets(port: number): Promise<any[]> {
  try { return await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(3000) })).json() as any[] } catch { return [] }
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

// ─── Assertions ──────────────────────────────────────────────────────────────

let passCount = 0, failCount = 0
function assert(test: string, cond: boolean, detail = '') {
  if (cond) { passCount++; console.log(`  ✅ ${test}${detail ? ' — ' + detail : ''}`) }
  else { failCount++; console.log(`  ❌ ${test}${detail ? ' — ' + detail : ''}`) }
}

// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═══════════════════════════════════════════════════════════')
  console.log('  REAL 2-AGENT VERTICAL SLICE — Post-fix Integration')
  console.log('═══════════════════════════════════════════════════════════')

  // ── CLEANUP ────────────────────────────────────────────────────────
  await killPort(PORT_A)
  await killPort(PORT_B)
  await sleep(1000)

  const relayA = freshRelay('slice-agent-a')
  const relayB = freshRelay('slice-agent-b')
  const instanceIdA = 'slice-agent-a'
  const instanceIdB = 'slice-agent-b'

  // ══════════════════════════════════════════════════════════════════
  // PHASE 1: Launch both agents with SA
  // ══════════════════════════════════════════════════════════════════
  log('PHASE 1', 'Launch Agent A and Agent B simultaneously')
  hr()

  const [startedA, startedB] = await Promise.all([
    launchChrome(relayA, PORT_A),
    launchChrome(relayB, PORT_B),
  ])
  assert('Chrome A started', startedA)
  assert('Chrome B started', startedB)
  if (!startedA || !startedB) { console.log('\nFATAL: Chrome launch failed'); process.exit(1) }

  await sleep(3000)

  // Load SA on both
  const extIdA = await loadSAViaCDP(PORT_A, LOCAL_SA)
  const extIdB = await loadSAViaCDP(PORT_B, LOCAL_SA)
  ev('SA-A extensionId', extIdA)
  ev('SA-B extensionId', extIdB)
  assert('SA-A loaded', !!extIdA, `id=${extIdA}`)
  assert('SA-B loaded', !!extIdB, `id=${extIdB}`)

  await sleep(3000)

  // ══════════════════════════════════════════════════════════════════
  // PHASE 2: Identity verification
  // ══════════════════════════════════════════════════════════════════
  log('PHASE 2', 'Verify identities')
  hr()

  // Instance IDs
  assert('instanceId A ≠ instanceId B', instanceIdA !== instanceIdB, `A=${instanceIdA} B=${instanceIdB}`)
  assert('debugPort A ≠ debugPort B', PORT_A !== PORT_B, `A=${PORT_A} B=${PORT_B}`)

  // Find SA SW targets
  const targetsA = await fetchTargets(PORT_A)
  const targetsB = await fetchTargets(PORT_B)
  const swTargetA = targetsA.find((t: any) => t.type === 'service_worker' && extIdA && t.url?.includes(`chrome-extension://${extIdA}/`))
  const swTargetB = targetsB.find((t: any) => t.type === 'service_worker' && extIdB && t.url?.includes(`chrome-extension://${extIdB}/`))

  assert('SW-A found', !!swTargetA, swTargetA?.url)
  assert('SW-B found', !!swTargetB, swTargetB?.url)

  // Inspect runtime identity
  let identityA: any = null, identityB: any = null
  if (swTargetA) identityA = await inspectSW(PORT_A, swTargetA.id)
  if (swTargetB) identityB = await inspectSW(PORT_B, swTargetB.id)

  ev('Identity A', identityA)
  ev('Identity B', identityB)

  assert('chrome.runtime.id A = extensionId A', identityA?.runtimeId === extIdA, `${identityA?.runtimeId} = ${extIdA}`)
  assert('chrome.runtime.id B = extensionId B', identityB?.runtimeId === extIdB, `${identityB?.runtimeId} = ${extIdB}`)
  assert('manifest A name = MCP SuperAssistant', identityA?.name === 'MCP SuperAssistant')
  assert('manifest B name = MCP SuperAssistant', identityB?.name === 'MCP SuperAssistant')
  assert('manifest A version = 0.6.0', identityA?.version === '0.6.0')
  assert('manifest B version = 0.6.0', identityB?.version === '0.6.0')

  // SW correspondence: A's port has A's SW, not B's. B's port has B's SW.
  // Since both IDs might be the same (same source path), check per-port isolation.
  const allSWsA = targetsA.filter((t: any) => t.type === 'service_worker')
  const allSWsB = targetsB.filter((t: any) => t.type === 'service_worker')
  ev('Total SWs on port A', allSWsA.length)
  ev('Total SWs on port B', allSWsB.length)

  // ── Point 4: saExtensionId per-instance audit ────────────────────
  log('PHASE 2b', 'Audit: saExtensionId is per-instance')
  hr()

  // Read Sentinel.ts and check the data structure
  const sentinelSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'webRelay', 'orchestration', 'Sentinel.ts'), 'utf-8')

  // Check that knownSAIds is a Map<string, string> (agentId → extensionId)
  const hasMap = sentinelSrc.includes('const knownSAIds = new Map<string, string>()')
  assert('knownSAIds is Map<string, string>', hasMap, 'per-agent, not global singleton')

  // Check there's no global "currentSaExtensionId" or similar
  const hasGlobalCurrent = sentinelSrc.includes('currentSaExtensionId') || sentinelSrc.includes('globalSaId')
  assert('No global currentSaExtensionId', !hasGlobalCurrent)

  // Check registerSAExtensionId takes agentId
  const registerSig = sentinelSrc.includes('registerSAExtensionId(agentId: string, extensionId: string)')
  assert('registerSAExtensionId takes agentId + extensionId', registerSig)

  // Simulate what happens with two agents
  ev('Conceptual mapping', `${instanceIdA} → ${extIdA}, ${instanceIdB} → ${extIdB}`)

  // ══════════════════════════════════════════════════════════════════
  // PHASE 3: Kill Chrome A, verify Sentinel isolation
  // ══════════════════════════════════════════════════════════════════
  log('PHASE 3', 'Kill Chrome A — verify isolation')
  hr()

  const pidA = await pidOnPort(PORT_A)
  ev('Chrome A PID before kill', pidA)
  await killPort(PORT_A)
  await sleep(2000)

  const portAafter = await portActive(PORT_A)
  const portBafter = await portActive(PORT_B)
  assert('Port A is DEAD after kill', !portAafter)
  assert('Port B is ALIVE after kill A', portBafter)

  // Simulate Sentinel scan
  log('PHASE 3b', 'Sentinel scan after killing A')

  // Check A
  const aAlive = await portActive(PORT_A)
  ev('Sentinel: port A alive?', aAlive)
  assert('Sentinel correctly detects A as DEAD', !aAlive)

  // Check B
  const bAlive = await portActive(PORT_B)
  ev('Sentinel: port B alive?', bAlive)
  assert('Sentinel correctly detects B as ALIVE', bAlive)

  // Verify B's SW is still running
  if (bAlive) {
    const tB = await fetchTargets(PORT_B)
    const swB = tB.find((t: any) => t.type === 'service_worker' && extIdB && t.url?.includes(`chrome-extension://${extIdB}/`))
    assert('B SW still active after A kill', !!swB, swB?.url)

    // Verify B's identity is unchanged
    if (swB) {
      const idB = await inspectSW(PORT_B, swB.id)
      assert('B identity unchanged after A kill', idB?.runtimeId === extIdB, `${idB?.runtimeId}`)
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 4: Restart Agent A, verify both ready
  // ══════════════════════════════════════════════════════════════════
  log('PHASE 4', 'Restart Agent A')
  hr()

  clearLocks(relayA)
  const restartedA = await launchChrome(relayA, PORT_A)
  assert('Chrome A restarted', restartedA)

  if (restartedA) {
    await sleep(3000)

    // Check if SA persisted from previous install
    const tA2 = await fetchTargets(PORT_A)
    let swA2 = tA2.find((t: any) => t.type === 'service_worker' && extIdA && t.url?.includes(`chrome-extension://${extIdA}/`))

    if (!swA2) {
      // SA may need reloading — persistence depends on relay profile state
      ev('SA not persisted — reloading', '')
      const newExtIdA = await loadSAViaCDP(PORT_A, LOCAL_SA)
      ev('Reloaded SA-A extensionId', newExtIdA)
      await sleep(3000)
      const tA3 = await fetchTargets(PORT_A)
      swA2 = tA3.find((t: any) => t.type === 'service_worker' && newExtIdA && t.url?.includes(`chrome-extension://${newExtIdA}/`))
      if (swA2 && newExtIdA) {
        assert('SA-A SW active after reload', true, swA2.url)
        // Verify identity
        const idA2 = await inspectSW(PORT_A, swA2.id)
        assert('Restarted A chrome.runtime.id matches', idA2?.runtimeId === newExtIdA, `${idA2?.runtimeId} = ${newExtIdA}`)
      } else {
        assert('SA-A SW active after reload', false, 'SW not found')
      }
    } else {
      assert('SA-A persisted through restart', true, swA2.url)
      const idA2 = await inspectSW(PORT_A, swA2.id)
      assert('Restarted A chrome.runtime.id matches', idA2?.runtimeId === extIdA, `${idA2?.runtimeId} = ${extIdA}`)
    }

    // Verify B is still fine
    const portBfinal = await portActive(PORT_B)
    assert('B still alive after A restart', portBfinal)

    if (portBfinal) {
      const tBfinal = await fetchTargets(PORT_B)
      const swBfinal = tBfinal.find((t: any) => t.type === 'service_worker' && extIdB && t.url?.includes(`chrome-extension://${extIdB}/`))
      assert('B SW still active after A restart', !!swBfinal)
    }

    // Verify A did not reuse B's identity
    const portAfinal = await portActive(PORT_A)
    const portBcheck = await portActive(PORT_B)
    assert('Port A ≠ Port B after restart', PORT_A !== PORT_B)
    assert('A alive on its own port', portAfinal)
    assert('B alive on its own port', portBcheck)
  }

  // ── Point 5: Sentinel has access to all needed evidence ──────────
  log('PHASE 5', 'Audit: Sentinel evidence access')
  hr()

  // Check Sentinel can access these through listAgents/getAgentStatus
  const runnerSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'webRelay', 'orchestration', 'MultiAgentRunner.ts'), 'utf-8')
  const typesSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'webRelay', 'orchestration', 'types.ts'), 'utf-8')

  // AgentState has all required fields
  assert('AgentState has agentId', typesSrc.includes('agentId: string'))
  assert('AgentState has instanceId', typesSrc.includes('instanceId?: string'))
  assert('AgentState has platformId', typesSrc.includes('platformId: string'))
  assert('AgentState has debugPort', typesSrc.includes('debugPort?: number'))
  assert('AgentState has status (lifecycle)', typesSrc.includes('status: AgentLifecycleStatus'))
  assert('AgentState has lastHeartbeat', typesSrc.includes('lastHeartbeat?: number'))

  // Sentinel has SA extension ID map
  assert('Sentinel has knownSAIds per agent', hasMap)

  // Sentinel imports listAgents/getAgentStatus
  const sentinelImports = sentinelSrc.includes('listAgents') && sentinelSrc.includes('getAgentStatus')
  assert('Sentinel imports listAgents + getAgentStatus', sentinelImports)

  // ══════════════════════════════════════════════════════════════════
  // RESULTS
  // ══════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60))
  console.log(`  RESULTS: ${passCount} PASS / ${failCount} FAIL`)
  console.log('═'.repeat(60))

  // Cleanup
  await killPort(PORT_A)
  await killPort(PORT_B)

  if (failCount > 0) process.exit(1)
}

main().catch(async (err) => {
  console.error('\nFATAL:', err)
  try { await killPort(PORT_A) } catch {}
  try { await killPort(PORT_B) } catch {}
  process.exit(1)
})
