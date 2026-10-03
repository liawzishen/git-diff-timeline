import type {
  GitDiffBranch,
  GitDiffBranchCompare,
  GitDiffCommit,
  GitDiffFile,
  GitDiffPatch,
  GitDiffStat,
} from '../types'

export type Run = (
  argv: readonly string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

export type Loaded = {
  status: 'ready' | 'no-repo' | 'no-commits' | 'error'
  message: string
  branch: string
  commits: GitDiffCommit[]
  hasWorking: boolean
  untracked: number
  baseOfOldest: string
  branches: GitDiffBranch[]
  /** The branch others are compared with by default: origin's default branch, else a main one. */
  defaultBase: string
}

/** The revisions of one `git diff`: two, one (against the working tree), or `base...compare`. */
export type Spec = readonly string[]

export const LOG_LIMIT = 60
export const BRANCH_COMMITS = 30
/** Characters of hunks one file's diff may hold: a Code element takes at most 10000. */
export const PATCH_LIMIT = 9000

/** The tree with nothing in it, which a root commit is compared with. */
export const EMPTY_TREE = {
  sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
} as const

/** Characters of a commit message's body kept: enough for a pull request's title and a line or two. */
const BODY_LIMIT = 300

const RS = '\u001e'
const US = '\u001f'
const GS = '\u001d'
const LOG_FORMAT = '--format=%x1e%H%x1f%h%x1f%ct%x1f%s%x1f%b%x1d'
const REF_FORMAT = '--format=%(refname)%1f%(refname:short)%1f%(committerdate:unix)%1f%(symref)'
const NUMSTAT = ['diff', '--numstat', '-z', '--no-renames']
const PATCH = ['diff', '--no-color', '--no-ext-diff', '--no-renames', '-U3']
const MAIN_BRANCHES = ['origin/main', 'origin/master', 'main', 'master']
/** Control characters a Code element refuses: all but tab and newline. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g

const firstLine = (text: string) => text.trim().split(/\r?\n/)[0] ?? ''

const countOf = (text: string, pattern: RegExp) => Number(pattern.exec(text)?.[1] ?? 0)

/** `git log` with LOG_FORMAT and `--shortstat`: newest first in, oldest first out. */
export const parseLog = (stdout: string): GitDiffCommit[] =>
  stdout
    .split(RS)
    .filter(chunk => chunk.trim() !== '')
    .map(chunk => {
      // The message ends at GS; the shortstat, when there is one, follows it.
      const end = chunk.lastIndexOf(GS)
      const fields = end < 0 ? chunk : chunk.slice(0, end)
      const stat = end < 0 ? '' : chunk.slice(end + 1)
      const [sha = '', short = '', time = '', subject = '', ...body] = fields.split(US)

      return {
        sha,
        short,
        time: Number(time),
        subject: subject.trim(),
        body: body.join(US).replace(/\r/g, '').trim().slice(0, BODY_LIMIT),
        added: countOf(stat, /(\d+) insertions?\(\+\)/),
        deleted: countOf(stat, /(\d+) deletions?\(-\)/),
      }
    })
    .filter(commit => commit.sha !== '' && Number.isFinite(commit.time))
    .reverse()

/** `git diff --numstat -z --no-renames`: `added TAB deleted TAB path NUL` per file. */
export const parseNumstat = (stdout: string): GitDiffStat => {
  const files: GitDiffFile[] = stdout
    .split('\0')
    .filter(record => record !== '')
    .map(record => {
      const [added = '', deleted = '', ...path] = record.split('\t')

      return {
        path: path.join('\t'),
        added: added === '-' ? null : Number(added),
        deleted: deleted === '-' ? null : Number(deleted),
      }
    })

  return {
    files,
    added: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
    deleted: files.reduce((sum, file) => sum + (file.deleted ?? 0), 0),
  }
}

/** `git for-each-ref` with REF_FORMAT; symbolic refs (`origin/HEAD`) left out. */
export const parseBranches = (stdout: string): GitDiffBranch[] =>
  stdout
    .split(/\r?\n/)
    .map(line => line.split(US))
    .filter(([refname = '', , , symref = '']) => refname !== '' && symref === '')
    .map(([refname = '', name = '', time = '']) => ({
      name,
      time: Number(time) || 0,
      isRemote: refname.startsWith('refs/remotes/'),
    }))

/** `git rev-list --left-right --count base...compare`: the base's own commits, then the compare's. */
export const parseLeftRight = (stdout: string) => {
  const [behind = '0', ahead = '0'] = stdout.trim().split(/\s+/)

  return { behind: Number(behind) || 0, ahead: Number(ahead) || 0 }
}

/** A hunk whose lines were cut: its header counted again from what is left. */
const recount = ([header = '', ...body]: string[]): string[] => {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(header)

  if (match === null) {
    return [header, ...body]
  }

  const old = body.filter(line => line.startsWith(' ') || line.startsWith('-')).length
  const now = body.filter(line => line.startsWith(' ') || line.startsWith('+')).length

  return [`@@ -${match[1]},${old} +${match[2]},${now} @@${match[3]}`, ...body]
}

/**
 * One file's `git diff` as a Code element takes it: the hunks alone, without control
 * characters, whole hunks up to `limit` characters (the first one cut to fit if it must).
 */
export const toHunks = (diff: string, limit = PATCH_LIMIT): Omit<GitDiffPatch, 'path'> => {
  const lines = diff.replace(/\r/g, '').replace(CONTROL, '�').split('\n')
  const first = lines.findIndex(line => line.startsWith('@@'))

  if (first < 0) {
    return { hunks: '', isCut: false, note: /^Binary files /m.test(diff) ? 'binary' : 'empty' }
  }

  const body = lines.slice(first)

  while (body.length > 0 && body[body.length - 1] === '') {
    body.pop()
  }

  const hunks: string[][] = []

  for (const line of body) {
    if (line.startsWith('@@') || hunks.length === 0) {
      hunks.push([line])
    } else {
      hunks[hunks.length - 1]!.push(line)
    }
  }

  const kept: string[] = []
  let size = 0

  for (const hunk of hunks) {
    const text = hunk.join('\n')
    const extra = (kept.length === 0 ? 0 : 1) + text.length

    if (size + extra <= limit) {
      kept.push(text)
      size += extra
      continue
    }

    if (kept.length === 0) {
      const head = [hunk[0] ?? '']
      let headSize = head[0]!.length

      for (const line of hunk.slice(1)) {
        if (headSize + 1 + line.length > limit) {
          break
        }

        head.push(line)
        headSize += 1 + line.length
      }

      kept.push(recount(head).join('\n'))
    }

    return { hunks: kept.join('\n'), isCut: true, note: '' }
  }

  return { hunks: kept.join('\n'), isCut: false, note: '' }
}

const empty = (status: Loaded['status'], message: string, branch = ''): Loaded => ({
  status,
  message,
  branch,
  commits: [],
  hasWorking: false,
  untracked: 0,
  baseOfOldest: '',
  branches: [],
  defaultBase: '',
})

const pickDefaultBase = (originHead: string, branches: GitDiffBranch[]) => {
  const names = new Set(branches.map(branch => branch.name))

  if (names.has(originHead)) {
    return originHead
  }

  return MAIN_BRANCHES.find(name => names.has(name)) ?? branches[0]?.name ?? ''
}

/** What the oldest commit is compared with: its first parent, or the empty tree for a root. */
const baseOf = async (run: Run, oldest: GitDiffCommit) => {
  const parent = await run(['git', 'rev-parse', '--verify', '--quiet', `${oldest.sha}^`])

  if (parent.exitCode === 0 && parent.stdout.trim() !== '') {
    return parent.stdout.trim()
  }

  const format = await run(['git', 'rev-parse', '--show-object-format'])

  return format.stdout.trim() === 'sha256' ? EMPTY_TREE.sha256 : EMPTY_TREE.sha1
}

export const loadTimeline = async (run: Run): Promise<Loaded> => {
  const inside = await run(['git', 'rev-parse', '--is-inside-work-tree'])

  if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
    return empty('no-repo', firstLine(inside.stderr) || 'Not a git repository')
  }

  const [branchRun, head, dirty, others, refs, originHead] = await Promise.all([
    run(['git', 'branch', '--show-current']),
    run(['git', 'rev-parse', '--verify', '--quiet', 'HEAD']),
    run(['git', ...NUMSTAT, 'HEAD', '--']),
    run(['git', 'ls-files', '--others', '--exclude-standard', '-z']),
    run(['git', 'for-each-ref', '--sort=-committerdate', REF_FORMAT, 'refs/heads', 'refs/remotes']),
    run(['git', 'symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']),
  ])
  const branch = branchRun.stdout.trim() || 'detached HEAD'

  if (head.exitCode !== 0) {
    return empty('no-commits', `No commits yet on ${branch}`, branch)
  }

  // First parent only: a merged pull request is one commit, so each step is one pull request's diff.
  const log = await run(['git', 'log', '--first-parent', '-n', String(LOG_LIMIT), LOG_FORMAT, '--shortstat'])

  if (log.exitCode !== 0) {
    return empty('error', firstLine(log.stderr) || 'git log failed', branch)
  }

  const commits = parseLog(log.stdout)
  const branches = refs.exitCode === 0 ? parseBranches(refs.stdout) : []
  const oldest = commits[0]

  return {
    status: 'ready',
    message: '',
    branch,
    commits,
    hasWorking: dirty.exitCode === 0 && dirty.stdout !== '',
    untracked: others.exitCode === 0 ? others.stdout.split('\0').filter(path => path !== '').length : 0,
    baseOfOldest: oldest === undefined ? '' : await baseOf(run, oldest),
    branches,
    defaultBase: pickDefaultBase(originHead.exitCode === 0 ? originHead.stdout.trim() : '', branches),
  }
}

/** The files a diff of `spec` changes. */
export const loadStat = async (run: Run, spec: Spec): Promise<GitDiffStat> => {
  const result = await run(['git', ...NUMSTAT, ...spec, '--'])

  if (result.exitCode !== 0) {
    throw new Error(firstLine(result.stderr) || 'git diff failed')
  }

  return parseNumstat(result.stdout)
}

/** One file's diff of `spec`, as hunks; a failure is kept as the note. */
export const loadPatch = async (run: Run, spec: Spec, path: string): Promise<GitDiffPatch> => {
  const result = await run(['git', ...PATCH, ...spec, '--', path])

  if (result.exitCode !== 0) {
    return { path, hunks: '', isCut: false, note: firstLine(result.stderr) || 'git diff failed' }
  }

  return { path, ...toHunks(result.stdout) }
}

/** How far apart two branches are: each side's own commits, and where they split. */
export const loadBranchCompare = async (run: Run, base: string, compare: string): Promise<GitDiffBranchCompare> => {
  const side = (range: string) =>
    run(['git', 'log', '--first-parent', '-n', String(BRANCH_COMMITS), LOG_FORMAT, '--shortstat', range])
  const [counts, mergeBase, aheadLog, behindLog] = await Promise.all([
    run(['git', 'rev-list', '--left-right', '--count', `${base}...${compare}`]),
    run(['git', 'merge-base', base, compare]),
    side(`${base}..${compare}`),
    side(`${compare}..${base}`),
  ])

  if (counts.exitCode !== 0) {
    throw new Error(firstLine(counts.stderr) || 'git rev-list failed')
  }

  const baseSha = mergeBase.exitCode === 0 ? mergeBase.stdout.trim() : ''
  const baseLog = baseSha === '' ? null : await run(['git', 'log', '-1', LOG_FORMAT, baseSha])

  return {
    ...parseLeftRight(counts.stdout),
    mergeBase: baseLog === null || baseLog.exitCode !== 0 ? null : (parseLog(baseLog.stdout)[0] ?? null),
    aheadCommits: aheadLog.exitCode === 0 ? parseLog(aheadLog.stdout) : [],
    behindCommits: behindLog.exitCode === 0 ? parseLog(behindLog.stdout) : [],
  }
}
