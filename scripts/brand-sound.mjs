// Renders the Kificut sound logo and theme from code, so the music can be edited and rebuilt.
// Run with `npm run brand:sound`. Output goes to brand/sound.
//
// The motif follows the name: "ki" and "fi" are two quick notes (A4, D5) and "cut" lands on E5
// with a snap and a Dmaj9 chord behind it. The theme builds a short track around that motif and
// ends on the exact sound logo.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const FFMPEG = require('ffmpeg-static')
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'brand', 'sound')
const TEMP = mkdtempSync(join(tmpdir(), 'kificut-sound-'))

const SR = 48000
const TAU = Math.PI * 2
const TARGET_LUFS = -16
const CEILING_DB = -1.5

const BPM = 110
const BEAT = 60 / BPM
const BAR = BEAT * 4
const SIXTEENTH = BEAT / 4

/* Building blocks */

const mtof = (note) => 440 * 2 ** ((note - 69) / 12)
const at = (seconds) => Math.round(seconds * SR)
const dbToGain = (db) => 10 ** (db / 20)

function seeded(seed) {
  let s = seed
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let random = seeded(2026)
const noise = () => random() * 2 - 1

class Bus {
  constructor(seconds) {
    const n = Math.ceil(seconds * SR)
    this.L = new Float32Array(n)
    this.R = new Float32Array(n)
  }

  get length() {
    return this.L.length
  }

  add(i, l, r) {
    if (i >= 0 && i < this.L.length) {
      this.L[i] += l
      this.R[i] += r
    }
  }

  mixInto(target, gain = 1) {
    for (let i = 0; i < this.length; i++) {
      target.L[i] += this.L[i] * gain
      target.R[i] += this.R[i] * gain
    }
  }

  rms(from = 0, to = this.length) {
    let sum = 0
    for (let i = from; i < to; i++) sum += (this.L[i] ** 2 + this.R[i] ** 2) / 2
    return Math.sqrt(sum / Math.max(1, to - from))
  }
}

function panGains(pan) {
  const a = ((pan + 1) * Math.PI) / 4
  return [Math.cos(a), Math.sin(a)]
}

class Biquad {
  constructor(type, freq, q = 0.707) {
    this.x1 = this.x2 = this.y1 = this.y2 = 0
    this.set(type, freq, q)
  }

  set(type, freq, q = 0.707) {
    const w = (TAU * Math.min(freq, SR * 0.45)) / SR
    const cos = Math.cos(w)
    const alpha = Math.sin(w) / (2 * q)
    let b0, b1, b2
    if (type === 'lowpass') [b0, b1, b2] = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2]
    else if (type === 'highpass') [b0, b1, b2] = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2]
    else [b0, b1, b2] = [alpha, 0, -alpha]
    const a0 = 1 + alpha
    this.b0 = b0 / a0
    this.b1 = b1 / a0
    this.b2 = b2 / a0
    this.a1 = (-2 * cos) / a0
    this.a2 = (1 - alpha) / a0
  }

  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
    this.x2 = this.x1
    this.x1 = x
    this.y2 = this.y1
    this.y1 = y
    return y
  }
}

/** Band limited sawtooth tables, one per harmonic count, so high notes do not alias. */
const TABLE_SIZE = 2048
const sawTables = new Map()

function sawTable(freq) {
  const harmonics = Math.max(1, Math.min(64, Math.floor(16000 / freq)))
  let table = sawTables.get(harmonics)
  if (!table) {
    table = new Float32Array(TABLE_SIZE + 1)
    for (let i = 0; i <= TABLE_SIZE; i++) {
      let s = 0
      for (let k = 1; k <= harmonics; k++) s += Math.sin((TAU * k * i) / TABLE_SIZE) / k
      table[i] = s * 0.55
    }
    sawTables.set(harmonics, table)
  }
  return table
}

function readTable(table, phase) {
  const p = phase * TABLE_SIZE
  const i = p | 0
  return table[i] + (table[i + 1] - table[i]) * (p - i)
}

/** Short fade at the very end of a rendered note so nothing ever stops on a click. */
const tail = (i, n) => Math.min(1, (n - i) / at(0.012))

/* Instruments */

/** Glassy FM bell used for the motif and the lead melody. */
function bell(bus, t0, note, { vel = 0.4, length = 0.5, decay = 0.9, pan = 0, bright = 1 } = {}) {
  const f = mtof(note)
  const start = at(t0)
  const n = at(length + 1.6)
  const [gl, gr] = panGains(pan)
  const spread = 2 ** (4 / 1200)
  const voice = (freq, t, index) =>
    Math.sin(TAU * freq * t + index * Math.sin(TAU * 2 * freq * t)) +
    0.16 * Math.exp(-t / 0.07) * Math.sin(TAU * 4.007 * freq * t)

  for (let i = 0; i < n; i++) {
    const t = i / SR
    const release = t > length ? Math.exp(-(t - length) / 0.22) : 1
    const amp = vel * Math.min(1, t / 0.003) * Math.exp(-t / decay) * release * tail(i, n)
    if (amp < 1e-5 && t > 0.05) break
    const index = bright * 1.5 * Math.exp(-t / 0.2)
    bus.add(start + i, voice(f / spread, t, index) * amp * gl, voice(f * spread, t, index) * amp * gr)
  }
}

/** Harp-like pluck for arpeggios: decaying harmonics, brighter at the start. */
function pluck(bus, t0, note, { vel = 0.2, pan = 0 } = {}) {
  const f = mtof(note)
  const start = at(t0)
  const n = at(2)
  const [gl, gr] = panGains(pan)
  const harmonics = Math.min(9, Math.floor(12000 / f))
  for (let i = 0; i < n; i++) {
    const t = i / SR
    if (t > 0.2 && Math.exp(-t * 3.4) < 2e-4) break
    let s = 0
    for (let k = 1; k <= harmonics; k++)
      s += (Math.sin(TAU * k * f * t) * Math.exp(-t * (1.8 + k * 1.6))) / k ** 1.4
    const amp = vel * Math.min(1, t / 0.002) * tail(i, n)
    bus.add(start + i, s * amp * gl, s * amp * gr)
  }
}

/** Warm pad from detuned band limited saws through a low pass filter. */
function pad(bus, t0, length, notes, { vel = 0.12, attack = 0.6, release = 1.2, cutoff = 1500 } = {}) {
  const start = at(t0)
  const n = at(length + release * 1.6)
  const voices = []
  for (const note of notes) {
    for (const [cents, pan] of [
      [-9, -0.65],
      [0, 0],
      [8, 0.65]
    ]) {
      const f = mtof(note) * 2 ** (cents / 1200)
      voices.push({ f, table: sawTable(f), phase: random(), gains: panGains(pan) })
    }
  }
  const lp = [new Biquad('lowpass', cutoff, 0.6), new Biquad('lowpass', cutoff, 0.6)]
  const norm = vel / Math.sqrt(voices.length)
  for (let i = 0; i < n; i++) {
    const t = i / SR
    let l = 0
    let r = 0
    for (const v of voices) {
      const s = readTable(v.table, v.phase)
      v.phase += v.f / SR
      if (v.phase >= 1) v.phase -= 1
      l += s * v.gains[0]
      r += s * v.gains[1]
    }
    const rise = Math.sin(Math.min(1, t / attack) * (Math.PI / 2)) ** 2
    const env = rise * (t > length ? Math.exp(-(t - length) / (release / 3)) : 1) * tail(i, n) * norm
    bus.add(start + i, lp[0].process(l) * env, lp[1].process(r) * env)
  }
}

function bass(bus, t0, length, note, { vel = 0.4 } = {}) {
  const f = mtof(note)
  const table = sawTable(f)
  const start = at(t0)
  const n = at(length + 0.15)
  const lp = new Biquad('lowpass', 380, 0.9)
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const gate = t > length ? Math.exp(-(t - length) / 0.02) : 1
    const env = Math.min(1, t / 0.004) * (0.75 + 0.25 * Math.exp(-t / 0.12)) * gate * tail(i, n)
    const s = Math.sin(TAU * phase) * 0.85 + lp.process(readTable(table, phase)) * 0.55
    phase = (phase + f / SR) % 1
    const y = Math.tanh(s * 1.3) * env * vel
    bus.add(start + i, y, y)
  }
}

/** Low sine with a slight drop, giving the logo's "cut" some weight. */
function thump(bus, t0, note, { vel = 0.5 } = {}) {
  const f = mtof(note)
  const start = at(t0)
  const n = at(0.8)
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / SR
    phase += (f * (1 + 0.6 * Math.exp(-t / 0.03))) / SR
    const y = Math.sin(TAU * phase) * Math.exp(-t / 0.16) * Math.min(1, t / 0.002) * vel * tail(i, n)
    bus.add(start + i, y, y)
  }
}

function kick(bus, t0, { vel = 0.8 } = {}) {
  const start = at(t0)
  const n = at(0.9)
  const hp = new Biquad('highpass', 3000)
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / SR
    phase += (46 + 120 * Math.exp(-t / 0.03)) / SR
    const body = Math.sin(TAU * phase) * Math.exp(-t / 0.2) * Math.min(1, t / 0.001)
    const click = hp.process(noise()) * Math.exp(-t / 0.004) * 0.3
    const y = Math.tanh((body + click) * 1.5) * vel * tail(i, n)
    bus.add(start + i, y, y)
  }
}

/**
 * The brand sound: a tight clap-like snap. With `crisp` it gets a short metallic ping on top,
 * which reads as a scissor cut in the logo.
 */
function snap(bus, t0, { vel = 0.5, tone = 2600, crisp = 0, pan = 0 } = {}) {
  const start = at(t0)
  const n = at(0.4)
  const [gl, gr] = panGains(pan)
  const bp = new Biquad('bandpass', tone, 1.1)
  const hp = new Biquad('highpass', 900)
  for (let i = 0; i < n; i++) {
    const t = i / SR
    let env = 0.55 * Math.exp(-t / 0.05)
    for (const d of [0, 0.006, 0.013]) if (t >= d) env = Math.max(env, Math.exp(-(t - d) / 0.006))
    let y = hp.process(bp.process(noise())) * env * 3
    if (crisp) {
      y += crisp * (0.6 * Math.sin(TAU * 3150 * t) + 0.4 * Math.sin(TAU * 4730 * t)) * Math.exp(-t / 0.035)
    }
    y *= vel * tail(i, n)
    bus.add(start + i, y * gl, y * gr)
  }
}

function hat(bus, t0, { vel = 0.1, open = false, pan = 0.25 } = {}) {
  const start = at(t0)
  const n = at(open ? 0.6 : 0.15)
  const [gl, gr] = panGains(pan)
  const hp1 = new Biquad('highpass', 7200, 0.8)
  const hp2 = new Biquad('highpass', 7200, 0.8)
  const decay = open ? 0.17 : 0.026
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const y = hp2.process(hp1.process(noise())) * Math.exp(-t / decay) * vel * 2 * tail(i, n)
    bus.add(start + i, y * gl, y * gr)
  }
}

/** Filtered noise sweep that builds into the next section. */
function riser(bus, t0, length, { vel = 0.15 } = {}) {
  const start = at(t0)
  const n = at(length)
  const bp = [new Biquad('bandpass', 300, 2.2), new Biquad('bandpass', 300, 2.2)]
  for (let i = 0; i < n; i++) {
    const p = i / n
    if (i % 32 === 0) {
      const fc = 300 * 20 ** p
      bp[0].set('bandpass', fc, 2.2)
      bp[1].set('bandpass', fc * 1.06, 2.2)
    }
    const env = vel * p * p * tail(i, n) * 4
    bus.add(start + i, bp[0].process(noise()) * env, bp[1].process(noise()) * env)
  }
}

/* Effects */

/** Ping-pong delay. Returns only the wet signal. */
function pingPong(input, delay, feedback, toneHz = 3500) {
  const out = new Bus(input.length / SR)
  const d = at(delay)
  const lineL = new Float32Array(d)
  const lineR = new Float32Array(d)
  const lp = [new Biquad('lowpass', toneHz), new Biquad('lowpass', toneHz)]
  let k = 0
  for (let i = 0; i < input.length; i++) {
    const l = lineL[k]
    const r = lineR[k]
    lineL[k] = lp[0].process((input.L[i] + input.R[i]) * 0.5 + r * feedback)
    lineR[k] = lp[1].process(l * feedback)
    out.L[i] = l
    out.R[i] = r
    k = (k + 1) % d
  }
  return out
}

class Comb {
  constructor(size) {
    this.buf = new Float32Array(size)
    this.i = 0
    this.store = 0
  }

  process(x, feedback, damp) {
    const y = this.buf[this.i]
    this.store = y * (1 - damp) + this.store * damp
    this.buf[this.i] = x + this.store * feedback
    if (++this.i >= this.buf.length) this.i = 0
    return y
  }
}

class AllPass {
  constructor(size) {
    this.buf = new Float32Array(size)
    this.i = 0
  }

  process(x) {
    const b = this.buf[this.i]
    this.buf[this.i] = x + b * 0.5
    if (++this.i >= this.buf.length) this.i = 0
    return b - x
  }
}

/** Freeverb style plate with a short pre-delay. Returns only the wet signal. */
function reverb(input, { room = 0.82, damp = 0.3, predelay = 0.02 } = {}) {
  const out = new Bus(input.length / SR)
  const scale = SR / 44100
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]
  const allpasses = [556, 441, 341, 225]
  const make = (spread) => ({
    combs: combs.map((s) => new Comb(Math.round((s + spread) * scale))),
    allpasses: allpasses.map((s) => new AllPass(Math.round((s + spread) * scale)))
  })
  const left = make(0)
  const right = make(23)
  const feedback = room * 0.28 + 0.7
  const dampening = damp * 0.4
  const hp = new Biquad('highpass', 250)
  const pre = at(predelay)
  for (let i = 0; i < input.length; i++) {
    const j = i - pre
    const x = hp.process(j >= 0 ? (input.L[j] + input.R[j]) * 0.015 : 0)
    let l = 0
    let r = 0
    for (const c of left.combs) l += c.process(x, feedback, dampening)
    for (const c of right.combs) r += c.process(x, feedback, dampening)
    for (const a of left.allpasses) l = a.process(l)
    for (const a of right.allpasses) r = a.process(r)
    out.L[i] = l
    out.R[i] = r
  }
  return out
}

/** Pumps a bus down after each kick so the low end stays clear. */
function duck(bus, times, depth, release = 0.18) {
  const gain = new Float32Array(bus.length).fill(1)
  for (const time of times) {
    const from = at(time)
    const to = Math.min(bus.length, from + at(release * 5))
    for (let i = from; i < to; i++) {
      const t = (i - from) / SR
      gain[i] = Math.min(gain[i], 1 - depth * Math.min(1, t / 0.005) * Math.exp(-t / release))
    }
  }
  for (let i = 0; i < bus.length; i++) {
    bus.L[i] *= gain[i]
    bus.R[i] *= gain[i]
  }
}

/** Look ahead peak limiter. Only shaves the loudest transients after loudness matching. */
function limit(bus, ceilingDb) {
  const ceiling = dbToGain(ceilingDb)
  const look = at(0.005)
  const n = bus.length
  const need = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const peak = Math.max(Math.abs(bus.L[i]), Math.abs(bus.R[i]))
    need[i] = peak > ceiling ? ceiling / peak : 1
  }
  const attack = Math.exp(-1 / (look / 3))
  const release = Math.exp(-1 / at(0.08))
  let g = 1
  for (let i = 0; i < n; i++) {
    let target = 1
    for (let j = i; j < Math.min(n, i + look); j++) if (need[j] < target) target = need[j]
    g = target < g ? target + (g - target) * attack : target + (g - target) * release
    const applied = Math.min(g, need[i])
    bus.L[i] *= applied
    bus.R[i] *= applied
  }
}

/* Output */

function writeWav(path, bus) {
  const n = bus.length
  const data = Buffer.alloc(n * 8)
  for (let i = 0; i < n; i++) {
    data.writeFloatLE(bus.L[i], i * 8)
    data.writeFloatLE(bus.R[i], i * 8 + 4)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(3, 20)
  header.writeUInt16LE(2, 22)
  header.writeUInt32LE(SR, 24)
  header.writeUInt32LE(SR * 8, 28)
  header.writeUInt16LE(8, 32)
  header.writeUInt16LE(32, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  writeFileSync(path, Buffer.concat([header, data]))
}

function ffmpeg(args) {
  const result = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stderr
}

function measure(bus) {
  const path = join(TEMP, 'measure.wav')
  writeWav(path, bus)
  const log = ffmpeg(['-nostats', '-i', path, '-af', 'ebur128=peak=true', '-f', 'null', '-'])
  const summary = log.slice(log.lastIndexOf('Summary:'))
  return {
    lufs: parseFloat(/I:\s+(-?[\d.]+) LUFS/.exec(summary)[1]),
    truePeak: parseFloat(/Peak:\s+(-?[\d.]+) dBFS/.exec(summary)[1])
  }
}

function scale(bus, gain) {
  for (let i = 0; i < bus.length; i++) {
    bus.L[i] *= gain
    bus.R[i] *= gain
  }
}

/** Removes DC, adds gentle saturation, matches loudness and limits peaks. */
function master(mix) {
  const hp = [new Biquad('highpass', 22), new Biquad('highpass', 22)]
  for (let i = 0; i < mix.length; i++) {
    mix.L[i] = Math.tanh(hp[0].process(mix.L[i]) * 1.1) / Math.tanh(1.1)
    mix.R[i] = Math.tanh(hp[1].process(mix.R[i]) * 1.1) / Math.tanh(1.1)
  }
  for (let pass = 0; pass < 3; pass++) {
    const { lufs } = measure(mix)
    if (Math.abs(lufs - TARGET_LUFS) < 0.2) break
    scale(mix, dbToGain(TARGET_LUFS - lufs))
    limit(mix, CEILING_DB)
  }
  const fade = at(0.05)
  for (let i = 0; i < fade; i++) {
    const g = i / fade
    mix.L[mix.length - 1 - i] *= g
    mix.R[mix.length - 1 - i] *= g
  }
  return measure(mix)
}

function exportAudio(name, title, mix) {
  const raw = join(TEMP, `${name}.wav`)
  writeWav(raw, mix)
  const meta = [
    '-metadata',
    `title=${title}`,
    '-metadata',
    'artist=Kificut',
    '-metadata',
    'album=Kificut brand sound'
  ]
  ffmpeg(['-y', '-i', raw, '-c:a', 'pcm_s24le', ...meta, join(OUT, `${name}.wav`)])
  ffmpeg(['-y', '-i', raw, '-c:a', 'libmp3lame', '-b:a', '320k', ...meta, join(OUT, `${name}.mp3`)])
}

/* Arrangement */

function createBuses(seconds) {
  return {
    lead: new Bus(seconds),
    arp: new Bus(seconds),
    pad: new Bus(seconds),
    bass: new Bus(seconds),
    drums: new Bus(seconds),
    fx: new Bus(seconds)
  }
}

/** The sound logo itself. Used on its own and as the last bar of the theme. */
function logo(b, t0, level = 1) {
  bell(b.lead, t0, 69, { vel: 0.3 * level, length: 0.12, pan: -0.15 })
  bell(b.lead, t0 + SIXTEENTH, 74, { vel: 0.34 * level, length: 0.12, pan: 0.15 })
  const hit = t0 + SIXTEENTH * 2
  snap(b.drums, hit, { vel: 0.55 * level, tone: 4200, crisp: 0.22 })
  bell(b.lead, hit, 76, { vel: 0.5 * level, length: 1.5, decay: 1.4 })
  bell(b.lead, hit + 0.07, 90, { vel: 0.07 * level, length: 0.9, decay: 0.7, pan: 0.45 })
  pad(b.pad, hit - 0.01, 1.3, [50, 57, 61, 64, 66], {
    vel: 0.17 * level,
    attack: 0.12,
    release: 1.8,
    cutoff: 2200
  })
  thump(b.bass, hit, 38, { vel: 0.22 * level })
}

/** Applies delay and reverb sends and sums the buses. */
function mixBuses(b, seconds, gains, { delayFeedback = 0.32 } = {}) {
  const mix = new Bus(seconds)
  const leadDelay = pingPong(b.lead, BEAT * 0.75, delayFeedback)
  const arpDelay = pingPong(b.arp, BEAT * 0.75, 0.3)

  const send = new Bus(seconds)
  b.lead.mixInto(send, gains.lead * 0.45)
  leadDelay.mixInto(send, gains.lead * 0.2)
  b.arp.mixInto(send, gains.arp * 0.4)
  b.pad.mixInto(send, gains.pad * 0.5)
  b.drums.mixInto(send, gains.drums * 0.12)
  b.fx.mixInto(send, gains.fx * 0.4)
  const space = reverb(send)

  b.lead.mixInto(mix, gains.lead)
  leadDelay.mixInto(mix, gains.lead * 0.28)
  b.arp.mixInto(mix, gains.arp)
  arpDelay.mixInto(mix, gains.arp * 0.35)
  b.pad.mixInto(mix, gains.pad)
  b.bass.mixInto(mix, gains.bass)
  b.drums.mixInto(mix, gains.drums)
  b.fx.mixInto(mix, gains.fx)
  space.mixInto(mix, 1)
  return mix
}

function renderLogo() {
  random = seeded(2026)
  const seconds = 3.2
  const b = createBuses(seconds)
  logo(b, 0.02)
  const mix = mixBuses(
    b,
    seconds,
    { lead: 1, arp: 1, pad: 1, bass: 1, drums: 0.9, fx: 1 },
    { delayFeedback: 0.22 }
  )
  return mix
}

const CHORDS = {
  D: { pad: [57, 61, 64, 66, 69], bass: 38, arp: [62, 66, 69, 73] },
  Bm: { pad: [54, 57, 62, 64, 66], bass: 35, arp: [59, 62, 66, 69] },
  G: { pad: [54, 57, 59, 62, 66], bass: 31, arp: [59, 62, 66, 69] },
  A: { pad: [52, 57, 59, 61, 64], bass: 33, arp: [57, 61, 64, 69] },
  Fm: { pad: [52, 57, 61, 64], bass: 30, arp: [57, 61, 64, 66] },
  Asus: { pad: [52, 57, 59, 62, 64], bass: 33, arp: [57, 62, 64, 69] }
}

// [bar, beat, chord, length in beats]
const PROGRESSION = [
  [0, 0, 'D', 8],
  ...['D', 'Bm', 'G', 'A', 'D', 'Bm', 'G', 'A'].map((c, i) => [2 + i, 0, c, 4]),
  ...['G', 'A', 'Fm', 'Bm', 'G', 'A', 'Bm'].map((c, i) => [10 + i, 0, c, 4]),
  [17, 0, 'Asus', 2],
  [17, 2, 'A', 2],
  [18, 0, 'Asus', 4]
]

// [bar, beat, note, length in beats]
const MOTIF_D = [
  [0, 69, 0.25],
  [0.25, 74, 0.25],
  [0.5, 76, 1.5],
  [2.5, 78, 0.5],
  [3, 76, 0.5],
  [3.5, 73, 0.5]
]
const MOTIF_G = [
  [0, 71, 0.25],
  [0.25, 76, 0.25],
  [0.5, 78, 1.5],
  [2.5, 81, 0.5],
  [3, 78, 0.5],
  [3.5, 76, 0.5]
]
const MELODY = [
  ...MOTIF_D.map((n) => [2, ...n]),
  [3, 0, 74, 1],
  [3, 1.5, 71, 0.5],
  [3, 2, 69, 1.5],
  ...MOTIF_G.map((n) => [4, ...n]),
  [5, 0, 76, 1.5],
  [5, 1.5, 73, 0.5],
  [5, 2, 71, 0.5],
  [5, 2.5, 69, 1.5],
  ...MOTIF_D.map((n) => [6, ...n]),
  [7, 0, 74, 1],
  [7, 1.5, 78, 0.5],
  [7, 2, 76, 1.5],
  ...MOTIF_G.map((n) => [8, ...n]),
  [9, 0, 73, 0.5],
  [9, 0.5, 76, 0.5],
  [9, 1, 81, 2],
  // Second section, higher and more open
  [10, 0, 83, 1],
  [10, 1, 81, 0.5],
  [10, 1.5, 78, 0.5],
  [10, 2, 74, 1],
  [10, 3, 76, 1],
  [11, 0, 76, 1.5],
  [11, 1.5, 78, 0.5],
  [11, 2, 76, 2],
  [12, 0, 81, 1],
  [12, 1, 78, 0.5],
  [12, 1.5, 76, 0.5],
  [12, 2, 73, 2],
  [13, 0, 74, 0.5],
  [13, 0.5, 78, 0.5],
  [13, 1, 81, 1],
  [13, 2, 78, 1],
  [13, 3, 74, 1],
  // The motif again, now in G: D, G, A
  [14, 0, 74, 0.25],
  [14, 0.25, 79, 0.25],
  [14, 0.5, 81, 1.5],
  [14, 2.5, 83, 0.5],
  [14, 3, 81, 0.5],
  [14, 3.5, 78, 0.5],
  [15, 0, 76, 1],
  [15, 1, 73, 0.5],
  [15, 1.5, 76, 0.5],
  [15, 2, 81, 2],
  [16, 0, 78, 1],
  [16, 1, 76, 0.5],
  [16, 1.5, 74, 0.5],
  [16, 2, 71, 1],
  [16, 3, 74, 1],
  [17, 0, 76, 2],
  [17, 2, 74, 1],
  [17, 3, 73, 1]
]

const ARP_PATTERN = [0, 1, 2, 3, 1, 2, 3, 2]

function renderTheme() {
  random = seeded(110)
  const time = (bar, beat = 0) => bar * BAR + beat * BEAT
  const logoBar = 19
  const seconds = time(logoBar) + 3.4
  const b = createBuses(seconds)
  const kicks = []

  for (const [bar, beat, name, beats] of PROGRESSION) {
    const chord = CHORDS[name]
    const intro = bar === 0
    pad(b.pad, time(bar, beat), beats * BEAT, chord.pad, {
      vel: intro ? 0.1 : 0.12,
      attack: intro ? 2.5 : 0.25,
      release: 1.1,
      cutoff: intro ? 900 : bar >= 10 ? 1900 : 1500
    })

    const groove = bar >= 2 && bar <= 17
    if (groove) {
      for (const [b0, len, offset] of [
        [0, 0.8, 0],
        [1.5, 0.4, 0],
        [2, 0.8, 0],
        [3, 0.4, 7],
        [3.5, 0.4, 12]
      ]) {
        if (b0 < beat || b0 >= beat + beats) continue
        bass(b.bass, time(bar, b0), len * BEAT, chord.bass + offset, { vel: 0.42 })
      }
    }

    const arps = (bar >= 6 && bar <= 9) || (bar >= 10 && bar <= 17)
    if (arps) {
      const steps = beats * 4
      for (let s = 0; s < steps; s++) {
        const note = chord.arp[ARP_PATTERN[s % ARP_PATTERN.length]] + 12
        const accent = s % 4 === 0 ? 1 : 0.7
        pluck(b.arp, time(bar, beat) + s * SIXTEENTH, note, {
          vel: (bar >= 10 ? 0.16 : 0.09) * accent,
          pan: s % 2 ? 0.45 : -0.45
        })
      }
    }
  }
  bass(b.bass, time(18), BAR * 0.9, 33, { vel: 0.38 })

  for (const [bar, beat, note, beats] of MELODY) {
    bell(b.lead, time(bar, beat), note, { vel: 0.3, length: beats * BEAT * 0.9, decay: 1.1, pan: 0 })
    if (bar >= 10) {
      bell(b.lead, time(bar, beat), note - 12, {
        vel: 0.11,
        length: beats * BEAT * 0.9,
        decay: 1.1,
        pan: -0.3,
        bright: 0.6
      })
    }
  }
  // A quiet hint of the motif over the intro pad.
  bell(b.lead, time(0, 2), 69, { vel: 0.12, length: 0.12 })
  bell(b.lead, time(0, 2.25), 74, { vel: 0.13, length: 0.12 })
  bell(b.lead, time(0, 2.5), 76, { vel: 0.16, length: 1.2, decay: 1.6 })

  for (let bar = 2; bar <= 17; bar++) {
    const lifted = bar >= 10
    const kickBeats = lifted && bar % 2 === 1 ? [0, 2, 2.5] : [0, 2]
    for (const beat of kickBeats) {
      kick(b.drums, time(bar, beat), { vel: lifted ? 0.85 : 0.6 })
      kicks.push(time(bar, beat))
    }
    for (const beat of [1, 3]) snap(b.drums, time(bar, beat), { vel: lifted ? 0.5 : 0.33, tone: 2600 })
    const steps = lifted ? 16 : 8
    for (let s = 0; s < steps; s++) {
      const beat = (s * 4) / steps
      const offbeat = beat % 1 === 0.5
      if (lifted && bar % 2 === 1 && beat === 3.5) {
        hat(b.drums, time(bar, beat), { vel: 0.09, open: true })
        continue
      }
      const level = lifted ? 1 : 0.65
      hat(b.drums, time(bar, beat), { vel: (offbeat ? 0.1 : 0.055) * level, pan: s % 2 ? 0.3 : 0.15 })
    }
  }
  // Fill into the second section, and a lone kick to start the breakdown.
  snap(b.drums, time(9, 3.5), { vel: 0.35, tone: 3000 })
  snap(b.drums, time(9, 3.75), { vel: 0.42, tone: 3400 })
  kick(b.drums, time(18), { vel: 0.7 })
  kicks.push(time(18))

  riser(b.fx, time(1), BAR, { vel: 0.12 })
  riser(b.fx, time(9, 2), BAR / 2, { vel: 0.1 })
  riser(b.fx, time(18), BAR, { vel: 0.16 })

  duck(b.pad, kicks, 0.35)
  duck(b.arp, kicks, 0.25)
  duck(b.bass, kicks, 0.3, 0.1)

  logo(b, time(logoBar), 1.25)

  // Balance the stems over the busiest section so the mix holds together.
  const from = at(time(10))
  const to = at(time(18))
  const targets = { drums: -14, bass: -16, lead: -17, pad: -23, arp: -24 }
  const gains = { fx: 1 }
  for (const [name, db] of Object.entries(targets)) {
    gains[name] = dbToGain(db) / Math.max(1e-6, b[name].rms(from, to))
  }
  return mixBuses(b, seconds, gains)
}

/* Main */

mkdirSync(OUT, { recursive: true })
try {
  for (const [name, title, render] of [
    ['kificut-sound-logo', 'Kificut sound logo', renderLogo],
    ['kificut-theme', 'Kificut theme', renderTheme]
  ]) {
    const started = Date.now()
    const mix = render()
    const { lufs, truePeak } = master(mix)
    exportAudio(name, title, mix)
    const seconds = (mix.length / SR).toFixed(2)
    console.log(`${name}: ${seconds}s, ${lufs} LUFS, true peak ${truePeak} dBFS (${Date.now() - started} ms)`)
  }
} finally {
  rmSync(TEMP, { recursive: true, force: true })
}
