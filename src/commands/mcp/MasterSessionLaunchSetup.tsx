import React, { useState } from 'react'
import { Box, Text } from '../../ink.js'
import { Spinner } from '../../components/Spinner.js'
import { SelectMulti } from '../../components/CustomSelect/index.js'
import { listMasterSessionSources } from '../../services/webRelay/session/MasterSessionRegistry.js'
import { openMasterSessionSource } from '../../services/webRelay/session/MasterSessionController.js'

type Props = {
  onComplete: (message: string) => void
}

export function MasterSessionLaunchSetup({ onComplete }: Props) {
  const sources = listMasterSessionSources()
  const [opening, setOpening] = useState(false)
  const [progress, setProgress] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  const openSelectedSources = async (sourceIds: string[]) => {
    if (sourceIds.length === 0) {
      setError('Select at least one Master Session source to open.')
      return
    }

    setOpening(true)
    setError(null)
    setProgress([])
    const opened: string[] = []
    const failures: string[] = []

    for (const sourceId of sourceIds) {
      const source = sources.find(candidate => candidate.id === sourceId)
      if (!source) {
        failures.push(`${sourceId}: source is no longer registered.`)
        continue
      }

      setProgress(current => [...current, `${source.name}: opening…`])
      try {
        const result = await openMasterSessionSource(sourceId)
        opened.push(
          `${result.sourceName} (${result.sourceId}): ${result.authenticated ? 'authenticated' : 'open; sign-in required'}, ` +
          `SuperAssistant ready, Master Session source ready, port ${result.debugPort}`,
        )
      } catch (caught) {
        failures.push(
          `${source.name} (${sourceId}): ${caught instanceof Error ? caught.message : String(caught)}`,
        )
      }
    }

    setOpening(false)
    const sections = [
      opened.length > 0 ? `Master Sessions opened/reused:\n${opened.join('\n')}` : '',
      failures.length > 0
        ? `Failures:\n${failures.join('\n')}\nIf a source still needs sign-in, complete sign-in in its open window, then retry with /mcp master-session open <id>.`
        : '',
      'Master-only launch does not create Relay profiles, add agents to the Web Relay pool, or change the active execution mode.',
    ].filter(Boolean)
    const message = sections.join('\n')
    onComplete(message)
  }

  if (opening) {
    return (
      <Box flexDirection="column" padding={1}>
        <Spinner />
        <Text>Opening selected Master Session profiles without launching Relays…</Text>
        {progress.map(item => <Text key={item}>{item}</Text>)}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">Launch Master Sessions only</Text>
      <Text>Select one or more persistent account profiles to open or reuse.</Text>
      <Text dimColor>Every opened Master Session is prepared and verified with SuperAssistant. This does not launch Relay windows, add Masters to the Web Relay pool, or change the active execution mode.</Text>
      {error && <Text color="red">{error}</Text>}
      {sources.length === 0
        ? <Text color="yellow">No Master Session sources are registered. Add one with /mcp master-session add &lt;name&gt;.</Text>
        : (
          <SelectMulti
            options={sources.map(source => ({
              label: `${source.name} (${source.platformId}, ${source.id})`,
              value: source.id,
              description: `Open or reuse this persistent ${source.platformId} account profile on port ${source.debugPort}.`,
            }))}
            onSubmit={values => { void openSelectedSources(values) }}
            onCancel={() => onComplete('Master-only launch cancelled')}
            submitButtonText="Open selected"
            visibleOptionCount={Math.min(8, sources.length)}
          />
        )}
      <Text dimColor>Space toggles a source · Tab moves to Open selected · Enter opens · Esc cancels</Text>
    </Box>
  )
}
