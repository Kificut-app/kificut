import { useEffect, useMemo, useState } from 'react'
import { CircleAlert, CircleCheck, FolderOpen } from 'lucide-react'
import {
  EXPORT_FORMATS,
  getExportFormat,
  type ExportFormatId,
  type ExportProgress,
  type ExportQuality,
  type ExportResult
} from '@shared/export-formats'
import { formatDuration, formatTimecode } from '@shared/time'
import { setDialog, useEditor } from '../../store/editor'
import { toast } from '../../store/ui'
import { projectDuration } from '../../lib/timeline'
import { FRAME_RATES } from '../../lib/factory'
import { runExport } from '../../engine/export'
import { player } from '../../engine/player'
import { Button, Segmented, Select, cx } from '../ui/controls'
import { Modal } from '../ui/overlays'

const SHORT_SIDES = [2160, 1440, 1080, 720, 480, 360]

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2)
}

export function ExportDialog() {
  const project = useEditor((s) => s.project!)
  const { width, height, fps: projectFps } = project.settings
  const duration = projectDuration(project)
  const hasRange = project.inPoint !== null || project.outPoint !== null

  const [format, setFormat] = useState<ExportFormatId>('mp4-h264')
  const [shortSide, setShortSide] = useState<number>(0)
  const [fps, setFps] = useState(projectFps)
  const [quality, setQuality] = useState<ExportQuality>('high')
  const [audioBitrate, setAudioBitrate] = useState(192)
  const [range, setRange] = useState<'all' | 'inout'>(hasRange ? 'inout' : 'all')
  const [phase, setPhase] = useState<'setup' | 'running' | 'done' | 'error'>('setup')
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [result, setResult] = useState<ExportResult | null>(null)

  const fmt = getExportFormat(format)
  const projectShort = Math.min(width, height)
  const sizeOptions = useMemo(
    () => [
      { value: 0, label: `Project (${width} × ${height})` },
      ...SHORT_SIDES.filter((s) => s < projectShort).map((s) => {
        const scale = s / projectShort
        return { value: s, label: `${even(width * scale)} × ${even(height * scale)}` }
      })
    ],
    [width, height, projectShort]
  )

  useEffect(() => {
    if (format === 'gif') {
      setFps((f) => Math.min(f, 15))
      setShortSide((s) => (s === 0 || s > 480 ? (projectShort > 480 ? 480 : 0) : s))
    }
  }, [format, projectShort])

  const scale = shortSide ? shortSide / projectShort : 1
  const outWidth = even(width * scale)
  const outHeight = even(height * scale)
  const rangeStart = range === 'inout' ? (project.inPoint ?? 0) : 0
  const rangeEnd = range === 'inout' ? (project.outPoint ?? duration) : duration
  const length = Math.max(0, rangeEnd - rangeStart)
  const running = phase === 'running'

  const start = async () => {
    const output = await window.kificut.exporter.chooseOutput(project.name, fmt.extension, fmt.label)
    if (!output) return
    player.pause()
    setPhase('running')
    setProgress(null)
    const unsubscribe = window.kificut.exporter.onProgress(setProgress)
    try {
      const res = await runExport({
        format,
        width: outWidth,
        height: outHeight,
        fps,
        quality,
        audioBitrate,
        start: rangeStart,
        end: rangeEnd,
        outputPath: output
      })
      setResult(res)
      if (res.ok) {
        setPhase('done')
        toast({
          kind: 'success',
          title: 'Export finished',
          message: res.outputPath,
          action: {
            label: 'Show in Folder',
            run: () => window.kificut.shell.showItemInFolder(res.outputPath!)
          }
        })
      } else if (res.cancelled) {
        setPhase('setup')
      } else {
        setPhase('error')
      }
    } catch (error) {
      setResult({ ok: false, error: error instanceof Error ? error.message : String(error) })
      setPhase('error')
    } finally {
      unsubscribe()
    }
  }

  const close = () => {
    if (!running) setDialog(null)
  }

  const percent = Math.round((progress?.progress ?? 0) * 100)

  return (
    <Modal title="Export" onClose={close} width={560}>
      {phase === 'setup' && (
        <div className="export">
          <div className="export__formats">
            {EXPORT_FORMATS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={cx('format-option', format === f.id && 'is-active')}
                onClick={() => setFormat(f.id)}
              >
                <span className="format-option__label">{f.label}</span>
                <span className="format-option__detail">{f.detail}</span>
              </button>
            ))}
          </div>

          <div className="export__settings">
            {fmt.video && (
              <>
                <label className="export__field">
                  <span>Resolution</span>
                  <Select value={shortSide} options={sizeOptions} onChange={setShortSide} />
                </label>
                <label className="export__field">
                  <span>Frame rate</span>
                  <Select
                    value={fps}
                    options={[
                      ...new Set([projectFps, ...FRAME_RATES, ...(format === 'gif' ? [10, 12, 15] : [])])
                    ]
                      .sort((a, b) => a - b)
                      .map((r) => ({
                        value: r,
                        label: r === projectFps ? `${r} fps (project)` : `${r} fps`
                      }))}
                    onChange={setFps}
                  />
                </label>
                {format !== 'gif' && (
                  <div className="export__field">
                    <span>Quality</span>
                    <Segmented
                      value={quality}
                      onChange={setQuality}
                      options={[
                        { value: 'high', label: 'High' },
                        { value: 'standard', label: 'Standard' },
                        { value: 'small', label: 'Smaller file' }
                      ]}
                    />
                  </div>
                )}
              </>
            )}
            {fmt.audio && format !== 'wav' && format !== 'mov-prores' && (
              <label className="export__field">
                <span>Audio bitrate</span>
                <Select
                  value={audioBitrate}
                  options={[128, 160, 192, 256, 320].map((b) => ({ value: b, label: `${b} kbps` }))}
                  onChange={setAudioBitrate}
                />
              </label>
            )}
            <div className="export__field">
              <span>Range</span>
              <Segmented
                value={range}
                onChange={setRange}
                options={[
                  { value: 'all', label: 'Entire timeline' },
                  ...(hasRange ? [{ value: 'inout' as const, label: 'In to Out' }] : [])
                ]}
              />
            </div>
          </div>

          <div className="export__summary">
            {fmt.video ? `${outWidth} × ${outHeight}, ${fps} fps, ` : ''}
            {formatTimecode(length, projectFps)} ({formatDuration(length)})
          </div>
        </div>
      )}

      {phase === 'running' && (
        <div className="export-progress">
          <div className="export-progress__head">
            <span>Exporting {fmt.label}</span>
            <span className="export-progress__percent">{percent}%</span>
          </div>
          <div className="progress">
            <span style={{ width: `${percent}%` }} />
          </div>
          <div className="export-progress__meta">
            <span>
              {formatTimecode(progress?.time ?? 0, projectFps)} of {formatTimecode(length, projectFps)}
            </span>
            <span>
              {progress?.speed ? `${progress.speed.toFixed(1)}x realtime` : 'Starting'}
              {progress?.etaSeconds != null && progress.etaSeconds > 0
                ? `, about ${formatDuration(progress.etaSeconds)} left`
                : ''}
            </span>
          </div>
        </div>
      )}

      {phase === 'done' && result?.ok && (
        <div className="export-result">
          <CircleCheck size={28} className="export-result__icon is-success" />
          <div>
            <h3>Your video is ready</h3>
            <p className="export-result__path">{result.outputPath}</p>
            {result.elapsed !== undefined && (
              <p className="hint">Finished in {formatDuration(result.elapsed)}.</p>
            )}
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div className="export-result">
          <CircleAlert size={28} className="export-result__icon is-error" />
          <div>
            <h3>Export failed</h3>
            <pre className="export-result__error">{result?.error ?? 'Unknown error'}</pre>
          </div>
        </div>
      )}

      <div className="modal__actions">
        {phase === 'setup' && (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" disabled={length <= 0} onClick={() => void start()}>
              Export…
            </Button>
          </>
        )}
        {phase === 'running' && (
          <Button onClick={() => void window.kificut.exporter.cancel()}>Stop Export</Button>
        )}
        {phase === 'done' && (
          <>
            <Button
              icon={<FolderOpen size={14} />}
              onClick={() => result?.outputPath && window.kificut.shell.showItemInFolder(result.outputPath)}
            >
              Show in Folder
            </Button>
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          </>
        )}
        {phase === 'error' && (
          <>
            <Button onClick={close}>Close</Button>
            <Button variant="primary" onClick={() => setPhase('setup')}>
              Back to Settings
            </Button>
          </>
        )}
      </div>
    </Modal>
  )
}
