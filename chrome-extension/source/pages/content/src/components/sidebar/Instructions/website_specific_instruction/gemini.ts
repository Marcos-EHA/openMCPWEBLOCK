/**
 * Custom instructions for Gemini
 * This file contains specific instructions for the Gemini AI platform
 */

export const geminiInstructions = `
Gemini-specific guidance:
- Use the JSONL event format in the main instructions, with one JSON object per line.
- Do not use Python snippets or JSON arrays as a substitute for a function call.
- Wait for the matching function_result before continuing.
`;
