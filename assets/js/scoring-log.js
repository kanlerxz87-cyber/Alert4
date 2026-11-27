/* ============================================================================
 * scoring-log.js — official-scoring pending / changes, kept apart on purpose
 *
 * This module owns the "Official Scoring" section and nothing else.  It has:
 *   • its own storage        mlbp.scoring.<date>  (+ POST/GET /api/scoring-log)
 *   • its own sound          Chime.play('scoring'), its own on/off + cooldown
 *   • its own poll loop      started/stopped by the section itself
 * and it never touches reviews-feed.js's alert entries, alert sound, or feed
 * log.  A failure here (storage full, server missing, odd payload) is caught
 * locally and cannot stop the alert system.
 *
 * What it logs (both come from the official payload):
 *   1. PENDING — an at-bat whose `result.eventType` is
 *      `os_ruling_pending_primary` / `os_ruling_pending_prior`, checked against
 *      the API's own event registry (GET /api/v1/eventTypes).  The row records
 *      the exact official wording while it is undecided.
 *   2. CHANGES — the official scorer reclassifying an at-bat or play.  The
 *      payload carries no "this was changed" marker, so a change is found by
 *      diffing each completed play's official classification on every poll.  A
 *      change can only be recorded when the initial call was observed *before*
 *      the change landed; the row keeps both descriptions and both scores.
 *
 * Rows are keyed per game and at-bat, so a page refresh restores the whole
 * history instead of starting over.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var MLB = global.MLB;
  var KEY_PREFIX = 'mlbp.scoring.';
  var INDEX_KEY = 'mlbp.scoring.index';
  var KEEP_DATES = 7;
  var MAX_ROWS = 400;
  var MAX_EVENTS = 400;
  var POLL_MS = 1000;          // the section's own cadence, independent of the feed
  var FINAL_GRACE_MS = 30 * 60 * 1000;
  var CONCURRENCY = 3;

  var serverState = { checked: false, available: false, lastError: null };
  var saveTimers = Object.create(null);

  function emptyDay(date) {
    return { v: 1, date: date, savedAt: Date.now(), rows: [], events: [], baselines: {} };
  }

  function storageGet(key) { try { return global.localStorage.getItem(key); } catch (e) { return null; } }
  function storageSet(key, value) { try { global.localStorage.setItem(key, value); return true; } catch (e) { return false; } }

  function normalize(payload, date) {
    if (!payload || typeof payload !== 'object') return emptyDay(date);
    return {
      v: 1,
      date: date,
      savedAt: Number(payload.savedAt) || Date.now(),
      rows: Array.isArray(payload.rows) ? payload.rows.slice(0, MAX_ROWS) : [],
      events: Array.isArray(payload.events) ? payload.events.slice(0, MAX_EVENTS) : [],
      baselines: (payload.baselines && typeof payload.baselines === 'object') ? payload.baselines : {},
    };
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
      global.console && global.console.warn && global.console.warn('[scoring-log] dropping malformed store for ' + date);
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
    return fetch('/api/scoring-log?date=' + encodeURIComponent(date), { cache: 'no-store', credentials: 'same-origin' })
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

  function merge(a, b, date) {
    var base = normalize(a, date);
    var add = normalize(b, date);
    var rows = Object.create(null);
    base.rows.concat(add.rows).forEach(function (row) {
      if (!row || !row.id) return;
      var prev = rows[row.id];
      rows[row.id] = prev ? Object.assign({}, prev, row, {
        firstSeen: Math.min(Number(prev.firstSeen) || Number(row.firstSeen) || Date.now(),
          Number(row.firstSeen) || Number(prev.firstSeen) || Date.now()),
        lastSeen: Math.max(Number(prev.lastSeen) || 0, Number(row.lastSeen) || 0),
      }) : row;
    });
    var events = Object.create(null);
    base.events.concat(add.events).forEach(function (ev) {
      if (!ev || !ev.id) return;
      events[ev.id] = events[ev.id] || ev;
    });
    return {
      v: 1,
      date: date,
      savedAt: Date.now(),
      rows: Object.keys(rows).map(function (k) { return rows[k]; })
        .sort(function (x, y) { return (y.lastSeen || 0) - (x.lastSeen || 0); }).slice(0, MAX_ROWS),
      events: Object.keys(events).map(function (k) { return events[k]; })
        .sort(function (x, y) { return (y.at || 0) - (x.at || 0); }).slice(0, MAX_EVENTS),
      baselines: Object.assign({}, base.baselines, add.baselines),
    };
  }

  /* ------------------------------------------------------------- module state */

  var days = Object.create(null);
  var prefs = { sound: true, enabled: true };
  /* When the Replay Feed is on the page it is already reading every game's
   * play-by-play as the feed moves.  This module then *consumes* those
   * observations instead of polling the same games a second time, which halves
   * the request cost without coupling the two: it keeps its own store, its own
   * sound, its own rendering and its own failure domain, and it starts polling
   * for itself (UPSTREAM_IDLE_MS) the moment the feed stops delivering. */
  var UPSTREAM_IDLE_MS = 10000;
  var upstreamAt = 0;
  var upstreamGames = 0;
  var PROBE_BUDGET_PER_SEC = 4;   // the log's share; the alert feed keeps its own

  var loop = {
    timer: null, running: false, inFlight: false, date: null, seq: 0,
    lastPollAt: 0, error: null, ticks: 0,
    probeSig: Object.create(null),   // gamePk -> last metaData signature
    changedUntil: Object.create(null),
    nextDue: Object.create(null),
    finalSeen: Object.create(null),
    reads: 0, probes: 0,
  };
  var registry = null;         // { eventType: description } once loaded

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
    if (isStaticHost() || typeof fetch !== 'function') return;
    if (serverState.checked && !serverState.available) return;
    try {
      fetch('/api/scoring-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(dayFor(date)),
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
    }, 1200);
  }

  function adopt(date, payload) {
    days[date] = merge(days[date] || emptyDay(date), normalize(payload, date), date);
    return days[date];
  }

  function forget(date) { delete days[date]; }

  /* --------------------------------------------------------------- detection */

  /* Official description for an event type: from the API's registry when it has
   * loaded, otherwise the raw code (never an invented phrase). */
  function describeEvent(eventType) {
    if (!eventType) return '';
    if (registry && registry[eventType]) return registry[eventType];
    return eventType;
  }

  function classification(play) {
    var about = (play && play.about) || {};
    var res = (play && play.result) || {};
    var count = (play && play.count) || {};
    var errors = 0;
    var errorEvents = [];
    ((play && play.runners) || []).forEach(function (r) {
      var d = r && r.details;
      if (d && /error/.test(String(d.eventType || ''))) {
        errors += 1;
        errorEvents.push(d.eventType);
      }
    });
    return {
      atBatIndex: about.atBatIndex === undefined ? null : Number(about.atBatIndex),
      inning: about.inning || null,
      halfInning: about.halfInning || null,
      eventType: res.eventType || '',
      description: res.description || '',
      isOut: res.isOut === true,
      outs: typeof count.outs === 'number' ? count.outs : null,
      rbi: typeof res.rbi === 'number' ? res.rbi : null,
      awayScore: typeof res.awayScore === 'number' ? res.awayScore : null,
      homeScore: typeof res.homeScore === 'number' ? res.homeScore : null,
      isHit: ['single', 'double', 'triple', 'home_run'].indexOf(res.eventType) !== -1,
      errors: errors,
      errorEvents: errorEvents,
      batter: (play.matchup && play.matchup.batter && play.matchup.batter.fullName) || '',
      pitcher: (play.matchup && play.matchup.pitcher && play.matchup.pitcher.fullName) || '',
    };
  }

  function isReclassification(before, after) {
    return before.eventType !== after.eventType ||
      before.isOut !== after.isOut ||
      before.errors !== after.errors ||
      (before.outs !== null && after.outs !== null && before.outs !== after.outs);
  }

  /**
   * observe(date, gamePk, matchupLabel, plays) — the pure detection step for one
   * game.  Returns { pending: [], changes: [], edits: [] } and stores nothing;
   * the caller (scan) applies it.  Exported so it can be unit-tested and so the
   * alert path can reuse the same official classification rules.
   */
  function observe(date, gamePk, matchupLabel, plays) {
    var day = dayFor(date);
    var pending = [];
    var changes = [];
    var edits = [];

    (plays || []).forEach(function (play) {
      var about = (play && play.about) || {};
      var res = (play && play.result) || {};
      if (res.eventType === 'os_ruling_pending_primary' || res.eventType === 'os_ruling_pending_prior') {
        pending.push({
          id: gamePk + ':' + about.atBatIndex + ':pending',
          kind: 'pending',
          gamePk: Number(gamePk),
          matchupLabel: matchupLabel || '',
          atBatIndex: about.atBatIndex === undefined ? null : Number(about.atBatIndex),
          inning: about.inning || null,
          halfInning: about.halfInning || null,
          eventType: res.eventType,
          officialWording: describeEvent(res.eventType),
          description: res.description || '',
          batter: (play.matchup && play.matchup.batter && play.matchup.batter.fullName) || '',
          pitcher: (play.matchup && play.matchup.pitcher && play.matchup.pitcher.fullName) || '',
          score: {
            away: typeof res.awayScore === 'number' ? res.awayScore : null,
            home: typeof res.homeScore === 'number' ? res.homeScore : null,
          },
          source: 'GET /api/v1/eventTypes — ' + res.eventType,
        });
      }

      if (about.isComplete !== true) return;
      var now = classification(play);
      var baseKey = gamePk + ':' + now.atBatIndex;
      var base = day.baselines[baseKey];

      if (!base) {
        day.baselines[baseKey] = { first: now, last: now, seenCount: 1, firstSeenAt: Date.now() };
        return;
      }
      base.seenCount = (base.seenCount || 1) + 1;
      if (isReclassification(base.last, now)) {
        changes.push({
          id: baseKey + ':change:' + (base.changeCount = (base.changeCount || 0) + 1),
          kind: 'change',
          gamePk: Number(gamePk),
          matchupLabel: matchupLabel || '',
          atBatIndex: now.atBatIndex,
          inning: now.inning,
          halfInning: now.halfInning,
          firstObserved: base.first,
          previous: base.last,
          official: now,
          attribution: 'Official scorer / Elias Sports Bureau / club review — see mlb.com/official-information/scoring-changes',
          source: 'diffed from consecutive GET /api/v1/game/' + gamePk + '/playByPlay responses',
        });
        base.last = now;
        base.changeCount = base.changeCount || 0;
        base.first = base.first || now;
      } else if (base.last.description !== now.description || base.last.rbi !== now.rbi ||
        base.last.awayScore !== now.awayScore || base.last.homeScore !== now.homeScore) {
        edits.push({
          atBatIndex: now.atBatIndex,
          inning: now.inning,
          before: base.last,
          after: now,
        });
        base.last = now;
      }
    });

    return { pending: pending, changes: changes, edits: edits };
  }

  /* Apply one observation to the persisted day.  Returns the rows that are new
   * (for the caller's sound decision) and the events that were appended. */
  function apply(date, observed) {
    var day = dayFor(date);
    var newRows = [];
    var newEvents = [];
    var now = Date.now();

    function upsert(row) {
      var idx = -1;
      for (var i = 0; i < day.rows.length; i += 1) {
        if (day.rows[i].id === row.id) { idx = i; break; }
      }
      if (idx === -1) {
        row.firstSeen = now;
        row.lastSeen = now;
        day.rows.push(row);
        newRows.push(row);
        return;
      }
      var prev = day.rows[idx];
      day.rows[idx] = Object.assign({}, prev, row, { firstSeen: prev.firstSeen, lastSeen: now });
      if (prev.status === 'pending' && row.status !== 'pending') newRows.push(day.rows[idx]);
    }

    /* A pending ruling that has been answered stops being pending; the row keeps
     * its history instead of disappearing (so the log is complete). */
    day.rows.forEach(function (row) {
      if (row.kind !== 'pending' || row.status !== 'pending') return;
      var stillPending = observed.pending.some(function (p) { return p.id === row.id; });
      if (!stillPending) row.status = 'resolved';
    });

    observed.pending.forEach(function (p) {
      upsert(Object.assign({}, p, { status: 'pending' }));
    });

    observed.changes.forEach(function (c) {
      upsert(Object.assign({}, c, { status: 'recorded' }));
      newEvents.push({
        id: c.id,
        at: now,
        kind: 'change',
        gamePk: c.gamePk,
        matchupLabel: c.matchupLabel,
        atBatIndex: c.atBatIndex,
        text: 'At-bat ' + c.atBatIndex + ' reclassified: ' +
          (c.firstObserved.eventType || '?') + ' → ' + (c.official.eventType || '?'),
      });
    });

    /* One activity-log line per pending ruling, so the trail shows when it was
     * first seen — the row itself already holds the official wording. */
    observed.pending.forEach(function (p) {
      var exists = day.events.some(function (ev) { return ev.id === p.id + ':logged'; });
      if (exists) return;
      newEvents.push({
        id: p.id + ':logged',
        at: now,
        kind: 'pending',
        gamePk: p.gamePk,
        matchupLabel: p.matchupLabel,
        atBatIndex: p.atBatIndex,
        text: 'Ruling pending observed: at-bat ' + p.atBatIndex + ' — ' + (p.officialWording || p.eventType),
      });
    });

    if (newRows.length || newEvents.length) {
      day.events = newEvents.concat(day.events).slice(0, MAX_EVENTS);
      day.rows = day.rows.sort(function (x, y) { return (y.lastSeen || 0) - (x.lastSeen || 0); }).slice(0, MAX_ROWS);
      save(date);
    }

    return { rows: newRows, events: newEvents };
  }

  /* ------------------------------------------------------------------- scan */

  function flattenGames(payload) {
    var out = [];
    ((payload && payload.dates) || []).forEach(function (d) {
      (d.games || []).forEach(function (g) { out.push(g); });
    });
    return out;
  }

  function shouldScan(game) {
    var status = (game.status && game.status.abstractGameState) || '';
    if (status === 'Live') return true;
    if (status === 'Final') {
      var key = String(game.gamePk);
      if (!loop.finalSeen) loop.finalSeen = Object.create(null);
      if (!loop.finalSeen[key]) loop.finalSeen[key] = Date.now();
      return Date.now() - loop.finalSeen[key] < FINAL_GRACE_MS;
    }
    return false;
  }

  function runLimited(items, limit, worker) {
    var index = 0;
    var active = 0;
    return new Promise(function (resolve) {
      if (!items.length) { resolve(); return; }
      function next() {
        if (index >= items.length && active === 0) { resolve(); return; }
        while (active < limit && index < items.length) {
          var item = items[index];
          index += 1;
          active += 1;
          Promise.resolve().then(function () { return worker(item); }).then(function () {
            active -= 1;
            next();
          }, function () {
            active -= 1;
            next();
          });
        }
      }
      next();
    });
  }

  function scan(date, onUpdate, force) {
    if (!prefs.enabled && !force) return Promise.resolve(null);
    if (loop.inFlight || loop.date !== date) return Promise.resolve(null);
    loop.inFlight = true;
    loop.lastPollAt = Date.now();
    var seq = loop.seq;

    /* The roster of games changes rarely; the per-game probe below is what
     * detects movement, so a few seconds of caching here costs no latency. */
    return MLB.schedule(date, { ttl: 3000, retries: 0 })
      .then(function (payload) {
        if (seq !== loop.seq) return null;
        var games = flattenGames(payload).filter(shouldScan);
        var liveCount = games.filter(function (g) {
          return (g.status && g.status.abstractGameState) === 'Live';
        }).length;
        return runLimited(games, CONCURRENCY, function (game) {
          var pk = game.gamePk;
          if (!force) {
            var due = loop.nextDue[pk] || 0;
            if (Date.now() < due) return null;
            loop.nextDue[pk] = Date.now() + MLB.probeIntervalFor(liveCount, PROBE_BUDGET_PER_SEC);
          }
          var prevSig = loop.probeSig[pk];

          /* Cheap path: a ~120 B metaData probe decides whether the game feed
           * moved at all.  A full play-by-play read only happens when it did,
           * when we have never seen the game, or when the caller forces it. */
          var gate;
          if (force) {
            gate = Promise.resolve('read');
          } else if (prevSig === undefined) {
            /* Seed the signature with the same cheap probe, then read once. */
            gate = MLB.gameProbe(pk).then(function (sig) {
              loop.probes += 1;
              loop.probeSig[pk] = sig || '';
              return 'read';
            }).catch(function () { return 'read'; });
          } else {
            gate = MLB.gameProbe(pk).then(function (sig) {
              loop.probes += 1;
              if (!sig) return 'read';
              if (sig === loop.probeSig[pk]) return 'same';
              loop.probeSig[pk] = sig;
              loop.changedUntil[pk] = Date.now() + 4000;
              return 'read';
            }).catch(function () { return 'read'; });
          }

          return gate.then(function (decision) {
            if (seq !== loop.seq) return null;
            if (decision === 'same') return null;
            loop.reads += 1;
            return MLB.playByPlay(pk, { retries: 0 })
              .then(function (pbp) {
                if (seq !== loop.seq) return;
                var label = UI0(game.teams, 'away') + ' @ ' + UI0(game.teams, 'home');
                var plays = (pbp && pbp.allPlays) || [];
                var observed = observe(date, pk, label, plays);
                var applied = apply(date, observed);
                loop.ticks += 1;
                if (onUpdate && (applied.rows.length || applied.events.length)) {
                  onUpdate(applied, game);
                }
              });
          }).catch(function () { /* one game failing never stops the log */ });
        });
      })
      .then(function () {
        loop.inFlight = false;
        loop.error = null;
        return dayFor(date);
      })
      .catch(function (err) {
        loop.inFlight = false;
        loop.error = err;
        return dayFor(date);
      });
  }

  function UI0(teams, side) {
    var t = teams && teams[side] && teams[side].team;
    if (!t) return '';
    var id = Number(t.id);
    var abbr = (global.UI && global.UI.TEAM_ABBR && global.UI.TEAM_ABBR[id]) || '';
    return abbr || (t.name || '').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase();
  }

  function start(date, onUpdate) {
    stop();
    loop.running = true;
    loop.date = date;
    loop.seq += 1;
    loop.finalSeen = Object.create(null);
    var seq = loop.seq;

    function tick() {
      if (!loop.running || loop.date !== date || seq !== loop.seq) return;
      if (global.document && global.document.hidden) {
        loop.timer = setTimeout(tick, 2000);
        return;
      }
      /* The Replay Feed is delivering observations: don't poll the same games. */
      if (hasUpstream()) {
        loop.timer = setTimeout(tick, Math.min(POLL_MS * 2, 4000));
        return;
      }
      var ticked = scan(date, onUpdate);
      Promise.resolve(ticked).then(function () {
        if (!loop.running || loop.date !== date || seq !== loop.seq) return;
        var delay = loop.error ? Math.max(5000, POLL_MS) : POLL_MS;
        loop.timer = setTimeout(tick, delay);
      });
    }
    tick();
  }

  function stop() {
    loop.running = false;
    if (loop.timer) { clearTimeout(loop.timer); loop.timer = null; }
  }

  function setDate(date, onUpdate) {
    loop.seq += 1;
    loop.probeSig = Object.create(null);
    loop.changedUntil = Object.create(null);
    loop.nextDue = Object.create(null);
    loop.finalSeen = Object.create(null);
    stop();
    load(date).then(function (day) {
      days[date] = merge(days[date] || emptyDay(date), day, date);
      if (onUpdate) onUpdate(null);
      start(date, onUpdate);
    });
  }

  /**
   * ingestPlays(date, gamePk, matchupLabel, plays) — the entry point the Replay
   * Feed calls after every play-by-play read.  Guarded: nothing here can throw
   * into the alert path.
   */
  function ingestPlays(date, gamePk, matchupLabel, plays) {
    if (!prefs.enabled) return null;
    if (!Array.isArray(plays)) return null;
    try {
      upstreamAt = Date.now();
      upstreamGames += 1;
      var applied = apply(date, observe(date, gamePk, matchupLabel, plays));
      if (applied.rows.length || applied.events.length) notify(applied);
      return applied;
    } catch (e) {
      global.console && global.console.warn && global.console.warn('[scoring-log] ingest skipped', e);
      return null;
    }
  }

  var onApplied = null;
  function setOnApplied(fn) { onApplied = typeof fn === 'function' ? fn : null; }
  function notify(applied) {
    if (onApplied) {
      try { onApplied(applied); } catch (e) { /* the UI can never break the log */ }
    }
  }

  function hasUpstream() { return Date.now() - upstreamAt < UPSTREAM_IDLE_MS; }

  function loadRegistry() {
    if (registry) return Promise.resolve(registry);
    return MLB.eventTypes().then(function (map) {
      registry = map || Object.create(null);
      return registry;
    });
  }

  function setSound(on) {
    prefs.sound = !!on;
    try { global.localStorage.setItem('mlbp.scoring.sound', prefs.sound ? '1' : '0'); } catch (e) { /* ignore */ }
    global.Chime.setEnabled('scoring', prefs.sound);
  }

  function setEnabled(on) {
    prefs.enabled = !!on;
    try { global.localStorage.setItem('mlbp.scoring.enabled', prefs.enabled ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  function loadPrefs() {
    try {
      var s = global.localStorage.getItem('mlbp.scoring.sound');
      if (s !== null) prefs.sound = s === '1';
      var e = global.localStorage.getItem('mlbp.scoring.enabled');
      if (e !== null) prefs.enabled = e === '1';
    } catch (err) { /* ignore */ }
    global.Chime.setEnabled('scoring', prefs.sound);
    return prefs;
  }

  global.ScoringLog = {
    observe: observe,
    apply: apply,
    classification: classification,
    isReclassification: isReclassification,
    describeEvent: describeEvent,
    load: load,
    save: save,
    adopt: adopt,
    forget: forget,
    merge: merge,
    normalize: normalize,
    start: start,
    stop: stop,
    setDate: setDate,
    scan: scan,
    loadRegistry: loadRegistry,
    ingestPlays: ingestPlays,
    setOnApplied: setOnApplied,
    hasUpstream: hasUpstream,
    UPSTREAM_IDLE_MS: UPSTREAM_IDLE_MS,
    setSound: setSound,
    setEnabled: setEnabled,
    loadPrefs: loadPrefs,
    dayFor: dayFor,
    days: days,
    prefs: prefs,
    loop: loop,
    POLL_MS: POLL_MS,
    serverState: serverState,
  };
}(window));
