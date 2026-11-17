import { app } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { ClaudeCodeResult } from '@shared/ipc'
import { isNewerVersion } from '@shared/updates'

/*
 * Connects Kificut to Claude Code. Claude Code runs the same MCP server as the Claude Desktop
 * bundle, started with Kificut's own executable in Node mode, so no separate Node.js is needed.
 * Registering goes through the `claude mcp add` command, at user scope so it works in every folder.
 */

const SERVER_NAME = 'kificut'

function serverScript(): string | null {
  const path = app.isPackaged
    ? join(process.resourcesPath, 'connectors', 'kificut-mcp.js')
    : join(app.getAppPath(), 'connectors', 'claude', 'build', 'server', 'index.js')
  return existsSync(path) ? path : null
}

function addArgs(script: string): string[] {
  return [
    'mcp',
    'add',
    SERVER_NAME,
    process.execPath,
    script,
    '--scope',
    'user',
    '--env',
    'ELECTRON_RUN_AS_NODE=1'
  ]
}

/** The command to paste into a terminal when Kificut cannot run it itself. */
function manualCommand(script: string): string {
  const quote =
    process.platform === 'win32' ? (s: string) => `"${s}"` : (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  const [, , name, command, path, ...rest] = addArgs(script)
  return ['claude', 'mcp', 'add', name, quote(command), quote(path), ...rest].join(' ')
}

/** Claude Code's own copy inside the VS Code (or Cursor, Windsurf) extension, newest first. */
function extensionBinaries(home: string): string[] {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const found: Array<{ version: string; path: string }> = []
  for (const editor of ['.vscode', '.vscode-insiders', '.cursor', '.windsurf']) {
    const dir = join(home, editor, 'extensions')
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const match = /^anthropic\.claude-code-(\d+\.\d+\.\d+)/.exec(name)
      if (match) found.push({ version: match[1], path: join(dir, name, 'resources', 'native-binary', exe) })
    }
  }
  return found
    .sort((a, b) =>
      isNewerVersion(a.version, b.version) ? -1 : isNewerVersion(b.version, a.version) ? 1 : 0
    )
    .map((f) => f.path)
}

function candidates(): string[] {
  const home = app.getPath('home')
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  let names: string[]
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
    dirs.push(join(home, '.local', 'bin'), join(appData, 'npm'))
    names = ['claude.exe', 'claude.cmd']
  } else {
    // Apps opened from the Dock or Finder do not get the shell's PATH, so look where installers put it.
    dirs.push(
      join(home, '.local', 'bin'),
      join(home, '.claude', 'local'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      join(home, '.npm-global', 'bin'),
      join(home, '.bun', 'bin')
    )
    names = ['claude']
  }
  return [...dirs.flatMap((dir) => names.map((name) => join(dir, name))), ...extensionBinaries(home)]
}

/** This process's environment without the switch that makes Kificut's executable act as Node. */
export function plainEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const isScript = /\.(cmd|bat)$/i.test(file)
    // Windows runs .cmd files through cmd.exe, which needs every argument quoted by hand.
    const [command, commandArgs] = isScript ? [`"${file}"`, args.map((a) => `"${a}"`)] : [file, args]
    execFile(
      command,
      commandArgs,
      { timeout: 60_000, windowsHide: true, shell: isScript, env: plainEnv() },
      (error, stdout, stderr) =>
        error ? reject(new Error((stderr || stdout || error.message).trim())) : resolve(stdout)
    )
  })
}

function fromLoginShell(): Promise<string | null> {
  if (process.platform === 'win32') return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile(
      process.env.SHELL || '/bin/zsh',
      ['-ilc', 'command -v claude'],
      { timeout: 5000 },
      (error, stdout) => {
        const path = stdout.trim().split('\n').pop() ?? ''
        resolve(!error && path.startsWith('/') && existsSync(path) ? path : null)
      }
    )
  })
}

async function findClaude(): Promise<string | null> {
  return candidates().find((path) => existsSync(path)) ?? (await fromLoginShell())
}

export async function connectClaudeCode(): Promise<ClaudeCodeResult> {
  const script = serverScript()
  if (!script) throw new Error('This build does not include the Kificut server for Claude Code.')
  const command = manualCommand(script)
  const claude = await findClaude()
  if (!claude) return { ok: false, reason: 'not-found', command }
  // Replace an earlier registration, which may point at an old copy of Kificut.
  await run(claude, ['mcp', 'remove', SERVER_NAME, '--scope', 'user']).catch(() => undefined)
  try {
    await run(claude, addArgs(script))
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      reason: 'failed',
      command,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
