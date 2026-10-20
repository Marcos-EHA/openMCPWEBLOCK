/**
 * Standalone launcher for openMCPWEBLOCK MCP Server.
 * Exposes openweblock core tools (Read, Write, Edit, Bash, etc.) and
 * SuperAssistant/ChatGPT aliases over StreamableHTTP and SSE on MCP_PORT (3006 by default).
 */
import { MCPSSEServer } from "../src/services/mcpServer/MCPSSEServer.js";
import { MCP_PORT } from "../src/services/mcpServer/mcpPort.js";
import { enableConfigs } from "../src/utils/config.js";

const port = MCP_PORT;

async function main() {
  enableConfigs();
  const server = new MCPSSEServer({ port: MCP_PORT });
  await server.start();
  console.log("====================================================");
  console.log("  openMCPWEBLOCK MCP Server Active");
  console.log("====================================================");
  console.log("  Port:            " + port);
  console.log("  StreamableHTTP:  http://localhost:" + port + "/mcp");
  console.log("  SSE Endpoint:    http://localhost:" + port + "/sse");
  console.log("  Health Check:    http://localhost:" + port + "/healthz");
  console.log("  Tools loaded:    " + server.getStatus().tools);
  console.log("====================================================");

  const shutdown = async () => {
    console.log("[MCP Server] Shutting down...");
    await server.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[MCP Server] Failed to start:", err);
  process.exit(1);
});
