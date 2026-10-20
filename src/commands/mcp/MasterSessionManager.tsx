import React, { useEffect, useRef, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { Spinner } from '../../components/Spinner.js'
import { createMasterSessionSource, getMasterSessionSource, listMasterSessionSources } from '../../services/webRelay/session/MasterSessionRegistry.js'
import { openMasterSessionSource } from '../../services/webRelay/session/MasterSessionController.js'
import { sendMasterSessionPrompt } from '../../services/webRelay/session/MasterSessionConversation.js'
import { SessionBroker } from '../../services/webRelay/session/SessionBroker.js'
import { parseMasterSessionAddArgs } from '../../services/webRelay/session/masterSessionArgs.js'

type Props = {
  args: string
  onComplete: (message?: string) => void
}

export function MasterSessionManager({ args, onComplete }: Props) {
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const didComplete = useRef(false)

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try {
        const [action, ...rest] = args.trim().split(/\s+/).filter(Boolean)
        if (action === 'add') {
          const addArgs = args.trim().slice('add'.length).trim()
          const { name, platformId } = parseMasterSessionAddArgs(addArgs, listMasterSessionSources())
          const source = createMasterSessionSource(name, platformId)
          let result
          try {
            result = await openMasterSessionSource(source.id)
          } catch (caught) {
            throw new Error(
              `Master Session "${source.name}" (${source.id}) was created and its window remains open, ` +
              `but SuperAssistant could not be prepared: ${caught instanceof Error ? caught.message : String(caught)}. ` +
              `Complete sign-in if needed, then retry with /mcp master-session open ${source.id}.`,
            )
          }
          if (cancelled) return
          setMessage(
            `Creada la fuente ${source.platformId} "${result.sourceName}" (${result.sourceId}) con SuperAssistant listo en el puerto ${result.debugPort}. ` +
            `Inicia sesión en esa ventana; luego ejecuta /mcp master-session status ${result.sourceId}.`,
          )
          return
        }

        if (action === 'open' && rest[0]) {
          const result = await openMasterSessionSource(rest[0])
          if (cancelled) return
          setMessage(
            `Abierta la fuente ${getMasterSessionSource(result.sourceId).platformId} "${result.sourceName}" ` +
            `(${result.sourceId}) con SuperAssistant listo en el puerto ${result.debugPort}.`,
          )
          return
        }

        if (action === 'ask') {
          const request = args.trim().slice('ask'.length).trim()
          const separator = request.search(/\s/)
          if (separator < 0) {
            throw new Error('Usage: /mcp master-session ask <id> <prompt>')
          }
          const sourceId = request.slice(0, separator)
          const prompt = request.slice(separator).trim()
          if (!prompt) throw new Error('Usage: /mcp master-session ask <id> <prompt>')
          const source = getMasterSessionSource(sourceId)
          const response = await sendMasterSessionPrompt(sourceId, prompt)
          if (cancelled) return
          setMessage(`Respuesta de Master Session "${source.name}" (${source.id}):\n${response}`)
          return
        }

        if (action === 'status' && rest[0]) {
          const status = await SessionBroker.getInstance().getMasterStatus(rest[0])
          const source = listMasterSessionSources().find(item => item.id === rest[0])
          if (!source) throw new Error(`Unknown Master Session source "${rest[0]}".`)
          if (cancelled) return
          setMessage(
            `${source.name} (${source.id}, ${source.platformId}): ${status.active ? 'Chrome abierto' : 'Chrome cerrado'}, ` +
            `${status.hasValidSession ? 'cuenta autenticada' : status.reason ?? 'requiere inicio de sesión'}; ` +
            `puerto ${status.debugPort ?? source.debugPort}.`,
          )
          return
        }

        const sources = listMasterSessionSources()
        const statuses = await Promise.all(sources.map(async source => ({
          source,
          status: await SessionBroker.getInstance().getMasterStatus(source.id),
        })))
        if (cancelled) return
        setMessage(statuses.length === 0
          ? 'No hay fuentes Master Session registradas.'
          : statuses.map(({ source, status }) =>
            `${source.name} (${source.id}, ${source.platformId}): ${status.active ? 'abierta' : 'cerrada'}, ` +
            `${status.hasValidSession ? 'autenticada' : status.reason ?? 'requiere inicio de sesión'}, puerto ${status.debugPort ?? source.debugPort}`,
          ).join('\n'))
      } catch (caught) {
        if (cancelled) return
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    }
    void run()
    return () => { cancelled = true }
  }, [args])

  useEffect(() => {
    if (didComplete.current) return
    if (message || error) onComplete(error ? `Error: ${error}` : message ?? '')
    if (message || error) didComplete.current = true
  }, [error, message, onComplete])

  if (error) {
    return <Box flexDirection="column" padding={1}><Text color="red">Master Session error: {error}</Text></Box>
  }
  if (message) {
    return <Box flexDirection="column" padding={1}><Text>{message}</Text></Box>
  }
  return <Box padding={1}><Spinner /><Text> Checking Master Session sources…</Text></Box>
}
