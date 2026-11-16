import { useEffect, useState } from 'react'
import type { Filmstrip, MediaItem, Waveform } from '@shared/types'
import { useEditor } from '../store/editor'

export function mediaUrl(path: string): string {
  return `media://local/${encodeURIComponent(path)}`
}

/** The file the preview should read: the proxy once it exists, otherwise the original. */
export function previewPath(media: MediaItem): string {
  const proxy = useEditor.getState().proxies[media.path]
  return proxy?.state === 'ready' && proxy.path ? proxy.path : media.path
}

const PLAYABLE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1', 'hevc'])
const PLAYABLE_AUDIO = new Set([
  'aac',
  'mp3',
  'opus',
  'vorbis',
  'flac',
  'pcm_s16le',
  'pcm_s24le',
  'pcm_s32le',
  'pcm_f32le',
  'pcm_u8'
])
const PLAYABLE_CONTAINERS = ['mp4', 'mov', 'matroska', 'webm', 'mp3', 'wav', 'ogg', 'flac', 'aac']

let hevcSupport: boolean | null = null
function canPlayHevc(): boolean {
  if (hevcSupport === null) {
    const probe = document.createElement('video')
    hevcSupport = probe.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"') !== ''
  }
  return hevcSupport
}

export function needsProxy(media: MediaItem, proxyAboveHeight: number): boolean {
  if (media.kind === 'image') return false
  const containerOk = PLAYABLE_CONTAINERS.some((c) => media.container.split(',').includes(c))
  if (!containerOk) return true
  if (media.hasAudio && media.audioCodec && !PLAYABLE_AUDIO.has(media.audioCodec)) return true
  if (media.kind === 'audio') return false
  if (!media.videoCodec || !PLAYABLE_VIDEO.has(media.videoCodec)) return true
  if (media.videoCodec === 'hevc' && !canPlayHevc()) return true
  return proxyAboveHeight > 0 && Math.min(media.width, media.height) > proxyAboveHeight
}

const posterCache = new Map<string, Promise<string | null>>()

export function loadPoster(media: MediaItem): Promise<string | null> {
  const key = media.path
  let job = posterCache.get(key)
  if (!job) {
    job = window.kificut.media.poster(media.path, media.duration).then((p) => (p ? mediaUrl(p) : null))
    posterCache.set(key, job)
  }
  return job
}

export function usePoster(media: MediaItem | undefined, offline: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!media || offline || media.kind === 'audio') return
    let alive = true
    void loadPoster(media).then((value) => alive && setUrl(value))
    return () => {
      alive = false
    }
  }, [media, offline])
  return media && !offline && media.kind !== 'audio' ? url : null
}

type Entry<T> = { value: T | null; promise: Promise<T | null> | null; listeners: Set<() => void> }

function createResourceCache<T>(load: (media: MediaItem) => Promise<T | null>) {
  const entries = new Map<string, Entry<T>>()

  function entry(media: MediaItem): Entry<T> {
    let e = entries.get(media.path)
    if (!e) {
      e = { value: null, promise: null, listeners: new Set() }
      entries.set(media.path, e)
    }
    if (!e.promise) {
      const current = e
      current.promise = load(media).then((value) => {
        current.value = value
        current.listeners.forEach((l) => l())
        return value
      })
    }
    return e
  }

  return function useResource(media: MediaItem | undefined, enabled: boolean): T | null {
    const [, force] = useState(0)
    useEffect(() => {
      if (!media || !enabled) return
      const e = entry(media)
      const listener = () => force((n) => n + 1)
      e.listeners.add(listener)
      return () => {
        e.listeners.delete(listener)
      }
    }, [media, enabled])
    if (!media || !enabled) return null
    return entries.get(media.path)?.value ?? null
  }
}

export const useFilmstrip = createResourceCache<Filmstrip>((media) =>
  window.kificut.media.filmstrip(media.path, media.duration)
)

export const useWaveform = createResourceCache<Waveform>((media) => window.kificut.media.waveform(media.path))
