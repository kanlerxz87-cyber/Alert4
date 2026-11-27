/* ============================================================================
 * game-state.js — official live game-state capture (before / after)
 *
 * Captures the exact official game state as it happens — score, count,
 * outs, pitcher, batter at bat, pitch count, bases, inning — timestamped
 * down to the second, for every game on the slate. For every challenge,
 * manager challenge, review, umpire review, official-scoring-pending and
 * scoring-change event it also captures the exact official wording
 * BEFORE and AFTER the event, so the replay feed can show what the
 * official record said on each side of the ruling.
 *
 * Everything here is read from the official StatsAPI payload; nothing is
 * inferred or guessed. Missing fields stay null/'' and are rendered as
 * "—" by the caller. This module is pure (no DOM, no network, no audio)
 * so it can be unit-tested and reused by the game page later.
 *
 * Payload sources (all public StatsAPI, keyless):
 *   - GET /api/v1/game/<pk>/playByPlay  (allPlays[].about/result/count/
 *     matchup/runners/playEvents) — the per-play official record.
 *   - GET /api/v1.1/game/<pk>/feed/live (liveData.linescore) — the live
 *     linescore (score, inning, count, offense) when a full feed is
 *     available. The replay feed's lean playByPlay poll carries the same
 *     per-play score/count, so state capture works on either.
 * ==========================================================================*/
(function (global) {
  'use strict';

  function numOrNull(v) {
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  function str(v) {
    return v === undefined || v === null ? '' : String(v);
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* Local HH:MM:SS (down to the second) for display, plus ISO for storage. */
  function stamp(date) {
    var d = date instanceof Date ? date : new Date(date || Date.now());
    if (isNaN(d.getTime())) d = new Date();
    return {
      iso: d.toISOString(),
      sec: pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()),
      ms: d.getTime(),
    };
  }

  function halfInningLabel(about) {
    var a = about || {};
    var half = a.halfInning || (a.isTopInning === false ? 'bottom' : 'top');
    var inning = a.inning;
    if (!inning) return '';
    var word = String(half).toLowerCase().indexOf('top') === 0 ? 'Top' : 'Bot';
    return word + ' ' + inning;
  }

  function pitchCountOf(play) {
    var events = (play && play.playEvents) || [];
    var count = 0;
    events.forEach(function (ev) {
      if (ev && ev.isPitch === true) count += 1;
    });
    return count;
  }

  function basesOf(play) {
    var bases = { first: null, second: null, third: null };
    ((play && play.runners) || []).forEach(function (r) {
      var d = r && r.details;
      if (!d) return;
      var base = d.base || '';
      var name = (d.runner && d.runner.fullName) || '';
      if (base === '1B') bases.first = name || true;
      else if (base === '2B') bases.second = name || true;
      else if (base === '3B') bases.third = name || true;
    });
    return bases;
  }

  function scoreOf(play, feed) {
    var res = (play && play.result) || {};
    if (typeof res.awayScore === 'number' && typeof res.homeScore === 'number') {
      return { away: res.awayScore, home: res.homeScore };
    }
    var ls = feed && feed.liveData && feed.liveData.linescore;
    var t = ls && ls.teams;
    if (t && t.away && t.home && typeof t.away.runs === 'number' && typeof t.home.runs === 'number') {
      return { away: t.away.runs, home: t.home.runs };
    }
    return null;
  }

  /**
   * capturePlay(play, feed, meta, observedAt)
   *   meta: { gamePk, teams:{away:{id,name},home:{id,name}} }
   * Returns one timestamped state snapshot for a single play.
   */
  function capturePlay(play, feed, meta, observedAt) {
    meta = meta || {};
    var p = play || {};
    var about = p.about || {};
    var res = p.result || {};
    var count = p.count || {};
    var matchup = p.matchup || {};
    var batter = matchup.batter || {};
    var pitcher = matchup.pitcher || {};
    var st = stamp(observedAt);
    var score = scoreOf(p, feed);

    return {
      gamePk: meta.gamePk || null,
      atBatIndex: numOrNull(about.atBatIndex),
      observedAt: st.iso,
      observedAtSec: st.sec,
      observedMs: st.ms,
      inning: numOrNull(about.inning),
      halfInning: about.halfInning || (about.isTopInning === false ? 'bottom' : 'top'),
      inningLabel: halfInningLabel(about),
      isTopInning: about.isTopInning === true,
      isComplete: about.isComplete === true,
      isScoringPlay: about.isScoringPlay === true,
      hasReview: about.hasReview === true,
      score: score,
      count: {
        balls: numOrNull(count.balls),
        strikes: numOrNull(count.strikes),
        outs: numOrNull(count.outs),
      },
      pitchCount: pitchCountOf(p),
      batter: { id: batter.id || null, name: batter.fullName || '' },
      pitcher: { id: pitcher.id || null, name: pitcher.fullName || '' },
      eventType: res.eventType || '',
      description: res.description || '',
      isOut: res.isOut === true,
      rbi: numOrNull(res.rbi),
      bases: basesOf(p),
      runnersCount: Array.isArray(p.runners) ? p.runners.length : 0,
      matchupLabel: meta.matchupLabel || '',
    };
  }

  /**
   * captureFeed(feed, meta, observedAt)
   * Returns the live "current" state from a feed/live payload: the
   * current play if present, else the last completed play, plus the
   * linescore snapshot. Used for the Live Game State cards.
   */
  function captureFeed(feed, meta, observedAt) {
    meta = meta || {};
    var st = stamp(observedAt);
    var plays = [];
    if (feed && feed.liveData && feed.liveData.plays && feed.liveData.plays.allPlays) {
      plays = feed.liveData.plays.allPlays;
    } else if (feed && feed.allPlays) {
      plays = feed.allPlays;
    }
    var current = feed && feed.liveData && feed.liveData.plays && feed.liveData.plays.currentPlay;
    var ls = feed && feed.liveData && feed.liveData.linescore;

    var currentState = null;
    if (current) currentState = capturePlay(current, feed, meta, observedAt);
    else if (plays.length) currentState = capturePlay(plays[plays.length - 1], feed, meta, observedAt);

    var linescoreState = null;
    if (ls) {
      var t = ls.teams || {};
      linescoreState = {
        gamePk: meta.gamePk || null,
        observedAt: st.iso,
        observedAtSec: st.sec,
        observedMs: st.ms,
        currentInning: numOrNull(ls.currentInning),
        inningState: ls.inningState || '',
        isTopInning: ls.isTopInning === true,
        balls: numOrNull(ls.balls),
        strikes: numOrNull(ls.strikes),
        outs: numOrNull(ls.outs),
        awayRuns: t.away ? numOrNull(t.away.runs) : null,
        homeRuns: t.home ? numOrNull(t.home.runs) : null,
        awayHits: t.away ? numOrNull(t.away.hits) : null,
        homeHits: t.home ? numOrNull(t.home.hits) : null,
        awayErrors: t.away ? numOrNull(t.away.errors) : null,
        homeErrors: t.home ? numOrNull(t.home.errors) : null,
        offense: ls.offense || null,
      };
    }

    return {
      gamePk: meta.gamePk || null,
      observedAt: st.iso,
      observedAtSec: st.sec,
      observedMs: st.ms,
      current: currentState,
      linescore: linescoreState,
      playCount: plays.length,
    };
  }

  /* Snapshot every play in a payload, in order, each timestamped. */
  function snapshotAll(plays, feed, meta, observedAt) {
    return (plays || []).map(function (p) { return capturePlay(p, feed, meta, observedAt); });
  }

  /**
   * beforeAfterForPlay(plays, atBatIndex, feed, meta, observedAt)
   * Returns { before, after } where `after` is the reviewed play's state
   * and `before` is the previous completed play's state (or null). Both
   * carry the exact official description wording from the payload.
   */
  function beforeAfterForPlay(plays, atBatIndex, feed, meta, observedAt) {
    var list = plays || [];
    var idx = -1;
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].about && Number(list[i].about.atBatIndex) === Number(atBatIndex)) {
        idx = i;
        break;
      }
    }
    if (idx === -1) return { before: null, after: null };
    var after = capturePlay(list[idx], feed, meta, observedAt);
    var before = null;
    for (var j = idx - 1; j >= 0; j -= 1) {
      if (list[j] && list[j].about && list[j].about.isComplete === true) {
        before = capturePlay(list[j], feed, meta, observedAt);
        break;
      }
    }
    return { before: before, after: after };
  }

  /* Compact one-line rendering of a state (for feed rows / status line). */
  function formatState(s) {
    if (!s) return '—';
    var parts = [];
    if (s.inningLabel) parts.push(s.inningLabel);
    if (s.score) parts.push(s.score.away + '–' + s.score.home);
    if (s.count && s.count.balls !== null && s.count.strikes !== null) {
      parts.push(s.count.balls + '-' + s.count.strikes +
        (s.count.outs !== null ? ' · ' + s.count.outs + ' out' + (s.count.outs === 1 ? '' : 's') : ''));
    }
    if (s.batter && s.batter.name) parts.push(s.batter.name + ' vs ' + (s.pitcher && s.pitcher.name ? s.pitcher.name : '—'));
    if (s.pitchCount) parts.push(s.pitchCount + ' pitch' + (s.pitchCount === 1 ? '' : 'es'));
    if (s.observedAtSec) parts.push('@ ' + s.observedAtSec);
    return parts.join(' · ') || '—';
  }

  /* Stable key for deduping identical consecutive states. */
  function stateKey(s) {
    if (!s) return '';
    return [
      s.gamePk, s.atBatIndex, s.inningLabel,
      s.score ? s.score.away + '-' + s.score.home : '',
      s.count ? s.count.balls + '-' + s.count.strikes + '-' + s.count.outs : '',
      s.batter && s.batter.name, s.pitcher && s.pitcher.name,
      s.eventType, s.description,
    ].join('|');
  }

  /* Diff two states: which official fields changed? */
  function diffStates(prev, next) {
    if (!prev || !next) return [];
    var changed = [];
    function cmp(label, a, b) {
      if (String(a === undefined ? '' : a) !== String(b === undefined ? '' : b)) changed.push(label);
    }
    cmp('score', prev.score && (prev.score.away + '-' + prev.score.home), next.score && (next.score.away + '-' + next.score.home));
    cmp('count', prev.count && (prev.count.balls + '-' + prev.count.strikes), next.count && (next.count.balls + '-' + next.count.strikes));
    cmp('outs', prev.count && prev.count.outs, next.count && next.count.outs);
    cmp('batter', prev.batter && prev.batter.name, next.batter && next.batter.name);
    cmp('pitcher', prev.pitcher && prev.pitcher.name, next.pitcher && next.pitcher.name);
    cmp('eventType', prev.eventType, next.eventType);
    cmp('description', prev.description, next.description);
    cmp('inning', prev.inningLabel, next.inningLabel);
    return changed;
  }

  global.GameState = {
    stamp: stamp,
    capturePlay: capturePlay,
    captureFeed: captureFeed,
    snapshotAll: snapshotAll,
    beforeAfterForPlay: beforeAfterForPlay,
    formatState: formatState,
    stateKey: stateKey,
    diffStates: diffStates,
    pitchCountOf: pitchCountOf,
  };
}(window));
