/* ============================================================================
 * live-state.js — second-precision capture of the official live game state
 *
 * Every poll of the official StatsAPI play-by-play is turned into one immutable
 * snapshot:
 *
 *   score (away/home) · inning + half · outs · balls/strikes · pitch count
 *   (game total and per pitcher) · current pitcher · current batter ·
 *   current at-bat · the official last-play wording · review status code
 *
 * Each snapshot carries the moment it was OBSERVED (`at` ms + ISO string with
 * milliseconds, so the record is accurate to the second and never rounded), the
 * official status code and the exact `result.description` / `detailedState`
 * wording the API published at that moment.
 *
 * Nothing here is inferred: every field is copied from the payload, and a field
 * the payload does not carry stays `null` (rendered as "—") instead of being
 * guessed.  `diff()` reports what changed between two snapshots — that is what
 * the feed uses to say "before → after" for a challenge, a pending ruling or an
 * official scoring change.
 *
 * Bounded history: STATE_HISTORY_MAX snapshots per game are kept (newest last),
 * so a whole slate can be journalled for refresh-persistence without growing
 * without limit.  Persistence itself lives in feed-log.js (`live` block).
 * ==========================================================================*/
(function (global) {
  'use strict';

  var STATE_HISTORY_MAX = 60;

  function numOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    var n = Number(value);
    return isFinite(n) ? n : null;
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  /** ISO-8601 with milliseconds — the second is always exact, ms is extra. */
  function isoOf(at) {
    var d = new Date(at);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' +
      pad(d.getMilliseconds()) + 'Z';
  }

  /** "20:15:03" — second precision for row labels. */
  function clockOf(at) {
    var d = new Date(at);
    if (isNaN(d.getTime())) return '—';
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function halfInningLabel(inning, half) {
    if (!inning) return '';
    var h = String(half || '').toLowerCase();
    var word = h.indexOf('top') === 0 ? 'Top' : (h.indexOf('bottom') === 0 || h.indexOf('bot') === 0 ? 'Bot' : '');
    return word ? word + ' ' + inning : 'Inning ' + inning;
  }

  function playsOf(payload) {
    var plays = payload && payload.liveData && payload.liveData.plays;
    if (plays && Array.isArray(plays.allPlays)) return plays.allPlays;
    if (payload && Array.isArray(payload.allPlays)) return payload.allPlays;
    return [];
  }

  /** Official pitch count from `playEvents[].isPitch`, total and per pitcher. */
  function pitchCounts(plays) {
    var total = 0;
    var byPitcher = Object.create(null);
    (plays || []).forEach(function (play) {
      var pitcher = play && play.matchup && play.matchup.pitcher;
      var pitcherId = pitcher && pitcher.id ? String(pitcher.id) : '';
      (play && play.playEvents || []).forEach(function (ev) {
        if (!ev || ev.isPitch !== true) return;
        total += 1;
        if (pitcherId) byPitcher[pitcherId] = (byPitcher[pitcherId] || 0) + 1;
      });
    });
    return { total: total, byPitcher: byPitcher };
  }

  function reviewStatusCodeOf(plays) {
    /* The most recent official review code anywhere in the payload; the
     * payload keeps `reviewDetails` on the reviewed play, so the last match is
     * the live one. */
    var code = null;
    (plays || []).forEach(function (play) {
      if (play && play.reviewDetails && play.reviewDetails.reviewType) {
        code = String(play.reviewDetails.reviewType).toUpperCase();
      }
      (play && play.playEvents || []).forEach(function (ev) {
        if (ev && ev.reviewDetails && ev.reviewDetails.reviewType) {
          code = String(ev.reviewDetails.reviewType).toUpperCase();
        }
      });
    });
    return code;
  }

  /**
   * capture({ gamePk, teams, game, payload, at })
   *   game    — the schedule row (status, teams, gameDate)
   *   payload — the play-by-play / feed payload just fetched
   *   at      — epoch ms when the observation was received (default: now)
   * Returns the snapshot described at the top of this file.
   */
  function capture(meta) {
    meta = meta || {};
    var game = meta.game || {};
    var payload = meta.payload || {};
    var at = Number(meta.at) || Date.now();
    var plays = playsOf(payload);
    var linescore = (payload.liveData && payload.liveData.linescore) || payload.linescore || {};
    var current = (payload.liveData && payload.liveData.plays && payload.liveData.plays.currentPlay) || null;
    var lastCompleted = null;
    for (var i = plays.length - 1; i >= 0; i -= 1) {
      if (plays[i] && plays[i].about && plays[i].about.isComplete === true) { lastCompleted = plays[i]; break; }
    }
    var play = current || lastCompleted || plays[plays.length - 1] || null;
    var about = (play && play.about) || {};
    var result = (play && play.result) || {};
    var count = (play && play.count) || {};

    var teams = meta.teams || {};
    var awayScore = linescore.teams && linescore.teams.away ? numOrNull(linescore.teams.away.runs) : null;
    var homeScore = linescore.teams && linescore.teams.home ? numOrNull(linescore.teams.home.runs) : null;
    if (awayScore === null && gamescore(payload)) {
      awayScore = gamescore(payload).away;
      homeScore = gamescore(payload).home;
    }

    var status = (game.status && game.status.abstractGameState) ||
      (payload.gameData && payload.gameData.status && payload.gameData.status.abstractGameState) || '';
    var detailedState = (game.status && game.status.detailedState) ||
      (payload.gameData && payload.gameData.status && payload.gameData.status.detailedState) || '';
    var statusCode = (game.status && game.status.statusCode) ||
      (payload.gameData && payload.gameData.status && payload.gameData.status.statusCode) || '';

    var pitcher = (play && play.matchup && play.matchup.pitcher) || {};
    var batter = (play && play.matchup && play.matchup.batter) || {};
    var pitches = pitchCounts(plays);
    var pitcherId = pitcher.id ? String(pitcher.id) : '';

    var inning = numOrNull(about.inning) || numOrNull(linescore.currentInning) || null;
    var half = about.halfInning || linescore.inningHalf || linescore.inningState || '';

    return {
      v: 1,
      gamePk: Number(meta.gamePk || game.gamePk || (payload.gamePk)) || null,
      at: at,
      atIso: isoOf(at),
      atClock: clockOf(at),
      status: status,
      statusCode: statusCode,
      detailedState: detailedState,
      inning: inning,
      halfInning: half,
      inningLabel: halfInningLabel(inning, half),
      outs: numOrNull(count.outs) !== null ? numOrNull(count.outs) : numOrNull(linescore.outs),
      balls: numOrNull(count.balls) !== null ? numOrNull(count.balls) : numOrNull(linescore.balls),
      strikes: numOrNull(count.strikes) !== null ? numOrNull(count.strikes) : numOrNull(linescore.strikes),
      score: { away: awayScore, home: homeScore },
      batter: { id: batter.id || null, name: batter.fullName || '' },
      pitcher: { id: pitcher.id || null, name: pitcher.fullName || '' },
      pitchCount: {
        total: pitches.total,
        pitcher: pitcherId ? (pitches.byPitcher[pitcherId] || 0) : null,
      },
      atBatIndex: numOrNull(about.atBatIndex),
      play: {
        atBatIndex: numOrNull(about.atBatIndex),
        eventType: result.eventType || '',
        description: result.description || '',
        isScoringPlay: about.isScoringPlay === true,
        isComplete: about.isComplete === true,
      },
      reviewStatusCode: reviewStatusCodeOf(plays),
      teams: { away: teams.away || null, home: teams.home || null },
    };
  }

  /* Fallback score: the highest score the plays report (payloads without a
   * linescore).  Never invents runs — it copies the last completed play. */
  function gamescore(payload) {
    var plays = playsOf(payload);
    for (var i = plays.length - 1; i >= 0; i -= 1) {
      var res = plays[i] && plays[i].result;
      if (res && (typeof res.awayScore === 'number' || typeof res.homeScore === 'number')) {
        return { away: numOrNull(res.awayScore), home: numOrNull(res.homeScore) };
      }
    }
    return null;
  }

  /** Compact identity of the observable state; equal strings ⇒ nothing moved. */
  function fingerprint(s) {
    if (!s) return '';
    return [
      s.status, s.statusCode, s.inning, s.halfInning, s.outs, s.balls, s.strikes,
      s.score && s.score.away, s.score && s.score.home,
      s.pitcher && s.pitcher.id, s.batter && s.batter.id,
      s.atBatIndex, s.reviewStatusCode, s.pitchCount && s.pitchCount.total,
    ].join('|');
  }

  function scoreText(score) {
    if (!score) return '—';
    var away = score.away === null || score.away === undefined ? '—' : score.away;
    var home = score.home === null || score.home === undefined ? '—' : score.home;
    return away + '–' + home;
  }

  function stateText(s) {
    if (!s) return '';
    return [
      s.inningLabel || '—',
      scoreText(s.score),
      s.outs === null || s.outs === undefined ? '— outs' : s.outs + ' out' + (s.outs === 1 ? '' : 's'),
      (s.balls === null || s.balls === undefined ? '—' : s.balls) + '-' +
        (s.strikes === null || s.strikes === undefined ? '—' : s.strikes) + ' count',
      s.pitcher && s.pitcher.name ? 'P ' + s.pitcher.name : '',
      s.batter && s.batter.name ? 'AB ' + s.batter.name : '',
    ].filter(Boolean).join(' · ');
  }

  /**
   * diff(previous, next) -> [{ field, label, before, after }]
   * Only the fields that actually changed, in a stable order.  A missing
   * previous snapshot (page opened mid-game) returns [] rather than a wall of
   * invented "changes".
   */
  function diff(previous, next) {
    if (!previous || !next) return [];
    var out = [];
    function push(field, label, before, after) {
      out.push({ field: field, label: label, before: before, after: after });
    }
    var a = previous.score || {};
    var b = next.score || {};
    if (a.away !== b.away || a.home !== b.home) {
      push('score', 'Score', scoreText(a), scoreText(b));
    }
    if (previous.outs !== next.outs) push('outs', 'Outs', previous.outs, next.outs);
    if (previous.inningLabel !== next.inningLabel) push('inning', 'Inning', previous.inningLabel, next.inningLabel);
    if ((previous.pitcher && previous.pitcher.id) !== (next.pitcher && next.pitcher.id)) {
      push('pitcher', 'Pitcher', (previous.pitcher && previous.pitcher.name) || '—',
        (next.pitcher && next.pitcher.name) || '—');
    }
    if (previous.atBatIndex !== next.atBatIndex &&
      (previous.batter && previous.batter.id) !== (next.batter && next.batter.id)) {
      push('batter', 'Batter', (previous.batter && previous.batter.name) || '—',
        (next.batter && next.batter.name) || '—');
    }
    if (previous.reviewStatusCode !== next.reviewStatusCode) {
      push('review', 'Review status', previous.reviewStatusCode || '—', next.reviewStatusCode || '—');
    }
    if (previous.statusCode !== next.statusCode) {
      push('status', 'Game status', previous.detailedState || previous.status || '—',
        next.detailedState || next.status || '—');
    }
    return out;
  }

  /**
   * append(history, snapshot) — bounded, newest-last per-game journal.
   * A snapshot identical to the previous one (same fingerprint) is not stored
   * again, but its observation time updates `lastSeenAt` on the stored one so
   * the board can say "captured 3s ago" without growing the log.
   */
  function append(history, snapshot) {
    var list = Array.isArray(history) ? history.slice() : [];
    var last = list[list.length - 1];
    if (last && fingerprint(last) === fingerprint(snapshot)) {
      last.lastSeenAt = snapshot.at;
      return { history: list, changed: false };
    }
    list.push(snapshot);
    if (list.length > STATE_HISTORY_MAX) list = list.slice(list.length - STATE_HISTORY_MAX);
    return { history: list, changed: true };
  }

  global.LiveState = {
    STATE_HISTORY_MAX: STATE_HISTORY_MAX,
    capture: capture,
    diff: diff,
    append: append,
    fingerprint: fingerprint,
    stateText: stateText,
    scoreText: scoreText,
    isoOf: isoOf,
    clockOf: clockOf,
    halfInningLabel: halfInningLabel,
    pitchCounts: pitchCounts,
    playsOf: playsOf,
  };
}(window));
