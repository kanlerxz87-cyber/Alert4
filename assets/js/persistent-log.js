/* ============================================================================
 * persistent-log.js — small factory for namespaced persistent event logs.
 *
 * One instance per log (see state-log.js / scoring-log.js). Each keeps:
 *   1. localStorage always — one log per date, newest KEEP_DATES dates kept,
 *      capped at maxEntries rows per date (newest first).
 *   2. server.mjs store — GET/POST + SSE stream at a dedicated endpoint pair.
 *      Absent on static hosting (GitHub Pages): requests fail quietly and the
 *      page keeps working from localStorage — the documented degradation.
 *
 * Deliberately independent of feed-log.js: changes here cannot affect the
 * alert persistence used by the Replay Feed / scoreboard.
 * ==========================================================================*/
(function (global) {
  'use strict';

  function create(config) {
    var KEY_PREFIX = config.keyPrefix;
    var INDEX_KEY = config.indexKey;
    var ENDPOINT = config.endpoint;         /* e.g. '/api/state-log' */
    var STREAM = ENDPOINT + '/stream';
    var MAX_ENTRIES = config.maxEntries || 500;
    var KEEP_DATES = config.keepDates || 7;
    var WRITE_COALESCE_MS = 1000;

    var apiState = { checked: false, available: false, lastError: null };
    var saveTimer = null;
    var pendingPayload = null;
    var listeners = [];
    var stream = null;

    function now() { return Date.now(); }

    function emptyPayload(date) {
      return { v: 1, date: date, savedAt: now(), entries: [] };
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

    function entryKey(entry) {
      if (!entry) return null;
      if (entry.id !== undefined && entry.id !== null && entry.id !== '') return String(entry.id);
      return null;
    }

    function isValidISODateLocal(d) {
      return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
    }

    function normalize(payload, date) {
      if (!payload || typeof payload !== 'object') return emptyPayload(date);
      return {
        v: 1,
        date: date,
        savedAt: Number(payload.savedAt) || now(),
        entries: Array.isArray(payload.entries) ? payload.entries.filter(Boolean).slice(-MAX_ENTRIES) : [],
      };
    }

    /* Union by id; newest lastSeen wins per row; list stays newest-first. */
    function mergePayloads(a, b, date) {
      var base = normalize(a, date);
      var add = normalize(b, date);
      var map = Object.create(null);
      function take(entry) {
        var key = entryKey(entry);
        if (!key) return;
        var prev = map[key];
        if (!prev) { map[key] = entry; return; }
        var merged = Object.assign({}, prev, entry);
        merged.firstSeen = Math.min(Number(prev.firstSeen) || now(), Number(entry.firstSeen) || now());
        merged.lastSeen = Math.max(Number(prev.lastSeen) || 0, Number(entry.lastSeen) || 0);
        /* Wording is evidence: never let a null overwrite recorded content.
         * `before` keeps the earliest observed call; `after` keeps the latest. */
        if (entry.before === null || entry.before === undefined) merged.before = prev.before !== undefined ? prev.before : merged.before;
        if (prev.before !== null && prev.before !== undefined) {
          if (!entry.before) merged.before = prev.before;
          else merged.before = (Number(prev.firstSeen) || Infinity) <= (Number(entry.firstSeen) || Infinity) ? prev.before : entry.before;
        }
        if (entry.after === null || entry.after === undefined) merged.after = prev.after !== undefined ? prev.after : merged.after;
        if (prev.after !== null && prev.after !== undefined) {
          if (!entry.after) merged.after = prev.after;
          else merged.after = (Number(entry.lastSeen) || 0) >= (Number(prev.lastSeen) || 0) ? entry.after : prev.after;
        }
        var prevHist = Array.isArray(prev.history) ? prev.history : [];
        var newHist = Array.isArray(entry.history) ? entry.history : [];
        if (prevHist.length || newHist.length) merged.history = (newHist.length >= prevHist.length ? newHist : prevHist).slice(-50);
        map[key] = merged;
      }
      base.entries.forEach(take);
      add.entries.forEach(take);
      var entries = Object.keys(map).map(function (k) { return map[k]; })
        .sort(function (x, y) { return (Number(y.lastSeen) || 0) - (Number(x.lastSeen) || 0); })
        .slice(0, MAX_ENTRIES);
      return { v: 1, date: date, savedAt: now(), entries: entries };
    }

    function loadLocal(date) {
      var raw = storageGet(KEY_PREFIX + date);
      if (!raw) return null;
      try {
        var parsed = JSON.parse(raw);
        if (!parsed || parsed.v !== 1) return null;
        return normalize(parsed, date);
      } catch (e) {
        global.console && global.console.warn && global.console.warn('[' + config.globalName + '] dropping malformed local log for ' + date);
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
      if (apiState.checked && !apiState.available) return Promise.resolve(null);
      return serverFetch(ENDPOINT + '?date=' + encodeURIComponent(date))
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
      if (!isValidISODateLocal(date)) return Promise.resolve(emptyPayload(date));
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
      var payload = pendingPayload;
      if (!payload) return Promise.resolve(null);
      pendingPayload = null;
      if (apiState.checked && !apiState.available) return Promise.resolve(null);
      return serverFetch(ENDPOINT, {
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

    /* save() is coalesced to at most one write per second. */
    function save(date, payload) {
      if (!isValidISODateLocal(date)) return;
      var normalized = normalize(payload, date);
      saveLocal(date, normalized);
      pendingPayload = normalized;
      if (saveTimer) return;
      saveTimer = setTimeout(function () {
        saveTimer = null;
        postNow(date);
      }, WRITE_COALESCE_MS);
    }

    function onChange(fn) {
      if (typeof fn === 'function') listeners.push(fn);
    }

    function emit(payload) {
      listeners.forEach(function (fn) {
        try { fn(payload); } catch (e) { global.console && global.console.warn && global.console.warn('[' + config.globalName + '] listener failed', e); }
      });
    }

    function openStream(date) {
      if (typeof global.EventSource !== 'function') return null;
      if (apiState.checked && !apiState.available) return null;
      try {
        stream = new global.EventSource(STREAM + '?date=' + encodeURIComponent(date));
      } catch (e) {
        return null;
      }
      stream.addEventListener(config.globalName + '-log', function (evt) {
        try {
          var payload = JSON.parse(evt.data);
          apiState.available = true;
          emit(normalize(payload, date));
        } catch (e) {
          global.console && global.console.warn && global.console.warn('[' + config.globalName + '] ignoring malformed push frame');
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

    return {
      emptyPayload: emptyPayload,
      normalize: normalize,
      mergePayloads: mergePayloads,
      load: load,
      save: save,
      onChange: onChange,
      openStream: openStream,
      closeStream: closeStream,
      entryKey: entryKey,
      state: apiState,
      MAX_ENTRIES: MAX_ENTRIES,
      KEEP_DATES: KEEP_DATES,
    };
  }

  global.PersistentLog = { create: create };
}(window));
