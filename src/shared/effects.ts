import type { Clip } from './types'

/*
 * Clip effects, shape masks, borders and shadows. The preview (engine/compositor.ts) and the export
 * (ffmpeg-graph.ts) both read these definitions, and the math they must agree on lives here.
 * Sizes in project pixels are scaled by whoever renders: preview pixels or export pixels per
 * project pixel.
 */

export type MaskShape =
  'rectangle' | 'ellipse' | 'circle' | 'heart' | 'star' | 'triangle' | 'diamond' | 'hexagon'

export interface ClipMask {
  shape: MaskShape
  /** Size as a multiple of the layer's shorter side. A circle uses `width` as its diameter. */
  width: number
  height: number
  /** Center offset from the middle of the layer, as a multiple of its shorter side. */
  x: number
  y: number
  /** Degrees, clockwise, on top of the clip's own rotation. */
  rotation: number
  /** Corner rounding from 0 (sharp) to 1 (fully round). */
  roundness: number
  /** Soft edge width in project pixels. */
  feather: number
  /** Keeps what is outside the shape instead. */
  invert: boolean
}

/** A line drawn just inside the edge of the shape (or of the clip without a shape). */
export interface ClipBorder {
  /** Project pixels. */
  width: number
  color: string
}

export interface ClipShadow {
  color: string
  opacity: number
  /** Softness in project pixels. */
  blur: number
  /** Offset in project pixels. */
  distance: number
  /** Direction the shadow falls, in degrees clockwise from the right. */
  angle: number
}

export type EffectType =
  | 'blur'
  | 'sharpen'
  | 'pixelate'
  | 'glow'
  | 'vignette'
  | 'grain'
  | 'rgbSplit'
  | 'shake'
  | 'blackWhite'
  | 'sepia'
  | 'invert'
  | 'hue'
  | 'chromaKey'

export type EffectParams = Record<string, number | string>

export interface Effect {
  id: string
  type: EffectType
  enabled: boolean
  params: EffectParams
}

export type EffectCategory = 'Blur and sharpen' | 'Stylize' | 'Color' | 'Keying'

export interface EffectParam {
  key: string
  label: string
  kind: 'number' | 'color'
  default: number | string
  min?: number
  max?: number
  step?: number
  /** Multiplier for the number shown, such as 100 for percentages. */
  display?: number
  suffix?: string
  precision?: number
}

export interface EffectDefinition {
  type: EffectType
  label: string
  category: EffectCategory
  description: string
  params: EffectParam[]
}

const percent = (key: string, label: string, value: number): EffectParam => ({
  key,
  label,
  kind: 'number',
  default: value,
  min: 0,
  max: 1,
  step: 0.01,
  display: 100,
  suffix: '%'
})

const pixels = (key: string, label: string, value: number, min: number, max: number): EffectParam => ({
  key,
  label,
  kind: 'number',
  default: value,
  min,
  max,
  step: 1,
  suffix: ' px'
})

const degrees = (key: string, label: string, value: number): EffectParam => ({
  key,
  label,
  kind: 'number',
  default: value,
  min: -180,
  max: 180,
  step: 1,
  suffix: '°'
})

export const EFFECTS: EffectDefinition[] = [
  {
    type: 'blur',
    label: 'Blur',
    category: 'Blur and sharpen',
    description: 'Gaussian blur, for soft backgrounds or hiding details.',
    params: [pixels('amount', 'Amount', 12, 0, 100)]
  },
  {
    type: 'sharpen',
    label: 'Sharpen',
    category: 'Blur and sharpen',
    description: 'Brings out fine detail (an unsharp mask on brightness).',
    params: [{ ...percent('amount', 'Amount', 0.8), max: 3 }]
  },
  {
    type: 'pixelate',
    label: 'Pixelate',
    category: 'Blur and sharpen',
    description: 'Large square blocks, to hide faces or text.',
    params: [pixels('size', 'Block size', 24, 2, 200)]
  },
  {
    type: 'glow',
    label: 'Glow',
    category: 'Stylize',
    description: 'Bright areas bloom softly into their surroundings.',
    params: [
      percent('threshold', 'Threshold', 0.6),
      pixels('radius', 'Radius', 24, 1, 100),
      percent('intensity', 'Intensity', 0.7)
    ]
  },
  {
    type: 'vignette',
    label: 'Vignette',
    category: 'Stylize',
    description: 'Darkens the edges to draw the eye to the middle.',
    params: [
      percent('amount', 'Amount', 0.5),
      percent('size', 'Size', 0.6),
      percent('softness', 'Softness', 0.6),
      percent('roundness', 'Roundness', 0)
    ]
  },
  {
    type: 'grain',
    label: 'Film Grain',
    category: 'Stylize',
    description: 'Moving film grain on the brightness.',
    params: [percent('amount', 'Amount', 0.3)]
  },
  {
    type: 'rgbSplit',
    label: 'RGB Split',
    category: 'Stylize',
    description: 'Shifts red and blue apart, like chromatic aberration.',
    params: [pixels('amount', 'Amount', 8, 0, 60), degrees('angle', 'Angle', 0)]
  },
  {
    type: 'shake',
    label: 'Camera Shake',
    category: 'Stylize',
    description: 'Handheld style movement.',
    params: [
      pixels('amount', 'Amount', 16, 0, 200),
      {
        key: 'speed',
        label: 'Speed',
        kind: 'number',
        default: 1,
        min: 0.1,
        max: 5,
        step: 0.05,
        precision: 2,
        suffix: 'x'
      }
    ]
  },
  {
    type: 'blackWhite',
    label: 'Black and White',
    category: 'Color',
    description: 'Removes the color.',
    params: [percent('amount', 'Amount', 1)]
  },
  {
    type: 'sepia',
    label: 'Sepia',
    category: 'Color',
    description: 'Warm brown tones of old photographs.',
    params: [percent('amount', 'Amount', 1)]
  },
  {
    type: 'invert',
    label: 'Invert',
    category: 'Color',
    description: 'Turns the picture into its negative.',
    params: [percent('amount', 'Amount', 1)]
  },
  {
    type: 'hue',
    label: 'Hue Shift',
    category: 'Color',
    description: 'Rotates every color around the color wheel.',
    params: [degrees('angle', 'Angle', 60)]
  },
  {
    type: 'chromaKey',
    label: 'Chroma Key',
    category: 'Keying',
    description: 'Makes a green or blue screen transparent.',
    params: [
      { key: 'color', label: 'Key color', kind: 'color', default: '#00ff00' },
      { ...percent('similarity', 'Similarity', 0.25), min: 0.01 },
      percent('smoothness', 'Smoothness', 0.08),
      percent('spill', 'Spill removal', 0.5)
    ]
  }
]

export const EFFECT_CATEGORIES: EffectCategory[] = ['Blur and sharpen', 'Stylize', 'Color', 'Keying']

export function effectDefinition(type: EffectType): EffectDefinition {
  return EFFECTS.find((e) => e.type === type)!
}

export function isEffectType(value: unknown): value is EffectType {
  return EFFECTS.some((e) => e.type === value)
}

export function defaultEffectParams(type: EffectType): EffectParams {
  return Object.fromEntries(effectDefinition(type).params.map((p) => [p.key, p.default]))
}

/** A parameter as a number, clamped to its range, or its default. */
export function effectNumber(effect: Effect, key: string): number {
  const param = effectDefinition(effect.type).params.find((p) => p.key === key)
  const fallback = typeof param?.default === 'number' ? param.default : 0
  const value = effect.params[key]
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(param?.max ?? Infinity, Math.max(param?.min ?? -Infinity, n))
}

export function effectColor(effect: Effect, key: string): string {
  const value = effect.params[key]
  const param = effectDefinition(effect.type).params.find((p) => p.key === key)
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
    ? value
    : String(param?.default ?? '#000000')
}

/** Fills in and clamps an effect read from a file or an assistant, or returns null if unusable. */
export function normalizeEffect(raw: unknown, id: () => string): Effect | null {
  const value = raw as Partial<Effect> | null
  if (!value || !isEffectType(value.type)) return null
  const definition = effectDefinition(value.type)
  const params: EffectParams = {}
  const given = (value.params ?? {}) as Record<string, unknown>
  for (const param of definition.params) {
    const v = given[param.key]
    if (param.kind === 'color') {
      params[param.key] = typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : param.default
    } else {
      const n = typeof v === 'number' && Number.isFinite(v) ? v : (param.default as number)
      params[param.key] = Math.min(param.max ?? Infinity, Math.max(param.min ?? -Infinity, n))
    }
  }
  return {
    id: typeof value.id === 'string' && value.id ? value.id : id(),
    type: value.type,
    enabled: value.enabled !== false,
    params
  }
}

export const MASK_SHAPES: Array<{ shape: MaskShape; label: string }> = [
  { shape: 'rectangle', label: 'Rectangle' },
  { shape: 'ellipse', label: 'Oval' },
  { shape: 'circle', label: 'Circle' },
  { shape: 'heart', label: 'Heart' },
  { shape: 'star', label: 'Star' },
  { shape: 'triangle', label: 'Triangle' },
  { shape: 'diamond', label: 'Diamond' },
  { shape: 'hexagon', label: 'Hexagon' }
]

export function isMaskShape(value: unknown): value is MaskShape {
  return MASK_SHAPES.some((s) => s.shape === value)
}

/** Shapes whose corners can be rounded. */
export function hasCorners(shape: MaskShape): boolean {
  return shape !== 'ellipse' && shape !== 'circle' && shape !== 'heart'
}

/**
 * A new mask for a layer of the given size: a rectangle covers the whole layer (so roundness gives
 * rounded corners), other shapes fill most of its height.
 */
export function defaultMask(shape: MaskShape, layerWidth: number, layerHeight: number): ClipMask {
  const short = Math.max(1, Math.min(layerWidth, layerHeight))
  const full = shape === 'rectangle' || shape === 'ellipse'
  return {
    shape,
    width: full ? layerWidth / short : 0.9,
    height: full ? layerHeight / short : 0.9,
    x: 0,
    y: 0,
    rotation: 0,
    roundness: shape === 'rectangle' ? 0.15 : 0,
    feather: 0,
    invert: false
  }
}

export function normalizeMask(raw: unknown): ClipMask | null {
  const m = raw as Partial<ClipMask> | null
  if (!m || !isMaskShape(m.shape)) return null
  const n = (v: unknown, fallback: number, min: number, max: number) =>
    Math.min(max, Math.max(min, typeof v === 'number' && Number.isFinite(v) ? v : fallback))
  return {
    shape: m.shape,
    width: n(m.width, 0.9, 0.01, 10),
    height: n(m.height, 0.9, 0.01, 10),
    x: n(m.x, 0, -5, 5),
    y: n(m.y, 0, -5, 5),
    rotation: n(m.rotation, 0, -360, 360),
    roundness: n(m.roundness, 0, 0, 1),
    feather: n(m.feather, 0, 0, 500),
    invert: m.invert === true
  }
}

export function normalizeBorder(raw: unknown): ClipBorder | null {
  const b = raw as Partial<ClipBorder> | null
  if (!b || typeof b.width !== 'number' || !Number.isFinite(b.width) || b.width <= 0) return null
  return {
    width: Math.min(200, b.width),
    color: typeof b.color === 'string' && /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '#ffffff'
  }
}

export function defaultShadow(): ClipShadow {
  return { color: '#000000', opacity: 0.6, blur: 24, distance: 12, angle: 45 }
}

export function normalizeShadow(raw: unknown): ClipShadow | null {
  const s = raw as Partial<ClipShadow> | null
  if (!s || typeof s !== 'object') return null
  const d = defaultShadow()
  const n = (v: unknown, fallback: number, min: number, max: number) =>
    Math.min(max, Math.max(min, typeof v === 'number' && Number.isFinite(v) ? v : fallback))
  return {
    color: typeof s.color === 'string' && /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : d.color,
    opacity: n(s.opacity, d.opacity, 0, 1),
    blur: n(s.blur, d.blur, 0, 200),
    distance: n(s.distance, d.distance, 0, 500),
    angle: n(s.angle, d.angle, -360, 360)
  }
}

/** Keys of the images the renderer draws for a clip's mask, border and vignettes. */
export const fxImageKey = {
  mask: (clipId: string) => `${clipId}/mask`,
  border: (clipId: string) => `${clipId}/border`,
  vignette: (clipId: string, effectId: string) => `${clipId}/vignette/${effectId}`
}

/** Enabled effects that change the picture, in order. */
export function activeEffects(clip: Clip): Effect[] {
  return (clip.effects ?? []).filter((e) => e.enabled && !isNoOp(e))
}

function isNoOp(effect: Effect): boolean {
  const n = (key: string) => effectNumber(effect, key)
  switch (effect.type) {
    case 'blur':
    case 'shake':
    case 'rgbSplit':
    case 'sharpen':
    case 'grain':
    case 'vignette':
    case 'blackWhite':
    case 'sepia':
    case 'invert':
      return n('amount') <= 0
    case 'glow':
      return n('intensity') <= 0
    case 'hue':
      return Math.abs(n('angle')) < 0.01
    default:
      return false
  }
}

/** Whether the clip needs the effects path at all, in the preview and in the export. */
export function hasClipFx(clip: Clip): boolean {
  return Boolean(
    clip.mask || clip.border || clip.shadow || activeEffects(clip).some((e) => e.type !== 'shake')
  )
}

/**
 * A 3x3 color matrix (row major, applied to RGB in 0..1) for the matrix based color effects. These
 * are the matrices of CSS grayscale(), sepia() and hue-rotate(), so the canvas fallback matches.
 */
export function colorMatrix(effect: Effect): number[] | null {
  const amount = effect.type === 'hue' ? 1 : effectNumber(effect, 'amount')
  const mix = (m: number[]) => m.map((v, i) => v * amount + (i % 4 === 0 ? 1 - amount : 0))
  switch (effect.type) {
    case 'blackWhite':
      return mix([0.2126, 0.7152, 0.0722, 0.2126, 0.7152, 0.0722, 0.2126, 0.7152, 0.0722])
    case 'sepia':
      return mix([0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131])
    case 'hue': {
      const a = (effectNumber(effect, 'angle') * Math.PI) / 180
      const c = Math.cos(a)
      const s = Math.sin(a)
      return [
        0.213 + 0.787 * c - 0.213 * s,
        0.715 - 0.715 * c - 0.715 * s,
        0.072 - 0.072 * c + 0.928 * s,
        0.213 - 0.213 * c + 0.143 * s,
        0.715 + 0.285 * c + 0.14 * s,
        0.072 - 0.072 * c - 0.283 * s,
        0.213 - 0.213 * c - 0.787 * s,
        0.715 - 0.715 * c + 0.715 * s,
        0.072 + 0.928 * c + 0.072 * s
      ]
    }
    default:
      return null
  }
}

/** RGB gains for the Temperature and Tint sliders in the Color section. */
export function temperatureGains(temperature: number, tint: number): [number, number, number] {
  return [1 + 0.25 * temperature, 1 - 0.25 * tint, 1 - 0.25 * temperature]
}

/** Number of blocks across and down for Pixelate on a layer of `width` x `height` pixels. */
export function pixelateCells(width: number, height: number, blockSize: number): [number, number] {
  const size = Math.max(1, blockSize)
  return [Math.max(1, Math.round(width / size)), Math.max(1, Math.round(height / size))]
}

/** Whole pixel offset of the red channel for RGB Split (blue moves the other way). */
export function rgbSplitOffset(effect: Effect, scale: number): [number, number] {
  const amount = effectNumber(effect, 'amount') * scale
  const a = (effectNumber(effect, 'angle') * Math.PI) / 180
  return [Math.round(amount * Math.cos(a)), Math.round(amount * Math.sin(a))]
}

/** Film grain: FFmpeg's noise strength (0..100) for an amount, and the standard deviation it gives. */
export function grainStrength(effect: Effect): number {
  return Math.round(effectNumber(effect, 'amount') * 60)
}
export const GRAIN_DEVIATION_PER_STRENGTH = 0.65 / 255

/** U and V of an RGB color with FFmpeg's BT.601 limited range conversion (0..255). */
export function rgbToUv(r: number, g: number, b: number): [number, number] {
  const k = 224 / 255
  return [
    -0.16874 * k * r - 0.33126 * k * g + 0.5 * k * b + 128,
    0.5 * k * r - 0.41869 * k * g - 0.08131 * k * b + 128
  ]
}

/** Which kind of screen a key color is, for spill removal. */
export function screenType(hex: string): 'green' | 'blue' {
  const n = parseInt(hex.replace('#', ''), 16) || 0
  return (n & 255) > ((n >> 8) & 255) ? 'blue' : 'green'
}

// Camera Shake: three sines at unrelated frequencies per axis look random but stay smooth, and the
// same formula is written as an FFmpeg expression for the export.
const SHAKE_X: Array<[number, number, number]> = [
  [1.3, 0, 0.5],
  [2.9, 1.7, 0.3],
  [5.3, 0.4, 0.2]
]
const SHAKE_Y: Array<[number, number, number]> = [
  [1.7, 2.1, 0.5],
  [3.1, 0.9, 0.3],
  [4.7, 2.6, 0.2]
]

/** Offset in project pixels at `time` seconds into the clip. */
export function shakeOffset(effect: Effect, time: number): [number, number] {
  const amount = effectNumber(effect, 'amount')
  const speed = effectNumber(effect, 'speed')
  const sum = (terms: Array<[number, number, number]>) =>
    terms.reduce((s, [f, p, w]) => s + w * Math.sin(2 * Math.PI * f * speed * time + p), 0)
  return [amount * sum(SHAKE_X), amount * sum(SHAKE_Y)]
}

/** The same offset as FFmpeg expressions of `timeExpr`, already multiplied by `scale`. */
export function shakeExpressions(
  effect: Effect,
  timeExpr: string,
  scale: number,
  digits: (n: number) => string
): [string, string] {
  const amount = effectNumber(effect, 'amount') * scale
  const speed = effectNumber(effect, 'speed')
  const expr = (terms: Array<[number, number, number]>) =>
    terms
      .map(
        ([f, p, w]) =>
          `${digits(amount * w)}*sin(${digits(2 * Math.PI * f * speed)}*(${timeExpr})+${digits(p)})`
      )
      .join('+')
  return [expr(SHAKE_X), expr(SHAKE_Y)]
}

/** Total shake offset of a clip, all shake effects added up. */
export function clipShake(clip: Clip, time: number): [number, number] {
  let x = 0
  let y = 0
  for (const effect of activeEffects(clip)) {
    if (effect.type !== 'shake') continue
    const [dx, dy] = shakeOffset(effect, time)
    x += dx
    y += dy
  }
  return [x, y]
}

/**
 * How a shadow is drawn at `scale` pixels per project pixel: the padding added around the layer so
 * the soft edge fits, the blur sigma and the offset in the layer's own (unrotated) pixels.
 */
export function shadowLayout(
  shadow: ClipShadow,
  scale: number,
  layerRotation: number
): { pad: number; sigma: number; offset: [number, number] } {
  const sigma = (shadow.blur / 2) * scale
  const distance = shadow.distance * scale
  const a = ((shadow.angle - layerRotation) * Math.PI) / 180
  const offset: [number, number] = [Math.round(distance * Math.cos(a)), Math.round(distance * Math.sin(a))]
  return { pad: Math.ceil(3 * sigma + distance) + 2, sigma, offset }
}
