#!/usr/bin/env node

/**
 * MCP Session Orchestrator - Maintains an MCP session and opens a browser page.
 *
 * Usage:
 *   node mcp-orchestrator.js --url https://chat.openai.com/ [--keepAlive]
 */

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logDir = path.join(__dirname, "logs");
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const logFile = path.join(logDir, "mcp-orchestrator.log");
const responsesFile = path.join(logDir, "mcp-responses.jsonl");
const resultFile = path.join(logDir, "mcp-orchestrator-result.json");

function log(msg) {
  const timestamp = new Date().toISOString();
  const logMsg = `[${timestamp}] ${msg}`;
  console.error(logMsg);
  fs.appendFileSync(logFile, logMsg + "\n", "utf8");
}

function saveResponse(response) {
  fs.appendFileSync(responsesFile, JSON.stringify(response) + "\n", "utf8");
}

function getArgValue(name, defaultValue) {
  const index = process.argv.indexOf(name);
  if (index !== -1 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  }
  return defaultValue;
}

const targetUrl = getArgValue("--url", "https://chat.openai.com/");
const keepAlive = process.argv.includes("--keepAlive");
const nodeInstallDir = process.env.PROGRAMFILES || "C:\\Program Files";
const npxCommand = process.platform === "win32"
  ? path.join(nodeInstallDir, "nodejs", "npx.cmd")
  : "npx";

log("=== MCP ORCHESTRATOR STARTING ===");
log(`Target URL: ${targetUrl}`);
log(`Keep alive: ${keepAlive}`);
log(`npx command: npx`);

const mcpProcess = spawn("npx", ["-y", "chrome-devtools-mcp"], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: __dirname,
  shell: true,
});

let messageId = 1;
const pendingRequests = new Map();

mcpProcess.stderr.on("data", (data) => {
  const msg = data.toString().trim();
  if (!msg.includes("Performance tools") && !msg.includes("Google collects")) {
    log(`[STDERR] ${msg}`);
  }
});

mcpProcess.on("error", (err) => {
  log(`[ERROR] MCP Process: ${err.message}`);
  process.exit(1);
});

mcpProcess.stdout.on("data", (chunk) => {
  const lines = chunk.toString().split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const response = JSON.parse(line);
      log(`[RECV #${response.id}] ${response.result ? "SUCCESS" : "ERROR"}`);
      if (pendingRequests.has(response.id)) {
        const request = pendingRequests.get(response.id);
        saveResponse({
          id: response.id,
          request,
          response,
          timestamp: new Date().toISOString(),
        });
        request.resolve(response);
        pendingRequests.delete(response.id);
      }
    } catch (e) {
      log(`[PARSE ERROR] ${e.message}: ${line}`);
    }
  }
});

function sendMessage(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = messageId++;
    const request = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    pendingRequests.set(id, { method, params, resolve, reject });
    mcpProcess.stdin.write(JSON.stringify(request) + "\n", (err) => {
      if (err) {
        pendingRequests.delete(id);
        reject(err);
      }
    });

    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.get(id).reject(new Error(`Request ${id} timed out`));
        pendingRequests.delete(id);
      }
    }, 30000);
  });
}

async function initializeSession() {
  log("Initializing MCP session...");
  const initResp = await sendMessage("initialize", {
    protocolVersion: "2025-11-05",
    capabilities: {},
    clientInfo: { name: "mcp-orchestrator", version: "1.0.0" },
  });
  log("MCP initialize complete.");

  log("Listing MCP tools...");
  const listResp = await sendMessage("tools/list", {});
  const toolCount = listResp.result?.tools?.length || 0;
  log(`Found ${toolCount} tools.`);

  log(`Opening browser page: ${targetUrl}`);
  const pageResp = await sendMessage("tools/call", {
    name: "new_page",
    arguments: {
      url: targetUrl,
      background: false,
    },
  });
  log("Browser page opened.");

  fs.writeFileSync(
    resultFile,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        targetUrl,
        initialize: initResp,
        tools_list: listResp,
        new_page: pageResp,
      },
      null,
      2
    ),
    "utf8"
  );
  log(`Saved orchestrator result to ${resultFile}`);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", async (line) => {
  if (!line.trim()) return;
  try {
    const command = JSON.parse(line);
    const response = await sendMessage(command.method, command.params || {});
    console.log(JSON.stringify(response));
  } catch (e) {
    log(`[ERROR] ${e.message}`);
    console.log(JSON.stringify({ error: e.message }));
  }
});

rl.on("close", () => {
  log("stdin closed, shutting down.");
  mcpProcess.stdin.end();
  process.exit(0);
});

process.on("SIGINT", () => {
  log("SIGINT received, shutting down.");
  mcpProcess.stdin.end();
  process.exit(0);
});

(async () => {
  try {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await initializeSession();
    log("Session ready. Send JSON commands via stdin or use Ctrl+C to stop.");
    if (!keepAlive) {
      log("No --keepAlive flag, will keep the session alive for 30 seconds.");
      await new Promise((resolve) => setTimeout(resolve, 30000));
      log("Timeout reached, shutting down.");
      process.exit(0);
    }
  } catch (err) {
    log(`[FATAL] ${err.stack || err.message}`);
    process.exit(1);
  }
})();
