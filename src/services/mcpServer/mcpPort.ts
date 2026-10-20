const DEFAULT_MCP_PORT = 3006

export function getMCPPort(value: string | undefined = process.env.MCP_PORT): number {
  if (value === undefined || value.trim() === '') return DEFAULT_MCP_PORT

  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid MCP_PORT "${value}". Expected an integer between 1 and 65535.`)
  }

  return port
}

export const MCP_PORT = getMCPPort()
