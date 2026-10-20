/**
 * Custom instructions for ChatGPT
 * This file contains specific instructions for the ChatGPT AI platform
 */

// Export the custom instructions for ChatGPT
export const chatgptInstructions = `
ChatGPT-specific guidance:
- The extension observes the JSONL function-call events in your response and runs them automatically when the configured automation options are enabled.
- Do not switch to canvas or code-interpreter mode to simulate an MCP tool call.
- After emitting a call, wait for the matching function_result before answering the user.
`;

// Compressed schema notation documentation will be added after this point
