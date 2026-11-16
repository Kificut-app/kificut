// Downloads the FFprobe binary from the same release as the bundled FFmpeg (ffmpeg-static), for
// the platform and architecture being installed. Runs on `npm install`; the file lands in
// vendor/ffprobe and is packaged next to FFmpeg.
//
// Honors the same overrides as ffmpeg-static: npm_config_platform, npm_config_arch,
// FFMPEG_BINARY_RELEASE and FFMPEG_BINARIES_URL (for mirrors).

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'node_modules', 'ffmpeg-static', 'package.json'), 'utf8'))
const settings = pkg['ffmpeg-static']

const release = process.env[settings['binary-release-tag-env-var']] || settings['binary-release-tag']
const baseUrl =
  process.env[settings['binaries-url-env-var']] ||
  `https://github.com/eugeneware/ffmpeg-static/releases/download/${release}`
const platform = process.env.npm_config_platform || process.platform
const arch = process.env.npm_config_arch || process.arch

const dir = join(root, 'vendor', 'ffprobe')
const target = join(dir, platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
const marker = join(dir, 'source.txt')
const source = `${release} ${platform}-${arch}`

if (existsSync(target) && existsSync(marker) && readFileSync(marker, 'utf8').trim() === source) {
  console.log(`ffprobe ${source} is installed already.`)
  process.exit(0)
}

const url = `${baseUrl}/ffprobe-${platform}-${arch}.gz`
try {
  console.log(`Downloading ffprobe ${source}`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  const binary = gunzipSync(Buffer.from(await response.arrayBuffer()))
  mkdirSync(dir, { recursive: true })
  writeFileSync(target, binary)
  chmodSync(target, 0o755)
  writeFileSync(marker, `${source}\n`)
  console.log(`ffprobe saved to ${target}`)
} catch (error) {
  console.warn(`Could not download ffprobe: ${error instanceof Error ? error.message : error}`)
  console.warn(
    'Media import will not work until it is available. Run `node scripts/fetch-ffprobe.mjs` to retry.'
  )
  // A missing binary must not slip into a release build.
  if (process.env.CI) process.exit(1)
}
