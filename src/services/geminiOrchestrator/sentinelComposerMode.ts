import { useSyncExternalStore } from 'react'

export type ComposerDestination = 'assistant' | 'sentinel' | 'web-agent'

export function getComposerDestinationPlaceholder(destination: ComposerDestination): string | undefined {
  if (destination === 'sentinel') return 'Escribe un mensaje para Sentinel (Gemini)…'
  if (destination === 'web-agent') return 'Escribe una tarea para el equipo Web…'
  return undefined
}

let composerDestination: ComposerDestination = 'assistant'
const listeners = new Set<() => void>()

export function isSentinelComposerMode(): boolean {
  return composerDestination === 'sentinel'
}

export function getComposerDestination(): ComposerDestination {
  return composerDestination
}

export function setSentinelComposerMode(enabled: boolean): void {
  setComposerDestination(enabled ? 'sentinel' : 'assistant')
}

export function setComposerDestination(destination: ComposerDestination): void {
  if (composerDestination === destination) return
  composerDestination = destination
  for (const listener of listeners) listener()
}

export function setWebAgentComposerMode(enabled: boolean): void {
  setComposerDestination(enabled ? 'web-agent' : 'assistant')
}

export function useComposerDestination(): ComposerDestination {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getComposerDestination,
    () => 'assistant',
  )
}

export function useSentinelComposerMode(): boolean {
  return useComposerDestination() === 'sentinel'
}

export function useWebAgentComposerMode(): boolean {
  return useComposerDestination() === 'web-agent'
}
