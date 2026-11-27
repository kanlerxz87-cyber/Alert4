# ⚾ Alert4 — MLB Live PBP (Live Scoreboard & Play-by-Play)

> **Alert4 copy (2026-11-25).** This repository is a working copy of
> [`snapquast73-boop/LIVPBP`](https://github.com/snapquast73-boop/LIVPBP)
> (live reference: https://snapquast73-boop.github.io/LIVPBP/reviews.html?date=2026-08-26),
> set up to run as the Alert4 GitHub Pages site for upcoming game days. The
> application code, verification notes, and flagged-review items below are carried
> over from the source and re-verified in this repo where noted.


> ### 📋 **COPY NOTE (2026-11-25)** 📋
> This repository is a copy of the working reference site
> [`snapquast73-boop/LIVPBP` @ `5c02527`](https://github.com/snapquast73-boop/LIVPBP/commit/5c02527d3c7a56ea66c698cfabff80a407b6dfd3),
> the revision published on [GitHub Pages](https://snapquast73-boop.github.io/LIVPBP/reviews.html?date=2026-08-26)
> at the time of the copy. This deployment is <https://kanlerxz87-cyber.github.io/Alert4/>.
> All 40 tracked upstream files were verified byte-for-byte (SHA-256, zero mismatches) by session
> `fd8d4cdb`; session `9572372b` independently confirmed byte-identity with `diff -r` apart from the
> listed adaptations. Five parallel copies of the same commit landed in this repository on
> 2026-11-25 and their work was merged without discarding any of it (see
> [`COORDINATION.md`](COORDINATION.md)): session `076871a5` retargeted `404.html`'s base path,
> `package.json`'s homepage and the two test-harness URLs to `/Alert4/`; session `fd8d4cdb` added a
> Pages-delivery CI guard and the copy verification report; session `arena-f17e9b8e` re-verified
> every API contract against the official MLB StatsAPI (A4-1…A4-10) and archived the upstream board
> at [`audit/source-repo-COORDINATION.md`](audit/source-repo-COORDINATION.md) (same content as
> [`docs/upstream-coordination.md`](docs/upstream-coordination.md)); session `arena/d8da4b48`
> added an Alert4 identity header, renamed `package.json` to `alert4-mlb-live-pbp`, and re-pointed
> deployed-site links in the audit/docs files at the Alert4 Pages URL; session `9572372b` unioned
> the copies and added the deployment-URL records, documentation union and link fixes described in
> `COORDINATION.md`.
> Copy checks, the official MLB StatsAPI spot-checks and every source link are in
> [`docs/copy-verification.md`](docs/copy-verification.md) and
> [`docs/verification-report-alert4.md`](docs/verification-report-alert4.md).
> Copy-specific deviations are published on the
> [**⚑ Flagged for Review**](flagged.html)
> page (sections 15–17); the upstream site's own flags remain in sections 1–14. External links to
> the upstream repository are provenance links for manual review, not internal navigation. The
> upstream coordination board is preserved verbatim at
> [`docs/upstream-coordination.md`](docs/upstream-coordination.md); what the copy sessions checked
> and could not verify live is in [`COORDINATION.md`](COORDINATION.md).
>
> ### ♻️ **RESTORATION NOTE (2026-11-20)** ♻️
> This repository was uploaded incomplete: the three HTML pages referenced a stylesheet and nine
> scripts under `assets/` that were **not** part of the upload, so GitHub Pages served an unstyled,
> inert page. The original author's repository (the previous "Live demo" link) no longer exists on
> GitHub (`404`), so the client could not be copied back.
>
> What was done here: every missing asset was re-implemented against the pages' own DOM contract and
> the **official MLB StatsAPI**, then verified — field by field, with the official response linked for
> each one — in [`docs/verification-report.md`](docs/verification-report.md), and end-to-end with
> `node tests/jsdom-render-test.mjs` (field map: `docs/statsapi-field-map.md`). Known deviations from this README's description of the
> original (refresh cadence, the reduced hit-forecast drivers, the simplified review score tracker,
> and every unverified item) are published on the
> **[⚑ Flagged for Review](flagged.html)** page, with source
> links. The text below is the original project documentation, unchanged apart from this note, the
> demo link, the file-tree entries that now exist, and the test commands in "Run it locally".

> ### 🛑 **CHECKPOINT NOTICE: `v1.0.0-stable-checkpoint`** 🛑
> **This tag marks a safe, working baseline of the code. If any experimental changes break the app, you can instantly revert back to this stable state by running:**
> ```bash
> git reset --hard v1.0.0-stable-checkpoint
> ```

A zero-dependency, static web app that pulls **live MLB game data** straight from the
public MLB StatsAPI and renders it in a **Gameday-style scoreboard** — exactly the data
mlb.com uses, re-implemented from scratch in vanilla HTML/CSS/JS.

- **Scoreboard** (like [MLB.com](https://www.mlb.com/scoreboard)) — every game for any
  date, with live scores, inning, count, probable pitchers, and W/L/S decisions.
  Deep links: `index.html?date=YYYY-MM-DD` opens a specific day (same for
  `reviews.html?date=YYYY-MM-DD`), and the address bar follows the selected date;
  the date-picker and day-nav buttons stay the in-page controls.
- **Game view** (like [MLB.com Gameday](https://www.mlb.com/gameday)) — **who's at bat,
  who's pitching, the count, outs, runners on base**, on-deck / in-the-hole hitters,
  pitch counts, last play, inning-by-inning linescore, full box score, and the complete
  play-by-play timeline with pitch-by-pitch details.
- **Instant Replay Reviews & Challenge Alerts** — real-time alerts and dedicated tracking
  for **Manager Challenges**, **Crew Chief Reviews**, **Umpire Reviews**, and **ABS**
  (Automated Ball-Strike system) pitch challenges across both the Scoreboard and Game views:
  - **All-Games "Replay Feed" page** (`reviews.html`) — a live, chat-style feed that pulls
    review events from **every game on the schedule** (not just one game): new manager
    challenges, crew chief reviews, umpire reviews, ABS pitch challenges and
    boundary-call reviews (potential home runs / fair-foul at the wall) appear at the
    top of the feed as they happen, with game link, inning, challenging team, reason,
    outcome, batter/pitcher context, and a three-row **review score tracker**:
    **Before review** (the call-on-field score when the active review is first
    observed), **Possible after** (call stands plus any conditional run-removal
    scenario supported by the reviewed scoring movements), and **Actual after**
    (the official score after the resolved reviewed play/action, when exposed).
    For example: `NYY 6 – BOS 5`, possible
    `NYY 5 – BOS 5` if the reviewed safe-at-home run is removed, then the actual
    official score after the ruling. The possible score is **not a prediction**:
    on a home-run/boundary review MLB may instead place runners. A boundary review
    with no currently credited run says “score impact pending” and does not invent
    an alternate score. If the page opens only after resolution, it shows an
    attributable official Actual-after score when available and honestly marks
    Before/Possible as not observed. A later end-of-plate-appearance score is not
    assigned to an earlier pitch review. For ABS,
    the feed also shows the pitch count before the challenge, who challenged (batter /
    catcher / pitcher, from official play text or the challenging team's batting/
    fielding side), and the count after the call is overturned or stands.
    Every ABS-challenge and manager-challenge row also carries a
    **challenges-remaining tracker**: the challenging team's current official
    counter (e.g. `CIN: 2 ABS challenges left now (2 successful · 0 failed)` or
    `PIT: 1 manager challenge left now (0 used)`), with the both-teams summary
    (`Challenges left: CIN 1 MGR · 2 ABS — CHC 1 MGR · 2 ABS`) on hover and on
    the Under-Review live strip. The numbers are the **official StatsAPI
    counters read as-is** — `review.away/home.used/remaining` (manager
    challenges, from the schedule's `hydrate=review` and feed/live
    `gameData.review`) and `gameData.absChallenges.away/home.usedSuccessful/
    usedFailed/remaining` (ABS, feed/live only; verified live 2026-08-28) —
    never counts derived from feed events, never zero-filled when absent
    (pre-ABS seasons have no `absChallenges` object at all), and a used-counter
    that moves backwards between polls is flagged on the row as an
    irregularity instead of being silently corrected. Crew-chief, umpire and
    boundary reviews are not charged to a team's counter, so those rows show
    no counter line by design. Includes
    an "Under Review" live strip, per-type
    filters — **All** (every category except ABS pitch challenges:
    challenges, reviews, boundary calls, under review, runs at risk),
    **ABS** (ABS challenges stay fully tracked here, in the **ABS
    Challenges** stat, and in the challenges-remaining counters),
    **Challenges**, **Reviews**, **Boundary Calls**, **Under Review**,
    **⚠️ Runs at Risk** —,
    summary stats for the whole day, and an optional **sound alert** — a gentle
    ~3 second rain shower (a soft filtered-noise patter under hand-placed pentatonic
    "raindrops" with a warm feedback delay and a low G4 close, ~2.9s end to end)
    that lands whenever **any** alert in the feed lands: challenges, umpire/crew-chief
    and boundary reviews, ABS pitch challenges, scoring changes, pending-ruling
    appearances, and the run-at-risk case below — it is literally the same audio
    graph and the same 3s cooldown every time. It is off by default, remembers your
    choice per browser, and the 🔊 toggle in the header turns it on/off at will.
  - **⚠️ Runs at Risk — "could this review take a run OFF the board?"** The feed
    tracks, per review, whether the call on the field credited runs to the very
    event now under review, so an overturn could remove them from the score. When
    it can, you get, immediately: the **same ~3-second rain** used for any
    new alert (one alert sound for the whole page — it is literally the same
    audio graph, and shares its 3s cooldown), an
    optional **desktop notification**, a persistent **red banner** at the top of
    the page listing every affected game with the call-stands score and — only
    when the payload actually supports it — the score if the runs come off,
    a **⚠️ N RUN(S) AT RISK** badge and glow on the feed row,
    a **Runs at Risk** stat, and a dedicated filter tab. It fires once per review
    (not once per poll), clears the moment the review resolves, and applies to
    every review type — manager challenge, crew chief/umpire review, boundary call,
    "under review", and ABS — because it is decided by the *data*, not the type: a
    run counts only when the official payload has a `runners[]` record with
    `details.isScoringEvent:true` whose `details.playIndex` matches the reviewed
    event. A score change elsewhere in the plate appearance (a steal of home, a
    wild pitch) never counts, and the ruling itself is **never predicted**.
    Note that browsers block audio until you have interacted with the page, so a
    run-at-risk chime on the very first page load may be silent until you click
    something; the desktop notification is not affected.
  - **Scoreboard Live Ticker & Alert Badges** — surfaces any game currently in review or challenge,
    with a link straight to the all-games Replay Feed.
  - **Live Game Review Alert Banner** — eye-catching alert at the top of the game and live module when a call is under review.
  - **Dedicated "Challenges & Reviews" Tab** — full breakdown of every review event with summary stats (overturn rate, breakdown by challenge type and team), call reasons, and outcomes (Overturned, Stands, Confirmed).
  - **Play-by-Play Chips** — highlighted review outcome chips directly on affected plays.
  - All review parsing is validated against the real StatsAPI shapes (`reviewDetails`
    with codes `MJ` = ABS pitch challenge, `MA`/`MF` = manager challenges, and
    `NH` = boundary-call review, plus
    `feed.gameData.review` / `feed.gameData.absChallenges` challenge counters) — see
    `docs/verification-report.md` and `tools/smoke-test.mjs` (review-parser checks) plus
    `tests/jsdom-render-test.mjs` (end-to-end render). The original `tools/review-test.mjs`
    was not part of the upload — see `flagged.html` F-003.
- **Two-sided hit forecast** — a transparent per-plate-appearance hit probability that
  compounds the batter's and pitcher's season rates (log5), real platoon splits,
  recent form, head-to-head history, same-game familiarity, and the live count into a
  single number with a matchup tier (Elite → Pitcher's edge) and per-driver point
  adjustments. It appears in the live at-bat card, the Props & Matchup tab, and
  completed PBP rows.
- **Δ-feed fast path:** for every *live* game the Replay Feed tracks the official
  **diff feed** — MLB's own `timestamps` + `diffPatch` (RFC 6902) endpoints applied
  in memory to the cached `feed/live` document — instead of re-downloading the feed
  each poll. A quiet live game costs one small `timestamps` call (~a few KB) every
  **750ms**; a revision moves a small JSON patch. After 3 consecutive patch
  failures the fast path silently re-syncs once and then returns to the standard
  `fields`-projected play-by-play poll, so a misbehaving endpoint can never wedge
  the page. The delta path is verified against a real captured `diffPatch`
  response in `tests/live-diff-test.mjs`. On a live game page the full feed lands
  every **500ms**, while a dedicated status watcher catches a brand-new
  challenge/review the instant MLB flips the official game status — and paints the
  review banner from the lean probe (~3 KB) while the 1–2MB full feed is still
  downloading (and while a review is in flight the page probes the lean
  play-by-play endpoint every **250ms**, pulling the full feed only when the
  review state flips). The Replay Feed re-checks the whole slate's official status
  every **500ms**; a game that flips into a review *during* a scan is fetched out
  of band instead of waiting for that scan to finish. The scoreboard keeps its
  500ms hydrated-schedule poll and adds the same rapid status sweep for the review
  ticker. The undocumented Gameday websocket is deliberately not used — see
  `docs/latency-and-tos.md`. When the persistence server is running, a **live push**
  (server-sent events) delivers every tracked entry recorded by another tab or
  browser as soon as it is written — the Replay Feed is the only writer of that
  log, and its write is coalesced at ≤1/s — while the periodic pull stays as the
  fallback (and for static hosting). Post-Final scorer rulings are re-scanned every **1s** for the
  first two minutes, then 2.5s to five minutes, then 15s inside a bounded
  30-minute grace. Works on desktop and mobile.
- **"Under review" is detected from the official game status, not from play
  text.** All three surfaces run a dedicated **125ms review-status watcher**
  (`GET /api/v1/schedule` with a `fields` projection and no hydrations — the
  whole slate's `gamePk` + `status` in ~2.4 KB, ~1/8th the size of the schedule
  the rest of the page uses); the Replay Feed and the scoreboard use it for
  the whole slate, and the game page sweeps a ~150-byte per-game status
  projection on the same cadence. MLB flips `status.statusCode` the instant a
  review is **called**, while the play description is written when it
  **resolves** — so this cuts the worst-case wait from ~3s (the schedule cache)
  to ~125ms plus one round trip, and it surfaces the official review reason
  ("Tag play", "Home run", "Pitch Result", …) before any play text exists.
  Detection reads the API's own status registry (`GET /api/v1/gameStatus`:
  `M*` manager challenge, `N*` umpire review, `IH` instant replay, `MJ`/`NJ`
  ABS pitch challenge) instead of matching the words "challenge"/"review" —
  which silently missed crew-chief reviews, whose official `detailedState` is
  **"Instant Replay"**. See `docs/verification-report.md` §16.
- No build step, no frameworks, no API keys — it runs on **GitHub Pages** (or any static
  host, or even `file://`).

> **Live demo (this copy):** [kanlerxz87-cyber.github.io/Alert4](https://kanlerxz87-cyber.github.io/Alert4/)  
> **Upstream reference:** [snapquast73-boop.github.io/LIVPBP](https://snapquast73-boop.github.io/LIVPBP/)
> (Restored 2026-11-20: the original author's repo linked here previously is
> no longer on GitHub — see `flagged.html` items F-002/F-008 and
> `COORDINATION.md` for the restoration log and flagged irregularities.)

---

## How it works — reverse-engineering MLB.com Gameday

MLB.com's Gameday is a JavaScript app. It reads JSON from a public, undocumented API at
**`https://statsapi.mlb.com/api/v1/`** (plus `v1.1` for live game feeds) and pulls
images (logos, headshots) from **`mlbstatic.com`**. No login, no API key, and the API
sends CORS headers, so any static page can call it directly from the browser.

This project does the same thing with its own front end. The API calls we make:

| What we need | Endpoint | Official source |
| --- | --- | --- |
| Games for a date (scoreboard cards, probables, live count) | `GET /api/v1/schedule?sportId=1&date=YYYY-MM-DD&hydrate=probablePitcher,linescore,decisions,review` | [schedule (2026-10-28)](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-10-28&hydrate=probablePitcher,linescore,decisions,review) |
| **Review status for the whole slate** (Replay Feed's 500ms sweep) | `GET /api/v1/schedule?sportId=1&date=YYYY-MM-DD&fields=dates,games,gamePk,season,status,abstractGameState,codedGameState,detailedState,statusCode,reason,startTimeTBD,abstractGameCode` | [slate status projection](https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-10-28&fields=dates,games,gamePk,season,status,abstractGameState,codedGameState,detailedState,statusCode,reason,startTimeTBD,abstractGameCode) |
| **Δ-feed heartbeat per live game** (Replay Feed fast path; ~a few KB) | `GET /api/v1.1/game/{gamePk}/feed/live/timestamps` — MLB's own revision timecodes | [timestamps (v1.1)](https://statsapi.mlb.com/api/v1.1/game/824638/feed/live/timestamps) |
| **Δ-feed delta** (only when `timestamps` shows a revision) | `GET /api/v1.1/game/{gamePk}/feed/live/diffPatch?startTimecode=…&endTimecode=…` — RFC 6902 patches applied in memory | [diffPatch (v1.1)](https://statsapi.mlb.com/api/v1.1/game/824638/feed/live/diffPatch?startTimecode=20260828_203856&endTimecode=20260828_203907) |
| **Review status for one game** (game page's 250ms status watcher, ~150 B) | `GET /api/v1.1/game/{gamePk}/feed/live?fields=gameData,status,abstractGameState,codedGameState,detailedState,statusCode,reason,startTimeTBD,abstractGameCode` | [game status projection](https://statsapi.mlb.com/api/v1.1/game/849799/feed/live?fields=gameData,status,abstractGameState,codedGameState,detailedState,statusCode,reason,startTimeTBD,abstractGameCode) |
| Official game-status registry (source of every review `statusCode` + `reason`) | `GET /api/v1/gameStatus` | [gameStatus registry](https://statsapi.mlb.com/api/v1/gameStatus) |
| Full game state — play-by-play, current at-bat, linescore, box score, decisions, rosters | `GET /api/v1.1/game/{gamePk}/feed/live` | [feed/live v1.1](https://statsapi.mlb.com/api/v1.1/game/849799/feed/live) |
| Fallback feed (older games) | `GET /api/v1/game/{gamePk}/feed/live` | [feed/live v1](https://statsapi.mlb.com/api/v1/game/744932/feed/live) |
| Fallback bundle (if the feed 404s) | `GET /api/v1/game/{gamePk}/playByPlay` + `/boxscore` + `/linescore` | [playByPlay](https://statsapi.mlb.com/api/v1/game/849799/playByPlay) · [boxscore](https://statsapi.mlb.com/api/v1/game/849799/boxscore) · [linescore](https://statsapi.mlb.com/api/v1/game/849799/linescore) |
| Play-by-play + official MGR/ABS challenge counters (all-games Replay Feed scans per game) | `GET /api/v1/game/{gamePk}/playByPlay` + leaf-projected `GET /api/v1.1/game/{gamePk}/feed/live?fields=gameData,review,absChallenges,…` | [playByPlay](https://statsapi.mlb.com/api/v1/game/824638/playByPlay) · [absChallenges](https://statsapi.mlb.com/api/v1.1/game/824638/feed/live?fields=gameData,review,absChallenges,hasChallenges,away,home,used,remaining,usedSuccessful,usedFailed) |
| Team logos | `https://www.mlbstatic.com/team-logos/team-cap-on-dark/{teamId}.svg` | [team logo 119](https://www.mlbstatic.com/team-logos/team-cap-on-dark/119.svg) |
| Player headshots | `https://img.mlbstatic.com/mlb-photos/image/upload/.../v1/people/{playerId}/headshot/67/current` | [headshot 660271](https://img.mlbstatic.com/mlb-photos/image/upload/v1/people/660271/headshot/67/current) |
| Batter / pitcher season inputs for the forecast | `GET /api/v1/people/{playerId}/stats?stats=expectedStatistics,season,statSplits,gameLog&group=hitting&sitCodes=vl,vr&season=YYYY` (same CSV for `group=pitching`). **Note:** the `statcast` stat is rejected with HTTP 400 for `group=hitting` on the live API (verified 2026-08-19), so it is deliberately not requested — xBA comes from `expectedStatistics`. | [people/660271/stats](https://statsapi.mlb.com/api/v1/people/660271/stats?stats=expectedStatistics,season,statSplits,gameLog&group=hitting&sitCodes=vl,vr&season=2026) |
| Career head-to-head for the live forecast | `GET /api/v1/people/{batterId}/stats?stats=vsPlayer&group=hitting&opposingPlayerId={pitcherId}` | [vsPlayer H2H](https://statsapi.mlb.com/api/v1/people/694192/stats?stats=vsPlayer&group=hitting&opposingPlayerId=656876) |

The live feed is the heart of it — one response contains everything Gameday shows:

```
liveData.plays.allPlays[]      → every at-bat: result, description, count, outs,
                                 batter/pitcher matchup, runner movement, pitch events
liveData.plays.currentPlay     → the at-bat happening RIGHT NOW (batter, pitcher, count)
liveData.linescore             → inning state, inning-by-inning runs/hits/errors
liveData.boxscore              → per-player batting & pitching lines, batting order
liveData.decisions             → winning/losing/saving pitcher
gameData.players / teams       → names, positions, records, venue, weather, status
```

The app polls `feed/live` every 500ms while a game is in progress (every 250ms
while a review is in flight, via a lean play-by-play probe that fetches the
full feed only when the review state flips) and only rebuilds the DOM when the
baseball state changes
(count, pitch event, score, inning, play, or review outcome). The heavy box-score
table is lazy-rendered only when its tab is open. Preview and final games use
slower cadences, and polling pauses automatically while the tab is hidden.

## Two-sided hit forecast

The hit percentage is a **transparent, per-plate-appearance estimate** — not an MLB
projection or a betting line. It is built to *discriminate*: great spots and terrible
spots land far apart instead of clustering around the league average. Two numbers are
shown, and they intentionally live in different bands:

- **Per-PA headline ("Hit this PA")** — the chance the batter gets a hit in *this*
  plate appearance. For **real MLB matchups this typically reads 22–30%** (league hit
  rates cluster around `.245`, and real batters/pitchers do too); the model's full
  clamp band is 13–62% per-PA (10–78% with live count), reached only by stacked
  synthetic edges like an overmatched call-up vs an ace (~13%) or an elite hitter on
  a hitter's count vs a weak arm (~50%). A single-PA hit rate can't honestly reach
  80%: even a perfect .400 hitter vs a .150-allowed pitcher resolves to ~55% before
  clamps. (The original `tools/model-calibration-report.mjs` archetype grid was not part of
  the upload — see `flagged.html` F-003/U-2; the shipped model constants are documented in
  `assets/js/props.js`.)
- **"≥1 hit in next N PAs" projection** — the *wide* number, and where the promised
  16–95% spread actually lives. It is `1 − (1 − per-PA)^remaining PAs`, so during a
  live game it naturally reads **50–95%** (the broadcast-style graphic number most
  fans expect). It is shown on the live at-bat card and in the Props & Matchup tab;
  on a **Final game there are no PAs left, so it reads "—"/0%** and the per-PA rate is
  the relevant number. Both are per-batter and per-pitcher.

The model:

1. **Season level (both sides):** the batter's xBA/AVG hit-production signal and the
   pitcher's xBA-allowed/opponent-AVG signal are each regressed toward a `.245` league
   baseline (light regression so a full-season signal can move the forecast by
   ~10-14 points), then compounded in log-odds space — a generalized **log5** (Bill
   James's odds-ratio method), so extreme signals push the estimate toward the
   extremes rather than canceling toward the mean. Total evidence is capped at
   ±1.9 logits from the league prior.
2. **Platoon splits:** each player's real `vs LHP` / `vs RHP` (pitchers: `vs LHB` /
   `vs RHB`) split enters as a shrunken *differential* against their own season rate.
   Without split data, a small flat handedness adjustment is used instead.
3. **Recent form:** the player's game-log window (last ~8 games, strictly before the
   modeled game's date, so a forecast never leaks the game's own result) nudges the
   estimate with a meaningful weight (capped so a single hot/cold week cannot dominate
   the season signal).
4. **Head-to-head:** the career batter/pitcher line is a bounded but real nudge
   (~up to 5.5 pts of weighted signal).
5. **Same-game familiarity:** each repeat plate appearance against the same pitcher
   adds a small times-through-the-order bump (~+0.75 pts/pass, capped at the third look).
6. **Live count:** mid-at-bat, the fresh-count estimate is multiplied in odds space by
   an empirically anchored count factor (3-1 » 0-0 » 0-2); walks are *not* hits, so
   3-ball factors deliberately exclude the walk's value. (The original
   `tools/count-model-derivation.mjs` derivation was not part of the upload — see
   `flagged.html` F-003/U-2; the shipped count factors are documented in `assets/js/props.js`.)

The headline number is the **hit probability for this plate appearance**; the chance
of at least one more hit across the remaining expected plate appearances is shown as a
secondary projection. A **matchup tier** (Elite matchup / Favorable / Neutral / Tough /
Pitcher's edge) and per-driver **adjustment chips** (season, platoon, form, history,
familiarity, count — in percentage points) make every forecast explainable.

If one player has no usable season data, the forecast remains available but labels the
fallback (for example, “Batter input; pitcher baseline fallback”). If neither side has
data, it shows the league baseline instead of pretending the estimate is personalized.
The same cached model powers the live at-bat card, Props & Matchup tab, and PBP chips;
for archived games the request is scoped to the feed's game season.

## Project structure

```
.
├── index.html                 # Scoreboard page (all games for a date; ?date=YYYY-MM-DD)
├── game.html                  # Game page (?gamePk=<id>)
├── reviews.html               # All-games Replay Feed (?date=YYYY-MM-DD; live review feed)
├── 404.html
├── flagged.html               # ⚑ Flagged for Review — irregularities + official source links
├── assets/
│   ├── css/style.css          # Dark Gameday-style theme (responsive)
│   └── js/
│       ├── api.js             # MLB StatsAPI client (fetch, retry, fallbacks, formatters)
│       ├── ui.js              # Shared UI: team logos, colors, count dots, runners diamond
│       ├── reviews.js         # Challenge & replay review parser (Manager, Crew Chief, ABS)
│       ├── reviews-feed.js    # All-games Replay Feed logic (diff helpers + page)
│       ├── scoreboard.js      # Scoreboard page logic
│       ├── feed-log.js        # Per-date alert log: localStorage + optional server.mjs sync/SSE
│       ├── persistent-log.js  # Shared persistence contract for the two extra logs
│       ├── scoring-log.js     # Official Scoring Monitor log (separate namespace + /api/scoring-log)
│       ├── scoring-monitor.js # Official Scoring Monitor writer (pending → resolved, reclassifications)
│       ├── state-log.js       # Game State timeline log (separate namespace + /api/state-log)
│       ├── state-tracker.js   # Live official-state capture for every game (preview → final)
│       ├── json-patch.js      # Minimal RFC 6902 (add/remove/replace/copy/move) engine
│       ├── live-diff.js       # Δ-feed tracker: timestamps + diffPatch over the cached feed
│       ├── scoring-page.js    # Official Scoring Monitor page logic (?date=, tabs, export)
│       ├── props.js           # Two-sided hit model, stat cache, Props & Matchup tab
│       └── game.js            # Game page logic (live "at bat" module, linescore, box, PBP)
├── scoring.html               # 📝 Official Scoring Monitor — pending rulings & reclassifications
├── server.mjs                 # Optional zero-dependency persistence server (static + 3 logs)
├── tests/                     # Zero-network checks: link check, jsdom render, live-diff, scoring-monitor
├── docs/latency-and-tos.md    # Request-rate budget, delta-feed design, terms-of-service bounds
├── docs/verification-report.md# Field-by-field verification with official source links
└── COORDINATION.md            # Multi-session task board, claims, merge + deployment record
```

## Run it locally

Run the built-in persistence server (recommended — persists scoring changes and reviews to disk across browsers):

```bash
# Node built-in server (multi-browser persistent logging backend)
node server.mjs

# or any static file server
python3 -m http.server 8000
# or
npx serve .
```

Then open <http://localhost:8000>. You can also open `index.html` directly in a browser
(`file://` works — the app uses plain scripts, no modules).

To run the checks that ship with this repository (no network needed):

```bash
node tests/link-check.mjs                # every local href/src/url() in the site resolves
node tests/jsdom-render-test.mjs         # end-to-end render of the real pages (needs jsdom)
npm install --no-save jsdom              # ...one-time dev dependency for the test above only
node tests/jsdom-render-test.mjs --live  # same test, answering the pages from the live StatsAPI
node tests/live-diff-test.mjs            # RFC 6902 engine vs a captured official diffPatch response
node tests/scoring-monitor-test.mjs      # scoring + state capture end to end (stubbed storage)
node tests/run-all.mjs                   # the whole suite (syntax, links, contracts, renders)
node server.mjs                          # optional persistence backend for the logs
```

The original repository also listed 15 `tools/*.mjs` scripts and `docs/*` notes; those files were
never uploaded and are not reproducible, so they are not claimed here — see
[`flagged.html`](flagged.html) F-003.

Everything tracked is persistent across the website, in three deliberately
**separate** stores (an alert-log failure can never corrupt or evict a scoring
record, and vice versa):

| Store | Keys / files | Cap | Kept |
|---|---|---|---|
| Alert log (`feed-log.js`) | `mlbp.feedlog.<date>` · `data/feed-log-<date>.json` via `/api/feed-log` | 500/date | 7 dates |
| Game-state timeline (`state-log.js`) | `mlbp.statelog.<date>` · `data/state-log-<date>.json` via `/api/state-log` | 2000/date | 7 dates |
| Official Scoring Monitor (`scoring-log.js`) | `mlbp.scoringlog.<date>` · `data/scoring-log-<date>.json` via `/api/scoring-log` | 500/date | 14 dates |

- **Across browsers & sessions (when served with `node server.mjs`):** every accepted
  write is pushed to the other open pages over server-sent events —
  `GET /api/feed-log/stream?date=<date>`, `GET /api/state-log/stream?date=<date>`,
  `GET /api/scoring-log/stream?date=<date>` (~3s reconnect hint, 20s heartbeat) — so an
  entry recorded in one browser shows up in the others as soon as that write lands;
  the periodic pull remains the fallback when the stream is unavailable. On static
  hosting (GitHub Pages) there is no server, so persistence is per-browser
  `localStorage` only. Both sides merge with **union-by-id** semantics and never let a
  recorded ruling revert (a resolved entry stays resolved; the earliest `before`
  wording and the latest `after` wording are kept; every reclassification is appended
  to a capped `history` chain).
- **The official scoring record lives in its own place — `scoring.html`.** The
  **Official Scoring Monitor** (📝 link next to the Replay Feed on every page) shows
  every official-scorer pending ruling and every reclassification — before/after wording
  verbatim from the payload (`result.eventType` / `result.description` / `isOut` / `rbi` /
  scores), `Pending → Resolved` transitions, runs, RBIs, and the official before/after
  score, timestamped to the second. It has All / ⏳ Pending / ✅ Resolved / ✏️ Scoring
  changes tabs, a `?date=YYYY-MM-DD` deep link, one-click JSON export, and a banner
  stating it never chimes, never notifies, and never blocks alerts — official-scoring
  state is evidence, not an alert. Alerts still render on `reviews.html` exactly as
  before (✏️ Scoring Changes tab included); the monitor is the separate, permanent,
  refresh-persistent record.
- **Every game on the slate gets a full official-state timeline** ("📈 Game State"
  tab on the Replay Feed, rendered from `state-log`): Preview (scheduled start +
  official probable pitchers) → game start → every pitch (official call text, count,
  outs, pitch number) → pitching changes → official score changes (before → after,
  with the scoring play's official description) → Final (official status wording,
  final score, decisions when the schedule payload carries them) — all timestamped to
  the second and persisted separately from the alert log.
- **Across the website:**
  - `reviews.html`: renders the All feed and dedicated ✏️ Scoring Changes tab.
  - `scoring.html`: the separate Official Scoring Monitor (stats tiles, tabs, export, `?date=`).
  - `game.html`: dedicated **Challenges & Reviews** tab displays official scoring changes
    with full initial-call-to-final-ruling breakdown, and updates the tab badge.
  - `index.html`: scoreboard cards display the `✏️ N Scoring Change(s)` indicator.
  (the original `docs/scoring-changes.md` was not uploaded — see F-003 on [`flagged.html`](flagged.html)).

To *see and hear* the ⚠️ Runs at Risk surfaces without waiting for a live review,
run the offline, fixture-driven render test — it stubs the API with the exact same
deterministic payload the pages use and makes no network request:

```bash
npm install --no-save jsdom     # dev-only, one time
node tests/jsdom-render-test.mjs
# (the original tools/run-risk-preview.html was not part of the upload — see
#  flagged.html F-003; the render test above is the shipped equivalent)
```

## Deploy to GitHub Pages

The site is 100% static (repo root = site root), so GitHub Pages serves it directly
with no build step and no workflow permissions:

1. **Push this project to GitHub** (any repo — e.g. `yourname/MLB-Live-PBP`).
2. In the repo: **Settings → Pages → Source → "Deploy from a branch"** → branch
   `main` → folder `/ (root)` → **Save**.
3. Your site is live at **`https://<your-username>.github.io/<repo-name>/`** —
   e.g. `https://buffedlizard55-lab.github.io/MLB-Live-PBP/`. Every push to `main`
   republishes it automatically (takes ~1 minute).

### Optional: Actions-based deployment & CI smoke test

The repo's Pages setup doesn't require Actions. If you'd rather deploy via GitHub
Actions (and/or run the nightly API smoke test), ready-to-use workflow files are in
`docs/workflows/` *(not part of the upload — create `.github/workflows/` yourself if you want Actions)*:

- `pages.yml` — deploys to Pages on every push to `main` (requires the repo setting
  **Pages → Source → "GitHub Actions"** instead of branch deployment).
- `smoke.yml` — runs the deterministic two-sided model checks and a nightly
  check that the upstream MLB StatsAPI still matches our parsers; run it anytime
  from **Actions** with "Run workflow".

To use them, copy the file contents into `.github/workflows/` in the repo (the GitHub
web UI's *Add file* is the easiest way), then go to **Settings → Pages → Source →
GitHub Actions**.

### Customizing

- **Season / league:** `SPORT_ID` in `assets/js/api.js` (1 = MLB). Minor-league IDs
  (11–14) also work.
- **Refresh rate:** `LIVE_POLL_MS`, `REVIEW_POLL_MS`, `PREVIEW_POLL_MS`, and `FINAL_POLL_MS` in
  `assets/js/game.js` (the 250ms in-review probe uses `REVIEW_POLL_MS` against the
  lean `playByPlay` endpoint); `LIVE_POLL_MS` / `REVIEW_POLL_MS` / `IDLE_POLL_MS`
  in `assets/js/scoreboard.js` and `assets/js/reviews-feed.js`;
  `FETCH_CONCURRENCY` in `assets/js/reviews-feed.js` (how many games the all-games
  feed fetches in parallel per scan).
- **Team colors:** `TEAM_COLORS` in `assets/js/ui.js`.

## Notes & etiquette

- The MLB StatsAPI is **unofficial and may change without notice**. The client is
  written defensively (fallbacks for every endpoint and missing fields) and the app
  degrades gracefully if a field disappears.
- **Terms & budget:** the request rate of every polling surface, the delta-feed
  design that keeps the steady state to a few KB per live game, the reasons the
  undocumented Gameday websocket is not used, and the terms-of-service bounds this
  site honors are written down in `docs/latency-and-tos.md`. The API's own notice permits
  "individual, non-commercial, non-bulk use"; MLB.com's Terms of Use §1 forbids automated
  collection and any display beyond personal, non-commercial home use — the open question
  of public deployment remains, and there is no published rate limit for the StatsAPI and
  no written authorization either way.
- Be a good citizen: the app needs **no API key** (the StatsAPI is keyless and
  open-CORS) and it self-limits — every page pauses when the tab is hidden,
  backs off on preview/final games, bounds post-Final re-scans to a 30-minute
  grace window, and the shared client honours **HTTP 429** with a quiet period
  (the server's own `Retry-After` when it sends one, clamped to 1s–5min;
  otherwise 60 seconds), so it can never hammer a host that has asked it to
  slow down. The live push is server-side (same-origin `EventSource`) and adds
  no requests to MLB's API. The Replay Feed tracks each live game through the
  official Δ-feed (one ~KB `timestamps` poll per 750ms; the payload moves only
  when MLB publishes a revision) and re-sweeps the slate status every 500ms —
  a quiet live game costs ~1.3 requests/s, not a multi-MB poll. In-review games
  are re-fetched first, and the page only re-renders when an event actually
  changes. The StatsAPI is pull-only — a shorter poll only reduces how long a
  landed event sits unseen, which is why the Δ-feed, not a websocket, is the
  chosen path (see `docs/latency-and-tos.md`).
- This is a **personal, non-commercial project** (no ads, no analytics, no data resale — see the
  request budget and the governing terms in `docs/latency-and-tos.md`).
  It lives in a public repository and is served from GitHub Pages; that is hosting, not a service
  offered to others.
- Review/challenge data shapes were verified against the live API on 2026-08-19
  (schedule `hydrate=review`, `reviewDetails` codes `MJ`/`MA`/`MF`, and
  `gameData.absChallenges`); see `docs/verification-report.md`.
- Team logos, headshots, and the underlying data are © MLB Advanced Media / MLB and
  their respective owners. This is an unofficial fan project — not affiliated with
  or endorsed by MLB.

## License

[MIT](LICENSE)
