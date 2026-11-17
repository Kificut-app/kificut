/*
 * Turns per-frame similarity scores from footage search into moments: runs of neighbouring frames
 * that match the description, ranked by their best frame.
 */

export interface ScoredFrames {
  /** Which file the frames came from. */
  key: string
  /** Seconds into the file for each frame. Images have a single frame at 0. */
  times: number[]
  scores: number[]
  /** Length of the file in seconds, 0 for images. */
  duration: number
}

export interface Moment {
  key: string
  start: number
  end: number
  /** The best matching frame in the moment. */
  time: number
  score: number
}

/** How far below the best match a frame can score and still count as part of the result. */
export const MATCH_MARGIN = 0.035
/** CLIP similarities below this are noise for any description. */
export const MIN_SCORE = 0.21

export function findMoments(files: ScoredFrames[], limit: number): Moment[] {
  const best = Math.max(-1, ...files.flatMap((f) => f.scores))
  const threshold = Math.max(MIN_SCORE, best - MATCH_MARGIN)
  const moments: Moment[] = []
  for (const file of files) {
    const step = file.times.length > 1 ? file.times[1] - file.times[0] : 0
    let run: Moment | null = null
    file.scores.forEach((score, i) => {
      const time = file.times[i]
      if (score < threshold) {
        run = null
        return
      }
      if (!run) {
        run = { key: file.key, start: time, end: time, time, score }
        moments.push(run)
      }
      run.end = time
      if (score > run.score) {
        run.score = score
        run.time = time
      }
    })
    // Widen each run by half a step either side, within the file.
    for (const moment of moments) {
      if (moment.key !== file.key || file.duration <= 0) continue
      moment.start = Math.max(0, moment.start - step / 2)
      moment.end = Math.min(file.duration, moment.end + step / 2)
    }
  }
  return moments.sort((a, b) => b.score - a.score).slice(0, limit)
}
