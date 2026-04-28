import type { ToolResult } from '../../Tool.js'
import type { InputSchema, OutputSchema } from './ModelDelegateTool.js'

export function renderToolUseMessage(input: InputSchema): string {
  return `Delegating task to ${input.targetModel}: ${input.taskDescription}`
}

export function renderToolResultMessage(
  input: InputSchema,
  result: ToolResult<OutputSchema>,
): string {
  if (result.type === 'error') {
    return `Error delegating to ${input.targetModel}: ${result.error}`
  }

  const output = result.output
  return `Response from ${input.targetModel}:\n${output.response}`
}