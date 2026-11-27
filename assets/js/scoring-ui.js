/* ============================================================================
 * scoring-ui.js — the "Official Scoring" section on reviews.html
 *
 * Renders what scoring-log.js has persisted.  It is a separate script with a
 * separate element tree, a separate sound switch and a separate poll loop, so
 * the alert feed keeps running if anything here fails (and vice versa).
 *
 * Row types
 *   pending  an at-bat the API has not classified yet — exact official wording
 *   change   a reclassification, with the initial call and the final ruling
 *   log      append-only activity trail (what was seen, when, in what order)
 * ==========================================================================*/
(function (global) {
  'use strict';

  var UI = global.UI;
  var MLB = global.MLB;
  var Log = global.ScoringLog;
  var GameState = global.GameState;

  var state = {
    date: MLB.todayISO(),
    tab: 'all',
    open: true,
    lastError: null,
    lastRender: '',
  };

  function $(id) { return document.getElementById(id); }

  function esc(v) { return UI && UI.esc ? UI.esc(v) : String(v === undefined || v === null ? '' : v); }

  function clockOf(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString();
  }

  function shortClock(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function inningLabel(row) {
    if (!row || !row.inning) return '';
    var half = String(row.halfInning || '').toLowerCase().indexOf('top') === 0 ? 'Top' : 'Bot';
    return half + ' ' + row.inning;
  }

  function chip(text, cls, title) { return UI.chip(text, cls, title); }

  function pendingRow(row) {
    return '<div class="scoring-row is-pending">' +
      '<div class="scoring-avatar">📝</div>' +
      '<div class="scoring-body">' +
        '<div class="scoring-top">' +
          '<a href="game.html?gamePk=' + encodeURIComponent(row.gamePk) + '&date=' + encodeURIComponent(state.date) + '"><b>' + esc(row.matchupLabel) + '</b></a>' +
          '<span>' + esc(inningLabel(row)) + '</span>' +
          '<span>first seen ' + esc(shortClock(row.firstSeen ? new Date(row.firstSeen).toISOString() : '')) + '</span>' +
          '<a href="https://statsapi.mlb.com/api/v1/game/' + encodeURIComponent(row.gamePk) + '/playByPlay" target="_blank" rel="noopener">MLB API ↗</a>' +
        '</div>' +
        '<div class="scoring-title">' + esc(row.officialWording || row.eventType) + '</div>' +
        (row.description ? '<div class="scoring-sub">Official wording as published: “' + esc(row.description) + '”</div>' : '') +
        (row.batter ? '<div class="scoring-sub">At bat: ' + esc(row.batter) + (row.pitcher ? ' vs ' + esc(row.pitcher) : '') + '</div>' : '') +
        '<div class="scoring-sub mono">eventType: ' + esc(row.eventType) +
          (row.score ? ' · score ' + esc(row.score.away) + '–' + esc(row.score.home) : '') +
          ' · atBatIndex ' + esc(row.atBatIndex) + '</div>' +
        '<div class="scoring-chips">' + chip(row.status === 'pending' ? 'Pending' : 'Resolved', row.status === 'pending' ? 'chip-warn' : 'chip-ok') +
          chip('Official scoring', 'chip-scoring') + '</div>' +
      '</div>' +
    '</div>';
  }

  function changeRow(row) {
    var first = row.firstObserved || {};
    var prev = row.previous || {};
    var now = row.official || {};
    return '<div class="scoring-row is-change">' +
      '<div class="scoring-avatar">✏️</div>' +
      '<div class="scoring-body">' +
        '<div class="scoring-top">' +
          '<a href="game.html?gamePk=' + encodeURIComponent(row.gamePk) + '&date=' + encodeURIComponent(state.date) + '"><b>' + esc(row.matchupLabel) + '</b></a>' +
          '<span>' + esc(inningLabel(row)) + '</span>' +
          '<span>recorded ' + esc(shortClock(row.firstSeen ? new Date(row.firstSeen).toISOString() : '')) + '</span>' +
          '<a href="https://statsapi.mlb.com/api/v1/game/' + encodeURIComponent(row.gamePk) + '/playByPlay" target="_blank" rel="noopener">MLB API ↗</a>' +
        '</div>' +
        '<div class="scoring-title">' + esc(row.batter || ('At-bat ' + row.atBatIndex)) + ' — ' +
          esc(first.eventType || '?') + ' → ' + esc(now.eventType || '?') + '</div>' +
        '<table class="scoring-before-after"><thead><tr><th></th><th>Initial call (observed ' +
          esc(shortClock(first.observedAt)) + ')</th><th>Final ruling (published)</th></tr></thead><tbody>' +
          '<tr><th>Official wording</th><td>' + esc(first.description || '—') + '</td><td>' + esc(now.description || '—') + '</td></tr>' +
          '<tr><th>Classification</th><td><code>' + esc(first.eventType || '—') + '</code></td><td><code>' + esc(now.eventType || '—') + '</code></td></tr>' +
          '<tr><th>Out</th><td>' + esc(String(first.isOut === true)) + '</td><td>' + esc(String(now.isOut === true)) + '</td></tr>' +
          '<tr><th>Score after</th><td>' + esc((first.awayScore !== null && first.awayScore !== undefined) ? first.awayScore + '–' + first.homeScore : '—') +
            '</td><td>' + esc((now.awayScore !== null && now.awayScore !== undefined) ? now.awayScore + '–' + now.homeScore : '—') + '</td></tr>' +
        '</tbody></table>' +
        '<div class="scoring-sub">' + esc(row.attribution || '') + '</div>' +
        '<div class="scoring-chips">' + chip('Scoring change', 'chip-scoring') +
          chip('Before / after captured', 'chip-review') + '</div>' +
      '</div>' +
    '</div>';
  }

  function logRow(ev) {
    return '<div class="scoring-log-row">' +
      '<span class="mono">' + esc(shortClock(ev.at ? new Date(ev.at).toISOString() : '')) + '</span>' +
      '<span class="scoring-log-kind ' + (ev.kind === 'change' ? 'is-change' : 'is-pending') + '">' + (ev.kind === 'change' ? 'change' : 'pending') + '</span>' +
      '<span>' + esc(ev.text) + '</span>' +
      '<span class="scoring-log-game">' + esc(ev.matchupLabel || '') + '</span>' +
    '</div>';
  }

  function visible(day) {
    var rows = (day && day.rows) || [];
    var events = (day && day.events) || [];
    if (state.tab === 'pending') return rows.filter(function (r) { return r.kind === 'pending'; });
    if (state.tab === 'change') return rows.filter(function (r) { return r.kind === 'change'; });
    if (state.tab === 'log') return events;
    return rows;
  }

  function render() {
    var list = $('scoring-list');
    var empty = $('scoring-empty');
    if (!list) return;
    var day = Log.dayFor(state.date);
    var rows = visible(day);
    var sig = state.date + '|' + state.tab + '|' + rows.length + '|' +
      rows.map(function (r) { return r.id + ':' + (r.lastSeen || r.at || 0); }).join(',');
    if (sig === state.lastRender) { updateStatus(day); return; }
    state.lastRender = sig;

    if (!rows.length) {
      list.innerHTML = '';
      if (empty) { empty.hidden = false; empty.style.display = ''; }
    } else {
      if (empty) { empty.hidden = true; empty.style.display = 'none'; }
      list.innerHTML = rows.map(function (row) {
        if (state.tab === 'log' || row.kind === 'pending-log') return logRow(row);
        if (row.kind === 'change') return changeRow(row);
        return pendingRow(row);
      }).join('');
    }
    updateStatus(day);
  }

  function updateStatus(day) {
    var el = $('scoring-status');
    if (!el) return;
    var rows = (day && day.rows) || [];
    var pending = rows.filter(function (r) { return r.kind === 'pending' && r.status === 'pending'; }).length;
    var changes = rows.filter(function (r) { return r.kind === 'change'; }).length;
    var storage = Log.serverState.available ? 'shared store' : 'this browser';
    var loop = Log.loop;
    var bits = [
      pending + ' pending',
      changes + ' change' + (changes === 1 ? '' : 's'),
      'saved to ' + storage,
      'scanning every ' + (Log.POLL_MS / 1000).toFixed(0) + 's',
      loop.lastPollAt ? 'last scan ' + new Date(loop.lastPollAt).toLocaleTimeString() : 'waiting for first scan',
    ];
    if (loop.error) bits.push('scan problem: ' + (loop.error.message || 'network'));
    el.textContent = bits.join(' · ');
    el.classList.toggle('is-error', !!loop.error);
  }

  /* --------------------------------------------------------------- controls */

  function setTab(tab) {
    state.tab = tab;
    state.lastRender = '';
    var nav = $('scoring-tabs');
    if (nav) {
      Array.prototype.forEach.call(nav.querySelectorAll('[data-scoring-tab]'), function (b) {
        b.classList.toggle('tab-on', b.getAttribute('data-scoring-tab') === tab);
      });
    }
    render();
  }

  function toggleSound() {
    var on = !Log.prefs.sound;
    Log.setSound(on);
    var btn = $('scoring-sound-btn');
    if (btn) {
      btn.textContent = on ? '🔊 Scoring sound on' : '🔇 Scoring sound off';
      btn.classList.toggle('btn-on', on);
    }
    if (on && global.Chime) global.Chime.play('scoring', { force: true });
  }

  function testSound() {
    if (!global.Chime) return;
    global.Chime.setEnabled('scoring', true);
    global.Chime.test('scoring');
  }

  function rescan() {
    Log.scan(state.date, onUpdate, true).then(render);
  }

  function onUpdate(applied) {
    state.lastRender = '';
    onNewEvents(applied);
    render();
  }

  function setDate(date) {
    if (!MLB.isValidISODate(date)) return;
    state.date = date;
    state.lastRender = '';
    Log.setDate(date, function (applied) {
      state.lastRender = '';
      onNewEvents(applied);
      render();
    });
    render();
  }

  /* The section's own sound: one rain drop per *new* logged event, gated by the
   * scoring player's own cooldown (Chime handles that).  Never touches the
   * alert player. */
  function onNewEvents(applied) {
    if (!applied || !applied.rows || !applied.rows.length) return;
    if (global.Chime) global.Chime.play('scoring');
  }

  /* The page's own date (?date= deep link, else the picker, else today) so the
   * section opens on the same day as the alert feed. */
  function pageDate() {
    try {
      var params = new URLSearchParams(global.location.search || '');
      var d = params.get('date');
      if (MLB.isValidISODate(d)) return d;
    } catch (e) { /* ignore */ }
    var picker = $('date-picker');
    if (picker && MLB.isValidISODate(picker.value)) return picker.value;
    return MLB.todayISO();
  }

  function init() {
    state.date = pageDate();
    Log.loadPrefs();
    var btn = $('scoring-sound-btn');
    if (btn) {
      btn.textContent = Log.prefs.sound ? '🔊 Scoring sound on' : '🔇 Scoring sound off';
      btn.classList.toggle('btn-on', Log.prefs.sound);
      btn.addEventListener('click', toggleSound);
    }
    var test = $('scoring-test-btn');
    if (test) test.addEventListener('click', testSound);
    var refresh = $('scoring-refresh-btn');
    if (refresh) refresh.addEventListener('click', rescan);
    var nav = $('scoring-tabs');
    if (nav) {
      nav.addEventListener('click', function (evt) {
        var b = evt.target.closest('[data-scoring-tab]');
        if (b) setTab(b.getAttribute('data-scoring-tab'));
      });
    }
    Log.setOnApplied(function (applied) {
      state.lastRender = '';
      onNewEvents(applied);
      render();
    });
    Log.loadRegistry().then(function () { state.lastRender = ''; render(); });
    render();
    Log.setDate(state.date, function (applied) {
      state.lastRender = '';
      onNewEvents(applied);
      render();
    });
  }

  global.ScoringUI = {
    init: init,
    render: render,
    setDate: setDate,
    setTab: setTab,
    toggleSound: toggleSound,
    testSound: testSound,
    rescan: rescan,
    onNewEvents: onNewEvents,
    state: state,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}(window));
