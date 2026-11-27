/* ============================================================================
 * live-diff.js — per-game delta tracking over the official feed/live document.
 *
 * The StatsAPI publishes a per-game timecode log and an RFC 6902 patch
 * endpoint (the same delta mechanism the mlb.com Gameday client uses):
 *
 *   GET /api/v1.1/game/{gamePk}/feed/live/timestamps
 *       → ["20260828_154013", …]  (every time the game feed was revised)
 *   GET /api/v1.1/game/{gamePk}/feed/live/diffPatch?startTimecode=A&endTimecode=B
 *       → [{ "diff": [ RFC6902 ops ], … }]
 *
 * Applying those patches to a cached copy of the full feed yields the exact
 * same document linescore/play-by-play/review parsers already consume — at a
 * fraction of the bandwidth of refetching the feed (verified live
 * 2026-11-27: adjacent-pair patch returned ~20 KB vs. a multi-MB feed).
 *
 * Contract notes observed on the official endpoint (2026-11-27):
 *   - `diffPatch` with only startTimecode returned the FULL feed object,
 *     not a patch array — this module treats a non-array response that looks
 *     like a full feed as a full re-sync (that is what MLB does internally).
 *   - Patches contain `copy` operations whose `from` is any reachable JSON
 *     pointer — handled by json-patch.js.
 *   - Any patch failure keeps the old base intact and counts against the
 *     failure budget; `MAX_FAILURES` in a row disables the fast path for that
 *     game (standard polling continues — the alert pipeline never stalls).
 * ==========================================================================*/
(function (global) {
  'use strict';

  var JsonPatch = global.JsonPatch ||
    (typeof require === 'function' ? (function () { try { return require('./json-patch.js'); } catch (e) { return null; } })() : null);

  var MAX_FAILURES = 3;

  function create(gamePk) {
    return {
      gamePk: gamePk,
      base: null,          /* cached full feed document (never mutated in place) */
      timecode: null,      /* metaData.timeStamp of `base` */
      failures: 0,         /* consecutive patch failures */
      disabled: false,     /* fast path gave up → standard polling */
      disabledReason: '',
      syncs: 0,            /* full re-syncs this session */
      patchesApplied: 0,   /* successful patch applications */
      lastSyncAt: 0,
      lastPatchAt: 0,
    };
  }

  function isFullFeed(obj) {
    return !!(obj && typeof obj === 'object' && !Array.isArray(obj) && obj.gameData && obj.liveData);
  }

  /* The diffPatch response is an array of entries carrying `diff` op lists.
   * Concatenate them in order; empty entries are fine (no-ops). */
  function flattenPatchResponse(json) {
    if (!Array.isArray(json)) return null;
    var ops = [];
    for (var i = 0; i < json.length; i += 1) {
      var entry = json[i];
      if (!entry || !Array.isArray(entry.diff)) {
        /* A single malformed entry poisons the batch — resync instead. */
        return null;
      }
      for (var j = 0; j < entry.diff.length; j += 1) ops.push(entry.diff[j]);
    }
    return ops;
  }

  function timecodeOf(doc) {
    var ts = doc && doc.metaData && doc.metaData.timeStamp;
    return (typeof ts === 'string' && ts) ? ts : null;
  }

  /* Adopt a full feed as the new base (first sync, or MLB's own fallback). */
  function adoptFullFeed(tracker, feed, fallbackTimecode) {
    if (!isFullFeed(feed)) throw new Error('not a full feed document');
    tracker.base = feed;
    tracker.timecode = timecodeOf(feed) || fallbackTimecode || null;
    tracker.failures = 0;
    tracker.syncs += 1;
    tracker.lastSyncAt = Date.now();
    return tracker.base;
  }

  /**
   * applyPatch(tracker, patchResponse, expectedEndTimecode)
   *   patchResponse: raw JSON from diffPatch?startTimecode&endTimecode
   * Returns { doc, via } where via is 'diffPatch' (patched), 'full' (MLB
   * answered with a whole feed instead), or throws on an unrecoverable patch.
   * The previous base is left untouched on failure.
   */
  function applyPatch(tracker, patchResponse, expectedEndTimecode) {
    if (!tracker.base) throw new Error('applyPatch called before a base feed exists');
    var ops = flattenPatchResponse(patchResponse);
    if (ops === null) {
      if (isFullFeed(patchResponse)) {
        adoptFullFeed(tracker, patchResponse, expectedEndTimecode);
        return { doc: tracker.base, via: 'full' };
      }
      throw new Error('diffPatch returned an unrecognized response shape');
    }
    var clone = JSON.parse(JSON.stringify(tracker.base));
    JsonPatch.apply(clone, ops);
    var newTimecode = timecodeOf(clone) || expectedEndTimecode || tracker.timecode;
    tracker.base = clone;
    tracker.timecode = newTimecode;
    tracker.failures = 0;
    tracker.patchesApplied += 1;
    tracker.lastPatchAt = Date.now();
    return { doc: tracker.base, via: 'diffPatch', opCount: ops.length };
  }

  function noteFailure(tracker, err) {
    tracker.failures += 1;
    if (tracker.failures >= MAX_FAILURES) {
      tracker.disabled = true;
      tracker.disabledReason = (err && err.message) || String(err || 'unknown patch error');
    }
    return tracker.failures;
  }

  function resetFailures(tracker) {
    tracker.failures = 0;
  }

  var api = {
    MAX_FAILURES: MAX_FAILURES,
    create: create,
    isFullFeed: isFullFeed,
    flattenPatchResponse: flattenPatchResponse,
    timecodeOf: timecodeOf,
    adoptFullFeed: adoptFullFeed,
    applyPatch: applyPatch,
    noteFailure: noteFailure,
    resetFailures: resetFailures,
  };

  var root = (typeof window !== 'undefined' && window) || (typeof globalThis !== 'undefined' && globalThis) || global;
  root.LiveDiff = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window !== 'undefined' ? window : globalThis));
