import { c as _c } from "react-compiler-runtime";
import figures from 'figures';
import * as React from 'react';
import { Suspense, use } from 'react';
import { getSessionId } from '../../bootstrap/state.js';
import type { LocalJSXCommandContext } from '../../commands.js';
import { useIsInsideModal } from '../../context/modalContext.js';
import { Box, Text, useTheme } from '../../ink.js';
import { type AppState, useAppState } from '../../state/AppState.js';
import { getCwd } from '../../utils/cwd.js';
import { getCurrentSessionTitle } from '../../utils/sessionStorage.js';
import { buildAccountProperties, buildAPIProviderProperties, buildIDEProperties, buildInstallationDiagnostics, buildInstallationHealthDiagnostics, buildMcpProperties, buildMemoryDiagnostics, buildSandboxProperties, buildSettingSourcesProperties, type Diagnostic, getModelDisplayLabel, type Property } from '../../utils/status.js';
import type { ThemeName } from '../../utils/theme.js';
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js';
import { useOrchestratorState } from '../../hooks/useOrchestratorState.js';
import type { AppState as OrchestrationAppState } from '../../services/webRelay/orchestration/AppState.js';
import type { AgentLifecycleStatus } from '../../services/webRelay/orchestration/types.js';
type Props = {
  context: LocalJSXCommandContext;
  diagnosticsPromise: Promise<Diagnostic[]>;
};
function buildPrimarySection(): Property[] {
  const sessionId = getSessionId();
  const customTitle = getCurrentSessionTitle(sessionId);
  const nameValue = customTitle ?? <Text dimColor>/rename to add a name</Text>;
  return [{
    label: 'Version',
    value: MACRO.DISPLAY_VERSION ?? MACRO.VERSION
  }, {
    label: 'Session name',
    value: nameValue
  }, {
    label: 'Session ID',
    value: sessionId
  }, {
    label: 'cwd',
    value: getCwd()
  }, ...buildAccountProperties(), ...buildAPIProviderProperties()];
}
function buildSecondarySection({
  mainLoopModel,
  mcp,
  theme,
  context
}: {
  mainLoopModel: AppState['mainLoopModel'];
  mcp: AppState['mcp'];
  theme: ThemeName;
  context: LocalJSXCommandContext;
}): Property[] {
  const modelLabel = getModelDisplayLabel(mainLoopModel);
  return [{
    label: 'Model',
    value: modelLabel
  }, ...buildIDEProperties(mcp.clients, context.options.ideInstallationStatus, theme), ...buildMcpProperties(mcp.clients, theme), ...buildSandboxProperties(), ...buildSettingSourcesProperties()];
}
export async function buildDiagnostics(): Promise<Diagnostic[]> {
  return [...(await buildInstallationDiagnostics()), ...(await buildInstallationHealthDiagnostics()), ...(await buildMemoryDiagnostics())];
}
function PropertyValue(t0) {
  const $ = _c(8);
  const {
    value
  } = t0;
  if (Array.isArray(value)) {
    let t1;
    if ($[0] !== value) {
      let t2;
      if ($[2] !== value.length) {
        t2 = (item, i) => <Text key={i}>{item}{i < value.length - 1 ? "," : ""}</Text>;
        $[2] = value.length;
        $[3] = t2;
      } else {
        t2 = $[3];
      }
      t1 = value.map(t2);
      $[0] = value;
      $[1] = t1;
    } else {
      t1 = $[1];
    }
    let t2;
    if ($[4] !== t1) {
      t2 = <Box flexWrap="wrap" columnGap={1} flexShrink={99}>{t1}</Box>;
      $[4] = t1;
      $[5] = t2;
    } else {
      t2 = $[5];
    }
    return t2;
  }
  if (typeof value === "string") {
    let t1;
    if ($[6] !== value) {
      t1 = <Text>{value}</Text>;
      $[6] = value;
      $[7] = t1;
    } else {
      t1 = $[7];
    }
    return t1;
  }
  return value;
}

export function getLifecycleColor(status: AgentLifecycleStatus): string | undefined {
  switch (status) {
    case 'ready':
      return 'green';
    case 'lost':
      return 'magenta';
    case 'error':
      return 'red';
    case 'stopping':
    case 'stopped':
      return undefined;
    case 'created':
    case 'starting':
    case 'chrome_ready':
    case 'session_ready':
    case 'extension_loading':
    case 'service_worker_ready':
    case 'mcp_ready':
    case 'sa_preparing':
    case 'sa_preparing':
    case 'restarting':
    default:
      return 'yellow';
  }
}

export function WebRelayOrchestrationSection({
  customAppState,
}: {
  customAppState?: OrchestrationAppState;
}): React.ReactNode {
  const { state } = useOrchestratorState(customAppState);
  const agents = Object.values(state.agents);

  return (
    <Box flexDirection="column">
      <Text bold={true}>Web Relay Orchestration</Text>
      <Box flexDirection="row" gap={1}>
        <Text bold={true}>System Health:</Text>
        <Text
          color={
            state.systemHealth?.status === 'healthy'
              ? 'green'
              : state.systemHealth?.status === 'degraded'
                ? 'yellow'
                : state.systemHealth?.status === 'unhealthy'
                  ? 'red'
                  : undefined
          }
        >
          {state.systemHealth?.status ?? 'unknown'}
        </Text>
      </Box>
      <Box flexDirection="row" gap={1}>
        <Text bold={true}>Sentinel:</Text>
        {state.sentinel ? (
          <Text color={state.sentinel.healthy ? 'green' : 'red'}>
            {state.sentinel.healthy ? 'healthy' : 'issues found'} (
            {state.sentinel.agentsChecked} checked, {state.sentinel.issuesFound} issues)
          </Text>
        ) : (
          <Text dimColor={true}>not scanned yet</Text>
        )}
      </Box>
      <Box flexDirection="column">
        <Text bold={true}>Agents ({agents.length}):</Text>
        {agents.length === 0 ? (
          <Box paddingLeft={2}>
            <Text dimColor={true}>No web agents registered</Text>
          </Box>
        ) : (
          agents.map(agent => {
            const color = getLifecycleColor(agent.status);
            const isDim = agent.status === 'stopped' || agent.status === 'stopping';
            const isSelected = state.selectedAgentId === agent.agentId;
            const relayPage = state.sentinel?.details.find(check => check.agentId === agent.agentId)?.saConfiguration;
            return (
              <Box key={agent.agentId} flexDirection="row" gap={1} paddingLeft={2}>
                <Text bold={isSelected}>
                  {isSelected ? '▶ ' : '• '}
                  {agent.agentId} [{agent.platformId}]:
                </Text>
                <Text color={color} dimColor={isDim} bold={agent.status === 'ready'}>
                  {agent.status}
                </Text>
                <Text dimColor={true}>
                  (instance: {agent.instanceId ?? 'none'}, port: {agent.debugPort ?? 'none'})
                </Text>
                {relayPage && (
                  <Text dimColor={true}>
                    (tab: {relayPage.pageVisibility ?? 'unmeasured'},
                    {' '}page focus: {relayPage.pageHasFocus === null || relayPage.pageHasFocus === undefined
                      ? 'unmeasured'
                      : relayPage.pageHasFocus
                        ? 'yes'
                        : 'no'})
                  </Text>
                )}
                {agent.unknownExecutions > 0 && (
                  <Text color="yellow">[{agent.unknownExecutions} unknown exec]</Text>
                )}
              </Box>
            );
          })
        )}
      </Box>
      {state.lastError && (
        <Box flexDirection="row" gap={1}>
          <Text bold={true} color="error">Last Error:</Text>
          <Text color="error">{state.lastError}</Text>
        </Box>
      )}
    </Box>
  );
}

export function Status(t0) {
  const $ = _c(20);
  const {
    context,
    diagnosticsPromise
  } = t0;
  const mainLoopModel = useAppState(_temp);
  const mcp = useAppState(_temp2);
  const [theme] = useTheme();
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = buildPrimarySection();
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  let t2;
  if ($[1] !== context || $[2] !== mainLoopModel || $[3] !== mcp || $[4] !== theme) {
    t2 = buildSecondarySection({
      mainLoopModel,
      mcp,
      theme,
      context
    });
    $[1] = context;
    $[2] = mainLoopModel;
    $[3] = mcp;
    $[4] = theme;
    $[5] = t2;
  } else {
    t2 = $[5];
  }
  let t3;
  if ($[6] !== t2) {
    t3 = [t1, t2];
    $[6] = t2;
    $[7] = t3;
  } else {
    t3 = $[7];
  }
  const sections = t3;
  const grow = useIsInsideModal() ? 1 : undefined;
  let t4;
  if ($[8] !== sections) {
    t4 = sections.map(_temp4);
    $[8] = sections;
    $[9] = t4;
  } else {
    t4 = $[9];
  }
  let t5;
  if ($[10] !== diagnosticsPromise) {
    t5 = <Suspense fallback={null}><Diagnostics promise={diagnosticsPromise} /></Suspense>;
    $[10] = diagnosticsPromise;
    $[11] = t5;
  } else {
    t5 = $[11];
  }
  let t6;
  if ($[12] !== grow || $[13] !== t4 || $[14] !== t5) {
    t6 = <Box flexDirection="column" gap={1} flexGrow={grow}>{t4}<WebRelayOrchestrationSection />{t5}</Box>;
    $[12] = grow;
    $[13] = t4;
    $[14] = t5;
    $[15] = t6;
  } else {
    t6 = $[15];
  }
  let t7;
  if ($[16] === Symbol.for("react.memo_cache_sentinel")) {
    t7 = <Text dimColor={true}><ConfigurableShortcutHint action="confirm:no" context="Settings" fallback="Esc" description="cancel" /></Text>;
    $[16] = t7;
  } else {
    t7 = $[16];
  }
  let t8;
  if ($[17] !== grow || $[18] !== t6) {
    t8 = <Box flexDirection="column" flexGrow={grow}>{t6}{t7}</Box>;
    $[17] = grow;
    $[18] = t6;
    $[19] = t8;
  } else {
    t8 = $[19];
  }
  return t8;
}
function _temp4(properties, i) {
  return properties.length > 0 && <Box key={i} flexDirection="column">{properties.map(_temp3)}</Box>;
}
function _temp3(t0, j) {
  const {
    label,
    value
  } = t0;
  return <Box key={j} flexDirection="row" gap={1} flexShrink={0}>{label !== undefined && <Text bold={true}>{label}:</Text>}<PropertyValue value={value} /></Box>;
}
function _temp2(s_0) {
  return s_0.mcp;
}
function _temp(s) {
  return s.mainLoopModel;
}
function Diagnostics(t0) {
  const $ = _c(5);
  const {
    promise
  } = t0;
  const diagnostics = use(promise);
  if (diagnostics.length === 0) {
    return null;
  }
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = <Text bold={true}>System Diagnostics</Text>;
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  let t2;
  if ($[1] !== diagnostics) {
    t2 = diagnostics.map(_temp5);
    $[1] = diagnostics;
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  let t3;
  if ($[3] !== t2) {
    t3 = <Box flexDirection="column" paddingBottom={1}>{t1}{t2}</Box>;
    $[3] = t2;
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  return t3;
}
function _temp5(diagnostic, i) {
  return <Box key={i} flexDirection="row" gap={1} paddingX={1}><Text color="error">{figures.warning}</Text>{typeof diagnostic === "string" ? <Text wrap="wrap">{diagnostic}</Text> : diagnostic}</Box>;
}
