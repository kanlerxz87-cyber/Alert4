/* ============================================================================
 * api.js — MLB StatsAPI client (latency-optimised, TOS-aware)
 *
 * One place for every network call the site makes:
 *   1. fetch wrapper with timeout, retry, response cache, HTTP-429 handling,
 *      a concurrency governor, request deduplication and latency tracking
 *   2. endpoint helpers (schedule, feed/live, playByPlay, gameStatus, people stats)
 *   3. small date/number formatters shared by the pages
 *
 * The StatsAPI is keyless and sends CORS headers, so a static GitHub Pages site
 * can call it straight from the browser.  Endpoint list + `fields` projections
 * follow the ones documented in README.md §"How it works".
 *
 * Latency strategy (fastest feed within the API's Terms of Service):
 *   - The lean slate-status sweep (GET /api/v1/schedule with a `fields`
 *     projection, ~2.4 KB for the whole day) is the fastest signal that a
 *     review/challenge has been called: MLB flips `status.statusCode` the
 *     instant a review is called, while play text is written at resolution.
 *     The sweep runs every 125 ms while any game is live and triggers an
 *     out-of-band playByPlay fetch for the flipped game only.
 *   - Play-by-play updates use the lean /playByPlay endpoint with a tight
 *     `fields` projection (not the 1–2 MB full feed/live) so each poll is
 *     small and fast. Live games are staggered; review games poll fastest.
 *   - A governor caps concurrency (6) and spaces request starts, dedupes
 *     identical in-flight URLs, caches static registries for an hour, and
 *     honours HTTP 429 + Retry-After with a quiet period and adaptive
 *     backoff. Polling pauses while the tab is hidden. Together this keeps
 *     the sustained rate well under the host's throttling threshold while
 *     still surfacing a new review in ~125 ms + one round trip.
 *   - Every request is timed; MLB.perf() exposes last/p50/p95 latency and
 *     the request rate so the Replay Feed can display live latency.
 *
 * TOS compliance: only public, keyless StatsAPI endpoints are used; no
 * authentication, no scraping of mlb.com pages, no redistribution of raw
 * payloads beyond the browser's own view. The client respects 429s,
 * caches aggressively where the data is static, and never retries a 429
 * inside the quiet window. See reviews.html footer + docs/ for the budget.
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

  var state = {
    quietUntil: 0,
    lastError: null,
    lastOK: 0,
    requests: 0,
    cacheHits: 0,
    lastLatencyMs: 0,
    latencySamples: [],
    totalLatencyMs: 0,
    deduped: 0,
    queued: 0,
  };

  var cache = Object.create(null);
  var CACHE_MAX_ENTRIES = 240;

  /* --- request governor (TOS budget) -------------------------------------
   * Caps concurrent fetches and spaces starts so a 15-game slate cannot
   * burst into a 429. High-priority calls (the 125 ms status sweep) jump
   * the queue ahead of bulk playByPlay polls. Identical in-flight URLs
   * share one promise (dedupe) instead of hitting the API twice.
   *
   * On top of the concurrency/interval limits there is a *sustained* token
   * bucket: no more than GOV_RATE_RPS requests may start in any one-second
   * window (plus a small burst allowance). A single game only needs a few
   * requests per second, so the ceiling is never felt in normal use; on a
   * full 15-game slate it keeps the client a good citizen instead of
   * hammering the public host. The measured rate is surfaced by perf()
   * and drawn in the Replay Feed's "Latency & API budget" panel. */
  var GOV_MAX_CONCURRENT = 6;
  var GOV_MIN_INTERVAL_MS = 25;
  var GOV_RATE_RPS = 40;
  var GOV_BURST = 60;
  var governor = {
    active: 0,
    queue: [],
    inFlight: Object.create(null),
    lastStartAt: 0,
    backoff: 1,
    tokens: GOV_BURST,
    lastRefillAt: 0,
    starts: [],
  };

  function refillTokens() {
    var t = now();
    if (!governor.lastRefillAt) { governor.lastRefillAt = t; return; }
    var elapsed = t - governor.lastRefillAt;
    if (elapsed <= 0) return;
    governor.lastRefillAt = t;
    governor.tokens = Math.min(GOV_BURST, governor.tokens + (elapsed / 1000) * GOV_RATE_RPS);
  }

  function tokenWaitMs() {
    refillTokens();
    if (governor.tokens >= 1) return 0;
    return Math.ceil(((1 - governor.tokens) / GOV_RATE_RPS) * 1000);
  }

  function recordStart() {
    var t = now();
    governor.starts.push(t);
    while (governor.starts.length && t - governor.starts[0] > 1000) governor.starts.shift();
  }

  function requestsPerSecond() {
    var t = now();
    while (governor.starts.length && t - governor.starts[0] > 1000) governor.starts.shift();
    return governor.starts.length;
  }

  function governorAcquire(priority) {
    return new Promise(function (resolve) {
      function tryGrant() {
        var waitForInterval = GOV_MIN_INTERVAL_MS * governor.backoff - (now() - governor.lastStartAt);
        var waitForToken = tokenWaitMs();
        if (governor.active < GOV_MAX_CONCURRENT && waitForInterval <= 0 && waitForToken <= 0) {
          refillTokens();
          governor.tokens -= 1;
          governor.active += 1;
          governor.lastStartAt = now();
          recordStart();
          resolve();
          return;
        }
        var delay = Math.max(5, waitForInterval > 0 ? waitForInterval : (waitForToken > 0 ? waitForToken : 10));
        setTimeout(tryGrant, delay);
      }
      if (priority === 'high' && governor.queue.length) {
        governor.queue.unshift(tryGrant);
      } else {
        governor.queue.push(tryGrant);
      }
      state.queued += 1;
      /* Drain the head of the queue immediately if a slot is free. */
      var head = governor.queue.shift();
      if (head) head();
    });
  }

  function governorRelease() {
    governor.active = Math.max(0, governor.active - 1);
    var next = governor.queue.shift();
    if (next) next();
  }

  function recordLatency(ms) {
    state.lastLatencyMs = Math.round(ms);
    state.totalLatencyMs += ms;
    state.latencySamples.push(ms);
    if (state.latencySamples.length > 120) state.latencySamples.shift();
  }

  function percentile(sorted, p) {
    if (!sorted.length) return 0;
    var idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return Math.round(sorted[idx]);
  }

  function perf() {
    var sorted = state.latencySamples.slice().sort(function (a, b) { return a - b; });
    var avg = state.latencySamples.length
      ? Math.round(state.totalLatencyMs / state.latencySamples.length) : 0;
    return {
      requests: state.requests,
      cacheHits: state.cacheHits,
      deduped: state.deduped,
      queued: state.queued,
      lastLatencyMs: state.lastLatencyMs,
      avgLatencyMs: avg,
      p50LatencyMs: percentile(sorted, 50),
      p95LatencyMs: percentile(sorted, 95),
      quietRemainingMs: quietRemainingMs(),
      backoff: governor.backoff,
      active: governor.active,
      maxConcurrent: GOV_MAX_CONCURRENT,
      minIntervalMs: GOV_MIN_INTERVAL_MS,
      rateLimitRps: GOV_RATE_RPS,
      requestsPerSecond: requestsPerSecond(),
      tokensLeft: Math.floor(governor.tokens),
    };
  }

  function tosBudget() {
    var p = perf();
    return {
      requests: p.requests,
      cacheHits: p.cacheHits,
      deduped: p.deduped,
      lastLatencyMs: p.lastLatencyMs,
      p50LatencyMs: p.p50LatencyMs,
      p95LatencyMs: p.p95LatencyMs,
      quietRemainingMs: p.quietRemainingMs,
      maxConcurrent: p.maxConcurrent,
      minIntervalMs: p.minIntervalMs,
      rateLimitRps: p.rateLimitRps,
      requestsPerSecond: p.requestsPerSecond,
      note: 'Public StatsAPI only; 429 + Retry-After honoured; sustained ceiling ' +
        p.rateLimitRps + ' req/s; static registries cached 1h; polling pauses when tab hidden.',
    };
  }

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

  /**
   * getJSON(url, opts)
   *   opts.ttl      cache lifetime in ms (0 = no cache, the default)
   *   opts.retries  extra attempts after a failed one (default 1)
   *   opts.signal   external AbortSignal (poll loops use it to cancel)
   *   opts.keepQuiet  bypass the 429 quiet window (used by the quiet probe only)
   *   opts.priority 'high' jumps the governor queue (status sweep); default 'normal'
   */
  function getJSON(url, opts) {
    opts = opts || {};
    var ttl = opts.ttl || 0;
    var retries = typeof opts.retries === 'number' ? opts.retries : 1;
    var priority = opts.priority || 'normal';

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

    /* Dedupe: an identical URL already in flight shares its promise. */
    if (!ttl && governor.inFlight[url]) {
      state.deduped += 1;
      return governor.inFlight[url];
    }

    var attempt = 0;
    var startedAt = 0;

    function once() {
      attempt += 1;
      state.requests += 1;
      startedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : now();

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
          governor.backoff = Math.min(8, governor.backoff * 2);
          throw ApiError('StatsAPI asked to slow down (HTTP 429); pausing ' + Math.round(wait / 1000) + 's', 429, url);
        }
        if (!res.ok) throw ApiError('HTTP ' + res.status + ' from ' + url, res.status, url);
        return res.json();
      }).then(function (data) {
        clearTimeout(timer);
        var endedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : now();
        recordLatency(endedAt - startedAt);
        governor.backoff = Math.max(1, governor.backoff * 0.9);
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

    var promise = governorAcquire(priority).then(once).then(
      function (data) {
        governorRelease();
        if (!ttl) delete governor.inFlight[url];
        return data;
      },
      function (err) {
        governorRelease();
        if (!ttl) delete governor.inFlight[url];
        throw err;
      }
    );
    if (!ttl) governor.inFlight[url] = promise;
    return promise;
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
    }), { ttl: opts.ttl || 0, signal: opts.signal, retries: opts.retries, priority: opts.priority });
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
      priority: 'high',
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

  global.MLB = {
    SPORT_ID: SPORT_ID,
    API_ROOT: API_ROOT,
    STATUS_FIELDS: STATUS_FIELDS,
    SCHEDULE_HYDRATE: SCHEDULE_HYDRATE,
    getJSON: getJSON,
    schedule: schedule,
    scheduleRange: scheduleRange,
    slateStatus: slateStatus,
    gameFeed: gameFeed,
    gameStatusLean: gameStatusLean,
    playByPlay: playByPlay,
    boxscore: boxscore,
    linescore: linescore,
    gameStatusRegistry: gameStatusRegistry,
    peopleStats: peopleStats,
    vsPlayer: vsPlayer,
    quietRemainingMs: quietRemainingMs,
    perf: perf,
    tosBudget: tosBudget,
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
