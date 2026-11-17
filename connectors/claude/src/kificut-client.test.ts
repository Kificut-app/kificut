import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createLineReader, type ConnectorInfo } from '@shared/connector-protocol'
import { KificutClient } from './kificut-client'

const TOKEN = 'ab'.repeat(32)
let dir = ''
let server: Server | null = null
let calls: Array<{ name: string; arguments: unknown }> = []
let hellos: Array<{ client: string }> = []

function writeInfo(info: Partial<ConnectorInfo>): void {
  const full: ConnectorInfo = {
    protocol: 1,
    port: null,
    token: null,
    pid: null,
    appVersion: '0.1.0',
    launch: null,
    ...info
  }
  writeFileSync(join(dir, 'connector.json'), JSON.stringify(full))
}

/** A stand-in for Kificut that speaks the connector protocol. */
function startFakeKificut(options: { dropOnCall?: boolean } = {}): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((socket) => {
      socket.setEncoding('utf8')
      let authed = false
      socket.on(
        'data',
        createLineReader(
          (line) => {
            const message = JSON.parse(line)
            if (!authed) {
              if (message.token !== TOKEN) {
                socket.write(`${JSON.stringify({ type: 'error', message: 'Not authorized.' })}\n`)
                socket.end()
                return
              }
              authed = true
              hellos.push({ client: message.client })
              socket.write(`${JSON.stringify({ type: 'welcome', protocol: 1, appVersion: '0.1.0' })}\n`)
              return
            }
            calls.push({ name: message.name, arguments: message.arguments })
            if (options.dropOnCall) {
              socket.destroy()
              return
            }
            const result = { content: [{ type: 'text', text: `ran ${message.name} ✓` }] }
            socket.write(`${JSON.stringify({ type: 'result', id: message.id, result })}\n`)
          },
          1e6,
          () => socket.destroy()
        )
      )
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server!.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kificut-connector-'))
  process.env.KIFICUT_CONNECTOR_FILE = join(dir, 'connector.json')
})

afterAll(() => {
  delete process.env.KIFICUT_CONNECTOR_FILE
  rmSync(dir, { recursive: true, force: true })
})

afterEach(async () => {
  calls = []
  hellos = []
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
})

describe('KificutClient', () => {
  it('authenticates and relays tool calls', async () => {
    const port = await startFakeKificut()
    writeInfo({ port, token: TOKEN, pid: process.pid })
    const client = new KificutClient(() => 'Claude')
    const result = await client.call('get_project', { verbose: true })
    expect(result.content[0]).toEqual({ type: 'text', text: 'ran get_project ✓' })
    expect(calls).toEqual([{ name: 'get_project', arguments: { verbose: true } }])
    expect(hellos).toEqual([{ client: 'Claude' }])

    // A second call reuses the same connection.
    await client.call('undo', {})
    expect(hellos).toHaveLength(1)
    client.close()
  })

  it('reports a wrong token as an error result', async () => {
    const port = await startFakeKificut()
    writeInfo({ port, token: 'cd'.repeat(32), pid: process.pid })
    const result = await new KificutClient(() => 'Claude').call('get_project', {})
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: 'Not authorized.' })
  })

  it('explains when access is turned off', async () => {
    writeInfo({ disabled: true, pid: process.pid })
    const result = await new KificutClient(() => 'Claude').call('get_project', {})
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('turned off')
  })

  it('asks the user to open Kificut when it is closed and cannot be started', async () => {
    writeInfo({ port: null, pid: null, launch: null })
    const result = await new KificutClient(() => 'Claude').call('get_project', {})
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('not running')
  })

  it('fails pending calls when Kificut goes away', async () => {
    const port = await startFakeKificut({ dropOnCall: true })
    writeInfo({ port, token: TOKEN, pid: process.pid })
    const result = await new KificutClient(() => 'Claude').call('export_video', { path: '/tmp/x.mp4' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('closed the connection')
  })
})
