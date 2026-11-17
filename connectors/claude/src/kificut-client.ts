import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ToolResult } from '@shared/ai-tools'
import {
  CONNECTOR_FILE,
  CONNECTOR_PROTOCOL,
  createLineReader,
  errorResult,
  userDataFolder,
  type ConnectorInfo,
  type ServerMessage
} from '@shared/connector-protocol'

const MAX_REPLY_LINE = 64 * 1024 * 1024
const LAUNCH_WAIT_MS = 45_000
const HANDSHAKE_TIMEOUT_MS = 10_000

export function connectorFilePath(): string {
  return (
    process.env.KIFICUT_CONNECTOR_FILE ||
    join(userDataFolder(process.platform, process.env, homedir()), CONNECTOR_FILE)
  )
}

function readInfo(): ConnectorInfo | null {
  try {
    return JSON.parse(readFileSync(connectorFilePath(), 'utf8')) as ConnectorInfo
  } catch {
    return null
  }
}

function isAlive(pid: number | null): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Talks to the Kificut app on this computer. Finds it through connector.json, starts it when it is
 * closed, and reconnects after it restarts.
 */
export class KificutClient {
  private socket: Socket | null = null
  private connecting: Promise<Socket> | null = null
  private pending = new Map<number, (result: ToolResult) => void>()
  private nextId = 1

  constructor(private readonly clientName: () => string) {}

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    let socket: Socket
    try {
      socket = await this.connection()
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error))
    }
    return new Promise<ToolResult>((resolve) => {
      const id = this.nextId++
      this.pending.set(id, resolve)
      socket.write(`${JSON.stringify({ type: 'call', id, name, arguments: args })}\n`)
    })
  }

  close(): void {
    this.socket?.destroy()
  }

  private connection(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket)
    this.connecting ??= this.open().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private async open(): Promise<Socket> {
    let info = readInfo()
    if (info?.disabled && isAlive(info.pid)) {
      throw new Error(
        'Claude access is turned off in Kificut. Ask the user to turn it on in Kificut Settings, under Claude.'
      )
    }
    if (!info?.port || !info.token || !isAlive(info.pid)) info = await this.launch(info)
    try {
      return await this.handshake(info)
    } catch (error) {
      // The file can be left over from a crash. Start Kificut once more before giving up.
      if (!info.launch || isAlive(info.pid)) throw error
      return this.handshake(await this.launch(info))
    }
  }

  private async launch(previous: ConnectorInfo | null): Promise<ConnectorInfo> {
    if (!previous?.launch) {
      throw new Error('Kificut is not running. Ask the user to open Kificut, then try again.')
    }
    // Claude Code runs this server with Kificut's executable in Node mode; the app itself must not inherit that.
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(previous.launch.command, previous.launch.args, {
      detached: true,
      stdio: 'ignore',
      env
    })
    child.on('error', () => undefined)
    child.unref()
    const deadline = Date.now() + LAUNCH_WAIT_MS
    while (Date.now() < deadline) {
      await sleep(400)
      const info = readInfo()
      if (info?.port && info.token && info.pid !== previous.pid && isAlive(info.pid)) return info
    }
    throw new Error('Kificut did not start in time. Ask the user to open it, then try again.')
  }

  private handshake(info: ConnectorInfo): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port: info.port! })
      socket.setEncoding('utf8')
      let welcomed = false
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('Kificut did not answer.'))
      }, HANDSHAKE_TIMEOUT_MS)

      socket.on('connect', () => {
        const hello = {
          type: 'hello',
          protocol: CONNECTOR_PROTOCOL,
          token: info.token,
          client: this.clientName()
        }
        socket.write(`${JSON.stringify(hello)}\n`)
      })

      const onLine = (line: string) => {
        let message: ServerMessage
        try {
          message = JSON.parse(line) as ServerMessage
        } catch {
          return
        }
        if (!welcomed) {
          clearTimeout(timer)
          if (message.type === 'welcome') {
            welcomed = true
            this.socket = socket
            resolve(socket)
          } else {
            socket.destroy()
            reject(
              new Error(message.type === 'error' ? message.message : 'Kificut sent an unexpected reply.')
            )
          }
          return
        }
        if (message.type === 'result') {
          const done = this.pending.get(message.id)
          this.pending.delete(message.id)
          done?.(message.result)
        }
      }

      socket.on(
        'data',
        createLineReader(onLine, MAX_REPLY_LINE, () => socket.destroy())
      )
      socket.on('error', (error) => {
        clearTimeout(timer)
        if (!welcomed) reject(new Error(`Could not reach Kificut: ${error.message}`))
      })
      socket.on('close', () => {
        if (this.socket === socket) this.socket = null
        for (const done of this.pending.values())
          done(errorResult('Kificut closed the connection. Try again.'))
        this.pending.clear()
      })
    })
  }
}
