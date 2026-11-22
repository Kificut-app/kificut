import { app, BrowserWindow, ipcMain, type WebContents } from 'electron'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { AI_TOOL_NAMES, type ToolResult } from '@shared/ai-tools'
import {
  CONNECTOR_FILE,
  CONNECTOR_PROTOCOL,
  createLineReader,
  errorResult,
  type ClientMessage,
  type ConnectorInfo,
  type ServerMessage
} from '@shared/connector-protocol'
import { IPC, type AiCall } from '@shared/ipc'

/*
 * Lets AI connectors (the Claude Desktop bundle) drive Kificut. The server only listens on
 * 127.0.0.1, and every connection must present the token from connector.json, which only the
 * current user can read. Tool calls are handed to the renderer, which owns the project.
 */

const MAX_REQUEST_LINE = 1024 * 1024
const CALL_TIMEOUT_MS = 10 * 60 * 1000
const READY_TIMEOUT_MS = 30 * 1000

interface PendingCall {
  resolve: (result: ToolResult) => void
  timer: NodeJS.Timeout
}

let server: Server | null = null
let token: Buffer | null = null
const clients = new Map<Socket, string>()
const pending = new Map<number, PendingCall>()
const readyContents = new Set<number>()
const readyWaiters: Array<() => void> = []
let nextCallId = 1
let getWindow: () => BrowserWindow = () => BrowserWindow.getAllWindows()[0]

function infoPath(): string {
  return join(app.getPath('userData'), CONNECTOR_FILE)
}

function launchCommand(): ConnectorInfo['launch'] {
  if (!app.isPackaged) return null
  // Inside an AppImage the executable sits in a temporary mount; start the AppImage itself.
  if (process.env.APPIMAGE) return { command: process.env.APPIMAGE, args: [] }
  if (process.platform === 'darwin') {
    // Launch through LaunchServices so the app gets its Dock icon and comes to the front.
    const bundle = process.execPath.replace(/\/Contents\/MacOS\/[^/]+$/, '')
    if (bundle.endsWith('.app')) return { command: '/usr/bin/open', args: ['-a', bundle] }
  }
  return { command: process.execPath, args: [] }
}

function writeInfo(port: number | null, disabled = false): void {
  const info: ConnectorInfo = {
    protocol: CONNECTOR_PROTOCOL,
    port,
    token: port && token ? token.toString('hex') : null,
    pid: port || disabled ? process.pid : null,
    appVersion: app.getVersion(),
    launch: launchCommand(),
    ...(disabled ? { disabled: true } : {})
  }
  const path = infoPath()
  const temp = `${path}.tmp`
  writeFileSync(temp, JSON.stringify(info, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(temp, path)
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows keeps the file private through the profile folder permissions.
  }
}

function send(socket: Socket, message: ServerMessage): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`)
}

function clientName(): string | null {
  const names = [...clients.values()]
  return names.length ? names[names.length - 1] : null
}

function bundleAvailable(): boolean {
  return findClaudeBundle() !== null
}

export function connectorStatus(enabled: boolean) {
  return { enabled, connected: clients.size > 0, client: clientName(), bundleAvailable: bundleAvailable() }
}

function broadcastStatus(): void {
  const status = connectorStatus(server !== null)
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.aiStatusChanged, status)
}

function tokenMatches(candidate: unknown): boolean {
  if (typeof candidate !== 'string' || !token) return false
  const given = Buffer.from(candidate, 'hex')
  return given.length === token.length && timingSafeEqual(given, token)
}

async function waitForRenderer(): Promise<WebContents> {
  let win = getWindow()
  if (!win || win.isDestroyed()) win = getWindow()
  const contents = win.webContents
  if (readyContents.has(contents.id)) return contents
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Kificut did not finish starting in time.')),
      READY_TIMEOUT_MS
    )
    readyWaiters.push(() => {
      clearTimeout(timer)
      resolve()
    })
  })
  return contents
}

/** Runs a tool in the renderer, which owns the project. Used by connectors and the in-app assistant. */
export async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (!AI_TOOL_NAMES.has(name)) return errorResult(`Unknown tool: ${name}`)
  const contents = await waitForRenderer()
  return new Promise<ToolResult>((resolve) => {
    const callId = nextCallId++
    const timer = setTimeout(() => {
      pending.delete(callId)
      resolve(errorResult(`${name} timed out in Kificut.`))
    }, CALL_TIMEOUT_MS)
    pending.set(callId, { resolve, timer })
    const call: AiCall = { callId, name, args }
    contents.send(IPC.aiCall, call)
  })
}

function handleConnection(socket: Socket): void {
  let authenticated = false
  socket.setNoDelay(true)
  socket.setEncoding('utf8')

  const onLine = (line: string) => {
    let message: ClientMessage
    try {
      message = JSON.parse(line) as ClientMessage
    } catch {
      socket.destroy()
      return
    }

    if (!authenticated) {
      if (message.type !== 'hello' || !tokenMatches(message.token)) {
        send(socket, { type: 'error', message: 'Not authorized.' })
        socket.end()
        return
      }
      authenticated = true
      clients.set(socket, String(message.client || 'An assistant').slice(0, 60))
      send(socket, { type: 'welcome', protocol: CONNECTOR_PROTOCOL, appVersion: app.getVersion() })
      broadcastStatus()
      return
    }

    if (message.type !== 'call' || typeof message.id !== 'number') return
    const args = message.arguments && typeof message.arguments === 'object' ? message.arguments : {}
    callTool(String(message.name), args)
      .catch((error: unknown) => errorResult(error instanceof Error ? error.message : String(error)))
      .then((result) => send(socket, { type: 'result', id: message.id, result }))
  }

  socket.on(
    'data',
    createLineReader(onLine, MAX_REQUEST_LINE, () => socket.destroy())
  )
  socket.on('error', () => undefined)
  socket.on('close', () => {
    if (clients.delete(socket)) broadcastStatus()
  })
}

export function registerConnectorIpc(windowProvider: () => BrowserWindow): void {
  getWindow = windowProvider

  ipcMain.on(IPC.aiResult, (_event, callId: number, result: ToolResult) => {
    const call = pending.get(callId)
    if (!call) return
    clearTimeout(call.timer)
    pending.delete(callId)
    call.resolve(result)
  })

  ipcMain.on(IPC.aiReady, (event) => {
    readyContents.add(event.sender.id)
    event.sender.once('destroyed', () => readyContents.delete(event.sender.id))
    event.sender.once('did-start-loading', () => readyContents.delete(event.sender.id))
    readyWaiters.splice(0).forEach((resolve) => resolve())
  })
}

export async function startConnector(): Promise<void> {
  if (server) return
  token = randomBytes(32)
  const instance = createServer(handleConnection)
  await new Promise<void>((resolve, reject) => {
    instance.once('error', reject)
    instance.listen(0, '127.0.0.1', () => resolve())
  })
  server = instance
  const address = instance.address()
  writeInfo(typeof address === 'object' && address ? address.port : null)
  broadcastStatus()
}

/** Stops listening. When the app keeps running, connectors are told access is turned off. */
export function stopConnector(quitting = false): void {
  if (!server) return
  for (const socket of clients.keys()) socket.destroy()
  clients.clear()
  server.close()
  server = null
  token = null
  try {
    writeInfo(null, !quitting)
  } catch {
    // Quitting; nothing else to do.
  }
  broadcastStatus()
}

/** Records that access is turned off, so connectors can say so instead of trying to start Kificut. */
export function announceConnectorDisabled(): void {
  try {
    writeInfo(null, true)
  } catch {
    // Not critical.
  }
}

export function isConnectorRunning(): boolean {
  return server !== null
}

/** The Claude Desktop bundle: next to the app when packaged, in the build output in development. */
export function findClaudeBundle(): string | null {
  const dir = app.isPackaged
    ? join(process.resourcesPath, 'connectors')
    : join(app.getAppPath(), 'connectors', 'claude', 'dist')
  if (!existsSync(dir)) return null
  const file = readdirSync(dir).find((name) => name.endsWith('.mcpb'))
  return file ? join(dir, file) : null
}
