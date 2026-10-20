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

type ModeChoice = 'web' | 'api' | 'local'
type WebPlatform = { id: string; name: string; url: string; models: string[] }

const WEB_PLATFORMS: WebPlatform[] = [
  { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com', models: ['GPT-5.6 Luna (current web default)'] },
  { id: 'gemini', name: 'Google Gemini', url: 'https://gemini.google.com', models: ['Gemini 2.5 Pro', 'Gemini 2.5 Flash'] },
  { id: 'grok', name: 'Grok', url: 'https://grok.com/', models: ['Choose an available model in Grok'] },
  { id: 'perplexity', name: 'Perplexity', url: 'https://www.perplexity.ai/', models: ['Choose an available model in Perplexity'] },
  { id: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com', models: ['Choose an available model in DeepSeek'] },
  { id: 'kimi', name: 'Kimi', url: 'https://www.kimi.com/', models: ['Choose an available model in Kimi'] },
  { id: 'qwen', name: 'Qwen', url: 'https://chat.qwen.ai/', models: ['Choose an available model in Qwen'] },
  { id: 'chathub', name: 'ChatHub', url: 'https://app.chathub.gg/chat/cloud-glm-5.3?cid=d6fb4088-ad5c-41f2-a513-4658ec1f06de', models: ['GLM-5.3'] },
  { id: 'copilot', name: 'Microsoft Copilot', url: 'https://copilot.microsoft.com', models: ['GPT-4o'] },
  { id: 'arena', name: 'Arena.ai Direct', url: 'https://arena.ai/text/direct?model_a=max', models: ['Choose a model in Arena'] },
  { id: 'zai', name: 'Z.ai', url: 'https://chat.z.ai/', models: ['Choose an available model in Z.ai'] },
  { id: 'aistudio', name: 'Google AI Studio', url: 'https://aistudio.google.com/prompts/new_chat', models: ['Choose an available model in AI Studio'] },
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
                label: '🌐 Modo Web — Usa ChatGPT, Gemini, Grok, Perplexity, DeepSeek, Kimi, Qwen, ChatHub, AI Studio, Arena.ai o Z.ai via navegador',
                value: 'web',
              },
              {
                label: '🔑 Modo API — Usa Claude, OpenAI o Gemini via API key',
                value: 'api',
              },
              {
                label: '💻 Modo Local — Usa Ollama / modelos locales (offline, privacidad)',
                value: 'local',
              },
            ]}
            onChange={(value: string) => {
              if (value === 'api') {
                onDone({ mode: 'api' })
              } else if (value === 'local') {
                onDone({ mode: 'local' })
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
          onChange={(platformId: string) => {
            onDone({ mode: 'web', platformId })
          }}
        />
        <Text dimColor>Enter para confirmar · Esc para volver</Text>
      </Box>
    </Box>
  )
}
