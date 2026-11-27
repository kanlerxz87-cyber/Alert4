# API usage bound — what this site sends, and why it is allowed to

This page records the request budget the Replay Feed actually enforces, the
terms it is built around, and the arithmetic behind both. Every number below is
either (a) a constant in the shipped code, named here, or (b) a measurement you
can reproduce in the browser's console. Nothing on this page is an estimate of
MLB's own latency.

> **Short version.** One tab of this site holds itself to **at most 30 requests
> per second and 8 in flight**, pauses entirely while the tab is hidden, narrows
> further whenever MLB's host answers slowly or with HTTP 429, and asks for the
> smallest document that answers each question (a ~120-byte metadata probe
> instead of a full game feed). A busy 15-game slate runs at roughly **~15
> requests per second**, measured with `tools/measure-cadence.mjs`.

---

## 1. The terms this is built around

| Source | What it says | How the code respects it |
|---|---|---|
| MLB Advanced Media usage notice, linked from the copyright line of **every** response — <http://gdx.mlb.com/components/copyright.txt> | "Only individual, non-commercial, non-bulk use of the Materials is permitted." | The site is a personal, non-commercial project: no ads, no analytics, no data resale, no account system. It is not a service offered to others. |
| MLB.com Terms of Use §1 / conduct rules | Forbid automated collection beyond personal, non-commercial home use. | Requests are one user's browser reading the same public feeds MLB.com's own Gameday reads. No scraping fleet, no bulk download, no redistribution. |
| The API itself | Keyless, open CORS, **no published rate limit**, **no SLA**, undocumented, "may change without notice". | Nothing here assumes a limit *or* a guarantee. The client re-derives every field defensively, degrades when a field disappears, and enforces its **own** ceiling rather than relying on MLB to enforce one. |

**The honest open question.** There is no written authorisation for automated
polling, and there is likewise no published limit or block. This site is built
as a *personal, single-user, non-commercial* consumer of a public feed. If it
were ever to become public-facing, or monetised, or to poll from a shared
server on behalf of many users, it would need written permission from MLB
Advanced Media first. That is recorded rather than resolved — see
[`flagged.html`](../flagged.html) §18.

---

## 2. The bound, in code

All of it lives in one place: `assets/js/api.js`.

| Constant | Value | Meaning |
|---|---|---|
| `RATE.maxPerSecond` | **30** | Token bucket for the whole tab, every surface combined |
| `RATE.floorPerSecond` | **2** | The bucket never narrows below this, so one slow response cannot stall the page |
| `RATE.maxConcurrent` | **8** | Requests in flight at once |
| `RATE.healthyStreakMs` | **30 s** | A narrowed bucket recovers one token/s after 30 s of health |
| `PROBE_BUDGET_PER_SEC` (feed) | **8** | Share of the budget reserved for the replay feed's probes |
| `PROBE_BUDGET_PER_SEC` (scoring log) | **4** | Share reserved for the scoring log *when it polls for itself* — normally it consumes the feed's reads (see below) |
| `REQUEST_TIMEOUT_MS` | **15 s** | Per-request abort |
| quiet period | `Retry-After`, else **60 s**, clamped 1 s – 5 min | HTTP 429 handling |

**On refusal the bucket narrows, it does not retry harder.** An HTTP 429, a
5xx, a timeout or a network error all multiply the ceiling by 0.6 (down to 2/s),
and the 429 path additionally opens a quiet window during which no request is
made at all. Sixty seconds of clean responses later, the ceiling climbs back one
token per second.

**Hidden tabs send nothing.** Every polling surface checks `document.hidden`
before it requests, and queues at most one wake-up.

**No endpoint is asked for more than it needs.** The `fields=` projection is
used everywhere it can be:

| Question | Request | Size |
|---|---|---|
| "Did this game's feed move?" | `feed/live?fields=metaData,…` | ~120 B |
| "Is any game in an official review?" | `schedule?fields=…statusCode,reason` | ~2–3 KB |
| "What is the score / batter / count?" | `schedule?fields=…teams` (slate) or `playByPlay?fields=…` | ~1–2 KB / a few KB |
| "What are the official challenge counters?" | `feed/live?fields=gameData,review,absChallenges,…` | < 1 KB |

---

## 3. The arithmetic

### Before this change (as shipped upstream)

| Surface | Request | Cadence | Cost |
|---|---|---|---|
| Replay Feed, per live game | full `playByPlay` | 250 ms | 4/s × games |
| Replay Feed, per live game | `feed/live?fields=gameData,…` (counters) | every scan | 4/s × games |
| Replay Feed status sweep | whole-slate `schedule` | 125 ms | 8/s |
| Replay Feed slate | hydrated `schedule` | 250 ms | 4/s |
| **15 live games** | | | **≈ 128 req/s** |

### After this change

| Surface | Request | Cadence | Cost at a 15-game slate |
|---|---|---|---|
| Replay Feed, per live game | `metaData` probe | `probeIntervalFor(15, 8)` = **1.9 s** | 7.9/s |
| Replay Feed, per live game | `playByPlay` | only when the probe moved | ~0.5/s |
| Replay Feed, per live game | counters | first sight / status change / every 10 s | ~1.5/s |
| Replay Feed status sweep | lean `schedule` | `sweepIntervalMs()` = **400 ms** on a full slate | 2.5/s |
| Replay Feed slate | lean `schedule` (teams only) | **1 s** | 1/s |
| Replay Feed section | — | — | **≈ 13.4 req/s** |
| Official scoring log | *none* | it ingests the feed's reads | **0** |
| Official scoring log (feed closed) | `metaData` probe per game | `probeIntervalFor(15, 4)` = **2 s** | 7.5/s, plus a probe+read on movement |
| **Total, feed open** | | | **≈ 14 req/s against a 30/s ceiling** |
| **Total, feed closed** | | | **≈ 14 + 8.5 ≈ 22 req/s** |

Measured with `npm run measure` (`tools/measure-cadence.mjs`) (the shipped page, a synthetic
15-game slate, every response stubbed): **14.6 req/s steady state, 18 req/s in
its busiest second**, inside the 30/s ceiling; a 9-game slate measures 9.6 req/s.
The page shows the same two figures live in its health line:

```
15 game(s) on Tue Apr 7, 2026 · 12 tracked · 15/30 req/s ·
publish latency ~1.4s (n=42) · probes 96 · reads 21 · status 12
```

`publish latency` is the median gap between the second MLB's own feed timecode
says the state was published and the second this tab observed it. It is
measured, not claimed, and it is the number to watch when tuning.

---

## 4. Why polling, and not the Gameday push socket

MLB's own Gameday client uses a WebSocket
(`wss://ws.statsapi.mlb.com/api/v1/game/push/subscribe/gameday/{gamePk}`) as a
doorbell, then fetches `feed/live/diffPatch` for the change set. That is
materially cheaper than polling, and it is the fastest path that exists.

It is **not** wired in here, deliberately:

* it is a third, undocumented push surface with no published authorisation —
  the same terms question as above, with more exposure;
* it needs one persistent socket **per game**, which is not obviously within
  "individual, non-commercial, non-bulk use" on a 15-game slate;
* the browser would need the full RFC-6902 patch machinery in shipped
  production code, where a wrong patch silently corrupts state.

What *is* shipped is the incremental endpoint's little sibling: the `metaData`
probe above uses MLB's own change marker (`metaData.timeStamp`, plus Gameday's
`metaData.gameEvents` counters as a fallback) to decide "nothing happened here"
in ~120 bytes. `MLB.diffPatch()` and `MLB.timestamps()` are exposed in
`assets/js/api.js`, unused, for a future opt-in — see
[`docs/latency.md`](latency.md) §5 for the design and the caveats.

---

## 5. How to verify this yourself

Open the Replay Feed with DevTools → Network, filter `statsapi`, and watch:

1. the request rate stays at or under 30/s (and ~15/s on a live slate);
2. most requests are `feed/live?fields=metaData…` (tiny) — full `playByPlay`
   requests appear only when something actually changed;
3. hide the tab: requests stop within one tick;
4. `MLB.usageStats()` in the console returns the current rate, the ceiling, the
   per-surface counters and any quiet period remaining.

```js
MLB.usageStats();
// { perSecond: 15, ceiling: 30, concurrent: 0, requests: 812,
//   byKind: { probe: 640, playByPlay: 22, status: 96, schedule: 48, feed: 6 },
//   quietRemainingMs: 0, lastStatus: 200 }
```
