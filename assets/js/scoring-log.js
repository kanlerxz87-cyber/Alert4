/* ============================================================================
 * scoring-log.js — persistent, separate log for official scoring pending
 * and official scoring changes.
 *
 * This is intentionally a SEPARATE system from the alert feed and from the
 * alert sound:
 *   - It owns its own localStorage keys (mlbp.scoringlog.<date>) and its
 *     own server endpoints (/api/scoring-log), so a refresh, a new browser
 *     tab, or a server restart restores the scoring record without touching
 *     the alert system.
 *   - It never plays sound, never shows desktop notifications, and never
 *     depends on AlertSound. The replay feed calls ScoringLog.append()
 *     alongside (not through) the alert bridge; if this module fails, the
 *     alert still fires, and if the alert is muted the log still records.
 *   - Entries are captured in real time from the official MLB StatsAPI
 *     payload (playByPlay `result.eventType` / `result.description` /
 *     `result.isOut` / `count.outs` / `runners[]` error movements, plus
 *     the API's own `os_ruling_pending_*` event types) and diffed between
 *     polls — the payload carries no scoring-change marker, so the initial
 *     call and the final ruling are known only from consecutive
 *     observations. Each entry keeps the exact official wording before
 *     and after, timestamped down to the second.
 *
 * Persistence layers (both idempotent, merged on load):
 *   1. localStorage — always available (GitHub Pages), one log per date.
 *   2. server store — optional POST/GET /api/scoring-log (server.mjs),
 *      with a server-sent-event stream for cross-browser live updates.
 *      On static hosting the endpoints do not exist and the page keeps
 *      working from localStorage alone.
 *
 * Export: JSON (full fidelity) and CSV (spreadsheet-friendly) so the log
 * can be reviewed offline after a refresh or after the season.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var KEY_PREFIX = 'mlbp.scoringlog.';
  var INDEX_KEY = 'mlbp.scoringlog.index';
  var KEEP_DATES = 30;
  var MAX_ENTRIES = 1000;
  var WRITE_COALESCE_MS = 1000;

  var apiState = { checked: false, available: false, lastError: null };
  var saveTimers = Object.create(null);
  var pendingPayloads = Object.create(null);
  var listeners = [];
  var stream = null;

  function emptyPayload(date) {
    return {
      v: 1,
      date: date,
      savedAt: Date.now(),
      entries: [],
      order: [],
    };
  }

  function storageGet(key) {
    try { return global.localStorage.getItem(key); } catch (e) { return null; }
  }
  function storageSet(key, value) {
    try { global.localStorage.setItem(key, value); return true; } catch (e) { return false; }
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

  function normalize(payload, date) {
    if (!payload || typeof payload !== 'object') return emptyPayload(date);
    return {
      v: 1,
      date: date,
      savedAt: Number(payload.savedAt) || Date.now(),
      entries: Array.isArray(payload.entries) ? payload.entries.filter(Boolean) : [],
      order: Array.isArray(payload.order) ? payload.order.slice() : [],
    };
  }

  function entryKey(entry) {
    if (!entry) return null;
    if (entry.id !== undefined && entry.id !== null && entry.id !== '') return String(entry.id);
    return null;
  }

  function mergePayloads(a, b, date) {
    var base = normalize(a, date);
    var add = normalize(b, date);
    var map = Object.create(null);
    var order = [];

    function take(entry) {
      var key = entryKey(entry);
      if (!key) return;
      var prev = map[key];
      if (!prev) {
        map[key] = entry;
        order.push(key);
        return;
      }
      /* Prefer the entry with the later observedMs; keep the earliest
       * firstSeen so the log shows when the ruling was first observed. */
      var merged = Object.assign({}, prev, entry);
      merged.firstSeen = Math.min(
        Number(prev.firstSeen) || Number(entry.firstSeen) || Date.now(),
        Number(entry.firstSeen) || Number(prev.firstSeen) || Date.now()
      );
      merged.lastSeen = Math.max(Number(prev.lastSeen) || 0, Number(entry.lastSeen) || 0);
      map[key] = merged;
    }

    base.entries.forEach(take);
    add.entries.forEach(take);

    var mergedEntries = order.map(function (k) { return map[k]; })
      .sort(function (x, y) { return (Number(y.observedMs) || 0) - (Number(x.observedMs) || 0); })
      .slice(0, MAX_ENTRIES);

    return {
      v: 1,
      date: date,
      savedAt: Date.now(),
      entries: mergedEntries,
      order: mergedEntries.map(entryKey),
    };
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
    if (apiState.checked && !apiState.available) return Promise.resolve(null);
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
      if (!local) {
        saveLocal(date, remote);
        return remote;
      }
      var merged = mergePayloads(remote, local, date);
      saveLocal(date, merged);
      return merged;
    });
  }

  function postNow(date) {
    var payload = pendingPayloads[date];
    if (!payload) return Promise.resolve(null);
    pendingPayloads[date] = null;
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

  function save(date, payload) {
    var normalized = normalize(payload, date);
    saveLocal(date, normalized);
    pendingPayloads[date] = normalized;
    if (saveTimers[date]) return;
    saveTimers[date] = setTimeout(function () {
      saveTimers[date] = null;
      postNow(date);
    }, WRITE_COALESCE_MS);
  }

  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  }

  function emit(payload) {
    listeners.forEach(function (fn) {
      try { fn(payload); } catch (e) { global.console && global.console.warn && global.console.warn('[scoring-log] listener failed', e); }
    });
  }

  function openStream(date) {
    if (typeof global.EventSource !== 'function') return null;
    if (apiState.checked && !apiState.available) return null;
    try {
      stream = new global.EventSource('/api/scoring-log/stream?date=' + encodeURIComponent(date));
    } catch (e) {
      return null;
    }
    stream.addEventListener('scoring-log', function (evt) {
      try {
        var payload = JSON.parse(evt.data);
        apiState.available = true;
        emit(normalize(payload, date));
      } catch (e) {
        global.console && global.console.warn && global.console.warn('[scoring-log] ignoring malformed push frame');
      }
    });
    stream.addEventListener('error', function () {
      apiState.available = false;
    });
    return stream;
  }

  function closeStream() {
    if (stream) {
      try { stream.close(); } catch (e) { /* ignore */ }
      stream = null;
    }
  }

  /* --------------------------------------------------------------- export */

  function toCSV(payload) {
    var rows = normalize(payload, payload && payload.date).entries;
    function cell(v) {
      var s = v === undefined || v === null ? '' : String(v);
      return '"' + s.replace(/"/g, '""') + '"';
    }
    var header = ['id', 'kind', 'gamePk', 'matchup', 'observedAt', 'observedAtSec', 'inning', 'batter', 'pitcher',
      'eventTypeBefore', 'eventTypeAfter', 'descriptionBefore', 'descriptionAfter',
      'scoreBefore', 'scoreAfter', 'source'];
    var lines = [header.join(',')];
    rows.forEach(function (e) {
      var before = e.before || {};
      var after = e.after || {};
      lines.push([
        e.id, e.kind, e.gamePk, e.matchupLabel, e.observedAt, e.observedAtSec, e.inningLabel,
        e.batter, e.pitcher,
        before.eventType || '', after.eventType || '',
        before.description || e.descriptionBefore || '',
        after.description || e.descriptionAfter || '',
        before.score ? before.score.away + '-' + before.score.home : '',
        after.score ? after.score.away + '-' + after.score.home : '',
        e.source || '',
      ].map(cell).join(','));
    });
    return lines.join('\n');
  }

  function download(filename, text, mime) {
    try {
      var blob = new Blob([text], { type: mime || 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        try { document.body.removeChild(a); } catch (e) { /* ignore */ }
        try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
      }, 500);
    } catch (e) {
      global.console && global.console.warn && global.console.warn('[scoring-log] export failed', e);
    }
  }

  function exportJSON(payload) {
    var p = normalize(payload, payload && payload.date);
    download('scoring-log-' + p.date + '.json', JSON.stringify(p, null, 2), 'application/json');
  }

  function exportCSV(payload) {
    var p = normalize(payload, payload && payload.date);
    download('scoring-log-' + p.date + '.csv', toCSV(p), 'text/csv');
  }

  function clear(date) {
    try { global.localStorage.removeItem(KEY_PREFIX + date); } catch (e) { /* ignore */ }
    var index = readIndex().filter(function (d) { return d !== date; });
    try { storageSet(INDEX_KEY, JSON.stringify(index)); } catch (e) { /* ignore */ }
    return emptyPayload(date);
  }

  global.ScoringLog = {
    emptyPayload: emptyPayload,
    normalize: normalize,
    mergePayloads: mergePayloads,
    load: load,
    save: save,
    onChange: onChange,
    openStream: openStream,
    closeStream: closeStream,
    entryKey: entryKey,
    toCSV: toCSV,
    exportJSON: exportJSON,
    exportCSV: exportCSV,
    clear: clear,
    state: apiState,
    MAX_ENTRIES: MAX_ENTRIES,
    KEEP_DATES: KEEP_DATES,
  };
}(window));
