import { useEffect, useMemo, useState } from 'react'
import { Clapperboard, Film, FolderOpen, ImageIcon, Plus, RotateCcw, Sparkles, X } from 'lucide-react'
import {
  frameSize,
  GENERATION_SERVICES,
  getService,
  nearest,
  nearestAspect,
  SUGGESTED_MODELS,
  type AspectRatio,
  type GenerationJob,
  type GenerationKind,
  type GenerationRequest,
  type GenerationService,
  type GenerationSettings,
  type ModelCapabilities,
  type StartImage
} from '@shared/generation'
import { useEditor } from '../../store/editor'
import { errorText } from '../../store/actions'
import { addJobAtPlayhead, canRetry, retryJob, startGeneration, useGeneration } from '../../store/generation'
import { player } from '../../engine/player'
import { mediaUrl } from '../../lib/media'
import { openAiDialog } from '../dialogs/AiDialog'
import { Button, Segmented, Select, Switch } from '../ui/controls'

/* The Generate tab: describe a scene or a picture and an AI service makes it. */

const SETTINGS_KEY = 'kificut.generate'
const OTHER_MODEL = '__other__'

interface Saved {
  kind: GenerationKind
  service: GenerationService
  models: Partial<Record<`${GenerationService}-${GenerationKind}`, string>>
  place: boolean
}

function loadSaved(): Saved {
  const defaults: Saved = { kind: 'video', service: 'google', models: {}, place: true }
  try {
    return { ...defaults, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<Saved>) }
  } catch {
    return defaults
  }
}

function remember(saved: Saved): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(saved))
  } catch {
    // A convenience only.
  }
}

/** Whether a service has what it needs to run, and what to say when it does not. */
function readiness(service: GenerationService, kind: GenerationKind, settings: GenerationSettings | null) {
  if (!settings) return { ready: false, missing: '' }
  if (service === 'google' && !settings.googleKey)
    return { ready: false, missing: 'Add your Gemini API key to use Google.' }
  if (service === 'fal' && !settings.falKey)
    return { ready: false, missing: 'Add your fal.ai API key to use fal.ai.' }
  if (service === 'comfyui') {
    const workflow = kind === 'video' ? settings.comfyuiVideoWorkflow : settings.comfyuiImageWorkflow
    if (!workflow)
      return {
        ready: false,
        missing: `Choose a ComfyUI ${kind === 'video' ? 'video' : 'picture'} workflow first.`
      }
  }
  return { ready: true, missing: '' }
}

async function fileToStartImage(path: string): Promise<StartImage> {
  const blob = await (await fetch(mediaUrl(path))).blob()
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(new Error('Could not read the picture.'))
    reader.readAsDataURL(blob)
  })
  const lower = path.toLowerCase()
  const mimeType = lower.endsWith('.png')
    ? 'image/png'
    : lower.endsWith('.webp')
      ? 'image/webp'
      : 'image/jpeg'
  return { data, mimeType }
}

function elapsed(job: GenerationJob): string {
  const seconds = Math.max(0, Math.round((Date.now() - job.startedAt) / 1000))
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`
}

export function GeneratePanel() {
  const settings = useGeneration((s) => s.settings)
  const jobs = useGeneration((s) => s.jobs)
  const project = useEditor((s) => s.project)
  const [saved, setSaved] = useState<Saved>(loadSaved)
  const [prompt, setPrompt] = useState('')
  const [otherModel, setOtherModel] = useState('')
  const [caps, setCaps] = useState<ModelCapabilities | null>(null)
  const [capsError, setCapsError] = useState('')
  const [duration, setDuration] = useState(5)
  const [aspect, setAspect] = useState<AspectRatio>('16:9')
  const [resolution, setResolution] = useState('720p')
  const [start, setStart] = useState<'none' | 'frame' | 'file'>('none')
  const [startFile, setStartFile] = useState<string | null>(null)
  const [estimate, setEstimate] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [, tick] = useState(0)

  const update = (patch: Partial<Saved>) =>
    setSaved((s) => {
      const next = { ...s, ...patch }
      remember(next)
      return next
    })

  const { kind, service } = saved
  const suggestions = service === 'comfyui' ? [] : SUGGESTED_MODELS[service].filter((m) => m.kind === kind)
  const modelKey = `${service}-${kind}` as const
  const chosen = saved.models[modelKey] ?? suggestions[0]?.id ?? ''
  const isOther = service === 'fal' && (chosen === OTHER_MODEL || !suggestions.some((m) => m.id === chosen))
  const model =
    service === 'comfyui'
      ? kind
      : isOther
        ? otherModel.trim() || (chosen === OTHER_MODEL ? '' : chosen)
        : chosen
  const { ready, missing } = readiness(service, kind, settings)

  useEffect(() => {
    if (isOther && chosen !== OTHER_MODEL && !otherModel) setOtherModel(chosen)
  }, [isOther, chosen, otherModel])

  // What the model accepts decides which options are offered.
  useEffect(() => {
    setCaps(null)
    setCapsError('')
    if (!model) return
    let current = true
    const timer = window.setTimeout(() => {
      window.kificut.generation
        .capabilities(service, model)
        .then((c) => {
          if (!current) return
          setCaps(c)
          const frame = project ? project.settings : { width: 16, height: 9 }
          setAspect((a) => (c.aspects.includes(a) ? a : nearestAspect(frame.width, frame.height, c.aspects)))
          setDuration((d) => (c.durations.length ? nearest(c.durations, d) : d))
          setResolution((r) =>
            c.resolutions.includes(r) ? r : (c.resolutions.find((x) => x === '720p') ?? c.resolutions[0] ?? r)
          )
          if (!c.startImage) setStart('none')
        })
        .catch((e: unknown) => current && setCapsError(errorText(e)))
    }, 400)
    return () => {
      current = false
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, model])

  const request: GenerationRequest | null = useMemo(
    () =>
      model && caps
        ? {
            kind: caps.kind,
            service,
            model,
            prompt: prompt.trim(),
            duration,
            aspect,
            resolution: caps.resolutions.length ? resolution : undefined
          }
        : null,
    [model, caps, service, prompt, duration, aspect, resolution]
  )

  useEffect(() => {
    setEstimate('')
    if (!request || !ready) return
    let current = true
    const timer = window.setTimeout(() => {
      void window.kificut.generation
        .estimate({ ...request, prompt: request.prompt || 'estimate' })
        .then((e) => current && setEstimate(e))
        .catch(() => undefined)
    }, 400)
    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [request, ready])

  // Keep the elapsed times in the job list moving.
  const running = jobs.some((j) => j.state === 'running')
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => tick((n) => n + 1), 1000)
    return () => window.clearInterval(timer)
  }, [running])

  const generate = async () => {
    if (!request || !request.prompt) return
    setBusy(true)
    setError('')
    try {
      let startImage: StartImage | undefined
      if (start === 'frame') startImage = { data: await player.capture(1280), mimeType: 'image/jpeg' }
      else if (start === 'file' && startFile) startImage = await fileToStartImage(startFile)
      await startGeneration({ ...request, startImage }, saved.place && !!project)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const pickStartFile = async () => {
    const paths = await window.kificut.media.pick()
    const picture = paths.find((p) => /\.(png|jpe?g|webp)$/i.test(p))
    if (picture) {
      setStartFile(picture)
      setStart('file')
    } else if (paths.length) setError('Choose a PNG, JPEG or WebP picture.')
  }

  const size = caps?.kind === 'video' ? frameSize(aspect, resolution) : null

  return (
    <div className="generate">
      <Segmented<GenerationKind>
        value={kind}
        onChange={(k) => update({ kind: k })}
        options={[
          { value: 'video', label: 'Scene', icon: <Film size={13} /> },
          { value: 'image', label: 'Picture', icon: <ImageIcon size={13} /> }
        ]}
      />

      <label className="field-label">Service</label>
      <Select<GenerationService>
        value={service}
        onChange={(s) => update({ service: s })}
        options={GENERATION_SERVICES.map((s) => ({ value: s.id, label: s.name }))}
      />
      {service !== 'comfyui' && (
        <>
          <label className="field-label">Model</label>
          <Select<string>
            value={isOther ? OTHER_MODEL : chosen}
            onChange={(m) => update({ models: { ...saved.models, [modelKey]: m } })}
            options={[
              ...suggestions.map((m) => ({ value: m.id, label: m.name })),
              ...(service === 'fal' ? [{ value: OTHER_MODEL, label: 'Another fal.ai model…' }] : [])
            ]}
          />
          {isOther && (
            <input
              className="text-input generate__other"
              placeholder="Model id, such as fal-ai/ltx-video"
              value={otherModel}
              spellCheck={false}
              onChange={(e) => setOtherModel(e.target.value)}
              onBlur={() =>
                update({ models: { ...saved.models, [modelKey]: otherModel.trim() || OTHER_MODEL } })
              }
              onKeyDown={(e) => e.stopPropagation()}
            />
          )}
        </>
      )}

      {!ready && missing ? (
        <div className="generate__setup">
          <p>{missing}</p>
          <Button size="sm" variant="primary" onClick={() => openAiDialog('generation')}>
            Set Up {getService(service)?.name}
          </Button>
        </div>
      ) : null}

      <label className="field-label" htmlFor="generate-prompt">
        Describe the {kind === 'video' ? 'scene' : 'picture'}
      </label>
      <textarea
        id="generate-prompt"
        className="text-area generate__prompt"
        placeholder={
          kind === 'video'
            ? 'A slow aerial shot over a misty pine forest at sunrise, soft golden light'
            : 'A cosy café interior in the morning, warm light, shallow depth of field'
        }
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
      />

      {capsError && <p className="generate__error">{capsError}</p>}

      {caps && (
        <div className="generate__options">
          {caps.kind === 'video' && caps.durations.length > 0 && (
            <div className="generate__option">
              <span>Length</span>
              <Select<string>
                value={String(duration)}
                onChange={(v) => setDuration(Number(v))}
                options={caps.durations.map((d) => ({ value: String(d), label: `${d} s` }))}
              />
            </div>
          )}
          <div className="generate__option">
            <span>Shape</span>
            <Select<AspectRatio>
              value={aspect}
              onChange={setAspect}
              options={caps.aspects.map((a) => ({
                value: a,
                label: a === '16:9' ? 'Wide 16:9' : a === '9:16' ? 'Tall 9:16' : 'Square 1:1'
              }))}
            />
          </div>
          {caps.resolutions.length > 0 && (
            <div className="generate__option">
              <span>Resolution</span>
              <Select<string>
                value={resolution}
                onChange={setResolution}
                options={caps.resolutions.map((r) => ({ value: r, label: r }))}
              />
            </div>
          )}
          {caps.startImage && (
            <div className="generate__option">
              <span>Start from</span>
              <Select<string>
                value={start}
                onChange={(v) => (v === 'pick' ? void pickStartFile() : setStart(v as typeof start))}
                options={[
                  { value: 'none', label: 'Only the description' },
                  ...(project ? [{ value: 'frame', label: 'The frame at the playhead' }] : []),
                  ...(startFile ? [{ value: 'file', label: startFile.split(/[\\/]/).pop()! }] : []),
                  { value: 'pick', label: 'A picture…' }
                ]}
              />
            </div>
          )}
        </div>
      )}

      {project && (
        <div className="generate__option generate__place">
          <span>Add to the timeline at the playhead</span>
          <Switch checked={saved.place} onChange={(place) => update({ place })} />
        </div>
      )}

      <Button
        variant="primary"
        className="generate__go"
        icon={<Sparkles size={14} />}
        disabled={!request || !prompt.trim() || !ready || busy}
        onClick={() => void generate()}
      >
        {busy ? 'Starting' : `Generate ${kind === 'video' ? 'Scene' : 'Picture'}`}
      </Button>
      <p className="generate__cost">
        {estimate
          ? `${estimate.charAt(0).toUpperCase()}${estimate.slice(1)}${size ? `, ${size.width} × ${size.height}` : ''}.`
          : service === 'comfyui'
            ? 'Free, on your own ComfyUI.'
            : 'Billed by the service to your account.'}
      </p>
      {error && <p className="generate__error">{error}</p>}

      {jobs.length > 0 && (
        <section className="generate__jobs">
          <h4 className="voice__heading">Recent</h4>
          <ul>
            {jobs.map((job) => (
              <JobRow key={job.id} job={job} hasProject={!!project} elapsed={elapsed(job)} />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function JobRow({ job, hasProject, elapsed }: { job: GenerationJob; hasProject: boolean; elapsed: string }) {
  const Icon = job.kind === 'video' ? Clapperboard : ImageIcon
  return (
    <li className={`generate__job is-${job.state}`}>
      <Icon size={14} className="generate__job-icon" />
      <div className="generate__job-text">
        <span className="generate__job-prompt" title={job.prompt}>
          {job.prompt}
        </span>
        <span className="generate__job-status">
          {job.state === 'running'
            ? `${job.message}, ${elapsed}`
            : job.state === 'failed'
              ? (job.error ?? 'Failed')
              : job.state === 'cancelled'
                ? 'Cancelled'
                : `Done · ${getService(job.service)?.name ?? job.service}`}
        </span>
        {job.state === 'running' && (
          <div className={`progress${job.progress === null ? ' progress--busy' : ''}`}>
            <span style={{ width: `${Math.round((job.progress ?? 0.35) * 100)}%` }} />
          </div>
        )}
      </div>
      <div className="generate__job-actions">
        {job.state === 'running' && (
          <Button
            size="sm"
            variant="ghost"
            icon={<X size={13} />}
            tip="Cancel"
            onClick={() => void window.kificut.generation.cancel(job.id)}
          />
        )}
        {job.state === 'done' && hasProject && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Plus size={13} />}
            tip="Add at the playhead"
            onClick={() => void addJobAtPlayhead(job)}
          />
        )}
        {job.state === 'done' && job.path && (
          <Button
            size="sm"
            variant="ghost"
            icon={<FolderOpen size={13} />}
            tip="Show in folder"
            onClick={() => void window.kificut.recorder.reveal(job.path!)}
          />
        )}
        {(job.state === 'failed' || job.state === 'cancelled') && canRetry(job) && (
          <Button
            size="sm"
            variant="ghost"
            icon={<RotateCcw size={13} />}
            tip="Try again"
            onClick={() => void retryJob(job)}
          />
        )}
      </div>
    </li>
  )
}
