# Latency — getting an in-game event to the screen as fast as the feed allows

This page explains what the Replay Feed does to be fast, what "fast" is
measured against, and — importantly — what it does **not** claim.

Everything described here is in the shipped code. Field names are quoted from
the official payloads; anything not verified against a live response is marked
as such and listed on [`flagged.html`](../flagged.html) §18.

---

## 1. What the feed is actually waiting for

There are three delays between an event happening and a row appearing, and only
one of them is ours:

| # | Delay | Typical | Whose it is |
|---|---|---|---|
| 1 | The play is scored and published by MLB | seconds | MLB's — nothing we can do |
| 2 | MLB's CDN hands us the new document | 0–10 s if a cached copy is reused | partly ours (see §2) |
| 3 | We notice, parse, render and chime | ~250 ms – 2 s | ours |

Delay 2 is the one that is easy to get wrong and invisible when you do: MLB
serves its API responses with `Cache-Control: max-age=10`, so asking the *same
URL* every 250 ms can legitimately return the **same cached document for ten
seconds**. Three years of "we poll every 250 ms" therefore does not mean "we see
things within 250 ms".

The fix is per-request cache bypass on the *cheapest possible* document rather
than on the expensive one:

```
GET /api/v1.1/game/{gamePk}/feed/live?fields=metaData,timeStamp,gameEvents,eventId,eventIndex&_=<nonce>
```

~120 bytes, always fresh, carrying MLB's own change marker
(`metaData.timeStamp`). The full play-by-play is fetched **only when that marker
moved**. The nonce is not a different resource and not a data-collection trick —
it is a cache-buster on a metadata document the client already needs.

---

## 2. The two-tier scan

```
every ~1 s   → league slate (gamePk + status + teams)          ~2 KB, cached 1 s
every 125–400 ms → official status sweep (statusCode/reason)   ~2.5 KB, adaptive
per live game    → metaData probe                              ~120 B, every 0.25–2 s
on change        → play-by-play read + counter read            only when it moved
```

`probeIntervalFor(liveCount, perSecond)` in `api.js` spreads the per-game probe
across the slate:

| Live games | Probe interval each | Probe requests/s |
|---|---|---|
| 1–8 | 250 ms | up to 8/s (capped by budget) |
| 10 | 1.25 s | 8/s |
| 15 | 1.9 s | 7.9/s |
| 40 | 2 s (floor) | 20/s — the bucket starts refusing |

A game whose feed is **moving** (`changedUntil`) or whose official status just
flipped into a review (`statusByPk`) is probed at the full 250 ms tier
regardless, and a status flip forces one immediate play-by-play read — taken out
of band, ahead of the running scan, so the alert row appears on the same tick
the status did.

---

## 3. The official status sweep (reviews and challenges)

A challenge or review is visible in *two* places in the payload:

1. **the game status** — `status.statusCode` flips to the review family the
   instant the crew calls for it (`MA` manager challenge: tag play, `NH` umpire
   review: home run, `IH` instant replay, `MJ`/`NJ` ABS pitch challenge, …);
2. **the play** — `reviewDetails` is written when the play resolves.

The status therefore lands **before** the review text exists. That is why the
sweep exists and why it is the fastest tier:

```
GET /api/v1/schedule?sportId=1&date=YYYY-MM-DD
    &fields=dates,games,gamePk,season,status,abstractGameState,codedGameState,
            detailedState,statusCode,reason,startTimeTBD,abstractGameCode
```

The whole slate's status in ~2.5 KB, every 125 ms on a small slate, widening to
400 ms on a full one — and doubling again if the request bucket is above 70% or
full. The interval is recomputed each tick (`sweepIntervalMs()`), so the sweep
can never starve the probes or the read path.

Detection is by the **API's own registry**, never by matching the words
"challenge" or "review" in a string: `M*` = manager challenge, `N*` = umpire
review, `IH` = instant replay, `MJ`/`NJ` = ABS pitch challenge, all resolved
through `GET /api/v1/gameStatus`.

---

## 4. The paths the owner asked about, one by one

| Event | Detected by | Fastest path |
|---|---|---|
| Manager challenge / crew chief review / umpire review / instant replay | status code flip (sweep) **plus** `reviewDetails` (read) | sweep → out-of-band read → row + chime |
| ABS pitch challenge | `reviewDetails` on the pitch event; `gameData.absChallenges` for the counters | probe → read → row |
| Official scoring **pending** (`os_ruling_pending_primary` / `_prior`) | the play's own `result.eventType`, checked against `GET /api/v1/eventTypes` | probe → read → row + chime, logged separately |
| Official scoring **change** (scorer reclassifies a play) | diffing every completed play's `result.eventType` / `isOut` / outs / error movements between reads | probe → read → diff → row + chime |
| Any other play-by-play update | `metaData.timeStamp` / `gameEvents` moved | probe → read → state transition |

Because the scoring-change detector needs *two* observations of the same play,
it can only report a change whose **initial call was observed before** the
change landed. That is a hard limit of a payload with no change marker, it is
stated in the UI and in the log, and the feed does not pretend otherwise.

---

## 5. What is exposed but not enabled

`assets/js/api.js` exports two incremental helpers that are **not** wired into
any page:

```js
MLB.diffPatch(gamePk, startTimecode, endTimecode)  // feed/live/diffPatch
MLB.timestamps(gamePk)                             // feed/live/timestamps
```

They return MLB's own RFC-6902 change set between two of its own feed
timecodes, which is what Gameday itself uses. They are here because the next
honest step in latency is "subscribe to the push doorbell and fetch only the
diff", and that needs these two calls.

Why it is off:

* one persistent WebSocket **per game** on a 15-game slate is not obviously
  within "individual, non-commercial, non-bulk use";
* patches apply to the raw tree and need a correct RFC-6902 implementation in
  production code — a bad patch silently corrupts state, and the failure mode is
  invisible;
* a patch stream needs a full-refetch fallback anyway, so it does not remove
  the polling code, it doubles the paths that can be wrong.

If it is ever turned on, the safe shape is documented in the code they came
from: patch a **copy**, commit on success, fall back to a full refetch on any
throw, keep the poll as a backstop (60 s), and kill the push path for the
session after three consecutive failures. That is a deliberate future decision,
not an oversight.

---

## 6. Measuring it

Every state snapshot is stamped with two clocks:

* `observedAt` — this browser's clock, ISO with seconds and milliseconds;
* `gameTimecode` — MLB's own `metaData.timeStamp`, the second the API published
  that state.

`latencyMs = observedAt − gameTimecode`, computed only when the timecode's wall
clock sits within **2 hours** of the reader's own clock. That guard exists
because the payload never states the timecode's zone: if it were reported in a
different zone, a naive subtraction would print a latency that is hours out.
When the guard fails, the health line says
`publish latency n/a (feed timecode is not on this clock)` and the strip still
shows the raw timecode. No number is invented.

The Replay Feed's health line shows the **median** of the last 60 samples:

```
15 game(s) on Tue Apr 7, 2026 · 12 tracked · 15/30 req/s ·
publish latency ~1.4s (n=42) · probes 96 · reads 21 · status 12
```

That figure includes MLB's own publish delay, so it is an upper bound on our
share. When it grows, the cause is one of: a saturated bucket (check `req/s`
against the ceiling), a big slate (check the probe interval), or MLB being slow
(nothing to fix here).

---

## 7. Known gaps

* **`max-age=10` is a floor, not a ceiling.** The probe's nonce defeats the
  client-side cache, but if an intermediate cache ignores query strings the read
  can still be up to 10 s stale. Not verified against MLB's edge network; see
  flagged §18.
* **The feed timecode's zone is not stated anywhere in the payload.** This
  client assumes only that it is on the reader's wall clock, verifies that
  within a 2-hour window, and reports no latency when the check fails. The zone
  itself is flagged (flagged.html §18, L-7), not asserted.
* **The status sweep is one request for the whole slate,** so its cadence is
  bounded by the budget rather than by the number of games: on a 15-game slate
  it runs every 400 ms, not 125 ms.
* **A review with no status-code change** (rare: the crew huddles and the code
  never leaves the normal live state) is only caught by the probe/read tier,
  i.e. within one probe interval plus a round trip.
