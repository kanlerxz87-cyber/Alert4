/* ============================================================================
 * scoring-log.js — persistence for the OFFICIAL SCORING MONITOR.
 *
 * Separate namespace from the alert pipeline (feed-log.js) on purpose:
 *   - localStorage keys:  mlbp.scoringlog.<date> / mlbp.scoringlog.index
 *   - server endpoints:   /api/scoring-log  (GET/POST) · /api/scoring-log/stream (SSE)
 *   - server files:       data/scoring-log-<date>.json
 *
 * Logs every observed official-scoring event for a date: pending rulings
 * (unscored at bats), resolutions, and official scoring changes — each with
 * the exact official wording before and after, timestamped to the second.
 * Never feeds, chimes, or blocks the alert system.
 * ==========================================================================*/
(function (global) {
  'use strict';
  global.ScoringLog = global.PersistentLog.create({
    globalName: 'scoring',
    keyPrefix: 'mlbp.scoringlog.',
    indexKey: 'mlbp.scoringlog.index',
    endpoint: '/api/scoring-log',
    maxEntries: 500,
    keepDates: 14,
  });
}(window));
