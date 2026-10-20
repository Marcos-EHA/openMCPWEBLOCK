/**
 * LocalInteractionBridge — Dispatches prompts from the Workspace WebUI
 * to local AI instances and returns their responses.
 *
 * This bridge enables the WebUI to act as the central control point:
 * the user sends a prompt from the Workspace input bar, the bridge
 * delivers it to the target local instance, and the response flows
 * back into the Workspace chat via WorkspaceParticipants.
 *
 * Interaction methods per platform:
 * - claude-code:     CLI pipe (`claude -p "..." --output-format text`)
 * - claude-desktop:  MCP-based task polling (already registered as MCP client)
 * - vscode:          Terminal command injection / extension bridge
 * - antigravity:     direct CDP interaction with an explicitly selected chat
 *
 * Design: each dispatch is async and resolves with the response text.
 * The caller (integration.ts) handles auto-claiming and completing
 * the WorkspaceParticipant task lifecycle.
 */

import { execFile } from 'child_process'
import { getLocalInstanceManager, type LocalInstance } from './LocalInstanceManager.js'
import { getLocalPlatformById } from '../../utils/localPlatforms.js'

export interface LocalPromptResult {
  ok: boolean
  response?: string
  error?: string
  delivery?: 'submitted' | 'unknown'
  model?: string
  conversationId?: string
  responseStatus?: 'received' | 'pending'
  verificationError?: string
  /** Milliseconds the interaction took */
  durationMs: number
}

/**
 * Send a prompt to a local instance and wait for the response.
 *
 * The method chosen depends on the platform: Claude Code uses its CLI,
 * Antigravity uses the selected local chat through CDP, and other local apps
 * retain their existing bridge behavior.
 */
export async function sendLocalPrompt(
  instanceId: string,
  prompt: string,
  conversationId?: string,
  expectedModel?: string,
): Promise<LocalPromptResult> {
  const manager = getLocalInstanceManager()
  const instance = manager.getInstance(instanceId)
  if (!instance) {
    return { ok: false, error: `Instancia local "${instanceId}" no encontrada.`, durationMs: 0 }
  }
  if (instance.status !== 'ready') {
    return { ok: false, error: `Instancia "${instanceId}" no está lista (estado: ${instance.status}).`, durationMs: 0 }
  }

  const platform = getLocalPlatformById(instance.platformId)
  if (!platform) {
    return { ok: false, error: `Plataforma "${instance.platformId}" no reconocida.`, durationMs: 0 }
  }

  const start = Date.now()

  switch (platform.id) {
    case 'claude-code':
      return sendViaClaudeCodeCLI(instance, prompt, start)

    case 'claude-desktop':
      // Claude Desktop receives tasks via MCP polling; the task stays pending
      // until the app claims it via workspace_claim_tasks tool.
      return {
        ok: true,
        response: `[Prompt enviado como tarea pendiente a Claude Desktop]\nClaude Desktop necesita tener el servidor MCP de OpenMCPWEBLOCK configurado (http://localhost:3006/mcp) y reclamar tareas vía workspace_claim_tasks.\nSi Claude Desktop ya tiene MCP configurado, la tarea aparecerá automáticamente.`,
        durationMs: Date.now() - start,
      }

    case 'vscode':
      return sendViaVSCodeBridge(instance, prompt, start)

    case 'antigravity':
      if (!conversationId) {
        return {
          ok: false,
          error: 'Selecciona primero una conversación de Antigravity (o “Nuevo chat”) en el panel de historial.',
          durationMs: Date.now() - start,
        }
      }
      if (!expectedModel?.trim()) {
        return {
          ok: false,
          error: 'Abre la conversación desde el historial para verificar el modelo antes de enviar.',
          durationMs: Date.now() - start,
        }
      }
      try {
        const { sendAntigravityPrompt } = await import('./AntigravityController.js')
        const sent = await sendAntigravityPrompt(instance, conversationId, prompt, expectedModel)
        return {
          ok: true,
          ...(sent.response ? { response: sent.response } : {}),
          delivery: sent.delivery,
          model: sent.model,
          conversationId: sent.conversationId,
          responseStatus: sent.responseStatus,
          ...(sent.verificationError ? { verificationError: sent.verificationError } : {}),
          durationMs: Date.now() - start,
        }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - start,
        }
      }

    default:
      return { ok: false, error: `Plataforma "${platform.id}" no tiene método de interacción implementado.`, durationMs: Date.now() - start }
  }
}

/**
 * Execute a prompt via Claude Code CLI.
 * Uses `claude -p "prompt" --output-format text` for direct interaction.
 */
async function sendViaClaudeCodeCLI(
  instance: LocalInstance,
  prompt: string,
  startTime: number,
): Promise<LocalPromptResult> {
  return new Promise(resolve => {
    const executablePath = instance.executablePath || 'claude'
    const args = ['-p', prompt, '--output-format', 'text']

    // Add working directory if available
    if (instance.workingDirectory) {
      args.push('--cwd', instance.workingDirectory)
    }

    const child = execFile(executablePath, args, {
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024, // 1MB max response
      timeout: 5 * 60 * 1000, // 5 minute timeout
      cwd: instance.workingDirectory || undefined,
    }, (error, stdout, stderr) => {
      const durationMs = Date.now() - startTime
      if (error) {
        resolve({
          ok: false,
          error: `Claude Code error: ${error.message}${stderr ? `\n${stderr}` : ''}`,
          durationMs,
        })
        return
      }
      resolve({
        ok: true,
        response: stdout.trim() || '(respuesta vacía)',
        durationMs,
      })
    })
  })
}

/**
 * Send a prompt to VS Code via task-based bridge.
 *
 * VS Code doesn't have a CLI prompt mode like Claude Code.
 * The prompt is registered as a pending workspace task that can be claimed
 * by an MCP-connected extension (Copilot, Cline, Continue, etc.).
 *
 * The user sees clear feedback about what happened and what they need.
 */
async function sendViaVSCodeBridge(
  instance: LocalInstance,
  prompt: string,
  startTime: number,
): Promise<LocalPromptResult> {
  // The prompt is dispatched as a workspace task.
  // An MCP extension in VS Code must call workspace_claim_tasks to pick it up.
  const truncatedPrompt = prompt.length > 100 ? prompt.slice(0, 100) + '...' : prompt
  return {
    ok: true,
    response: `[Prompt registrado como tarea del Workspace para VS Code]\n` +
      `Prompt: "${truncatedPrompt}"\n` +
      `Para que VS Code procese este prompt, necesitas una extensión MCP conectada a http://localhost:3006/mcp que reclame tareas (workspace_claim_tasks).\n` +
      `Extensiones compatibles: GitHub Copilot (con MCP), Cline, Continue, o cualquier extensión que soporte MCP.`,
    durationMs: Date.now() - startTime,
  }
}

/**
 * Check if a local instance supports direct (synchronous) prompt execution.
 * Returns true if sendLocalPrompt will actually execute the prompt and wait
 * for a response, false if it will only assign a pending task.
 */
export function supportsDirectExecution(platformId: string): boolean {
  return platformId === 'claude-code'
}

/**
 * Get a human-readable description of the interaction method for a platform.
 */
export function getInteractionMethod(platformId: string): string {
  switch (platformId) {
    case 'claude-code':
      return 'Ejecución directa vía CLI'
    case 'claude-desktop':
      return 'Tarea vía MCP (Claude Desktop reclama)'
    case 'vscode':
      return 'Tarea vía MCP (extensión IDE reclama)'
    case 'antigravity':
      return 'Control directo de Antigravity (chat local)'
    default:
      return 'No disponible'
  }
}
