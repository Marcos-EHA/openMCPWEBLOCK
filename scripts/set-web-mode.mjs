/**
 * Set web mode by directly editing config files.
 * Run: node scripts/set-web-mode.mjs [chatgpt|gemini|grok|copilot]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'

const platforms = {
  chatgpt: { name: 'ChatGPT', url: 'https://chatgpt.com' },
  gemini: { name: 'Google Gemini', url: 'https://gemini.google.com' },
  grok: { name: 'Grok', url: 'https://grok.com' },
  copilot: { name: 'Copilot', url: 'https://copilot.microsoft.com' },
}

const selected = process.argv[2] || 'chatgpt'
const platform = platforms[selected] || platforms.chatgpt

// --- Global config: ~/.openclaude.json ---
const globalPath = join(homedir(), '.openclaude.json')
let globalConfig = {}
try { globalConfig = JSON.parse(readFileSync(globalPath, 'utf-8')) } catch {}
globalConfig.hasCompletedOnboarding = true
globalConfig.lastOnboardingVersion = '0.7.0'
globalConfig.theme = globalConfig.theme || 'dark'
writeFileSync(globalPath, JSON.stringify(globalConfig, null, 2))
console.log(`✅ Global config: ${globalPath}`)

// --- Project config: .claude/config.json ---
const projectPath = join(process.cwd(), '.claude', 'config.json')
let projectConfig = {}
try { projectConfig = JSON.parse(readFileSync(projectPath, 'utf-8')) } catch {}
projectConfig.mcpExecutionMode = 'web'
projectConfig.selectedWebPlatform = selected
mkdirSync(dirname(projectPath), { recursive: true })
writeFileSync(projectPath, JSON.stringify(projectConfig, null, 2))
console.log(`✅ Project config: ${projectPath}`)

console.log(`\n🌐 Web mode → ${platform.name} (${platform.url})`)
console.log(`   Onboarding: will be skipped`)
console.log(`\nAhora lanza: node dist/cli.mjs`)
console.log(`Para cambiar: node scripts/set-web-mode.mjs gemini`)
