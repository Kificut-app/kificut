import { app } from 'electron'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/*
 * `Kificut --mcp-server` runs the Claude connector inside Kificut's own executable instead of
 * opening the editor. Claude Code uses it on Linux, where Kificut ships as an AppImage: there the
 * executable lives in a folder that changes every run, and the AppImage launcher may add
 * --no-sandbox, which Node mode does not accept. No window opens; the connector talks to the
 * running editor (starting it if needed) and exits when Claude Code closes the connection.
 */

export const MCP_SERVER_FLAG = '--mcp-server'

export function isMcpServerMode(): boolean {
  return process.argv.includes(MCP_SERVER_FLAG)
}

export function runMcpServer(): void {
  app.disableHardwareAcceleration()
  const script = app.isPackaged
    ? join(process.resourcesPath, 'connectors', 'kificut-mcp.js')
    : join(app.getAppPath(), 'connectors', 'claude', 'build', 'server', 'index.js')
  // The connector reads stdin and writes MCP messages to stdout until Claude Code disconnects.
  createRequire(join(app.getAppPath(), 'package.json'))(script)
}
