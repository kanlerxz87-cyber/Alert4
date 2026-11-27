# API compliance — what we ask of the MLB StatsAPI, and the rules we hold it to

This is the written record of the two things a reader of this project should be
able to check without reading the code: **the request budget** and **the
terms-of-use question**. It accompanies [`docs/latency.md`](latency.md), which
explains the polling design that this document constrains.

The short version: **no API key, no bulk collection, a self-imposed request
governor, and an honest acknowledgement that there is no written authorization
either way.**

---

## 1. The two notices that apply

Two separate statements govern this data, and they do not say the same thing.

**(a) The StatsAPI notice** — `https://gdx.mlb.com/components/copyright.txt`:

> "Only **individual, non-commercial, non-bulk use** … prohibited without prior
> written authorization from MLBAM."

This is the notice on the data component itself. It permits individual,
non-commercial, non-bulk use, and forbids bulk use without written
authorization. This project is individual, non-commercial, and deliberately
non-bulk (see §3).

**(b) MLB.com Terms of Use §1** — the site-level terms, which are stricter:
they forbid automated collection and any display beyond personal, non-commercial
home use.

The two clauses pull in different directions: (a) contemplates programmatic
access for individual non-commercial use; (b) is written for the website and
speaks against automated collection in general. **This project does not claim to
have resolved that tension**, and it does not claim written authorization. What
it does is:

- stay inside the narrowest reading of both (individual, non-commercial, home
  use, non-bulk, no redistribution of the data as a dataset);
- make every request it issues visible and bounded (below), so that a reader can
  judge the volume;
- treat the **public deployment question as open** — see §6.

**No published rate limit.** The StatsAPI publishes no numeric limit and has
issued no written authorization. The numbers in §3 are therefore self-imposed
policy, not an implementation of a published quota. They are deliberately
conservative.

## 2. Request shapes

- **Keyless.** No API key, no cookie, no auth header is sent. Nothing about the
  user is transmitted to MLB.
- **Public endpoints only**: `/api/v1/schedule`, `/api/v1.1/game/{pk}/feed/live`,
  `/api/v1/game/{pk}/playByPlay`, `/api/v1/game/{pk}/boxscore`,
  `/api/v1/eventTypes`, `/api/v1/teams`, `/api/v1/sports`, `/api/v1/game/{pk}/gameStatus`.
- **`fields` projections everywhere they help.** The feed reads are a few
  hundred bytes (the revision stamp) or one purpose-built projection, never the
  multi-megabyte full document. Short, non-overlapping projections return
  exactly what they name; overlong mixed lists are avoided because they come
  back empty.
- **No scraping of mlb.com pages, no bulk export, no mirroring.** The site
  renders a live view; it does not build a redistributable dataset.
- **Same-origin only for our own persistence.**
  `GET|POST /api/state-log` and `/api/feed-log` go to the project's own Node
  server, never to MLB. On GitHub Pages those calls are skipped entirely
  (`*.github.io`), so a static deployment never 404s.

## 3. The request budget

The budget is enforced in **one** place — the governor in
`assets/js/api.js` — so that every surface (scoreboard, game page, replay feed,
props) shares it rather than each keeping its own timer.

```js
var BUDGET = {
  refillPerSec: 20,      // token bucket refill
  burst: 30,             // token bucket ceiling
  windowMs: 60000,       // rolling-minute window
  maxPerWindow: 2400,    // hard cap: 40 requests/second-equivalent, sustained
};
```

- **Token bucket:** 20 tokens/s refilled, 30 max. A request that finds the
  bucket empty is **denied** (rejected with `err.budget`) rather than queued —
  a queue turns a spike into a burst, which is exactly what a governor exists to
  prevent. `takeBudgetToken()` / `budgetRemaining()` expose the state; the
  Replay Feed header shows it live.
- **Rolling-minute cap:** 2400 requests in any 60 s window, hard stop.
- **HTTP 429 is honoured**, not retried: the client enters a quiet period using
  the server's `Retry-After` when present (clamped to 1 s – 5 min), otherwise
  60 s. During the quiet period the governor denies requests, so a host that has
  asked us to slow down never sees us again until it expires.
- **Hidden tab ⇒ paused.** Every polling surface stops when `document.hidden`.
- **TTL caches** on the static endpoints (`eventTypes`, `teams`, `sports`,
  schedule) mean those are read once, not per scan.

### Per-surface rates

| surface | behaviour | worst case |
|---|---|---|
| **Replay Feed** (all games) | stamp poll, slate-wide budget (see `docs/latency.md` §4) | **10 meta reads/s** slate-wide; tier-2 reads only on a stamp change |
| Replay Feed schedule | 1 read/min, TTL-cached | 1 req/min |
| Replay Feed status sweep | schedule-level safety net (`STATUS_SWEEP_MS = 5000`) | 0.2 req/s |
| Scoreboard (`scoreboard.js`) | `LIVE_POLL_MS = 500`, `IDLE_POLL_MS = 30000`, `STATUS_SWEEP_MS = 125` on live games | governed by the shared bucket |
| Game page (`game.js`) | `LIVE_POLL_MS = 500`, `REVIEW_POLL_MS = 250` (review in flight), `PREVIEW_POLL_MS = 30000` | governed by the shared bucket |
| Final games | 5 s post-final watch (scorer changes) inside the same budget | falls to 0 after the grace window |
| Preview games | 30 s (lineups only) | — |

The point of the shared bucket is that these tables cannot add up to something
unbounded: whatever each surface asks for, the governor caps the sum at **20
req/s sustained, 30 burst, 2400 per rolling minute**.

For context, the shape this replaced pulled a full `playByPlay` document for
every live game every 250 ms — roughly 60 req/s and multi-MB/min on a 15-game
slate. The two-tier stamp poll moves *less* data and makes *fewer* requests
while seeing changes no later (see `docs/latency.md` §2–§4).

## 4. Behaviour under failure

- **429 / 5xx / network error** ⇒ quiet period (429) or bounded retry with
  backoff; the UI shows the last good state rather than an empty page.
- **Budget denial** ⇒ the tick is skipped, not queued; the next tick recomputes.
- **Missing fields** ⇒ rendered "—"; never inferred, never zero-filled.
- **Endpoints change** ⇒ every caller has a fallback (v1.1 → v1 for the live
  feed, `feed/live` → `playByPlay` for review parsing), and the page degrades
  instead of breaking.

## 5. What we do not do

- We do not scrape `mlb.com` pages, and we do not call any endpoint that
  requires an account or a key.
- We do not bulk-download, mirror, or republish the API as a dataset.
- We do not resell, advertise against, or analyse traffic (no analytics, no
  trackers, no third-party scripts).
- We do not poll a game that is finished beyond the short post-final grace
  window, and we do not poll at all while the tab is hidden.
- We do not attempt to defeat a rate limit, and we do not rotate identities or
  IPs to get around one.

## 6. The open question: public deployment

The project is a **personal, non-commercial project**. It lives in a public
repository and is served from GitHub Pages; that is *hosting*, not a service
offered to others. Under the strictest reading of MLB.com Terms §1 (personal,
non-commercial home use), a public URL that anyone can load is the part that is
least clearly covered, and that question is **left open and stated as open**
rather than quietly assumed away.

If you fork this and point a large audience at it, the compliance posture
changes and the responsibility for that decision is yours: the honest options
are (a) keep it personal, (b) seek written authorization from MLBAM, or (c) use
a licensed data provider. Nothing in the code prevents any of those, and the
budget in §3 is a floor for good behaviour, not a licence.

## 7. How to check the claims in this document

```bash
grep -n "refillPerSec\|maxPerWindow\|burst" assets/js/api.js       # the budget itself
grep -n "POLL_MS\|SWEEP_MS" assets/js/*.js                         # every interval
node tests/latency-state-test.mjs                                  # §5 asserts ≤10 meta req/s
node tests/contract-check.mjs                                      # endpoint/field contracts
```

The latency suite asserts the slate-wide meta rate directly, so a future change
that quietly multiplies the request rate fails the build rather than shipping.

---

*Verified against the live API 2026-11-27. Data and marks © MLB Advanced Media /
MLB. This is an unofficial fan project, not affiliated with or endorsed by MLB.*
