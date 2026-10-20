import { afterEach, describe, expect, test } from 'bun:test'
import {
  getComposerDestinationPlaceholder,
  getComposerDestination,
  isSentinelComposerMode,
  setComposerDestination,
  setSentinelComposerMode,
  setWebAgentComposerMode,
} from './sentinelComposerMode.js'

afterEach(() => setComposerDestination('assistant'))

describe('Sentinel composer destination', () => {
  test('shows the active destination as the input placeholder', () => {
    expect(getComposerDestinationPlaceholder('sentinel')).toBe('Escribe un mensaje para Sentinel (Gemini)…')
    expect(getComposerDestinationPlaceholder('web-agent')).toBe('Escribe una tarea para el equipo Web…')
    expect(getComposerDestinationPlaceholder('assistant')).toBeUndefined()
  })

  test('can be switched on and back to web mode', () => {
    setSentinelComposerMode(true)
    expect(isSentinelComposerMode()).toBe(true)
    setSentinelComposerMode(false)
    expect(isSentinelComposerMode()).toBe(false)
  })

  test('setting the same destination repeatedly is safe', () => {
    setSentinelComposerMode(true)
    setSentinelComposerMode(true)
    expect(isSentinelComposerMode()).toBe(true)
  })

  test('selects Web Agent as a distinct composer destination', () => {
    setWebAgentComposerMode(true)
    expect(getComposerDestination()).toBe('web-agent')
    expect(isSentinelComposerMode()).toBe(false)
    setSentinelComposerMode(true)
    expect(getComposerDestination()).toBe('sentinel')
  })
})
