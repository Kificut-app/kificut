import { ArrowDown, ArrowUp, Ban, Eye, EyeOff, Trash2 } from 'lucide-react'
import type { Draft } from 'immer'
import type { Clip, Project } from '@shared/types'
import {
  defaultEffectParams,
  defaultMask,
  defaultShadow,
  effectDefinition,
  EFFECT_CATEGORIES,
  EFFECTS,
  hasCorners,
  MASK_SHAPES,
  type ClipMask,
  type ClipShadow,
  type Effect,
  type EffectType,
  type MaskShape
} from '@shared/effects'
import { uid } from '../../lib/factory'
import { clipLayer } from '../../engine/layers'
import { ColorField, IconButton, NumberField, Select, Switch } from '../ui/controls'
import { Row, Section, SliderRow } from './parts'

type Update = (recipe: (c: Draft<Clip>) => void, field: string) => void

function star(outer: number, inner: number): string {
  return Array.from({ length: 10 }, (_, i) => {
    const a = ((-90 + 36 * i) * Math.PI) / 180
    const r = i % 2 === 0 ? outer : inner
    return `${(r * Math.cos(a)).toFixed(2)},${(r * Math.sin(a)).toFixed(2)}`
  }).join(' ')
}

function hexagon(r: number): string {
  return Array.from({ length: 6 }, (_, i) => {
    const a = ((-90 + 60 * i) * Math.PI) / 180
    return `${(r * Math.cos(a)).toFixed(2)},${(r * Math.sin(a)).toFixed(2)}`
  }).join(' ')
}

function ShapeIcon({ shape }: { shape: MaskShape }) {
  const props = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinejoin: 'round' as const }
  let body
  switch (shape) {
    case 'rectangle':
      body = <rect x={-6.5} y={-4.5} width={13} height={9} rx={2} {...props} />
      break
    case 'ellipse':
      body = <ellipse rx={7} ry={4.5} {...props} />
      break
    case 'circle':
      body = <circle r={6} {...props} />
      break
    case 'heart':
      body = <path d="M0 6C-8 0.5-6.5-6-3-6C-1.5-6 0-4.8 0-3.6C0-4.8 1.5-6 3-6C6.5-6 8 0.5 0 6Z" {...props} />
      break
    case 'star':
      body = <polygon points={star(7, 3)} {...props} />
      break
    case 'triangle':
      body = <polygon points="0,-6 6.5,5.5 -6.5,5.5" {...props} />
      break
    case 'diamond':
      body = <polygon points="0,-7 5.5,0 0,7 -5.5,0" {...props} />
      break
    case 'hexagon':
      body = <polygon points={hexagon(6.5)} {...props} />
      break
  }
  return (
    <svg width={16} height={16} viewBox="-8 -8 16 16" aria-hidden>
      {body}
    </svg>
  )
}

export function ShapeSection({ project, clip, update }: { project: Project; clip: Clip; update: Update }) {
  const mask = clip.mask ?? null
  const setMask = (patch: Partial<ClipMask>, field: string) =>
    update((c) => {
      if (c.mask) Object.assign(c.mask, patch)
    }, `mask.${field}`)
  const pick = (shape: MaskShape | null) =>
    update((c) => {
      if (!shape) {
        delete c.mask
        return
      }
      if (c.mask?.shape === shape) return
      const layer = clipLayer(project, clip)
      const next = defaultMask(shape, layer.width, layer.height)
      if (c.mask) {
        // Keep where the shape was and how soft it is when switching shapes.
        Object.assign(next, {
          x: c.mask.x,
          y: c.mask.y,
          rotation: c.mask.rotation,
          feather: c.mask.feather,
          invert: c.mask.invert
        })
      }
      c.mask = next
    }, 'mask.shape')

  return (
    <Section title="Shape" defaultOpen={!!mask} onReset={mask ? () => pick(null) : undefined}>
      <div className="shape-picker" role="radiogroup" aria-label="Shape">
        <IconButton tip="No shape" active={!mask} onClick={() => pick(null)}>
          <Ban size={15} />
        </IconButton>
        {MASK_SHAPES.map(({ shape, label }) => (
          <IconButton key={shape} tip={label} active={mask?.shape === shape} onClick={() => pick(shape)}>
            <ShapeIcon shape={shape} />
          </IconButton>
        ))}
      </div>
      {mask && (
        <>
          {mask.shape === 'circle' ? (
            <SliderRow
              label="Size"
              value={mask.width}
              min={0.05}
              max={3}
              display={100}
              suffix="%"
              reset={0.9}
              onChange={(width) => setMask({ width }, 'width')}
            />
          ) : (
            <>
              <SliderRow
                label="Width"
                value={mask.width}
                min={0.05}
                max={4}
                display={100}
                suffix="%"
                reset={0.9}
                onChange={(width) => setMask({ width }, 'width')}
              />
              <SliderRow
                label="Height"
                value={mask.height}
                min={0.05}
                max={4}
                display={100}
                suffix="%"
                reset={0.9}
                onChange={(height) => setMask({ height }, 'height')}
              />
            </>
          )}
          <Row label="Position">
            <div className="pair">
              <NumberField
                label="X"
                value={mask.x}
                step={0.01}
                display={100}
                suffix="%"
                onChange={(x) => setMask({ x }, 'x')}
              />
              <NumberField
                label="Y"
                value={mask.y}
                step={0.01}
                display={100}
                suffix="%"
                onChange={(y) => setMask({ y }, 'y')}
              />
            </div>
          </Row>
          <SliderRow
            label="Rotation"
            value={mask.rotation}
            min={-180}
            max={180}
            step={1}
            suffix="°"
            reset={0}
            onChange={(rotation) => setMask({ rotation }, 'rotation')}
          />
          {hasCorners(mask.shape) && (
            <SliderRow
              label="Roundness"
              value={mask.roundness}
              min={0}
              max={1}
              display={100}
              suffix="%"
              reset={0}
              onChange={(roundness) => setMask({ roundness }, 'roundness')}
            />
          )}
          <SliderRow
            label="Feather"
            value={mask.feather}
            min={0}
            max={200}
            step={1}
            suffix=" px"
            reset={0}
            onChange={(feather) => setMask({ feather }, 'feather')}
          />
          <Row label="Invert">
            <Switch
              checked={mask.invert}
              onChange={(invert) => setMask({ invert }, 'invert')}
              label="Keep the outside"
            />
          </Row>
        </>
      )}
    </Section>
  )
}

export function BorderShadowSection({ clip, update }: { clip: Clip; update: Update }) {
  const border = clip.border ?? null
  const shadow = clip.shadow ?? null
  const setShadow = (patch: Partial<ClipShadow>, field: string) =>
    update((c) => {
      if (c.shadow) Object.assign(c.shadow, patch)
    }, `shadow.${field}`)

  return (
    <Section
      title="Border and Shadow"
      defaultOpen={!!border || !!shadow}
      onReset={
        border || shadow
          ? () =>
              update((c) => {
                delete c.border
                delete c.shadow
              }, 'style.reset')
          : undefined
      }
    >
      <SliderRow
        label="Border"
        value={border?.width ?? 0}
        min={0}
        max={40}
        step={1}
        suffix=" px"
        reset={0}
        onChange={(width) =>
          update((c) => {
            if (width <= 0) delete c.border
            else c.border = { width, color: c.border?.color ?? '#ffffff' }
          }, 'border.width')
        }
      />
      {border && (
        <Row label="Border color">
          <ColorField
            value={border.color}
            onChange={(color) =>
              update((c) => {
                if (c.border) c.border.color = color
              }, 'border.color')
            }
          />
        </Row>
      )}
      <Row label="Shadow">
        <Switch
          checked={!!shadow}
          label="Drop shadow"
          onChange={(on) =>
            update((c) => {
              if (on) c.shadow = defaultShadow()
              else delete c.shadow
            }, 'shadow.on')
          }
        />
      </Row>
      {shadow && (
        <>
          <Row label="Shadow color">
            <ColorField value={shadow.color} onChange={(color) => setShadow({ color }, 'color')} />
          </Row>
          <SliderRow
            label="Opacity"
            value={shadow.opacity}
            min={0}
            max={1}
            display={100}
            suffix="%"
            reset={0.6}
            onChange={(opacity) => setShadow({ opacity }, 'opacity')}
          />
          <SliderRow
            label="Softness"
            value={shadow.blur}
            min={0}
            max={100}
            step={1}
            suffix=" px"
            reset={24}
            onChange={(blur) => setShadow({ blur }, 'blur')}
          />
          <SliderRow
            label="Distance"
            value={shadow.distance}
            min={0}
            max={100}
            step={1}
            suffix=" px"
            reset={12}
            onChange={(distance) => setShadow({ distance }, 'distance')}
          />
          <SliderRow
            label="Angle"
            value={shadow.angle}
            min={-180}
            max={180}
            step={1}
            suffix="°"
            reset={45}
            onChange={(angle) => setShadow({ angle }, 'angle')}
          />
        </>
      )}
    </Section>
  )
}

const ADD_OPTIONS: Array<{ value: EffectType | ''; label: string; group?: string }> = [
  { value: '', label: 'Add Effect…' },
  ...EFFECT_CATEGORIES.flatMap((category) =>
    EFFECTS.filter((e) => e.category === category).map((e) => ({
      value: e.type,
      label: e.label,
      group: category
    }))
  )
]

export function EffectsSection({ clip, update }: { clip: Clip; update: Update }) {
  const effects = clip.effects ?? []
  const edit = (id: string, recipe: (e: Draft<Effect>) => void, field: string) =>
    update((c) => {
      const effect = c.effects?.find((e) => e.id === id)
      if (effect) recipe(effect)
    }, `effects.${id}.${field}`)
  const move = (index: number, by: number) =>
    update((c) => {
      const list = c.effects
      if (!list) return
      const [effect] = list.splice(index, 1)
      list.splice(Math.max(0, Math.min(list.length, index + by)), 0, effect)
    }, `effects.move.${index}.${by}.${Date.now()}`)
  const remove = (id: string) =>
    update((c) => {
      c.effects = (c.effects ?? []).filter((e) => e.id !== id)
      if (c.effects.length === 0) delete c.effects
    }, `effects.remove.${id}`)
  const add = (type: EffectType) =>
    update((c) => {
      c.effects = [
        ...(c.effects ?? []),
        { id: uid('fx'), type, enabled: true, params: defaultEffectParams(type) }
      ]
    }, `effects.add.${Date.now()}`)

  return (
    <Section
      title={effects.length ? `Effects (${effects.length})` : 'Effects'}
      defaultOpen={effects.length > 0}
    >
      {effects.map((effect, index) => {
        const definition = effectDefinition(effect.type)
        return (
          <div key={effect.id} className={`fx-card${effect.enabled ? '' : ' is-off'}`}>
            <div className="fx-card__head">
              <span className="fx-card__name" title={definition.description}>
                {definition.label}
              </span>
              <IconButton
                size="sm"
                tip={effect.enabled ? 'Turn off' : 'Turn on'}
                onClick={() => edit(effect.id, (e) => void (e.enabled = !e.enabled), 'enabled')}
              >
                {effect.enabled ? <Eye size={13} /> : <EyeOff size={13} />}
              </IconButton>
              <IconButton size="sm" tip="Move up" disabled={index === 0} onClick={() => move(index, -1)}>
                <ArrowUp size={13} />
              </IconButton>
              <IconButton
                size="sm"
                tip="Move down"
                disabled={index === effects.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown size={13} />
              </IconButton>
              <IconButton size="sm" tip="Remove" onClick={() => remove(effect.id)}>
                <Trash2 size={13} />
              </IconButton>
            </div>
            {definition.params.map((param) =>
              param.kind === 'color' ? (
                <Row key={param.key} label={param.label}>
                  <ColorField
                    value={String(effect.params[param.key] ?? param.default)}
                    onChange={(v) => edit(effect.id, (e) => void (e.params[param.key] = v), param.key)}
                  />
                </Row>
              ) : (
                <SliderRow
                  key={param.key}
                  label={param.label}
                  value={Number(effect.params[param.key] ?? param.default)}
                  min={param.min ?? 0}
                  max={param.max ?? 1}
                  step={param.step}
                  display={param.display}
                  precision={param.precision}
                  suffix={param.suffix}
                  reset={Number(param.default)}
                  onChange={(v) => edit(effect.id, (e) => void (e.params[param.key] = v), param.key)}
                />
              )
            )}
          </div>
        )
      })}
      <Select<EffectType | ''>
        className="fx-add"
        value=""
        options={ADD_OPTIONS}
        onChange={(type) => {
          if (type) add(type)
        }}
      />
    </Section>
  )
}
