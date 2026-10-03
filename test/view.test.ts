import { describe, expect, test } from 'claude-code/testing'

import { CELL, branchCard, historyCard } from '../hooks/card'
import type { CardNode } from '../hooks/card'
import {
  ARROW_W,
  SLOT_W,
  dayLabels,
  formatDate,
  formatTime,
  resolveStart,
  slotCenter,
  stepStart,
  visibleCount,
} from '../hooks/layout'

const node = (label: string, role: CardNode['role'], churn = 10): CardNode => ({
  label,
  churn,
  role,
  isWorking: false,
  tip: `${label} tip`,
})

const attr = (svg: string, name: string) => [...svg.matchAll(new RegExp(`${name}="([^"]*)"`, 'g'))].map(m => m[1])

describe('layout', () => {
  test('visibleCount fits whole commit slots between the paging arrows, at least two', () => {
    expect(visibleCount(95, 60)).toBe(Math.floor((95 - 2 * ARROW_W) / SLOT_W))
    expect(visibleCount(20, 60)).toBe(2)
    expect(visibleCount(200, 3)).toBe(3)
  })

  test('a slot centre sits past the left arrow', () => {
    expect(slotCenter(0)).toBe(ARROW_W + SLOT_W / 2)
    expect(slotCenter(2)).toBe(ARROW_W + 2 * SLOT_W + SLOT_W / 2)
  })

  test('the window follows the newest unless paged, and pages with overlap', () => {
    expect(resolveStart(-1, 5, 12)).toBe(7)
    expect(resolveStart(99, 5, 12)).toBe(7)
    expect(resolveStart(2, 5, 12)).toBe(2)
    expect(stepStart(-1, -1, 5, 12)).toBe(3)
    expect(stepStart(3, -1, 5, 12)).toBe(0)
    expect(stepStart(0, 1, 5, 12)).toBe(4)
    expect(stepStart(4, 1, 5, 12)).toBe(-1)
    expect(resolveStart(-1, 5, 3)).toBe(0)
  })

  test('a dot reads as its day where the day changes, else as its time, and the working tree as Now', () => {
    const at = (day: number, h: number, m: number) => Math.floor(new Date(2026, 6, day, h, m).getTime() / 1000)

    expect(dayLabels([at(3, 9, 0), at(4, 9, 5), at(4, 21, 47), at(5, 1, 0), null])).toEqual([
      'Jul 3',
      'Jul 4',
      '9:47 PM',
      'Jul 5',
      'Now',
    ])
  })

  test('dates and times', () => {
    const seconds = (h: number, m: number) => Math.floor(new Date(2026, 3, 3, h, m).getTime() / 1000)

    expect(formatDate(seconds(14, 40))).toBe('Apr 3, 2026')
    expect(formatTime(seconds(14, 40))).toBe('02:40 PM')
    expect(formatTime(seconds(0, 5))).toBe('12:05 AM')
  })
})

describe('the history card', () => {
  const nodes = [node('Jul 2', 'outside'), node('Jul 3', 'base'), node('Jul 4', 'compare', 300)]
  const svg = historyCard({
    columns: 95,
    nodes,
    title: 'main · 3 commits',
    stats: { files: '4 files changed', added: '+172', deleted: '−35' },
    older: 2,
    newer: 0,
  })

  test('is one svg as wide as the band, a dot per commit at its slot centre', () => {
    const centres = [...svg.matchAll(/data-node="(\d+)" cx="([\d.]+)"/g)].map(m => [Number(m[1]), Number(m[2])])

    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg.endsWith('</svg>')).toBe(true)
    expect(attr(svg, 'viewBox')[0]).toBe(`0 0 ${95 * CELL} 170`)
    expect(centres).toEqual(nodes.map((_, i) => [i, slotCenter(i) * CELL]))
  })

  test('marks the compared pair, and says what is beyond the window', () => {
    expect(attr(svg, 'data-role')).toEqual(['outside', 'base', 'compare'])
    expect(svg).toContain('4 files changed')
    expect(svg).toContain('+172')
    expect(svg).toContain('2 older')
    expect(svg).not.toContain('newer')
  })

  test('escapes text', () => {
    const odd = historyCard({ columns: 60, nodes, title: 'a<b & c', stats: null, older: 0, newer: 0 })

    expect(odd).toContain('a&lt;b &amp; c')
    expect(odd).toContain('reading the diff')
  })
})

describe('the branch card', () => {
  test('shows both branches, how far apart they are, and a dot per commit on each side', () => {
    const svg = branchCard({
      columns: 95,
      base: 'origin/main',
      compare: 'farm-360-tour',
      ahead: 9,
      behind: 5,
      aheadTips: Array.from({ length: 9 }, (_, i) => `a${i}`),
      behindTips: Array.from({ length: 5 }, (_, i) => `b${i}`),
      mergeBase: 'merge base · Jul 13',
      stats: { files: '9 files changed', added: '+1,057', deleted: '−57' },
    })

    expect(svg).toContain('9 ahead')
    expect(svg).toContain('5 behind')
    expect(svg).toContain('origin/main')
    expect(svg).toContain('farm-360-tour')
    expect(attr(svg, 'data-side').filter(side => side === 'ahead')).toHaveLength(9)
    expect(attr(svg, 'data-side').filter(side => side === 'behind')).toHaveLength(5)
  })

  test('draws at most a dozen dots a side and says how many more', () => {
    const svg = branchCard({
      columns: 95,
      base: 'main',
      compare: 'big',
      ahead: 58,
      behind: 0,
      aheadTips: Array.from({ length: 30 }, (_, i) => `a${i}`),
      behindTips: [],
      mergeBase: '',
      stats: null,
    })

    expect(attr(svg, 'data-side').filter(side => side === 'ahead')).toHaveLength(12)
    expect(svg).toContain('+46 more')
  })
})
