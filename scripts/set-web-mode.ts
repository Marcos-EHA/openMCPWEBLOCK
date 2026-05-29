/**
 * Quick setup: set web mode config so TUI skips Anthropic onboarding.
 * Run once: npx tsx scripts/set-web-mode.ts
 * Then launch: node dist/cli.mjs
 */
import { saveCurrentProjectConfig, getCurrentProjectConfig, saveGlobalConfig, getGlobalConfig } from '../src/utils/config.js'

const platforms = [
  { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com' },
  { id: 'gemini', name: 'Google Gemini', url: 'https://gemini.google.com' },
  { id: 'grok', name: 'Grok', url: 'https://grok.com' },
  { id: 'copilot', name: 'Copilot', url: 'https://copilot.microsoft.com' },
]

const selected = process.argv[2] || 'chatgpt'
const platform = platforms.find(p => p.id === selected) || platforms[0]!

// Set project config
saveCurrentProjectConfig(config => ({
  ...config,
  mcpExecutionMode: 'web' as const,
  selectedWebPlatform: platform.id,
}))

// Mark onboarding as complete
saveGlobalConfig(current => ({
  ...current,
  hasCompletedOnboarding: true,
  theme: current.theme || 'dark',
}))

console.log(`✅ Web mode configured:`)
console.log(`   Platform: ${platform.name} (${platform.url})`)
console.log(`   Onboarding: skipped`)
console.log(`\nNow launch: node dist/cli.mjs`)
console.log(`Or change platform: npx tsx scripts/set-web-mode.ts gemini`)
