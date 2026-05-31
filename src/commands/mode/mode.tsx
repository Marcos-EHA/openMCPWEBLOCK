import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { Select } from '../../components/CustomSelect/select.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { WEB_PLATFORMS } from '../../utils/webPlatforms.js'
import { getCurrentProjectConfig, saveCurrentProjectConfig } from '../../utils/config.js'
import type { LocalJSXCommandOnDone, LocalJSXCommandContext } from '../../types/command.js'

// Web platform model mapping
const WEB_PLATFORM_MODELS: Record<string, string> = {
  chatgpt: 'GPT-4o',
  gemini: 'Gemini 2.5 Pro',
  grok: 'Grok 3',
  perplexity: 'Sonar Pro',
  deepseek: 'DeepSeek V3',
  claude: 'Claude Sonnet',
}

type Step = 'select-mode' | 'select-platform' | 'done'

function ModeCommand({ onDone }: { onDone: (msg: string) => void }): React.ReactNode {
  const [step, setStep] = React.useState<Step>('select-mode')
  const config = getCurrentProjectConfig()
  const currentMode = config.mcpExecutionMode || 'api'
  const currentPlatform = config.selectedWebPlatform || ''

  if (step === 'select-mode') {
    return (
      <Dialog
        title="Connection Mode"
        onCancel={() => onDone('Mode selection cancelled')}
        color="permission"
      >
        <Box flexDirection="column" gap={1}>
          <Text>Current mode: <Text bold>{currentMode === 'web' ? 'Web 🌐' : currentMode === 'local' ? 'Local 💻' : 'API 🔑'}</Text></Text>
          <Text bold>Select connection mode:</Text>
          <Select
            options={[
              { label: 'Web 🌐 — ChatGPT, Gemini, Grok via browser (free)', value: 'web' },
              { label: 'API 🔑 — Claude, OpenAI via API key', value: 'api' },
              { label: 'Local 💻 — Ollama, LM Studio local models', value: 'local' },
            ]}
            onChange={(value: string) => {
              if (value === 'web') {
                setStep('select-platform')
              } else {
                // Save API or Local mode
                saveCurrentProjectConfig(cfg => ({
                  ...cfg,
                  mcpExecutionMode: value as 'api' | 'local',
                  selectedWebPlatform: undefined,
                }))
                onDone(`✅ Mode: ${value === 'local' ? 'Local 💻' : 'API 🔑'} — saved`)
              }
            }}
          />
          <Text dimColor>Enter to confirm · Esc to cancel</Text>
        </Box>
      </Dialog>
    )
  }

  if (step === 'select-platform') {
    return (
      <Dialog
        title="Web Platform"
        onCancel={() => setStep('select-mode')}
        color="permission"
      >
        <Box flexDirection="column" gap={1}>
          {currentPlatform && (
            <Text>Current: <Text bold>{currentPlatform}</Text></Text>
          )}
          <Text bold>Select AI platform:</Text>
          <Select
            options={WEB_PLATFORMS.map(p => ({
              label: `${p.name} — ${WEB_PLATFORM_MODELS[p.id] || 'AI'} (${p.url})`,
              value: p.id,
            }))}
            onChange={(platformId: string) => {
              saveCurrentProjectConfig(cfg => ({
                ...cfg,
                mcpExecutionMode: 'web' as const,
                selectedWebPlatform: platformId,
              }))
              const platform = WEB_PLATFORMS.find(p => p.id === platformId)
              const model = WEB_PLATFORM_MODELS[platformId] || 'AI'
              onDone(`✅ Mode: Web 🌐 → ${platform?.name || platformId} (${model}) — saved`)
            }}
          />
          <Text dimColor>Enter to confirm · Esc to go back</Text>
        </Box>
      </Dialog>
    )
  }

  return null
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: LocalJSXCommandContext,
  _args?: string,
): Promise<React.ReactNode> {
  return (
    <ModeCommand
      onDone={(msg) => {
        onDone(msg, { display: 'system' })
      }}
    />
  )
}
