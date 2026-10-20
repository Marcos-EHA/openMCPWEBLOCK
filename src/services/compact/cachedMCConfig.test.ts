import { describe, expect, test } from 'bun:test'
import { getCachedMCConfig } from './cachedMCConfig.js'

describe('cached microcompact config adapter', () => {
  test('reuses the configuration contract provided by the microcompact implementation', () => {
    expect(getCachedMCConfig()).toBeNull()
  })
})
