import { describe, expect, spyOn, test } from 'bun:test'
import { MessageDeduplicator } from './execution.js'

describe('MessageDeduplicator', () => {
  test('retains completed entries until TTL and evicts oldest at capacity without evicting active entries', () => {
    let now = 1000
    const clock = spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const cache = new MessageDeduplicator(100, 2)
      expect(cache.reserve(['a'])).toBe(true)
      expect(cache.has('a')).toBe(true)
      cache.complete(['a'])
      now += 1
      expect(cache.reserve(['b'])).toBe(true); cache.complete(['b'])
      expect(cache.reserve(['c'])).toBe(true)
      expect(cache.has('a')).toBe(false); expect(cache.has('b')).toBe(true); expect(cache.has('c')).toBe(true)
      expect(cache.reserve(['d', 'e'])).toBe(false)
      cache.complete(['c'])
      now = 1101
      expect(cache.has('b')).toBe(false); expect(cache.has('c')).toBe(false)
      expect(cache.reserve(['d', 'e'])).toBe(true)
    } finally { clock.mockRestore() }
  })
})
