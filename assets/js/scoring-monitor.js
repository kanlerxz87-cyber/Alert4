/* ============================================================================
 * scoring-monitor.js — the OFFICIAL SCORING MONITOR writer.
 *
 * Observes exactly the same payload stream the alert feed already consumes
 * and mirrors every official-scoring moment into ScoringLog (the separate,
 * permanent log rendered by scoring.html):
 *
 *   kind 'pending'          — an at bat completed whose official outcome is
 *                             undecided (payload result.eventType
 *                             'os_ruling_pending_primary|prior', description
 *                             "Official Scorer Ruling Pending").
 *   kind 'pending_resolved' — a play that WAS pending in an earlier poll now
 *                             carries an official outcome.
 *   kind 'scoring_change'   — an already-scored play was reclassified by the
 *                             official scorer (hit ↔ error, out ↔ hit, …),
 *                             detected by diffing completed-play classifications
 *                             between polls (the payload carries no marker).
 *
 * Each entry stores the EXACT official wording before and after
 * (result.eventType / result.description / isOut / rbi / scores) verbatim
 * from the payload, plus the official score after the play and an
 * attribution note. Timestamped to the second (ts / firstSeen / lastSeen).
 *
 * HARD SEPARATION: this module only writes to ScoringLog (its own
 * localStorage keys + /api/scoring-log). It never touches feed-log.js,
 * never chimes, never renders. A failure here cannot disrupt alerts —
 * callers wrap every observe() call in try/catch.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var ScoringLog = global.ScoringLog;
  var Reviews = global.Reviews;

  var state = {
    date: null,
    entries: [],
    byId: Object.create(null),
    loadedDate: null,
  };

  function nowTs() { return Date.now(); }

  function entryKey(gamePk, atBatIndex) {
    return gamePk + ':' + atBatIndex + ':scoring';
  }

  function rebuildIndex() {
    state.byId = Object.create(null);
    state.entries.forEach(function (e) {
      if (e && e.id) state.byId[e.id] = e;
    });
  }

  function setEntries(entries) {
    state.entries = Array.isArray(entries) ? entries.filter(Boolean) : [];
    rebuildIndex();
  }

  /* Synchronous local restore for the observe hot path. The async server
   * copy merges on the next ScoringLog.load() (both sides union by id). */
  function adoptLocal(date) {
    try {
      var raw = global.localStorage && global.localStorage.getItem('mlbp.scoringlog.' + date);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (parsed && parsed.v === 1 && Array.isArray(parsed.entries)) setEntries(parsed.entries);
    } catch (e) { /* malformed local copy — start clean, never guess */ }
  }

  function switchDate(date) {
    state.date = date;
    state.entries = [];
    state.byId = Object.create(null);
    state.loadedDate = date;
    adoptLocal(date);
  }

  function ensureDate(date) {
    if (!date) return false;
    if (state.loadedDate !== date) switchDate(date);
    return true;
  }

  function upsert(entry) {
    var prev = entry.id ? state.byId[entry.id] : null;
    if (!prev) {
      entry.firstSeen = entry.firstSeen || nowTs();
      entry.lastSeen = nowTs();
      state.entries.push(entry);
      state.byId[entry.id] = entry;
      return true;
    }
    var merged = Object.assign({}, prev, entry);
    /* Immutable first-observation stamps win. */
    merged.firstSeen = Math.min(Number(prev.firstSeen) || nowTs(), Number(entry.firstSeen) || nowTs());
    merged.lastSeen = nowTs();
    /* The FIRST observed call is kept as `before` forever; `after` always
     * holds the latest official ruling. Every step is appended to `history`
     * so nothing — including intermediate rulings — is ever overwritten. */
    merged.before = prev.before || entry.before || null;
    merged.after = entry.after || prev.after || null;
    merged.history = prev.history || [];
    if (entry.historyStep) {
      var h = merged.history.slice();
      var lastStep = h.length ? h[h.length - 1] : null;
      var step = entry.historyStep;
      if (!lastStep || lastStep.fromType !== step.fromType || lastStep.toType !== step.toType || lastStep.at !== step.at) {
        h.push(step);
        merged.history = h.slice(-50);
      }
    }
    /* A resolved entry never reverts to pending. */
    if (prev.after && !entry.after) merged.after = prev.after;
    if (prev.outcome === 'Pending → Resolved' && entry.outcome === 'Pending') merged.outcome = prev.outcome;
    var index = state.entries.indexOf(prev);
    if (index >= 0) state.entries[index] = merged; else state.entries.push(merged);
    state.byId[entry.id] = merged;
    return false;
  }

  function trim() {
    if (state.entries.length <= 500) return;
    state.entries.sort(function (a, b) { return (Number(b.lastSeen) || 0) - (Number(a.lastSeen) || 0); });
    state.entries = state.entries.slice(0, 500);
    rebuildIndex();
  }

  function persist() {
    if (!state.date) return;
    trim();
    ScoringLog.save(state.date, { v: 1, date: state.date, savedAt: nowTs(), entries: state.entries.slice() });
  }

  function classificationFrom(play) {
    var c = Reviews.classificationOf(play);
    return {
      eventType: c.eventType,
      event: (play && play.result && play.result.event) || '',
      description: c.description,
      isOut: c.isOut,
      rbi: c.rbi,
      awayScore: c.awayScore,
      homeScore: c.homeScore,
    };
  }

  function scoreOfSides(c) {
    return (c && typeof c.awayScore === 'number' && typeof c.homeScore === 'number')
      ? { away: c.awayScore, home: c.homeScore } : null;
  }

  function matchup(teams) {
    if (!teams) return '';
    var awayAbbr = teams.away && teams.away.abbr ? teams.away.abbr : '';
    var homeAbbr = teams.home && teams.home.abbr ? teams.home.abbr : '';
    if (awayAbbr && homeAbbr) return awayAbbr + ' @ ' + homeAbbr;
    var awayName = teams.away && teams.away.name ? teams.away.name : 'Away';
    var homeName = teams.home && teams.home.name ? teams.home.name : 'Home';
    return awayName + ' @ ' + homeName;
  }

  /**
   * observe({ date, gamePk, teams, teamsAbbr, plays, diff, pending })
   *   diff:    Reviews.diffSnapshots(prev, snapshot) — only its `changes` are used
   *   pending: Reviews.pendingRulings(plays, meta)   — freshly observed pending rows
   */
  function observe(input) {
    var date = input && input.date;
    var gamePk = input && input.gamePk;
    if (!date || !gamePk) return { recorded: 0 };
    if (!ensureDate(date)) return { recorded: 0 };

    var teams = input.teams || null;
    var teamsAbbr = input.teamsAbbr || null;
    var label = matchup(teamsAbbr || teams);
    var recorded = 0;
    var ts = nowTs();

    /* ---- 1) newly observed pending rulings (at bats not yet scored) */
    var pendingRows = input.pending || [];
    var plays = input.plays || [];
    var byAtBat = Object.create(null);
    plays.forEach(function (p) {
      var abi = p && p.about && Number(p.about.atBatIndex);
      if (isFinite(abi)) byAtBat[abi] = p;
    });
    pendingRows.forEach(function (row) {
      var play = byAtBat[Number(row.atBatIndex)] || null;
      var before = play ? classificationFrom(play) : {
        eventType: row.eventType, event: '', description: row.description || '',
        isOut: null, rbi: null, awayScore: null, homeScore: null,
      };
      upsert({
        id: entryKey(gamePk, row.atBatIndex),
        kind: 'pending',
        gamePk: gamePk,
        officialDate: date,
        atBatIndex: Number(row.atBatIndex),
        inningLabel: row.inningLabel || '',
        batter: row.batter || '',
        pitcher: row.pitcher || '',
        matchupLabel: label,
        teams: teams,
        description: row.description || '',
        source: row.source || '',
        before: before,
        after: null,
        scoreBefore: scoreOfSides(before),
        scoreAfter: null,
        outcome: 'Pending',
        attribution: 'Undecided — the official scorer has not published the outcome yet.',
        history: [],
        ts: ts,
      });
      recorded += 1;
    });

    /* ---- 2) reclassifications (incl. pending → official outcome) */
    var changes = (input.diff && input.diff.changes) || [];
    changes.forEach(function (change) {
      var from = change.from || {};
      var to = change.to || {};
      var wasPending = /^os_ruling_pending_/.test(String(from.eventType || ''));
      var id = entryKey(gamePk, change.atBatIndex);
      var prev = state.byId[id] || null;
      upsert({
        id: id,
        kind: wasPending ? 'pending_resolved' : 'scoring_change',
        gamePk: gamePk,
        officialDate: date,
        atBatIndex: Number(change.atBatIndex),
        inningLabel: change.inningLabel || '',
        batter: change.batter || '',
        pitcher: (prev && prev.pitcher) || '',
        matchupLabel: label,
        teams: teams,
        description: 'Initial call: ' + (from.description || from.eventType || '—') +
          ' → Final ruling: ' + (to.description || to.eventType || '—'),
        source: 'Observed via diff of consecutive official play-by-play payloads (there is no scoring-change marker in the payload).',
        before: {
          eventType: from.eventType || '', event: from.event || '', description: from.description || '',
          isOut: from.isOut === true, rbi: typeof from.rbi === 'number' ? from.rbi : null,
          awayScore: typeof from.awayScore === 'number' ? from.awayScore : null,
          homeScore: typeof from.homeScore === 'number' ? from.homeScore : null,
        },
        after: {
          eventType: to.eventType || '', event: to.event || '', description: to.description || '',
          isOut: to.isOut === true, rbi: typeof to.rbi === 'number' ? to.rbi : null,
          awayScore: typeof to.awayScore === 'number' ? to.awayScore : null,
          homeScore: typeof to.homeScore === 'number' ? to.homeScore : null,
        },
        scoreBefore: scoreOfSides(from),
        scoreAfter: change.scoreAfter || scoreOfSides(to),
        outcome: wasPending ? 'Pending → Resolved' : 'Reclassified',
        attribution: change.attribution || 'Official scorer / Elias / club review — see mlb.com/official-information/scoring-changes',
        historyStep: {
          at: ts,
          fromType: from.eventType || '',
          toType: to.eventType || '',
          from: { eventType: from.eventType || '', description: from.description || '', isOut: from.isOut === true, rbi: typeof from.rbi === 'number' ? from.rbi : null, awayScore: from.awayScore, homeScore: from.homeScore },
          to: { eventType: to.eventType || '', description: to.description || '', isOut: to.isOut === true, rbi: typeof to.rbi === 'number' ? to.rbi : null, awayScore: to.awayScore, homeScore: to.homeScore },
        },
        ts: (prev && prev.ts) || ts,
      });
      recorded += 1;
    });

    if (recorded) persist();
    return { recorded: recorded };
  }

  function beginDate(date) {
    if (!date) return;
    if (state.loadedDate !== date) switchDate(date);
  }

  function all() { return state.entries.slice(); }

  function get(id) { return state.byId[id] || null; }

  global.ScoringMonitor = {
    beginDate: beginDate,
    observe: observe,
    all: all,
    get: get,
    entryKey: entryKey,
    /* test hook — replaces the in-memory store without touching persistence */
    _replaceEntries: setEntries,
    state: state,
  };
}(window));
