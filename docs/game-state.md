# Live game state — captured to the second

`assets/js/game-state.js` records the official state of every live game on the
slate as it happens, and the *transition* between two states. It is written to
its own store, under its own key, and it never sits between an alert and the
screen.

## 1. What is captured

One snapshot per observation (`GameState.snapshot(payload)`):

| Field | Source in the official payload |
|---|---|
| score | `liveData.linescore.teams.away/home.runs` (falls back to the last play's `result.awayScore/homeScore`) |
| outs | `liveData.linescore.outs` |
| count | `liveData.linescore.balls/strikes` |
| batter at bat | `liveData.linescore.offense.batter` |
| pitcher | `liveData.linescore.defense.pitcher` |
| runners | `liveData.linescore.offense.first/second/third` |
| inning / half | `liveData.linescore.currentInning`, `isTopInning`, `inningState` |
| pitch | last `playEvents[].isPitch` — official `pitchNumber`, `details.call.description`, pitch type, start speed |
| last play | `liveData.plays.allPlays[]` — `result.eventType`, `result.description` |
| at-bat | `about.atBatIndex`, `about.isComplete`, `about.hasReview` |
| official status | `gameData.status.statusCode/detailedState/abstractGameState/reason` |
| official scoring pending | `result.eventType` is `os_ruling_pending_primary` / `_prior` |

and two clocks:

```json
{
  "observedAt": "2026-04-07T18:22:36.412Z",   // our clock, to the millisecond
  "gameTimecode": "20260407_182231",           // MLB's own feed timecode
  "latencyMs": 5412                            // the difference
}
```

`observedClock` is the same moment as `HH:MM:SS` for display. The latency figure
is shown in the health line and documented in [`latency.md`](latency.md) §6.

## 2. What a transition is

`GameState.diff(prev, next)` compares two snapshots field by field and returns
each change with the exact before/after values, the wording of both, and the
game timecode the change landed at:

```json
{
  "field": "status",
  "label": "Status",
  "fromText": "In Progress",
  "toText": "Manager challenge: Tag play",
  "atGameTimecode": "20260407_182302",
  "alerting": true
}
```

Two fields are **alerting** — a change there is something the owner asked to be
told about:

* `status` — any official status change, which is how a challenge, manager
  challenge, review, umpire review or instant replay first becomes visible;
* `pendingRuling` — an at-bat whose official scoring has not been decided.

Everything else (score, outs, count, batter, pitcher, inning, pitch, at-bat,
runners) is recorded and timestamped for the trail but does not make a sound:
the alert sound is for decisions under review, not for every pitch.

## 3. Storage, and surviving a refresh

Two layers, both idempotent, both **separate from the alert feed log**:

| Layer | Key / endpoint | Kept |
|---|---|---|
| this browser | `localStorage["mlbp.gamestate.<YYYY-MM-DD>"]` | newest 7 dates |
| local server | `GET/POST /api/game-state?date=…` → `data/game-state-<date>.json` | until deleted |

**Storage limits are the reason for the caps.** A nine-inning game publishes
roughly 150–300 distinct states; a 15-game slate would be ~4,500 snapshots and
would overflow a 5 MB quota quickly. So:

* `MAX_SNAPSHOTS = 240` per game per date (a full game plus room);
* `MAX_TRANSITIONS = 320` per game per date;
* equal snapshots (same `gameTimecode`) are not stored twice;
* transitions are de-duplicated by `gameTimecode + field + new wording`;
* on a quota error the local write fails **silently** and the server write is
  still attempted — nothing breaks, the page just keeps less history.

Server rows are **merged, not overwritten**, so two browsers watching the same
day never lose each other's observations.

## 4. Where it shows up

* **Replay Feed → "Live game state — captured to the second"**: one row per
  monitored game with the score, inning, outs, count, batter and pitcher, the
  capture clock and MLB's feed timecode, and an `official scoring pending`
  chip when that at-bat is undecided.
* **Alerts**: the state transition that flips `status` into a review is what the
  feed's row and chime are anchored to, and the row carries the official
  wording that produced it.
* **Game page** *(not wired yet)*: `GameState.latest(date, gamePk)` and
  `GameState.forGame(date, gamePk)` are exported for a before/after panel on the
  game view. The data is already being recorded there; only the panel is
  missing, so this is listed as remaining work rather than claimed as done.

## 5. Reading it from the console

```js
GameState.latest(MLB.todayISO(), 823109);        // newest snapshot
GameState.forGame(MLB.todayISO(), 823109).transitions;  // the trail
GameState.days[MLB.todayISO()].games[823109];    // everything held in memory
```
