// Builds the Claude Desktop connector into connectors/claude/dist/Kificut-<version>-claude.mcpb.
// Run with `npm run build:connector` (also part of `npm run build`).

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const connector = join(root, 'connectors', 'claude')
const staging = join(connector, 'build')
const dist = join(connector, 'dist')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const repo = 'https://github.com/Kificut-app/kificut'
const mcpb = join(root, 'node_modules', '@anthropic-ai', 'mcpb', 'dist', 'cli', 'cli.js')

rmSync(staging, { recursive: true, force: true })
await build({ configFile: join(connector, 'vite.config.mts') })

const server = join(staging, 'server', 'index.js')
const tools = JSON.parse(execFileSync(process.execPath, [server, '--print-tools'], { encoding: 'utf8' }))

const manifest = {
  manifest_version: '0.2',
  name: 'kificut',
  display_name: 'Kificut',
  version: pkg.version,
  description: 'Edit videos in Kificut: bring in footage, build the timeline, add titles and export.',
  long_description:
    'Lets Claude work in the Kificut video editor on your computer. Claude can look through your footage, ' +
    'find scene changes and silences, place and trim clips, add titles and color layers, check frames and ' +
    'export the result. Kificut needs to be installed; the connector opens it when needed. Every change ' +
    'shows up in Kificut as it happens and can be undone there. Claude sees the project details, file ' +
    'names and frames it asks for.',
  author: { name: 'Kificut contributors', url: repo },
  repository: { type: 'git', url: `${repo}.git` },
  homepage: repo,
  documentation: `${repo}#use-kificut-from-claude`,
  support: `${repo}/issues`,
  icon: 'icon.png',
  server: {
    type: 'node',
    entry_point: 'server/index.js',
    mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'] }
  },
  tools,
  keywords: ['video', 'video editor', 'editing', 'ffmpeg', 'kificut'],
  license: 'MIT',
  compatibility: { platforms: ['darwin', 'win32', 'linux'], runtimes: { node: '>=18.0.0' } }
}

writeFileSync(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
copyFileSync(join(connector, 'icon.png'), join(staging, 'icon.png'))

execFileSync(process.execPath, [mcpb, 'validate', join(staging, 'manifest.json')], { stdio: 'inherit' })
rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })
const output = join(dist, `Kificut-${pkg.version}-claude.mcpb`)
execFileSync(process.execPath, [mcpb, 'pack', staging, output], { stdio: 'inherit' })
console.log(`Claude connector: ${output}`)
