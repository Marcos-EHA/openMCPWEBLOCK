import { describe, expect, test } from 'bun:test'
import { shouldRoutePromptToSentinel, shouldRoutePromptToWebAgent } from './sentinelRouting.js'

describe('shouldRoutePromptToSentinel', () => {
  test('routes ordinary composer messages to Sentinel when that destination is active', () => {
    expect(shouldRoutePromptToSentinel({
      sentinelMode: true,
      isLeader: true,
      isSubmittingSlashCommand: false,
      input: '¿Cómo configuro una instancia?',
    })).toBe(true)
  })

  test('keeps slash commands on the normal command path', () => {
    expect(shouldRoutePromptToSentinel({
      sentinelMode: true,
      isLeader: true,
      isSubmittingSlashCommand: false,
      input: '  /mcp status',
    })).toBe(false)
  })

  test('does not intercept web/API prompts when Sentinel mode is off', () => {
    expect(shouldRoutePromptToSentinel({
      sentinelMode: false,
      isLeader: true,
      isSubmittingSlashCommand: false,
      input: 'Explícame el estado',
    })).toBe(false)
  })

  test('does not intercept prompts directed to an in-process teammate', () => {
    expect(shouldRoutePromptToSentinel({
      sentinelMode: true,
      isLeader: false,
      isSubmittingSlashCommand: false,
      input: 'Revisa el archivo',
    })).toBe(false)
  })
})

describe('shouldRoutePromptToWebAgent', () => {
  test('routes ordinary messages to the coordinator in Web Agent mode', () => {
    expect(shouldRoutePromptToWebAgent({
      webAgentMode: true,
      isLeader: true,
      isSubmittingSlashCommand: false,
      input: 'Investiga cómo se inicializa el proyecto',
    })).toBe(true)
  })

  test('leaves slash commands on their existing local command path', () => {
    expect(shouldRoutePromptToWebAgent({
      webAgentMode: true,
      isLeader: true,
      isSubmittingSlashCommand: false,
      input: '  /mcp status',
    })).toBe(false)
  })

  test('does not route teammate-directed or empty messages', () => {
    expect(shouldRoutePromptToWebAgent({
      webAgentMode: true,
      isLeader: false,
      isSubmittingSlashCommand: false,
      input: 'Revisa el archivo',
    })).toBe(false)
    expect(shouldRoutePromptToWebAgent({
      webAgentMode: true,
      isLeader: true,
      isSubmittingSlashCommand: false,
      input: '  ',
    })).toBe(false)
  })
})
