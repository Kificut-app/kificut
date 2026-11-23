import type { ColorAdjust } from '@shared/types'
import type { DrawLayer, LayerRenderer } from './compositor'
import type { LayerFx } from './fx-gl'

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

function scratch(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas')
  return [canvas, canvas.getContext('2d')!]
}

/**
 * Fallback for systems without WebGL 2 (virtual machines, remote desktops, blocklisted drivers).
 * Geometry matches the GPU path exactly; color adjustments are approximated with CSS filters. Of
 * the effects, shape, border, shadow, vignette and pixelate match; blur and the color effects use
 * CSS filters; sharpen, glow, grain, RGB split and chroma key are left out.
 */
export class CanvasCompositor implements LayerRenderer {
  readonly backend = 'canvas'
  private ctx: CanvasRenderingContext2D
  private sx = 1
  private sy = 1
  private work = scratch()
  private spare = scratch()

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
    // Layers with effects are flipped while they are drawn at their own size.
    if (!layer.fx) ctx.scale(u1 < u0 ? -1 : 1, v1 < v0 ? -1 : 1)
    ctx.globalAlpha = Math.min(1, layer.opacity)

    if (layer.fx) {
      const fx = layer.fx
      const canvas = this.renderFx(layer, fx)
      if (canvas) {
        // The corners include the shadow's padding; the canvas shadow draws outside the layer.
        const pad = fx.shadow ? fx.shadow.pad / this.sx : 0
        const w = width - 2 * pad
        const h = height - 2 * pad
        if (fx.shadow) {
          const [r, g, b] = fx.shadow.color.map((c) => Math.round(c * 255))
          const [ox, oy] = fx.shadow.offset
          ctx.shadowColor = `rgba(${r}, ${g}, ${b}, ${fx.shadow.opacity})`
          ctx.shadowBlur = fx.shadow.sigma * 2
          // Shadow offsets ignore the transform: turn the layer's own offset back into screen space.
          ctx.shadowOffsetX = ox * Math.cos(angle) - oy * Math.sin(angle)
          ctx.shadowOffsetY = ox * Math.sin(angle) + oy * Math.cos(angle)
        }
        ctx.drawImage(canvas, -w / 2, -h / 2, w, h)
      }
      ctx.restore()
      return
    }

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

  /** Draws the layer at its own pixel size with its effects, mask and border, or null if not ready. */
  private renderFx(layer: DrawLayer, fx: LayerFx): HTMLCanvasElement | null {
    let [canvas, ctx] = this.work
    canvas.width = fx.width
    canvas.height = fx.height
    const [u0, v0, u1, v1] = layer.uv
    if (layer.solid) {
      const [r, g, b] = layer.solid.map((c) => Math.round(c * 255))
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`
      ctx.fillRect(0, 0, fx.width, fx.height)
    } else {
      const [w, h] = layer.source ? sourceSize(layer.source) : [0, 0]
      if (w <= 0 || h <= 0) return null
      ctx.filter = cssFilter(layer.color)
      // Flip the picture only: the mask and border stay as they are, as in the export.
      const fh = u1 < u0
      const fv = v1 < v0
      ctx.setTransform(fh ? -1 : 1, 0, 0, fv ? -1 : 1, fh ? fx.width : 0, fv ? fx.height : 0)
      ctx.drawImage(
        layer.source as CanvasImageSource,
        Math.min(u0, u1) * w,
        Math.min(v0, v1) * h,
        Math.max(1, Math.abs(u1 - u0) * w),
        Math.max(1, Math.abs(v1 - v0) * h),
        0,
        0,
        fx.width,
        fx.height
      )
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.filter = 'none'
    }

    const copy = (filter = 'none') => {
      const [next, nextCtx] = this.spare
      next.width = fx.width
      next.height = fx.height
      nextCtx.filter = filter
      nextCtx.drawImage(canvas, 0, 0)
      nextCtx.filter = 'none'
      this.spare = this.work
      this.work = [next, nextCtx]
      ;[canvas, ctx] = this.work
    }
    for (const pass of fx.passes) {
      if (pass.css) copy(pass.css)
      else if (pass.kind === 'pixelate') {
        const [small, smallCtx] = scratch()
        small.width = pass.cells[0]
        small.height = pass.cells[1]
        smallCtx.drawImage(canvas, 0, 0, small.width, small.height)
        ctx.clearRect(0, 0, fx.width, fx.height)
        ctx.imageSmoothingEnabled = false
        ctx.drawImage(small, 0, 0, fx.width, fx.height)
        ctx.imageSmoothingEnabled = true
      } else if (pass.kind === 'multiply') {
        const [before, beforeCtx] = scratch()
        before.width = fx.width
        before.height = fx.height
        beforeCtx.drawImage(canvas, 0, 0)
        ctx.globalCompositeOperation = 'multiply'
        ctx.drawImage(pass.image.source as CanvasImageSource, 0, 0, fx.width, fx.height)
        // Multiply makes everything opaque; keep the layer's own transparency.
        ctx.globalCompositeOperation = 'destination-in'
        ctx.drawImage(before, 0, 0)
        ctx.globalCompositeOperation = 'source-over'
      }
    }
    if (fx.mask) {
      ctx.globalCompositeOperation = 'destination-in'
      ctx.drawImage(fx.mask.source as CanvasImageSource, 0, 0, fx.width, fx.height)
      ctx.globalCompositeOperation = 'source-over'
    }
    if (fx.border) ctx.drawImage(fx.border.source as CanvasImageSource, 0, 0, fx.width, fx.height)
    return canvas
  }

  hasTexture(): boolean {
    return false
  }

  end(): void {}

  destroy(): void {}
}
