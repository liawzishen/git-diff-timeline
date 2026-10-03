import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, RenderElement, Timer } from 'claude-code'

import type { GitDiffCommit, GitDiffFile, GitDiffPatch, GitDiffStat, GitDiffTimeline } from '../types'
import { branchCard, historyCard } from './card'
import type { CardNode } from './card'
import { EMPTY_TREE, LOG_LIMIT, loadBranchCompare, loadPatch, loadStat, loadTimeline } from './git'
import type { Loaded, Run } from './git'
import { ARROW_W, SLOT_W, dayLabels, formatTime, resolveStart, shortDate, stepStart, visibleCount } from './layout'
import {
  INITIAL,
  WORKING,
  buttonLabel,
  clickCommit,
  commitTitle,
  describeStat,
  diffSpec,
  merge,
  nodeIds,
  rangeCommits,
  refOf,
  selectionKey,
} from './model'

type Kit = Pick<ElementTable<'terminal'>, 'Box' | 'Text' | 'Button' | 'Code'> & {
  /** Absent on the phone. */
  Select: ElementTable<'terminal'>['Select'] | null
  /** The desktop's; the terminal draws the timeline in text. */
  Svg: ElementTable<'desktop'>['Svg'] | null
}

type Actions = {
  refresh: () => void
  details: () => void
  mode: (mode: GitDiffTimeline['mode']) => void
  pickCommit: (index: number) => void
  pickBranch: (side: 'base' | 'compare', name: string) => void
  swap: () => void
  step: (delta: number, count: number) => void
  toggleFile: (path: string) => void
}

const PANE = 'git-diff'
const PANE_ARGS = { id: PANE, title: 'Git Diff', rows: 24, columns: 96 } as const

/** Tools whose calls can change what git sees. */
const WATCHED = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'])
const REFRESH_DELAY_MS = 1200
/** Files the files view lists, and diffs it holds open at once. */
const MAX_FILES = 100
const MAX_OPEN = 4
/** Commits the files view lists above the files. */
const MAX_COMMITS = 20
const BLOCKS = 5

const GRAY = '#9aa3b2'
const GREEN = '#2f9e5b'
const RED = '#d9534f'
const ACCENT = '#ff4d2e'

const timeline = atom({ plugin: 'git-diff-timeline', key: 'timeline' } as const, INITIAL)

/** `band`: the strip above the prompt. `pane`: the side pane, opened on its own. Set in register. */
let position: 'band' | 'pane' = 'band'

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

const kitOf = (ui: ElementTable): Kit => ({
  Box: ui.Box,
  Text: ui.Text,
  Button: ui.Button,
  Code: ui.Code,
  Select: 'Select' in ui ? ui.Select : null,
  Svg: 'Svg' in ui ? ui.Svg : null,
})

const runnerFor = async ($: EngineInterface): Promise<Run> => {
  const cwd = await $.session.cwd()

  return argv => $.process.run(argv, { cwd, timeoutMs: 15_000 })
}

/** The files open after a fresh read: the first file for a new pick, else those still changed. */
const openAfter = (cur: GitDiffTimeline, key: string, stat: GitDiffStat | null): string[] => {
  if (cur.statKey !== key) {
    const first = stat?.files[0]

    return first === undefined ? [] : [first.path]
  }

  const paths = new Set(stat?.files.map(file => file.path) ?? [])

  return cur.open.filter(path => paths.has(path))
}

/** Reads the diff of each open file still unread (`force`: every open file). */
const loadPatches = async ($: EngineInterface, force: boolean) => {
  const t = await read($, timeline)

  if (t.status !== 'ready' || t.stat === null) {
    return
  }

  const key = t.statKey
  const wanted = t.open.filter(path => force || !t.patches.some(patch => patch.path === path))

  if (wanted.length === 0) {
    return
  }

  const run = await runnerFor($)
  const spec = diffSpec(t)
  const loaded = await Promise.all(wanted.map(path => loadPatch(run, spec, path)))

  await update($, timeline, cur =>
    cur.statKey !== key
      ? cur
      : {
          ...cur,
          patches: [...cur.patches.filter(patch => !wanted.includes(patch.path)), ...loaded].filter(patch =>
            cur.open.includes(patch.path),
          ),
        },
  )
}

/** Reads what the pick changed, unless it is on screen already (`force` rereads), then its open files. */
const loadSelection = async ($: EngineInterface, force: boolean) => {
  const t = await read($, timeline)

  if (t.status !== 'ready') {
    return
  }

  const key = selectionKey(t)

  if (!force && t.statKey === key && t.stat !== null) {
    await loadPatches($, false)

    return
  }

  const run = await runnerFor($)
  let stat: GitDiffStat | null = null
  let statError = ''
  let branchCompare = t.branchCompare

  try {
    const [loadedStat, compared] = await Promise.all([
      loadStat(run, diffSpec(t)),
      t.mode === 'branches' ? loadBranchCompare(run, t.base, t.compare) : Promise.resolve(null),
    ])

    stat = loadedStat
    branchCompare = compared ?? branchCompare
  } catch (error) {
    statError = errorText(error)
  }

  await update($, timeline, cur =>
    selectionKey(cur) !== key
      ? cur
      : {
          ...cur,
          stat,
          statKey: key,
          statError,
          branchCompare: cur.mode === 'branches' ? branchCompare : cur.branchCompare,
          open: openAfter(cur, key, stat),
          patches: cur.statKey === key ? cur.patches : [],
        },
  )
  await loadPatches($, force)
}

const refresh = async ($: EngineInterface) => {
  const cwd = await $.session.cwd()
  const run = await runnerFor($)
  const failed = (error: unknown): Loaded => ({
    status: 'error',
    message: errorText(error),
    branch: '',
    commits: [],
    hasWorking: false,
    untracked: 0,
    baseOfOldest: '',
    branches: [],
    defaultBase: '',
  })
  const loaded = await loadTimeline(run).catch(failed)

  await update($, timeline, prev => merge(prev, loaded, cwd))
  await loadSelection($, true)
}

let pending: Timer | undefined

/** Whether the pane has been seated this session; a pane opened unasked can wait undrawn. */
let wasPlaced = false
let hasOffered = false

const openDetails = async ($: EngineInterface) => {
  try {
    wasPlaced = (await $.ui.open(PANE_ARGS)).isPlaced
  } catch {
    // /gitdiff says why when the pane cannot open.
  }
}

/** Shows what the person picked: the files view opened by their press, then a fresh read. */
const show = async ($: EngineInterface, change: (t: GitDiffTimeline) => GitDiffTimeline) => {
  await openDetails($)
  await update($, timeline, t => {
    const next = change(t)

    return selectionKey(next) === selectionKey(t)
      ? next
      : { ...next, stat: null, statKey: '', statError: '', open: [], patches: [] }
  })
  await loadSelection($, false)
}

const pickCommit = ($: EngineInterface, index: number) =>
  show($, t => ({ ...t, ...clickCommit(t, index), isPinned: true }))

const pickBranch = ($: EngineInterface, side: 'base' | 'compare', name: string) =>
  show($, t => (side === 'base' ? { ...t, base: name } : { ...t, compare: name }))

const toggleFile = async ($: EngineInterface, path: string) => {
  await update($, timeline, t => {
    if (t.open.includes(path)) {
      return { ...t, open: t.open.filter(p => p !== path), patches: t.patches.filter(patch => patch.path !== path) }
    }

    const open = [...t.open, path].slice(-MAX_OPEN)

    return { ...t, open, patches: t.patches.filter(patch => open.includes(patch.path)) }
  })
  await loadPatches($, false)
}

const step = ($: EngineInterface, delta: number, count: number) =>
  update($, timeline, t => ({ ...t, start: stepStart(t.start, delta, count, nodeIds(t).length) }))

const actionsFor = ($: EngineInterface): Actions => ({
  refresh: () => void refresh($).catch(() => undefined),
  details: () => void openDetails($),
  mode: mode => void show($, t => ({ ...t, mode })),
  pickCommit: index => void pickCommit($, index),
  pickBranch: (side, name) => void pickBranch($, side, name),
  swap: () => void show($, t => ({ ...t, base: t.compare, compare: t.base })),
  step: (delta, count) => void step($, delta, count),
  toggleFile: path => void toggleFile($, path),
})

/** A node in words: its pull request or message, `Uncommitted changes`, or what came before. */
const nodeName = (t: GitDiffTimeline, index: number) => {
  if (index < 0) {
    const oldest = t.commits[0]

    return t.baseOfOldest === EMPTY_TREE.sha1 || t.baseOfOldest === EMPTY_TREE.sha256 || oldest === undefined
      ? 'nothing (before the first commit)'
      : `before ${commitTitle(oldest)}`
  }

  const commit = t.commits[index]

  return commit === undefined ? 'Uncommitted changes' : commitTitle(commit)
}

const when = (seconds: number) => `${shortDate(seconds)}, ${formatTime(seconds)}`

/** What a click does next: wait for the second commit, or start a comparison. */
const clickHint = (t: GitDiffTimeline) => {
  const waiting = nodeIds(t).indexOf(t.anchor)

  return waiting < 0
    ? 'Click a commit to see its changes · click two to compare them'
    : `Click another commit to compare it with ${nodeName(t, waiting)}`
}

const rangeTitle = (t: GitDiffTimeline) =>
  t.mode === 'branches' ? `${t.base} ← ${t.compare}` : `${nodeName(t, t.from)} → ${nodeName(t, t.to)}`

const roleOf = (t: GitDiffTimeline, index: number): CardNode['role'] =>
  index === t.to ? 'compare' : index === t.from ? 'base' : index > t.from && index < t.to ? 'between' : 'outside'

/** The window of commits the strip shows: where it starts and how many. */
const windowOf = (t: GitDiffTimeline, columns: number) => {
  const total = nodeIds(t).length
  const count = visibleCount(columns, total)
  const start = resolveStart(t.start, count, total)

  return { total, count, start, indexes: Array.from({ length: Math.min(count, total) }, (_, i) => start + i) }
}

const branchOptions = (t: GitDiffTimeline) =>
  t.branches.map(branch => ({
    value: branch.name,
    label: branch.name === t.branch ? `${branch.name} (current)` : branch.name,
  }))

/** The strip's first row: History or Branches, how to pick, the files view and a refresh. */
const controls = ({ Box, Text, Button, Select }: Kit, t: GitDiffTimeline, on: Actions): RenderElement => {
  const isHistory = t.mode === 'history'
  const pickers = isHistory ? (
    <Text dimColor>{clickHint(t)}</Text>
  ) : Select === null ? null : t.branches.length === 0 ? (
      <Text dimColor>No branches to compare.</Text>
    ) : (
      <Box flexDirection="row" columnGap={1} alignItems="center" flexWrap="wrap">
        <Select
          key="branch-base"
          label="Base"
          options={branchOptions(t)}
          value={t.base}
          onSelect={name => on.pickBranch('base', name)}
        />
        <Text dimColor>←</Text>
        <Select
          key="branch-compare"
          label="Compare"
          options={branchOptions(t)}
          value={t.compare}
          onSelect={name => on.pickBranch('compare', name)}
        />
        <Button key="swap" plain label="⇄" onPress={on.swap} />
      </Box>
    )

  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center" justifyContent="space-between">
      <Box flexDirection="row" columnGap={1} alignItems="center" flexWrap="wrap">
        <Button
          key="mode:history"
          label="History"
          {...(isHistory ? { variant: 'primary' as const } : {})}
          onPress={() => on.mode('history')}
        />
        <Button
          key="mode:branches"
          label="Branches"
          {...(isHistory ? {} : { variant: 'primary' as const })}
          onPress={() => on.mode('branches')}
        />
        {pickers}
      </Box>
      <Box flexDirection="row" columnGap={1}>
        <Button key="details" label="Files changed" onPress={on.details} />
        <Button key="refresh" plain label="↻" onPress={on.refresh} />
      </Box>
    </Box>
  )
}

/** The totals as text: the terminal's strip, and the files view's first line. */
const totals = ({ Box, Text }: Kit, t: GitDiffTimeline): RenderElement => {
  const stat = describeStat(t.stat)

  return (
    <Box flexDirection="row" columnGap={1}>
      {t.statError !== '' && <Text color={RED}>{t.statError}</Text>}
      {t.statError === '' && stat === null && <Text dimColor>Reading the diff…</Text>}
      {stat !== null && <Text>{stat.files}</Text>}
      {stat !== null && <Text color={GREEN}>{stat.added}</Text>}
      {stat !== null && <Text color={RED}>{stat.deleted}</Text>}
    </Box>
  )
}

const dotColor = (role: CardNode['role']) =>
  role === 'base' || role === 'compare' ? { color: ACCENT } : role === 'between' ? {} : { color: GRAY }

/** History: the card (a line of dots in text on the terminal), and under it a button per commit. */
const historyStrip = (kit: Kit, t: GitDiffTimeline, columns: number, on: Actions): RenderElement => {
  const { Box, Text, Button, Svg } = kit
  const { total, count, start, indexes } = windowOf(t, columns)
  const labels = dayLabels(indexes.map(i => t.commits[i]?.time ?? null))
  const nodes: CardNode[] = indexes.map((i, k) => {
    const commit = t.commits[i]

    return commit === undefined
      ? { label: 'Now', churn: 0, role: roleOf(t, i), isWorking: true, tip: 'Uncommitted changes' }
      : {
          label: labels[k] ?? '',
          churn: commit.added + commit.deleted,
          role: roleOf(t, i),
          isWorking: false,
          tip: `${commit.short} · ${commitTitle(commit)} · +${commit.added} −${commit.deleted}`,
        }
  })
  const title = `${t.branch} · ${plural(t.commits.length, 'commit')}${t.commits.length >= LOG_LIMIT ? ' shown' : ''}`
  const picture =
    Svg === null ? (
      <Box flexDirection="column">
        {totals(kit, t)}
        <Box flexDirection="row">
          <Box width={ARROW_W} />
          {nodes.map(node => (
            <Box width={SLOT_W} justifyContent="center">
              <Text {...dotColor(node.role)} bold={node.role === 'compare'}>
                {node.isWorking ? '○' : node.role === 'compare' ? '◉' : '●'}
              </Text>
            </Box>
          ))}
        </Box>
      </Box>
    ) : (
      <Svg
        source={historyCard({
          columns,
          nodes,
          title,
          stats: describeStat(t.stat),
          older: start,
          newer: total - start - indexes.length,
        })}
        alt={`${title}: ${rangeTitle(t)}`}
      />
    )

  return (
    <Box flexDirection="column">
      {picture}
      <Box flexDirection="row">
        <Box width={ARROW_W}>
          <Button key="prev" plain dimColor={start === 0} label="‹" onPress={() => on.step(-1, count)} />
        </Box>
        {indexes.map(i => {
          const commit = t.commits[i]
          const role = roleOf(t, i)
          const look =
            role === 'compare'
              ? { variant: 'primary' as const }
              : role === 'base'
                ? { variant: 'secondary' as const }
                : { plain: true as const, dimColor: role === 'outside' }

          return (
            <Box width={SLOT_W} justifyContent="center">
              <Button
                key={`node:${i}`}
                label={commit === undefined ? 'Now' : buttonLabel(commit)}
                {...look}
                onPress={() => on.pickCommit(i)}
              />
            </Box>
          )
        })}
        <Box width={ARROW_W} justifyContent="flex-end">
          <Button key="next" plain dimColor={start + count >= total} label="›" onPress={() => on.step(1, count)} />
        </Box>
      </Box>
      {messageRow(kit, t, t.from, '○')}
      {messageRow(kit, t, t.to, '●')}
    </Box>
  )
}

/** One end of the comparison: its mark, short sha, message and when. */
const messageRow = ({ Box, Text }: Kit, t: GitDiffTimeline, index: number, mark: string): RenderElement => {
  const commit = t.commits[index]
  const short = index < 0 ? t.baseOfOldest.slice(0, 7) : (commit?.short ?? '')

  return (
    <Box flexDirection="row" columnGap={1}>
      <Text color={ACCENT}>{mark}</Text>
      {short !== '' && <Text dimColor>{short}</Text>}
      <Box flexShrink={1}>
        <Text wrap="truncate-end">{nodeName(t, index)}</Text>
      </Box>
      {commit !== undefined && <Text dimColor>{when(commit.time)}</Text>}
    </Box>
  )
}

/** Branches: the fork card, or a line of words on the terminal. */
const branchStrip = (kit: Kit, t: GitDiffTimeline, columns: number): RenderElement => {
  const { Box, Text, Svg } = kit
  const compared = t.branchCompare
  const ahead = compared?.ahead ?? 0
  const behind = compared?.behind ?? 0
  const words = `${t.compare} is ${plural(ahead, 'commit')} ahead, ${behind} behind ${t.base}`

  if (Svg === null) {
    return (
      <Box flexDirection="column">
        <Text>{words}</Text>
        {totals(kit, t)}
      </Box>
    )
  }

  const mergeBase = compared?.mergeBase ?? null

  return (
    <Svg
      source={branchCard({
        columns,
        base: t.base,
        compare: t.compare,
        ahead,
        behind,
        aheadTips: compared?.aheadCommits.map(commitTitle) ?? [],
        behindTips: compared?.behindCommits.map(commitTitle) ?? [],
        mergeBase: mergeBase === null ? '' : `merge base ${mergeBase.short} · ${shortDate(mergeBase.time)}`,
        stats: describeStat(t.stat),
      })}
      alt={words}
    />
  )
}

const strip = (kit: Kit, t: GitDiffTimeline, columns: number, on: Actions): RenderElement => {
  const { Box } = kit

  return (
    <Box flexDirection="column">
      {controls(kit, t, on)}
      {t.mode === 'history' ? historyStrip(kit, t, columns, on) : branchStrip(kit, t, columns)}
    </Box>
  )
}

/** GitHub's five squares: a file's share of lines added and deleted. */
const blocks = (file: GitDiffFile) => {
  const total = (file.added ?? 0) + (file.deleted ?? 0)

  if (file.added === null || total === 0) {
    return { added: 0, deleted: 0 }
  }

  const added = Math.round((file.added / total) * BLOCKS)

  return { added, deleted: BLOCKS - added }
}

const patchView = ({ Box, Text, Code }: Kit, path: string, patch: GitDiffPatch | undefined): RenderElement => {
  if (patch === undefined) {
    return <Text dimColor>Loading the diff…</Text>
  }

  if (patch.note === 'binary') {
    return <Text dimColor>Binary file not shown.</Text>
  }

  if (patch.note === 'empty') {
    return <Text dimColor>No line changes: the file's mode or name changed.</Text>
  }

  if (patch.note !== '') {
    return <Text color={RED}>{patch.note}</Text>
  }

  return (
    <Box flexDirection="column">
      <Code source={patch.hunks} format="diff" path={path} />
      {patch.isCut && <Text dimColor>Diff cut to fit here; open the file to see the rest.</Text>}
    </Box>
  )
}

const fileRow = (kit: Kit, t: GitDiffTimeline, file: GitDiffFile, on: Actions): RenderElement => {
  const { Box, Text, Button } = kit
  const isOpen = t.open.includes(file.path)
  const share = blocks(file)
  const rest = BLOCKS - share.added - share.deleted

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        <Button
          key={`file:${file.path}`}
          plain
          label={`${isOpen ? '▾' : '▸'} ${file.path}`}
          onPress={() => on.toggleFile(file.path)}
        />
        <Text color={GREEN}>{file.added === null ? 'binary' : `+${file.added}`}</Text>
        {file.deleted !== null && <Text color={RED}>{`−${file.deleted}`}</Text>}
        <Box flexDirection="row">
          {share.added > 0 && <Text color={GREEN}>{'■'.repeat(share.added)}</Text>}
          {share.deleted > 0 && <Text color={RED}>{'■'.repeat(share.deleted)}</Text>}
          {rest > 0 && <Text dimColor>{'■'.repeat(rest)}</Text>}
        </Box>
      </Box>
      {isOpen && patchView(kit, file.path, t.patches.find(patch => patch.path === file.path))}
    </Box>
  )
}

const notice = ({ Text }: Kit, t: GitDiffTimeline): RenderElement => {
  switch (t.status) {
    case 'loading':
      return <Text dimColor>Reading git history…</Text>
    case 'no-repo':
      return <Text dimColor>{`Not a git repository: ${t.cwd}`}</Text>
    case 'error':
      return <Text color={RED}>{`git failed: ${t.message}`}</Text>
    default:
      return <Text dimColor>{t.message}</Text>
  }
}

/** One commit of a comparison: short sha, message and when, and the body's first line under it. */
const commitRow = ({ Box, Text }: Kit, commit: GitDiffCommit): RenderElement => {
  const title = commitTitle(commit)
  const detail = commit.body
    .split('\n')
    .map(line => line.trim())
    .find(line => line !== '' && !title.includes(line) && !line.startsWith('See merge request'))

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        <Text dimColor>{commit.short}</Text>
        <Box flexShrink={1}>
          <Text wrap="truncate-end">{title}</Text>
        </Box>
        <Text dimColor>{when(commit.time)}</Text>
      </Box>
      {detail !== undefined && (
        <Box paddingLeft={8}>
          <Text dimColor wrap="truncate-end">
            {detail}
          </Text>
        </Box>
      )}
    </Box>
  )
}

/** The commits the comparison takes in, newest first, as GitHub's compare page lists them. */
const commitList = (kit: Kit, t: GitDiffTimeline): RenderElement | null => {
  const { Box, Text } = kit
  const commits =
    t.mode === 'history' ? rangeCommits(t) : [...(t.branchCompare?.aheadCommits ?? [])].reverse()
  const total = t.mode === 'history' ? commits.length : (t.branchCompare?.ahead ?? commits.length)

  if (commits.length === 0) {
    return null
  }

  return (
    <Box flexDirection="column">
      <Text bold>{t.mode === 'history' ? plural(total, 'commit') : `${plural(total, 'commit')} on ${t.compare}`}</Text>
      {commits.slice(0, MAX_COMMITS).map(commit => commitRow(kit, commit))}
      {total > MAX_COMMITS && <Text dimColor>{`… ${total - MAX_COMMITS} older not listed`}</Text>}
    </Box>
  )
}

/** The files view: the commits compared, then what changed, file by file, as GitHub shows it. */
const filesView = (kit: Kit, t: GitDiffTimeline, on: Actions): RenderElement => {
  const { Box, Text } = kit
  const files = t.stat?.files ?? []
  const more = files.length - MAX_FILES
  const compared = t.branchCompare

  return (
    <Box flexDirection="column" rowGap={1}>
      {t.mode === 'branches' && compared !== null && (
        <Text dimColor>
          {`${t.compare} is ${plural(compared.ahead, 'commit')} ahead, ${compared.behind} behind ${t.base}` +
            (compared.mergeBase === null ? ' · no shared history' : ` · they split at ${compared.mergeBase.short}`)}
        </Text>
      )}
      {commitList(kit, t)}
      {totals(kit, t)}
      {files.slice(0, MAX_FILES).map(file => fileRow(kit, t, file, on))}
      {more > 0 && <Text dimColor>{`… ${plural(more, 'more file')} not listed`}</Text>}
      {t.mode === 'history' && refOf(t, t.to) === WORKING && t.untracked > 0 && (
        <Text dimColor>{`${plural(t.untracked, 'untracked file')} not in this diff`}</Text>
      )}
    </Box>
  )
}

const paneView = (kit: Kit, t: GitDiffTimeline, bodyColumns: number, on: Actions): RenderElement => {
  const { Box, Text, Button } = kit
  const isReady = t.status === 'ready'

  return (
    <Box flexDirection="column" paddingX={1} rowGap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row" columnGap={1} flexShrink={1}>
          <Text bold>Files changed</Text>
          {isReady && (
            <Box flexShrink={1}>
              <Text dimColor wrap="truncate-end">
                {rangeTitle(t)}
              </Text>
            </Box>
          )}
        </Box>
        {position === 'band' && <Button key="refresh" plain label="↻" onPress={on.refresh} />}
      </Box>
      {isReady && position === 'pane' && strip(kit, t, bodyColumns - 2, on)}
      {isReady ? filesView(kit, t, on) : notice(kit, t)}
    </Box>
  )
}

/** The strip is always on screen in a repository; the pane only counts while it is open. */
const refreshIfShown = async ($: EngineInterface) => {
  try {
    if (position === 'band' || (await $.ui.panes()).some(pane => pane.id === PANE)) {
      await refresh($)
    }
  } catch {
    // The view keeps its last good state; the next trigger tries again.
  }
}

/** One refresh per burst of tool calls, after the burst settles. */
const scheduleRefresh = ($: EngineInterface) => {
  if (pending !== undefined) {
    return
  }

  pending = $.clock.after(REFRESH_DELAY_MS, () => {
    pending = undefined
    void refreshIfShown($)
  })
}

const begin = async ($: EngineInterface) => {
  try {
    await refresh($)

    if (position === 'band') {
      // The strip replaces the side pane: close one an earlier load or setting left open.
      await $.ui.close({ id: PANE })

      return
    }

    const { status } = await read($, timeline)

    if (status !== 'no-repo' && status !== 'error') {
      wasPlaced = (await $.ui.open(PANE_ARGS)).isPlaced
    }
  } catch {
    // Opening the pane by hand (/gitdiff) shows the error.
  }
}

/**
 * A pane opened at session start is unasked, and a desktop that has not attached yet
 * seats it late or never. The first prompt of a repository session asks again: opened
 * with the person's prompt behind it, it is seated at any width.
 */
const offerOnce = async ($: EngineInterface) => {
  if (position !== 'pane' || hasOffered) {
    return
  }

  try {
    const { status } = await read($, timeline)

    if (status === 'loading') {
      return
    }

    hasOffered = true

    if (!wasPlaced && status !== 'no-repo' && status !== 'error') {
      wasPlaced = (await $.ui.open(PANE_ARGS)).isPlaced
    }
  } catch {
    // The pane stays as it was; /gitdiff opens it by hand.
  }
}

export const register: Register = (on, options) => {
  position = options.position === 'pane' ? 'pane' : 'band'

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'gitdiff', description: 'Open the Git Diff files view (what changed, file by file)' })
    void begin($)

    return next(e)
  })

  on('command.run', { command: 'gitdiff' }, async $ => {
    await refresh($).catch(() => undefined)

    const opened = await $.ui.open(PANE_ARGS)

    wasPlaced = opened.isPlaced

    return { text: opened.isPlaced ? 'Git Diff pane opened.' : `Git Diff pane is waiting: ${opened.reason}` }
  })

  on('prompt.submit', async ($, e, next) => {
    await offerOnce($)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    scheduleRefresh($)

    return done
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)

    if (WATCHED.has(e.tool)) {
      scheduleRefresh($)
    }

    return ran
  })

  // The strip above the prompt: drawn in a repository, left alone elsewhere.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (position !== 'band' || e.props.hasSurvey) {
      return next(e)
    }

    const t = await read($, timeline)

    if (t.status !== 'ready' && t.status !== 'error') {
      return next(e)
    }

    const kit = kitOf($.ui.resolve(e))
    const { Text } = kit

    return t.status === 'ready' ? (
      strip(kit, t, e.props.bodyColumns, actionsFor($))
    ) : (
      <Text color={RED}>{`Git Diff: git failed: ${t.message}`}</Text>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const t = await read($, timeline)

    return paneView(kitOf($.ui.resolve(e)), t, e.props.bodyColumns, actionsFor($))
  })
}
