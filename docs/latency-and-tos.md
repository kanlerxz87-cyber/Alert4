# Latency architecture & MLB StatsAPI terms-of-service bounds

_How Alert4 receives the fastest in-game play-by-play and official-scoring updates it can, while staying inside the bounds of the public MLB StatsAPI's terms of use._

## 1. Endpoints used and how often (per browser session)

| Endpoint | Purpose | Cadence | Approx. size |
|---|---|---|---|
| `GET /api/v1/schedule?sportId=1&date=…` (hydrated `probablePitcher,linescore,decisions,review`) | slate + probable pitchers + decisions + challenge counters | once per 750 ms scan per slate (one request) | ~10–40 KB |
| `GET /api/v1/schedule?sportId=1&date=…&fields=…` (lean status projection) | the 125/500 ms "did a game/review flip?" sweep | 500 ms, all games in **one** request | ~2.4 KB |
| `GET /api/v1.1/game/{gamePk}/feed/live/timestamps` | delta-feed heartbeat for each **live** game | 750 ms per live game | ~2–15 KB (grows with the game) |
| `GET /api/v1.1/game/{gamePk}/feed/live/diffPatch?startTimecode=A&endTimecode=B` | RFC 6902 patch(es) since our cached base — the **documented diff mechanism** (MLB's own swagger describes exactly this flow: request full payload → take `metaData.timeStamp` → pass two timecodes into diffPatch) | only when `timestamps` shows a revision | typically 0.5–50 KB |
| `GET /api/v1.1/game/{gamePk}/feed/live` | full base feed, fetched once per game per session and automatically re-fetched after repeated patch failures | once per game; again only on re-sync | ~1–5 MB |
| `GET /api/v1/game/{gamePk}/playByPlay?fields=…` | fallback path if the delta feed misbehaves (after 3 consecutive failures) | 750 ms per live game | ~100–300 KB |
| `GET /api/v1/game/{gamePk}/feed/live?fields=gameData,review,absChallenges,…` | official challenge counters | only on the standard path (delta mode reads counters from the cached base) | ~1–10 KB |
| `GET /api/v1/gameStatus` | codes → official wording registry | hourly (cached) | ~10 KB |
| `GET /api/v1/eventTypes` | registry for `os_ruling_pending_*` | via pending-ruling detection (codes verified 2026-11-20) | — |

Nothing else is requested. Scores, counts, runners, pitcher/batter names, pitch-by-pitch calls, review details and counters are all read from those official payloads — nothing is simulated, predicted, or re-identified.

## 2. Why this is the fastest legal path

- **A change is visible within ≤ 750 ms of MLB publishing it** (plus network latency) for every live game — score changes, new pitches, pitcher changes, play-by-play completions, pending-ruling appearances, scoring reclassifications, review starts and resolutions.
- The slate sweep separately re-checks official status codes every 500 ms, so a game flipping into a review status (`M*`/`N*`/`IH`/`MJ`/`NJ`) triggers an **out-of-band immediate fetch** rather than waiting for the poll cycle.
- Per poll, the steady-state cost is one `timestamps` call per live game (a few KB). The expensive payload moves only when MLB actually publishes a revision — bandwidth roughly two orders of magnitude below full-feed polling at the same cadence.
- Alert latency (chime/banner) is driven by the *first* poll that sees the revised document, and by the out-of-band path for review flips.

### Why not the Gameday websocket?

`wss://ws.statsapi.mlb.com/api/v1/game/push/subscribe/gameday/{gamePk}` exists and is what mlb.com's Gameday uses, but it is **not** part of the documented public API surface: it is undocumented, its Origin handling is not published, it closes with application-specific codes when a game is unavailable, and relying on it would mean building an alert system on infrastructure MLB does not offer or support. Alert4 deliberately does not use it. If MLB were to publish a push channel with stable terms, adopting it would slot into `live-diff.js` (the timecode bookkeeping is identical).

## 3. Terms-of-service bounds this site honors

1. **Same host, same public surface as MLB.com.** Only `https://statsapi.mlb.com` JSON endpoints are called — the same endpoints mlb.com Gameday itself reads, unauthenticated, no tokens, no circumvention of access controls of any kind.
2. **Rate discipline.** One slate sweep per 500 ms, one small `timestamps` call per live game per 750 ms, patches only on change, hourly registry caching, `no-store` responses respected, **`Retry-After` honored with an automatic quiet period on HTTP 429** (implemented in `assets/js/api.js`, clamped 1 s–5 min), exponential-ish backoff on retries, single retry ceiling, no thundering re-polling of failing endpoints. The static site issues one request stream per open page; it does not fan out across background tabs (hidden tabs pause polling).
3. **No redistribution of the data as a competing product.** Pages render live scores/reviews for personal, in-page display with attribution and direct “MLB API ↗” source links per row. The persistence layers (`feed-log`, `state-log`, `scoring-log`) are local review aids, capped per date (500–2000 rows) and auto-kept only for 7–14 dates; nothing here republishes datasets, bulk extracts, warehouses, or a commercial feed.
4. **No media misuse.** Team logos/headshots are hot-linked from MLB's public CDNs with attribution, exactly as mlb.com serves them; no assets are mirrored or re-encoded.
5. **No interference.** No load testing, no parallel sessions hammering the API, no attempt to bypass caps, paywalls or rate limits, and no scraping of `www.mlb.com` HTML.
6. **Accuracy over bravado.** Where a payload does not carry a fact, the site omits it or flags it (flagged.html) instead of inventing it. Official wording is quoted verbatim. Scores/rulings are never predicted.

**Disclaimer.** MLB's terms are set by MLB Advanced Media, L.P. and can change; this document describes how Alert4 uses the API today, not legal advice. The repository owner should review the current official terms (https://www.mlb.com/official-information/scoring-changes and MLB's Terms of Service) before any public or commercial deployment beyond GitHub Pages of this codebase.

## 4. Data retention (all three logs)

| Log | Namespace | Where | Cap per date | Dates kept |
|---|---|---|---|---|
| Replay feed alerts | `mlbp.feedlog.<date>` | browser localStorage (+`/api/feed-log` when served) | 500 rows | 7 |
| Game-state timeline | `mlbp.statelog.<date>` | browser localStorage (+`/api/state-log` when served) | 2000 rows | 7 |
| Official scoring monitor | `mlbp.scoringlog.<date>` | browser localStorage (+`/api/scoring-log` when served) | 500 rows | 14 |

All three are pruned oldest-first and contain only official payload data (plus local first/last-seen stamps). Clearing site data in the browser wipes them. When served with `npm run serve`, `data/<log>-<date>.json` files are written atomically on the machine running the server and are never committed (`data/` is git-ignored).

## 5. Verifying the pipeline yourself

```bash
node tests/live-diff-test.mjs        # JSON-patch engine vs. a captured official diffPatch response
node tests/scoring-monitor-test.mjs  # scoring + state capture end to end (stubbed storage)
node tests/jsdom-render-test.mjs     # full page render against official fixtures
npm run serve                        # then curl -s localhost:8000/api/scoring-log?date=YYYY-MM-DD
```

During a live game, `reviews.html` shows “Δ-feed fast path on N game(s)” in the status line while the delta feed is healthy for N live games.
