import { describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  compareChromeProfileCookieDatabaseSnapshot,
  describeChromeProfileCookieDatabaseReadIssue,
  getBlockingChromeProfileProcessIds,
  inspectChromeProfileCopy,
  parseChromeProfileSources,
} from './ChromeProfileRegistry.js'

describe('compareChromeProfileCookieDatabaseSnapshot', () => {
  test('distinguishes unchanged, rewritten, missing, and legacy cookie database snapshots', () => {
    const marker = {
      profileId: 'Profile 16',
      cookieDatabasePath: 'Default/Network/Cookies' as const,
      cookieDatabaseSha256: 'abc123',
    }
    expect(compareChromeProfileCookieDatabaseSnapshot(marker, true, 'abc123')).toBe('unchanged')
    expect(compareChromeProfileCookieDatabaseSnapshot(marker, true, 'def456')).toBe('changed')
    expect(compareChromeProfileCookieDatabaseSnapshot(marker, false)).toBe('missing')
    expect(compareChromeProfileCookieDatabaseSnapshot({ profileId: 'Profile 16' }, true)).toBe('not-recorded')
    expect(compareChromeProfileCookieDatabaseSnapshot(marker, true)).toBe('unavailable')
  })
})

describe('describeChromeProfileCookieDatabaseReadIssue', () => {
  test('reports transient Chrome locks and access restrictions but leaves unexpected errors explicit', () => {
    expect(describeChromeProfileCookieDatabaseReadIssue({ code: 'EBUSY' }))
      .toContain('Chrome currently locks')
    expect(describeChromeProfileCookieDatabaseReadIssue({ code: 'EACCES' }))
      .toContain('not readable')
    expect(describeChromeProfileCookieDatabaseReadIssue({ code: 'EPERM' }))
      .toContain('not readable')
    expect(describeChromeProfileCookieDatabaseReadIssue({ code: 'EIO' })).toBeUndefined()
  })
})

describe('inspectChromeProfileCopy', () => {
  test('reports when Chrome rewrites the copied cookie database after launch', () => {
    const relayDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'openmcp-profile-diagnostic-'))
    try {
      const cookieDirectory = path.join(relayDirectory, 'Default', 'Network')
      fs.mkdirSync(cookieDirectory, { recursive: true })
      const cookieDatabase = path.join(cookieDirectory, 'Cookies')
      fs.writeFileSync(cookieDatabase, 'rewritten by Chrome')
      fs.writeFileSync(path.join(relayDirectory, '.openmcp-chrome-profile-copy.json'), JSON.stringify({
        profileId: 'Profile 16',
        copiedAt: 123,
        cookieDatabasePath: 'Default/Network/Cookies',
        cookieDatabaseSha256: 'hash-from-copy-time',
      }))

      expect(inspectChromeProfileCopy('Profile 16', relayDirectory)).toEqual({
        copied: true,
        profileMatches: true,
        copiedAt: 123,
        cookieDatabase: 'changed',
      })
    } finally {
      fs.rmSync(relayDirectory, { recursive: true, force: true })
    }
  })

  test('does not claim a profile copy when there is no copy marker', () => {
    const relayDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'openmcp-profile-diagnostic-'))
    try {
      expect(inspectChromeProfileCopy('Profile 16', relayDirectory)).toEqual({
        copied: false,
        profileMatches: null,
        copiedAt: null,
        cookieDatabase: 'not-recorded',
      })
    } finally {
      fs.rmSync(relayDirectory, { recursive: true, force: true })
    }
  })
})

describe('parseChromeProfileSources', () => {
  test('returns valid profile names without exposing account email metadata', () => {
    const profiles = parseChromeProfileSources({
      profile: {
        info_cache: {
          'Profile 2': {
            name: 'Carlos Chrome',
            gaia_name: 'Carlos',
            user_name: 'carlos@example.com',
          },
          Default: { name: 'Default' },
          'Guest Profile': { name: 'Guest' },
          '../outside': { name: 'Invalid' },
        },
      },
    })

    expect(profiles).toEqual([
      { id: 'Default', name: 'Default' },
      { id: 'Profile 2', name: 'Carlos' },
    ])
  })

  test('returns an empty list when Chrome has no profile metadata', () => {
    expect(parseChromeProfileSources({})).toEqual([])
  })
})

describe('getBlockingChromeProfileProcessIds', () => {
  test('reports Chrome processes using the default profile, including background processes', () => {
    expect(getBlockingChromeProfileProcessIds([
      { processId: 24372, commandLine: 'chrome.exe --no-startup-window' },
      { processId: 29088, commandLine: 'chrome.exe --user-data-dir="C:\\openmcp\\master"' },
    ], 'C:\\Users\\user\\AppData\\Local\\Google\\Chrome\\User Data')).toEqual([24372])
  })

  test('reports only Chrome processes using the profile being copied', () => {
    expect(getBlockingChromeProfileProcessIds([
      { processId: 100, commandLine: 'chrome.exe --user-data-dir="C:\\relay\\profile"' },
      { processId: 101, commandLine: 'chrome.exe --user-data-dir="C:\\Users\\user\\AppData\\Local\\Google\\Chrome\\User Data"' },
    ], 'C:\\Users\\user\\AppData\\Local\\Google\\Chrome\\User Data')).toEqual([101])
  })

  test('treats a process with an unreadable command line as using the default profile', () => {
    expect(getBlockingChromeProfileProcessIds([{ processId: 12 }], 'C:\\Chrome\\User Data'))
      .toEqual([12])
  })
})
