# Latency — how fast the site sees a play, a challenge, or a scoring change

This document is the written record behind the "as fast as possible, inside the
rules" claim. It covers **what the site polls, how often, why that is the
fastest legitimate shape, what was measured against the live API**, and **what
was rejected**. The companion document
[`docs/api-compliance.md`](api-compliance.md) covers the request budget and the
terms-of-use question; the two are meant to be read together.

Everything here was verified against `statsapi.mlb.com` on **2026-11-27** using
game **824638 (CIN @ CHC, 2026-08-28)** — a completed game, so every revision is
permanently addressable. The numbers quoted are what the API actually returned.

---

## 1. The one fact that decides the architecture

The MLB StatsAPI is **pull-only**. There is no webhook, no push channel, and no
websocket: the official notice is an individual, non-commercial, non-bulk data
feed at `gdx.mlb.com/components/copyright.txt`. "Fastest" therefore means:

> **one round trip after MLB publishes**, with as little work as possible
> between the publication and the alert.

Two consequences follow, and both are load-bearing:

1. A shorter poll only reduces *how long a landed event sits unseen*. It cannot
   make MLB publish sooner. The floor on latency is
   `publish → (our poll interval) → (parse) → (alert)`.
2. Because the floor is the poll interval, the win is not "poll harder" — it is
   **"poll something tiny, and parse only when it moved."** That is the whole
   design.

## 2. The revision stamp (`metaData.timeStamp`)

Every live feed document carries its own revision stamp:

```
GET /api/v1.1/game/824638/feed/live?fields=metaData,timeStamp,wait,gameEvents,logicalEvents
→ {"metaData":{"wait":10,"timeStamp":"20260828_212805","gameEvents":[],"logicalEvents":[]}}
```

- **~200–300 bytes.** Measured response body on the game above; the four
  projected keys are the entire document.
- **`YYYYMMDD_HHMMSS`, UTC wall clock.** Game 824638's revisions run from
  `20260828_154013` (pre-game) to `20260828_212805` (final) — i.e. the stamp is
  the official publication time to the second, not a sequence number.
- **It moves exactly when the official state moves.** A new pitch, a count, a
  challenge, a ruling, a scorer change, the final — each lands as a new
  revision with a new stamp. `Latency.parseTimecode()` converts it to a real
  UTC instant, and that instant (not our clock) is what the state log records
  as `officialTime`.

This is why the first tier is a stamp poll and not a feed read: comparing one
string costs a fraction of a millisecond, so nearly the entire budget can go
into *frequency* rather than payload.

## 3. Two-tier polling

```
tier 0   schedule (1 read/minute, ttl-cached)        → which games are live
tier 1   feed/live?fields=metaData… (the stamp)      → "did anything land?"
tier 2   feed/live?fields=<structured projection>    → only when the stamp moved
         + playByPlay?fields=<review projection>      → only when the stamp moved
```

**Tier 1 — the stamp.** One ~300-byte read per game, per tick. Nothing is
parsed: the response is compared with the last stamp seen for that game. If it
is unchanged, the tick ends there. If it changed (or 15 s have passed with no
stamp at all — the safety re-read), tier 2 runs.

**Tier 2 — the structured projection.** A single purpose-built `fields` list
(status, linescore incl. count/outs/runners, current play, review details,
challenge counters, teams). It returns the **complete official state**, so one
read answers both "what is the state now" and "what changed since the last
observation". Then — and only then — the review/scoring parser runs on the
`playByPlay` projection.

Measured behaviour of the projection on 824638:

```
GET /api/v1.1/game/824638/feed/live?timecode=20260828_204406&fields=liveData,linescore,currentInning,…count,playEvents,isPitch,pitchNumber,details,call
→ complete 7th-inning state: 9–4, 1-0 count, 2 outs, Busch batting, Civale/Burke
```

The `timecode=` parameter returns that revision exactly (verified), so a state
row can always be re-fetched for audit. The live loop does **not** use it —
pinning to an old revision would defeat the point.

### Why so many small `fields` lists?

Overlong *mixed* projections come back empty (a documented API quirk: a field
list that spans incompatible document branches can return `{}` for the whole
block). Short, purpose-specific lists return exactly what they name. That is
why the code carries three separate lists — `META_FIELDS`, `SNAPSHOT_FIELDS`,
`PLAYBYPLAY_FIELDS` in `assets/js/api.js`, plus the box-score list — instead of
one "everything" list.

## 4. Pacing: how often, and the arithmetic

`Latency.metaIntervalMs(liveCount, reviewCount)` spreads a **slate-wide** budget:

| live games | interval per game | slate-wide meta rate |
|-----------:|------------------:|---------------------:|
| 1          | 500 ms            | 2 req/s              |
| 3          | 500 ms            | 6 req/s              |
| 9          | 900 ms            | 10 req/s             |
| 15         | 1500 ms (cap)     | 10 req/s             |

- `META_TARGET_RPS = 10` slate-wide, `META_MIN_MS = 500` per game,
  `META_MAX_MS = 1500` per game — the cap is what keeps a 15-game slate from
  turning into 30 req/s by arithmetic accident.
- **Games under review poll at half the interval** (`REVIEW_FACTOR = 0.5`,
  floored at 500 ms). A challenge is the event we must surface first, so it
  gets a double share of the budget.
- **A game with no stamp yet** sets `pendingCycle` every tick: for those, the
  parse itself is the detector (the stamp cannot be compared to nothing).
- **Final games** drop to a 5 s post-final watch for scorer changes;
  **preview** games drop to 30 s (lineups only).

Worst case, measured and asserted by `tests/latency-state-test.mjs` §5:
**≤ 10 meta polls/s slate-wide, ≤ 620 meta requests per minute** for the entire
slate (including the once-a-minute schedule read).

Compare the shape this replaced: a full `playByPlay` document per live game
every 250 ms — ~60 req/s and multi-MB/min on a 15-game slate, with the *whole
document* on the wire before anything could be seen.

## 5. What the two tiers buy, event by event

| official event | first thing that sees it | extra work before the alert |
|---|---|---|
| pitch / count / outs / runners | stamp moves | one structured read, diff, row |
| at-bat ends (hit, out, walk) | stamp moves | same read; official `description` captured verbatim |
| **challenge / manager challenge / umpire review** | stamp moves | same read; `reviewDetails` (`reviewType`, `isOverturned`, `inProgress`, `challengeTeamId`) + counters |
| **official scoring pending** (`os_ruling_pending_primary`) | stamp moves | same read + playByPlay parse |
| **official scorer changes a prior at-bat** | stamp moves | same read + playByPlay parse → `scoring_change` row |
| final | stamp moves | same read; status `Final` |

The alert path itself is then **local and synchronous**: the diff produces the
row, the row is rendered, and `chime()` fires on the same tick. There is no
queue, no second round trip, and no debounce between "we know" and "you hear
it". The only cooling-off is the sound layer's own 3.2 s anti-machine-gun
cooldown (`AlertSound.COOLDOWN_MS`), which is a comfort decision, not a
latency one.

## 6. What was rejected, and why

- **`feed/live/diffPatch?startTimecode=…&endTimecode=…` as a cheap delta.**
  Tried as the obvious "give me just the changes" endpoint. It is unusable for
  this purpose: without an `endTimecode` it returns the **full feed**; narrow
  windows **duplicate** operations; and it **ignores `fields`**. A delta that
  costs more than the stamp and cannot be projected is worse than no delta.
  Not retried.
- **Polling the full feed faster.** This is the naive reading of "lowest
  latency" and it is strictly worse: more bytes (slower), more requests (worse
  citizen), and no earlier knowledge, because the stamp is the thing that tells
  you something landed.
- **Deriving challenge counters from play-by-play events.** Counters are not
  reliably present there. They come from the tier-2 structured snapshot
  (`gameData.review` / `gameData.absChallenges`, then the normalized state),
  and are never inferred by counting events.
- **`?timecode=` in the live loop.** Verified working, and deliberately not
  used for polling: it would pin us to revisions we already have.

## 6b. Two failure modes found while replaying a real 15-game slate

Both were found by replaying the actual 2026-08-28 schedule (15 games, every
club) through the real page with per-game payloads, and both are now covered by
regressions in `tests/latency-state-test.mjs` §2.

1. **`pendingCycle` was cleared before it was read.** `pollGame()` did
   `rec.pendingCycle = false` and *then* `var forced = rec.pendingCycle === true`
   — always false. A tick that was explicitly requested (Refresh, tab focus,
   first read, a game that publishes no stamp) therefore never forced its
   confirm read; on a 15-game slate only 9 of 15 games captured initial state.
   The flag is now read first. Symptom to watch for: "the feed works but some
   games never appear in the live strip".
2. **A denied tier-2 read was recorded as the official state.** When the
   governor denied the structured read (a 15-game slate can spend the burst on
   tier-2 reads in one tick), the failure path produced `{}`, and the page
   happily diffed it into `Score: 12–12 → null–null`. Absence was being logged
   as observation. The capture now **skips** a read that returned nothing
   (re-queueing the game) and refuses to diff a state with no revision, no
   status and no inning. Symptom to watch for: rows whose "after" is `null`.

The pacing consequence of (2) is worth stating plainly: a full slate at burst
can deny a handful of tier-2 reads per tick. Those games simply confirm a tick
later — the stamp is unchanged, so nothing is missed, only deferred; verified
by replay, where all 15 games converged to their final captured state.

## 7. Honest limits

- **Pull-only.** If two revisions land inside one poll window, the diff shows
  the net change; the intermediate state was never on offer. Nothing in this
  design can fix that — it is a property of the feed.
- **A copy of a game's feed is per-game.** Replaying one payload for 15 games
  produces rows labelled with the wrong clubs; the real page reads each
  `gamePk` separately and the replay asserts zero mislabeled rows across the
  full slate (15/15 games, every club).
- **One RTT floor.** Latency is bounded below by the network's round trip to
  `statsapi.mlb.com` plus the poll interval. On a 15-game slate that is up to
  1.5 s; on a single game it is 500 ms.
- **Absent fields stay absent.** A value the API does not publish is rendered
  "—", never inferred.
- **TOS.** This is a personal, non-commercial project holding itself to a
  self-imposed budget; it is not a bulk data service. See
  [`docs/api-compliance.md`](api-compliance.md).

## 8. Where each piece lives

| file | role |
|---|---|
| `assets/js/api.js` | governor (token bucket + rolling-minute cap), `feedMeta`, `feedSnapshot`, `boxscorePitchCounts`, `META_FIELDS` / `SNAPSHOT_FIELDS` |
| `assets/js/latency.js` | `metaIntervalMs`, `parseTimecode`, `readState`, `diffStates`, `buildEvents`, `eventId`, `readPitchCounts`, `readPlayerLines` |
| `assets/js/reviews-feed.js` | the scan loop — tier 0 → tier 1 → tier 2, `scan({force})`, `confirmGame`, `parseGame`, `ingestState`, `chime` |
| `assets/js/state-log.js` | persistence (localStorage + `POST /api/state-log`) and restore |
| `server.mjs` | `GET|POST /api/state-log`, SSE channel `state-log` |
| `tests/latency-state-test.mjs` | the five-section proof in §4/§5, including "unchanged stamp ⇒ no parse" |

## 9. How to verify it yourself

```bash
node tests/latency-state-test.mjs     # latency, capture, persistence, sound, pacing
node tests/run-all.mjs                # the above plus syntax/link/contract/render checks
```

The test binds a fake `fetch` to the real page scripts and serves the exact
revision pair `20260828_204406` → `20260828_212805`, so it asserts against
values the API actually returned: one confirm read per stamp change, zero
parses on an unchanged stamp, the official before/after wording, and the
restore-without-re-chime property.
