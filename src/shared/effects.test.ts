import { describe, expect, it } from 'vitest'
import {
  colorMatrix,
  defaultEffectParams,
  defaultMask,
  EFFECTS,
  hasClipFx,
  normalizeEffect,
  normalizeMask,
  pixelateCells,
  rgbSplitOffset,
  rgbToUv,
  screenType,
  shadowLayout,
  shakeExpressions,
  shakeOffset,
  type Effect,
  type EffectType
} from './effects'
import { num } from './ffmpeg-graph'
import { createClip } from '../renderer/src/lib/factory'

const effect = (type: EffectType, params: Effect['params'] = {}): Effect => ({
  id: 'fx1',
  type,
  enabled: true,
  params: { ...defaultEffectParams(type), ...params }
})

function apply(m: number[], rgb: number[]): number[] {
  return [0, 1, 2].map((r) => m[r * 3] * rgb[0] + m[r * 3 + 1] * rgb[1] + m[r * 3 + 2] * rgb[2])
}

describe('effect definitions', () => {
  it('have defaults inside their ranges', () => {
    for (const definition of EFFECTS) {
      for (const p of definition.params) {
        if (p.kind === 'number') {
          expect(p.default as number).toBeGreaterThanOrEqual(p.min!)
          expect(p.default as number).toBeLessThanOrEqual(p.max!)
        }
      }
    }
  })

  it('normalizes effects from files and assistants', () => {
    expect(normalizeEffect({ type: 'nope' }, () => 'x')).toBeNull()
    const blur = normalizeEffect({ type: 'blur', params: { amount: 900 } }, () => 'new')!
    expect(blur).toEqual({ id: 'new', type: 'blur', enabled: true, params: { amount: 100 } })
    const key = normalizeEffect(
      { type: 'chromaKey', params: { color: '#0000FF' }, enabled: false },
      () => 'k'
    )!
    expect(key.params.color).toBe('#0000ff')
    expect(key.enabled).toBe(false)
    expect(key.params.similarity).toBe(0.25)
  })

  it('normalizes masks and keeps a shape', () => {
    expect(normalizeMask({ shape: 'blob' })).toBeNull()
    expect(normalizeMask({ shape: 'circle', width: -1, feather: 9999 })).toMatchObject({
      width: 0.01,
      feather: 500
    })
    // A rectangle covers the whole 16:9 layer; other shapes fit inside its height.
    expect(defaultMask('rectangle', 1920, 1080)).toMatchObject({ width: 1920 / 1080, height: 1 })
    expect(defaultMask('star', 1920, 1080)).toMatchObject({ width: 0.9, height: 0.9 })
  })

  it('only sends clips with something to draw down the effects path', () => {
    const clip = createClip({ kind: 'solid', trackId: 't', start: 0, duration: 1 })
    expect(hasClipFx(clip)).toBe(false)
    clip.effects = [effect('blur', { amount: 0 })]
    expect(hasClipFx(clip)).toBe(false)
    clip.effects = [effect('shake')]
    expect(hasClipFx(clip)).toBe(false)
    clip.effects = [effect('blur')]
    expect(hasClipFx(clip)).toBe(true)
  })
})

describe('color matrices', () => {
  it('leave gray alone and do nothing at zero', () => {
    for (const type of ['blackWhite', 'sepia', 'hue'] as const) {
      const gray = apply(colorMatrix(effect(type))!, [0.5, 0.5, 0.5])
      if (type !== 'sepia') gray.forEach((v) => expect(v).toBeCloseTo(0.5, 2))
    }
    const none = colorMatrix(effect('sepia', { amount: 0 }))!
    expect(apply(none, [0.2, 0.4, 0.6]).map((v) => +v.toFixed(6))).toEqual([0.2, 0.4, 0.6])
    const turn = colorMatrix(effect('hue', { angle: 0 }))!
    apply(turn, [0.9, 0.1, 0.3]).forEach((v, i) => expect(v).toBeCloseTo([0.9, 0.1, 0.3][i], 2))
  })

  it('removes the color for black and white', () => {
    const [r, g, b] = apply(colorMatrix(effect('blackWhite'))!, [1, 0, 0])
    expect(r).toBeCloseTo(g, 6)
    expect(g).toBeCloseTo(b, 6)
  })
})

describe('geometry helpers', () => {
  it('counts pixelate blocks', () => {
    expect(pixelateCells(1920, 1080, 24)).toEqual([80, 45])
    expect(pixelateCells(10, 10, 500)).toEqual([1, 1])
  })

  it('offsets RGB split in whole pixels at the render scale', () => {
    expect(rgbSplitOffset(effect('rgbSplit', { amount: 8, angle: 0 }), 0.5)).toEqual([4, 0])
    expect(rgbSplitOffset(effect('rgbSplit', { amount: 10, angle: 90 }), 1)).toEqual([0, 10])
  })

  it('pads a shadow enough for its blur and offset, turned into the layer', () => {
    const shadow = { color: '#000000', opacity: 1, blur: 20, distance: 10, angle: 0 }
    const flat = shadowLayout(shadow, 1, 0)
    expect(flat.offset).toEqual([10, 0])
    expect(flat.sigma).toBe(10)
    expect(flat.pad).toBeGreaterThanOrEqual(3 * flat.sigma + 10)
    // A layer turned 90 degrees clockwise sees "right" as its own "up".
    expect(shadowLayout(shadow, 1, 90).offset.map((v) => Math.round(v) + 0)).toEqual([0, -10])
  })

  it('converts the key color to the chroma FFmpeg compares', () => {
    const [u, v] = rgbToUv(128, 128, 128)
    expect(u).toBeCloseTo(128, 6)
    expect(v).toBeCloseTo(128, 6)
    expect(screenType('#00ff00')).toBe('green')
    expect(screenType('#1030ff')).toBe('blue')
  })
})

describe('camera shake', () => {
  it('writes the same movement as an FFmpeg expression', () => {
    const shake = effect('shake', { amount: 30, speed: 1.5 })
    const [ex, ey] = shakeExpressions(shake, 't+2', 2, (n) => num(n, 6))
    const evaluate = (expr: string, t: number) =>
      Function('t', 'sin', `return ${expr}`)(t, Math.sin) as number
    for (const time of [0, 0.37, 1.2, 5]) {
      const [x, y] = shakeOffset(shake, time + 2)
      expect(evaluate(ex, time)).toBeCloseTo(x * 2, 2)
      expect(evaluate(ey, time)).toBeCloseTo(y * 2, 2)
    }
  })
})
