import { effectNumber, hasCorners, type ClipBorder, type ClipMask, type Effect } from '@shared/effects'

/*
 * Images drawn with the 2D canvas for a layer of `width` x `height` pixels: the shape mask, the
 * border and the vignette. The preview uploads them as textures and the export sends them to FFmpeg
 * as PNG files, so both use exactly the same pixels. `scale` is pixels per project pixel.
 */

const CACHE_LIMIT = 48
const cache = new Map<string, HTMLCanvasElement>()

function cached(key: string, draw: () => HTMLCanvasElement): HTMLCanvasElement {
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const canvas = draw()
  cache.set(key, canvas)
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  return canvas
}

function newCanvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  return [canvas, canvas.getContext('2d')!]
}

type Point = [number, number]

/** Corner points of the polygon shapes in a box from -0.5 to 0.5, stretched to fill it. */
function polygon(shape: ClipMask['shape']): Point[] {
  let points: Point[]
  switch (shape) {
    case 'triangle':
      return [
        [0, -0.5],
        [0.5, 0.5],
        [-0.5, 0.5]
      ]
    case 'diamond':
      return [
        [0, -0.5],
        [0.5, 0],
        [0, 0.5],
        [-0.5, 0]
      ]
    case 'hexagon':
      points = Array.from({ length: 6 }, (_, i) => {
        const a = ((-90 + 60 * i) * Math.PI) / 180
        return [Math.cos(a), Math.sin(a)] as Point
      })
      break
    case 'star':
      points = Array.from({ length: 10 }, (_, i) => {
        const a = ((-90 + 36 * i) * Math.PI) / 180
        const r = i % 2 === 0 ? 1 : 0.42
        return [r * Math.cos(a), r * Math.sin(a)] as Point
      })
      break
    default:
      return []
  }
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  return points.map(([x, y]) => [(x - x0) / (x1 - x0) - 0.5, (y - y0) / (y1 - y0) - 0.5])
}

/** A polygon with each corner rounded by `roundness` of the largest radius that still fits. */
function roundedPolygon(path: Path2D, points: Point[], roundness: number): void {
  const count = points.length
  const at = (i: number) => points[(i + count) % count]
  const mid = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  const start = mid(at(-1), at(0))
  path.moveTo(start[0], start[1])
  for (let i = 0; i < count; i++) {
    const [prev, corner, next] = [at(i - 1), at(i), at(i + 1)]
    const a = Math.hypot(prev[0] - corner[0], prev[1] - corner[1])
    const b = Math.hypot(next[0] - corner[0], next[1] - corner[1])
    const dot =
      ((prev[0] - corner[0]) * (next[0] - corner[0]) + (prev[1] - corner[1]) * (next[1] - corner[1])) /
      (a * b)
    const half = Math.acos(Math.min(1, Math.max(-1, dot))) / 2
    // The arc touches each edge at radius / tan(half) from the corner, at most half the edge.
    const radius = roundness * (Math.min(a, b) / 2) * Math.tan(half)
    const end = mid(corner, next)
    if (radius < 1e-6) path.lineTo(corner[0], corner[1])
    else path.arcTo(corner[0], corner[1], end[0], end[1], radius)
  }
  path.closePath()
}

function heart(path: Path2D, w: number, h: number): void {
  const steps = 240
  const points: Point[] = []
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2
    points.push([
      16 * Math.sin(t) ** 3,
      -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))
    ])
  }
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  points.forEach(([x, y], i) => {
    const px = ((x - x0) / (x1 - x0) - 0.5) * w
    const py = ((y - y0) / (y1 - y0) - 0.5) * h
    if (i === 0) path.moveTo(px, py)
    else path.lineTo(px, py)
  })
  path.closePath()
}

/** The mask shape in layer pixels. Without a mask, the whole layer. */
export function shapePath(mask: ClipMask | null, width: number, height: number): Path2D {
  if (!mask) {
    const full = new Path2D()
    full.rect(0, 0, width, height)
    return full
  }
  const short = Math.min(width, height)
  const w = mask.width * short
  const h = (mask.shape === 'circle' ? mask.width : mask.height) * short
  const local = new Path2D()
  switch (mask.shape) {
    case 'rectangle':
      local.roundRect(-w / 2, -h / 2, w, h, (mask.roundness * Math.min(w, h)) / 2)
      break
    case 'ellipse':
    case 'circle':
      local.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2)
      break
    case 'heart':
      heart(local, w, h)
      break
    default:
      roundedPolygon(
        local,
        polygon(mask.shape).map(([x, y]) => [x * w, y * h]),
        hasCorners(mask.shape) ? mask.roundness : 0
      )
  }
  const path = new Path2D()
  const matrix = new DOMMatrix()
    .translate(width / 2 + mask.x * short, height / 2 + mask.y * short)
    .rotate(mask.rotation)
  path.addPath(local, matrix)
  return path
}

/** White where the layer shows, transparent where it is cut away. */
export function maskImage(mask: ClipMask, width: number, height: number, scale: number): HTMLCanvasElement {
  const key = `mask|${width}x${height}|${scale.toFixed(4)}|${JSON.stringify(mask)}`
  return cached(key, () => {
    const [canvas, ctx] = newCanvas(width, height)
    const path = shapePath(mask, canvas.width, canvas.height)
    const blur = (mask.feather * scale) / 2
    ctx.fillStyle = '#ffffff'
    if (mask.invert) {
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.globalCompositeOperation = 'destination-out'
    }
    if (blur > 0.25) ctx.filter = `blur(${blur}px)`
    ctx.fill(path)
    return canvas
  })
}

/** The border line, inside the edge of the shape (or of the layer when there is no mask). */
export function borderImage(
  mask: ClipMask | null,
  border: ClipBorder,
  width: number,
  height: number,
  scale: number
): HTMLCanvasElement {
  const key = `border|${width}x${height}|${scale.toFixed(4)}|${JSON.stringify(mask)}|${JSON.stringify(border)}`
  return cached(key, () => {
    const [canvas, ctx] = newCanvas(width, height)
    const path = shapePath(mask, canvas.width, canvas.height)
    // Clip to what stays visible, so the stroke lies inside it; it is twice as wide to make up for
    // the half that falls outside.
    if (mask?.invert) {
      const outside = new Path2D()
      outside.rect(0, 0, canvas.width, canvas.height)
      outside.addPath(path)
      ctx.clip(outside, 'evenodd')
    } else {
      ctx.clip(path)
    }
    ctx.strokeStyle = border.color
    ctx.lineWidth = Math.max(1, border.width * scale) * 2
    ctx.lineJoin = 'round'
    ctx.stroke(path)
    return canvas
  })
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** Gray levels the picture is multiplied by: white in the middle, darker toward the edges. */
export function vignetteImage(effect: Effect, width: number, height: number): HTMLCanvasElement {
  const amount = effectNumber(effect, 'amount')
  const size = effectNumber(effect, 'size')
  const softness = effectNumber(effect, 'softness')
  const roundness = effectNumber(effect, 'roundness')
  const key = `vignette|${width}x${height}|${amount}|${size}|${softness}|${roundness}`
  return cached(key, () => {
    const [canvas, ctx] = newCanvas(width, height)
    const w = canvas.width
    const h = canvas.height
    // Distance 1 reaches the corners: an oval that follows the layer, or a circle.
    const half = Math.hypot(w, h) / 2
    const rx = (w / Math.SQRT2) * (1 - roundness) + half * roundness
    const ry = (h / Math.SQRT2) * (1 - roundness) + half * roundness
    const middle = 0.35 + 0.65 * size
    const spread = 0.05 + 0.6 * softness
    const image = ctx.createImageData(w, h)
    const data = image.data
    for (let y = 0; y < h; y++) {
      const dy = (y + 0.5 - h / 2) / ry
      for (let x = 0; x < w; x++) {
        const dx = (x + 0.5 - w / 2) / rx
        const d = Math.sqrt(dx * dx + dy * dy)
        const v = Math.round(255 * (1 - amount * smoothstep(middle - spread, middle + spread, d)))
        const i = (y * w + x) * 4
        data[i] = v
        data[i + 1] = v
        data[i + 2] = v
        data[i + 3] = 255
      }
    }
    ctx.putImageData(image, 0, 0)
    return canvas
  })
}

export async function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('Could not draw an effect image for the export.')
  return new Uint8Array(await blob.arrayBuffer())
}
