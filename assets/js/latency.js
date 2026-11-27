/* ============================================================================
 * latency.js — fastest-legitimate-feed pacing + official live-state capture
 *
 * WHAT THIS IS
 *   One module that answers two questions for every live game, as fast as the
 *   public MLB StatsAPI allows:
 *     1. "Has MLB published anything new?"  -> the feed's own revision stamp
 *        (`metaData.timeStamp`, YYYYMMDD_HHMMSS UTC).  A few hundred bytes.
 *     2. "What exactly is the official state now, and what changed?" -> one
 *        structured projection (status, linescore, current play, review
 *        details, challenge counters); diffed against the previous observation
 *        to produce timestamped before/after events.
 *
 * WHY NOT JUST POLL THE FULL FEED FASTER
 *   The old Replay Feed pulled a full playByPlay document for every live game
 *   every 250 ms (~60 req/s on a 15-game slate, multi-MB/min) and still could
 *   not see a change until the whole document came back.  The stamp poll is
 *   ~200 bytes, returns in one RTT, and turns "something landed" into a cheap
 *   comparison — so the expensive parse only runs when there is something to
 *   parse.  Same-or-better latency, a fraction of the traffic, and comfortably
 *   inside MLBAM's "individual, non-commercial, non-bulk use" notice
 *   (gdx.mlb.com/components/copyright.txt).
 *
 * VERIFIED AGAINST THE LIVE API (2026-11-27; see docs/latency.md)
 *   GET /api/v1.1/game/824638/feed/live?fields=metaData,timeStamp,wait,...
 *       -> {"metaData":{"wait":10,"timeStamp":"20260828_212805",...}}
 *   GET /api/v1.1/game/824638/feed/live?fields=liveData,linescore,offense,...
 *       -> {"liveData":{"linescore":{...},"plays":{"currentPlay":{...}}}}
 *   GET /api/v1/game/824638/boxscore?fields=teams,teamStats,pitching,numberOfPitches
 *       -> {"teams":{"away":{"teamStats":{"pitching":{"numberOfPitches":173}}}}}
 *   Timecodes run 15:40:13 (pre-game) -> 21:28:05 (final) for a game that
 *   started 18:20:00Z and ran ~3h08m, i.e. they are UTC wall clocks.
 *
 * HONEST LIMITS
 *   - The StatsAPI is pull-only: "fastest" means "one RTT after MLB publishes",
 *     not a push.  If two revisions land inside one poll window, the state diff
 *     shows the net change of both; the intermediate state was never on offer.
 *   - A field the API does not publish is never invented here: absent values
 *     stay null and the UI renders "—".
 *   - `timecode` lets a snapshot be pinned to an exact revision (verified:
 *     `?timecode=20260828_204406` returns that revision's linescore).  It is
 *     used for audit links, not for the live loop (pinning to an old revision
 *     would defeat the point).
 * ==========================================================================*/
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------- pacing */

  var TICK_MS = 150;              /* scheduler granularity                  */
  var META_TARGET_RPS = 10;       /* meta polls/s we allow ourselves (whole slate) */
  var META_MIN_MS = 500;          /* never poll one game faster than this   */
  var META_MAX_MS = 1500;         /* a full slate still beats 1.5s/game     */
  var REVIEW_FACTOR = 0.5;        /* games under review poll twice as fast  */
  var FINAL_MS = 5000;            /* post-final scoring-change watch        */
  var PREVIEW_MS = 30000;         /* pre-game: lineups only                 */
  var SAFETY_PARSE_MS = 15000;    /* re-read playByPlay even with no stamp move */
  var PITCH_COUNT_MS = 30000;     /* official box-score pitch counts        */

  /**
   * metaIntervalMs(liveCount, reviewCount)
   *   Spread our own meta budget across the live slate.  One game -> 500 ms;
   *   15 games -> 1500 ms each (10 req/s total).  Review games jump the queue
   *   by polling at half the interval, because a challenge/review is the event
   *   we must surface first.
   */
  function metaIntervalMs(liveCount, reviewCount) {
    var n = Math.max(1, Number(liveCount) || 1);
    var base = (1000 * n) / META_TARGET_RPS;
    base = Math.min(META_MAX_MS, Math.max(META_MIN_MS, base));
    if (reviewCount > 0) base = Math.max(META_MIN_MS, base * REVIEW_FACTOR);
    return Math.round(base);
  }

  function pollIntervalMs(status, inReview) {
    if (status === 'Live') {
      /* One live game: 500 ms; several: the shared budget above.  The caller
       * passes the slate size in `Latency.pace()`; this single-game helper is
       * used by the game page, which only watches one game. */
      return inReview ? META_MIN_MS : META_MIN_MS + 250;
    }
    if (status === 'Final') return FINAL_MS;
    return PREVIEW_MS;
  }

  /* ------------------------------------------------------------ timecodes */

  var TIMECODE_RE = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/;

  /**
   * parseTimecode('20260828_212805')
   *   -> { valid, raw, iso: '2026-08-28T21:28:05Z', ymd, hms, ms }
   * The stamp is the official feed revision (UTC wall clock, verified above).
   * An unparseable stamp is reported as invalid — never guessed into a date.
   */
  function parseTimecode(tc) {
    var raw = String(tc || '').trim();
    var m = TIMECODE_RE.exec(raw);
    if (!m) return { valid: false, raw: raw, iso: '', ymd: '', hms: '', ms: 0 };
    var y = Number(m[1]);
    var mo = Number(m[2]);
    var d = Number(m[3]);
    var hh = Number(m[4]);
    var mm = Number(m[5]);
    var ss = Number(m[6]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mm > 59 || ss > 59) {
      return { valid: false, raw: raw, iso: '', ymd: '', hms: '', ms: 0 };
    }
    var ms = Date.UTC(y, mo - 1, d, hh, mm, ss);
    var iso = new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
    return {
      valid: true,
      raw: raw,
      iso: iso,
      ymd: y + '-' + m[2] + '-' + m[3],
      hms: m[4] + ':' + m[5] + ':' + m[6],
      ms: ms,
    };
  }

  function timecodeLabel(tc) {
    var p = parseTimecode(tc);
    return p.valid ? p.hms + ' UTC' : '—';
  }

  /* ISO second-resolution stamp for our own observations. */
  function isoNow(ts) {
    var d = new Date(typeof ts === 'number' ? ts : Date.now());
    return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  function clockLabel(ts) {
    var d = new Date(typeof ts === 'number' ? ts : Date.now());
    var hh = String(d.getUTCHours());
    var mm = String(d.getUTCMinutes());
    var ss = String(d.getUTCSeconds());
    return (hh.length < 2 ? '0' + hh : hh) + ':' + (mm.length < 2 ? '0' + mm : mm) + ':' +
      (ss.length < 2 ? '0' + ss : ss) + ' UTC';
  }

  /* ---------------------------------------------------- official state read */

  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }

  function personOf(p) {
    if (!p) return { id: null, name: '' };
    return { id: p.id !== undefined ? p.id : null, name: p.fullName || p.name || '' };
  }

  function baseOf(offense, base) {
    var r = offense && offense[base];
    if (!r) return null;
    return { id: r.id !== undefined ? r.id : null, name: r.fullName || '' };
  }

  /**
   * readState(payload, opts) -> normalized official state
   *   payload: a feed/live document (full or `fields`-projected) or a
   *            playByPlay document; opts: { gamePk, teams, pitchCounts }
   * Every value is read from the payload; absent values are null / ''.
   */
  function readState(payload, opts) {
    opts = opts || {};
    var feed = payload || {};
    var gameData = feed.gameData || {};
    var live = feed.liveData || {};
    var ls = live.linescore || feed.linescore || {};
    var play = (live.plays && live.plays.currentPlay) || feed.currentPlay || null;
    var about = (play && play.about) || {};
    var result = (play && play.result) || {};
    var count = (play && live.count) || ls || {};
    var reviewDetails = (play && play.reviewDetails) || null;
    if (!reviewDetails && play) {
      /* Pitch-level reviews (ABS) attach to a playEvent. */
      var events = play.playEvents || [];
      for (var i = events.length - 1; i >= 0; i -= 1) {
        if (events[i] && events[i].reviewDetails) { reviewDetails = events[i].reviewDetails; break; }
      }
    }
    var meta = feed.metaData || {};
    var status = gameData.status || feed.status || {};
    var offense = ls.offense || {};
    var defense = ls.defense || {};
    var teams = ls.teams || {};
    var counters = gameData.review ? null : null; /* read below */
    var pc = opts.pitchCounts || null;

    var batter = personOf(offense.batter || (play && play.matchup && play.matchup.batter));
    var pitcher = personOf(defense.pitcher || (play && play.matchup && play.matchup.pitcher));

    var state = {
      gamePk: Number(opts.gamePk || gameData.game && gameData.game.pk || feed.gamePk) || null,
      officialDate: (gameData.datetime && gameData.datetime.officialDate) || '',
      teams: opts.teams || readTeams(gameData.teams) || readTeams(lsTeamsShape(ls)),
      statusCode: status.statusCode || '',
      detailedState: status.detailedState || '',
      abstractState: status.abstractGameState || '',
      reason: status.reason || '',
      inning: num(ls.currentInning),
      inningOrdinal: ls.currentInningOrdinal || '',
      half: ls.isTopInning === true ? 'top' : (ls.isTopInning === false ? 'bottom' : ''),
      inningState: ls.inningState || '',
      balls: num(ls.balls),
      strikes: num(ls.strikes),
      outs: num(ls.outs),
      score: {
        away: num(teams.away && teams.away.runs),
        home: num(teams.home && teams.home.runs),
      },
      bases: {
        first: baseOf(offense, 'first'),
        second: baseOf(offense, 'second'),
        third: baseOf(offense, 'third'),
      },
      batter: batter,
      pitcher: pitcher,
      onDeck: personOf(offense.onDeck),
      atBat: {
        index: num(about.atBatIndex),
        complete: about.isComplete === true,
        isScoringPlay: about.isScoringPlay === true,
        eventType: result.eventType || '',
        event: result.event || '',
        description: result.description || '',
        rbi: num(result.rbi),
      },
      review: reviewDetails ? {
        code: String(reviewDetails.reviewType || '').toUpperCase(),
        inProgress: reviewDetails.inProgress === true,
        overturned: typeof reviewDetails.isOverturned === 'boolean' ? reviewDetails.isOverturned : null,
        challengeTeamId: reviewDetails.challengeTeamId || null,
      } : null,
      counters: {
        manager: readManagerCounters(gameData.review),
        abs: readAbsCounters(gameData.absChallenges),
      },
      timecode: meta.timeStamp || '',
      statusTime: status.statusCode || '',
      pitchCounts: pc ? {
        away: num(pc.away),
        home: num(pc.home),
        pitcher: num(pc.pitcher),
        pitcherName: pc.pitcherName || '',
        /* Official per-pitcher / per-batter game lines (box score). */
        lines: pc.lines || null,
      } : null,
      observedAt: Date.now(),
    };
    state.time = parseTimecode(state.timecode);
    state.pitchCount = state.pitchCounts
      ? (state.half === 'top' ? state.pitchCounts.home : state.pitchCounts.away)
      : null;
    state.lineScore = readLineScore(ls);
    return state;
  }

  /* Official club abbreviations by team id (GET /api/v1/teams?sportId=1, the
   * same table ui.js uses).  Used only when the payload does not carry
   * `abbreviation` itself (a `fields` projection can omit it). */
  var TEAM_ABBR = {
    108: 'LAA', 109: 'AZ', 110: 'BAL', 111: 'BOS', 112: 'CHC', 113: 'CIN', 114: 'CLE', 115: 'COL',
    116: 'DET', 117: 'HOU', 118: 'KC', 119: 'LAD', 120: 'WSH', 121: 'NYM', 133: 'ATH', 134: 'PIT',
    135: 'SD', 136: 'SEA', 137: 'SF', 138: 'STL', 139: 'TB', 140: 'TEX', 141: 'TOR', 142: 'MIN',
    143: 'PHI', 144: 'ATL', 145: 'CWS', 146: 'MIA', 147: 'NYY', 158: 'MIL',
  };

  /* linescore teams carry `{ runs, hits, team: { id, name } }`; wrap them in
   * the gameData shape so readTeams can name the clubs when gameData.teams is
   * absent from a `fields` projection. */
  function lsTeamsShape(ls) {
    var t = (ls && ls.teams) || {};
    return {
      away: t.away ? { team: t.away.team || t.away, id: t.away.team && t.away.team.id } : null,
      home: t.home ? { team: t.home.team || t.home, id: t.home.team && t.home.team.id } : null,
    };
  }

  function readTeams(teams) {
    function side(t) {
      var team = (t && t.team) || (t && t.id ? t : {}) || {};
      var id = team.id || (t && t.id) || null;
      var name = team.name || team.teamName || (t && (t.name || t.teamName)) || '';
      var abbr = team.abbreviation || TEAM_ABBR[Number(id)] || '';
      if (!abbr && name) abbr = String(name).replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase();
      return { id: id, name: name, abbreviation: abbr };
    }
    return { away: side(teams && teams.away), home: side(teams && teams.home) };
  }

  function readManagerCounters(review) {
    if (!review) return null;
    var away = review.away || null;
    var home = review.home || null;
    if (!away && !home) return null;
    return {
      hasChallenges: review.hasChallenges === true,
      away: { used: num(away && away.used), remaining: num(away && away.remaining) },
      home: { used: num(home && home.used), remaining: num(home && home.remaining) },
    };
  }

  function readAbsCounters(abs) {
    if (!abs) return null;
    function side(v) {
      if (!v) return { usedSuccessful: null, usedFailed: null, remaining: null };
      return {
        usedSuccessful: num(v.usedSuccessful),
        usedFailed: num(v.usedFailed),
        remaining: num(v.remaining),
      };
    }
    return {
      hasChallenges: abs.hasChallenges === true,
      away: side(abs.away),
      home: side(abs.home),
    };
  }

  function readLineScore(ls) {
    var innings = (ls && ls.innings) || [];
    var teams = (ls && ls.teams) || {};
    return {
      away: {
        runs: num(teams.away && teams.away.runs),
        hits: num(teams.away && teams.away.hits),
        errors: num(teams.away && teams.away.errors),
      },
      home: {
        runs: num(teams.home && teams.home.runs),
        hits: num(teams.home && teams.home.hits),
        errors: num(teams.home && teams.home.errors),
      },
      innings: innings.map(function (inn) {
        return {
          num: inn.num,
          ordinal: inn.ordinalNum || '',
          away: num(inn.away && inn.away.runs),
          home: num(inn.home && inn.home.runs),
        };
      }),
    };
  }

  /* ------------------------------------------------------ state comparison */

  /* The fields whose change is a *baseball* event worth logging.  Everything
   * else (weather, players map, venue) is deliberately excluded so the log is
   * a game log, not a diff dump. */
  function slim(state) {
    if (!state) return null;
    return {
      statusCode: state.statusCode,
      detailedState: state.detailedState,
      abstractState: state.abstractState,
      inning: state.inning,
      half: state.half,
      inningState: state.inningState,
      outs: state.outs,
      balls: state.balls,
      strikes: state.strikes,
      away: state.score.away,
      home: state.score.home,
      first: state.bases.first ? state.bases.first.id : null,
      second: state.bases.second ? state.bases.second.id : null,
      third: state.bases.third ? state.bases.third.id : null,
      batterId: state.batter.id,
      batterName: state.batter.name,
      pitcherId: state.pitcher.id,
      pitcherName: state.pitcher.name,
      atBatIndex: state.atBat.index,
      atBatComplete: state.atBat.complete,
      eventType: state.atBat.eventType,
      description: state.atBat.description,
      review: state.review
        ? state.review.code + '|' + state.review.inProgress + '|' + state.review.overturned
        : '',
      mgrAway: state.counters.manager ? state.counters.manager.away.used : null,
      mgrHome: state.counters.manager ? state.counters.manager.home.used : null,
      absAway: state.counters.abs ? state.counters.abs.away.remaining : null,
      absHome: state.counters.abs ? state.counters.abs.home.remaining : null,
      pitchCount: state.pitchCount,
    };
  }

  function same(a, b) { return a === b || (a === null && b === undefined) || (a === undefined && b === null); }

  function baseLabel(base) {
    return base === 'first' ? '1B' : base === 'second' ? '2B' : '3B';
  }

  function runnersLabel(state) {
    var bits = [];
    ['first', 'second', 'third'].forEach(function (b) {
      var r = state.bases[b];
      if (r) bits.push(baseLabel(b) + ' ' + (r.name || '?'));
    });
    return bits.length ? bits.join(' · ') : 'Bases empty';
  }

  function scoreLabel(state) {
    if (state.score.away === null || state.score.home === null) return '—';
    return state.score.away + '–' + state.score.home;
  }

  function countLabel(state) {
    if (state.balls === null && state.strikes === null) return '—';
    return (state.balls === null ? '—' : state.balls) + '-' + (state.strikes === null ? '—' : state.strikes);
  }

  function inningLabel(state) {
    if (!state.inning) return '';
    var half = state.half === 'top' ? 'Top' : state.half === 'bottom' ? 'Bot' : '';
    var word = state.inningState && state.inningState !== 'Middle' && state.inningState !== 'End'
      ? '' : '';
    return (half + ' ' + state.inning).trim() + (word ? ' ' + word : '') +
      (state.inningState === 'Middle' ? ' (Middle)' : state.inningState === 'End' ? ' (End)' : '');
  }

  function reviewLabel(review) {
    if (!review) return '';
    return 'Review ' + (review.code || '(type not in payload)') +
      (review.inProgress ? ' · under review' : review.overturned === true ? ' · overturned'
        : review.overturned === false ? ' · stands' : '');
  }

  /**
   * diffStates(before, after) -> ordered change list
   *   Each row: { kind, label, before, after, field }
   *   Order is the order a fan would describe the play: status, inning, score,
   *   outs, bases, pitching, at-bat end, at-bat start, count, review, counters.
   */
  function diffStates(before, after) {
    var out = [];
    if (!after) return out;
    var b = before ? slim(before) : null;
    var a = slim(after);
    if (!b) {
      out.push({
        kind: 'state_initial', field: 'state',
        label: 'Official state captured: ' + (after.abstractState || '—') +
          (after.inning ? ' · ' + inningLabel(after) : '') + ' · ' + scoreLabel(after) +
          (after.counters.manager ? ' · challenges ' + challengeSummary(after) : ''),
        before: null, after: { score: scoreLabel(after), count: countLabel(after), outs: after.outs },
      });
      return out;
    }

    if (b.statusCode !== a.statusCode || b.detailedState !== a.detailedState) {
      out.push({
        kind: 'status', field: 'status', before: b.detailedState || b.statusCode || '—',
        after: a.detailedState || a.statusCode || '—',
        label: 'Official status: ' + (b.detailedState || b.statusCode || '—') + ' → ' +
          (a.detailedState || a.statusCode || '—'),
      });
    }

    if (b.inning !== a.inning || b.half !== a.half) {
      out.push({
        kind: 'inning', field: 'inning', before: inningOf(b), after: inningOf(a),
        label: 'Inning: ' + (inningOf(b) || '—') + ' → ' + (inningOf(a) || '—'),
      });
    }

    if (b.away !== a.away || b.home !== a.home) {
      out.push({
        kind: 'score', field: 'score',
        before: b.away + '–' + b.home, after: a.away + '–' + a.home,
        label: 'Score: ' + (b.away === null ? '—' : b.away) + '–' + (b.home === null ? '—' : b.home) +
          ' → ' + (a.away === null ? '—' : a.away) + '–' + (a.home === null ? '—' : a.home),
      });
    }

    if (b.outs !== a.outs) {
      out.push({
        kind: 'outs', field: 'outs', before: b.outs, after: a.outs,
        label: 'Outs: ' + (b.outs === null ? '—' : b.outs) + ' → ' + (a.outs === null ? '—' : a.outs),
      });
    }

    if (b.first !== a.first || b.second !== a.second || b.third !== a.third) {
      out.push({
        kind: 'bases', field: 'bases', before: runnersLabel(before), after: runnersLabel(after),
        label: 'Runners: ' + runnersLabel(after),
      });
    }

    if (b.pitcherId !== a.pitcherId && a.pitcherId) {
      out.push({
        kind: 'pitching_change', field: 'pitcher', before: b.pitcherName || '—', after: a.pitcherName || '—',
        label: 'Pitching change: ' + (a.pitcherName || '—') + (b.pitcherName ? ' replaces ' + b.pitcherName : ''),
      });
    }

    if (b.atBatIndex !== null && a.atBatIndex !== null && a.atBatIndex !== b.atBatIndex) {
      out.push({
        kind: 'inning', field: 'atBatIndex', before: b.atBatIndex, after: a.atBatIndex,
        label: '', quiet: true,
      });
    }

    /* The completed plate appearance, in MLB's own words. */
    if ((b.atBatComplete !== true) && a.atBatComplete === true && a.description) {
      out.push({
        kind: 'atbat_complete', field: 'result',
        before: null, after: a.eventType || 'complete',
        label: a.description,
        official: {
          eventType: a.eventType,
          event: after.atBat.event,
          description: a.description,
          rbi: after.atBat.rbi,
          batter: after.batter.name,
          pitcher: after.pitcher.name,
          score: scoreLabel(after),
          outs: after.outs,
        },
      });
    }

    var newAtBat = b.atBatIndex === null
      ? false
      : (a.atBatIndex !== b.atBatIndex || (b.atBatComplete === true && a.atBatComplete === false));
    if (newAtBat && a.batterName) {
      out.push({
        kind: 'atbat_start', field: 'batter', before: b.batterName || null, after: a.batterName,
        label: 'At bat: ' + a.batterName + (a.pitcherName ? ' vs ' + a.pitcherName : '') +
          (a.pitchCount !== null ? ' · ' + a.pitchCount + ' pitches to this batter' : ''),
      });
    }

    if (b.balls !== a.balls || b.strikes !== a.strikes) {
      var bl = (b.balls === null ? '—' : b.balls) + '-' + (b.strikes === null ? '—' : b.strikes);
      var al = (a.balls === null ? '—' : a.balls) + '-' + (a.strikes === null ? '—' : a.strikes);
      out.push({
        kind: 'count', field: 'count', before: bl, after: al,
        label: 'Count: ' + bl + ' → ' + al + (a.batterName ? ' · ' + a.batterName : ''),
      });
    }

    if (b.review !== a.review) {
      var wasOpen = /true/.test(String(b.review));
      var isOpen = /true/.test(String(a.review));
      out.push({
        kind: isOpen && !wasOpen ? 'review_open' : 'review_update',
        field: 'review',
        before: b.review || null, after: a.review || null,
        label: reviewLabel(after.review) || 'Review state changed',
      });
    }

    if (b.mgrAway !== a.mgrAway || b.mgrHome !== a.mgrHome ||
      b.absAway !== a.absAway || b.absHome !== a.absHome) {
      out.push({
        kind: 'counters', field: 'challenges', before: null, after: challengeSummary(after),
        label: 'Challenge counters: ' + challengeSummary(after),
      });
    }

    if (b.pitchCount !== a.pitchCount && a.pitchCount !== null) {
      out.push({
        kind: 'pitch_count', field: 'pitchCount', before: b.pitchCount, after: a.pitchCount,
        label: 'Pitch count: ' + a.pitchCount + (a.pitcherName ? ' · ' + a.pitcherName : ''),
        quiet: true,
      });
    }

    return out.filter(function (c) { return !c.quiet; });
  }

  function inningOf(s) {
    if (!s.inning) return '';
    return (s.half === 'top' ? 'Top ' : s.half === 'bottom' ? 'Bot ' : '') + s.inning;
  }

  function challengeSummary(state) {
    var bits = [];
    var m = state.counters.manager;
    var a = state.counters.abs;
    var awayAbbr = (state.teams && state.teams.away && state.teams.away.abbreviation) || 'Away';
    var homeAbbr = (state.teams && state.teams.home && state.teams.home.abbreviation) || 'Home';
    function side(abbr, mSide, aSide) {
      var b = [];
      if (mSide && mSide.remaining !== null) b.push(mSide.remaining + ' MGR');
      if (aSide && aSide.remaining !== null) b.push(aSide.remaining + ' ABS');
      return b.length ? abbr + ' ' + b.join(' · ') : '';
    }
    if (m || a) {
      var away = side(awayAbbr, m && m.away, a && a.away);
      var home = side(homeAbbr, m && m.home, a && a.home);
      if (away) bits.push(away);
      if (home) bits.push(home);
    }
    return bits.length ? bits.join(' — ') : 'not published';
  }

  /* ------------------------------------------------------------- event ids */

  /**
   * eventId(gamePk, state, change)
   *   Deterministic so a refresh (or a second browser) cannot double-log the
   *   same observation: game + official revision + change kind + the value it
   *   changed to.  Two different observations of the same revision collapse,
   *   which is exactly the "idempotent log" property the site needs.
   */
  function eventId(gamePk, state, change) {
    var tc = (state && state.timecode) || (state && state.time && state.time.raw) || '';
    var anchor = tc || isoNow(state && state.observedAt);
    return String(gamePk) + ':' + anchor + ':' + change.kind + ':' +
      String(change.field || '') + ':' + String(change.after === null || change.after === undefined ? '' : change.after);
  }

  /**
   * buildEvents(gamePk, before, after, teams) -> [{id, kind, label, ...}]
   *   One row per baseball change, carrying the exact official wording before
   *   and after plus both stamps (MLB's revision and our observation time).
   */
  function buildEvents(gamePk, before, after, teams, matchupLabel) {
    var changes = diffStates(before, after);
    return changes.map(function (c) {
      return {
        id: eventId(gamePk, after, c),
        gamePk: gamePk,
        matchupLabel: matchupLabel || teamsLabel(after.teams || teams),
        kind: c.kind,
        label: c.label,
        field: c.field || '',
        before: c.before,
        after: c.after,
        official: c.official || null,
        timecode: after.timecode || '',
        officialTime: after.time && after.time.valid ? after.time.iso : '',
        observedAt: isoNow(after.observedAt),
        observedMs: after.observedAt,
        score: scoreLabel(after),
        count: countLabel(after),
        outs: after.outs,
        inning: inningLabel(after),
        detail: c.official || null,
      };
    });
  }

  function teamsLabel(teams) {
    if (!teams) return '';
    var a = (teams.away && (teams.away.abbreviation || teams.away.name)) || 'AWAY';
    var h = (teams.home && (teams.home.abbreviation || teams.home.name)) || 'HOME';
    return a + ' @ ' + h;
  }

  /* ----------------------------------------------------------- box scores */

  /**
   * readPlayerLines(boxscore) -> { pitchers: [...], batters: [...] }
   *   Compact official game lines, straight from boxscore.teams.<side>.players
   *   .stats: pitchers (IP, H, R, ER, BB, K, HR, pitches, strikes) and batters
   *   (AB, R, H, RBI, BB, K).  Only players with a line are included, and only
   *   numbers the payload actually published (null otherwise).
   */
  function readPlayerLines(boxscore) {
    var out = { pitchers: [], batters: [] };
    if (!boxscore || !boxscore.teams) return out;
    ['away', 'home'].forEach(function (side) {
      var team = boxscore.teams[side] || {};
      var players = team.players || {};
      Object.keys(players).forEach(function (key) {
        var row = players[key] || {};
        var person = row.person || {};
        var stats = row.stats || {};
        var p = stats.pitching;
        var b = stats.batting;
        if (p && (num(p.numberOfPitches) !== null || num(p.inningsPitched) !== null ||
          String(p.inningsPitched || '').length)) {
          out.pitchers.push({
            side: side,
            id: person.id || null,
            name: person.fullName || '',
            ip: p.inningsPitched !== undefined ? String(p.inningsPitched) : '',
            h: num(p.hits),
            r: num(p.runs),
            er: num(p.earnedRuns),
            bb: num(p.baseOnBalls),
            k: num(p.strikeOuts),
            hr: num(p.homeRuns),
            pitches: num(p.numberOfPitches),
            strikes: num(p.strikes),
          });
        }
        if (b && (num(b.atBats) !== null || num(b.hits) !== null)) {
          out.batters.push({
            side: side,
            id: person.id || null,
            name: person.fullName || '',
            ab: num(b.atBats),
            r: num(b.runs),
            h: num(b.hits),
            rbi: num(b.rbi),
            bb: num(b.baseOnBalls),
            k: num(b.strikeOuts),
          });
        }
      });
    });
    /* Only include a batting line when the batter actually has a plate
     * appearance in this game (the box score lists everyone who played). */
    out.batters = out.batters.filter(function (row) { return (row.ab || 0) + (row.bb || 0) > 0; });
    return out;
  }

  /**
   * readPitchCounts(boxscore, state) -> { away, home, pitcher, pitcherName, lines }
   *   Official totals only: team pitch counts from teamStats.pitching, and the
   *   current pitcher's own count from players[ID].stats.pitching.
   */
  function readPitchCounts(boxscore, state) {
    if (!boxscore || !boxscore.teams) return null;
    function teamPitches(side) {
      var t = boxscore.teams[side] || {};
      var ts = t.teamStats || {};
      var p = ts.pitching || {};
      return num(p.numberOfPitches);
    }
    var out = {
      away: teamPitches('away'),
      home: teamPitches('home'),
      pitcher: null,
      pitcherName: '',
      lines: readPlayerLines(boxscore),
    };
    var current = state && state.pitcher;
    if (current && current.id && (out.away !== null || out.home !== null)) {
      var sideName = state.half === 'top' ? 'home' : 'away'; /* batting top => home pitches */
      var side = boxscore.teams[sideName];
      var players = (side && side.players) || {};
      var row = players['ID' + current.id];
      var pitching = row && row.stats && row.stats.pitching;
      out.pitcher = num(pitching && pitching.numberOfPitches);
      out.pitcherName = (row && row.person && row.person.fullName) || current.name || '';
    }
    return out;
  }

  /* ------------------------------------------------------------- exports */

  global.Latency = {
    TICK_MS: TICK_MS,
    META_MIN_MS: META_MIN_MS,
    META_MAX_MS: META_MAX_MS,
    META_TARGET_RPS: META_TARGET_RPS,
    FINAL_MS: FINAL_MS,
    PREVIEW_MS: PREVIEW_MS,
    SAFETY_PARSE_MS: SAFETY_PARSE_MS,
    PITCH_COUNT_MS: PITCH_COUNT_MS,
    metaIntervalMs: metaIntervalMs,
    pollIntervalMs: pollIntervalMs,
    parseTimecode: parseTimecode,
    timecodeLabel: timecodeLabel,
    isoNow: isoNow,
    clockLabel: clockLabel,
    readState: readState,
    slim: slim,
    diffStates: diffStates,
    buildEvents: buildEvents,
    eventId: eventId,
    readPitchCounts: readPitchCounts,
    readPlayerLines: readPlayerLines,
    teamsLabel: teamsLabel,
    readTeams: readTeams,
    lsTeamsShape: lsTeamsShape,
    scoreLabel: scoreLabel,
    countLabel: countLabel,
    inningLabel: inningLabel,
    runnersLabel: runnersLabel,
    challengeSummary: challengeSummary,
  };
}(window));
