import React from 'react';
import { MCPSettings } from './MCPSettings.js';
import { getCurrentProjectConfig } from '../../utils/config.js';
import { getWebPlatformById } from '../../utils/webPlatforms.js';
import { useAppState } from '../../state/AppState.js';

type Props = {
  onComplete: (result?: string, options?: {
    display?: any;
  }) => void;
};

export function MCPSettingsExtended(props: Props) {
  const config = getCurrentProjectConfig();
  const mode = config.mcpExecutionMode || 'api';
  const selectedWebPlatformId = config.selectedWebPlatform;
  const selectedWebPlatform = selectedWebPlatformId ? getWebPlatformById(selectedWebPlatformId) : null;

  // Check if superassistant-proxy is connected
  const mcpClients = useAppState((s: any) => s.mcp.clients);
  const superAssistantProxyClient = mcpClients.find((client: any) => client.name === 'superassistant-proxy');
  const isSuperAssistantProxyActive = superAssistantProxyClient?.type === 'connected';

  return (
    <div>
      {/* Show web platform status when in web mode */}
      {mode === 'web' && (
        <div style={{
          padding: '10px',
          marginBottom: '10px',
          border: '1px solid #ccc',
          borderRadius: '4px',
          backgroundColor: selectedWebPlatform ? '#e8f5e8' : '#fff3cd'
        }}>
          <h4>Web Mode Status</h4>
          {selectedWebPlatform ? (
            <p>
              <strong>Selected Platform:</strong> {selectedWebPlatform.name} ({selectedWebPlatform.url})
            </p>
          ) : (
            <p style={{ color: '#856404' }}>
              <strong>Warning:</strong> No web platform selected. Use <code>/mcp set-mode web</code> to select one.
            </p>
          )}

          {!isSuperAssistantProxyActive && (
            <p style={{ color: '#721c24' }}>
              <strong>Warning:</strong> superassistant-proxy server is not active. Web mode may not function properly.
            </p>
          )}
        </div>
      )}

      {/* Render the original MCPSettings component */}
      <MCPSettings {...props} />
    </div>
  );
}