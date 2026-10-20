/**
 * CollaborationSurface.tsx - El lienzo que refleja el trabajo de agentes.
 */

import React, { useEffect, useState, useCallback } from 'react'
import { Box, Text } from '../ink.js'
import {
  CuratedContent,
  CuratedItem,
  CuratedAnomaly,
  SurfaceMode,
  SurfaceConfig,
  formatElapsed,
} from '../services/collaboration/types.js'
import { getSentinelCurator } from '../services/collaboration/SentinelCurator.js'
import type {
  CollaborationFinding,
  CollaborationRequest,
  CollaborationIssue,
  CollaborationSnapshot,
} from '../services/collaboration/CollaborationStore.js'

function StatusIcon({ status }: { status: CuratedItem['status'] }): React.ReactNode {
  switch (status) {
    case 'done': return <Text color='green'>✓</Text>
    case 'active': return <Text color='yellow'>◐</Text>
    case 'pending': return <Text color='gray'>○</Text>
    case 'blocked': return <Text color='red'>✗</Text>
    default: return <Text>?</Text>
  }
}

function ProgressBar({ progress, width }: { progress: number; width: number }): React.ReactNode {
  const filled = Math.round((progress / 100) * width)
  const empty = width - filled
  return (
    <Box>
      <Text color='cyan'>{'█'.repeat(filled)}</Text>
      <Text color='gray'>{'░'.repeat(empty)}</Text>
      <Text> {progress}%</Text>
    </Box>
  )
}

function ItemLine({ item, showPreview }: { item: CuratedItem; showPreview: boolean }): React.ReactNode {
  const elapsed = item.elapsedMs ? formatElapsed(item.elapsedMs) : ''
  return (
    <Box flexDirection='column' marginLeft={2}>
      <Box>
        <StatusIcon status={item.status} />
        <Text> </Text>
        <Text bold={item.status === 'active'} color={item.status === 'done' ? 'green' : item.status === 'blocked' ? 'red' : 'white'}>
          {item.title}
        </Text>
        {item.agentName && (
          <Text dimColor> — {item.agentName}{elapsed ? ` (${elapsed})` : ''}</Text>
        )}
      </Box>
      {showPreview && item.preview && (
        <Box marginLeft={4}>
          <Text dimColor italic>└─ {item.preview}</Text>
        </Box>
      )}
    </Box>
  )
}

function AnomalyBox({ anomaly }: { anomaly: CuratedAnomaly }): React.ReactNode {
  return (
    <Box borderStyle='round' borderColor='cyan' paddingX={1} marginX={1} flexDirection='column'>
      <Box>
        <Text color={anomaly.canAutoResolve ? 'cyan' : 'magenta'} bold>
          {anomaly.canAutoResolve ? '⚠️' : '🔴'} {anomaly.agentName}
        </Text>
        <Text> — {anomaly.userMessage}</Text>
      </Box>
      <Box marginTop={1}>
        {anomaly.availableActions.map(action => (
          <Box key={action.key} marginRight={2}>
            <Text backgroundColor='white' color='black' bold> [{action.key}] </Text>
            <Text> {action.label}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  )
}

function MessageLine({ text, isUser }: { text: string; isUser: boolean }): React.ReactNode {
  return (
    <Box marginLeft={1}>
      <Text color={isUser ? 'cyan' : 'magenta'} bold>{isUser ? '👤 ' : '💬 '}</Text>
      <Text wrap='wrap' color={isUser ? 'cyan' : 'white'}>{text}</Text>
    </Box>
  )
}

function DocumentMode({ content, config }: { content: CuratedContent; config: SurfaceConfig }): React.ReactNode {
  return (
    <Box flexDirection='column'>
      <Box marginBottom={1}>
        <Text bold color='cyan'>📄 {content.taskTitle ?? 'Documento'}</Text>
        <Text dimColor> (borrador evolutivo)</Text>
      </Box>
      {content.items.map(item => (
        <ItemLine key={item.id} item={item} showPreview={config.show.draftPreviews} />
      ))}
      <Box marginTop={1}>
        <ProgressBar progress={content.overallProgress} width={30} />
      </Box>
    </Box>
  )
}

function GraphMode({ content, config }: { content: CuratedContent; config: SurfaceConfig }): React.ReactNode {
  return (
    <Box flexDirection='column'>
      <Box marginBottom={1}>
        <Text bold color='cyan'>🕷️ {content.taskTitle ?? 'Investigacion'}</Text>
      </Box>
      <Box marginLeft={2}>
        <Text dimColor>┌─ Pregunta central</Text>
      </Box>
      {content.items.map(item => (
        <Box key={item.id} flexDirection='column' marginLeft={4}>
          <Box>
            <Text dimColor>│</Text>
            <StatusIcon status={item.status} />
            <Text> </Text>
            <Text bold={item.status === 'active'}>{item.title}</Text>
            {item.agentName && <Text dimColor> ({item.agentName})</Text>}
          </Box>
          {item.preview && config.show.draftPreviews && (
            <Box marginLeft={6}>
              <Text dimColor>└─ {item.preview}</Text>
            </Box>
          )}
        </Box>
      ))}
      <Box marginLeft={2}>
        <Text dimColor>└─ {content.summaryLine}</Text>
      </Box>
    </Box>
  )
}

function ProgressMode({ content }: { content: CuratedContent }): React.ReactNode {
  return (
    <Box flexDirection='column'>
      <Box marginBottom={1}>
        <Text bold color='cyan'>📊 {content.taskTitle ?? 'Progreso'}</Text>
      </Box>
      <ProgressBar progress={content.overallProgress} width={40} />
      <Box marginTop={1}>
        <Text>{content.summaryLine}</Text>
      </Box>
      <Box flexDirection='column' marginTop={1}>
        {content.items.map(item => (
          <Box key={item.id} marginLeft={2}>
            <StatusIcon status={item.status} />
            <Text> {item.title}</Text>
            {item.agentName && <Text dimColor> · {item.agentName}</Text>}
          </Box>
        ))}
      </Box>
    </Box>
  )
}

function ConversationMode({ content }: { content: CuratedContent }): React.ReactNode {
  const recentMessages = content.messages.slice(-8)
  return (
    <Box flexDirection='column'>
      <Box marginBottom={1}>
        <Text bold color='magenta'>💬 Conversacion</Text>
        {content.overallProgress > 0 && content.overallProgress < 100 && (
          <Text dimColor> · {content.overallProgress}% · {content.summaryLine}</Text>
        )}
      </Box>
      <Box flexDirection='column'>
        {recentMessages.map((msg) => {
          const isUser = msg.text.startsWith('Tu:')
          const cleanText = isUser ? msg.text.substring(3).trim() : msg.text
          return (
            <MessageLine key={msg.id} text={cleanText} isUser={isUser} />
          )
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>[p] pregunta · [v] volver · [c] configurar</Text>
      </Box>
    </Box>
  )
}

interface CanvasData {
  findings: CollaborationFinding[]
  pendingRequests: CollaborationRequest[]
  openIssues: CollaborationIssue[]
  snapshot: CollaborationSnapshot
  convergence: Array<{ topic: string; workerCount: number }>
  divergence: Array<{ topic: string }>
}

function CanvasMode({ data }: { data: CanvasData }): React.ReactNode {
  const { findings, pendingRequests, openIssues, snapshot, convergence, divergence } = data

  return (
    <Box flexDirection='column'>
      <Box marginBottom={1}>
        <Text bold color='green'>📋 Lienzo Curado</Text>
        <Text dimColor> · {snapshot.findings} hallazgos · {snapshot.activeWorkers} workers</Text>
      </Box>

      {convergence.length > 0 && (
        <Box flexDirection='column' marginBottom={1}>
          <Text color='green' bold>🤝 Convergencia</Text>
          {convergence.map((c, i) => (
            <Box key={i} marginLeft={2}>
              <Text color='green'>✓ {c.topic}</Text>
              <Text dimColor> — {c.workerCount} workers coinciden</Text>
            </Box>
          ))}
        </Box>
      )}

      {divergence.length > 0 && (
        <Box flexDirection='column' marginBottom={1}>
          <Text color='yellow' bold>⚡ Divergencia</Text>
          {divergence.map((d, i) => (
            <Box key={i} marginLeft={2}>
              <Text color='yellow'>? {d.topic}</Text>
              <Text dimColor> — perspectivas diferentes</Text>
            </Box>
          ))}
        </Box>
      )}

      {findings.length > 0 && (
        <Box flexDirection='column' marginBottom={1}>
          <Text bold>📌 Hallazgos ({findings.length})</Text>
          {findings.slice(-6).map(f => (
            <Box key={f.id} marginLeft={2} flexDirection='column'>
              <Box>
                <Text color={f.confidence === 'alta' ? 'green' : f.confidence === 'media' ? 'yellow' : 'gray'}>
                  {f.confidence === 'alta' ? '●' : f.confidence === 'media' ? '◐' : '○'}
                </Text>
                <Text dimColor> [{f.workerPlatform}] </Text>
                <Text bold>{f.topic}</Text>
              </Box>
              <Box marginLeft={4}>
                <Text dimColor wrap='wrap'>└─ {f.finding}</Text>
              </Box>
            </Box>
          ))}
        </Box>
      )}

      {pendingRequests.length > 0 && (
        <Box flexDirection='column' marginBottom={1}>
          <Text color='blue' bold>🔄 Solicitudes pendientes ({pendingRequests.length})</Text>
          {pendingRequests.map(r => (
            <Box key={r.id} marginLeft={2}>
              <Text color='blue'>[{r.workerPlatform}]</Text>
              <Text> {r.need}</Text>
            </Box>
          ))}
        </Box>
      )}

      {openIssues.length > 0 && (
        <Box flexDirection='column'>
          <Text color='red' bold>🚩 Problemas ({openIssues.length})</Text>
          {openIssues.map(issue => (
            <Box key={issue.id} marginLeft={2}>
              <Text color={issue.severity === 'alta' ? 'red' : 'yellow'}>
                {issue.severity === 'alta' ? '✗' : '⚠'}
              </Text>
              <Text> [{issue.workerPlatform}] {issue.description}</Text>
            </Box>
          ))}
        </Box>
      )}

      {findings.length === 0 && pendingRequests.length === 0 && openIssues.length === 0 && (
        <Box marginLeft={2}>
          <Text dimColor italic>Sin actividad en el lienzo aún...</Text>
        </Box>
      )}
    </Box>
  )
}

interface CollaborationSurfaceProps {
  config?: Partial<SurfaceConfig>
}

export function CollaborationSurface({ config }: CollaborationSurfaceProps): React.ReactNode {
  const curator = getSentinelCurator(config)
  const [content, setContent] = useState<CuratedContent>(curator.getContent())
  const [canvasData, setCanvasData] = useState<CanvasData | null>(null)

  useEffect(() => {
    const unsubscribe = curator.subscribe((newContent) => {
      setContent({ ...newContent })
    })
    return unsubscribe
  }, [curator])

  // Subscribe to CollaborationStore for canvas data
  useEffect(() => {
    let unsub: (() => void) | undefined
    import('../services/collaboration/CollaborationStore.js').then(({ collaborationStore }) => {
      const update = () => {
        setCanvasData({
          findings: collaborationStore.getFindings(),
          pendingRequests: collaborationStore.getPendingRequests(),
          openIssues: collaborationStore.getOpenIssues(),
          snapshot: collaborationStore.getSnapshot(),
          convergence: collaborationStore.getConvergence().map(c => ({ topic: c.topic, workerCount: c.workerCount })),
          divergence: collaborationStore.getDivergence().map(d => ({ topic: d.topic })),
        })
      }
      update() // initial load
      unsub = collaborationStore.subscribe(update)
    }).catch(() => {})
    return () => { if (unsub) unsub() }
  }, [])

  const renderMode = useCallback(() => {
    switch (content.mode) {
      case 'document':
        return <DocumentMode content={content} config={curator['config']} />
      case 'graph':
        return <GraphMode content={content} config={curator['config']} />
      case 'progress':
        return <ProgressMode content={content} />
      case 'conversation':
        return <ConversationMode content={content} />
      default:
        return <ProgressMode content={content} />
    }
  }, [content])

  const hasAnomalies = content.anomalies.length > 0

  return (
    <Box flexDirection='column' borderStyle='single' borderColor='cyan' paddingX={1}>
      <Box justifyContent='space-between' marginBottom={1}>
        <Box>
          <Text bold color={content.overallProgress === 100 ? 'green' : 'cyan'}>
            {content.overallProgress === 100 ? '✅' : content.overallProgress > 0 ? '🔄' : '⏳'}
          </Text>
          <Text bold> Colaboracion</Text>
          <Text dimColor> · {content.mode}</Text>
        </Box>
        <Box>
          <Text dimColor>{content.summaryLine}</Text>
        </Box>
      </Box>

      <Box flexDirection='column' minHeight={3}>
        {renderMode()}
      </Box>

      {canvasData && canvasData.snapshot.totalEntries > 0 && (
        <Box flexDirection='column' marginTop={1} borderStyle='single' borderColor={'green' as any} paddingX={1}>
          <CanvasMode data={canvasData} />
        </Box>
      )}

      {hasAnomalies && (
        <Box flexDirection='column' marginTop={1}>
          <Text bold color='red'>📥 Requiere tu atencion</Text>
          {content.anomalies.map(anomaly => (
            <AnomalyBox key={anomaly.id} anomaly={anomaly} />
          ))}
        </Box>
      )}

      {content.mode !== 'conversation' && content.messages.length > 0 && (
        <Box flexDirection='column' marginTop={1}>
          {content.messages.slice(-2).map(msg => {
            const isUser = msg.text.startsWith('Tu:')
            const cleanText = isUser ? msg.text.substring(3).trim() : msg.text
            return <MessageLine key={msg.id} text={cleanText} isUser={isUser} />
          })}
        </Box>
      )}

      <Box marginTop={1} justifyContent='space-between'>
        <Box>
          <Text dimColor>[v] modo · [p] preguntar · [c] config{hasAnomalies ? ' · [r/s/i/d] acciones' : ''}</Text>
        </Box>
        <Box>
          <Text dimColor>{new Date(content.updatedAt).toLocaleTimeString()}</Text>
        </Box>
      </Box>
    </Box>
  )
}

export default CollaborationSurface