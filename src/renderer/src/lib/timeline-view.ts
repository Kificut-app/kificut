/** Shared handle on the timeline scroller, so actions like zoom-to-fit can read its size. */
export const HEADER_WIDTH = 188
export const RULER_HEIGHT = 30
export const VIDEO_TRACK_HEIGHT = 66
export const AUDIO_TRACK_HEIGHT = 54

export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 1200

export const timelineView = {
  element: null as HTMLDivElement | null,
  /** A scroll position to apply after the next render, used to keep a point fixed while zooming. */
  pendingScrollLeft: null as number | null,

  viewportWidth(): number {
    return this.element ? Math.max(100, this.element.clientWidth - HEADER_WIDTH) : 900
  },

  scrollLeft(): number {
    return this.element?.scrollLeft ?? 0
  }
}
