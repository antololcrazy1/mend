[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/antololcrazy1/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/antololcrazy1/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend — one patch tool for every AI edit format

`mend` applies an edit an AI model wrote to a tree of text files. Models write edits in four
formats, and `mend` reads all four to one written specification (`SPEC.md` in the kit's starter,
which this repository does not ship — see below):

- **unified diffs**, often with wrong line numbers — hunks are matched by content, nearest the
  stated line number, not by trusting it;
- **SEARCH/REPLACE blocks** — the old lines must occur exactly once;
- **V4A patches** — `*** Begin Patch` / `*** Add File:` / `*** Delete File:` /
  `*** Update File:` / `*** Move to:` with anchored, cursor-ordered chunks;
- **JSON tool calls** — `create`, `str_replace` and `insert` objects, as one array or as
  JSON Lines.

Matching works at three tiers: exact lines, then lines equal once trailing whitespace is
removed, then lines equal once leading and trailing whitespace is removed (with new lines
re-indented to the file's own indentation at that tier). `--strict` matches exactly only.

Every file is changed or none: edits apply in patch order, a failed edit changes nothing and
the edits after it still run so every failure is reported; when any edit failed, no file is
written at all.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file, relative to the working directory (the root of the tree); when
  absent or `-`, the patch is read from standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a` or `json`; `auto`
  (the default) detects it.
- `--check` does everything but write: the same output and exit code, no file created,
  changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 prints one line per changed path (`A`/`D`/`M`, `R old -> new` for a move) and
`ok: <n> files`. Exit 1 prints one `error: <code> <path>` line per failed edit, then
`failed: <k> of <n> edits`. Exit 2 prints one line for a usage, missing-patch, format or
parse error.

## Running

Node 22, standard library alone — nothing is installed at run time:

```
node main.ts fix.patch
```

`runner.ts` (the kit's, unchanged) runs the CLI over a trial's checks when `MAKEFUN_ENV_URL`
is set; `check.ts` in the kit's starter runs it over the public practice set.

## Entry

Built for the make.fun bounty
[hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
("Build mend, one patch tool for every AI edit format", $100 total, 1st–10th $10 each).
Practice score: **1000** (100 of 100 public practice checks pass), plus 94 hand-written
edge-case checks derived from SPEC.md sentences the practice set does not show.

## License

MIT — see `LICENSE`.
