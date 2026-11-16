import { useEffect, useState } from 'react'
import { Clock, FolderOpen, Plus, X } from 'lucide-react'
import type { RecentProject } from '@shared/types'
import { FRAME_RATES, RESOLUTION_PRESETS } from '../lib/factory'
import { newProject, openProjectDialog, openProjectPath } from '../store/actions'
import { Button, NumberField, Select, cx } from './ui/controls'
import { LogoMark } from './Logo'
import { modKey } from '../lib/platform'

function relativeDate(iso: string): string {
  const then = new Date(iso).getTime()
  const days = Math.floor((Date.now() - then) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days} days ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function PresetShape({ width, height }: { width: number; height: number }) {
  const max = 26
  const ratio = width / height
  const w = ratio >= 1 ? max : max * ratio
  const h = ratio >= 1 ? max / ratio : max
  return (
    <span className="preset__shape">
      <span style={{ width: w, height: h }} />
    </span>
  )
}

export function Welcome() {
  const [recent, setRecent] = useState<RecentProject[]>([])
  const [name, setName] = useState('')
  const [presetId, setPresetId] = useState('1080p')
  const [custom, setCustom] = useState({ width: 1920, height: 1080 })
  const [fps, setFps] = useState(30)

  useEffect(() => {
    void window.kificut.project.recent().then(setRecent)
  }, [])

  const preset = RESOLUTION_PRESETS.find((p) => p.id === presetId)
  const size = presetId === 'custom' ? custom : { width: preset!.width, height: preset!.height }

  const create = () => {
    newProject(name || 'Untitled Project', {
      width: Math.round(size.width / 2) * 2,
      height: Math.round(size.height / 2) * 2,
      fps
    })
  }

  return (
    <div className="welcome">
      <div className="welcome__inner">
        <section className="welcome__new">
          <div className="welcome__hero">
            <LogoMark size={44} />
            <div>
              <h1>Kificut</h1>
              <p>Start a new project or pick up where you left off.</p>
            </div>
          </div>

          <div className="card">
            <label className="field-label" htmlFor="project-name">
              Project name
            </label>
            <input
              id="project-name"
              className="text-input"
              placeholder="Untitled Project"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && create()}
            />

            <div className="field-label">Format</div>
            <div className="presets">
              {RESOLUTION_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={cx('preset', presetId === p.id && 'is-active')}
                  onClick={() => setPresetId(p.id)}
                >
                  <PresetShape width={p.width} height={p.height} />
                  <span className="preset__label">{p.label}</span>
                  <span className="preset__detail">{p.detail}</span>
                </button>
              ))}
              <button
                type="button"
                className={cx('preset', presetId === 'custom' && 'is-active')}
                onClick={() => setPresetId('custom')}
              >
                <PresetShape width={custom.width} height={custom.height} />
                <span className="preset__label">Custom</span>
                <span className="preset__detail">
                  {custom.width} × {custom.height}
                </span>
              </button>
            </div>

            {presetId === 'custom' && (
              <div className="welcome__custom">
                <NumberField
                  label="W"
                  value={custom.width}
                  min={16}
                  max={7680}
                  step={2}
                  onChange={(v) => setCustom((c) => ({ ...c, width: Math.round(v) }))}
                  suffix="px"
                />
                <NumberField
                  label="H"
                  value={custom.height}
                  min={16}
                  max={7680}
                  step={2}
                  onChange={(v) => setCustom((c) => ({ ...c, height: Math.round(v) }))}
                  suffix="px"
                />
              </div>
            )}

            <div className="welcome__row">
              <div>
                <div className="field-label">Frame rate</div>
                <Select
                  value={fps}
                  options={FRAME_RATES.map((r) => ({ value: r, label: `${r} fps` }))}
                  onChange={setFps}
                />
              </div>
              <Button variant="primary" size="lg" icon={<Plus size={16} />} onClick={create}>
                Create Project
              </Button>
            </div>
          </div>
        </section>

        <section className="welcome__recent">
          <div className="welcome__recent-head">
            <h2>Recent projects</h2>
            <Button
              variant="ghost"
              size="sm"
              icon={<FolderOpen size={14} />}
              tip={`Open|${modKey}O`}
              onClick={() => void openProjectDialog()}
            >
              Open…
            </Button>
          </div>
          {recent.length === 0 ? (
            <div className="welcome__empty">
              <Clock size={20} />
              <p>Projects you save or open will show up here.</p>
            </div>
          ) : (
            <ul className="recent-list">
              {recent.map((r) => (
                <li key={r.path}>
                  <button type="button" className="recent-item" onClick={() => void openProjectPath(r.path)}>
                    <span className="recent-item__name">{r.name}</span>
                    <span className="recent-item__path">{r.path}</span>
                    <span className="recent-item__date">{relativeDate(r.openedAt)}</span>
                  </button>
                  <button
                    type="button"
                    className="recent-item__remove"
                    aria-label={`Remove ${r.name} from recent projects`}
                    data-tip="Remove from list"
                    onClick={() => void window.kificut.project.removeRecent(r.path).then(setRecent)}
                  >
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
