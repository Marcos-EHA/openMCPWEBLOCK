import { describe, expect, test } from 'bun:test'
import { getMCPPort } from './mcpPort.js'

describe('getMCPPort', () => {
  test('defaults to the established MCP port', () => {
    expect(getMCPPort(undefined)).toBe(3006)
    expect(getMCPPort('')).toBe(3006)
  })

  test('accepts a valid port override', () => {
    expect(getMCPPort('3307')).toBe(3307)
  })

  test('rejects invalid or out-of-range overrides', () => {
    for (const value of ['abc', '0', '65536', '3006.5']) {
      expect(() => getMCPPort(value)).toThrow(/Invalid MCP_PORT/)
    }
  })
})
