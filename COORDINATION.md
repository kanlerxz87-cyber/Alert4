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
| C-1 Read board + claim copy/verification/integration work | done | `arena-fd8d4cdb-alert4` | `COORDINATION.md` | Claim committed/pushed before any other file was touched (`5dc701a`). No other branches or claims existed (`git branch -a`, `gh api .../branches`: only `main`) |
| C-2 Copy the working upstream site (`snapquast73-boop/LIVPBP` @ `5c02527`, main) into this repo | done | `arena-fd8d4cdb-alert4` | all site files: `index.html`, `game.html`, `reviews.html`, `flagged.html`, `404.html`, `assets/**`, `docs/**`, `tests/**`, `tools/**`, `.github/workflows/**`, `server.mjs`, `package*.json`, `.gitignore`, `.nojekyll`, `LICENSE`, `README.md` | Verified source is the exact revision published by the reference site's Pages build. 40/40 tracked files SHA-256 identical; upstream board preserved as `docs/upstream-coordination.md` |
| C-3 Verify copied files line by line (official MLB StatsAPI links, no inferred values), run all check suites | done | `arena-fd8d4cdb-alert4` | `docs/copy-verification.md` (new), `flagged.html` §15, `README.md` copy note | 64/64 smoke, 47/47 jsdom, 41 links, 8 bindings, restoration + props suites pass; S1–S4 re-fetched from official StatsAPI. `flagged.html` §15 lists COPY-1…COPY-5 |
| C-4 Integration: PR → `main`, merge, confirm Pages build + live pages, record PR/merge result here | in progress | `arena-fd8d4cdb-alert4` | `COORDINATION.md` | Final integration only; flagged items do not block |

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
| 2026-11-25 | Source Pages build used commit `5c02527d3c7a56ea66c698cfabff80a407b6dfd3` (the copied revision) | https://api.github.com/repos/snapquast73-boop/LIVPBP/pages/builds/latest | Confirmed (`status: built`) |
| 2026-11-25 | 40/40 upstream tracked files copied byte-for-byte (SHA-256) | https://github.com/snapquast73-boop/LIVPBP/tree/5c02527d3c7a56ea66c698cfabff80a407b6dfd3 | Confirmed, 0 mismatches |
| 2026-11-25 | PHI @ SEA review row `823096:36:p:MF`: description, `reviewType: MF`, `challengeTeamId: 136`, score 6–0 | https://statsapi.mlb.com/api/v1/game/823096/playByPlay?fields=allPlays,about,atBatIndex,inning,halfInning,result,description,awayScore,homeScore,reviewDetails,isOverturned,inProgress,reviewType,challengeTeamId,matchup,batter,fullName,pitcher | Confirmed; Before-review score remains unobserved (not inferred) |
| 2026-11-25 | CIN @ SF review row `823180:57:p:MA`: description and score 3–6 | https://statsapi.mlb.com/api/v1/game/823180/playByPlay?fields=allPlays,result,description,awayScore,homeScore,about,atBatIndex,inning,halfInning | Confirmed |
| 2026-11-25 | CIN @ SF review row `823180:84:p:NF`: description and score 10–9; final linescore 10–9 | https://statsapi.mlb.com/api/v1/game/823180/linescore | Confirmed |
| 2026-11-25 | Upcoming game days are available from the official schedule (2027-04-06: 15 games) | https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2027-04-06&fields=dates,games,gamePk,gameDate,status,teams | Confirmed |
| 2026-11-25 | Static link/contract/render/smoke/props/server suites on the copied tree | `node tests/run-all.mjs`, `npm test`, `node tools/restoration-check.mjs`, `node tests/props-provenance-test.mjs` | All pass: 41 links, 8 bindings, 47/47 jsdom, 64/64 smoke, restoration ALL PASSED, props 5/5 |
| 2026-11-25 | Optional live-API render mode from this sandbox | `node tests/jsdom-render-test.mjs --live` | **Inconclusive**: shell egress to statsapi.mlb.com blocked (SSL error) and 13 assertions expect the 2026-08-28 slate; official endpoints were fetched separately. Published as COPY-4 |

Irregularities recorded for review: `COPY-1` (branch constraint), `COPY-2` (upstream reconstruction),
`COPY-3` (upstream provenance links), `COPY-4` (sandbox live-test limitation), `COPY-5` (no
values changed — confirmed). All are published with source links in
[`docs/copy-verification.md`](docs/copy-verification.md) and [`flagged.html`](flagged.html) §15.
The upstream board and its 14 sections of flags are preserved unchanged in
[`docs/upstream-coordination.md`](docs/upstream-coordination.md) and `flagged.html` §§1–14.

## Merge / conflict log

None during the copy (the branch was clean at `a24f7e1` and no other session claimed work).

Rebase status: `git fetch origin` showed only `main` and this session's branch; remote `main`
unchanged at `a24f7e1`. `git pull --rebase origin arena/fd8d4cdb-alert4` found no remote branch
at claim time; the claim was pushed with `git push -u`. No conflicts encountered.
