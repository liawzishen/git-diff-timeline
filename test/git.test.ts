import { describe, expect, test } from 'claude-code/testing'

import {
  EMPTY_TREE,
  loadBranchCompare,
  loadPatch,
  loadStat,
  loadTimeline,
  parseBranches,
  parseLeftRight,
  parseLog,
  parseNumstat,
  toHunks,
} from '../hooks/git'
import type { Run } from '../hooks/git'

const RS = '\u001e'
const US = '\u001f'
const GS = '\u001d'

/** One `git log --format=%x1e%H%x1f%h%x1f%ct%x1f%s%x1f%b%x1d --shortstat` record. */
const record = (sha: string, time: number, subject: string, stat = '', body = '') =>
  `${RS}${sha}${US}${sha.slice(0, 7)}${US}${time}${US}${subject}${US}${body}${GS}\n${stat === '' ? '' : `\n ${stat}\n`}`

const result = (stdout: string, exitCode = 0, stderr = '') => ({ exitCode, stdout, stderr })

const ref = (refname: string, short: string, time: number, symref = '') => [refname, short, String(time), symref].join(US)

describe('reading git output', () => {
  test('parseLog reads each commit with its lines changed, oldest first', () => {
    const out = [
      record('c'.repeat(40), 300, 'three', '4 files changed, 172 insertions(+), 35 deletions(-)'),
      record('b'.repeat(40), 200, 'two', '1 file changed, 5 insertions(+)'),
      record('d'.repeat(40), 150, 'gone', '2 files changed, 7 deletions(-)'),
      record('a'.repeat(40), 100, 'one'),
    ].join('')
    const commits = parseLog(out)

    expect(commits.map(c => c.subject)).toEqual(['one', 'gone', 'two', 'three'])
    expect(commits[0]).toEqual({ sha: 'a'.repeat(40), short: 'aaaaaaa', time: 100, subject: 'one', body: '', added: 0, deleted: 0 })
    expect(commits[1]).toMatchObject({ added: 0, deleted: 7 })
    expect(commits[2]).toMatchObject({ added: 5, deleted: 0 })
    expect(commits[3]).toMatchObject({ added: 172, deleted: 35 })
  })

  test('parseLog keeps the message body, trimmed and cut short', () => {
    const merge = record(
      'a'.repeat(40),
      100,
      'Merge pull request #14 from me/premium-auth',
      '4 files changed, 172 insertions(+), 35 deletions(-)',
      'Premium auth: 50/50 split\n\nMore details\n',
    )
    const long = record('b'.repeat(40), 200, 'Long', '', 'x'.repeat(400))
    // git lists the newest first.
    const [first, second] = parseLog(long + merge)

    expect(first).toMatchObject({ body: 'Premium auth: 50/50 split\n\nMore details', added: 172, deleted: 35 })
    expect(second!.body).toHaveLength(300)
  })

  test('parseNumstat sums files and reads binary files as null', () => {
    const stat = parseNumstat('12\t3\tsrc/app.tsx\u0000-\t-\tlogo.png\u00005\t1\ta b.md\u0000')

    expect(stat.files).toEqual([
      { path: 'src/app.tsx', added: 12, deleted: 3 },
      { path: 'logo.png', added: null, deleted: null },
      { path: 'a b.md', added: 5, deleted: 1 },
    ])
    expect(stat.added).toBe(17)
    expect(stat.deleted).toBe(4)
  })

  test('parseBranches keeps local and remote branches and skips symbolic refs', () => {
    const out = [
      ref('refs/heads/main', 'main', 300),
      ref('refs/remotes/origin/HEAD', 'origin', 300, 'refs/remotes/origin/main'),
      ref('refs/remotes/origin/main', 'origin/main', 400),
    ].join('\n')

    expect(parseBranches(`${out}\n`)).toEqual([
      { name: 'main', time: 300, isRemote: false },
      { name: 'origin/main', time: 400, isRemote: true },
    ])
  })

  test('parseLeftRight reads behind then ahead', () => {
    expect(parseLeftRight('5\t9\n')).toEqual({ behind: 5, ahead: 9 })
    expect(parseLeftRight('')).toEqual({ behind: 0, ahead: 0 })
  })
})

describe('cutting a diff to hunks', () => {
  test('keeps everything from the first hunk and drops the file headers', () => {
    const diff = 'diff --git a/x.ts b/x.ts\nindex 1..2 100644\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-a\n+b\n c\n'

    expect(toHunks(diff)).toEqual({ hunks: '@@ -1,2 +1,2 @@\n-a\n+b\n c', isCut: false, note: '' })
  })

  test('says binary or empty when there is no hunk to draw', () => {
    expect(toHunks('diff --git a/l.png b/l.png\nBinary files a/l.png and b/l.png differ\n')).toEqual({
      hunks: '',
      isCut: false,
      note: 'binary',
    })
    expect(toHunks('diff --git a/x b/x\nold mode 100644\nnew mode 100755\n')).toEqual({ hunks: '', isCut: false, note: 'empty' })
  })

  test('removes carriage returns and replaces other control characters', () => {
    expect(toHunks('@@ -1 +1 @@\r\n-a\r\n+b\u0007\r\n').hunks).toBe('@@ -1 +1 @@\n-a\n+b�')
  })

  test('drops whole hunks past the limit', () => {
    const first = '@@ -1 +1 @@\n-a\n+b'
    const second = '@@ -9 +9 @@\n-c\n+d'
    const out = toHunks(`${first}\n${second}\n`, first.length + 5)

    expect(out).toEqual({ hunks: first, isCut: true, note: '' })
  })

  test('cuts a hunk too long for the limit and rewrites its line counts', () => {
    const big = '@@ -10,6 +10,6 @@ fn\n one\n-two\n+TWO\n three\n four\n five\n six\n'
    const out = toHunks(big, 48)
    const [header, ...body] = out.hunks.split('\n')
    const old = body.filter(line => line.startsWith(' ') || line.startsWith('-')).length
    const now = body.filter(line => line.startsWith(' ') || line.startsWith('+')).length

    expect(out.isCut).toBe(true)
    expect(out.hunks.length).toBeLessThanOrEqual(48)
    expect(body.length).toBeGreaterThan(0)
    expect(header).toBe(`@@ -10,${old} +10,${now} @@ fn`)
  })
})

describe('loading from git', () => {
  test('loadTimeline: outside a repository', async () => {
    const run: Run = async () => result('', 128, 'fatal: not a git repository\n')

    expect(await loadTimeline(run)).toMatchObject({ status: 'no-repo', message: 'fatal: not a git repository' })
  })

  test('loadTimeline: a repository with no commits', async () => {
    const run: Run = async argv =>
      argv[1] === 'rev-parse' && argv[2] === '--is-inside-work-tree'
        ? result('true\n')
        : argv[1] === 'branch'
          ? result('main\n')
          : result('', 128)

    expect(await loadTimeline(run)).toMatchObject({ status: 'no-commits', branch: 'main' })
  })

  const repo = (overrides: { parent?: boolean; originHead?: boolean } = {}): { run: Run; logs: string[][] } => {
    const logs: string[][] = []
    const run: Run = async argv => {
      const [, sub, flag] = argv

      switch (sub) {
        case 'rev-parse':
          if (flag === '--is-inside-work-tree') {
            return result('true\n')
          }

          if (argv.includes('--show-object-format')) {
            return result('sha1\n')
          }

          if (argv.some(arg => arg.endsWith('^'))) {
            return overrides.parent === false ? result('', 1) : result(`${'9'.repeat(40)}\n`)
          }

          return result(`${'b'.repeat(40)}\n`)
        case 'branch':
          return result('feature\n')
        case 'diff':
          return result('1\t0\tx.ts\0')
        case 'ls-files':
          return result('new.ts\0other.ts\0')
        case 'for-each-ref':
          return result(`${[ref('refs/heads/feature', 'feature', 9), ref('refs/heads/main', 'main', 5), ref('refs/remotes/origin/main', 'origin/main', 7)].join('\n')}\n`)
        case 'symbolic-ref':
          return overrides.originHead === false ? result('', 1) : result('origin/main\n')
        default:
          logs.push([...argv])

          return result(record('b'.repeat(40), 2, 'two', '1 file changed, 3 insertions(+)') + record('a'.repeat(40), 1, 'one'))
      }
    }

    return { run, logs }
  }

  test('loadTimeline: commits with their size, the working tree, branches and what the oldest commit is compared with', async () => {
    const { run, logs } = repo()
    const out = await loadTimeline(run)

    expect(out).toMatchObject({ status: 'ready', branch: 'feature', hasWorking: true, untracked: 2 })
    expect(out.commits.map(c => [c.subject, c.added])).toEqual([
      ['one', 0],
      ['two', 3],
    ])
    expect(out.baseOfOldest).toBe('9'.repeat(40))
    expect(out.branches.map(b => b.name)).toEqual(['feature', 'main', 'origin/main'])
    expect(out.defaultBase).toBe('origin/main')
    expect(logs[0]).toContain('--first-parent')
    expect(logs[0]).toContain('--shortstat')
  })

  test('loadTimeline: a root commit is compared with the empty tree, and the base falls back to a main branch', async () => {
    const out = await loadTimeline(repo({ parent: false, originHead: false }).run)

    expect(out.baseOfOldest).toBe(EMPTY_TREE.sha1)
    expect(out.defaultBase).toBe('origin/main')
  })

  test('loadStat diffs any revisions, the working tree included, and throws on failure', async () => {
    const seen: string[][] = []
    const run: Run = async argv => {
      seen.push([...argv])

      return argv.includes('bad') ? result('', 128, 'fatal: bad revision\n') : result('1\t1\tf.ts\0')
    }

    await loadStat(run, ['aaa'])
    await loadStat(run, ['aaa', 'bbb'])
    await loadStat(run, ['main...feature'])

    expect(seen).toEqual([
      ['git', 'diff', '--numstat', '-z', '--no-renames', 'aaa', '--'],
      ['git', 'diff', '--numstat', '-z', '--no-renames', 'aaa', 'bbb', '--'],
      ['git', 'diff', '--numstat', '-z', '--no-renames', 'main...feature', '--'],
    ])
    await expect(loadStat(run, ['bad'])).rejects.toThrow('fatal: bad revision')
  })

  test('loadPatch reads one file as hunks, and keeps the error as a note', async () => {
    const seen: string[][] = []
    const run: Run = async argv => {
      seen.push([...argv])

      return argv.includes('bad')
        ? result('', 128, 'fatal: bad revision\n')
        : result('diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n')
    }

    expect(await loadPatch(run, ['aaa', 'bbb'], 'src/a.ts')).toEqual({
      path: 'src/a.ts',
      hunks: '@@ -1 +1 @@\n-a\n+b',
      isCut: false,
      note: '',
    })
    expect(seen[0]).toEqual(['git', 'diff', '--no-color', '--no-ext-diff', '--no-renames', '-U3', 'aaa', 'bbb', '--', 'src/a.ts'])
    expect(await loadPatch(run, ['bad'], 'x.ts')).toEqual({ path: 'x.ts', hunks: '', isCut: false, note: 'fatal: bad revision' })
  })

  test('loadBranchCompare counts both sides and lists their commits, oldest first', async () => {
    const run: Run = async argv => {
      const last = argv[argv.length - 1]

      switch (argv[1]) {
        case 'rev-list':
          return result('5\t9\n')
        case 'merge-base':
          return result(`${'m'.repeat(40)}\n`)
        default:
          if (last === 'main..feature') {
            return result(record('f'.repeat(40), 30, 'f2') + record('e'.repeat(40), 20, 'f1'))
          }

          if (last === 'feature..main') {
            return result(record('k'.repeat(40), 25, 'm1'))
          }

          return result(record('m'.repeat(40), 10, 'base'))
      }
    }
    const out = await loadBranchCompare(run, 'main', 'feature')

    expect(out).toMatchObject({ ahead: 9, behind: 5, mergeBase: { sha: 'm'.repeat(40), subject: 'base' } })
    expect(out.aheadCommits.map(c => c.subject)).toEqual(['f1', 'f2'])
    expect(out.behindCommits.map(c => c.subject)).toEqual(['m1'])
  })

  test('loadBranchCompare: unrelated histories have no merge base, and a bad branch throws', async () => {
    const run: Run = async argv =>
      argv[1] === 'merge-base'
        ? result('', 1)
        : argv[1] === 'rev-list'
          ? argv.some(arg => arg.includes('nope'))
            ? result('', 128, "fatal: ambiguous argument 'nope...main'\n")
            : result('1\t1\n')
          : result('')

    expect(await loadBranchCompare(run, 'main', 'orphan')).toMatchObject({ mergeBase: null, ahead: 1, behind: 1 })
    await expect(loadBranchCompare(run, 'nope', 'main')).rejects.toThrow('ambiguous argument')
  })
})
