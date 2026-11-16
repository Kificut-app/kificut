import type { ClipKind, Transform } from './types'

export interface LayerRect {
  /** Center of the visible (cropped) region, in frame pixels. */
  cx: number
  cy: number
  /** Visible size after cropping, before rotation. */
  width: number
  height: number
  /** Size of the full scaled source, before cropping. */
  fullWidth: number
  fullHeight: number
  rotation: number
}

export type Point = [number, number]

/** Text layers are drawn at their natural size; everything else is fitted into the frame. */
export function fitsToFrame(kind: ClipKind): boolean {
  return kind !== 'text'
}

export function computeLayer(
  transform: Transform,
  sourceWidth: number,
  sourceHeight: number,
  frameWidth: number,
  frameHeight: number,
  fit: boolean
): LayerRect {
  const base = fit ? Math.min(frameWidth / sourceWidth, frameHeight / sourceHeight) : 1
  const fullWidth = sourceWidth * base * transform.scale
  const fullHeight = sourceHeight * base * transform.scale

  const cropX = clampCrop(transform.cropLeft, transform.cropRight)
  const cropY = clampCrop(transform.cropTop, transform.cropBottom)
  const width = fullWidth * (1 - cropX[0] - cropX[1])
  const height = fullHeight * (1 - cropY[0] - cropY[1])

  // Cropping keeps the remaining area in place, so the visible center moves.
  const offsetX = ((cropX[0] - cropX[1]) / 2) * fullWidth
  const offsetY = ((cropY[0] - cropY[1]) / 2) * fullHeight
  const [rx, ry] = rotate([offsetX, offsetY], transform.rotation)

  return {
    cx: frameWidth / 2 + transform.x + rx,
    cy: frameHeight / 2 + transform.y + ry,
    width,
    height,
    fullWidth,
    fullHeight,
    rotation: transform.rotation
  }
}

export function clampCrop(a: number, b: number): [number, number] {
  const first = Math.min(Math.max(a, 0), 0.99)
  const second = Math.min(Math.max(b, 0), 0.99 - first)
  return [first, second]
}

export function rotate(point: Point, degrees: number): Point {
  if (!degrees) return point
  const r = (degrees * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  return [point[0] * cos - point[1] * sin, point[0] * sin + point[1] * cos]
}

/** Corners in order: top-left, top-right, bottom-right, bottom-left. */
export function layerCorners(rect: LayerRect): Point[] {
  const hw = rect.width / 2
  const hh = rect.height / 2
  const local: Point[] = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh]
  ]
  return local.map((p) => {
    const [x, y] = rotate(p, rect.rotation)
    return [rect.cx + x, rect.cy + y]
  })
}

/** Bounding box of a rotated rectangle, matching FFmpeg's rotw()/roth(). */
export function rotatedBounds(width: number, height: number, degrees: number): [number, number] {
  const r = (degrees * Math.PI) / 180
  const cos = Math.abs(Math.cos(r))
  const sin = Math.abs(Math.sin(r))
  return [width * cos + height * sin, width * sin + height * cos]
}

export function pointInLayer(point: Point, rect: LayerRect): boolean {
  const [lx, ly] = rotate([point[0] - rect.cx, point[1] - rect.cy], -rect.rotation)
  return Math.abs(lx) <= rect.width / 2 && Math.abs(ly) <= rect.height / 2
}
