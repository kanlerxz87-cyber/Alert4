# COORDINATION.md — shared task board

Repo: `kanlerxz87-cyber/Alert4` · Target reference site: https://snapquast73-boop.github.io/LIVPBP/reviews.html?date=2026-08-26
Updated 2026-11-25 by session **`d8da4b48`** (branch `arena/d8da4b48-alert4`).

## Protocol

- Read this board before starting. Claim a task by writing your session ID and file scope, then commit and push the claim before starting work.
- Keep scopes non-overlapping. If you need a file owned by another session, log the request here instead of editing it.
- Make small, frequent commits and run `git pull --rebase` before every push.
- If you hit a merge conflict, stop, resolve without discarding other sessions' work, and log it.
- When done, record sources, verification performed, and any irregularities; mark the task done.
- Never mark anything verified without checking it against an official source, and link that source.
- Shared outputs (table data, site index/navigation) are changed only by a final integration session once all other tasks are done.
- A claim older than 60 minutes with no commits may be taken over; note the handoff.

## Branch / worktree note

Arena fixes each session to one branch. This session works on `arena/d8da4b48-alert4` (base `a24f7e1` on `main`). Per-session `session-<id>/<task>` branches cannot be created in this environment; deviations are logged here.

## Task board

| Task | Status | Session | File scope | Notes |
|---|---|---|---|---|
| Copy LIVPBP reference repo into Alert4 and verify site builds/runs | done | `076871a5` | full repo copy | Completed on `main` via PR #3 (`f00b6f1`). Source: https://github.com/snapquast73-boop/LIVPBP `main@5c02527d3c7a56ea66c698cfabff80a407b6dfd3`. See preserved log below. |
| T1 Copy LIVPBP source into Alert4 and adapt repo identity | done | `d8da4b48` | repo root (initial copy), `README.md`, `package.json`, `404.html`, `COORDINATION.md`, `flagged.html` identity refs | Independent copy on `arena/d8da4b48-alert4`; merged with main after 076871a5 landed. Same source commit `5c02527`. Base path `/LIVPBP/`->`/Alert4/`, homepage/name updated. |
| T2 Verify copied site builds/runs locally, links/assets resolve, no broken refs | done | `d8da4b48` | `tests/`, `tools/`, site files (read/verify) | `node tools/restoration-check.mjs` -> ALL CHECKS PASSED. `npm test` (`tools/smoke-test.mjs`) -> 64 passed, 0 failed. `node tests/run-all.mjs` -> syntax OK, 41 local refs OK, 8 contract bindings OK, jsdom 47 checks OK. |
| T3 Verify MLB StatsAPI data paths used by site against official sources | done | `d8da4b48` | `docs/verification-report.md`, `flagged.html` (read/verify) | Sandbox cannot reach statsapi.mlb.com (not in outbound allowlist); verified endpoint paths/shapes against copied source code, source verification docs, and live reference site. Official URLs recorded in verification log. |
| T4 Final integration: resolve main merge, tests pass, PR to main, merge, confirm Pages deploy | in progress | `d8da4b48` | repo root | Resolving add/add conflicts with origin/main (076871a5 work) preserving both sessions' work. |

## Verification log

| When | What was checked | Official source | Result |
|---|---|---|---|
| 2026-11-25 | Source repo exists and is public; identified files to copy | https://api.github.com/repos/snapquast73-boop/LIVPBP | Confirmed; default branch `main`, commit `5c02527d3c7a56ea66c698cfabff80a407b6dfd3` at fetch time |
| 2026-11-25 | Live reference site renders replay feed | https://snapquast73-boop.github.io/LIVPBP/reviews.html?date=2026-08-26 | Confirmed page renders with review/challenge/ABS tiles and 3 review rows for 2026-08-26 |
| 2026-11-25 | Local restoration checks pass after copy/adaptation | `node tools/restoration-check.mjs` (local) | ALL CHECKS PASSED |
| 2026-11-25 | Local smoke tests pass | `node tools/smoke-test.mjs` (local) | 64 passed, 0 failed |
| 2026-11-25 | Local full test suite passes | `node tests/run-all.mjs` (local) | syntax OK, link-check 41 refs OK, contract-check 8 bindings OK, jsdom 47 checks OK |
| 2026-11-25 | MLB schedule endpoint is the documented official source used by scoreboard | https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=YYYY-MM-DD (official MLB StatsAPI) | Not fetched from sandbox (statsapi.mlb.com not in sandbox outbound allowlist). Endpoint/path matches source code and README; reference site uses same endpoint. |
| 2026-11-25 | MLB gameStatus registry is the documented official source used by reviews | https://statsapi.mlb.com/api/v1/gameStatus (official MLB StatsAPI) | Not fetched from sandbox (allowlist). Endpoint present in `assets/js/reviews.js`/README; carried over from verified source. |
| 2026-11-25 | MLB eventTypes registry is the documented official source used by replay feed | https://statsapi.mlb.com/api/v1/eventTypes (official MLB StatsAPI) | Not fetched from sandbox (allowlist). Endpoint present in source and verified by source repo docs; carried over. |

## Irregularities / flagged items

| ID | Item | Status | Notes |
|---|---|---|---|
| F-001 | Arena branch restriction prevents `session-<id>/<task>` branches | logged | All work on `arena/d8da4b48-alert4`; PR used for integration. |
| F-002 | Historical flagged items inherited from source LIVPBP | needs review | See `flagged.html` — carried over from source repo with source links preserved; not re-adjudicated here except where tests verify behavior. |
| F-003 | Sandbox cannot directly fetch statsapi.mlb.com | logged | Outbound allowlist does not include statsapi.mlb.com; live MLB API responses were not re-fetched from sandbox. Static site calls MLB StatsAPI from user browser. Official endpoint URLs documented in `docs/verification-report.md` and verification log. |
| F-004 | Parallel session 076871a5 merged same LIVPBP copy to main (PR #3) while this session worked | logged | Merged origin/main into `arena/d8da4b48-alert4`, resolved add/add conflicts by keeping Alert4-adapted versions and merging COORDINATION/README, preserved 076871a5 log below. |

## Merge/conflict log

- 2026-11-25: `git merge origin/main` produced add/add conflicts in COORDINATION.md, README.md, package.json, flagged.html, docs/*, audit/*, tests/README.md, tests/link-check.mjs due to parallel copy by session 076871a5 (PR #3, merged as `f00b6f1`). Resolved by: merging COORDINATION.md boards (preserving 076871a5 log), merging README identity notes, keeping Alert4-adapted package/docs/flagged/test files. No other session work discarded.

## Handoff log

| When | From | To | Task | Reason |
|---|---|---|---|---|

## Preserved log — session 076871a5 (from main)

# COORDINATION.md — Alert4 (LIVPBP copy)

Shared task board for parallel agent sessions. Read before starting work. Claim tasks by writing your session ID and file scope, then commit and push the claim immediately.

## Status values
- `unclaimed`
- `in_progress`
- `done`
- `needs_review` (published on Flagged for Review page; does not block merge)

## Tasks

| Task | Status | Session | Scope (files/dirs) | Notes |
|------|--------|---------|--------------------|-------|
| Copy LIVPBP reference repo into Alert4 and verify site builds/runs | done | 076871a5 | `/` (full repo copy, excluding .git) | Copied from https://github.com/snapquast73-boop/LIVPBP `main@5c02527d3c7a56ea66c698cfabff80a407b6dfd3`. |

## Log

### 2026-11-25T20:40Z — session 076871a5
- Claimed: "Copy LIVPBP reference repo into Alert4 and verify site builds/runs".
- Scope: full repository contents (copy from reference repo).
- Plan: clone reference repo, copy files into Alert4, verify structure/tests/build, create PR, merge, confirm Pages deploy.

### 2026-11-25 — session 076871a5 (completion)
- **Source copied:** https://github.com/snapquast73-boop/LIVPBP (default branch `main`, commit `5c02527d3c7a56ea66c698cfabff80a407b6dfd3`).
- **Reference live site:** https://snapquast73-boop.github.io/LIVPBP/reviews.html?date=2026-08-26
- **Actions:**
  - Cloned reference repo (depth 1) and copied all files into Alert4 (excluding `.git`); preserved our repo-local COORDINATION.md.
  - Repo-local adaptations required for Alert4 deployment (recorded, no data fabrication):
    - `404.html`: base-href detection changed from `/LIVPBP/` to `/Alert4/` so GitHub Pages subpath works in this repo.
    - `package.json`: `homepage` updated to `https://kanlerxz87-cyber.github.io/Alert4/`.
    - `tests/jsdom-render-test.mjs`, `tests/props-provenance-test.mjs`: test URL base updated to Alert4 Pages URL (test logic unchanged).
    - `README.md`: added copy note and this-copy/upstream live demo links; historical audit/verification docs retain upstream provenance links.
- **Verification performed:**
  - `node tools/restoration-check.mjs` — ALL CHECKS PASSED (file refs, JS parse, server endpoints/static serving, .git/HEAD blocked, atBatIndex 0 merge preserved).
  - `node tools/smoke-test.mjs` (`npm test`) — **64 passed, 0 failed** (fixtures from official StatsAPI responses per repo tests; includes feed-log merge semantics, static asset integrity, deep-link/date handling, ABS/review parity checks).
  - `node tests/run-all.mjs` — PASS syntax, PASS link-check (41 local refs), PASS contract-check (8 bindings), PASS jsdom-render-test (47 checks).
  - Local server smoke: `node server.mjs` on port 8000 returned 200 for `/`, `/index.html`, `/reviews.html`, `/game.html`, `/flagged.html`, `/assets/js/reviews-feed.js`; `reviews.html` contained expected UI IDs (`date-picker`, `feed-list`, `feed-tabs`, `active-strip`, etc.).
- **Official sources used by the app (as copied from upstream):** MLB StatsAPI endpoints under `https://statsapi.mlb.com/api/` (see `docs/statsapi-field-map.md`, `docs/verification-report.md`, and `flagged.html` in repo for upstream-verified mappings/provenance). No MLB data values were invented in this session.
- **Irregularities / flags:** None introduced by this copy. Existing upstream flagged/unverified items remain published on `flagged.html` per upstream audit; they do not block merge.
- **PR / merge / Pages:** to be recorded after PR creation, merge, and Pages deploy verification.

