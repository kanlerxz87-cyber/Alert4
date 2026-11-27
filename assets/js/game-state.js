/* ============================================================================
 * game-state.js — the official live game state, captured to the second
 *
 * For every live game on the slate this records a snapshot of the state MLB
 * itself publishes, and the *transition* between two snapshots:
 *
 *   score · outs · count · batter at bat · pitcher · runners · inning/half ·
 *   pitch number and call · last play · official game status · the at-bat's
 *   pending scoring state
 *
 * Each snapshot carries two clocks:
 *   observedAt   our clock, ISO with seconds ("2026-04-07T18:22:31.412Z")
 *   gameTimecode MLB's own feed timecode from metaData.timeStamp
 *                ("20260407_182231") — the second the API published the state
 * Their difference is the publish latency we actually saw (state.latencyMs),
 * so "as fast as possible" is measured, not claimed.
 *
 * Persistence is deliberately *separate* from the alert path:
 *   localStorage  mlbp.gamestate.<date>   (always; survives a refresh)
 *   server        POST/GET /api/game-state (server.mjs; also separate)
 * If either is unavailable the other still works, and the alert system keeps
 * running untouched — nothing in this file can throw into reviews-feed.js.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var MLB = global.MLB;
  var KEY_PREFIX = 'mlbp.gamestate.';
  var INDEX_KEY = 'mlbp.gamestate.index';
  var KEEP_DATES = 7;
  var MAX_SNAPSHOTS = 240;    // per game, per date — a full nine innings with room
  var MAX_TRANSITIONS = 320;  // per game, per date
  var serverState = { checked: false, available: false, lastError: null };
  var saveTimers = Object.create(null);

  /* The feed's timecode is published as YYYYMMDD_HHMMSS, with **no zone stated**
   * anywhere in the payload.  Two candidates are plausible (UTC, or the same
   * wall clock in one zone), and we do not get to guess silently: the client
   * reads the timecode's *wall clock* and only reports a latency when that
   * wall clock sits within `PUBLISH_WINDOW_MS` of our own local wall clock.  If
   * it does not, latency is `null` and the UI says "waiting" rather than
   * printing a number that is hours out.
   *
   * This is deliberately conservative: it assumes only that the feed publishes
   * in the same wall-clock zone as the reader (MLB's audience and its own
   * servers are US-based, and a local display is what the reader sees).  The
   * zone question is flagged (flagged.html §18, L-7) rather than asserted.
   */
  var PUBLISH_WINDOW_MS = 2 * 60 * 60 * 1000;

  function parseGameTimecode(tc, referenceMs) {
    var m = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(String(tc || ''));
    if (!m) return null;
    /* Read the six numbers as a LOCAL wall clock: that is the only reading that
     * can be compared with the reader's own clock without assuming a zone. */
    var local = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      Number(m[4]), Number(m[5]), Number(m[6])).getTime();
    if (!isFinite(local)) return null;
    var ref = typeof referenceMs === 'number' && isFinite(referenceMs) ? referenceMs : Date.now();
    var delta = ref - local;
    /* Published in the recent past (or a second or two ahead on a clock-skewed
     * machine) — anything else is a different zone or a different date, and we
     * decline to report a number for it. */
    if (delta < -5000 || delta > PUBLISH_WINDOW_MS) return null;
    return local;
  }

  /* Display form of the timecode: "18:22:31" from "20260407_182231". */
  function timecodeClock(tc) {
    var m = /^\d{8}_(\d{2})(\d{2})(\d{2})$/.exec(String(tc || ''));
    return m ? m[1] + ':' + m[2] + ':' + m[3] : '';
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function isoSeconds(ms) {
    var d = new Date(ms);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) + 'T' +
      pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds()) + '.' +
      String(d.getUTCMilliseconds()).padStart(3, '0') + 'Z';
  }

  function localClock(ms) {
    var d = new Date(ms);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function person(p) {
    if (!p) return null;
    if (typeof p === 'string') return { id: null, name: p };
    return { id: p.id === undefined ? null : p.id, name: p.fullName || p.name || '' };
  }

  /* ------------------------------------------------------------- extraction */

  /**
   * snapshot(payload, opts) -> snapshot object (or null when the payload has
   * no live state at all).  `payload` is a feed/live response (or the merged
   * bundle gameFeed() falls back to).
   */
  function snapshot(payload, opts) {
    if (!payload) return null;
    var gameData = payload.gameData || {};
    var live = payload.liveData || {};
    var ls = live.linescore || {};
    var plays = (live.plays && live.plays.allPlays) || payload.allPlays || [];
    var current = (live.plays && live.plays.currentPlay) || null;
    var status = gameData.status || {};
    var off = ls.offense || {};
    var def = ls.defense || {};
    var meta = payload.metaData || {};

    var lastCompleted = null;
    for (var i = plays.length - 1; i >= 0; i -= 1) {
      if (plays[i] && plays[i].about && plays[i].about.isComplete) { lastCompleted = plays[i]; break; }
    }
    var atBat = current || lastCompleted;
    var about = (atBat && atBat.about) || {};
    var result = (atBat && atBat.result) || {};
    var events = (atBat && atBat.playEvents) || [];
    var lastPitch = null;
    for (var e = events.length - 1; e >= 0; e -= 1) {
      if (events[e] && events[e].isPitch) { lastPitch = events[e]; break; }
    }

    var awayRuns = (ls.teams && ls.teams.away && ls.teams.away.runs);
    var homeRuns = (ls.teams && ls.teams.home && ls.teams.home.runs);
    if (typeof awayRuns !== 'number' && lastCompleted && lastCompleted.result) {
      awayRuns = lastCompleted.result.awayScore;
      homeRuns = lastCompleted.result.homeScore;
    }

    var observedMs = opts && opts.observedAt ? opts.observedAt : Date.now();
    var tc = meta.timeStamp ? String(meta.timeStamp) : '';
    var tcMs = parseGameTimecode(tc, observedMs);

    var snap = {
      capturedAt: observedMs,
      observedAt: isoSeconds(observedMs),
      observedClock: localClock(observedMs),
      gameTimecode: tc,
      gameTimecodeMs: tcMs,
      latencyMs: tcMs === null ? null : Math.max(0, observedMs - tcMs),
      publishWindowMs: PUBLISH_WINDOW_MS,
      gamePk: Number((gameData.game && gameData.game.pk) || (opts && opts.gamePk) || 0) || null,
      status: {
        code: status.statusCode || '',
        detailed: status.detailedState || '',
        abstract: status.abstractGameState || '',
        reason: status.reason || '',
      },
      inning: {
        num: typeof ls.currentInning === 'number' ? ls.currentInning : (about.inning || null),
        half: ls.isTopInning === false ? 'bottom' : (ls.isTopInning === true ? 'top' : (about.halfInning || null)),
        state: ls.inningState || '',
        ordinal: ls.currentInningOrdinal || '',
      },
      score: {
        away: typeof awayRuns === 'number' ? awayRuns : null,
        home: typeof homeRuns === 'number' ? homeRuns : null,
      },
      outs: typeof ls.outs === 'number' ? ls.outs
        : (atBat && atBat.count && atBat.count.outs !== undefined && atBat.count.outs !== null ? atBat.count.outs : null),
      count: {
        balls: typeof ls.balls === 'number' ? ls.balls : (lastPitch && lastPitch.count ? lastPitch.count.balls : null),
        strikes: typeof ls.strikes === 'number' ? ls.strikes : (lastPitch && lastPitch.count ? lastPitch.count.strikes : null),
      },
      batter: person(off.batter || (atBat && atBat.matchup && atBat.matchup.batter)),
      pitcher: person(def.pitcher || (atBat && atBat.matchup && atBat.matchup.pitcher)),
      runners: {
        first: person(off.first),
        second: person(off.second),
        third: person(off.third),
      },
      atBat: {
        index: about.atBatIndex === undefined ? null : about.atBatIndex,
        complete: about.isComplete === true,
        eventType: result.eventType || '',
        description: result.description || '',
        hasReview: about.hasReview === true,
      },
      pitch: lastPitch ? {
        number: lastPitch.pitchNumber === undefined ? null : lastPitch.pitchNumber,
        call: (lastPitch.details && ((lastPitch.details.call && lastPitch.details.call.description) || lastPitch.details.description)) || '',
        type: (lastPitch.details && lastPitch.details.type && lastPitch.details.type.description) || '',
        speed: (lastPitch.pitchData && lastPitch.pitchData.startSpeed) || null,
        index: lastPitch.index === undefined ? null : lastPitch.index,
      } : null,
      plays: {
        total: plays.length,
        events: (current && current.playEvents ? current.playEvents.length : 0),
      },
      pendingRuling: result.eventType === 'os_ruling_pending_primary' || result.eventType === 'os_ruling_pending_prior',
    };
    return snap;
  }

  /* --------------------------------------------------------------- diffing */

  var FIELDS = [
    { key: 'score', label: 'Score', format: function (v) { return v ? v.away + '–' + v.home : '—'; } },
    { key: 'outs', label: 'Outs', format: function (v) { return String(v); } },
    { key: 'count', label: 'Count', format: function (v) { return v ? v.balls + '-' + v.strikes : '—'; } },
    { key: 'batter', label: 'Batter', format: function (v) { return v ? v.name : '—'; } },
    { key: 'pitcher', label: 'Pitcher', format: function (v) { return v ? v.name : '—'; } },
    { key: 'inning', label: 'Inning', format: function (v) { return v ? (v.half === 'top' ? 'Top ' : 'Bot ') + (v.num || '') : '—'; } },
    { key: 'status', label: 'Status', format: function (v) { return v ? (v.detailed || v.abstract || v.code) : '—'; } },
    { key: 'atBat', label: 'At-bat', format: function (v) { return v ? (v.eventType || (v.complete ? 'complete' : 'in progress')) : '—'; } },
    { key: 'pitch', label: 'Pitch', format: function (v) { return v ? ('#' + (v.number === null ? '?' : v.number) + ' ' + (v.call || '')).trim() : '—'; } },
    { key: 'pendingRuling', label: 'Official scoring', format: function (v) { return v ? 'ruling pending' : 'decided'; } },
  ];

  function runnersKey(v) {
    function one(p) { return p && p.id ? String(p.id) : ''; }
    return one(v && v.first) + '|' + one(v && v.second) + '|' + one(v && v.third);
  }

  /* The alerting transitions are the ones the owner asked to hear about; the
   * rest are recorded for the state trail but never make a sound. */
  var ALERT_FIELDS = { status: true, pendingRuling: true };

  /**
   * diff(prev, next) -> { changes: [], alerting: [] }
   *   changes  every field that moved, with the exact before/after values and
   *            both clocks (so a row can say "18:22:31 → 18:22:44")
   */
  function diff(prev, next) {
    var changes = [];
    if (!prev || !next) return { changes: changes, alerting: [] };

    FIELDS.forEach(function (f) {
      var a = prev[f.key];
      var b = next[f.key];
      var changed;
      if (f.key === 'score' || f.key === 'count' || f.key === 'inning' || f.key === 'status' ||
        f.key === 'atBat' || f.key === 'pitch' || f.key === 'batter') {
        changed = JSON.stringify(a || null) !== JSON.stringify(b || null);
        /* batter identity: a same-name reorder is not a change worth logging */
        if (f.key === 'batter' && a && b && a.id === b.id) changed = false;
      } else {
        changed = JSON.stringify(a === undefined ? null : a) !== JSON.stringify(b === undefined ? null : b);
      }
      if (!changed) return;
      changes.push({
        field: f.key,
        label: f.label,
        from: a === undefined ? null : a,
        to: b === undefined ? null : b,
        fromText: f.format(a),
        toText: f.format(b),
        alerting: ALERT_FIELDS[f.key] === true,
        atGameTimecode: next.gameTimecode,
        atObserved: next.observedAt,
        atGameMs: next.gameTimecodeMs,
        latencyMs: next.latencyMs,
      });
    });

    if (runnersKey(prev.runners) !== runnersKey(next.runners)) {
      var names = [next.runners.first, next.runners.second, next.runners.third]
        .filter(function (r) { return r && r.name; }).map(function (r) { return r.name; });
      changes.push({
        field: 'runners',
        label: 'Runners on',
        from: prev.runners,
        to: next.runners,
        fromText: [prev.runners.first, prev.runners.second, prev.runners.third].filter(Boolean).length + ' on',
        toText: names.length ? names.join(', ') : 'bases empty',
        alerting: false,
        atGameTimecode: next.gameTimecode,
        atObserved: next.observedAt,
        atGameMs: next.gameTimecodeMs,
        latencyMs: next.latencyMs,
      });
    }

    return {
      changes: changes,
      alerting: changes.filter(function (c) { return c.alerting; }),
    };
  }

  /* ------------------------------------------------------------ persistence */

  function storageGet(key) { try { return global.localStorage.getItem(key); } catch (e) { return null; } }
  function storageSet(key, value) { try { global.localStorage.setItem(key, value); return true; } catch (e) { return false; } }

  function emptyDay(date) {
    return { v: 1, date: date, savedAt: Date.now(), games: {} };
  }

  function normalize(payload, date) {
    if (!payload || typeof payload !== 'object') return emptyDay(date);
    var games = (payload.games && typeof payload.games === 'object') ? payload.games : {};
    var out = { v: 1, date: date, savedAt: Number(payload.savedAt) || Date.now(), games: {} };
    Object.keys(games).forEach(function (pk) {
      var g = games[pk] || {};
      out.games[pk] = {
        gamePk: Number(pk),
        matchupLabel: g.matchupLabel || '',
        snapshots: Array.isArray(g.snapshots) ? g.snapshots.slice(-MAX_SNAPSHOTS) : [],
        transitions: Array.isArray(g.transitions) ? g.transitions.slice(-MAX_TRANSITIONS) : [],
        lastSeenAt: Number(g.lastSeenAt) || 0,
        lastTimecode: g.lastTimecode || '',
      };
    });
    return out;
  }

  function readIndex() {
    try {
      var parsed = JSON.parse(storageGet(INDEX_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
  }

  function loadLocal(date) {
    var raw = storageGet(KEY_PREFIX + date);
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || parsed.v !== 1) return null;
      return normalize(parsed, date);
    } catch (e) {
      global.console && global.console.warn && global.console.warn('[game-state] dropping malformed local store for ' + date);
      return null;
    }
  }

  function saveLocal(date, payload) {
    var ok = storageSet(KEY_PREFIX + date, JSON.stringify(payload));
    if (ok) {
      var index = readIndex();
      if (index.indexOf(date) === -1) index.push(date);
      index.sort();
      while (index.length > KEEP_DATES) {
        var drop = index.shift();
        try { global.localStorage.removeItem(KEY_PREFIX + drop); } catch (e) { /* ignore */ }
      }
      storageSet(INDEX_KEY, JSON.stringify(index));
    }
    return ok;
  }

  function isStaticHost() {
    var host = (global.location && global.location.hostname) || '';
    return /\.github\.io$/i.test(host);
  }

  function loadServer(date) {
    if (isStaticHost() || typeof fetch !== 'function') {
      serverState.checked = true;
      serverState.available = false;
      return Promise.resolve(null);
    }
    return fetch('/api/game-state?date=' + encodeURIComponent(date), { cache: 'no-store', credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        serverState.checked = true;
        serverState.available = true;
        return res.json();
      })
      .then(function (data) { return data ? normalize(data, date) : null; })
      .catch(function (err) {
        serverState.checked = true;
        serverState.available = false;
        serverState.lastError = err;
        return null;
      });
  }

  /* Merge two days of state without losing either side's observations. */
  function merge(a, b, date) {
    var base = normalize(a, date);
    var add = normalize(b, date);
    var games = {};
    [base, add].forEach(function (src) {
      Object.keys(src.games).forEach(function (pk) {
        var g = src.games[pk];
        var acc = games[pk] || (games[pk] = { gamePk: g.gamePk, matchupLabel: '', snapshots: [], transitions: [], lastSeenAt: 0, lastTimecode: '' });
        acc.matchupLabel = g.matchupLabel || acc.matchupLabel;
        acc.lastSeenAt = Math.max(acc.lastSeenAt, g.lastSeenAt);
        if (g.lastTimecode && g.lastTimecode > acc.lastTimecode) acc.lastTimecode = g.lastTimecode;
        g.snapshots.forEach(function (s) { pushUnique(acc.snapshots, s, snapKey); });
        g.transitions.forEach(function (t) { pushUnique(acc.transitions, t, transKey); });
      });
    });
    Object.keys(games).forEach(function (pk) {
      games[pk].snapshots.sort(function (x, y) { return (x.capturedAt || 0) - (y.capturedAt || 0); });
      games[pk].transitions.sort(function (x, y) { return (x.at || 0) - (y.at || 0); });
      games[pk].snapshots = games[pk].snapshots.slice(-MAX_SNAPSHOTS);
      games[pk].transitions = games[pk].transitions.slice(-MAX_TRANSITIONS);
    });
    return { v: 1, date: date, savedAt: Date.now(), games: games };
  }

  function pushUnique(list, item, keyFn) {
    if (!item) return false;
    var key = keyFn(item);
    for (var i = 0; i < list.length; i += 1) {
      if (keyFn(list[i]) === key) return false;
    }
    list.push(item);
    return true;
  }

  function snapKey(s) { return String(s.gameTimecode || '') + '|' + String(s.capturedAt || ''); }
  function transKey(t) { return String(t.gameTimecode || '') + '|' + String(t.field || '') + '|' + String(t.toText || ''); }

  /* ------------------------------------------------------------ module state */

  var days = Object.create(null);     // date -> { games: { pk: { snapshots, transitions } } }
  var listeners = [];

  function dayFor(date) {
    if (!days[date]) days[date] = emptyDay(date);
    return days[date];
  }

  function load(date) {
    var local = loadLocal(date);
    return loadServer(date).then(function (remote) {
      if (!remote && !local) return emptyDay(date);
      if (!remote) return local;
      if (!local) { saveLocal(date, remote); return remote; }
      var merged = merge(remote, local, date);
      saveLocal(date, merged);
      return merged;
    });
  }

  function serverSave(date) {
    var payload = dayFor(date);
    if (isStaticHost() || typeof fetch !== 'function') return;
    if (serverState.checked && !serverState.available) return;
    try {
      fetch('/api/game-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      }).then(function (res) {
        serverState.available = res.ok;
        serverState.lastError = res.ok ? null : new Error('HTTP ' + res.status);
      }).catch(function (err) {
        serverState.available = false;
        serverState.lastError = err;
      });
    } catch (e) { /* static hosting */ }
  }

  function save(date) {
    dayFor(date).savedAt = Date.now();
    saveLocal(date, dayFor(date));
    if (saveTimers[date]) return;
    saveTimers[date] = setTimeout(function () {
      saveTimers[date] = null;
      serverSave(date);
    }, 1500);
  }

  function emit(date, gamePk, transition) {
    listeners.forEach(function (fn) {
      try { fn(date, gamePk, transition); } catch (e) {
        global.console && global.console.warn && global.console.warn('[game-state] listener failed', e);
      }
    });
  }

  function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }

  /**
   * record(date, gamePk, matchupLabel, next, opts) -> { snapshot, transition }
   * Stores the snapshot, diffs it against the previous one, stores the
   * transition, and notifies listeners.  Never throws.
   */
  function record(date, gamePk, matchupLabel, next, opts) {
    if (!date || !gamePk || !next) return null;
    var day = dayFor(date);
    var key = String(gamePk);
    var game = day.games[key] || (day.games[key] = {
      gamePk: Number(gamePk), matchupLabel: matchupLabel || '', snapshots: [], transitions: [], lastSeenAt: 0, lastTimecode: '',
    });
    game.matchupLabel = matchupLabel || game.matchupLabel;
    game.lastSeenAt = next.capturedAt;

    var prev = game.snapshots.length ? game.snapshots[game.snapshots.length - 1] : null;
    var sameState = prev && prev.gameTimecode && next.gameTimecode && prev.gameTimecode === next.gameTimecode;
    if (!sameState) {
      game.snapshots.push(next);
      if (game.snapshots.length > MAX_SNAPSHOTS) game.snapshots = game.snapshots.slice(-MAX_SNAPSHOTS);
      game.lastTimecode = next.gameTimecode || game.lastTimecode;
    }

    var d = diff(prev, next);
    var transition = null;
    if (d.changes.length) {
      transition = {
        gamePk: Number(gamePk),
        at: next.capturedAt,
        observedAt: next.observedAt,
        observedClock: next.observedClock,
        gameTimecode: next.gameTimecode,
        latencyMs: next.latencyMs,
        changes: d.changes,
        alerting: d.alerting.map(function (c) { return c.field; }),
      };
      game.transitions.push(transition);
      if (game.transitions.length > MAX_TRANSITIONS) game.transitions = game.transitions.slice(-MAX_TRANSITIONS);
      emit(date, gamePk, transition);
    }

    if (!opts || opts.save !== false) save(date);
    return { snapshot: next, transition: transition, changes: d.changes };
  }

  function forGame(date, gamePk) {
    var day = days[date];
    if (!day) return { snapshots: [], transitions: [] };
    return day.games[String(gamePk)] || { snapshots: [], transitions: [] };
  }

  function latest(date, gamePk) {
    var game = forGame(date, gamePk);
    return game.snapshots && game.snapshots.length ? game.snapshots[game.snapshots.length - 1] : null;
  }

  /* The most recent transition per game — what the Replay Feed shows as the
   * live "state of the game right now" line. */
  function recentTransitions(date, limit) {
    var day = days[date];
    if (!day) return [];
    var all = [];
    Object.keys(day.games).forEach(function (pk) {
      var t = day.games[pk].transitions;
      if (t && t.length) all.push(t[t.length - 1]);
    });
    all.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
    return all.slice(0, limit || 6);
  }

  function adopt(date, payload) {
    days[date] = merge(days[date] || emptyDay(date), normalize(payload, date), date);
    return days[date];
  }

  function forget(date) { delete days[date]; }

  global.GameState = {
    snapshot: snapshot,
    diff: diff,
    record: record,
    load: load,
    save: save,
    adopt: adopt,
    forget: forget,
    forGame: forGame,
    latest: latest,
    recentTransitions: recentTransitions,
    merge: merge,
    normalize: normalize,
    onChange: onChange,
    parseGameTimecode: parseGameTimecode,
    timecodeClock: timecodeClock,
    PUBLISH_WINDOW_MS: PUBLISH_WINDOW_MS,
    isoSeconds: isoSeconds,
    localClock: localClock,
    FIELDS: FIELDS,
    MAX_SNAPSHOTS: MAX_SNAPSHOTS,
    MAX_TRANSITIONS: MAX_TRANSITIONS,
    state: serverState,
    days: days,
  };
}(window));
