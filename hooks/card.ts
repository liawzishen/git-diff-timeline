import { slotCenter } from './layout'

/**
 * The cards the desktop draws as one Svg each: a deep navy card, the compared span
 * aglow in orange-red. Units are tenths of a cell, so a dot drawn at a slot's centre
 * sits over the commit button in that slot below the card.
 */

/** viewBox units per cell: a card is `columns * CELL` wide. */
export const CELL = 10

const H = 170
const BY = 116
const WAVE = 50
const MAX_DOTS = 12

const CARD = '#0f1729'
const INK = '#eef1f7'
const INK2 = '#a3adc2'
const MUTED = '#8a94ab'
const LINE = '#2a3550'
const DOT = '#56627f'
const IN_RANGE = '#c9d1e3'
const ADDED = '#5fd38d'
const DELETED = '#ff7b8a'
const A1 = '#ffa25c'
const A2 = '#ff4d2e'
const FONT = 'Segoe UI, system-ui, -apple-system, sans-serif'

export type CardNode = {
  /** Under the dot: `Jul 4`, `Now`. */
  label: string
  /** Lines changed: the wave's height over the dot. */
  churn: number
  role: 'outside' | 'base' | 'between' | 'compare'
  isWorking: boolean
  /** What the dot is, for a reader that hovers or cannot see it. */
  tip: string
}

export type CardStats = { files: string; added: string; deleted: string } | null

export type HistoryCardInput = {
  /** The band's width in cells: the card spans it. */
  columns: number
  /** The commits in view, oldest first, one per slot. */
  nodes: CardNode[]
  title: string
  stats: CardStats
  /** Commits beyond the view on each side. */
  older: number
  newer: number
}

export type BranchCardInput = {
  columns: number
  base: string
  compare: string
  ahead: number
  behind: number
  /** Titles of each side's commits, oldest first. */
  aheadTips: string[]
  behindTips: string[]
  /** Under the fork: `merge base · Jul 13`; '' when the branches share no history. */
  mergeBase: string
  stats: CardStats
}

const r = (n: number) => Math.round(n * 10) / 10

const esc = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A smooth curve through the points (Catmull-Rom as cubic Béziers). */
const smooth = (points: ReadonlyArray<readonly [number, number]>) => {
  const [x0 = 0, y0 = 0] = points[0] ?? []
  let d = `M${r(x0)},${r(y0)}`

  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i - 1] ?? points[i]!
    const b = points[i]!
    const c = points[i + 1]!
    const e = points[i + 2] ?? c

    d += ` C${r(b[0] + (c[0] - a[0]) / 7)},${r(b[1] + (c[1] - a[1]) / 7)} ${r(c[0] - (e[0] - b[0]) / 7)},${r(c[1] - (e[1] - b[1]) / 7)} ${r(c[0])},${r(c[1])}`
  }

  return d
}

const open = (width: number, label: string, glowX1: number, glowX2: number) =>
  [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${H}" width="${width * 4}" height="${H * 4}" font-family="${FONT}" role="img" aria-label="${esc(label)}">`,
    '<defs>',
    '<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#151f37"/><stop offset="1" stop-color="#0b1220"/></linearGradient>',
    `<linearGradient id="accent" gradientUnits="userSpaceOnUse" x1="${r(glowX1)}" y1="0" x2="${r(Math.max(glowX2, glowX1 + 1))}" y2="0"><stop offset="0" stop-color="${A1}"/><stop offset="1" stop-color="${A2}"/></linearGradient>`,
    `<linearGradient id="fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${A2}" stop-opacity="0.5"/><stop offset="1" stop-color="${A2}" stop-opacity="0"/></linearGradient>`,
    `<radialGradient id="halo"><stop offset="0" stop-color="${A2}" stop-opacity="0.22"/><stop offset="1" stop-color="${A2}" stop-opacity="0"/></radialGradient>`,
    '<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>',
    '</defs>',
    `<rect width="${width}" height="${H}" rx="22" fill="url(#bg)"/>`,
  ].join('')

/** The header's right side: the totals, or that they are on their way. */
const statsText = (x: number, stats: CardStats) =>
  stats === null
    ? `<text x="${r(x)}" y="30" font-size="15" fill="${MUTED}" text-anchor="end">reading the diff…</text>`
    : `<text x="${r(x)}" y="30" font-size="15" text-anchor="end"><tspan fill="${INK}">${esc(stats.files)}</tspan><tspan dx="14" fill="${ADDED}">${esc(stats.added)}</tspan><tspan dx="10" fill="${DELETED}">${esc(stats.deleted)}</tspan></text>`

const glowDot = (x: number, y: number, extra = '') =>
  `<circle cx="${r(x)}" cy="${y}" r="17" fill="${A2}" opacity="0.35" filter="url(#glow)"/><circle${extra} cx="${r(x)}" cy="${y}" r="8" fill="${A2}" stroke="${CARD}" stroke-width="3"/>`

const nodeMark = (node: CardNode, i: number, x: number) => {
  const at = ` data-node="${i}" cx="${r(x)}" cy="${BY}"`
  const role = ` data-role="${node.role}"`
  const dashed = node.isWorking ? ' stroke-dasharray="3 3"' : ''

  switch (node.role) {
    case 'compare':
      return `<circle cx="${r(x)}" cy="${BY}" r="17" fill="${A2}" opacity="0.35" filter="url(#glow)"/><circle${at} r="8"${role} fill="${A2}" stroke="${CARD}" stroke-width="3"/>`
    case 'base':
      return `<circle${at} r="7"${role} fill="${CARD}" stroke="${A1}" stroke-width="3"${dashed}/>`
    case 'between':
      return `<circle${at} r="4.5"${role} fill="${IN_RANGE}"/>`
    default:
      return node.isWorking
        ? `<circle${at} r="5"${role} fill="${CARD}" stroke="${IN_RANGE}" stroke-width="2"${dashed}/>`
        : `<circle${at} r="4.5"${role} fill="${DOT}"/>`
  }
}

/** History: the commits in view on a line, the wave of their size above it, the pick aglow. */
export const historyCard = ({ columns, nodes, title, stats, older, newer }: HistoryCardInput): string => {
  const width = columns * CELL
  const xs = nodes.map((_, i) => slotCenter(i) * CELL)
  const tallest = Math.log10(1 + Math.max(1, ...nodes.map(node => node.churn)))
  const ys = nodes.map(node => BY - 6 - (WAVE * Math.log10(1 + node.churn)) / tallest)
  const left = 16
  const right = width - 16
  const wave = smooth([[left, BY], ...xs.map((x, i) => [x, ys[i]!] as const), [right, BY]])
  const area = `${wave} L${right},${BY} L${left},${BY} Z`
  const picked = nodes.map((node, i) => (node.role === 'outside' ? -1 : i)).filter(i => i >= 0)
  const firstPicked = picked[0]
  const lastPicked = picked[picked.length - 1]
  const hasSpan = firstPicked !== undefined && lastPicked !== undefined
  // A pick that runs out of view glows to the card's edge on that side.
  const spanFrom = !hasSpan ? 0 : nodes[firstPicked]!.role === 'between' ? left : xs[firstPicked]!
  const spanTo = !hasSpan ? 0 : nodes[lastPicked]!.role === 'between' ? right : xs[lastPicked]!
  const parts = [
    open(width, title, spanFrom, spanTo),
    hasSpan ? `<ellipse cx="${r((spanFrom + spanTo) / 2)}" cy="${BY - 30}" rx="${r(Math.max(120, (spanTo - spanFrom) / 2 + 80))}" ry="90" fill="url(#halo)"/>` : '',
    `<text x="24" y="30" font-size="15" fill="${INK2}">${esc(title)}</text>`,
    statsText(width - 24, stats),
    `<path d="${area}" fill="#18233c"/>`,
    `<path d="${wave}" fill="none" stroke="#2f3d5c" stroke-width="2"/>`,
  ]

  if (hasSpan && spanTo > spanFrom) {
    parts.push(
      `<clipPath id="span"><rect x="${r(spanFrom)}" y="0" width="${r(spanTo - spanFrom)}" height="${H}"/></clipPath>`,
      `<g clip-path="url(#span)"><path d="${area}" fill="url(#fill)"/><path d="${wave}" fill="none" stroke="url(#accent)" stroke-width="3" filter="url(#glow)"/></g>`,
    )
  }

  parts.push(`<line x1="${left}" y1="${BY}" x2="${right}" y2="${BY}" stroke="${LINE}" stroke-width="3" stroke-linecap="round"/>`)

  if (hasSpan && spanTo > spanFrom) {
    parts.push(
      `<line x1="${r(spanFrom)}" y1="${BY}" x2="${r(spanTo)}" y2="${BY}" stroke="url(#accent)" stroke-width="5" stroke-linecap="round" filter="url(#glow)"/>`,
    )
  }

  nodes.forEach((node, i) => {
    const x = xs[i]!
    const isPicked = node.role === 'base' || node.role === 'compare'

    parts.push(
      `<g><title>${esc(node.tip)}</title>${nodeMark(node, i, x)}</g>`,
      `<text x="${r(x)}" y="146" font-size="13" fill="${isPicked ? INK : MUTED}" text-anchor="middle">${esc(node.label)}</text>`,
    )
  })

  if (older > 0) {
    parts.push(`<text x="20" y="164" font-size="12" fill="${MUTED}">‹ ${older} older</text>`)
  }

  if (newer > 0) {
    parts.push(`<text x="${width - 20}" y="164" font-size="12" fill="${MUTED}" text-anchor="end">${newer} newer ›</text>`)
  }

  parts.push('</svg>')

  return parts.join('')
}

/** Spreads `count` dots from `x1` to `x2`, the last one at `x2`. */
const spread = (count: number, x1: number, x2: number) =>
  Array.from({ length: count }, (_, i) => (count === 1 ? x2 : x1 + ((x2 - x1) * i) / (count - 1)))

/** Branches: the base line, the compare branch forking off it, each side's commits as dots. */
export const branchCard = (input: BranchCardInput): string => {
  const { columns, base, compare, ahead, behind, aheadTips, behindTips, mergeBase, stats } = input
  const width = columns * CELL
  const fork = Math.round(width * 0.22)
  const top = 68
  const tipX = width - 40
  const aheadCount = Math.min(ahead, MAX_DOTS)
  const behindCount = Math.min(behind, MAX_DOTS)
  const aheadXs = spread(aheadCount, fork + 90, tipX)
  const behindXs = spread(behindCount, fork + 90, tipX)
  const label = `${compare} is ${ahead} ahead of and ${behind} behind ${base}`
  const parts = [
    open(width, label, fork, tipX),
    `<ellipse cx="${r((fork + tipX) / 2)}" cy="${top}" rx="${r((tipX - fork) / 2 + 60)}" ry="70" fill="url(#halo)"/>`,
    `<text x="24" y="30" font-size="15"><tspan fill="${INK}">${ahead} ahead</tspan><tspan dx="8" fill="${MUTED}">·</tspan><tspan dx="8" fill="${INK}">${behind} behind</tspan></text>`,
    statsText(width - 24, stats),
    `<line x1="16" y1="${BY}" x2="${width - 16}" y2="${BY}" stroke="${LINE}" stroke-width="3" stroke-linecap="round"/>`,
    ...[0.25, 0.5, 0.75].map(at => `<circle cx="${r(fork * at)}" cy="${BY}" r="4.5" fill="${DOT}"/>`),
  ]

  behindXs.forEach((x, i) => {
    const tip = behindTips[behindTips.length - behindCount + i] ?? ''
    const isTip = i === behindCount - 1

    parts.push(
      `<g><title>${esc(tip)}</title><circle data-side="behind" cx="${r(x)}" cy="${BY}" r="${isTip ? 6 : 4.5}" fill="${isTip ? IN_RANGE : DOT}"/></g>`,
    )
  })

  if (ahead > 0) {
    parts.push(
      `<path d="M${fork},${BY} C${fork + 40},${BY} ${fork + 36},${top} ${fork + 76},${top} L${tipX},${top}" fill="none" stroke="url(#accent)" stroke-width="3" stroke-linecap="round" filter="url(#glow)"/>`,
    )
  }

  aheadXs.forEach((x, i) => {
    const tip = aheadTips[aheadTips.length - aheadCount + i] ?? ''
    const isTip = i === aheadCount - 1

    parts.push(
      `<g><title>${esc(tip)}</title>${isTip ? glowDot(x, top, ' data-side="ahead"') : `<circle data-side="ahead" cx="${r(x)}" cy="${top}" r="4" fill="#ffc6a6"/>`}</g>`,
    )
  })

  if (ahead > aheadCount) {
    parts.push(`<text x="${fork + 90}" y="${top - 16}" font-size="12" fill="${MUTED}">+${ahead - aheadCount} more</text>`)
  }

  if (behind > behindCount) {
    parts.push(`<text x="${fork + 90}" y="${BY + 22}" font-size="12" fill="${MUTED}">+${behind - behindCount} more</text>`)
  }

  parts.push(
    `<circle cx="${fork}" cy="${BY}" r="7" fill="${CARD}" stroke="${IN_RANGE}" stroke-width="2.5"/>`,
    `<text x="${tipX}" y="${top - 18}" font-size="14" fill="${INK2}" text-anchor="end">${esc(compare)}</text>`,
    `<text x="${tipX}" y="${BY + 26}" font-size="14" fill="${INK2}" text-anchor="end">${esc(base)}</text>`,
    mergeBase === '' ? '' : `<text x="${fork}" y="${BY + 26}" font-size="12" fill="${MUTED}" text-anchor="middle">${esc(mergeBase)}</text>`,
    '</svg>',
  )

  return parts.join('')
}
