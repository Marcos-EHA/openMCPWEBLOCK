/**
 * ClaudeDesktopMCPConfig — Manages MCP server configuration in Claude Desktop.
 *
 * Reads and writes the claude_desktop_config.json file to register/unregister
 * the OpenMCPWEBLOCK MCP server as a connection in Claude Desktop.
 * This enables Claude Desktop to use all MCP tools exposed by the Workspace.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

const OPENMCP_SERVER_KEY = 'openmcpweblock'

interface ClaudeDesktopConfig {
  mcpServers?: Record<string, {
    command: string
    args?: string[]
    env?: Record<string, string>
    url?: string
  }>
  [key: string]: unknown
}

/**
 * Get the path to claude_desktop_config.json
 */
export function getClaudeDesktopConfigPath(): string | undefined {
  const appData = process.env.APPDATA
  if (!appData) return undefined
  const configPath = join(appData, 'Claude', 'claude_desktop_config.json')
  return existsSync(configPath) ? configPath : undefined
}

/**
 * Read the current Claude Desktop config.
 */
export function readClaudeDesktopConfig(): ClaudeDesktopConfig | undefined {
  const path = getClaudeDesktopConfigPath()
  if (!path) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return undefined
  }
}

/**
 * Check if OpenMCPWEBLOCK MCP server is already configured in Claude Desktop.
 */
export function isOpenMCPRegistered(): boolean {
  const config = readClaudeDesktopConfig()
  if (!config?.mcpServers) return false
  return OPENMCP_SERVER_KEY in config.mcpServers
}

/**
 * Get the current OpenMCPWEBLOCK MCP server config from Claude Desktop.
 */
export function getOpenMCPServerConfig(): { command: string; args?: string[]; url?: string } | undefined {
  const config = readClaudeDesktopConfig()
  return config?.mcpServers?.[OPENMCP_SERVER_KEY]
}

/**
 * Register the OpenMCPWEBLOCK MCP server in Claude Desktop config.
 * This adds an SSE transport connection pointing to the running MCP server.
 *
 * @param mcpPort - The port where the MCP SSE server is running (default: 3006)
 * @returns Whether the config was written successfully
 */
export function registerOpenMCPInClaudeDesktop(mcpPort = 3006): boolean {
  const configPath = getClaudeDesktopConfigPath()
  if (!configPath) return false

  try {
    const config = readClaudeDesktopConfig() ?? {}
    if (!config.mcpServers) config.mcpServers = {}

    config.mcpServers[OPENMCP_SERVER_KEY] = {
      command: 'npx',
      args: [
        '-y',
        'mcp-remote',
        `http://localhost:${mcpPort}/mcp`,
      ],
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
    return true
  } catch {
    return false
  }
}

/**
 * Remove the OpenMCPWEBLOCK MCP server from Claude Desktop config.
 */
export function unregisterOpenMCPFromClaudeDesktop(): boolean {
  const configPath = getClaudeDesktopConfigPath()
  if (!configPath) return false

  try {
    const config = readClaudeDesktopConfig()
    if (!config?.mcpServers?.[OPENMCP_SERVER_KEY]) return true

    delete config.mcpServers[OPENMCP_SERVER_KEY]
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
    return true
  } catch {
    return false
  }
}

/**
 * Summary of Claude Desktop MCP integration status.
 */
export interface ClaudeDesktopMCPStatus {
  configFileFound: boolean
  configPath?: string
  openMCPRegistered: boolean
  serverConfig?: { command: string; args?: string[]; url?: string }
  existingServers: string[]
}

export function getClaudeDesktopMCPStatus(): ClaudeDesktopMCPStatus {
  const configPath = getClaudeDesktopConfigPath()
  const config = readClaudeDesktopConfig()

  return {
    configFileFound: Boolean(configPath),
    configPath: configPath,
    openMCPRegistered: isOpenMCPRegistered(),
    serverConfig: getOpenMCPServerConfig(),
    existingServers: config?.mcpServers ? Object.keys(config.mcpServers) : [],
  }
}
