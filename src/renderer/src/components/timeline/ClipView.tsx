import { memo, useEffect, useRef } from 'react'
import { AudioLines, Image as ImageIcon, Link2, Square, Type, Video } from 'lucide-react'
import type { Clip, MediaItem } from '@shared/types'
import { mediaUrl, useFilmstrip, useWaveform } from '../../lib/media'
import { cx } from '../ui/controls'

export type ClipPart = 'body' | 'trim-start' | 'trim-end' | 'fade-in' | 'fade-out'

interface ClipViewProps {
  clip: Clip
  media: MediaItem | undefined
  zoom: number
  height: number
  selected: boolean
  offline: boolean
  dimmed: boolean
  visibleLeft: number
  visibleRight: number
  showThumbnails: boolean
  showWaveforms: boolean
  onPointerDown: (event: React.PointerEvent, clip: Clip, part: ClipPart) => void
  onContextMenu: (event: React.MouseEvent, clip: Clip) => void
}

const KIND_ICON = {
  video: Video,
  audio: AudioLines,
  image: ImageIcon,
  text: Type,
  solid: Square
}

export const ClipView = memo(function ClipView(props: ClipViewProps) {
  const { clip, media, zoom, height, selected, offline, dimmed, onPointerDown, onContextMenu } = props
  const left = clip.start * zoom
  const width = Math.max(2, clip.duration * zoom)
  const compact = width < 44
  const Icon = KIND_ICON[clip.kind]
  const fadeInW = clip.fadeIn * zoom
  const fadeOutW = clip.fadeOut * zoom

  return (
    <div
      className={cx(
        'clip',
        `clip--${clip.kind}`,
        selected && 'is-selected',
        offline && 'is-offline',
        compact && 'is-compact',
        dimmed && 'is-dimmed'
      )}
      style={{ left, width }}
      data-clip-id={clip.id}
      onPointerDown={(e) => onPointerDown(e, clip, 'body')}
      onContextMenu={(e) => onContextMenu(e, clip)}
    >
      <div className="clip__content">
        {clip.kind === 'video' && media && props.showThumbnails && !offline && (
          <Filmstrip
            clip={clip}
            media={media}
            zoom={zoom}
            height={height}
            visibleLeft={props.visibleLeft}
            visibleRight={props.visibleRight}
          />
        )}
        {clip.kind === 'audio' && media && props.showWaveforms && !offline && (
          <ClipWaveform
            clip={clip}
            media={media}
            zoom={zoom}
            height={height}
            visibleLeft={props.visibleLeft}
            visibleRight={props.visibleRight}
          />
        )}
        {clip.kind === 'text' && clip.text && !compact && (
          <span className="clip__text">{clip.text.content.split('\n')[0]}</span>
        )}
        {clip.kind === 'solid' && (
          <span className="clip__swatch" style={{ background: clip.solidColor ?? '#000' }} />
        )}
      </div>

      {(fadeInW > 1 || fadeOutW > 1) && (
        <svg
          className="clip__fades"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
        >
          {fadeInW > 1 && <path d={`M0 0 L${fadeInW} 0 L0 ${height} Z`} />}
          {fadeOutW > 1 && <path d={`M${width} 0 L${width - fadeOutW} 0 L${width} ${height} Z`} />}
          {fadeInW > 1 && <line x1={0} y1={height} x2={fadeInW} y2={0} />}
          {fadeOutW > 1 && <line x1={width - fadeOutW} y1={0} x2={width} y2={height} />}
        </svg>
      )}

      <div className="clip__label">
        {!compact && <Icon size={11} className="clip__icon" />}
        {clip.linkId && !compact && <Link2 size={10} className="clip__icon clip__icon--link" />}
        <span className="clip__name">{clip.name || (clip.kind === 'text' ? 'Text' : 'Clip')}</span>
        {Math.abs(clip.speed - 1) > 1e-3 && !compact && (
          <span className="clip__badge">{Math.round(clip.speed * 100)}%</span>
        )}
        {!compact && Boolean(clip.mask || clip.border || clip.shadow || clip.effects?.length) && (
          <span className="clip__badge" title="Shape, border, shadow or effects">
            fx
          </span>
        )}
        {offline && <span className="clip__badge clip__badge--warn">Offline</span>}
      </div>

      {!compact && (
        <>
          <span
            className="clip__fade-handle clip__fade-handle--in"
            style={{ left: Math.min(fadeInW, width - 12) }}
            data-tip="Drag to fade in"
            onPointerDown={(e) => {
              e.stopPropagation()
              onPointerDown(e, clip, 'fade-in')
            }}
          />
          <span
            className="clip__fade-handle clip__fade-handle--out"
            style={{ right: Math.min(fadeOutW, width - 12) }}
            data-tip="Drag to fade out"
            onPointerDown={(e) => {
              e.stopPropagation()
              onPointerDown(e, clip, 'fade-out')
            }}
          />
        </>
      )}
      <span
        className="clip__trim clip__trim--start"
        onPointerDown={(e) => {
          e.stopPropagation()
          onPointerDown(e, clip, 'trim-start')
        }}
      />
      <span
        className="clip__trim clip__trim--end"
        onPointerDown={(e) => {
          e.stopPropagation()
          onPointerDown(e, clip, 'trim-end')
        }}
      />
    </div>
  )
})

interface StripProps {
  clip: Clip
  media: MediaItem
  zoom: number
  height: number
  visibleLeft: number
  visibleRight: number
}

function Filmstrip({ clip, media, zoom, height, visibleLeft, visibleRight }: StripProps) {
  const strip = useFilmstrip(media, true)
  if (!strip || strip.frames.length === 0) return null
  const aspect = media.width && media.height ? media.width / media.height : 16 / 9
  const thumbW = Math.max(28, Math.round(height * aspect))
  const clipLeft = clip.start * zoom
  const width = clip.duration * zoom
  const from = Math.max(0, Math.floor((visibleLeft - clipLeft) / thumbW))
  const to = Math.min(Math.ceil(width / thumbW), Math.ceil((visibleRight - clipLeft) / thumbW))

  const frames = []
  for (let i = from; i < to; i++) {
    const x = i * thumbW
    const sourceTime = clip.inPoint + ((x + thumbW / 2) / zoom) * clip.speed
    const index = Math.max(0, Math.min(strip.frames.length - 1, Math.floor(sourceTime / strip.interval)))
    const path = strip.frames[index]
    if (!path) continue
    frames.push(
      <div
        key={i}
        className="filmstrip__frame"
        style={{ left: x, width: thumbW, backgroundImage: `url("${mediaUrl(path)}")` }}
      />
    )
  }
  return <div className="filmstrip">{frames}</div>
}

function ClipWaveform({ clip, media, zoom, height, visibleLeft, visibleRight }: StripProps) {
  const wave = useWaveform(media, true)
  const ref = useRef<HTMLCanvasElement>(null)
  const clipLeft = clip.start * zoom
  const width = clip.duration * zoom
  const segLeft = Math.max(0, Math.floor(visibleLeft - clipLeft))
  const segRight = Math.min(width, Math.ceil(visibleRight - clipLeft))
  const segWidth = Math.max(0, segRight - segLeft)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !wave || segWidth <= 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.ceil(segWidth * dpr)
    canvas.height = Math.ceil(height * dpr)
    const ctx = canvas.getContext('2d')!
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, segWidth, height)
    ctx.fillStyle = getComputedStyle(canvas).getPropertyValue('--wave').trim() || 'rgba(160, 240, 210, 0.7)'

    const { peaks, rate } = wave
    const mid = height / 2
    const gain = Math.min(2, clip.volume)
    for (let x = 0; x < segWidth; x++) {
      const t0 = clip.inPoint + ((segLeft + x) / zoom) * clip.speed
      const t1 = clip.inPoint + ((segLeft + x + 1) / zoom) * clip.speed
      const i0 = Math.max(0, Math.floor(t0 * rate))
      const i1 = Math.min(peaks.length, Math.max(i0 + 1, Math.ceil(t1 * rate)))
      let peak = 0
      for (let i = i0; i < i1; i++) if (peaks[i] > peak) peak = peaks[i]
      const amp = Math.min(1, Math.pow(peak * gain, 0.75))
      const h = Math.max(0.5, amp * (mid - 2))
      ctx.fillRect(x, mid - h, 1, h * 2)
    }
  }, [wave, segLeft, segWidth, zoom, height, clip.inPoint, clip.speed, clip.volume])

  if (!wave || segWidth <= 0) return null
  return <canvas ref={ref} className="waveform" style={{ left: segLeft, width: segWidth, height }} />
}
