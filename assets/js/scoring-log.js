/* ============================================================================
 * scoring-log.js — the official-scoring log (kept deliberately separate)
 *
 * This store holds ONLY the two official-scoring signals, and nothing else:
 *
 *   1. `pending` — an at-bat the official scorer has not ruled on yet
 *      (`result.eventType` = os_ruling_pending_primary / os_ruling_pending_prior,
 *      official wording "Official Scorer Ruling Pending")
 *   2. `change`  — a play whose official scoring outcome was reclassified after
 *      the fact (hit ↔ error, out ↔ hit, single ↔ double, …)
 *
 * It is a SEPARATE persistence channel from the Replay Feed's own log:
 *   - localStorage: `mlbp.scoringlog.<YYYY-MM-DD>` (index `mlbp.scoringlog.index`)
 *   - server:       GET/POST `/api/scoring-log` → `data/scoring-log-<date>.json`
 * so a scoring-log write can never fail, block, reset or re-render the alert
 * feed, and clearing one store leaves the other intact.  Nothing in this file
 * plays a sound, opens a notification or touches the alert pipeline — that is
 * the isolation the Replay Feed relies on.
 *
 * Every record is written the moment it is observed, with
 *   at / atIso / atClock  — second-precision observation time
 *   wordingBefore/After   — the exact official wording before and after
 *   officialBefore/After  — eventType, description, outs, RBI, score
 *   stateBefore/After     — the live-state snapshot (score, outs, count,
 *                           pitcher, batter, pitch count) at each observation
 * and is merged idempotently by id, so a refresh, a second tab or the server
 * round-trip can never duplicate or reorder it.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var KEY_PREFIX = 'mlbp.scoringlog.';
  var INDEX_KEY = 'mlbp.scoringlog.index';
  var KEEP_DATES = 14;
  var MAX_RECORDS = 2000;
  var WRITE_COALESCE_MS = 1000;

  var apiState = { checked: false, available: false, lastError: null };
  var saveTimer = null;
  var pendingPayload = null;
  var listeners = [];

  function now() { return Date.now(); }

  function storageGet(key) { try { return global.localStorage.getItem(key); } catch (e) { return null; } }
  function storageSet(key, value) { try { global.localStorage.setItem(key, value); return true; } catch (e) { return false; } }

  function emptyPayload(date) {
    return { v: 1, date: date, savedAt: now(), records: [] };
  }

  function normalize(payload, date) {
    if (!payload || typeof payload !== 'object') return emptyPayload(date);
    var records = Array.isArray(payload.records) ? payload.records.filter(function (r) {
      return r && r.id;
    }) : [];
    return {
      v: 1,
      date: date,
      savedAt: Number(payload.savedAt) || now(),
      records: records,
    };
  }

  function readIndex() {
    try {
      var raw = storageGet(INDEX_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
  }

  function writeIndex(dates) {
    var sorted = dates.slice().sort();
    while (sorted.length > KEEP_DATES) {
      var drop = sorted.shift();
      try { global.localStorage.removeItem(KEY_PREFIX + drop); } catch (e) { /* ignore */ }
    }
    storageSet(INDEX_KEY, JSON.stringify(sorted));
  }

  /**
   * mergeRecords(current, incoming) — idempotent, order-preserving.
   * The first observation wins "before" data; the newest observation wins
   * "after" data and status.  A record is never deleted or rewritten.
   */
  function mergeRecords(current, incoming) {
    var map = Object.create(null);
    var order = [];
    function take(rec) {
      if (!rec || !rec.id) return;
      var key = String(rec.id);
      var prev = map[key];
      if (!prev) {
        map[key] = Object.assign({}, rec);
        order.push(key);
        return;
      }
      var merged = Object.assign({}, prev, rec);
      merged.at = Math.min(Number(prev.at) || Number(rec.at) || now(), Number(rec.at) || now());
      merged.firstSeen = Math.min(Number(prev.firstSeen) || Number(rec.firstSeen) || now(),
        Number(rec.firstSeen) || now());
      merged.lastSeen = Math.max(Number(prev.lastSeen) || 0, Number(rec.lastSeen) || 0, now());
      /* Never overwrite an observed "before" with a later guess. */
      merged.wordingBefore = prev.wordingBefore || rec.wordingBefore || '';
      merged.officialBefore = prev.officialBefore || rec.officialBefore || null;
      merged.stateBefore = prev.stateBefore || rec.stateBefore || null;
      merged.wordingAfter = rec.wordingAfter || prev.wordingAfter || '';
      merged.officialAfter = rec.officialAfter || prev.officialAfter || null;
      merged.stateAfter = rec.stateAfter || prev.stateAfter || null;
      merged.status = rec.status || prev.status || 'open';
      map[key] = merged;
    }
    (current || []).forEach(take);
    (incoming || []).forEach(take);
    var records = order.map(function (k) { return map[k]; })
      .sort(function (a, b) { return (Number(a.at) || 0) - (Number(b.at) || 0); });
    if (records.length > MAX_RECORDS) records = records.slice(records.length - MAX_RECORDS);
    return records;
  }

  function loadLocal(date) {
    var raw = storageGet(KEY_PREFIX + date);
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || parsed.v !== 1) return null;
      return normalize(parsed, date);
    } catch (e) {
      global.console && global.console.warn && global.console.warn('[scoring-log] dropping malformed local log for ' + date);
      return null;
    }
  }

  function saveLocal(date, payload) {
    var ok = storageSet(KEY_PREFIX + date, JSON.stringify(payload));
    if (ok) {
      var index = readIndex();
      if (index.indexOf(date) === -1) index.push(date);
      writeIndex(index);
    }
    return ok;
  }

  function isStaticHost() {
    var host = (global.location && global.location.hostname) || '';
    return /\.github\.io$/i.test(host);
  }

  function serverFetch(path, opts) {
    return fetch(path, Object.assign({ cache: 'no-store', credentials: 'same-origin' }, opts || {}))
      .then(function (res) {
        if (!res.ok) {
          var err = new Error('HTTP ' + res.status);
          err.status = res.status;
          throw err;
        }
        return res.json();
      });
  }

  function loadServer(date) {
    if (isStaticHost()) {
      apiState.checked = true;
      apiState.available = false;
      return Promise.resolve(null);
    }
    return serverFetch('/api/scoring-log?date=' + encodeURIComponent(date))
      .then(function (data) {
        apiState.checked = true;
        apiState.available = true;
        return normalize(data, date);
      })
      .catch(function (err) {
        apiState.checked = true;
        apiState.available = false;
        apiState.lastError = err;
        return null;
      });
  }

  function load(date) {
    var local = loadLocal(date);
    return loadServer(date).then(function (remote) {
      if (!remote && !local) return emptyPayload(date);
      if (!remote) return local;
      if (!local) { saveLocal(date, remote); return remote; }
      var merged = normalize({ records: mergeRecords(remote.records, local.records), savedAt: now() }, date);
      saveLocal(date, merged);
      return merged;
    });
  }

  function postNow() {
    var payload = pendingPayload;
    if (!payload) return Promise.resolve(null);
    pendingPayload = null;
    if (apiState.checked && !apiState.available) return Promise.resolve(null);
    return serverFetch('/api/scoring-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (res) {
      apiState.available = true;
      return res;
    }).catch(function (err) {
      apiState.available = false;
      apiState.lastError = err;
      return null;
    });
  }

  function emit(payload) {
    listeners.forEach(function (fn) {
      try { fn(payload); } catch (e) { global.console && global.console.warn && global.console.warn('[scoring-log] listener failed', e); }
    });
  }

  /**
   * record(date, records) — synchronous local persist + coalesced server write.
   * Returns the merged payload so the caller can re-render from it.  Called by
   * the Replay Feed AFTER the alert path has already completed; any throw here
   * is caught by the caller so the feed is never disrupted.
   */
  function record(date, records) {
    var current = loadLocal(date) || emptyPayload(date);
    var merged = normalize({
      records: mergeRecords(current.records, records || []),
      savedAt: now(),
    }, date);
    saveLocal(date, merged);
    pendingPayload = merged;
    if (!saveTimer) {
      saveTimer = setTimeout(function () {
        saveTimer = null;
        postNow();
      }, WRITE_COALESCE_MS);
    }
    emit(merged);
    return merged;
  }

  function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }

  /** Newest-first view grouped for the page: { pending: [], changes: [] }. */
  function split(payload) {
    var pending = [];
    var changes = [];
    ((payload && payload.records) || []).forEach(function (r) {
      if (!r) return;
      if (r.kind === 'pending') pending.push(r);
      else if (r.kind === 'change') changes.push(r);
    });
    pending.sort(function (a, b) { return (Number(b.at) || 0) - (Number(a.at) || 0); });
    changes.sort(function (a, b) { return (Number(b.at) || 0) - (Number(a.at) || 0); });
    return { pending: pending, changes: changes };
  }

  global.ScoringLog = {
    emptyPayload: emptyPayload,
    normalize: normalize,
    mergeRecords: mergeRecords,
    load: load,
    record: record,
    split: split,
    onChange: onChange,
    state: apiState,
    MAX_RECORDS: MAX_RECORDS,
    KEEP_DATES: KEEP_DATES,
  };
}(window));
