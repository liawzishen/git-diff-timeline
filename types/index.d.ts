export type GitDiffCommit = {
  sha: string
  short: string
  /** Commit time, seconds since the epoch. */
  time: number
  subject: string
  /** The message after the subject, trimmed and cut short: a merge's pull request title lives here. */
  body: string
  /** Lines changed against the first parent: the height of the card's wave. */
  added: number
  deleted: number
}

export type GitDiffFile = {
  path: string
  /** Null for a binary file. */
  added: number | null
  deleted: number | null
}

export type GitDiffStat = {
  files: GitDiffFile[]
  added: number
  deleted: number
}

export type GitDiffBranch = {
  /** As git spells it short: `main`, `origin/main`. */
  name: string
  /** Last commit time, seconds since the epoch. */
  time: number
  isRemote: boolean
}

/** One file's diff as the files view draws it. */
export type GitDiffPatch = {
  path: string
  /** Unified-diff hunks from the first `@@`, cut to fit a Code element; '' when there are none. */
  hunks: string
  /** True when hunks were left out or cut to fit. */
  isCut: boolean
  /** Why nothing is drawn: `binary`, `empty`, or what git said. */
  note: string
}

export type GitDiffBranchCompare = {
  /** Commits on the compare branch that the base lacks, and the other way round. */
  ahead: number
  behind: number
  mergeBase: GitDiffCommit | null
  /** Oldest first, the newest few of each side. */
  aheadCommits: GitDiffCommit[]
  behindCommits: GitDiffCommit[]
}

export type GitDiffTimeline = {
  status: 'loading' | 'ready' | 'too-short' | 'no-repo' | 'no-commits' | 'error'
  message: string
  cwd: string
  branch: string
  /** `history` compares two points of this branch; `branches` compares two branches. */
  mode: 'history' | 'branches'
  /** Oldest first. */
  commits: GitDiffCommit[]
  /** True while tracked files differ from HEAD: one more node after the commits. */
  hasWorking: boolean
  untracked: number
  /** What the oldest commit is compared with: its parent, or the empty tree for a root. */
  baseOfOldest: string
  /** The compared range, as node indexes: `from` is older than `to`; -1 is `baseOfOldest`. */
  from: number
  to: number
  /** Index of the leftmost commit button; -1 follows the newest. */
  start: number
  /** True once the person picked a range, so a refresh keeps it. */
  isPinned: boolean
  /** The commit clicked first, waiting for a second click to compare with; '' when none waits. */
  anchor: string
  /** Newest first, as git sorts them. */
  branches: GitDiffBranch[]
  base: string
  compare: string
  branchCompare: GitDiffBranchCompare | null
  stat: GitDiffStat | null
  /** What `stat` (and `patches`) were read for: selectionKey of the pick. */
  statKey: string
  statError: string
  /** Files whose diff is open in the files view, in the order opened. */
  open: string[]
  patches: GitDiffPatch[]
}

declare module 'claude-code' {
  interface PluginState {
    'git-diff-timeline': { timeline: GitDiffTimeline }
  }
}
