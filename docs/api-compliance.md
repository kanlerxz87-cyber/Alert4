# API compliance — the terms, the budget, and every request the site makes

This file is the binding reference the README points at (previously listed as
"not part of the upload"). It records **what the site is allowed to do** with the
MLB StatsAPI, **how fast it asks**, and **where in the code each limit is
enforced**. Nothing here is an inference about MLB's intent: each clause is
quoted from the source it names.

---

## 1. The terms, quoted

### 1.1 MLB Advanced Media usage notice

Every StatsAPI response carries a copyright line pointing at
<http://gdx.mlb.com/components/copyright.txt>, which states:

> **Only individual, non-commercial, non-bulk use of the Materials is permitted.**

Any other use requires prior written authorization from MLB Advanced Media, L.P.

### 1.2 MLB.com Terms of Use

MLB.com's Terms of Use §1 (the conduct rules) bars automated scripts that collect
information from MLB's digital properties. That is a stricter clause than the
usage notice, and it is the one this project treats as controlling for a
public deployment.

### 1.3 What that means for this project

| Question | Answer, and where it is enforced |
|---|---|
| Is there a published rate limit? | **No.** No response carries a rate-limit header, and MLB publishes no figure. The client therefore imposes its own ceiling (`BUDGET_PER_MIN`, §2). |
| Is commercial use allowed? | **No.** No ads, no analytics, no data resale, no paid access (`README.md` §Notes). |
| Is bulk collection allowed? | **No.** There is no server-side crawler, no archive job, and no historical backfill anywhere in this repo. Every request is made by a browser tab that a person opened, for the game/date that tab is showing. |
| Is the data redistributed? | **No.** The site renders it. Team logos, headshots and all underlying data remain © MLB Advanced Media. The optional persistence server stores only what that browser observed, on that operator's own machine, in `data/` (git-ignored). |
| Is automated collection happening at all? | The site is a client-side reader: it polls the same public JSON the MLB.com scoreboards use, at a bounded rate, and it shows MLB's own wording rather than republishing a derived feed. If your use does not fit "individual, non-commercial, non-bulk", **do not deploy this** — license the data instead. |

Nothing in this document is legal advice. It records the terms and the code that
keeps the site inside them so the owner can make an informed call.

---

## 2. The request budget (enforced in `assets/js/api.js`)

`api.js` is the only place in the site that calls `fetch` against
`statsapi.mlb.com`. Every request — schedule, status sweep, live feed, registry,
people — passes through `getJSON`, which applies:

| Limit | Value | Code | Behaviour |
|---|---|---|---|
| Rolling per-minute ceiling | **240 requests / 60 s per tab** | `BUDGET_PER_MIN` + `awaitSlot()` | A request that would exceed it **waits** for a slot; it is never dropped, so a busy minute delays a poll instead of losing data. |
| Inter-request gap | **40 ms** | `MIN_GAP_MS` | No bursts; two calls cannot leave back to back. |
| One polling tab per browser | lease in `localStorage` | `claimLeader()` / `isLeader()` | The first tab claims the lease and re-claims every 4 s. A second tab sees a live lease and **does not poll MLB** (it renders the shared log instead). A stalled tab is taken over after 12 s. |
| HTTP 429 | `Retry-After`, clamped 1 s–5 min, else 60 s | `QUIET_DEFAULT_MS` etc. | The whole tab goes quiet for that window. |
| Response cache | per-call `ttl` | `getJSON` | `feed/live` is served by MLB with `max-age=10`; the site asks for a 1 s TTL where it needs the second-by-second state and reuses the body it already has otherwise. A shorter interval would only re-read the same bytes. |
| Hidden tab | — | every loop | All polling stops (`document.hidden`), so a background tab makes zero requests. |
| Manual refresh | `nocache` | `runScan(true)` / `game.js` | Pressing Refresh bypasses the local cache (but not the budget) so the user sees MLB's current body. |

`MLB.budgetSummary()` is rendered in both the Replay Feed's latency line and the
game page's status line, so the operator can always see
`API n/240 req/min · this tab polls | another tab polls`.

---

## 3. Every endpoint, its cadence, and why

| Endpoint | Used by | Cadence (live game) | Size | Why this endpoint and not a bigger one |
|---|---|---|---|---|
| `GET /api/v1/schedule?sportId=1&date=…&fields=dates,games,gamePk,season,status,…` | Replay Feed sweep, scoreboard sweep, game page (none) | **125 ms** (whole slate) | ~2.4 KB | The cheapest way to learn "a review was just **called**": `gameData.status.statusCode` flips to `M*`/`N*`/`IH` the moment MLB calls it, while play text is written only when it **resolves**. One request covers all ~15 games. |
| `GET /api/v1.1/game/{pk}/feed/live?fields=<state>` | Replay Feed fast probe, scoring-log capture | 250 ms (feed) / 1 s (capture) | ~2–4 KB | `metaData.timeStamp` + status + linescore + currentPlay: enough to detect *every* change and to timestamp the official state to the second. |
| `GET /api/v1.1/game/{pk}/feed/live?fields=<state>,<plays>` | Replay Feed deep read, game page | on change signal, plus 1 s post-Final tiers | ~120–200 KB | The full game's plays with `reviewDetails`, counters and officials — **without** `players`/`boxscore`, which are the bulk of the ~700 KB–1 MB full feed. |
| `GET /api/v1/gameStatus` | review-type registry | once, cached 1 h | small | Official code → wording (`MA` = "Tag play", …). |
| `GET /api/v1/people?personIds=…` | officials named in a review | once per crew, cached 1 h | small | Identity only. Never per poll. |
| `GET /api/v1/people/{id}/stats` | hit forecast (props) | cached 2 min / 10 min | small | Unchanged by this work. |
| `POST/GET /api/feed-log`, `/api/scoring-log` | **this site's own server** | — | — | Same-origin, not MLB. See §5. |

### What is deliberately *not* done

- No `feed/live` call without a `fields` projection in the polling loops (it
  would be the ~1 MB document for the ~150 KB of it the page reads).
- No `/playByPlay` + `/feed/live` pair per poll (the old shape). One projected
  feed now carries both halves, which is both faster and fewer requests.
- No WebSocket (`wss://ws.statsapi.mlb.com/...`) use. It exists, but MLB does not
  document it for public use, and the site does not depend on an undocumented
  push channel. If MLB ever publishes one, it would replace the probe loop, not
  add to it.
- No `diffPatch` use. It exists and would cut bytes, but its contract (returns a
  whole document when nothing changed, patch paths outside the documented
  surface) is undocumented; a wrong patch would silently corrupt an alert, which
  is worse than the bandwidth it saves.

---

## 4. Latency model, stated plainly

The StatsAPI is **pull-only**, so "fastest" has a floor set by MLB, not this code:

1. **MLB's own interval.** `metaData.wait` in the live feed is `10` seconds, and
   the feed is served with `max-age=10`. A new *document* appears at most about
   once every 10 s per game. Polling faster than that cannot surface an event
   that MLB has not published.
2. **What the site does with that floor** — it removes every avoidable wait
   *after* the document lands:
   - status sweep every 125 ms across the whole slate (~2.4 KB) → the review
     **called** signal is seen within one sweep + one round trip;
   - the affected game is deep-read **out of band** the moment the sweep sees the
     code change — it does not wait for the scan loop;
   - a change in the per-game lean probe (250 ms) promotes that game to a deep
     read in the same tick;
   - the deep read is a projection, not the full feed (~1/5th the bytes, so it
     lands proportionally sooner);
   - the page renders only when a signature changes, so a 250 ms cadence does not
     cost DOM work between events.
3. **What is measured, not claimed.** Both pages print the observed time of the
   last change signal and the configured cadence. Run
   `node tools/alert-latency-test.mjs` for the regression checks on the loop,
   and use the optional server's status line for the request budget in real time.

The honest summary: **the site cannot be faster than MLB's 10 s publish interval
per game, and it is typically within one sweep (≤125 ms) plus one round trip of
a new event after MLB publishes it.** Anyone promising sub-second MLB data
without a licensed push feed is not describing this API.

---

## 5. Two entirely separate persistence stores

| Store | File | Endpoint | Written by | Retention |
|---|---|---|---|---|
| Alert feed log (reviews, challenges, pending, scoring-change **rows**) | `data/feed-log-<date>.json` | `/api/feed-log`, `/api/feed-log/stream` (SSE) | `feed-log.js` ← Replay Feed alert path | newest **14** date files (`pruneOldLogs`, `RETAIN_DAYS`) |
| Official scoring log (exact before/after wording, per-second state) | `data/scoring-log-<date>.json` | `/api/scoring-log` | `scoring-log.js` (own timer) | **kept indefinitely** |

The two never read or write each other's files. A failure in the scoring store
cannot fail a feed-log write, and vice versa; the client mirrors that isolation
(`tools/alert-latency-test.mjs` §2 asserts that a throwing scoring log leaves the
alert feed tracking). Both live in the git-ignored `data/` directory — runtime
state, never committed, never uploaded.

---

## 6. If you intend to run this publicly

The open question in the README stands: the usage notice permits individual,
non-commercial, non-bulk use, and MLB.com's Terms of Use §1 bars automated
collection. A GitHub Pages deployment is hosting of a client that each visitor
runs in their own browser — but that is a judgment call for the operator, not a
fact this project can assert. If your use is commercial, bulk, or redistributes
the data, **seek written permission from MLB Advanced Media or license the data
from a provider** instead of deploying this.
