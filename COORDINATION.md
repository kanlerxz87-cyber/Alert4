# COORDINATION.md — shared task board

Repo: `kanlerxz87-cyber/Alert4` · Site: https://kanlerxz87-cyber.github.io/Alert4/
Reference site copied: https://snapquast73-boop.github.io/LIVPBP/ (repo `snapquast73-boop/LIVPBP`)
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
| A1 Create board + claim scopes | done | `arena-f17e9b8e` | `COORDINATION.md` | Claim commit `9f11906` pushed before work started |
| A2 Copy `snapquast73-boop/LIVPBP` @ `5c02527` into this repo | done | `arena-f17e9b8e` | all site files | Verbatim import commit `ed34b2d`; `diff -r` clean; source board archived to `audit/source-repo-COORDINATION.md` |
| A3 Adapt repo-specific paths/links to Alert4 | done | `arena-f17e9b8e` | `404.html`, `package.json`, `README.md`, `tests/jsdom-render-test.mjs`, `tests/props-provenance-test.mjs`, `tests/link-check.mjs` | `/LIVPBP/` → `/Alert4/`, homepage/demo URLs, README copy note; no behavior changes |
| A4 Line-by-line verification vs official MLB StatsAPI | done | `arena-f17e9b8e` | `docs/verification-report-alert4.md`, `COORDINATION.md` | 18 live re-verification rows + 5 provenance rows, every one linked to the exact official request; see report |
| A5 Run full test suite + link check + local server smoke | done | `arena-f17e9b8e` | (read-only on tests) | restoration-check ALL PASSED · smoke 64/64 · run-all (syntax, 45 refs, 8 bindings, jsdom 47/47) · props-provenance 5/5 · server smoke all 200 |
| A6 Flagged for Review page | done (needs review items published) | `arena-f17e9b8e` | `flagged.html` | Sections 1–14 preserved verbatim; intro copy-note + section 15 added (A4-1…A4-10) |
| A7 Integration: PR → `main`, merge, confirm Pages deploy | in progress | `arena-f17e9b8e` | repo root | PR link + merge result recorded below when complete |

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

## Log

- 2026-11-25 — session `arena-f17e9b8e` created this board and claimed A1–A7 (no other session
  has claimed anything in this repo; board did not exist before). Claim commit pushed immediately.
- 2026-11-25 — source repo state verified: `snapquast73-boop/LIVPBP` HEAD `5c02527` ("Merge pull
  request #33"); live reference page fetched (15 games, 76 tracked entries, 3 reviews /
  2 challenges / 1 umpire review / 27 ABS challenges).
- 2026-11-25 — verbatim import committed (`ed34b2d`), adaptations committed (`6e99faa`),
  full harness green, live re-verification complete, `flagged.html` §15 + verification report
  published. No merge conflicts encountered (single session on this repo so far).
- 2026-11-25 — integration: PR/merge/Pages results appended below.
