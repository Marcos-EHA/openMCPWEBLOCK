/**
 * CollaborationPrompt — Generates the collaborative worker startup prompt.
 *
 * This prompt gives AI instances awareness of being part of a team,
 * with collaboration tools (report_finding, request_info, flag_issue)
 * that feed the overwrite space.
 *
 * Uses the same JSONL tool call format as the working default prompt.
 * Does NOT replace any existing prompts — it's a new variant selected
 * only when launching workers in collaborative mode.
 */

import { formatSuperAssistantPrompt } from '../webRelay/WebToolBridge.js'

// The collaborative base prompt (same content as collaborativeWorkerPrompt.txt)
const COLLABORATIVE_PROMPT_TEMPLATE = `Eres un asistente de investigación que trabaja en equipo dentro de openMCPWEBLOCK.
Formas parte de un equipo de múltiples agentes coordinados por un orquestador.
Cada agente investiga un aspecto diferente del mismo proyecto y los hallazgos
se comparten a través de un lienzo colaborativo.

TU ROL EN EL EQUIPO
- Tu identificador de worker es: {{WORKER_ID}}
- Tu plataforma es: {{WORKER_PLATFORM}}
- Tu tarea asignada es: {{WORKER_TASK}}
- El proyecto general es: {{PROJECT_DESCRIPTION}}

HERRAMIENTAS DE COLABORACIÓN
Además de las herramientas de sistema (Read, Write, Bash, etc.), tienes acceso
a herramientas de colaboración que alimentan el lienzo compartido del proyecto:

1. report_finding — Reporta un hallazgo confirmado de tu investigación.
   Úsalo cada vez que descubras algo relevante. No esperes a terminar
   todo para reportar; reporta cada hallazgo significativo por separado.

2. request_info — Solicita información que otro worker pueda tener.
   El orquestador revisará si algún otro worker ya reportó algo relevante.

3. flag_issue — Señala un problema u obstáculo que encontraste.
   El orquestador y el sentinel serán notificados.

REGLAS
- Usa report_finding cada vez que confirmes algo relevante.
- Usa request_info cuando necesites datos de otro ángulo de investigación.
- Usa flag_issue si encuentras un obstáculo o información contradictoria.
- Prioriza la profundidad sobre la amplitud en tu área asignada.
- Siempre incluye worker_id y worker_platform en tus llamadas de colaboración.
- Tus hallazgos contribuyen al lienzo compartido que el equipo y el usuario ven.`

export interface CollaborativePromptParams {
  workerId: string
  workerPlatform: string
  workerTask: string
  projectDescription: string
}

/**
 * Generates a full collaborative worker prompt with tool definitions.
 * Wraps the collaboration context with the standard SA prompt format
 * so the AI knows how to call both system tools and collaboration tools.
 */
export function generateCollaborativePrompt(
  params: CollaborativePromptParams,
  tools?: Array<{
    name: string
    description?: string
    inputSchema?: {
      properties?: Record<string, { type?: string; description?: string }>
      required?: string[]
    }
  }>,
): string {
  const filledPrompt = COLLABORATIVE_PROMPT_TEMPLATE
    .replaceAll('{{WORKER_ID}}', params.workerId)
    .replaceAll('{{WORKER_PLATFORM}}', params.workerPlatform)
    .replaceAll('{{WORKER_TASK}}', params.workerTask)
    .replaceAll('{{PROJECT_DESCRIPTION}}', params.projectDescription)

  // Wrap with SA operational instructions + tool definitions
  // This uses the same format as the default prompt that works
  return formatSuperAssistantPrompt(filledPrompt, tools)
}

/**
 * Generates just the collaboration context prefix (without SA wrapping).
 * Useful when the SA prompt is already applied separately (e.g., via sidebar).
 */
export function getCollaborativeContext(params: CollaborativePromptParams): string {
  return COLLABORATIVE_PROMPT_TEMPLATE
    .replaceAll('{{WORKER_ID}}', params.workerId)
    .replaceAll('{{WORKER_PLATFORM}}', params.workerPlatform)
    .replaceAll('{{WORKER_TASK}}', params.workerTask)
    .replaceAll('{{PROJECT_DESCRIPTION}}', params.projectDescription)
}
