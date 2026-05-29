/**
 * BridgeScript — JavaScript to inject into AI web pages via CDP.
 *
 * This is the heart of the SA integration. When injected into a page like ChatGPT,
 * it sets up a MutationObserver that watches the DOM for AI-generated tool call
 * blocks in the XML format that SA uses:
 *
 *   <function_calls>
 *     <invoke name="Read" call_id="1">
 *       <parameter name="file_path">package.json</parameter>
 *     </invoke>
 *   </function_calls>
 *
 * When detected, it stores parsed tool calls in window.__MCP_PENDING_CALLS
 * which the WebRelayProvider polls via CDP Runtime.evaluate.
 *
 * Also supports the simpler <tool_use> format as fallback.
 */

/**
 * Returns the bridge script as a string ready for CDP Runtime.evaluate.
 * This runs entirely in the browser context.
 */
export function getBridgeScript(): string {
  return `
(function() {
  // Guard against double-injection
  if (window.__MCP_BRIDGE_ACTIVE) return 'already_active';
  window.__MCP_BRIDGE_ACTIVE = true;

  // Pending tool calls for the host to pick up
  window.__MCP_PENDING_CALLS = [];
  // Processed call IDs to avoid duplicates
  window.__MCP_PROCESSED_IDS = new Set();
  // Status: 'idle' | 'watching' | 'waiting_result'
  window.__MCP_STATUS = 'watching';
  // Last known assistant message count
  window.__MCP_LAST_MSG_COUNT = 0;

  var callCounter = 0;

  // ─── XML Parser: <function_calls> / <invoke> format ───────────
  function parseFunctionCallsXML(text) {
    var calls = [];
    // Match <invoke name="ToolName" call_id="..."> ... </invoke>
    var invokePattern = /<invoke\\s+name="([^"]+)"(?:\\s+call_id="([^"]*)")?\\s*>([\\s\\S]*?)<\\/invoke>/g;
    var match;
    while ((match = invokePattern.exec(text)) !== null) {
      var toolName = match[1];
      var callId = match[2] || ('auto_' + (++callCounter));
      var paramsBlock = match[3];
      var params = {};
      // Extract <parameter name="key">value</parameter>
      var paramPattern = /<parameter\\s+name="([^"]+)"\\s*>([\\s\\S]*?)<\\/parameter>/g;
      var pm;
      while ((pm = paramPattern.exec(paramsBlock)) !== null) {
        params[pm[1]] = pm[2].trim();
      }
      calls.push({ id: callId, name: toolName, input: params });
    }
    return calls;
  }

  // ─── XML Parser: <tool_use> format (fallback) ─────────────────
  function parseToolUseXML(text) {
    var calls = [];
    var pattern = /<tool_use>\\s*<tool_name>([\\s\\S]*?)<\\/tool_name>\\s*<tool_input>\\s*([\\s\\S]*?)\\s*<\\/tool_input>\\s*<\\/tool_use>/g;
    var match;
    while ((match = pattern.exec(text)) !== null) {
      var name = match[1].trim();
      var inputStr = match[2].trim();
      try {
        var input = JSON.parse(inputStr);
        calls.push({ id: 'tu_' + (++callCounter), name: name, input: input });
      } catch(e) {
        // Try key-value extraction
        var kv = {};
        var kvp = /"(\\w+)":\\s*"([^"]*?)"/g;
        var km;
        while ((km = kvp.exec(inputStr)) !== null) kv[km[1]] = km[2];
        if (Object.keys(kv).length > 0) {
          calls.push({ id: 'tu_' + (++callCounter), name: name, input: kv });
        }
      }
    }
    return calls;
  }

  // ─── JSON Parser: {"name":"tool","arguments":{}} format ───────
  function parseJSONFunctionCalls(text) {
    var calls = [];
    // Look for JSON blocks in code fences
    var codePattern = /\\\`\\\`\\\`(?:json|tool_code)?\\s*\\n([\\s\\S]*?)\\\`\\\`\\\`/g;
    var match;
    while ((match = codePattern.exec(text)) !== null) {
      try {
        var parsed = JSON.parse(match[1].trim());
        if (parsed.name && (parsed.arguments || parsed.input || parsed.parameters)) {
          calls.push({
            id: 'json_' + (++callCounter),
            name: parsed.name,
            input: parsed.arguments || parsed.input || parsed.parameters
          });
        }
      } catch(e) { /* not valid JSON */ }
    }
    return calls;
  }

  // ─── Main: Scan a text node for tool calls ────────────────────
  function extractToolCalls(text) {
    // Try SA's <function_calls> format first (most reliable)
    if (text.includes('<function_calls>') || text.includes('<invoke')) {
      var calls = parseFunctionCallsXML(text);
      if (calls.length > 0) return calls;
    }
    // Try <tool_use> format
    if (text.includes('<tool_use>')) {
      var calls2 = parseToolUseXML(text);
      if (calls2.length > 0) return calls2;
    }
    // Try JSON format
    var calls3 = parseJSONFunctionCalls(text);
    if (calls3.length > 0) return calls3;
    return [];
  }

  // ─── DOM Scanner ──────────────────────────────────────────────
  function scanForToolCalls() {
    // Get all assistant messages
    var msgs = document.querySelectorAll(
      '[data-message-author-role="assistant"], ' +
      '.model-response-text, ' +
      'model-response, ' +
      '[data-is-streaming], ' +
      '.font-claude-message, ' +
      '.ds-markdown'
    );

    for (var i = msgs.length - 1; i >= 0; i--) {
      var msg = msgs[i];
      var text = msg.textContent || '';

      // Quick check: does this message contain anything that looks like a tool call?
      if (!text.includes('<invoke') && 
          !text.includes('<function_calls>') && 
          !text.includes('<tool_use>') &&
          !text.includes('<tool_name>') &&
          !text.includes('"name"')) continue;

      var calls = extractToolCalls(text);
      for (var j = 0; j < calls.length; j++) {
        var call = calls[j];
        var callKey = call.name + '_' + JSON.stringify(call.input);
        if (!window.__MCP_PROCESSED_IDS.has(callKey)) {
          window.__MCP_PROCESSED_IDS.add(callKey);
          window.__MCP_PENDING_CALLS.push(call);
          window.__MCP_STATUS = 'waiting_result';
        }
      }
      // Only check the latest message
      break;
    }
  }

  // ─── MutationObserver ─────────────────────────────────────────
  var debounceTimer = null;
  var observer = new MutationObserver(function(mutations) {
    // Debounce to avoid excessive scanning during streaming
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function() {
      scanForToolCalls();
    }, 300);
  });

  // Start observing
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });

  // Also do periodic scans (fallback for cases MutationObserver misses)
  setInterval(function() {
    scanForToolCalls();
  }, 2000);

  // Initial scan
  setTimeout(scanForToolCalls, 1000);

  return 'bridge_injected';
})()
`;
}

/**
 * Script to check for pending tool calls.
 * Returns JSON array of pending calls, or empty array.
 */
export const CHECK_PENDING_CALLS = `
(function() {
  if (!window.__MCP_PENDING_CALLS) return '[]';
  var calls = window.__MCP_PENDING_CALLS.splice(0);
  return JSON.stringify(calls);
})()
`;

/**
 * Script to get the bridge status.
 */
export const GET_BRIDGE_STATUS = `
(function() {
  return JSON.stringify({
    active: !!window.__MCP_BRIDGE_ACTIVE,
    status: window.__MCP_STATUS || 'unknown',
    pendingCount: (window.__MCP_PENDING_CALLS || []).length,
    processedCount: window.__MCP_PROCESSED_IDS ? window.__MCP_PROCESSED_IDS.size : 0
  });
})()
`;

/**
 * Format tool results in the SA-compatible format for re-injection.
 * Uses <function_results> XML which is what Claude/ChatGPT understand.
 */
export function formatToolResultMessage(results: Array<{name: string, output: string, isError: boolean}>): string {
  const parts = results.map(r => {
    if (r.isError) {
      return `<function_results>
<output name="${r.name}" status="error">
${r.output}
</output>
</function_results>`;
    }
    return `<function_results>
<output name="${r.name}">
${r.output}
</output>
</function_results>`;
  });
  return parts.join('\n\n');
}

/**
 * Format tool definitions in the SA-compatible format.
 * This gets prepended to the first message to teach the AI about available tools.
 */
export function formatToolDefsForInjection(tools: Array<{name: string, description: string, inputSchema?: any}>): string {
  if (!tools.length) return '';

  const toolDefs = tools.map(tool => {
    const params = tool.inputSchema?.properties
      ? Object.entries(tool.inputSchema.properties as Record<string, any>)
          .map(([name, schema]: [string, any]) => {
            const required = (tool.inputSchema?.required as string[] || []).includes(name);
            return `      <parameter name="${name}" type="${(schema as any).type || 'string'}" required="${required}">${(schema as any).description || ''}</parameter>`;
          })
          .join('\n')
      : '';

    return `    <tool_description>
      <tool_name>${tool.name}</tool_name>
      <description>${tool.description || ''}</description>
      <parameters>
${params}
      </parameters>
    </tool_description>`;
  }).join('\n');

  return `In this environment you have access to a set of tools you can use to answer the user's question. You MUST use the following XML format to call tools:

<function_calls>
<invoke name="TOOL_NAME" call_id="1">
<parameter name="param1">value1</parameter>
<parameter name="param2">value2</parameter>
</invoke>
</function_calls>

Here are the available tools:

<tools>
${toolDefs}
</tools>

When you need to use a tool, output the <function_calls> XML block. After you output it, STOP and wait. I will provide the result in <function_results> format, then you may continue.

Important: You may call multiple tools in sequence. Always use the exact XML format shown above.`;
}
