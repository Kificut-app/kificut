import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AppWindow,
  Circle,
  FolderOpen,
  Monitor,
  PictureInPicture2,
  RefreshCw,
  SquareDashed,
  Video,
  X
} from 'lucide-react'
import {
  CAMERA_SIZES,
  DEFAULT_RECORDING_OPTIONS,
  estimateBytesPerSecond,
  fitOutputSize,
  planFiles,
  RECORDING_SHORTCUTS,
  RESOLUTION_LABELS,
  RESOLUTIONS,
  shortcutLabel,
  SYSTEM_PICKER_SOURCE,
  type AreaRect,
  type CameraResolution,
  type CaptureSource,
  type FrameRate,
  type PipCorner,
  type PipSize,
  type RecorderSupport,
  type RecordingMode,
  type RecordingOptions,
  type RecordingQuality,
  type Resolution
} from '@shared/recording'
import { setDialog } from '../../store/editor'
import { errorText } from '../../store/actions'
import { Button, Segmented, Select, Switch } from '../ui/controls'
import { Modal } from '../ui/overlays'

/* Sets up a recording of the screen, a camera, or both, and starts it. */

const SETTINGS_KEY = 'kificut.recording'
const mac = window.kificut.platform === 'darwin'

interface Saved {
  mode: RecordingMode
  sourceName: string | null
  cameraId: string | null
  micId: string | null
  noiseSuppression: boolean
  systemAudio: boolean
  resolution: Resolution
  fps: FrameRate
  quality: RecordingQuality
  cameraResolution: CameraResolution
  countdown: number
  hideKificut: boolean
  showControls: boolean | null
  cameraPreview: boolean
  corner: PipCorner
  size: PipSize
}

function loadSaved(): Saved {
  const defaults: Saved = {
    mode: DEFAULT_RECORDING_OPTIONS.mode,
    sourceName: null,
    cameraId: null,
    micId: null,
    noiseSuppression: true,
    systemAudio: false,
    resolution: DEFAULT_RECORDING_OPTIONS.resolution,
    fps: DEFAULT_RECORDING_OPTIONS.fps,
    quality: DEFAULT_RECORDING_OPTIONS.quality,
    cameraResolution: '720',
    countdown: DEFAULT_RECORDING_OPTIONS.countdown,
    hideKificut: DEFAULT_RECORDING_OPTIONS.hideKificut,
    showControls: null,
    cameraPreview: DEFAULT_RECORDING_OPTIONS.cameraPreview,
    corner: DEFAULT_RECORDING_OPTIONS.pip.corner,
    size: DEFAULT_RECORDING_OPTIONS.pip.size
  }
  try {
    return { ...defaults, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<Saved>) }
  } catch {
    return defaults
  }
}

function save(settings: Saved): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // Remembering the settings is a convenience only.
  }
}

function formatGigabytes(bytes: number): string {
  return bytes >= 1e12 ? `${(bytes / 1e12).toFixed(1)} TB` : `${Math.round(bytes / 1e9)} GB`
}

function formatHours(seconds: number): string {
  if (seconds >= 2 * 3600) return `about ${Math.floor(seconds / 3600)} hours`
  if (seconds >= 3600) return 'about an hour'
  return `about ${Math.max(1, Math.floor(seconds / 60))} minutes`
}

/** A live stream for the previews in this dialog, released when the choice changes or the dialog closes. */
function useStream(constraints: MediaStreamConstraints | null, onDevices: () => void) {
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [error, setError] = useState('')
  const key = JSON.stringify(constraints)
  useEffect(() => {
    if (!constraints) {
      setStream(null)
      return
    }
    let current: MediaStream | null = null
    let stopped = false
    setError('')
    navigator.mediaDevices
      .getUserMedia(constraints)
      .then((s) => {
        if (stopped) s.getTracks().forEach((t) => t.stop())
        else {
          current = s
          setStream(s)
          // Device names are only available once access is granted.
          onDevices()
        }
      })
      .catch((e: unknown) => {
        if (!stopped)
          setError(
            e instanceof DOMException && e.name === 'NotAllowedError'
              ? 'Access was denied.'
              : 'Not available.'
          )
      })
    return () => {
      stopped = true
      current?.getTracks().forEach((t) => t.stop())
      setStream(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return { stream, error }
}

function useLevel(stream: MediaStream | null): number {
  const [level, setLevel] = useState(0)
  useEffect(() => {
    const track = stream?.getAudioTracks()[0]
    if (!stream || !track) {
      setLevel(0)
      return
    }
    const context = new AudioContext()
    const analyser = context.createAnalyser()
    analyser.fftSize = 1024
    context.createMediaStreamSource(stream).connect(analyser)
    const data = new Float32Array(analyser.fftSize)
    let frame = 0
    let peak = 0
    const tick = () => {
      analyser.getFloatTimeDomainData(data)
      let max = 0
      for (const v of data) max = Math.max(max, Math.abs(v))
      peak = Math.max(max, peak * 0.9)
      setLevel(peak)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      void context.close()
    }
  }, [stream])
  return level
}

function LevelBar({ level }: { level: number }) {
  const db = level > 0 ? 20 * Math.log10(level) : -100
  const percent = Math.max(0, Math.min(100, ((db + 60) / 60) * 100))
  return (
    <div className="record__level" aria-label="Microphone level">
      <span style={{ width: `${percent}%` }} className={db > -6 ? 'is-hot' : ''} />
    </div>
  )
}

function SourceCard({
  source,
  selected,
  onSelect
}: {
  source: CaptureSource
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      className={`record__source${selected ? ' is-selected' : ''}`}
      onClick={onSelect}
      title={source.name}
    >
      <span className="record__thumb">
        <img src={source.thumbnail} alt="" draggable={false} />
      </span>
      <span className="record__source-name">
        {source.icon ? (
          <img src={source.icon} alt="" className="record__source-icon" />
        ) : source.kind === 'screen' ? (
          <Monitor size={12} />
        ) : (
          <AppWindow size={12} />
        )}
        <span>{source.name}</span>
      </span>
    </button>
  )
}

function CornerPicker({ value, onChange }: { value: PipCorner; onChange: (corner: PipCorner) => void }) {
  const corners: PipCorner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']
  return (
    <div className="record__corners" role="radiogroup" aria-label="Camera position">
      {corners.map((corner) => (
        <button
          key={corner}
          type="button"
          role="radio"
          aria-checked={value === corner}
          aria-label={corner.replace('-', ' ')}
          className={`record__corner record__corner--${corner}${value === corner ? ' is-selected' : ''}`}
          onClick={() => onChange(corner)}
        >
          <span />
        </button>
      ))}
    </div>
  )
}

export function RecordDialog() {
  const [settings, setSettings] = useState<Saved>(loadSaved)
  const [support, setSupport] = useState<RecorderSupport | null>(null)
  const [sources, setSources] = useState<CaptureSource[] | null>(null)
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [area, setArea] = useState<AreaRect | null>(null)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(false)
  const preview = useRef<HTMLVideoElement>(null)

  const update = (patch: Partial<Saved>) => setSettings((s) => ({ ...s, ...patch }))
  const hasScreen = settings.mode !== 'camera'
  const hasCamera = settings.mode !== 'screen'

  const refreshDevices = useCallback(() => {
    void navigator.mediaDevices.enumerateDevices().then(setDevices)
  }, [])

  const refreshSources = useCallback(() => {
    void window.kificut.recorder
      .sources()
      .then((list) => {
        setSources(list)
        setSourceId((current) => {
          if (current && list.some((s) => s.id === current)) return current
          const remembered = settings.sourceName ? list.find((s) => s.name === settings.sourceName) : null
          return (
            (remembered ?? list.find((s) => s.kind === 'screen' && s.display?.primary) ?? list[0])?.id ?? null
          )
        })
      })
      .catch((e: unknown) => setError(errorText(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    void window.kificut.recorder.support().then((s) => {
      setSupport(s)
      // On Wayland the system's own picker chooses the source when recording starts.
      if (!s.systemPicker) refreshSources()
    })
    refreshDevices()
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices)
    return () => navigator.mediaDevices.removeEventListener('devicechange', refreshDevices)
  }, [refreshDevices, refreshSources])

  const cameras = devices.filter((d) => d.kind === 'videoinput' && d.deviceId)
  const mics = devices.filter((d) => d.kind === 'audioinput' && d.deviceId)
  const cameraId = cameras.some((c) => c.deviceId === settings.cameraId)
    ? settings.cameraId
    : (cameras[0]?.deviceId ?? null)
  // An unknown saved microphone falls back to the default one; '' means no microphone.
  const micId =
    settings.micId === ''
      ? ''
      : mics.some((m) => m.deviceId === settings.micId)
        ? settings.micId
        : (mics[0]?.deviceId ?? '')

  const cameraStream = useStream(
    hasCamera ? { video: cameraId ? { deviceId: { exact: cameraId }, width: { ideal: 640 } } : true } : null,
    refreshDevices
  )
  const micStream = useStream(
    micId !== null && micId !== ''
      ? { audio: { deviceId: { exact: micId } } }
      : mics.length === 0
        ? { audio: true }
        : null,
    refreshDevices
  )
  const level = useLevel(micId ? micStream.stream : null)

  useEffect(() => {
    if (preview.current) preview.current.srcObject = cameraStream.stream
  }, [cameraStream.stream])

  const systemPicker = support?.systemPicker ?? false
  const source = sources?.find((s) => s.id === sourceId) ?? null
  const controlsHidden = support?.controlsHiddenFromCapture ?? false
  // Floating controls show up in recordings of a whole screen where they cannot be hidden from
  // capture. With the system's picker, a whole screen may be chosen, so assume it.
  const wholeScreen = systemPicker || source?.kind === 'screen'
  const controlsCaptured = hasScreen && wholeScreen && !controlsHidden
  const showControls = settings.showControls ?? !controlsCaptured
  const previewCaptured = hasScreen && hasCamera && wholeScreen && !controlsHidden
  const cameraPreview = settings.cameraPreview && !previewCaptured

  const plans = planFiles({
    mode: settings.mode,
    microphone: micId ? { deviceId: micId, label: '', noiseSuppression: true } : null,
    systemAudio: settings.systemAudio && !!support?.systemAudio
  })
  const screenSize = source?.display
    ? fitOutputSize(
        area ? source.display.width * area.width : source.display.width,
        area ? source.display.height * area.height : source.display.height,
        settings.resolution
      )
    : fitOutputSize(1920, 1080, settings.resolution)
  const bytesPerSecond = estimateBytesPerSecond(
    plans,
    { screen: screenSize, camera: CAMERA_SIZES[settings.cameraResolution] },
    settings.fps,
    settings.quality
  )

  const problems = useMemo(() => {
    const list: string[] = []
    if (hasScreen && !source && !systemPicker) list.push('Choose a screen or window to record.')
    if (hasCamera && !cameraId) list.push('Connect a camera to record it.')
    if (hasScreen && support?.screenAccess === 'denied') {
      list.push(
        'Kificut is not allowed to record the screen. Turn it on in System Settings > Privacy & Security > Screen & System Audio Recording, then open Kificut again.'
      )
    }
    return list
  }, [hasScreen, hasCamera, source, cameraId, support, systemPicker])

  const pickArea = async () => {
    if (!source?.display) return
    const picked = await window.kificut.recorder.pickArea(source.display.id)
    if (picked) setArea(picked)
  }

  const start = async () => {
    if (problems.length) return
    setStarting(true)
    setError('')
    const camera = cameras.find((c) => c.deviceId === cameraId)
    const mic = mics.find((m) => m.deviceId === micId)
    const options: RecordingOptions = {
      mode: settings.mode,
      screen: !hasScreen
        ? null
        : systemPicker
          ? {
              sourceId: SYSTEM_PICKER_SOURCE,
              name: 'Chosen in the system dialog',
              kind: 'screen',
              displayId: null,
              area: null
            }
          : source
            ? {
                sourceId: source.id,
                name: source.name,
                kind: source.kind,
                displayId: source.display?.id ?? null,
                area: source.kind === 'screen' ? area : null
              }
            : null,
      camera:
        hasCamera && camera
          ? { deviceId: camera.deviceId, label: camera.label, resolution: settings.cameraResolution }
          : null,
      microphone: mic
        ? { deviceId: mic.deviceId, label: mic.label, noiseSuppression: settings.noiseSuppression }
        : null,
      systemAudio: hasScreen && settings.systemAudio && !!support?.systemAudio,
      resolution: settings.resolution,
      fps: settings.fps,
      quality: settings.quality,
      countdown: settings.countdown,
      hideKificut: settings.hideKificut,
      showControls,
      cameraPreview: hasCamera && cameraPreview,
      pip: { corner: settings.corner, size: settings.size }
    }
    save({ ...settings, sourceName: source?.name ?? settings.sourceName, cameraId, micId })
    // Free the camera and microphone for the recorder.
    cameraStream.stream?.getTracks().forEach((t) => t.stop())
    micStream.stream?.getTracks().forEach((t) => t.stop())
    try {
      await window.kificut.recorder.start(options)
      setDialog(null)
    } catch (e) {
      setError(errorText(e))
      setStarting(false)
    }
  }

  const screens = sources?.filter((s) => s.kind === 'screen') ?? []
  const windows = sources?.filter((s) => s.kind === 'window') ?? []
  const free = support?.freeBytes ?? null

  return (
    <Modal title="New Recording" onClose={() => setDialog(null)} width={880} className="record">
      <div className="record__modes">
        <Segmented<RecordingMode>
          value={settings.mode}
          onChange={(mode) => update({ mode })}
          options={[
            { value: 'screen', label: 'Screen', icon: <Monitor size={14} /> },
            { value: 'camera', label: 'Camera', icon: <Video size={14} /> },
            { value: 'screen-camera', label: 'Screen and Camera', icon: <PictureInPicture2 size={14} /> }
          ]}
        />
      </div>

      <div className="record__grid">
        <section className="record__what">
          {hasScreen && systemPicker && (
            <>
              <div className="record__heading">
                <h4>What to record</h4>
              </div>
              <div className="record__picker">
                <Monitor size={22} />
                <p>
                  <strong>Your system asks which screen or window to record</strong> when you click Start
                  Recording. Recording only part of a screen is not available on Wayland.
                </p>
              </div>
            </>
          )}
          {hasScreen && !systemPicker && (
            <>
              <div className="record__heading">
                <h4>What to record</h4>
                <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={refreshSources}>
                  Refresh
                </Button>
              </div>
              {sources === null ? (
                <p className="record__muted">Looking for screens and windows…</p>
              ) : (
                <div className="record__sources">
                  {screens.map((s) => (
                    <SourceCard
                      key={s.id}
                      source={s}
                      selected={s.id === sourceId}
                      onSelect={() => {
                        setSourceId(s.id)
                        setArea(null)
                      }}
                    />
                  ))}
                  {windows.length > 0 && <p className="record__subheading">Windows</p>}
                  {windows.map((s) => (
                    <SourceCard
                      key={s.id}
                      source={s}
                      selected={s.id === sourceId}
                      onSelect={() => {
                        setSourceId(s.id)
                        setArea(null)
                      }}
                    />
                  ))}
                </div>
              )}
              {source?.kind === 'screen' && source.display && (
                <div className="record__area">
                  <SquareDashed size={14} />
                  <span>
                    {area
                      ? `Area of ${Math.round(source.display.width * area.width)} × ${Math.round(source.display.height * area.height)}`
                      : `Whole screen, ${source.display.width} × ${source.display.height}`}
                  </span>
                  <Button size="sm" onClick={() => void pickArea()}>
                    {area ? 'Change Area' : 'Select Area…'}
                  </Button>
                  {area && (
                    <Button size="sm" variant="ghost" icon={<X size={13} />} onClick={() => setArea(null)}>
                      Whole Screen
                    </Button>
                  )}
                </div>
              )}
            </>
          )}

          {hasCamera && (
            <>
              <div className="record__heading">
                <h4>Camera</h4>
              </div>
              <div className={`record__camera${hasScreen ? ' is-small' : ''}`}>
                {cameraStream.error ? (
                  <span className="record__muted">{cameraStream.error}</span>
                ) : (
                  <video ref={preview} autoPlay muted playsInline />
                )}
              </div>
              <Select<string>
                value={cameraId ?? ''}
                onChange={(id) => update({ cameraId: id })}
                options={
                  cameras.length
                    ? cameras.map((c, i) => ({ value: c.deviceId, label: c.label || `Camera ${i + 1}` }))
                    : [{ value: '', label: 'No camera found' }]
                }
              />
            </>
          )}
        </section>

        <section className="record__settings">
          <h4>Sound</h4>
          <div className="record__row">
            <span>Microphone</span>
            <Select<string>
              value={micId ?? ''}
              onChange={(id) => update({ micId: id })}
              options={[
                ...mics.map((m, i) => ({ value: m.deviceId, label: m.label || `Microphone ${i + 1}` })),
                { value: '', label: 'No microphone' }
              ]}
            />
          </div>
          {micId ? <LevelBar level={level} /> : null}
          {micId ? (
            <div className="record__row">
              <span>Reduce background noise</span>
              <Switch checked={settings.noiseSuppression} onChange={(v) => update({ noiseSuppression: v })} />
            </div>
          ) : null}
          {hasScreen && (
            <div className="record__row">
              <span>
                Computer sound
                {!support?.systemAudio && <small>Windows only for now</small>}
              </span>
              <Switch
                checked={settings.systemAudio && !!support?.systemAudio}
                disabled={!support?.systemAudio}
                onChange={(v) => update({ systemAudio: v })}
              />
            </div>
          )}

          <h4>Quality</h4>
          {hasScreen && (
            <div className="record__row">
              <span>Screen resolution</span>
              <Select<Resolution>
                value={settings.resolution}
                onChange={(resolution) => update({ resolution })}
                options={RESOLUTIONS.map((r) => ({
                  value: r,
                  label: RESOLUTION_LABELS[r]
                }))}
              />
            </div>
          )}
          {hasCamera && (
            <div className="record__row">
              <span>Camera resolution</span>
              <Select<CameraResolution>
                value={settings.cameraResolution}
                onChange={(cameraResolution) => update({ cameraResolution })}
                options={[
                  { value: '720', label: '720p' },
                  { value: '1080', label: '1080p' }
                ]}
              />
            </div>
          )}
          <div className="record__row">
            <span>Frame rate</span>
            <Select<string>
              value={String(settings.fps)}
              onChange={(v) => update({ fps: Number(v) as FrameRate })}
              options={[
                { value: '30', label: '30 fps' },
                { value: '60', label: '60 fps, smoother motion' }
              ]}
            />
          </div>
          <div className="record__row">
            <span>Quality</span>
            <Select<RecordingQuality>
              value={settings.quality}
              onChange={(quality) => update({ quality })}
              options={[
                { value: 'standard', label: 'Standard' },
                { value: 'high', label: 'High, larger files' }
              ]}
            />
          </div>

          {settings.mode === 'screen-camera' && (
            <>
              <h4>Camera on the screen</h4>
              <div className="record__row">
                <span>
                  Position
                  <small>You can move it later in the editor.</small>
                </span>
                <CornerPicker value={settings.corner} onChange={(corner) => update({ corner })} />
              </div>
              <div className="record__row">
                <span>Size</span>
                <Select<PipSize>
                  value={settings.size}
                  onChange={(size) => update({ size })}
                  options={[
                    { value: 'small', label: 'Small' },
                    { value: 'medium', label: 'Medium' },
                    { value: 'large', label: 'Large' }
                  ]}
                />
              </div>
            </>
          )}

          <h4>While recording</h4>
          <div className="record__row">
            <span>Countdown</span>
            <Select<string>
              value={String(settings.countdown)}
              onChange={(v) => update({ countdown: Number(v) })}
              options={[
                { value: '0', label: 'None' },
                { value: '3', label: '3 seconds' },
                { value: '5', label: '5 seconds' },
                { value: '10', label: '10 seconds' }
              ]}
            />
          </div>
          <div className="record__row">
            <span>
              Show recording controls
              {controlsCaptured && (
                <small>
                  {systemPicker
                    ? 'They show up in the recording if you pick a whole screen.'
                    : 'They would appear in this screen recording.'}
                </small>
              )}
            </span>
            <Switch checked={showControls} onChange={(v) => update({ showControls: v })} />
          </div>
          {hasCamera && (
            <div className="record__row">
              <span>
                Show camera preview
                {previewCaptured && (
                  <small>
                    {systemPicker
                      ? 'Off: it would show up if you pick a whole screen.'
                      : 'Off: it would appear in this screen recording.'}
                  </small>
                )}
              </span>
              <Switch
                checked={cameraPreview}
                disabled={previewCaptured}
                onChange={(v) => update({ cameraPreview: v })}
              />
            </div>
          )}
          {hasScreen && (
            <div className="record__row">
              <span>Minimize Kificut</span>
              <Switch checked={settings.hideKificut} onChange={(v) => update({ hideKificut: v })} />
            </div>
          )}
        </section>
      </div>

      {(problems.length > 0 || error) && (
        <div className="record__problems">
          {[...problems, ...(error ? [error] : [])].map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
      )}

      <div className="record__footer">
        <div className="record__info">
          <span>
            Stop with <kbd>{shortcutLabel(RECORDING_SHORTCUTS.stop, mac)}</kbd>, pause with{' '}
            <kbd>{shortcutLabel(RECORDING_SHORTCUTS.pause, mac)}</kbd>, or from the tray icon.
          </span>
          {free !== null && (
            <span>
              {formatGigabytes(free)} free, {formatHours(free / bytesPerSecond)} at these settings.
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          icon={<FolderOpen size={14} />}
          onClick={() => void window.kificut.recorder.reveal()}
          tip="Open the recordings folder"
        >
          Recordings
        </Button>
        <Button variant="ghost" onClick={() => setDialog(null)}>
          Cancel
        </Button>
        <Button
          variant="primary"
          className="record__start"
          icon={<Circle size={12} fill="currentColor" />}
          disabled={problems.length > 0 || starting}
          onClick={() => void start()}
        >
          {starting ? 'Starting' : 'Start Recording'}
        </Button>
      </div>
    </Modal>
  )
}
