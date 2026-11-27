# Official scoring — pending rulings and scoring changes, kept apart

Two things the official scorer does after a play is over are easy to miss and
worth a permanent record:

1. **a ruling is pending** — the at-bat exists in the feed but has not been
   classified yet (`os_ruling_pending_primary` / `os_ruling_pending_prior`);
2. **a call is changed** — the scorer reclassifies a play (hit ↔ error, single ↔
   double, out → hit, and so on).

Both live in the **Official Scoring** section at the bottom of the Replay Feed,
in their own store, with their own sound and their own files. That separation is
the design requirement, not an accident — and it costs nothing in requests,
because the log **ingests the plays the Replay Feed has already read** instead of
polling the same games again. It keeps its own loop for the case where no feed is
on the page (or the feed goes quiet for `UPSTREAM_IDLE_MS`, 10 s), and that loop
stands down again the moment the feed resumes. So the request cost is zero on the
Replay Feed and unchanged anywhere else:

| | Alert feed | Official scoring log |
|---|---|---|
| Code | `reviews-feed.js`, `reviews.js` | `scoring-log.js`, `scoring-ui.js` |
| Storage key | `mlbp.feedlog.<date>` | `mlbp.scoring.<date>` |
| Server store | `data/feed-log-<date>.json`, `/api/feed-log` | `data/scoring-<date>.json`, `/api/scoring-log` |
| Sound | `Chime.play('alert')` | `Chime.play('scoring')` |
| On/off | `mlbp.pref.sound` | `mlbp.scoring.sound` |
| Poll loop | the feed's scan | `ScoringLog.start()` — but it stands down while the feed is delivering (`ScoringLog.ingestPlays()`) |
| Failure blast radius | — | a failure here cannot stop the alert feed |

`Chime` keeps the two players in **separate `AudioContext`s, with separate
preferences and separate cooldowns**, so switching one off never silences the
other and a bug in one cannot mute the other.

---

## 1. Pending rulings

**Detection.** The play-level `result.eventType` is checked against the API's
own event registry, `GET /api/v1/eventTypes`, which lists
`os_ruling_pending_primary` and `os_ruling_pending_prior` with the description
**"Official Scorer Ruling Pending"**. The registry is fetched once an hour
(it is a static reference table) and used for the label; the code itself is what
is matched. Nothing here is inferred from the wording of a description.

**Row.** The exact official wording as published, the batter, the pitcher, the
inning, the score at the time, the `atBatIndex` and the source endpoint. When
the scorer decides, the row is marked **resolved** — it is never deleted, so the
log stays complete.

```json
{
  "id": "823109:71:pending",
  "kind": "pending",
  "status": "pending",
  "eventType": "os_ruling_pending_primary",
  "officialWording": "Official Scorer Ruling Pending",
  "description": "…the exact official wording at the time…",
  "firstSeen": 1775586151000, "lastSeen": 1775586213000
}
```

## 2. Scoring changes

**Detection.** The payload carries **no** "this was changed" marker, so a change
can only be found by observation: every completed play's official
classification is fingerprinted on each read

```
result.eventType · result.isOut · count.outs · rbi ·
result.awayScore/homeScore · runner movements whose details.eventType is an error
```

and diffed against the previous fingerprint for the same `atBatIndex`.

**Row.** Both sides, always:

| | Initial call | Final ruling |
|---|---|---|
| official wording | `"Reached on error, E6."` | `"Singles on a ball the shortstop misplayed."` |
| classification | `field_error` | `single` |
| out | false | false |
| score after | 1–1 | 2–1 |

with the attribution MLB itself gives for changes — the Official Scorer, the
Elias Sports Bureau, or a post-game club review
([mlb.com/official-information/scoring-changes](https://www.mlb.com/official-information/scoring-changes)).

**The honest limitation.** A change is only recordable when the **initial call
was observed before the change landed**. If the page opens after the scorer has
already made the change, the log cannot invent the first version; it records the
current call as the baseline and says so. This is a property of the payload, and
it is stated on the page rather than papered over.

## 3. Persistence

| | Where | Kept |
|---|---|---|
| This browser | `localStorage["mlbp.scoring.<date>"]` | newest 7 dates |
| Local server | `POST/GET /api/scoring-log` → `data/scoring-<date>.json` | until deleted |

Both are read on load and **merged**, so a refresh restores every row and every
activity line, and two browsers on the same day combine instead of overwriting.
On static hosting (GitHub Pages) the server endpoints do not exist; every
request fails quietly and the section runs from `localStorage` alone.

## 4. The activity log

A third tab in the section is an append-only trail — what was seen, when, for
which game — so the order of events is reviewable after the fact:

```
18:22:31  pending    Ruling pending observed: at-bat 71 — Official Scorer Ruling Pending   SEA @ MIN
18:24:07  change     At-bat 71 reclassified: field_error → single                           SEA @ MIN
```

## 5. Sound

The scoring player plays the same rain drop, gated by its **own** toggle, its
own 4 s cooldown and its own preference key. It sounds for a newly logged row
(pending or change) and it is labelled in the section it belongs to, so it is
obvious which switch controls which sound.

## 6. Operating it

* **Rescan now** — forces an immediate full read of every monitored game
  (ignores the probe schedule) and re-renders.
* The section shows its own status: pending count, change count, where it is
  saving (`shared store` or `this browser`), the poll cadence and the last scan.
* Console access: `ScoringLog.days[date]`, `ScoringLog.dayFor(date)`,
  `ScoringLog.loop`.

## 7. Suggested next steps (not implemented)

* Export a day's log as JSON/CSV for a season-long archive (the store already
  has the shape; GitHub Pages cannot persist a server-side file, so this would
  be a local-server or manual-download feature).
* Diff against MLB's published scoring-changes page to attribute a change to
  "post-game Elias" rather than "in-game scorer" — currently the row states the
  three possible sources, it does not pick one.
* Keep a longer server-side retention than the browser's seven dates; the
  server file has no cap today other than the row/event counts.
