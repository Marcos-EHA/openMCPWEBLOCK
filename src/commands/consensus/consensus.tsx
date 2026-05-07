import React, { useEffect, useRef, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { getTaskOrchestrator, type ConsensusTask, type AgentConfig } from '../../services/consensus/TaskOrchestrator.js'
import { getConsensusEngine } from '../../services/consensus/ConsensusEngine.js'

/**
 * Command for orchestrating consensus-based tasks across multiple web agents
 */
export function ConsensusCommand({
  agentNames,
  taskDescription,
  onDone,
}: {
  agentNames: string[]
  taskDescription: string
  onDone: (result: string) => void
}): React.ReactElement {
  const [status, setStatus] = useState<string>('Initializing...')
  const didRun = useRef(false)

  useEffect(() => {
    if (didRun.current) return
    didRun.current = true

    const runConsensus = async () => {
      try {
        const orchestrator = getTaskOrchestrator()
        const consensusEngine = getConsensusEngine()

        // Create agent configs
        const platforms = ['chatgpt', 'gemini', 'grok'] as const
        const agents: AgentConfig[] = agentNames.map((name, idx) => ({
          name,
          platform: platforms[idx % platforms.length],
          model: platforms[idx % platforms.length] === 'chatgpt' ? 'gpt-4' : undefined,
        }))

        // Create task
        const task: ConsensusTask = {
          id: `task_${Date.now()}`,
          title: 'Consensus Task',
          description: taskDescription,
          agents,
          constraints: {
            maxAgents: agentNames.length,
            timeout: 300000, // 5 minutes
            minConfidence: 0.7,
          },
        }

        setStatus('Delegating task to agents...')

        // Delegate to all agents
        const taskState = await orchestrator.delegateTask(task)

        if (taskState.error) {
          onDone(`❌ Task failed: ${taskState.error}`)
          return
        }

        setStatus('Waiting for responses...')

        // Wait for responses
        const responses = await orchestrator.waitForResponses(task.id)

        if (responses.length === 0) {
          onDone('❌ No responses received from agents')
          return
        }

        setStatus('Generating consensus...')

        // Generate consensus
        const consensus = consensusEngine.generateConsensus(responses)
        orchestrator.completeTask(task.id)

        // Format output
        const lines = [
          '═══ CONSENSUS RESULT ═══',
          `Confidence: ${(consensus.confidence * 100).toFixed(1)}%`,
          '',
          consensus.consensusText,
          '',
          '═══ AGREEMENT ═══',
          ...consensus.agreement.map(
            a => `✓ ${a.point} (${a.agreeCount}/${a.agreeCount + a.neutralCount} agree)`
          ),
        ]

        if (consensus.divergences.length > 0) {
          lines.push('', '═══ DIVERGENCES ═══')
          consensus.divergences.forEach(d => {
            lines.push(`⚠️  ${d.topic} [${d.severity}]`)
            Object.entries(d.positions).forEach(([agent, position]) => {
              lines.push(`   ${agent}: ${position}`)
            })
          })
        }

        lines.push(
          '',
          '═══ METRICS ═══',
          `Agents: ${consensus.metadata.agentCount}`,
          `Processing time: ${consensus.metadata.processingTime}ms`,
          `Method: ${consensus.metadata.method}`
        )

        onDone(lines.join('\n'))
      } catch (error) {
        onDone(`❌ Consensus error: ${String(error)}`)
      }
    }

    void runConsensus()
  }, [agentNames, taskDescription, onDone])

  return (
    <Box flexDirection="column">
      <Text>{status}</Text>
    </Box>
  )
}

/**
 * Consensus command entry point
 */
export function call(
  _config: any,
  parts: string[],
  onDone: (output: string) => void
): React.ReactElement | null {
  if (parts[0] === 'consensus') {
    if (parts[1] === 'run') {
      const taskDescription = parts.slice(2).join(' ') || 'Analyze the following and provide consensus'
      const agents = parts[3]?.split(',') || ['Agent-1', 'Agent-2', 'Agent-3']

      return (
        <ConsensusCommand
          agentNames={agents}
          taskDescription={taskDescription}
          onDone={onDone}
        />
      )
    }

    if (parts[1] === 'help' || parts.length === 1) {
      onDone(`
/consensus - Multi-agent consensus orchestration

Usage:
  /consensus run "Your task description" agent1,agent2,agent3
  /consensus help

Examples:
  /consensus run "Analyze AI trends 2026" ChatGPT,Gemini,Grok
  /consensus run "Review this code" ChatGPT,Gemini
      `)
      return null
    }
  }

  return null
}

export const meta = {
  name: 'consensus',
  category: 'mcp',
  description: 'Run tasks on multiple web agents and generate consensus',
  isHidden: false,
}
