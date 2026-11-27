/* ============================================================================
 * reviews-feed.js — the all-games Replay Feed (reviews.html)
 *
 * Scans every game on the slate and renders a live, chat-style feed:
 *   - manager challenges (M*), umpire/crew-chief reviews (N*), instant replay
 *     (IH), boundary calls (umpire-side home run / fair-foul / stadium-boundary
 *     reviews; charged manager challenges of those plays stay challenges)
 *   - ABS pitch challenges (MJ/NJ) with count before/after
 *   - official-scorer pending rulings (os_ruling_pending_*)
 *   - official scoring changes, detected by diffing each completed play's
 *     classification between polls
 *   - the official live game state, play by play: every at-bat start, pitch,
 *     count, runner, out, run, pitching change and challenge counter change,
 *     captured with MLB's own revision timecode and our observation time
 *
 * LATENCY MODEL (details: docs/latency.md, assets/js/latency.js)
 *   The feed no longer re-downloads every live game's full play-by-play four
 *   times a second.  It runs two tiers:
 *     1. STAMP POLL — `feedMeta()` returns the feed's own revision stamp
 *        (`metaData.timeStamp`) plus the official status, a few hundred bytes.
 *        Polled at the fastest cadence the shared request budget allows
 *        (10 meta polls/s across the whole slate, 500 ms for one game; review
 *        games get double share).  A changed stamp means new official data.
 *     2. CONFIRM — only when the stamp moved (or a safety re-read is due) does
 *        it fetch the structured official state, then the full playByPlay.
 *        The state diff produces timestamped before/after rows for the state
 *        log and the feed.
 *   Net effect: a landed event is seen on the next tick (≤1.5 s on a full
 *   slate, 500 ms for a single game) instead of after a multi-hundred-KB
 *   download, while total traffic to statsapi.mlb.com drops sharply.  Both are
 *   required by MLBAM's "individual, non-commercial, non-bulk use" notice.
 *
 * TWO SEPARATE PIPELINES (do not feed one from the other)
 *   · ALERT path  — chime() / notifyRunAtRisk() driven by the review entries.
 *   · STATE path  — StateLog (state-log.js) records official state changes.
 *   They share this poll loop but nothing else: the state log never chimes,
 *   and an alert never depends on a state-log write succeeding.
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
  var Latency = global.Latency;
  var StateLog = global.StateLog;
  var AlertSound = global.AlertSound;

  /* Scheduler granularity.  The per-game wait comes from Latency.pace() below,
   * which spreads the meta budget across the live slate. */
  var TICK_MS = Latency ? Latency.TICK_MS : 150;
  var STATUS_SWEEP_MS = 5000;      /* schedule-level status safety net       */
  var FETCH_CONCURRENCY = 6;
  var FINAL_GRACE_MS = 30 * 60 * 1000;
  var SOUND_COOLDOWN_MS = AlertSound ? AlertSound.COOLDOWN_MS : 3200;
  /* The old constants are still exported for the test harness and for anyone
   * tuning the cadence: SCAN_MS is the fastest a live game can be re-read. */
  var SCAN_MS = Latency ? Latency.META_MIN_MS : 500;
  var STATUS_SWEEP_LEGACY_MS = 125;

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
    scanQueued: null,
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

    /* ---- latency engine ---- */
    /* Per-game poll bookkeeping, keyed by gamePk:
     *   { stamp, dueAt, inflight, lastParseAt, state, pitchCounts, pitchCountAt,
     *     lastStampChangeAt, lastError, metaPolls, parses, staleStamps,
     *     pendingCycle, intervalMs } */
    feed: Object.create(null),
    /* Rolling latency instrumentation (shown in the HUD + Status line). */
    latency: {
      metaPolls: 0,
      metaErrors: 0,
      parses: 0,
      stampChanges: 0,
      stateEvents: 0,
      lastStampAt: 0,
      lastParseAt: 0,
      lastDetectMs: null,
      budgetDenied: 0,
      liveCount: 0,
      reviewCount: 0,
      intervalMs: SCAN_MS,
      parseErrors: 0,
    },
    /* Official live state log (separate section, separate persistence). */
    stateLog: null,
    stateEvents: [],
    stateDirty: false,
    liveStripOpen: true,
    scoringSectionOpen: true,
    scoringFilter: 'all',
    eventSoundOn: true,
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
        abbreviation: (game.teams && game.teams.away && game.teams.away.team &&
          game.teams.away.team.abbreviation) || '',
      },
      home: {
        id: game.teams && game.teams.home && game.teams.home.team ? game.teams.home.team.id : null,
        name: game.teams && game.teams.home && game.teams.home.team ? game.teams.home.team.name : '',
        abbreviation: (game.teams && game.teams.home && game.teams.home.team &&
          game.teams.home.team.abbreviation) || '',
      },
    };
  }

  function matchupOf(game) {
    var t = teamsOf(game);
    return UI.abbr(t.away) + ' @ ' + UI.abbr(t.home);
  }

  function gameStatus(game) {
    return (game.status && game.status.abstractGameState) || '';
  }

  function isLiveGame(game) {
    return gameStatus(game) === 'Live';
  }

  function liveGames() {
    return state.games.filter(isLiveGame);
  }

  /* A game that is officially under review (an M- or N-family status code,
   * or IH, or a live reviewDetails block) gets a double share of the meta
   * budget, because a challenge is the event the feed must surface first. */
  function isReviewGame(game) {
    if (!game || !game.status) return false;
    var code = String(game.status.statusCode || '').toUpperCase();
    if (/^[MN]/.test(code) || code === 'IH') return true;
    var rec = state.feed[game.gamePk];
    return !!(rec && rec.state && rec.state.review && rec.state.review.inProgress);
  }

  function finalGraceDelay(finalFirstSeen, elapsed) {
    if (elapsed < 2 * 60 * 1000) return Latency.FINAL_MS;
    if (elapsed < 5 * 60 * 1000) return 2500;
    return 15000;
  }

  /* --------------------------------------------------------- pacing / feed */

  function feedRec(gamePk) {
    var rec = state.feed[gamePk];
    if (!rec) {
      rec = {
        stamp: null,
        dueAt: 0,
        inflight: false,
        parsing: false,
        lastParseAt: 0,
        state: null,
        pitchCounts: null,
        pitchCountAt: 0,
        lastStampChangeAt: 0,
        lastError: null,
        metaPolls: 0,
        parses: 0,
        staleStamps: 0,
        intervalMs: SCAN_MS,
        pendingCycle: false,
      };
      state.feed[gamePk] = rec;
    }
    return rec;
  }

  /* Refresh the shared pacing: one interval for every live game, tightest for
   * review games.  Called at the top of each scan so a slate that grows or
   * shrinks redistributes the budget instead of hammering. */
  function refreshPacing() {
    var live = liveGames();
    var reviews = state.games.filter(isReviewGame).length;
    state.latency.liveCount = live.length;
    state.latency.reviewCount = reviews;
    state.latency.intervalMs = Latency.metaIntervalMs(live.length, reviews);
    return state.latency.intervalMs;
  }

  function shouldMeta(game, now) {
    var rec = feedRec(game.gamePk);
    var status = gameStatus(game);
    if (status === 'Live') {
      rec.intervalMs = isReviewGame(game)
        ? Math.max(Latency.META_MIN_MS, Math.round(state.latency.intervalMs * 0.5))
        : state.latency.intervalMs;
      return now >= rec.dueAt;
    }
    if (status === 'Final') {
      if (!state.finalSeen[game.gamePk]) state.finalSeen[game.gamePk] = now;
      var elapsed = now - state.finalSeen[game.gamePk];
      if (elapsed > FINAL_GRACE_MS) return false;
      rec.intervalMs = finalGraceDelay(state.finalSeen[game.gamePk], elapsed);
      return now >= rec.dueAt;
    }
    /* Preview: read once so lineups/state are captured, then idle. */
    rec.intervalMs = Latency.PREVIEW_MS;
    return rec.state === null;
  }

  /**
   * pollGame(game) -> Promise
   *   Tier 1 of the engine: one tiny meta request.  When the official revision
   *   stamp changes, tier 2 runs (refreshState → ingestState → parseGame).
   *   Nothing here decides what chimes; ingestGame/ingestState do.
   */
  function pollGame(game) {
    var rec = feedRec(game.gamePk);
    if (rec.inflight) return Promise.resolve();
    /* Read the flag BEFORE clearing it: `forced` records that this tick was
     * asked for (refresh / tab focus / first read / no-stamp game), so the
     * confirm read below runs even if the stamp happens to be unchanged. */
    var forced = rec.pendingCycle === true;
    rec.inflight = true;
    rec.pendingCycle = false;
    var started = Date.now();
    state.latency.metaPolls += 1;
    rec.metaPolls += 1;

    return MLB.feedMeta(game.gamePk)
      .then(function (payload) {
        rec.lastError = null;
        var meta = (payload && payload.metaData) || {};
        var stamp = String(meta.timeStamp || '');
        var isLive = isLiveGame(game);
        if (!stamp) {
          /* No revision stamp published for this game (some pre-game and older
           * documents): there is nothing cheap to diff, so the parse itself is
           * the change detector for that game — exactly the previous behaviour,
           * but only for games that publish no stamp.  Live 2026 games all
           * publish one (verified 2026-11-27). */
          rec.staleStamps += 1;
          rec.pendingCycle = true;
          return null;
        }
        if (stamp !== rec.stamp) {
          var previous = rec.stamp;
          rec.stamp = stamp;
          rec.lastStampChangeAt = Date.now();
          state.latency.stampChanges += 1;
          state.latency.lastStampAt = Date.now();
          rec.pendingCycle = true;
          if (previous !== null && isLive) {
            state.latency.lastDetectMs = Date.now() - started;
          }
        } else if (isLive && Date.now() - rec.lastParseAt > Latency.SAFETY_PARSE_MS) {
          /* Safety net: the stamp is unchanged but it has been a long time since
           * the last full read.  Re-read once in a while so a missed revision
           * (or a game whose feed re-publishes without a new stamp) still gets
           * captured.  Cheap: once per 15 s per game. */
          rec.pendingCycle = true;
        }
        return null;
      })
      .catch(function (err) {
        rec.lastError = err;
        state.latency.metaErrors += 1;
        if (err && err.budget) state.latency.budgetDenied += 1;
        if (forced) rec.pendingCycle = true;
        return null;
      })
      .then(function () {
        rec.inflight = false;
        if (rec.pendingCycle || forced) {
          rec.pendingCycle = false;
          return confirmGame(game);
        }
        return null;
      })
      .then(function () {
        rec.dueAt = Date.now() + rec.intervalMs;
      });
  }

  /**
   * confirmGame(game) -> Promise
   *   Tier 2: structured official state (small projection) → state log events
   *   → playByPlay parse (reviews, pending rulings, scoring changes).
   *   Runs only when the stamp actually moved (or the safety re-read fired).
   */
  function confirmGame(game) {
    var rec = feedRec(game.gamePk);
    rec.pendingCycle = false;
    rec.lastParseAt = Date.now();

    var pitchDue = !rec.pitchCounts || (Date.now() - rec.pitchCountAt) > Latency.PITCH_COUNT_MS;
    var snapshotPromise = MLB.feedSnapshot(game.gamePk).catch(function (err) {
      rec.lastError = err;
      return null;
    });
    var pitchPromise = pitchDue
      ? MLB.boxscorePitchCounts(game.gamePk).catch(function () { return null; })
      : Promise.resolve(null);

    return Promise.all([snapshotPromise, pitchPromise])
      .then(function (parts) {
        var snapshot = parts[0] || null;
        var box = parts[1] || null;
        if (!snapshot) {
          /* The structured read failed (network, or the governor denied it
           * because the burst was spent on a 15-game slate).  Recording the
           * absence as "the official state" would invent nulls and produce
           * bogus before/after rows, so the capture is skipped and the game is
           * re-queued for the next tick instead. */
          rec.pendingCycle = true;
          rec.lastError = rec.lastError || new Error('structured read unavailable');
          state.latency.skippedReads = (state.latency.skippedReads || 0) + 1;
          return null;
        }
        if (box) {
          rec.pitchCounts = box;
          rec.pitchCountAt = Date.now();
        }
        var provisional = Latency.readState(snapshot, {
          gamePk: game.gamePk,
          teams: teamsOf(game),
          pitchCounts: rec.pitchCounts
            ? Latency.readPitchCounts(rec.pitchCounts, { pitcher: null, half: '' })
            : null,
        });
        if (rec.pitchCounts) {
          provisional.pitchCounts = null;
          var pc = Latency.readPitchCounts(rec.pitchCounts, provisional);
          provisional.pitchCounts = pc;
          provisional.pitchCount = pc
            ? (provisional.half === 'top' ? pc.home : pc.away)
            : null;
        }
        var before = rec.state;
        rec.state = provisional;
        state.latency.lastParseAt = Date.now();
        /* A projection with no revision and no status is not an observation. */
        if (provisional.timecode || provisional.statusCode) {
          ingestState(game, before, provisional);
        }
        /* Hand BOTH shapes to the parser: the raw projection (its
         * `gameData.review` / `gameData.absChallenges` blocks are what
         * Reviews.managerCounters/absCounters read) and the normalized state
         * (used when the raw blocks are absent). */
        return { raw: snapshot, state: provisional };
      })
      .catch(function (err) {
        rec.lastError = err;
        state.latency.parseErrors += 1;
        return null;
      })
      .then(function (ctx) {
        return parseGame(game, ctx && { raw: ctx.raw, state: ctx.state });
      });
  }

  /**
   * parseGame(game) -> Promise
   *   The review/scoring parser, unchanged in what it reads, run only when the
   *   official stamp moved.  This is where review rows, pending rulings and
   *   scoring-change rows (and their chimes) are produced.
   */
  function parseGame(game, ctx) {
    var rec = feedRec(game.gamePk);
    if (rec.parsing) return Promise.resolve();
    rec.parsing = true;
    rec.parses += 1;
    state.latency.parses += 1;
    var payloadPromise = MLB.playByPlay(game.gamePk, { fields: PLAYBYPLAY_FIELDS, retries: 0 });
    return payloadPromise
      .then(function (payload) {
        /* `countersPayload` is the structured snapshot from tier 2: it carries
         * the official manager/ABS challenge counters even when the
         * play-by-play document does not.  The parser falls back to the
         * play-by-play's own gameData.review when it is absent. */
        ingestGame({
          game: game,
          payload: payload,
          countersPayload: (ctx && ctx.raw) || null,
          countersState: (ctx && ctx.state) || null,
        });
        rec.lastError = null;
      })
      .catch(function (err) {
        rec.lastError = err;
        if (!(err && err.quiet)) state.scanError = err;
        state.latency.parseErrors += 1;
      })
      .then(function () {
        rec.parsing = false;
        persist();
        renderIfChanged();
        updateChrome();
      });
  }

  /**
   * ingestState(game, before, after)
   *   THE STATE PATH.  Builds timestamped before/after events and appends them
   *   to the separate StateLog.  It never calls chime(): the alert path is
   *   driven from ingestGame below, so a state-log problem cannot silence an
   *   alert (and vice versa).
   */
  function ingestState(game, before, after) {
    if (!after || !StateLog) return;
    if (!after.timecode && !after.statusCode && !after.inning) return;
    var teams = teamsOf(game);
    var matchup = UI.abbr(teams.away) + ' @ ' + UI.abbr(teams.home);
    var events = Latency.buildEvents(game.gamePk, before, after, teams, matchup);
    if (!events.length) {
      /* No diff (first read produced the initial row, or nothing changed but
       * the box score did): still keep the latest official snapshot + at-bat
       * row so the state log always reflects the current game. */
      state.stateDirty = true;
      if (before) return;
    }
    if (!state.stateLog) state.stateLog = StateLog.emptyPayload(state.date);
    var existing = Object.create(null);
    state.stateEvents.forEach(function (e) { if (e && e.id) existing[e.id] = true; });
    var added = 0;
    events.forEach(function (ev) {
      ev.officialDate = state.date;
      if (existing[ev.id]) return;
      state.stateEvents.push(ev);
      added += 1;
    });
    state.latency.stateEvents += added;
    state.stateEvents = state.stateEvents.slice(-StateLog.EVENT_CAP);
    state.stateLog.events = state.stateEvents.slice();
    state.stateLog.snapshots = state.stateLog.snapshots || {};
    state.stateLog.snapshots[game.gamePk] = snapshotForLog(after);
    recordAtBat(after, teams, matchup);
    state.stateDirty = true;
    StateLog.save(state.date, state.stateLog);
  }

  function snapshotForLog(st) {
    return {
      timecode: st.timecode,
      lineScore: st.lineScore,
      playerLines: st.pitchCounts && st.pitchCounts.lines ? st.pitchCounts.lines : null,
      observedAt: Latency.isoNow(st.observedAt),
      statusCode: st.statusCode,
      detailedState: st.detailedState,
      inning: st.inning,
      half: st.half,
      outs: st.outs,
      count: Latency.countLabel(st),
      score: Latency.scoreLabel(st),
      batter: st.batter.name,
      pitcher: st.pitcher.name,
      runners: Latency.runnersLabel(st),
      review: st.review,
      counters: Latency.challengeSummary(st),
      pitchCount: st.pitchCount,
    };
  }

  /* One row per plate appearance, updated in place: what the at-bat looked
   * like when it was observed, for the "official scoring pending / changed"
   * review section. */
  function recordAtBat(st, teams, matchup) {
    if (!st || !st.atBat || st.atBat.index === null) return;
    var key = String(st.gamePk) + ':' + st.atBat.index;
    var row = {
      key: key,
      gamePk: st.gamePk,
      matchupLabel: matchup,
      atBatIndex: st.atBat.index,
      inning: Latency.inningLabel(st),
      batter: st.batter.name,
      pitcher: st.pitcher.name,
      complete: st.atBat.complete,
      eventType: st.atBat.eventType,
      description: st.atBat.description,
      rbi: st.atBat.rbi,
      score: Latency.scoreLabel(st),
      count: Latency.countLabel(st),
      outs: st.outs,
      timecode: st.timecode,
      observedAt: Latency.isoNow(st.observedAt),
      firstObservedAt: null,
    };
    var idx = -1;
    var rows = state.stateLog && state.stateLog.atBats ? state.stateLog.atBats : [];
    for (var j = 0; j < rows.length; j += 1) {
      if (rows[j] && rows[j].key === key) { idx = j; break; }
    }
    if (!state.stateLog) state.stateLog = StateLog.emptyPayload(state.date);
    if (!Array.isArray(state.stateLog.atBats)) state.stateLog.atBats = [];
    if (idx === -1) {
      row.firstObservedAt = row.observedAt;
      state.stateLog.atBats.push(row);
    } else {
      var prev = state.stateLog.atBats[idx];
      state.stateLog.atBats[idx] = Object.assign({}, prev, row, {
        firstObservedAt: prev.firstObservedAt || row.observedAt,
      });
    }
    if (state.stateLog.atBats.length > StateLog.EVENT_CAP) {
      state.stateLog.atBats = state.stateLog.atBats.slice(-StateLog.EVENT_CAP);
    }
  }

  /* The state-log event list the feed renders (newest first). */
  function visibleStateEvents() {
    var rows = state.stateEvents.slice().reverse();
    return rows;
  }

  /* ------------------------------------------------------------ review ingest */

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

  function ingestGame(result) {
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
        timecode: (feedRec(game.gamePk).stamp) || '',
      };

      var isNew = upsertEntry(entry);
      /* Always operate on the stored entry: upsertEntry merges into the
       * existing object, so flags like `warned` live there. */
      entry = state.entries.find(function (e) { return e.id === entry.id; }) || entry;

      /* Uploaded reviews.html button title (aef1a74c L39): "a gentle raindrop
       * chime for new challenges/reviews/boundary calls, official-scorer
       * pending rulings and official scoring changes (not ABS), and the same
       * chime whenever an active review could remove a run already on the
       * scoreboard".  ABS pitch challenges are tracked but never chime. */
      if (isNew && !review.isABS) chime('review');
      if (review.runsAtRiskCount > 0 && !entry.warned) {
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
      if (isNewPending) {
        chime('pending');
        logScoringRow({
          kind: 'scoring_pending',
          gamePk: game.gamePk,
          matchupLabel: UI.abbr(teams.away) + ' @ ' + UI.abbr(teams.home),
          label: 'Official scorer ruling pending: ' + (row.description || ''),
          before: row.description || '',
          after: 'Pending',
          inning: row.inningLabel,
          batter: row.batter,
          pitcher: row.pitcher,
          atBatIndex: row.atBatIndex,
          eventType: row.eventType,
          source: row.source,
        });
      }
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
      if (isNewChange) {
        chime('scoring');
        logScoringRow({
          kind: 'scoring_change',
          gamePk: game.gamePk,
          matchupLabel: UI.abbr(teams.away) + ' @ ' + UI.abbr(teams.home),
          label: 'Official scoring change: ' + (change.from.eventType || '—') + ' → ' + (change.to.eventType || '—'),
          before: change.from.description || '',
          after: change.to.description || '',
          beforeEventType: change.from.eventType || '',
          afterEventType: change.to.eventType || '',
          inning: change.inningLabel,
          batter: change.batter,
          atBatIndex: change.atBatIndex,
          scoreAfter: change.scoreAfter,
          attribution: change.attribution,
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
    var rawMgr = (gdCounters && gdCounters.review) ||
      (result.payload.gameData && result.payload.gameData.review) ||
      result.payload.review || game.review || null;
    var rawAbs = (gdCounters && gdCounters.absChallenges) ||
      (result.payload.gameData && result.payload.gameData.absChallenges) ||
      result.payload.absChallenges || null;
    /* Third source: the normalized tier-2 state (structured counters already
     * validated).  Official values only — never derived by counting events. */
    var stateCounters = (result.countersState && result.countersState.counters) || null;
    var reviewCounters = Reviews.managerCounters(rawMgr) ||
      (stateCounters && stateCounters.manager) || (prevCached && prevCached.manager) || null;
    var absCounters = Reviews.absCounters(rawAbs) ||
      (stateCounters && stateCounters.abs) || (prevCached && prevCached.abs) || null;
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

  /* A scoring-section row is stored separately from the alert entries: its own
   * list in the StateLog payload so it survives refreshes and cannot disturb
   * the feed's alert entries. */
  function logScoringRow(row) {
    if (!row) return;
    if (!state.stateLog) state.stateLog = StateLog.emptyPayload(state.date);
    if (!Array.isArray(state.stateLog.scoring)) state.stateLog.scoring = [];
    var id = String(row.gamePk) + ':' + row.kind + ':' + (row.atBatIndex === undefined ? '' : row.atBatIndex);
    var exists = state.stateLog.scoring.some(function (r) {
      return r && r.id === id && r.kind === row.kind && r.atBatIndex === row.atBatIndex;
    });
    if (exists) return;
    row.id = id;
    row.observedAt = Latency.isoNow();
    row.officialDate = state.date;
    state.stateLog.scoring.push(row);
    if (state.stateLog.scoring.length > 400) state.stateLog.scoring = state.stateLog.scoring.slice(-400);
    state.stateDirty = true;
    StateLog.save(state.date, state.stateLog);
  }

  /* --------------------------------------------------------------- scanning */

  /**
   * scan(opts)
   *   opts.force = true (manual Refresh, tab focus, tests) clears every
   *   per-game wait and forces one full read of each in-scope game.  The
   *   automatic loop never forces; it honours the paced due times.
   */
  function scan(opts) {
    if (state.scanning) {
      /* A scan is already in flight.  A caller who asks for one now (Refresh,
       * tab focus, the test harness) needs a read that STARTS AFTER their
       * change, so queue it instead of dropping it. */
      state.scanQueued = { force: !!(opts && opts.force) };
      return;
    }
    if (document.hidden) { scheduleScan(1000); return; }
    if (opts && opts.force) {
      Object.keys(state.feed).forEach(function (pk) {
        var rec = state.feed[pk];
        rec.dueAt = 0;
        rec.pendingCycle = true;
      });
    }
    var scanSeq = state.dateSeq;
    var scanDate = state.date;
    state.scanning = true;
    refreshPacing();
    state.nextScanAt = Date.now() + state.latency.intervalMs;

    MLB.schedule(scanDate, { ttl: 0, retries: 0 })
      .then(function (payload) {
        if (scanSeq !== state.dateSeq || scanDate !== state.date) return null;
        state.games = flattenGames(payload);
        var now = Date.now();
        var due = state.games.filter(function (g) { return shouldMeta(g, now); });
        state.scanError = null;
        if (!due.length) {
          updateChrome();
          renderIfChanged();
          return null;
        }
        return runLimited(due, FETCH_CONCURRENCY, function (game) {
          if (scanSeq !== state.dateSeq || scanDate !== state.date) return Promise.resolve();
          return pollGame(game);
        }).then(function () {
          if (scanSeq !== state.dateSeq || scanDate !== state.date) return;
          persist();
          renderIfChanged();
          updateChrome();
        });
      })
      .catch(function (err) {
        if (scanSeq !== state.dateSeq || scanDate !== state.date) return;
        state.scanError = err;
        state.latency.metaErrors += 1;
        updateChrome();
      })
      .then(function () {
        if (scanSeq !== state.dateSeq || scanDate !== state.date) return;
        state.scanning = false;
        state.lastScanAt = Date.now();
        if (state.scanQueued) {
          var queued = state.scanQueued;
          state.scanQueued = null;
          scan(queued);
          return;
        }
        /* Next tick: as soon as the nearest per-game wait expires, no later
         * than one interval — subtracts scan time instead of adding to it. */
        var next = nextDueIn();
        scheduleScan(Math.max(0, Math.min(state.latency.intervalMs, next)));
      });
  }

  function nextDueIn() {
    var now = Date.now();
    var soonest = Infinity;
    state.games.forEach(function (g) {
      var rec = state.feed[g.gamePk];
      if (!rec) return;
      if (rec.dueAt > now && rec.dueAt - now < soonest) soonest = rec.dueAt - now;
    });
    return soonest === Infinity ? state.latency.intervalMs : soonest;
  }

  function scheduleScan(delay) {
    clearTimeout(state.timers.scan);
    state.nextScanAt = Date.now() + delay;
    state.timers.scan = setTimeout(scan, delay);
  }

  /* Schedule-level status sweep: a slow safety net (5 s) that catches a game
   * flipping to Live/Final when the schedule payload is the first to say so.
   * Per-game review state is caught by the meta poll instead (500 ms-1.5 s),
   * which is why this no longer needs to run at 125 ms. */
  function sweep() {
    if (document.hidden) return;
    var sweepSeq = state.dateSeq;
    var sweepDate = state.date;
    var live = liveGames();
    if (!live.length) return;
    MLB.slateStatus(sweepDate).then(function (payload) {
      if (sweepSeq !== state.dateSeq || sweepDate !== state.date) return;
      var games = flattenGames(payload);
      var changed = false;
      games.forEach(function (g) {
        var current = state.games.find(function (x) { return x.gamePk === g.gamePk; });
        if (!current) return;
        if (gameStatus(current) !== gameStatus(g) || current.status.statusCode !== g.status.statusCode) {
          changed = true;
          current.status = g.status;
          var rec = feedRec(g.gamePk);
          rec.dueAt = 0;
          if (current.status && current.status.abstractGameState === 'Live') {
            pollGame(current);
          }
        }
      });
      if (changed) {
        refreshPacing();
        updateChrome();
      }
    }).catch(function () { /* the scan owns error reporting */ });
  }


  /* ------------------------------------------------------------- sound/notify
   * The tone itself lives in alert-sound.js (a ~3 s synthesized raindrop with a
   * hard peak ceiling; see that file's header for the mix).  Everything here is
   * the policy layer for the Replay Feed:
   *
   *   chime(reason)  — called by the ALERT path only (review rows, pending
   *                    rulings, scoring changes, runs-at-risk).  Respects the
   *                    Sound On/Off toggle, the shared cooldown and the saved
   *                    preference.  ABS pitch challenges never call it.
   *   testSound()    — the Test button: plays the exact alert tone even while
   *                    Sound is off, so the operator can confirm their speakers
   *                    and the site's audio path without waiting for a game
   *                    event.  This is the "toggle on/off to test" control.
   */

  function chime(kind) {
    if (!state.soundOn) return false;
    /* lastChimeAt records "an alert was triggered" — the policy decision — so
     * it stays meaningful on machines with no Web Audio (and the HUD/tests can
     * tell an alert from a silent page).  Whether a tone is physically audible
     * is AlertSound's job, including its own cooldown. */
    state.lastChimeAt = Date.now();
    AlertSound.play(kind || 'review');
    return true;
  }

  function testSound() {
    var played = AlertSound.test();
    var el = $('sound-test-note');
    if (el) {
      el.textContent = played
        ? 'Test alert played — ' + AlertSound.LENGTH_S.toFixed(1) + 's raindrop at ' +
          Math.round(AlertSound.MASTER_PEAK * 100) + '% peak gain.'
        : 'No audio could be scheduled in this browser (Web Audio unavailable or blocked).';
    }
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


  /* ------------------------------------------------- live state (all games) */

  var EVENT_ICONS = {
    state_initial: '🟢',
    status: '📣',
    score: '🏅',
    inning: '🔄',
    outs: '🔴',
    bases: '🏃',
    atbat_start: '⚾',
    atbat_complete: '✅',
    count: '🔢',
    pitching_change: '🔁',
    review_open: '🚨',
    review_update: '⚖️',
    counters: '🎫',
    pitch_count: '🧮',
    scoring_change: '✏️',
    scoring_pending: '📝',
  };

  function eventIcon(kind) { return EVENT_ICONS[kind] || '⚾'; }

  /* The games that are live right now, with the captured official state.
   * Score, inning, count, outs, runners, batter, pitcher, pitch count, review
   * state and challenge counters — every value straight from the payload. */
  function renderLiveStrip() {
    var el = $('live-state');
    if (!el) return;
    var rows = state.games.filter(function (g) {
      return isLiveGame(g) || (state.feed[g.gamePk] && state.feed[g.gamePk].state &&
        state.feed[g.gamePk].state.abstractState === 'Live');
    });
    if (!rows.length) {
      el.innerHTML = '';
      return;
    }
    var open = state.liveStripOpen;
    var html = '<div class="live-state-panel">' +
      '<div class="ls-head">' +
        '<h3><span class="live-dot-sm"></span> Official live state · ' + rows.length +
          ' game' + (rows.length === 1 ? '' : 's') + ' in progress</h3>' +
        '<span class="ls-meta">captured to the second · MLB revision timecode (UTC)</span>' +
        '<button class="btn btn-ghost btn-sm" data-ls-toggle="1">' + (open ? 'Hide' : 'Show') + '</button>' +
      '</div>';
    if (open) {
      html += '<div class="ls-grid">';
      rows.forEach(function (g) {
        var rec = state.feed[g.gamePk];
        var st = rec && rec.state;
        var matchup = matchupOf(g);
        if (!st) {
          html += '<div class="ls-card"><div class="ls-top"><b>' + UI.esc(matchup) + '</b>' +
            UI.chip('awaiting first read', '') + '</div></div>';
          return;
        }
        var age = rec.stamp ? Math.max(0, Math.round((Date.now() - rec.lastStampChangeAt) / 1000)) : null;
        html += '<div class="ls-card' + (st.review && st.review.inProgress ? ' is-review' : '') + '">' +
          '<div class="ls-top">' +
            '<a href="game.html?gamePk=' + encodeURIComponent(g.gamePk) + '&date=' + encodeURIComponent(state.date) + '"><b>' + UI.esc(matchup) + '</b></a>' +
            '<span class="ls-score">' + UI.esc(Latency.scoreLabel(st)) + '</span>' +
            '<span class="ls-inn">' + UI.esc(Latency.inningLabel(st) || st.detailedState || '—') + '</span>' +
          '</div>' +
          '<div class="ls-line">' +
            '<span title="Count">' + UI.esc(Latency.countLabel(st)) + '</span>' +
            '<span title="Outs">' + (st.outs === null ? '—' : st.outs) + ' out' + (st.outs === 1 ? '' : 's') + '</span>' +
            '<span title="Runners">' + UI.esc(Latency.runnersLabel(st)) + '</span>' +
          '</div>' +
          '<div class="ls-line">' +
            '<span title="Batter">⚾ ' + UI.esc(st.batter.name || '—') + '</span>' +
            '<span title="Pitcher">🅿️ ' + UI.esc(st.pitcher.name || '—') + '</span>' +
            (st.pitchCount !== null ? '<span title="Official pitch count (box score)">' + UI.esc(st.pitchCount) + ' P</span>' : '') +
          '</div>' +
          (st.review ? '<div class="ls-line ls-review">' +
            UI.chip(st.review.code + (st.review.inProgress ? ' · under review' : st.review.overturned === true ? ' · overturned' : ' · stands'), 'chip-review') +
            '</div>' : '') +
          '<div class="ls-stamp">' +
            '<span title="MLB feed revision timecode (official)">rev ' + UI.esc(Latency.timecodeLabel(st.timecode)) + '</span>' +
            (age !== null ? '<span> · ' + UI.esc(age < 60 ? age + 's old' : Math.round(age / 60) + 'm old') + '</span>' : '') +
            '<span> · polled ' + UI.esc(String(rec.intervalMs || state.latency.intervalMs)) + ' ms</span>' +
          '</div>' +
        '</div>';
      });
      html += '</div>';
    }
    html += '</div>';
    el.innerHTML = html;
  }

  /* The play-by-play log of the official state: newest row first, timestamped
   * twice (MLB's revision timecode + our observation time) with the exact
   * official wording before → after. */
  function renderStateLog() {
    var el = $('state-log');
    if (!el) return;
    var events = visibleStateEvents();
    var head = '<div class="sl-head">' +
      '<h3>Official live game state log</h3>' +
      '<span class="sl-count">' + state.stateEvents.length + ' captured change' +
        (state.stateEvents.length === 1 ? '' : 's') + ' · ' + state.games.length + ' game' +
        (state.games.length === 1 ? '' : 's') + ' monitored</span>' +
      '<label class="sl-filter"><input type="checkbox" id="sl-only-events" ' +
        (state.eventSoundOn ? 'checked' : '') + '> play-by-play rows</label>' +
      '</div>';
    if (!events.length) {
      el.innerHTML = head + '<div class="feed-empty">Waiting for the first official state read. ' +
        'Every captured change (score, outs, count, runners, batter, pitcher, reviews, challenges) ' +
        'is written here live and restored after a refresh.</div>';
      return;
    }
    var shown = events.slice(0, 200);
    el.innerHTML = head + '<div class="sl-list">' + shown.map(function (ev) {
      var isHigh = ev.kind !== 'count' && ev.kind !== 'pitch_count';
      return '<div class="sl-row' + (isHigh ? ' sl-high' : '') + '">' +
        '<span class="sl-icon">' + eventIcon(ev.kind) + '</span>' +
        '<span class="sl-time" title="MLB feed revision: ' + UI.esc(ev.officialTime || '') +
          ' · observed ' + UI.esc(ev.observedAt || '') + '">' +
          UI.esc(ev.officialTime ? ev.officialTime.slice(11) : (ev.observedAt || '').slice(11)) + 'Z' +
        '</span>' +
        '<span class="sl-team"><a href="game.html?gamePk=' + encodeURIComponent(ev.gamePk) +
          '&date=' + encodeURIComponent(state.date) + '">' + UI.esc(ev.matchupLabel || '') + '</a></span>' +
        '<span class="sl-msg">' + UI.esc(ev.label || '') + '</span>' +
        '<span class="sl-kind">' + UI.esc(ev.kind || '') + '</span>' +
      '</div>';
    }).join('') + '</div>';
  }

  /* ------------------------------------------- official scoring section
   * Separate from the alert feed by design.  Shows (a) pending official-scorer
   * rulings and (b) scoring changes the scorer made after the fact, each with
   * the official wording before and after, persisted in StateLog so a refresh
   * does not lose it. */
  function scoringRowsFor() {
    var rows = [];
    if (state.stateLog && Array.isArray(state.stateLog.scoring)) rows = rows.concat(state.stateLog.scoring);
    /* Also derive from state-log events so a log written before the scoring
     * list existed still shows its review/scoring rows. */
    return rows.slice().reverse();
  }

  function renderScoringSection() {
    var el = $('scoring-section');
    if (!el) return;
    var rows = scoringRowsFor();
    var pendingRows = rows.filter(function (r) { return r.kind === 'scoring_pending'; });
    var changeRows = rows.filter(function (r) { return r.kind === 'scoring_change'; });
    var filter = state.scoringFilter;
    var shown = filter === 'pending' ? pendingRows : filter === 'changes' ? changeRows : rows;
    var html = '<div class="sc-panel">' +
      '<div class="sc-head">' +
        '<h3>📝 Official scoring pending &amp; scoring changes</h3>' +
        '<span class="sc-note">Separate log · survives refresh · never drives the alert feed</span>' +
      '</div>' +
      '<div class="sc-tabs">' +
        ['all', 'pending', 'changes'].map(function (f) {
          var label = f === 'all' ? 'All (' + rows.length + ')' :
            f === 'pending' ? 'Pending rulings (' + pendingRows.length + ')' :
            'Scoring changes (' + changeRows.length + ')';
          return '<button class="tab-btn' + (filter === f ? ' tab-on' : '') + '" data-sc-filter="' + f + '">' +
            UI.esc(label) + '</button>';
        }).join('') +
      '</div>';
    if (!shown.length) {
      html += '<div class="feed-empty">No official-scorer pending rulings or scoring changes captured for this date yet. ' +
        'Rows appear here the second the API publishes them and are kept in ' +
        (StateLog.state.available ? 'the shared server log and this browser' : 'this browser (local log)') +
        ', so a refresh does not lose them.</div>';
    } else {
      html += '<div class="sc-list">' + shown.map(function (row) {
        var kindLabel = row.kind === 'scoring_pending' ? 'Ruling pending' : 'Scoring change';
        return '<div class="sc-row' + (row.kind === 'scoring_pending' ? ' is-pending' : '') + '">' +
          '<div class="sc-top">' +
            '<span class="sc-kind">' + eventIcon(row.kind) + ' ' + UI.esc(kindLabel) + '</span>' +
            '<a href="game.html?gamePk=' + encodeURIComponent(row.gamePk) + '&date=' + encodeURIComponent(state.date) + '">' +
              UI.esc(row.matchupLabel || '') + '</a>' +
            '<span>' + UI.esc(row.inning || '') + '</span>' +
            '<span class="sl-time">' + UI.esc((row.observedAt || '').slice(11)) + 'Z</span>' +
            (row.atBatIndex !== undefined && row.atBatIndex !== null
              ? '<span class="sc-atbat">at-bat #' + (Number(row.atBatIndex) + 1) + '</span>' : '') +
          '</div>' +
          '<div class="sc-body">' +
            (row.kind === 'scoring_pending'
              ? '<div class="sc-line"><span class="sc-lbl">Official description</span> ' + UI.esc(row.before || '—') + '</div>' +
                '<div class="sc-line"><span class="sc-lbl">Ruling</span> ' + UI.esc(row.after || 'Pending') + '</div>'
              : '<div class="sc-line"><span class="sc-lbl">Initial call</span> ' + UI.esc(row.before || '—') +
                  ' <code>' + UI.esc(row.beforeEventType || '') + '</code></div>' +
                '<div class="sc-line"><span class="sc-lbl">Final ruling</span> ' + UI.esc(row.after || '—') +
                  ' <code>' + UI.esc(row.afterEventType || '') + '</code></div>' +
                (row.scoreAfter ? '<div class="sc-line"><span class="sc-lbl">Score after</span> ' +
                  UI.esc(row.scoreAfter.away) + '–' + UI.esc(row.scoreAfter.home) + '</div>' : '') +
                (row.attribution ? '<div class="sc-attr">Attribution: ' + UI.esc(row.attribution) + '</div>' : '')) +
            (row.batter ? '<div class="sc-line"><span class="sc-lbl">Batter</span> ' + UI.esc(row.batter) +
              (row.pitcher ? ' vs ' + UI.esc(row.pitcher) : '') + '</div>' : '') +
          '</div>' +
        '</div>';
      }).join('') + '</div>';
    }
    html += '</div>';
    el.innerHTML = html;
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
          (entry.timecode ? '<span title="MLB feed revision (UTC)">rev ' + UI.esc(Latency.timecodeLabel(entry.timecode)) + '</span>' : '') +
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
   * actually changed, so a fast scan does not re-create identical rows. */
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
    return state.filter + '|' + state.games.length + '|' + (state.lastGameDate || '') + '|' +
      state.latency.stampChanges + '|' + state.stateEvents.length + '|' +
      (state.stateLog && state.stateLog.scoring ? state.stateLog.scoring.length : 0) + '|' +
      state.scoringFilter + '|' + state.liveStripOpen + '|' +
      state.entries.map(function (e) {
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
    renderLiveStrip();
    renderStateLog();
    renderScoringSection();
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
        if (!namesEntry && flagged.indexOf(flaggedRowHtml(e, n)) === -1) {
          flagged.push(flaggedRowHtml(e, n));
        }
      });
    });
    list.innerHTML = flagged.join('') + rows.map(renderRow).join('');
  }


  /* -------------------------------------------------------------------- nav */

  function resetFeedState() {
    state.games = [];
    state.entries = [];
    state.snapshots = Object.create(null);
    state.irregularities = Object.create(null);
    state.finalSeen = Object.create(null);
    state.nextDue = Object.create(null);
    state.statusByPk = Object.create(null);
    state.counterCache = Object.create(null);
    state.absFetchedRevCount = Object.create(null);
    state.feed = Object.create(null);
    state.stateEvents = [];
    state.stateLog = null;
    state.stateDirty = false;
    state.latency.lastDetectMs = null;
    state.latency.stampChanges = 0;
    state.latency.parses = 0;
    state.latency.metaPolls = 0;
    state.latency.stateEvents = 0;
  }

  function setDate(date) {
    var clean = MLB.isValidISODate(date) ? date : MLB.todayISO();
    if (clean === state.date) return;
    state.dateSeq += 1;
    var seq = state.dateSeq;
    clearTimeout(state.timers.scan);
    state.scanning = false;
    state.date = clean;
    resetFeedState();
    state.lastGameDate = undefined;
    state.lookingForRecent = false;
    state.log = null;
    state.lastRenderSignature = '';
    syncNav();
    render();
    FeedLog.closeStream();
    StateLog.closeStream();
    FeedLog.load(clean).then(function (log) {
      if (seq !== state.dateSeq || state.date !== clean) return;
      adoptLog(log);
      render();
      FeedLog.openStream(clean);
    });
    /* Paint the persisted log from localStorage straight away; the merged
     * server copy replaces it when it arrives. */
    paintLocalStateLog(clean);
    StateLog.load(clean).then(function (payload) {
      if (seq !== state.dateSeq || state.date !== clean) return;
      adoptStateLog(payload);
      StateLog.openStream(clean);
      render();
      scan();
    });
  }

  /* Synchronous first paint from localStorage only — no network, no alert. */
  function paintLocalStateLog(date) {
    if (typeof StateLog.loadLocal !== 'function') return;
    var local = StateLog.loadLocal(date);
    if (!local || !local.events || !local.events.length) return;
    adoptStateLog(StateLog.markRestored(StateLog.normalize(local, date)));
  }

  function adoptStateLog(payload) {
    if (!payload) return;
    if (payload.date && MLB.isValidISODate(payload.date) && payload.date !== state.date) return;
    state.stateLog = payload;
    state.stateEvents = Array.isArray(payload.events) ? payload.events.slice().slice(-StateLog.EVENT_CAP) : [];
    /* Restored rows were observed earlier: they must never re-chime (they are
     * not on the alert path at all, but mark them so a future feature cannot). */
    state.stateEvents.forEach(function (e) { e.restored = true; });
  }

  function setFilter(filter) { state.filter = filter; render(); }

  function setScoringFilter(filter) {
    state.scoringFilter = filter;
    render();
  }

  function toggleLiveStrip() {
    state.liveStripOpen = !state.liveStripOpen;
    render();
  }

  /* The line under the sound controls always states the current contract, so
   * the toggle is self-describing from the first paint (and after a refresh). */
  function soundNoteText() {
    var len = AlertSound ? AlertSound.LENGTH_S.toFixed(1) : '3.0';
    var cool = AlertSound ? (AlertSound.COOLDOWN_MS / 1000).toFixed(1) : '3.2';
    if (!state.soundOn) {
      return 'Alerts are OFF (silent monitoring — the feed keeps running). Press Test to play the alert even while Off.';
    }
    return 'Alerts are ON — a ' + len + 's raindrop plays for every alert row (one tone per ' + cool +
      's, so a burst collapses into one).';
  }

  function syncSoundControls() {
    var btn = $('sound-toggle-btn');
    if (btn) {
      btn.textContent = state.soundOn ? '🔊 Sound On' : '🔇 Sound Off';
      btn.classList.toggle('btn-on', state.soundOn);
      btn.setAttribute('aria-pressed', state.soundOn ? 'true' : 'false');
    }
    var note = $('sound-test-note');
    if (note) note.textContent = soundNoteText();
  }

  function toggleSound() {
    state.soundOn = !state.soundOn;
    savePref('sound', state.soundOn);
    AlertSound.setEnabled(state.soundOn);
    syncSoundControls();
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

  /* End-to-end alert test: prove the whole alert path (state → chime) works
   * without waiting for a live event.  It exercises the same AlertSound graph
   * the real alerts use, and reports the audio state in #sound-test-note. */
  function runAlertTest() {
    /* AlertSound.test() bypasses the on/off toggle on purpose: the operator
     * is asking "can this machine make the sound?", which is a different
     * question from "are alerts on?". */
    return testSound();
  }

  /* ------------------------------------------------------------- chrome/HUD */

  function latencyText() {
    var l = state.latency;
    var bits = [];
    bits.push(l.intervalMs + ' ms poll');
    if (l.lastDetectMs !== null) bits.push('last detect ' + l.lastDetectMs + ' ms');
    if (l.stampChanges) bits.push(l.stampChanges + ' revisions');
    if (l.stateEvents) bits.push(l.stateEvents + ' state rows');
    return bits.join(' · ');
  }

  function updateChrome() {
    var label = $('countdown');
    if (label) {
      var left = Math.max(0, state.nextScanAt - Date.now());
      label.textContent = document.hidden ? 'paused' : (left / 1000).toFixed(1) + 's';
    }
    var dot = $('live-dot');
    if (dot) dot.style.opacity = state.scanError ? '0.3' : '1';
    var hud = $('latency-hud');
    if (hud) {
      var budget = MLB.budgetRemaining();
      hud.textContent = latencyText() + ' · API ' + budget.tokens + ' burst / ' + budget.windowLeft + ' left this min';
    }
    if (state.scanError) {
      statusLine('Scan problem: ' + (state.scanError.message || 'network error') + ' — retrying.', true);
    } else {
      var live = liveGames().length;
      var under = state.entries.filter(function (e) { return e.review && e.review.inProgress; }).length;
      statusLine(state.games.length + ' game(s) on ' + MLB.formatDateLabel(state.date) +
        ' · ' + live + ' live' + (under ? ' · ' + under + ' under review' : '') +
        ' · ' + state.entries.length + ' alert row' + (state.entries.length === 1 ? '' : 's') +
        ' · ' + state.stateEvents.length + ' state row' + (state.stateEvents.length === 1 ? '' : 's') +
        ' · ' + latencyText() +
        ' · scanned ' + new Date(state.lastScanAt || Date.now()).toLocaleTimeString() +
        (FeedLog.state.available ? ' · shared alert log' : ' · local alert log') +
        (StateLog.state.available ? ' · shared state log' : ' · local state log'));
    }
  }

  function init() {
    state.date = urlDate() || parseDate();
    syncNav();
    state.soundOn = loadPref('sound', false);
    state.notifyOn = loadPref('notify', false);
    AlertSound.setEnabled(state.soundOn);
    /* Paint the restored preference + contract line; otherwise a page whose
     * preference is ON would show "🔇 Sound Off" until the user clicked. */
    syncSoundControls();

    FeedLog.onChange(function (pushed) {
      if (pushed && pushed.date === state.date) {
        adoptLog(FeedLog.mergePayloads(state.log, pushed, state.date));
        render();
      }
    });
    StateLog.onChange(function (pushed) {
      if (pushed && pushed.date === state.date) {
        adoptStateLog(StateLog.mergePayloads(state.stateLog, pushed, state.date));
        render();
      }
    });

    var soundBtn = $('sound-toggle-btn');
    if (soundBtn) {
      soundBtn.textContent = state.soundOn ? '🔊 Sound On' : '🔇 Sound Off';
      soundBtn.classList.toggle('btn-on', state.soundOn);
      soundBtn.addEventListener('click', toggleSound);
    }
    var testBtn = $('sound-test-btn');
    if (testBtn) testBtn.addEventListener('click', runAlertTest);
    var notifyBtn = $('notify-toggle-btn');
    if (notifyBtn) {
      notifyBtn.textContent = state.notifyOn ? '🔴 Run Alerts On' : '⚪ Run Alerts Off';
      notifyBtn.classList.toggle('btn-on', state.notifyOn);
      notifyBtn.addEventListener('click', toggleNotify);
    }
    var refreshBtn = $('refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', function () { scan({ force: true }); });

    var tabs = $('feed-tabs');
    if (tabs) {
      tabs.addEventListener('click', function (evt) {
        var btn = evt.target.closest('[data-filter]');
        if (btn) setFilter(btn.getAttribute('data-filter'));
      });
    }
    var liveState = $('live-state');
    if (liveState) {
      liveState.addEventListener('click', function (evt) {
        if (evt.target.closest('[data-ls-toggle]')) toggleLiveStrip();
      });
    }
    var scoring = $('scoring-section');
    if (scoring) {
      scoring.addEventListener('click', function (evt) {
        var btn = evt.target.closest('[data-sc-filter]');
        if (btn) setScoringFilter(btn.getAttribute('data-sc-filter'));
      });
    }

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { scan({ force: true }); }
    });
    /* Flush the separate state log before the page goes away so a refresh
     * cannot lose the last captured row. */
    global.addEventListener('pagehide', function () {
      if (state.stateDirty) StateLog.flush(state.date);
    });

    Reviews.loadRegistry();
    Reviews.loadEventTypes();

    var initSeq = state.dateSeq;
    var initDate = state.date;
    FeedLog.load(initDate).then(function (log) {
      if (initSeq !== state.dateSeq || state.date !== initDate) return;
      adoptLog(log);
      render();
      FeedLog.openStream(initDate);
    });
    /* A refresh must never show an empty log while a request is in flight:
     * localStorage already holds this date's rows, so paint them first. */
    paintLocalStateLog(initDate);
    StateLog.load(initDate).then(function (payload) {
      if (initSeq !== state.dateSeq || state.date !== initDate) return;
      adoptStateLog(payload);
      StateLog.openStream(initDate);
      render();
      scan();
    });

    state.timers.sweep = setInterval(sweep, STATUS_SWEEP_MS);
    state.timers.countdown = setInterval(updateChrome, 250);
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
    setScoringFilter: setScoringFilter,
    toggleLiveStrip: toggleLiveStrip,
    toggleSound: toggleSound,
    toggleNotify: toggleNotify,
    testSound: testSound,
    runAlertTest: runAlertTest,
    scan: scan,
    state: state,
    SCAN_MS: SCAN_MS,
    STATUS_SWEEP_MS: STATUS_SWEEP_MS,
    STATUS_SWEEP_LEGACY_MS: STATUS_SWEEP_LEGACY_MS,
    FETCH_CONCURRENCY: FETCH_CONCURRENCY,
    TICK_MS: TICK_MS,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}(window));
