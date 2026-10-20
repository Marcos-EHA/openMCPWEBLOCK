import { c as _c } from "react-compiler-runtime";
import React, { useEffect, useRef } from 'react';
import { Box, Text } from '../../ink.js';
import { MCPSettings } from '../../components/mcp/index.js';
import { MCPReconnect } from '../../components/mcp/MCPReconnect.js';
import { useMcpToggleEnabled } from '../../services/mcp/MCPConnectionManager.js';
import { useAppState, useAppStateMaybeOutsideOfProvider } from '../../state/AppState.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { PluginSettings } from '../plugin/PluginSettings.js';
import { WebModelSelector } from '../../components/WebModelSelector.js';
import { WebRelayAgentSetup } from './WebRelayAgentSetup.js';
import { MasterSessionManager } from './MasterSessionManager.js';
import { MasterSessionLaunchSetup } from './MasterSessionLaunchSetup.js';
import { Select } from '../../components/CustomSelect/index.js';
import { getWebPlatformById } from '../../utils/webPlatforms.js';
import {
  saveCurrentProjectConfig,
  getCurrentProjectConfig,
  type McpExecutionMode,
} from '../../utils/config.js';
import { sendWebPrompt } from '../../services/webRelay/WebRelayProvider.js';
import { MCP_PORT } from '../../services/mcpServer/mcpPort.js';
import { runCoordinatedWebTask, type WebRelayCoordinatorEvent } from '../../services/webRelay/WebRelayCoordinator.js';
import { getConfiguredMcpServerNames, getMcpConfigByName } from '../../services/mcp/config.js';
import { validateMcpModeConnectivity } from '../../services/mcp/client.js';
import { useOrchestratorState } from '../../hooks/useOrchestratorState.js';
import type { AppState as OrchestrationAppState } from '../../services/webRelay/orchestration/AppState.js';
import { SentinelConsole } from './SentinelConsole.js';
import { MCPBridgeMenu } from './MCPBridgeMenu.js';



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
  useEffect(() => {
    saveCurrentProjectConfig(config => config.mcpExecutionMode === 'web' ? config : ({ ...config, mcpExecutionMode: 'web' }));
  }, []);
  const [launchTarget, setLaunchTarget] = React.useState<'master' | 'relay' | 'chrome-profile' | null>(null);
  const [selectedPlatform, setSelectedPlatform] = React.useState<string | null>(null);

  if (!launchTarget) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">Elige qué quieres lanzar</Text>
        <Select
          options={[
            {
              label: 'Perfiles Relay (Guest, Master o Chrome aislado)',
              value: 'relay' as const,
              description: 'Configura los perfiles de las instancias Relay.',
            },
            ...(process.platform === 'win32' ? [{
              label: 'ChatGPT — usar mi perfil Chrome normal',
              value: 'chrome-profile' as const,
              description: 'Acceso directo para copiar tu perfil a instancias Relay aisladas; no comparte la ventana normal.',
            }] : []),
            {
              label: 'Solo sesiones Master',
              value: 'master' as const,
              description: 'Recomendado si no quieres cerrar Chrome normal: inicia sesión una vez en el perfil OpenMCP y reutilízalo. No copia tu perfil normal.',
            },
          ]}
          onChange={(value: 'master' | 'relay' | 'chrome-profile' | undefined) => {
            if (!value) return;
            setLaunchTarget(value);
            if (value === 'chrome-profile') setSelectedPlatform('chatgpt');
          }}
          onCancel={() => onComplete('Web mode setup cancelled')}
          visibleOptionCount={3}
        />
        <Text dimColor>Las sesiones autenticadas Relay pueden abrir temporalmente la Master elegida para copiar su sesión.</Text>
      </Box>
    );
  }

  if (launchTarget === 'master') {
    return <MasterSessionLaunchSetup onComplete={onComplete} />;
  }

  if (!selectedPlatform) {
    return (
      <WebModelSelector
        initialValue={getCurrentProjectConfig().selectedWebPlatform}
        onSelect={(platformId) => {
          setSelectedPlatform(platformId);
        }}
        onCancel={() => onComplete('Web mode setup cancelled')}
      />
    );
  }

  return (
    <WebRelayAgentSetup
      platformId={selectedPlatform}
      onComplete={onComplete}
      chromeProfilePreset={launchTarget === 'chrome-profile'}
    />
  );
}
function MCPSetMode({ mode, onComplete }: { mode: 'api' | 'web' | 'local'; onComplete: (message: string) => void }) {
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

function MCPAgentTask({
  task,
  onComplete,
}: {
  task: string
  onComplete: (message: string) => void
}) {
  const { state } = useOrchestratorState()
  const [events, setEvents] = React.useState<WebRelayCoordinatorEvent[]>([])
  const didRun = useRef(false)
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete
  const config = getCurrentProjectConfig()
  const platformId = config.selectedWebPlatform ?? 'chatgpt'

  useEffect(() => {
    if (didRun.current) return
    didRun.current = true

    let taskTraceId: string | undefined
    void runCoordinatedWebTask({
      prompt: task,
      platformId,
      agents: Object.values(state.agents).filter(agent =>
        config.webRelayAgentIds?.includes(agent.agentId),
      ),
      coordinatorAgentId: config.webRelayCoordinatorAgentId,
      orchestratorBrain: config.webRelayOrchestratorBrain ?? 'api',
      sendPrompt: (prompt, targetPlatformId, agentId) =>
        sendWebPrompt(prompt, targetPlatformId, agentId),
      onEvent: event => {
        if (event.type === 'task-started') taskTraceId = event.taskId
        setEvents(previous => [...previous, event])
      },
    }).then(result => {
      const sections = [
        ...(taskTraceId ? [`TRAZA COMPLETA · taskId: ${taskTraceId} · MCP: workspace_task_trace`] : []),
        result.dispatchMode === 'coordinated'
          ? `Modo agente Â· coordinador: ${result.coordinatorId}`
          : `Modo agente Â· envío directo a Relay: ${result.directAgentId ?? result.coordinatorId}`,
      ]
      if (result.directResponse !== undefined) {
        sections.push(
          `RESPUESTA DIRECTA · ${result.directAgentId ?? result.coordinatorId}\n${result.directResponse}`,
        )
      } else if (result.planningResponse) {
        sections.push(
          `${result.workerResponses.length === 0 ? 'RESPUESTA DEL AGENTE' : 'PLAN DEL COORDINADOR'} Â· ${result.coordinatorId}\n` +
          `${result.planningResponse}`,
        )
      }
      for (const worker of result.workerResponses) {
        sections.push(
          `INSTANCIA Â· ${worker.agentId}\nTarea: ${worker.task}\n` +
          (worker.response !== undefined
            ? `Texto devuelto por Web Relay:\n${worker.response}`
            : `Error:\n${worker.error}`),
        )
      }
      if (result.reviewResponse !== undefined) {
        sections.push(`SEGUIMIENTO DEL COORDINADOR Â· ${result.coordinatorId}\n${result.reviewResponse}`)
      } else if (result.reviewError) {
        sections.push(`ERROR DE SEGUIMIENTO Â· ${result.coordinatorId}\n${result.reviewError}`)
      }
      onCompleteRef.current(sections.join('\n\nâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€\n\n'))
    }).catch(error => {
      const detail = error instanceof Error ? error.message : String(error)
      onCompleteRef.current(`No se pudo completar la coordinaciÃ³n Web Relay: ${detail}`)
    })
  }, [platformId, state.agents, task])

  const latestStatus = events.map(event => {
    switch (event.type) {
      case 'agent-ready':
        return `${event.role} ${event.agentId}: conectada y esperando tarea.`
      case 'planning-started':
        return `Coordinador ${event.agentId}: preparando el plan.`
      case 'plan-ready':
        return `Coordinador ${event.agentId}: plan recibido; se inicia la delegaciÃ³n.`
      case 'direct-response':
        return `Agente ${event.agentId}: texto devuelto por Web Relay.`
      case 'worker-started':
        return `Worker ${event.agentId}: ejecutando su tarea asignada.`
      case 'worker-response':
        return `Worker ${event.agentId}: respuesta recibida.`
      case 'worker-error':
        return `Worker ${event.agentId}: error â€” ${event.error}`
      case 'review-started':
        return `Coordinador ${event.agentId}: revisando el avance de los workers.`
      case 'review-response':
        return `Coordinador ${event.agentId}: seguimiento listo.`
      case 'review-error':
        return `Coordinador ${event.agentId}: error de seguimiento â€” ${event.error}`
      case 'task-started':
        return `Tarea ${event.taskId}: proceso iniciado.`
      case 'task-finished':
        return `Tarea ${event.taskId}: proceso ${event.status}.`
    }
  })
  const panels = new Map<string, {
    role: 'coordinador' | 'worker'
    status: string
    task?: string
    plan?: string
    response?: string
    review?: string
    error?: string
  }>()
  for (const event of events) {
    const panel = panels.get(event.agentId) ?? {
      role: 'worker' as const,
      status: 'En espera',
    }
    switch (event.type) {
      case 'agent-ready':
        panels.set(event.agentId, {
          ...panel,
          role: event.role,
          status: 'En espera de asignaciÃ³n',
        })
        break
      case 'planning-started':
        panels.set(event.agentId, { ...panel, role: 'coordinador', status: 'Preparando plan' })
        break
      case 'plan-ready':
        panels.set(event.agentId, { ...panel, role: 'coordinador', status: 'Delegando a workers', plan: event.response })
        break
      case 'direct-response':
        panels.set(event.agentId, {
          ...panel,
          role: 'coordinador',
          status: 'Respuesta recibida',
          response: event.response,
        })
        break
      case 'worker-started':
        panels.set(event.agentId, {
          ...panel,
          role: 'worker',
          status: 'Trabajando',
          task: event.prompt,
        })
        break
      case 'worker-response':
        panels.set(event.agentId, { ...panel, role: 'worker', status: 'Respuesta recibida', response: event.response })
        break
      case 'worker-error':
        panels.set(event.agentId, { ...panel, role: 'worker', status: 'Error', error: event.error })
        break
      case 'review-started':
        panels.set(event.agentId, { ...panel, role: 'coordinador', status: 'Supervisando resultados' })
        break
      case 'review-response':
        panels.set(event.agentId, { ...panel, role: 'coordinador', status: 'Seguimiento listo', review: event.response })
        break
      case 'review-error':
        panels.set(event.agentId, { ...panel, role: 'coordinador', status: 'Error de seguimiento', error: event.error })
        break
      case 'task-started':
      case 'task-finished':
        break
    }
  }

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">Modo agente Â· coordinaciÃ³n Web Relay</Text>
      <Text>Tarea: {task}</Text>
      <Text dimColor>Coordinación: {(config.webRelayOrchestratorBrain ?? 'api') === 'api' ? 'cerebro API local; no consume worker' : `Relay Web ${config.webRelayCoordinatorAgentId ?? 'primary inicial'}`} · independiente de Sentinel (Gemini).</Text>
      <Text dimColor>Se muestran por instancia la peticiÃ³n enviada y el texto devuelto por Web Relay. No se expone razonamiento privado ni el protocolo interno de SA.</Text>
      {Array.from(panels.entries()).map(([agentId, panel], index, allPanels) => (
        <Box key={agentId} flexDirection="column">
          <Text bold color={panel.error ? 'error' : panel.status.includes('Trabajando') || panel.status.includes('Supervisando') ? 'warning' : 'cyan'}>
            {agentId} Â· {panel.role} Â· {panel.status}
          </Text>
          {panel.task && <Text>PeticiÃ³n enviada:\n{panel.task}</Text>}
          {panel.plan && <Text>Plan devuelto por el coordinador:\n{panel.plan}</Text>}
          {panel.response && <Text>Texto devuelto por Web Relay (mensaje visible capturado):\n{panel.response}</Text>}
          {panel.review && <Text>Seguimiento del coordinador:\n{panel.review}</Text>}
          {panel.error && <Text color="error">Error: {panel.error}</Text>}
          {index < allPanels.length - 1 && (
            <Text dimColor>â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€</Text>
          )}
        </Box>
      ))}
      {panels.size === 0 && latestStatus.map((status, index) => (
        <Text key={`${index}-${status}`} dimColor>{status}</Text>
      ))}
    </Box>
  )
}

export function MCPStatus({
  onComplete,
  customAppState,
}: {
  onComplete: (message: string) => void
  customAppState?: OrchestrationAppState
}) {
  const mcpClients = useAppStateMaybeOutsideOfProvider((s: any) => s?.mcp?.clients) ?? [];
  const { state: orchState } = useOrchestratorState(customAppState);
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
      const saServerStatus = await readSAServerStatus()

      const lines = [
        `MCP mode: ${mode}`,
        `SuperAssistant MCP server :${MCP_PORT}: ${saServerStatus.running ? 'running' : 'unavailable'}`,
        `  Relay control API: ${saServerStatus.relayAvailable ? 'available' : 'unavailable'}`,
        `  Connected SA sessions: ${saServerStatus.connections ?? 'unknown'}`,
        `  Exposed MCP tools: ${saServerStatus.tools ?? 'unknown'}`,
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

      // Web Relay Orchestration block from AppState projection
      lines.push('');
      lines.push('Web Relay Orchestration:');
      const healthState = orchState.systemHealth;
      const health = !healthState
        ? 'unknown'
        : healthState.mcpServerRunning &&
            healthState.deadInstances === 0 &&
            healthState.unknownOutcomes === 0
          ? 'healthy'
          : 'degraded';
      lines.push(`  System Health: ${health}`);

      const sentinel = orchState.sentinel;
      if (sentinel) {
        lines.push(
          `  Sentinel: ${sentinel.healthy ? 'healthy' : 'issues found'} (${sentinel.agentsChecked} checked, ${sentinel.issuesFound} issues)`,
        );
        for (const check of sentinel.details) {
          const identity = check.sessionMode === 'authenticated'
            ? `authenticated Â· Master ${check.masterSessionSourceName ?? check.masterSessionSourceId ?? 'source missing'}`
            : `${check.sessionMode ?? 'session unknown'} Â· no Master required`
          const saConfiguration = check.saConfiguration
          const saReady = saConfiguration?.inspected === true &&
            saConfiguration.mcpEnabled === true &&
            saConfiguration.pushContentMode === true &&
            saConfiguration.autoInsert === true &&
            saConfiguration.autoSubmit === true &&
            saConfiguration.autoExecute === true &&
            saConfiguration.sidebarVisible === true &&
            saConfiguration.compactButtonVisible === true
          lines.push(
            `    ${check.agentId} [${identity}] Chrome ${check.portAlive ? 'OK' : 'unreachable'}, ` +
            `SA config ${saReady ? 'ready' : saConfiguration?.inspected ? 'needs attention' : 'unverified'}, ` +
            `tab ${saConfiguration?.pageVisibility ?? 'unmeasured'}/focus ${
              saConfiguration?.pageHasFocus === null || saConfiguration?.pageHasFocus === undefined
                ? 'unmeasured'
                : saConfiguration.pageHasFocus ? 'yes' : 'no'
            }, ` +
            `MCP ${check.mcpAlive === null ? 'not checked' : check.mcpAlive ? 'OK' : 'unavailable'}`,
          );
          for (const diagnostic of check.diagnostics) {
            lines.push(
              `      ${diagnostic.severity.toUpperCase()} [${diagnostic.code}]: ${diagnostic.message}`,
            );
          }
        }
        const recentLogs = sentinel.logs?.slice(0, 5) ?? [];
        if (recentLogs.length > 0) {
          lines.push('  Recent Sentinel logs:');
          for (const entry of recentLogs) {
            lines.push(
              `    ${new Date(entry.timestamp).toLocaleTimeString()} ${entry.severity.toUpperCase()} ` +
              `[${entry.code}]${entry.agentId ? ` ${entry.agentId}` : ''}: ${entry.message}`,
            );
          }
        }
      } else {
        lines.push('  Sentinel: not scanned yet');
      }

      const agents = Object.values(orchState.agents);
      if (agents.length === 0) {
        lines.push('  Agents: none registered');
      } else {
        lines.push(`  Agents (${agents.length}):`);
        for (const a of agents) {
          const purpose = a.role?.startsWith('manual-user-') ? 'user/manual' : 'agent'
          lines.push(
            `    â€¢ ${a.agentId} [${a.platformId}, ${purpose}, role ${a.role ?? 'unknown'}]: ${a.status}, ${a.sessionMode ?? 'unknown'} session` +
            ` (SA: ${a.saExtensionId ? 'detected' : 'unknown'}, port: ${a.debugPort ?? 'none'}, instance: ${a.instanceId ?? 'none'})`,
          );
        }
      }

      if (orchState.lastError) {
        lines.push(`  Last Error: ${orchState.lastError}`);
      }

      onComplete(lines.join('\n'))
    }

    void runStatus()
  }, [mcpClients, orchState, onComplete]);

  return null;
}

async function readSAServerStatus(): Promise<{
  running: boolean
  relayAvailable: boolean
  connections?: number
  tools?: number
}> {
  try {
    const response = await fetch(`http://127.0.0.1:${MCP_PORT}/status`, {
      signal: AbortSignal.timeout(1500),
    })
    if (!response.ok) {
      return { running: false, relayAvailable: false }
    }
    const status = await response.json() as {
      connections?: unknown
      tools?: unknown
    }
    let relayAvailable = false
    try {
      const relayResponse = await fetch(`http://127.0.0.1:${MCP_PORT}/relay/status`, {
        signal: AbortSignal.timeout(1500),
      })
      if (relayResponse.ok) {
        const relayStatus = await relayResponse.json() as { available?: unknown }
        relayAvailable = relayStatus.available === true
      }
    } catch {
      relayAvailable = false
    }

    return {
      running: true,
      relayAvailable,
      connections: typeof status.connections === 'number' ? status.connections : undefined,
      tools: typeof status.tools === 'number' ? status.tools : undefined,
    }
  } catch {
    return { running: false, relayAvailable: false }
  }
}

function MCPHome({ onComplete }: { onComplete: (message: string) => void }) {
  const [section, setSection] = React.useState<string | null>(null);
  if (section === 'bridge') return <MCPBridgeMenu onComplete={onComplete} />;
  if (section === 'settings') return <MCPSettings onComplete={onComplete} />;
  if (section === 'status') return <MCPStatus onComplete={onComplete} />;
  return <Box flexDirection="column" padding={1}>
    <Text bold color="cyan">MCP y conexiones</Text>
    <Select
      options={[
        { label: 'Conexión con SuperAssistant', value: 'bridge', description: 'Iniciar, reiniciar o detener el puente local.' },
        { label: 'Servidores y configuración', value: 'settings', description: 'Administrar los servidores MCP configurados.' },
        { label: 'Estado de conexiones', value: 'status', description: 'Consultar conexiones, herramientas y sesiones.' },
      ]}
      onChange={(value: string | undefined) => { if (value) setSection(value); }}
      onCancel={() => onComplete('Menú MCP cerrado')}
      visibleOptionCount={3}
    />
  </Box>;
}

export async function call(onDone: LocalJSXCommandOnDone, _context: unknown, args?: string): Promise<React.ReactNode> {
  if (!args || !args.trim()) return <MCPHome onComplete={onDone} />;
  if (args.trim().split(/\s+/)[0] === 'bridge') {
    const parts = args.trim().split(/\s+/);
    if (parts.length === 1) return <MCPBridgeMenu onComplete={onDone} />;
    const action = parts[1];
    if (parts.length !== 2 || !['start', 'stop', 'restart', 'status'].includes(action)) {
      onDone('Uso: /mcp bridge start | stop | restart | status');
      return null;
    }
    try {
      const { applicationMCPBridge, startApplicationMCPBridge, restartApplicationMCPBridge } = await import('../../services/mcpServer/ApplicationMCPBridge.js');
      const status = action === 'start' ? await startApplicationMCPBridge()
        : action === 'restart' ? await restartApplicationMCPBridge()
        : action === 'stop' ? await applicationMCPBridge.stop()
        : applicationMCPBridge.status();
      const label = status.state === 'owned' ? 'activo, administrado por esta aplicación'
        : status.state === 'external' ? 'activo en otro proceso; esta aplicación no lo detiene'
        : status.state === 'error' ? `error: ${status.error}` : 'detenido';
      onDone(`Conexión con SuperAssistant: ${label}. Solo funciona en modo Web.`);
    } catch (error) {
      onDone(error instanceof Error ? error.message : String(error));
    }
    return null;
  }
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
    if (parts[0] === 'set-mode' && parts[1] && ['api', 'web', 'local'].includes(parts[1])) {
      const mode = parts[1] as 'api' | 'web' | 'local';
      if (mode === 'web') {
        return <MCPSetWebMode onComplete={onDone} />;
      } else {
        return <MCPSetMode mode={mode} onComplete={onDone} />;
      }
    }
    if (parts[0] === 'status') {
      return <MCPStatus onComplete={onDone} />;
    }
    if (parts[0] === 'master-session') {
      return <MasterSessionManager args={args.trim().slice('master-session'.length).trim()} onComplete={onDone} />;
    }
    if (parts[0] === 'ask') {
      const task = args.trim().slice('ask'.length).trim()
      if (!task) {
        onDone('Uso: /mcp ask <tarea>. El coordinador Web seleccionado asigna tareas a las workers y revisa sus respuestas; es independiente de Sentinel (Gemini).')
        return null
      }
      return <MCPAgentTask task={task} onComplete={onDone} />
    }
    if (parts[0] === 'sentinel') {
      return <SentinelConsole onComplete={onDone} />;
    }
    if (parts[0] === 'lienzo') {
      const { toggleLienzo } = await import('../../services/collaboration/lienzoToggle.js');
      const on = toggleLienzo();
      onDone(on ? 'Lienzo TUI activado' : 'Lienzo TUI desactivado');
      return null;
    }
    if (parts[0] === 'workspace') {
      const { workspaceCmd } = await import('./workspaceCommand.js');
      const result = workspaceCmd(parts.slice(1).join(' '));
      onDone(result);
      return null;
    }
    if (parts[0] === 'recover') {
      return <SentinelConsole initialStep="recover-purpose" onComplete={onDone} />;
    }
  }

  // Redirect base /mcp command to /plugins installed tab for ant users
  if ('external' as string === 'ant') {
    return <PluginSettings onComplete={onDone} args="manage" showMcpRedirectMessage />;
  }
  return <MCPSettings onComplete={onDone} />;
}
