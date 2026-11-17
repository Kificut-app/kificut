import type { ToolResult } from './ai-tools'

/*
 * The local link between Kificut and an AI connector such as the Claude Desktop bundle.
 *
 * Kificut listens on 127.0.0.1 on a random port and writes the port and a secret token to
 * connector.json in its user data folder (readable only by the user). A connector reads that file,
 * connects, proves it knows the token, and then sends tool calls. Messages are JSON, one per line.
 */

export const CONNECTOR_PROTOCOL = 1
export const CONNECTOR_FILE = 'connector.json'

export interface ConnectorInfo {
  protocol: number
  /** Null while Kificut is not running. */
  port: number | null
  token: string | null
  pid: number | null
  appVersion: string
  /** How a connector can start Kificut when it is closed. Null in development builds. */
  launch: { command: string; args: string[] } | null
  /** Set while Kificut is running with assistant access turned off in Settings. */
  disabled?: boolean
}

export type ClientMessage =
  | { type: 'hello'; protocol: number; token: string; client: string }
  | { type: 'call'; id: number; name: string; arguments: Record<string, unknown> }

export type ServerMessage =
  | { type: 'welcome'; protocol: number; appVersion: string }
  | { type: 'result'; id: number; result: ToolResult }
  | { type: 'error'; message: string }

/** Kificut's user data folder, matching Electron's app.getPath('userData') for the app name. */
export function userDataFolder(
  platform: string,
  env: Record<string, string | undefined>,
  home: string
): string {
  const sep = platform === 'win32' ? '\\' : '/'
  if (platform === 'darwin') return [home, 'Library', 'Application Support', 'Kificut'].join(sep)
  if (platform === 'win32')
    return [env.APPDATA || [home, 'AppData', 'Roaming'].join(sep), 'Kificut'].join(sep)
  return [env.XDG_CONFIG_HOME || [home, '.config'].join(sep), 'Kificut'].join(sep)
}

/**
 * Splits a byte stream into lines. Calls onOverflow and stops when a single line grows past the
 * limit, which protects both sides from runaway input.
 */
export function createLineReader(
  onLine: (line: string) => void,
  maxLineLength: number,
  onOverflow: () => void
): (chunk: { toString(): string }) => void {
  let buffer = ''
  let stopped = false
  return (chunk) => {
    if (stopped) return
    buffer += chunk.toString()
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line) onLine(line)
      index = buffer.indexOf('\n')
    }
    if (buffer.length > maxLineLength) {
      stopped = true
      buffer = ''
      onOverflow()
    }
  }
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}
