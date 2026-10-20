import { describe, expect, test } from 'bun:test'
import { getLocalPlatformById } from '../../utils/localPlatforms.js'
import { waitForRunningLocalProcess } from './LocalInstanceDetector.js'

describe('local application startup detection', () => {
  test('waits for the actual application process before reporting startup success', async () => {
    const platform = getLocalPlatformById('antigravity')
    if (!platform) throw new Error('Antigravity platform configuration is missing')
    let checks = 0

    const process = await waitForRunningLocalProcess(platform, [0, 0], async () => {
      checks++
      return checks === 2 ? { pid: 1234, name: 'Antigravity.exe' } : undefined
    })

    expect(process).toEqual({ pid: 1234, name: 'Antigravity.exe' })
    expect(checks).toBe(2)
  })

  test('fails with a specific error when the application process never appears', async () => {
    const platform = getLocalPlatformById('antigravity')
    if (!platform) throw new Error('Antigravity platform configuration is missing')

    const error = await waitForRunningLocalProcess(platform, [0, 0], async () => undefined).then(
      () => undefined,
      reason => reason,
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(
      'Antigravity did not start: no running application process was detected after 2 checks (0ms).',
    )
  })
})
