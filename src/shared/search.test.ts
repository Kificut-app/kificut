import { describe, expect, it } from 'vitest'
import { findMoments } from './search'

describe('findMoments', () => {
  it('joins neighbouring matching frames and ranks moments by their best frame', () => {
    const moments = findMoments(
      [
        { key: 'a', times: [0, 2, 4, 6, 8], scores: [0.2, 0.3, 0.31, 0.2, 0.29], duration: 9 },
        { key: 'b', times: [0, 2], scores: [0.32, 0.1], duration: 3 }
      ],
      5
    )
    expect(moments).toEqual([
      { key: 'b', start: 0, end: 1, time: 0, score: 0.32 },
      { key: 'a', start: 1, end: 5, time: 4, score: 0.31 },
      { key: 'a', start: 7, end: 9, time: 8, score: 0.29 }
    ])
  })

  it('returns nothing when no frame looks like the description', () => {
    expect(findMoments([{ key: 'a', times: [0, 2], scores: [0.19, 0.2], duration: 4 }], 5)).toEqual([])
  })

  it('treats a picture as a single moment', () => {
    expect(findMoments([{ key: 'img', times: [0], scores: [0.27], duration: 0 }], 5)).toEqual([
      { key: 'img', start: 0, end: 0, time: 0, score: 0.27 }
    ])
  })

  it('keeps only the requested number of moments', () => {
    const scores = [0.3, 0.1, 0.3, 0.1, 0.3, 0.1, 0.3]
    const times = scores.map((_, i) => i * 2)
    expect(findMoments([{ key: 'a', times, scores, duration: 14 }], 2)).toHaveLength(2)
  })
})
