# COORDINATION.md — shared task board

Repo: `kanlerxz87-cyber/Alert4` · Target site: https://kanlerxz87-cyber.github.io/Alert4/
Reference site being copied: https://snapquast73-boop.github.io/LIVPBP/ (repo `snapquast73-boop/LIVPBP`)
Updated 2026-11-25 by session **`arena-f17e9b8e`** (branch `arena/f17e9b8e-alert4`).

## Branch / worktree note (Arena sandbox restriction)

Arena fixes each session to one branch (`arena/f17e9b8e-alert4`, from `main` @ `a24f7e1`) and
forbids creating or pushing to any other branch, so the brief's `session-<id>/<task>` branch
rule cannot be followed literally. All work for this session lives on
**`arena/f17e9b8e-alert4`**; integration is a pull request from that branch into `main`.
(The source repo's sessions logged the same deviation; see the archived board.)

## Task board (session `arena-f17e9b8e`)

| Task | Status | Session | File scope | Notes |
|---|---|---|---|---|
| A1 Create board + claim scopes | in progress | `arena-f17e9b8e` | `COORDINATION.md` | This file; claim pushed before work starts |
| A2 Copy `snapquast73-boop/LIVPBP` @ `5c02527` into this repo | unclaimed → claimed | `arena-f17e9b8e` | all site files (see below) | Verbatim copy; source board archived to `audit/source-repo-COORDINATION.md` |
| A3 Adapt repo-specific paths/links to Alert4 | unclaimed → claimed | `arena-f17e9b8e` | `404.html`, `package.json`, `README.md`, `tests/jsdom-render-test.mjs`, `tests/props-provenance-test.mjs`, `tests/link-check.mjs` | `/LIVPBP/` → `/Alert4/`, homepage/demo URLs |
| A4 Line-by-line verification vs official MLB StatsAPI | unclaimed → claimed | `arena-f17e9b8e` | `docs/verification-report-alert4.md`, `COORDINATION.md` | Every endpoint/field re-checked against statsapi.mlb.com; links recorded |
| A5 Run full test suite + link check + local server smoke | unclaimed → claimed | `arena-f17e9b8e` | (read-only on tests) | `tools/restoration-check.mjs`, `tools/smoke-test.mjs`, `tests/run-all.mjs` |
| A6 Flagged for Review page | unclaimed → claimed | `arena-f17e9b8e` | `flagged.html` | Carry over source flags verbatim + append Alert4-copy findings |
| A7 Integration: PR → `main`, merge, confirm Pages deploy | unclaimed → claimed | `arena-f17e9b8e` | repo root | PR link + merge result recorded here when done |

File scope for A2 (verbatim copy from source @ `5c02527`): `.github/`, `.gitignore`, `.nojekyll`,
`404.html`, `LICENSE`, `README.md`, `assets/`, `audit/`, `docs/`, `flagged.html`, `game.html`,
`index.html`, `package.json`, `package-lock.json`, `reviews.html`, `server.mjs`, `tests/`, `tools/`.
Source `COORDINATION.md` is archived (not used as this repo's board).

## Log

- 2026-11-25 — session `arena-f17e9b8e` created this board and claimed A1–A7 (no other session
  has claimed anything in this repo; board did not exist before). Claim commit pushed immediately.
- Source repo state verified: `snapquast73-boop/LIVPBP` HEAD `5c02527` ("Merge pull request #33"),
  live reference page fetched successfully (reviews.html?date=2026-08-26 shows 15 games, 76 tracked
  entries, 3 reviews / 2 challenges / 1 umpire review / 27 ABS challenges).
