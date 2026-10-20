import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { Box, Text } from '../../ink.js'
import {
  getWebRelayActivitySnapshot,
  subscribeToWebRelayActivity,
} from '../../services/webRelay/WebRelayActivityStore.js'

const ACTIVE_BORDER_COLORS = ['cyan', 'blue', 'magenta'] as const

function statusColor(status: string) {
  if (status === 'complete') return 'success'
  if (status === 'error' || status === 'failed') return 'error'
  if (status === 'partial') return 'warning'
  if (status === 'working' || status === 'running') return 'cyan'
  return 'dim'
}

function oneLine(text: string | undefined): string | undefined {
  if (!text) return undefined
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length > 110 ? `${compact.slice(0, 107)}…` : compact
}

export function WebRelayActivityPanel(): React.ReactNode {
  const activities = useSyncExternalStore(
    subscribeToWebRelayActivity,
    getWebRelayActivitySnapshot,
    getWebRelayActivitySnapshot,
  )
  const [animationFrame, setAnimationFrame] = useState(0)
  const latest = activities[0]
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>()
  const selectedTask = activities.find(task => task.taskId === selectedTaskId) ?? latest
  const isRunning = selectedTask?.status === 'running'

  useEffect(() => {
    if (!isRunning) return
    const timer = setInterval(() => {
      setAnimationFrame(frame => (frame + 1) % ACTIVE_BORDER_COLORS.length)
    }, 180)
    return () => clearInterval(timer)
  }, [isRunning])

  useEffect(() => {
    if (latest) setSelectedTaskId(latest.taskId)
  }, [latest?.taskId])

  useEffect(() => {
    if (selectedTaskId && !activities.some(task => task.taskId === selectedTaskId)) {
      setSelectedTaskId(latest?.taskId)
    }
  }, [activities, latest?.taskId, selectedTaskId])

  if (!selectedTask) return null

  const borderColor = selectedTask.status === 'running' ? ACTIVE_BORDER_COLORS[animationFrame]! : statusColor(selectedTask.status)
  const statusLabel = selectedTask.status === 'running'
    ? 'en curso'
    : selectedTask.status === 'complete'
      ? 'completa'
      : selectedTask.status === 'partial'
        ? 'parcial'
        : 'fallida'
  const selectedTaskIndex = activities.findIndex(task => task.taskId === selectedTask.taskId)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1} marginX={1}>
      <Text bold color={borderColor}>
        Lienzo de agentes · {statusLabel} · {selectedTask.agents.length} instancias
      </Text>
      <Text dimColor wrap="truncate">Petición: {oneLine(selectedTask.prompt)}</Text>
      {selectedTask.agents.map(agent => {
        const working = agent.status === 'working'
        const cardColor = working ? ACTIVE_BORDER_COLORS[animationFrame]! : statusColor(agent.status)
        const roleLabel = agent.role === 'coordinator' ? 'Coordinador' : 'Worker'
        const detail = oneLine(agent.error ?? agent.response ?? agent.task)
        return (
          <Box key={agent.agentId} flexDirection="column" borderStyle="round" borderColor={cardColor} paddingX={1}>
            <Text color={cardColor} wrap="truncate">
              {roleLabel} · {agent.agentId} · {agent.stage}
            </Text>
            {detail && <Text dimColor wrap="truncate">{detail}</Text>}
          </Box>
        )
      })}
      <Box flexDirection="row" gap={1}>
        <Text
          color={selectedTaskIndex < activities.length - 1 ? 'cyan' : 'dim'}
          onClick={() => {
            const previous = activities[selectedTaskIndex + 1]
            if (previous) setSelectedTaskId(previous.taskId)
          }}
        >
          [Anterior]
        </Text>
        <Text dimColor>{selectedTaskIndex + 1}/{activities.length} · {selectedTask.startedAt ? new Date(selectedTask.startedAt).toLocaleTimeString() : ''}</Text>
        <Text
          color={selectedTaskIndex > 0 ? 'cyan' : 'dim'}
          onClick={() => {
            const next = activities[selectedTaskIndex - 1]
            if (next) setSelectedTaskId(next.taskId)
          }}
        >
          [Siguiente]
        </Text>
      </Box>
      <Text dimColor>{activities.length} tareas retenidas en esta sesión; respuestas completas en el transcript.</Text>
      <Text dimColor>
        El borde animado indica una solicitud activa; el relay aún no expone cada llamada interna de SuperAssistant.
      </Text>
      {selectedTask.error && <Text color="error">{selectedTask.error}</Text>}
    </Box>
  )
}
