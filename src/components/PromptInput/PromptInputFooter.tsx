import * as React from 'react';
import { memo, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { isBridgeEnabled } from '../../bridge/bridgeEnabled.js';
import { getBridgeStatus } from '../../bridge/bridgeStatusUtil.js';
import { useSetPromptOverlay } from '../../context/promptOverlayContext.js';
import type { VerificationStatus } from '../../hooks/useApiKeyVerification.js';
import type { IDESelection } from '../../hooks/useIdeSelection.js';
import { useSettings } from '../../hooks/useSettings.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { Box, Text } from '../../ink.js';
import { MCP_PORT } from '../../services/mcpServer/mcpPort.js';
import type { MCPServerConnection } from '../../services/mcp/types.js';
import { useAppState } from '../../state/AppState.js';
import type { ToolPermissionContext } from '../../Tool.js';
import type { Message } from '../../types/message.js';
import type { PromptInputMode, VimMode } from '../../types/textInputTypes.js';
import type { AutoUpdaterResult } from '../../utils/autoUpdater.js';
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js';
import { isUndercover } from '../../utils/undercover.js';
import { CoordinatorTaskPanel, useCoordinatorTaskCount } from '../CoordinatorAgentStatus.js';
import { getLastAssistantMessageId, StatusLine, statusLineShouldDisplay } from '../StatusLine.js';
import { Notifications } from './Notifications.js';
import { PromptInputFooterLeftSide } from './PromptInputFooterLeftSide.js';
import { PromptInputFooterSuggestions, type SuggestionItem } from './PromptInputFooterSuggestions.js';
import { PromptInputHelpMenu } from './PromptInputHelpMenu.js';
import { useOrchestratorState } from '../../hooks/useOrchestratorState.js';
import { getCurrentProjectConfig, saveCurrentProjectConfig } from '../../utils/config.js';
import { getWebRelayPoolStatus } from '../../services/webRelay/WebRelayPoolStatus.js'
import { setComposerDestination, setSentinelComposerMode, useSentinelComposerMode, useWebAgentComposerMode } from '../../services/geminiOrchestrator/sentinelComposerMode.js';
import { WebRelayActivityPanel } from './WebRelayActivityPanel.js';
type Props = {
  apiKeyStatus: VerificationStatus;
  debug: boolean;
  exitMessage: {
    show: boolean;
    key?: string;
  };
  vimMode: VimMode | undefined;
  mode: PromptInputMode;
  autoUpdaterResult: AutoUpdaterResult | null;
  isAutoUpdating: boolean;
  verbose: boolean;
  onAutoUpdaterResult: (result: AutoUpdaterResult) => void;
  onChangeIsUpdating: (isUpdating: boolean) => void;
  suggestions: SuggestionItem[];
  selectedSuggestion: number;
  maxColumnWidth?: number;
  toolPermissionContext: ToolPermissionContext;
  helpOpen: boolean;
  suppressHint: boolean;
  isLoading: boolean;
  tasksSelected: boolean;
  teamsSelected: boolean;
  bridgeSelected: boolean;
  tmuxSelected: boolean;
  teammateFooterIndex?: number;
  ideSelection: IDESelection | undefined;
  mcpClients?: MCPServerConnection[];
  isPasting?: boolean;
  isInputWrapped?: boolean;
  messages: Message[];
  isSearching: boolean;
  historyQuery: string;
  setHistoryQuery: (query: string) => void;
  historyFailedMatch: boolean;
  onOpenTasksDialog?: (taskId?: string) => void;
  onQuickAction?: (command: string) => void;
  onPrefillInput?: (input: string) => void;
};
function PromptInputFooter({
  apiKeyStatus,
  debug,
  exitMessage,
  vimMode,
  mode,
  autoUpdaterResult,
  isAutoUpdating,
  verbose,
  onAutoUpdaterResult,
  onChangeIsUpdating,
  suggestions,
  selectedSuggestion,
  maxColumnWidth,
  toolPermissionContext,
  helpOpen,
  suppressHint: suppressHintFromProps,
  isLoading,
  tasksSelected,
  teamsSelected,
  bridgeSelected,
  tmuxSelected,
  teammateFooterIndex,
  ideSelection,
  mcpClients,
  isPasting = false,
  isInputWrapped = false,
  messages,
  isSearching,
  historyQuery,
  setHistoryQuery,
  historyFailedMatch,
  onOpenTasksDialog,
  onQuickAction,
  onPrefillInput,
}: Props): ReactNode {
  const settings = useSettings();
  const {
    columns,
    rows
  } = useTerminalSize();
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const lastAssistantMessageId = useMemo(() => getLastAssistantMessageId(messages), [messages]);
  const isNarrow = columns < 80;
  // In fullscreen the bottom slot is flexShrink:0, so every row here is a row
  // stolen from the ScrollBox. Drop the optional StatusLine first. Non-fullscreen
  // has terminal scrollback to absorb overflow, so we never hide StatusLine there.
  const isFullscreen = isFullscreenEnvEnabled();
  const isShort = isFullscreen && rows < 24;

  // Pill highlights when tasks is the active footer item AND no specific
  // agent row is selected. When coordinatorTaskIndex >= 0 the pointer has
  // moved into CoordinatorTaskPanel, so the pill should un-highlight.
  // coordinatorTaskCount === 0 covers the bash-only case (no agent rows
  // exist, pill is the only selectable item).
  const coordinatorTaskCount = useCoordinatorTaskCount();
  const coordinatorTaskIndex = useAppState(s => s.coordinatorTaskIndex);
  const pillSelected = tasksSelected && (coordinatorTaskCount === 0 || coordinatorTaskIndex < 0);

  // Hide `? for shortcuts` if the user has a custom status line, or during ctrl-r
  const suppressHint = suppressHintFromProps || statusLineShouldDisplay(settings) || isSearching;
  // Fullscreen: portal data to FullscreenLayout — see promptOverlayContext.tsx
  const overlayData = useMemo(() => isFullscreen && suggestions.length ? {
    suggestions,
    selectedSuggestion,
    maxColumnWidth
  } : null, [isFullscreen, suggestions, selectedSuggestion, maxColumnWidth]);
  useSetPromptOverlay(overlayData);
  if (suggestions.length && !isFullscreen) {
    return <Box paddingX={2} paddingY={0}>
        <PromptInputFooterSuggestions suggestions={suggestions} selectedSuggestion={selectedSuggestion} maxColumnWidth={maxColumnWidth} />
      </Box>;
  }
  if (helpOpen) {
    return <PromptInputHelpMenu dimColor={true} fixedWidth={true} paddingX={2} />;
  }
  return <>
      <WebRelayActivityPanel />
      <Box flexDirection={isNarrow ? 'column' : 'row'} justifyContent={isNarrow ? 'flex-start' : 'space-between'} paddingX={2} gap={isNarrow ? 0 : 1}>
        <Box flexDirection="column" flexShrink={isNarrow ? 0 : 1}>
          {mode === 'prompt' && !isShort && !exitMessage.show && !isPasting && statusLineShouldDisplay(settings) && <StatusLine messagesRef={messagesRef} lastAssistantMessageId={lastAssistantMessageId} vimMode={vimMode} />}
          <PromptInputFooterLeftSide exitMessage={exitMessage} vimMode={vimMode} mode={mode} toolPermissionContext={toolPermissionContext} suppressHint={suppressHint} isLoading={isLoading} tasksSelected={pillSelected} teamsSelected={teamsSelected} teammateFooterIndex={teammateFooterIndex} tmuxSelected={tmuxSelected} isPasting={isPasting} isSearching={isSearching} historyQuery={historyQuery} setHistoryQuery={setHistoryQuery} historyFailedMatch={historyFailedMatch} onOpenTasksDialog={onOpenTasksDialog} />
        </Box>
        <Box flexShrink={1} flexDirection={isNarrow ? 'column' : 'row'} gap={1}>
          {isFullscreen ? null : <Notifications apiKeyStatus={apiKeyStatus} autoUpdaterResult={autoUpdaterResult} debug={debug} isAutoUpdating={isAutoUpdating} verbose={verbose} messages={messages} onAutoUpdaterResult={onAutoUpdaterResult} onChangeIsUpdating={onChangeIsUpdating} ideSelection={ideSelection} mcpClients={mcpClients} isInputWrapped={isInputWrapped} isNarrow={isNarrow} />}
          {mode === 'prompt' && <WebRelayInputControls
            onQuickAction={onQuickAction}
            onPrefillInput={onPrefillInput}
          />}
          {"external" === 'ant' && isUndercover() && <Text dimColor>undercover</Text>}
          <BridgeStatusIndicator bridgeSelected={bridgeSelected} />
        </Box>
      </Box>
      {"external" === 'ant' && <CoordinatorTaskPanel />}
    </>;
}
export default memo(PromptInputFooter);

export function WebRelayInputControls({
  onQuickAction,
  onPrefillInput,
}: {
  onQuickAction?: (command: string) => void
  onPrefillInput?: (input: string) => void
}): ReactNode {
  const [serverState, setServerState] = useState<'checking' | 'online' | 'incompatible' | 'offline'>('checking')
  const sentinelMode = useSentinelComposerMode()
  const webAgentMode = useWebAgentComposerMode()
  const { columns } = useTerminalSize()
  const compact = columns < 160
  const { state } = useOrchestratorState()
  const config = getCurrentProjectConfig()
  const platformId = config.selectedWebPlatform ?? 'chatgpt'
  const [coordinatorOverride, setCoordinatorOverride] = useState<string | undefined>()
  const configuredIds = new Set(config.webRelayAgentIds ?? [])
  const requestedCoordinatorId = coordinatorOverride ?? config.webRelayCoordinatorAgentId
  const poolStatus = getWebRelayPoolStatus(
    Object.values(state.agents),
    platformId,
    configuredIds,
    requestedCoordinatorId,
    config.webRelayOrchestratorBrain ?? 'api',
  )
  const readyCoordinatedAgents = poolStatus.availableAgents
  const selectedCoordinator = poolStatus.coordinator
  const selectedCoordinatorIndex = selectedCoordinator
    ? poolStatus.coordinators.findIndex(agent => agent.agentId === selectedCoordinator.agentId)
    : -1

  useEffect(() => {
    let active = true
    const checkServer = async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${MCP_PORT}/status`, {
          signal: AbortSignal.timeout(1200),
        })
        if (!response.ok) {
          if (active) setServerState('offline')
          return
        }
        const relayResponse = await fetch(`http://127.0.0.1:${MCP_PORT}/relay/status`, {
          signal: AbortSignal.timeout(1200),
        })
        if (!relayResponse.ok) {
          if (active) setServerState('incompatible')
          return
        }
        const relayStatus = await relayResponse.json() as { available?: unknown }
        if (active) setServerState(relayStatus.available === true ? 'online' : 'incompatible')
      } catch {
        if (active) setServerState('offline')
      }
    }

    void checkServer()
    const interval = setInterval(() => { void checkServer() }, 5000)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [])

  const statusColor = serverState === 'online' ? 'success' : serverState === 'offline' ? 'error' : 'warning'
  const statusText = serverState === 'online'
    ? 'ON'
    : serverState === 'offline'
      ? 'OFF'
      : serverState === 'incompatible'
        ? 'ACTUALIZAR'
        : '…'
  const selectNextCoordinator = () => {
    if (poolStatus.coordinators.length === 0) return
    const next = poolStatus.coordinators[(selectedCoordinatorIndex + 1) % poolStatus.coordinators.length]!
    saveCurrentProjectConfig(current => ({
      ...current,
      webRelayCoordinatorAgentId: next.agentId,
    }))
    setCoordinatorOverride(next.agentId)
  }
  const coordinatorLabel = (config.webRelayOrchestratorBrain ?? 'api') === 'api'
    ? 'API'
    : selectedCoordinator
    ? selectedCoordinator.agentId.length > 24
      ? `${selectedCoordinator.agentId.slice(0, 21)}…`
      : selectedCoordinator.agentId
    : requestedCoordinatorId
      ? `${requestedCoordinatorId.slice(0, 18)}… no listo`
      : poolStatus.issue === 'no-coordinator'
        ? 'sin primary'
        : 'no configurado'
  const poolIssueLabel = poolStatus.issue === 'empty-pool'
    ? 'sin instancias elegibles'
    : poolStatus.issue === 'no-coordinator'
      ? 'falta coordinador'
      : poolStatus.issue === 'missing-worker'
        ? 'falta worker'
        : `${poolStatus.workerCount} workers listos`
  const compactCoordinatorLabel = (config.webRelayOrchestratorBrain ?? 'api') === 'api'
    ? 'API'
    : selectedCoordinator
        ? selectedCoordinator.agentId.length > 12
          ? `${selectedCoordinator.agentId.slice(0, 11)}…`
          : selectedCoordinator.agentId
        : requestedCoordinatorId
          ? 'no listo'
          : poolStatus.issue === 'no-coordinator'
            ? 'sin coord.'
            : 'sin config'
  const canChangeCoordinator = (config.webRelayOrchestratorBrain ?? 'api') !== 'api' &&
    (poolStatus.coordinators.length > 1 ||
    (selectedCoordinator === undefined && poolStatus.coordinators.length > 0)
    )

  const mcpControl = (
    <Box key="mcp" onClick={() => onQuickAction?.('/mcp status')}>
      <Text color={statusColor}>{compact ? `[MCP ${statusText}]` : `[Puente MCP :${MCP_PORT} ${statusText}]`}</Text>
    </Box>
  )
  const cliControl = (
    <Box key="cli" onClick={() => setComposerDestination('assistant')}>
      <Text color={!sentinelMode && !webAgentMode ? 'success' : 'dim'}>
        {compact ? '[CLI]' : '[OpenMCP]'}
      </Text>
    </Box>
  )
  const webControl = (
    <Box key="web" onClick={() => setComposerDestination('web-agent')}>
      <Text color={poolStatus.issue ? 'warning' : webAgentMode ? 'success' : 'cyan'} wrap={compact ? 'truncate' : undefined}>
        {compact
          ? `[Web ${compactCoordinatorLabel} ${readyCoordinatedAgents.length}/${poolStatus.configuredCount}]`
          : `[Modo agente Web · coordinador ${coordinatorLabel} · pool ${readyCoordinatedAgents.length}/${poolStatus.configuredCount} listo · ${poolIssueLabel}]`}
      </Text>
    </Box>
  )
  const coordinatorControl = canChangeCoordinator ? (
    <Box key="coordinator" onClick={selectNextCoordinator}>
      <Text dimColor>{compact ? '[Coord.]' : '[Cambiar coordinador Web]'}</Text>
    </Box>
  ) : null
  const unavailableControl = poolStatus.unavailableCount > 0 ? (
    <Box key="unavailable" onClick={() => onQuickAction?.('/mcp sentinel')}>
      <Text color="warning">
        {compact ? `[${poolStatus.unavailableCount} no listos]` : `[${poolStatus.unavailableCount} del pool no disponibles]`}
      </Text>
    </Box>
  ) : null
  const sentinelControl = (
    <Box key="sentinel" onClick={() => setSentinelComposerMode(true)}>
      <Text color={sentinelMode ? 'success' : 'cyan'}>{compact ? '[◆ Gemini]' : '[◆ Sentinel · Gemini]'}</Text>
    </Box>
  )
  const launchControl = (
    <Box key="launch" onClick={() => onQuickAction?.('/mcp set-mode web')}>
      <Text color="cyan">{compact ? '[+ Web]' : '[+ Lanzar/configurar]'}</Text>
    </Box>
  )
  const delegateControl = readyCoordinatedAgents.length > 0 ? (
    <Box key="delegate" onClick={() => onPrefillInput?.('/mcp ask ')}>
      <Text color="cyan">{compact ? '[Delegar]' : '[Delegar tarea al equipo]'}</Text>
    </Box>
  ) : null

  if (compact) {
    return (
      <Box flexDirection="column" gap={0}>
        <Box flexDirection="row" gap={1}>{mcpControl}{cliControl}</Box>
        <Box flexDirection="row">{webControl}</Box>
        {(coordinatorControl || unavailableControl) && (
          <Box flexDirection="row" gap={1}>{coordinatorControl}{unavailableControl}</Box>
        )}
        <Box flexDirection="row" gap={1}>{sentinelControl}{launchControl}{delegateControl}</Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="row" flexWrap="wrap" gap={1}>
      {mcpControl}
      {cliControl}
      {webControl}
      {coordinatorControl}
      {unavailableControl}
      {sentinelControl}
      {launchControl}
      {delegateControl}
    </Box>
  )
}

type BridgeStatusProps = {
  bridgeSelected: boolean;
};
function BridgeStatusIndicator({
  bridgeSelected
}: BridgeStatusProps): React.ReactNode {
  if (!false) return null;

  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  const enabled = useAppState(s => s.replBridgeEnabled);
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  const connected = useAppState(s_0 => s_0.replBridgeConnected);
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  const sessionActive = useAppState(s_1 => s_1.replBridgeSessionActive);
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  const reconnecting = useAppState(s_2 => s_2.replBridgeReconnecting);
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  const explicit = useAppState(s_3 => s_3.replBridgeExplicit);

  // Failed state is surfaced via notification (useReplBridge), not a footer pill.
  if (!isBridgeEnabled() || !enabled) return null;
  const status = getBridgeStatus({
    error: undefined,
    connected,
    sessionActive,
    reconnecting
  });

  // For implicit (config-driven) remote, only show the reconnecting state
  if (!explicit && status.label !== 'Remote Control reconnecting') {
    return null;
  }
  return <Text color={bridgeSelected ? 'background' : status.color} inverse={bridgeSelected} wrap="truncate">
      {status.label}
      {bridgeSelected && <Text dimColor> · Enter to view</Text>}
    </Text>;
}
