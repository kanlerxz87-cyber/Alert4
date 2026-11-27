/* ============================================================================
 * reviews-feed.js — the all-games Replay Feed (reviews.html)
 *
 * Scans every game on the slate for review events and renders them as a live,
 * chat-style feed:
 *   - manager challenges (M*), umpire/crew-chief reviews (N*), instant replay
 *     (IH), boundary calls (umpire-side home run / fair-foul / stadium-boundary
 *     reviews; charged manager challenges of those plays stay challenges)
 *   - ABS pitch challenges (MJ/NJ) with count before/after
 *   - official-scorer pending rulings (os_ruling_pending_*)
 *   - official scoring changes, detected by diffing each completed play's
 *     classification between polls
 *   - official live game state for every game (score, count, outs, batter,
 *     pitcher, pitch count, bases, inning — timestamped to the second),
 *     with exact official wording before/after every alerted event
 *
 * Latency: the 125 ms lean status sweep is the fastest signal that a review
 * was called; play-by-play uses the lean /playByPlay projection, staggered
 * per game, through the api.js governor (concurrency 6, dedupe, 429-aware).
 * Counters are fetched on a slower cadence than play-by-play.
 *
 * Every tracked entry is persisted through feed-log.js (localStorage + the
 * optional server store) and restored on the next visit. Official scoring
 * pending + scoring changes are ALSO persisted through scoring-log.js — a
 * separate system (own keys + own /api/scoring-log endpoints) that never
 * plays sound and never depends on the alert system. The alert sound itself
 * lives in alert-sound.js (isolated 3-second raindrop chime, toggle + test).
 * ==========================================================================*/
(function (global) {
  'use strict';

  var MLB = global.MLB;
  var UI = global.UI;
  var Reviews = global.Reviews;
  var FeedLog = global.FeedLog;
  var AlertSound = global.AlertSound || null;
  var GameState = global.GameState || null;
  var ScoringLog = global.ScoringLog || null;

  var SCAN_MS = 250;
  var LIVE_SCAN_MS = 250;
  var REVIEW_SCAN_MS = 250;
  var STATUS_SWEEP_MS = 125;
  var FETCH_CONCURRENCY = 6;
  var FINAL_GRACE_MS = 30 * 60 * 1000;
  var COUNTERS_MS = 5000;
  var SCHEDULE_TTL_MS = 5000;
  var SOUND_COOLDOWN_MS = 2500;

  var PLAYBYPLAY_FIELDS = 'allPlays,about,atBatIndex,hasReview,isComplete,inning,halfInning,isTopInning,isScoringPlay,' +
    'result,eventType,description,isOut,rbi,awayScore,homeScore,count,balls,strikes,outs,matchup,batter,id,fullName,pitcher,' +
    'playEvents,details,call,reviewDetails,isOverturned,inProgress,reviewType,challengeTeamId,runners,' +
    'isScoringEvent,playIndex,movement,index,isPitch,pitchNumber,type,startTime,endTime,hasOutcome';

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
    counterDue: Object.create(null),
    /* Freshest status per game, written by the 125 ms lean sweep. */
    liveStatusByPk: Object.create(null),
    absFetchedRevCount: Object.create(null),
    lastGameDate: undefined,
    lookingForRecent: false,
    /* Live game-state capture (game-state.js): latest state per game +
     * bounded history of every observed state change, timestamped to the
     * second. Populates the Live Game State section + before/after rows. */
    gameStates: Object.create(null),
    stateHistory: [],
    lastStateKey: Object.create(null),
    /* Separate persistent scoring log (scoring-log.js). */
    scoringLog: null,
    sweepInFlight: false,
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
    /* The scoring log persists independently (own keys/endpoints). */
    if (ScoringLog && state.scoringLog) {
      state.scoringLog.savedAt = Date.now();
      ScoringLog.save(state.date, state.scoringLog);
    }
  }

  /* Append one pending/scoring-change entry to the SEPARATE persistent
   * scoring log. Never plays sound, never touches the alert feed — if this
   * fails the alert still fired, and if the alert is muted this still logs. */
  function appendScoringLog(entry) {
    if (!ScoringLog || !entry || !entry.id) return;
    if (!state.scoringLog) state.scoringLog = ScoringLog.emptyPayload(state.date);
    var exists = state.scoringLog.entries.some(function (e) { return e && e.id === entry.id; });
    if (exists) return;
    entry.firstSeen = Date.now();
    entry.lastSeen = Date.now();
    state.scoringLog.entries.push(entry);
    if (state.scoringLog.entries.length > ScoringLog.MAX_ENTRIES) {
      state.scoringLog.entries = state.scoringLog.entries.slice(-ScoringLog.MAX_ENTRIES);
    }
    state.scoringLog.order = state.scoringLog.entries.map(ScoringLog.entryKey);
    ScoringLog.save(state.date, state.scoringLog);
    renderScoringLog();
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

  /* The freshest status we know for a game. The 125 ms lean sweep is the
   * authority (it sees Live -> Final and review flips within 125 ms); the
   * scheduled slate is only a slower fallback. */
  function statusOf(game) {
    var live = state.liveStatusByPk[game.gamePk];
    if (live) return live.abstractGameState || '';
    return (game.status && game.status.abstractGameState) || '';
  }

  function detailedStatusOf(game) {
    var live = state.liveStatusByPk[game.gamePk];
    if (live) return live.detailedState || live.abstractGameState || '';
    return (game.status && game.status.detailedState) || (game.status && game.status.abstractGameState) || '';
  }

  /* Per-game poll phase. Each game is polled once per `interval` ms, but its
   * polls sit on a fixed phase derived from the gamePk, so a 15-game slate
   * spreads its requests evenly across the interval instead of bursting on
   * every scan. The average rate per game is unchanged; only the phase
   * differs, so no game's alert is delayed by the stagger. */
  function dueAt(pk, now, interval) {
    var phase = Number(pk) % interval;
    var due = phase + Math.ceil((now - phase) / interval) * interval;
    if (due <= now) due += interval;
    return due;
  }

  function shouldFetch(game, now) {
    var status = statusOf(game);
    var pk = game.gamePk;
    if (status === 'Live') {
      /* Stagger live games so a 15-game slate does not burst: review games
       * poll at REVIEW_SCAN_MS, others at LIVE_SCAN_MS. The 125 ms status
       * sweep still catches a new review out of band. */
      var inReview = !!(state.statusByPk[pk] && state.statusByPk[pk] !== '');
      var interval = inReview ? REVIEW_SCAN_MS : LIVE_SCAN_MS;
      var due = state.nextDue[pk] || 0;
      if (!due) {
        /* First time we see this game: give it a phase slot so a 15-game
         * slate does not fire 15 requests in the same tick. */
        state.nextDue[pk] = now + (Number(pk) % interval);
        return false;
      }
      if (now < due) return false;
      state.nextDue[pk] = dueAt(pk, now, interval);
      return true;
    }
    if (status === 'Final') {
      if (!state.finalSeen[pk]) state.finalSeen[pk] = now;
      var elapsed = now - state.finalSeen[pk];
      if (elapsed > FINAL_GRACE_MS) return false;
      var dueFinal = state.nextDue[pk] || 0;
      if (now < dueFinal) return false;
      state.nextDue[pk] = now + finalGraceDelay(state.finalSeen[pk], elapsed);
      return true;
    }
    return false;
  }

  function fetchGame(game) {
    var now = Date.now();
    var status = statusOf(game);
    var pbpPromise = MLB.playByPlay(game.gamePk, { fields: PLAYBYPLAY_FIELDS, retries: 0 });
    /* Counters (manager/ABS remaining) change rarely: fetch them at most
     * every COUNTERS_MS per game, plus immediately when a review flips the
     * status sweep. This keeps the per-poll payload small and the request
     * rate inside the TOS budget without losing counter freshness. */
    var countersDue = (state.counterDue[game.gamePk] || 0) <= now;
    var countersPromise = countersDue
      ? MLB.gameFeed(game.gamePk, { fields: COUNTERS_FIELDS, retries: 0 }).catch(function () { return null; })
      : Promise.resolve(null);
    if (countersDue) state.counterDue[game.gamePk] = now + COUNTERS_MS;
    return Promise.all([pbpPromise, countersPromise])
      .then(function (parts) {
        return { game: game, payload: parts[0], countersPayload: parts[1] };
      })
      .catch(function (err) {
        return { game: game, payload: null, countersPayload: null, error: err };
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

  function ingestGame(result, expectedSeq, expectedDate) {
    if (expectedSeq !== undefined && expectedSeq !== state.dateSeq) return;
    if (expectedDate !== undefined && expectedDate !== state.date) return;
    if (!result || !result.payload) {
      if (result && result.error && !(result.error && result.error.quiet)) {
        state.scanError = result.error;
      }
      return;
    }
    var game = result.game;
    var plays = Reviews.playsOf(result.payload);
    var teams = teamsOf(game);
    var matchupLabel = UI.abbr(teams.away) + ' @ ' + UI.abbr(teams.home);
    var meta = { gamePk: game.gamePk, teams: teams, feed: result.payload, matchupLabel: matchupLabel };
    var observedAt = new Date();

    /* ---- official live game state (every game, every poll) ----
     * Capture the latest state for this game (score, count, outs, batter,
     * pitcher, pitch count, bases, inning — timestamped to the second) and
     * append to the bounded history when the official state actually
     * changed. This populates the Live Game State section and gives every
     * alerted event its exact before/after wording. */
    if (GameState && plays.length) {
      var latestPlay = plays[plays.length - 1];
      var latestState = GameState.capturePlay(latestPlay, result.payload, meta, observedAt);
      state.gameStates[game.gamePk] = latestState;
      var key = GameState.stateKey(latestState);
      if (state.lastStateKey[game.gamePk] !== key) {
        state.lastStateKey[game.gamePk] = key;
        state.stateHistory.push(latestState);
        if (state.stateHistory.length > 500) state.stateHistory = state.stateHistory.slice(-500);
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

      /* Exact official before/after state for this review (game-state.js). */
      var ba = (GameState && typeof GameState.beforeAfterForPlay === 'function')
        ? GameState.beforeAfterForPlay(plays, review.atBatIndex, result.payload, meta, observedAt)
        : { before: null, after: null };

      var entry = {
        id: review.id,
        kind: 'review',
        gamePk: game.gamePk,
        matchupLabel: matchupLabel,
        teams: teams,
        review: review,
        scoreTracker: scoreTracker,
        beforeState: ba.before,
        afterState: ba.after,
        observedAt: observedAt.toISOString(),
        observedAtSec: GameState ? GameState.stamp(observedAt).sec : observedAt.toLocaleTimeString(),
        firstSeenLabel: MLB.formatGameTime(game.gameDate),
      };

      var isNew = upsertEntry(entry);
      /* Always operate on the stored entry: upsertEntry merges into the
       * existing object, so flags like `warned` live there. */
      entry = state.entries.find(function (e) { return e.id === entry.id; }) || entry;

      /* Every alert-feed event chimes through the isolated alert-sound
       * module: challenges, reviews, boundary calls, pending rulings,
       * scoring changes and runs-at-risk. Routine ABS pitch challenges are
       * tracked in the ABS tab/counters but stay silent (they happen many
       * times per game — an all-day chime for each would be unlistenable);
       * an ABS challenge that could remove a run still chimes via the
       * runs-at-risk path below. */
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

    /* ---- official-scorer pending rulings ----
     * Logged to BOTH the alert feed (with sound) and the separate persistent
     * scoring log (no sound, survives refresh). The two systems are
     * independent: either can fail without affecting the other. */
    var pending = Reviews.pendingRulings(plays, meta);
    pending.forEach(function (row) {
      var baPending = (GameState && typeof GameState.beforeAfterForPlay === 'function')
        ? GameState.beforeAfterForPlay(plays, row.atBatIndex, result.payload, meta, observedAt)
        : { before: null, after: null };
      var isNewPending = upsertEntry({
        id: row.id,
        kind: 'pending',
        gamePk: game.gamePk,
        matchupLabel: matchupLabel,
        teams: teams,
        pending: row,
        beforeState: baPending.before,
        afterState: baPending.after,
        observedAt: observedAt.toISOString(),
        observedAtSec: GameState ? GameState.stamp(observedAt).sec : observedAt.toLocaleTimeString(),
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
      if (isNewPending) {
        chime('pending');
        appendScoringLog({
          id: row.id,
          kind: 'pending',
          gamePk: game.gamePk,
          matchupLabel: matchupLabel,
          observedAt: observedAt.toISOString(),
          observedAtSec: GameState ? GameState.stamp(observedAt).sec : observedAt.toLocaleTimeString(),
          observedMs: observedAt.getTime(),
          inningLabel: row.inningLabel,
          batter: row.batter,
          pitcher: row.pitcher,
          before: baPending.before || { description: '', eventType: '' },
          after: baPending.after || { description: row.description, eventType: row.eventType },
          descriptionBefore: baPending.before ? baPending.before.description : '',
          descriptionAfter: row.description,
          source: row.source || 'GET /api/v1/eventTypes — os_ruling_pending_*',
        });
      }
    });

    /* ---- official scoring changes */
    var snapshot = Reviews.snapshotPlays(plays);
    var previous = state.snapshots[game.gamePk];
    var diff = Reviews.diffSnapshots(previous, snapshot);
    state.snapshots[game.gamePk] = snapshot;

    diff.changes.forEach(function (change) {
      var baChange = (GameState && typeof GameState.beforeAfterForPlay === 'function')
        ? GameState.beforeAfterForPlay(plays, change.atBatIndex, result.payload, meta, observedAt)
        : { before: null, after: null };
      var isNewChange = upsertEntry({
        id: game.gamePk + ':' + change.atBatIndex + ':scoring-change',
        kind: 'scoring_change',
        gamePk: game.gamePk,
        matchupLabel: matchupLabel,
        teams: teams,
        change: change,
        beforeState: baChange.before,
        afterState: baChange.after,
        observedAt: observedAt.toISOString(),
        observedAtSec: GameState ? GameState.stamp(observedAt).sec : observedAt.toLocaleTimeString(),
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
      if (isNewChange) {
        chime('scoring');
        appendScoringLog({
          id: game.gamePk + ':' + change.atBatIndex + ':scoring-change',
          kind: 'scoring_change',
          gamePk: game.gamePk,
          matchupLabel: matchupLabel,
          observedAt: observedAt.toISOString(),
          observedAtSec: GameState ? GameState.stamp(observedAt).sec : observedAt.toLocaleTimeString(),
          observedMs: observedAt.getTime(),
          inningLabel: change.inningLabel,
          batter: change.batter,
          pitcher: '',
          before: {
            description: change.from.description || '',
            eventType: change.from.eventType || '',
            score: change.from.awayScore !== null && change.from.homeScore !== null
              ? { away: change.from.awayScore, home: change.from.homeScore } : null,
          },
          after: {
            description: change.to.description || '',
            eventType: change.to.eventType || '',
            score: change.scoreAfter || null,
          },
          descriptionBefore: change.from.description || '',
          descriptionAfter: change.to.description || '',
          source: change.attribution || 'Official scorer / Elias / club review',
        });
      }
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
    var gdCounters = (result.countersPayload && result.countersPayload.gameData) || null;
    var rawMgr = (gdCounters && gdCounters.review) || result.payload.review || (game.review || null);
    var rawAbs = (gdCounters && gdCounters.absChallenges) || result.payload.absChallenges || null;
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
  }

  function scan() {
    if (state.scanning) return;
    if (document.hidden) { scheduleScan(1000); return; }
    var scanSeq = state.dateSeq;
    var scanDate = state.date;
    state.scanning = true;
    state.nextScanAt = Date.now() + SCAN_MS;

    /* The full slate is cached for SCHEDULE_TTL_MS: team/venue/order data
     * does not change, and the 125 ms lean sweep is the fast authority on
     * status. This removes ~4 requests/s from the budget without making
     * any alert later. */
    MLB.schedule(scanDate, { ttl: SCHEDULE_TTL_MS, retries: 0 })
      .then(function (payload) {
        if (scanSeq !== state.dateSeq || scanDate !== state.date) return null;
        state.games = flattenGames(payload);
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
          return fetchGame(game).then(function (result) {
            ingestGame(result, scanSeq, scanDate);
          });
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
        scheduleScan(SCAN_MS);
      });
  }

  function scheduleScan(delay) {
    clearTimeout(state.timers.scan);
    state.nextScanAt = Date.now() + delay;
    state.timers.scan = setTimeout(scan, delay);
  }

  /* 125 ms official status sweep: catches a review the moment MLB flips it.
   * In-flight guarded so a slow network cannot stack sweeps; the api.js
   * governor gives this call high priority ahead of bulk playByPlay polls. */
  function sweep() {
    if (document.hidden || state.sweepInFlight) return;
    var sweepSeq = state.dateSeq;
    var sweepDate = state.date;
    if (!state.games.some(function (g) { return statusOf(g) === 'Live'; })) return;
    state.sweepInFlight = true;
    MLB.slateStatus(sweepDate).then(function (payload) {
      state.sweepInFlight = false;
      if (sweepSeq !== state.dateSeq || sweepDate !== state.date) return;
      var games = flattenGames(payload);
      games.forEach(function (g) {
        /* The lean sweep is the fast authority on status: record it so the
         * Live -> Final transition and the "In Progress"/"Final" labels are
         * current within 125 ms even though the full slate is cached. */
        var abs = (g.status && g.status.abstractGameState) || '';
        if (abs) {
          state.liveStatusByPk[g.gamePk] = {
            abstractGameState: abs,
            detailedState: (g.status && g.status.detailedState) || abs,
          };
        }
        var review = Reviews.statusReview(g.status);
        var prev = state.statusByPk[g.gamePk];
        var nextKey = review ? review.code + '|' + review.reason : '';
        if (prev !== nextKey) {
          state.statusByPk[g.gamePk] = nextKey;
          if (review) {
            /* Out-of-band fetch: don't wait for the current scan to finish.
             * Force a fresh counters fetch so the remaining-challenges
             * counter on the new row is current. */
            state.counterDue[g.gamePk] = 0;
            fetchGame(g).then(function (result) {
              if (sweepSeq !== state.dateSeq || sweepDate !== state.date) return;
              ingestGame(result, sweepSeq, sweepDate);
              persist(sweepSeq, sweepDate);
              renderIfChanged();
              updateChrome();
            });
          }
        }
      });
    }).catch(function () {
      state.sweepInFlight = false;
      /* the scan owns error reporting */
    });
  }

  /* ------------------------------------------------------------- sound/notify
   * The alert sound lives in the isolated alert-sound.js module (3-second
   * raindrop chime). This bridge only forwards events; it never synthesizes
   * audio itself, so sound changes cannot break the feed and feed changes
   * cannot break the sound. */

  function chime(reason) {
    if (!state.soundOn) return;
    var now = Date.now();
    if (now - state.lastChimeAt < SOUND_COOLDOWN_MS && reason !== 'preview') return;
    state.lastChimeAt = now;
    if (AlertSound) {
      try {
        /* Keep the isolated module in step without a preview chime: the
         * feed's toggle is the source of truth, AlertSound just renders. */
        if (AlertSound.state) AlertSound.state.enabled = true;
        AlertSound.play(reason || 'review');
      } catch (e) { /* never a failure path */ }
      return;
    }
    /* Fallback if alert-sound.js failed to load: silent no-op. */
  }

  function testSound() {
    if (AlertSound) {
      try { AlertSound.test(); } catch (e) { /* ignore */ }
    }
    statusLine('🔔 Test sound played — 3-second raindrop chime (toggle Sound On to hear alerts for every feed event).');
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
    nav.innerHTML = FILTERS.map(function (f) {
      var count = state.entries.filter(function (e) { return entryMatches(e, f.id); }).length;
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

  function beforeAfterHtml(entry) {
    var before = entry.beforeState;
    var after = entry.afterState;
    if (!before && !after) return '';
    function line(label, s) {
      if (!s) return '<div class="feed-sub">' + UI.esc(label) + ': — (not observed)</div>';
      var bits = [];
      if (s.inningLabel) bits.push(s.inningLabel);
      if (s.score) bits.push(s.score.away + '–' + s.score.home);
      if (s.count && s.count.balls !== null && s.count.strikes !== null) {
        bits.push(s.count.balls + '-' + s.count.strikes + (s.count.outs !== null ? ' · ' + s.count.outs + ' out' + (s.count.outs === 1 ? '' : 's') : ''));
      }
      if (s.batter && s.batter.name) bits.push(s.batter.name + ' vs ' + (s.pitcher && s.pitcher.name ? s.pitcher.name : '—'));
      if (s.pitchCount) bits.push(s.pitchCount + ' pitch' + (s.pitchCount === 1 ? '' : 'es'));
      if (s.observedAtSec) bits.push('@ ' + s.observedAtSec);
      return '<div class="feed-sub"><b>' + UI.esc(label) + ':</b> ' + UI.esc(bits.join(' · ')) +
        (s.description ? '<br><span class="official-wording">“' + UI.esc(s.description) + '”</span>' : '') + '</div>';
    }
    return '<div class="before-after">' + line('Before', before) + line('After', after) + '</div>';
  }

  function renderLiveState() {
    var el = $('live-state-list');
    var statusEl = $('live-state-status');
    if (!el) return;
    var pks = Object.keys(state.gameStates);
    if (!state.games.length && !pks.length) {
      el.innerHTML = '<div class="feed-empty">No games on this date yet. Live state (score, count, outs, batter, pitcher, pitch count) appears here the second each game starts.</div>';
      if (statusEl) statusEl.textContent = 'Waiting for games…';
      return;
    }
    /* Show every game on the slate, even before its first playByPlay lands. */
    var cards = state.games.map(function (g) {
      var s = state.gameStates[g.gamePk];
      var label = UI.abbr(teamsOf(g).away) + ' @ ' + UI.abbr(teamsOf(g).home);
      var status = statusOf(g);
      var detailed = detailedStatusOf(g) || status;
      if (!s) {
        return '<div class="live-state-card">' +
          '<div class="live-state-head"><a href="game.html?gamePk=' + encodeURIComponent(g.gamePk) + '&date=' + encodeURIComponent(state.date) + '"><b>' + UI.esc(label) + '</b></a>' +
          UI.chip(detailed, status === 'Live' ? 'chip-danger' : '') + '</div>' +
          '<div class="feed-sub">State capture pending — first playByPlay poll in flight…</div></div>';
      }
      var countText = (s.count && s.count.balls !== null && s.count.strikes !== null)
        ? s.count.balls + '-' + s.count.strikes + (s.count.outs !== null ? ' · ' + s.count.outs + ' out' + (s.count.outs === 1 ? '' : 's') : '')
        : '—';
      return '<div class="live-state-card' + (status === 'Live' ? ' is-live' : '') + '">' +
        '<div class="live-state-head"><a href="game.html?gamePk=' + encodeURIComponent(g.gamePk) + '&date=' + encodeURIComponent(state.date) + '"><b>' + UI.esc(label) + '</b></a>' +
        '<span class="live-state-score">' + (s.score ? UI.esc(s.score.away) + '–' + UI.esc(s.score.home) : '—') + '</span>' +
        UI.chip(detailed, status === 'Live' ? 'chip-danger' : '') + '</div>' +
        '<dl class="state-kv">' +
          '<dt>Inning</dt><dd>' + UI.esc(s.inningLabel || '—') + '</dd>' +
          '<dt>Count</dt><dd>' + UI.esc(countText) + '</dd>' +
          '<dt>Batter</dt><dd>' + UI.esc((s.batter && s.batter.name) || '—') + '</dd>' +
          '<dt>Pitcher</dt><dd>' + UI.esc((s.pitcher && s.pitcher.name) || '—') + '</dd>' +
          '<dt>Pitches (PA)</dt><dd>' + (s.pitchCount !== null && s.pitchCount !== undefined ? s.pitchCount : '—') + '</dd>' +
          '<dt>Captured</dt><dd>' + UI.esc(s.observedAtSec || '') + '</dd>' +
        '</dl>' +
        (s.description ? '<div class="feed-sub official-wording">“' + UI.esc(s.description) + '”</div>' : '') +
      '</div>';
    }).join('');
    el.innerHTML = cards;
    if (statusEl) {
      var live = state.games.filter(function (g) { return statusOf(g) === 'Live'; }).length;
      statusEl.textContent = state.games.length + ' game(s) · ' + live + ' live · state captured ' +
        new Date(state.lastScanAt || Date.now()).toLocaleTimeString();
    }
  }

  function renderScoringLog() {
    var el = $('scoring-log-list');
    var countEl = $('scoring-log-count');
    var statusEl = $('scoring-log-status');
    if (!el) return;
    var entries = (state.scoringLog && state.scoringLog.entries) || [];
    if (countEl) countEl.textContent = entries.length + ' entr' + (entries.length === 1 ? 'y' : 'ies') + ' logged';
    if (statusEl) {
      var saved = ScoringLog && ScoringLog.state && ScoringLog.state.available ? ' · shared log connected' : ' · local log only (survives refresh)';
      statusEl.textContent = 'Separate persistent log · survives refresh' + saved;
    }
    if (!entries.length) {
      el.innerHTML = '<div class="feed-empty">No official-scorer pending rulings or scoring changes observed yet for this date. They are captured here in real time and kept after a refresh.</div>';
      return;
    }
    var sorted = entries.slice().sort(function (a, b) { return (Number(b.observedMs) || 0) - (Number(a.observedMs) || 0); });
    el.innerHTML = sorted.map(function (e) {
      var before = e.before || {};
      var after = e.after || {};
      var scoreBefore = before.score ? before.score.away + '–' + before.score.home : '—';
      var scoreAfter = after.score ? after.score.away + '–' + after.score.home : '—';
      return '<div class="scoring-row">' +
        '<div class="scoring-head"><b>' + UI.esc(e.matchupLabel || '') + '</b>' +
        UI.chip(e.kind === 'pending' ? '📝 Pending ruling' : '✏️ Scoring change', e.kind === 'pending' ? 'chip-warn' : 'chip-scoring') +
        '<span>' + UI.esc(e.inningLabel || '') + '</span>' +
        '<span class="timestamp">' + UI.esc(e.observedAtSec || '') + '</span>' +
        '<a href="game.html?gamePk=' + encodeURIComponent(e.gamePk) + '&date=' + encodeURIComponent(state.date) + '">Game ↗</a></div>' +
        '<div class="feed-sub">' + UI.esc(e.batter || '') + (e.pitcher ? ' vs ' + UI.esc(e.pitcher) : '') + '</div>' +
        '<dl class="score-track">' +
          '<dt>Before (official)</dt><dd>' + UI.esc(before.description || e.descriptionBefore || '—') + ' · ' + UI.esc(scoreBefore) + '</dd>' +
          '<dt>After (official)</dt><dd>' + UI.esc(after.description || e.descriptionAfter || '—') + ' · ' + UI.esc(scoreAfter) + '</dd>' +
        '</dl>' +
        '<div class="feed-irregular">Source: ' + UI.esc(e.source || '') + '</div>' +
      '</div>';
    }).join('');
  }

  function renderLatency() {
    var badge = $('latency-badge');
    var details = $('latency-details');
    if (!MLB.perf) return;
    var p = MLB.perf();
    if (badge) {
      badge.textContent = p.lastLatencyMs ? (p.lastLatencyMs + ' ms · p50 ' + p.p50LatencyMs + ' ms') : '— ms';
      badge.classList.toggle('is-quiet', p.quietRemainingMs > 0);
    }
    if (details) {
      var rps = p.requestsPerSecond || 0;
      var ceiling = p.rateLimitRps || 0;
      var overCeiling = ceiling && rps > ceiling;
      details.innerHTML =
        '<span><b>Last</b> ' + p.lastLatencyMs + ' ms</span>' +
        '<span><b>p50</b> ' + p.p50LatencyMs + ' ms</span>' +
        '<span><b>p95</b> ' + p.p95LatencyMs + ' ms</span>' +
        '<span><b>Requests</b> ' + p.requests + ' (' + p.cacheHits + ' cached · ' + p.deduped + ' deduped)</span>' +
        '<span><b>Rate</b> ' + rps + ' req/s' + (ceiling ? ' · ceiling ' + ceiling + ' req/s' : '') + '</span>' +
        '<span><b>Governor</b> ' + p.active + '/' + p.maxConcurrent + ' concurrent · ' + p.minIntervalMs + ' ms spacing</span>' +
        (p.quietRemainingMs > 0 ? '<span class="is-quiet">⏸ 429 quiet: ' + Math.ceil(p.quietRemainingMs / 1000) + 's remaining</span>'
          : (overCeiling ? '<span class="is-quiet">⚠️ Above sustained ceiling — backing off</span>'
            : '<span>✅ Within TOS budget</span>'));
    }
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

    var stampText = entry.observedAtSec || new Date(entry.lastSeen || Date.now()).toLocaleTimeString();
    return '<div class="' + cls + '">' +
      '<div class="feed-avatar">' + avatar + '</div>' +
      '<div class="feed-body">' +
        '<div class="feed-top">' +
          '<a href="game.html?gamePk=' + encodeURIComponent(entry.gamePk) + '&date=' + encodeURIComponent(state.date) + '"><b>' + UI.esc(entry.matchupLabel || '') + '</b></a>' +
          '<span>' + UI.esc(r.inningLabel || '') + '</span>' +
          (r.challengerSide && r.challengerSide !== 'unknown' && r.challenger
            ? '<span>Challenged by ' + UI.esc(r.challenger) + (r.challengerRole ? ' (' + UI.esc(r.challengerRole) + ')' : '') + '</span>' : '') +
          '<span class="timestamp" title="Observed at (local, to the second)">' + UI.esc(stampText) + '</span>' +
          '<a href="https://statsapi.mlb.com/api/v1/game/' + encodeURIComponent(entry.gamePk) + '/playByPlay" target="_blank" rel="noopener" title="Official MLB StatsAPI play-by-play source">MLB API ↗</a>' +
        '</div>' +
        '<div class="feed-title">' + UI.esc((r.batter && r.batter.name) || '') +
          (r.pitcher && r.pitcher.name ? ' vs ' + UI.esc(r.pitcher.name) : '') + '</div>' +
        (r.description ? '<div class="feed-sub official-wording">“' + UI.esc(r.description) + '”</div>' : '') +
        absLine + changeHtml + pendingHtml +
        beforeAfterHtml(entry) +
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
    var statePart = Object.keys(state.gameStates).map(function (pk) {
      var s = state.gameStates[pk];
      return pk + ':' + (s && s.observedAtSec) + ':' + (s && s.score ? s.score.away + '-' + s.score.home : '') +
        ':' + (s && s.description ? s.description.slice(0, 40) : '');
    }).join('|');
    var scoringPart = state.scoringLog ? state.scoringLog.entries.length : 0;
    return state.filter + '|' + state.games.length + '|' + (state.lastGameDate || '') + '|' + scoringPart + '|' + statePart + '|' + state.entries.map(function (e) {
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

  function render() {
    renderBanner();
    renderTabs();
    renderStats();
    renderActiveStrip();
    renderLiveState();
    renderScoringLog();
    renderLatency();
    var list = $('feed-list');
    if (!list) return;
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

  function updateChrome() {
    var label = $('countdown');
    if (label) {
      var left = Math.max(0, state.nextScanAt - Date.now());
      label.textContent = document.hidden ? 'paused' : (left / 1000).toFixed(1) + 's';
    }
    var dot = $('live-dot');
    if (dot) dot.style.opacity = state.scanError ? '0.3' : '1';
    renderLatency();
    if (state.scanError) {
      statusLine('Scan problem: ' + (state.scanError.message || 'network error') + ' — retrying.', true);
    } else {
      var live = state.games.filter(function (g) { return statusOf(g) === 'Live'; }).length;
      var perfText = '';
      if (MLB.perf) {
        var p = MLB.perf();
        perfText = ' · latency ' + p.lastLatencyMs + ' ms (p50 ' + p.p50LatencyMs + ' ms)';
      }
      statusLine(state.games.length + ' game(s) on ' + MLB.formatDateLabel(state.date) +
        ' · ' + live + ' live · ' + state.entries.length + ' tracked entr' + (state.entries.length === 1 ? 'y' : 'ies') +
        ' · scanned ' + new Date(state.lastScanAt || Date.now()).toLocaleTimeString() + perfText +
        (FeedLog.state.available ? ' · shared log connected' : ' · local log only'));
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
    state.statusByPk = Object.create(null);
    state.liveStatusByPk = Object.create(null);
    state.counterCache = Object.create(null);
    state.counterDue = Object.create(null);
    state.absFetchedRevCount = Object.create(null);
    state.gameStates = Object.create(null);
    state.stateHistory = [];
    state.lastStateKey = Object.create(null);
    state.scoringLog = null;
    state.lastGameDate = undefined;
    state.lookingForRecent = false;
    state.log = null;
    state.lastRenderSignature = '';
    syncNav();
    render();
    FeedLog.closeStream();
    if (ScoringLog) ScoringLog.closeStream();
    var feedPromise = FeedLog.load(clean);
    var scoringPromise = ScoringLog ? ScoringLog.load(clean) : Promise.resolve(null);
    Promise.all([feedPromise, scoringPromise]).then(function (parts) {
      if (seq !== state.dateSeq || state.date !== clean) return;
      adoptLog(parts[0]);
      if (ScoringLog) state.scoringLog = parts[1] || ScoringLog.emptyPayload(clean);
      render();
      FeedLog.openStream(clean);
      if (ScoringLog) ScoringLog.openStream(clean);
      scan();
    });
  }

  function setFilter(filter) { state.filter = filter; render(); }

  function toggleSound() {
    state.soundOn = !state.soundOn;
    savePref('sound', state.soundOn);
    if (AlertSound) {
      try { AlertSound.setEnabled(state.soundOn); } catch (e) { /* ignore */ }
    }
    var btn = $('sound-toggle-btn');
    if (btn) {
      btn.textContent = state.soundOn ? '🔊 Sound On' : '🔇 Sound Off';
      btn.classList.toggle('btn-on', state.soundOn);
    }
    /* setEnabled already plays the 3s preview when switched on. */
  }

  function setVolume(v) {
    if (AlertSound) {
      try { AlertSound.setVolume(v); } catch (e) { /* ignore */ }
    }
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
    if (AlertSound) {
      /* AlertSound owns its own pref; keep the feed's copy in step. */
      try { state.soundOn = AlertSound.isEnabled(); } catch (e) { /* keep loaded */ }
    }
    state.notifyOn = loadPref('notify', false);

    FeedLog.onChange(function (pushed) {
      if (pushed && pushed.date === state.date) {
        adoptLog(FeedLog.mergePayloads(state.log, pushed, state.date));
        render();
      }
    });

    if (ScoringLog) {
      ScoringLog.onChange(function (pushed) {
        if (pushed && pushed.date === state.date) {
          state.scoringLog = ScoringLog.mergePayloads(state.scoringLog, pushed, state.date);
          renderScoringLog();
        }
      });
    }

    var soundBtn = $('sound-toggle-btn');
    if (soundBtn) {
      soundBtn.textContent = state.soundOn ? '🔊 Sound On' : '🔇 Sound Off';
      soundBtn.classList.toggle('btn-on', state.soundOn);
      soundBtn.addEventListener('click', toggleSound);
    }
    var testBtn = $('sound-test-btn');
    if (testBtn) testBtn.addEventListener('click', testSound);
    var vol = $('sound-volume');
    if (vol) {
      try { vol.value = String(Math.round((AlertSound ? AlertSound.getVolume() : 0.5) * 100)); } catch (e) { /* ignore */ }
      vol.addEventListener('input', function () { setVolume(Number(vol.value) / 100); });
    }
    var notifyBtn = $('notify-toggle-btn');
    if (notifyBtn) {
      notifyBtn.textContent = state.notifyOn ? '🔴 Run Alerts On' : '⚪ Run Alerts Off';
      notifyBtn.classList.toggle('btn-on', state.notifyOn);
      notifyBtn.addEventListener('click', toggleNotify);
    }
    var refreshBtn = $('refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', function () { scan(); });

    var exportJson = $('scoring-export-json');
    if (exportJson) exportJson.addEventListener('click', function () {
      if (ScoringLog && state.scoringLog) ScoringLog.exportJSON(state.scoringLog);
    });
    var exportCsv = $('scoring-export-csv');
    if (exportCsv) exportCsv.addEventListener('click', function () {
      if (ScoringLog && state.scoringLog) ScoringLog.exportCSV(state.scoringLog);
    });
    var clearBtn = $('scoring-clear');
    if (clearBtn) clearBtn.addEventListener('click', function () {
      if (ScoringLog) {
        state.scoringLog = ScoringLog.clear(state.date);
        renderScoringLog();
        statusLine('Scoring log cleared for ' + MLB.formatDateLabel(state.date) + ' (local copy).');
      }
    });

    var tabs = $('feed-tabs');
    if (tabs) {
      tabs.addEventListener('click', function (evt) {
        var btn = evt.target.closest('[data-filter]');
        if (btn) setFilter(btn.getAttribute('data-filter'));
      });
    }

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { scan(); }
    });

    Reviews.loadRegistry();

    var initSeq = state.dateSeq;
    var initDate = state.date;
    var feedPromise = FeedLog.load(initDate);
    var scoringPromise = ScoringLog ? ScoringLog.load(initDate) : Promise.resolve(null);
    Promise.all([feedPromise, scoringPromise]).then(function (parts) {
      if (initSeq !== state.dateSeq || state.date !== initDate) return;
      adoptLog(parts[0]);
      if (ScoringLog) state.scoringLog = parts[1] || ScoringLog.emptyPayload(initDate);
      render();
      FeedLog.openStream(initDate);
      if (ScoringLog) ScoringLog.openStream(initDate);
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
    state: state,
    SCAN_MS: SCAN_MS,
    LIVE_SCAN_MS: LIVE_SCAN_MS,
    REVIEW_SCAN_MS: REVIEW_SCAN_MS,
    STATUS_SWEEP_MS: STATUS_SWEEP_MS,
    FETCH_CONCURRENCY: FETCH_CONCURRENCY,
    COUNTERS_MS: COUNTERS_MS,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}(window));
