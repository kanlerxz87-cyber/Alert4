# Alert4 copy — verification report (session `arena-f17e9b8e`, 2026-11-25)

This document records the verification performed when copying
[`snapquast73-boop/LIVPBP`](https://github.com/snapquast73-boop/LIVPBP) into
`kanlerxz87-cyber/Alert4`. It complements — does not replace — the source repo's own
line-by-line records, which are preserved verbatim in this copy:

- [`docs/verification-report.md`](verification-report.md) — field-by-field rebuild verification (2026-11-20/22)
- [`docs/statsapi-field-map.md`](statsapi-field-map.md) — every field the client reads, with the official response that proves it
- [`audit/reference-parity-2026-11-22.md`](../audit/reference-parity-2026-11-22.md) — reference-site parity audit
- [`audit/reference-replay-comparison.md`](../audit/reference-replay-comparison.md) — replay-feed comparison
- [`flagged.html`](../flagged.html) — all flagged/unverified items (sections 1–14 inherited; section 15 added by this session)
- [`audit/source-repo-COORDINATION.md`](../audit/source-repo-COORDINATION.md) — the source repo's task board, archived

## 1. Provenance — the copy is byte-identical to the deployed reference

| # | Claim | Evidence | Status |
|---|---|---|---|
| P-1 | Source repo HEAD (`main`) is `5c02527d3c7a56ea66c698cfabff80a407b6dfd3` ("Merge pull request #33") | `git ls-remote https://github.com/snapquast73-boop/LIVPBP.git refs/heads/main` → `5c02527d…` · [repo](https://github.com/snapquast73-boop/LIVPBP) | Verified |
| P-2 | The reference site is built from that exact commit | [Pages API](https://api.github.com/repos/snapquast73-boop/LIVPBP/pages) → `build_type: legacy`, `source: main /`, `status: built`; [builds API](https://api.github.com/repos/snapquast73-boop/LIVPBP/pages/builds) → newest build commit `5c02527d…`, status `built` (2026-11-22T02:47:06Z) | Verified |
| P-3 | Every copied file is byte-identical to the source at that commit | `diff -r --exclude=.git --exclude=COORDINATION.md /tmp/LIVPBP /home/user/Alert4` → no differences (run immediately after import, before adaptations) | Verified |
| P-4 | The only content changes are repo-path adaptations | `404.html` base `/LIVPBP/`→`/Alert4/`; `package.json` homepage; README demo links + copy note; test URLs in `tests/jsdom-render-test.mjs`, `tests/props-provenance-test.mjs`; comment in `tests/link-check.mjs`. See commit "adapt: Alert4 repo paths and links" | Verified |
| P-5 | Reference page reachable and rendering at copy time | [reviews.html?date=2026-08-26](https://snapquast73-boop.github.io/LIVPBP/reviews.html?date=2026-08-26) fetched 2026-11-25: 15 games, 76 tracked entries, tiles 3 Reviews / 2 Challenges / 1 Umpire review / 27 ABS / 0 Boundary / 1 Under review / 0 Runs at risk / 0 Scoring changes | Verified |

## 2. Official-source re-verification (all responses read 2026-11-25 via the page-fetch channel)

`statsapi.mlb.com` is not reachable over a socket from this sandbox (`curl` → status `000`),
exactly as the source repo documented. Every response below was retrieved through the
page-fetch channel and read directly; each row links the exact request.

| # | What was verified | Official source (exact request) | Result |
|---|---|---|---|
| V-1 | Schedule for the reference date | [/api/v1/schedule?sportId=1&date=2026-08-26](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-08-26&fields=dates,date,totalGames,games,gamePk,gameDate,officialDate,status,detailedState,teams,away,home,team,name,score) | 15 games — matches the reference page's "15 game(s) on Wed Aug 26, 2026". PHI@SEA `823096` Final 6–0; CIN@SF `823180` Final 10–9 |
| V-2 | Reference review row 1 (PHI@SEA, Bot 5) | [/api/v1/game/823096/playByPlay](https://statsapi.mlb.com/api/v1/game/823096/playByPlay?fields=allPlays,about,atBatIndex,inning,halfInning,result,description,eventType,reviewDetails,reviewType,isOverturned,inProgress,player,fullName,matchup,batter,pitcher,hasReview) | `atBatIndex 36`, bottom 5th, `hasReview:true`, `reviewDetails{isOverturned:false,inProgress:false,reviewType:"MF"}`, batter J.P. Crawford / pitcher Jesús Luzardo, description "Mariners challenged (play at 1st), call on the field was upheld: J.P. Crawford grounds out sharply, shortstop Trea Turner to first baseman Alec Bohm." — identical to the reference feed row |
| V-3 | Reference review row 2 (CIN@SF, Top 7) | [/api/v1/game/823180/playByPlay](https://statsapi.mlb.com/api/v1/game/823180/playByPlay?fields=allPlays,about,atBatIndex,inning,halfInning,result,description,eventType,reviewDetails,reviewType,isOverturned,inProgress,matchup,batter,pitcher,fullName,hasReview) | `atBatIndex 57`, top 7th, `reviewType:"MA"`, `isOverturned:false`, Sal Stewart vs Ryan Walker, "Giants challenged (tag play), call on the field was upheld: Sal Stewart out on a sacrifice fly to center fielder Jonah Cox. Ke'Bryan Hayes scores. Héctor Rodríguez to 3rd. Elly De La Cruz to 2nd." — identical to the reference feed row |
| V-4 | Reference review row 3 (CIN@SF, Top 9) | same response as V-3 | `atBatIndex 84`, top 9th, `reviewType:"NF"`, `isOverturned:false`, Héctor Rodríguez vs Reiver Sanmartin, "Umpire reviewed (play at 1st), call on the field was upheld: Umpire reviewed (slide interference), call on the field was upheld: …" — identical to the reference feed row |
| V-5 | ABS challenge events carry `reviewDetails` with `reviewType MJ` and challenger | same responses as V-2/V-3 | `823096:51` MJ confirmed (Cal Raleigh, `reviewDetails.player.id 663728`); `823180:58` and `823180:65` MJ overturned — matches the client's ABS extraction (`play.reviewDetails`, `playEvents[i].reviewDetails`) |
| V-6 | Review-type registry codes | [/api/v1/gameStatus](https://statsapi.mlb.com/api/v1/gameStatus) | `MF`="Manager challenge: Close play at 1st", `MA`="Manager challenge: Tag play", `NF`="Umpire review: Close play at 1st", `NH`="Umpire review: Home run", `MJ`="Player challenge: Pitch Result", `NJ`="Umpire Challenge: Pitch Result", `IH`="Instant Replay" (reason "Review") — matches `assets/js/reviews.js` family rules (M\* manager, N\* umpire, MJ/NJ ABS, IH replay) and fallback reasons |
| V-7 | Official-scorer pending-ruling event types | [/api/v1/eventTypes](https://statsapi.mlb.com/api/v1/eventTypes) | `os_ruling_pending_primary` and `os_ruling_pending_prior`, both description "Official Scorer Ruling Pending" — matches `PENDING_RULING_TYPES` in reviews.js; hit types `single/double/triple/home_run` confirmed |
| V-8 | Manager-challenge counters (feed/live) | [/api/v1.1/game/823180/feed/live?fields=gameData,game,pk,status,detailedState,statusCode,review,absChallenges,away,home,used,remaining,usedSuccessful,usedFailed,hasChallenges](https://statsapi.mlb.com/api/v1.1/game/823180/feed/live?fields=gameData,game,pk,status,detailedState,statusCode,review,absChallenges,away,home,used,remaining,usedSuccessful,usedFailed,hasChallenges) | `review{away{used:0,remaining:1},home{used:1,remaining:0}}` → reference row "SF: 0 manager challenges left now (1 used)" ✓ |
| V-9 | ABS counters (feed/live) | same response as V-8 | `absChallenges{away{usedSuccessful:4,usedFailed:0,remaining:2},home{usedSuccessful:2,usedFailed:1,remaining:1}}` → reference summary "Challenges left: CIN 1 MGR · 2 ABS — SF 0 MGR · 1 ABS" ✓ |
| V-10 | Schedule `hydrate=review` counters | [/api/v1/schedule?sportId=1&date=2026-08-26&hydrate=review](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-08-26&hydrate=review&fields=dates,games,gamePk,review,hasChallenges,away,home,used,remaining) | Per-game `review` objects present; `823096` home `{used:1,remaining:0}`, `823180` home `{used:1,remaining:0}` — consistent with V-8 |
| V-11 | Linescore endpoint | [/api/v1/game/823096/linescore](https://statsapi.mlb.com/api/v1/game/823096/linescore?fields=currentInning,currentInningOrdinal,inningState,inningHalf,isTopInning,innings,num,ordinalNum,home,away,runs,hits,errors,balls,strikes,outs,teams) | 9 innings, `teams.away{runs:6,hits:10}`, `teams.home{runs:0,hits:2}` — matches final 6–0 |
| V-12 | Boxscore endpoint | [/api/v1/game/823096/boxscore](https://statsapi.mlb.com/api/v1/game/823096/boxscore?fields=teams,away,home,team,id,name,teamStats,batting,runs,hits,rbi,pitching,inningsPitched,strikeOuts,earnedRunAverage) | `teams.away.team{id:143,name:"Philadelphia Phillies"}`, `teamStats.batting{runs:6,hits:10}`, player blocks `ID…` with `stats`/`seasonStats` — shape matches `assets/js/game.js` box-score renderer |
| V-13 | Season + expected statistics (props drivers) | [/api/v1/people/663728/stats?stats=season,expectedStatistics&group=hitting&season=2026](https://statsapi.mlb.com/api/v1/people/663728/stats?stats=season,expectedStatistics&group=hitting&season=2026&fields=stats,type,displayName,splits,season,stat,avg,obp,slg,ops,atBats,hits,homeRuns,baseOnBalls,strikeOuts,plateAppearances) | `season` split `avg ".182", ops ".664", homeRuns 23 …`; `expectedStatistics` split `avg ".192"` — matches props.js inputs (xBA driver) |
| V-14 | Head-to-head stats | [/api/v1/people/682829/stats?stats=vsPlayer&group=hitting&opposingPlayerId=656849](https://statsapi.mlb.com/api/v1/people/682829/stats?stats=vsPlayer&group=hitting&opposingPlayerId=656849&fields=stats,type,displayName,splits,stat,atBats,hits,avg,ops) | `vsPlayer` splits + `vsPlayerTotal` split `{atBats:15,hits:5,avg:".333"}` — matches `MLB.vsPlayer` and props.js H2H driver |
| V-15 | Team ids/names/abbreviations | [/api/v1/teams?sportId=1](https://statsapi.mlb.com/api/v1/teams?sportId=1&fields=teams,id,name,abbreviation,teamName) | All 30 clubs match `UI.TEAM_ABBR` exactly, incl. `133 ATH`, `145 CWS`, `109 AZ` |
| V-16 | Upcoming game days exist in the official schedule | [/api/v1/schedule?sportId=1&startDate=2027-02-01&endDate=2027-04-15&fields=dates,date,totalGames](https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=2027-02-01&endDate=2027-04-15&fields=dates,date,totalGames) | 757 games; first date 2027-02-19 (17 games, spring training); regular-season opening slate 2027-03-25 (14 games) |
| V-17 | A future slate renders as Preview/Scheduled | [/api/v1/schedule?sportId=1&date=2027-02-19&hydrate=probablePitcher](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2027-02-19&hydrate=probablePitcher&fields=dates,date,totalGames,games,gamePk,gameDate,status,detailedState,abstractGameState,teams,away,home,team,name,probablePitcher,fullName) | 17 games, all `abstractGameState:"Preview"`, `detailedState:"Scheduled"` — the scoreboard/replay feed date navigation will pick these up with no code change |
| V-18 | Today (2026-11-25) is an offseason empty slate | [/api/v1/schedule?sportId=1&date=2026-11-25](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-11-25&fields=dates,date,totalGames) | `totalGames:0, dates:[]` — the site's documented empty-state/offseason-hint path applies (`scoreboard.js` "No games scheduled…", `scheduleRange` hint) |

## 3. Checks run on the copied tree (2026-11-25)

| Check | Result |
|---|---|
| `node tools/restoration-check.mjs` | ALL CHECKS PASSED (local refs, JS syntax, server contract round-trip incl. `atBatIndex 0` vs empty) |
| `node tools/smoke-test.mjs` (`npm test`) | 64 passed, 0 failed |
| `node tests/run-all.mjs` | syntax OK · link-check 41 local refs OK · contract-check 8 bindings OK · jsdom-render-test 47/47 (fixtures captured verbatim from official StatsAPI responses) |
| `node tests/props-provenance-test.mjs` | 5 passed, 0 failed (every driver row carries an official statsapi.mlb.com source link) |
| `node server.mjs` + curl | `/`, `/index.html`, `/reviews.html`, `/reviews.html?date=2026-08-26`, `/game.html`, `/flagged.html`, `/404.html`, CSS/JS assets → 200; `/api/health` → 200; `/api/feed-log?date=…` round-trip OK |
| `node tests/pages-delivery.mjs` | run after the Pages deploy (see COORDINATION.md integration log) |

## 4. Observations and carried-forward flags (non-blocking)

1. **CDN images (carried U-8 / T-9).** `www.mlbstatic.com` / `img.mlbstatic.com` return HTTP 500
   to the page-fetch channel (binary/SVG assets), so the logo/headshot URLs could not be
   re-verified from this environment — same limitation the source repo flagged. The URLs are
   unchanged from the working reference site, the pattern is documented by the MLB-StatsAPI
   community ([r/mlbdata](https://www.reddit.com/r/mlbdata/comments/1b1eit0/team_logos/)), and
   the UI degrades to an initials badge on image failure. Flagged, not corrected.
2. **`review.home{used:1,remaining:1}` on two games** (`824555` TEX@CWS, `824963` MIN@ATH in
   V-10). This is the official payload read as-is (a successful challenge is retained under
   MLB replay rules); the client never derives or "corrects" counters. Recorded as an
   observation, not a site defect.
3. **Browser-local feed history.** The reference page's "76 tracked entries · local log only"
   includes entries observed live in that browser's localStorage (scoring changes, pending
   rulings, before-review scores). A fresh browser on the copy rebuilds from the official API
   for the date (reviews/ABS are re-detected from `playByPlay`; before-review scores show
   "not observed" exactly as the reference does for post-resolution visits). This is the
   documented design, not data loss.
4. **All inherited flags stay published.** Items U-1…U-11, I-8, F-001…F-009, L-1…L-4,
   RR-01…RR-06, D-1…D-4, AF-1…AF-7, R2-1…R2-11 in `flagged.html` sections 1–14 are preserved
   verbatim with their original source links (they point at the source repo, which remains
   online). Section 15 adds this session's record.
