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
  const options = getWebPlatformOptions().map(option => ({
    ...option,
    label: option.value === 'chatgpt'
      ? `${option.label} · GPT-5.6 Luna`
      : option.label,
  }));

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        Configura tus instancias de IA web
      </Text>
      <Text dimColor>
        Elige la plataforma. Luego escogerás cuántas instancias y el tipo de sesión.
      </Text>
      <Text dimColor>
        No se abrirá ninguna ventana al iniciar OpenMCPWEBLOCK; solo al confirmar el lanzamiento aquí.
      </Text>
      {initialValue === 'chatgpt' && (
        <Text dimColor>GPT-5.6 Luna es el modelo indicado por defecto; el modelo real se selecciona dentro de ChatGPT.</Text>
      )}
      <Box marginTop={1}>
        <Select
          options={options}
          defaultValue={initialValue}
          onChange={(value) => {
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