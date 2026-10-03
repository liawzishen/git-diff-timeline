import type { GitDiffCommit, GitDiffStat, GitDiffTimeline } from '../types'
import type { Loaded } from './git'

export type Range = { from: number; to: number }

/** The id of the uncommitted-changes node, after the last commit. */
export const WORKING = 'working'

export const INITIAL: GitDiffTimeline = {
  status: 'loading',
  message: '',
  cwd: '',
  branch: '',
  mode: 'history',
  commits: [],
  hasWorking: false,
  untracked: 0,
  baseOfOldest: '',
  from: 0,
  to: 0,
  start: -1,
  isPinned: false,
  anchor: '',
  branches: [],
  base: '',
  compare: '',
  branchCompare: null,
  stat: null,
  statKey: '',
  statError: '',
  open: [],
  patches: [],
}

type Nodes = Pick<GitDiffTimeline, 'commits' | 'hasWorking'>
type Picked = Nodes & Range & Pick<GitDiffTimeline, 'baseOfOldest' | 'mode' | 'base' | 'compare'>

/** One id per timeline node, oldest first: commit shas, then `WORKING` when dirty. */
export const nodeIds = (t: Nodes): string[] => [
  ...t.commits.map(commit => commit.sha),
  ...(t.hasWorking ? [WORKING] : []),
]

/** The revision node `index` stands for; -1 is what the oldest commit is compared with. */
export const refOf = (t: Nodes & Pick<GitDiffTimeline, 'baseOfOldest'>, index: number): string =>
  index < 0 ? t.baseOfOldest : (nodeIds(t)[index] ?? '')

/** The revisions of the `git diff` the pick shows: two, one against the working tree, or base...compare. */
export const diffSpec = (t: Picked): string[] => {
  if (t.mode === 'branches') {
    return [`${t.base}...${t.compare}`]
  }

  const to = refOf(t, t.to)

  return to === WORKING ? [refOf(t, t.from)] : [refOf(t, t.from), to]
}

/** What a stat or a patch was read for. */
export const selectionKey = (t: Picked): string =>
  t.mode === 'branches' ? `${t.base}...${t.compare}` : `${refOf(t, t.from)}..${refOf(t, t.to)}`

/** A commit on its own: against the node before it. */
export const commitRange = (index: number): Range => ({ from: index - 1, to: index })

/**
 * A click on node `index`, as a date-range picker takes it: the first shows that commit
 * on its own and waits; a second on another node compares the two; the next starts over.
 */
export const clickCommit = (t: Nodes & Pick<GitDiffTimeline, 'anchor'>, index: number): Range & { anchor: string } => {
  const ids = nodeIds(t)
  const waiting = t.anchor === '' ? -1 : ids.indexOf(t.anchor)

  if (waiting < 0) {
    return { ...commitRange(index), anchor: ids[index] ?? '' }
  }

  return waiting === index
    ? { ...commitRange(index), anchor: '' }
    : { from: Math.min(waiting, index), to: Math.max(waiting, index), anchor: '' }
}

/** The commits a history comparison takes in, newest first; the working tree is none of them. */
export const rangeCommits = (t: Nodes & Range): GitDiffCommit[] =>
  t.commits.slice(Math.max(0, t.from + 1), Math.min(t.to + 1, t.commits.length)).reverse()

/** The newest step: the newest node on its own. */
export const defaultRange = (total: number): Range => commitRange(total - 1)

const grouped = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** The three phrases of a summary: `4 files changed`, `+172`, `−35`; null while unread. */
export const describeStat = (stat: GitDiffStat | null) =>
  stat === null
    ? null
    : {
        files: `${stat.files.length} file${stat.files.length === 1 ? '' : 's'} changed`,
        added: `+${grouped(stat.added)}`,
        deleted: `−${grouped(stat.deleted)}`,
      }

/** A merge's subject by its pull request or branch; any other subject as it is. */
const subjectName = (subject: string): string => {
  const pull = /^Merge pull request #(\d+) from [^/\s]+\/(\S+)/.exec(subject)

  if (pull !== null) {
    return `PR #${pull[1]} ${pull[2]}`
  }

  const branch = /^Merge branch '([^']+)'/.exec(subject)

  return branch === null ? subject : `Merge ${branch[1]}`
}

const firstLine = (text: string) => text.split('\n').find(line => line.trim() !== '')?.trim() ?? ''

/** A GitLab merge's request number, from the `See merge request group/project!123` line it carries. */
const mergeRequestOf = (commit: Pick<GitDiffCommit, 'subject' | 'body'>) =>
  /^Merge branch '/.test(commit.subject) ? (/See merge request \S*!(\d+)/.exec(commit.body)?.[1] ?? null) : null

/** A commit button's label: its pull or merge request number, else its short sha. */
export const buttonLabel = (commit: GitDiffCommit): string => {
  const pull = /^Merge pull request #(\d+)/.exec(commit.subject)

  if (pull !== null) {
    return `#${pull[1]}`
  }

  const request = mergeRequestOf(commit)

  return request === null ? commit.short : `!${request}`
}

/**
 * A commit as the timeline names it: a merge by its pull or merge request's title, else its
 * subject. Whole: the row drawing it cuts it to the room it has.
 */
export const commitTitle = (commit: Pick<GitDiffCommit, 'subject' | 'body'>): string => {
  const title = firstLine(commit.body)
  const pull = /^Merge pull request #(\d+)/.exec(commit.subject)

  if (pull !== null) {
    return title === '' ? subjectName(commit.subject) : `#${pull[1]} ${title}`
  }

  const request = mergeRequestOf(commit)

  return request !== null && title !== '' && !title.startsWith('See merge request')
    ? `!${request} ${title}`
    : subjectName(commit.subject)
}

/** The branches compared: kept while they exist, else origin's default against the current one. */
const branchPick = (prev: GitDiffTimeline, loaded: Loaded, isSameRepo: boolean) => {
  const names = new Set(loaded.branches.map(branch => branch.name))
  const kept = (name: string) => (isSameRepo && names.has(name) ? name : '')
  const base = kept(prev.base) || loaded.defaultBase || loaded.branches[0]?.name || ''
  const current = names.has(loaded.branch) ? loaded.branch : ''
  const compare =
    kept(prev.compare) || current || loaded.branches.find(branch => branch.name !== base)?.name || base

  return { base, compare }
}

/** The next state once git answered; keeps what the person picked while it still exists. */
export const merge = (prev: GitDiffTimeline, loaded: Loaded, cwd: string): GitDiffTimeline => {
  const isSameRepo = prev.cwd === cwd
  const bare: GitDiffTimeline = {
    ...INITIAL,
    cwd,
    status: loaded.status,
    message: loaded.message,
    branch: loaded.branch,
    mode: isSameRepo ? prev.mode : 'history',
  }

  if (loaded.status !== 'ready') {
    return bare
  }

  const next: GitDiffTimeline = {
    ...bare,
    commits: loaded.commits,
    hasWorking: loaded.hasWorking,
    untracked: loaded.untracked,
    baseOfOldest: loaded.baseOfOldest,
    branches: loaded.branches,
    ...branchPick(prev, loaded, isSameRepo),
  }
  const ids = nodeIds(next)
  const locate = (ref: string): number | null => {
    if (ref === '') {
      return null
    }

    if (ref === next.baseOfOldest) {
      return -1
    }

    const index = ids.indexOf(ref)

    return index < 0 ? null : index
  }
  const from = isSameRepo && prev.isPinned ? locate(refOf(prev, prev.from)) : null
  const to = isSameRepo && prev.isPinned ? locate(refOf(prev, prev.to)) : null
  const kept = from !== null && to !== null && to > from ? { from, to } : null
  const merged: GitDiffTimeline = {
    ...next,
    ...(kept ?? defaultRange(ids.length)),
    isPinned: kept !== null,
    anchor: isSameRepo && ids.includes(prev.anchor) ? prev.anchor : '',
    start: isSameRepo ? prev.start : -1,
    branchCompare: isSameRepo ? prev.branchCompare : null,
  }

  // What is on screen stays until the fresh answer lands, unless the pick moved.
  return selectionKey(merged) === prev.statKey
    ? { ...merged, stat: prev.stat, statKey: prev.statKey, statError: prev.statError, open: prev.open, patches: prev.patches }
    : merged
}
