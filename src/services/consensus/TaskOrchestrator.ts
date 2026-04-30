import type { ConnectedMCPServer } from '../mcp/types.js'

/**
 * Agent configuration for web-based IA
 */
export interface AgentConfig {
  name: string
  platform: 'chatgpt' | 'gemini' | 'grok' | 'perplexity' | 'deepseek'
  windowHandle?: string
  instructions?: string
  temperature?: number
  model?: string
}

/**
 * Task definition for consensus-based execution
 */
export interface ConsensusTask {
  id: string
  title: string
  description: string
  agents: AgentConfig[]
  context?: Record<string, any>
  constraints?: {
    maxAgents?: number
    timeout?: number
    minConfidence?: number
  }
}

/**
 * Individual agent response
 */
export interface AgentResponse {
  agentName: string
  platform: string
  response: string
  timestamp: number
  metadata?: {
    model?: string
    tokens?: number
    latency?: number
    confidence?: number
  }
}

/**
 * Orchestrator task state
 */
export interface TaskState {
  taskId: string
  status: 'pending' | 'running' | 'collecting' | 'processing' | 'complete' | 'error'
  responses: AgentResponse[]
  startTime: number
  endTime?: number
  error?: string
}

/**
 * Task Orchestrator - Manages delegation of tasks to multiple web agents
 * 
 * This class handles:
 * - Task division and distribution
 * - Agent pool management
 * - Response collection
 * - Memory persistence (via claude-mem)
 */
export class TaskOrchestrator {
  private taskStates: Map<string, TaskState> = new Map()
  private mcpClients: ConnectedMCPServer[] = []
  private readonly maxConcurrentTasks = 3

  constructor() {
    this.refreshMcpClients()
  }

  /**
   * Refresh connected MCP clients
   */
  private refreshMcpClients(): void {
    // TODO: wire this to the MCP state manager or app state that tracks connected servers.
    // For now, keep a placeholder until the integration layer is available.
    this.mcpClients = []
  }

  /**
   * Delegate a task to multiple agents
   */
  async delegateTask(task: ConsensusTask): Promise<TaskState> {
    const taskState: TaskState = {
      taskId: task.id,
      status: 'pending',
      responses: [],
      startTime: Date.now(),
    }

    this.taskStates.set(task.id, taskState)

    try {
      // Save to claude-mem for persistence
      await this.saveTaskToMemory(task)

      // Update status
      taskState.status = 'running'

      // Execute on all agents in parallel
      const promises = task.agents.map(agent =>
        this.executeOnAgent(agent, task).catch(err => ({
          agentName: agent.name,
          platform: agent.platform,
          response: `Error: ${String(err)}`,
          timestamp: Date.now(),
          metadata: { error: String(err) },
        }))
      )

      const responses = await Promise.all(promises)
      taskState.responses = responses.filter((r): r is AgentResponse => r !== undefined)
      taskState.status = 'collecting'

      return taskState
    } catch (error) {
      taskState.status = 'error'
      taskState.error = String(error)
      taskState.endTime = Date.now()
      return taskState
    }
  }

  /**
   * Execute task on a single agent
   */
  private async executeOnAgent(agent: AgentConfig, task: ConsensusTask): Promise<AgentResponse> {
    const startTime = Date.now()

    // TODO: This would connect to SuperAssistant and relay to the browser
    // For now, return placeholder
    return {
      agentName: agent.name,
      platform: agent.platform,
      response: `Response from ${agent.name} for task: ${task.title}`,
      timestamp: Date.now(),
      metadata: {
        model: agent.model,
        latency: Date.now() - startTime,
        confidence: 0.8,
      },
    }
  }

  /**
   * Save task to claude-mem for persistence
   */
  private async saveTaskToMemory(task: ConsensusTask): Promise<void> {
    // Find claude-mem client
    const claudeMemClient = this.mcpClients.find(c => c.name === 'claude-mem')
    if (!claudeMemClient) {
      console.warn('claude-mem not available for memory persistence')
      return
    }

    try {
      // Call claude-mem tool to save task context
      // TODO: Implement when we have tool execution working
      console.log(`Task ${task.id} saved to memory`)
    } catch (error) {
      console.warn(`Failed to save task to memory: ${String(error)}`)
    }
  }

  /**
   * Get task state by ID
   */
  getTaskState(taskId: string): TaskState | undefined {
    return this.taskStates.get(taskId)
  }

  /**
   * Get all active tasks
   */
  getActiveTasks(): TaskState[] {
    return Array.from(this.taskStates.values()).filter(
      t => t.status === 'running' || t.status === 'pending' || t.status === 'collecting'
    )
  }

  /**
   * Wait for all responses to a task
   */
  async waitForResponses(
    taskId: string,
    timeout: number = 300000 // 5 minutes default
  ): Promise<AgentResponse[]> {
    const startTime = Date.now()
    const taskState = this.getTaskState(taskId)

    if (!taskState) {
      throw new Error(`Task ${taskId} not found`)
    }

    // Poll for responses
    while (Date.now() - startTime < timeout) {
      if (taskState.status === 'collecting' || taskState.status === 'complete') {
        return taskState.responses
      }

      await new Promise(resolve => setTimeout(resolve, 1000))
    }

    throw new Error(`Timeout waiting for task ${taskId} responses`)
  }

  /**
   * Mark task as complete
   */
  completeTask(taskId: string): void {
    const taskState = this.taskStates.get(taskId)
    if (taskState) {
      taskState.status = 'complete'
      taskState.endTime = Date.now()
    }
  }

  /**
   * Get metrics for a task
   */
  getTaskMetrics(taskId: string): {
    duration: number
    agentCount: number
    averageLatency: number
    successRate: number
  } | null {
    const taskState = this.taskStates.get(taskId)
    if (!taskState || !taskState.endTime) {
      return null
    }

    const duration = taskState.endTime - taskState.startTime
    const agentCount = taskState.responses.length
    const averageLatency =
      taskState.responses.reduce((sum, r) => sum + (r.metadata?.latency ?? 0), 0) / agentCount || 0
    const successRate = taskState.responses.filter(r => !r.metadata?.error).length / agentCount

    return { duration, agentCount, averageLatency, successRate }
  }
}

// Singleton instance
let orchestrator: TaskOrchestrator | null = null

/**
 * Get or create TaskOrchestrator instance
 */
export function getTaskOrchestrator(): TaskOrchestrator {
  if (!orchestrator) {
    orchestrator = new TaskOrchestrator()
  }
  return orchestrator
}
