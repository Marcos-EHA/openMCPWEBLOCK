import { describe, expect, test } from 'bun:test'
import { parseMasterSessionAddArgs } from './masterSessionArgs.js'

describe('parseMasterSessionAddArgs', () => {
  test('creates a named Claude source when only its platform is specified', () => {
    expect(parseMasterSessionAddArgs('--platform claude', [])).toEqual({
      platformId: 'claude',
      name: 'Claude',
    })
  })

  test('chooses an unused default name when a Claude source already exists', () => {
    expect(parseMasterSessionAddArgs('--platform claude', [{ name: 'Claude' }])).toEqual({
      platformId: 'claude',
      name: 'Claude 2',
    })
  })

  test('creates a named Z.ai source when only its platform is specified', () => {
    expect(parseMasterSessionAddArgs('--platform zai', [])).toEqual({
      platformId: 'zai',
      name: 'Z.ai',
    })
  })

  test('creates a named ChatX source when only its platform is specified', () => {
    expect(parseMasterSessionAddArgs('--platform chatx', [])).toEqual({
      platformId: 'chatx',
      name: 'ChatX',
    })
  })

  test('preserves an explicit quoted name and defaults to ChatGPT', () => {
    expect(parseMasterSessionAddArgs('"Cuenta de trabajo"', [])).toEqual({
      platformId: 'chatgpt',
      name: 'Cuenta de trabajo',
    })
  })

  test('rejects unknown platforms and incomplete platform options', () => {
    expect(() => parseMasterSessionAddArgs('--platform gemini', [])).toThrow('chatgpt", "claude", "zai", or "chatx')
    expect(() => parseMasterSessionAddArgs('--platform', [])).toThrow('Usage:')
  })
})
