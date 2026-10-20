import { createLogger } from '@extension/shared/lib/logger';
import claudeDedicatedPrompt from './claudeDedicatedPrompt.txt?raw';

const logger = createLogger('InstructionGeneratorJSON');

type InstructionTool = {
  name: string;
  schema: string;
  description: string;
};

const generateToolDefinitions = (tools: InstructionTool[]): string => tools.map((tool) => {
  let schemaText = 'Input schema unavailable.';
  try {
    schemaText = JSON.stringify(JSON.parse(tool.schema), null, 2);
  } catch (error) {
    logger.error(`Could not parse the input schema for ${tool.name}:`, error);
  }

  return [
    `### ${tool.name}`,
    tool.description ? tool.description : '',
    'Input schema:',
    '```json',
    schemaText,
    '```',
  ].filter(Boolean).join('\n');
}).join('\n\n');

const appendCustomInstructions = (
  instructions: string,
  customInstructions?: string,
  customInstructionsEnabled?: boolean,
): string => {
  if (!customInstructionsEnabled || !customInstructions?.trim()) return instructions;
  return `${instructions}\nAdditional user instructions:\n${customInstructions.trim()}\n`;
};

export const generateInstructionsJson = (
  tools: InstructionTool[],
  customInstructions?: string,
  customInstructionsEnabled?: boolean,
): string => {
  if (!tools || tools.length === 0) {
    return '# No tools available\n\nConnect to the MCP server to see available tools.';
  }

  const toolDefinitions = generateToolDefinitions(tools);

  const instructions = `[SuperAssistant Operational Instructions]

You are SuperAssistant, an assistant connected to the tools listed below through the SuperAssistant browser extension and the OpenMCPWEBLOCK MCP server.

When a tool is needed, emit a function call as plain JSONL text using exactly one JSON object per line. Do not wrap the call in XML, JSON arrays, or Python code. The extension observes these lines, executes the call, and returns the result in a function_result message.

Function-call protocol:
- Emit one standalone JSON object per line in a jsonl code block.
- In the start event, use type to identify function_call_start, name for the exact listed tool, and call_id for a unique identifier.
- In each parameter event, use type to identify parameter, key for the exact argument name, value for its JSON value, and the same call_id.
- In the end event, use type to identify function_call_end and the same call_id.
- Never use event instead of type, name instead of key for a parameter, or a nested parameters object.
- Use the exact parameter keys and valid JSON values required by the tool schema.
- Do not emit protocol examples, labels, or placeholder words as a tool call. The observer executes the actual call from your response.

Rules:
- Use the exact tool name and parameter keys from the schemas below.
- Include every required parameter. Encode strings as JSON strings; encode numbers, booleans, arrays, and objects as JSON values.
- Use the same unique call_id in the start and end events. Do not invent or add executionId or executionKey parameters.
- Emit one complete function call, then stop and wait for its function_result before continuing.
- Never fabricate a function_result, claim a tool ran when it did not, or ask the user to copy/paste a call that the extension can observe.
- If a tool result is an error, report the error accurately and decide whether a safe retry is appropriate.
- If no listed tool can perform the task, explain that limitation instead of inventing a tool.

Available tools:

${toolDefinitions}
`;

  return appendCustomInstructions(instructions, customInstructions, customInstructionsEnabled);
};

export const generateClaudeInstructionsJson = (): string => claudeDedicatedPrompt;
