/**
 * ModeSelector — First screen on startup. Lets the user pick Web or API mode.
 * 
 * Web mode: connects to ChatGPT/Gemini via browser (free, no API key)
 * API mode: uses Claude Sonnet via Anthropic API (requires key)
 */
import React, { useState } from 'react'
import { Box, Text } from '../../ink.js'
import { Select } from '../CustomSelect/select.js'
import { WelcomeV2 } from '../LogoV2/WelcomeV2.js'
import { getWebPlatformById } from '../../utils/webPlatforms.js'

type ModeChoice = 'web' | 'api'
type WebPlatform = { id: string; name: string; url: string; models: string[] }

const WEB_PLATFORMS: WebPlatform[] = [
  { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com', models: ['GPT-4o', 'GPT-4.5', 'o3'] },
  { id: 'gemini', name: 'Google Gemini', url: 'https://gemini.google.com', models: ['Gemini 2.5 Pro', 'Gemini 2.5 Flash'] },
  { id: 'grok', name: 'Grok', url: 'https://grok.com', models: ['Grok 3', 'Grok 3 Mini'] },
  { id: 'copilot', name: 'Microsoft Copilot', url: 'https://copilot.microsoft.com', models: ['GPT-4o'] },
]

interface Props {
  onDone: (result: { mode: ModeChoice; platformId?: string }) => void
}

export function ModeSelector({ onDone }: Props): React.ReactNode {
  const [step, setStep] = useState<'mode' | 'platform'>('mode')
  const [selectedMode, setSelectedMode] = useState<ModeChoice | null>(null)

  if (step === 'mode') {
    return (
      <Box flexDirection="column">
        <WelcomeV2 />
        <Box flexDirection="column" marginTop={1} paddingLeft={1} gap={1}>
          <Text bold>¿Cómo quieres usar openMCPWEBLOCK?</Text>
          <Select
            options={[
              {
                label: '🌐 Modo Web — Usa ChatGPT, Gemini, Grok via navegador (gratis)',
                value: 'web',
              },
              {
                label: '🔑 Modo API — Usa Claude Sonnet via API key (requiere cuenta)',
                value: 'api',
              },
            ]}
            onChange={(value) => {
              if (value === 'api') {
                onDone({ mode: 'api' })
              } else {
                setSelectedMode('web')
                setStep('platform')
              }
            }}
          />
          <Text dimColor>Enter para confirmar</Text>
        </Box>
      </Box>
    )
  }

  // Step 2: Platform selection (only for web mode)
  return (
    <Box flexDirection="column">
      <WelcomeV2 />
      <Box flexDirection="column" marginTop={1} paddingLeft={1} gap={1}>
        <Text bold>Elige tu plataforma de IA:</Text>
        <Select
          options={WEB_PLATFORMS.map(p => ({
            label: `${p.name} — ${p.models.join(', ')} (${p.url})`,
            value: p.id,
          }))}
          onChange={(platformId) => {
            onDone({ mode: 'web', platformId })
          }}
        />
        <Text dimColor>Enter para confirmar · Esc para volver</Text>
      </Box>
    </Box>
  )
}
