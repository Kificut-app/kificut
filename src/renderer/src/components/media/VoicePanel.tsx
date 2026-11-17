import { useState } from 'react'
import { AudioLines } from 'lucide-react'
import { DEFAULT_VOICE, getLocalModel, KOKORO_VOICES } from '@shared/models'
import { cancelModelInstall, formatBytes, installModel, useModels } from '../../store/models'
import { generateVoiceover } from '../../local-ai/commands'
import { Button, Select, Slider } from '../ui/controls'

const KOKORO = getLocalModel('kokoro-82m')!
const VOICE_KEY = 'kificut.voice'

function savedVoice(): string {
  try {
    const voice = localStorage.getItem(VOICE_KEY)
    return voice && KOKORO_VOICES.some((v) => v.id === voice) ? voice : DEFAULT_VOICE
  } catch {
    return DEFAULT_VOICE
  }
}

export function VoicePanel() {
  const status = useModels((s) => s[KOKORO.id])
  const [text, setText] = useState('')
  const [voice, setVoice] = useState(savedVoice)
  const [speed, setSpeed] = useState(1)
  const [working, setWorking] = useState(false)

  if (status?.state !== 'installed') {
    const downloading = status?.state === 'downloading'
    const percent = downloading && status.total ? (status.received / status.total) * 100 : 0
    return (
      <div className="voice voice--setup">
        <div className="media-bin__empty-icon">
          <AudioLines size={20} />
        </div>
        <h3>Voiceovers from text</h3>
        <p>
          Type a script and Kificut reads it out with one of {KOKORO_VOICES.length} natural voices. The Kokoro
          model runs on this computer and works offline.
        </p>
        {downloading ? (
          <div className="voice__progress">
            <div className="progress">
              <span style={{ width: `${percent}%` }} />
            </div>
            <div className="voice__progress-row">
              <span>
                {formatBytes(status.received)} of {formatBytes(status.total)}
              </span>
              <Button size="sm" variant="ghost" onClick={() => cancelModelInstall(KOKORO.id)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <Button variant="primary" size="sm" onClick={() => installModel(KOKORO.id)}>
              {status?.state === 'error'
                ? 'Try Again'
                : `Install Kokoro (${formatBytes(KOKORO.approximateSize)})`}
            </Button>
            {status?.state === 'error' && <p className="voice__error">{status.error}</p>}
          </>
        )}
      </div>
    )
  }

  const generate = async () => {
    setWorking(true)
    const ok = await generateVoiceover(text, voice, speed)
    setWorking(false)
    if (ok) setText('')
  }

  return (
    <div className="voice">
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
        value={voice}
        onChange={(v) => {
          setVoice(v)
          try {
            localStorage.setItem(VOICE_KEY, v)
          } catch {
            // Remembering the voice is a convenience only.
          }
        }}
        options={KOKORO_VOICES.map((v) => ({
          value: v.id,
          label: `${v.name}, ${v.accent} ${v.gender.toLowerCase()}`
        }))}
      />
      <label className="field-label">
        Speed <span className="voice__value">{speed.toFixed(2)}x</span>
      </label>
      <Slider value={speed} min={0.5} max={2} step={0.05} reset={1} onChange={setSpeed} />
      <Button
        variant="primary"
        className="voice__generate"
        disabled={working || !text.trim()}
        onClick={() => void generate()}
      >
        {working ? 'Creating Voiceover' : 'Add Voiceover at Playhead'}
      </Button>
      <p className="voice__note">Saved as a WAV file in Documents/Kificut/Generated.</p>
    </div>
  )
}
