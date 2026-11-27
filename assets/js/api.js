/* ============================================================================
 * api.js — MLB StatsAPI client
 *
 * One place for every network call the site makes:
 *   1. fetch wrapper with timeout, retry, response cache, HTTP-429 handling and
 *      a request-rate governor (individual, non-commercial, non-bulk use)
 *   2. endpoint helpers (schedule, feed/live, feed metadata, playByPlay,
 *      gameStatus, eventTypes, people stats)
 *   3. small date/number formatters shared by the pages
 *
 * The StatsAPI is keyless and sends CORS headers, so a static GitHub Pages site
 * can call it straight from the browser.  Endpoint list + `fields` projections
 * follow the ones documented in README.md §"How it works" and
 * docs/api-compliance.md (the request budget).
 *
 * Latency design (see docs/latency.md):
 *   - `feedMeta()` asks for the game feed's own revision stamp (`metaData`) plus
 *     its status.  It is a few hundred bytes and is the *earliest* signal that
 *     MLB has published anything for a game: `timeStamp` is the official feed
 *     revision (YYYYMMDD_HHMMSS), so a changed stamp means "new official data
 *     exists right now".  Polling this instead of the whole feed is what makes
 *     sub-second detection affordable inside the terms of use.
 *   - `feedSnapshot()` then asks for one small structured projection (status,
 *     linescore, current play, review details, challenge counters) pinned to a
 *     timecode — the exact official state, stamped to the second.
 *   - `playByPlay()` is the ground-truth parser input and now runs on demand
 *     (new completed at-bat / review / safety cadence) instead of four times a
 *     second per game.
 * ==========================================================================*/
(function (global) {
  'use strict';

  /* 1 = MLB. 11-14 = the minor leagues (see README §Customizing). */
  var SPORT_ID = 1;
  var API_ROOT = 'https://statsapi.mlb.com/api';
  var REQUEST_TIMEOUT_MS = 15000;

  /* HTTP 429 quiet period: honour Retry-After when the host sends one, else 60s.
   * Clamped to 1s-5min so a bogus header can neither spin nor stall the page. */
  var QUIET_DEFAULT_MS = 60000;
  var QUIET_MIN_MS = 1000;
  var QUIET_MAX_MS = 300000;

  /* ---------------------------------------------------------- request budget
   * The MLBAM notice that ships with the API (gdx.mlb.com/components/
   * copyright.txt) permits "only individual, non-commercial, non-bulk use".
   * The budget below is the enforceable reading of "non-bulk" for this app:
   * one browser page may not exceed ~20 requests/second sustained and 2400 per
   * rolling minute, whichever is smaller.  Callers that cannot get a token are
   * told to back off (err.budget) — they never queue up into a burst.
   *
   * Why a global governor rather than per-page numbers: the Replay Feed now
   * polls every live game, so the number of requests scales with the slate.
   * The governor keeps the *total* flat no matter how many games are live, and
   * the latency engine lowers its per-game interval when the slate is large
   * (see assets/js/latency.js → adaptiveMetaMs).
   */
  var BUDGET = {
    refillPerSec: 20,
    burst: 30,
    windowMs: 60000,
    maxPerWindow: 2400,
  };

  var state = {
    quietUntil: 0,
    lastError: null,
    lastOK: 0,
    requests: 0,
    cacheHits: 0,
    budget: {
      tokens: BUDGET.burst,
      refilledAt: Date.now(),
      denied: 0,
      windowStart: Date.now(),
      windowCount: 0,
      peakPerSec: 0,
      perSec: 0,
      perSecAt: Date.now(),
      perSecCount: 0,
    },
  };

  var cache = Object.create(null);
  var CACHE_MAX_ENTRIES = 240;

  function now() { return Date.now(); }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function quietRemainingMs() { return Math.max(0, state.quietUntil - now()); }

  /**
   * takeBudgetToken() -> true when the request may go out now.
   *
   * Two limits, both enforced in this one place:
   *   - token bucket: BUDGET.refillPerSec with a BUDGET.burst ceiling;
   *   - rolling-minute cap: BUDGET.maxPerWindow.
   * Absence of a token is not "wait forever": the caller gets false and backs
   * its own polling interval off, so a big slate simply scans a little slower
   * instead of firing a burst.  Every response resets nothing — the bucket is
   * monotonic, which is what keeps this inside "non-bulk".
   */
  function takeBudgetToken() {
    var b = state.budget;
    var t = now();
    var elapsed = Math.max(0, t - b.refilledAt) / 1000;
    if (elapsed > 0) {
      b.tokens = Math.min(BUDGET.burst, b.tokens + elapsed * BUDGET.refillPerSec);
      b.refilledAt = t;
    }
    if (t - b.perSecAt >= 1000) {
      b.peakPerSec = Math.max(b.peakPerSec, b.perSecCount);
      b.perSec = b.perSecCount;
      b.perSecCount = 0;
      b.perSecAt = t;
    }
    if (t - b.windowStart >= BUDGET.windowMs) {
      b.windowStart = t;
      b.windowCount = 0;
    }
    if (b.tokens < 1 || b.windowCount >= BUDGET.maxPerWindow) {
      b.denied += 1;
      return false;
    }
    b.tokens -= 1;
    b.windowCount += 1;
    b.perSecCount += 1;
    return true;
  }

  /** Requests still available in the current rolling minute (for the HUD). */
  function budgetRemaining() {
    var b = state.budget;
    var t = now();
    var windowLeft = b.windowCount >= BUDGET.maxPerWindow
      ? 0
      : BUDGET.maxPerWindow - b.windowCount;
    var elapsed = Math.max(0, t - b.refilledAt) / 1000;
    var tokens = Math.min(BUDGET.burst, b.tokens + elapsed * BUDGET.refillPerSec);
    return { tokens: Math.floor(tokens), windowLeft: windowLeft, denied: b.denied };
  }

  function parseRetryAfter(value) {
    if (!value) return 0;
    var seconds = Number(value);
    if (isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    var when = Date.parse(value); // HTTP-date form
    if (!isNaN(when)) return Math.max(0, when - now());
    return 0;
  }

  function pruneCache() {
    var keys = Object.keys(cache);
    if (keys.length <= CACHE_MAX_ENTRIES) return;
    keys.sort(function (a, b) { return cache[a].at - cache[b].at; });
    keys.slice(0, keys.length - CACHE_MAX_ENTRIES).forEach(function (k) { delete cache[k]; });
  }

  function ApiError(message, status, url) {
    var err = new Error(message);
    err.name = 'ApiError';
    err.status = status || 0;
    err.url = url || '';
    return err;
  }

  /**
   * getJSON(url, opts)
   *   opts.ttl      cache lifetime in ms (0 = no cache, the default)
   *   opts.retries  extra attempts after a failed one (default 1)
   *   opts.signal   external AbortSignal (poll loops use it to cancel)
   *   opts.keepQuiet  bypass the 429 quiet window (used by the quiet probe only)
   *   opts.noBudget bypass the request-rate governor (never used by poll loops)
   */
  function getJSON(url, opts) {
    opts = opts || {};
    var ttl = opts.ttl || 0;
    var retries = typeof opts.retries === 'number' ? opts.retries : 1;
    var noBudget = opts.noBudget === true;

    if (ttl && cache[url] && now() - cache[url].at < cache[url].ttl) {
      state.cacheHits += 1;
      return Promise.resolve(cache[url].data);
    }

    var quiet = quietRemainingMs();
    if (quiet > 0 && !opts.keepQuiet) {
      var qerr = ApiError('StatsAPI quiet period, ' + Math.ceil(quiet / 1000) + 's remaining', 429, url);
      qerr.quiet = true;
      return Promise.reject(qerr);
    }

    if (!noBudget && !takeBudgetToken()) {
      /* Over budget: fail fast with a typed error so poll loops can slow down
       * instead of retrying (a retry would be exactly the burst we are avoiding). */
      var berr = ApiError('Request budget reached (individual, non-commercial, non-bulk use)', 0, url);
      berr.budget = true;
      return Promise.reject(berr);
    }

    var attempt = 0;

    function once() {
      attempt += 1;
      state.requests += 1;

      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);
      var external = opts.signal;
      if (external) {
        if (external.aborted) controller.abort();
        else external.addEventListener('abort', function () { controller.abort(); }, { once: true });
      }

      var request = fetch(url, {
        method: 'GET',
        mode: 'cors',
        cache: 'no-store',
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });

      return request.then(function (res) {
        clearTimeout(timer);

        if (res.status === 429) {
          var wait = parseRetryAfter(res.headers.get('Retry-After')) || QUIET_DEFAULT_MS;
          wait = Math.min(QUIET_MAX_MS, Math.max(QUIET_MIN_MS, wait));
          state.quietUntil = Math.max(state.quietUntil, now() + wait);
          throw ApiError('StatsAPI asked to slow down (HTTP 429); pausing ' + Math.round(wait / 1000) + 's', 429, url);
        }
        if (!res.ok) throw ApiError('HTTP ' + res.status + ' from ' + url, res.status, url);
        return res.json();
      }).then(function (data) {
        clearTimeout(timer);
        state.lastOK = now();
        state.lastError = null;
        if (ttl) {
          cache[url] = { at: now(), ttl: ttl, data: data };
          pruneCache();
        }
        return data;
      }).catch(function (err) {
        clearTimeout(timer);
        state.lastError = err;

        var status = err && err.status;
        var retryable = !status || status >= 500 || err.name === 'AbortError' || err.name === 'TypeError';
        if (retryable && attempt <= retries) {
          return sleep(300 * attempt).then(once);
        }
        if (err.name === 'AbortError') {
          throw ApiError('Request timed out after ' + REQUEST_TIMEOUT_MS + 'ms: ' + url, 0, url);
        }
        throw err;
      });
    }

    return once();
  }

  /* ------------------------------------------------------------- endpoints */

  var SCHEDULE_HYDRATE = 'probablePitcher,linescore,decisions,review';

  /* Games for one date.  `fields` is deliberately open so the scoreboard can
   * ask for the full hydrated card data and the 125ms sweep can ask for the
   * lean status projection (README table, rows 1 and 2). */
  function scheduleUrl(date, opts) {
    opts = opts || {};
    var qs = ['sportId=' + SPORT_ID, 'date=' + encodeURIComponent(date)];
    if (opts.hydrate) qs.push('hydrate=' + encodeURIComponent(opts.hydrate));
    if (opts.fields) qs.push('fields=' + encodeURIComponent(opts.fields));
    return API_ROOT + '/v1/schedule?' + qs.join('&');
  }

  function schedule(date, opts) {
    opts = opts || {};
    return getJSON(scheduleUrl(date, {
      hydrate: opts.hydrate === undefined ? SCHEDULE_HYDRATE : opts.hydrate,
      fields: opts.fields || '',
    }), { ttl: opts.ttl || 0, signal: opts.signal, retries: opts.retries });
  }

  /* Date-range game counts — used only to point at the most recent date that
   * actually had games (the scoreboard looks empty in the offseason). */
  function scheduleRange(startDate, endDate, opts) {
    opts = opts || {};
    var qs = 'sportId=' + SPORT_ID + '&startDate=' + encodeURIComponent(startDate) +
      '&endDate=' + encodeURIComponent(endDate) + '&fields=dates,date,totalGames';
    return getJSON(API_ROOT + '/v1/schedule?' + qs, { ttl: 300000, retries: 0, signal: opts.signal });
  }

  /* Lean slate status sweep: gamePk + status only (~2.4 KB for the whole day). */
  var STATUS_FIELDS = 'dates,games,gamePk,season,status,abstractGameState,codedGameState,' +
    'detailedState,statusCode,reason,startTimeTBD,abstractGameCode';

  function slateStatus(date, opts) {
    opts = opts || {};
    return schedule(date, {
      hydrate: '',
      fields: STATUS_FIELDS,
      ttl: opts.ttl === undefined ? 0 : opts.ttl,
      signal: opts.signal,
      retries: 0,
    });
  }

  /* Full live feed (v1.1 first, v1 fallback, then /playByPlay + /boxscore + /linescore bundle). */
  function gameFeed(gamePk, opts) {
    opts = opts || {};
    var url = API_ROOT + '/v1.1/game/' + gamePk + '/feed/live';
    if (opts.fields) url += '?fields=' + encodeURIComponent(opts.fields);
    return getJSON(url, { signal: opts.signal, retries: opts.retries })
      .catch(function (err) {
        if (err && err.status === 404) {
          var v1Url = API_ROOT + '/v1/game/' + gamePk + '/feed/live';
          if (opts.fields) v1Url += '?fields=' + encodeURIComponent(opts.fields);
          return getJSON(v1Url, { signal: opts.signal }).catch(function (err2) {
            if (err2 && err2.status === 404 && !opts.fields) {
              return Promise.all([
                playByPlay(gamePk, { signal: opts.signal }),
                boxscore(gamePk, { signal: opts.signal }),
                linescore(gamePk, { signal: opts.signal }),
              ]).then(function (parts) {
                var pbp = parts[0] || {};
                var box = parts[1] || {};
                var ls = parts[2] || {};
                var awayTeam = (box.teams && box.teams.away && box.teams.away.team) || {};
                var homeTeam = (box.teams && box.teams.home && box.teams.home.team) || {};
                return {
                  gamePk: Number(gamePk),
                  gameData: {
                    game: { pk: Number(gamePk) },
                    status: { abstractGameState: ls.isFinal ? 'Final' : 'Live', detailedState: ls.isFinal ? 'Final' : '' },
                    teams: { away: awayTeam, home: homeTeam },
                    players: {},
                    venue: {},
                    datetime: {},
                  },
                  liveData: {
                    plays: { allPlays: pbp.allPlays || [], currentPlay: pbp.currentPlay || null },
                    linescore: ls,
                    boxscore: box,
                    decisions: {},
                  },
                };
              });
            }
            throw err2;
          });
        }
        throw err;
      });
  }

  /* Lean per-game status projection for the game page's 125ms watcher (~150 B). */
  function gameStatusLean(gamePk, opts) {
    opts = opts || {};
    var fields = 'gameData,status,abstractGameState,codedGameState,detailedState,statusCode,reason,startTimeTBD,abstractGameCode';
    return getJSON(API_ROOT + '/v1.1/game/' + gamePk + '/feed/live?fields=' + encodeURIComponent(fields), {
      signal: opts.signal, retries: 0,
    });
  }

  /* ------------------------------------------------------- fastest tier ---- *
   * The two helpers below are the ones the Replay Feed's latency engine polls.
   * Both were verified against the live StatsAPI on 2026-11-27 (see
   * docs/latency.md §Verification, `docs/verification-report-alert4.md`):
   *
   *   GET /api/v1.1/game/{pk}/feed/live?fields=metaData,timeStamp,wait,gameEvents,logicalEvents
   *     -> {"metaData":{"wait":10,"timeStamp":"20260828_212415","gameEvents":[...]}}
   *   GET /api/v1.1/game/{pk}/feed/live?fields=gameData,status,...,review,absChallenges
   *     -> {"gameData":{"status":{...},"review":{...},"absChallenges":{...}}}
   *
   * `timeStamp` is MLB's own feed revision id: it changes the moment any part of
   * the official feed is re-published, and every at-bat / pitch / review lands
   * as one revision.  A single few-hundred-byte request per game per tick is
   * therefore enough to know "something landed" — the heavy parse only runs
   * when it did.  `wait` is the server's own suggested poll wait (ms).
   */

  var META_FIELDS = 'metaData,timeStamp,wait,gameEvents,logicalEvents';

  function feedMetaUrl(gamePk, opts) {
    var url = API_ROOT + '/v1.1/game/' + gamePk + '/feed/live?fields=' + encodeURIComponent(META_FIELDS);
    if (opts && opts.timecode) url += '&timecode=' + encodeURIComponent(opts.timecode);
    return url;
  }

  function feedMeta(gamePk, opts) {
    opts = opts || {};
    return getJSON(feedMetaUrl(gamePk), { signal: opts.signal, retries: 0 });
  }

  /* Structured official state in one small response.  Unprojected today's
   * fields were validated live; when a field group is missing for an older
   * game the caller falls back to the playByPlay path (never guesses). */
  var SNAPSHOT_FIELDS = [
    'metaData,timeStamp',
    'gameData,status,abstractGameState,codedGameState,detailedState,statusCode,reason,abstractGameCode,startTimeTBD',
    'review,absChallenges,hasChallenges,away,home,used,remaining,usedSuccessful,usedFailed',
    'liveData,linescore,currentInning,currentInningOrdinal,inningState,isTopInning,scheduledInnings',
    'innings,num,ordinalNum,runs,hits,errors,leftOnBase,isFinal',
    'teams,away,home,name,abbreviation,teamName',
    'offense,defense,batter,pitcher,onDeck,inHole,first,second,third,id,fullName',
    'balls,strikes,outs',
    'plays,currentPlay,about,atBatIndex,isComplete,hasReview,isScoringPlay,isTopInning,inning,halfInning',
    'result,eventType,event,description,rbi,awayScore,homeScore,isOut,isScoringEvent',
    'reviewDetails,reviewType,isOverturned,inProgress,challengeTeamId,player',
    'count,matchup,playEvents,isPitch,index,pitchNumber,details,call,type,description',
  ].join(',');

  function feedSnapshot(gamePk, opts) {
    opts = opts || {};
    var url = API_ROOT + '/v1.1/game/' + gamePk + '/feed/live?fields=' + encodeURIComponent(SNAPSHOT_FIELDS);
    if (opts.timecode) url += '&timecode=' + encodeURIComponent(opts.timecode);
    return getJSON(url, { signal: opts.signal, retries: 0 })
      .catch(function (err) {
        if (err && err.status === 404) {
          /* v1.1 is the only documented feed/live version that honours
           * `timecode`; retry the v1 path without the pin before giving up. */
          var v1 = API_ROOT + '/v1/game/' + gamePk + '/feed/live?fields=' + encodeURIComponent(SNAPSHOT_FIELDS);
          return getJSON(v1, { signal: opts.signal, retries: 0 });
        }
        throw err;
      });
  }

  /* Box-score pitch counts are the only place the official per-pitcher and
   * per-team pitch totals live; the lean feed does not carry them.  Re-read on
   * a slow cadence (see latency.js) so the live state log can record them. */
  var PITCH_COUNT_FIELDS = 'teams,away,home,teamStats,pitching,numberOfPitches,players,stats,person,id,fullName';

  function boxscorePitchCounts(gamePk, opts) {
    opts = opts || {};
    return getJSON(API_ROOT + '/v1/game/' + gamePk + '/boxscore?fields=' + encodeURIComponent(PITCH_COUNT_FIELDS), {
      signal: opts.signal, retries: 0,
    });
  }

  function playByPlay(gamePk, opts) {
    opts = opts || {};
    var url = API_ROOT + '/v1/game/' + gamePk + '/playByPlay';
    if (opts.fields) url += '?fields=' + encodeURIComponent(opts.fields);
    return getJSON(url, { signal: opts.signal, retries: opts.retries });
  }

  function boxscore(gamePk, opts) {
    opts = opts || {};
    return getJSON(API_ROOT + '/v1/game/' + gamePk + '/boxscore', { signal: opts.signal, retries: 0 });
  }

  function linescore(gamePk, opts) {
    opts = opts || {};
    return getJSON(API_ROOT + '/v1/game/' + gamePk + '/linescore', { signal: opts.signal, retries: 0 });
  }

  /* Official game-status / review-type registry (codes -> official wording).
   * Cached for an hour: it is a static reference table. */
  function gameStatusRegistry(opts) {
    opts = opts || {};
    return getJSON(API_ROOT + '/v1/gameStatus', { ttl: 3600000, retries: 0, signal: opts.signal })
      .then(function (rows) {
        var byCode = Object.create(null);
        (Array.isArray(rows) ? rows : []).forEach(function (row) {
          if (row && row.statusCode) byCode[row.statusCode] = row;
        });
        return byCode;
      });
  }

  /* Official event-type registry (GET /api/v1/eventTypes) — each row is
   * {code, description, hit, plateAppearance, baseRunningEvent}.  Used to
   * resolve official wording for scoring-change from/to values
   * ("Fielders Choice" ↔ "Field Error") instead of inventing labels. */
  function eventTypesRegistry(opts) {
    opts = opts || {};
    return getJSON(API_ROOT + '/v1/eventTypes', { ttl: 3600000, retries: 0, signal: opts.signal })
      .then(function (rows) {
        var byCode = Object.create(null);
        (Array.isArray(rows) ? rows : []).forEach(function (row) {
          if (row && row.code) byCode[row.code] = row;
        });
        return byCode;
      });
  }

  function peopleStats(personId, group, opts) {
    opts = opts || {};
    var stats = opts.stats || 'season,statSplits,gameLog,expectedStatistics';
    var season = opts.season || new Date().getUTCFullYear();
    var qs = 'stats=' + encodeURIComponent(stats) + '&group=' + encodeURIComponent(group) +
      '&season=' + encodeURIComponent(season);
    if (opts.sitCodes) qs += '&sitCodes=' + encodeURIComponent(opts.sitCodes);
    return getJSON(API_ROOT + '/v1/people/' + personId + '/stats?' + qs, {
      ttl: opts.ttl === undefined ? 120000 : opts.ttl,
      signal: opts.signal, retries: 0,
    });
  }

  function vsPlayer(batterId, pitcherId, group, opts) {
    opts = opts || {};
    var qs = 'stats=vsPlayer&group=' + encodeURIComponent(group || 'hitting') +
      '&opposingPlayerId=' + encodeURIComponent(pitcherId);
    return getJSON(API_ROOT + '/v1/people/' + batterId + '/stats?' + qs, {
      ttl: opts.ttl === undefined ? 600000 : opts.ttl,
      signal: opts.signal, retries: 0,
    });
  }

  /* ------------------------------------------------------------ formatters */

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* Local calendar date as YYYY-MM-DD (no UTC shift surprises). */
  function toISODate(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function todayISO() { return toISODate(new Date()); }

  function shiftISODate(dateStr, deltaDays) {
    var parts = String(dateStr || '').split('-');
    if (parts.length !== 3) return todayISO();
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    d.setDate(d.getDate() + deltaDays);
    return toISODate(d);
  }

  function isValidISODate(s) {
    var str = String(s || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
    var p = str.split('-');
    var y = Number(p[0]);
    var m = Number(p[1]);
    var day = Number(p[2]);
    if (m < 1 || m > 12 || day < 1 || day > 31) return false;
    var d = new Date(Date.UTC(y, m - 1, day));
    return d.getUTCFullYear() === y && (d.getUTCMonth() + 1) === m && d.getUTCDate() === day;
  }

  function formatDateLabel(dateStr) {
    if (!isValidISODate(dateStr)) return '';
    var p = dateStr.split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    var weekday = d.toLocaleDateString(undefined, { weekday: 'short' });
    var month = d.toLocaleDateString(undefined, { month: 'short' });
    return weekday + ' ' + month + ' ' + d.getDate() + ', ' + d.getFullYear();
  }

  function formatGameTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function formatClock(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    return m + 'm ' + pad2(s % 60) + 's';
  }

  /* Baseball-style average: ".312" (leading zero dropped) or "—" when absent. */
  function avg3(value) {
    var n = Number(value);
    if (value === null || value === undefined || value === '' || !isFinite(n)) return '—';
    var s = n.toFixed(3);
    return s.replace(/^0/, '');
  }

  function pct(value, digits) {
    var n = Number(value);
    if (value === null || value === undefined || value === '' || !isFinite(n)) return '—';
    return (n * 100).toFixed(digits === undefined ? 0 : digits) + '%';
  }

  function ipText(value) {
    var raw = String(value === undefined || value === null ? '' : value);
    if (!raw) return '—';
    return raw;
  }

  function num(value, fallback) {
    var n = Number(value);
    return isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
  }

  global.MLB = {
    SPORT_ID: SPORT_ID,
    API_ROOT: API_ROOT,
    BUDGET: BUDGET,
    STATUS_FIELDS: STATUS_FIELDS,
    SCHEDULE_HYDRATE: SCHEDULE_HYDRATE,
    META_FIELDS: META_FIELDS,
    SNAPSHOT_FIELDS: SNAPSHOT_FIELDS,
    getJSON: getJSON,
    schedule: schedule,
    scheduleRange: scheduleRange,
    slateStatus: slateStatus,
    gameFeed: gameFeed,
    gameStatusLean: gameStatusLean,
    feedMeta: feedMeta,
    feedMetaUrl: feedMetaUrl,
    feedSnapshot: feedSnapshot,
    boxscorePitchCounts: boxscorePitchCounts,
    playByPlay: playByPlay,
    boxscore: boxscore,
    linescore: linescore,
    gameStatusRegistry: gameStatusRegistry,
    eventTypesRegistry: eventTypesRegistry,
    peopleStats: peopleStats,
    vsPlayer: vsPlayer,
    quietRemainingMs: quietRemainingMs,
    budgetRemaining: budgetRemaining,
    takeBudgetToken: takeBudgetToken,
    state: state,
    toISODate: toISODate,
    todayISO: todayISO,
    shiftISODate: shiftISODate,
    isValidISODate: isValidISODate,
    formatDateLabel: formatDateLabel,
    formatGameTime: formatGameTime,
    formatClock: formatClock,
    avg3: avg3,
    pct: pct,
    ipText: ipText,
    num: num,
  };
}(window));
