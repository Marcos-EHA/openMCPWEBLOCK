/**
 * CollaborationTools — MCP tools for multi-agent collaboration.
 *
 * These tools are called by workers via SuperAssistant tool calls.
 * Each call updates the CollaborationStore (the overwrite space)
 * and returns confirmation to the worker.
 *
 * Tools:
 *   - report_finding: Worker confirms a research finding
 *   - request_info: Worker requests data from another worker
 *   - flag_issue: Worker flags a problem
 *
 * These tools are registered alongside Read/Write/Bash/etc in the MCP server.
 * Workers learn about them via the collaborative startup prompt.
 */

import { collaborationStore } from './CollaborationStore.js'
import type { SimpleTool } from '../mcpServer/ToolAdapter.js'

// ─── Worker identity resolution ─────────────────────────────────

/**
 * Extracts workerId and platform from execution context.
 * In multi-agent mode, each instance has a unique agentId and platform.
 * Falls back to 'unknown' if not in multi-agent context.
 */
function resolveWorkerIdentity(args: Record<string, unknown>): {
  workerId: string
  workerPlatform: string
} {
  return {
    workerId: typeof args.worker_id === 'string' ? args.worker_id : 'unknown',
    workerPlatform: typeof args.worker_platform === 'string' ? args.worker_platform : 'unknown',
  }
}

// ─── Tool definitions ───────────────────────────────────────────

export function getCollaborationTools(): SimpleTool[] {
  return [
    {
      name: 'report_finding',
      description:
        'Report a confirmed research finding to the collaboration canvas. ' +
        'Use this when you have discovered something relevant to your assigned task. ' +
        'Each finding is tracked separately and visible to the orchestrator, sentinel, and user. ' +
        'Report findings as you discover them — do not wait until you finish everything.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: 'Topic or category of this finding (e.g., "bundling", "testing", "architecture")',
          },
          finding: {
            type: 'string',
            description: 'The finding itself — what you discovered, concluded, or confirmed',
          },
          confidence: {
            type: 'string',
            enum: ['alta', 'media', 'baja'],
            description: 'How confident you are in this finding: alta (high), media (medium), baja (low)',
          },
          sources: {
            type: 'number',
            description: 'Number of distinct sources or evidence points supporting this finding',
          },
          worker_id: {
            type: 'string',
            description: 'Your worker identifier (provided in your assignment)',
          },
          worker_platform: {
            type: 'string',
            description: 'Your platform name (e.g., chatgpt, claude, gemini)',
          },
        },
        required: ['topic', 'finding', 'confidence', 'worker_id', 'worker_platform'],
      },
      execute: async (args: Record<string, unknown>): Promise<string> => {
        const { workerId, workerPlatform } = resolveWorkerIdentity(args)
        const topic = String(args.topic ?? '')
        const finding = String(args.finding ?? '')
        const confidence = (args.confidence as 'alta' | 'media' | 'baja') ?? 'media'
        const sources = typeof args.sources === 'number' ? args.sources : 0
        const callId = typeof args.call_id === 'string' ? args.call_id : `auto-${Date.now()}`

        if (!topic || !finding) {
          return JSON.stringify({
            success: false,
            error: 'Both topic and finding are required',
          })
        }

        const entry = collaborationStore.addFinding({
          workerId,
          workerPlatform,
          topic,
          finding,
          confidence,
          sources,
          callId,
        })

        const snapshot = collaborationStore.getSnapshot()

        return JSON.stringify({
          success: true,
          finding_id: entry.id,
          message: `Finding registered: "${topic}" (${confidence} confidence)`,
          canvas_status: {
            total_findings: snapshot.findings,
            convergence_topics: snapshot.convergenceTopics,
            pending_requests: snapshot.pendingRequests,
          },
        })
      },
    },
    {
      name: 'request_info',
      description:
        'Request information that another worker may have. ' +
        'The orchestrator will check if another worker has reported a relevant finding ' +
        'and will provide it to you. Use this when you need data from a different research angle.',
      inputSchema: {
        type: 'object',
        properties: {
          need: {
            type: 'string',
            description: 'What information you need (be specific)',
          },
          reason: {
            type: 'string',
            description: 'Why you need this information — how it relates to your current task',
          },
          worker_id: {
            type: 'string',
            description: 'Your worker identifier (provided in your assignment)',
          },
          worker_platform: {
            type: 'string',
            description: 'Your platform name (e.g., chatgpt, claude, gemini)',
          },
        },
        required: ['need', 'reason', 'worker_id', 'worker_platform'],
      },
      execute: async (args: Record<string, unknown>): Promise<string> => {
        const { workerId, workerPlatform } = resolveWorkerIdentity(args)
        const need = String(args.need ?? '')
        const reason = String(args.reason ?? '')
        const callId = typeof args.call_id === 'string' ? args.call_id : `auto-${Date.now()}`

        if (!need || !reason) {
          return JSON.stringify({
            success: false,
            error: 'Both need and reason are required',
          })
        }

        // Check if there are already findings that match the request
        const allFindings = collaborationStore.getFindings()
        const needLower = need.toLowerCase()
        const relevantFindings = allFindings.filter(f =>
          f.workerId !== workerId && (
            f.topic.toLowerCase().includes(needLower) ||
            f.finding.toLowerCase().includes(needLower) ||
            needLower.includes(f.topic.toLowerCase())
          ),
        )

        if (relevantFindings.length > 0) {
          // Immediately fulfill from existing findings
          const entry = collaborationStore.addRequest({
            workerId,
            workerPlatform,
            need,
            reason,
            callId,
          })
          const fulfillData = relevantFindings.map(f => ({
            from_worker: f.workerId,
            platform: f.workerPlatform,
            topic: f.topic,
            finding: f.finding,
            confidence: f.confidence,
          }))
          collaborationStore.fulfillRequest(
            entry.id,
            'orchestrator-auto',
            JSON.stringify(fulfillData),
          )

          return JSON.stringify({
            success: true,
            request_id: entry.id,
            status: 'fulfilled',
            message: `Found ${relevantFindings.length} relevant finding(s) from other workers`,
            data: fulfillData,
          })
        }

        // No matching findings yet — register as pending
        const entry = collaborationStore.addRequest({
          workerId,
          workerPlatform,
          need,
          reason,
          callId,
        })

        return JSON.stringify({
          success: true,
          request_id: entry.id,
          status: 'pending',
          message: 'Request registered. The orchestrator will provide this information when available.',
        })
      },
    },
    {
      name: 'flag_issue',
      description:
        'Flag a problem or obstacle you encountered during your task. ' +
        'The sentinel and orchestrator will be notified. ' +
        'Use this when something prevents you from completing your assignment ' +
        'or when you find contradictory/unreliable information.',
      inputSchema: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'Description of the problem or obstacle',
          },
          severity: {
            type: 'string',
            enum: ['alta', 'media', 'baja'],
            description: 'How severe is this issue: alta (blocks work), media (slows work), baja (minor)',
          },
          worker_id: {
            type: 'string',
            description: 'Your worker identifier (provided in your assignment)',
          },
          worker_platform: {
            type: 'string',
            description: 'Your platform name (e.g., chatgpt, claude, gemini)',
          },
        },
        required: ['description', 'severity', 'worker_id', 'worker_platform'],
      },
      execute: async (args: Record<string, unknown>): Promise<string> => {
        const { workerId, workerPlatform } = resolveWorkerIdentity(args)
        const description = String(args.description ?? '')
        const severity = (args.severity as 'alta' | 'media' | 'baja') ?? 'media'
        const callId = typeof args.call_id === 'string' ? args.call_id : `auto-${Date.now()}`

        if (!description) {
          return JSON.stringify({
            success: false,
            error: 'Description is required',
          })
        }

        const entry = collaborationStore.addIssue({
          workerId,
          workerPlatform,
          description,
          severity,
          callId,
        })

        return JSON.stringify({
          success: true,
          issue_id: entry.id,
          message: `Issue flagged (${severity} severity). The orchestrator and sentinel have been notified.`,
        })
      },
    },
  ]
}
