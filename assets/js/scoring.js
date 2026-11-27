/* ============================================================================
 * scoring.js — page logic for scoring.html (the official-scoring log)
 *
 * Two responsibilities, both deliberately OUTSIDE the alert system:
 *
 *   1. an INDEPENDENT capture loop (its own 2 s cadence, its own in-flight
 *      guard, its own store).  It uses the parser (`Reviews`) and the
 *      play-by-play projection, but it never imports reviews-feed.js, never
 *      plays a sound and never writes the alert feed's rows.  If it slows down,
 *      errors or is closed, the Replay Feed's alerts are untouched — and vice
 *      versa: opening this page alone still logs pending rulings and scoring
 *      changes.
 *
 *   2. the reader: two separate sections (pending rulings / scoring changes),
 *      each row showing the exact official wording before and after, the live
 *      state at each observation, and a second-precision timestamp.
 *
 * Persistence: scoring-log.js (localStorage per date + /api/scoring-log when
 * the Node server is running) — survives a refresh, a second tab and a restart
 * of the server, and is merged idempotently by record id.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var MLB = global.MLB;
  var UI = global.UI;
  var Reviews = global.Reviews;
  var ScoringLog = global.ScoringLog;
  var LiveState = global.LiveState;

  var CAPTURE_MS = 2000;
  var CAPTURE_CONCURRENCY = 4;
  var FINAL_GRACE_MS = 30 * 60 * 1000;
  var RENDER_MS = 1000;

  /* Same lean projection the Replay Feed uses: no boxscore, no rosters. */
  var CAPTURE_FIELDS = 'allPlays,about,atBatIndex,isComplete,inning,halfInning,isTopInning,isScoringPlay,' +
    'result,eventType,description,isOut,rbi,awayScore,homeScore,count,balls,strikes,outs,matchup,batter,id,fullName,pitcher,' +
    'playEvents,details,call,reviewDetails,isOverturned,inProgress,reviewType,challengeTeamId,runners,' +
    'isScoringEvent,playIndex,movement,index,isPitch,pitchNumber,hasOutcome';

  var state = {
    date: MLB.todayISO(),
    seq: 0,
    payload: null,
    games: [],
    live: Object.create(null),
    snapshots: Object.create(null),
    pendingSeen: Object.create(null),
    finalSeen: Object.create(null),
    nextDue: Object.create(null),
    scanning: false,
    lastCaptureAt: 0,
    lastError: null,
    timers: { capture: null, render: null },
    filter: 'all',
  };

  function $(id) { return document.getElementById(id); }

  function urlDate() {
    try {
      var params = new URLSearchParams(global.location.search || '');
      var d = params.get('date');
      return MLB.isValidISODate(d) ? d : null;
    } catch (e) { return null; }
  }

  function statusLine(text, isError) {
    var el = $('status-line');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-error', !!isError);
  }

  function syncUrl() {
    try {
      var url = new URL(global.location.href);
      if (url.searchParams.get('date') === state.date) return;
      url.searchParams.set('date', state.date);
      global.history.replaceState(null, '', url.toString());
    } catch (e) { /* ignore */ }
  }

  function syncNav() {
    var picker = $('date-picker');
    if (picker && picker.value !== state.date) picker.value = state.date;
    var label = $('date-label');
    if (label) label.textContent = MLB.formatDateLabel(state.date);
    var back = document.querySelector('a.btn[href^="index.html"]');
    if (back) back.setAttribute('href', 'index.html?date=' + encodeURIComponent(state.date));
    syncUrl();
  }

  /* ------------------------------------------------------------- capture --- */

  function flattenGames(payload) {
    var out = [];
    ((payload && payload.dates) || []).forEach(function (d) {
      (d.games || []).forEach(function (g) { out.push(g); });
    });
    return out;
  }

  function teamsOf(game) {
    return {
      away: {
        id: game.teams && game.teams.away && game.teams.away.team ? game.teams.away.team.id : null,
        name: game.teams && game.teams.away && game.teams.away.team ? game.teams.away.team.name : '',
      },
      home: {
        id: game.teams && game.teams.home && game.teams.home.team ? game.teams.home.team.id : null,
        name: game.teams && game.teams.home && game.teams.home.team ? game.teams.home.team.name : '',
      },
    };
  }

  function shouldCapture(game, now) {
    var status = (game.status && game.status.abstractGameState) || '';
    var pk = game.gamePk;
    if (status === 'Live') { state.nextDue[pk] = now + CAPTURE_MS; return true; }
    if (status === 'Final') {
      if (!state.finalSeen[pk]) state.finalSeen[pk] = now;
      if (now - state.finalSeen[pk] > FINAL_GRACE_MS) return false;
      if (now < (state.nextDue[pk] || 0)) return false;
      state.nextDue[pk] = now + 15000;
      return true;
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
          worker(item).then(function () { active -= 1; next(); });
        }
      }
      next();
    });
  }

  function summaryOf(snapshot) {
    if (!snapshot) return null;
    return {
      at: snapshot.at,
      atIso: snapshot.atIso,
      atClock: snapshot.atClock,
      inningLabel: snapshot.inningLabel,
      score: snapshot.score,
      outs: snapshot.outs,
      balls: snapshot.balls,
      strikes: snapshot.strikes,
      pitchCount: snapshot.pitchCount,
      pitcher: snapshot.pitcher,
      batter: snapshot.batter,
      detailedState: snapshot.detailedState,
    };
  }

  function playAt(plays, atBatIndex) {
    for (var i = 0; i < (plays || []).length; i += 1) {
      var play = plays[i];
      if (play && play.about && Number(play.about.atBatIndex) === Number(atBatIndex)) return play;
    }
    return null;
  }

  /* Turn one game's payload into scoring-log records (idempotent by id). */
  function recordsFromGame(game, payload, observedAt) {
    var plays = Reviews.playsOf(payload);
    var teams = teamsOf(game);
    var meta = { gamePk: game.gamePk, teams: teams, feed: payload };
    var matchup = (global.UI ? global.UI.abbr(teams.away) + ' @ ' + global.UI.abbr(teams.home) : '');
    var snapshot = LiveState ? LiveState.capture({
      gamePk: game.gamePk, teams: teams, game: game, payload: payload, at: observedAt,
    }) : null;
    var records = [];

    /* ---- pending rulings ------------------------------------------------- */
    var pending = Reviews.pendingRulings(plays, meta);
    var nowPending = Object.create(null);
    var seen = state.pendingSeen[game.gamePk] || Object.create(null);
    pending.forEach(function (row) {
      nowPending[row.id] = true;
      if (seen[row.id]) { seen[row.id].row = row; return; }
      seen[row.id] = { row: row, at: observedAt, snapshot: summaryOf(snapshot) };
      records.push({
        id: row.id,
        kind: 'pending',
        status: 'open',
        gamePk: game.gamePk,
        matchupLabel: matchup,
        inningLabel: row.inningLabel,
        atBatIndex: row.atBatIndex,
        batter: row.batter,
        pitcher: row.pitcher,
        at: observedAt,
        atIso: LiveState ? LiveState.isoOf(observedAt) : '',
        atClock: LiveState ? LiveState.clockOf(observedAt) : '',
        officialBefore: { eventType: row.eventType, description: row.description, score: row.score },
        wordingBefore: row.description,
        stateBefore: summaryOf(snapshot),
        source: row.source,
      });
    });
    Object.keys(seen).forEach(function (id) {
      if (nowPending[id]) return;
      var resolvedPlay = playAt(plays, seen[id].row.atBatIndex);
      var result = (resolvedPlay && resolvedPlay.result) || null;
      if (!result) return;
      var type = result.eventType || '';
      if (type === 'os_ruling_pending_primary' || type === 'os_ruling_pending_prior') return;
      records.push({
        id: id,
        kind: 'pending',
        status: 'resolved',
        gamePk: game.gamePk,
        matchupLabel: matchup,
        inningLabel: seen[id].row.inningLabel,
        atBatIndex: seen[id].row.atBatIndex,
        batter: seen[id].row.batter,
        pitcher: seen[id].row.pitcher,
        at: seen[id].at,
        atIso: seen[id].snapshot ? seen[id].snapshot.atIso : '',
        atClock: seen[id].snapshot ? seen[id].snapshot.atClock : '',
        officialBefore: { eventType: seen[id].row.eventType, description: seen[id].row.description },
        wordingBefore: seen[id].row.description,
        stateBefore: seen[id].snapshot,
        officialAfter: { eventType: type, description: result.description || '', score: snapshot ? snapshot.score : null },
        wordingAfter: result.description || '',
        stateAfter: summaryOf(snapshot),
        resolvedAt: observedAt,
        source: seen[id].row.source,
      });
      delete seen[id];
    });
    state.pendingSeen[game.gamePk] = seen;

    /* ---- official scoring changes --------------------------------------- */
    var nextSnapshots = Reviews.snapshotPlays(plays);
    var diff = Reviews.diffSnapshots(state.snapshots[game.gamePk], nextSnapshots);
    state.snapshots[game.gamePk] = nextSnapshots;
    diff.changes.forEach(function (change) {
      records.push({
        id: game.gamePk + ':' + change.atBatIndex + ':scoring-change',
        kind: 'change',
        status: 'changed',
        gamePk: game.gamePk,
        matchupLabel: matchup,
        inningLabel: change.inningLabel,
        atBatIndex: change.atBatIndex,
        batter: change.batter,
        at: observedAt,
        atIso: LiveState ? LiveState.isoOf(observedAt) : '',
        atClock: LiveState ? LiveState.clockOf(observedAt) : '',
        officialBefore: {
          eventType: change.from.eventType,
          description: change.from.description,
          isOut: change.from.isOut,
          outs: change.from.outs,
          rbi: change.from.rbi,
          awayScore: change.from.awayScore,
          homeScore: change.from.homeScore,
        },
        wordingBefore: change.from.description,
        stateBefore: summaryOf(snapshot),
        officialAfter: {
          eventType: change.to.eventType,
          description: change.to.description,
          isOut: change.to.isOut,
          outs: change.to.outs,
          rbi: change.to.rbi,
          awayScore: change.to.awayScore,
          homeScore: change.to.homeScore,
        },
        wordingAfter: change.to.description,
        stateAfter: summaryOf(snapshot),
        attribution: change.attribution,
      });
    });

    if (snapshot) state.live[game.gamePk] = { latest: snapshot, matchupLabel: matchup };
    return records;
  }

  function capture() {
    if (state.scanning) return;
    if (document.hidden) { scheduleCapture(CAPTURE_MS); return; }
    if (MLB.quietRemainingMs && MLB.quietRemainingMs() > 0) {
      scheduleCapture(Math.min(5000, Math.max(CAPTURE_MS, MLB.quietRemainingMs())));
      return;
    }
    var seq = state.seq;
    var date = state.date;
    state.scanning = true;
    MLB.slateStatus(date, { tag: 'scoring-sweep' })
      .then(function (payload) {
        if (seq !== state.seq || date !== state.date) return null;
        state.games = flattenGames(payload);
        var now = Date.now();
        var due = state.games.filter(function (g) { return shouldCapture(g, now); });
        if (!due.length) return null;
        var collected = [];
        return runLimited(due, CAPTURE_CONCURRENCY, function (game) {
          if (seq !== state.seq || date !== state.date) return Promise.resolve();
          return MLB.playByPlay(game.gamePk, { fields: CAPTURE_FIELDS, retries: 0, tag: 'scoring-pbp' })
            .then(function (gamePayload) {
              if (seq !== state.seq || date !== state.date) return;
              var observedAt = Date.now();
              collected = collected.concat(recordsFromGame(game, gamePayload, observedAt));
            })
            .catch(function () { /* one game failing must not stop the slate */ });
        }).then(function () {
          if (seq !== state.seq || date !== state.date) return;
          state.lastError = null;
          if (collected.length) {
            try { state.payload = ScoringLog.record(date, collected); } catch (e) { state.lastError = e; }
          }
          render();
          updateChrome();
        });
      })
      .catch(function (err) {
        if (seq !== state.seq || date !== state.date) return;
        state.lastError = err;
        updateChrome();
      })
      .then(function () {
        if (seq !== state.seq || date !== state.date) return;
        state.scanning = false;
        state.lastCaptureAt = Date.now();
        scheduleCapture(CAPTURE_MS);
      });
  }

  function scheduleCapture(delay) {
    clearTimeout(state.timers.capture);
    state.timers.capture = setTimeout(capture, delay);
  }

  /* -------------------------------------------------------------- render --- */

  function fmtCount(snapshot) {
    if (!snapshot) return '—';
    var balls = snapshot.balls === null || snapshot.balls === undefined ? '—' : snapshot.balls;
    var strikes = snapshot.strikes === null || snapshot.strikes === undefined ? '—' : snapshot.strikes;
    return balls + '-' + strikes;
  }

  function stateBlock(label, snapshot) {
    if (!snapshot) {
      return '<div class="score-state-row"><span class="score-state-label">' + UI.esc(label) + '</span>' +
        '<span class="score-state-text">Not observed (page opened after this moment).</span></div>';
    }
    var bits = [
      snapshot.inningLabel || '',
      LiveState ? LiveState.scoreText(snapshot.score) : '',
      (snapshot.outs === null || snapshot.outs === undefined ? '—' : snapshot.outs) + ' outs',
      fmtCount(snapshot) + ' count',
      snapshot.pitchCount ? (snapshot.pitchCount.pitcher === null ? '—' : snapshot.pitchCount.pitcher) +
        '/' + snapshot.pitchCount.total + ' pitches' : '',
      snapshot.pitcher && snapshot.pitcher.name ? 'P ' + snapshot.pitcher.name : '',
      snapshot.batter && snapshot.batter.name ? 'AB ' + snapshot.batter.name : '',
    ].filter(Boolean);
    return '<div class="score-state-row"><span class="score-state-label">' + UI.esc(label) + '</span>' +
      '<span class="score-state-text">' + UI.esc(bits.join(' · ')) + '</span></div>';
  }

  function officialBlock(official) {
    if (!official) return '<div class="score-state-text">—</div>';
    var bits = [];
    if (official.eventType) bits.push('eventType: ' + official.eventType);
    if (official.outs !== undefined && official.outs !== null) bits.push('outs: ' + official.outs);
    if (official.rbi !== undefined && official.rbi !== null) bits.push('RBI: ' + official.rbi);
    if (official.awayScore !== undefined && official.awayScore !== null) {
      bits.push('score: ' + official.awayScore + '–' + official.homeScore);
    }
    return '<div class="score-official-desc">' + UI.esc(official.description || '—') + '</div>' +
      (bits.length ? '<div class="score-official-fields">' + UI.esc(bits.join(' · ')) + '</div>' : '');
  }

  function recordRow(record) {
    var isPending = record.kind === 'pending';
    var resolved = record.status === 'resolved';
    var cls = 'score-row' + (isPending && !resolved ? ' is-open' : '');
    var link = 'game.html?gamePk=' + encodeURIComponent(record.gamePk) + '&date=' + encodeURIComponent(state.date);
    return '<article class="' + cls + '" data-id="' + UI.esc(record.id) + '">' +
      '<header class="score-row-head">' +
        '<a href="' + link + '"><b>' + UI.esc(record.matchupLabel || '') + '</b></a>' +
        '<span class="score-chip ' + (isPending ? (resolved ? 'is-resolved' : 'is-open') : 'is-changed') + '">' +
          (isPending ? (resolved ? 'Ruled' : 'Pending') : 'Reclassified') + '</span>' +
        '<span>' + UI.esc(record.inningLabel || '') + '</span>' +
        '<span>' + UI.esc(record.batter || '') + '</span>' +
        '<span class="score-when" title="' + UI.esc(record.atIso || '') + '">' +
          UI.esc(record.atClock || '') + '</span>' +
        '<a href="https://statsapi.mlb.com/api/v1/game/' + encodeURIComponent(record.gamePk) +
          '/playByPlay" target="_blank" rel="noopener">MLB API ↗</a>' +
      '</header>' +
      '<div class="score-io">' +
        '<div class="score-side">' +
          '<div class="score-side-head">Official wording — before</div>' +
          officialBlock(record.officialBefore) +
          stateBlock('State then', record.stateBefore) +
        '</div>' +
        '<div class="score-side">' +
          '<div class="score-side-head">Official wording — after</div>' +
          (record.officialAfter ? officialBlock(record.officialAfter)
            : '<div class="score-official-desc is-muted">' + (isPending
              ? 'Ruling not issued yet — the play is still unscored.'
              : 'Awaiting the official ruling.') + '</div>') +
          stateBlock('State then', record.stateAfter) +
        '</div>' +
      '</div>' +
      (record.attribution ? '<div class="score-attrib">' + UI.esc(record.attribution) + '</div>' : '') +
      '<div class="score-attrib">Source: ' + UI.esc(record.source || 'MLB StatsAPI') +
        ' · first observed ' + UI.esc(record.atIso || '') +
        ' · record id ' + UI.esc(record.id) + '</div>' +
    '</article>';
  }

  function render() {
    var payload = state.payload || ScoringLog.emptyPayload(state.date);
    var split = ScoringLog.split(payload);
    var open = split.pending.filter(function (r) { return r.status !== 'resolved'; }).length;
    var resolved = split.pending.length - open;
    var games = Object.create(null);
    split.pending.concat(split.changes).forEach(function (r) { games[r.gamePk] = true; });

    var tiles = [
      { n: open, label: 'Pending rulings', cls: 'is-open' },
      { n: resolved, label: 'Rulings resolved', cls: '' },
      { n: split.changes.length, label: 'Scoring changes', cls: '' },
      { n: Object.keys(games).length, label: 'Games affected', cls: '' },
    ];
    var stats = $('score-stats');
    if (stats) {
      stats.innerHTML = tiles.map(function (t) {
        return '<div class="stat-tile ' + t.cls + '"><div class="stat-num">' + t.n + '</div>' +
          '<div class="stat-label">' + UI.esc(t.label) + '</div></div>';
      }).join('');
    }

    var pendingEl = $('pending-list');
    if (pendingEl) {
      pendingEl.innerHTML = split.pending.length
        ? split.pending.map(recordRow).join('')
        : '<div class="feed-empty">No official-scoring pending rulings logged for this date yet. ' +
          'A pending ruling appears here the second the official payload marks an at-bat unscored ' +
          '(os_ruling_pending_primary / os_ruling_pending_prior).</div>';
    }

    var changesEl = $('changes-list');
    if (changesEl) {
      changesEl.innerHTML = split.changes.length
        ? split.changes.map(recordRow).join('')
        : '<div class="feed-empty">No official scoring changes logged for this date yet. ' +
          'Reclassifications (hit ↔ error, out ↔ hit, single ↔ double…) appear here with the ' +
          'initial call and the final ruling exactly as the API published them.</div>';
    }

    var pendingCount = $('pending-count');
    if (pendingCount) pendingCount.textContent = String(split.pending.length);
    var changeCount = $('change-count');
    if (changeCount) changeCount.textContent = String(split.changes.length);
  }

  function updateChrome() {
    var last = $('last-capture');
    if (last) {
      last.textContent = state.lastCaptureAt
        ? 'last capture ' + new Date(state.lastCaptureAt).toLocaleTimeString()
        : 'waiting for the first capture';
    }
    var store = $('store-note');
    if (store) {
      store.textContent = ScoringLog.state.available
        ? 'shared server log connected (/api/scoring-log) + this browser'
        : 'this browser (localStorage) — the shared server log is not running';
    }
    if (state.lastError) {
      statusLine('Capture problem: ' + (state.lastError.message || 'network error') + ' — retrying.', true);
    } else {
      var live = state.games.filter(function (g) { return g.status && g.status.abstractGameState === 'Live'; }).length;
      var lat = MLB.latencyStats ? MLB.latencyStats() : null;
      statusLine(state.games.length + ' game(s) on ' + MLB.formatDateLabel(state.date) +
        ' · ' + live + ' live · capturing every ' + (CAPTURE_MS / 1000) + 's, separate from the alert feed' +
        (lat && lat.count ? ' · API p50 ' + lat.p50 + 'ms' : ''));
    }
  }

  /* ---------------------------------------------------------------- page --- */

  function setDate(date) {
    var clean = MLB.isValidISODate(date) ? date : MLB.todayISO();
    if (clean === state.date) return;
    state.seq += 1;
    state.date = clean;
    state.payload = null;
    state.games = [];
    state.live = Object.create(null);
    state.snapshots = Object.create(null);
    state.pendingSeen = Object.create(null);
    state.finalSeen = Object.create(null);
    state.nextDue = Object.create(null);
    state.lastCaptureAt = 0;
    syncNav();
    render();
    ScoringLog.load(clean).then(function (payload) {
      state.payload = payload;
      render();
      updateChrome();
      capture();
    });
  }

  function exportJson() {
    var payload = state.payload || ScoringLog.emptyPayload(state.date);
    var blob = new global.Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = global.URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'official-scoring-log-' + state.date + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { global.URL.revokeObjectURL(url); }, 2000);
  }

  function init() {
    state.date = urlDate() || MLB.todayISO();
    syncNav();
    render();
    updateChrome();

    var picker = $('date-picker');
    if (picker) picker.addEventListener('change', function () {
      setDate(MLB.isValidISODate(picker.value) ? picker.value : state.date);
    });
    var refreshBtn = $('refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', function () { capture(); });
    var exportBtn = $('export-btn');
    if (exportBtn) exportBtn.addEventListener('click', exportJson);

    ScoringLog.onChange(function (payload) {
      if (payload && payload.date === state.date) { state.payload = payload; render(); }
    });
    /* Another tab's write lands here even while this tab is idle. */
    global.addEventListener('storage', function (evt) {
      if (!evt || String(evt.key || '').indexOf('mlbp.scoringlog.') !== 0) return;
      ScoringLog.load(state.date).then(function (payload) {
        state.payload = payload;
        render();
      });
    });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) capture();
    });

    state.timers.render = setInterval(updateChrome, RENDER_MS);

    ScoringLog.load(state.date).then(function (payload) {
      state.payload = payload;
      render();
      updateChrome();
      capture();
    });
    Reviews.loadRegistry();
  }

  global.ScoringPage = {
    init: init,
    prevDay: function () { setDate(MLB.shiftISODate(state.date, -1)); },
    nextDay: function () { setDate(MLB.shiftISODate(state.date, 1)); },
    today: function () { setDate(MLB.todayISO()); },
    setDate: setDate,
    refresh: function () { capture(); },
    exportJson: exportJson,
    state: state,
    capture: capture,
    recordsFromGame: recordsFromGame,
    CAPTURE_MS: CAPTURE_MS,
    CAPTURE_FIELDS: CAPTURE_FIELDS,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}(window));
