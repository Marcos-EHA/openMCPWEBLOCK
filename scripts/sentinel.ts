/**
 * Sentinel V1 — Multi-Agent Orchestrator for openMCPWEBLOCK
 * 
 * Orchestrates multiple concurrent tool executions against the MCP server.
 * Each "agent" runs independently with its own executionKey, agentId, and isolation.
 * 
 * Usage:
 *   bun run scripts/sentinel.ts
 *   bun run scripts/sentinel.ts --task "Analyze the project structure"
 */

const MCP_URL = process.env.MCP_URL || "http://localhost:3006/mcp";
const ACCEPT = { "Accept": "application/json, text/event-stream", "Content-Type": "application/json" };

// ─── MCP Transport ─────────────────────────────────────────

class McpSession {
  private sessionId: string | null = null;
  private nextId = 1;

  async initialize(): Promise<void> {
    const { sid } = await this.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "sentinel-v1", version: "1.0.0" },
    });
    this.sessionId = sid;
    await this.rpc("notifications/initialized", {});
  }

  async listTools(): Promise<{ name: string; description: string }[]> {
    const { data } = await this.rpc("tools/list", {});
    return data?.result?.tools || [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const { data } = await this.rpc("tools/call", { name, arguments: args });
    const content = data?.result?.content?.[0]?.text?.trim() || "";
    const isError = !!data?.result?.isError;
    return { text: content, isError };
  }

  private async rpc(method: string, params: unknown): Promise<{ sid: string | null; data: any }> {
    const headers: Record<string, string> = { ...ACCEPT };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    const body = JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params });
    const resp = await fetch(MCP_URL, { method: "POST", headers, body });
    const newSid = resp.headers.get("mcp-session-id") || this.sessionId;
    if (newSid) this.sessionId = newSid;

    const text = await resp.text();
    const dataLines = text.split("\n").filter(l => l.startsWith("data: "));
    const parsed = dataLines.length ? JSON.parse(dataLines[0].replace("data: ", "")) : null;
    return { sid: this.sessionId, data: parsed };
  }
}

// ─── Agent Execution ────────────────────────────────────────

interface AgentTask {
  agentId: string;
  role: string;
  tool: string;
  args: Record<string, unknown>;
  dependsOn?: string[];  // agentIds this task depends on
}

interface AgentResult {
  agentId: string;
  role: string;
  executionKey: string;
  tool: string;
  status: "success" | "error" | "skipped";
  result: string;
  error: string;
  durationMs: number;
  startedAt: string;
  completedAt: string;
}

// ─── Sentinel Orchestrator ──────────────────────────────────

class Sentinel {
  private session: McpSession;
  private results: Map<string, AgentResult> = new Map();

  constructor() {
    this.session = new McpSession();
  }

  async initialize(): Promise<void> {
    await this.session.initialize();
    const tools = await this.session.listTools();
    console.log(`[Sentinel] Connected to MCP server. ${tools.length} tools available.`);
  }

  /**
   * Run multiple agent tasks concurrently with dependency resolution.
   * Tasks without dependencies run immediately in parallel.
   * Tasks with dependencies wait for their deps to complete.
   */
  async runAgents(tasks: AgentTask[]): Promise<AgentResult[]> {
    console.log(`\n[Sentinel] Orchestrating ${tasks.length} agents...`);
    
    // Separate into waves based on dependencies
    const noDeps = tasks.filter(t => !t.dependsOn?.length);
    const withDeps = tasks.filter(t => t.dependsOn?.length);

    // Wave 1: All independent tasks run concurrently
    if (noDeps.length > 0) {
      console.log(`[Sentinel] Wave 1: ${noDeps.length} independent agents`);
      const wave1 = await Promise.allSettled(
        noDeps.map(task => this.executeAgent(task))
      );
      wave1.forEach((r, i) => {
        const result = r.status === "fulfilled" ? r.value : this.errorResult(noDeps[i], (r as PromiseRejectedResult).reason);
        this.results.set(result.agentId, result);
      });
    }

    // Wave 2+: Tasks with dependencies
    if (withDeps.length > 0) {
      console.log(`[Sentinel] Wave 2: ${withDeps.length} dependent agents`);
      // For V1, run dependent tasks after all independent tasks complete
      const wave2 = await Promise.allSettled(
        withDeps.map(async task => {
          // Check if dependencies succeeded
          const depsFailed = task.dependsOn?.some(dep => {
            const depResult = this.results.get(dep);
            return !depResult || depResult.status === "error";
          });
          if (depsFailed) {
            return { ...this.errorResult(task, "Dependency failed"), status: "skipped" as const };
          }
          
          // Inject dependency results into args if needed
          const enrichedArgs = { ...task.args };
          if (task.dependsOn) {
            const depResults: Record<string, string> = {};
            for (const dep of task.dependsOn) {
              depResults[dep] = this.results.get(dep)?.result || "";
            }
            enrichedArgs._dependencyResults = depResults;
          }
          
          return this.executeAgent({ ...task, args: enrichedArgs });
        })
      );
      wave2.forEach((r, i) => {
        const result = r.status === "fulfilled" ? r.value : this.errorResult(withDeps[i], (r as PromiseRejectedResult).reason);
        this.results.set(result.agentId, result);
      });
    }

    return Array.from(this.results.values());
  }

  private async executeAgent(task: AgentTask): Promise<AgentResult> {
    const executionKey = `sentinel-${task.agentId}-${Date.now()}`;
    const startedAt = new Date().toISOString();
    const t0 = Date.now();

    console.log(`  [${task.agentId}] Starting: ${task.role} (${task.tool})`);

    try {
      const { text, isError } = await this.session.callTool(task.tool, task.args);
      const durationMs = Date.now() - t0;
      const status = isError ? "error" : "success";
      
      console.log(`  [${task.agentId}] ${status.toUpperCase()} (${durationMs}ms)`);
      
      return {
        agentId: task.agentId,
        role: task.role,
        executionKey,
        tool: task.tool,
        status,
        result: isError ? "" : text,
        error: isError ? text : "",
        durationMs,
        startedAt,
        completedAt: new Date().toISOString(),
      };
    } catch (err: any) {
      const durationMs = Date.now() - t0;
      console.log(`  [${task.agentId}] ERROR (${durationMs}ms): ${err.message}`);
      return this.errorResult(task, err.message, executionKey, startedAt, durationMs);
    }
  }

  private errorResult(task: AgentTask, error: string, executionKey?: string, startedAt?: string, durationMs?: number): AgentResult {
    return {
      agentId: task.agentId,
      role: task.role,
      executionKey: executionKey || `sentinel-${task.agentId}-error`,
      tool: task.tool,
      status: "error",
      result: "",
      error: String(error),
      durationMs: durationMs || 0,
      startedAt: startedAt || new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
  }

  /**
   * Decompose a high-level task into agent sub-tasks.
   * V1: Simple predefined decomposition patterns.
   */
  static decomposeTask(taskDescription: string): AgentTask[] {
    // Pattern: "audit project" → multi-agent inspection
    if (taskDescription.toLowerCase().includes("audit") || taskDescription.toLowerCase().includes("analiz")) {
      return [
        {
          agentId: "arch-inspector",
          role: "Architecture Inspector",
          tool: "Bash",
          args: { command: `powershell -c "Get-ChildItem -Path 'C:\\Users\\elias\\Gits\\openMCPWEBLOCK\\src' -Directory | Select-Object Name"` },
        },
        {
          agentId: "dep-analyzer",
          role: "Dependency Analyzer",
          tool: "Read",
          args: { file_path: "C:\\Users\\elias\\Gits\\openMCPWEBLOCK\\package.json", offset: 0, limit: 30 },
        },
        {
          agentId: "tool-counter",
          role: "Tool Inventory",
          tool: "Bash",
          args: { command: `powershell -c "Get-ChildItem -Path 'C:\\Users\\elias\\Gits\\openMCPWEBLOCK\\src\\tools' -Directory | Measure-Object | Select-Object -ExpandProperty Count"` },
        },
        {
          agentId: "ext-inspector",
          role: "Extension Inspector",
          tool: "Bash",
          args: { command: `powershell -c "Get-ChildItem -Path 'C:\\Users\\elias\\Gits\\openMCPWEBLOCK\\chrome-extension\\source\\dist' -Recurse -File | Select-Object Name, Length | Format-Table -AutoSize"` },
        },
        {
          agentId: "git-status",
          role: "Git Status",
          tool: "Bash",
          args: { command: "cd C:\\Users\\elias\\Gits\\openMCPWEBLOCK && git log --oneline -5 && echo --- && git status --short" },
        },
        {
          agentId: "consolidator",
          role: "Result Consolidator",
          tool: "Bash",
          args: { command: "echo Consolidation_complete" },
          dependsOn: ["arch-inspector", "dep-analyzer", "tool-counter", "ext-inspector", "git-status"],
        },
      ];
    }

    // Default: single agent execution
    return [{
      agentId: "default",
      role: "General Agent",
      tool: "Bash",
      args: { command: taskDescription },
    }];
  }

  /** Pretty-print results as a table */
  static printResults(results: AgentResult[]): void {
    console.log("\n╔══════════════════════════════════════════════════════════════════╗");
    console.log("║                    SENTINEL V1 — RESULTS                        ║");
    console.log("╠══════════════════════════════════════════════════════════════════╣");
    
    for (const r of results) {
      const icon = r.status === "success" ? "✅" : r.status === "skipped" ? "⏭️" : "❌";
      const preview = (r.result || r.error).substring(0, 60).replace(/\n/g, " ");
      console.log(`║ ${icon} ${r.agentId.padEnd(18)} │ ${r.role.padEnd(22)} │ ${r.durationMs}ms`);
      console.log(`║   ${r.tool.padEnd(18)} │ ${preview}`);
      console.log("║──────────────────────────────────────────────────────────────────");
    }
    
    const total = results.reduce((s, r) => s + r.durationMs, 0);
    const maxDuration = Math.max(...results.map(r => r.durationMs));
    const passed = results.filter(r => r.status === "success").length;
    console.log(`║ ${passed}/${results.length} succeeded │ Wall time: ~${maxDuration}ms │ CPU time: ${total}ms`);
    console.log(`║ Parallelism ratio: ${(total / maxDuration).toFixed(1)}x`);
    console.log("╚══════════════════════════════════════════════════════════════════╝");
  }
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  const taskArg = process.argv.find(a => a.startsWith("--task="))?.replace("--task=", "") 
    || (process.argv.includes("--task") ? process.argv[process.argv.indexOf("--task") + 1] : null);

  const sentinel = new Sentinel();
  await sentinel.initialize();

  // Demo: Audit the project
  const task = taskArg || "audit project";
  console.log(`\n[Sentinel] Task: "${task}"`);
  
  const agents = Sentinel.decomposeTask(task);
  console.log(`[Sentinel] Decomposed into ${agents.length} agent tasks`);

  const results = await sentinel.runAgents(agents);
  Sentinel.printResults(results);
}

main().catch(err => {
  console.error("[Sentinel] Fatal:", err.message);
  process.exit(1);
});
