import { app, BrowserWindow, dialog, ipcMain, systemPreferences } from 'electron'
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS } from '@shared/media-formats'
import {
  CUSTOM_VOICE_PREFIX,
  isCustomVoiceId,
  MAX_REFERENCE_SECONDS,
  MAX_VOICE_NAME,
  MIN_REFERENCE_SECONDS,
  splitForSpeech,
  VOICE_CLONE_MODEL,
  VOICE_SAMPLE_RATE,
  type CreateVoiceRequest,
  type CustomVoice
} from '@shared/voices'
import { encodeWav } from '@shared/wav'
import { ffmpegPath, run } from './ffmpeg'
import { decodeAudio, generatedPath } from './media'
import { isModelInstalled } from './models'
import { cancelVoiceEngine, speakChunks, stopVoiceEngine, voiceSupport } from './voice-engine'

/*
 * The user's own voices: a trimmed reference recording and a small JSON file per voice in
 * <userData>/voices/<id>. Recordings stay on the computer.
 */

type StoredVoice = Omit<CustomVoice, 'referencePath'>

const REFERENCE = 'reference.wav'
const INFO = 'voice.json'
/** The most input read for a voice; silences are removed before the first 20 seconds are kept. */
const MAX_INPUT_SECONDS = 90

/*
 * Cleans up a reference recording: removes the silence before and after, shortens long pauses to
 * a third of a second, and brings the level to a steady loudness, then keeps 24 kHz mono.
 */
const CLEANUP =
  'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.1:' +
  'stop_periods=-1:stop_duration=0.5:stop_threshold=-45dB:stop_silence=0.3,' +
  'loudnorm=I=-20:TP=-2:LRA=11'

function voicesDir(): string {
  return join(app.getPath('userData'), 'voices')
}

function voiceDir(id: string): string {
  if (!isCustomVoiceId(id)) throw new Error(`Unknown voice "${id}".`)
  return join(voicesDir(), id)
}

function withPath(stored: StoredVoice): CustomVoice {
  return { ...stored, referencePath: join(voiceDir(stored.id), REFERENCE) }
}

async function readVoice(id: string): Promise<CustomVoice | null> {
  try {
    const stored = JSON.parse(await readFile(join(voiceDir(id), INFO), 'utf8')) as StoredVoice
    await stat(join(voiceDir(id), REFERENCE))
    return withPath({ ...stored, id })
  } catch {
    return null
  }
}

export async function listVoices(): Promise<CustomVoice[]> {
  const entries = await readdir(voicesDir(), { withFileTypes: true }).catch(() => [])
  const voices = await Promise.all(
    entries.filter((e) => e.isDirectory() && isCustomVoiceId(e.name)).map((e) => readVoice(e.name))
  )
  return voices
    .filter((v): v is CustomVoice => v !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export async function getVoice(id: string): Promise<CustomVoice> {
  const voice = isCustomVoiceId(id) ? await readVoice(id) : null
  if (!voice) throw new Error(`There is no custom voice with the id "${id}".`)
  return voice
}

async function broadcast(): Promise<void> {
  const voices = await listVoices()
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.voicesChanged, voices)
}

function cleanName(name: string): string {
  const trimmed = name.replace(/\s+/g, ' ').trim().slice(0, MAX_VOICE_NAME)
  if (!trimmed) throw new Error('Give the voice a name.')
  return trimmed
}

function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).filter(Boolean).pop() ?? ''
}

export async function createVoice(request: CreateVoiceRequest): Promise<CustomVoice> {
  if (request.consent !== true) {
    throw new Error('Confirm that this is your own voice or that you have permission to use it.')
  }
  const name = cleanName(request.name)
  const id = `${CUSTOM_VOICE_PREFIX}${randomBytes(4).toString('hex')}`
  const dir = voiceDir(id)
  await mkdir(dir, { recursive: true })
  try {
    const source = request.source
    const input: string[] = []
    if (source.kind === 'recording') {
      if (!(source.data instanceof Uint8Array) || source.data.length === 0)
        throw new Error('The recording is empty.')
      const recording = join(dir, 'recording')
      await writeFile(recording, source.data)
      input.push('-t', String(MAX_INPUT_SECONDS), '-i', recording)
    } else {
      const info = await stat(source.path).catch(() => null)
      if (!info?.isFile()) throw new Error(`The file ${source.path} could not be found.`)
      if (source.start && source.start > 0) input.push('-ss', source.start.toFixed(3))
      const length = Math.min(source.duration ?? MAX_INPUT_SECONDS, MAX_INPUT_SECONDS)
      input.push('-t', length.toFixed(3), '-i', source.path)
    }

    const reference = join(dir, REFERENCE)
    const result = await run(ffmpegPath(), [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      ...input,
      '-vn',
      '-af',
      CLEANUP,
      '-ac',
      '1',
      '-ar',
      String(VOICE_SAMPLE_RATE),
      '-t',
      String(MAX_REFERENCE_SECONDS),
      '-map_metadata',
      '-1',
      '-c:a',
      'pcm_s16le',
      reference
    ])
    await rm(join(dir, 'recording'), { force: true })
    if (result.code !== 0) {
      throw new Error(lastLine(result.stderr) || 'Could not read the sound in that recording.')
    }

    const duration = (await decodeAudio(reference, VOICE_SAMPLE_RATE)).length / VOICE_SAMPLE_RATE
    if (duration < MIN_REFERENCE_SECONDS) {
      throw new Error(
        `Kificut found only ${duration.toFixed(1)} seconds of sound. Use at least ${MIN_REFERENCE_SECONDS} seconds of speech, ideally 10 to 20.`
      )
    }

    const now = new Date().toISOString()
    const stored: StoredVoice = {
      id,
      name,
      createdAt: now,
      duration: Math.round(duration * 10) / 10,
      source: source.kind,
      consentAt: now
    }
    await writeFile(join(dir, INFO), JSON.stringify(stored, null, 2))
    void broadcast()
    return withPath(stored)
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}

export async function renameVoice(id: string, name: string): Promise<CustomVoice> {
  const voice = await getVoice(id)
  const { referencePath: _, ...stored } = voice
  const next: StoredVoice = { ...stored, name: cleanName(name) }
  await writeFile(join(voiceDir(id), INFO), JSON.stringify(next, null, 2))
  void broadcast()
  return withPath(next)
}

export async function removeVoice(id: string): Promise<void> {
  await getVoice(id)
  await rm(voiceDir(id), { recursive: true, force: true })
  void broadcast()
}

export interface SpokenVoiceover {
  path: string
  duration: number
}

/**
 * Says the script in a custom voice and saves it as a WAV file in Documents/Kificut/Generated.
 * `speed` above or below 1 is applied afterwards with FFmpeg's atempo filter.
 */
export async function speakInVoice(
  id: string,
  text: string,
  speed = 1,
  onStatus?: (message: string) => void
): Promise<SpokenVoiceover> {
  const support = voiceSupport()
  if (!support.supported) throw new Error(support.reason)
  if (!(await isModelInstalled(VOICE_CLONE_MODEL))) {
    throw new Error('Custom voices need the Chatterbox Turbo model, which is not installed yet.')
  }
  const voice = await getVoice(id)
  const chunks = splitForSpeech(text)
  if (chunks.length === 0) throw new Error('There is no text to speak.')
  if (!(speed >= 0.5 && speed <= 2)) throw new Error('Speed must be between 0.5 and 2.')

  const reference = await decodeAudio(voice.referencePath, VOICE_SAMPLE_RATE)
  const { mtimeMs } = await stat(voice.referencePath)
  const { samples, sampleRate } = await speakChunks(reference, `${id}:${mtimeMs}`, chunks, onStatus)

  const target = await generatedPath(`Voiceover ${voice.name} - ${text.trim().slice(0, 32)}.wav`)
  if (Math.abs(speed - 1) < 0.005) {
    await writeFile(target, encodeWav(samples, sampleRate))
    return { path: target, duration: samples.length / sampleRate }
  }
  const raw = `${target}.part.wav`
  await writeFile(raw, encodeWav(samples, sampleRate))
  try {
    const result = await run(ffmpegPath(), [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      raw,
      '-af',
      `atempo=${speed.toFixed(3)}`,
      '-c:a',
      'pcm_s16le',
      target
    ])
    if (result.code !== 0) throw new Error(lastLine(result.stderr) || 'Could not change the speed.')
  } finally {
    await rm(raw, { force: true })
  }
  return { path: target, duration: samples.length / sampleRate / speed }
}

/** On macOS the system asks once for permission to use the microphone. */
async function allowMicrophone(): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true
  return systemPreferences.askForMediaAccess('microphone')
}

export function registerVoiceIpc(): void {
  ipcMain.handle(IPC.voicesSupport, () => voiceSupport())
  ipcMain.handle(IPC.voicesList, () => listVoices())
  ipcMain.handle(IPC.voicesCreate, (_event, request: CreateVoiceRequest) => createVoice(request))
  ipcMain.handle(IPC.voicesRename, (_event, id: string, name: string) => renameVoice(id, name))
  ipcMain.handle(IPC.voicesRemove, (_event, id: string) => removeVoice(id))
  ipcMain.handle(IPC.voicesSpeak, (event, id: string, text: string, speed: number) =>
    speakInVoice(id, text, speed, (message) => {
      if (!event.sender.isDestroyed()) event.sender.send(IPC.voicesStatus, message)
    })
  )
  ipcMain.handle(IPC.voicesCancel, () => cancelVoiceEngine())
  ipcMain.handle(IPC.voicesMicrophone, () => allowMicrophone())
  ipcMain.handle(IPC.voicesPickFile, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a Recording of the Voice',
      properties: ['openFile'],
      filters: [{ name: 'Audio and video', extensions: [...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS] }]
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  app.on('before-quit', () => stopVoiceEngine())
}
