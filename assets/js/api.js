/* ============================================================================
 * api.js — MLB StatsAPI client
 *
 * One place for every network call the site makes:
 *   1. fetch wrapper with timeout, retry, response cache and HTTP-429 handling
 *   2. endpoint helpers (schedule, feed/live, playByPlay, gameStatus, people stats)
 *   3. small date/number formatters shared by the pages
 *
 * The StatsAPI is keyless and sends CORS headers, so a static GitHub Pages site
 * can call it straight from the browser.  Endpoint list + `fields` projections
 * follow the ones documented in README.md §"How it works".
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
   * MLB publishes no rate limit for the StatsAPI and no written authorization;
   * the binding terms are its usage notice ("only individual, non-commercial,
   * non-bulk use", http://gdx.mlb.com/components/copyright.txt — linked from
   * every response) plus MLB.com's Terms of Use §1, which bars automated
   * collection.  The client therefore polices itself rather than relying on a
   * server to say stop:
   *
   *   - BUDGET_PER_MIN is a hard ceiling on requests this tab issues in any
   *     rolling 60 s.  New requests wait for a slot instead of firing (the
   *     waiting caller is never dropped, so a slow minute only delays a poll).
   *   - MIN_GAP_MS keeps consecutive requests from the same tab from bursting.
   *   - Only ONE tab on the machine polls MLB: leadership is claimed in
   *     localStorage (see claimLeader), so two open tabs do not double the
   *     load.  The leader re-claims every LEADER_TTL_MS; a tab that cannot
   *     claim takes over after another LEADER_STALE_MS of silence.
   *   - Responses that MLB marks `max-age=10` are honoured by caller TTLs —
   *     polling the same live game faster than that only costs MLB a cache hit
   *     and buys the page nothing, so no caller asks for more.
   *
   * These are limits per *browser tab*, which is how the site is used: one
   * person watching the slate.  Nothing here fans out — there is no server-side
   * crawler and no bulk/archival collection anywhere in the client.
   */
  var BUDGET_PER_MIN = 240;
  var MIN_GAP_MS = 40;
  var LEADER_KEY = 'mlbp.api.leader';
  var LEADER_TTL_MS = 4000;
  var LEADER_STALE_MS = 12000;
  var TAB_ID = 'tab-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);

  var state = {
    quietUntil: 0,
    lastError: null,
    lastOK: 0,
    requests: 0,       // requests issued by this tab (all time)
    cacheHits: 0,
    windowStart: 0,    // rolling-minute bookkeeping
    windowCount: 0,
    lastRequestAt: 0,
    waiting: 0,        // callers currently parked on the budget
    throttled: 0,      // how many times the budget made a caller wait
    budgetWaitMs: 0,   // total time spent waiting on the budget (diagnostics)
    leader: false,
    lastPingAt: 0,
    lastSnapshotAt: 0,
  };

  var cache = Object.create(null);
  var CACHE_MAX_ENTRIES = 240;

  function now() { return Date.now(); }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function quietRemainingMs() { return Math.max(0, state.quietUntil - now()); }

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

  /* ------------------------------------------------------- budget + leader */

  function readLeader() {
    try {
      var raw = global.localStorage.getItem(LEADER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function writeLeader(id, at) {
    try {
      global.localStorage.setItem(LEADER_KEY, JSON.stringify({ id: id, at: at }));
    } catch (e) { /* private mode: single-tab assumption is the fallback */ }
  }

  /* Deterministic-ish leadership: this tab polls MLB only while it holds the
   * lease.  Losing the lease never throws; the caller simply stops scheduling
   * new MLB requests (see requiresLeader).
   *
   * A tab that has never yielded keeps the lease: the value it wrote is the
   * one it reads back, so `mine` is true and nothing is stolen.  Another tab
   * takes over only when the holder has been silent for LEADER_STALE_MS, which
   * is longer than the slowest page cadence, so a live leader cannot be
   * displaced by a tab that was merely opened later. */
  function claimLeader() {
    var nowAt = now();
    var held = readLeader();
    var mine = !!held && held.id === TAB_ID;
    if (mine) {
      if (!state.leader || nowAt - state.lastPingAt > LEADER_TTL_MS) {
        writeLeader(TAB_ID, nowAt);
        state.lastPingAt = nowAt;
      }
      state.leader = true;
      return true;
    }
    if (!held || nowAt - Number(held.at || 0) > LEADER_STALE_MS) {
      writeLeader(TAB_ID, nowAt);
      state.lastPingAt = nowAt;
      state.leader = true;
      return true;
    }
    state.leader = false;
    return false;
  }

  function releaseLeader() {
    var held = readLeader();
    if (held && held.id === TAB_ID) {
      try { global.localStorage.removeItem(LEADER_KEY); } catch (e) { /* ignore */ }
    }
    state.leader = false;
  }

  /* Callers that must not run twice poll this.  Ordinary one-shot reads
   * (stats, registry) ignore it. */
  function isLeader() { return claimLeader(); }

  /* Park a caller until the rolling-minute budget and the inter-request gap
   * both allow a request.  Resolves with the number of ms it had to wait. */
  function awaitSlot() {
    var waited = 0;
    function step() {
      var t = now();
      if (t - state.windowStart >= 60000) {
        state.windowStart = t;
        state.windowCount = 0;
      }
      var gap = Math.max(0, state.lastRequestAt + MIN_GAP_MS - t);
      var budgetFull = state.windowCount >= BUDGET_PER_MIN;
      if (!budgetFull && gap <= 0) {
        state.windowCount += 1;
        state.lastRequestAt = t;
        if (waited) {
          state.throttled += 1;
          state.budgetWaitMs += waited;
        }
        return Promise.resolve(waited);
      }
      var wait = budgetFull ? Math.min(1000, Math.max(80, 60000 - (t - state.windowStart))) : gap;
      state.waiting += 1;
      return sleep(wait).then(function () {
        state.waiting -= 1;
        waited += wait;
        return step();
      });
    }
    return step();
  }

  /**
   * getJSON(url, opts)
   *   opts.ttl      cache lifetime in ms (0 = no cache, the default)
   *   opts.retries  extra attempts after a failed one (default 1)
   *   opts.signal   external AbortSignal (poll loops use it to cancel)
   *   opts.keepQuiet  bypass the 429 quiet window (used by the quiet probe only)
   *   opts.noBudget bypass the rolling-minute budget (never used by the site;
   *                 present so a diagnostic can measure a deliberate burst)
   *   opts.nocache  ignore a cached body even when a ttl is set — what a manual
   *                 refresh needs, so pressing Refresh can never show a stale
   *                 second-old body
   */
  function getJSON(url, opts) {
    opts = opts || {};
    var ttl = opts.ttl || 0;
    var retries = typeof opts.retries === 'number' ? opts.retries : 1;

    if (ttl && !opts.nocache && cache[url] && now() - cache[url].at < cache[url].ttl) {
      state.cacheHits += 1;
      return Promise.resolve(cache[url].data);
    }

    var quiet = quietRemainingMs();
    if (quiet > 0 && !opts.keepQuiet) {
      var qerr = ApiError('StatsAPI quiet period, ' + Math.ceil(quiet / 1000) + 's remaining', 429, url);
      qerr.quiet = true;
      return Promise.reject(qerr);
    }

    var attempt = 0;

    function once() {
      attempt += 1;

      return (opts.noBudget ? Promise.resolve(0) : awaitSlot()).then(function () {
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

  /* Lean per-game status projection for the game page's status watcher (~150 B). */
  function gameStatusLean(gamePk, opts) {
    opts = opts || {};
    var fields = 'metaData,timeStamp,gameData,status,abstractGameState,codedGameState,detailedState,statusCode,reason,startTimeTBD,abstractGameCode';
    return getJSON(API_ROOT + '/v1.1/game/' + gamePk + '/feed/live?fields=' + encodeURIComponent(fields), {
      signal: opts.signal, retries: 0,
    });
  }

  /* ----------------------------------------------------- official game state
   *
   * The "capture everything, every second" surfaces.  Two shapes:
   *
   *   gameState(gamePk)
   *     Everything a play-by-play alert needs, in ONE request: metaData (the
   *     feed's own update clock), gameData.status (official status / review
   *     codes), the review + ABS counters, the officials (the umpire crew a
   *     review names), liveData.linescore (score, inning, count, outs,
   *     runners), liveData.plays.currentPlay (the at-bat in progress) and every
   *     completed play's classification.  It deliberately excludes `players`,
   *     `boxscore` and `decisions` — those are the bulk of the 700 KB–1 MB full
   *     feed and cost latency on every poll.  Used by the game page's alert
   *     read and by the replay feed's play-by-play scan.
   *
   *   gameStateLean(gamePk)
   *     The cheap "did anything change at all" read: metaData + status +
   *     linescore + currentPlay (~2–4 KB).  This is what the seconds-level game
   *     state capture polls.
   *
   * Both honour the feed's cache: MLB serves the live feed with max-age=10 and
   * the metaData timeStamp advances with each published update, so callers pass
   * the ttl their cadence needs — the seconds-level capture asks for 1000 ms so
   * it never serves a 10 s-old body back to itself, while a faster alert scan
   * reuses the body it just fetched instead of re-requesting an unchanged feed.
   */
  var EVENT_PLAY_FIELDS = 'allPlays,about,atBatIndex,hasReview,isComplete,inning,halfInning,isTopInning,' +
    'isScoringPlay,result,eventType,description,isOut,rbi,awayScore,homeScore,count,balls,strikes,outs,' +
    'matchup,batter,id,fullName,pitcher,playEvents,details,call,reviewDetails,isOverturned,inProgress,' +
    'reviewType,challengeTeamId,type,startTime,endTime,runners,isScoringEvent,playIndex,movement,index,' +
    'isPitch,pitchNumber,hasOutcome,used,remaining,usedSuccessful,usedFailed';

  /* gameData fields the alert/capture paths read: status, counters, officials,
   * the umpire crew and the two team identities.  No players, no boxscore. */
  var STATE_FIELDS = 'metaData,wait,timeStamp,gameData,game,status,abstractGameState,codedGameState,' +
    'detailedState,statusCode,reason,startTimeTBD,abstractGameCode,review,absChallenges,hasChallenges,' +
    'away,home,used,remaining,usedSuccessful,usedFailed,officials,official,type,fullName,' +
    'teams,datetime,officialDate,gameDate,liveData,linescore,currentInning,currentInningOrdinal,' +
    'inningState,inningHalf,isTopInning,scheduledInnings,balls,strikes,outs,runs,hits,errors,' +
    'leftOnBase,offense,batter,onDeck,inHole,first,second,third,defense,pitcher,catcher,isFinal,' +
    'plays,currentPlay,result,event,eventType,description,about,atBatIndex,isComplete,isScoringPlay,' +
    'halfInning,inning,count,matchup,playEvents,isPitch,call,hasReview,reviewDetails,inProgress,' +
    'isOverturned';

  function gameState(gamePk, opts) {
    opts = opts || {};
    return getJSON(API_ROOT + '/v1.1/game/' + gamePk + '/feed/live?fields=' +
      encodeURIComponent(STATE_FIELDS + ',' + EVENT_PLAY_FIELDS), {
      ttl: opts.ttl || 0, signal: opts.signal, retries: 0, nocache: opts.nocache === true,
    });
  }

  function gameStateLean(gamePk, opts) {
    opts = opts || {};
    return getJSON(API_ROOT + '/v1.1/game/' + gamePk + '/feed/live?fields=' + encodeURIComponent(STATE_FIELDS), {
      ttl: opts.ttl || 0, signal: opts.signal, retries: 0, nocache: opts.nocache === true,
    });
  }

  /* Identity lines for the umpire crew — called once per crew, cached an hour,
   * only for officials actually named in a review.  Never per poll. */
  function peopleBrief(personIds, opts) {
    opts = opts || {};
    var ids = (personIds || []).filter(function (id) { return id; }).join(',');
    if (!ids) return Promise.resolve({ people: [] });
    return getJSON(API_ROOT + '/v1/people?personIds=' + encodeURIComponent(ids), {
      ttl: 3600000, signal: opts.signal, retries: 0,
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

  /* One-line, human-readable request-budget summary for the status lines. */
  function budgetSummary() {
    var used = state.windowCount;
    var waiters = state.waiting ? ' · ' + state.waiting + ' queued' : '';
    return 'API ' + used + '/' + BUDGET_PER_MIN + ' req/min' + waiters +
      (state.leader ? ' · this tab polls' : ' · another tab polls');
  }

  global.MLB = {
    SPORT_ID: SPORT_ID,
    API_ROOT: API_ROOT,
    STATUS_FIELDS: STATUS_FIELDS,
    SCHEDULE_HYDRATE: SCHEDULE_HYDRATE,
    BUDGET_PER_MIN: BUDGET_PER_MIN,
    TAB_ID: TAB_ID,
    getJSON: getJSON,
    budgetSummary: budgetSummary,
    isLeader: isLeader,
    releaseLeader: releaseLeader,
    schedule: schedule,
    scheduleRange: scheduleRange,
    slateStatus: slateStatus,
    gameFeed: gameFeed,
    gameState: gameState,
    gameStateLean: gameStateLean,
    peopleBrief: peopleBrief,
    gameStatusLean: gameStatusLean,
    playByPlay: playByPlay,
    boxscore: boxscore,
    linescore: linescore,
    gameStatusRegistry: gameStatusRegistry,
    peopleStats: peopleStats,
    vsPlayer: vsPlayer,
    quietRemainingMs: quietRemainingMs,
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
