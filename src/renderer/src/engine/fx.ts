import type { Clip } from '@shared/types'
import type { LayerRect } from '@shared/geometry'
import {
  activeEffects,
  colorMatrix,
  effectColor,
  effectNumber,
  fxImageKey,
  GRAIN_DEVIATION_PER_STRENGTH,
  grainStrength,
  hasClipFx,
  pixelateCells,
  rgbSplitOffset,
  rgbToUv,
  screenType,
  shadowLayout
} from '@shared/effects'
import { hexToRgb } from './compositor'
import { borderImage, maskImage, vignetteImage } from './decor'
import type { FxPass, LayerFx } from './fx-gl'

/**
 * The effects of a clip for a renderer that draws `scale` pixels per project pixel, or null when
 * the clip has none. `pad` is the margin in pixels the shadow adds on every side.
 */
export function layerFx(
  clip: Clip,
  layer: LayerRect,
  scale: number,
  frame: number
): { fx: LayerFx; pad: number } | null {
  if (!hasClipFx(clip)) return null
  const width = Math.max(2, Math.round(layer.width * scale))
  const height = Math.max(2, Math.round(layer.height * scale))
  const passes: FxPass[] = []
  for (const effect of activeEffects(clip)) {
    const n = (key: string) => effectNumber(effect, key)
    switch (effect.type) {
      case 'blur':
        passes.push({
          kind: 'blur',
          sigma: (n('amount') * scale) / 2,
          css: `blur(${(n('amount') * scale) / 2}px)`
        })
        break
      case 'sharpen':
        passes.push({ kind: 'sharpen', amount: n('amount') })
        break
      case 'pixelate':
        passes.push({ kind: 'pixelate', cells: pixelateCells(width, height, n('size') * scale) })
        break
      case 'glow': {
        const low = Math.min(254, Math.round(n('threshold') * 255))
        passes.push({
          kind: 'glow',
          low,
          gain: 255 / (255 - low),
          sigma: (n('radius') * scale) / 2,
          intensity: n('intensity')
        })
        break
      }
      case 'vignette':
        passes.push({
          kind: 'multiply',
          image: {
            key: fxImageKey.vignette(clip.id, effect.id),
            source: vignetteImage(effect, width, height)
          }
        })
        break
      case 'grain':
        passes.push({
          kind: 'grain',
          deviation: grainStrength(effect) * GRAIN_DEVIATION_PER_STRENGTH,
          seed: frame % 997
        })
        break
      case 'rgbSplit': {
        const offset = rgbSplitOffset(effect, scale)
        if (offset[0] || offset[1]) passes.push({ kind: 'shift', offset })
        break
      }
      case 'blackWhite':
      case 'sepia':
      case 'hue': {
        const css =
          effect.type === 'hue'
            ? `hue-rotate(${n('angle')}deg)`
            : `${effect.type === 'sepia' ? 'sepia' : 'grayscale'}(${n('amount')})`
        passes.push({ kind: 'matrix', matrix: colorMatrix(effect)!, offset: 0, css })
        break
      }
      case 'invert': {
        // c + (1 - 2c) * amount, the export's lutrgb expression.
        const a = n('amount')
        const d = 1 - 2 * a
        passes.push({ kind: 'matrix', matrix: [d, 0, 0, 0, d, 0, 0, 0, d], offset: a, css: `invert(${a})` })
        break
      }
      case 'chromaKey': {
        const color = effectColor(effect, 'color')
        const [r, g, b] = hexToRgb(color).map((v) => v * 255)
        passes.push({
          kind: 'key',
          uv: rgbToUv(r, g, b),
          similarity: n('similarity'),
          smoothness: n('smoothness'),
          spill: n('spill'),
          blue: screenType(color) === 'blue'
        })
        break
      }
      case 'shake':
        break
    }
  }

  const shadow =
    clip.shadow && clip.shadow.opacity > 1e-4
      ? {
          ...shadowLayout(clip.shadow, scale, clip.transform.rotation),
          color: hexToRgb(clip.shadow.color),
          opacity: clip.shadow.opacity
        }
      : null
  return {
    fx: {
      width,
      height,
      passes,
      mask: clip.mask
        ? { key: fxImageKey.mask(clip.id), source: maskImage(clip.mask, width, height, scale) }
        : null,
      border: clip.border
        ? {
            key: fxImageKey.border(clip.id),
            source: borderImage(clip.mask ?? null, clip.border, width, height, scale)
          }
        : null,
      shadow
    },
    pad: shadow?.pad ?? 0
  }
}
