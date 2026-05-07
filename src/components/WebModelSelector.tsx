import React from 'react';
import { Box, Text } from '../ink.js';
import { Select } from './CustomSelect/index.js';
import { WEB_PLATFORMS, getWebPlatformOptions } from '../utils/webPlatforms.js';

export interface WebModelSelectorProps {
  onSelect: (platformId: string) => void;
  onCancel?: () => void;
  initialValue?: string;
}

export function WebModelSelector({ onSelect, onCancel, initialValue }: WebModelSelectorProps) {
  const options = getWebPlatformOptions();

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        Select Web AI Platform
      </Text>
      <Text dimColor>
        Choose which web-based AI platform to use with MCP Web Relay Mode
      </Text>
      <Box marginTop={1}>
        <Select
          options={options}
          initialValue={initialValue}
          onSelect={(value) => {
            if (value) {
              onSelect(value);
            }
          }}
          onCancel={onCancel}
          visibleOptionCount={6}
        />
      </Box>
    </Box>
  );
}