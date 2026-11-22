import { describe, expect, it } from 'vitest'
import { computeLayer } from './geometry'
import {
  areaToPixels,
  estimateBytesPerSecond,
  fitOutputSize,
  formatClock,
  isWaylandSession,
  pipTransform,
  planFiles,
  recordingFileName,
  recordingStamp,
  shortcutLabel,
  videoBitrate
} from './recording'

const mic = { deviceId: 'm', label: 'Mic', noiseSuppression: true }

describe('planFiles', () => {
  it('puts the voice with the camera when there is one', () => {
    expect(planFiles({ mode: 'camera', microphone: mic, systemAudio: false })).toEqual([
      { role: 'camera', video: 'camera', audio: 'microphone' }
    ])
    expect(planFiles({ mode: 'screen-camera', microphone: mic, systemAudio: true })).toEqual([
      { role: 'screen', video: 'screen', audio: 'system' },
      { role: 'camera', video: 'camera', audio: 'microphone' }
    ])
  })

  it('puts the voice with the screen otherwise, and gives the computer sound its own file when both are on', () => {
    expect(planFiles({ mode: 'screen', microphone: mic, systemAudio: false })).toEqual([
      { role: 'screen', video: 'screen', audio: 'microphone' }
    ])
    expect(planFiles({ mode: 'screen', microphone: null, systemAudio: true })).toEqual([
      { role: 'screen', video: 'screen', audio: 'system' }
    ])
    expect(planFiles({ mode: 'screen', microphone: mic, systemAudio: true })).toEqual([
      { role: 'screen', video: 'screen', audio: 'microphone' },
      { role: 'system-audio', video: null, audio: 'system' }
    ])
    expect(planFiles({ mode: 'screen', microphone: null, systemAudio: false })).toEqual([
      { role: 'screen', video: 'screen', audio: null }
    ])
  })

  it('ignores the computer sound without a screen', () => {
    expect(planFiles({ mode: 'camera', microphone: null, systemAudio: true })).toEqual([
      { role: 'camera', video: 'camera', audio: null }
    ])
  })
})

describe('fitOutputSize', () => {
  it('fits into a 16:9 box of the chosen height without enlarging, with even sides', () => {
    expect(fitOutputSize(3840, 2160, '1080')).toEqual({ width: 1920, height: 1080 })
    expect(fitOutputSize(2560, 1600, '1080')).toEqual({ width: 1728, height: 1080 })
    expect(fitOutputSize(1280, 720, '1080')).toEqual({ width: 1280, height: 720 })
    expect(fitOutputSize(2880, 1800, 'original')).toEqual({ width: 2880, height: 1800 })
    expect(fitOutputSize(1001, 755, 'original')).toEqual({ width: 1000, height: 754 })
    // A tall window keeps its shape and the height limit.
    expect(fitOutputSize(1080, 1920, '720')).toEqual({ width: 404, height: 720 })
  })
})

describe('areaToPixels', () => {
  it('converts fractions to an even pixel rectangle inside the frame', () => {
    expect(areaToPixels({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, 1920, 1080)).toEqual({
      left: 480,
      top: 270,
      width: 960,
      height: 540
    })
    const odd = areaToPixels({ x: 0.1001, y: 0.333, width: 0.3333, height: 0.25 }, 1920, 1080)
    for (const v of Object.values(odd)) expect(v % 2).toBe(0)
  })

  it('keeps at least 64 pixels and stays inside the frame', () => {
    const tiny = areaToPixels({ x: 0.99, y: 0.99, width: 0.001, height: 0.001 }, 1920, 1080)
    expect(tiny.width).toBe(64)
    expect(tiny.height).toBe(64)
    expect(tiny.left + tiny.width).toBeLessThanOrEqual(1920)
    expect(tiny.top + tiny.height).toBeLessThanOrEqual(1080)
  })
})

describe('videoBitrate', () => {
  it('gives about 7.5 Mbit/s for 1080p30 and more for higher quality and frame rate', () => {
    const base = videoBitrate(1920, 1080, 30, 'standard')
    expect(base).toBeGreaterThan(7e6)
    expect(base).toBeLessThan(8e6)
    expect(videoBitrate(1920, 1080, 30, 'high')).toBeGreaterThan(base * 1.5)
    const sixty = videoBitrate(1920, 1080, 60, 'standard')
    expect(sixty).toBeGreaterThan(base * 1.5)
    expect(sixty).toBeLessThan(base * 2)
  })

  it('stays within sensible limits', () => {
    expect(videoBitrate(320, 180, 30, 'standard')).toBe(1.5e6)
    expect(videoBitrate(7680, 4320, 60, 'high')).toBe(80e6)
  })
})

describe('estimateBytesPerSecond', () => {
  it('adds up the video and audio of every planned file', () => {
    const plans = planFiles({ mode: 'screen-camera', microphone: mic, systemAudio: false })
    const bytes = estimateBytesPerSecond(
      plans,
      { screen: { width: 1920, height: 1080 }, camera: { width: 1280, height: 720 } },
      30,
      'standard'
    )
    const expected =
      (videoBitrate(1920, 1080, 30, 'standard') + videoBitrate(1280, 720, 30, 'standard') + 160_000) / 8
    expect(bytes).toBe(expected)
  })
})

describe('pipTransform', () => {
  const frame = { width: 1920, height: 1080 }
  const camera = { width: 1280, height: 720 }

  for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) {
    it(`places the camera in the ${corner} corner with an even margin`, () => {
      const t = pipTransform(camera, frame, corner, 'medium')
      const layer = computeLayer(
        {
          ...t,
          rotation: 0,
          opacity: 1,
          flipH: false,
          flipV: false,
          cropLeft: 0,
          cropRight: 0,
          cropTop: 0,
          cropBottom: 0
        },
        camera.width,
        camera.height,
        frame.width,
        frame.height,
        true
      )
      expect(layer.width).toBeCloseTo(1920 * 0.27, 0)
      const left = layer.cx - layer.width / 2
      const top = layer.cy - layer.height / 2
      const margin = 38
      if (corner.endsWith('left')) expect(left).toBeCloseTo(margin, 0)
      else expect(1920 - (left + layer.width)).toBeCloseTo(margin, 0)
      if (corner.startsWith('top')) expect(top).toBeCloseTo(margin, 0)
      else expect(1080 - (top + layer.height)).toBeCloseTo(margin, 0)
    })
  }

  it('works when the camera and frame shapes differ', () => {
    const t = pipTransform({ width: 640, height: 480 }, { width: 1080, height: 1920 }, 'top-right', 'large')
    const layer = computeLayer(
      {
        ...t,
        rotation: 0,
        opacity: 1,
        flipH: false,
        flipV: false,
        cropLeft: 0,
        cropRight: 0,
        cropTop: 0,
        cropBottom: 0
      },
      640,
      480,
      1080,
      1920,
      true
    )
    expect(layer.width).toBeCloseTo(1080 * 0.36, 0)
    expect(layer.height).toBeCloseTo((1080 * 0.36 * 480) / 640, 0)
  })
})

describe('names and labels', () => {
  it('names files by time and role', () => {
    const stamp = recordingStamp(new Date(2026, 10, 21, 9, 5, 7))
    expect(stamp).toBe('2026-11-21 09.05.07')
    expect(recordingFileName(stamp, 'screen')).toBe('2026-11-21 09.05.07 Screen.mp4')
    expect(recordingFileName(stamp, 'camera')).toBe('2026-11-21 09.05.07 Camera.mp4')
    expect(recordingFileName(stamp, 'system-audio')).toBe('2026-11-21 09.05.07 Computer sound.m4a')
  })

  it('formats clocks and shortcuts', () => {
    expect(formatClock(7.9)).toBe('0:07')
    expect(formatClock(754)).toBe('12:34')
    expect(formatClock(3723)).toBe('1:02:03')
    expect(shortcutLabel('CmdOrCtrl+Shift+2', false)).toBe('Ctrl+Shift+2')
    expect(shortcutLabel('CmdOrCtrl+Shift+2', true)).toBe('⌘⇧2')
  })
})

describe('isWaylandSession', () => {
  it('needs both a Wayland session type and a Wayland display, like WebRTC', () => {
    expect(isWaylandSession({ XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' })).toBe(true)
    expect(isWaylandSession({ XDG_SESSION_TYPE: 'wayland' })).toBe(false)
    expect(isWaylandSession({ XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: 'wayland-0' })).toBe(false)
    expect(isWaylandSession({ DISPLAY: ':0' })).toBe(false)
  })
})
