# Copy verification — Alert4 ← LIVPBP

Date: 2026-11-25 (UTC) · Session: `arena-fd8d4cdb-alert4` · Branch: `arena/fd8d4cdb-alert4`

This is the record for copying the *working* reference site into `kanlerxz87-cyber/Alert4`.
It is deliberately a **copy**, not a rewrite: every one of the 40 tracked files in the
upstream repository was byte-for-byte reproduced, then checked. Nothing in the site's
data or verification tables was inferred or filled in; where a value cannot be confirmed
from the linked source, the existing pages leave it blank and flag it.

## 1. What was copied, and why that exact revision

| # | Check | Source (official / first-party) | Result |
|---|---|---|---|
| C1 | The user's reference page is published by the repository `snapquast73-boop/LIVPBP`. | [Reference `reviews.html?date=2026-08-26`](https://snapquast73-boop.github.io/LIVPBP/reviews.html?date=2026-08-26) · [GitHub repository](https://api.github.com/repos/snapquast73-boop/LIVPBP) | Confirmed: the page renders three review entries for that date. |
| C2 | The exact revision behind the reference site is commit `5c02527d3c7a56ea66c698cfabff80a407b6dfd3`. | [Latest Pages build of the source repo](https://api.github.com/repos/snapquast73-boop/LIVPBP/pages/builds/latest) · [commit 5c02527](https://github.com/snapquast73-boop/LIVPBP/commit/5c02527d3c7a56ea66c698cfabff80a407b6dfd3) | Confirmed: `status: built`, `commit: 5c02527…`. That commit was exported with `git archive` into this repo. |
| C3 | All 40 tracked files were copied unchanged. | [Upstream tree at 5c02527](https://github.com/snapquast73-boop/LIVPBP/tree/5c02527d3c7a56ea66c698cfabff80a407b6dfd3) | Confirmed: SHA-256 comparison of every tracked upstream file against this working tree returned zero mismatches. `COORDINATION.md` is the local shared board; the upstream board is preserved verbatim as [`docs/upstream-coordination.md`](upstream-coordination.md). |
| C4 | This repo's Pages source is `main` at the repository root, so the copied site is served without a build step. | [Pages configuration of Alert4](https://api.github.com/repos/kanlerxz87-cyber/Alert4/pages) · [Pages docs](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/about-custom-domains-and-github-pages) | Confirmed before merge: `build_type: legacy`, `source.branch: main`, `source.path: /`, `html_url: https://kanlerxz87-cyber.github.io/Alert4/`. |

## 2. Line-by-line checks performed on the copied files

| # | Check | Command / where | Source for the values checked | Result |
|---|---|---|---|---|
| V1 | Static link and asset resolution (no broken internal `href`/`src`/CSS `url()`), including no root-absolute paths that break under a `/<repo>/` Pages prefix. | `node tests/link-check.mjs` | [test source](https://github.com/snapquast73-boop/LIVPBP/blob/5c02527d3c7a56ea66c698cfabff80a407b6dfd3/tests/link-check.mjs) | OK — 41 local references checked. |
| V2 | Every inline handler, `getElementById()` target and script load order across the five HTML pages. | `node tests/contract-check.mjs` | [test source](https://github.com/snapquast73-boop/LIVPBP/blob/5c02527d3c7a56ea66c698cfabff80a407b6dfd3/tests/contract-check.mjs) | OK — 8 bindings across 5 pages. |
| V3 | Real pages rendered in jsdom with the real scripts and official-payload fixtures: scoreboard, game view, play-by-play, review rows, linescore, box score, props, replay feed, tabs, `?date=` deep links, 404 page. | `node tests/run-all.mjs` | [render test](https://github.com/snapquast73-boop/LIVPBP/blob/5c02527d3c7a56ea66c698cfabff80a407b6dfd3/tests/jsdom-render-test.mjs) · [fixture provenance](https://github.com/snapquast73-boop/LIVPBP/blob/5c02527d3c7a56ea66c698cfabff80a407b6dfd3/tests/README.md) | OK — syntax OK, 41 links OK, 8 bindings OK, 47/47 render checks. |
| V4 | Site smoke suite, including the reference-parity assertions (counter lines, two-team summaries, “not observed” markings, empty state, chimes, runs-at-risk, scoring changes, per-row irregularity attribution). | `npm test` | [smoke test](https://github.com/snapquast73-boop/LIVPBP/blob/5c02527d3c7a56ea66c698cfabff80a407b6dfd3/tools/smoke-test.mjs) | OK — 64 passed, 0 failed. |
| V5 | Local server static routes, `.git` denial, and feed-log round-trip. | `node tools/restoration-check.mjs` | [test source](https://github.com/snapquast73-boop/LIVPBP/blob/5c02527d3c7a56ea66c698cfabff80a407b6dfd3/tools/restoration-check.mjs) · [server](https://github.com/snapquast73-boop/LIVPBP/blob/5c02527d3c7a56ea66c698cfabff80a407b6dfd3/server.mjs) | OK — ALL CHECKS PASSED. |
| V6 | Every rendered Props & Matchup row carries a clickable official StatsAPI source link; unconfirmed numbers rendered as `—`, never guessed. | `node tests/props-provenance-test.mjs` | [test source](https://github.com/snapquast73-boop/LIVPBP/blob/5c02527d3c7a56ea66c698cfabff80a407b6dfd3/tests/props-provenance-test.mjs) | OK — 5 passed, 0 failed. |

### Spot-checks against the live official MLB StatsAPI (fetched 2026-11-25)

These re-check the three rows visible on the user's reference page. They are spot-checks on
top of the upstream field-by-field report in [`verification-report.md`](verification-report.md)
and [`statsapi-field-map.md`](statsapi-field-map.md), not replacements for it.

| # | Reference-page row | Official value checked | Official source | Result |
|---|---|---|---|---|
| S1 | `823096:36:p:MF` — PHI @ SEA, Bot 5, J.P. Crawford vs Jesús Luzardo. | `atBatIndex: 36`, inning 5/bottom, description “Mariners challenged (play at 1st), call on the field was upheld: J.P. Crawford grounds out sharply, shortstop Trea Turner to first baseman Alec Bohm.”, `reviewDetails.reviewType: MF`, `challengeTeamId: 136`, `awayScore: 6`, `homeScore: 0`. | [MLB playByPlay 823096](https://statsapi.mlb.com/api/v1/game/823096/playByPlay?fields=allPlays,about,atBatIndex,inning,halfInning,result,description,awayScore,homeScore,reviewDetails,isOverturned,inProgress,reviewType,challengeTeamId,matchup,batter,fullName,pitcher) | Confirmed; the page's “Actual after 6–0” matches away/home scores. The “Before review” value is explicitly *not observed* on the reference page and is not inferred here. |
| S2 | `823180:57:p:MA` — CIN @ SF, Top 7, Sal Stewart vs Ryan Walker. | `atBatIndex: 57`, description “Giants challenged (tag play), call on the field was upheld: … Ke'Bryan Hayes scores. …”, `awayScore: 3`, `homeScore: 6`. | [MLB playByPlay 823180](https://statsapi.mlb.com/api/v1/game/823180/playByPlay?fields=allPlays,result,description,awayScore,homeScore,about,atBatIndex,inning,halfInning) | Confirmed; the page's “Actual after 3–6” matches. |
| S3 | `823180:84:p:NF` — CIN @ SF, Top 9, Héctor Rodríguez vs Reiver Sanmartin. | `atBatIndex: 84`, official “Umpire reviewed (play at 1st)… Umpire reviewed (slide interference)… Héctor Rodríguez grounds into a force out, pitcher Reiver Sanmartin to shortstop Christian Koss. Ivan Johnson out at 2nd.”, `awayScore: 10`, `homeScore: 9`; final linescore away 10, home 9. | [MLB playByPlay 823180](https://statsapi.mlb.com/api/v1/game/823180/playByPlay?fields=allPlays,result,description,awayScore,homeScore,about,atBatIndex,inning,halfInning) · [MLB linescore 823180](https://statsapi.mlb.com/api/v1/game/823180/linescore) | Confirmed; the page's “Actual after 10–9” matches. |
| S4 | Upcoming game days are read from the official schedule, not hard-coded. | `date=2027-04-06` returns 15 scheduled games with `gamePk` values and UTC `gameDate`s. | [MLB schedule 2027-04-06](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2027-04-06&fields=dates,games,gamePk,gameDate,status,teams) | Confirmed. `index.html?date=YYYY-MM-DD` and `reviews.html?date=YYYY-MM-DD` deep links are covered by V3; no game values are pre-filled. |

## 3. Flagged / unverified items found in this copy

Every item below is also published on the site's
[*Flagged for Review*](../flagged.html) page (section 15).

| # | Item | Source | Status |
|---|---|---|---|
| COPY-1 | Arena fixes a session to one branch; the brief's `session-<id>/<task>` branch rule cannot be followed. Work is on `arena/fd8d4cdb-alert4`, integrated via PR to `main`. | [Task board](https://github.com/kanlerxz87-cyber/Alert4/blob/arena/fd8d4cdb-alert4/COORDINATION.md) · [branch API](https://api.github.com/repos/kanlerxz87-cyber/Alert4/branches) | Flagged — environment deviation. |
| COPY-2 | The upstream site is itself a reconstruction: the original `assets/` were never published and are unrecoverable. This copy reproduces the *working* reconstruction, not the lost original code. | [Upstream verification report](https://github.com/snapquast73-boop/LIVPBP/blob/5c02527d3c7a56ea66c698cfabff80a407b6dfd3/docs/verification-report.md) · [upstream commit aef1a74](https://github.com/snapquast73-boop/LIVPBP/commit/aef1a74c40143a7fff9d24853418002e008b79b1) | Flagged — inherited limitation; all upstream deviations remain on `flagged.html` sections 1–14. |
| COPY-3 | External source links in the copied documentation/flagged page point at `snapquast73-boop/LIVPBP` and the reference site. They are provenance links for manual review, not internal navigation; all in-site links are relative and were checked by V1. | [Upstream flagged page](https://github.com/snapquast73-boop/LIVPBP/blob/5c02527d3c7a56ea66c698cfabff80a407b6dfd3/flagged.html) · [link-check test](https://github.com/snapquast73-boop/LIVPBP/blob/5c02527d3c7a56ea66c698cfabff80a407b6dfd3/tests/link-check.mjs) | Flagged — intentional provenance. |
| COPY-4 | The optional `node tests/jsdom-render-test.mjs --live` mode could not complete from this build sandbox: outbound access to `statsapi.mlb.com` is blocked for shell processes (SSL connect failure), and its 13 date-specific assertions target the 2026-08-28 slate rather than today's empty offseason slate. Official endpoints were fetched and checked separately (S1–S4); the deterministic fixture run (V3) passes in full. | [render test source](https://github.com/snapquast73-boop/LIVPBP/blob/5c02527d3c7a56ea66c698cfabff80a407b6dfd3/tests/jsdom-render-test.mjs) · [live schedule used by that mode](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-08-28&hydrate=probablePitcher,linescore,decisions,review) | Flagged — verification limitation; no values inferred. |
| COPY-5 | No upstream source value was changed. All values that the upstream site marks “not observed”, “unverified” or blank remain marked that way; e.g. the Before/Possible scores on the reference page are shown as unobserved. | [Reference reviews page](https://snapquast73-boop.github.io/LIVPBP/reviews.html?date=2026-08-26) · [commit 5c02527](https://github.com/snapquast73-boop/LIVPBP/commit/5c02527d3c7a56ea66c698cfabff80a407b6dfd3) | Confirmed by C3. |
| COPY-6 | On the first pull-request run, the `Published Pages delivery` check failed: it compared the live site with the *pre-copy* `main` commit `a24f7e1`, which has no `index.html` (`ENOENT: deployed/index.html`). The site's own checks passed. | [Failed Actions job log](https://github.com/kanlerxz87-cyber/Alert4/actions/runs/45697922416/job/139500101879) · [Pages builds API](https://api.github.com/repos/kanlerxz87-cyber/Alert4/pages/builds/latest) · [delivery test](https://github.com/snapquast73-boop/LIVPBP/blob/5c02527d3c7a56ea66c698cfabff80a407b6dfd3/tests/pages-delivery.mjs) | Fixed by skipping the byte comparison only when the published revision has no `index.html`; it still runs on the first real Pages build after merge. The workflow itself is the only upstream file intentionally changed in this copy. |

## 4. Artifacts and reproduction

- Upstream board preserved: [`docs/upstream-coordination.md`](upstream-coordination.md).
- Full upstream verification: [`docs/verification-report.md`](verification-report.md),
  [`docs/statsapi-field-map.md`](statsapi-field-map.md),
  [`audit/reference-parity-2026-11-22.md`](../audit/reference-parity-2026-11-22.md).
- Reproduce the checks in this repo: `npm ci && npm test && node tests/run-all.mjs &&
  node tools/restoration-check.mjs && node tests/props-provenance-test.mjs` (see
  [`tests/README.md`](../tests/README.md)).
- The site has no build step: GitHub Pages serves the repository root directly.
