import { useEffect, useState } from 'react'
import { Plus, ScanSearch } from 'lucide-react'
import { formatDuration } from '@shared/time'
import { useEditor } from '../../store/editor'
import { addMediaAtPlayhead, errorText, placeMedia } from '../../store/actions'
import { useModels } from '../../store/models'
import { findShots, ModelMissingError, type Shot } from '../../local-ai/features'
import { openAiDialog } from '../dialogs/AiDialog'
import { Button, IconButton } from '../ui/controls'

/** Searches the footage in the project by what it shows, with CLIP running on this computer. */
export function FootageSearch({ query, run }: { query: string; run: number }) {
  const media = useEditor((s) => s.project?.media)
  const installed = useModels((s) => s['clip-base']?.state === 'installed')
  const [shots, setShots] = useState<Shot[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (run === 0 || !query.trim() || !media) return
    let cancelled = false
    setBusy(true)
    setError(null)
    findShots(query, media, 12)
      .then((found) => !cancelled && setShots(found))
      .catch((e: unknown) => !cancelled && setError(e instanceof ModelMissingError ? null : errorText(e)))
      .finally(() => !cancelled && setBusy(false))
    return () => {
      cancelled = true
    }
    // Search when asked to (Enter), not on every keystroke or media change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run])

  if (!installed) {
    return (
      <div className="footage-search__empty">
        <div className="media-bin__empty-icon">
          <ScanSearch size={20} />
        </div>
        <p>Find shots by describing them, like "sunset over the sea" or "close-up of hands".</p>
        <Button size="sm" variant="primary" onClick={() => openAiDialog('models')}>
          Install the Search Model
        </Button>
      </div>
    )
  }
  if (busy) {
    return (
      <div className="footage-search__empty">
        <span className="spinner" />
        <p>Looking through the footage. The first search of a file takes longer while it is indexed.</p>
      </div>
    )
  }
  if (error) return <p className="footage-search__note is-error">{error}</p>
  if (!shots) {
    return <p className="footage-search__note">Describe a shot and press Enter.</p>
  }
  if (shots.length === 0) return <p className="footage-search__note">Nothing looks like "{query}".</p>
  return (
    <div className="footage-search__results">
      {shots.map((shot) => (
        <ShotRow key={`${shot.media.id}-${shot.start}`} shot={shot} />
      ))}
    </div>
  )
}

function ShotRow({ shot }: { shot: Shot }) {
  const [frame, setFrame] = useState<string | null>(null)
  const image = shot.media.kind === 'image'

  useEffect(() => {
    let cancelled = false
    void window.kificut.media
      .sampleFrames(shot.media.path, shot.media.duration, 1, shot.time, shot.time)
      .then(([f]) => !cancelled && f && setFrame(`data:image/jpeg;base64,${f.data}`))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [shot.media.path, shot.media.duration, shot.time])

  const add = () => {
    if (image) {
      addMediaAtPlayhead(shot.media.id)
      return
    }
    const length = Math.max(1, shot.end - shot.start)
    placeMedia(shot.media.id, useEditor.getState().playhead, null, { inPoint: shot.start, duration: length })
  }

  return (
    <div className="shot">
      <div className="shot__frame">{frame && <img src={frame} alt="" />}</div>
      <div className="shot__text">
        <span className="shot__name">{shot.media.name}</span>
        <span className="shot__time">
          {image ? 'Picture' : `${formatDuration(shot.start)} to ${formatDuration(shot.end)}`}
        </span>
      </div>
      <IconButton size="sm" tip="Add to the timeline at the playhead" onClick={add}>
        <Plus size={14} />
      </IconButton>
    </div>
  )
}
