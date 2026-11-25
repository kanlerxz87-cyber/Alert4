# COORDINATION.md — shared task board

Repo: `kanlerxz87-cyber/Alert4` · Site: https://kanlerxz87-cyber.github.io/Alert4/
Reference site copied: https://snapquast73-boop.github.io/LIVPBP/ (repo `snapquast73-boop/LIVPBP`)
Updated 2026-11-25 by session **`arena-f17e9b8e`** (branch `arena/f17e9b8e-alert4`).

> **Two parallel sessions worked this repo on 2026-11-25.** Session `076871a5` imported the
> same source commit and merged PR #3 into `main` first; session `arena-f17e9b8e` (this board)
> merged `main` back into its branch without discarding either session's work, added the
> official-source re-verification report and Flagged-for-Review §15, and integrates via PR #4.
> Session `076871a5`'s board and log are preserved verbatim in the section
> "Board of session 076871a5 (preserved)" below. The merge/conflict record is at the end.

## Branch / worktree note (Arena sandbox restriction)

Arena fixes each session to one branch (`arena/f17e9b8e-alert4`, from `main` @ `a24f7e1`) and
forbids creating or pushing to any other branch, so the brief's `session-<id>/<task>` branch
rule cannot be followed literally. All work for this session lives on
**`arena/f17e9b8e-alert4`**; integration is a pull request from that branch into `main`.
(The source repo's sessions logged the same deviation; see the archived board.)

## Task board (session `arena-f17e9b8e`)

| Task | Status | Session | File scope | Notes |
|---|---|---|---|---|
| A1 Create board + claim scopes | done | `arena-f17e9b8e` | `COORDINATION.md` | Claim commit `9f11906` pushed before work started |
| A2 Copy `snapquast73-boop/LIVPBP` @ `5c02527` into this repo | done | `arena-f17e9b8e` | all site files | Verbatim import commit `ed34b2d`; `diff -r` clean; source board archived to `audit/source-repo-COORDINATION.md`. Session `076871a5` independently imported the same commit (PR #3) — duplicate work, merged cleanly |
| A3 Adapt repo-specific paths/links to Alert4 | done | `arena-f17e9b8e` | `404.html`, `package.json`, `README.md`, `tests/jsdom-render-test.mjs`, `tests/props-provenance-test.mjs`, `tests/link-check.mjs` | `/LIVPBP/` → `/Alert4/`, homepage/demo URLs, README copy note; no behavior changes |
| A4 Line-by-line verification vs official MLB StatsAPI | done | `arena-f17e9b8e` | `docs/verification-report-alert4.md`, `COORDINATION.md` | 18 live re-verification rows + 5 provenance rows, every one linked to the exact official request; see report |
| A5 Run full test suite + link check + local server smoke | done | `arena-f17e9b8e` | (read-only on tests) | restoration-check ALL PASSED · smoke 64/64 · run-all (syntax, 45 refs, 8 bindings, jsdom 47/47) · props-provenance 5/5 · server smoke all 200 |
| A6 Flagged for Review page | done (needs review items published) | `arena-f17e9b8e` | `flagged.html` | Sections 1–14 preserved verbatim; intro copy-note + section 15 added (A4-1…A4-10) |
| A7 Integration: PR → `main`, merge, confirm Pages deploy | in progress | `arena-f17e9b8e` | repo root | PR #4; main moved (PR #3) mid-session → merged back, conflicts resolved (record below) |

## Verification performed (summary — full table in `docs/verification-report-alert4.md`)

Provenance: source `main` HEAD = `5c02527d3c7a56ea66c698cfabff80a407b6dfd3`
(`git ls-remote`), reference Pages built from exactly that commit
([builds API](https://api.github.com/repos/snapquast73-boop/LIVPBP/pages/builds)),
copy byte-identical (`diff -r`). Only repo-path adaptations differ.

Official-source re-verification (2026-11-25, page-fetch channel; direct sockets to
statsapi.mlb.com blocked in sandbox, `curl` → `000`):

- Reference date slate: [schedule?date=2026-08-26](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-08-26&fields=dates,date,totalGames,games,gamePk,gameDate,officialDate,status,detailedState,teams,away,home,team,name,score) → 15 games, PHI@SEA 6–0 (`823096`), CIN@SF 10–9 (`823180`) — matches reference page.
- All 3 reference review rows verified verbatim in official play-by-play: [823096](https://statsapi.mlb.com/api/v1/game/823096/playByPlay?fields=allPlays,about,atBatIndex,inning,halfInning,result,description,eventType,reviewDetails,reviewType,isOverturned,inProgress,player,fullName,matchup,batter,pitcher,hasReview) (`:36` MF stands), [823180](https://statsapi.mlb.com/api/v1/game/823180/playByPlay?fields=allPlays,about,atBatIndex,inning,halfInning,result,description,eventType,reviewDetails,reviewType,isOverturned,inProgress,matchup,batter,pitcher,fullName,hasReview) (`:57` MA stands, `:84` NF stands); ABS `MJ` events at `823096:51`, `823180:58/65`.
- Counters: [823180 feed/live](https://statsapi.mlb.com/api/v1.1/game/823180/feed/live?fields=gameData,game,pk,status,detailedState,statusCode,review,absChallenges,away,home,used,remaining,usedSuccessful,usedFailed,hasChallenges) → `review.home{used:1,remaining:0}`, `absChallenges` away rem 2 / home rem 1 — matches reference rows; [schedule hydrate=review](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-08-26&hydrate=review&fields=dates,games,gamePk,review,hasChallenges,away,home,used,remaining) consistent.
- Registries: [gameStatus](https://statsapi.mlb.com/api/v1/gameStatus) (MF/MA/NF/NH/MJ/NJ/IH wording), [eventTypes](https://statsapi.mlb.com/api/v1/eventTypes) (`os_ruling_pending_primary/prior` = "Official Scorer Ruling Pending").
- Data endpoints: [linescore](https://statsapi.mlb.com/api/v1/game/823096/linescore), [boxscore](https://statsapi.mlb.com/api/v1/game/823096/boxscore), [people season+expected](https://statsapi.mlb.com/api/v1/people/663728/stats?stats=season,expectedStatistics&group=hitting&season=2026), [vsPlayer](https://statsapi.mlb.com/api/v1/people/682829/stats?stats=vsPlayer&group=hitting&opposingPlayerId=656849), [teams](https://statsapi.mlb.com/api/v1/teams?sportId=1) (all 30 abbreviations match `UI.TEAM_ABBR`).
- Upcoming game days: [2027 range](https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=2027-02-01&endDate=2027-04-15&fields=dates,date,totalGames) → 757 games, ST opens 2027-02-19, regular season 2027-03-25; [2027-02-19 slate](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2027-02-19&hydrate=probablePitcher) → 17 Preview/Scheduled games; [today](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-11-25&fields=dates,date,totalGames) → 0 games (offseason empty-state path). No code change needed for upcoming game days.
- Rule context: [MLB replay-review glossary](https://www.mlb.com/glossary/rules/replay-review) (challenge retained after overturn — explains official `used:1,remaining:1` counters).

## Irregularities / unverified (published on `flagged.html` §15, non-blocking)

- A4-8 (carried U-8/T-9): mlbstatic.com logo/headshot files return HTTP 500 to the fetch
  channel (binary/SVG) — unverified from this sandbox; unchanged from the working reference;
  initials fallback in UI. mlb.com's own share image confirms the host is MLB's asset CDN.
- A4-9: official `review.home{used:1,remaining:1}` on `824555`/`824963` — read as-is by design.
- A4-10: reference's "76 tracked entries" are browser-local; a fresh browser rebuilds from the
  official API (documented persistence design, not data loss).
- All inherited flags (U-1…U-11, I-8, F-001…F-009, L-1…L-4, RR-01…RR-06, D-1…D-4, AF-1…AF-7,
  R2-1…R2-11) preserved verbatim in `flagged.html` §§1–14 with original evidence links.

## Log (session `arena-f17e9b8e`)

- 2026-11-25 — created this board and claimed A1–A7 (board did not exist on this branch at
  claim time; session `076871a5`'s claim was on `main`, unseen until PR #4 reported a
  conflict — see merge record). Claim commit pushed immediately.
- 2026-11-25 — source repo state verified: `snapquast73-boop/LIVPBP` HEAD `5c02527` ("Merge pull
  request #33"); live reference page fetched (15 games, 76 tracked entries, 3 reviews /
  2 challenges / 1 umpire review / 27 ABS challenges).
- 2026-11-25 — verbatim import committed (`ed34b2d`), adaptations committed (`6e99faa`),
  full harness green, live re-verification complete, `flagged.html` §15 + verification report
  published (`bea811a`).
- 2026-11-25 — integration: PR #4 opened; `main` had advanced to `f00b6f1` (PR #3, session
  `076871a5`). Merged `origin/main` into this branch; conflicts resolved as recorded below.

---

## Board of session 076871a5 (preserved verbatim from `main` @ f00b6f1)

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

*(End of preserved board. Integration note appended by `arena-f17e9b8e`: session `076871a5`'s
PR [#3](https://github.com/kanlerxz87-cyber/Alert4/pull/3) was merged into `main` as `f00b6f1`;
its Pages deploy and the combined deploy are recorded in the integration log below.)*

---

## Merge / conflict record (2026-11-25, session `arena-f17e9b8e`)

`git merge origin/main` (f00b6f1, PR #3 by session `076871a5`) into `arena/f17e9b8e-alert4`
reported 5 conflicts. Both sessions had imported the **same source commit** (`5c02527`), so
the site code was identical; conflicts were only in repo-meta files. Resolutions (no work
discarded from either session):

| File | Resolution | Rationale |
|---|---|---|
| `COORDINATION.md` | Union: this session's board on top, session `076871a5`'s board + log preserved verbatim below, plus this record | Both boards are the shared task history |
| `README.md` | Kept the fuller COPY NOTE (mentions both sessions/PRs); took `076871a5`'s **relative** `flagged.html` link (more robust than absolute); merged both demo-link blocks | Superset of both sessions' text |
| `flagged.html` | Kept this session's version | `076871a5`'s file is the source verbatim (verified by diff); this session's is a strict superset (§§1–14 unchanged + intro note + §15) |
| `package.json` | Kept literal em-dash in description (source-verbatim); homepage identical on both sides | `076871a5`'s `\u2014` escape decodes to the same string — no semantic difference |
| `tests/link-check.mjs` | Kept `/Alert4/` comment wording | Comment-only; accurate for this repo (`076871a5` left `/LIVPBP/`) |

Auto-merged without conflict (identical adaptations on both sides): `404.html`,
`tests/jsdom-render-test.mjs`, `tests/props-provenance-test.mjs`, and all site assets.
Post-merge: full harness re-run on the combined tree (results in the integration log).

## Integration log (session `arena-f17e9b8e`)

- PR: https://github.com/kanlerxz87-cyber/Alert4/pull/4 (branch `arena/f17e9b8e-alert4` → `main`)
- Merge result / Pages deploy: appended after merge + deploy verification.
