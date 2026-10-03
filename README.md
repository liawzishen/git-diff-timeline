# git-diff-timeline

A Claude Code mod that puts a Git Diff timeline above the prompt.

- **History:** a card of the branch's commits (first parent, so a merged pull request is one commit). Click a commit to see its changes; click a second commit to compare the two. The commit messages being compared show under the timeline, with merges named by their pull or merge request title.
- **Branches:** compare two branches the way a pull request would (`base...compare`): commits ahead and behind, where they split, and what the compare branch adds.
- **Files changed:** a side panel listing the compared commits and each changed file, with its diff.

It reads local git only, so it works with GitHub, GitLab or any other remote.

## Install

Load the folder as a plugin directory, for every session, through the `env` block of `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/git-diff-timeline",
    "CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"
  }
}
```

Or for one session: `claude --plugin-dir /path/to/git-diff-timeline`.

`/gitdiff` opens the files view. The `position` option (`band` or `pane`) chooses between the strip above the prompt and a side pane.

## Test

```bash
claude plugin test .
claude plugin validate .
```
