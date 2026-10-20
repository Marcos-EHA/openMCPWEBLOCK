import { describe, expect, test } from 'bun:test'
import {
  applyCommandSuggestion,
  generateCommandSuggestions,
  isMcpCommandInput,
} from './commandSuggestions.js'

describe('MCP subcommand suggestions', () => {
  test('shows MCP actions as selectable command suggestions under /mcp', () => {
    const suggestions = generateCommandSuggestions('/mcp', [])

    expect(suggestions.map(item => item.displayText)).toContain('/mcp status')
    expect(suggestions.map(item => item.displayText)).toContain('/mcp sentinel')
    expect(suggestions.map(item => item.displayText)).toContain('/mcp recover')
    expect(suggestions.map(item => item.displayText)).toContain('/mcp set-mode web')
    expect(suggestions.map(item => item.displayText)).toContain('/mcp master-session')
    expect(suggestions.map(item => item.displayText)).toContain('/mcp master-session add --platform claude [nombre]')
    expect(suggestions.map(item => item.displayText)).toContain('/mcp master-session add --platform zai [nombre]')
    expect(suggestions.map(item => item.displayText)).toContain('/mcp master-session add --platform chatx [nombre]')
    expect(suggestions.map(item => item.displayText)).not.toContain('/mcp')
    expect(suggestions.every(item => Boolean(item.description))).toBe(true)
  })

  test('filters suggestions by the typed MCP subcommand', () => {
    const suggestions = generateCommandSuggestions('/mcp set-mode w', [])

    expect(suggestions.map(item => item.displayText)).toEqual(['/mcp set-mode web'])
  })

  test('shows Claude Master Session creation when completing the nested subcommand', () => {
    const suggestions = generateCommandSuggestions('/mcp master-session ', [])
    expect(suggestions.map(item => item.displayText))
      .toContain('/mcp master-session add --platform claude [nombre]')
    expect(suggestions.map(item => item.displayText))
      .toContain('/mcp master-session add --platform zai [nombre]')
    expect(suggestions.map(item => item.displayText))
      .toContain('/mcp master-session add --platform chatx [nombre]')
  })

  test('filters Z.ai Master Session creation by platform while completing its command', () => {
    const suggestions = generateCommandSuggestions('/mcp master-session add --platform z', [])

    expect(suggestions.map(item => item.displayText))
      .toEqual(['/mcp master-session add --platform zai [nombre]'])
  })

  test('filters ChatX Master Session creation by platform while completing its command', () => {
    const suggestions = generateCommandSuggestions('/mcp master-session add --platform cha', [])

    expect(suggestions.map(item => item.displayText))
      .toEqual(['/mcp master-session add --platform chatx [nombre]'])
  })

  test('filters nested Master Session suggestions while typing the command', () => {
    const suggestions = generateCommandSuggestions('/mcp master-session a', [])
    expect(suggestions.map(item => item.displayText))
      .toContain('/mcp master-session add --platform claude [nombre]')
    expect(suggestions.map(item => item.displayText))
      .toContain('/mcp master-session add --platform zai [nombre]')
    expect(suggestions.map(item => item.displayText))
      .toContain('/mcp master-session add --platform chatx [nombre]')
    expect(suggestions.map(item => item.displayText))
      .not.toContain('/mcp master-session status <id>')
  })

  test('accepting Claude Master Session suggestion inserts the command without submitting it', () => {
    const suggestion = generateCommandSuggestions('/mcp', [])
      .find(item => item.displayText === '/mcp master-session add --platform claude [nombre]')
    const changes: string[] = []
    const submitted: string[] = []

    expect(suggestion).toBeDefined()
    applyCommandSuggestion(
      suggestion!,
      true,
      [],
      value => changes.push(value),
      () => {},
      value => submitted.push(value),
    )

    expect(changes).toEqual(['/mcp master-session add --platform claude '])
    expect(submitted).toEqual([])
  })

  test('accepting Z.ai Master Session suggestion inserts its registration command without submitting it', () => {
    const suggestion = generateCommandSuggestions('/mcp', [])
      .find(item => item.displayText === '/mcp master-session add --platform zai [nombre]')
    const changes: string[] = []
    const submitted: string[] = []

    expect(suggestion).toBeDefined()
    applyCommandSuggestion(
      suggestion!,
      true,
      [],
      value => changes.push(value),
      () => {},
      value => submitted.push(value),
    )

    expect(changes).toEqual(['/mcp master-session add --platform zai '])
    expect(submitted).toEqual([])
  })

  test('accepting ChatX Master Session suggestion inserts its registration command without submitting it', () => {
    const suggestion = generateCommandSuggestions('/mcp', [])
      .find(item => item.displayText === '/mcp master-session add --platform chatx [nombre]')
    const changes: string[] = []
    const submitted: string[] = []

    expect(suggestion).toBeDefined()
    applyCommandSuggestion(
      suggestion!,
      true,
      [],
      value => changes.push(value),
      () => {},
      value => submitted.push(value),
    )

    expect(changes).toEqual(['/mcp master-session add --platform chatx '])
    expect(submitted).toEqual([])
  })

  test('accepting an actionable suggestion fills and submits the slash command', () => {
    const suggestion = generateCommandSuggestions('/mcp', [])
      .find(item => item.displayText === '/mcp status')
    const changes: string[] = []
    const submitted: string[] = []
    const cursors: number[] = []

    expect(suggestion).toBeDefined()
    applyCommandSuggestion(
      suggestion!,
      true,
      [],
      value => changes.push(value),
      offset => cursors.push(offset),
      value => submitted.push(value),
    )

    expect(changes).toEqual(['/mcp status'])
    expect(cursors).toEqual(['/mcp status'.length])
    expect(submitted).toEqual(['/mcp status'])
  })

  test('argument-taking subcommands complete without executing', () => {
    const suggestion = generateCommandSuggestions('/mcp', [])
      .find(item => item.displayText === '/mcp reconnect <servidor>')
    const submitted: string[] = []
    let changed = ''

    expect(suggestion).toBeDefined()
    applyCommandSuggestion(
      suggestion!,
      true,
      [],
      value => { changed = value },
      () => {},
      value => submitted.push(value),
    )

    expect(changed).toBe('/mcp reconnect ')
    expect(submitted).toEqual([])
  })

  test('recognizes /mcp and its subcommand input without matching longer commands', () => {
    expect(isMcpCommandInput('/mcp')).toBe(true)
    expect(isMcpCommandInput('/mcp status')).toBe(true)
    expect(isMcpCommandInput('/mcps')).toBe(false)
  })
})
