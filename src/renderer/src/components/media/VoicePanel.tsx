import { useEffect, useRef, useState } from 'react'
import { AudioLines, Check, Pause, Pencil, Play, Plus, Trash2, UserRound } from 'lucide-react'
import { DEFAULT_VOICE, getLocalModel, KOKORO_VOICES, type LocalModelInfo } from '@shared/models'
import { VOICE_CLONE_MODEL, type CustomVoice } from '@shared/voices'
import { cancelModelInstall, formatBytes, installModel, useModels } from '../../store/models'
import { useVoices } from '../../store/voices'
import { confirmDialog, toast } from '../../store/ui'
import { errorText } from '../../store/actions'
import { generateVoiceover } from '../../local-ai/commands'
import { mediaUrl } from '../../lib/media'
import { Button, Select, Slider } from '../ui/controls'
import { AddVoiceDialog } from './AddVoiceDialog'

const KOKORO = getLocalModel('kokoro-82m')!
const CHATTERBOX = getLocalModel(VOICE_CLONE_MODEL)!
const VOICE_KEY = 'kificut.voice'

function savedVoice(): string | null {
  try {
    return localStorage.getItem(VOICE_KEY)
  } catch {
    return null
  }
}

function rememberVoice(voice: string): void {
  try {
    localStorage.setItem(VOICE_KEY, voice)
  } catch {
    // Remembering the voice is a convenience only.
  }
}

/** Install button, progress and errors for one model. */
function InstallButton({ model }: { model: LocalModelInfo }) {
  const status = useModels((s) => s[model.id])
  if (status?.state === 'downloading') {
    const percent = status.total ? (status.received / status.total) * 100 : 0
    return (
      <div className="voice__progress">
        <div className="progress">
          <span style={{ width: `${percent}%` }} />
        </div>
        <div className="voice__progress-row">
          <span>
            {formatBytes(status.received)} of {formatBytes(status.total)}
          </span>
          <Button size="sm" variant="ghost" onClick={() => cancelModelInstall(model.id)}>
            Cancel
          </Button>
        </div>
      </div>
    )
  }
  return (
    <>
      <Button variant="primary" size="sm" onClick={() => installModel(model.id)}>
        {status?.state === 'error'
          ? 'Try Again'
          : `Install ${model.name} (${formatBytes(model.approximateSize)})`}
      </Button>
      {status?.state === 'error' && <p className="voice__error">{status.error}</p>}
    </>
  )
}

export function VoicePanel() {
  const kokoroReady = useModels((s) => s[KOKORO.id]?.state === 'installed')
  const cloneReady = useModels((s) => s[CHATTERBOX.id]?.state === 'installed')
  const voices = useVoices((s) => s.voices)
  const support = useVoices((s) => s.support)
  const [text, setText] = useState('')
  const [voice, setVoice] = useState<string | null>(savedVoice)
  const [speed, setSpeed] = useState(1)
  const [working, setWorking] = useState(false)
  const [adding, setAdding] = useState(false)

  const mine = cloneReady && support?.supported ? voices : []
  const options = [
    ...mine.map((v) => ({ value: v.id, label: v.name, group: 'My voices' })),
    ...(kokoroReady
      ? KOKORO_VOICES.map((v) => ({
          value: v.id,
          label: `${v.name}, ${v.accent} ${v.gender.toLowerCase()}`,
          group: mine.length > 0 ? 'Kokoro voices' : undefined
        }))
      : [])
  ]
  // Fall back when the saved voice was deleted or its model removed.
  const current = options.some((o) => o.value === voice)
    ? voice!
    : kokoroReady
      ? DEFAULT_VOICE
      : (options[0]?.value ?? null)

  const generate = async () => {
    if (!current) return
    setWorking(true)
    const ok = await generateVoiceover(text, current, speed)
    setWorking(false)
    if (ok) setText('')
  }

  return (
    <div className="voice">
      {current ? (
        <>
          <label className="field-label" htmlFor="voice-script">
            Script
          </label>
          <textarea
            id="voice-script"
            className="text-area voice__script"
            placeholder="What should the voice say?"
            value={text}
            disabled={working}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <label className="field-label">Voice</label>
          <Select<string>
            value={current}
            onChange={(v) => {
              setVoice(v)
              rememberVoice(v)
            }}
            options={options}
          />
          <label className="field-label">
            Speed <span className="voice__value">{speed.toFixed(2)}x</span>
          </label>
          <Slider value={speed} min={0.5} max={2} step={0.05} reset={1} onChange={setSpeed} />
          <div className="voice__actions">
            <Button
              variant="primary"
              className="voice__generate"
              disabled={working || !text.trim()}
              onClick={() => void generate()}
            >
              {working ? 'Creating Voiceover' : 'Add Voiceover at Playhead'}
            </Button>
            {working && mine.some((v) => v.id === current) && (
              <Button variant="ghost" onClick={() => void window.kificut.voices.cancel()}>
                Stop
              </Button>
            )}
          </div>
          <p className="voice__note">Saved as a WAV file in Documents/Kificut/Generated.</p>
        </>
      ) : (
        <div className="voice--setup">
          <div className="media-bin__empty-icon">
            <AudioLines size={20} />
          </div>
          <h3>Voiceovers from text</h3>
          <p>
            Type a script and Kificut reads it out with one of {KOKORO_VOICES.length} natural voices, or in
            your own voice. The models run on this computer and work offline.
          </p>
        </div>
      )}

      {!kokoroReady && (
        <section className="voice__section">
          <h4 className="voice__heading">Kokoro voices</h4>
          <p className="voice__text">
            {KOKORO_VOICES.length} American and British voices, quick enough to try a script many times.
          </p>
          <InstallButton model={KOKORO} />
        </section>
      )}

      <section className="voice__section">
        <h4 className="voice__heading">My voices</h4>
        {support && !support.supported ? (
          <p className="voice__text">{support.reason}</p>
        ) : !cloneReady ? (
          <>
            <p className="voice__text">
              Use your own voice, or a voice you have permission to use. Chatterbox Turbo learns it from 10 to
              20 seconds of speech; nothing is trained or uploaded. It is slower than Kokoro: 30 seconds of
              speech can take a minute or two.
            </p>
            <InstallButton model={CHATTERBOX} />
          </>
        ) : (
          <>
            {voices.length === 0 && (
              <p className="voice__text">
                Record yourself, or use a clip where you speak, and Kificut can read any script in that voice.
              </p>
            )}
            <ul className="voice__list">
              {voices.map((v) => (
                <VoiceRow key={v.id} voice={v} />
              ))}
            </ul>
            <Button size="sm" icon={<Plus size={13} />} onClick={() => setAdding(true)}>
              Add My Voice
            </Button>
          </>
        )}
      </section>

      {adding && (
        <AddVoiceDialog
          onClose={() => setAdding(false)}
          onCreated={(created) => {
            setVoice(created.id)
            rememberVoice(created.id)
          }}
        />
      )}
    </div>
  )
}

function VoiceRow({ voice }: { voice: CustomVoice }) {
  const [playing, setPlaying] = useState(false)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(voice.name)
  const audio = useRef<HTMLAudioElement | null>(null)

  useEffect(() => () => audio.current?.pause(), [])

  const togglePlay = () => {
    if (playing) {
      audio.current?.pause()
      return
    }
    // A fresh element each time, so a re-recorded voice is never played from cache.
    const element = new Audio(`${mediaUrl(voice.referencePath)}?t=${Date.now()}`)
    element.onended = element.onpause = () => setPlaying(false)
    audio.current = element
    void element.play().then(() => setPlaying(true))
  }

  const rename = async () => {
    setEditing(false)
    if (name.trim() === voice.name || !name.trim()) return setName(voice.name)
    try {
      await window.kificut.voices.rename(voice.id, name)
    } catch (e) {
      setName(voice.name)
      toast({ kind: 'error', title: 'Could not rename the voice', message: errorText(e) })
    }
  }

  const remove = async () => {
    const choice = await confirmDialog({
      title: `Delete ${voice.name}?`,
      message: 'Its recording is deleted from this computer. Voiceovers already made with it stay.',
      buttons: [
        { id: 'cancel', label: 'Cancel' },
        { id: 'delete', label: 'Delete Voice', danger: true }
      ]
    })
    if (choice !== 'delete') return
    try {
      await window.kificut.voices.remove(voice.id)
    } catch (e) {
      toast({ kind: 'error', title: 'Could not delete the voice', message: errorText(e) })
    }
  }

  return (
    <li className="voice__item">
      <UserRound size={14} className="voice__item-icon" />
      {editing ? (
        <input
          className="text-input voice__rename"
          value={name}
          autoFocus
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void rename()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') {
              setName(voice.name)
              setEditing(false)
            }
          }}
        />
      ) : (
        <span className="voice__item-name">
          {voice.name}
          <span className="voice__item-meta">{voice.duration.toFixed(0)} s</span>
        </span>
      )}
      <Button
        size="sm"
        variant="ghost"
        icon={editing ? <Check size={13} /> : <Pencil size={13} />}
        tip={editing ? 'Save Name' : 'Rename'}
        onMouseDown={(e) => editing && e.preventDefault()}
        onClick={() => (editing ? void rename() : setEditing(true))}
      />
      <Button
        size="sm"
        variant="ghost"
        icon={playing ? <Pause size={13} /> : <Play size={13} />}
        tip={playing ? 'Stop' : 'Play the Recording'}
        onClick={togglePlay}
      />
      <Button
        size="sm"
        variant="ghost"
        icon={<Trash2 size={13} />}
        tip="Delete Voice"
        onClick={() => void remove()}
      />
    </li>
  )
}
