/* ============================================================================
 * reviews-feed.js — the all-games Replay Feed (reviews.html)
 *
 * Watches every game on the slate and surfaces, as a live chat-style feed:
 *   - manager challenges (M*), umpire/crew-chief reviews (N*), instant replay
 *     (IH), boundary calls (umpire-side home run / fair-foul / stadium-boundary
 *     reviews; charged manager challenges of those plays stay challenges)
 *   - ABS pitch challenges (MJ/NJ) with count before/after
 *   - official-scorer pending rulings (os_ruling_pending_*)
 *   - official scoring changes, detected by holding each completed play's exact
 *     official classification and diffing it against a later read
 *
 * LATENCY MODEL (what the owner asked for: the fastest feed for any in-game
 * play-by-play update, and the moment a challenge / manager challenge / review /
 * umpire review / official-scoring-pending appears or is re-scored)
 *
 *   The StatsAPI is pull-only.  Two facts set the floor:
 *     - `metaData.wait` in the feed is MLB's own requested poll interval
 *       (10 s on the live feed), and the live feed is served with max-age=10, so
 *       MLB does not publish a new body faster than that regardless of how
 *       often this page asks.  The page therefore polls faster than the
 *       *cache* only where it costs MLB nothing and buys the user something:
 *       a cached 304-equivalent body is a cheap hit, and the metaData timeStamp
 *       tells us the instant the *next* body lands.
 *     - `gameData.status.statusCode` flips the moment a review is CALLED
 *       (the M family, the N family, IH), while play descriptions are written
 *       when it RESOLVES.  So
 *       the status code is the fastest signal available, and it comes back in a
 *       ~2.4 KB whole-slate projection.
 *
 *   Three loops, cheapest first, all stopping when the tab is hidden:
 *     1. status sweep   — whole slate's official status in one ~2.4 KB request.
 *                         Runs every STATUS_SWEEP_MS while any game is live, and
 *                         the *ms after* it lands a review code the affected
 *                         game is fetched out of band, not on the next cycle.
 *     2. fast probe     — per live game, the lean live-feed projection
 *                         (~2–4 KB: metaData + status + linescore + currentPlay,
 *                         plus the play classifications we must diff).  This is
 *                         what notices a resolution, a reclassification or a
 *                         pending-ruling event with no slate-wide sweep involved.
 *     3. deep read      — on any change signal, one projected per-game read
 *                         (~120–200 KB: all plays + reviewDetails + counters +
 *                         officials) — never the ~1 MB full feed.
 *
 *   All of it is bounded by the shared request budget in api.js (a rolling
 *   limit of BUDGET_PER_MIN per tab, one polling tab per browser), so the
 *   cadence can be tight without exceeding the "individual, non-commercial,
 *   non-bulk use" terms the API notice sets.
 *
 * ALERT PATH vs SCORING LOG
 *   The feed's own tracked entries (reviews/challenges/pending/scoring-change
 *   rows) are persisted through feed-log.js exactly as before.  The separate,
 *   append-only Official Scoring record — exact before/after wording, per-second
 *   game state snapshots, exportable — lives in scoring-log.js and is written
 *   by its own capture loop on its own timer.  This file only *reads* it for the
 *   separate section, so a fault in the logging system cannot silence an alert.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var MLB = global.MLB;
  var UI = global.UI;
  var Reviews = global.Reviews;
  var FeedLog = global.FeedLog;
  var ScoringLog = global.ScoringLog;
  var AlertSound = global.AlertSound;

  /* Fast probe cadence for a live game.  Kept just above the live feed's own
   * update granularity: a shorter interval only re-reads the same body. */
  var SCAN_MS = 250;
  /* Whole-slate official status sweep.  This is the "a review was just called"
   * detector and the cheapest request the page makes. */
  var STATUS_SWEEP_MS = 125;
  var FETCH_CONCURRENCY = 6;
  var FINAL_GRACE_MS = 30 * 60 * 1000;
  var SOUND_COOLDOWN_MS = 1200;
  /* A per-game deep read is skipped while a newer one is still in flight. */
  var DEEP_MIN_GAP_MS = 200;

  /* Alert framing: everything the feed wants to show/alert on, in one request. */
  var PLAYBYPLAY_FIELDS = 'metaData,timeStamp,allPlays,about,atBatIndex,hasReview,isComplete,inning,halfInning,' +
    'isTopInning,isScoringPlay,result,event,eventType,description,isOut,rbi,awayScore,homeScore,count,balls,' +
    'strikes,outs,matchup,batter,id,fullName,pitcher,playEvents,details,call,reviewDetails,isOverturned,' +
    'inProgress,reviewType,challengeTeamId,runners,isScoringEvent,playIndex,movement,index,isPitch,' +
    'pitchNumber,type,startTime,endTime,hasOutcome,review,absChallenges,hasChallenges,away,home,used,' +
    'remaining,usedSuccessful,usedFailed,gameData,status,abstractGameState,codedGameState,detailedState,' +
    'statusCode,reason,officials,official,liveData,linescore,currentPlay,teams,datetime,officialDate,game,' +
    'defense,offense,isTopInning,currentInning,currentInningOrdinal,inningState,runs,hits,errors';

  /* The lean probe: enough to detect every change, ~2–4 KB. */
  var PROBE_FIELDS = 'metaData,timeStamp,gameData,game,status,abstractGameState,codedGameState,' +
    'detailedState,statusCode,reason,review,absChallenges,hasChallenges,away,home,used,remaining,' +
    'usedSuccessful,usedFailed,officials,official,type,fullName,teams,datetime,officialDate,gameDate,' +
    'liveData,linescore,currentInning,currentInningOrdinal,inningState,isTopInning,balls,strikes,outs,' +
    'runs,hits,errors,offense,defense,batter,pitcher,first,second,third,plays,currentPlay,allPlays,' +
    'about,atBatIndex,isComplete,isScoringPlay,halfInning,inning,result,event,eventType,description,' +
    'isOut,rbi,awayScore,homeScore,count,matchup,id,playIndex,movement,isScoringEvent,runners,details,' +
    'playEvents,isPitch,call,pitchNumber,hasReview,reviewDetails,inProgress,isOverturned,reviewType,' +
    'challengeTeamId,index,startTime,endTime';

  var COUNTERS_FIELDS = 'gameData,review,absChallenges,hasChallenges,away,home,used,remaining,usedSuccessful,usedFailed';

  var FILTERS = [
    { id: 'all', label: 'All' },
    { id: 'abs', label: 'ABS' },
    { id: 'challenges', label: 'Challenges' },
    { id: 'reviews', label: 'Reviews' },
    { id: 'boundary', label: 'Boundary Calls' },
    { id: 'under', label: 'Under Review' },
    { id: 'risk', label: '⚠️ Runs at Risk' },
    { id: 'scoring', label: '✏️ Scoring Changes' },
    { id: 'official', label: '📝 Official Scoring Log' },
  ];

  var state = {
    date: MLB.todayISO(),
    dateSeq: 0,
    filter: 'all',
    games: [],
    log: null,
    entries: [],
    snapshots: Object.create(null),
    irregularities: Object.create(null),
    finalSeen: Object.create(null),
    nextDue: Object.create(null),
    probeInFlight: Object.create(null),
    deepInFlight: Object.create(null),
    statusByPk: Object.create(null),
    scanning: false,
    scanError: null,
    soundOn: false,
    notifyOn: false,
    lastChimeAt: 0,
    lastScanAt: 0,
    timers: { scan: null, sweep: null, countdown: null },
    nextScanAt: 0,
    lastRenderSignature: '',
    counterCache: Object.create(null),
    absFetchedRevCount: Object.create(null),
    lastGameDate: undefined,
    lookingForRecent: false,
    /* latency bookkeeping, surfaced in the status line */
    lastSignalAt: 0,
    lastSignalKind: '',
    signalTimes: [],
    sweepInFlight: false,
    lastSweepAt: 0,
    lastProbeAt: 0,
    probeSignatures: Object.create(null),
    officialRows: [],
    officialLoadedAt: 0,
  };

  function $(id) { return document.getElementById(id); }

  function statusLine(text, isError) {
    var el = $('status-line');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-error', !!isError);
  }

  function urlDate() {
    try {
      var params = new URLSearchParams(global.location.search || '');
      var d = params.get('date');
      return MLB.isValidISODate(d) ? d : null;
    } catch (e) { return null; }
  }

  /* Keep the address bar in step with the selected date (shareable links).
   * Guarded: history.replaceState is not writable in every embedding context. */
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
    var backLink = document.querySelector('a.btn[href^="index.html"]');
    if (backLink) backLink.setAttribute('href', 'index.html?date=' + encodeURIComponent(state.date));
    syncUrl();
  }

  function parseDate() {
    /* A ?date=YYYY-MM-DD deep link (reviews.html?date=2026-10-28) wins over the
     * picker, so a shared or bookmarked URL always opens the date it names. */
    var fromUrl = urlDate();
    if (fromUrl) return fromUrl;
    var input = $('date-picker');
    var value = input && input.value;
    return MLB.isValidISODate(value) ? value : MLB.todayISO();
  }

  /* ------------------------------------------------------------ log helpers */

  function upsertEntry(entry) {
    if (!entry || !entry.id) return false;
    var index = -1;
    for (var i = 0; i < state.entries.length; i += 1) {
      if (state.entries[i].id === entry.id) { index = i; break; }
    }
    var now = Date.now();
    if (index === -1) {
      entry.firstSeen = entry.firstSeen || now;
      entry.lastSeen = now;
      state.entries.push(entry);
      return true;
    }
    var prev = state.entries[index];
    var merged = Object.assign({}, prev, entry);
    merged.firstSeen = prev.firstSeen || now;
    merged.lastSeen = now;
    if (prev.scoreTracker && entry.scoreTracker) {
      merged.scoreTracker = Object.assign({}, prev.scoreTracker, entry.scoreTracker);
      /* Never overwrite an observed "before" score with a later guess. */
      if (prev.scoreTracker.before && !entry.scoreTracker.before) {
        merged.scoreTracker.before = prev.scoreTracker.before;
      }
    }
    state.entries[index] = merged;
    return false;
  }

  function noteIrregularity(gamePk, text) {
    if (!gamePk || !text) return;
    var list = state.irregularities[gamePk] || [];
    if (list.indexOf(text) === -1) {
      list.push(text);
      state.irregularities[gamePk] = list.slice(-30);
    }
  }

  function persist(expectedSeq, expectedDate) {
    if (expectedSeq !== undefined && expectedSeq !== state.dateSeq) return;
    if (expectedDate !== undefined && expectedDate !== state.date) return;
    if (!state.log) state.log = FeedLog.emptyPayload(state.date);
    state.log.entries = state.entries.slice();
    state.log.snapshots = state.snapshots;
    state.log.irregularities = state.irregularities;
    state.log.savedAt = Date.now();
    FeedLog.save(state.date, state.log);
  }

  function adoptLog(log) {
    if (!log) return;
    if (log.date && MLB.isValidISODate(log.date) && log.date !== state.date) return;
    state.log = log;
    state.entries = Array.isArray(log.entries)
      ? log.entries.filter(function (e) {
          return !e || !e.officialDate || e.officialDate === state.date;
        })
      : [];
    state.snapshots = log.snapshots || Object.create(null);
    state.irregularities = log.irregularities || Object.create(null);
    /* Restored rows were not observed live: pre-mark runs-at-risk rows so the
     * warning state stays visible but the chime does not fire on restore. */
    state.entries.forEach(function (e) {
      if (e && e.review && e.review.runsAtRiskCount > 0) e.warned = true;
    });
  }

  /* ------------------------------------------------------------- scan cycle */

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

  function finalGraceDelay(finalFirstSeen, elapsed) {
    if (elapsed < 2 * 60 * 1000) return 1000;
    if (elapsed < 5 * 60 * 1000) return 2500;
    return 15000;
  }

  function isReviewStatus(status) {
    var code = String((status && status.statusCode) || '').toUpperCase();
    return /^[MN]/.test(code) || code === 'IH';
  }

  /* Is this game worth polling right now?  Live games always (a game between
   * innings keeps abstractGameState 'Live'); a Final game for FINAL_GRACE_MS,
   * because the official scorer publishes reclassifications after the last out
   * and that window is the whole point of the scoring log. */
  function shouldFetch(game, now) {
    var status = (game.status && game.status.abstractGameState) || '';
    var pk = game.gamePk;
    if (status === 'Live' || isReviewStatus(game.status)) {
      state.nextDue[pk] = now + SCAN_MS;
      return true;
    }
    if (status === 'Final') {
      if (!state.finalSeen[pk]) state.finalSeen[pk] = now;
      var elapsed = now - state.finalSeen[pk];
      if (elapsed > FINAL_GRACE_MS) return false;
      var due = state.nextDue[pk] || 0;
      if (now < due) return false;
      state.nextDue[pk] = now + finalGraceDelay(state.finalSeen[pk], elapsed);
      return true;
    }
    return false;
  }

  /* A deep read = ONE projected per-game feed carrying every play, its
   * reviewDetails, the official counters and the officials.  It replaces the old
   * pair of requests (playByPlay + full feed) and is roughly 1/5th the bytes of
   * the full feed, which is what makes a fast cadence affordable. */
  function fetchGame(game, opts) {
    opts = opts || {};
    return MLB.gameState(game.gamePk, { ttl: 1000, nocache: opts.nocache === true })
      .then(function (payload) {
        return { game: game, payload: payload };
      })
      .catch(function (err) {
        /* Fallback: the raw play-by-play still carries reviewDetails, which is
         * what the feed rows need; counters are then simply absent. */
        return MLB.playByPlay(game.gamePk, { fields: PLAYBYPLAY_FIELDS, retries: 0 })
          .then(function (payload) { return { game: game, payload: payload }; })
          .catch(function () {
            return { game: game, payload: null, error: err };
          });
      });
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
          worker(item).then(function () {
            active -= 1;
            next();
          });
        }
      }
      next();
    });
  }

  /* Signal bookkeeping: one timestamp per observed event, newest last, bounded.
   * The status line reports these so the owner can see observed latency instead
   * of a claimed figure. */
  function markSignal(kind, detail) {
    state.lastSignalAt = Date.now();
    state.lastSignalKind = kind + (detail ? ' · ' + detail : '');
    state.signalTimes.push({ at: state.lastSignalAt, kind: kind });
    if (state.signalTimes.length > 40) state.signalTimes = state.signalTimes.slice(-40);
  }

  /* The lean probe signature.  Any change in it means there is something new to
   * read in full — so the deep read is driven by an observable difference, not
   * by a fixed timer alone. */
  function probeSignature(payload) {
    if (!payload) return '';
    var gd = payload.gameData || {};
    var ld = payload.liveData || {};
    var ls = ld.linescore || {};
    var plays = (ld.plays && ld.plays.allPlays) || payload.allPlays || [];
    var cur = (ld.plays && ld.plays.currentPlay) || {};
    var tail = '';
    /* The last two plays' classification is where a scorer reclassification
     * lands; the count catches anything further back cheaply. */
    var start = Math.max(0, plays.length - 2);
    for (var i = start; i < plays.length; i += 1) {
      var p = plays[i] || {};
      var res = p.result || {};
      var cnt = p.count || {};
      tail += '~' + (p.about && p.about.atBatIndex) + ':' + (res.eventType || '') + ':' +
        (res.isOut === true ? 1 : 0) + ':' + (cnt.outs === undefined ? '' : cnt.outs) + ':' +
        (res.rbi === undefined ? '' : res.rbi) + ':' + (res.awayScore === undefined ? '' : res.awayScore) +
        '-' + (res.homeScore === undefined ? '' : res.homeScore);
    }
    return [
      (payload.metaData && payload.metaData.timeStamp) || '',
      (gd.status && gd.status.statusCode) || '',
      (gd.status && gd.status.detailedState) || '',
      (ls.teams && ls.teams.away && ls.teams.away.runs) + '-' + (ls.teams && ls.teams.home && ls.teams.home.runs),
      ls.currentInning || '',
      ls.inningState || '',
      ls.balls + '-' + ls.strikes + '-' + ls.outs,
      (cur.about && cur.about.atBatIndex) || '',
      (cur.result && cur.result.eventType) || '',
      plays.length,
      tail,
    ].join('|');
  }

  function ingestGame(result, expectedSeq, expectedDate) {
    if (expectedSeq !== undefined && expectedSeq !== state.dateSeq) return { touched: false };
    if (expectedDate !== undefined && expectedDate !== state.date) return { touched: false };
    if (!result || !result.payload) {
      if (result && result.error && !(result.error && result.error.quiet)) {
        state.scanError = result.error;
      }
      return { touched: false };
    }
    var game = result.game;
    var plays = Reviews.playsOf(result.payload);
    var teams = teamsOf(game);
    var meta = { gamePk: game.gamePk, teams: teams, feed: result.payload };
    var touched = false;

    /* Hand the same payload to the Official Scoring log.  It keeps its own
     * store and its own timers; this call only saves it a request.  Wrapped so a
     * fault there can never interrupt an alert below. */
    if (ScoringLog && typeof ScoringLog.ingestGame === 'function') {
      try {
        ScoringLog.ingestGame(state.date, {
          gamePk: game.gamePk,
          teams: teams,
          payload: result.payload,
          capturedAt: Date.now(),
          fullState: true,
        });
      } catch (e) {
        global.console && global.console.warn && global.console.warn('[feed] scoring-log ingest skipped', e);
      }
    }

    /* ---- reviews */
    var reviews = Reviews.extractReviews(plays, meta);
    reviews.forEach(function (review) {
      var existing = state.entries.find(function (e) { return e.id === review.id; });
      var before = existing && existing.scoreTracker && existing.scoreTracker.before ? existing.scoreTracker.before : null;

      var scoreTracker = {
        before: before,
        possible: null,
        actual: null,
      };

      if (review.inProgress) {
        /* Call-on-field score while the review is still open = the score the
         * review is deciding on.  Taken from the official linescore/result. */
        scoreTracker.before = review.score || before;
      } else {
        scoreTracker.actual = review.scoreAfter || null;
        if (!scoreTracker.before) {
          /* Never infer or fill in the pre-ruling score when the page opened
           * after resolution (README §"Before / Possible / Actual score tracker"). */
          noteIrregularity(game.gamePk, 'Before-review score was not observed for ' + review.id + ' (page opened after the ruling).');
        }
      }
      if (scoreTracker.before && review.runsAtRiskCount > 0) {
        scoreTracker.possible = {
          away: scoreTracker.before.away,
          home: scoreTracker.before.home,
        };
        scoreTracker.possible[review.battingSide] = Math.max(0, scoreTracker.possible[review.battingSide] - review.runsAtRiskCount);
      }

      var entry = {
        id: review.id,
        kind: 'review',
        gamePk: game.gamePk,
        matchupLabel: UI.abbr(teams.away) + ' @ ' + UI.abbr(teams.home),
        teams: teams,
        review: review,
        scoreTracker: scoreTracker,
        firstSeenLabel: MLB.formatGameTime(game.gameDate),
      };

      var isNew = upsertEntry(entry);
      /* Always operate on the stored entry: upsertEntry merges into the
       * existing object, so flags like `warned` live there. */
      entry = state.entries.find(function (e) { return e.id === entry.id; }) || entry;

      /* Uploaded reviews.html button title (aef1a74c L39): "a gentle raindrop
       * chime for new challenges/reviews/boundary calls, official-scorer
       * pending rulings and official scoring changes (not ABS), and the same
       * chime whenever an active review could remove a run already on the
       * scoreboard". */
      if (isNew) {
        touched = true;
        markSignal(review.typeLabel, review.code || '');
      } else if (existing && existing.review && existing.review.inProgress && !review.inProgress) {
        touched = true;
        markSignal('review outcome', review.outcome || '');
      }
      if (isNew && !review.isABS) chime('review');
      if (review.runsAtRiskCount > 0 && !entry.warned) {
        /* "whenever an active review could remove a run" — chime the moment
         * the condition first becomes visible (including mid-review), then
         * mark the entry so it never re-chimes. Restored rows are pre-marked
         * in adoptLog (not observed live). */
        entry.warned = true;
        chime('risk');
        notifyRunAtRisk(review, teams);
      }
    });

    /* ---- official-scorer pending rulings */
    var pending = Reviews.pendingRulings(plays, meta);
    pending.forEach(function (row) {
      var isNewPending = upsertEntry({
        id: row.id,
        kind: 'pending',
        gamePk: game.gamePk,
        matchupLabel: UI.abbr(teams.away) + ' @ ' + UI.abbr(teams.home),
        teams: teams,
        pending: row,
        review: {
          typeLabel: 'Official Scorer Ruling Pending',
          reason: row.eventType === 'os_ruling_pending_primary' ? 'Primary event ruling pending' : 'Prior event ruling pending',
          inningLabel: row.inningLabel,
          description: row.description,
          batter: { name: row.batter },
          pitcher: { name: row.pitcher },
          outcome: 'Pending',
          isABS: false,
          isBoundary: false,
          runsAtRiskCount: 0,
          family: 'pending',
        },
      });
      if (isNewPending) { touched = true; chime('pending'); }
    });

    /* ---- official scoring changes */
    var snapshot = Reviews.snapshotPlays(plays);
    var previous = state.snapshots[game.gamePk];
    var diff = Reviews.diffSnapshots(previous, snapshot);
    state.snapshots[game.gamePk] = snapshot;

    diff.changes.forEach(function (change) {
      var isNewChange = upsertEntry({
        id: game.gamePk + ':' + change.atBatIndex + ':scoring-change',
        kind: 'scoring_change',
        gamePk: game.gamePk,
        matchupLabel: UI.abbr(teams.away) + ' @ ' + UI.abbr(teams.home),
        teams: teams,
        change: change,
        review: {
          typeLabel: 'Official Scoring Change',
          reason: '',
          inningLabel: change.inningLabel,
          description: 'Initial call: ' + (change.from.description || '') + ' → Final: ' + (change.to.description || ''),
          batter: { name: change.batter },
          pitcher: { name: '' },
          outcome: 'Reclassified',
          isABS: false,
          isBoundary: false,
          runsAtRiskCount: 0,
          family: 'scoring',
        },
      });
      if (isNewChange) { touched = true; chime('scoring'); }
      if (state.log) {
        state.log.grace = state.log.grace || {};
        state.log.grace[game.gamePk] = Date.now();
      }
    });

    diff.edits.forEach(function (edit) {
      noteIrregularity(game.gamePk, 'Play ' + edit.atBatIndex + ' edited without reclassification (' +
        edit.inningLabel + ') — flagged, not corrected.');
    });
    diff.vanished.forEach(function (gone) {
      noteIrregularity(game.gamePk, 'Play ' + gone.atBatIndex + ' (' + gone.inningLabel +
        ') disappeared from the payload after being observed — flagged, not corrected.');
    });

    /* ---- counter regressions & official MGR / ABS counters */
    state.counterCache = state.counterCache || Object.create(null);
    var prevCached = state.counterCache[game.gamePk] || null;
    /* Counters now ride in the same projected read, so there is no second
     * request.  Accept every shape that can carry them: gameData.review /
     * gameData.absChallenges on the feed, a top-level review block on a plain
     * play-by-play fallback, and the schedule's hydrated review. */
    var gdCounters = (result.payload && result.payload.gameData) || null;
    var extraCounters = result.countersPayload && result.countersPayload.gameData;
    var rawMgr = (gdCounters && gdCounters.review) ||
      (extraCounters && extraCounters.review) ||
      (result.payload && result.payload.review) || (game.review || null);
    var rawAbs = (gdCounters && gdCounters.absChallenges) ||
      (extraCounters && extraCounters.absChallenges) ||
      (result.payload && result.payload.absChallenges) || null;
    var reviewCounters = Reviews.managerCounters(rawMgr) || (prevCached && prevCached.manager) || null;
    var absCounters = Reviews.absCounters(rawAbs) || (prevCached && prevCached.abs) || null;
    state.absFetchedRevCount[game.gamePk] = reviews.length;

    var regression = Reviews.counterRegression(prevCached, {
      manager: reviewCounters, abs: absCounters,
    });
    if (regression) {
      regression.forEach(function (note) {
        noteIrregularity(game.gamePk, 'Official counter ' + note + ' — flagged, not corrected.');
      });
    }
    state.counterCache[game.gamePk] = {
      manager: reviewCounters,
      abs: absCounters,
      awayAbbr: UI.abbr(teams.away),
      homeAbbr: UI.abbr(teams.home),
    };
    return { touched: touched };
  }

  /* Every scan tick does three things in one pass:
   *   a. refresh the slate (cheap, cached 5 s: delayed starts and postponements
   *      matter, but not every 250 ms);
   *   b. deep-read the games whose fast probe says something changed;
   *   c. probe the remaining live games with the lean projection.
   * A game that a status sweep just flagged is fetched out of band (sweep()
   * below) instead of waiting for this pass. */
  /* Manual refresh (the Refresh button, or ReplayFeed.scan()) forces a full
   * deep read of every game worth polling, because a user pressing Refresh is
   * asking for the payload, not for the probe's opinion of it.  The scheduled
   * loop uses runScan(false) and stays probe-driven so it stays cheap. */
  function scan() { return runScan(true); }

  function runScan(force) {
    if (force) state.probeSignatures = Object.create(null);
    if (state.scanning) return;
    if (document.hidden) { scheduleScan(1000); return; }
    if (MLB.isLeader && !MLB.isLeader()) {
      /* Another tab already polls MLB: never double the load.  This tab still
       * renders the shared log (localStorage + the server push). */
      updateChrome();
      scheduleScan(SCAN_MS * 4);
      return;
    }
    var scanSeq = state.dateSeq;
    var scanDate = state.date;
    state.scanning = true;
    state.nextScanAt = Date.now() + SCAN_MS;

    loadSlate(scanDate, scanSeq)
      .then(function (games) {
        if (scanSeq !== state.dateSeq || scanDate !== state.date) return null;
        if (!games) return null;
        state.games = games;
        var now = Date.now();
        var due = state.games.filter(function (g) { return shouldFetch(g, now); });
        state.scanError = null;
        if (!due.length) {
          updateChrome();
          renderIfChanged();
          return null;
        }
        return runLimited(due, FETCH_CONCURRENCY, function (game) {
          if (scanSeq !== state.dateSeq || scanDate !== state.date) return Promise.resolve();
          if (force) return deepRead(game, scanSeq, scanDate, null, { nocache: true });
          return probeGame(game, scanSeq, scanDate);
        }).then(function () {
          if (scanSeq !== state.dateSeq || scanDate !== state.date) return;
          persist(scanSeq, scanDate);
          renderIfChanged();
          updateChrome();
        });
      })
      .catch(function (err) {
        if (scanSeq !== state.dateSeq || scanDate !== state.date) return;
        state.scanError = err;
        updateChrome();
      })
      .then(function () {
        if (scanSeq !== state.dateSeq || scanDate !== state.date) return;
        state.scanning = false;
        state.lastScanAt = Date.now();
        /* Subtract the work time from the next wait so the cadence is the
         * observed period, not the period plus request time. */
        var spent = Date.now() - (state.nextScanAt - SCAN_MS);
        scheduleScan(Math.max(0, SCAN_MS - spent));
      });
  }

  /* The slate is cached briefly.  Between polls, the whole-day status sweep
   * (sweep()) keeps statuses — and therefore the live-game set — current, so a
   * 5 s cake here costs nothing in alert latency. */
  var slateCache = { date: null, at: 0, games: null };

  function loadSlate(date, seq) {
    var now = Date.now();
    if (slateCache.date === date && slateCache.games && now - slateCache.at < 5000) {
      return Promise.resolve(slateCache.games);
    }
    return MLB.schedule(date, { ttl: 0, retries: 0 }).then(function (payload) {
      if (seq !== state.dateSeq || date !== state.date) return null;
      var games = flattenGames(payload);
      slateCache = { date: date, at: Date.now(), games: games };
      return games;
    });
  }

  function scheduleScan(delay) {
    clearTimeout(state.timers.scan);
    state.nextScanAt = Date.now() + delay;
    state.timers.scan = setTimeout(function () { runScan(false); }, delay);
  }

  /* The fast path for one game.
   *
   *   probe (lean, ~2–4 KB) → if the signature changed, or the deep read is due
   *   on the Final-scoring-change cadence → deep read (all plays).
   *
   * A newly-arrived review is caught by the signature (status code changes the
   * instant MLB calls it) and is deep-read in the same tick, so the row appears
   * one round trip after the status flips — not on the next scan. */
  function probeGame(game, seq, date) {
    var pk = game.gamePk;
    if (state.probeInFlight[pk]) return Promise.resolve();
    state.probeInFlight[pk] = true;
    state.lastProbeAt = Date.now();
    var isFinal = (game.status && game.status.abstractGameState) === 'Final';

    if (isFinal) {
      /* Finished games: no lean probe, just the bounded post-Final deep read
       * (the official scorer's window). */
      return deepRead(game, seq, date).then(function () {
        state.probeInFlight[pk] = false;
      });
    }

    return MLB.gameStateLean(pk, { ttl: 300 }).then(function (lean) {
      if (seq !== state.dateSeq || date !== state.date) return null;
      var sig = probeSignature(lean);
      var prevSig = state.probeSignatures[pk];
      state.probeSignatures[pk] = sig;
      var changed = prevSig !== undefined && prevSig !== sig;
      if (prevSig === undefined) markSignal('first read', 'game ' + pk);
      if (changed) markSignal('change', 'game ' + pk);

      /* Keep the per-second state record complete even when the change is too
       * small to be worth a deep read. */
      if (ScoringLog && typeof ScoringLog.ingestGame === 'function') {
        try {
          ScoringLog.ingestGame(date, {
            gamePk: pk,
            teams: teamsOf(game),
            payload: lean,
            capturedAt: Date.now(),
            fullState: true,
          });
        } catch (e) { /* the scoring log must never break an alert */ }
      }

      /* First observation of a game always deep-reads: the counters, the
       * officials and the official scoring baselines must exist before the
       * first alert.  After that, a change signal or the due time triggers it. */
      var due = state.nextDue[pk] || 0;
      if (prevSig !== undefined && !changed && Date.now() < due) return null;
      return deepRead(game, seq, date, lean);
    }).catch(function () {
      /* Individual probe failures are transient; the scan owns the error line. */
    }).then(function () {
      state.probeInFlight[pk] = false;
    });
  }

  function deepRead(game, seq, date, lean, opts) {
    var pk = game.gamePk;
    opts = opts || {};
    /* The status sweep and the fast probe can both decide to read the same game
     * in the same instant.  One in-flight read per game is enough: a duplicate
     * would cost a request and could land out of order. */
    if (state.deepInFlight[pk] && !opts.nocache) return state.deepInFlight[pk];
    var run = fetchGame(game, opts).then(function (result) {
      if (seq !== state.dateSeq || date !== state.date) return;
      var res = ingestGame(result, seq, date);
      if (res && res.touched) {
        persist(seq, date);
        renderIfChanged();
        updateChrome();
      }
      if (lean) {
        /* The lean body is the same read one tick earlier; if the deep read
         * disagrees, the next probe signature reconciles it. */
        state.probeSignatures[pk] = probeSignature(result.payload) || state.probeSignatures[pk];
      }
    }).then(function () {
      state.deepInFlight[pk] = null;
    }, function () {
      state.deepInFlight[pk] = null;
    });
    state.deepInFlight[pk] = run;
    return run;
  }

  /* Whole-slate official status sweep (one ~2.4 KB request).  This is the
   * "review just called" detector: it fires the moment MLB flips statusCode,
   * and the affected game is deep-read immediately, out of band. */
  function sweep() {
    if (document.hidden) return;
    if (state.sweepInFlight) return;
    if (MLB.isLeader && !MLB.isLeader()) return;
    var sweepSeq = state.dateSeq;
    var sweepDate = state.date;
    var live = state.games.some(function (g) {
      return (g.status && g.status.abstractGameState === 'Live') || isReviewStatus(g.status);
    });
    if (!live) return;
    state.sweepInFlight = true;
    state.lastSweepAt = Date.now();
    MLB.slateStatus(sweepDate).then(function (payload) {
      if (sweepSeq !== state.dateSeq || sweepDate !== state.date) return;
      var games = flattenGames(payload);
      /* Fresh statuses keep the scoreboard and the live-game set in step. */
      if (slateCache.date === sweepDate && slateCache.games) {
        games.forEach(function (g) {
          var cached = slateCache.games.find(function (x) { return x.gamePk === g.gamePk; });
          if (cached && g.status) cached.status = g.status;
        });
      }
      games.forEach(function (g) {
        var review = Reviews.statusReview(g.status);
        var prev = state.statusByPk[g.gamePk];
        var nextKey = review ? review.code + '|' + review.reason : '';
        if (prev === nextKey) return;
        state.statusByPk[g.gamePk] = nextKey;
        if (!review) {
          /* Review resolved: deep-read so the outcome ("Stands"/"Overturned")
           * lands in the feed straight away. */
          if (prev) {
            markSignal('review resolved', UI.abbr(teamsOf(g).away) + ' @ ' + UI.abbr(teamsOf(g).home));
            deepRead(g, sweepSeq, sweepDate);
          }
          return;
        }
        markSignal('review called', review.code + ' ' + (review.reason || ''));
        /* Out of band: never wait for the scan loop to finish. */
        deepRead(g, sweepSeq, sweepDate);
      });
    }).catch(function () { /* the scan owns error reporting */ })
      .then(function () { state.sweepInFlight = false; });
  }

  /* ------------------------------------------------------------- sound/notify
   *
   * The sound itself lives in alert-sound.js (a ~3 s raindrop figure, its own
   * volume, its own Test button).  This is only the policy: which events ring.
   * From the owner's brief — every event we alert to and that appears in the
   * feed: new challenges, manager challenges, reviews, umpire reviews, boundary
   * calls, official-scorer pending rulings, official scoring changes, and a run
   * at risk.  Routine ABS pitch challenges are tracked and shown but stay
   * silent: they fire dozens of times a game and the owner's own note excludes
   * them from the chime.
   */
  function chime(reason) {
    if (!state.soundOn) return;
    var now = Date.now();
    if (now - state.lastChimeAt < SOUND_COOLDOWN_MS) return;
    state.lastChimeAt = now;
    if (AlertSound && typeof AlertSound.chime === 'function') {
      AlertSound.chime(reason);
      return;
    }
    /* Fallback only if alert-sound.js failed to load: a single soft drop. */
    try {
      var Ctx = global.AudioContext || global.webkitAudioContext;
      if (!Ctx) return;
      var c = new Ctx();
      var osc = c.createOscillator();
      var gain = c.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1046, c.currentTime);
      osc.frequency.exponentialRampToValueAtTime(784, c.currentTime + 0.35);
      gain.gain.setValueAtTime(0.0001, c.currentTime);
      gain.gain.linearRampToValueAtTime(0.14, c.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.45);
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start();
      osc.stop(c.currentTime + 0.5);
    } catch (e) { /* audio is a nicety, never a failure path */ }
  }

  function notifyRunAtRisk(review, teams) {
    if (!state.notifyOn) return;
    if (typeof global.Notification !== 'function') return;
    if (global.Notification.permission !== 'granted') return;
    try {
      var title = '⚠️ Run at risk — ' + UI.abbr(teams.away) + ' @ ' + UI.abbr(teams.home);
      var body = review.typeLabel + (review.reason ? ' (' + review.reason + ')' : '') +
        ' · ' + review.inningLabel + ' — ' + review.runsAtRiskCount + ' run(s) credited to the reviewed play.';
      new global.Notification(title, { body: body, tag: review.id });
    } catch (e) { /* ignore */ }
  }

  function loadPref(key, fallback) {
    try {
      var raw = global.localStorage.getItem('mlbp.pref.' + key);
      return raw === null ? fallback : raw === '1';
    } catch (e) { return fallback; }
  }

  function savePref(key, value) {
    try { global.localStorage.setItem('mlbp.pref.' + key, value ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ render */

  function entryMatches(entry, filter) {
    if (!entry) return false;
    if (filter === 'all') return (entry.kind === 'review' || entry.kind === 'pending' || entry.kind === 'scoring_change') && !(entry.review && entry.review.isABS);
    if (filter === 'abs') return entry.review && entry.review.isABS;
    if (filter === 'challenges') return entry.review && entry.review.family === 'manager';
    if (filter === 'reviews') return entry.review && (entry.review.family === 'umpire' || entry.review.family === 'replay');
    if (filter === 'boundary') return entry.review && entry.review.isBoundary;
    if (filter === 'under') return entry.review && entry.review.inProgress;
    if (filter === 'risk') return entry.review && entry.review.runsAtRiskCount > 0;
    if (filter === 'scoring') return entry.kind === 'scoring_change';
    if (filter === 'official') return false; /* its own section, not an entry */
    return true;
  }

  function visibleEntries() {
    return state.entries.filter(function (e) { return entryMatches(e, state.filter); })
      .sort(function (a, b) { return (b.lastSeen || 0) - (a.lastSeen || 0); });
  }

  function statsFor() {
    var s = { total: 0, manager: 0, umpire: 0, abs: 0, boundary: 0, under: 0, risk: 0, scoring: 0 };
    state.entries.forEach(function (e) {
      if (e.kind === 'scoring_change') { s.scoring += 1; return; }
      if (e.kind !== 'review') return;
      var r = e.review;
      if (!r) return;
      if (r.isABS) s.abs += 1; else s.total += 1;
      if (r.family === 'manager') s.manager += 1;
      if (r.family === 'umpire' || r.family === 'replay') s.umpire += 1;
      if (r.isBoundary) s.boundary += 1;
      if (r.inProgress) s.under += 1;
      if (r.runsAtRiskCount > 0) s.risk += 1;
    });
    return s;
  }

  function renderTabs() {
    var nav = $('feed-tabs');
    if (!nav) return;
    var officialCount = 0;
    if (ScoringLog) {
      try {
        var rowsAll = officialRows();
        officialCount = rowsAll.pending.length + rowsAll.changes.length;
      } catch (e) { officialCount = 0; }
    }
    nav.innerHTML = FILTERS.map(function (f) {
      var count = f.id === 'official'
        ? officialCount
        : state.entries.filter(function (e) { return entryMatches(e, f.id); }).length;
      return '<button class="tab-btn' + (state.filter === f.id ? ' tab-on' : '') + '" data-filter="' + f.id + '">' +
        UI.esc(f.label) + (count ? ' <span class="tab-badge">' + count + '</span>' : '') + '</button>';
    }).join('');
  }

  function renderStats() {
    var el = $('feed-stats');
    if (!el) return;
    var s = statsFor();
    var tiles = [
      { n: s.total, label: 'Reviews', cls: '' },
      { n: s.manager, label: 'Challenges', cls: '' },
      { n: s.umpire, label: 'Umpire reviews', cls: '' },
      { n: s.abs, label: 'ABS challenges', cls: '' },
      { n: s.boundary, label: 'Boundary calls', cls: '' },
      { n: s.under, label: 'Under review', cls: '' },
      { n: s.risk, label: 'Runs at risk', cls: 'is-risk' },
      { n: s.scoring, label: 'Scoring changes', cls: '' },
    ];
    el.innerHTML = tiles.map(function (t) {
      return '<div class="stat-tile ' + t.cls + '"><div class="stat-num">' + t.n + '</div>' +
        '<div class="stat-label">' + UI.esc(t.label) + '</div></div>';
    }).join('');
  }

  function renderBanner() {
    var el = $('banner');
    if (!el) return;
    var atRisk = state.entries.filter(function (e) {
      return e.review && e.review.inProgress && e.review.runsAtRiskCount > 0;
    });
    if (!atRisk.length) { el.innerHTML = ''; return; }
    el.innerHTML = atRisk.map(function (e) {
      var r = e.review;
      return '<div class="banner-item">' +
        '⚠️ <strong>' + UI.esc(r.runsAtRiskCount + ' run' + (r.runsAtRiskCount === 1 ? '' : 's') + ' at risk') + '</strong>' +
        ' — <a class="banner-link" href="game.html?gamePk=' + encodeURIComponent(e.gamePk) + '&date=' + encodeURIComponent(state.date) + '">' +
        UI.esc(e.matchupLabel || '') + '</a> · ' + UI.esc(r.typeLabel + (r.reason ? ': ' + r.reason : '')) +
        (r.inningLabel ? ' (' + UI.esc(r.inningLabel) + ')' : '') +
      '</div>';
    }).join('');
  }

  function renderActiveStrip() {
    var el = $('active-strip');
    if (!el) return;
    var active = state.entries.filter(function (e) { return e.review && e.review.inProgress; });
    if (!active.length) { el.innerHTML = ''; return; }
    el.innerHTML = '<div class="active-strip"><h3>Under review</h3><div class="active-items">' +
      active.map(function (e) {
        var r = e.review;
        var cached = state.counterCache && state.counterCache[e.gamePk];
        var bothSummary = cached ? Reviews.countersSummary(cached) : '';
        return '<div class="active-item">' +
          '<a href="game.html?gamePk=' + encodeURIComponent(e.gamePk) + '&date=' + encodeURIComponent(state.date) + '"><b>' + UI.esc(e.matchupLabel || '') + '</b></a>' +
          UI.chip(r.typeLabel + (r.reason ? ': ' + r.reason : ''), r.isABS ? 'chip-abs' : 'chip-review') +
          '<span>' + UI.esc(r.inningLabel || '') + '</span>' +
          (r.runsAtRiskCount ? UI.chip('⚠️ ' + r.runsAtRiskCount + ' run(s) at risk', 'chip-danger') : '') +
          (bothSummary ? '<span class="counter-note">' + UI.esc(bothSummary) + '</span>' : '') +
          '</div>';
      }).join('') + '</div></div>';
  }

  function scoreLine(label, score) {
    if (!score) return '';
    return '<dt>' + UI.esc(label) + '</dt><dd>' + UI.esc(score.away) + '–' + UI.esc(score.home) + '</dd>';
  }

  function renderRow(entry) {
    var r = entry.review || {};
    var tracker = entry.scoreTracker || {};
    var cls = 'feed-row';
    if (r.inProgress) cls += ' is-live';
    if (r.runsAtRiskCount) cls += ' is-at-risk';

    var avatar = r.isABS ? '🎯' : r.isBoundary ? '📏' : entry.kind === 'scoring_change' ? '✏️' : entry.kind === 'pending' ? '📝' : '🚨';

    var chips = [];
    chips.push(UI.chip(r.typeLabel || 'Review', r.isABS ? 'chip-abs' : 'chip-review'));
    if (r.reason) chips.push(UI.chip(r.reason, 'chip-review'));
    if (r.isBoundary) chips.push(UI.chip('Boundary call', 'chip-warn'));
    if (r.inProgress) chips.push(UI.chip('Under review', 'chip-warn'));
    else if (r.outcome) chips.push(UI.chip(r.outcome, r.outcome === 'Overturned' ? 'chip-ok' : ''));
    if (r.runsAtRiskCount) chips.push(UI.chip('⚠️ ' + r.runsAtRiskCount + ' run(s) at risk', 'chip-danger'));

    var trackerHtml = '';
    if (entry.kind === 'review' && (tracker.before || tracker.possible || tracker.actual)) {
      trackerHtml = '<dl class="score-track">' +
        (tracker.before ? scoreLine('Before review', tracker.before) : '<dt>Before review</dt><dd>— (not observed before ruling)</dd>') +
        (tracker.possible ? scoreLine('Possible after (conditional)', tracker.possible)
          : (r.isBoundary && !(r.runsAtRiskCount > 0)
            /* README: "A boundary review with no currently credited run says
             * 'score impact pending' and does not invent an alternate score." */
            ? '<dt>Possible after (conditional)</dt><dd>score impact pending</dd>'
            : (r.runsAtRiskCount > 0
              ? '<dt>Possible after (conditional)</dt><dd>— (not observed before ruling)</dd>'
              : ''))) +
        scoreLine('Actual after (official)', tracker.actual) +
        '</dl>';
    }

    var absLine = '';
    if (r.isABS && r.absCountBefore) {
      absLine = '<div class="feed-sub">Pitch ' + UI.esc(r.absPitchNumber) +
        ' · count before ' + r.absCountBefore.balls + '-' + r.absCountBefore.strikes +
        (r.absCountAfter ? ' · after ' + r.absCountAfter.balls + '-' + r.absCountAfter.strikes : '') + '</div>';
    }

    var counterText = '';
    var counterSummaryTitle = '';
    var cached = state.counterCache && state.counterCache[entry.gamePk];
    /* README counter examples prefix the challenging team's abbreviation
     * ("CIN: 2 ABS challenges left now (…)" / "PIT: 1 manager challenge left
     * now (0 used)"). */
    var challengerLabel = (r.challengerSide && entry.teams && entry.teams[r.challengerSide])
      ? UI.abbr(entry.teams[r.challengerSide]) : '';
    if (cached) {
      counterSummaryTitle = Reviews.countersSummary(cached);
      if (r.family === 'manager' && r.challengerSide && cached.manager && cached.manager[r.challengerSide]) {
        counterText = Reviews.counterLine({ manager: cached.manager, side: r.challengerSide, label: challengerLabel });
      }
      if (r.isABS && r.challengerSide && cached.abs && cached.abs[r.challengerSide]) {
        counterText = Reviews.counterLine({ abs: cached.abs, side: r.challengerSide, label: challengerLabel });
      }
      if (!counterText && counterSummaryTitle) {
        counterText = counterSummaryTitle;
      }
    }

    var changeHtml = '';
    if (entry.kind === 'scoring_change' && entry.change) {
      changeHtml = '<div class="feed-sub">Initial call: ' + UI.esc(entry.change.from && entry.change.from.description ? entry.change.from.description : '') +
        '</div><div class="feed-sub">Final ruling: ' + UI.esc(entry.change.to && entry.change.to.description ? entry.change.to.description : '') + '</div>' +
        (entry.change.scoreAfter ? '<div class="feed-sub">Official score after the play: ' +
          UI.esc(entry.change.scoreAfter.away) + '–' + UI.esc(entry.change.scoreAfter.home) + '</div>' : '') +
        '<div class="feed-irregular">Attribution: ' + UI.esc(entry.change.attribution || '') + '</div>';
    }

    var pendingHtml = '';
    if (entry.kind === 'pending' && entry.pending) {
      pendingHtml = '<div class="feed-sub">' + UI.esc(entry.pending.description || '') + '</div>' +
        '<div class="feed-irregular">Source: ' + UI.esc(entry.pending.source || '') + '</div>';
    }

    /* Irregularity notes that name this entry's id belong on this row only —
     * never repeat a game's first note on every row. Game-level notes (no
     * entry id) render once as flagged rows in renderList. */
    var irregularity = '';
    (state.irregularities[entry.gamePk] || []).some(function (n) {
      if (entry.id && n.indexOf(entry.id) !== -1) { irregularity = n; return true; }
      return false;
    });

    return '<div class="' + cls + '">' +
      '<div class="feed-avatar">' + avatar + '</div>' +
      '<div class="feed-body">' +
        '<div class="feed-top">' +
          '<a href="game.html?gamePk=' + encodeURIComponent(entry.gamePk) + '&date=' + encodeURIComponent(state.date) + '"><b>' + UI.esc(entry.matchupLabel || '') + '</b></a>' +
          '<span>' + UI.esc(r.inningLabel || '') + '</span>' +
          (r.challengerSide && r.challengerSide !== 'unknown' && r.challenger
            ? '<span>Challenged by ' + UI.esc(r.challenger) + (r.challengerRole ? ' (' + UI.esc(r.challengerRole) + ')' : '') + '</span>' : '') +
          '<span>' + new Date(entry.lastSeen || Date.now()).toLocaleTimeString() + '</span>' +
          '<a href="https://statsapi.mlb.com/api/v1/game/' + encodeURIComponent(entry.gamePk) + '/playByPlay" target="_blank" rel="noopener" title="Official MLB StatsAPI play-by-play source">MLB API ↗</a>' +
        '</div>' +
        '<div class="feed-title">' + UI.esc((r.batter && r.batter.name) || '') +
          (r.pitcher && r.pitcher.name ? ' vs ' + UI.esc(r.pitcher.name) : '') + '</div>' +
        (r.description ? '<div class="feed-sub">' + UI.esc(r.description) + '</div>' : '') +
        absLine + changeHtml + pendingHtml +
        (trackerHtml ? trackerHtml : '') +
        (counterText ? '<div class="counter-note"' + (counterSummaryTitle ? ' title="' + UI.esc(counterSummaryTitle) + '"' : '') + '>' + UI.esc(counterText) + '</div>' : '') +
        (irregularity ? '<div class="feed-irregular">⚠️ ' + UI.esc(irregularity) + '</div>' : '') +
        '<div class="feed-chips">' + chips.join('') + '</div>' +
      '</div>' +
    '</div>';
  }

  /* Same idea as the scoreboard: only touch the DOM when the tracked data
   * actually changed, so a 250 ms scan does not re-create identical rows. */
  function offerRecentDate() {
    if (state.lastGameDate !== undefined || state.lookingForRecent) return;
    state.lookingForRecent = true;
    var reqSeq = state.dateSeq;
    var reqDate = state.date;
    var from = MLB.shiftISODate(reqDate, -180);
    MLB.scheduleRange(from, reqDate)
      .then(function (payload) {
        if (reqSeq !== state.dateSeq || reqDate !== state.date) return;
        var dates = ((payload && payload.dates) || []).filter(function (d) {
          return d && d.totalGames > 0;
        });
        state.lastGameDate = dates.length ? dates[dates.length - 1].date : null;
      })
      .catch(function () {
        if (reqSeq === state.dateSeq && reqDate === state.date) state.lastGameDate = null;
      })
      .then(function () {
        if (reqSeq !== state.dateSeq || reqDate !== state.date) return;
        state.lookingForRecent = false;
        if (state.lastGameDate) render();
      });
  }

  function entriesSignature() {
    return state.filter + '|' + state.games.length + '|' + (state.lastGameDate || '') + '|' + state.entries.map(function (e) {
      return [e.id, e.lastSeen, e.review && e.review.outcome, e.review && e.review.inProgress,
        e.scoreTracker && e.scoreTracker.actual ? e.scoreTracker.actual.away + '-' + e.scoreTracker.actual.home : '',
        e.scoreTracker && e.scoreTracker.before ? e.scoreTracker.before.away + '-' + e.scoreTracker.before.home : ''].join(':');
    }).join('|');
  }

  function renderIfChanged() {
    var sig = entriesSignature();
    if (sig === state.lastRenderSignature) return;
    state.lastRenderSignature = sig;
    render();
  }

  /* One flagged row for a game-level irregularity (a note that names no
   * entry). Rendered once per note above the entry rows: flagged for review,
   * never corrected or hidden (uploaded reviews.html footer). */
  function flaggedRowHtml(entry, note) {
    return '<div class="feed-row flagged-row">' +
      '<div class="feed-avatar">🚩</div>' +
      '<div class="feed-body">' +
        '<div class="feed-top">' +
          '<a href="game.html?gamePk=' + encodeURIComponent(entry.gamePk) + '&date=' + encodeURIComponent(state.date) + '"><b>' + UI.esc(entry.matchupLabel || '') + '</b></a>' +
          '<span>Flagged for review</span>' +
          '<a href="https://statsapi.mlb.com/api/v1/game/' + encodeURIComponent(entry.gamePk) + '/playByPlay" target="_blank" rel="noopener" title="Official MLB StatsAPI play-by-play source">MLB API ↗</a>' +
        '</div>' +
        '<div class="feed-irregular">⚠️ ' + UI.esc(note) + '</div>' +
        '<div class="feed-chips">' + UI.chip('Irregularity', 'chip-warn') + UI.chip('Source data', 'chip-review') + '</div>' +
      '</div>' +
    '</div>';
  }

  /* ------------------------------------------------ official scoring section
   *
   * SEPARATE FROM THE ALERT FEED.  These rows come from scoring-log.js, which
   * owns its own store and its own capture timer; nothing here chimes, and a
   * failure inside this section leaves the alert feed untouched.  The owner
   * asked for exactly that isolation, and for the record to survive a refresh —
   * it is written to localStorage and (when the persistence server is running)
   * to its own append-only server file, then restored before the first scan.
   */

  function officialRows() {
    if (!ScoringLog) return { pending: [], changes: [], anomalies: [] };
    return {
      pending: ScoringLog.rows(state.date, 'pending'),
      changes: ScoringLog.rows(state.date, 'changes'),
      anomalies: ScoringLog.rows(state.date, 'anomalies'),
    };
  }

  function stateRowHtml(gamePk) {
    if (!ScoringLog || typeof ScoringLog.stateOf !== 'function') return '';
    var s = ScoringLog.stateOf(state.date, gamePk);
    if (!s) return '';
    var at = s.capturedAtISO ? new Date(s.capturedAt).toLocaleTimeString() : '';
    var score = (s.score && (s.score.away !== null || s.score.home !== null))
      ? s.score.away + '–' + s.score.home : '—';
    var count = s.count ? (s.count.balls + '-' + s.count.strikes + ', ' + s.count.outs + ' out' +
      (s.count.outs === 1 ? '' : 's')) : '—';
    var inning = s.inning && s.inning.number ? ((s.inning.half === 'Top' || s.inning.isTop === true) ? 'Top ' : 'Bot ') + s.inning.number : '—';
    return '<div class="official-state">' +
      '<span class="os-chip">captured ' + UI.esc(at) + '</span>' +
      '<span class="os-chip">feed stamp ' + UI.esc(s.officialTimeStamp || '—') + '</span>' +
      '<span class="os-chip">' + UI.esc(score) + '</span>' +
      '<span class="os-chip">' + UI.esc(inning) + '</span>' +
      '<span class="os-chip">count ' + UI.esc(count) + '</span>' +
      '<span class="os-chip">' + UI.esc(s.batter && s.batter.name ? 'AB: ' + s.batter.name : 'AB: —') + '</span>' +
      '<span class="os-chip">' + UI.esc(s.pitcher && s.pitcher.name ? 'P: ' + s.pitcher.name : 'P: —') + '</span>' +
      '<span class="os-chip">' + UI.esc(s.runners && (s.runners.first || s.runners.second || s.runners.third)
        ? 'runners on ' + [s.runners.first && '1B', s.runners.second && '2B', s.runners.third && '3B'].filter(Boolean).join('·')
        : 'bases empty') + '</span>' +
      (s.status && s.status.detailed ? '<span class="os-chip">' + UI.esc(s.status.detailed) + '</span>' : '') +
      '</div>';
  }

  function pendingCardHtml(r) {
    var resolved = !!r.resolution;
    var wording = r.officialWording || '(the payload published no description)';
    var html = '<article class="official-card' + (resolved ? ' is-resolved' : ' is-pending') + '">' +
      '<header class="official-head">' +
        '<b>' + UI.esc(r.matchupLabel || '') + '</b>' +
        '<span>' + UI.esc(r.inningLabel || '') + '</span>' +
        UI.chip(resolved ? 'Ruling made' : 'Pending', resolved ? 'chip-ok' : 'chip-warn') +
        (r.kindLabel ? UI.chip(r.kindLabel, 'chip-review') : '') +
        '<span class="os-time">observed ' + UI.esc(new Date(r.firstSeen || r.capturedAt).toLocaleTimeString()) + '</span>' +
        '<a href="game.html?gamePk=' + encodeURIComponent(r.gamePk) + '&date=' + encodeURIComponent(state.date) + '">open game</a>' +
      '</header>' +
      '<div class="official-body">' +
        '<div class="os-line"><span class="os-label">Official event</span><code>' + UI.esc(r.eventType) + '</code></div>' +
        '<div class="os-line"><span class="os-label">Official wording</span><q>' + UI.esc(wording) + '</q></div>' +
        (r.batter || r.pitcher ? '<div class="os-line"><span class="os-label">At bat</span>' + UI.esc(r.batter || '—') +
          (r.pitcher ? ' vs ' + UI.esc(r.pitcher) : '') + '</div>' : '') +
        stateRowHtml(r.gamePk) +
        (resolved
          ? '<div class="os-line"><span class="os-label">Resolved to</span><code>' + UI.esc(r.resolution.eventType) + '</code> ' +
            '<q>' + UI.esc(r.resolution.description || '') + '</q></div>'
          : '<div class="os-line"><span class="os-label">Ruling</span><em>not yet published by the official scorer</em></div>') +
        '<div class="os-line os-source"><span class="os-label">Source</span>' + UI.esc(r.source || '') + '</div>' +
      '</div>' +
    '</article>';
    return html;
  }

  function changeCardHtml(r) {
    var before = r.before || {};
    var after = r.to || {};
    return '<article class="official-card is-change">' +
      '<header class="official-head">' +
        '<b>' + UI.esc(r.matchupLabel || '') + '</b>' +
        '<span>' + UI.esc(r.inningLabel || '') + '</span>' +
        UI.chip('Reclassified', 'chip-ok') +
        '<span class="os-time">detected ' + UI.esc(new Date(r.detectedAt || r.firstSeen).toLocaleTimeString()) + '</span>' +
        '<a href="game.html?gamePk=' + encodeURIComponent(r.gamePk) + '&date=' + encodeURIComponent(state.date) + '">open game</a>' +
      '</header>' +
      '<div class="official-body">' +
        '<div class="os-line"><span class="os-label">Batter</span>' + UI.esc(r.batter || '—') + '</div>' +
        '<div class="os-before-after">' +
          '<div class="os-side os-before"><h5>Before (observed ' + UI.esc(before.capturedAtISO ? new Date(before.capturedAt).toLocaleTimeString() : 'earlier') + ')</h5>' +
            '<div class="os-line"><span class="os-label">eventType</span><code>' + UI.esc(before.eventType || '—') + '</code></div>' +
            '<div class="os-line"><span class="os-label">description</span><q>' + UI.esc(before.description || '—') + '</q></div>' +
            '<div class="os-line"><span class="os-label">isOut</span><code>' + UI.esc(String(before.isOut)) + '</code></div>' +
            '<div class="os-line"><span class="os-label">outs</span><code>' + UI.esc(before.outs === null || before.outs === undefined ? '—' : before.outs) + '</code></div>' +
            '<div class="os-line"><span class="os-label">RBI</span><code>' + UI.esc(before.rbi === null || before.rbi === undefined ? '—' : before.rbi) + '</code></div>' +
            '<div class="os-line"><span class="os-label">score</span><code>' + UI.esc((before.awayScore === null ? '—' : before.awayScore) + '–' + (before.homeScore === null ? '—' : before.homeScore)) + '</code></div>' +
          '</div>' +
          '<div class="os-side os-after"><h5>After (observed ' + UI.esc(r.detectedAtISO ? new Date(r.detectedAt).toLocaleTimeString() : 'now') + ')</h5>' +
            '<div class="os-line"><span class="os-label">eventType</span><code>' + UI.esc(after.eventType || '—') + '</code></div>' +
            '<div class="os-line"><span class="os-label">description</span><q>' + UI.esc(after.description || '—') + '</q></div>' +
            '<div class="os-line"><span class="os-label">isOut</span><code>' + UI.esc(String(after.isOut)) + '</code></div>' +
            '<div class="os-line"><span class="os-label">outs</span><code>' + UI.esc(after.outs === null || after.outs === undefined ? '—' : after.outs) + '</code></div>' +
            '<div class="os-line"><span class="os-label">RBI</span><code>' + UI.esc(after.rbi === null || after.rbi === undefined ? '—' : after.rbi) + '</code></div>' +
            '<div class="os-line"><span class="os-label">score</span><code>' + UI.esc((after.awayScore === null ? '—' : after.awayScore) + '–' + (after.homeScore === null ? '—' : after.homeScore)) + '</code></div>' +
          '</div>' +
        '</div>' +
        '<div class="os-line os-source"><span class="os-label">Why</span>' + UI.esc(r.attribution || '') + '</div>' +
        '<div class="os-line os-source"><span class="os-label">Evidence</span>' + UI.esc(r.source || '') + '</div>' +
      '</div>' +
    '</article>';
  }

  function anomalyCardHtml(r) {
    return '<article class="official-card is-anomaly">' +
      '<header class="official-head">' +
        '<b>' + UI.esc(r.gamePk ? 'game ' + r.gamePk : '') + '</b>' +
        '<span>' + UI.esc(r.inningLabel || '') + '</span>' +
        UI.chip(r.kind === 'vanished' ? 'Play disappeared' : 'Edited, not reclassified', 'chip-warn') +
        '<span class="os-time">' + UI.esc(new Date(r.capturedAt || r.firstSeen).toLocaleTimeString()) + '</span>' +
      '</header>' +
      '<div class="official-body">' +
        '<div class="os-line">' + UI.esc(r.note || '') + '</div>' +
        (r.before && r.after
          ? '<div class="os-line"><span class="os-label">before → after</span>' +
            '<code>' + UI.esc(JSON.stringify(r.before)) + '</code> → <code>' + UI.esc(JSON.stringify(r.after)) + '</code></div>'
          : '') +
      '</div>' +
    '</article>';
  }

  function renderOfficialSection() {
    var list = $('feed-list');
    if (!list) return;
    var rows = officialRows();
    var total = rows.pending.length + rows.changes.length + rows.anomalies.length;
    var header = '<div class="official-head-bar">' +
      '<div>' +
        '<h2>Official scoring log</h2>' +
        '<p>Kept separately from the alert feed. Pending rulings are the API\'s own ' +
        '<code>os_ruling_pending_primary</code> / <code>os_ruling_pending_prior</code> event types; ' +
        'changes hold the exact official wording before and after. This record is written to ' +
        (ScoringLog && ScoringLog.apiState && ScoringLog.apiState.available
          ? 'the shared server log and this browser'
          : 'this browser') + ' and survives a refresh.</p>' +
      '</div>' +
      '<div class="official-actions">' +
        '<button class="btn" onclick="ReplayFeed.exportOfficial(\'json\')">Export JSON</button>' +
        '<button class="btn btn-ghost" onclick="ReplayFeed.exportOfficial(\'csv\')">Export CSV</button>' +
        '<button class="btn btn-ghost" onclick="ReplayFeed.reloadOfficial()">Reload</button>' +
      '</div>' +
    '</div>';

    if (!total) {
      list.innerHTML = header + '<div class="feed-empty">' +
        'Nothing logged for this date yet. A pending official-scorer ruling (' +
        '<code>os_ruling_pending_primary</code> / <code>os_ruling_pending_prior</code>) or a ' +
        'reclassification of a completed at-bat is recorded here the second this page observes it, ' +
        'with the official wording on both sides.</div>';
      return;
    }

    var pendingHtml = rows.pending.length
      ? '<h3 class="official-sub">Pending official scorer rulings (' + rows.pending.length + ')</h3>' +
        rows.pending.map(pendingCardHtml).join('')
      : '<p class="official-none">No pending-ruling events observed on this date.</p>';
    var changeHtml = rows.changes.length
      ? '<h3 class="official-sub">Scoring changes (' + rows.changes.length + ')</h3>' +
        rows.changes.map(changeCardHtml).join('')
      : '<p class="official-none">No reclassifications observed on this date.</p>';
    var anomalyHtml = rows.anomalies.length
      ? '<h3 class="official-sub">Flagged, not corrected (' + rows.anomalies.length + ')</h3>' +
        rows.anomalies.map(anomalyCardHtml).join('')
      : '';
    list.innerHTML = header + pendingHtml + changeHtml + anomalyHtml;
  }

  function reloadOfficial() {
    if (!ScoringLog) return;
    ScoringLog.load(state.date).then(function () {
      render();
    });
  }

  function download(name, text, mime) {
    try {
      var blob = new global.Blob([text], { type: mime });
      var url = global.URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { global.URL.revokeObjectURL(url); }, 2000);
      return true;
    } catch (e) {
      statusLine('Export failed in this browser: ' + e.message, true);
      return false;
    }
  }

  function exportOfficial(format) {
    if (!ScoringLog) return;
    var payload = ScoringLog.exportPayload(state.date);
    if (format === 'csv') {
      var cols = ['atBatIndex', 'gamePk', 'matchupLabel', 'inningLabel', 'eventType', 'officialWording',
        'firstSeen', 'lastSeen', 'resolutionEventType', 'resolutionWording'];
      var rows = payload.pending.map(function (r) {
        return Object.assign({}, r, {
          resolutionEventType: r.resolution && r.resolution.eventType,
          resolutionWording: r.resolution && r.resolution.description,
        });
      });
      download('official-scoring-pending-' + state.date + '.csv',
        ScoringLog.toCSV(rows, cols), 'text/csv;charset=utf-8');
      return;
    }
    download('official-scoring-log-' + state.date + '.json',
      JSON.stringify(payload, null, 2), 'application/json');
  }

  function render() {
    renderBanner();
    renderTabs();
    renderStats();
    renderActiveStrip();
    var list = $('feed-list');
    if (!list) return;
    /* The Official Scoring Log is its own section on its own tab: it is a
     * record, not an alert, and it must never be mixed into (or able to break)
     * the alert feed's rows. */
    if (state.filter === 'official') {
      renderOfficialSection();
      return;
    }
    var rows = visibleEntries();
    if (!rows.length) {
      var emptyNote = 'No tracked events for this date and filter yet. New challenges, reviews, boundary calls, ABS challenges, official-scorer pending rulings and official scoring changes appear here live.';
      if (!state.games.length && !state.entries.length) {
        list.innerHTML = '<div class="panel" style="text-align:center;color:var(--muted)">' +
          'No games scheduled for ' + UI.esc(MLB.formatDateLabel(state.date)) + '.' +
          '<div class="feed-empty">' + UI.esc(emptyNote) + '</div>' +
          (state.lastGameDate
            ? '<div style="margin-top:10px">Most recent date with games: ' +
              UI.esc(MLB.formatDateLabel(state.lastGameDate)) + ' ' +
              '<button class="btn" onclick="ReplayFeed.setDate(\'' + state.lastGameDate + '\')">Show it</button></div>'
            : '') +
          '</div>';
        offerRecentDate();
      } else {
        list.innerHTML = '<div class="feed-empty">' + UI.esc(emptyNote) + '</div>';
      }
      return;
    }
    var flagged = [];
    var seenGames = Object.create(null);
    rows.forEach(function (e) {
      if (!e || seenGames[e.gamePk]) return;
      seenGames[e.gamePk] = true;
      (state.irregularities[e.gamePk] || []).forEach(function (n) {
        var namesEntry = state.entries.some(function (x) {
          return x && x.gamePk === e.gamePk && x.id && n.indexOf(x.id) !== -1;
        });
        if (!namesEntry) flagged.push(flaggedRowHtml(e, n));
      });
    });
    list.innerHTML = flagged.join('') + rows.map(renderRow).join('');
  }

  /* Observed-latency line.  These are measured here (wall clock at the moment
   * this page saw the change), not claimed: the middle value is the gap between
   * the last change signal and the scan that carried it. */
  function latencyLine() {
    var parts = [];
    parts.push('probe ' + SCAN_MS + 'ms');
    parts.push('status sweep ' + STATUS_SWEEP_MS + 'ms');
    if (state.lastSignalAt) {
      parts.push('last signal ' + new Date(state.lastSignalAt).toLocaleTimeString() +
        (state.lastSignalKind ? ' (' + state.lastSignalKind + ')' : ''));
    }
    if (MLB.budgetSummary) {
      try { parts.push(MLB.budgetSummary()); } catch (e) { /* diagnostics only */ }
    }
    return parts.join(' · ');
  }

  function updateChrome() {
    var label = $('countdown');
    if (label) {
      var left = Math.max(0, state.nextScanAt - Date.now());
      label.textContent = document.hidden ? 'paused' : (left / 1000).toFixed(1) + 's';
    }
    var dot = $('live-dot');
    if (dot) dot.style.opacity = state.scanError ? '0.3' : '1';
    var lat = $('latency-line');
    if (lat) lat.textContent = latencyLine();
    if (state.scanError) {
      statusLine('Scan problem: ' + (state.scanError.message || 'network error') + ' — retrying.', true);
    } else {
      var live = state.games.filter(function (g) { return g.status && g.status.abstractGameState === 'Live'; }).length;
      statusLine(state.games.length + ' game(s) on ' + MLB.formatDateLabel(state.date) +
        ' · ' + live + ' live · ' + state.entries.length + ' tracked entr' + (state.entries.length === 1 ? 'y' : 'ies') +
        ' · scanned ' + new Date(state.lastScanAt || Date.now()).toLocaleTimeString() +
        (FeedLog.state.available ? ' · shared log connected' : ' · local log only') +
        (ScoringLog && ScoringLog.isRunning && ScoringLog.isRunning() ? ' · scoring log capturing' : ''));
    }
  }

  /* -------------------------------------------------------------------- nav */

  function setDate(date) {
    var clean = MLB.isValidISODate(date) ? date : MLB.todayISO();
    if (clean === state.date) return;
    state.dateSeq += 1;
    var seq = state.dateSeq;
    clearTimeout(state.timers.scan);
    state.scanning = false;
    state.date = clean;
    state.games = [];
    state.entries = [];
    state.snapshots = Object.create(null);
    state.irregularities = Object.create(null);
    state.finalSeen = Object.create(null);
    state.nextDue = Object.create(null);
    state.probeInFlight = Object.create(null);
    state.deepInFlight = Object.create(null);
    state.probeSignatures = Object.create(null);
    state.statusByPk = Object.create(null);
    state.counterCache = Object.create(null);
    state.absFetchedRevCount = Object.create(null);
    state.lastGameDate = undefined;
    state.lookingForRecent = false;
    state.log = null;
    state.lastRenderSignature = '';
    slateCache = { date: null, at: 0, games: null };
    syncNav();
    render();
    FeedLog.closeStream();
    if (ScoringLog) {
      try { ScoringLog.setDate(clean); } catch (e) { /* isolated */ }
    }
    FeedLog.load(clean).then(function (log) {
      if (seq !== state.dateSeq || state.date !== clean) return;
      adoptLog(log);
      if (ScoringLog) {
        ScoringLog.load(clean).then(function () { render(); }).catch(function () { render(); });
      }
      render();
      FeedLog.openStream(clean);
      scan();
    });
  }

  function setFilter(filter) { state.filter = filter; render(); }

  /* Sound: one switch per page, persisted, plus an always-available Test button
   * that plays the same ~3 s raindrop an alert plays — so "is my alert working?"
   * is answered in one click whether the switch is on or off. */
  function reflectSoundButton() {
    var btn = $('sound-toggle-btn');
    if (btn) {
      btn.textContent = state.soundOn ? '🔊 Alert sound on' : '🔇 Alert sound off';
      btn.classList.toggle('btn-on', state.soundOn);
      btn.setAttribute('aria-pressed', state.soundOn ? 'true' : 'false');
    }
    var snd = global.AlertSound;
    var status = $('sound-status');
    if (status && snd && typeof snd.status === 'function') {
      var st = snd.status();
      var bits = [];
      bits.push(st.supported ? 'Web Audio ready' : 'this browser has no Web Audio');
      if (st.supported) bits.push(st.unlocked ? 'unlocked' : 'click once to unlock');
      bits.push('volume ' + Math.round(st.volume * 100) + '%');
      if (st.played) bits.push(st.played + ' played');
      status.textContent = bits.join(' · ');
    }
  }

  function toggleSound() {
    state.soundOn = !state.soundOn;
    savePref('sound', state.soundOn);
    if (global.AlertSound && typeof global.AlertSound.setEnabled === 'function') {
      global.AlertSound.setEnabled(state.soundOn);
      if (state.soundOn) global.AlertSound.unlock();
    }
    reflectSoundButton();
    /* Turning it on plays the alert once: that is the proof it works. */
    if (state.soundOn) chime('toggle');
  }

  function testSound() {
    var result = global.AlertSound && typeof global.AlertSound.test === 'function'
      ? global.AlertSound.test()
      : { ok: false, reason: 'alert-sound.js is not loaded on this page.' };
    reflectSoundButton();
    if (!result.ok) statusLine('Test sound: ' + (result.reason || 'could not play') +
      ' — check the browser tab is not muted and click the page once.', true);
    else statusLine('Test sound: playing the ~3 s raindrop alert (same figure a real alert plays).', false);
    return result;
  }

  function setVolume(value) {
    if (global.AlertSound && typeof global.AlertSound.setVolume === 'function') {
      global.AlertSound.setVolume(value);
    }
    reflectSoundButton();
  }

  function toggleNotify() {
    state.notifyOn = !state.notifyOn;
    savePref('notify', state.notifyOn);
    var btn = $('notify-toggle-btn');
    if (btn) {
      btn.textContent = state.notifyOn ? '🔴 Run Alerts On' : '⚪ Run Alerts Off';
      btn.classList.toggle('btn-on', state.notifyOn);
    }
    if (state.notifyOn && typeof global.Notification === 'function' &&
      global.Notification.permission === 'default') {
      global.Notification.requestPermission();
    }
  }

  function init() {
    state.date = urlDate() || parseDate();
    syncNav();
    state.soundOn = loadPref('sound', false);
    state.notifyOn = loadPref('notify', false);
    if (global.AlertSound) {
      /* The sound module owns the preference; keep them in agreement. */
      try { global.AlertSound.setEnabled(state.soundOn); } catch (e) { /* ignore */ }
    }

    FeedLog.onChange(function (pushed) {
      if (pushed && pushed.date === state.date) {
        adoptLog(FeedLog.mergePayloads(state.log, pushed, state.date));
        render();
      }
    });

    var soundBtn = $('sound-toggle-btn');
    if (soundBtn) soundBtn.addEventListener('click', toggleSound);
    var testBtn = $('sound-test-btn');
    if (testBtn) testBtn.addEventListener('click', testSound);
    var vol = $('sound-volume');
    if (vol) {
      try { vol.value = String(Math.round((global.AlertSound ? global.AlertSound.getVolume() : 0.5) * 100)); } catch (e) { /* ignore */ }
      vol.addEventListener('input', function () { setVolume(Number(vol.value) / 100); });
    }
    reflectSoundButton();
    var notifyBtn = $('notify-toggle-btn');
    if (notifyBtn) {
      notifyBtn.textContent = state.notifyOn ? '🔴 Run Alerts On' : '⚪ Run Alerts Off';
      notifyBtn.classList.toggle('btn-on', state.notifyOn);
      notifyBtn.addEventListener('click', toggleNotify);
    }
    var refreshBtn = $('refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', function () { scan(); });

    var tabs = $('feed-tabs');
    if (tabs) {
      tabs.addEventListener('click', function (evt) {
        var btn = evt.target.closest('[data-filter]');
        if (btn) setFilter(btn.getAttribute('data-filter'));
      });
    }

    document.addEventListener('visibilitychange', function () {
      /* Coming back to the tab: a normal scan.  The Refresh button is the only
       * thing that forces the full payload. */
      if (!document.hidden) { runScan(false); }
    });
    /* Releasing the leader lease on unload lets another tab take over at once
     * instead of waiting for the lease to go stale. */
    global.addEventListener('pagehide', function () {
      if (MLB.releaseLeader) MLB.releaseLeader();
    });

    Reviews.loadRegistry();

    /* The Official Scoring log is loaded and its own capture loop started
     * BEFORE the first alert scan, so a refresh restores the record first and
     * the two systems never wait on each other. */
    if (ScoringLog) {
      try {
        ScoringLog.load(state.date).catch(function () { /* isolated */ });
        ScoringLog.start(state.date, function () { return state.games; });
      } catch (e) {
        global.console && global.console.warn && global.console.warn('[feed] scoring log unavailable', e);
      }
      ScoringLog.onChange(function (evt) {
        if (!evt || evt.date !== state.date) return;
        /* Re-render the separate section and the tab badge only; no chime, no
         * entry-list change — the isolation the owner asked for. */
        renderIfChanged();
      });
    }

    var initSeq = state.dateSeq;
    var initDate = state.date;
    FeedLog.load(initDate).then(function (log) {
      if (initSeq !== state.dateSeq || state.date !== initDate) return;
      adoptLog(log);
      render();
      FeedLog.openStream(initDate);
      scan();
    });

    state.timers.sweep = setInterval(sweep, STATUS_SWEEP_MS);
    state.timers.countdown = setInterval(updateChrome, 200);
  }

  global.ReplayFeed = {
    init: init,
    prevDay: function () { setDate(MLB.shiftISODate(state.date, -1)); },
    nextDay: function () { setDate(MLB.shiftISODate(state.date, 1)); },
    today: function () { setDate(MLB.todayISO()); },
    pickDate: function () {
      /* The picker is the user's own choice; a ?date= deep link seeds the first
       * view but must not override a later pick. */
      var input = $('date-picker');
      var value = input && input.value;
      setDate(MLB.isValidISODate(value) ? value : state.date);
    },
    setDate: setDate,
    setFilter: setFilter,
    toggleSound: toggleSound,
    testSound: testSound,
    setVolume: setVolume,
    toggleNotify: toggleNotify,
    scan: scan,
    sweep: sweep,
    exportOfficial: exportOfficial,
    reloadOfficial: reloadOfficial,
    state: state,
    SCAN_MS: SCAN_MS,
    STATUS_SWEEP_MS: STATUS_SWEEP_MS,
    FETCH_CONCURRENCY: FETCH_CONCURRENCY,
    latencyLine: latencyLine,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}(window));
