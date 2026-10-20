#!/usr/bin/env bun
/**
 * SA Launcher Diagnostic — traces every step of the SA loading chain.
 *
 * Run: bun run scripts/sa-diagnostic.ts
 */

import path from 'path'
import fs from 'fs'

const LOCALAPPDATA = process.env.LOCALAPPDATA ?? ''
const CHROME_USER_DATA = path.join(LOCALAPPDATA, 'Google', 'Chrome', 'User Data')
const SA_RELAY_DIR = path.join(LOCALAPPDATA, 'openMCPWEBLOCK', 'sa-extension')
const RELAY_ROOT = path.join(LOCALAPPDATA, 'openMCPWEBLOCK', 'chrome-agents')
const MODULE_DIR = path.resolve('src', 'services', 'webRelay')

const SA_EXTENSION_ID_CWS = 'kngiafgkdnlkgmefdafaibkibegkcaef'

function log(section: string, ...args: any[]) {
  console.log(`\n[${section}]`, ...args)
}
function evidence(label: string, value: any) {
  console.log(`  ${label}: ${value}`)
}

// ─── Step 1: findSASourcePath equivalent ─────────────────────────────────────

log('STEP 1', 'Finding SA source path...')

const envPath = process.env.OPENMCP_SA_PATH
evidence('OPENMCP_SA_PATH env', envPath || 'NOT SET')

const localCandidates = [
  path.join(process.cwd(), 'chrome-extension', 'source', 'dist'),
  path.resolve(MODULE_DIR, '..', '..', '..', 'chrome-extension', 'source', 'dist'),
  path.join(process.cwd(), 'chrome-extension', 'dist'),
  path.resolve(MODULE_DIR, '..', '..', '..', 'chrome-extension', 'dist'),
  path.join(process.cwd(), '..', 'MCP-SuperAssistant', 'dist'),
  path.join(process.cwd(), 'MCP-SuperAssistant', 'dist'),
]

let foundLocalSource: string | null = null
for (const candidate of localCandidates) {
  const manifestPath = path.join(candidate, 'manifest.json')
  const exists = fs.existsSync(manifestPath)
  evidence(`  ${candidate}`, exists ? 'FOUND' : 'not found')
  if (exists && !foundLocalSource) {
    foundLocalSource = candidate
  }
}

if (foundLocalSource) {
  log('STEP 1 RESULT', `SA source found at: ${foundLocalSource}`)
  // Check if it matches the local repo pattern
  const isLocalRepo = foundLocalSource.includes('chrome-extension') || foundLocalSource.includes('MCP-SuperAssistant')
  evidence('Is local repo build', isLocalRepo)
  evidence('prepareSAExtension() would return', isLocalRepo ? foundLocalSource : SA_RELAY_DIR)

  // Read manifest
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(foundLocalSource, 'manifest.json'), 'utf-8'))
    evidence('Manifest name', manifest.name)
    evidence('Manifest version', manifest.version)
    evidence('Manifest MV', manifest.manifest_version)
    evidence('Background', manifest.background?.service_worker ?? 'NONE')
    evidence('Has key (CWS)', manifest.key ? 'YES' : 'NO')
    evidence('Has update_url (CWS)', manifest.update_url ? 'YES' : 'NO')
  } catch (e: any) {
    evidence('Manifest read error', e.message)
  }
} else {
  log('STEP 1 RESULT', 'No local SA source found. Will search Chrome profiles.')
}

// ─── Step 2: Check Chrome profiles for SA ────────────────────────────────────

log('STEP 2', 'Checking Chrome profiles for SA...')

const profiles = ['Default', ...Array.from({ length: 10 }, (_, i) => `Profile ${i + 1}`)]
let foundInProfile: string | null = null

for (const profile of profiles) {
  const profilePath = path.join(CHROME_USER_DATA, profile)
  if (!fs.existsSync(profilePath)) continue

  const extDir = path.join(profilePath, 'Extensions')
  if (!fs.existsSync(extDir)) {
    evidence(`  ${profile}/Extensions`, 'NOT FOUND')
    continue
  }

  let saFound = false
  let saExtId = ''
  let saVersion = ''
  let saManifestName = ''

  try {
    const extensions = fs.readdirSync(extDir, { withFileTypes: true })
    for (const ext of extensions) {
      if (!ext.isDirectory()) continue
      const extPath = path.join(extDir, ext.name)
      try {
        const versions = fs.readdirSync(extPath, { withFileTypes: true })
        for (const ver of versions) {
          if (!ver.isDirectory()) continue
          const manifestPath = path.join(extPath, ver.name, 'manifest.json')
          if (!fs.existsSync(manifestPath)) continue
          try {
            const content = fs.readFileSync(manifestPath, 'utf-8')
            if (content.includes('MCP') || content.includes('SuperAssistant') || content.includes('mcp-superassistant')) {
              saFound = true
              saExtId = ext.name
              saVersion = ver.name
              try {
                const m = JSON.parse(content)
                saManifestName = m.name
              } catch {}
            }
          } catch {}
        }
      } catch {}
    }
  } catch {}

  if (saFound) {
    evidence(`  ${profile}`, `SA FOUND — extId=${saExtId} ver=${saVersion} name="${saManifestName}"`)
    evidence(`    Is CWS ID`, saExtId === SA_EXTENSION_ID_CWS ? 'YES' : 'NO (different ID)')
    foundInProfile = path.join(extDir, saExtId, saVersion)
  } else {
    evidence(`  ${profile}`, 'SA not found in Extensions/')
  }
}

// ─── Step 3: detectSAInProfile on relay directories ──────────────────────────

log('STEP 3', 'Checking existing relay directories for SA...')

if (fs.existsSync(RELAY_ROOT)) {
  try {
    const relayDirs = fs.readdirSync(RELAY_ROOT, { withFileTypes: true })
    for (const rd of relayDirs) {
      if (!rd.isDirectory()) continue
      const relayDefault = path.join(RELAY_ROOT, rd.name, 'Default')
      const relayExtDir = path.join(relayDefault, 'Extensions')

      if (!fs.existsSync(relayExtDir)) {
        evidence(`  ${rd.name}/Default/Extensions`, 'NOT FOUND')
        continue
      }

      let saFoundInRelay = false
      try {
        const extensions = fs.readdirSync(relayExtDir, { withFileTypes: true })
        for (const ext of extensions) {
          if (!ext.isDirectory()) continue
          const extPath = path.join(relayExtDir, ext.name)
          const versions = fs.readdirSync(extPath, { withFileTypes: true })
          for (const ver of versions) {
            if (!ver.isDirectory()) continue
            const mp = path.join(extPath, ver.name, 'manifest.json')
            if (!fs.existsSync(mp)) continue
            try {
              const content = fs.readFileSync(mp, 'utf-8')
              if (content.includes('MCP') || content.includes('SuperAssistant')) {
                evidence(`  ${rd.name}`, `SA FOUND — extId=${ext.name} ver=${ver.name}`)
                saFoundInRelay = true
              }
            } catch {}
          }
        }
      } catch {}
      if (!saFoundInRelay) {
        evidence(`  ${rd.name}`, 'SA not found in relay Extensions/')
      }
    }
  } catch (e: any) {
    evidence('  Error reading relay root', e.message)
  }
} else {
  evidence('  Relay root', `NOT FOUND at ${RELAY_ROOT}`)
}

// ─── Step 4: Check SA relay dir ──────────────────────────────────────────────

log('STEP 4', 'Checking SA relay directory...')
evidence('SA_RELAY_DIR', SA_RELAY_DIR)
if (fs.existsSync(SA_RELAY_DIR)) {
  const relayManifest = path.join(SA_RELAY_DIR, 'manifest.json')
  if (fs.existsSync(relayManifest)) {
    try {
      const m = JSON.parse(fs.readFileSync(relayManifest, 'utf-8'))
      evidence('  name', m.name)
      evidence('  version', m.version)
      evidence('  has key', m.key ? 'YES (CWS metadata NOT stripped)' : 'NO (stripped correctly)')
      evidence('  has update_url', m.update_url ? 'YES (CWS metadata NOT stripped)' : 'NO (stripped correctly)')
    } catch (e: any) {
      evidence('  manifest error', e.message)
    }
  } else {
    evidence('  manifest.json', 'NOT FOUND')
  }
} else {
  evidence('  SA relay dir', 'NOT FOUND (not yet prepared)')
}

// ─── Step 5: Check puppeteer-core availability ───────────────────────────────

log('STEP 5', 'Checking puppeteer-core availability (needed for pipe install)...')
try {
  let pup = await import('puppeteer-core')
  if ((pup as any).default) pup = (pup as any).default
  evidence('puppeteer-core', 'AVAILABLE')
  evidence('  version', (pup as any).version ?? (pup as any).default?.version ?? 'unknown')
} catch (e: any) {
  evidence('puppeteer-core', `NOT AVAILABLE — ${e.message}`)
  log('STEP 5 WARNING', 'Without puppeteer-core, loadUnpackedViaPipe() will fail.')
  log('STEP 5 WARNING', 'SA can only work if already in the synced profile.')
}

// ─── Step 6: Trace the launchChrome() decision tree ──────────────────────────

log('STEP 6', 'Tracing launchChrome() decision tree for a new relay instance...')

const testRelayDir = path.join(RELAY_ROOT, 'diag-test-instance')
const testRelayDefault = path.join(testRelayDir, 'Default')

evidence('Profile used by MultiAgentRunner', 'Default (hardcoded in startAgentImpl)')
evidence('Relay data dir would be', testRelayDir)

// Simulate: would launchChrome use guest or not?
const profileDir = 'Default'
const isGuest = profileDir === 'guest'
evidence('isGuest', isGuest)

if (!isGuest) {
  // syncProfileToRelay: copies from real Chrome Default to relay dir
  const srcProfile = path.join(CHROME_USER_DATA, profileDir)
  evidence('Sync source', srcProfile)
  evidence('  exists', fs.existsSync(srcProfile))

  // What gets synced?
  const filesToSync = ['Preferences', 'Cookies', 'Login Data', 'Web Data']
  const dirsToSync = ['Extensions', 'Local Extension Settings', 'Sync Extension Settings']

  log('STEP 6a', 'Files that syncProfileToRelay would copy:')
  for (const f of filesToSync) {
    const exists = fs.existsSync(path.join(srcProfile, f))
    evidence(`  ${f}`, exists ? 'EXISTS (will sync)' : 'NOT FOUND')
  }
  for (const d of dirsToSync) {
    const exists = fs.existsSync(path.join(srcProfile, d))
    evidence(`  ${d}/`, exists ? 'EXISTS (will sync)' : 'NOT FOUND')
  }

  // Check what's in the source Extensions dir
  const srcExtDir = path.join(srcProfile, 'Extensions')
  if (fs.existsSync(srcExtDir)) {
    log('STEP 6b', `Extensions in source profile (${profileDir}):`)
    try {
      const exts = fs.readdirSync(srcExtDir, { withFileTypes: true })
      for (const ext of exts) {
        if (!ext.isDirectory()) continue
        const versions = fs.readdirSync(path.join(srcExtDir, ext.name), { withFileTypes: true })
        const versionNames = versions.filter(v => v.isDirectory()).map(v => v.name)
        let extName = ext.name
        // Try to read manifest for name
        for (const v of versionNames) {
          try {
            const m = JSON.parse(fs.readFileSync(path.join(srcExtDir, ext.name, v, 'manifest.json'), 'utf-8'))
            extName = `${ext.name} (${m.name} v${m.version})`
            break
          } catch {}
        }
        evidence(`  ${extName}`, `versions: ${versionNames.join(', ')}`)
      }
    } catch (e: any) {
      evidence('  Error listing extensions', e.message)
    }
  }
}

// Check Secure Preferences
const srcSecPrefs = path.join(CHROME_USER_DATA, 'Default', 'Secure Preferences')
if (fs.existsSync(srcSecPrefs)) {
  log('STEP 6c', 'Secure Preferences check:')
  try {
    const sp = JSON.parse(fs.readFileSync(srcSecPrefs, 'utf-8'))
    const extSettings = sp?.extensions?.settings ?? {}
    const saEntry = extSettings[SA_EXTENSION_ID_CWS]
    if (saEntry) {
      evidence(`  SA (${SA_EXTENSION_ID_CWS}) in Secure Preferences`, 'PRESENT')
      evidence('    state', saEntry.state)
      evidence('    path', saEntry.path)
      evidence('    manifest.version', saEntry.manifest?.version)
    } else {
      evidence(`  SA (${SA_EXTENSION_ID_CWS}) in Secure Preferences`, 'NOT FOUND')
      // Look for any SA-like entry
      for (const [id, settings] of Object.entries(extSettings)) {
        const s = settings as any
        if (s.manifest?.name?.includes('MCP') || s.manifest?.name?.includes('SuperAssistant')) {
          evidence(`  Found SA-like extension`, `id=${id} name="${s.manifest.name}" path=${s.path}`)
        }
      }
    }
  } catch (e: any) {
    evidence('  Parse error', e.message)
  }
}

// ─── Step 7: launchChrome decision ───────────────────────────────────────────

log('STEP 7', 'launchChrome() SA decision for relay launch:')

// prepareSAExtension returns saDir
const saDir = foundLocalSource // This is what prepareSAExtension would return
evidence('saDir from prepareSAExtension()', saDir || 'NULL')

if (saDir) {
  // detectSAInProfile on the relay dir
  // For a fresh instance, relay dir doesn't exist yet
  evidence('Relay dir exists', fs.existsSync(testRelayDir))
  evidence('detectSAInProfile(relay/Default)', 'false (new relay dir)')
  evidence('Decision', 'Would call loadUnpackedViaPipe() to install SA')
  evidence('After install', 'detectSAInProfile should find it in relay/Default/Extensions/')
  evidence('Then', 'launchChromeInstance() would NOT use --load-extension (detectSAInProfile=true)')
} else {
  evidence('Decision', 'No SA directory → Chrome launches WITHOUT SA')
  evidence('SA_EXTENSION_ID', SA_EXTENSION_ID_CWS)
  evidence('Result', 'The instance will have no SA. extension_loading gate SHOULD fail.')
}

// ─── Step 8: What the vertical slice actually saw ────────────────────────────

log('STEP 8', '=== Analysis of Vertical Slice Results ===')
log('STEP 8', 'Port A (9222) first SW: gighmmpiobklfepjocnamgkkbiglidom = AdBlock Plus')
log('STEP 8', 'Port B (9223) first SW: kngiafgkdnlkgmefdafaibkibegkcaef = SA (CWS)')
log('STEP 8', '')
log('STEP 8', 'Key observation:')
log('STEP 8', '  The profile sync copies ALL extensions from Default, including AdBlock Plus.')
log('STEP 8', '  SA CWS (kngiafgkdnlkgmefdafaibkibegkcaef) appeared on port B.')
log('STEP 8', '  On port A, the script listed the FIRST SW, which happened to be AdBlock.')
log('STEP 8', '  SA may or may not have been present on port A.')
log('STEP 8', '')
log('STEP 8', 'The vertical slice script had a bug: it showed only the first SW per port.')
log('STEP 8', 'All 8 SWs need to be examined to determine if SA was among them.')

// ─── Step 9: Check runner's extension_loading gate ───────────────────────────

log('STEP 9', '=== MultiAgentRunner extension_loading gate analysis ===')
log('STEP 9', 'checkExtensionPresent() looks for:')
log('STEP 9', '  - url contains "kngiafgkdnlkgmefdafaibkibegkcaef" (SA CWS ID)')
log('STEP 9', '  - url contains "background.js"')
log('STEP 9', '  - title contains "SuperAssistant"')
log('STEP 9', '')
log('STEP 9', 'PROBLEM: "background.js" is too broad. MANY extensions have background.js.')
log('STEP 9', 'The gate could pass with ANY extension that has background.js, not just SA.')
log('STEP 9', '')
log('STEP 9', 'For the local build (chrome-extension/source/dist), the extension ID is NOT')
log('STEP 9', `"${SA_EXTENSION_ID_CWS}". When loaded unpacked, Chrome assigns a DIFFERENT ID`)
log('STEP 9', 'based on the path. So checking for the CWS ID would MISS the local build.')
log('STEP 9', '')
log('STEP 9', 'The correct check needs to match either:')
log('STEP 9', '  1. The CWS ID (kngiafg...) for the web store version')
log('STEP 9', '  2. The manifest name "MCP SuperAssistant" for any version')
log('STEP 9', '  3. A specific known pattern in the SW URL for the local build')

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('\n═══════════════════════════════════════════════════════════')
console.log('  SA LAUNCHER DIAGNOSTIC SUMMARY')
console.log('═══════════════════════════════════════════════════════════')

console.log('\n  CHAIN STATUS:')
console.log(`  1. SA source path:           ${foundLocalSource ? '✅ FOUND' : '❌ NOT FOUND'}`)
console.log(`     → ${foundLocalSource ?? 'null'}`)
console.log(`  2. SA in user Chrome profile: ${foundInProfile ? '✅ FOUND' : '⚠️ CHECK ABOVE'}`)
console.log(`  3. prepareSAExtension():     ${foundLocalSource ? '✅ Would return path' : '❌ Would return null'}`)
console.log(`  4. loadUnpackedViaPipe():    REQUIRES puppeteer-core + fresh relay dir`)
console.log(`  5. Chrome profile sync:      Copies Default → relay dir (INCLUDING all extensions)`)
console.log(`  6. detectSAInProfile:        Scans relay Extensions/ for MCP/SuperAssistant manifest`)
console.log(`  7. Service Worker:           Depends on which SA was loaded (CWS vs local)`)
console.log(`  8. Extension ID:             CWS=${SA_EXTENSION_ID_CWS}, local=DYNAMIC (path-based)`)

console.log('\n  ISSUES FOUND:')
console.log('  A. checkExtensionPresent() in runner matches "background.js" — too broad')
console.log('  B. checkServiceWorkerActive() in runner matches "background.js" — too broad')
console.log('  C. SA CWS ID is hardcoded but local build gets a DIFFERENT dynamic ID')
console.log('  D. No verification that the SA found is actually the OpenMCPWEBLOCK SA')
console.log('')
