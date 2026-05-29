/**
 * Recalculate super_mac after removing SA, then relaunch Chrome
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'

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

const relayDir = path.join(process.env.LOCALAPPDATA ?? '', 'openMCPWEBLOCK', 'chrome-debug')
const spPath = path.join(relayDir, 'Default', 'Secure Preferences')

// Read and recalculate super_mac
const sp = JSON.parse(fs.readFileSync(spPath, 'utf-8'))

// Verify SA is gone
console.log('SA in settings:', sp.extensions?.settings?.kngiafgkdnlkgmefdafaibkibegkcaef ? 'EXISTS' : 'REMOVED')
console.log('SA MAC:', sp.protection?.macs?.extensions?.settings?.kngiafgkdnlkgmefdafaibkibegkcaef ? 'EXISTS' : 'REMOVED')

// Recalculate super_mac
const macsJson = JSON.stringify(sp.protection.macs)
sp.protection.super_mac = hmacSign(MACHINE_SID, '', macsJson)
console.log('New super_mac:', sp.protection.super_mac.substring(0, 30) + '...')

// Write back
fs.writeFileSync(spPath, JSON.stringify(sp), 'utf-8')
console.log('Written!')

// Also clean the regular Preferences file
const prefsPath = path.join(relayDir, 'Default', 'Preferences')
if (fs.existsSync(prefsPath)) {
  const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'))
  if (prefs.extensions?.settings?.kngiafgkdnlkgmefdafaibkibegkcaef) {
    delete prefs.extensions.settings.kngiafgkdnlkgmefdafaibkibegkcaef
    fs.writeFileSync(prefsPath, JSON.stringify(prefs), 'utf-8')
    console.log('Cleaned regular Preferences too')
  }
}

// Launch Chrome to the Web Store page
console.log('\nLaunching Chrome...')
spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--remote-debugging-port=9222',
  `--user-data-dir=${relayDir}`,
  '--no-first-run',
  'https://chromewebstore.google.com/detail/mcp-superassistant/kngiafgkdnlkgmefdafaibkibegkcaef',
], { detached: true, stdio: 'ignore' }).unref()

console.log('Done! Chrome will open the Web Store page.')
console.log('Click "Añadir a Chrome" → "Añadir extensión" to install SA.')
process.exit(0)
