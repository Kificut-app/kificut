import { useEffect, useRef, useState } from 'react'
import { FileAudio, Mic, RotateCcw, Scissors, Square } from 'lucide-react'
import {
  MAX_REFERENCE_SECONDS,
  MAX_VOICE_NAME,
  MIN_REFERENCE_SECONDS,
  READING_TEXT,
  type CustomVoice,
  type VoiceSource
} from '@shared/voices'
import { useEditor } from '../../store/editor'
import { toast } from '../../store/ui'
import { useVoices } from '../../store/voices'
import { errorText } from '../../store/actions'
import { Button, Segmented } from '../ui/controls'
import { Modal } from '../ui/overlays'

type Method = 'record' | 'clip' | 'file'

/** Recording stops by itself here; Kificut keeps at most 20 seconds of speech anyway. */
const MAX_RECORDING_SECONDS = 30

function defaultName(voices: CustomVoice[]): string {
  const names = new Set(voices.map((v) => v.name))
  if (!names.has('My voice')) return 'My voice'
  for (let i = 2; ; i++) if (!names.has(`My voice ${i}`)) return `My voice ${i}`
}

function formatSeconds(seconds: number): string {
  const s = Math.floor(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/** The part of the selected timeline clip that is used, in seconds of its source file. */
function useSelectedClipSource(): { label: string; source: VoiceSource } | { problem: string } {
  const project = useEditor((s) => s.project)
  const selection = useEditor((s) => s.selection)
  const clips = project?.clips.filter((c) => selection.includes(c.id) && c.mediaId) ?? []
  const clip = clips.find((c) => c.kind === 'audio') ?? clips.find((c) => c.kind === 'video')
  const media = clip && project?.media.find((m) => m.id === clip.mediaId)
  if (!clip || !media) {
    return { problem: 'Select a clip on the timeline where the person speaks, trimmed to the part you want.' }
  }
  if (!media.hasAudio) return { problem: `${clip.name} has no sound.` }
  const length = clip.duration * clip.speed
  return {
    label: `${clip.name}, ${length.toFixed(1)} seconds from ${formatSeconds(clip.inPoint)}`,
    source: { kind: 'file', path: media.path, start: clip.inPoint, duration: length }
  }
}

interface Recording {
  data: Uint8Array
  url: string
  seconds: number
}

function useRecorder() {
  const [state, setState] = useState<'idle' | 'starting' | 'recording'>('idle')
  const [seconds, setSeconds] = useState(0)
  const [level, setLevel] = useState(0)
  const [recording, setRecording] = useState<Recording | null>(null)
  const [error, setError] = useState('')
  const live = useRef<{ stop: () => void } | null>(null)

  useEffect(() => () => live.current?.stop(), [])
  useEffect(() => () => void (recording && URL.revokeObjectURL(recording.url)), [recording])

  const start = async () => {
    setError('')
    setState('starting')
    try {
      if (!(await window.kificut.voices.allowMicrophone())) {
        throw new Error(
          'Kificut is not allowed to use the microphone. Turn it on in System Settings > Privacy & Security > Microphone.'
        )
      }
      // Echo cancellation colours the voice; the other clean ups help in a normal room.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true }
      })
      const context = new AudioContext()
      const analyser = context.createAnalyser()
      analyser.fftSize = 1024
      context.createMediaStreamSource(stream).connect(analyser)
      const samples = new Float32Array(analyser.fftSize)

      const recorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm;codecs=opus',
        audioBitsPerSecond: 128_000
      })
      const chunks: Blob[] = []
      recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data)
      const began = performance.now()
      let frame = 0
      const tick = () => {
        analyser.getFloatTimeDomainData(samples)
        let sum = 0
        for (const s of samples) sum += s * s
        setLevel(Math.min(1, Math.sqrt(sum / samples.length) * 4))
        const elapsed = (performance.now() - began) / 1000
        setSeconds(elapsed)
        if (elapsed >= MAX_RECORDING_SECONDS) stop()
        else frame = requestAnimationFrame(tick)
      }
      const stop = () => {
        cancelAnimationFrame(frame)
        if (recorder.state !== 'inactive') recorder.stop()
        stream.getTracks().forEach((t) => t.stop())
        void context.close()
        live.current = null
      }
      recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: 'audio/webm' })
        const data = new Uint8Array(await blob.arrayBuffer())
        setRecording({ data, url: URL.createObjectURL(blob), seconds: (performance.now() - began) / 1000 })
        setState('idle')
        setLevel(0)
      }
      live.current = { stop }
      recorder.start(250)
      setRecording(null)
      setSeconds(0)
      setState('recording')
      frame = requestAnimationFrame(tick)
    } catch (e) {
      setState('idle')
      const name = e instanceof DOMException ? e.name : ''
      setError(
        name === 'NotFoundError'
          ? 'No microphone was found. Connect one, or use a clip or a file instead.'
          : name === 'NotAllowedError'
            ? 'The microphone is blocked. Allow Kificut to use it in your system settings.'
            : errorText(e)
      )
    }
  }

  return { state, seconds, level, recording, error, start, stop: () => live.current?.stop() }
}

export function AddVoiceDialog({
  onClose,
  onCreated
}: {
  onClose: () => void
  onCreated: (voice: CustomVoice) => void
}) {
  const voices = useVoices((s) => s.voices)
  const [name, setName] = useState(() => defaultName(voices))
  const [method, setMethod] = useState<Method>('record')
  const [file, setFile] = useState<string | null>(null)
  const [consent, setConsent] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const recorder = useRecorder()
  const clip = useSelectedClipSource()

  const source: VoiceSource | null =
    method === 'record'
      ? recorder.recording && recorder.state === 'idle'
        ? { kind: 'recording', data: recorder.recording.data }
        : null
      : method === 'clip'
        ? 'source' in clip
          ? clip.source
          : null
        : file
          ? { kind: 'file', path: file }
          : null

  const close = () => {
    recorder.stop()
    onClose()
  }

  const save = async () => {
    if (!source) return
    setSaving(true)
    setError('')
    try {
      const voice = await window.kificut.voices.create({ name, source, consent })
      toast({
        kind: 'success',
        title: `${voice.name} is ready`,
        message: `Kificut kept ${voice.duration.toFixed(1)} seconds of speech. Pick it as the voice for a script.`
      })
      onCreated(voice)
      onClose()
    } catch (e) {
      setError(errorText(e))
      setSaving(false)
    }
  }

  return (
    <Modal title="Add My Voice" onClose={close} width={500} className="add-voice">
      <p className="add-voice__intro">
        Chatterbox Turbo imitates a voice from a short recording: {MIN_REFERENCE_SECONDS} seconds at least, 10
        to {MAX_REFERENCE_SECONDS} is best. Speak naturally in a quiet room. The recording stays on this
        computer.
      </p>

      <label className="field-label" htmlFor="voice-name">
        Name
      </label>
      <input
        id="voice-name"
        className="text-input add-voice__name"
        value={name}
        maxLength={MAX_VOICE_NAME}
        spellCheck={false}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
      />

      <div className="add-voice__methods">
        <Segmented<Method>
          value={method}
          onChange={(m) => {
            if (recorder.state === 'recording') recorder.stop()
            setMethod(m)
          }}
          options={[
            { value: 'record', label: 'Record', icon: <Mic size={13} /> },
            { value: 'clip', label: 'Selected Clip', icon: <Scissors size={13} /> },
            { value: 'file', label: 'File', icon: <FileAudio size={13} /> }
          ]}
        />
      </div>

      {method === 'record' && (
        <div className="add-voice__panel">
          <p className="add-voice__hint">Read this aloud, or say anything you like:</p>
          <blockquote className="add-voice__reading">{READING_TEXT}</blockquote>
          <div className="add-voice__recorder">
            {recorder.state === 'recording' ? (
              <Button variant="danger" icon={<Square size={13} />} onClick={recorder.stop}>
                Stop
              </Button>
            ) : (
              <Button
                variant={recorder.recording ? 'default' : 'primary'}
                icon={recorder.recording ? <RotateCcw size={13} /> : <Mic size={13} />}
                disabled={recorder.state === 'starting'}
                onClick={() => void recorder.start()}
              >
                {recorder.recording ? 'Record Again' : 'Start Recording'}
              </Button>
            )}
            {recorder.state === 'recording' && (
              <>
                <span className="add-voice__time">{formatSeconds(recorder.seconds)}</span>
                <div className="add-voice__meter" aria-hidden="true">
                  <span style={{ width: `${recorder.level * 100}%` }} />
                </div>
              </>
            )}
            {recorder.recording && recorder.state === 'idle' && (
              <audio className="add-voice__playback" src={recorder.recording.url} controls />
            )}
          </div>
          {recorder.recording &&
            recorder.state === 'idle' &&
            recorder.recording.seconds < MIN_REFERENCE_SECONDS && (
              <p className="add-voice__warning">
                That was short. Record at least {MIN_REFERENCE_SECONDS} seconds of speech.
              </p>
            )}
          {recorder.error && <p className="add-voice__error">{recorder.error}</p>}
        </div>
      )}

      {method === 'clip' && (
        <div className="add-voice__panel">
          {'source' in clip ? (
            <p className="add-voice__hint">
              Uses <strong>{clip.label}</strong>. Trim the clip on the timeline to change which part is used.
            </p>
          ) : (
            <p className="add-voice__hint">{clip.problem}</p>
          )}
        </div>
      )}

      {method === 'file' && (
        <div className="add-voice__panel">
          <div className="add-voice__recorder">
            <Button
              icon={<FileAudio size={13} />}
              onClick={() => void window.kificut.voices.pickFile().then((path) => path && setFile(path))}
            >
              {file ? 'Choose Another File' : 'Choose File'}
            </Button>
            {file && <span className="add-voice__file">{fileName(file)}</span>}
          </div>
          <p className="add-voice__hint">
            Any audio or video file with one person speaking. Kificut uses the start of it, without the
            pauses.
          </p>
        </div>
      )}

      <label className="add-voice__consent">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>This is my own voice, or I have permission from the person speaking to use their voice.</span>
      </label>

      {error && <p className="add-voice__error">{error}</p>}

      <div className="modal__actions">
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!source || !consent || !name.trim() || saving}
          onClick={() => void save()}
        >
          {saving ? 'Saving Voice' : 'Save Voice'}
        </Button>
      </div>
    </Modal>
  )
}
