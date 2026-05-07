import { c as _c } from "react-compiler-runtime";
import React, { useEffect, useRef } from 'react';
import { MCPSettings } from '../../components/mcp/index.js';
import { MCPReconnect } from '../../components/mcp/MCPReconnect.js';
import { useMcpToggleEnabled } from '../../services/mcp/MCPConnectionManager.js';
import { useAppState } from '../../state/AppState.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { PluginSettings } from '../plugin/PluginSettings.js';
import { WebModelSelector } from '../../components/WebModelSelector.js';
import { getWebPlatformById } from '../../utils/webPlatforms.js';
import { saveCurrentProjectConfig, getCurrentProjectConfig } from '../../utils/config.js';
import { getConfiguredMcpServerNames, getMcpConfigByName } from '../../services/mcp/config.js';
import { validateMcpModeConnectivity } from '../../services/mcp/client.js';
import path from 'path';
import { spawn } from 'child_process';

// TODO: This is a hack to get the context value from toggleMcpServer (useContext only works in a component)
// Ideally, all MCP state and functions would be in global state.
function MCPToggle(t0: any) {
  const $ = _c(7);
  const {
    action,
    target,
    onComplete
  } = t0;
  const mcpClients = useAppState(_temp);
  const toggleMcpServer = useMcpToggleEnabled();
  const didRun = useRef(false);
  let t1;
  let t2;
  if ($[0] !== action || $[1] !== mcpClients || $[2] !== onComplete || $[3] !== target || $[4] !== toggleMcpServer) {
    t1 = () => {
      if (didRun.current) {
        return;
      }
      didRun.current = true;
      const isEnabling = action === "enable";
      const clients = mcpClients.filter(_temp2);
      const toToggle = target === "all" ? clients.filter((c_0: any) => isEnabling ? c_0.type === "disabled" : c_0.type !== "disabled") : clients.filter((c_1: any) => c_1.name === target);
      if (toToggle.length === 0) {
        onComplete(target === "all" ? `All MCP servers are already ${isEnabling ? "enabled" : "disabled"}` : `MCP server "${target}" not found`);
        return;
      }
      for (const s_0 of toToggle) {
        toggleMcpServer(s_0.name);
      }
      onComplete(target === "all" ? `${isEnabling ? "Enabled" : "Disabled"} ${toToggle.length} MCP server(s)` : `MCP server "${target}" ${isEnabling ? "enabled" : "disabled"}`);
    };
    t2 = [action, target, mcpClients, toggleMcpServer, onComplete];
    $[0] = action;
    $[1] = mcpClients;
    $[2] = onComplete;
    $[3] = target;
    $[4] = toggleMcpServer;
    $[5] = t1;
    $[6] = t2;
  } else {
    t1 = $[5];
    t2 = $[6];
  }
  useEffect(t1, t2);
  return null;
}
function _temp2(c: any) {
  return c.name !== "ide";
}
function _temp(s: any) {
  return s.mcp.clients;
}
function MCPSetWebMode({ onComplete }: { onComplete: (message: string) => void }) {
  const [selectedPlatform, setSelectedPlatform] = React.useState<string | null>(null);

  if (!selectedPlatform) {
    return (
      <WebModelSelector
        onSelect={(platformId) => {
          setSelectedPlatform(platformId);
        }}
        onCancel={() => onComplete('Web mode setup cancelled')}
      />
    );
  }

  // Once platform is selected, save config and open web page
  React.useEffect(() => {
    if (!selectedPlatform) {
      return;
    }

    const openSelectedPlatform = async () => {
      saveCurrentProjectConfig(config => ({
        ...config,
        mcpExecutionMode: 'web' as const,
        selectedWebPlatform: selectedPlatform,
      }));

      const platform = getWebPlatformById(selectedPlatform);
      if (!platform) {
        onComplete(`Error: Unknown platform '${selectedPlatform}'`);
        return;
      }

      try {
        const orchestratorPath = path.resolve(process.cwd(), 'mcp-orchestrator.js');
        const cp = spawn(process.execPath, [orchestratorPath, '--url', platform.url, '--keepAlive'], {
          cwd: process.cwd(),
          detached: true,
          stdio: 'ignore',
          shell: false,
        });
        cp.unref();
        onComplete(`MCP execution mode set to 'web' with platform '${platform.name}'. Opening ${platform.url}...`);
      } catch (error: any) {
        onComplete(`Error launching web relay: ${error?.message ?? String(error)}`);
      }
    };

    void openSelectedPlatform();
  }, [selectedPlatform, onComplete]);

  return null;
}
function MCPSetMode({ mode, onComplete }: { mode: 'api' | 'web' | 'auto'; onComplete: (message: string) => void }) {
  const didRun = useRef(false);
  useEffect(() => {
    if (didRun.current) return;
    didRun.current = true;

    if (mode === 'web') {
      // Web mode is handled by MCPSetWebMode.
      return;
    }

    saveCurrentProjectConfig(config => ({
      ...config,
      mcpExecutionMode: mode,
    }));
    onComplete(`MCP execution mode set to '${mode}'`);
  }, [mode, onComplete]);
  return null;
}
function MCPStatus({ onComplete }: { onComplete: (message: string) => void }) {
  const mcpClients = useAppState((s: any) => s.mcp.clients);
  const didRun = useRef(false);

  useEffect(() => {
    if (didRun.current) return;
    didRun.current = true;

    const runStatus = async () => {
      const config = getCurrentProjectConfig();
      const mode = (config.mcpExecutionMode || 'api') as McpExecutionMode;
      const configuredServerNames = getConfiguredMcpServerNames();
      const activeServerNames = mcpClients.map((client: any) => client.name);
      const selectedWebPlatformId = config.selectedWebPlatform;
      const selectedWebPlatform = selectedWebPlatformId ? getWebPlatformById(selectedWebPlatformId) : null;

      const serverConfigs = configuredServerNames
        .map(name => [name, getMcpConfigByName(name)] as const)
        .filter(([, cfg]) => cfg !== null)
        .reduce<Record<string, any>>((acc, [name, cfg]) => {
          acc[name] = cfg
          return acc
        }, {})

      const connectivity = await validateMcpModeConnectivity(mode, serverConfigs)

      const lines = [
        `MCP mode: ${mode}`,
        selectedWebPlatformId
          ? `Selected web platform: ${selectedWebPlatform ? selectedWebPlatform.name : selectedWebPlatformId}${selectedWebPlatform ? ` (${selectedWebPlatform.url})` : ''}`
          : `Selected web platform: none`,
        `Configured MCP servers: ${
          configuredServerNames.length > 0
            ? configuredServerNames.join(', ')
            : 'none'
        }`,
        `Active MCP clients: ${
          activeServerNames.length > 0 ? activeServerNames.join(', ') : 'none'
        }`,
        `Expected servers for mode: ${connectivity.expectedServers.join(', ')}`,
        `Reachable servers: ${
          connectivity.reachableServers.length > 0
            ? connectivity.reachableServers.join(', ')
            : 'none'
        }`,
      ];

      if (connectivity.unreachableServers.length > 0) {
        lines.push(
          `Unreachable expected servers: ${connectivity.unreachableServers.join(', ')}`,
        )
      }
      if (connectivity.missingServers.length === 0) {
        lines.push('No expected servers are missing.');
      } else {
        lines.push(`Missing expected servers: ${connectivity.missingServers.join(', ')}`);
        lines.push('MCP will degrade gracefully to available servers and built-in tools.');
      }
      onComplete(lines.join('\n'))
    }

    void runStatus()
  }, [mcpClients, onComplete]);

  return null;
}
export async function call(onDone: LocalJSXCommandOnDone, _context: unknown, args?: string): Promise<React.ReactNode> {
  if (args) {
    const parts = args.trim().split(/\s+/);

    // Allow /mcp no-redirect to bypass the redirect for testing
    if (parts[0] === 'no-redirect') {
      return <MCPSettings onComplete={onDone} />;
    }
    if (parts[0] === 'reconnect' && parts[1]) {
      return <MCPReconnect serverName={parts.slice(1).join(' ')} onComplete={onDone} />;
    }
    if (parts[0] === 'enable' || parts[0] === 'disable') {
      return <MCPToggle action={parts[0]} target={parts.length > 1 ? parts.slice(1).join(' ') : 'all'} onComplete={onDone} />;
    }
    if (parts[0] === 'set-mode' && parts[1] && ['api', 'web', 'auto'].includes(parts[1])) {
      const mode = parts[1] as 'api' | 'web' | 'auto';
      if (mode === 'web') {
        return <MCPSetWebMode onComplete={onDone} />;
      } else {
        return <MCPSetMode mode={mode} onComplete={onDone} />;
      }
    }
    if (parts[0] === 'status') {
      return <MCPStatus onComplete={onDone} />;
    }
  }

  // Redirect base /mcp command to /plugins installed tab for ant users
  if ('external' as string === 'ant') {
    return <PluginSettings onComplete={onDone} args="manage" showMcpRedirectMessage />;
  }
  return <MCPSettings onComplete={onDone} />;
}
