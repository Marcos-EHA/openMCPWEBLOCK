/**
 * MultiAgent V1 Concurrent Execution Tests
 * Run: bun run test-concurrent.ts
 */

const SERVER = "http://localhost:3006/mcp";
const HDR = { "Accept": "application/json, text/event-stream", "Content-Type": "application/json" };

async function rpc(sid: string | null, method: string, params: any, id: number) {
  const h: Record<string, string> = { ...HDR };
  if (sid) h["mcp-session-id"] = sid;
  const r = await fetch(SERVER, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  const newSid = r.headers.get("mcp-session-id") || sid;
  // Note: results may have Windows line endings (\r\n), always trim()
  const lines = (await r.text()).split("\n").filter(l => l.startsWith("data: "));
  return { sid: newSid, data: lines.length ? JSON.parse(lines[0].replace("data: ", "")) : null };
}

async function initSession(): Promise<string> {
  const { sid } = await rpc(null, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } }, 1);
  if (!sid) throw new Error("No session");
  return sid;
}

interface Exec {
  agentId: string; tool: string; status: string; result: string; error: string;
  t0: number; t1: number;
}

async function callTool(sid: string, agentId: string, tool: string, args: any, id: number): Promise<Exec> {
  const t0 = Date.now();
  try {
    const { data } = await rpc(sid, "tools/call", { name: tool, arguments: args }, id);
    const t1 = Date.now();
    const content = data?.result?.content?.[0]?.text?.trim() || "";
    const isErr = data?.result?.isError;
    return { agentId, tool, status: isErr ? "error" : "success", result: content, error: isErr ? content : "", t0, t1 };
  } catch (e: any) {
    return { agentId, tool, status: "error", result: "", error: e.message, t0, t1: Date.now() };
  }
}

// ─── Tests ─────────────────────────────────────────────────

const results: Record<string, string> = {};

async function test(name: string, fn: () => Promise<boolean>) {
  try {
    const ok = await fn();
    results[name] = ok ? "PASS" : "FAIL";
    console.log(`  ${ok ? "✅" : "❌"} ${name}`);
  } catch (e: any) {
    results[name] = "ERROR";
    console.log(`  💥 ${name}: ${e.message}`);
  }
}

async function main() {
  console.log("\n═══ MultiAgent V1 Concurrent Execution Tests ═══\n");
  const sid = await initSession();
  // Send initialized notification (required by MCP protocol)
  await rpc(sid, "notifications/initialized", {}, 2);
  console.log(`Session: ${sid}\n`);

  await test("A: Single execution", async () => {
    const e = await callTool(sid, "A", "Bash", { command: "echo MARKER_A" }, 10);
    if (e.status !== "success") console.log(`    DEBUG: status=${e.status} error=${e.error} result=[${e.result}]`);
    return e.status === "success" && e.result.includes("MARKER_A");
  });

  await test("B: Two concurrent", async () => {
    const [a, b] = await Promise.all([
      callTool(sid, "B1", "Bash", { command: "echo B1_MARK" }, 20),
      callTool(sid, "B2", "Bash", { command: "echo B2_MARK" }, 21),
    ]);
    return a.result.includes("B1_MARK") && b.result.includes("B2_MARK") && !a.result.includes("B2") && !b.result.includes("B1");
  });

  await test("C: Three concurrent", async () => {
    const r = await Promise.all([
      callTool(sid, "C1", "Bash", { command: "echo C1" }, 30),
      callTool(sid, "C2", "Bash", { command: "echo C2" }, 31),
      callTool(sid, "C3", "Bash", { command: "echo C3" }, 32),
    ]);
    return r.every((e, i) => e.result.includes(`C${i + 1}`));
  });

  await test("D: A fails, B continues", async () => {
    const [a, b] = await Promise.all([
      callTool(sid, "D-fail", "Read", { file_path: "Z:\\nonexistent\\x.txt" }, 40),
      callTool(sid, "D-ok", "Bash", { command: "echo D_OK" }, 41),
    ]);
    return b.result.includes("D_OK");
  });

  await test("J: Different tools simultaneously", async () => {
    const r = await Promise.all([
      callTool(sid, "J-read", "Read", { file_path: "C:\\Users\\elias\\Gits\\openMCPWEBLOCK\\package.json", offset: 0, limit: 2 }, 50),
      callTool(sid, "J-bash", "Bash", { command: "echo J_BASH" }, 51),
      callTool(sid, "J-glob", "Glob", { pattern: "*.md", path: "C:\\Users\\elias\\Gits\\openMCPWEBLOCK" }, 52),
    ]);
    return r[0].status === "success" && r[1].result.includes("J_BASH") && r[2].status === "success";
  });

  await test("M: Results isolated (5 agents)", async () => {
    const markers = ["ALPHA", "BETA", "GAMMA", "DELTA", "EPSILON"];
    const r = await Promise.all(markers.map((m, i) =>
      callTool(sid, m, "Bash", { command: `echo ${m}_${i}` }, 60 + i)
    ));
    return r.every((e, i) => {
      const own = e.result.includes(`${markers[i]}_${i}`);
      const leak = markers.some((m, j) => j !== i && e.result.includes(`${m}_${j}`));
      return own && !leak;
    });
  });

  await test("N: Concurrent long + short (concurrency proof)", async () => {
    // Use TWO separate sessions to avoid HTTP-level serialization
    const sid2 = await initSession();
    await rpc(sid2, "notifications/initialized", {}, 2);
    const t0 = Date.now();
    const [slow, fast] = await Promise.all([
      callTool(sid, "N-slow", "Bash", { command: "powershell -c \"Start-Sleep -Milliseconds 2000; echo SLOW_DONE\"" }, 70),
      callTool(sid2, "N-fast", "Bash", { command: "echo FAST_DONE" }, 71),
    ]);
    const total = Date.now() - t0;
    const fastTime = fast.t1 - fast.t0;
    const slowTime = slow.t1 - slow.t0;
    console.log(`    slow=${slowTime}ms fast=${fastTime}ms total=${total}ms`);
    // True concurrency: fast completes much faster than slow 
    return fast.result.includes("FAST_DONE") && slow.result.includes("SLOW_DONE") && fastTime < slowTime / 2;
  });

  console.log("\n═══ SUMMARY ═══");
  let pass = 0, fail = 0;
  for (const [t, r] of Object.entries(results)) {
    if (r === "PASS") pass++; else fail++;
  }
  console.log(`${pass} passed, ${fail} failed out of ${pass + fail}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
