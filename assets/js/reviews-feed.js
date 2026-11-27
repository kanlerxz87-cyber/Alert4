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
 * Every tracked entry is persisted through feed-log.js (localStorage + the
 * optional server store) and restored on the next visit.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var MLB = global.MLB;
  var UI = global.UI;
  var Reviews = global.Reviews;
  var FeedLog = global.FeedLog;

  var SCAN_MS = 250;
  var STATUS_SWEEP_MS = 125;
  var FETCH_CONCURRENCY = 6;
  var FINAL_GRACE_MS = 30 * 60 * 1000;
  var SOUND_COOLDOWN_MS = 2500;
  /* Two-tier scan, so every request earns its place inside the budget in
   * api.js: a tiny metaData probe for each live game decides whether the game
   * feed actually moved, and the full play-by-play is only fetched when it did
   * (or when the game flips into/out of an official review status). */
  var PROBE_TIER_MS = 500;          // fastest per-game probe interval (few games)
  var FULL_TIER_MS = 250;           // extra-fast probe while a game's feed is moving
  var CHANGED_LINGER_MS = 4000;
  var SLATE_MS = 1000;              // roster of games; the 125 ms sweep owns status
  var PROBE_BUDGET_PER_SEC = 8;     // share of the request budget reserved for probes

  var PLAYBYPLAY_FIELDS = 'allPlays,about,atBatIndex,hasReview,isComplete,inning,halfInning,isTopInning,isScoringPlay,' +
    'result,eventType,description,isOut,rbi,awayScore,homeScore,count,balls,strikes,outs,matchup,batter,id,fullName,pitcher,' +
    'playEvents,details,call,reviewDetails,isOverturned,inProgress,reviewType,challengeTeamId,runners,' +
    'isScoringEvent,playIndex,movement,index,isPitch,pitchNumber,type,startTime,endTime,hasOutcome';

  /* One lean feed/live read per changed game carries BOTH the official challenge
   * counters and the official game state (linescore, status, current play,
   * metaData timecode).  playByPlay alone has no linescore, so a snapshot built
   * from it would have no score, outs, count or inning — this is why the state
   * comes from the feed and the play-level review data still comes from
   * playByPlay (whose parser is the one the whole app already uses). */
  var STATE_AND_COUNTERS_FIELDS = 'metaData,timeStamp,gameData,game,status,detailedState,abstractGameState,' +
    'statusCode,reason,review,absChallenges,hasChallenges,away,home,used,remaining,usedSuccessful,usedFailed,' +
    'linescore,currentInning,isTopInning,inningState,outs,balls,strikes,teams,runs,hits,errors,offense,' +
    'first,second,third,onDeck,inHole,defense,pitcher,batter,id,fullName,currentPlay,about,atBatIndex,' +
    'isComplete,result,eventType,description,isOut,count,matchup,playEvents,index,isPitch,pitchNumber,details,call';

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
    lastChimeReason: '',
    chimes: 0,
    lastScanAt: 0,
    timers: { scan: null, sweep: null, countdown: null },
    nextScanAt: 0,
    lastRenderSignature: '',
    counterCache: Object.create(null),
    absFetchedRevCount: Object.create(null),
    counterStatus: Object.create(null),
    lastGameDate: undefined,
    lookingForRecent: false,
    /* latency instrumentation */
    probeSig: Object.create(null),   // gamePk -> last metaData signature seen
    probeAt: Object.create(null),    // gamePk -> when that signature was observed
    changedUntil: Object.create(null), // gamePk -> full-read priority window
    latencies: [],                   // observed publish latencies (ms), newest last
    scanBudget: 0,                   // requests the gate started in the last second
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

  /* Full read + the official counters.  `wantFull` is what the probe decided:
   * 'live' (read every time), 'changed' (the feed moved), 'forced' (review
   * status flipped, or no probe marker was ever published). */
  function fetchGame(game, wantFull) {
    var pk = game.gamePk;
    var pbpPromise = wantFull
      ? MLB.playByPlay(pk, { fields: PLAYBYPLAY_FIELDS, retries: 0 })
      : Promise.resolve(null);
    /* Same request the counters already needed — now also the state source. */
    var countersPromise = wantFull
      ? MLB.gameFeed(pk, { fields: STATE_AND_COUNTERS_FIELDS, retries: 0 }).catch(function () { return null; })
      : Promise.resolve(null);
    state.counterStatus[pk] = (game.status && game.status.abstractGameState) || '';
    return Promise.all([pbpPromise, countersPromise])
      .then(function (parts) {
        return { game: game, payload: parts[0], countersPayload: parts[1] };
      })
      .catch(function (err) {
        return { game: game, payload: null, countersPayload: null, error: err };
      });
  }

  /* One tick for one game inside a scan: probe first, read only if it moved.
   * Returns 'full' when the play-by-play was (or should be) read, 'probe' when
   * the probe said "nothing new", 'skip' when the game is outside its window. */
  function scanGame(game, now, forceFull) {
    var pk = game.gamePk;
    var status = (game.status && game.status.abstractGameState) || '';
    var inChanged = state.changedUntil[pk] && now < state.changedUntil[pk];

    /* Final games: unchanged API contract, just the post-final re-scan cadence. */
    if (status === 'Final') {
      return shouldFetch(game, now)
        ? fetchGame(game, true).then(function (result) { ingestGame(result); return 'full'; })
        : Promise.resolve('skip');
    }
    if (status !== 'Live') return Promise.resolve('skip');

    /* A status flip forces exactly one read (the sweep may already have done
     * it); everything else goes through the probe.  Inside the priority window
     * the probe simply runs at the full tier instead of the probe tier — the
     * play-by-play is still only read when the feed actually moved, so a
     * review in flight does not multiply requests. */
    if (forceFull) {
      return fetchGame(game, true).then(function (result) { ingestGame(result); return 'full'; });
    }

    var due = state.nextDue[pk] || 0;
    if (now < due) return Promise.resolve('skip');
    var liveCount = state.games.filter(function (g) {
      return g.status && g.status.abstractGameState === 'Live';
    }).length;
    var interval = probeIntervalMs(liveCount);
    /* Above the 250 ms floor there is room to check the games that just moved
     * more often than the rest. */
    if (inChanged) interval = Math.max(FULL_TIER_MS, Math.round(interval / 3));
    state.nextDue[pk] = now + interval;

    return MLB.gameProbe(pk).then(function (sig) {
      var prev = state.probeSig[pk];
      /* First sight of a game (or no marker published): fall back to a full read
       * so nothing can be missed, then rely on the probe. */
      if (!sig || prev === undefined || prev === '') {
        state.probeSig[pk] = sig || '';
        return fetchGame(game, true).then(function (result) { ingestGame(result); return 'full'; });
      }
      if (sig === prev) return 'probe';
      state.probeSig[pk] = sig;
      state.probeAt[pk] = Date.now();
      state.changedUntil[pk] = Date.now() + CHANGED_LINGER_MS;
      return fetchGame(game, true).then(function (result) { ingestGame(result); return 'full'; });
    }).catch(function () {
      /* A failed probe is not a failed game: fall back to the full read, whose
       * own error handling and quiet-period logic already exist. */
      return fetchGame(game, true).then(function (result) { ingestGame(result); return 'full'; });
    });
  }

  function loadGameState(date) {
    var GS = global.GameState;
    if (!GS) return;
    try {
      GS.load(date).then(function (day) {
        if (!day || state.date !== date) return;
        GS.adopt(date, day);
        renderLiveState();
      }).catch(function () { /* the store is an enrichment, never a dependency */ });
    } catch (e) { /* ignore */ }
  }

  /* ---- official game state + latency instrumentation --------------------- */

  /* Record the game's official state (score, outs, count, batter, pitcher,
   * runners, inning, pitch, status) with both clocks.  Its own storage and its
   * own try/catch: a problem here can never stop an alert. */
  function recordGameState(game, matchupLabel, result, plays) {
    var GS = global.GameState;
    if (!GS) return;
    try {
      /* Prefer the feed read: it is the only payload carrying linescore + status
       * + the published timecode.  playByPlay is the fallback, and then the
       * snapshot honestly reports the fields it cannot see. */
      var stateSource = result.countersPayload || result.payload;
      var snap = GS.snapshot(stateSource, { gamePk: game.gamePk });
      if (!snap) return;
      /* A feed/live payload carries metaData; the playByPlay fallback does not,
       * so use the probe's timecode when we have a fresher one than the body. */
      if (!snap.gameTimecode && state.probeSig[game.gamePk]) snap.gameTimecode = state.probeSig[game.gamePk];
      if (snap.gameTimecode && snap.gameTimecodeMs === null) {
        var parsed = GS.parseGameTimecode(snap.gameTimecode, snap.capturedAt);
        if (parsed !== null) {
          snap.gameTimecodeMs = parsed;
          snap.latencyMs = Math.max(0, snap.capturedAt - parsed);
        }
      }
      if (typeof snap.latencyMs === 'number' && isFinite(snap.latencyMs)) {
        state.latencies.push(snap.latencyMs);
        if (state.latencies.length > 60) state.latencies.shift();
      }
      GS.record(state.date, game.gamePk, matchupLabel, snap, { save: true });
    } catch (e) {
      global.console && global.console.warn && global.console.warn('[replay-feed] state capture skipped', e);
    }
  }

  /* The ISO timestamp of the newest state snapshot we hold for a game, so a
   * scoring-change row can say when its "after" wording was observed. */
  function gameStateSnap(gamePk) {
    var GS = global.GameState;
    if (!GS) return null;
    try {
      var latestSnap = GS.latest(state.date, gamePk);
      return latestSnap ? latestSnap.observedAt : null;
    } catch (e) { return null; }
  }

  function existingOfficial(change) {
    var id = change && change.atBatIndex !== undefined
      ? change.atBatIndex : null;
    if (id === null) return null;
    var entry = state.entries.find(function (e) {
      return e.kind === 'scoring_change' && e.change && e.change.atBatIndex === id;
    });
    return entry && entry.official ? entry.official.before : null;
  }

  /* officialWording({before, state}) — keeps the first observed official wording
   * and the latest, both with their timestamps.  Never rewrites history. */
  function officialWording(args) {
    var before = args && args.before ? args.before : null;
    var nowState = (args && args.state) || {};
    var first = (before && before.before) || null;
    if (!first || first.eventType !== nowState.eventType) {
      if (!first) first = Object.assign({}, nowState);
    }
    return {
      before: first,
      after: nowState,
      history: ((before && before.history) || []).concat([nowState]).slice(-8),
    };
  }

  /* Median publish latency we have actually seen (game timecode -> our clock),
   * for the health line.  null until a live feed publishes a timecode. */
  function feedTimecodeSeen() {
    var GS = global.GameState;
    if (!GS) return false;
    return state.games.some(function (g) {
      var snap = GS.latest(state.date, g.gamePk);
      return !!(snap && snap.gameTimecode);
    });
  }

  function latencyStats() {
    var list = state.latencies.slice().sort(function (a, b) { return a - b; });
    if (!list.length) return null;
    var mid = Math.floor(list.length / 2);
    return {
      samples: list.length,
      medianMs: list[mid],
      minMs: list[0],
      maxMs: list[list.length - 1],
    };
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
    var meta = { gamePk: game.gamePk, teams: teams, feed: result.payload };
    var matchupLabel = UI.abbr(teams.away) + ' @ ' + UI.abbr(teams.home);

    /* ---- official game state, captured to the second (separate store) */
    recordGameState(game, matchupLabel, result, plays);

    /* ---- official scoring log: handed the same plays, so it does not have to
     * poll every game again.  Guarded — it can never disturb this path. */
    if (global.ScoringLog && global.ScoringLog.ingestPlays) {
      try { global.ScoringLog.ingestPlays(state.date, game.gamePk, matchupLabel, plays); } catch (e) { /* ignore */ }
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
      var pendingEntry = {
        id: row.id,
        kind: 'pending',
        gamePk: game.gamePk,
        matchupLabel: matchupLabel,
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
      };
      var beforePending = state.entries.find(function (e) { return e.id === row.id; });
      /* Exact official wording, captured the moment the state is first seen and
       * again whenever it moves — the row keeps both, never a paraphrase. */
      pendingEntry.official = officialWording({
        before: beforePending && beforePending.official,
        state: {
          eventType: row.eventType,
          description: row.description,
          outcome: 'Pending',
          atBatIndex: row.atBatIndex,
          score: row.score,
          at: row.observedAt,
        },
      });
      var isNewPending = upsertEntry(pendingEntry);
      if (isNewPending) chime('pending');
    });

    /* ---- official scoring changes */
    var snapshot = Reviews.snapshotPlays(plays);
    var previous = state.snapshots[game.gamePk];
    var diff = Reviews.diffSnapshots(previous, snapshot);
    state.snapshots[game.gamePk] = snapshot;

    diff.changes.forEach(function (change) {
      var seenAt = gameStateSnap(game.gamePk);
      var changeEntry = {
        id: game.gamePk + ':' + change.atBatIndex + ':scoring-change',
        kind: 'scoring_change',
        gamePk: game.gamePk,
        matchupLabel: matchupLabel,
        teams: teams,
        change: change,
        official: {
          before: {
            eventType: change.from && change.from.eventType,
            description: change.from && change.from.description,
            isOut: change.from && change.from.isOut,
            outs: change.from && change.from.outs,
            score: change.from ? { away: change.from.awayScore, home: change.from.homeScore } : null,
            at: (existingOfficial(change) || {}).at || null,
          },
          after: {
            eventType: change.to && change.to.eventType,
            description: change.to && change.to.description,
            isOut: change.to && change.to.isOut,
            outs: change.to && change.to.outs,
            score: change.to ? { away: change.to.awayScore, home: change.to.homeScore } : null,
            at: seenAt,
          },
          source: 'official play-by-play: consecutive observations of result.eventType / description',
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
      };
      var isNewChange = upsertEntry(changeEntry);
      if (isNewChange) chime('scoring');
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
    state.nextScanAt = Date.now() + FULL_TIER_MS;

    MLB.slateGames(scanDate, { ttl: 1000 })
      .then(function (payload) {
        if (scanSeq !== state.dateSeq || scanDate !== state.date) return null;
        state.games = flattenGames(payload);
        var now = Date.now();

        /* Priority: a game whose official status just flipped into a review is
         * read first, then games inside their change window, then the rest. */
        var live = state.games.filter(function (g) {
          var st = (g.status && g.status.abstractGameState) || '';
          return st === 'Live' || st === 'Final';
        });
        live.sort(function (a, b) {
          return priorityOf(b, now) - priorityOf(a, now);
        });

        state.scanError = null;
        if (!live.length) {
          updateChrome();
          renderIfChanged();
          return null;
        }
        return runLimited(live, FETCH_CONCURRENCY, function (game) {
          if (scanSeq !== state.dateSeq || scanDate !== state.date) return Promise.resolve();
          return scanGame(game, Date.now(), false);
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
        /* If the gate is saturated the next scan starts later, not sooner: the
         * budget is the ceiling, and a 250 ms tick that cannot run is not a
         * reason to queue another one. */
        scheduleScan(nextScanDelay());
      });
  }

  /* How often each live game is probed.  Small slates get a fast per-game
   * cadence; a full 15-game slate spreads its probes so the tab stays inside the
   * request budget in api.js instead of saturating it.  Every game is still
   * checked at least every two seconds, and a game whose feed is moving (or
   * showing a review) is probed at the full tier. */
  function probeIntervalMs(liveCount) {
    return MLB.probeIntervalFor(liveCount, PROBE_BUDGET_PER_SEC);
  }

  function priorityOf(game, now) {
    var pk = game.gamePk;
    if (state.statusByPk[pk]) return 3;                       // official review status
    if (state.changedUntil[pk] && now < state.changedUntil[pk]) return 2;
    if ((game.status && game.status.abstractGameState) === 'Live') return 1;
    return 0;
  }

  function nextScanDelay() {
    var usage = MLB.usageStats ? MLB.usageStats() : null;
    /* Saturated gate: wait for it to drain rather than queue more work. */
    if (usage && usage.perSecond >= usage.ceiling) return SLATE_MS * 2;
    return state.games.some(function (g) { return g.status && g.status.abstractGameState === 'Live'; })
      ? SLATE_MS : Math.max(SLATE_MS, 5000);
  }

  function scheduleScan(delay) {
    clearTimeout(state.timers.scan);
    state.nextScanAt = Date.now() + delay;
    state.timers.scan = setTimeout(scan, delay);
  }

  /* Official status sweep: catches a review the moment MLB flips it.  The
   * cadence is fast on a small slate and widens as the slate (or the request
   * rate) grows, so the whole tab stays inside the budget rather than the sweep
   * eating it.  Worst case on a full slate is a few hundred ms — still far
   * faster than the 500 ms full-feed poll it replaces for review detection. */
  function sweepIntervalMs() {
    var usage = MLB.usageStats ? MLB.usageStats() : null;
    var live = state.games.filter(function (g) { return g.status && g.status.abstractGameState === 'Live'; }).length;
    var base = live <= 4 ? STATUS_SWEEP_MS : live <= 8 ? 250 : 400;
    /* A big slate is where the sweep costs the most and matters the least: 15
     * simultaneous reviews do not arrive as burst alerts, and the per-game probe
     * already carries the one signal that has to be instant. */
    if (live > 10) base = Math.max(base, 600);
    if (usage && usage.perSecond >= Math.floor(usage.ceiling * 0.7)) base *= 2;
    if (usage && usage.perSecond >= usage.ceiling) base *= 2;
    return base;
  }

  function scheduleSweep() {
    if (state.timers.sweep) clearTimeout(state.timers.sweep);
    state.timers.sweep = setTimeout(function () {
      sweep();
      if (!document.hidden) scheduleSweep();
      else state.timers.sweep = setTimeout(scheduleSweep, 2000);
    }, sweepIntervalMs());
  }

  function sweep() {
    if (document.hidden) return;
    var sweepSeq = state.dateSeq;
    var sweepDate = state.date;
    if (!state.games.some(function (g) { return g.status && g.status.abstractGameState === 'Live'; })) return;
    if (state.sweepInFlight) return;
    state.sweepInFlight = true;
    MLB.slateStatus(sweepDate).then(function (payload) {
      state.sweepInFlight = false;
      if (sweepSeq !== state.dateSeq || sweepDate !== state.date) return;
      var games = flattenGames(payload);
      games.forEach(function (g) {
        var review = Reviews.statusReview(g.status);
        var prev = state.statusByPk[g.gamePk];
        var nextKey = review ? review.code + '|' + review.reason : '';
        if (prev !== nextKey) {
          state.statusByPk[g.gamePk] = nextKey;
          if (review) {
            /* The official status flipped into a review: read this game's
             * play-by-play out of band, ahead of the running scan, so the alert
             * row appears on the same tick the status did. */
            state.changedUntil[g.gamePk] = Date.now() + CHANGED_LINGER_MS;
            fetchGame(g, true).then(function (result) {
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

  /* ------------------------------------------------------------- sound/notify */

  /* The alert sound itself lives in chime.js (a ~2.6 s rain drop, synthesised,
   * shared with the scoring log through a *separate* player).  This function is
   * the feed's gate: it owns the on/off toggle, one audible event per cooldown
   * window, and the per-kind bookkeeping `lastChimeAt` the checks rely on. */
  function chime(reason) {
    if (!state.soundOn) return;
    var now = Date.now();
    if (now - state.lastChimeAt < SOUND_COOLDOWN_MS) return;
    state.lastChimeAt = now;
    state.lastChimeReason = reason || 'review';
    state.chimes += 1;
    var Chime = global.Chime;
    if (!Chime) return;
    /* The feed's own toggle is the authority for the alert player; keep the
     * module preference in step so a preview press sounds the same voice. */
    Chime.setEnabled('alert', true);
    Chime.play('alert');
  }

  /* Explicit sound check (the button): plays the rain drop regardless of the
   * toggle, so the user can hear it, then toggle it on for the real feed. */
  function testSound() {
    var Chime = global.Chime;
    if (!Chime) {
      statusLine('This browser cannot play audio (no Web Audio API).', true);
      return false;
    }
    Chime.setEnabled('alert', true);
    var played = Chime.test('alert');
    statusLine(played
      ? '🔊 Sound check — the alert rain drop is playing (2.6 s).'
      : '🔊 Sound check — already playing (press again to stop).');
    return played;
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

  function render() {
    renderBanner();
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
      var live = state.games.filter(function (g) { return g.status && g.status.abstractGameState === 'Live'; }).length;
      statusLine(state.games.length + ' game(s) on ' + MLB.formatDateLabel(state.date) +
        ' · ' + live + ' live · ' + state.entries.length + ' tracked entr' + (state.entries.length === 1 ? 'y' : 'ies') +
        ' · scanned ' + new Date(state.lastScanAt || Date.now()).toLocaleTimeString() +
        (FeedLog.state.available ? ' · shared log connected' : ' · local log only'));
      var health = healthLine();
      if (health) statusLine(health, false);
    }
    renderLiveState();
  }

  /* The usage/latency line.  Every figure is measured in this tab: the request
   * rate the shared gate actually allowed, the ceiling it is enforcing, and the
   * median gap between MLB's published timecode and our observation of it. */
  function healthLine() {
    var usage = MLB.usageStats ? MLB.usageStats() : null;
    if (!usage) return '';
    var lat = latencyStats();
    var bits = [
      state.games.length + ' game(s) on ' + MLB.formatDateLabel(state.date),
      state.entries.length + ' tracked',
      usage.perSecond + '/' + usage.ceiling + ' req/s',
      (lat ? 'publish latency ~' + (lat.medianMs < 1000 ? lat.medianMs + 'ms' : (lat.medianMs / 1000).toFixed(1) + 's') +
        ' (n=' + lat.samples + ')'
        : (feedTimecodeSeen() ? 'publish latency n/a (feed timecode is not on this clock)'
          : 'publish latency — waiting for a timecode')),
      'probes ' + (usage.byKind.probe || 0) + ' · reads ' + (usage.byKind.playByPlay || 0) +
        ' · status ' + (usage.byKind.status || 0),
    ];
    if (usage.quietRemainingMs) bits.push('quiet period ' + Math.ceil(usage.quietRemainingMs / 1000) + 's');
    return bits.join(' · ');
  }

  /* The live game-state strip: one line per monitored game with the official
   * state and the exact clocks it was captured at. */
  function renderLiveState() {
    var host = $('live-state');
    if (!host) return;
    var GS = global.GameState;
    if (!GS) { host.innerHTML = ''; return; }
    var games = state.games.filter(function (g) {
      var st = (g.status && g.status.abstractGameState) || '';
      return st === 'Live' || st === 'Final';
    });
    if (!games.length) { host.innerHTML = ''; return; }
    var rows = games.slice(0, 20).map(function (g) {
      var snap = GS.latest(state.date, g.gamePk);
      var label = UI.abbr(teamsOf(g).away) + ' @ ' + UI.abbr(teamsOf(g).home);
      if (!snap) {
        return '<div class="ls-row"><span class="ls-game">' + UI.esc(label) + '</span>' +
          '<span class="ls-note">waiting for the first capture…</span></div>';
      }
      var half = snap.inning.half === 'top' ? 'Top' : snap.inning.half === 'bottom' ? 'Bot' : '';
      var stateBits = [
        (snap.score.away === null ? '—' : snap.score.away) + '–' + (snap.score.home === null ? '—' : snap.score.home),
        (half ? half + ' ' + (snap.inning.num || '') : ''),
        (snap.outs === null ? '' : snap.outs + ' out' + (snap.outs === 1 ? '' : 's')),
        (snap.count.balls === null ? '' : snap.count.balls + '-' + snap.count.strikes),
        (snap.batter && snap.batter.name ? snap.batter.name : ''),
        (snap.pitcher && snap.pitcher.name ? 'vs ' + snap.pitcher.name : ''),
      ].filter(Boolean).join(' · ');
      return '<div class="ls-row' + (snap.pendingRuling ? ' is-pending' : '') + '">' +
        '<span class="ls-game"><a href="game.html?gamePk=' + encodeURIComponent(g.gamePk) + '&date=' + encodeURIComponent(state.date) + '">' + UI.esc(label) + '</a>' +
          ' <span class="ls-status">' + UI.esc(snap.status.detailed || snap.status.abstract || '') + '</span></span>' +
        '<span class="ls-state">' + UI.esc(stateBits) + '</span>' +
        '<span class="ls-clock mono" title="MLB feed timecode ' + UI.esc(snap.gameTimecode || 'n/a') + '">' +
          UI.esc(snap.observedClock) +
          (snap.gameTimecode ? ' <span class="ls-tc" title="MLB feed timecode ' + UI.esc(snap.gameTimecode) + '">feed ' + UI.esc(global.GameState.timecodeClock(snap.gameTimecode)) + '</span>' : '') +
        '</span>' +
        (snap.pendingRuling ? '<span class="chip chip-warn">official scoring pending</span>' : '') +
      '</div>';
    });
    var recent = GS.recentTransitions ? GS.recentTransitions(state.date, 3) : [];
    var trail = recent.filter(function (t) { return t.changes && t.changes.length; }).map(function (t) {
      var game = state.games.find(function (g) { return g.gamePk === t.gamePk; });
      var label = game ? (UI.abbr(teamsOf(game).away) + ' @ ' + UI.abbr(teamsOf(game).home)) : ('#' + t.gamePk);
      var bits = t.changes.slice(0, 3).map(function (c) {
        return c.label + ': ' + c.fromText + ' → ' + c.toText;
      });
      return '<div class="ls-trail"><span class="mono">' + UI.esc(t.observedClock || '') + '</span> ' +
        '<b>' + UI.esc(label) + '</b> ' + UI.esc(bits.join(' · ')) +
        (t.changes.length > 3 ? ' +' + (t.changes.length - 3) + ' more' : '') + '</div>';
    });
    host.innerHTML = '<div class="live-state"><div class="live-state-head">' +
      '<h3>Live game state — captured to the second</h3>' +
      '<span class="ls-note">official score · inning · outs · count · batter · pitcher, stamped with our clock and MLB’s feed timecode</span>' +
      '</div>' + rows.join('') +
      (trail.length ? '<div class="ls-trail-head">Latest state transitions</div>' + trail.join('') : '') +
      '</div>';
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
    state.counterStatus = Object.create(null);
    state.lastGameDate = undefined;
    state.lookingForRecent = false;
    state.log = null;
    state.lastRenderSignature = '';
    syncNav();
    render();
    FeedLog.closeStream();
    state.probeSig = Object.create(null);
    state.probeAt = Object.create(null);
    state.changedUntil = Object.create(null);
    state.latencies = [];
    loadGameState(clean);
    if (global.ScoringUI) {
      try { global.ScoringUI.setDate(clean); } catch (e) { /* section is optional */ }
    }
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
    if (global.Chime) global.Chime.setEnabled('alert', state.soundOn);
    if (state.soundOn) {
      /* Toggling ON plays the rain drop once: the toggle doubles as the
       * "is the alert system working?" check the owner asked for. */
      var Chime = global.Chime;
      if (Chime) {
        var played = Chime.test('alert');
        if (played) statusLine('🔊 Alert sound on — rain drop playing (2.6 s). Sound check any time with “Test sound”.');
      }
      state.lastChimeAt = Date.now();
      state.lastChimeReason = 'preview';
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
    state.notifyOn = loadPref('notify', false);
    if (global.Chime) global.Chime.setEnabled('alert', state.soundOn);

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
    var refreshBtn = $('refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', function () { scan(); });

    /* Sound check — always plays, independent of the on/off toggle. */
    var testBtn = $('sound-test-btn');
    if (testBtn) testBtn.addEventListener('click', testSound);

    var tabs = $('feed-tabs');
    if (tabs) {
      tabs.addEventListener('click', function (evt) {
        var btn = evt.target.closest('[data-filter]');
        if (btn) setFilter(btn.getAttribute('data-filter'));
      });
    }

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        /* Back from a hidden tab: re-arm the sweep and read every live game
         * immediately, because the feed may have moved while we were paused. */
        state.changedUntil = Object.create(null);
        scheduleSweep();
        scan();
      }
    });

    Reviews.loadRegistry();

    var initSeq = state.dateSeq;
    var initDate = state.date;
    /* The state store is loaded before the first scan and restored on a
     * refresh, but it is never a dependency: a failure there leaves the feed
     * running exactly as before. */
    loadGameState(initDate);
    FeedLog.load(initDate).then(function (log) {
      if (initSeq !== state.dateSeq || state.date !== initDate) return;
      adoptLog(log);
      render();
      FeedLog.openStream(initDate);
      scan();
    });

    scheduleSweep();
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
    toggleNotify: toggleNotify,
    healthLine: healthLine,
    latencyStats: latencyStats,
    renderLiveState: renderLiveState,
    scan: scan,
    state: state,
    SCAN_MS: SCAN_MS,
    STATUS_SWEEP_MS: STATUS_SWEEP_MS,
    FETCH_CONCURRENCY: FETCH_CONCURRENCY,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}(window));
