#!/usr/bin/env node

/**
 * Direct MCP Client - ESM version for Node.js
 *
 * Usage:
 *   node mcp-client-node.js --url https://chat.openai.com/ [--keepAlive] [--timeout 30]
 */

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logDir = path.join(__dirname, "logs");
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const outputFile = path.join(logDir, "mcp-client-direct.json");
const errorFile = path.join(logDir, "mcp-client-direct-error.txt");
const logFile = path.join(logDir, "mcp-client-node.log");

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.error(line);
  fs.appendFileSync(logFile, line + "\n", "utf8");
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
const timeoutSeconds = Number(getArgValue("--timeout", keepAlive ? "0" : "20"));

const nodeInstallDir = process.env.PROGRAMFILES || "C:\\Program Files";
const npxCommand = process.platform === "win32"
  ? path.join(nodeInstallDir, "nodejs", "npx.cmd")
  : "npx";

log("=== MCP CLIENT STARTING ===");
log(`Timestamp: ${new Date().toISOString()}`);
log(`Target URL: ${targetUrl}`);
log(`Keep alive: ${keepAlive}`);
log(`Timeout (s): ${timeoutSeconds}`);
log(`npx command: npx`);

const mcpProcess = spawn("npx", ["-y", "chrome-devtools-mcp"], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: __dirname,
  shell: true,
});

let responses = {};
let expectedResponses = 0;
let receivedResponses = 0;

mcpProcess.stderr.on("data", (data) => {
  log(`[STDERR] ${data.toString().trim()}`);
});

mcpProcess.on("error", (err) => {
  const error = `[MCP ERROR] ${err.message}`;
  log(error);
  fs.writeFileSync(errorFile, error, "utf8");
  process.exit(1);
});

mcpProcess.on("exit", (code, signal) => {
  log(`[MCP PROCESS EXIT] code=${code} signal=${signal}`);
});

function sendMessage(id, method, params) {
  return new Promise((resolve, reject) => {
    const msg = { jsonrpc: "2.0", id, method, params: params || {} };
    const jsonStr = JSON.stringify(msg) + "\n";

    log(`[SEND #${id}] ${method}`);

    mcpProcess.stdin.write(jsonStr, (err) => {
      if (err) {
        reject(err);
        return;
      }
      responses[id] = { resolve, reject, method };
      expectedResponses++;
    });
  });
}

mcpProcess.stdout.on("data", (chunk) => {
  const lines = chunk.toString().split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      log(`[RECV #${msg.id}] ${JSON.stringify(msg).substring(0, 100)}`);
      if (responses[msg.id]) {
        responses[msg.id].response = msg;
        responses[msg.id].resolve(msg);
        receivedResponses++;
        delete responses[msg.id];
      }
    } catch (e) {
      log(`[PARSE ERROR] ${e.message}`);
    }
  }
});

function safeShutdown(code = 0) {
  try {
    if (!mcpProcess.killed) {
      mcpProcess.stdin.end();
      mcpProcess.kill();
    }
  } catch (e) {
    log(`[SHUTDOWN ERROR] ${e.message}`);
  }
  process.exit(code);
}

process.on("SIGINT", () => {
  log("SIGINT received, shutting down.");
  safeShutdown(0);
});

process.on("uncaughtException", (err) => {
  log(`[UNCAUGHT EXCEPTION] ${err.stack || err.message}`);
  fs.writeFileSync(errorFile, err.stack || err.message, "utf8");
  safeShutdown(1);
});

async function main() {
  try {
    log("Waiting for MCP process to start...");
    await new Promise((resolve) => setTimeout(resolve, 2000));

    log("--- Step 1: Initialize ---");
    const initResp = await sendMessage(1, "initialize", {
      protocolVersion: "2025-11-05",
      capabilities: {},
      clientInfo: { name: "mcp-client-node", version: "1.0.0" },
    });
    log(`[INIT OK] ${JSON.stringify(initResp).substring(0, 120)}`);

    log("--- Step 2: List Tools ---");
    const listResp = await sendMessage(2, "tools/list", {});
    const toolCount = listResp.result?.tools?.length || 0;
    log(`[LIST OK] Found ${toolCount} tools`);

    log("--- Step 3: Execute new_page ---");
    const toolResp = await sendMessage(3, "tools/call", {
      name: "new_page",
      arguments: {
        url: targetUrl,
        background: false,
      },
    });
    log(`[TOOL OK] ${JSON.stringify(toolResp).substring(0, 120)}`);

    const results = {
      timestamp: new Date().toISOString(),
      status: "SUCCESS",
      target_url: targetUrl,
      initialize: initResp,
      tools_list: listResp,
      new_page: toolResp,
    };
    fs.writeFileSync(outputFile, JSON.stringify(results, null, 2), "utf8");
    log(`[SUCCESS] Results saved to ${outputFile}`);

    if (keepAlive) {
      log("Keep-alive enabled. MCP client will continue running until interrupted.");
      return;
    }

    const waitMs = timeoutSeconds > 0 ? timeoutSeconds * 1000 : 20000;
    log(`Waiting ${waitMs / 1000}s before shutdown.`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    safeShutdown(0);
  } catch (err) {
    log(`[FATAL] ${err.stack || err.message}`);
    fs.writeFileSync(errorFile, err.stack || err.message, "utf8");
    safeShutdown(1);
  }
}

main().catch((err) => {
  log(`[MAIN ERROR] ${err.stack || err.message}`);
  fs.writeFileSync(errorFile, err.stack || err.message, "utf8");
  safeShutdown(1);
});
