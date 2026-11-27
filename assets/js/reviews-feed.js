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
 *
 * Latency (fastest feed within the StatsAPI terms):
 *   - 125 ms official-status sweep while any game is live.  MLB flips
 *     `status.statusCode` the instant a challenge is called — before any play
 *     text exists — so the sweep is the earliest possible signal; a flip
 *     triggers an immediate out-of-band play-by-play fetch instead of waiting
 *     for the next 250 ms scan.  With no live game the sweep relaxes to 1 s,
 *     and every poll pauses while the tab is hidden, so the request budget
 *     stays bounded (see README §"Notes & etiquette" and docs/api-compliance.md).
 *   - Each sweep records its own round-trip (state.sweepMs) and every StatsAPI
 *     request is timed by api.js (`MLB.latencyStats()`); both are shown in the
 *     status line so latency is measured, not claimed.
 *
 * Live state / alerting:
 *   - live-state.js turns every poll into a second-precision snapshot (score,
 *     inning, outs, count, pitch count, pitcher, batter, official last-play
 *     wording) and the board above the feed shows all games.
 *   - Every row carries `official.before` / `official.after`: the exact wording
 *     the API published before and after the ruling.
 *
 * Persistence is split in two so one can never disrupt the other:
 *   - feed-log.js  → the alert feed's own rows/baselines (localStorage + server)
 *   - scoring-log.js → a SEPARATE store for official-scoring pending rulings
 *     and reclassifications, written after the alert path has finished and
 *     rendered on scoring.html.  It plays no sound and never blocks the feed.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var MLB = global.MLB;
  var UI = global.UI;
  var Reviews = global.Reviews;
  var FeedLog = global.FeedLog;
  /* live-state.js loads before this file; kept in a module-level name so every
   * helper can use it without shadowing. */
  var LiveState = global.LiveState || null;

  var SCAN_MS = 250;
  /* Fastest official signal.  125 ms while a game is live (the README cadence);
   * 1 s when the slate has nothing in progress, so an idle page is not paying
   * for 8 sweeps a second. */
  var SWEEP_LIVE_MS = 125;
  var SWEEP_IDLE_MS = 1000;
  var STATUS_SWEEP_MS = SWEEP_LIVE_MS;
  var FETCH_CONCURRENCY = 6;
  var FINAL_GRACE_MS = 30 * 60 * 1000;
  /* ~3 s raindrop (SOUND_DURATION_MS) with a short cooldown so two events a
   * second apart do not stack into a wall of noise.  A 250 ms scan that sees
   * a whole slate of new rows still only plays one chime. */
  var SOUND_DURATION_MS = 3000;
  var SOUND_COOLDOWN_MS = 1200;

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
    /* second-precision live state: { [gamePk]: { latest, history, matchupLabel, teams } } */
    live: Object.create(null),
    /* pending rulings observed live: { [gamePk]: { [id]: record } } */
    pendingSeen: Object.create(null),
    sweepMs: 0,
    lastSweepAt: 0,
    lastStateChangeAt: 0,
    timers: { scan: null, sweep: null, countdown: null },
    nextScanAt: 0,
    lastRenderSignature: '',
    counterCache: Object.create(null),
    absFetchedRevCount: Object.create(null),
    lastGameDate: undefined,
    lookingForRecent: false,
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
    /* The live-state journal rides in the feed log so a refresh restores the
     * second-precision trail for every game, with its last capture time. */
    state.log.live = state.live;
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
    state.live = (log && log.live && typeof log.live === 'object') ? log.live : Object.create(null);
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

  function shouldFetch(game, now) {
    var status = (game.status && game.status.abstractGameState) || '';
    var pk = game.gamePk;
    if (status === 'Live') {
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

  function fetchGame(game) {
    var prevCount = state.absFetchedRevCount[game.gamePk];
    var status = (game.status && game.status.abstractGameState) || '';
    var pbpPromise = MLB.playByPlay(game.gamePk, { fields: PLAYBYPLAY_FIELDS, retries: 0 });
    var countersPromise = (prevCount === undefined || status === 'Live')
      ? MLB.gameFeed(game.gamePk, { fields: COUNTERS_FIELDS, retries: 0 }).catch(function () { return null; })
      : Promise.resolve(null);
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


  /* ------------------------------------------------- official-state helpers */

  /* Compact live-state summary attached to a feed row (never a prediction). */
  function stateSummary(snapshot) {
    if (!snapshot) return null;
    return {
      at: snapshot.at,
      atIso: snapshot.atIso,
      inningLabel: snapshot.inningLabel,
      score: snapshot.score,
      outs: snapshot.outs,
      balls: snapshot.balls,
      strikes: snapshot.strikes,
      pitchCount: snapshot.pitchCount,
      pitcher: snapshot.pitcher,
      batter: snapshot.batter,
      statusCode: snapshot.statusCode,
      detailedState: snapshot.detailedState,
    };
  }

  /**
   * officialWording(existingEntry, review, snapshot, at)
   *   .before  the official wording the first time this page observed the
   *            event (status code, detailed state, play description, outcome)
   *   .after   the official wording once the ruling resolved
   * A row first seen AFTER resolution stores the same wording twice and sets
   * `lateObservation`, so the UI can say the pre-ruling wording was not
   * observed instead of pretending it was.
   */
  function officialWording(existing, review, snapshot, at) {
    var official = (existing && existing.official) || {};
    var clock = global.LiveState ? global.LiveState.clockOf(at) : '';
    var wording = {
      at: at,
      atIso: global.LiveState ? global.LiveState.isoOf(at) : '',
      atClock: clock,
      statusCode: (snapshot && snapshot.statusCode) || '',
      detailedState: (snapshot && snapshot.detailedState) || '',
      eventType: review.eventType || '',
      description: review.playDescription || review.description || '',
      typeLabel: review.typeLabel || '',
      reason: review.reason || '',
      outcome: review.inProgress ? 'Under review' : (review.outcome || ''),
      reviewStatusCode: review.code || '',
    };
    if (!official.before) {
      official.before = wording;
      /* First sight of this row was already resolved: the pre-ruling wording
       * was never observed, so say so instead of pretending before === after
       * was captured live. */
      if (!review.inProgress) official.lateObservation = true;
    }
    if (!review.inProgress && !official.after) official.after = wording;
    return official;
  }

  /* One record for scoring-log.js.  `kind` is pending | change. */
  function scoringRecord(fields) {
    return Object.assign({
      at: Date.now(),
      atIso: global.LiveState ? global.LiveState.isoOf(Date.now()) : '',
      atClock: global.LiveState ? global.LiveState.clockOf(Date.now()) : '',
      status: 'open',
      source: 'MLB StatsAPI play-by-play (observed live by this page)',
    }, fields);
  }

  /* Writes happen only after every alert for this ingest has been raised, in
   * their own try/catch and their own store: a scoring-log failure can never
   * take a review, a run-at-risk warning or a scoring-change alert down. */
  function writeScoringLog(records) {
    var ScoringLog = global.ScoringLog;
    if (!ScoringLog || !records || !records.length) return;
    try {
      ScoringLog.record(state.date, records);
    } catch (e) {
      if (global.console && global.console.warn) {
        global.console.warn('[replay-feed] scoring log write failed (alert feed unaffected)', e);
      }
    }
  }

  function playAt(plays, atBatIndex) {
    for (var i = 0; i < (plays || []).length; i += 1) {
      var play = plays[i];
      if (play && play.about && Number(play.about.atBatIndex) === Number(atBatIndex)) return play;
    }
    return null;
  }

  function ingestGame(result, expectedSeq, expectedDate) {
    if (expectedSeq !== undefined && expectedSeq !== state.dateSeq) return;
    if (expectedDate !== undefined && expectedDate !== state.date) return;
    if (!result || !result.payload) {
      var err = result && result.error;
      if (err && !err.quiet) {
        /* One game failing (404 for a postponed/removed game, 500 for a flaky
         * endpoint) must not hide the whole slate's status or the latency
         * readout: it is recorded as an irregularity for that game, and only a
         * slate-wide failure (the schedule call) raises the scan banner. */
        if (err.status === 404 || err.status === 400) {
          noteIrregularity(result.game && result.game.gamePk,
            'Play-by-play unavailable (HTTP ' + err.status + ') — game left unread, flagged for review.');
        } else {
          state.scanError = err;
        }
      }
      return;
    }
    var game = result.game;
    var plays = Reviews.playsOf(result.payload);
    var teams = teamsOf(game);
    var meta = { gamePk: game.gamePk, teams: teams, feed: result.payload };

    /* ---- second-precision live-state snapshot (live-state.js) --------------
     * Captured on every poll, before any alerting, so the "before" wording of a
     * challenge/pending ruling/scoring change is whatever the official payload
     * said the moment this page first observed it. */
    var observedAt = Date.now();
    var liveSnapshot = LiveState ? LiveState.capture({
      gamePk: game.gamePk, teams: teams, game: game, payload: result.payload, at: observedAt,
    }) : null;
    var previousSnapshot = (state.live[game.gamePk] && state.live[game.gamePk].latest) || null;
    var stateChanges = (LiveState && liveSnapshot) ? LiveState.diff(previousSnapshot, liveSnapshot) : [];
    if (liveSnapshot) {
      var journalled = LiveState.append(state.live[game.gamePk] && state.live[game.gamePk].history, liveSnapshot);
      state.live[game.gamePk] = {
        latest: liveSnapshot,
        history: journalled.history,
        matchupLabel: UI.abbr(teams.away) + ' @ ' + UI.abbr(teams.home),
        teams: teams,
      };
      if (journalled.changed) state.lastStateChangeAt = observedAt;
    }
    /* Official-scoring records collected during this ingest and written to the
     * separate scoring store only after every alert has already been raised. */
    var scoringRecords = [];

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
        observedAt: observedAt,
        observedAtIso: LiveState ? LiveState.isoOf(observedAt) : '',
        official: officialWording(existing, review, liveSnapshot, observedAt),
        state: stateSummary(liveSnapshot),
        stateChanges: stateChanges.map(function (c) {
          return { field: c.field, label: c.label, before: c.before, after: c.after, at: observedAt };
        }),
      };

      var isNew = upsertEntry(entry);
      /* Always operate on the stored entry: upsertEntry merges into the
       * existing object, so flags like `warned` live there. */
      entry = state.entries.find(function (e) { return e.id === entry.id; }) || entry;

      /* Owner instruction 2026-11-27 supersedes the earlier "not ABS" title:
       * "It should make an alert sound for all events that we want to be
       * alerted to and that shows up in the alert feed."  ABS pitch
       * challenges are feed rows, so they chime too — once per row, throttled
       * by SOUND_COOLDOWN_MS, so a busy ABS game cannot become a drone. */
      if (isNew) chime(review.isABS ? 'abs' : 'review');
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

    /* ---- official-scorer pending rulings (at-bats not scored yet) ---------
     * Open rulings are feed rows AND scoring-log records; when the scorer
     * rules, the play's own official wording becomes the "after" half, so the
     * log keeps both sides of the change. */
    var pending = Reviews.pendingRulings(plays, meta);
    var pendingNow = Object.create(null);
    var seenForGame = state.pendingSeen[game.gamePk] || Object.create(null);
    pending.forEach(function (row) {
      pendingNow[row.id] = row;
      var existingPending = state.entries.find(function (e) { return e.id === row.id; });
      var isNewPending = upsertEntry({
        id: row.id,
        kind: 'pending',
        gamePk: game.gamePk,
        matchupLabel: UI.abbr(teams.away) + ' @ ' + UI.abbr(teams.home),
        teams: teams,
        pending: row,
        observedAt: observedAt,
        observedAtIso: LiveState ? LiveState.isoOf(observedAt) : '',
        state: stateSummary(liveSnapshot),
        official: {
          before: {
            at: observedAt,
            atIso: LiveState ? LiveState.isoOf(observedAt) : '',
            atClock: LiveState ? LiveState.clockOf(observedAt) : '',
            statusCode: (liveSnapshot && liveSnapshot.statusCode) || '',
            detailedState: (liveSnapshot && liveSnapshot.detailedState) || '',
            eventType: row.eventType,
            description: row.description,
            typeLabel: 'Official Scorer Ruling Pending',
            outcome: 'Pending',
          },
        },
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
        scoringRecords.push(scoringRecord({
          id: row.id,
          kind: 'pending',
          status: 'open',
          gamePk: game.gamePk,
          matchupLabel: UI.abbr(teams.away) + ' @ ' + UI.abbr(teams.home),
          inningLabel: row.inningLabel,
          atBatIndex: row.atBatIndex,
          batter: row.batter,
          pitcher: row.pitcher,
          officialBefore: {
            eventType: row.eventType,
            description: row.description,
            score: row.score,
          },
          wordingBefore: row.description,
          stateBefore: stateSummary(liveSnapshot),
          source: row.source,
        }));
      }
      seenForGame[row.id] = {
        row: row,
        at: (existingPending && existingPending.observedAt) || observedAt,
        snapshot: stateSummary(liveSnapshot),
      };
    });

    /* A ruling that is no longer pending has been decided: record the official
     * wording it was decided with (never a guess when the play is absent). */
    Object.keys(seenForGame).forEach(function (id) {
      if (pendingNow[id]) return;
      var seen = seenForGame[id];
      var resolvedPlay = playAt(plays, seen.row.atBatIndex);
      var resolvedResult = (resolvedPlay && resolvedPlay.result) || null;
      var resolvedType = (resolvedResult && resolvedResult.eventType) || '';
      var stillPending = resolvedType === 'os_ruling_pending_primary' || resolvedType === 'os_ruling_pending_prior';
      if (!resolvedResult || stillPending) return; // no evidence yet — keep watching
      var resolvedEntry = state.entries.find(function (e) { return e.id === id; });
      var after = {
        at: observedAt,
        atIso: LiveState ? LiveState.isoOf(observedAt) : '',
        atClock: LiveState ? LiveState.clockOf(observedAt) : '',
        statusCode: (liveSnapshot && liveSnapshot.statusCode) || '',
        detailedState: (liveSnapshot && liveSnapshot.detailedState) || '',
        eventType: resolvedType,
        description: resolvedResult.description || '',
        outcome: 'Ruled',
      };
      if (resolvedEntry) {
        resolvedEntry.official = Object.assign({}, resolvedEntry.official || {}, { after: after });
        resolvedEntry.resolvedAt = observedAt;
        resolvedEntry.lastSeen = observedAt;
        if (resolvedEntry.pending) resolvedEntry.pending = Object.assign({}, resolvedEntry.pending, { resolved: true });
      }
      scoringRecords.push(scoringRecord({
        id: id,
        kind: 'pending',
        status: 'resolved',
        gamePk: game.gamePk,
        matchupLabel: UI.abbr(teams.away) + ' @ ' + UI.abbr(teams.home),
        inningLabel: (resolvedEntry && resolvedEntry.pending && resolvedEntry.pending.inningLabel) || seen.row.inningLabel,
        atBatIndex: seen.row.atBatIndex,
        batter: seen.row.batter,
        pitcher: seen.row.pitcher,
        at: seen.at,
        officialBefore: { eventType: seen.row.eventType, description: seen.row.description },
        wordingBefore: seen.row.description,
        stateBefore: seen.snapshot,
        officialAfter: {
          eventType: resolvedType,
          description: resolvedResult.description || '',
          score: liveSnapshot ? liveSnapshot.score : null,
        },
        wordingAfter: resolvedResult.description || '',
        stateAfter: stateSummary(liveSnapshot),
        source: seen.row.source,
      }));
    });
    state.pendingSeen[game.gamePk] = pendingNow && Object.keys(pendingNow).length
      ? seenForGame : Object.create(null);

    /* ---- official scoring changes */
    var snapshot = Reviews.snapshotPlays(plays);
    var previous = state.snapshots[game.gamePk];
    var diff = Reviews.diffSnapshots(previous, snapshot);
    state.snapshots[game.gamePk] = snapshot;

    diff.changes.forEach(function (change) {
      var changeId = game.gamePk + ':' + change.atBatIndex + ':scoring-change';
      var existingChange = state.entries.find(function (e) { return e.id === changeId; });
      var isNewChange = upsertEntry({
        id: changeId,
        kind: 'scoring_change',
        gamePk: game.gamePk,
        matchupLabel: UI.abbr(teams.away) + ' @ ' + UI.abbr(teams.home),
        teams: teams,
        change: change,
        observedAt: observedAt,
        observedAtIso: LiveState ? LiveState.isoOf(observedAt) : '',
        state: stateSummary(liveSnapshot),
        official: {
          before: (existingChange && existingChange.official && existingChange.official.before) || {
            at: observedAt,
            atIso: LiveState ? LiveState.isoOf(observedAt) : '',
            atClock: LiveState ? LiveState.clockOf(observedAt) : '',
            statusCode: (liveSnapshot && liveSnapshot.statusCode) || '',
            detailedState: (liveSnapshot && liveSnapshot.detailedState) || '',
            eventType: change.from.eventType,
            description: change.from.description,
            outcome: 'Initial call (official scoring)',
          },
          after: {
            at: observedAt,
            atIso: LiveState ? LiveState.isoOf(observedAt) : '',
            atClock: LiveState ? LiveState.clockOf(observedAt) : '',
            statusCode: (liveSnapshot && liveSnapshot.statusCode) || '',
            detailedState: (liveSnapshot && liveSnapshot.detailedState) || '',
            eventType: change.to.eventType,
            description: change.to.description,
            outcome: 'Final ruling (official scoring)',
          },
        },
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
      if (isNewChange) chime('scoring');
      if (state.log) {
        state.log.grace = state.log.grace || {};
        state.log.grace[game.gamePk] = Date.now();
      }
      /* Separate scoring store — written after the chime, so it cannot delay or
       * break the alert path. */
      scoringRecords.push(scoringRecord({
        id: changeId,
        kind: 'change',
        status: 'changed',
        gamePk: game.gamePk,
        matchupLabel: UI.abbr(teams.away) + ' @ ' + UI.abbr(teams.home),
        inningLabel: change.inningLabel,
        atBatIndex: change.atBatIndex,
        batter: change.batter,
        at: (existingChange && existingChange.observedAt) || observedAt,
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
        stateBefore: (existingChange && existingChange.state) || stateSummary(previousSnapshot),
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
        stateAfter: stateSummary(liveSnapshot),
        attribution: change.attribution,
      }));
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

    /* Last statement of the ingest: the alert path above has already finished
     * (chimes raised, feed rows upserted), so the separate scoring store can
     * neither delay nor disrupt it. */
    writeScoringLog(scoringRecords);
  }

  function scan() {
    if (state.scanning) return;
    if (document.hidden) { scheduleScan(1000); return; }
    var scanSeq = state.dateSeq;
    var scanDate = state.date;
    state.scanning = true;
    state.nextScanAt = Date.now() + SCAN_MS;

    MLB.schedule(scanDate, { ttl: 0, retries: 0 })
      .then(function (payload) {
        if (scanSeq !== state.dateSeq || scanDate !== state.date) return null;
        var hadLive = liveGameCount();
        state.games = flattenGames(payload);
        if (!hadLive && liveGameCount()) scheduleSweep(0);
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

  /* ----------------------------------------------------- official status sweep
   * The fastest honest signal.  MLB flips `status.statusCode` the moment a
   * challenge/review is called — typically before the play text lands — so this
   * poll runs at 125 ms while any game is live.  The sweep also times itself
   * (state.sweepMs) so the page can show the real round-trip instead of a
   * claimed latency, and it relaxes to 1 s (bounded, TOS-friendly) when nothing
   * is in progress, while the tab is hidden, or while a 429 quiet period runs.
   */
  function liveGameCount() {
    return state.games.filter(function (g) {
      return g && g.status && g.status.abstractGameState === 'Live';
    }).length;
  }

  function sweepDelay() {
    return liveGameCount() ? SWEEP_LIVE_MS : SWEEP_IDLE_MS;
  }

  function scheduleSweep(delay) {
    clearTimeout(state.timers.sweep);
    var wait = typeof delay === 'number' ? delay : sweepDelay();
    state.timers.sweep = setTimeout(sweep, Math.max(0, wait));
  }

  function sweep() {
    if (document.hidden || !liveGameCount()) { scheduleSweep(SWEEP_IDLE_MS); return; }
    if (MLB.quietRemainingMs && MLB.quietRemainingMs() > 0) {
      scheduleSweep(Math.min(5000, Math.max(SWEEP_IDLE_MS, MLB.quietRemainingMs())));
      return;
    }
    var sweepSeq = state.dateSeq;
    var sweepDate = state.date;
    var startedAt = Date.now();
    MLB.slateStatus(sweepDate).then(function (payload) {
      state.sweepMs = Date.now() - startedAt;
      state.lastSweepAt = Date.now();
      if (sweepSeq !== state.dateSeq || sweepDate !== state.date) return;
      var games = flattenGames(payload);
      games.forEach(function (g) {
        var review = Reviews.statusReview(g.status);
        var prev = state.statusByPk[g.gamePk];
        var nextKey = review ? review.code + '|' + review.reason : '';
        if (prev === nextKey) return;
        state.statusByPk[g.gamePk] = nextKey;
        if (!review) return;
        /* Out-of-band fetch: never wait for the current 250 ms scan.  This is
         * what makes the alert land within a sweep of the official flip. */
        fetchGame(g).then(function (result) {
          if (sweepSeq !== state.dateSeq || sweepDate !== state.date) return;
          ingestGame(result, sweepSeq, sweepDate);
          persist(sweepSeq, sweepDate);
          renderIfChanged();
          updateChrome();
        });
      });
      scheduleSweep(sweepDelay());
    }).catch(function () {
      state.sweepMs = Date.now() - startedAt;
      /* the scan owns error reporting; keep sweeping, but gently */
      scheduleSweep(SWEEP_IDLE_MS);
    });
  }

  /* ------------------------------------------------------------- sound/notify */

  var audioCtx = null;

  function audioContext() {
    var Ctx = global.AudioContext || global.webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === 'suspended' && audioCtx.resume) audioCtx.resume();
    return audioCtx;
  }

  /* Seeded PRNG so every chime is the same pleasant pattern (a random scattershot
   * of droplets every time is what makes a sound tiring over a season). */
  function seeded(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  /**
   * playRaindrop() — a ~3 second rain drop.
   *
   * Layers, all gently filtered so it can be heard all day:
   *   - a soft rain bed (band-passed noise, very low level) that fades in/out
   *   - 13 water droplets: sine tones whose pitch falls as they decay, panned
   *     across the stereo field, decaying from 0.12 s to 0.95 s
   *   - two low "plops" for body, and a short delay for space
   * Peak amplitude is deliberately low (0.16) — a notification you can keep on
   * for nine innings, not a klaxon.
   */
  function playRaindrop() {
    var ctx = audioContext();
    if (!ctx) return false;
    try {
      var t0 = ctx.currentTime;
      var dur = SOUND_DURATION_MS / 1000;

      var master = ctx.createGain();
      master.gain.setValueAtTime(0.0001, t0);
      master.gain.exponentialRampToValueAtTime(0.16, t0 + 0.25);
      master.gain.setValueAtTime(0.16, t0 + dur - 0.9);
      master.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      var softener = ctx.createBiquadFilter();
      softener.type = 'lowpass';
      softener.frequency.setValueAtTime(4200, t0);
      softener.Q.setValueAtTime(0.4, t0);
      master.connect(softener);
      softener.connect(ctx.destination);

      /* small room: one short echo keeps the drops from sounding dry/clicky */
      var echo = ctx.createDelay(0.5);
      echo.delayTime.setValueAtTime(0.19, t0);
      var echoGain = ctx.createGain();
      echoGain.gain.setValueAtTime(0.22, t0);
      var echoFilter = ctx.createBiquadFilter();
      echoFilter.type = 'lowpass';
      echoFilter.frequency.setValueAtTime(2200, t0);
      master.connect(echo);
      echo.connect(echoFilter);
      echoFilter.connect(echoGain);
      echoGain.connect(ctx.destination);

      /* rain bed: filtered noise, barely there */
      var frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
      var buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
      var data = buffer.getChannelData(0);
      var rnd = seeded(20261127);
      for (var i = 0; i < frames; i += 1) data[i] = rnd() * 2 - 1;
      var bed = ctx.createBufferSource();
      bed.buffer = buffer;
      var bedFilter = ctx.createBiquadFilter();
      bedFilter.type = 'bandpass';
      bedFilter.frequency.setValueAtTime(1400, t0);
      bedFilter.Q.setValueAtTime(0.6, t0);
      var bedGain = ctx.createGain();
      bedGain.gain.setValueAtTime(0.0001, t0);
      bedGain.gain.exponentialRampToValueAtTime(0.05, t0 + 0.5);
      bedGain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      bed.connect(bedFilter);
      bedFilter.connect(bedGain);
      bedGain.connect(master);
      bed.start(t0);

      function pan(node, value) {
        if (typeof ctx.createStereoPanner !== 'function') return node;
        var p = ctx.createStereoPanner();
        p.pan.setValueAtTime(Math.max(-1, Math.min(1, value)), t0);
        node.connect(p);
        return p;
      }

      function drop(at, freq, decay, level, panValue, type) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        var filter = ctx.createBiquadFilter();
        osc.type = type || 'sine';
        osc.frequency.setValueAtTime(freq, at);
        /* a drop's pitch rises for an instant then falls as it spreads */
        osc.frequency.exponentialRampToValueAtTime(freq * 1.06, at + 0.02);
        osc.frequency.exponentialRampToValueAtTime(Math.max(60, freq * 0.72), at + decay);
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(Math.max(600, freq * 2.2), at);
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(level, at + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + decay);
        osc.connect(filter);
        filter.connect(gain);
        var out = pan(gain, panValue);
        out.connect(master);
        osc.start(at);
        osc.stop(at + decay + 0.06);
      }

      /* 13 droplets: deterministic times/frequencies/pans, descending in
       * energy so the chime resolves instead of trailing off randomly. */
      var drops = [
        [0.00, 1280, 0.30, 0.16, -0.35],
        [0.13, 960, 0.55, 0.20, 0.30],
        [0.29, 1520, 0.26, 0.13, 0.55],
        [0.44, 780, 0.75, 0.18, -0.55],
        [0.62, 1180, 0.40, 0.14, 0.10],
        [0.78, 1640, 0.22, 0.10, -0.20],
        [0.95, 690, 0.90, 0.15, 0.40],
        [1.18, 1040, 0.50, 0.12, -0.45],
        [1.40, 1360, 0.34, 0.10, 0.25],
        [1.66, 860, 0.66, 0.11, -0.15],
        [1.92, 1210, 0.42, 0.09, 0.50],
        [2.20, 730, 0.70, 0.08, -0.40],
        [2.48, 1080, 0.46, 0.06, 0.20],
      ];
      drops.forEach(function (d) { drop(t0 + d[0], d[1], d[2], d[3], d[4], 'sine'); });
      /* two low plops give the drop body without a boom */
      drop(t0 + 0.06, 210, 0.55, 0.10, 0.0, 'triangle');
      drop(t0 + 0.52, 176, 0.70, 0.08, -0.1, 'triangle');
      return true;
    } catch (e) {
      return false; /* audio is a nicety, never a failure path */
    }
  }

  /**
   * chime(reason) — one alert sound per newly observed feed event.
   *   reason 'test' plays even when the toggle is off (that is the point of a
   *   test button) and ignores the cooldown; every other reason respects both.
   */
  function chime(reason) {
    var isTest = reason === 'test';
    if (!isTest && !state.soundOn) return false;
    var at = Date.now();
    if (!isTest && at - state.lastChimeAt < SOUND_COOLDOWN_MS) return false;
    state.lastChimeAt = at;
    state.lastChimeReason = reason || 'event';
    return playRaindrop();
  }

  /** Test button: audible proof the alert path works, toggle state untouched. */
  function testSound() {
    chime('test');
    var btn = $('sound-test-btn');
    if (btn) {
      btn.classList.add('is-flash');
      setTimeout(function () { btn.classList.remove('is-flash'); }, 3200);
    }
    var note = $('sound-test-note');
    if (note) {
      note.textContent = (global.AudioContext || global.webkitAudioContext)
        ? 'Test chime played (' + (SOUND_DURATION_MS / 1000).toFixed(0) + 's raindrop).'
        : 'This browser has no Web Audio API, so no sound can play.';
    }
    return true;
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
    var s = { total: 0, manager: 0, umpire: 0, abs: 0, boundary: 0, under: 0, risk: 0, scoring: 0, pending: 0 };
    state.entries.forEach(function (e) {
      if (e.kind === 'scoring_change') { s.scoring += 1; return; }
      if (e.kind === 'pending') { s.pending += 1; return; }
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

  /* --------------------------------------------------- live state (all games)
   * Every game on the slate, captured to the second from the official payload:
   * score, inning, outs, count, pitch count, pitcher, batter and the official
   * last-play wording.  This is the "state as it happens" view; the rows below
   * it are the alerted events. */
  function renderLiveBoard() {
    var el = $('live-state-board');
    if (!el) return;
    if (!state.games.length) { el.innerHTML = ''; return; }
    var cards = state.games.map(function (game) {
      var entry = state.live[game.gamePk];
      var snap = entry && entry.latest;
      var status = (game.status && game.status.abstractGameState) || '';
      var cls = 'live-card' + (status === 'Live' ? ' is-live' : status === 'Final' ? ' is-final' : '');
      var link = 'game.html?gamePk=' + encodeURIComponent(game.gamePk) + '&date=' + encodeURIComponent(state.date);
      var label = entry ? entry.matchupLabel : (UI.abbr(game.teams && game.teams.away && game.teams.away.team) + ' @ ' +
        UI.abbr(game.teams && game.teams.home && game.teams.home.team));
      if (!snap) {
        return '<a class="' + cls + '" href="' + link + '">' +
          '<div class="live-card-top"><b>' + UI.esc(label) + '</b>' +
          '<span class="live-tag">' + UI.esc((game.status && game.status.detailedState) || status || '—') + '</span></div>' +
          '<div class="live-meta">State not captured yet — waiting for the first poll.</div>' +
        '</a>';
      }
      var count = (snap.balls === null || snap.balls === undefined ? '—' : snap.balls) + '-' +
        (snap.strikes === null || snap.strikes === undefined ? '—' : snap.strikes);
      var outs = snap.outs === null || snap.outs === undefined ? '—' : snap.outs;
      var pitch = snap.pitchCount && snap.pitchCount.pitcher !== null
        ? snap.pitchCount.pitcher + '/game ' + snap.pitchCount.total
        : String(snap.pitchCount ? snap.pitchCount.total : '—');
      return '<a class="' + cls + '" href="' + link + '">' +
        '<div class="live-card-top"><b>' + UI.esc(label) + '</b>' +
        '<span class="live-tag">' + UI.esc(snap.detailedState || snap.status || status || '—') + '</span></div>' +
        '<div class="live-score">' + UI.esc(LiveState ? LiveState.scoreText(snap.score) : '') +
          '<span class="live-inning">' + UI.esc(snap.inningLabel || '') + '</span></div>' +
        '<div class="live-meta">' + outs + ' out' + (Number(outs) === 1 ? '' : 's') +
          ' · ' + count + ' count · ' + UI.esc(pitch) + ' pitches</div>' +
        '<div class="live-meta">P ' + UI.esc((snap.pitcher && snap.pitcher.name) || '—') +
          ' · AB ' + UI.esc((snap.batter && snap.batter.name) || '—') + '</div>' +
        (snap.play && snap.play.description
          ? '<div class="live-play">' + UI.esc(snap.play.description) + '</div>' : '') +
        '<div class="live-stamp">captured ' + UI.esc(snap.atClock || '') + ' UTC-offset local · ' +
          UI.esc(String((entry.history || []).length)) + ' change(s) journalled</div>' +
      '</a>';
    });
    el.innerHTML = '<div class="live-board">' +
      '<div class="live-board-head"><span>Live game state — all games, captured to the second</span>' +
      '<span class="live-board-note">' + liveGameCount() + ' live · ' + state.games.length + ' on the slate</span></div>' +
      '<div class="live-board-grid">' + cards.join('') + '</div>' +
    '</div>';
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
      { n: s.pending, label: 'Pending rulings', cls: '' },
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

    /* Exact official wording before and after — copied from the payload, never
     * paraphrased.  For a review/pending row this shows the pre-ruling and
     * post-ruling wording; a scoring change shows its initial call / final
     * ruling below. */
    var officialHtml = '';
    if (entry.official && entry.official.before && entry.kind !== 'scoring_change') {
      var ob = entry.official.before;
      var oa = entry.official.after;
      officialHtml = '<dl class="official-wording">' +
        '<dt>Official wording — before' + (ob.atClock ? ' (' + UI.esc(ob.atClock) + ')' : '') + '</dt>' +
        '<dd>' + UI.esc(ob.description || '—') + '</dd>' +
        '<dt>Official wording — after' + (oa && oa.atClock ? ' (' + UI.esc(oa.atClock) + ')' : '') + '</dt>' +
        '<dd>' + (oa ? UI.esc(oa.description || '—') : UI.esc(entry.kind === 'pending' ? 'Ruling not issued yet — pending.' : 'Awaiting the official ruling.')) + '</dd>' +
        (entry.kind === 'pending' && oa && oa.eventType
          ? '<dt>Official classification</dt><dd>' + UI.esc(oa.eventType) + '</dd>' : '') +
        (entry.official.lateObservation
          ? '<dt>Observation</dt><dd>Row first observed after the ruling — the pre-ruling wording was not captured live.</dd>' : '') +
      '</dl>';
    }

    var changeHtml = '';
    if (entry.kind === 'scoring_change' && entry.change) {
      changeHtml = '<div class="feed-sub">Initial call' +
        (entry.official && entry.official.before && entry.official.before.atClock
          ? ' (' + UI.esc(entry.official.before.atClock) + ')' : '') + ': ' +
        UI.esc(entry.change.from && entry.change.from.description ? entry.change.from.description : '') +
        '</div><div class="feed-sub">Final ruling' +
        (entry.official && entry.official.after && entry.official.after.atClock
          ? ' (' + UI.esc(entry.official.after.atClock) + ')' : '') + ': ' +
        UI.esc(entry.change.to && entry.change.to.description ? entry.change.to.description : '') + '</div>' +
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
          '<span title="Observed ' + UI.esc(entry.observedAtIso || '') + '">' +
            UI.esc(entry.observedAt ? (LiveState ? LiveState.clockOf(entry.observedAt) : '') : '') + '</span>' +
          '<a href="https://statsapi.mlb.com/api/v1/game/' + encodeURIComponent(entry.gamePk) + '/playByPlay" target="_blank" rel="noopener" title="Official MLB StatsAPI play-by-play source">MLB API ↗</a>' +
        '</div>' +
        '<div class="feed-title">' + UI.esc((r.batter && r.batter.name) || '') +
          (r.pitcher && r.pitcher.name ? ' vs ' + UI.esc(r.pitcher.name) : '') + '</div>' +
        (r.description ? '<div class="feed-sub">' + UI.esc(r.description) + '</div>' : '') +
        absLine + changeHtml + pendingHtml + officialHtml +
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
    var liveSig = Object.keys(state.live).map(function (pk) {
      var latest = state.live[pk] && state.live[pk].latest;
      return pk + ':' + (latest ? latest.at + ':' + (state.live[pk].history || []).length : '');
    }).join(',');
    return state.filter + '|' + state.games.length + '|' + (state.lastGameDate || '') + '|' + liveSig + '|' +
      state.entries.map(function (e) {
      return [e.id, e.lastSeen, e.review && e.review.outcome, e.review && e.review.inProgress,
        e.official && e.official.after ? 'ruled' : 'open',
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
    renderLiveBoard();
    renderTabs();
    renderStats();
    renderActiveStrip();
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
    if (state.scanError) {
      statusLine('Scan problem: ' + (state.scanError.message || 'network error') + ' — retrying.', true);
    } else {
      var live = liveGameCount();
      var lat = MLB.latencyStats ? MLB.latencyStats() : null;
      var latencyText = lat && lat.count
        ? ' · status sweep ' + state.sweepMs + 'ms · API p50 ' + lat.p50 + 'ms / p95 ' + lat.p95 + 'ms'
        : '';
      statusLine(state.games.length + ' game(s) on ' + MLB.formatDateLabel(state.date) +
        ' · ' + live + ' live · ' + state.entries.length + ' tracked entr' + (state.entries.length === 1 ? 'y' : 'ies') +
        ' · polled ' + (live ? SWEEP_LIVE_MS + 'ms sweep / ' + SCAN_MS + 'ms scan' : SCAN_MS + 'ms scan') +
        ' · scanned ' + new Date(state.lastScanAt || Date.now()).toLocaleTimeString() +
        latencyText +
        (FeedLog.state.available ? ' · shared log connected' : ' · local log only') +
        (MLB.quietRemainingMs && MLB.quietRemainingMs() > 0
          ? ' · API asked us to slow down (' + Math.ceil(MLB.quietRemainingMs() / 1000) + 's)'
          : ''));
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
    state.counterCache = Object.create(null);
    state.absFetchedRevCount = Object.create(null);
    state.live = Object.create(null);
    state.pendingSeen = Object.create(null);
    state.sweepMs = 0;
    state.lastStateChangeAt = 0;
    state.lastGameDate = undefined;
    state.lookingForRecent = false;
    state.log = null;
    state.lastRenderSignature = '';
    syncNav();
    render();
    FeedLog.closeStream();
    FeedLog.load(clean).then(function (log) {
      if (seq !== state.dateSeq || state.date !== clean) return;
      adoptLog(log);
      render();
      FeedLog.openStream(clean);
      scan();
    });
  }

  function setFilter(filter) { state.filter = filter; render(); }

  function toggleSound() {
    state.soundOn = !state.soundOn;
    savePref('sound', state.soundOn);
    var btn = $('sound-toggle-btn');
    if (btn) {
      btn.textContent = state.soundOn ? '🔊 Sound On' : '🔇 Sound Off';
      btn.classList.toggle('btn-on', state.soundOn);
    }
    if (state.soundOn) chime('preview');
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

    FeedLog.onChange(function (pushed) {
      if (pushed && pushed.date === state.date) {
        adoptLog(FeedLog.mergePayloads(state.log, pushed, state.date));
        render();
      }
    });

    var soundBtn = $('sound-toggle-btn');
    if (soundBtn) {
      soundBtn.textContent = state.soundOn ? '🔊 Sound On' : '🔇 Sound Off';
      soundBtn.classList.toggle('btn-on', state.soundOn);
      soundBtn.addEventListener('click', toggleSound);
    }
    var notifyBtn = $('notify-toggle-btn');
    if (notifyBtn) {
      notifyBtn.textContent = state.notifyOn ? '🔴 Run Alerts On' : '⚪ Run Alerts Off';
      notifyBtn.classList.toggle('btn-on', state.notifyOn);
      notifyBtn.addEventListener('click', toggleNotify);
    }
    var testBtn = $('sound-test-btn');
    if (testBtn) testBtn.addEventListener('click', testSound);

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
      if (!document.hidden) { scan(); }
    });

    Reviews.loadRegistry();

    var initSeq = state.dateSeq;
    var initDate = state.date;
    FeedLog.load(initDate).then(function (log) {
      if (initSeq !== state.dateSeq || state.date !== initDate) return;
      adoptLog(log);
      render();
      FeedLog.openStream(initDate);
      scan();
    });

    scheduleSweep(SWEEP_LIVE_MS);
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
    toggleNotify: toggleNotify,
    testSound: testSound,
    scan: scan,
    sweep: sweep,
    state: state,
    latency: function () {
      var cur = MLB.latencyStats ? MLB.latencyStats() : null;
      if (!cur) return null;
      cur.sweepMs = state.sweepMs;
      cur.sweepAt = state.lastSweepAt;
      cur.sweepIntervalMs = sweepDelay();
      return cur;
    },
    SCAN_MS: SCAN_MS,
    STATUS_SWEEP_MS: STATUS_SWEEP_MS,
    SWEEP_LIVE_MS: SWEEP_LIVE_MS,
    SWEEP_IDLE_MS: SWEEP_IDLE_MS,
    SOUND_DURATION_MS: SOUND_DURATION_MS,
    SOUND_COOLDOWN_MS: SOUND_COOLDOWN_MS,
    FETCH_CONCURRENCY: FETCH_CONCURRENCY,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}(window));
