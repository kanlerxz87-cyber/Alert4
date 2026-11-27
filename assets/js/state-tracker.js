/* ============================================================================
 * state-tracker.js — captures the OFFICIAL game state, live, for every game.
 *
 * For every game on the slate the all-games feed calls observe() on each scan.
 * This module diffs the official payload against what it last captured and
 * appends timestamped (second precision) state events to the Game State
 * timeline — the data behind the "Game State" tab in the Replay Feed:
 *
 *   subtype 'preview'        — first sighting of a Preview game: scheduled
 *                             start + official probable pitchers (schedule
 *                             hydrate). "Before game" state.
 *   subtype 'game_start'     — first Live observation: the official status
 *                             wording (e.g. "In Progress", code I).
 *   subtype 'pitch'          — every pitch: pitcher, official pitch number,
 *                             the official call text, count and outs.
 *   subtype 'pitcher_change' — the matchup pitcher changed: before → after.
 *   subtype 'score_change'   — the official score moved: before → after, with
 *                             the scoring play's official description.
 *   subtype 'game_final'     — first Final observation: official status wording,
 *                             final score, and decisions (when the schedule
 *                             payload carries them). "After game" state.
 *
 * Everything shown comes from the official payload (play-by-play / feed/live /
 * schedule) — nothing is derived from projections or betting data.
 *
 * Persistence is separate from both the alert log (feed-log.js) and the
 * scoring log (scoring-log.js): localStorage mlbp.statelog.<date> (always) +
 * /api/state-log (when server.mjs is present), via state-log.js. Kept honest:
 * when feed/live is unavailable (standard play-by-play poll), fields that only
 * exist on the full feed (e.g. runner occupancy) are omitted, never guessed.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var StateLog = global.StateLog;
  var Reviews = global.Reviews;

  var MAX_IN_MEMORY = 2000;

  var state = {
    date: null,
    loadedDate: null,
    events: [],
    byId: Object.create(null),
    perGame: Object.create(null),  /* pk -> { seenPitchKeys, snapshot, liveSeen, finalSeen } */
  };

  function nowTs() { return Date.now(); }

  function abbrOf(team) {
    if (!team) return '';
    if (typeof team === 'string') return team;
    return team.abbreviation || (team.team && team.team.abbreviation) || '';
  }

  function matchupLabel(teamsInput) {
    if (!teamsInput) return '';
    var away = teamsInput.away || {};
    var home = teamsInput.home || {};
    var awayAbbr = away.abbr || abbrOf(away.team) || away.name || 'AWAY';
    var homeAbbr = home.abbr || abbrOf(home.team) || home.name || 'HOME';
    return awayAbbr + ' @ ' + homeAbbr;
  }

  function inningLabelOf(inning, isTop) {
    if (!inning) return '';
    return (isTop ? 'Top ' : 'Bot ') + inning;
  }

  function rebuildIndex() {
    state.byId = Object.create(null);
    state.events.forEach(function (e) { if (e && e.id) state.byId[e.id] = e; });
  }

  function rebuildPitchKeys() {
    Object.keys(state.perGame).forEach(function (pk) {
      state.perGame[pk].seenPitchKeys = state.perGame[pk].seenPitchKeys || {};
    });
    state.events.forEach(function (e) {
      if (!e || e.subtype !== 'pitch') return;
      var g = state.perGame[e.gamePk];
      if (g && e.pitchKey) g.seenPitchKeys[e.pitchKey] = true;
    });
  }

  function adoptLocal(date) {
    try {
      var raw = global.localStorage && global.localStorage.getItem('mlbp.statelog.' + date);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (parsed && parsed.v === 1 && Array.isArray(parsed.entries)) {
        parsed.entries.forEach(adoptEntry);
      }
    } catch (e) { /* malformed local copy — start clean */ }
  }

  function adoptEntry(entry) {
    if (!entry || !entry.id) return;
    if (state.byId[entry.id]) {
      state.byId[entry.id].lastSeen = Math.max(Number(state.byId[entry.id].lastSeen) || 0, Number(entry.lastSeen) || 0);
      return;
    }
    state.events.push(entry);
    state.byId[entry.id] = entry;
  }

  function switchDate(date) {
    state.date = date;
    state.events = [];
    state.byId = Object.create(null);
    state.perGame = Object.create(null);
    state.loadedDate = date;
    adoptLocal(date);
    rebuildPitchKeys();
  }

  function ensureDate(date) {
    if (!date) return false;
    if (state.loadedDate !== date) switchDate(date);
    return true;
  }

  function beginDate(date) { if (date) ensureDate(date); }

  function perGame(pk) {
    if (!state.perGame[pk]) state.perGame[pk] = { seenPitchKeys: {}, snapshot: null, score: null };
    return state.perGame[pk];
  }

  function emit(subtype, id, fields) {
    if (!state.date) return null;
    var ts = nowTs();
    var entry = {
      id: id,
      kind: 'game_state',
      subtype: subtype,
      gamePk: fields.gamePk,
      officialDate: state.date,
      ts: ts,
      firstSeen: ts,
      lastSeen: ts,
      matchupLabel: fields.matchupLabel || '',
      teams: fields.teams || null,
      inningLabel: fields.inningLabel || '',
      batter: fields.batter || '',
      pitcher: fields.pitcher || '',
      pitchNumber: fields.pitchNumber || null,
      pitchKey: fields.pitchKey || null,
      count: fields.count || null,
      outs: typeof fields.outs === 'number' ? fields.outs : null,
      description: fields.description || '',
      before: fields.before || null,
      after: fields.after || null,
      scoreOnly: fields.scoreOnly || null,
      runnersOn: fields.runnersOn || null,
      atBatIndex: typeof fields.atBatIndex === 'number' ? fields.atBatIndex : null,
    };
    var existing = state.byId[id];
    if (existing) return existing;
    state.events.push(entry);
    state.byId[id] = entry;
    return entry;
  }

  function trimInMemory() {
    if (state.events.length <= MAX_IN_MEMORY) return;
    state.events.sort(function (a, b) { return (Number(b.lastSeen) || 0) - (Number(a.lastSeen) || 0); });
    state.events = state.events.slice(0, MAX_IN_MEMORY);
    rebuildIndex();
    rebuildPitchKeys();
  }

  function persist() {
    if (!state.date) return;
    trimInMemory();
    StateLog.save(state.date, { v: 1, date: state.date, savedAt: nowTs(), entries: state.events.slice() });
  }

  /* -------------------------------------------------------- snapshot build */

  function latestScores(plays) {
    var away = null, home = null;
    (plays || []).forEach(function (p) {
      var r = (p && p.result) || {};
      if (typeof r.awayScore === 'number' && typeof r.homeScore === 'number') {
        away = r.awayScore; home = r.homeScore;
      }
    });
    return (away === null) ? null : { away: away, home: home };
  }

  function boxscorePitchCount(feed, pitcherId) {
    if (!feed || !pitcherId) return null;
    var box = feed.liveData && feed.liveData.boxscore;
    if (!box || !box.teams) return null;
    var sides = ['away', 'home'];
    for (var i = 0; i < sides.length; i += 1) {
      var players = box.teams[sides[i]] && box.teams[sides[i]].players;
      if (!players) continue;
      var p = players['ID' + pitcherId];
      var n = p && p.stats && p.stats.pitching && Number(p.stats.pitching.numberOfPitches);
      if (isFinite(n)) return n;
    }
    return null;
  }

  function pitchCountByTally(plays, pitcherId) {
    if (!pitcherId) return null;
    var count = 0;
    (plays || []).forEach(function (p) {
      if (!p || !p.matchup || !p.matchup.pitcher) return;
      if (Number(p.matchup.pitcher.id) !== Number(pitcherId)) return;
      (p.playEvents || []).forEach(function (ev) { if (ev && ev.isPitch === true) count += 1; });
    });
    return count;
  }

  function runnerOn(linescore, base) {
    var off = linescore && linescore.offense;
    var r = off && off[base];
    if (!r) return null;
    if (r.id) return { id: r.id, fullName: r.fullName || '' };
    return null;
  }

  function buildSnapshot(game, payload) {
    var plays = Reviews.playsOf(payload);
    var feed = payload && payload.liveData ? payload : null;
    var linescore = feed && feed.liveData && feed.liveData.linescore;
    var currentPlay = feed && feed.liveData && feed.liveData.plays && feed.liveData.plays.currentPlay
      ? feed.liveData.plays.currentPlay
      : (plays.length ? plays[plays.length - 1] : null);

    var away = null, home = null;
    if (linescore && linescore.teams && typeof linescore.teams.away === 'object' && typeof linescore.teams.home === 'object') {
      if (typeof linescore.teams.away.runs === 'number' && typeof linescore.teams.home.runs === 'number') {
        away = linescore.teams.away.runs; home = linescore.teams.home.runs;
      }
    }
    if (away === null) {
      var sc = latestScores(plays);
      if (sc) { away = sc.away; home = sc.home; }
    }

    var inning = (currentPlay && currentPlay.about && Number(currentPlay.about.inning)) ||
      (linescore && Number(linescore.currentInning)) || null;
    var isTop = currentPlay && currentPlay.about ? currentPlay.about.isTopInning !== false : (linescore ? linescore.isTopInning !== false : null);
    var balls = currentPlay && currentPlay.count && typeof currentPlay.count.balls === 'number' ? currentPlay.count.balls :
      (linescore && typeof linescore.balls === 'number' ? linescore.balls : null);
    var strikes = currentPlay && currentPlay.count && typeof currentPlay.count.strikes === 'number' ? currentPlay.count.strikes :
      (linescore && typeof linescore.strikes === 'number' ? linescore.strikes : null);
    var outs = currentPlay && currentPlay.count && typeof currentPlay.count.outs === 'number' ? currentPlay.count.outs :
      (linescore && typeof linescore.outs === 'number' ? linescore.outs : null);

    var batter = (currentPlay && currentPlay.matchup && currentPlay.matchup.batter) || {};
    var pitcher = (currentPlay && currentPlay.matchup && currentPlay.matchup.pitcher) || {};

    var pitchCount = boxscorePitchCount(feed, pitcher.id);
    if (pitchCount === null) pitchCount = pitchCountByTally(plays, pitcher.id);

    return {
      ts: nowTs(),
      status: game && game.status ? {
        abstractGameState: game.status.abstractGameState || '',
        codedGameState: game.status.codedGameState || '',
        detailedState: game.status.detailedState || '',
        statusCode: game.status.statusCode || '',
      } : { abstractGameState: '', codedGameState: '', detailedState: '', statusCode: '' },
      inning: inning,
      isTopInning: isTop,
      inningLabel: inningLabelOf(inning, isTop !== false),
      balls: balls,
      strikes: strikes,
      outs: outs,
      awayScore: away,
      homeScore: home,
      batter: { id: batter.id || null, name: batter.fullName || '' },
      pitcher: { id: pitcher.id || null, name: pitcher.fullName || '', pitchCount: pitchCount },
      atBatIndex: currentPlay && currentPlay.about && typeof currentPlay.about.atBatIndex === 'number' ? currentPlay.about.atBatIndex : null,
      runners: {
        first: runnerOn(linescore, 'first'),
        second: runnerOn(linescore, 'second'),
        third: runnerOn(linescore, 'third'),
      },
      plays: plays,
    };
  }

  /* ------------------------------------------------------------- emitters */

  function emitPreview(game, teamsInput, matchupLabel) {
    var id = game.gamePk + ':preview';
    if (state.byId[id]) return;
    var teams = game.teams || {};
    function probable(side) {
      var p = teams[side] && teams[side].probablePitcher;
      return p && p.fullName ? p.fullName : null;
    }
    var awayP = probable('away'), homeP = probable('home');
    var parts = ['Scheduled start ' + (game.gameDate || 'TBD')];
    if (awayP || homeP) parts.push('Probable pitchers: ' + (awayP || 'TBD') + ' vs ' + (homeP || 'TBD'));
    parts.push('Official state: ' + ((game.status && game.status.detailedState) || 'Preview') +
      ' (code ' + ((game.status && game.status.statusCode) || '—') + ')');
    emit('preview', id, {
      gamePk: game.gamePk,
      matchupLabel: matchupLabel,
      teams: teamsInput,
      description: parts.join(' · '),
      before: null,
      after: { scheduledStart: game.gameDate || null, probableAwayPitcher: awayP, probableHomePitcher: homeP },
    });
  }

  function emitGameStart(game, snap, teamsInput, matchupLabel) {
    var id = game.gamePk + ':start';
    if (state.byId[id]) return;
    emit('game_start', id, {
      gamePk: game.gamePk,
      matchupLabel: matchupLabel,
      teams: teamsInput,
      inningLabel: snap.inningLabel,
      description: 'Game in progress — official status "' + (snap.status.detailedState || 'In Progress') +
        '" (code ' + (snap.status.statusCode || 'I') + ')',
      before: { status: 'Preview' },
      after: { status: snap.status.detailedState || 'In Progress', statusCode: snap.status.statusCode || '' },
      atBatIndex: snap.atBatIndex,
    });
  }

  function emitScoreChange(game, snap, prevSnap, teamsInput, matchupLabel) {
    var prevScore = { away: prevSnap.awayScore, home: prevSnap.homeScore };
    var plays = snap.plays;
    var scoringPlay = null;
    for (var i = plays.length - 1; i >= 0; i -= 1) {
      var p = plays[i];
      if (p && p.about && p.about.isComplete === true &&
          typeof p.result.awayScore === 'number' && typeof p.result.homeScore === 'number' &&
          p.result.awayScore === snap.awayScore && p.result.homeScore === snap.homeScore) {
        scoringPlay = p;
        break;
      }
    }
    if (!scoringPlay) {
      for (var j = plays.length - 1; j >= 0; j -= 1) {
        if (plays[j] && plays[j].isScoringPlay === true) { scoringPlay = plays[j]; break; }
      }
    }
    var atBatIndex = scoringPlay && scoringPlay.about && typeof scoringPlay.about.atBatIndex === 'number' ? scoringPlay.about.atBatIndex : null;
    var id = game.gamePk + ':score:' + (atBatIndex === null ? 'x' + snap.awayScore + '-' + snap.homeScore : atBatIndex);
    if (state.byId[id]) return;
    var desc = (scoringPlay && scoringPlay.result && scoringPlay.result.description) || 'Official score updated';
    var battingSide = scoringPlay && scoringPlay.about && String(scoringPlay.about.halfInning).indexOf('top') === 0 ? 'away' : 'home';
    var runsAdded = Math.abs((snap.awayScore + snap.homeScore) - (prevScore.away + prevScore.home));
    emit('score_change', id, {
      gamePk: game.gamePk,
      matchupLabel: matchupLabel,
      teams: teamsInput,
      inningLabel: snap.inningLabel,
      batter: scoringPlay && scoringPlay.matchup && scoringPlay.matchup.batter ? scoringPlay.matchup.batter.fullName : '',
      pitcher: scoringPlay && scoringPlay.matchup && scoringPlay.matchup.pitcher ? scoringPlay.matchup.pitcher.fullName : '',
      description: desc,
      before: { away: prevScore.away, home: prevScore.home },
      after: { away: snap.awayScore, home: snap.homeScore },
      scoreOnly: { runsAdded: runsAdded, scoringSide: battingSide },
      atBatIndex: atBatIndex,
    });
  }

  function emitPitcherChange(game, snap, prevPitcher, teamsInput, matchupLabel) {
    var id = game.gamePk + ':pitcher:' + snap.pitcher.id + ':' + (snap.atBatIndex === null ? 'x' : snap.atBatIndex);
    if (state.byId[id]) return;
    emit('pitcher_change', id, {
      gamePk: game.gamePk,
      matchupLabel: matchupLabel,
      teams: teamsInput,
      inningLabel: snap.inningLabel,
      batter: snap.batter.name,
      pitcher: snap.pitcher.name,
      description: 'Pitching change: ' + prevPitcher.name + ' → ' + snap.pitcher.name,
      before: { pitcher: prevPitcher.name, pitcherId: prevPitcher.id },
      after: { pitcher: snap.pitcher.name, pitcherId: snap.pitcher.id, pitchCount: snap.pitcher.pitchCount },
      atBatIndex: snap.atBatIndex,
    });
  }

  function emitNewPitches(game, payload, snap, teamsInput, matchupLabel) {
    var pg = perGame(game.gamePk);
    var plays = snap.plays;
    plays.forEach(function (p) {
      if (!p) return;
      var abid = p.about && typeof p.about.atBatIndex === 'number' ? p.about.atBatIndex : null;
      var pitcherName = (p.matchup && p.matchup.pitcher && p.matchup.pitcher.fullName) || '';
      var batterName = (p.matchup && p.matchup.batter && p.matchup.batter.fullName) || '';
      var events = p.playEvents || [];
      events.forEach(function (ev, index) {
        if (!ev || ev.isPitch !== true) return;
        var key = abid + ':' + index;
        if (pg.seenPitchKeys[key]) return;
        pg.seenPitchKeys[key] = true;
        var pitchNumber = typeof ev.pitchNumber === 'number' ? ev.pitchNumber : null;
        var call = (ev.details && ev.details.description) || (ev.call && ev.call.description) || '';
        var count = ev.count && typeof ev.count.balls === 'number'
          ? ev.count.balls + '-' + ev.count.strikes : '';
        var id = game.gamePk + ':pitch:' + abid + ':' + index;
        if (state.byId[id]) return;
        var evOuts = p.count && typeof p.count.outs === 'number' ? p.count.outs : null;
        emit('pitch', id, {
          gamePk: game.gamePk,
          matchupLabel: matchupLabel,
          teams: teamsInput,
          inningLabel: snap.inningLabel,
          batter: batterName,
          pitcher: pitcherName,
          pitchNumber: pitchNumber,
          pitchKey: key,
          count: count,
          outs: evOuts,
          atBatIndex: abid,
          description: (pitcherName || 'Pitcher') + ' — pitch ' + (pitchNumber === null ? '?' : pitchNumber) +
            (call ? ': ' + call : '') + '. ' + (batterName || 'Batter') + ' batting' +
            (count ? ', count ' + count : '') + (evOuts === null ? '' : ', ' + evOuts + ' out' + (evOuts === 1 ? '' : 's')),
        });
      });
    });
  }

  function emitGameFinal(game, snap, teamsInput, matchupLabel) {
    var id = game.gamePk + ':final';
    if (state.byId[id]) return;
    var decisions = game.decisions || {};
    var winner = decisions.winner && decisions.winner.fullName;
    var loser = decisions.loser && decisions.loser.fullName;
    var save = decisions.save && decisions.save.fullName;
    var decisionText = [];
    if (winner) decisionText.push('Winning pitcher: ' + winner);
    if (loser) decisionText.push('Losing pitcher: ' + loser);
    if (save) decisionText.push('Save: ' + save);
    if (!decisionText.length) decisionText.push('Decisions not in schedule payload');
    var scoreText = (snap.awayScore !== null && snap.awayScore !== undefined)
      ? snap.awayScore + '–' + snap.homeScore : 'score not in payload';
    emit('game_final', id, {
      gamePk: game.gamePk,
      matchupLabel: matchupLabel,
      teams: teamsInput,
      inningLabel: snap.inningLabel,
      description: 'Final — official status "' + (snap.status.detailedState || 'Final') +
        '" (code ' + (snap.status.statusCode || 'F') + '). Final score ' + scoreText +
        '. ' + decisionText.join(' · '),
      before: { status: 'Live' },
      after: {
        status: snap.status.detailedState || 'Final',
        away: snap.awayScore,
        home: snap.homeScore,
        decisions: decisionText.join(' · '),
      },
    });
  }

  /* -------------------------------------------------------------- observe */

  /**
   * observe({ date, game, payload, teams })
   *   game    — the schedule game object (status, teams, gameDate, decisions)
   *   payload — playByPlay body OR (diff-patch mode) the patched live feed
   *   teams   — { away:{id,name}, home:{id,name} } as used by the feed
   */
  function observe(input) {
    var date = input && input.date;
    var game = input && input.game;
    if (!date || !game || !game.gamePk) return { emitted: 0 };
    if (!ensureDate(date)) return { emitted: 0 };

    var pk = game.gamePk;
    var payload = input.payload || null;
    var teamsInput = input.teams || null;
    var label = input.matchupLabel || matchupLabel(teamsInput || game.teams);
    var before = state.events.length;
    var pg = perGame(pk);
    var status = (game.status && game.status.abstractGameState) || '';

    if (status === 'Preview' || status === 'Pre-Game' || status === 'Warmup') {
      emitPreview(game, teamsInput || game.teams, label);
    }

    var snap = buildSnapshot(game, payload);
    var prev = pg.snapshot;

    if (status === 'Live') {
      if (!pg.liveSeen) {
        pg.liveSeen = true;
        emitGameStart(game, snap, teamsInput || game.teams, label);
      }
      /* score change vs previous observed score */
      if (prev && prev.awayScore !== null && snap.awayScore !== null &&
          (prev.awayScore !== snap.awayScore || prev.homeScore !== snap.homeScore)) {
        emitScoreChange(game, snap, prev, teamsInput || game.teams, label);
      }
      /* pitcher change vs previous matchup */
      if (prev && prev.pitcher.id && snap.pitcher.id && Number(prev.pitcher.id) !== Number(snap.pitcher.id)) {
        emitPitcherChange(game, snap, prev.pitcher, teamsInput || game.teams, label);
      }
      if (payload) emitNewPitches(game, payload, snap, teamsInput || game.teams, label);
    }

    if (status === 'Final') {
      pg.finalSeen = true;
      emitGameFinal(game, snap, teamsInput || game.teams, label);
    }

    pg.snapshot = snap;
    pg.score = snap.awayScore === null ? null : { away: snap.awayScore, home: snap.homeScore };

    var emitted = state.events.length - before;
    if (emitted > 0) persist();
    return { emitted: emitted };
  }

  /* Merge a persistence payload (server copy, or local+server merged by the
   * caller) into the in-memory timeline — same idempotent union-by-id as the
   * local restore. Never throws; malformed rows are dropped. */
  function adopt(payload) {
    if (!payload || !Array.isArray(payload.entries)) return;
    payload.entries.forEach(adoptEntry);
    trimInMemory();
    rebuildIndex();
    rebuildPitchKeys();
  }

  function all() {
    return state.events.slice().sort(function (a, b) {
      return (Number(b.ts) || 0) - (Number(a.ts) || 0);
    });
  }

  function countBySubtype() {
    var out = Object.create(null);
    state.events.forEach(function (e) {
      if (!e || e.kind !== 'game_state') return;
      out[e.subtype] = (out[e.subtype] || 0) + 1;
    });
    return out;
  }

  global.StateTracker = {
    beginDate: beginDate,
    observe: observe,
    adopt: adopt,
    all: all,
    countBySubtype: countBySubtype,
    state: state,
  };
}(window));
