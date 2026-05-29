/**
 * SA Full HMAC Bypass v2: Exact copy of real profile entry
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'

const SEED_HEX = 'E748F336D85EA5F9DCDF25D8F347A65B4CDF667600F02DF6724A2AF18A212D26B788A25086910CF3A90313696871F3DC05823730C91DF8BA5C4FD9C884B505A8'
const MACHINE_SID = 'S-1-5-21-2978769104-1846352092-2597173333'
const seedBuffer = Buffer.from(SEED_HEX, 'hex')

function hmacSign(deviceId: string, prefPath: string, value: string): string {
  const hmac = crypto.createHmac('sha256', seedBuffer)
  hmac.update(deviceId)
  hmac.update(prefPath)
  hmac.update(value)
  return hmac.digest('hex').toUpperCase()
}

const RELAY_DIR = path.join(process.env.LOCALAPPDATA ?? '', 'openMCPWEBLOCK', 'chrome-debug')
const REAL_PROFILE = path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'User Data', 'Default')
const SA_ID = 'kngiafgkdnlkgmefdafaibkibegkcaef'

function copyDir(src: string, dst: string) {
  fs.mkdirSync(dst, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name)
    const dstPath = path.join(dst, entry.name)
    entry.isDirectory() ? copyDir(srcPath, dstPath) : fs.copyFileSync(srcPath, dstPath)
  }
}

console.log('=== SA Full HMAC Bypass v2 ===\n')

// 1. Close Chrome
console.log('1. Closing Chrome...')
try { execSync('taskkill /IM chrome.exe /F', { stdio: 'ignore' }) } catch {}
await new Promise(r => setTimeout(r, 3000))

// 2. Copy extension files
const srcExtDir = path.join(REAL_PROFILE, 'Extensions', SA_ID)
const dstExtDir = path.join(RELAY_DIR, 'Default', 'Extensions', SA_ID)
if (fs.existsSync(dstExtDir)) fs.rmSync(dstExtDir, { recursive: true, force: true })
copyDir(srcExtDir, dstExtDir)
console.log('   ✓ Extension files copied')

// 3. Read real SA entry (full)
const realSp = JSON.parse(fs.readFileSync(path.join(REAL_PROFILE, 'Secure Preferences'), 'utf-8'))
const realSaEntry = JSON.parse(JSON.stringify(realSp.extensions.settings[SA_ID]))

// 4. Only modify what's needed: enable it
realSaEntry.active_bit = true
realSaEntry.disable_reasons = 0  // 0 = no disable reasons (Chrome stores as int bitmask)

// Keep the RELATIVE path - same as original since we mirrored the directory structure
// path should be: "kngiafgkdnlkgmefdafaibkibegkcaef\\0.6.0_0"
console.log(`   Path: ${realSaEntry.path}`)
console.log(`   disable_reasons: ${JSON.stringify(realSaEntry.disable_reasons)}`)

// 5. Update relay Secure Preferences
const spPath = path.join(RELAY_DIR, 'Default', 'Secure Preferences')
const sp = JSON.parse(fs.readFileSync(spPath, 'utf-8'))

// Set the full entry
sp.extensions.settings[SA_ID] = realSaEntry

// 6. Calculate MAC
const saJson = JSON.stringify(realSaEntry)
const newMac = hmacSign(MACHINE_SID, `extensions.settings.${SA_ID}`, saJson)
sp.protection.macs.extensions.settings[SA_ID] = newMac
console.log(`   New MAC: ${newMac.substring(0, 30)}...`)

// 7. Recalculate super_mac
const macsJson = JSON.stringify(sp.protection.macs)
sp.protection.super_mac = hmacSign(MACHINE_SID, '', macsJson)
console.log(`   New super: ${sp.protection.super_mac.substring(0, 30)}...`)

// 8. Write (keep Chrome's own JSON format - no indentation changes)
fs.copyFileSync(spPath, spPath + '.bak3')
fs.writeFileSync(spPath, JSON.stringify(sp), 'utf-8')
console.log('\n   ✓ Secure Preferences written (compact JSON)')

// 9. Launch Chrome
console.log('\n2. Launching Chrome...')
const { spawn } = await import('child_process')
spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  `--remote-debugging-port=9222`,
  `--user-data-dir=${RELAY_DIR}`,
  '--no-first-run',
  'chrome://extensions',
], { detached: true, stdio: 'ignore' }).unref()

await new Promise(r => setTimeout(r, 8000))

// 10. Check via CDP
console.log('\n3. Checking extensions...')
const { CDPConnection } = await import('./src/services/webRelay/ChromeCDP.ts')
const cdp = new CDPConnection()
await cdp.connect()

const exts = await cdp.evaluate(`
  new Promise(resolve => {
    if (typeof chrome !== 'undefined' && chrome.developerPrivate) {
      chrome.developerPrivate.getExtensionsInfo(function(exts) {
        resolve(JSON.stringify(exts.map(e => ({
          name: e.name, id: e.id, state: e.state, location: e.location, type: e.type
        }))));
      });
    } else {
      resolve('[]');
    }
  })
`)
const extList = JSON.parse(exts as string)
console.log(`\n   Found ${extList.length} extensions:`)
for (const ext of extList) {
  const marker = ext.id === SA_ID ? '★★★' : '   '
  console.log(`   ${marker} [${ext.state}] ${ext.name} (${ext.location})`)
}

const sa = extList.find((e: any) => e.id === SA_ID)
if (sa) {
  console.log(`\n🎉 SA IS LOADED! State: ${sa.state}`)
  
  if (sa.state !== 'ENABLED') {
    console.log('   Attempting to enable...')
    await cdp.evaluate(`
      new Promise(resolve => {
        chrome.developerPrivate.updateExtensionConfiguration({
          extensionId: '${SA_ID}',
          fileAccess: true,
          hostAccess: 'ON_ALL_SITES'
        }, () => resolve('ok'));
      })
    `)
    console.log('   ✓ Enabled')
  }
} else {
  console.log('\n✗ SA NOT found in extensions')
  // Check what Chrome did to the prefs
  const spNow = JSON.parse(fs.readFileSync(spPath, 'utf-8'))
  const saAfter = spNow.extensions.settings[SA_ID]
  if (saAfter) {
    console.log('   SA still in prefs:', JSON.stringify(saAfter).substring(0, 200))
  } else {
    console.log('   SA was REMOVED from prefs by Chrome')
  }
}

cdp.close()
process.exit(0)
