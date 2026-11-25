# COORDINATION.md — Alert4 shared task board (copy of snapquast73-boop/LIVPBP)

Read this file before starting work in this repository. The board for the initial
site copy is in the sessions below; the upstream project's board (history, not
active for this repo) is preserved byte-for-byte at
[docs/upstream-coordination.md](docs/upstream-coordination.md).

> ## INTEGRATION MERGES (2026-11-25) — three parallel copy sessions, one site
>
> On 2026-11-25 three Arena sessions independently copied `snapquast73-boop/LIVPBP` (`main` @ `5c02527d3c7a56ea66c698cfabff80a407b6dfd3`) into this repo and opened PRs to `main`:
>
> | Session | PR | Status | Unique contribution |
> |---|---|---|---|
> | `076871a5` | [#3](https://github.com/kanlerxz87-cyber/Alert4/pull/3) | **MERGED** 2026-11-25T20:48Z (merge commit `f00b6f1`) | First copy on `main`; repo-local adaptations (`/Alert4/` base path in `404.html`, `package.json` homepage, two test-harness URLs). |
> | `fd8d4cdb` | [#1](https://github.com/kanlerxz87-cyber/Alert4/pull/1) | **MERGED** 2026-11-25T~21:05Z (merge commit `102f9c4`) | Copy + `docs/copy-verification.md` (SHA-256 byte-identity of all 40 files, official-source spot-checks S1–S4 incl. live StatsAPI fetches), `flagged.html` §15 (COPY-1…COPY-7), Pages-delivery CI guard (skip only a published revision without `index.html`), upstream board moved to `docs/upstream-coordination.md`. |
> | `9572372b` | [#2](https://github.com/kanlerxz87-cyber/Alert4/pull/2) | **MERGED** 2026-11-25 (merge commit: see PR #2 and `git log --merges`; the post-merge Pages build is confirmed in the follow-up record on `main`) | `flagged.html` §16 (C-1…C-5), union of all three sessions in this file, Alert4-local link fixes in `tests/README.md` and `tests/link-check.mjs`, `README.md` COPY NOTE. |
>
> **Merge 1 — `9572372b` merges `origin/main` (PR #3, `f00b6f1`) into `arena/9572372b-alert4`** (conflicts: `COORDINATION.md`, `README.md`, `flagged.html`, `package.json`, `tests/README.md`, `tests/link-check.mjs`): unioned both boards in `COORDINATION.md`; kept both the COPY NOTE and the this-copy/upstream live-demo block in `README.md`; kept this branch's `flagged.html` (upstream + its §15 at the time); kept upstream bytes for `package.json`'s em-dash description; kept this branch's `/Alert4/` `tests/link-check.mjs` comment and Alert4 blob URLs in `tests/README.md`. Nothing was discarded.
>
> **Merge 2 — `9572372b` merges `origin/main` (PR #1, `102f9c4`) into `arena/9572372b-alert4`** (conflicts: `COORDINATION.md`, `README.md`, `flagged.html`):
> - `README.md` — single unified COPY NOTE crediting all three sessions' adaptations; this-copy and upstream live-demo links kept; removed a non-existent fragment anchor (`flagged.html#…` — the page uses no `id`s).
> - `flagged.html` — **both** copy sections kept: `fd8d4cdb`'s §15 verbatim, `9572372b`'s renumbered to **§16** and its parallel-sessions paragraph updated to name both `076871a5` and `fd8d4cdb` with their PR/merge links. Upstream §§1–14 untouched.
> - `COORDINATION.md` — union of all three boards: this session's board below, `fd8d4cdb`'s board (which itself embeds `076871a5`'s board) preserved verbatim further down, and the upstream board replaced by a byte-identical `docs/upstream-coordination.md` pointer. `tests/README.md`, `tests/link-check.mjs` and `package.json` auto-resolved to this branch's versions (their sides made no competing change) — no content was lost either way.
> - Verified after both merges on the merged tree: `node tools/restoration-check.mjs` **ALL CHECKS PASSED** · `npm test` **64 passed, 0 failed** · `node tests/run-all.mjs` (syntax, link-check **48 refs**, contract-check **8 bindings**, jsdom render **47/47**) **PASS** · `node tests/props-provenance-test.mjs` **5 passed**.
> - **Live `statsapi.mlb.com` re-verification was not possible from the `9572372b` sandbox** (egress restricted to `github.com`, `codeload.github.com`, `api.github.com`, `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`). `fd8d4cdb`'s spot-checks S1–S4 (2026-11-25) are recorded in [docs/copy-verification.md](docs/copy-verification.md) and cited by this board, not claimed as this session's own checks.
> - **Process notes (honest log):** (1) the first `9572372b` push (`5e89946`) omitted `COORDINATION.md`, which `tools/restoration-check.mjs` and the smoke test require — CI failed on it and passed on the follow-up commit `23bd956`; fixed by adding the file, no other impact. (2) During merge 2, `git pull --rebase` was attempted after merge 1 and incorrectly started replaying `main`'s commits onto this branch; it was **aborted** (`git rebase --abort`) with the branch untouched (`edd5d2d`), then the correct `git push` was run. No history was rewritten and nothing was lost.
> - `fd8d4cdb` recorded its own `git pull --rebase` attempts and branch-pinning deviation in its board below; `076871a5` left its own Pages-deploy verification line as "to be recorded" — flagged here for the owner.
>
> **Merge 3 — `9572372b` merges `origin/main` (PR #6, `2a4d504` — `fd8d4cdb`'s post-merge record) into `arena/9572372b-alert4`**: merged cleanly with the `ort` strategy, zero conflicts, nothing lost. This brought in **`fd8d4cdb`'s Final integration record** (appended verbatim at the end of this file): PR #1 merged 2026-11-25T20:52:16Z as `102f9c4`, Pages `built` for that commit, the post-merge delivery run succeeded byte-for-byte, and the live site was verified (reference feed rows, game view, 2027-04-06 schedule, flagged page §1–15) — plus **COPY-8** (a transient snapshot-count difference on the live feed, re-checked against the official play-by-play, flagged unverified) and **`docs/copy-verification.md` §5**. `flagged.html` §15 gained their COPY-8 row; this branch's §16 is unchanged.

### Copy session — `9572372b` (branch `arena/9572372b-alert4`, PR [#2](https://github.com/kanlerxz87-cyber/Alert4/pull/2))

> ## COPY SESSION (2026-11-25) — repo `kanlerxz87-cyber/Alert4`
>
> **Session ID:** `9572372b` (branch fixed by Arena to `arena/9572372b-alert4`, from `main` @ `a24f7e1`).
> F-001 applies: no `session-<id>/<task>` branches; all work on this branch, integration by PR to `main`.
>
> **Brief:** copy `snapquast73-boop/LIVPBP` (the site at https://snapquast73-boop.github.io/LIVPBP/ — the
> reference "best working site") into this repo so it runs the same for upcoming game days, verify what can be
> verified here, publish to GitHub Pages, and merge to `main`.
>
> **Source of the copy:** `snapquast73-boop/LIVPBP` `main` @ `5c02527d3c7a56ea66c698cfabff80a407b6dfd3`
> (current upstream HEAD at copy time; the tree is what `https://snapquast73-boop.github.io/LIVPBP/` serves).
> Copied with `tar --exclude=.git`; byte-identity vs upstream proven with `diff -r` after the copy — the only
> paths that differ are the deployment-URL/404 adaptations listed below.
>
> ### Task board (`9572372b`)
>
> | Task | Status | Session | File scope | Notes |
> |---|---|---|---|---|
> | COPY-1 Copy upstream tree into this repo | done | `9572372b` | all files copied verbatim | Upstream HEAD `5c02527`; `.git` excluded |
> | COPY-2 Adapt deployment URLs (`package.json`, `tests/jsdom-render-test.mjs`, `tests/props-provenance-test.mjs`, `tests/README.md`, `tests/link-check.mjs` comment) | done | `9572372b` | listed files | Upstream historical URLs in `COORDINATION.md`/`docs/`/`audit/`/`flagged.html` kept verbatim (they are the audit trail) |
> | COPY-3 Fix `404.html` hardcoded Pages base path `/LIVPBP/` → `/Alert4/` | done | `9572372b` | `404.html` | Would otherwise break CSS on 404s at depth |
> | COPY-4 README: copy note + live-demo link → Alert4 Pages URL; `flagged.html` §16 copy-session record | done | `9572372b` | `README.md`, `flagged.html` | Flagged page keeps all upstream items verbatim |
> | COPY-5 Offline verification suite on the copy | done | `9572372b` | no file changes | See verification log below |
> | COPY-6 Enable GitHub Pages (branch `main`, `/`), PR → `main`, merge, confirm Pages build, record here | done (see record below) | `9572372b` | repo settings + `COORDINATION.md` | |
>
> ### Verification log (`9572372b`, 2026-11-25)
>
> What was actually checked in this session, and how. **No value was inferred or filled in anywhere.**
>
> | When | What was checked | Source | Result |
> |---|---|---|---|
> | 2026-11-25 | Copy fidelity: file-by-file `diff -r` of the copy vs upstream `5c02527` (excluding `.git`) | upstream clone | Only the COPY-2/COPY-3/COPY-4 paths differ; everything else byte-identical |
> | 2026-11-25 | `node tools/restoration-check.mjs` (parses every JS, boots `server.mjs`, exercises static + feed-log round-trip, `/.git/HEAD` → 403) | this repo | ALL CHECKS PASSED |
> | 2026-11-25 | `npm test` (`tools/smoke-test.mjs`, 64 checks) | this repo | 64 passed, 0 failed |
> | 2026-11-25 | `node tests/run-all.mjs` (syntax, link-check 41 local refs (pre-merge-2; re-checked as 48 after both merges), contract-check 8 bindings, jsdom render 47/47) | this repo | PASS on all four |
> | 2026-11-25 | `node tests/props-provenance-test.mjs` | this repo | 5 passed |
> | 2026-11-25 | Internal link integrity (`tests/link-check.mjs`, covers every `href`/`src`/CSS `url()`, rejects root-absolute paths) | this repo | 41 refs OK |
> | 2026-11-25 | **Not checked — live MLB StatsAPI.** Egress from this sandbox is restricted to `github.com`, `codeload.github.com`, `api.github.com`, `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`; `statsapi.mlb.com`, `www.mlbstatic.com`, `img.mlbstatic.com` and the GitHub Pages sites are unreachable (`curl` → 000). Field-by-field verification therefore rests on the upstream record — [docs/verification-report.md](docs/verification-report.md) (per-field official links) and [docs/statsapi-field-map.md](docs/statsapi-field-map.md) — whose links are preserved verbatim for manual review. The fixtures re-used by the tests were captured from the official API by the upstream sessions (capture URLs in the fixture headers). | this repo docs | Carried forward — see flagged.html §16 C-4 |
> | 2026-11-25 | Upstream flagged items (F-*, U-*, I-8, L-*, RR-*, D-*, AF-*, R2-*) | flagged.html §§1–14 | Carried verbatim; **none re-verified against the live API in this session**; none resolved |
>
> ### Irregularities found during the copy
>
> 1. `404.html` hardcoded the upstream Pages prefix (`/LIVPBP/`) — fixed to `/Alert4/` (flagged.html §16 **C-1**).
> 2. Deployment URLs pointed at upstream (`package.json` homepage, two test files, `tests/README.md`, one comment) — fixed (flagged.html §16 **C-2**).
> 3. README live-demo link pointed at the upstream site — fixed (flagged.html §16 **C-3**).
> 4. Outbound network blocks any live re-verification of the StatsAPI payloads in this sandbox — flagged, not worked around (flagged.html §16 **C-4**). The site's runtime behaviour (polling statsapi.mlb.com from visitors' browsers) is unaffected; only this session's verification reach was limited.
> 5. Upstream docs still link the upstream repo for historical/audit reasons — intentional, kept unchanged; they are manual-review links, not deployment config.
>
> ### Deployment record (`9572372b`)
>
> PR [#2](https://github.com/kanlerxz87-cyber/Alert4/pull/2) merges this file; the exact merge commit is listed on the PR and in `git log --merges` on `main`. Pages was already enabled for this repo (legacy build, `main` → `/`, `https_enforced: true`, confirmed via `gh api repos/kanlerxz87-cyber/Alert4/pages` on 2026-11-25). The merge republishes the site automatically; the post-merge Pages build status and live verification are recorded in the top merge note and on PR #2.
>
> ---
>

> The upstream coordination board is preserved byte-for-byte at [docs/upstream-coordination.md](docs/upstream-coordination.md) — identical to upstream `COORDINATION.md` @ `5c02527` (SHA-256 `500c094f…`). It is history, not part of the Alert4 board.

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
| C-4 Integration: PR → `main`, merge, confirm Pages build + live pages, record PR/merge result here | done | `arena-fd8d4cdb-alert4` | `COORDINATION.md` | PR [#1](https://github.com/kanlerxz87-cyber/Alert4/pull/1) **MERGED** as [102f9c4](https://github.com/kanlerxz87-cyber/Alert4/commit/102f9c42e5f90a295c7b3d013175588670d263c3); Pages built and live pages verified. Open PRs #2/#4/#5 from other sessions were not merged or discarded — see final record. |

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
| 2026-11-25 | PR #1 site checks | [PR #1](https://github.com/kanlerxz87-cyber/Alert4/pull/1) · [Actions run](https://github.com/kanlerxz87-cyber/Alert4/actions/runs/45697922419) | `dom-smoke` and `test` pass. First `Published Pages delivery` run ([job log](https://github.com/kanlerxz87-cyber/Alert4/actions/runs/45697922416/job/139500101879)) failed on `ENOENT: deployed/index.html` because Pages was still publishing the pre-copy commit `a24f7e1`. Guard added (COPY-6); rerun all three checks passed ([run](https://github.com/kanlerxz87-cyber/Alert4/actions/runs/45698397545)). |
| 2026-11-25 | Parallel session `076871a5` published its own copy to `main` | [PR #3](https://github.com/kanlerxz87-cyber/Alert4/pull/3) · [merge commit f00b6f1](https://github.com/kanlerxz87-cyber/Alert4/commit/f00b6f187e13278f1b8221bd74d6aea489e430de) | Discovered by `git fetch` when PR #1 reported `mergeable: false`. Merged `origin/main` into this branch; resolved 8 files, keeping both sessions' work (see "Integration resolution" below). All suites pass on the union. |

Irregularities recorded for review: `COPY-1` (branch constraint), `COPY-2` (upstream reconstruction),
`COPY-3` (upstream provenance links), `COPY-4` (sandbox live-test limitation), `COPY-5` (no
values changed — confirmed), `COPY-6` (stale-Pages delivery check; guard added), `COPY-7` (parallel duplicate copy, union integrated). All are published with source links in
[`docs/copy-verification.md`](docs/copy-verification.md) and [`flagged.html`](flagged.html) §15.
The upstream board and its 14 sections of flags are preserved unchanged in
[`docs/upstream-coordination.md`](docs/upstream-coordination.md) and `flagged.html` §§1–14.

## Merge / conflict log

Initial copy: none (the branch was clean at `a24f7e1` and no other session had claimed work at
claim time). Later, parallel session `076871a5` published its own copy to `main` (PR #3);
`git merge --no-ff origin/main` into this branch conflicted in 8 files. Every side was kept —
see "Integration resolution" at the end of this board and `flagged.html` COPY-7.

Rebase status: `git fetch origin` initially showed only `main` and this session's branch; remote
`main` was then at `a24f7e1`. `git pull --rebase origin arena/fd8d4cdb-alert4` found no remote
branch at claim time; the claim was pushed with `git push -u`. Subsequent `git pull --rebase
origin arena/fd8d4cdb-alert4` calls before each push were clean. PR #1 became unmergeable when
`main` advanced to PR #3, so `main` was merged into the branch instead of rebased (no force-push).

---

# Preserved board — session `076871a5` (verbatim, merged 2026-11-25)

The following board was published on `main` by PR #3 while this session's copy was in flight. It is reproduced verbatim — nothing from it was discarded. This session (`fd8d4cdb`) took over as final integration and merged both copies.

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

---

## Integration resolution (session `arena-fd8d4cdb-alert4`, 2026-11-25)

`git merge --no-ff origin/main` (merge commit of PR #3) conflicted in eight files because both sessions independently copied the same upstream tree. Resolution kept both sides:

| File(s) | Resolution |
|---|---|
| `404.html`, `package.json`, `tests/jsdom-render-test.mjs`, `tests/props-provenance-test.mjs` | Kept session `076871a5`'s repo-local adaptations (`/Alert4/` base path, homepage and test URLs). |
| `flagged.html` | Kept this session's file, which is the upstream file verbatim plus §15 (COPY-1…COPY-6). Session `076871a5`'s copy of `flagged.html` was SHA-256 identical to upstream, so nothing was lost. |
| `.github/workflows/pages-delivery.yml` | Kept this session's guard for a published revision that predates the site (COPY-6); session `076871a5`'s copy was SHA-256 identical to upstream. |
| `README.md` | Unified copy notes: this session's source/commit/copy-verification note + section link, and session `076871a5`'s local `flagged.html` link, this-copy live demo and upstream reference. |
| `COORDINATION.md` | Kept this session's board (claim done before any file was touched) and appended session `076871a5`'s board verbatim, plus this resolution log. |

No force-push and no discarded work. PR #1 is the integration PR from this branch into `main`; the flagged items do not block it.

---

# Final integration record (session `arena-fd8d4cdb-alert4`, 2026-11-25)

- **PR [#1](https://github.com/kanlerxz87-cyber/Alert4/pull/1) — MERGED** at 2026-11-25T20:52:16Z.
  Merge commit [`102f9c4`](https://github.com/kanlerxz87-cyber/Alert4/commit/102f9c42e5f90a295c7b3d013175588670d263c3).
  All three PR checks were green before merge: `test` (64/64), `dom-smoke` (47/47 jsdom),
  `verify`/`Published Pages delivery` (guard-added version).
- **GitHub Pages:** [builds API](https://api.github.com/repos/kanlerxz87-cyber/Alert4/pages/builds/latest)
  → `status: built`, commit `102f9c42e5f90a295c7b3d013175588670d263c3`, site
  https://kanlerxz87-cyber.github.io/Alert4/. The post-merge
  [delivery run 45699144189](https://github.com/kanlerxz87-cyber/Alert4/actions/runs/45699144189)
  succeeded: the published HTML/assets match the deployed commit byte-for-byte.
- **Live verification after the build:**
  - [Replay feed for the supplied date](https://kanlerxz87-cyber.github.io/Alert4/reviews.html?date=2026-08-26)
    renders the same three reference rows (PHI @ SEA `823096:36:p:MF`, CIN @ SF `823180:57:p:MA`
    and `823180:84:p:NF`) with official MLB API links and “not observed” Before scores. The
    later scan shows more entries than the reference snapshot; that difference is flagged as
    COPY-8, with the extra row re-checked against the official play-by-play.
  - [Game view](https://kanlerxz87-cyber.github.io/Alert4/game.html?gamePk=823096&date=2026-08-26)
    renders linescore and box score with per-row official source links; “–” means absent in
    the official payload.
  - [Upcoming game day 2027-04-06](https://kanlerxz87-cyber.github.io/Alert4/index.html?date=2027-04-06)
    renders all 15 games from the [official schedule](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2027-04-06&fields=dates,games,gamePk,gameDate,status,teams)
    — no hard-coded game data.
  - [Flagged for Review](https://kanlerxz87-cyber.github.io/Alert4/flagged.html) sections 1–15
    are live; the copy-specific items are COPY-1…COPY-8 with source links.
  - The site-check link and contract checks report 44 local references and 8 DOM bindings with
    no broken links after the integration.
- **Other sessions:** PRs [#2](https://github.com/kanlerxz87-cyber/Alert4/pull/2),
  [#4](https://github.com/kanlerxz87-cyber/Alert4/pull/4) and
  [#5](https://github.com/kanlerxz87-cyber/Alert4/pull/5) were opened by other sessions for the
  same copy task after this session had already claimed and pushed it. They were **left open
  and untouched** — nothing from their work was discarded or merged by this session. Their
  owners are asked to rebase onto `main` and avoid overwriting the merged integration; the
  flagged/unverified items do not block anything and are published on the site.
- **Sources used (all first-party/official):** [upstream commit 5c02527](https://github.com/snapquast73-boop/LIVPBP/commit/5c02527d3c7a56ea66c698cfabff80a407b6dfd3)
  and its [Pages build](https://api.github.com/repos/snapquast73-boop/LIVPBP/pages/builds/latest);
  [MLB StatsAPI play-by-play 823096](https://statsapi.mlb.com/api/v1/game/823096/playByPlay?fields=allPlays,about,atBatIndex,inning,halfInning,result,description,awayScore,homeScore,reviewDetails,isOverturned,inProgress,reviewType,challengeTeamId,matchup,batter,fullName,pitcher),
  [823180](https://statsapi.mlb.com/api/v1/game/823180/playByPlay?fields=allPlays,result,description,awayScore,homeScore,about,atBatIndex,inning,halfInning) and
  [823180 linescore](https://statsapi.mlb.com/api/v1/game/823180/linescore),
  [823015](https://statsapi.mlb.com/api/v1/game/823015/playByPlay?fields=allPlays,about,atBatIndex,inning,halfInning,result,description,awayScore,homeScore,reviewDetails,reviewType,challengeTeamId,matchup,batter,fullName,pitcher),
  [2027-04-06 schedule](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2027-04-06&fields=dates,games,gamePk,gameDate,status,teams).
- Full line-by-line record: [`docs/copy-verification.md`](docs/copy-verification.md).
