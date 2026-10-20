#!/usr/bin/env bun
/**
 * Sentinel V2 — Intelligent Multi-Agent Orchestrator for openMCPWEBLOCK
 * 
 * Uses Gemini as reasoning engine + MCP tools for execution + CDP for browser control.
 * 
 * Capabilities:
 * - Start/check MCP server
 * - Manage Chrome extension (SA) via CDP
 * - Execute tools against MCP server  
 * - Reason about system state using Gemini
 * - Auto-diagnose and fix issues
 * 
 * Usage:
 *   bun run scripts/sentinel-v2.ts
 *   bun run scripts/sentinel-v2.ts --chat   (interactive mode)
 */

import { readFileSync } from "fs";
import { resolve } from "path";

// Load env
const ROOT = resolve(import.meta.dir, "..");
try {
  const envContent = readFileSync(resolve(ROOT, ".env"), "utf-8");
  for (const line of envContent.split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
} catch {}

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const MCP_URL = process.env.MCP_URL || "http://localhost:3006/mcp";
const CDP_URL = process.env.CDP_URL || "http://localhost:9222";
const MCP_ACCEPT = { "Accept": "application/json, text/event-stream", "Content-Type": "application/json" };

// ─── System Knowledge ───────────────────────────────────────

const SYSTEM_KNOWLEDGE = `
You are Sentinel, the orchestrator for the openMCPWEBLOCK ecosystem.

## Architecture
- MCP Server: localhost:3006 (StreamableHTTP at /mcp, SSE at /sse, health at /healthz)
- Chrome Extension (SuperAssistant): Content script injects into ChatGPT/Gemini/etc
  - Extension dist: ${ROOT}/chrome-extension/source/dist
  - Extension ID varies by profile (local unpacked)
  - Background service worker: background.js (singleton McpClient)
  - Content script: content/index.iife.js (injected at document_idle)
- CDP: Chrome DevTools Protocol on localhost:9222

## Tools Available via MCP (23)
Core: Read, Write, Edit, MultiEdit, Bash, ListDir, Glob, Grep, WebSearch, WebFetch, TodoRead, TodoWrite
Aliases: filesystem.read_file, filesystem.write_file, filesystem.list_directory, shell.execute_command, etc.
Relay: relay_get_pending_prompt, relay_send_response

## Common Issues
1. Extension CWS vs Local: The Chrome Web Store version is outdated. Must use local source/dist.
2. Content script not injecting: May need page reload after extension load. Check for errors in SW console.
3. MCP server not running: Start with "bun run scripts/start-mcp-server.ts" from project root.
4. Port 3006 conflict: Both internal MCP and external proxy use 3006. Only one can run.
5. Timer throttling: Content scripts in inactive tabs have throttled timers (setTimeout >=1s).
6. execCommand failure: DeepSeek/Grok/Kimi/OpenRouter/T3Chat adapters fail in inactive tabs.

## Project Root
${ROOT}

## Key Directories
- src/: Main server code (tools, services, bridge)
- chrome-extension/source/: Extension source
- chrome-extension/source/dist/: Built extension (load this in Chrome)
- scripts/: Utility scripts
- .agents/: Multi-agent coordination state

When asked to check system status, use the MCP tools and CDP to gather real data.
When asked to fix something, explain what you'll do and then do it.
Always provide concrete evidence, not assumptions.
`;

// ─── MCP Client ─────────────────────────────────────────────

class McpClient {
  private sessionId: string | null = null;
  private nextId = 1;

  async initialize(): Promise<boolean> {
    try {
      const { sid } = await this.rpc("initialize", {
        protocolVersion: "2024-11-05", capabilities: {},
        clientInfo: { name: "sentinel-v2", version: "2.0.0" }
      });
      this.sessionId = sid;
      await this.rpc("notifications/initialized", {});
      return true;
    } catch { return false; }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const { data } = await this.rpc("tools/call", { name, arguments: args });
    return data?.result?.content?.[0]?.text?.trim() || "";
  }

  async listTools(): Promise<string[]> {
    const { data } = await this.rpc("tools/list", {});
    return (data?.result?.tools || []).map((t: any) => t.name);
  }

  private async rpc(method: string, params: unknown) {
    const headers: Record<string, string> = { ...MCP_ACCEPT };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const resp = await fetch(MCP_URL, {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params })
    });
    const newSid = resp.headers.get("mcp-session-id") || this.sessionId;
    if (newSid) this.sessionId = newSid;
    const text = await resp.text();
    const lines = text.split("\n").filter(l => l.startsWith("data: "));
    return { sid: this.sessionId, data: lines.length ? JSON.parse(lines[0].replace("data: ", "")) : null };
  }
}

// ─── CDP Client ─────────────────────────────────────────────

class CdpClient {
  async getTargets(): Promise<any[]> {
    try {
      return await (await fetch(`${CDP_URL}/json`)).json();
    } catch { return []; }
  }

  async evalInPage(wsUrl: string, expr: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        ws.send(JSON.stringify({
          id: 1, method: "Runtime.evaluate",
          params: { expression: expr, returnByValue: true, awaitPromise: true }
        }));
      };
      ws.onmessage = (ev) => {
        const d = JSON.parse(ev.data);
        if (d.id === 1) { ws.close(); resolve(d.result?.result?.value || JSON.stringify(d.result)); }
      };
      ws.onerror = () => { ws.close(); reject(new Error("CDP WS error")); };
      setTimeout(() => { ws.close(); resolve("timeout"); }, 8000);
    });
  }
}

// ─── Gemini ─────────────────────────────────────────────────

async function askGemini(messages: { role: string; parts: { text: string }[] }[]): Promise<string> {
  if (!GEMINI_KEY) return "[Gemini not configured - no API key]";
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: messages,
      systemInstruction: { parts: [{ text: SYSTEM_KNOWLEDGE }] },
      generationConfig: { maxOutputTokens: 2048, temperature: 0.3 }
    })
  });
  const data = await resp.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || `[Gemini error: ${JSON.stringify(data?.error || data)}]`;
}

// ─── Sentinel ───────────────────────────────────────────────

class SentinelV2 {
  private mcp = new McpClient();
  private cdp = new CdpClient();
  private history: { role: string; parts: { text: string }[] }[] = [];
  private mcpConnected = false;

  async boot(): Promise<void> {
    console.log("╔══════════════════════════════════════════╗");
    console.log("║  Sentinel V2 — System Orchestrator       ║");
    console.log("╚══════════════════════════════════════════╝\n");

    // Check MCP server
    process.stdout.write("MCP Server... ");
    try {
      const health = await (await fetch("http://localhost:3006/healthz")).text();
      if (health === "ok") {
        this.mcpConnected = await this.mcp.initialize();
        const tools = this.mcpConnected ? await this.mcp.listTools() : [];
        console.log(`✅ (${tools.length} tools)`);
      } else {
        console.log("❌ unhealthy");
      }
    } catch {
      console.log("❌ not running");
      console.log("  Starting MCP server...");
      // Could auto-start here
    }

    // Check CDP
    process.stdout.write("Chrome CDP... ");
    const targets = await this.cdp.getTargets();
    if (targets.length > 0) {
      const pages = targets.filter((t: any) => t.type === "page");
      console.log(`✅ (${pages.length} pages)`);
      for (const p of pages) {
        console.log(`  📄 ${p.title?.substring(0, 50)} → ${p.url?.substring(0, 60)}`);
      }
    } else {
      console.log("❌ not running");
    }

    // Check Gemini
    process.stdout.write("Gemini API... ");
    if (GEMINI_KEY) {
      const test = await askGemini([{ role: "user", parts: [{ text: "Reply with just: OK" }] }]);
      console.log(test.includes("OK") ? "✅" : `⚠️ ${test.substring(0, 50)}`);
    } else {
      console.log("❌ no API key");
    }

    console.log("");
  }

  async checkSystemStatus(): Promise<string> {
    const status: Record<string, any> = {};

    // MCP Server
    try {
      const st = await (await fetch("http://localhost:3006/status")).json();
      status.mcpServer = { running: true, ...st };
    } catch { status.mcpServer = { running: false }; }

    // CDP / Chrome
    const targets = await this.cdp.getTargets();
    status.chrome = {
      running: targets.length > 0,
      pages: targets.filter((t: any) => t.type === "page").map((t: any) => ({ title: t.title, url: t.url })),
      serviceWorkers: targets.filter((t: any) => t.type === "service_worker").map((t: any) => t.url),
    };

    // Check SA on each AI page
    for (const page of targets.filter((t: any) => t.type === "page" && (t.url?.includes("chatgpt") || t.url?.includes("gemini")))) {
      try {
        const result = await this.cdp.evalInPage(page.webSocketDebuggerUrl, `JSON.stringify({
          url: location.href,
          hasMcpStyles: document.querySelectorAll('style').length,
          hasMcpElements: document.querySelectorAll('[class*="mcp"], [data-function-call-id]').length,
        })`);
        status[`sa_${new URL(page.url).hostname}`] = JSON.parse(result);
      } catch (e: any) {
        status[`sa_${page.url}`] = { error: e.message };
      }
    }

    return JSON.stringify(status, null, 2);
  }

  async executeCommand(input: string): Promise<string> {
    // Built-in commands
    if (input === "status") return this.checkSystemStatus();
    if (input === "tools") return this.mcpConnected ? (await this.mcp.listTools()).join("\n") : "MCP not connected";

    // Tool execution shortcuts
    if (input.startsWith("bash ")) {
      return this.mcpConnected ? this.mcp.callTool("Bash", { command: input.slice(5) }) : "MCP not connected";
    }
    if (input.startsWith("read ")) {
      return this.mcpConnected ? this.mcp.callTool("Read", { file_path: input.slice(5) }) : "MCP not connected";
    }

    // For everything else, use Gemini for reasoning
    this.history.push({ role: "user", parts: [{ text: input }] });

    // Give Gemini current system state as context
    const systemState = await this.checkSystemStatus();
    const contextMsg = `[SYSTEM STATE]\n${systemState}\n\n[USER REQUEST]\n${input}\n\nRespond with what actions to take. If you need to run a tool, say: TOOL: <toolname> ARGS: <json args>`;
    
    const geminiResponse = await askGemini([
      ...this.history.slice(-6),
      { role: "user", parts: [{ text: contextMsg }] }
    ]);

    this.history.push({ role: "model", parts: [{ text: geminiResponse }] });

    // Parse tool calls from Gemini's response
    const toolMatch = geminiResponse.match(/TOOL:\s*(\w+)\s*ARGS:\s*(\{[^}]+\})/);
    if (toolMatch && this.mcpConnected) {
      const [, toolName, argsStr] = toolMatch;
      try {
        const args = JSON.parse(argsStr);
        const result = await this.mcp.callTool(toolName, args);
        return `${geminiResponse}\n\n--- Tool Result ---\n${result}`;
      } catch (e: any) {
        return `${geminiResponse}\n\n--- Tool Error ---\n${e.message}`;
      }
    }

    return geminiResponse;
  }

  async interactiveMode(): Promise<void> {
    console.log("Sentinel V2 Interactive Mode. Type 'exit' to quit.\n");
    console.log("Commands: status, tools, bash <cmd>, read <file>, or ask anything\n");
    
    const readline = await import("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    
    const prompt = () => {
      rl.question("sentinel> ", async (input) => {
        input = input.trim();
        if (!input) { prompt(); return; }
        if (input === "exit" || input === "quit") { rl.close(); return; }
        
        try {
          const result = await this.executeCommand(input);
          console.log(`\n${result}\n`);
        } catch (e: any) {
          console.error(`Error: ${e.message}\n`);
        }
        prompt();
      });
    };
    prompt();
  }

  async autoMode(): Promise<void> {
    // Automatic system check and diagnostics
    console.log("🔍 Running system diagnostics...\n");
    
    const status = await this.checkSystemStatus();
    console.log("System Status:");
    console.log(status);
    
    // Ask Gemini to analyze and suggest fixes
    const analysis = await askGemini([{
      role: "user",
      parts: [{ text: `Analyze this system status and tell me what's working, what's broken, and what to fix:\n\n${status}` }]
    }]);
    
    console.log("\n📋 Gemini Analysis:");
    console.log(analysis);
  }
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  const sentinel = new SentinelV2();
  await sentinel.boot();

  if (process.argv.includes("--chat")) {
    await sentinel.interactiveMode();
  } else {
    await sentinel.autoMode();
  }
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
