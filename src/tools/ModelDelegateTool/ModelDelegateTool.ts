import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  MODEL_DELEGATE_TOOL_NAME,
  DESCRIPTION,
  MODEL_DELEGATE_TOOL_PROMPT,
} from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    targetModel: z
      .string()
      .describe('The model to delegate to (e.g., "codellama:7b-code", "neural-chat:7b")'),
    taskDescription: z
      .string()
      .describe('Clear description of the task to delegate to the specialized model'),
    context: z
      .string()
      .optional()
      .describe('Additional context or previous conversation to provide to the delegated model'),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    response: z.string().describe('The response from the delegated model'),
    modelUsed: z.string().describe('The model that was actually used'),
    success: z.boolean().describe('Whether the delegation was successful'),
  }),
)

type OutputSchema = ReturnType<typeof outputSchema>

async function delegateToModel(input: InputSchema): Promise<OutputSchema> {
  const { targetModel, taskDescription, context = '' } = input

  try {
    // Build the prompt for the delegated model
    const systemPrompt = MODEL_DELEGATE_TOOL_PROMPT
    const userPrompt = `Task: ${taskDescription}\n\n${context ? `Context: ${context}\n\n` : ''}Please provide a helpful response.`

    // Make API call to Ollama
    const response = await fetch('http://localhost:11434/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: targetModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
        max_tokens: 2048,
      }),
    })

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`)
    }

    const data = await response.json()
    const modelResponse = data.choices?.[0]?.message?.content || 'No response from model'

    return {
      response: modelResponse,
      modelUsed: targetModel,
      success: true,
    }
  } catch (error) {
    console.error('Error delegating to model:', error)
    return {
      response: `Error delegating to ${targetModel}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      modelUsed: targetModel,
      success: false,
    }
  }
}

export const ModelDelegateTool: ToolDef<InputSchema, OutputSchema> = buildTool({
  name: MODEL_DELEGATE_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema,
  outputSchema,
  renderToolUseMessage,
  renderToolResultMessage,
  execute: delegateToModel,
})