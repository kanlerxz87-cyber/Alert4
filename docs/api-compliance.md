# StatsAPI terms & the request budget

_Written 2026-11-27 for the latency work. Nothing here is legal advice; it records what the
published terms say and exactly how the client limits itself._

## 1. What the terms actually say

| Source | Text (paraphrased only where quoted) | Effect on this app |
| --- | --- | --- |
| `statsapi.mlb.com` response envelope | "Copyright MLB Advanced Media… Use of any content on this page acknowledges agreement to the terms posted here <http://gdx.mlb.com/components/copyright.txt>" | The data is MLB's; it is displayed unmodified with attribution, never resold or rebranded. |
| API notice (endpoint metadata, as reported in the project's earlier compliance notes) | permits "individual, non-commercial, non-bulk use" | Personal, non-commercial monitoring. No bulk harvesting: the client only reads the games on the selected date, one at a time. |
| MLB.com Terms of Use §1 | forbids automated collection and any display beyond personal, non-commercial home use | The app is a personal, non-commercial project served from GitHub Pages / a local Node server. Public redeployment as a service is out of scope; this is recorded as an open question, not resolved here. |
| Rate limits | **The StatsAPI publishes no numeric rate limit and no written authorization.** | Acceptability of a cadence is a judgement call, so the client budgets conservatively and reacts to the only signal MLB actually sends: HTTP 429. |

Consequences already implemented before this work: keyless requests, CORS `credentials: 'omit'`,
`Accept: application/json`, no API keys or tokens, no scraping of MLB.com pages, no redistribution,
no analytics.

## 2. Every polling surface, by cadence

| Surface | Cadence | Request | Size | Notes |
| --- | --- | --- | --- | --- |
| Replay Feed — official status sweep | **125 ms** while any game is live, **1 s** otherwise | `GET /api/v1/schedule` + `fields` projection, no hydrations | ~2.4 KB whole slate | Fastest honest signal; a status flip triggers one out-of-band play-by-play fetch. |
| Replay Feed — play-by-play scan | 250 ms | `GET /api/v1/game/{pk}/playByPlay` + `fields` projection | small per game | Only games that are live (or inside the 30-minute post-Final grace, backing off 1s → 2.5s → 15s). Capped at `FETCH_CONCURRENCY = 6` parallel. |
| Replay Feed — counters probe | same as scan, live games only | `GET /api/v1.1/game/{pk}/feed/live` + counters `fields` | ~300 B | Skipped once a game stops being live and its counters are cached. |
| Game page | 500 ms full feed / 250 ms lean play-by-play / 125 ms per-game status | `feed/live`, `playByPlay` | varies | Unchanged by this work. |
| Scoreboard | 500 ms hydrated schedule / 125 ms sweep | `schedule` | varies / ~2.4 KB | Unchanged. |
| Scoring page (new) | **2 s** capture, 4 parallel | `schedule` status + `playByPlay` per live/Final-grace game | small | Deliberately slower than the alert feed: it is a journal, not an alarm. |
| Reference tables | 1 h cache | `GET /api/v1/gameStatus` | static | Registry of official codes/wording. |

Worst case, a full ~15-game slate with the Replay Feed open: ~60 play-by-play + ~8 status
requests per second, single client. The scoring page adds ~7/s. That is tens of requests per
second — not "thousands" — and it is the cadence the original build already used whenever a
review was in flight.

## 3. Guards that are enforced in code

| Guard | Where | Behaviour |
| --- | --- | --- |
| Hidden tab | `reviews-feed.js` (`document.hidden`), `scoring.js`, `game.js`, `scoreboard.js` | No requests while the tab is hidden; work resumes on `visibilitychange`. |
| HTTP 429 | `api.js` `getJSON` | Honours `Retry-After` (1 s – 5 min; default 60 s) as a global quiet period. Every poll path checks `MLB.quietRemainingMs()` and backs off; the sweep waits out the quiet window instead of retrying. |
| Timeout | `api.js` | 15 s per attempt, `AbortController`; one retry with 300 ms backoff for 5xx/network only. |
| No-cache polls | `api.js` | Polls use `cache: 'no-store'` and `ttl: 0`; only the static gameStatus registry is cached (1 h). |
| Post-Final grace | `reviews-feed.js` | 30 minutes after Final, then the game is dropped from the scan entirely. |
| Parallelism | `FETCH_CONCURRENCY = 6` (feed), `CAPTURE_CONCURRENCY = 4` (scoring) | A 15-game slate is never 15 simultaneous sockets. |
| Per-game failure | `reviews-feed.js` `ingestGame` | A 404/400 for one game becomes a flagged irregularity, not a retry storm, and never hides the slate status. |

## 4. Latency, measured rather than claimed

`api.js` times every request with `performance.now()` and exposes
`MLB.latencyStats()` → `{ count, p50, p95, last, slowest, quietRemainingMs, requests, cacheHits }`.
`ReplayFeed.latency()` adds the status sweep's own round trip (`sweepMs`), its scheduled
interval (`sweepIntervalMs`) and when it last ran (`sweepAt`). The Replay Feed status line
prints the sweep round trip and the API p50/p95, so "fastest feed" is an observation, not a
marketing claim. The smoke test asserts the instrumentation exists and that the status line
renders it (section 14, `LA-2`).

## 5. What is deliberately NOT done

- No polling of MLB.com HTML pages, no scraping, no headless browser against MLB.
- No push endpoint is invented: the StatsAPI is pull-only, so a shorter poll can only reduce
  how long a landed event sits unseen — it cannot make MLB publish sooner.
- No request amplification: no per-pitch endpoint fan-out, no boxscore/roster fetches in the
  feed scan, no `feed/live` for games that are not live.
