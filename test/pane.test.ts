import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const RS = '\u001e'
const US = '\u001f'
const GS = '\u001d'
const NUL = '\u0000'
const NUMSTAT = `12\t3\tsrc/app.tsx${NUL}-\t-\tlogo.png${NUL}5\t0\tREADME.md${NUL}`
const BASE = Math.floor(new Date(2026, 0, 2, 10, 15).getTime() / 1000)

const sha = (n: number) => String(n).padStart(40, '0')
const record = (n: number) =>
  `${RS}${sha(n)}${US}${sha(n).slice(0, 7)}${US}${BASE + n * 86_400}${US}commit ${n}${US}Body of commit ${n}${GS}\n\n 1 file changed, ${n + 1} insertions(+)\n`
const LOG = [5, 4, 3, 2, 1, 0].map(record).join('')
const patch = (path: string) =>
  path === 'logo.png'
    ? 'diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n'
    : `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,2 @@\n-old line\n+new line\n context\n`
const BRANCHES = [
  ['refs/heads/main', 'main', '9', ''],
  ['refs/heads/feature', 'feature', '8', ''],
  ['refs/remotes/origin/main', 'origin/main', '7', ''],
]
  .map(fields => fields.join(US))
  .join('\n')

const answer = (stdout: string, exitCode = 0, stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

type Opened = { value: { isPlaced: true } | { isPlaced: false; reason: string } }

const placed: Opened = { value: { isPlaced: true } }

const world = (on: On, { isDirty, open }: { isDirty: boolean; open?: () => Opened }) => {
  const diffs: string[][] = []

  on('session.cwd', () => ({ value: '/repo' }))
  on('command.register', () => ({ value: { command: 'gitdiff' } }))
  on('ui.open', open ?? (() => placed))
  on('process.run', (_$, e) => {
    const argv = e.argv
    const [, sub, flag] = argv
    const last = argv[argv.length - 1] ?? ''

    switch (sub) {
      case 'rev-parse':
        if (flag === '--is-inside-work-tree') {
          return answer('true\n')
        }

        return answer(argv.some(arg => arg.endsWith('^')) ? `${'9'.repeat(40)}\n` : `${sha(5)}\n`)
      case 'branch':
        return answer('main\n')
      case 'ls-files':
        return answer('')
      case 'for-each-ref':
        return answer(`${BRANCHES}\n`)
      case 'symbolic-ref':
        return answer('origin/main\n')
      case 'rev-list':
        return answer('5\t9\n')
      case 'merge-base':
        return answer(`${sha(2)}\n`)
      case 'diff':
        diffs.push([...argv])

        if (argv.includes('-U3')) {
          return answer(patch(last))
        }

        return answer(argv.includes('HEAD') ? (isDirty ? NUMSTAT : '') : NUMSTAT)
      default:
        if (argv.includes('-1')) {
          return answer(record(2))
        }

        return answer(last.includes('..') ? record(4) + record(3) : LOG)
    }
  })

  return { diffs }
}

const PANE = {
  title: 'Git Diff',
  isFocused: false,
  bodyColumns: 84,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 18 },
  view: {},
} as const

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 12 },
  view: {},
} as const

const PLUGIN = 'git-diff-timeline'

describe('the strip above the prompt', () => {
  test('desktop: one click shows that commit and its message, a second click compares the two', async ($, on) => {
    let opens = 0

    world(on, {
      isDirty: true,
      open: () => {
        opens += 1

        return placed
      },
    })
    await $.command.run({ command: 'gitdiff' })

    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: { columns: 120, rows: 30 } })

    expect(await band.find({ type: 'Svg' })).toBeDefined()
    expect(await band.find({ type: 'Select' })).toBeUndefined()
    expect(await band.find({ key: 'node:0' })).toBeDefined()
    expect(await band.find({ key: 'node:6' })).toMatchObject({ props: { label: 'Now' } })

    const before = opens

    await band.press({ key: 'node:2' })

    expect(opens).toBe(before + 1)
    expect(await band.find({ type: 'Text', text: 'commit 1' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'commit 2' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'Click another commit' })).toBeDefined()

    await band.press({ key: 'node:5' })

    expect(await band.find({ type: 'Text', text: 'Click another commit' })).toBeUndefined()

    const pane = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: 'git-diff', props: PANE, viewport: { columns: 84, rows: 30 } })

    expect(await pane.find({ type: 'Text', text: 'commit 2 → commit 5' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '3 commits' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Body of commit 4' })).toBeDefined()
    expect(await pane.find({ key: 'file:src/app.tsx' })).toBeDefined()
    expect(await pane.find({ type: 'Code' })).toMatchObject({ props: { format: 'diff', path: 'src/app.tsx' } })
  })

  test('terminal: no picture, the same commit buttons', async ($, on) => {
    world(on, { isDirty: false })
    await $.command.run({ command: 'gitdiff' })

    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND, viewport: { columns: 120, rows: 30 } })

    expect(await band.find({ type: 'Svg' })).toBeUndefined()
    expect(await band.find({ type: 'Select' })).toBeUndefined()
    expect(await band.find({ key: 'node:5' })).toMatchObject({ props: { label: sha(5).slice(0, 7) } })
    expect(await band.find({ key: 'node:6' })).toBeUndefined()

    await band.press({ key: 'node:3' })

    const pane = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'git-diff', props: PANE, viewport: { columns: 84, rows: 30 } })

    expect(await pane.find({ type: 'Code' })).toBeDefined()
  })

  test('paging shows older commits', async ($, on) => {
    world(on, { isDirty: true })
    await $.command.run({ command: 'gitdiff' })

    const narrow = { ...BAND, bodyColumns: 40 }
    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: narrow, viewport: { columns: 40, rows: 30 } })

    expect(await band.find({ key: 'node:6' })).toBeDefined()
    expect(await band.find({ key: 'node:2' })).toBeUndefined()

    await band.press({ key: 'prev' })

    expect(await band.find({ key: 'node:2' })).toBeDefined()
    expect(await band.find({ key: 'node:6' })).toBeUndefined()
  })

  test('branches: two branches, how far apart they are, and what the compare branch adds', async ($, on) => {
    const { diffs } = world(on, { isDirty: false })

    await $.command.run({ command: 'gitdiff' })

    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: { columns: 120, rows: 30 } })

    await band.press({ key: 'mode:branches' })

    expect(await band.find({ key: 'branch-base' })).toMatchObject({ props: { value: 'origin/main' } })
    expect(await band.find({ key: 'branch-compare' })).toMatchObject({ props: { value: 'main' } })
    expect(await band.find({ type: 'Svg' })).toBeDefined()

    await band.select({ key: 'branch-compare', value: 'feature' })

    const pane = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: 'git-diff', props: PANE, viewport: { columns: 84, rows: 30 } })

    expect(await pane.find({ type: 'Text', text: '9 commits ahead, 5 behind' })).toBeDefined()
    expect(await pane.find({ type: 'Code' })).toBeDefined()
    expect(diffs.some(argv => argv.includes('origin/main...feature'))).toBe(true)
  })

  test('stays out of the way outside a repository', async ($, on) => {
    on('session.cwd', () => ({ value: '/tmp' }))
    on('command.register', () => ({ value: { command: 'gitdiff' } }))
    on('ui.open', () => placed)
    on('process.run', () => answer('', 128, 'fatal: not a git repository\n'))
    // Beneath the plugin: what the engine itself draws in the band, which is nothing.
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }))

    await $.command.run({ command: 'gitdiff' })

    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: { columns: 120, rows: 30 } })

    expect(await band.find({ type: 'Button' })).toBeUndefined()
  })

  test('is not drawn when the setting asks for the side pane', { options: { position: 'pane' } }, async ($, on) => {
    world(on, { isDirty: true })
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }))

    await $.command.run({ command: 'gitdiff' })

    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: BAND, viewport: { columns: 120, rows: 30 } })

    expect(await band.find({ key: 'node:0' })).toBeUndefined()
  })

  test('a session start closes a leftover side pane in band mode', async ($, on) => {
    const calls: string[] = []
    const clock = mock.clock(on)

    world(on, {
      isDirty: false,
      open: () => {
        calls.push('open')

        return placed
      },
    })
    on('ui.close', () => {
      calls.push('close')

      return { value: undefined }
    })
    on('session.start', (_$, e) => ({ cwd: e.cwd }))

    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
    await clock.settle()

    expect(calls).toEqual(['close'])
  })
})

describe('the files view', () => {
  test('a file’s diff opens and closes from its name, and a binary file says so', async ($, on) => {
    world(on, { isDirty: true })
    await $.command.run({ command: 'gitdiff' })

    const pane = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: 'git-diff', props: PANE, viewport: { columns: 84, rows: 30 } })

    expect(await pane.find({ type: 'Text', text: '3 files changed' })).toBeDefined()
    expect(await pane.findAll({ type: 'Code' })).toHaveLength(1)

    await pane.press({ key: 'file:README.md' })

    expect(await pane.findAll({ type: 'Code' })).toHaveLength(2)

    await pane.press({ key: 'file:src/app.tsx' })

    expect(await pane.findAll({ type: 'Code' })).toHaveLength(1)

    await pane.press({ key: 'file:logo.png' })

    expect(await pane.find({ type: 'Text', text: 'Binary file not shown' })).toBeDefined()
  })

  test('says so outside a repository', async ($, on) => {
    on('session.cwd', () => ({ value: '/tmp' }))
    on('command.register', () => ({ value: { command: 'gitdiff' } }))
    on('ui.open', () => placed)
    on('process.run', () => answer('', 128, 'fatal: not a git repository\n'))

    await $.command.run({ command: 'gitdiff' })

    const pane = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: 'git-diff', props: PANE, viewport: { columns: 84, rows: 30 } })

    expect(await pane.find({ type: 'Text', text: 'Not a git repository: /tmp' })).toBeDefined()
    expect(await pane.find({ type: 'Code' })).toBeUndefined()
  })

  test('with the side-pane setting, the pane carries the timeline too', { options: { position: 'pane' } }, async ($, on) => {
    world(on, { isDirty: false })

    const ran = await $.command.run({ command: 'gitdiff' })

    expect(ran.text).toBe('Git Diff pane opened.')

    const pane = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: 'git-diff', props: PANE, viewport: { columns: 84, rows: 30 } })

    expect(await pane.find({ type: 'Svg' })).toBeDefined()
    expect(await pane.find({ key: 'node:5' })).toBeDefined()
    expect(await pane.find({ type: 'Code' })).toBeDefined()
  })

  test('a session start opens the side pane when the setting asks for it', { options: { position: 'pane' } }, async ($, on) => {
    const calls: string[] = []
    const clock = mock.clock(on)

    world(on, {
      isDirty: false,
      open: () => {
        calls.push('open')

        return placed
      },
    })
    on('ui.close', () => {
      calls.push('close')

      return { value: undefined }
    })
    on('session.start', (_$, e) => ({ cwd: e.cwd }))

    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
    await clock.settle()

    expect(calls).toEqual(['open'])
  })

  test('the first prompt asks again when the pane was left waiting, and only once', { options: { position: 'pane' } }, async ($, on) => {
    const opens: boolean[] = []

    world(on, {
      isDirty: false,
      open: () => {
        const isPlaced = opens.length > 0

        opens.push(isPlaced)

        return isPlaced ? placed : { value: { isPlaced: false as const, reason: 'too narrow' } }
      },
    })
    on('prompt.submit', (_$, e) => ({ text: e.text }))

    const ran = await $.command.run({ command: 'gitdiff' })

    expect(ran.text).toBe('Git Diff pane is waiting: too narrow')
    expect(opens).toEqual([false])

    const submit = { text: 'hello', wait: false, origin: { kind: 'composer' as const } }

    await $.prompt.submit(submit)
    await $.prompt.submit(submit)

    expect(opens).toEqual([false, true])
  })
})
