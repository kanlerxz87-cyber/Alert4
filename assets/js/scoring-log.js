/* ============================================================================
 * scoring-log.js — the Official Scoring log (persistent, refresh-proof)
 *
 * WHAT THIS IS
 *   A standalone recorder for the two things the official scorer does after a
 *   play has been put on the board:
 *
 *     1. PENDING  — a plate appearance that has not been scored yet.  The
 *        StatsAPI publishes these as its own event types
 *        `os_ruling_pending_primary` / `os_ruling_pending_prior`
 *        (GET /api/v1/eventTypes, description "Official Scorer Ruling Pending").
 *     2. CHANGE   — the scorer (or Elias, or a club review) reclassifies an
 *        at-bat after the fact: hit → error, single → double, out → hit,
 *        an RBI or a run taken away.  The payload carries NO change marker, so
 *        a change is only knowable by holding the exact official before state
 *        and diffing it against a later read.  That is what this file does,
 *        and it keeps BOTH sides verbatim.
 *
 * WHY IT IS A SEPARATE MODULE
 *   The owner asked for this to be kept apart from the alert system so that
 *   changes here cannot disrupt alerts.  Nothing in this file chimes, notifies,
 *   touches the Replay Feed's entry list, or shares its timers.  It owns its own
 *   storage namespace (`mlbp.scoringlog.*`), its own snapshot table, and its own
 *   capture loop.  The alert path imports nothing from here; the only coupling
 *   is the other direction — the Replay Feed *reads* these records to render its
 *   ✏️ / 📝 rows, which it could already do from its own log.  If this module
 *   throws, the alert path is untouched.
 *
 * PERSISTENCE
 *   Three layers, each idempotent, so a refresh (or a new browser) never loses a
 *   record and never duplicates one:
 *     1. localStorage — `mlbp.scoringlog.<type>.<YYYY-MM-DD>`, newest 14 dates.
 *     2. server       — POST/GET /api/scoring-log (server.mjs) when the
 *                       persistence server is running; a shared, append-only
 *                       store every browser sees.  Absent on GitHub Pages, where
 *                       the module degrades to localStorage exactly as
 *                       feed-log.js does.
 *     3. export       — every record is downloadable as JSON/CSV from the UI, so
 *                       a review session can archive a day it cares about.
 *
 * HONESTY RULES (carried over from the rest of the site)
 *   - A pending ruling is recorded from the API's own event type; the wording is
 *     the API's `result.description`.  Nothing is paraphrased.
 *   - A change's `before` is only recorded when this module actually observed it
 *     before the change landed.  When the page opened after the ruling, the row
 *     says "not observed" — it never back-fills a guess.
 *   - Plays that vanish from the payload, and descriptions that change without a
 *     reclassification, are logged in a separate `anomalies` list rather than
 *     being "corrected".
 * ==========================================================================*/
(function (global) {
  'use strict';

  var MLB = global.MLB;
  var Reviews = global.Reviews;

  var KEY_PREFIX = 'mlbp.scoringlog.';
  var SNAP_KEY = 'mlbp.scoringlog.snapshots';
  var INDEX_KEY = 'mlbp.scoringlog.index';
  var KEEP_DATES = 14;
  var MAX_RECORDS = 4000;
  var WRITE_COALESCE_MS = 1200;
  var SAVE_STALE_MS = 10 * 60 * 1000;   // drop an unfinished "before" after 10 min
  var CAPTURE_MS = 1000;                // seconds-level state capture cadence
  var FULL_READ_MS = 2000;              // full play classification read cadence

  var apiState = { checked: false, available: false, lastError: null };
  var saveTimers = Object.create(null);
  var pendingWrites = Object.create(null);
  var listeners = [];

  /* Per-date in-memory tables, rebuilt on load. */
  function emptyTable() {
    return {
      v: 1,
      pending: [],      // pending-ruling observations, one row per at-bat
      changes: [],      // confirmed reclassifications
      anomalies: [],    // payload edits / vanished plays — logged, never fixed
      snapshots: {},    // gamePk -> { atBatIndex: {classification, capturedAt} }
      lastAt: 0,
    };
  }

  var tables = Object.create(null);       // date -> table
  var lastSignatures = Object.create(null); // gamePk -> signature of last full read

  /* --------------------------------------------------------------- storage */

  function storageGet(key) {
    try { return global.localStorage.getItem(key); } catch (e) { return null; }
  }
  function storageSet(key, value) {
    try { global.localStorage.setItem(key, value); return true; } catch (e) { return false; }
  }
  function storageRemove(key) {
    try { global.localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }
  function parse(raw, fallback) {
    if (!raw) return fallback;
    try {
      var v = JSON.parse(raw);
      return v === null || v === undefined ? fallback : v;
    } catch (e) { return fallback; }
  }

  function readIndex() {
    var list = parse(storageGet(INDEX_KEY), []);
    return Array.isArray(list) ? list : [];
  }

  function noteDate(date) {
    var index = readIndex();
    if (index.indexOf(date) === -1) {
      index.push(date);
      index.sort();
      while (index.length > KEEP_DATES) {
        var drop = index.shift();
        storageRemove(KEY_PREFIX + 'pending.' + drop);
        storageRemove(KEY_PREFIX + 'changes.' + drop);
        storageRemove(KEY_PREFIX + 'anomalies.' + drop);
      }
      storageSet(INDEX_KEY, JSON.stringify(index));
    }
  }

  function listLocal(type, date) {
    var rows = parse(storageGet(KEY_PREFIX + type + '.' + date), []);
    return Array.isArray(rows) ? rows : [];
  }

  function writeLocal(type, date, rows) {
    noteDate(date);
    return storageSet(KEY_PREFIX + type + '.' + date, JSON.stringify(rows.slice(-MAX_RECORDS)));
  }

  function writeSnapshots(snapshots) {
    /* Snapshots are the "before" evidence; keep them in their own key so a
     * large day of records never evicts them.  Bounded per game. */
    return storageSet(SNAP_KEY, JSON.stringify(snapshots));
  }

  function readSnapshots() {
    var v = parse(storageGet(SNAP_KEY), {});
    return (v && typeof v === 'object') ? v : {};
  }

  /* ---------------------------------------------------------------- servers */

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

  /* The server store is append-only per (date, type).  A failed server write is
   * never fatal: the record is already in localStorage. */
  function flush(type) {
    Object.keys(pendingWrites).forEach(function (key) {
      var parts = key.split('|');
      var d = parts[0];
      var t = parts[1];
      var rows = pendingWrites[key];
      if (!rows) return;
      pendingWrites[key] = null;
      if (apiState.checked && !apiState.available) return;
      serverFetch('/api/scoring-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ v: 1, date: d, type: t, rows: rows }),
      }).then(function () {
        apiState.checked = true;
        apiState.available = true;
      }).catch(function (err) {
        apiState.checked = true;
        apiState.available = false;
        apiState.lastError = err;
      });
    });
  }

  function queueWrite(type, date, rows) {
    writeLocal(type, date, rows);
    pendingWrites[date + '|' + type] = rows;
    var key = date + '|' + type;
    if (saveTimers[key]) return;
    saveTimers[key] = setTimeout(function () {
      saveTimers[key] = null;
      flush(type);
    }, WRITE_COALESCE_MS);
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
        return data;
      })
      .catch(function (err) {
        apiState.checked = true;
        apiState.available = false;
        apiState.lastError = err;
        return null;
      });
  }

  /* --------------------------------------------------------------- records */

  /* Stable identity for a record so merging (local + server, or two tabs)
   * never double-counts.  Pending rows are one per at-bat; a change row is one
   * per at-bat per reclassification (an at-bat can be re-scored twice). */
  function pendingKey(row) {
    return row.gamePk + ':' + row.atBatIndex + ':pending';
  }
  function changeKey(row) {
    return row.gamePk + ':' + row.atBatIndex + ':change:' + (row.to && row.to.eventType) + ':' +
      (row.to && row.to.isOut ? '1' : '0');
  }
  function recordKey(type, row) {
    return type === 'pending' ? pendingKey(row) : type === 'changes' ? changeKey(row) : row.id;
  }

  /* Merge by key; the earliest observation wins for identity fields and the
   * latest observation wins for "what the API says now".  Nothing is dropped. */
  function mergeRows(existing, incoming, type) {
    var map = Object.create(null);
    var order = [];
    function take(row) {
      if (!row) return;
      var k = recordKey(type, row);
      if (!k) return;
      var prev = map[k];
      if (!prev) {
        map[k] = row;
        order.push(k);
        return;
      }
      var merged = Object.assign({}, prev, row);
      merged.firstSeen = Math.min(Number(prev.firstSeen) || Infinity, Number(row.firstSeen) || Infinity) || Date.now();
      merged.lastSeen = Math.max(Number(prev.lastSeen) || 0, Number(row.lastSeen) || 0);
      /* The before state is evidence: never overwrite it with a later read. */
      if (prev.before && !row.before) merged.before = prev.before;
      if (prev.before && row.before && prev.before.description) merged.before = prev.before;
      if (prev.resolution && !row.resolution) merged.resolution = prev.resolution;
      map[k] = merged;
    }
    (existing || []).forEach(take);
    (incoming || []).forEach(take);
    return order.map(function (k) { return map[k]; });
  }

  function table(date) {
    if (!tables[date]) {
      var t = emptyTable();
      t.pending = listLocal('pending', date);
      t.changes = listLocal('changes', date);
      t.anomalies = listLocal('anomalies', date);
      t.snapshots = readSnapshots();
      objectsFor(date);
      tables[date] = t;
    }
    return tables[date];
  }

  /* Rows are stored per date; the in-memory index lets the UI filter by game. */
  function objectsFor(date) {
    var t = tables[date];
    if (!t) return;
    t.byGame = Object.create(null);
    ['pending', 'changes', 'anomalies'].forEach(function (type) {
      t[type].forEach(function (row) {
        if (!row || !row.gamePk) return;
        t.byGame[row.gamePk] = t.byGame[row.gamePk] || { pending: [], changes: [], anomalies: [] };
        t.byGame[row.gamePk][type].push(row);
      });
    });
  }

  function addPending(date, row) {
    var t = table(date);
    t.pending = mergeRows(t.pending, [row], 'pending');
    objectsFor(date);
    queueWrite('pending', date, t.pending);
    emit(date, 'pending', row);
    return row;
  }

  function addChange(date, row) {
    var t = table(date);
    t.changes = mergeRows(t.changes, [row], 'changes');
    objectsFor(date);
    queueWrite('changes', date, t.changes);
    emit(date, 'changes', row);
    return row;
  }

  function addAnomaly(date, row) {
    var t = table(date);
    var key = row.id;
    if (t.anomalies.some(function (x) { return x.id === key; })) return null;
    t.anomalies.push(row);
    if (t.anomalies.length > MAX_RECORDS) t.anomalies = t.anomalies.slice(-MAX_RECORDS);
    objectsFor(date);
    queueWrite('anomalies', date, t.anomalies);
    emit(date, 'anomalies', row);
    return row;
  }

  /* ------------------------------------------------------- the capture loop */

  var state = {
    date: null,
    running: false,
    timer: null,
    due: Object.create(null),        // gamePk -> next full-read time
    leanDue: Object.create(null),    // gamePk -> next lean-read time
    lastAt: 0,
    captures: 0,
    reads: 0,
    errors: 0,
    inFlight: false,
  };

  function emit(date, type, row) {
    listeners.forEach(function (fn) {
      try { fn({ date: date, type: type, row: row }); } catch (e) { /* a listener must not break capture */ }
    });
  }

  function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }

  /* Read the current official classifications from a feed payload.  Completed
   * plays only: an at-bat that is still in progress has no final scoring to
   * compare yet, which is exactly why `os_ruling_pending_*` exists. */
  function classificationsOf(plays) {
    var map = Object.create(null);
    (plays || []).forEach(function (play) {
      var about = (play && play.about) || {};
      if (about.isComplete !== true) return;
      var c = Reviews.classificationOf(play);
      if (c.atBatIndex === undefined || isNaN(c.atBatIndex)) return;
      map[c.atBatIndex] = c;
    });
    return map;
  }

  function playCounters(play) {
    var res = (play && play.result) || {};
    var count = (play && play.count) || {};
    var about = (play && play.about) || {};
    var runners = [];
    ((play && play.runners) || []).forEach(function (r) {
      var d = (r && r.details) || {};
      if (d.isScoringEvent !== true) return;
      runners.push({
        runner: (d.runner && d.runner.fullName) || '',
        eventType: d.eventType || '',
        rbi: d.rbi === true,
        playIndex: d.playIndex,
      });
    });
    return {
      inning: about.inning || null,
      halfInning: about.halfInning || '',
      outs: typeof count.outs === 'number' ? count.outs : null,
      balls: typeof count.balls === 'number' ? count.balls : null,
      strikes: typeof count.strikes === 'number' ? count.strikes : null,
      scoringRunners: runners,
      rbi: typeof res.rbi === 'number' ? res.rbi : null,
      awayScore: typeof res.awayScore === 'number' ? res.awayScore : null,
      homeScore: typeof res.homeScore === 'number' ? res.homeScore : null,
    };
  }

  /* The exact official wording of a play, kept verbatim on both sides. */
  function wordingOf(play, classification) {
    var res = (play && play.result) || {};
    return {
      description: res.description || '',
      event: res.event || '',
      eventType: res.eventType || (classification && classification.eventType) || '',
      rbi: typeof res.rbi === 'number' ? res.rbi : null,
      awayScore: typeof res.awayScore === 'number' ? res.awayScore : null,
      homeScore: typeof res.homeScore === 'number' ? res.homeScore : null,
      isOut: res.isOut === true,
    };
  }

  /* Half-inning label, read from the play's own `about` block. */
  function inningLabelOf(play) {
    var about = (play && play.about) || {};
    var inning = about.inning;
    if (!inning) return '';
    var half = String(about.halfInning || (about.isTopInning === false ? 'bottom' : 'top')).toLowerCase();
    return (half.indexOf('top') === 0 ? 'Top ' : 'Bot ') + inning;
  }

  function labelFor(teams) {
    if (!teams) return '';
    var UI = global.UI;
    if (UI && UI.abbr) return UI.abbr(teams.away) + ' @ ' + UI.abbr(teams.home);
    return '';
  }

  function officialsOf(gameData) {
    var out = [];
    var officials = (gameData && gameData.officials) || [];
    officials.forEach(function (o) {
      var person = (o && o.official) || {};
      if (!person.id && !person.fullName) return;
      out.push({
        type: o.officialType || '',
        id: person.id || null,
        name: person.fullName || '',
        link: person.link || '',
      });
    });
    return out;
  }

  /**
   * ingestGame({ gamePk, teams, payload, capturedAt })
   *   One observation of one game.  Called by the page every second with the
   *   lean state read and every couple of seconds (or the moment the state
   *   signature changes) with the full play read.  Everything this function
   *   writes goes to THIS module's store only.
   */
  function ingestGame(date, obs) {
    if (!date || !obs || !obs.payload) return null;
    var payload = obs.payload;
    var gameData = payload.gameData || {};
    var liveData = payload.liveData || {};
    var playsWrap = liveData.plays || {};
    var plays = playsWrap.allPlays || payload.allPlays || [];
    var gamePk = obs.gamePk || (gameData.game && gameData.game.pk) || payload.gamePk;
    if (!gamePk) return null;
    var capturedAt = obs.capturedAt || Date.now();
    var t = table(date);
    var result = { gamePk: gamePk, pending: 0, changes: 0, anomalies: 0, stateCaptured: false };

    /* ---- 1. official live state, itemised, timestamped to the second ---- */
    if (obs.fullState) {
      t.snapshots[gamePk] = t.snapshots[gamePk] || {};
      var linescore = liveData.linescore || {};
      var lsTeams = linescore.teams || {};
      var current = playsWrap.currentPlay || {};
      var curAbout = current.about || {};
      var curResult = current.result || {};
      var curCount = current.count || {};
      var curMatch = current.matchup || {};
      var offense = linescore.offense || {};
      var defense = linescore.defense || {};
      var status = gameData.status || {};

      t.lastState = t.lastState || {};
      t.lastState[gamePk] = {
        capturedAt: capturedAt,
        capturedAtISO: new Date(capturedAt).toISOString(),
        officialTimeStamp: (payload.metaData && payload.metaData.timeStamp) || null,
        feedWaitSeconds: (payload.metaData && typeof payload.metaData.wait === 'number')
          ? payload.metaData.wait : null,
        status: {
          abstract: status.abstractGameState || '',
          coded: status.codedGameState || '',
          detailed: status.detailedState || '',
          statusCode: status.statusCode || '',
          reason: status.reason || '',
        },
        score: {
          away: (lsTeams.away && typeof lsTeams.away.runs === 'number') ? lsTeams.away.runs : null,
          home: (lsTeams.home && typeof lsTeams.home.runs === 'number') ? lsTeams.home.runs : null,
        },
        hits: {
          away: (lsTeams.away && typeof lsTeams.away.hits === 'number') ? lsTeams.away.hits : null,
          home: (lsTeams.home && typeof lsTeams.home.hits === 'number') ? lsTeams.home.hits : null,
        },
        errors: {
          away: (lsTeams.away && typeof lsTeams.away.errors === 'number') ? lsTeams.away.errors : null,
          home: (lsTeams.home && typeof lsTeams.home.errors === 'number') ? lsTeams.home.errors : null,
        },
        inning: {
          number: linescore.currentInning || null,
          ordinal: linescore.currentInningOrdinal || '',
          half: linescore.inningState || '',
          isTop: linescore.isTopInning === true,
          scheduled: linescore.scheduledInnings || null,
        },
        count: {
          balls: typeof linescore.balls === 'number' ? linescore.balls : (typeof curCount.balls === 'number' ? curCount.balls : null),
          strikes: typeof linescore.strikes === 'number' ? linescore.strikes : (typeof curCount.strikes === 'number' ? curCount.strikes : null),
          outs: typeof linescore.outs === 'number' ? linescore.outs : (typeof curCount.outs === 'number' ? curCount.outs : null),
        },
        batter: {
          id: (offense.batter && offense.batter.id) || (curMatch.batter && curMatch.batter.id) || null,
          name: (offense.batter && offense.batter.fullName) || (curMatch.batter && curMatch.batter.fullName) || '',
        },
        onDeck: { name: (offense.onDeck && offense.onDeck.fullName) || '' },
        onDeckTwo: { name: (offense.inHole && offense.inHole.fullName) || '' },
        pitcher: {
          id: (defense.pitcher && defense.pitcher.id) || (curMatch.pitcher && curMatch.pitcher.id) || null,
          name: (defense.pitcher && defense.pitcher.fullName) || (curMatch.pitcher && curMatch.pitcher.fullName) || '',
        },
        runners: {
          first: (offense.first && (offense.first.fullName || offense.first.id)) || null,
          second: (offense.second && (offense.second.fullName || offense.second.id)) || null,
          third: (offense.third && (offense.third.fullName || offense.third.id)) || null,
        },
        atBat: {
          atBatIndex: typeof curAbout.atBatIndex === 'number' ? curAbout.atBatIndex : null,
          isComplete: curAbout.isComplete === true,
          eventType: curResult.eventType || '',
          description: curResult.description || '',
        },
        completedPlays: Object.keys(classificationsOf(plays)).length,
        pitchCounts: (function () {
          /* Only what the payload publishes: per-team boxscore pitch totals are
           * NOT in this projection.  A pitcher's count is the number of
           * playEvents with isPitch on the at-bat in progress, which is what the
           * feed itself carries; the completed-play total is published as
           * `currentPlay.playEvents` cumulatively only in newer feeds, so only
           * the current at-bat figure is recorded and the field says so. */
          var events = (playsWrap.currentPlay && playsWrap.currentPlay.playEvents) || [];
          var n = 0;
          events.forEach(function (e) { if (e && e.isPitch === true) n += 1; });
          return { currentAtBatPitches: n };
        })(),
        officials: officialsOf(gameData),
        counters: {
          manager: Reviews.managerCounters(gameData.review || null),
          abs: Reviews.absCounters(gameData.absChallenges || null),
        },
        teams: obs.teams || {
          away: (gameData.teams && gameData.teams.away && gameData.teams.away.team) || null,
          home: (gameData.teams && gameData.teams.home && gameData.teams.home.team) || null,
        },
      };
      result.stateCaptured = true;
      writeSnapshots(t.snapshots);
    }

    /* ---- 2. pending official-scorer rulings ---- */
    (plays || []).forEach(function (play) {
      var res = (play && play.result) || {};
      var type = res.eventType || '';
      if (Reviews.PENDING_RULING_TYPES.indexOf(type) === -1) return;
      var about = (play && play.about) || {};
      var atBatIndex = Number(about.atBatIndex);
      if (isNaN(atBatIndex)) return;
      var prev = (t.pending || []).find(function (r) {
        return r.gamePk === gamePk && r.atBatIndex === atBatIndex;
      });
      var row = {
        id: gamePk + ':' + atBatIndex + ':pending',
        gamePk: gamePk,
        matchupLabel: labelFor(obs.teams),
        atBatIndex: atBatIndex,
        inning: about.inning || null,
        halfInning: about.halfInning || '',
        inningLabel: inningLabelOf(play),
        eventType: type,
        kindLabel: type === 'os_ruling_pending_primary' ? 'Primary event ruling pending' : 'Prior event ruling pending',
        officialWording: res.description || '',
        officialEvent: res.event || '',
        batter: (play.matchup && play.matchup.batter && play.matchup.batter.fullName) || '',
        pitcher: (play.matchup && play.matchup.pitcher && play.matchup.pitcher.fullName) || '',
        atBat: playCounters(play),
        capturedAt: capturedAt,
        capturedAtISO: new Date(capturedAt).toISOString(),
        observedFor: prev ? Math.max(0, capturedAt - (Number(prev.capturedAt) || capturedAt)) : 0,
        /* Both halves of the provenance: the event-type registry is where the
         * API defines this code, the feed is where this instance was observed. */
        source: 'event type ' + type + ' — defined by GET /api/v1/eventTypes ("Official Scorer Ruling Pending"); ' +
          'observed at GET /api/v1.1/game/' + gamePk + '/feed/live → liveData.plays.allPlays[].result.eventType',
        resolution: prev && prev.resolution ? prev.resolution : null,
        firstSeen: prev && prev.firstSeen ? prev.firstSeen : capturedAt,
        lastSeen: capturedAt,
      };
      /* Once resolved, stop re-writing it: the record becomes history. */
      if (prev && prev.resolution) {
        t.pending = t.pending.map(function (r) { return r === prev ? Object.assign({}, r, { lastSeen: capturedAt }) : r; });
        return;
      }
      addPending(date, row);
      result.pending += 1;
    });

    /* ---- 3. reclassifications, from the exact before/after state ---- */
    if (obs.fullState) {
      var nowMap = classificationsOf(plays);
      var prevMap = (t.snapshots[gamePk] && t.snapshots[gamePk].plays) || null;
      if (prevMap) {
        Object.keys(nowMap).forEach(function (key) {
          var before = prevMap[key];
          var after = nowMap[key];
          if (!before) return;
          var reclassified = before.eventType !== after.eventType ||
            before.isOut !== after.isOut ||
            (before.outs !== null && after.outs !== null && before.outs !== after.outs);
          var play = (plays || []).find(function (p) {
            return p && p.about && Number(p.about.atBatIndex) === Number(after.atBatIndex);
          });
          if (reclassified) {
            addChange(date, {
              id: gamePk + ':' + after.atBatIndex + ':change',
              gamePk: gamePk,
              matchupLabel: labelFor(obs.teams || before.teams),
              atBatIndex: after.atBatIndex,
              inningLabel: after.inningLabel || before.inningLabel,
              batter: after.batter || before.batter,
              before: before,
              to: after,
              beforeWording: before.wording || null,
              afterWording: play ? wordingOf(play, after) : null,
              detectedAt: capturedAt,
              detectedAtISO: new Date(capturedAt).toISOString(),
              observedSince: before.capturedAtISO || null,
              source: 'GET /api/v1.1/game/' + gamePk + '/feed/live → liveData.plays.allPlays[] (' +
                'result.eventType / result.isOut / count.outs) held from ' +
                (before.capturedAtISO || 'an earlier read') + ' and diffed at ' + new Date(capturedAt).toISOString(),
              attribution: 'Official scorer / Elias Sports Bureau / club review — ' +
                'mlb.com/official-information/scoring-changes (the payload carries no change marker)',
              firstSeen: capturedAt,
              lastSeen: capturedAt,
            });
            result.changes += 1;
          } else if (before.description !== after.description || before.rbi !== after.rbi ||
            before.awayScore !== after.awayScore || before.homeScore !== after.homeScore) {
            var anomaly = {
              id: gamePk + ':' + after.atBatIndex + ':edit:' + capturedAt,
              gamePk: gamePk,
              atBatIndex: after.atBatIndex,
              inningLabel: after.inningLabel || before.inningLabel,
              kind: 'edit',
              before: { description: before.description, rbi: before.rbi, awayScore: before.awayScore, homeScore: before.homeScore },
              after: { description: after.description, rbi: after.rbi, awayScore: after.awayScore, homeScore: after.homeScore },
              note: 'Official wording / RBI / score changed without a reclassification. Logged for review; nothing was corrected.',
              capturedAt: capturedAt,
              capturedAtISO: new Date(capturedAt).toISOString(),
              firstSeen: capturedAt,
              lastSeen: capturedAt,
            };
            if (addAnomaly(date, anomaly)) result.anomalies += 1;
          }
        });
        Object.keys(prevMap).forEach(function (key) {
          if (nowMap[key]) return;
          var gone = prevMap[key];
          var row = {
            id: gamePk + ':' + key + ':vanished:' + capturedAt,
            gamePk: gamePk,
            atBatIndex: Number(key),
            inningLabel: gone.inningLabel || '',
            kind: 'vanished',
            before: gone,
            after: null,
            note: 'Play ' + key + ' was observed as complete and then disappeared from the payload. Logged for review; nothing was corrected.',
            capturedAt: capturedAt,
            capturedAtISO: new Date(capturedAt).toISOString(),
            firstSeen: capturedAt,
            lastSeen: capturedAt,
          };
          if (addAnomaly(date, row)) result.anomalies += 1;
        });
      }
      /* Replace the stored classification table with this read, stamped. */
      var stamped = Object.create(null);
      Object.keys(nowMap).forEach(function (key) {
        var stampedPlay = (plays || []).find(function (p) {
          return p && p.about && Number(p.about.atBatIndex) === Number(nowMap[key].atBatIndex);
        });
        stamped[key] = Object.assign({}, nowMap[key], {
          capturedAt: capturedAt,
          capturedAtISO: new Date(capturedAt).toISOString(),
          wording: stampedPlay ? wordingOf(stampedPlay, nowMap[key]) : null,
        });
      });
      t.snapshots[gamePk] = { plays: stamped, capturedAt: capturedAt };
      writeSnapshots(t.snapshots);
    }

    /* ---- 4. close out pending rulings the scorer has decided ---- */
    if (obs.fullState) {
      var open = (t.pending || []).filter(function (r) {
        return r.gamePk === gamePk && !r.resolution;
      });
      if (open.length) {
        open.forEach(function (r) {
          /* Resolved = the at-bat no longer carries a pending event type and the
           * feed now exposes a completed classification for it. */
          var current = classificationsOf(plays)[r.atBatIndex];
          if (current && Reviews.PENDING_RULING_TYPES.indexOf(current.eventType) === -1) {
            var play = (plays || []).find(function (p) {
              return p && p.about && Number(p.about.atBatIndex) === Number(r.atBatIndex);
            });
            addPending(date, Object.assign({}, r, {
              resolution: {
                eventType: current.eventType,
                description: current.description,
                isOut: current.isOut,
                outs: current.outs,
                rbi: current.rbi,
                awayScore: current.awayScore,
                homeScore: current.homeScore,
                wording: play ? wordingOf(play, current) : null,
                observedAt: capturedAt,
                observedAtISO: new Date(capturedAt).toISOString(),
              },
              lastSeen: capturedAt,
            }));
            result.pending += 1;
          }
        });
      }
    }

    t.lastAt = capturedAt;
    state.captures += 1;
    return result;
  }

  /* ------------------------------------------------------------ capture loop
   *
   * A deliberately small, self-contained poller.  It runs on its own timer,
   * never touches the alert feed's scan timer, and stops whenever the tab is
   * hidden.  Cadence:
   *   - every CAPTURE_MS (1 s): the CHEAP state read for the game whose state
   *     signature is due, which is what makes the "state to the second" record;
   *   - every FULL_READ_MS (2 s), or immediately when a cheap read's signature
   *     changed: the full play read that drives pending/change detection.
   * Only live games are polled, and only by the tab holding the API leader
   * lease (see api.js) so two open tabs do not double the load.
   */

  function signatureOf(lean) {
    if (!lean) return '';
    var gd = lean.gameData || {};
    var ld = lean.liveData || {};
    var ls = ld.linescore || {};
    var cur = (ld.plays && ld.plays.currentPlay) || {};
    return [
      (lean.metaData && lean.metaData.timeStamp) || '',
      (gd.status && gd.status.statusCode) || '',
      (gd.status && gd.status.detailedState) || '',
      (ls.teams && ls.teams.away && ls.teams.away.runs) + '-' + (ls.teams && ls.teams.home && ls.teams.home.runs),
      ls.currentInning || '',
      ls.inningState || '',
      ls.balls + '-' + ls.strikes + '-' + ls.outs,
      (cur.about && cur.about.atBatIndex) || '',
      (cur.result && cur.result.eventType) || '',
      (ld.plays && Array.isArray(ld.plays.allPlays)) ? ld.plays.allPlays.length : '',
    ].join('|');
  }

  function isLive(game) {
    var s = (game && game.status) || {};
    return s.abstractGameState === 'Live' || /^[MN]/.test(s.statusCode || '') || s.statusCode === 'IH';
  }

  function start(date, gamesGetter) {
    if (state.running && state.date === date) return;
    stop();
    state.date = date;
    state.running = true;
    state.gamesGetter = gamesGetter;
    state.lastAt = Date.now();
    tick();
  }

  function stop() {
    state.running = false;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  }

  function setDate(date) {
    if (date && date !== state.date) {
      state.date = date;
      state.due = Object.create(null);
      state.leanDue = Object.create(null);
      lastSignatures = Object.create(null);
    }
  }

  function tick() {
    if (!state.running) return;
    state.timer = setTimeout(tick, CAPTURE_MS);
    if (state.inFlight) return;
    if (global.document && global.document.hidden) return;
    if (!state.date || !state.gamesGetter) return;
    if (MLB && MLB.isLeader && !MLB.isLeader()) return;

    var games = (state.gamesGetter() || []).filter(isLive);
    if (!games.length) return;
    var nowAt = Date.now();
    var date = state.date;

    /* Pick at most one game per tick, the one due soonest: a 15-game slate is
     * therefore observed every ~15 s per game at 1 s ticks, and the moment a
     * game's cheap signature changes it is promoted to a full read.  This keeps
     * the whole loop inside the request budget by construction. */
    var next = null;
    games.forEach(function (g) {
      var pk = g.gamePk;
      if (!state.leanDue[pk]) state.leanDue[pk] = 0;
      if (!state.due[pk]) state.due[pk] = 0;
      var leanDue = state.leanDue[pk];
      if (leanDue > nowAt) return;
      if (!next || leanDue < state.leanDue[next.gamePk]) next = g;
    });
    if (!next) return;

    var game = next;
    var gamePk = game.gamePk;
    state.inFlight = true;

    MLB.gameStateLean(gamePk, { ttl: 1000 })
      .then(function (lean) {
        if (date !== state.date) return null;
        state.reads += 1;
        state.leanDue[gamePk] = Date.now() + CAPTURE_MS;
        var teams = teamsOfLean(lean) || teamsOfGame(game);
        ingestGame(date, { gamePk: gamePk, teams: teams, payload: lean, capturedAt: Date.now(), fullState: true });

        var sig = signatureOf(lean);
        var changed = sig !== lastSignatures[gamePk];
        lastSignatures[gamePk] = sig;

        var fullDue = state.due[gamePk] || 0;
        if (!changed && Date.now() < fullDue) {
          return null;
        }
        state.due[gamePk] = Date.now() + FULL_READ_MS;
        return MLB.gameState(gamePk, { ttl: 1000 }).then(function (full) {
          if (date !== state.date) return null;
          state.reads += 1;
          return ingestGame(date, {
            gamePk: gamePk,
            teams: teamsOfLean(full) || teams,
            payload: full,
            capturedAt: Date.now(),
            fullState: true,
          });
        });
      })
      .catch(function () {
        state.errors += 1;
        /* A failed read is retried on the next tick; the alert path never sees
         * this module's errors. */
      })
      .then(function () {
        state.inFlight = false;
      });
  }

  function teamsOfLean(lean) {
    var gd = (lean && lean.gameData) || {};
    var teams = gd.teams;
    if (!teams) return null;
    return {
      away: (teams.away && teams.away.team) || null,
      home: (teams.home && teams.home.team) || null,
    };
  }

  function teamsOfGame(game) {
    if (!game || !game.teams) return null;
    return {
      away: (game.teams.away && game.teams.away.team) || null,
      home: (game.teams.home && game.teams.home.team) || null,
    };
  }

  /* --------------------------------------------------------------- queries */

  function rows(date, type) {
    var t = table(date);
    return (t[type] || []).slice().sort(function (a, b) { return (b.lastSeen || 0) - (a.lastSeen || 0); });
  }

  function forGame(date, gamePk) {
    var t = table(date);
    objectsFor(date);
    return (t.byGame && t.byGame[gamePk]) || { pending: [], changes: [], anomalies: [] };
  }

  function stateOf(date, gamePk) {
    var t = table(date);
    return (t.lastState && t.lastState[gamePk]) || null;
  }

  function load(date) {
    var t = table(date);
    return loadServer(date).then(function (remote) {
      if (!remote) return t;
      t.pending = mergeRows(t.pending, remote.pending || [], 'pending');
      t.changes = mergeRows(t.changes, remote.changes || [], 'changes');
      t.anomalies = mergeRows(t.anomalies, remote.anomalies || [], 'anomalies');
      writeLocal('pending', date, t.pending);
      writeLocal('changes', date, t.changes);
      writeLocal('anomalies', date, t.anomalies);
      objectsFor(date);
      return t;
    });
  }

  /* Unfinished "before" states older than SAVE_STALE_MS belong to an at-bat that
   * was abandoned (rain, replay overturning a half-inning).  Reported, never
   * silently applied — the UI says "before not observed" for those rows. */
  function staleSaves(date) {
    var t = table(date);
    var cutoff = Date.now() - SAVE_STALE_MS;
    return Object.keys(t.snapshots || {}).filter(function (gamePk) {
      var s = t.snapshots[gamePk];
      return s && s.capturedAt && s.capturedAt < cutoff;
    });
  }

  /* ------------------------------------------------------------- exporting */

  function toCSV(rowsIn, columns) {
    var cols = columns || [];
    function cell(v) {
      if (v === null || v === undefined) return '';
      var s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return [cols.join(',')].concat((rowsIn || []).map(function (r) {
      return cols.map(function (c) { return cell(r[c]); }).join(',');
    })).join('\n');
  }

  function exportPayload(date) {
    var t = table(date);
    return {
      v: 1,
      exportedAt: new Date().toISOString(),
      date: date,
      pending: t.pending,
      changes: t.changes,
      anomalies: t.anomalies,
      lastState: t.lastState || {},
      note: 'Official scoring log exported from Alert4. Pending rows are the API\'s os_ruling_pending_* ' +
        'event types; change rows hold the exact official before and after wording observed by this page.',
    };
  }

  function clearDate(date) {
    ['pending', 'changes', 'anomalies'].forEach(function (type) {
      storageRemove(KEY_PREFIX + type + '.' + date);
      pendingWrites[date + '|' + type] = [];
      writeLocal(type, date, []);
    });
    tables[date] = null;
    delete tables[date];
  }

  global.ScoringLog = {
    /* capture */
    start: start,
    stop: stop,
    setDate: setDate,
    ingestGame: ingestGame,
    isRunning: function () { return state.running; },
    /* queries */
    load: load,
    rows: rows,
    forGame: forGame,
    stateOf: stateOf,
    staleSaves: staleSaves,
    table: table,
    /* change feed */
    onChange: onChange,
    /* export */
    toCSV: toCSV,
    exportPayload: exportPayload,
    clearDate: clearDate,
    /* diagnostics */
    state: state,
    apiState: apiState,
    CAPTURE_MS: CAPTURE_MS,
    FULL_READ_MS: FULL_READ_MS,
    MAX_RECORDS: MAX_RECORDS,
    KEEP_DATES: KEEP_DATES,
  };
}(window));
