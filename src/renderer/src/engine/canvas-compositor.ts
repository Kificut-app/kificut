import type { ColorAdjust } from '@shared/types'
import type { DrawLayer, LayerRenderer } from './compositor'

function sourceSize(source: TexImageSource): [number, number] {
  if (source instanceof HTMLVideoElement) return [source.videoWidth, source.videoHeight]
  if (source instanceof HTMLImageElement) return [source.naturalWidth, source.naturalHeight]
  if ('width' in source && 'height' in source) return [Number(source.width), Number(source.height)]
  return [0, 0]
}

function cssFilter(color: ColorAdjust): string {
  const parts: string[] = []
  if (Math.abs(color.brightness) > 1e-3) parts.push(`brightness(${Math.max(0, 1 + color.brightness)})`)
  if (Math.abs(color.contrast - 1) > 1e-3) parts.push(`contrast(${color.contrast})`)
  if (Math.abs(color.saturation - 1) > 1e-3) parts.push(`saturate(${color.saturation})`)
  return parts.length ? parts.join(' ') : 'none'
}

/**
 * Fallback for systems without WebGL 2 (virtual machines, remote desktops, blocklisted drivers).
 * Geometry matches the GPU path exactly; color adjustments are approximated with CSS filters.
 */
export class CanvasCompositor implements LayerRenderer {
  readonly backend = 'canvas'
  private ctx: CanvasRenderingContext2D
  private sx = 1
  private sy = 1

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('The preview could not create a drawing surface.')
    this.ctx = ctx
  }

  resize(pixelWidth: number, pixelHeight: number, projectWidth: number, projectHeight: number): void {
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth
      this.canvas.height = pixelHeight
    }
    this.sx = pixelWidth / projectWidth
    this.sy = pixelHeight / projectHeight
  }

  begin(background: string): void {
    const ctx = this.ctx
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.filter = 'none'
    ctx.fillStyle = background
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
  }

  draw(layer: DrawLayer): void {
    if (layer.opacity <= 0) return
    if (!layer.solid && !layer.source) return
    const ctx = this.ctx
    const [tl, tr, , bl] = layer.corners
    const width = Math.hypot(tr[0] - tl[0], tr[1] - tl[1])
    const height = Math.hypot(bl[0] - tl[0], bl[1] - tl[1])
    if (width < 0.5 || height < 0.5) return
    const angle = Math.atan2(tr[1] - tl[1], tr[0] - tl[0])
    const cx = (tl[0] + tr[0] + layer.corners[2][0] + bl[0]) / 4
    const cy = (tl[1] + tr[1] + layer.corners[2][1] + bl[1]) / 4
    const [u0, v0, u1, v1] = layer.uv

    ctx.save()
    ctx.setTransform(this.sx, 0, 0, this.sy, 0, 0)
    ctx.translate(cx, cy)
    ctx.rotate(angle)
    ctx.scale(u1 < u0 ? -1 : 1, v1 < v0 ? -1 : 1)
    ctx.globalAlpha = Math.min(1, layer.opacity)

    if (layer.solid) {
      const [r, g, b] = layer.solid.map((c) => Math.round(c * 255))
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`
      ctx.fillRect(-width / 2, -height / 2, width, height)
    } else {
      const [w, h] = sourceSize(layer.source!)
      if (w > 0 && h > 0) {
        ctx.filter = cssFilter(layer.color)
        const sx = Math.min(u0, u1) * w
        const sy = Math.min(v0, v1) * h
        const sw = Math.max(1, Math.abs(u1 - u0) * w)
        const sh = Math.max(1, Math.abs(v1 - v0) * h)
        ctx.drawImage(
          layer.source as CanvasImageSource,
          sx,
          sy,
          sw,
          sh,
          -width / 2,
          -height / 2,
          width,
          height
        )
      }
    }
    ctx.restore()
  }

  hasTexture(): boolean {
    return false
  }

  end(): void {}

  destroy(): void {}
}
