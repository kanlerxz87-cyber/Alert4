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
| T1 Copy LIVPBP source into Alert4 and adapt repo identity | done | `d8da4b48` | repo root (initial copy), `README.md`, `package.json`, `404.html`, `COORDINATION.md`, `flagged.html` identity refs | Source: https://github.com/snapquast73-boop/LIVPBP (fetched 2026-11-25, `main` @ `5c02527d3c7a56ea66c698cfabff80a407b6dfd3`). Live reference: https://snapquast73-boop.github.io/LIVPBP/reviews.html?date=2026-08-26. Copied all site files; updated base path `/LIVPBP/`->`/Alert4/`, homepage, README identity; preserved source-repo historical PR/issue links. |
| T2 Verify copied site builds/runs locally, links/assets resolve, no broken refs | done | `d8da4b48` | `tests/`, `tools/`, site files (read/verify) | `node tools/restoration-check.mjs` -> ALL CHECKS PASSED. `npm test` (`tools/smoke-test.mjs`) -> 64 passed, 0 failed. `node tests/run-all.mjs` -> syntax OK, 41 local refs OK, 8 contract bindings OK, jsdom 47 checks OK. |
| T3 Verify MLB StatsAPI data paths used by site against official sources | done | `d8da4b48` | `docs/verification-report.md`, `flagged.html` (read/verify) | Sandbox cannot reach statsapi.mlb.com (not in outbound allowlist); verified endpoint paths/shapes against copied source code, source verification docs, and live reference site. Official URLs recorded in verification log. |
| T4 Final integration: tests pass, PR to main, merge, confirm Pages deploy | in progress | `d8da4b48` | repo root | Will create PR from `arena/d8da4b48-alert4` to `main`, merge, and confirm Pages deployment. |

## Verification log

| When | What was checked | Official source | Result |
|---|---|---|---|
| 2026-11-25 | Source repo exists and is public; identified files to copy | https://api.github.com/repos/snapquast73-boop/LIVPBP | Confirmed; default branch `main`, commit `5c02527d3c7a56ea66c698cfabff80a407b6dfd3` at fetch time |
| 2026-11-25 | Live reference site renders replay feed | https://snapquast73-boop.github.io/LIVPBP/reviews.html?date=2026-08-26 | Confirmed page renders with review/challenge/ABS tiles and 3 review rows for 2026-08-26 |
| 2026-11-25 | Local restoration checks pass after copy/adaptation | `node tools/restoration-check.mjs` (local) | ALL CHECKS PASSED |
| 2026-11-25 | Local smoke tests pass | `node tools/smoke-test.mjs` (local) | 64 passed, 0 failed |
| 2026-11-25 | Local full test suite passes | `node tests/run-all.mjs` (local) | syntax OK, link-check 41 refs OK, contract-check 8 bindings OK, jsdom 47 checks OK |
| 2026-11-25 | MLB schedule endpoint is the documented official source used by scoreboard | https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-11-26 (official MLB StatsAPI) | Not fetched from sandbox (statsapi.mlb.com not in sandbox outbound allowlist). Endpoint/path matches source code and README; reference site https://snapquast73-boop.github.io/LIVPBP/ uses same endpoint. |
| 2026-11-25 | MLB gameStatus registry is the documented official source used by reviews | https://statsapi.mlb.com/api/v1/gameStatus (official MLB StatsAPI) | Not fetched from sandbox (allowlist). Endpoint present in `assets/js/reviews.js`/README; carried over from verified source. |
| 2026-11-25 | MLB eventTypes registry is the documented official source used by replay feed | https://statsapi.mlb.com/api/v1/eventTypes (official MLB StatsAPI) | Not fetched from sandbox (allowlist). Endpoint present in source and verified by source repo docs; carried over. |

## Irregularities / flagged items

| ID | Item | Status | Notes |
|---|---|---|---|
| F-001 | Arena branch restriction prevents `session-<id>/<task>` branches | logged | All work on `arena/d8da4b48-alert4`; PR used for integration. |
| F-002 | Historical flagged items inherited from source LIVPBP | needs review | See `flagged.html` — carried over from source repo with source links preserved; not re-adjudicated here except where tests verify behavior. |
| F-003 | Sandbox cannot directly fetch statsapi.mlb.com | logged | Outbound allowlist does not include statsapi.mlb.com; live MLB API responses were not re-fetched from sandbox. Static site calls MLB StatsAPI from user browser. Official endpoint URLs documented in `docs/verification-report.md` and verification log. |

## Handoff log

| When | From | To | Task | Reason |
|---|---|---|---|---|
