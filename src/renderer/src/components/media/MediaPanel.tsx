import { useMemo, useState } from 'react'
import { AudioLines, FileVideo, ImageIcon, Link2Off, Plus, ScanSearch, Search, Upload } from 'lucide-react'
import type { MediaItem } from '@shared/types'
import { formatDuration } from '@shared/time'
import { useEditor } from '../../store/editor'
import {
  addMediaAtPlayhead,
  addSolidClip,
  addTextClip,
  appendMedia,
  importDialog,
  importPaths,
  relinkMedia,
  removeMedia
} from '../../store/actions'
import { openMenu } from '../../store/ui'
import { SOLID_PRESETS, TEXT_PRESETS, defaultTextStyle } from '../../lib/factory'
import { usePoster } from '../../lib/media'
import { droppedPaths, endDrag, hasFiles, startDrag } from '../../lib/drag'
import { cssFontFamily } from '../../engine/text'
import { modKey } from '../../lib/platform'
import { Button, ColorField, IconButton, cx } from '../ui/controls'
import { VoicePanel } from './VoicePanel'
import { GeneratePanel } from './GeneratePanel'
import { FootageSearch } from './FootageSearch'

type Tab = 'media' | 'text' | 'elements' | 'voice' | 'generate'

const NO_MEDIA: MediaItem[] = []

export function MediaPanel() {
  const [tab, setTab] = useState<Tab>('media')
  return (
    <section className="panel media-panel">
      <div className="panel__tabs" role="tablist">
        {(
          [
            ['media', 'Media'],
            ['text', 'Text'],
            ['elements', 'Elements'],
            ['voice', 'Voice'],
            ['generate', 'Generate']
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={cx('panel__tab', tab === id && 'is-active')}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="panel__body">
        {tab === 'media' && <MediaBin />}
        {tab === 'text' && <TextPresets />}
        {tab === 'elements' && <Elements />}
        {tab === 'voice' && <VoicePanel />}
        {tab === 'generate' && <GeneratePanel />}
      </div>
    </section>
  )
}

function MediaBin() {
  const media = useEditor((s) => s.project?.media ?? NO_MEDIA)
  const [query, setQuery] = useState('')
  const [dropping, setDropping] = useState(false)
  const [footage, setFootage] = useState(false)
  const [run, setRun] = useState(0)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? media.filter((m) => m.name.toLowerCase().includes(q)) : media
  }, [media, query])

  return (
    <div
      className={cx('media-bin', dropping && 'is-dropping')}
      onDragOver={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDropping(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false)
      }}
      onDrop={(e) => {
        setDropping(false)
        if (!hasFiles(e)) return
        e.preventDefault()
        void importPaths(droppedPaths(e))
      }}
    >
      <div className="media-bin__toolbar">
        <div className="search">
          <Search size={13} />
          <input
            placeholder={footage ? 'Describe a shot' : 'Search media'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Escape') setQuery('')
              if (e.key === 'Enter' && footage) setRun((n) => n + 1)
            }}
          />
        </div>
        <IconButton
          tip="Search inside footage by what it shows"
          active={footage}
          onClick={() => {
            setFootage((on) => !on)
            setRun(0)
          }}
        >
          <ScanSearch size={16} />
        </IconButton>
        <IconButton tip={`Import media|${modKey}I`} onClick={() => void importDialog()}>
          <Plus size={16} />
        </IconButton>
      </div>

      {footage && media.length > 0 ? (
        <FootageSearch query={query} run={run} />
      ) : media.length === 0 ? (
        <div className="media-bin__empty">
          <div className="media-bin__empty-icon">
            <Upload size={20} />
          </div>
          <p>Drop video, audio or images here</p>
          <Button size="sm" onClick={() => void importDialog()}>
            Import Media
          </Button>
        </div>
      ) : (
        <div className="media-grid">
          {filtered.map((item) => (
            <MediaCard key={item.id} item={item} />
          ))}
          {filtered.length === 0 && <p className="media-bin__none">No media matches "{query}".</p>}
        </div>
      )}
    </div>
  )
}

function MediaCard({ item }: { item: MediaItem }) {
  const offline = useEditor((s) => !!s.offline[item.id])
  const proxy = useEditor((s) => s.proxies[item.path])
  const selected = useEditor((s) => s.selectedMediaId === item.id)
  const used = useEditor((s) => s.project?.clips.some((c) => c.mediaId === item.id) ?? false)
  const poster = usePoster(item, offline)

  const meta =
    item.kind === 'audio'
      ? (item.audioCodec?.toUpperCase() ?? 'Audio')
      : `${item.width} × ${item.height}${item.kind === 'video' ? ` · ${Math.round(item.fps * 100) / 100} fps` : ''}`

  return (
    <div
      className={cx('media-card', selected && 'is-selected', offline && 'is-offline')}
      draggable={!offline}
      tabIndex={0}
      onDragStart={(e) => startDrag(e, { type: 'media', mediaId: item.id })}
      onDragEnd={endDrag}
      onClick={() => useEditor.setState({ selectedMediaId: item.id, selection: [] })}
      onDoubleClick={() => !offline && addMediaAtPlayhead(item.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !offline) addMediaAtPlayhead(item.id)
      }}
      onContextMenu={(e) =>
        openMenu(e, [
          { label: 'Insert at Playhead', disabled: offline, run: () => addMediaAtPlayhead(item.id) },
          { label: 'Append to Timeline', disabled: offline, run: () => appendMedia(item.id) },
          { separator: true },
          {
            label: 'Show in Folder',
            disabled: offline,
            run: () => window.kificut.shell.showItemInFolder(item.path)
          },
          { label: 'Locate File…', run: () => void relinkMedia(item.id) },
          { separator: true },
          { label: 'Remove from Project', danger: true, run: () => void removeMedia(item.id) }
        ])
      }
      title={item.path}
    >
      <div className="media-card__thumb">
        {poster ? (
          <img src={poster} alt="" draggable={false} />
        ) : (
          <div className={`media-card__placeholder media-card__placeholder--${item.kind}`}>
            {item.kind === 'audio' ? (
              <AudioLines size={22} />
            ) : item.kind === 'image' ? (
              <ImageIcon size={22} />
            ) : (
              <FileVideo size={22} />
            )}
          </div>
        )}
        {item.kind !== 'image' && (
          <span className="media-card__duration">{formatDuration(item.duration)}</span>
        )}
        {used && <span className="media-card__used" data-tip="Used in timeline" />}
        {offline && (
          <span className="media-card__offline">
            <Link2Off size={14} /> Offline
          </span>
        )}
        {proxy?.state === 'pending' && (
          <span className="media-card__proxy" data-tip="Creating preview file">
            <span style={{ width: `${Math.round(proxy.progress * 100)}%` }} />
          </span>
        )}
      </div>
      <div className="media-card__name">{item.name}</div>
      <div className="media-card__meta">{meta}</div>
    </div>
  )
}

function TextPresets() {
  return (
    <div className="preset-list">
      <p className="panel__hint">Click to add at the playhead, or drag onto the timeline.</p>
      <div className="text-presets">
        {TEXT_PRESETS.map((preset) => {
          const style = defaultTextStyle(preset.style)
          return (
            <button
              key={preset.id}
              type="button"
              className="text-preset"
              draggable
              onDragStart={(e) => startDrag(e, { type: 'text', presetId: preset.id })}
              onDragEnd={endDrag}
              onClick={() => addTextClip(preset.id)}
            >
              <span
                className="text-preset__sample"
                style={{
                  fontFamily: cssFontFamily(style.fontFamily),
                  fontWeight: style.fontWeight,
                  fontStyle: style.italic ? 'italic' : 'normal',
                  color: style.color,
                  background: style.backgroundOpacity > 0 ? style.backgroundColor : 'transparent',
                  WebkitTextStroke: style.strokeWidth ? `1px ${style.strokeColor}` : undefined,
                  textShadow: style.shadow ? '0 1px 3px rgba(0,0,0,.6)' : undefined,
                  padding: style.backgroundOpacity > 0 ? '2px 6px' : undefined
                }}
              >
                Aa
              </span>
              <span className="text-preset__label">{preset.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function Elements() {
  const [custom, setCustom] = useState('#3a7bd5')
  return (
    <div className="preset-list">
      <p className="panel__hint">Solid color layers for backgrounds and dips.</p>
      <div className="swatches">
        {SOLID_PRESETS.map((color) => (
          <button
            key={color}
            type="button"
            className="swatch"
            style={{ background: color }}
            aria-label={`Add ${color} color layer`}
            data-tip={color.toUpperCase()}
            draggable
            onDragStart={(e) => startDrag(e, { type: 'solid', color })}
            onDragEnd={endDrag}
            onClick={() => addSolidClip(color)}
          />
        ))}
      </div>
      <div className="elements__custom">
        <ColorField value={custom} onChange={setCustom} />
        <Button size="sm" onClick={() => addSolidClip(custom)}>
          Add Color
        </Button>
      </div>
    </div>
  )
}
