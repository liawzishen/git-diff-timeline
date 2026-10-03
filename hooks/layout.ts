/** Cells each paging arrow takes, either end of the commit buttons. */
export const ARROW_W = 3

/** Cells one commit takes: room for a `#1234` or short-sha button. */
export const SLOT_W = 9

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const two = (n: number) => String(n).padStart(2, '0')

/** `Jan 2, 2026`, in local time. */
export const formatDate = (seconds: number): string => {
  const date = new Date(seconds * 1000)

  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`
}

/** `Jan 2`, in local time. */
export const shortDate = (seconds: number): string => {
  const date = new Date(seconds * 1000)

  return `${MONTHS[date.getMonth()]} ${date.getDate()}`
}

/** `02:40 PM`, in local time. */
export const formatTime = (seconds: number): string => {
  const date = new Date(seconds * 1000)
  const hours = date.getHours()

  return `${two(hours % 12 || 12)}:${two(date.getMinutes())} ${hours < 12 ? 'AM' : 'PM'}`
}

/** `9:47 PM`, in local time. */
const shortTime = (seconds: number): string => {
  const date = new Date(seconds * 1000)
  const hours = date.getHours()

  return `${hours % 12 || 12}:${two(date.getMinutes())} ${hours < 12 ? 'AM' : 'PM'}`
}

const dayOf = (seconds: number) => new Date(seconds * 1000).toDateString()

/** The label under each dot: its day where the day changes, else its time; null is the working tree. */
export const dayLabels = (times: ReadonlyArray<number | null>): string[] =>
  times.map((time, i) => {
    if (time === null) {
      return 'Now'
    }

    const before = i === 0 ? null : times[i - 1]

    return before === null || before === undefined || dayOf(before) !== dayOf(time) ? shortDate(time) : shortTime(time)
  })

/** How many commit slots fit between the arrows; at least two, at most all of them. */
export const visibleCount = (columns: number, total: number): number => {
  const room = Math.floor((columns - 2 * ARROW_W) / SLOT_W)

  return Math.max(2, Math.min(total, room))
}

/** The centre of slot `i`, in cells from the left edge. */
export const slotCenter = (i: number): number => ARROW_W + i * SLOT_W + SLOT_W / 2

const clampStart = (start: number, count: number, total: number) =>
  Math.min(Math.max(0, total - count), Math.max(0, start))

/** The leftmost visible node: `-1` means the newest window. */
export const resolveStart = (start: number, count: number, total: number): number =>
  start < 0 ? Math.max(0, total - count) : clampStart(start, count, total)

/** One page left (`delta` -1) or right (1), overlapping by a node; `-1` once at the newest. */
export const stepStart = (start: number, delta: number, count: number, total: number): number => {
  const next = clampStart(resolveStart(start, count, total) + delta * Math.max(1, count - 1), count, total)

  return next === Math.max(0, total - count) ? -1 : next
}
