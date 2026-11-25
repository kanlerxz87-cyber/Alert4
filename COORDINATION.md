# COORDINATION.md — Alert4 (LIVPBP copy)

Shared task board for parallel agent sessions. Read before starting work. Claim tasks by writing your session ID and file scope, then commit and push the claim immediately.

## Status values
- `unclaimed`
- `in_progress`
- `done`
- `needs_review` (published on Flagged for Review page; does not block merge)

## Tasks

| Task | Status | Session | Scope (files/dirs) | Notes |
|------|--------|---------|--------------------|-------|
| Copy LIVPBP reference repo into Alert4 and verify site builds/runs | done | 076871a5 | `/` (full repo copy, excluding .git) | Copied from https://github.com/snapquast73-boop/LIVPBP `main@5c02527d3c7a56ea66c698cfabff80a407b6dfd3`. |

## Log

### 2026-11-25T20:40Z — session 076871a5
- Claimed: "Copy LIVPBP reference repo into Alert4 and verify site builds/runs".
- Scope: full repository contents (copy from reference repo).
- Plan: clone reference repo, copy files into Alert4, verify structure/tests/build, create PR, merge, confirm Pages deploy.

### 2026-11-25 — session 076871a5 (completion)
- **Source copied:** https://github.com/snapquast73-boop/LIVPBP (default branch `main`, commit `5c02527d3c7a56ea66c698cfabff80a407b6dfd3`).
- **Reference live site:** https://snapquast73-boop.github.io/LIVPBP/reviews.html?date=2026-08-26
- **Actions:**
  - Cloned reference repo (depth 1) and copied all files into Alert4 (excluding `.git`); preserved our repo-local COORDINATION.md.
  - Repo-local adaptations required for Alert4 deployment (recorded, no data fabrication):
    - `404.html`: base-href detection changed from `/LIVPBP/` to `/Alert4/` so GitHub Pages subpath works in this repo.
    - `package.json`: `homepage` updated to `https://kanlerxz87-cyber.github.io/Alert4/`.
    - `tests/jsdom-render-test.mjs`, `tests/props-provenance-test.mjs`: test URL base updated to Alert4 Pages URL (test logic unchanged).
    - `README.md`: added copy note and this-copy/upstream live demo links; historical audit/verification docs retain upstream provenance links.
- **Verification performed:**
  - `node tools/restoration-check.mjs` — ALL CHECKS PASSED (file refs, JS parse, server endpoints/static serving, .git/HEAD blocked, atBatIndex 0 merge preserved).
  - `node tools/smoke-test.mjs` (`npm test`) — **64 passed, 0 failed** (fixtures from official StatsAPI responses per repo tests; includes feed-log merge semantics, static asset integrity, deep-link/date handling, ABS/review parity checks).
  - `node tests/run-all.mjs` — PASS syntax, PASS link-check (41 local refs), PASS contract-check (8 bindings), PASS jsdom-render-test (47 checks).
  - Local server smoke: `node server.mjs` on port 8000 returned 200 for `/`, `/index.html`, `/reviews.html`, `/game.html`, `/flagged.html`, `/assets/js/reviews-feed.js`; `reviews.html` contained expected UI IDs (`date-picker`, `feed-list`, `feed-tabs`, `active-strip`, etc.).
- **Official sources used by the app (as copied from upstream):** MLB StatsAPI endpoints under `https://statsapi.mlb.com/api/` (see `docs/statsapi-field-map.md`, `docs/verification-report.md`, and `flagged.html` in repo for upstream-verified mappings/provenance). No MLB data values were invented in this session.
- **Irregularities / flags:** None introduced by this copy. Existing upstream flagged/unverified items remain published on `flagged.html` per upstream audit; they do not block merge.
- **PR / merge / Pages:** to be recorded after PR creation, merge, and Pages deploy verification.
