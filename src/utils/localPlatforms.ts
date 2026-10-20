// Local AI platforms supported by OpenMCPWEBLOCK Workspace
// These represent locally installed AI applications that can be launched
// and connected to the Workspace via MCP or direct process management.

export interface LocalPlatform {
  id: string
  name: string
  description: string
  /** How to detect if this platform is installed */
  detection: LocalPlatformDetection
  /** Type of connection this platform uses */
  connectionType: 'mcp-stdio' | 'mcp-sse' | 'process-only'
  /** How to launch this application */
  launchMethod: 'spawn' | 'msix' | 'cli-command'
  /** For MSIX apps: the AppUserModelId (from Get-StartApps) */
  msixAppId?: string
  /** Process name to detect in tasklist (may differ from the executable filename) */
  processName?: string
  icon?: string
}

export interface LocalPlatformDetection {
  /** Executable name to search in PATH */
  executableName?: string
  /** Well-known installation paths (Windows) */
  windowsPaths?: string[]
  /** Config file that indicates installation */
  configPath?: string
  /** PowerShell command to detect the app (e.g. Get-AppxPackage) */
  detectCommand?: string
}

export interface DetectedLocalPlatform extends LocalPlatform {
  installed: boolean
  executablePath?: string
  configFilePath?: string
  version?: string
}

/**
 * Registry of local AI platforms that can participate in the Workspace.
 * Each platform has detection logic for Windows and a connection type
 * that determines how Workspace communicates with it.
 */
export const LOCAL_PLATFORMS: LocalPlatform[] = [
  {
    id: 'antigravity',
    name: 'Antigravity',
    description: 'Google Antigravity — Agentic AI coding assistant (Electron app).',
    connectionType: 'process-only',
    launchMethod: 'spawn',
    processName: 'Antigravity.exe',
    detection: {
      executableName: 'Antigravity.exe',
      windowsPaths: [
        '${LOCALAPPDATA}\\Programs\\antigravity\\Antigravity.exe',
      ],
    },
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    description: 'Anthropic Claude Desktop — App de escritorio nativa con soporte MCP.',
    connectionType: 'mcp-stdio',
    launchMethod: 'msix',
    msixAppId: 'Claude_pzs8sxrjxfjjc!Claude',
    processName: 'claude.exe',
    detection: {
      // Claude Desktop on Windows is installed as an MSIX/Store app.
      // The executable is inside WindowsApps and cannot be spawned directly;
      // we detect it via Get-AppxPackage and launch via explorer shell protocol.
      detectCommand: 'Get-AppxPackage -Name "Claude"',
      configPath: '${APPDATA}\\Claude\\claude_desktop_config.json',
    },
  },
  {
    id: 'vscode',
    name: 'VS Code',
    description: 'Visual Studio Code — Editor con extensiones de IA (Copilot, Cline, etc.).',
    connectionType: 'process-only',
    launchMethod: 'spawn',
    processName: 'Code.exe',
    detection: {
      executableName: 'code',
      windowsPaths: [
        '${LOCALAPPDATA}\\Programs\\Microsoft VS Code\\Code.exe',
      ],
    },
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: 'Anthropic Claude Code CLI — Asistente de código en terminal con soporte MCP.',
    connectionType: 'mcp-stdio',
    launchMethod: 'cli-command',
    processName: 'claude.exe',
    detection: {
      executableName: 'claude.exe',
      windowsPaths: [],
    },
  },
]

export function getLocalPlatformById(id: string): LocalPlatform | undefined {
  return LOCAL_PLATFORMS.find(platform => platform.id === id)
}

export function getLocalPlatformOptions() {
  return LOCAL_PLATFORMS.map(platform => ({
    value: platform.id,
    label: platform.name,
    description: platform.description,
  }))
}
