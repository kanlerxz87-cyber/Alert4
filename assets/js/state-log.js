/* ============================================================================
 * state-log.js — persistence for the GAME-STATE timeline captured by the
 * replay feed (score, count, outs, runners, pitcher, batter — per official
 * payload, timestamped to the second).
 *
 * Separate namespace from the alert pipeline (feed-log.js) and from the
 * scoring monitor (scoring-log.js):
 *   - localStorage keys:  mlbp.statelog.<date> / mlbp.statelog.index
 *   - server endpoints:   /api/state-log  (GET/POST) · /api/state-log/stream (SSE)
 *   - server files:       data/state-log-<date>.json
 * Max 2000 rows per date (pitch-level rows are voluminous), 7 dates kept.
 * ==========================================================================*/
(function (global) {
  'use strict';
  global.StateLog = global.PersistentLog.create({
    globalName: 'state',
    keyPrefix: 'mlbp.statelog.',
    indexKey: 'mlbp.statelog.index',
    endpoint: '/api/state-log',
    maxEntries: 2000,
    keepDates: 7,
  });
}(window));
