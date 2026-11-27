# Live game state (second precision) & the isolated official-scoring log

_Written 2026-11-27. Describes what was added, why it is shaped this way, and the suggestions
that follow from it._

## 1. The problem

The Replay Feed already answered "did a challenge/review/pending ruling/scoring change happen",
but three things were missing for full-season monitoring:

1. the **state around** the event (score, outs, count, pitch count, pitcher, batter) was not
   journalled, so "before" was only a score pair, and there was no second-precision trail;
2. the **exact official wording** before and after a ruling was not stored separately from the
   rendered row;
3. the pending/scoring signals lived only in the alert feed's store, so a busy or broken alert
   store was also the scoring archive.

## 2. Live state — `assets/js/live-state.js`

`LiveState.capture({ gamePk, teams, game, payload, at })` reads one play-by-play payload and
returns an immutable snapshot:

```
at, atIso (ISO-8601 with ms), atClock (HH:MM:SS)
status, statusCode, detailedState
inning, halfInning, inningLabel
outs, balls, strikes            (currentPlay.count, else linescore)
score { away, home }            (linescore.teams, else last play's result scores)
pitcher { id, name }, batter { id, name }
pitchCount { total, pitcher }   (sum of playEvents[].isPitch, per pitcher id)
atBatIndex, play { atBatIndex, eventType, description, isScoringPlay, isComplete }
reviewStatusCode                (last official reviewDetails.reviewType in the payload)
```

Everything is copied from the payload. A field the payload does not carry is `null` and renders
as `—`; nothing is inferred or back-filled.

Helper functions:

- `fingerprint(snapshot)` — a compact identity string (status, inning, outs, count, score,
  pitcher, batter, at-bat, review code, pitch total). `append()` uses it so an unchanged poll
  does not grow the journal; it only bumps `lastSeenAt`.
- `append(history, snapshot)` — bounded journal (default 60 snapshots per game), newest last.
- `diff(previous, next)` — `[{ field, label, before, after }]` for score, outs, inning, pitcher,
  batter (only when the at-bat changed), review status and game status. With no previous
  snapshot (page opened mid-game) it returns `[]` rather than inventing a diff.

Persistence: the journal rides in the feed log payload under `live` —
`{ [gamePk]: { latest, history } }`. `feed-log.js` merges journals by observation time
(`mergeLive`), and `server.mjs` does the same merge before writing
`data/feed-log-<date>.json`, so a refresh, a second tab or a server round-trip cannot lose a
capture. The Replay Feed renders it as a board of **every game on the slate** (score, inning,
outs, count, pitch count, pitcher, batter, last play, `captured HH:MM:SS`).

## 3. Before/after wording on feed rows

Each review row carries:

```js
official: {
  before: { at, atIso, atClock, statusCode, detailedState, eventType,
            description, typeLabel, reason, outcome, reviewStatusCode },
  after:  { …same shape, written when the ruling resolves… },
  lateObservation: true   // only when the page first saw the row after the ruling
}
```

Pending rulings get `official.before` when first observed and `official.after` when the play's
`result.eventType` stops being `os_ruling_pending_*` and the API publishes a real
classification. Scoring changes get `official.before` = the initial classification and
`official.after` = the final classification, both timestamped.

The UI prints them verbatim under "Official wording — before / after". A late observation is
labelled as such; the pre-ruling text is never fabricated.

## 4. The isolated scoring store — `assets/js/scoring-log.js`

Two record kinds only:

| kind | when it is written | `status` |
| --- | --- | --- |
| `pending` | the payload marks an at-bat unscored (`os_ruling_pending_primary` / `_prior`) | `open` → `resolved` when the ruling lands |
| `change` | a completed play's official classification changed between observations | `changed` |

Each record keeps `at/atIso/atClock`, `wordingBefore/After`, `officialBefore/After`
(eventType, description, outs, RBI, scores), `stateBefore/After` (the live-state summary),
`inningLabel`, batter/pitcher, attribution and source.

Isolation, in concrete terms:

- **Separate keys:** `mlbp.scoringlog.<date>` (+ `mlbp.scoringlog.index`), never the
  `mlbp.feedlog.*` keys. Clearing one leaves the other.
- **Separate server route and file:** `GET/POST /api/scoring-log` →
  `data/scoring-log-<date>.json`, merged by record id, capped at 2000 records. The feed log's
  route/file is untouched, so a scoring-log write cannot corrupt or block the alert log.
- **Separate write path:** `reviews-feed.js` accumulates records during a poll and calls
  `writeScoringLog()` as the **last** statement of `ingestGame`, after every chime and row
  upsert, inside its own `try/catch`. A throw or a slow server never reaches the alert path.
- **No alerting:** `scoring-log.js` has no audio, no notifications, no `ReplayFeed` import. A
  smoke test asserts a scoring write changes neither the feed rows nor `lastChimeAt`.
- **Independent capture:** `scoring.html` (`assets/js/scoring.js`) runs its own 2s loop, so
  the journal keeps filling even with the Replay Feed closed. That loop is slower than the
  alert feed on purpose (it is an archive, not an alarm) and uses the same parser
  (`reviews.js`) and the same projections — no second definition of "pending" or "changed".

Merging is idempotent by record id: the first observation wins the "before" half, later
observations fill the "after" half and the status, and nothing is ever deleted or reordered.

## 5. Suggestions that follow from this design

1. **Server-side watcher (optional).** A tiny `node tools/watch-slate.mjs` cron (one request per
   live game per few seconds) would keep the log filling while no browser is open. It should
   reuse `scoring-log.js`/`server.mjs` rather than a second ingest path, and it is the only
   way to guarantee capture for a game nobody has a tab open for.
2. **True push latency.** The StatsAPI is pull-only. If MLB ever exposes a stream, the sweep
   becomes the fallback rather than the primary. Until then 125 ms while live is the floor.
3. **Compact journals after the fact.** `data/feed-log-<date>.json` grows with 60 snapshots per
   game; a nightly compaction that keeps only snapshots that `fingerprint()`-differ plus the
   final state would shrink it ~10× with no loss of the before/after trail.
4. **Export the scoring log daily.** `scoring.html` already has "Export JSON"; a scheduled
   download or a server job copying `data/scoring-log-*.json` into a season archive would give
   a complete, queryable record of every official-scoring decision.
