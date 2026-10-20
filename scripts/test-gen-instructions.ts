import { generateInstructionsJson } from '../chrome-extension/source/pages/content/src/components/sidebar/Instructions/instructionGeneratorJson.ts'

const testTools = [
  {
    name: 'Bash',
    description: 'Execute shell commands in the workspace',
    schema: JSON.stringify({
      type: 'object',
      properties: { command: { type: 'string', description: 'The command to execute' } },
      required: ['command']
    })
  },
  {
    name: 'Read',
    description: 'Read the contents of a file',
    schema: JSON.stringify({
      type: 'object',
      properties: { file_path: { type: 'string', description: 'Path to file' } },
      required: ['file_path']
    })
  }
]

const instructions = generateInstructionsJson(testTools)
console.log('=== Instructions Length:', instructions.length)
console.log('=== Instructions Preview (first 500 chars) ===\n', instructions.substring(0, 500))
console.log('\n=== Instructions Tail (last 500 chars) ===\n', instructions.substring(instructions.length - 500))
