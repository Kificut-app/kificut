import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ChevronDown,
  FlipHorizontal2,
  FlipVertical2,
  Italic,
  Link2,
  RotateCcw,
  Trash2,
  Unlink2
} from 'lucide-react'
import type { Draft } from 'immer'
import type { Clip, ColorAdjust, MediaItem, Project, TextStyle, Transform } from '@shared/types'
import { dbToGain, formatDuration, formatTimecode, gainToDb, parseTimecode, snapToFrame } from '@shared/time'
import { commit, useEditor } from '../../store/editor'
import {
  clearInOut,
  deleteSelection,
  linkSelection,
  renameProject,
  setClipSpeed,
  unlinkSelection,
  updateClips,
  updateProjectSettings
} from '../../store/actions'
import { defaultColor, defaultTransform, FRAME_RATES, RESOLUTION_PRESETS } from '../../lib/factory'
import { maxDuration, mediaFor, projectDuration, resolveOverlaps, withLinked } from '../../lib/timeline'
import { useFonts } from '../../lib/fonts'
import {
  Button,
  ColorField,
  IconButton,
  NumberField,
  Segmented,
  Select,
  Slider,
  Switch,
  cx
} from '../ui/controls'

export function Inspector() {
  const project = useEditor((s) => s.project!)
  const selection = useEditor((s) => s.selection)

  const content = useMemo(() => {
    const clips = project.clips.filter((c) => selection.includes(c.id))
    if (clips.length === 0) return <ProjectInspector project={project} />

    const linkIds = new Set(clips.map((c) => c.linkId ?? c.id))
    if (linkIds.size === 1) {
      const visual = clips.find((c) => c.kind !== 'audio')
      const audio = clips.find((c) => c.kind === 'audio')
      const primary = visual ?? audio!
      return (
        <ClipInspector key={primary.id} project={project} clip={primary} audio={visual ? audio : undefined} />
      )
    }
    return <MultiInspector count={clips.length} />
  }, [project, selection])

  return (
    <section className="panel inspector">
      <div className="panel__header">
        <span className="panel__title">Inspector</span>
      </div>
      <div className="panel__body inspector__body">{content}</div>
    </section>
  )
}

function Section({
  title,
  children,
  onReset,
  defaultOpen = true
}: {
  title: string
  children: ReactNode
  onReset?: () => void
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={cx('section', open && 'is-open')}>
      <div className="section__header">
        <button type="button" className="section__toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          <ChevronDown size={13} className="section__chevron" />
          {title}
        </button>
        {onReset && (
          <IconButton size="sm" tip="Reset" onClick={onReset}>
            <RotateCcw size={12} />
          </IconButton>
        )}
      </div>
      {open && <div className="section__body">{children}</div>}
    </div>
  )
}

function Row({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cx('row', wide && 'row--wide')}>
      <span className="row__label">{label}</span>
      <div className="row__control">{children}</div>
    </div>
  )
}

function SliderRow(props: {
  label: string
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  step?: number
  display?: number
  precision?: number
  suffix?: string
  reset: number
}) {
  const { label, value, onChange, min, max, step = 0.01, display = 1, precision = 0, suffix, reset } = props
  return (
    <Row label={label}>
      <Slider value={value} min={min} max={max} step={step} reset={reset} onChange={onChange} />
      <NumberField
        className="num-field--compact"
        value={value}
        onChange={onChange}
        min={min}
        max={max}
        step={step * display >= 1 ? 1 : step * display}
        display={display}
        precision={precision}
        suffix={suffix}
      />
    </Row>
  )
}

function TimecodeField({
  value,
  fps,
  onChange,
  min = 0
}: {
  value: number
  fps: number
  onChange: (v: number) => void
  min?: number
}) {
  const [text, setText] = useState(formatTimecode(value, fps))
  useEffect(() => setText(formatTimecode(value, fps)), [value, fps])
  const apply = () => {
    const parsed = parseTimecode(text, fps)
    if (parsed !== null && parsed >= min) onChange(snapToFrame(parsed, fps))
    else setText(formatTimecode(value, fps))
  }
  return (
    <input
      className="text-input text-input--mono"
      value={text}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onBlur={apply}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setText(formatTimecode(value, fps))
      }}
    />
  )
}

const KIND_LABEL: Record<Clip['kind'], string> = {
  video: 'Video',
  audio: 'Audio',
  image: 'Image',
  text: 'Text',
  solid: 'Color'
}

function ClipInspector({ project, clip, audio }: { project: Project; clip: Clip; audio?: Clip }) {
  const media = mediaFor(project, clip)
  const fps = project.settings.fps
  const linked = withLinked(project, [clip.id])
  const update = (recipe: (c: Draft<Clip>) => void, field: string, ids: string[] = [clip.id]) =>
    updateClips(ids, recipe, `${field}:${ids.join(',')}`)

  const setTransform = (patch: Partial<Transform>, field: string) =>
    update((c) => {
      Object.assign(c.transform, patch)
    }, `transform.${field}`)
  const setColor = (patch: Partial<ColorAdjust>, field: string) =>
    update((c) => {
      Object.assign(c.color, patch)
    }, `color.${field}`)
  const setText = (patch: Partial<TextStyle>, field: string) =>
    update((c) => {
      if (c.text) Object.assign(c.text, patch)
    }, `text.${field}`)

  const visual = clip.kind !== 'audio'
  const audioClip = clip.kind === 'audio' ? clip : audio
  const t = clip.transform

  return (
    <div className="clip-inspector">
      <div className="clip-inspector__head">
        <span className={`kind-dot kind-dot--${clip.kind}`} />
        <input
          className="clip-inspector__name"
          value={clip.name}
          placeholder={KIND_LABEL[clip.kind]}
          onChange={(e) => update((c) => void (c.name = e.target.value), 'name')}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
        />
        <span className="clip-inspector__kind">{KIND_LABEL[clip.kind]}</span>
      </div>
      {media && (
        <div className="clip-inspector__source" title={media.path}>
          {media.name}
        </div>
      )}

      {clip.kind === 'text' && clip.text && <TextSection style={clip.text} onChange={setText} />}

      {clip.kind === 'solid' && (
        <Section title="Fill">
          <Row label="Color">
            <ColorField
              value={clip.solidColor ?? '#000000'}
              onChange={(v) => update((c) => void (c.solidColor = v), 'solid')}
            />
          </Row>
        </Section>
      )}

      {visual && (
        <Section
          title="Transform"
          onReset={() =>
            update(
              (c) =>
                void (c.transform = {
                  ...defaultTransform(),
                  cropLeft: c.transform.cropLeft,
                  cropRight: c.transform.cropRight,
                  cropTop: c.transform.cropTop,
                  cropBottom: c.transform.cropBottom
                }),
              'transform.reset'
            )
          }
        >
          <Row label="Position">
            <div className="pair">
              <NumberField label="X" value={t.x} step={1} onChange={(x) => setTransform({ x }, 'x')} />
              <NumberField label="Y" value={t.y} step={1} onChange={(y) => setTransform({ y }, 'y')} />
            </div>
          </Row>
          <SliderRow
            label="Scale"
            value={t.scale}
            min={0}
            max={4}
            step={0.01}
            display={100}
            suffix="%"
            reset={1}
            onChange={(scale) => setTransform({ scale }, 'scale')}
          />
          <SliderRow
            label="Rotation"
            value={t.rotation}
            min={-180}
            max={180}
            step={1}
            suffix="°"
            reset={0}
            onChange={(rotation) => setTransform({ rotation }, 'rotation')}
          />
          <SliderRow
            label="Opacity"
            value={t.opacity}
            min={0}
            max={1}
            step={0.01}
            display={100}
            suffix="%"
            reset={1}
            onChange={(opacity) => setTransform({ opacity }, 'opacity')}
          />
          <Row label="Flip">
            <div className="toggle-group">
              <IconButton
                tip="Flip horizontally"
                active={t.flipH}
                onClick={() => setTransform({ flipH: !t.flipH }, 'flipH')}
              >
                <FlipHorizontal2 size={15} />
              </IconButton>
              <IconButton
                tip="Flip vertically"
                active={t.flipV}
                onClick={() => setTransform({ flipV: !t.flipV }, 'flipV')}
              >
                <FlipVertical2 size={15} />
              </IconButton>
            </div>
          </Row>
        </Section>
      )}

      {(clip.kind === 'video' || clip.kind === 'image') && (
        <Section
          title="Crop"
          defaultOpen={t.cropLeft + t.cropRight + t.cropTop + t.cropBottom > 0}
          onReset={() => setTransform({ cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 }, 'crop')}
        >
          <Row label="Left / Right">
            <div className="pair">
              <NumberField
                value={t.cropLeft}
                min={0}
                max={0.95}
                step={1}
                display={100}
                suffix="%"
                onChange={(cropLeft) => setTransform({ cropLeft }, 'cropLeft')}
              />
              <NumberField
                value={t.cropRight}
                min={0}
                max={0.95}
                step={1}
                display={100}
                suffix="%"
                onChange={(cropRight) => setTransform({ cropRight }, 'cropRight')}
              />
            </div>
          </Row>
          <Row label="Top / Bottom">
            <div className="pair">
              <NumberField
                value={t.cropTop}
                min={0}
                max={0.95}
                step={1}
                display={100}
                suffix="%"
                onChange={(cropTop) => setTransform({ cropTop }, 'cropTop')}
              />
              <NumberField
                value={t.cropBottom}
                min={0}
                max={0.95}
                step={1}
                display={100}
                suffix="%"
                onChange={(cropBottom) => setTransform({ cropBottom }, 'cropBottom')}
              />
            </div>
          </Row>
        </Section>
      )}

      {(clip.kind === 'video' || clip.kind === 'image') && (
        <Section title="Color" onReset={() => update((c) => void (c.color = defaultColor()), 'color.reset')}>
          <SliderRow
            label="Brightness"
            value={clip.color.brightness}
            min={-1}
            max={1}
            step={0.01}
            display={100}
            reset={0}
            onChange={(brightness) => setColor({ brightness }, 'brightness')}
          />
          <SliderRow
            label="Contrast"
            value={clip.color.contrast}
            min={0}
            max={2}
            step={0.01}
            display={100}
            suffix="%"
            reset={1}
            onChange={(contrast) => setColor({ contrast }, 'contrast')}
          />
          <SliderRow
            label="Saturation"
            value={clip.color.saturation}
            min={0}
            max={3}
            step={0.01}
            display={100}
            suffix="%"
            reset={1}
            onChange={(saturation) => setColor({ saturation }, 'saturation')}
          />
          <SliderRow
            label="Gamma"
            value={clip.color.gamma}
            min={0.1}
            max={3}
            step={0.01}
            precision={2}
            reset={1}
            onChange={(gamma) => setColor({ gamma }, 'gamma')}
          />
        </Section>
      )}

      {audioClip && <AudioSection clip={audioClip} />}

      <TimingSection clip={clip} media={media} linked={linked} fps={fps} />

      <div className="clip-inspector__actions">
        {clip.linkId ? (
          <Button size="sm" icon={<Unlink2 size={14} />} onClick={unlinkSelection}>
            Unlink
          </Button>
        ) : (
          useEditor.getState().selection.length > 1 && (
            <Button size="sm" icon={<Link2 size={14} />} onClick={linkSelection}>
              Link
            </Button>
          )
        )}
        <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => deleteSelection(false)}>
          Delete
        </Button>
      </div>
    </div>
  )
}

function AudioSection({ clip }: { clip: Clip }) {
  const db = gainToDb(clip.volume)
  const setDb = (value: number) => {
    const gain = value <= -60 ? 0 : dbToGain(value)
    updateClips([clip.id], (c) => void (c.volume = Math.round(gain * 10000) / 10000), `volume:${clip.id}`)
  }
  return (
    <Section
      title="Audio"
      onReset={() => updateClips([clip.id], (c) => void (c.volume = 1), `volume:${clip.id}`)}
    >
      <Row label="Volume">
        <Slider
          value={Number.isFinite(db) ? Math.max(-60, db) : -60}
          min={-60}
          max={12}
          step={0.1}
          reset={0}
          onChange={setDb}
        />
        <NumberField
          className="num-field--compact"
          value={Number.isFinite(db) ? db : -Infinity}
          min={-60}
          max={12}
          step={0.5}
          precision={1}
          suffix="dB"
          onChange={setDb}
        />
      </Row>
    </Section>
  )
}

function TimingSection({
  clip,
  media,
  linked,
  fps
}: {
  clip: Clip
  media?: MediaItem
  linked: string[]
  fps: number
}) {
  const frame = 1 / fps
  const limit = maxDuration(clip, media)
  const canSpeed = clip.kind === 'video' || clip.kind === 'audio'

  const setStart = (value: number) => {
    const delta = value - clip.start
    commit((draft) => {
      for (const c of draft.clips)
        if (linked.includes(c.id)) c.start = Math.max(0, snapToFrame(c.start + delta, fps))
      resolveOverlaps(draft as Project, linked)
    })
  }
  const setDuration = (value: number) => {
    const next = Math.max(frame, Math.min(limit, value))
    commit((draft) => {
      for (const c of draft.clips) {
        if (!linked.includes(c.id)) continue
        c.duration = snapToFrame(next, fps)
        c.fadeIn = Math.min(c.fadeIn, c.duration)
        c.fadeOut = Math.min(c.fadeOut, c.duration - c.fadeIn)
      }
      resolveOverlaps(draft as Project, linked)
    })
  }
  const setFade = (key: 'fadeIn' | 'fadeOut', value: number) => {
    updateClips(
      linked,
      (c) => {
        const other = key === 'fadeIn' ? c.fadeOut : c.fadeIn
        c[key] = Math.max(0, Math.min(value, c.duration - other))
      },
      `${key}:${clip.id}`
    )
  }

  return (
    <Section title="Timing">
      <Row label="Start">
        <TimecodeField value={clip.start} fps={fps} onChange={setStart} />
      </Row>
      <Row label="Duration">
        <TimecodeField value={clip.duration} fps={fps} onChange={setDuration} min={frame} />
      </Row>
      {canSpeed && (
        <Row label="Speed">
          <NumberField
            value={clip.speed}
            min={0.1}
            max={16}
            step={5}
            display={100}
            suffix="%"
            onChange={(v) => setClipSpeed(clip.id, v)}
          />
        </Row>
      )}
      <Row label="Fade in / out">
        <div className="pair">
          <NumberField
            value={clip.fadeIn}
            min={0}
            max={clip.duration}
            step={0.1}
            precision={2}
            suffix="s"
            onChange={(v) => setFade('fadeIn', v)}
          />
          <NumberField
            value={clip.fadeOut}
            min={0}
            max={clip.duration}
            step={0.1}
            precision={2}
            suffix="s"
            onChange={(v) => setFade('fadeOut', v)}
          />
        </div>
      </Row>
      {media && canSpeed && (
        <div className="hint">
          Source {formatTimecode(clip.inPoint, fps)} to{' '}
          {formatTimecode(clip.inPoint + clip.duration * clip.speed, fps)}
        </div>
      )}
    </Section>
  )
}

const WEIGHTS = [
  { value: 300, label: 'Light' },
  { value: 400, label: 'Regular' },
  { value: 500, label: 'Medium' },
  { value: 600, label: 'Semibold' },
  { value: 700, label: 'Bold' },
  { value: 800, label: 'Extra Bold' },
  { value: 900, label: 'Black' }
]

function TextSection({
  style,
  onChange
}: {
  style: TextStyle
  onChange: (patch: Partial<TextStyle>, field: string) => void
}) {
  const fonts = useFonts()
  const options = useMemo(() => {
    const list = fonts.includes(style.fontFamily) ? fonts : [style.fontFamily, ...fonts]
    return list.map((f) => ({ value: f, label: f }))
  }, [fonts, style.fontFamily])

  return (
    <>
      <Section title="Text">
        <textarea
          className="text-area"
          value={style.content}
          rows={3}
          onChange={(e) => onChange({ content: e.target.value }, 'content')}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <Row label="Font">
          <Select
            value={style.fontFamily}
            options={options}
            onChange={(fontFamily) => onChange({ fontFamily }, 'font')}
          />
        </Row>
        <Row label="Weight">
          <div className="pair">
            <Select
              value={style.fontWeight}
              options={WEIGHTS}
              onChange={(fontWeight) => onChange({ fontWeight }, 'weight')}
            />
            <IconButton
              tip="Italic"
              active={style.italic}
              onClick={() => onChange({ italic: !style.italic }, 'italic')}
            >
              <Italic size={15} />
            </IconButton>
          </div>
        </Row>
        <Row label="Size">
          <NumberField
            value={style.fontSize}
            min={6}
            max={1000}
            step={1}
            suffix="px"
            onChange={(fontSize) => onChange({ fontSize: Math.round(fontSize) }, 'size')}
          />
        </Row>
        <Row label="Align">
          <Segmented
            value={style.align}
            onChange={(align) => onChange({ align }, 'align')}
            options={[
              { value: 'left', icon: <AlignLeft size={14} />, tip: 'Align left' },
              { value: 'center', icon: <AlignCenter size={14} />, tip: 'Align center' },
              { value: 'right', icon: <AlignRight size={14} />, tip: 'Align right' }
            ]}
          />
        </Row>
        <Row label="Color">
          <ColorField value={style.color} onChange={(color) => onChange({ color }, 'color')} />
        </Row>
        <Row label="Line / Spacing">
          <div className="pair">
            <NumberField
              value={style.lineHeight}
              min={0.6}
              max={4}
              step={0.05}
              precision={2}
              onChange={(lineHeight) => onChange({ lineHeight }, 'lineHeight')}
            />
            <NumberField
              value={style.letterSpacing}
              min={-50}
              max={200}
              step={1}
              suffix="px"
              onChange={(letterSpacing) => onChange({ letterSpacing }, 'letterSpacing')}
            />
          </div>
        </Row>
      </Section>
      <Section title="Text style" defaultOpen={style.strokeWidth > 0 || style.backgroundOpacity > 0}>
        <Row label="Outline">
          <div className="pair">
            <NumberField
              value={style.strokeWidth}
              min={0}
              max={60}
              step={1}
              suffix="px"
              onChange={(strokeWidth) => onChange({ strokeWidth: Math.round(strokeWidth) }, 'strokeWidth')}
            />
            <ColorField
              value={style.strokeColor}
              onChange={(strokeColor) => onChange({ strokeColor }, 'strokeColor')}
            />
          </div>
        </Row>
        <SliderRow
          label="Background"
          value={style.backgroundOpacity}
          min={0}
          max={1}
          step={0.01}
          display={100}
          suffix="%"
          reset={0}
          onChange={(backgroundOpacity) => onChange({ backgroundOpacity }, 'bgOpacity')}
        />
        <Row label="Box color">
          <ColorField
            value={style.backgroundColor}
            onChange={(backgroundColor) => onChange({ backgroundColor }, 'bgColor')}
          />
        </Row>
        <Row label="Padding">
          <NumberField
            value={style.padding}
            min={0}
            max={400}
            step={1}
            suffix="px"
            onChange={(padding) => onChange({ padding: Math.round(padding) }, 'padding')}
          />
        </Row>
        <Row label="Shadow">
          <Switch
            checked={style.shadow}
            onChange={(shadow) => onChange({ shadow }, 'shadow')}
            label="Drop shadow"
          />
        </Row>
      </Section>
    </>
  )
}

function ProjectInspector({ project }: { project: Project }) {
  const { settings } = project
  const [name, setName] = useState(project.name)
  useEffect(() => setName(project.name), [project.name])
  const preset = RESOLUTION_PRESETS.find((p) => p.width === settings.width && p.height === settings.height)
  const duration = projectDuration(project)

  return (
    <div className="project-inspector">
      <Section title="Project">
        <Row label="Name">
          <input
            className="text-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => renameProject(name)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
          />
        </Row>
        <Row label="Format">
          <Select
            value={preset?.id ?? 'custom'}
            options={[
              ...RESOLUTION_PRESETS.map((p) => ({ value: p.id, label: `${p.label} (${p.detail})` })),
              { value: 'custom', label: 'Custom' }
            ]}
            onChange={(id) => {
              const p = RESOLUTION_PRESETS.find((r) => r.id === id)
              if (p) updateProjectSettings({ width: p.width, height: p.height })
            }}
          />
        </Row>
        <Row label="Size">
          <div className="pair">
            <NumberField
              label="W"
              value={settings.width}
              min={16}
              max={7680}
              step={2}
              onChange={(w) => updateProjectSettings({ width: Math.round(w / 2) * 2 }, 'settings.width')}
            />
            <NumberField
              label="H"
              value={settings.height}
              min={16}
              max={7680}
              step={2}
              onChange={(h) => updateProjectSettings({ height: Math.round(h / 2) * 2 }, 'settings.height')}
            />
          </div>
        </Row>
        <Row label="Frame rate">
          <Select
            value={settings.fps}
            options={FRAME_RATES.map((r) => ({ value: r, label: `${r} fps` }))}
            onChange={(fps) => updateProjectSettings({ fps })}
          />
        </Row>
        <Row label="Background">
          <ColorField
            value={settings.background}
            onChange={(background) => updateProjectSettings({ background }, 'settings.background')}
          />
        </Row>
      </Section>
      <Section title="Overview">
        <dl className="stats">
          <dt>Duration</dt>
          <dd>{formatDuration(duration)}</dd>
          <dt>Clips</dt>
          <dd>{project.clips.length}</dd>
          <dt>Media</dt>
          <dd>{project.media.length}</dd>
          <dt>Markers</dt>
          <dd>{project.markers.length}</dd>
          {(project.inPoint !== null || project.outPoint !== null) && (
            <>
              <dt>In / Out</dt>
              <dd>
                {formatTimecode(project.inPoint ?? 0, settings.fps)} to{' '}
                {formatTimecode(project.outPoint ?? duration, settings.fps)}
                <button type="button" className="link-button" onClick={clearInOut}>
                  Clear
                </button>
              </dd>
            </>
          )}
        </dl>
      </Section>
      <p className="inspector__empty">Select a clip on the timeline to edit its properties.</p>
    </div>
  )
}

function MultiInspector({ count }: { count: number }) {
  return (
    <div className="multi-inspector">
      <p>
        <strong>{count} clips</strong> selected
      </p>
      <div className="clip-inspector__actions">
        <Button size="sm" icon={<Link2 size={14} />} onClick={linkSelection}>
          Link
        </Button>
        <Button size="sm" icon={<Unlink2 size={14} />} onClick={unlinkSelection}>
          Unlink
        </Button>
        <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => deleteSelection(false)}>
          Delete
        </Button>
      </div>
    </div>
  )
}
