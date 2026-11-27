/* ============================================================================
 * state-log.js — persistent OFFICIAL LIVE GAME STATE log
 *
 * WHAT IT STORES (per date, append-only, newest kept)
 *   · `events`        every captured change with the exact official wording
 *                     before and after, MLB's own feed revision timecode
 *                     (YYYYMMDD_HHMMSS UTC) AND our observation time to the
 *                     second: status, inning, score, outs, runners, pitching
 *                     changes, plate-appearance starts/ends, count, review
 *                     state, challenge counters, pitch counts.
 *   · `atBats`        the last captured state of each plate appearance, so the
 *                     log can answer "what did this at-bat look like before
 *                     the scoring decision?".
 *   · `snapshots`     the latest captured official state per game.
 *
 * WHY IT IS SEPARATE FROM THE ALERT SYSTEM
 *   The Replay Feed's alert path (reviews-feed.js + Reviews parser) decides
 *   what chimes.  This module never chimes and never reads that path: it only
 *   records.  A bug or a slow write here cannot silence or delay an alert, and
 *   clearing/editing the log cannot change what the feed alerts on.  The two
 *   share the persistence transport (FeedLog / server.mjs) but not the data.
 *
 * PERSISTENCE ACROSS REFRESHES
 *   Two identical layers, learned from feed-log.js:
 *     1. localStorage  — always; one key per date, survives refresh and
 *        restart, capped at KEEP_DATES dates.
 *     2. server store  — optional POST/GET /api/state-log (server.mjs), which
 *        survives even a cleared browser profile and merges concurrent writes
 *        by event id.  On static GitHub Pages the endpoints do not exist and
 *        every request fails quietly: the localStorage layer is the log.
 *   Both layers are idempotent by event id, so writing the same event twice
 *   (two tabs, a retry, a page restored from disk) is a no-op.
 *
 * SIZE CONTROL
 *   The event list is capped (EVENT_CAP) and the stored payload is trimmed if
 *   a write would exceed LOCAL_BUDGET_CHARS (localStorage is ~5 MB per origin
 *   and the log shares it with the feed log).  Trimming drops the oldest
 *   *routine* rows first (count/pitch-count/state rows) and keeps every
 *   review/scoring/score row, so the expensive-to-reconstruct events survive.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var VERSION = 1;
  var KEY_PREFIX = 'mlbp.statelog.';
  var INDEX_KEY = 'mlbp.statelog.index';
  var KEEP_DATES = 14;
  var EVENT_CAP = 600;
  var ATBAT_CAP = 300;
  var LOCAL_BUDGET_CHARS = 1600000;
  var WRITE_COALESCE_MS = 1200;

  /* Row kinds that must never be trimmed while a routine row exists. */
  var KEEP_KINDS = {
    review_open: 1, review_update: 1, scoring_change: 1, score: 1, status: 1,
    state_initial: 1, atbat_complete: 1, pitching_change: 1,
  };

  var apiState = { checked: false, available: false, lastError: null };
  var saveTimers = Object.create(null);
  var pending = Object.create(null);
  var listeners = [];

  function now() { return Date.now(); }

  function storageGet(key) {
    try { return global.localStorage.getItem(key); } catch (e) { return null; }
  }
  function storageSet(key, value) {
    try { global.localStorage.setItem(key, value); return true; } catch (e) { return false; }
  }

  function emptyPayload(date) {
    return {
      v: VERSION,
      date: date,
      savedAt: now(),
      events: [],
      atBats: [],
      snapshots: {},
      trimmed: 0,
    };
  }

  /* A row that came off disk (or out of a server snapshot) was observed
   * earlier; the flag travels WITH the row so a restored log can never
   * re-fire an alert.  `restored` is sticky once set. */
  function markRestored(list, flag) {
    if (!Array.isArray(list)) return [];
    return list.filter(Boolean).map(function (e) {
      if (!e || typeof e !== 'object') return e;
      if (e.restored === undefined) e.restored = flag;
      return e;
    });
  }

  function normalize(payload, date) {
    if (!payload || typeof payload !== 'object') return emptyPayload(date);
    return {
      v: VERSION,
      date: date,
      savedAt: Number(payload.savedAt) || now(),
      events: markRestored(payload.events, true),
      atBats: markRestored(payload.atBats, true),
      snapshots: (payload.snapshots && typeof payload.snapshots === 'object') ? payload.snapshots : {},
      trimmed: Number(payload.trimmed) || 0,
    };
  }

  function readIndex() {
    try {
      var parsed = JSON.parse(storageGet(INDEX_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
  }

  function writeIndex(dates) {
    var sorted = dates.slice().sort();
    while (sorted.length > KEEP_DATES) {
      var drop = sorted.shift();
      try { global.localStorage.removeItem(KEY_PREFIX + drop); } catch (e) { /* ignore */ }
      try { global.localStorage.removeItem(KEY_PREFIX + drop + '.scoring'); } catch (e) { /* ignore */ }
    }
    storageSet(INDEX_KEY, JSON.stringify(sorted));
  }

  function loadLocal(date) {
    var raw = storageGet(KEY_PREFIX + date);
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || parsed.v !== VERSION) return null;
      return normalize(parsed, date);
    } catch (e) {
      if (global.console && global.console.warn) {
        global.console.warn('[state-log] dropping malformed local log for ' + date);
      }
      return null;
    }
  }

  /**
   * trim(payload)
   *   Keep the newest rows, but only trim routine kinds while protected kinds
   *   remain under their own share; drop oldest first.  Also shrink the stored
   *   payload until it fits the local budget (largest fields first: snapshots).
   */
  function trim(payload) {
    var date = (payload && payload.date) || undefined;
    var p = normalize(JSON.parse(JSON.stringify(payload)), date);
    p.date = date;
    if (p.events.length > EVENT_CAP) {
      var overflow = p.events.length - EVENT_CAP;
      var kept = [];
      var dropped = 0;
      for (var i = 0; i < p.events.length; i += 1) {
        var e = p.events[i];
        var routine = !KEEP_KINDS[e.kind];
        if (dropped < overflow && routine) { dropped += 1; continue; }
        kept.push(e);
      }
      /* If still over, drop the oldest regardless of kind. */
      if (kept.length > EVENT_CAP) kept = kept.slice(kept.length - EVENT_CAP);
      p.trimmed += p.events.length - kept.length;
      p.events = kept;
    }
    if (p.atBats.length > ATBAT_CAP) p.atBats = p.atBats.slice(p.atBats.length - ATBAT_CAP);

    var size = JSON.stringify(p).length;
    if (size > LOCAL_BUDGET_CHARS) {
      /* Drop the per-game snapshot bodies first, then oldest routine rows. */
      p.snapshots = {};
      size = JSON.stringify(p).length;
      while (size > LOCAL_BUDGET_CHARS && p.events.length > 40) {
        var removeAt = -1;
        for (var j = 0; j < p.events.length; j += 1) {
          if (!KEEP_KINDS[p.events[j].kind]) { removeAt = j; break; }
        }
        if (removeAt === -1) break;
        p.events.splice(removeAt, 1);
        p.trimmed += 1;
        size = JSON.stringify(p).length;
      }
    }
    return p;
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

  /* --------------------------------------------------------------- server */

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

  function isStaticHost() {
    var host = (global.location && global.location.hostname) || '';
    return /\.github\.io$/i.test(host);
  }

  function loadServer(date) {
    if (isStaticHost()) {
      apiState.checked = true;
      apiState.available = false;
      return Promise.resolve(null);
    }
    return serverFetch('/api/state-log?date=' + encodeURIComponent(date))
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

  /**
   * mergePayloads(a, b)
   *   Idempotent union by event id, newest per id wins on the *content* (so a
   *   status row observed first as "open" and later as "resolved" keeps the
   *   resolved copy) while the first `observedAt` is preserved.
   */
  function mergePayloads(a, b, date) {
    var base = normalize(a, date);
    var add = normalize(b, date);
    var map = Object.create(null);
    var order = [];
    function take(e) {
      if (!e || !e.id) return;
      var id = String(e.id);
      var prev = map[id];
      if (!prev) { map[id] = e; order.push(id); return; }
      var merged = Object.assign({}, prev, e);
      merged.restored = prev.restored === true || e.restored === true;
      merged.observedAt = prev.observedAt || e.observedAt;
      merged.observedMs = Math.min(Number(prev.observedMs) || Number(e.observedMs) || now(),
        Number(e.observedMs) || Number(prev.observedMs) || now());
      map[id] = merged;
    }
    base.events.forEach(take);
    add.events.forEach(take);

    var atBatMap = Object.create(null);
    base.atBats.concat(add.atBats).forEach(function (row) {
      if (!row || row.key === undefined) return;
      atBatMap[row.key] = Object.assign({}, atBatMap[row.key] || {}, row);
    });

    var snapshots = Object.assign({}, base.snapshots, add.snapshots);
    var events = order.map(function (id) { return map[id]; });
    events.sort(function (x, y) { return (Number(x.observedMs) || 0) - (Number(y.observedMs) || 0); });

    return trim({
      v: VERSION,
      date: date,
      savedAt: now(),
      events: events,
      atBats: Object.keys(atBatMap).map(function (k) { return atBatMap[k]; }),
      snapshots: snapshots,
      trimmed: base.trimmed + add.trimmed,
    });
  }

  function load(date) {
    var local = loadLocal(date);
    return loadServer(date).then(function (remote) {
      if (!remote && !local) return emptyPayload(date);
      if (!remote) return local;
      if (!local) { saveLocal(date, remote); return remote; }
      var merged = mergePayloads(remote, local, date);
      saveLocal(date, merged);
      return merged;
    });
  }

  function postNow(date) {
    var payload = pending[date];
    if (!payload) return Promise.resolve(null);
    pending[date] = null;
    if (apiState.checked && !apiState.available) return Promise.resolve(null);
    return serverFetch('/api/state-log', {
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

  function save(date, payload) {
    var normalized = trim(payload);
    saveLocal(date, normalized);
    pending[date] = normalized;
    if (saveTimers[date]) return;
    saveTimers[date] = setTimeout(function () {
      saveTimers[date] = null;
      postNow(date);
    }, WRITE_COALESCE_MS);
  }

  /** Flush a pending write immediately (used on page hide / unload). */
  function flush(date) {
    if (saveTimers[date]) {
      clearTimeout(saveTimers[date]);
      saveTimers[date] = null;
    }
    return postNow(date);
  }

  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  }

  function emit(payload) {
    listeners.forEach(function (fn) {
      try { fn(payload); } catch (e) {
        if (global.console && global.console.warn) {
          global.console.warn('[state-log] listener failed', e);
        }
      }
    });
  }

  var stream = null;

  function openStream(date) {
    if (typeof global.EventSource !== 'function') return null;
    if (isStaticHost()) return null;
    try {
      stream = new global.EventSource('/api/state-log/stream?date=' + encodeURIComponent(date));
    } catch (e) { return null; }
    stream.addEventListener('state-log', function (evt) {
      try {
        var payload = JSON.parse(evt.data);
        apiState.available = true;
        emit(normalize(payload, date));
      } catch (e) {
        if (global.console && global.console.warn) {
          global.console.warn('[state-log] ignoring malformed push frame');
        }
      }
    });
    stream.addEventListener('error', function () { apiState.available = false; });
    return stream;
  }

  function closeStream() {
    if (stream) {
      try { stream.close(); } catch (e) { /* ignore */ }
      stream = null;
    }
  }

  /* ------------------------------------------------------------- selection */

  /** Newest-first rows that matter for the scoring section. */
  function scoringRows(payload) {
    if (!payload || !Array.isArray(payload.events)) return [];
    return payload.events.filter(function (e) {
      return e && (e.kind === 'scoring_change' || e.kind === 'scoring_pending' ||
        e.kind === 'review_open' || e.kind === 'review_update');
    }).slice().reverse();
  }

  global.StateLog = {
    VERSION: VERSION,
    EVENT_CAP: EVENT_CAP,
    KEEP_DATES: KEEP_DATES,
    emptyPayload: emptyPayload,
    normalize: normalize,
    loadLocal: loadLocal,
    markRestored: markRestored,
    mergePayloads: mergePayloads,
    trim: trim,
    load: load,
    save: save,
    flush: flush,
    onChange: onChange,
    openStream: openStream,
    closeStream: closeStream,
    scoringRows: scoringRows,
    state: apiState,
  };
}(window));
