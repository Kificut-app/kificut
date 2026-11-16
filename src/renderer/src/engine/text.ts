import type { TextStyle } from '@shared/types'

export interface TextRaster {
  canvas: HTMLCanvasElement
  /** Size in project pixels. */
  width: number
  height: number
  key: string
}

const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui'])
const MAX_SIZE = 8192
const CACHE_LIMIT = 64

const cache = new Map<string, TextRaster>()
const pendingFonts = new Set<string>()
let fontListener: (() => void) | null = null

/** Called whenever a font finishes loading, so the preview can redraw text that used a fallback. */
export function onFontLoaded(listener: () => void): void {
  fontListener = listener
}

export function cssFontFamily(family: string): string {
  if (GENERIC_FAMILIES.has(family)) return family
  if (family === 'Inter') return '"Inter Variable", "Inter", sans-serif'
  return `"${family.replace(/"/g, '')}", "Inter Variable", sans-serif`
}

export function fontString(style: TextStyle): string {
  return `${style.italic ? 'italic ' : ''}${style.fontWeight} ${style.fontSize}px ${cssFontFamily(style.fontFamily)}`
}

function ensureFont(font: string): void {
  if (document.fonts.check(font) || pendingFonts.has(font)) return
  pendingFonts.add(font)
  void document.fonts.load(font).then(() => {
    for (const [key, raster] of cache) if (raster.key.includes(font)) cache.delete(key)
    fontListener?.()
  })
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '')
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean
  const n = parseInt(full.slice(0, 6), 16) || 0
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

/**
 * Draws a text layer onto its own canvas at project resolution. The same raster feeds the WebGL
 * preview and is written to PNG for export, which keeps both outputs identical.
 */
export function rasterizeText(style: TextStyle): TextRaster {
  const font = fontString(style)
  const key = `${font}|${JSON.stringify(style)}`
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  ensureFont(font)

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  ctx.font = font
  ctx.letterSpacing = `${style.letterSpacing}px`

  const lines = (style.content || ' ').split('\n')
  const lineHeight = style.fontSize * style.lineHeight
  const widths = lines.map((line) => ctx.measureText(line || ' ').width)
  const textWidth = Math.max(1, ...widths)
  const textHeight = lineHeight * lines.length

  const hasBox = style.backgroundOpacity > 0
  const pad = hasBox ? style.padding : 0
  const margin = Math.ceil(style.strokeWidth + (style.shadow ? style.fontSize * 0.2 : 0) + 2)
  const width = Math.min(MAX_SIZE, Math.ceil(textWidth + pad * 2 + margin * 2))
  const height = Math.min(MAX_SIZE, Math.ceil(textHeight + pad * 2 + margin * 2))

  canvas.width = width
  canvas.height = height
  ctx.font = font
  ctx.letterSpacing = `${style.letterSpacing}px`
  ctx.textBaseline = 'middle'

  if (hasBox) {
    ctx.fillStyle = hexToRgba(style.backgroundColor, style.backgroundOpacity)
    roundedRect(
      ctx,
      margin,
      margin,
      width - margin * 2,
      height - margin * 2,
      Math.min(pad, style.fontSize * 0.14)
    )
    ctx.fill()
  }

  const left = margin + pad
  const right = width - margin - pad
  ctx.textAlign = style.align
  const x = style.align === 'left' ? left : style.align === 'right' ? right : width / 2

  lines.forEach((line, i) => {
    const y = margin + pad + lineHeight * (i + 0.5)
    if (style.shadow) {
      ctx.save()
      ctx.shadowColor = 'rgba(0, 0, 0, 0.55)'
      ctx.shadowBlur = style.fontSize * 0.14
      ctx.shadowOffsetY = style.fontSize * 0.04
      ctx.fillStyle = style.color
      ctx.fillText(line, x, y)
      ctx.restore()
    }
    if (style.strokeWidth > 0) {
      ctx.lineJoin = 'round'
      ctx.lineWidth = style.strokeWidth * 2
      ctx.strokeStyle = style.strokeColor
      ctx.strokeText(line, x, y)
    }
    ctx.fillStyle = style.color
    ctx.fillText(line, x, y)
  })

  const raster: TextRaster = { canvas, width, height, key }
  cache.set(key, raster)
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  return raster
}

export async function textToPng(
  style: TextStyle
): Promise<{ png: Uint8Array; width: number; height: number }> {
  await document.fonts.load(fontString(style)).catch(() => undefined)
  const raster = rasterizeText(style)
  const blob = await new Promise<Blob | null>((resolve) => raster.canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('Could not render a text layer.')
  return { png: new Uint8Array(await blob.arrayBuffer()), width: raster.width, height: raster.height }
}
