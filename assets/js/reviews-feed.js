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
 *   - LIVE GAME STATE for every game on the slate (preview → first pitch →
 *     pitch-by-pitch → final), captured second-precision by state-tracker.js
 *
 * Latency: live games are tracked through the official delta feed — MLB's own
 * timestamps + diffPatch (RFC 6902) over the cached feed/live document — so
 * changes are detected within one 750 ms poll *without* re-downloading the
 * multi-MB feed. On any patch failure the fast path re-syncs, and after
 * MAX_FAILURES failures the game silently returns to standard playByPlay
 * polling. The slate status sweep is 500 ms. The undocumented Gameday
 * websocket is deliberately NOT used (see docs/latency-and-tos.md).
 *
 * Persistence: alert entries go through feed-log.js (localStorage + the
 * optional server store) exactly as before. Game-state rows persist through
 * state-log.js (separate namespace + /api/state-log), official-scoring
 * entries through scoring-log.js via scoring-monitor.js — so scoring/state
 * capture can never evict or corrupt the alert log.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var MLB = global.MLB;
  var UI = global.UI;
  var Reviews = global.Reviews;
  var FeedLog = global.FeedLog;
  var LiveDiff = global.LiveDiff;
  var StateTracker = global.StateTracker;
  var StateLog = global.StateLog;
  var ScoringMonitor = global.ScoringMonitor;

  /* Latency budget (see docs/latency-and-tos.md): live games are detected via
   * the diffPatch fast path at one 750 ms poll; the slate sweep re-checks
   * statuses every 500 ms. Both are far below the cost of re-fetching full
   * play-by-play at the old 250/125 ms cadence, and comfortably bounded. */
  var SCAN_MS = 750;
  var STATUS_SWEEP_MS = 500;
  var FETCH_CONCURRENCY = 6;
  var FINAL_GRACE_MS = 30 * 60 * 1000;
  var SOUND_COOLDOWN_MS = 3000;  /* the rain falls for ~3s; keep cycles non-overlapping */

  var PLAYBYPLAY_FIELDS = 'allPlays,currentPlay,about,atBatIndex,hasReview,isComplete,inning,halfInning,isTopInning,isScoringPlay,' +
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
    { id: 'state', label: '📈 Game State' },
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
    absFetchedRevCount: Object.create(null),
    diffTrackers: Object.create(null),
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

  /* ---- diffPatch fast path --------------------------------------------
   * For live games, poll the small timecode list; only when the game feed was
   * revised do we fetch the RFC 6902 delta and apply it to the cached feed in
   * memory. No changes -> no payload download at all beyond ~a few KB. Any
   * failure keeps the old base and counts against the failure budget; after
   * LiveDiff.MAX_FAILURES failures the game is polled the standard way. */
  function latestTimecode(list) {
    if (!Array.isArray(list) || !list.length) return null;
    for (var i = list.length - 1; i >= 0; i -= 1) {
      if (typeof list[i] === 'string' && list[i]) return list[i];
    }
    return null;
  }

  function diffTrack(game) {
    if (!LiveDiff) return null;
    var pk = game.gamePk;
    if (!state.diffTrackers[pk]) state.diffTrackers[pk] = LiveDiff.create(pk);
    return state.diffTrackers[pk];
  }

  /* Standard path: full projected playByPlay (+ counters feed when needed). */
  function standardFetch(game) {
    var prevCount = state.absFetchedRevCount[game.gamePk];
    var status = (game.status && game.status.abstractGameState) || '';
    var pbpPromise = MLB.playByPlay(game.gamePk, { fields: PLAYBYPLAY_FIELDS, retries: 0 });
    var countersPromise = (prevCount === undefined || status === 'Live')
      ? MLB.gameFeed(game.gamePk, { fields: COUNTERS_FIELDS, retries: 0 }).catch(function () { return null; })
      : Promise.resolve(null);
    return Promise.all([pbpPromise, countersPromise])
      .then(function (parts) {
        return { game: game, payload: parts[0], countersPayload: parts[1], via: 'playByPlay' };
      })
      .catch(function (err) {
        return { game: game, payload: null, countersPayload: null, error: err };
      });
  }

  function deltaFetch(game) {
    var tracker = diffTrack(game);
    if (!tracker || tracker.disabled) return Promise.resolve(null);
    var pk = game.gamePk;
    return MLB.gameFeedTimecodes(pk, { retries: 0 }).then(function (list) {
      var latest = latestTimecode(list);
      if (!latest) return null; /* unintelligible timecode list — fall back */

      /* Base feed missing or stale-and-empty: fetch it once. */
      if (!tracker.base) {
        return MLB.gameFeed(pk, { retries: 1 }).then(function (feed) {
          if (!LiveDiff.isFullFeed(feed)) throw new Error('full feed response not recognized');
          LiveDiff.adoptFullFeed(tracker, feed, latest);
          /* If the feed we got is older than the timecode list (a revision
           * landed while downloading), pull the delta to catch up. */
          if (tracker.timecode && latest !== tracker.timecode) {
            return MLB.gameFeedDiffPatch(pk, tracker.timecode, latest, { retries: 0 }).then(function (patchJson) {
              LiveDiff.applyPatch(tracker, patchJson, latest);
              return wrapDeltaResult(game, tracker.base);
            });
          }
          return wrapDeltaResult(game, tracker.base);
        });
      }

      /* Nothing revised since our base: reuse it. Zero payload download. */
      if (latest === tracker.timecode) {
        return wrapDeltaResult(game, tracker.base);
      }

      return MLB.gameFeedDiffPatch(pk, tracker.timecode, latest, { retries: 0 }).then(function (patchJson) {
        var applied = LiveDiff.applyPatch(tracker, patchJson, latest);
        return wrapDeltaResult(game, applied.doc);
      });
    }).catch(function (err) {
      LiveDiff.noteFailure(tracker, err);
      if (tracker.disabled) {
        noteIrregularity(pk, 'diffPatch fast path disabled for ' + pk + ' after ' + LiveDiff.MAX_FAILURES +
          ' failures (' + (tracker.disabledReason || 'patch error') + ') — using standard play-by-play polling.');
      }
      /* fall back to the standard path for this scan */
      return standardFetch(game);
    });
  }

  function wrapDeltaResult(game, payload) {
    var countersPayload = payload && payload.gameData ? { gameData: payload.gameData } : null;
    return { game: game, payload: payload, countersPayload: countersPayload, via: 'diffPatch' };
  }

  function fetchGame(game) {
    var status = (game.status && game.status.abstractGameState) || '';
    if (status === 'Live') {
      return deltaFetch(game).then(function (result) {
        if (result) return result;
        return standardFetch(game);
      });
    }
    return standardFetch(game);
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
    var meta = { gamePk: game.gamePk, teams: teams, feed: result.payload };

    /* ---- isolated capture hooks (scoring monitor + game-state timeline) */
    /* These write to SEPARATE persistence (scoring-log / state-log). They are
     * wrapped so a failure here can never disrupt the alert pipeline. */
    var captureDate = state.date;
    try {
      var earlySnapshot = Reviews.snapshotPlays(plays);
      var earlyPrevious = state.snapshots[game.gamePk];
      var earlyDiffForMonitor = Reviews.diffSnapshots(earlyPrevious, earlySnapshot);
      if (global.ScoringMonitor) {
        global.ScoringMonitor.observe({
          date: captureDate,
          gamePk: game.gamePk,
          teams: teams,
          teamsAbbr: { away: { abbr: UI.abbr(teams.away) }, home: { abbr: UI.abbr(teams.home) } },
          plays: plays,
          diff: earlyDiffForMonitor,
          pending: Reviews.pendingRulings(plays, meta),
        });
      }
    } catch (e) {
      global.console && global.console.warn && global.console.warn('[scoring-monitor] capture failed (alerts unaffected):', e);
    }
    try {
      if (global.StateTracker) {
        global.StateTracker.observe({
          date: captureDate,
          game: game,
          payload: result.payload,
          teams: teams,
          matchupLabel: matchupLabel,
        });
      }
    } catch (e) {
      global.console && global.console.warn && global.console.warn('[state-tracker] capture failed (alerts unaffected):', e);
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

      /* Alert sound fires for every event in the alert feed: challenges,
       * umpire/crew-chief reviews, boundary calls, ABS pitch challenges,
       * official-scorer pending rulings and official scoring changes. */
      if (isNew) chime('review');
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
      if (isNewPending) chime('pending');
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
    state.nextScanAt = Date.now() + SCAN_MS;

    MLB.schedule(scanDate, { ttl: 0, retries: 0 })
      .then(function (payload) {
        if (scanSeq !== state.dateSeq || scanDate !== state.date) return null;
        state.games = flattenGames(payload);
        var onSlate = Object.create(null);
        state.games.forEach(function (g) { onSlate[g.gamePk] = true; });
        Object.keys(state.diffTrackers).forEach(function (pk) {
          if (!onSlate[pk]) delete state.diffTrackers[pk];
        });
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

  /* 125 ms official status sweep: catches a review the moment MLB flips it. */
  function sweep() {
    if (document.hidden) return;
    var sweepSeq = state.dateSeq;
    var sweepDate = state.date;
    if (!state.games.some(function (g) { return g.status && g.status.abstractGameState === 'Live'; })) return;
    MLB.slateStatus(sweepDate).then(function (payload) {
      if (sweepSeq !== state.dateSeq || sweepDate !== state.date) return;
      var games = flattenGames(payload);
      games.forEach(function (g) {
        var review = Reviews.statusReview(g.status);
        var prev = state.statusByPk[g.gamePk];
        var nextKey = review ? review.code + '|' + review.reason : '';
        if (prev !== nextKey) {
          state.statusByPk[g.gamePk] = nextKey;
          if (review) {
            /* Out-of-band fetch: don't wait for the current scan to finish. */
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
    }).catch(function () { /* the scan owns error reporting */ });
  }

  /* ------------------------------------------------------------- sound/notify */

  var audioCtx = null;
  var noiseBuffer = null;

  function getNoiseBuffer() {
    if (!audioCtx) return null;
    if (noiseBuffer && noiseBuffer.sampleRate === audioCtx.sampleRate) return noiseBuffer;
    var len = Math.floor(audioCtx.sampleRate * 1);
    var buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    var data = buf.getChannelData(0);
    var seed = 22222; /* deterministic — the same pleasant rain every time */
    for (var i = 0; i < len; i += 1) {
      seed = (seed * 16807) % 2147483647;
      data[i] = ((seed / 2147483647) * 2 - 1) * 0.5;
    }
    noiseBuffer = buf;
    return buf;
  }

  /* ~3 seconds of gentle rain: a soft filtered-noise patter under a handful of
   * soft pentatonic "raindrop" plinks with a long, warm feedback delay —
   * pleasant enough to hear all season. Toggle the sound button to test. */
  var RAIN_DROPS = [
    /* [offsetSeconds, frequencyHz] — hand-placed over a C-major pentatonic,
     * resolving back to a low warm root. */
    [0.16, 1318.51], [0.36, 1046.50], [0.55, 1567.98], [0.73, 880.00],
    [0.90, 1174.66], [1.08, 783.99], [1.24, 1760.00], [1.42, 1046.50],
    [1.60, 1318.51], [1.80, 659.25], [2.02, 1567.98], [2.26, 880.00],
    [2.52, 523.25],
  ];

  function chime(reason) {
    if (!state.soundOn) return;
    var now = Date.now();
    if (now - state.lastChimeAt < SOUND_COOLDOWN_MS) return;
    state.lastChimeAt = now;
    try {
      var Ctx = global.AudioContext || global.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === 'suspended' && audioCtx.resume) audioCtx.resume();
      var t0 = audioCtx.currentTime + 0.03;
      var END = 2.9;

      var master = audioCtx.createGain();
      master.gain.setValueAtTime(0.0001, t0);
      master.gain.exponentialRampToValueAtTime(0.24, t0 + 0.18);
      master.gain.setValueAtTime(0.24, t0 + 2.25);
      master.gain.exponentialRampToValueAtTime(0.0001, t0 + END + 0.1);
      master.connect(audioCtx.destination);

      /* Long feedback delay — a soft "open porch" under the drops. */
      var echo = audioCtx.createDelay(0.8);
      echo.delayTime.setValueAtTime(0.32, t0);
      var echoSend = audioCtx.createGain(); echoSend.gain.value = 0.5;
      var echoGain = audioCtx.createGain(); echoGain.gain.value = 0.3;
      var echoFb = audioCtx.createGain(); echoFb.gain.value = 0.38;
      echoSend.connect(echo);
      echo.connect(echoGain);
      echoGain.connect(echoFb);
      echoFb.connect(echo);
      echoGain.connect(master);

      /* Rain bed: looped noise through a wandering lowpass. */
      var noise = getNoiseBuffer();
      if (noise) {
        var bed = audioCtx.createBufferSource();
        bed.buffer = noise;
        bed.loop = true;
        var bedFilter = audioCtx.createBiquadFilter();
        bedFilter.type = 'lowpass';
        bedFilter.Q.value = 0.6;
        bedFilter.frequency.setValueAtTime(900, t0);
        bedFilter.frequency.exponentialRampToValueAtTime(1500, t0 + 1.2);
        bedFilter.frequency.exponentialRampToValueAtTime(700, t0 + END);
        var bedGain = audioCtx.createGain();
        bedGain.gain.setValueAtTime(0.0001, t0);
        bedGain.gain.exponentialRampToValueAtTime(0.055, t0 + 0.3);
        bedGain.gain.setValueAtTime(0.055, t0 + 2.1);
        bedGain.gain.exponentialRampToValueAtTime(0.0001, t0 + END);
        bed.connect(bedFilter);
        bedFilter.connect(bedGain);
        bedGain.connect(master);
        bed.start(t0);
        bed.stop(t0 + END + 0.05);
      }

      /* The drops. */
      RAIN_DROPS.forEach(function (pair) {
        var at = t0 + pair[0];
        var freq = pair[1];
        var dur = freq < 700 ? 0.85 : 0.5;
        var osc = audioCtx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, at);
        osc.frequency.exponentialRampToValueAtTime(freq * 0.985, at + dur);
        /* second, quieter partial an octave up — the "plink" */
        var partial = audioCtx.createOscillator();
        partial.type = 'sine';
        partial.frequency.setValueAtTime(freq * 2, at);
        var partialGain = audioCtx.createGain();
        partialGain.gain.setValueAtTime(0.0001, at);
        partialGain.gain.exponentialRampToValueAtTime(0.12, at + 0.015);
        partialGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
        var gain = audioCtx.createGain();
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.4, at + 0.018);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
        osc.connect(gain);
        partial.connect(partialGain);
        gain.connect(master);
        partialGain.connect(master);
        gain.connect(echoSend);
        osc.start(at);
        osc.stop(at + dur + 0.05);
        partial.start(at);
        partial.stop(at + 0.25);
      });

      /* One low warm tap to close the phrase. */
      var closeAt = t0 + 2.62;
      var root = audioCtx.createOscillator();
      root.type = 'sine';
      root.frequency.setValueAtTime(392.0, closeAt); /* G4 */
      var rootGain = audioCtx.createGain();
      rootGain.gain.setValueAtTime(0.0001, closeAt);
      rootGain.gain.exponentialRampToValueAtTime(0.3, closeAt + 0.02);
      rootGain.gain.exponentialRampToValueAtTime(0.0001, closeAt + 0.35);
      root.connect(rootGain);
      rootGain.connect(master);
      rootGain.connect(echoSend);
      root.start(closeAt);
      root.stop(closeAt + 0.4);
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
    if (filter === 'all') {
      /* state rows join the All view, except pitch-by-pitch rows (those live
       * under Game State — they would swamp the alert feed). */
      if (entry.kind === 'game_state') return entry.subtype !== 'pitch';
      return (entry.kind === 'review' || entry.kind === 'pending' || entry.kind === 'scoring_change') && !(entry.review && entry.review.isABS);
    }
    if (filter === 'state') return entry.kind === 'game_state';
    if (filter === 'abs') return entry.review && entry.review.isABS;
    if (filter === 'challenges') return entry.review && entry.review.family === 'manager';
    if (filter === 'reviews') return entry.review && (entry.review.family === 'umpire' || entry.review.family === 'replay');
    if (filter === 'boundary') return entry.review && entry.review.isBoundary;
    if (filter === 'under') return entry.review && entry.review.inProgress;
    if (filter === 'risk') return entry.review && entry.review.runsAtRiskCount > 0;
    if (filter === 'scoring') return entry.kind === 'scoring_change';
    return true;
  }

  function mergedEntries() {
    var alerts = state.entries;
    if (!StateTracker) return alerts.slice();
    return alerts.concat(StateTracker.all());
  }

  function visibleEntries() {
    var rows = mergedEntries().filter(function (e) { return entryMatches(e, state.filter); })
      .sort(function (a, b) { return (b.lastSeen || 0) - (a.lastSeen || 0); });
    /* Pitch-level rows are voluminous; render at most the newest 150. */
    if (state.filter === 'state') return rows.slice(0, 150);
    return rows;
  }

  function statsFor() {
    var s = { total: 0, manager: 0, umpire: 0, abs: 0, boundary: 0, under: 0, risk: 0, scoring: 0, state: 0 };
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
    if (StateTracker) {
      var bySubtype = StateTracker.countBySubtype();
      s.state = Object.keys(bySubtype).reduce(function (n, k) { return n + bySubtype[k]; }, 0);
    }
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
      { n: s.state, label: 'State events', cls: '' },
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

  var STATE_LABELS = {
    preview: 'Preview',
    game_start: 'First pitch',
    pitch: 'Pitch',
    pitcher_change: 'Pitching change',
    score_change: 'Score change',
    game_final: 'Final',
  };
  var STATE_AVATARS = {
    preview: '🗓️',
    game_start: '🟢',
    pitch: '⚾',
    pitcher_change: '🔄',
    score_change: '📈',
    game_final: '🏁',
  };

  function stateTime(entry) {
    return UI.formatTimestampSeconds ? UI.formatTimestampSeconds(entry.ts || entry.lastSeen) : new Date(entry.ts || Date.now()).toLocaleTimeString();
  }

  function renderStateRow(entry) {
    var sub = entry.subtype;
    var avatar = STATE_AVATARS[sub] || '📈';
    var chips = [];
    chips.push(UI.chip(STATE_LABELS[sub] || sub, sub === 'game_final' ? 'chip-ok' : sub === 'score_change' ? 'chip-scoring' : 'chip-review'));
    if (sub === 'pitch' && entry.count) chips.push(UI.chip('Count ' + entry.count, 'chip-review'));
    if (sub === 'pitch' && typeof entry.outs === 'number') chips.push(UI.chip(entry.outs + ' out' + (entry.outs === 1 ? '' : 's'), 'chip-review'));
    if (sub === 'score_change' && entry.before && entry.after) {
      chips.push(UI.chip(entry.before.away + '–' + entry.before.home + ' → ' + entry.after.away + '–' + entry.after.home, 'chip-scoring'));
    }

    var trackHtml = '';
    if (sub === 'score_change' && entry.before && entry.after) {
      trackHtml = '<dl class="score-track">' +
        scoreLine('Before play', entry.before) +
        scoreLine('After play', entry.after) +
        '</dl>';
    } else if (sub === 'game_final' && entry.after) {
      trackHtml = '<dl class="score-track">' + scoreLine('Final', entry.after) + '</dl>';
    } else if (sub === 'pitcher_change' && entry.before && entry.after) {
      trackHtml = '<div class="feed-sub">Before: ' + UI.esc(entry.before.pitcher || '') + '</div>' +
        '<div class="feed-sub">After: ' + UI.esc(entry.after.pitcher || '') + '</div>';
    }

    return '<div class="feed-row game-state-row" data-subtype="' + UI.esc(sub) + '">' +
      '<div class="feed-avatar">' + avatar + '</div>' +
      '<div class="feed-body">' +
        '<div class="feed-top">' +
          '<a href="game.html?gamePk=' + encodeURIComponent(entry.gamePk) + '&date=' + encodeURIComponent(state.date) + '"><b>' + UI.esc(entry.matchupLabel || '') + '</b></a>' +
          (entry.inningLabel ? '<span>' + UI.esc(entry.inningLabel) + '</span>' : '') +
          '<span title="Captured to the second">' + UI.esc(stateTime(entry)) + '</span>' +
          '<a href="https://statsapi.mlb.com/api/v1/game/' + encodeURIComponent(entry.gamePk) + '/playByPlay" target="_blank" rel="noopener" title="Official MLB StatsAPI play-by-play source">MLB API ↗</a>' +
        '</div>' +
        '<div class="feed-title">' + UI.esc((entry.batter || '') + (entry.pitcher ? ' vs ' + entry.pitcher : '')) + '</div>' +
        (entry.description ? '<div class="feed-sub">' + UI.esc(entry.description) + '</div>' : '') +
        trackHtml +
        '<div class="feed-chips">' + chips.join('') + '</div>' +
      '</div>' +
    '</div>';
  }

  function renderRow(entry) {
    if (entry.kind === 'game_state') return renderStateRow(entry);
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
          '<span title="Captured to the second">' + UI.esc(UI.formatTimestampSeconds ? UI.formatTimestampSeconds(entry.lastSeen || Date.now()) : new Date(entry.lastSeen || Date.now()).toLocaleTimeString()) + '</span>' +
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

  function stateSignature() {
    if (!StateTracker) return '0:0';
    var rows = StateTracker.all();
    var last = 0;
    for (var i = 0; i < rows.length; i += 1) { last = Math.max(last, Number(rows[i].lastSeen) || 0); }
    return rows.length + ':' + last;
  }

  function entriesSignature() {
    return state.filter + '|' + state.games.length + '|' + (state.lastGameDate || '') + '|st:' + stateSignature() + '|' + state.entries.map(function (e) {
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
      var fastPath = 0;
      Object.keys(state.diffTrackers).forEach(function (pk) {
        if (!state.diffTrackers[pk].disabled) fastPath += 1;
      });
      statusLine(state.games.length + ' game(s) on ' + MLB.formatDateLabel(state.date) +
        ' · ' + live + ' live · ' + state.entries.length + ' tracked entr' + (state.entries.length === 1 ? 'y' : 'ies') +
        ' · scanned ' + new Date(state.lastScanAt || Date.now()).toLocaleTimeString() +
        (fastPath ? ' · Δ-feed fast path on ' + fastPath + ' game(s)' : '') +
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
    state.counterCache = Object.create(null);
    state.absFetchedRevCount = Object.create(null);
    state.diffTrackers = Object.create(null);
    if (ScoringMonitor) ScoringMonitor.beginDate(clean);
    if (StateTracker) StateTracker.beginDate(clean);
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
    if (StateLog && StateTracker) {
      StateLog.load(clean).then(function (payload) {
        if (seq !== state.dateSeq || state.date !== clean) return;
        StateTracker.adopt(payload);
        renderIfChanged();
      });
    }
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

    if (ScoringMonitor) ScoringMonitor.beginDate(state.date);
    if (StateTracker) StateTracker.beginDate(state.date);
    var initSeq = state.dateSeq;
    var initDate = state.date;
    FeedLog.load(initDate).then(function (log) {
      if (initSeq !== state.dateSeq || state.date !== initDate) return;
      adoptLog(log);
      render();
      FeedLog.openStream(initDate);
      scan();
    });
    if (StateLog && StateTracker) {
      StateLog.load(initDate).then(function (payload) {
        if (initSeq !== state.dateSeq || state.date !== initDate) return;
        StateTracker.adopt(payload);
        renderIfChanged();
      });
    }

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
    toggleNotify: toggleNotify,
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
