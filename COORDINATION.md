# COORDINATION.md — shared task board

Repo: `kanlerxz87-cyber/Alert4` · Site: https://kanlerxz87-cyber.github.io/Alert4/
Updated 2026-11-25 (UTC) by session **`arena-fd8d4cdb-alert4`**.

## Branch / worktree note (Arena sandbox restriction)

Arena fixes this session to one branch and forbids creating or pushing to any other
branch, so the brief's `session-<id>/<task>` branch rule cannot be followed
literally. All work below happens on **`arena/fd8d4cdb-alert4`** (branched from
`main` @ `a24f7e1`); final integration is a pull request from this branch into
`main`. This deviation is logged as an irregularity for review (AF-COPY-1).

## Task board

| Task | Status | Session | File scope | Notes |
|---|---|---|---|---|
| C-1 Read board + claim copy/verification/integration work | in progress | `arena-fd8d4cdb-alert4` | `COORDINATION.md` | Claimed 2026-11-25; no other branches or claims exist in this repo (`git branch -a`, `gh api .../branches`: only `main`) |
| C-2 Copy the working upstream site (`snapquast73-boop/LIVPBP` @ `5c02527`, main) into this repo | unclaimed | `arena-fd8d4cdb-alert4` | all site files: `index.html`, `game.html`, `reviews.html`, `flagged.html`, `404.html`, `assets/**`, `docs/**`, `tests/**`, `tools/**`, `.github/workflows/**`, `server.mjs`, `package*.json`, `.gitignore`, `.nojekyll`, `LICENSE`, `README.md` | Verified source is the exact repository that publishes the user's reference page |
| C-3 Verify copied files line by line (official MLB StatsAPI links, no inferred values), run all check suites | unclaimed | `arena-fd8d4cdb-alert4` | verification log below; extend `docs/verification-report.md` / `flagged.html` only if a new irregularity is found | Final integration only |
| C-4 Integration: PR → `main`, merge, confirm Pages build + live pages, record PR/merge result here | unclaimed | `arena-fd8d4cdb-alert4` | `COORDINATION.md` | Final integration only; flagged items do not block |

## Source of truth for the copy

- Reference page supplied by the user: https://snapquast73-boop.github.io/LIVPBP/reviews.html?date=2026-08-26
- Publishing repository (GitHub API, verified): https://github.com/snapquast73-boop/LIVPBP
- Upstream commit copied: [`5c02527`](https://github.com/snapquast73-boop/LIVPBP/commit/5c02527) (`main`, includes PR #33, the 14-section Flagged for Review page and the reference-parity pass).
- No values are inferred: every verification row below links an official source, or is left blank and flagged.

## Verification log

| When | What was checked | Official / first-party source | Result |
|---|---|---|---|
| 2026-11-25 | Reference page is served by `snapquast73-boop/LIVPBP` and shows 3 reviews for 2026-08-26 | https://snapquast73-boop.github.io/LIVPBP/reviews.html?date=2026-08-26 | Confirmed |
| 2026-11-25 | Upstream repository exists and contains the full working site (HTML + assets + verification docs) | https://api.github.com/repos/snapquast73-boop/LIVPBP | Confirmed |
| 2026-11-25 | Destination repo Pages source is `main` at site root | https://api.github.com/repos/kanlerxz87-cyber/Alert4/pages | Confirmed (`build_type: legacy`, `source.branch: main`, `path: /`) |

## Merge / conflict log

No conflicts yet.
