#!/usr/bin/env node

/**
 * Direct MCP Client para chrome-devtools-mcp
 * Conecta vía stdio y ejecuta herramientas sin proxy HTTP
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const logDir = path.join(__dirname, "logs");
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const outputFile = path.join(logDir, "mcp-client-direct.json");
const errorFile = path.join(logDir, "mcp-client-direct-error.txt");

// Launch chrome-devtools-mcp directly
const mcpProcess = spawn("npx", ["-y", "chrome-devtools-mcp"], {
  stdio: ["pipe", "pipe", "inherit"],
  cwd: __dirname,
});

let messageId = 1;
const requestMap = {};

// Parse JSON-RPC responses
mcpProcess.stdout.on("data", (data) => {
  const lines = data.toString().split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const msg = JSON.parse(line);
      const reqId = msg.id;

      if (requestMap[reqId]) {
        requestMap[reqId].response = msg;
      }
    } catch (e) {
      console.error("[PARSE ERROR]", e.message, "Line:", line);
    }
  }
});

mcpProcess.on("error", (err) => {
  const error = `MCP Process error: ${err.message}`;
  console.error(error);
  fs.writeFileSync(errorFile, error, "utf8");
  process.exit(1);
});

// Send JSON-RPC request and wait for response
async function sendRequest(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = messageId++;
    const request = { jsonrpc: "2.0", id, method, params };

    requestMap[id] = { request, response: null };

    const onResponse = () => {
      if (requestMap[id].response) {
        clearTimeout(timeout);
        delete requestMap[id];
        resolve(requestMap[id].response || requestMap[id]);
      }
    };

    const timeout = setInterval(() => {
      if (requestMap[id] && requestMap[id].response) {
        clearInterval(timeout);
        onResponse();
      }
    }, 100);

    setTimeout(() => {
      clearInterval(timeout);
      reject(new Error(`Timeout waiting for response to ${method}`));
    }, 30000);

    mcpProcess.stdin.write(JSON.stringify(request) + "\n");
  });
}

// Main test flow
async function main() {
  try {
    console.log("Connecting to chrome-devtools-mcp via stdio...");

    // Wait a bit for process to start
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Send initialize
    console.log("Sending initialize...");
    const initResp = await sendRequest("initialize", {
      protocolVersion: "2025-11-05",
      capabilities: {},
      clientInfo: { name: "mcp-client-direct", version: "1.0.0" },
    });
    console.log("Initialize response:", JSON.stringify(initResp, null, 2));

    // List tools
    console.log("Sending tools/list...");
    const listResp = await sendRequest("tools/list", {});
    console.log("Tools:", listResp.result?.tools?.length || "unknown");

    // Execute new_page
    console.log("Executing chrome-devtools-mcp.new_page...");
    const toolResp = await sendRequest("tools/call", {
      name: "new_page",
      arguments: {
        url: "https://example.com",
        background: false,
      },
    });
    console.log("Tool response:", JSON.stringify(toolResp, null, 2));

    // Save results
    const results = {
      timestamp: new Date().toISOString(),
      initialize: initResp,
      tools_list: listResp,
      new_page: toolResp,
    };

    fs.writeFileSync(outputFile, JSON.stringify(results, null, 2), "utf8");
    console.log("Results saved to:", outputFile);

    // Keep running to see browser activity
    await new Promise((resolve) => setTimeout(resolve, 5000));

    process.exit(0);
  } catch (err) {
    console.error("Error:", err.message);
    fs.writeFileSync(errorFile, err.stack, "utf8");
    process.exit(1);
  }
}

main().catch(console.error);
