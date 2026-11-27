/* ============================================================================
 * scoring-page.js — the Official Scoring Monitor (scoring.html).
 *
 * Loads the persistent scoring log (scoring-log.js — localStorage always,
 * /api/scoring-log when served), merges it idempotently, renders the pending
 * rulings and official scoring changes with before/after official wording,
 * and polls for changes every 2.5s (plus an SSE push channel when the server
 * store is available). NEVER chimes, notifies, or touches feed-log.js — this
 * page is deliberately independent of the alert system.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var MLB = global.MLB;
  var UI = global.UI;
  var ScoringLog = global.ScoringLog;

  var POLL_MS = 2500;

  var state = {
    date: MLB.todayISO(),
    dateSeq: 0,
    filter: 'all',
    entries: [],
    signature: '',
    timer: null,
    loading: false,
  };

  function $(id) { return document.getElementById(id); }

  function urlDate() {
    try {
      var params = new URLSearchParams(global.location.search || '');
      var d = params.get('date');
      return MLB.isValidISODate(d) ? d : null;
    } catch (e) { return null; }
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
    syncUrl();
  }

  function statusLine(text, isError) {
    var el = $('status-line');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-error', !!isError);
  }

  function timeLabel(ts) {
    return UI.formatTimestampSeconds ? UI.formatTimestampSeconds(ts) : new Date(Number(ts) || 0).toLocaleTimeString();
  }

  /* Resolve pending rows whose id now carries an official outcome. */
  function decorate(entries) {
    var resolvedIds = Object.create(null);
    entries.forEach(function (e) {
      if (e && e.after && (e.kind === 'pending_resolved' || e.kind === 'scoring_change')) resolvedIds[e.id] = e;
    });
    return entries.map(function (e) {
      if (e && e.kind === 'pending' && resolvedIds[e.id]) {
        var resolved = resolvedIds[e.id];
        return Object.assign({}, e, {
          outcome: 'Pending → Resolved',
          resolvedEventType: resolved.after && resolved.after.eventType,
          resolvedDescription: resolved.after && resolved.after.description,
          resolvedAt: resolved.lastSeen,
        });
      }
      return e;
    });
  }

  var TABS = [
    { id: 'all', label: 'All' },
    { id: 'pending', label: '⏳ Pending' },
    { id: 'resolved', label: '✅ Resolved' },
    { id: 'changes', label: '✏️ Scoring changes' },
  ];

  function matches(entry, filter) {
    if (!entry) return false;
    if (filter === 'all') return entry.kind === 'pending' || entry.kind === 'scoring_change' || entry.kind === 'pending_resolved';
    if (filter === 'pending') return entry.kind === 'pending' && entry.outcome === 'Pending';
    if (filter === 'resolved') return entry.kind === 'pending_resolved' || (entry.kind === 'pending' && entry.outcome !== 'Pending');
    if (filter === 'changes') return entry.kind === 'scoring_change';
    return true;
  }

  function signatureOf(entries) {
    return state.filter + '|' + entries.map(function (e) {
      return [e.id, e.lastSeen, e.outcome, e.after ? e.after.eventType : ''].join(':');
    }).join('|');
  }

  function counts(entries) {
    var c = { pending: 0, resolved: 0, changes: 0, total: 0 };
    entries.forEach(function (e) {
      c.total += 1;
      if (e.kind === 'pending') {
        if (e.outcome === 'Pending') c.pending += 1; else c.resolved += 1;
      } else if (e.kind === 'pending_resolved') c.resolved += 1;
      else if (e.kind === 'scoring_change') c.changes += 1;
    });
    return c;
  }

  function renderStats() {
    var el = $('scoring-stats');
    if (!el) return;
    var c = counts(state.entries);
    var tiles = [
      { n: c.pending, label: 'Pending rulings', cls: '' },
      { n: c.resolved, label: 'Resolved', cls: '' },
      { n: c.changes, label: 'Scoring changes', cls: '' },
      { n: c.total, label: 'Total logged', cls: '' },
    ];
    el.innerHTML = tiles.map(function (t) {
      return '<div class="stat-tile ' + t.cls + '"><div class="stat-num">' + t.n + '</div>' +
        '<div class="stat-label">' + UI.esc(t.label) + '</div></div>';
    }).join('');
  }

  function renderTabs() {
    var nav = $('scoring-tabs');
    if (!nav) return;
    nav.innerHTML = TABS.map(function (t) {
      var count = state.entries.filter(function (e) { return matches(e, t.id); }).length;
      return '<button class="tab-btn' + (state.filter === t.id ? ' tab-on' : '') + '" data-filter="' + t.id + '">' +
        UI.esc(t.label) + (count ? ' <span class="tab-badge">' + count + '</span>' : '') + '</button>';
    }).join('');
  }

  function sideChip(label, score) {
    if (!score || typeof score.away !== 'number') return '';
    return UI.chip(label + ' ' + score.away + '–' + score.home, 'chip-scoring');
  }

  function renderWordingBlock(label, side) {
    if (!side) return '';
    var scorePart = (typeof side.awayScore === 'number' && typeof side.homeScore === 'number')
      ? ' · score ' + side.awayScore + '–' + side.homeScore : '';
    var rbiPart = typeof side.rbi === 'number' ? ' · ' + side.rbi + ' RBI' : '';
    var outPart = side.isOut === true ? ' · out recorded' : ' · no out';
    return '<div class="feed-sub"><strong>' + UI.esc(label) + ':</strong> ' +
      '<code>' + UI.esc(side.eventType || '—') + '</code>' +
      (side.description ? ' — ' + UI.esc(side.description) : '') +
      '<span class="counter-note">' + UI.esc(scorePart + rbiPart + outPart) + '</span></div>';
  }

  function renderRow(entry) {
    var isPending = entry.kind === 'pending' && entry.outcome === 'Pending';
    var resolvedPending = entry.kind === 'pending' && entry.outcome !== 'Pending';
    var avatar = entry.kind === 'scoring_change' ? '✏️' : (isPending ? '⏳' : '✅');
    var cls = 'feed-row scoring-row';
    if (isPending) cls += ' is-live';

    var chips = [];
    if (entry.kind === 'scoring_change') chips.push(UI.chip('Reclassified', 'chip-scoring'));
    else if (isPending) chips.push(UI.chip('Ruling pending', 'chip-warn'));
    else chips.push(UI.chip('Pending → Resolved', 'chip-ok'));
    if (entry.before && entry.before.eventType) chips.push(UI.chip(entry.before.eventType, 'chip-review'));
    if (entry.after && entry.after.eventType) chips.push(UI.chip('→ ' + entry.after.eventType, 'chip-ok'));

    var timeStr = timeLabel(entry.ts || entry.firstSeen || entry.lastSeen);

    var trackHtml = '<dl class="score-track">' +
      (entry.scoreBefore ? '<dt>Before play</dt><dd>' + UI.esc(entry.scoreBefore.away) + '–' + UI.esc(entry.scoreBefore.home) + '</dd>' : '') +
      (entry.scoreAfter ? '<dt>After play</dt><dd>' + UI.esc(entry.scoreAfter.away) + '–' + UI.esc(entry.scoreAfter.home) + '</dd>' : '') +
      '</dl>';

    return '<div class="' + cls + '">' +
      '<div class="feed-avatar">' + avatar + '</div>' +
      '<div class="feed-body">' +
        '<div class="feed-top">' +
          '<a href="game.html?gamePk=' + encodeURIComponent(entry.gamePk) + '&date=' + encodeURIComponent(state.date) + '"><b>' + UI.esc(entry.matchupLabel || '') + '</b></a>' +
          (entry.inningLabel ? '<span>' + UI.esc(entry.inningLabel) + '</span>' : '') +
          '<span title="Captured to the second">' + UI.esc(timeStr) + '</span>' +
          (entry.atBatIndex !== undefined && entry.atBatIndex !== null ? '<span>AB #' + UI.esc(entry.atBatIndex) + '</span>' : '') +
          '<a href="https://statsapi.mlb.com/api/v1/game/' + encodeURIComponent(entry.gamePk) + '/playByPlay" target="_blank" rel="noopener" title="Official MLB StatsAPI play-by-play source">MLB API ↗</a>' +
        '</div>' +
        (entry.batter || entry.pitcher
          ? '<div class="feed-title">' + UI.esc((entry.batter || '') + (entry.pitcher ? ' vs ' + entry.pitcher : '')) + '</div>'
          : '') +
        renderWordingBlock(entry.kind === 'pending' ? 'Official wording (pending)' : 'Initial call (official)', entry.before) +
        (entry.after
          ? renderWordingBlock('Final ruling (official)', entry.after)
          : (resolvedPending && entry.resolvedDescription
            ? '<div class="feed-sub"><strong>Final ruling (official):</strong> <code>' + UI.esc(entry.resolvedEventType || '') + '</code> — ' + UI.esc(entry.resolvedDescription) + '</div>'
            : '<div class="feed-sub"><strong>Final ruling:</strong> not published yet — awaiting the official scorer.</div>')) +
        (entry.description && entry.kind === 'scoring_change' ? '<div class="feed-sub">' + UI.esc(entry.description) + '</div>' : '') +
        trackHtml +
        (entry.attribution ? '<div class="feed-irregular">Attribution: ' + UI.esc(entry.attribution) + '</div>' : '') +
        (entry.source ? '<div class="feed-irregular">Source: ' + UI.esc(entry.source) + '</div>' : '') +
        '<div class="feed-chips">' + chips.join('') + '</div>' +
      '</div>' +
    '</div>';
  }

  function render() {
    renderStats();
    renderTabs();
    var list = $('scoring-list');
    if (!list) return;
    var rows = state.entries.filter(function (e) { return matches(e, state.filter); })
      .sort(function (a, b) { return (Number(b.lastSeen) || 0) - (Number(a.lastSeen) || 0); });
    if (!rows.length) {
      list.innerHTML = '<div class="feed-empty">No official-scoring entries for ' + UI.esc(MLB.formatDateLabel(state.date)) +
        ' yet. Pending rulings and scoring changes are logged here the moment the official payload publishes them.' +
        ' The monitor fills in as games are played — open this page from the replay feed after any scoring play.</div>';
      return;
    }
    list.innerHTML = rows.map(renderRow).join('');
  }

  function renderIfChanged(entries) {
    var sig = signatureOf(entries);
    if (sig === state.signature) return;
    state.signature = sig;
    state.entries = entries;
    render();
  }

  function showPersistenceNote() {
    var dot = $('live-dot');
    if (dot) dot.style.opacity = 1;
    var server = ScoringLog && ScoringLog.state && ScoringLog.state.available;
    statusLine((server ? 'shared server log connected' : 'local log only (GitHub Pages has no backend)') +
      ' · ' + state.entries.length + ' entr' + (state.entries.length === 1 ? 'y' : 'ies') +
      ' for ' + MLB.formatDateLabel(state.date));
  }

  function refresh() {
    if (state.loading) return Promise.resolve();
    state.loading = true;
    var seq = state.dateSeq;
    var date = state.date;
    return ScoringLog.load(date).then(function (payload) {
      state.loading = false;
      if (seq !== state.dateSeq || date !== state.date) return;
      var entries = decorate((payload && payload.entries) || []);
      renderIfChanged(entries);
      showPersistenceNote();
    }).catch(function (err) {
      state.loading = false;
      statusLine('Could not load the scoring log: ' + ((err && err.message) || 'unknown error'), true);
    });
  }

  function setDate(date) {
    var clean = MLB.isValidISODate(date) ? date : MLB.todayISO();
    if (clean === state.date) return;
    state.dateSeq += 1;
    state.date = clean;
    state.entries = [];
    state.signature = '';
    syncNav();
    ScoringLog.closeStream();
    refresh().then(function () {
      ScoringLog.openStream(clean);
    });
  }

  function exportJSON() {
    ScoringLog.load(state.date).then(function (payload) {
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'official-scoring-' + state.date + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    }).catch(function () { /* ignore */ });
  }

  function init() {
    state.date = urlDate() || MLB.todayISO();
    syncNav();

    ScoringLog.onChange(function (pushed) {
      if (!pushed || pushed.date !== state.date) return;
      var entries = decorate(pushed.entries || []);
      renderIfChanged(entries);
      showPersistenceNote();
    });

    $('prev-day-btn').addEventListener('click', function () { setDate(MLB.shiftISODate(state.date, -1)); });
    $('next-day-btn').addEventListener('click', function () { setDate(MLB.shiftISODate(state.date, 1)); });
    $('today-btn').addEventListener('click', function () { setDate(MLB.todayISO()); });
    $('date-picker').addEventListener('change', function () {
      var value = $('date-picker').value;
      setDate(MLB.isValidISODate(value) ? value : state.date);
    });
    $('export-btn').addEventListener('click', exportJSON);
    $('refresh-btn').addEventListener('click', function () { refresh(); });

    var tabs = $('scoring-tabs');
    if (tabs) {
      tabs.addEventListener('click', function (evt) {
        var btn = evt.target.closest('[data-filter]');
        if (btn) {
          state.filter = btn.getAttribute('data-filter');
          state.signature = ''; /* force re-render on filter change */
          renderIfChanged(state.entries);
        }
      });
    }

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) refresh();
    });

    refresh().then(function () {
      ScoringLog.openStream(state.date);
    });
    state.timer = setInterval(refresh, POLL_MS);
  }

  global.ScoringPage = { init: init, setDate: setDate, refresh: refresh, exportJSON: exportJSON, state: state };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}(window));
