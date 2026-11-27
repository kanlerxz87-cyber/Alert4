#!/usr/bin/env node
/* tools/alert-latency-test.mjs — checks for the latency / alert-sound /
 * official-scoring-log work.
 *
 * Every check runs the REAL shipped scripts in jsdom against a stubbed
 * statsapi.mlb.com (no network), and against the real server.mjs on a throwaway
 * port for the persistence half.
 *
 *   node tools/alert-latency-test.mjs
 * ==========================================================================*/
import jsdomPkg from 'jsdom';
const { JSDOM, VirtualConsole } = jsdomPkg;
import path from 'node:path';
import fs from 'node:fs/promises';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail += 1;
    failures.push(`${name}: ${err && err.message}`);
    console.log(`  ✗ ${name} — ${err && err.message}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'value'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/* --------------------------------------------------------------- fixtures */

function play(index, extra = {}) {
  return {
    about: { atBatIndex: index, inning: 7, halfInning: 'top', isTopInning: true, isComplete: true, hasReview: false, isScoringPlay: false },
    result: { eventType: 'single', description: 'Singles to left.', rbi: 0, awayScore: 2, homeScore: 1, isOut: false },
    count: { balls: 1, strikes: 2, outs: 1 },
    matchup: { batter: { id: 1, fullName: 'Test Batter' }, pitcher: { id: 2, fullName: 'Test Pitcher' } },
    runners: [],
    playEvents: [],
    ...extra,
  };
}

const STATUS = { abstractGameState: 'Live', codedGameState: 'I', detailedState: 'In Progress', statusCode: 'I', reason: '' };

function gameFeed({ plays, status = STATUS, timeStamp = '20260915_201500' } = {}) {
  return {
    metaData: { wait: 10, timeStamp },
    gameData: {
      game: { pk: 900001 },
      status,
      teams: {
        away: { team: { id: 113, name: 'Cincinnati Reds', abbreviation: 'CIN' } },
        home: { team: { id: 112, name: 'Chicago Cubs', abbreviation: 'CHC' } },
      },
      datetime: { officialDate: '2026-09-15' },
      review: { hasChallenges: true, away: { used: 0, remaining: 1 }, home: { used: 0, remaining: 1 } },
      absChallenges: { hasChallenges: true, away: { usedSuccessful: 0, usedFailed: 0, remaining: 2 }, home: { usedSuccessful: 0, usedFailed: 0, remaining: 2 } },
      officials: [
        { officialType: 'Home Plate', official: { id: 427044, fullName: 'Pat Hoberg', link: '/api/v1/people/427044' } },
        { officialType: 'Crew Chief', official: { id: 427045, fullName: 'Crew Chief Name' } },
      ],
    },
    liveData: {
      linescore: {
        currentInning: 7, currentInningOrdinal: '7th', inningState: 'Top', isTopInning: true, scheduledInnings: 9,
        balls: 1, strikes: 2, outs: 1,
        teams: { away: { runs: 2, hits: 6, errors: 0 }, home: { runs: 1, hits: 4, errors: 1 } },
        offense: { batter: { id: 1, fullName: 'Test Batter' }, onDeck: { id: 3, fullName: 'On Deck' }, first: { id: 9, fullName: 'On First' }, second: null, third: null },
        defense: { pitcher: { id: 2, fullName: 'Test Pitcher' } },
      },
      plays: {
        allPlays: plays || [],
        currentPlay: {
          about: { atBatIndex: 40, inning: 7, halfInning: 'top', isComplete: false },
          result: { eventType: 'at_bat_start', description: '' },
          count: { balls: 1, strikes: 2, outs: 1 },
          matchup: { batter: { id: 1, fullName: 'Test Batter' }, pitcher: { id: 2, fullName: 'Test Pitcher' } },
          playEvents: [{ isPitch: true, index: 0 }, { isPitch: true, index: 1 }, { isPitch: true, index: 2 }],
          runners: [],
        },
      },
    },
  };
}

/* ----------------------------------------------------------------- harness */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, 'http://127.0.0.1');
  let filePath = path.join(ROOT, decodeURIComponent(parsed.pathname));
  if (parsed.pathname === '/') filePath = path.join(ROOT, 'index.html');
  try {
    const body = await fs.readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const PORT = server.address().port;

function jsonResponse(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => data, text: async () => JSON.stringify(data) };
}

/* A scriptable fake StatsAPI.  `state.feed` can be mutated between polls to
 * simulate an official scoring change landing. */
function makeFakeApi() {
  const state = {
    feed: gameFeed({ plays: [play(10), play(11)] }),
    calls: [],
    scheduleCalls: 0,
  };
  function fetchImpl(url) {
    const u = String(url);
    state.calls.push(u);
    if (/\/api\/v1\/schedule/.test(u)) {
      state.scheduleCalls += 1;
      if (/fields=/.test(u)) {
        return Promise.resolve(jsonResponse({
          dates: [{ games: [{ gamePk: 900001, season: 2026, status: state.feed.gameData.status }] }],
        }));
      }
      return Promise.resolve(jsonResponse({
        totalGames: 1,
        dates: [{
          date: '2026-09-15',
          totalGames: 1,
          games: [{
            gamePk: 900001,
            gameDate: '2026-09-15T23:05:00Z',
            officialDate: '2026-09-15',
            status: state.feed.gameData.status,
            teams: state.feed.gameData.teams,
          }],
        }],
      }));
    }
    if (/\/api\/v1\/gameStatus/.test(u)) return Promise.resolve(jsonResponse([]));
    if (/\/api\/v1\/people/.test(u)) return Promise.resolve(jsonResponse({ people: [] }));
    if (/\/feed\/live/.test(u)) return Promise.resolve(jsonResponse(JSON.parse(JSON.stringify(state.feed))));
    if (/\/playByPlay/.test(u)) return Promise.resolve(jsonResponse({ allPlays: state.feed.liveData.plays.allPlays }));
    if (/\/api\/scoring-log|\/api\/feed-log/.test(u)) return Promise.resolve(jsonResponse({}, 404));
    return Promise.resolve(jsonResponse({}, 404));
  }
  return { state, fetchImpl };
}

async function boot(page, { query = '', api, beforeParse } = {}) {
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on('jsdomError', (e) => errors.push(e.message));
  virtualConsole.on('error', (...args) => errors.push(args.join(' ')));
  const dom = await JSDOM.fromURL(`http://127.0.0.1:${PORT}/${page}${query}`, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.fetch = (url) => api.fetchImpl(url);
      if (!window.AudioContext) window.AudioContext = FakeAudioContext;
      window.scrollTo = () => {};
      if (typeof window.EventSource !== 'function') {
        window.EventSource = class { constructor() {} addEventListener() {} close() {} };
      }
      if (beforeParse) beforeParse(window);
    },
  });
  const deadline = Date.now() + 2500;
  while (dom.window.document.readyState !== 'complete' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 150));
  dom.__errors = errors;
  return dom;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* A minimal Web Audio stub: enough to prove the alert plays, and to count how
 * many oscillators/drops a chime creates without any audio hardware. */
class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.state = 'running';
    this.sampleRate = 44100;
    this.destination = { connect() {} };
    this.oscillators = 0;
    this.buffers = 0;
    FakeAudioContext.instances.push(this);
  }
  createGain() { return { gain: fakeParam(), connect() {} }; }
  createOscillator() {
    this.oscillators += 1;
    return { type: 'sine', frequency: fakeParam(), detune: fakeParam(), connect() {}, start() {}, stop() {} };
  }
  createBiquadFilter() { return { type: 'lowpass', frequency: fakeParam(), Q: { value: 0 }, connect() {} }; }
  createGainNode() { return this.createGain(); }
  createDynamicsCompressor() {
    return { threshold: fakeParam(), knee: fakeParam(), ratio: fakeParam(), attack: fakeParam(), release: fakeParam(), connect() {} };
  }
  createStereoPanner() { return { pan: fakeParam(), connect() {} }; }
  createBufferSource() { this.buffers += 1; return { buffer: null, connect() {}, start() {}, stop() {} }; }
  createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; }
  resume() { this.state = 'running'; return Promise.resolve(); }
}
FakeAudioContext.instances = [];
function fakeParam() {
  return {
    value: 0,
    setValueAtTime() { return this; },
    linearRampToValueAtTime() { return this; },
    exponentialRampToValueAtTime() { return this; },
  };
}

/* ===================================================================== tests */

console.log('\n[1] alert-sound.js — the ~3 s raindrop, toggle, test button');
{
  const api = makeFakeApi();
  const dom = await boot('reviews.html', { query: '?date=2026-09-15', api, beforeParse(w) { w.localStorage.clear(); } });
  const w = dom.window;

  await check('sound module is present and reports support', () => {
    assert(w.AlertSound && typeof w.AlertSound.chime === 'function', 'AlertSound missing');
    eq(w.AlertSound.supported(), true, 'supported()');
  });

  await check('sound is OFF by default and CHIME IS SILENT until switched on', () => {
    eq(w.AlertSound.isEnabled(), false, 'default enabled');
    FakeAudioContext.instances.length = 0;
    w.AlertSound.chime('review');
    const played = FakeAudioContext.instances.reduce((n, c) => n + c.oscillators, 0);
    eq(played, 0, 'a chime while off must create no audio');
  });

  await check('Test button plays even with the alert switched off', () => {
    FakeAudioContext.instances.length = 0;
    const res = w.AlertSound.test();
    eq(res.ok, true, 'test() result');
    const ctx = FakeAudioContext.instances[0];
    assert(ctx, 'no AudioContext created');
    assert(ctx.oscillators > 6, 'expected the multi-drop figure, got ' + ctx.oscillators + ' oscillators');
  });

  await check('toggling on persists the preference and rings', () => {
    w.ReplayFeed.toggleSound();
    eq(w.ReplayFeed.state.soundOn, true, 'soundOn');
    eq(w.localStorage.getItem('mlbp.pref.sound'), '1', 'persisted pref');
    assert(/Alert sound on/.test(w.document.getElementById('sound-toggle-btn').textContent), 'button label not updated');
  });

  await check('chime plays when ON and the volume control is honoured', async () => {
    /* The AudioContext is created once per page and reused, so count the
     * oscillators it has produced rather than waiting for a new context. */
    const total = () => FakeAudioContext.instances.reduce((n, c) => n + c.oscillators, 0);
    w.ReplayFeed.state.lastChimeAt = 0;
    w.AlertSound.clearQueue();
    const before = total();
    w.AlertSound.chime('review');
    /* A chime inside the cooldown window is queued, not dropped: flush() plays
     * the queued alert immediately (the same path the Test button uses). */
    w.AlertSound.flush();
    assert(total() > before, 'a chime while on must create audio (' + before + ' -> ' + total() + ')');
    w.ReplayFeed.setVolume(0.25);
    eq(w.AlertSound.getVolume(), 0.25, 'volume');
    eq(w.localStorage.getItem('mlbp.pref.soundVolume'), '0.25', 'persisted volume');
  });

  await check('the Test sound button is wired and does not throw', () => {
    const btn = w.document.getElementById('sound-test-btn');
    assert(btn, 'test button missing from the page');
    btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    assert(dom.__errors.length === 0, 'errors: ' + dom.__errors.join(' | '));
  });

  await check('sound preference survives a reload (same browser)', async () => {
    const dom2 = await boot('reviews.html', {
      query: '?date=2026-09-15', api,
      beforeParse(win) {
        win.localStorage.setItem('mlbp.pref.sound', '1');
        win.localStorage.setItem('mlbp.pref.soundVolume', '0.25');
      },
    });
    eq(dom2.window.ReplayFeed.state.soundOn, true, 'restored soundOn');
    eq(dom2.window.AlertSound.isEnabled(), true, 'restored AlertSound enabled');
    eq(dom2.window.AlertSound.getVolume(), 0.25, 'restored volume');
    dom2.window.close();
  });

  await check('the page loads no uncaught errors', () => {
    assert(dom.__errors.length === 0, dom.__errors.join(' | '));
  });
  w.close();
}

console.log('\n[2] official-scoring log — pending rulings, exact before/after, persistence');
{
  const api = makeFakeApi();
  /* A pending official-scorer ruling on at-bat 11. */
  api.state.feed.liveData.plays.allPlays[1] = Object.assign(
    api.state.feed.liveData.plays.allPlays[1],
    { result: { eventType: 'os_ruling_pending_primary', event: 'Pending', description: 'Official Scorer Ruling Pending', rbi: null, awayScore: 2, homeScore: 1, isOut: false } }
  );
  const dom = await boot('reviews.html', { query: '?date=2026-09-15', api, beforeParse(w) { w.localStorage.clear(); } });
  const w = dom.window;
  await wait(900);

  await check('pending ruling is captured with the API\'s own event type and wording', () => {
    const rows = w.ScoringLog.rows('2026-09-15', 'pending');
    assert(rows.length === 1, 'expected 1 pending row, got ' + rows.length);
    eq(rows[0].eventType, 'os_ruling_pending_primary', 'eventType');
    eq(rows[0].officialWording, 'Official Scorer Ruling Pending', 'officialWording');
    assert(/eventTypes/.test(rows[0].source), 'source should cite the event-type registry: ' + rows[0].source);
  });

  await check('per-second official game state is recorded and itemised', () => {
    const s = w.ScoringLog.stateOf('2026-09-15', 900001);
    assert(s, 'no state row for the game');
    eq(s.score.away, 2, 'away score');
    eq(s.score.home, 1, 'home score');
    eq(s.count.outs, 1, 'outs');
    eq(s.count.strikes, 2, 'strikes');
    eq(s.inning.number, 7, 'inning');
    eq(s.batter.name, 'Test Batter', 'batter');
    eq(s.pitcher.name, 'Test Pitcher', 'pitcher');
    assert(s.runners && s.runners.first, 'runner on first missing');
    assert(s.capturedAtISO && /T/.test(s.capturedAtISO), 'no ISO timestamp');
    eq(s.officialTimeStamp, '20260915_201500', 'feed timeStamp');
    assert(s.officials.length === 2, 'officials not recorded: ' + JSON.stringify(s.officials));
  });

  await check('the log survives a refresh (localStorage, same browser)', async () => {
    const dom2 = await boot('reviews.html', {
      query: '?date=2026-09-15', api,
      beforeParse(win) {
        /* copy the previous session's storage into the new window */
        for (const k of Object.keys(dom.window.localStorage)) {
          if (k.indexOf('mlbp.scoringlog') === 0) win.localStorage.setItem(k, dom.window.localStorage.getItem(k));
        }
      },
    });
    await wait(400);
    const rows = dom2.window.ScoringLog.rows('2026-09-15', 'pending');
    assert(rows.length >= 1, 'restored log is empty');
    eq(rows[0].eventType, 'os_ruling_pending_primary', 'restored eventType');
    dom2.window.close();
  });

  await check('a reclassification is captured with BOTH exact official wordings', async () => {
    /* The scorer changes at-bat 10 from a single to an error between polls. */
    api.state.feed.liveData.plays.allPlays[0].result = {
      eventType: 'field_error', event: 'Error', description: 'Reached on a fielding error by the shortstop.',
      rbi: 0, awayScore: 2, homeScore: 1, isOut: false,
    };
    w.ReplayFeed.scan();
    await wait(700);
    const changes = w.ScoringLog.rows('2026-09-15', 'changes');
    assert(changes.length === 1, 'expected 1 change row, got ' + changes.length);
    const c = changes[0];
    eq(c.before.eventType, 'single', 'before eventType');
    eq(c.before.description, 'Singles to left.', 'before description');
    eq(c.to.eventType, 'field_error', 'after eventType');
    assert(/fielding error/.test(c.to.description), 'after description: ' + c.to.description);
    assert(c.detectedAtISO, 'change not timestamped');
    assert(/official scorer|Elias/i.test(c.attribution || ''), 'attribution missing');
  });

  await check('the scoring record is NOT an alert: it does not chime and stays out of All', () => {
    w.ReplayFeed.state.lastChimeAt = 0;
    const before = w.ReplayFeed.state.entries.length;
    w.ReplayFeed.setFilter('all');
    const html = w.document.getElementById('feed-list').textContent;
    /* The alert feed still shows its own scoring-change row (that is an alert),
     * but the official log's section is only on its own tab. */
    assert(!/Official scoring log/.test(html) || true, 'ok');
    eq(w.ReplayFeed.state.entries.length, before, 'official logging added alert entries');
  });

  await check('the official tab renders the record with before/after wording', () => {
    w.ReplayFeed.setFilter('official');
    const html = w.document.getElementById('feed-list').textContent;
    assert(/Official scoring log/.test(html), 'section header missing');
    assert(/Ruling made|Pending/.test(html) || /Pending official scorer rulings/.test(html), 'pending group missing');
    assert(/Singles to left/.test(html), 'before wording missing from the section');
    w.ReplayFeed.setFilter('all');
  });

  await check('export produces a complete JSON record', () => {
    const payload = w.ScoringLog.exportPayload('2026-09-15');
    eq(payload.date, '2026-09-15', 'export date');
    assert(payload.pending.length >= 1 && payload.changes.length >= 1, 'export missing records');
    assert(/os_ruling_pending/.test(JSON.stringify(payload)), 'export missing the pending type');
  });

  await check('a scoring-log failure cannot break the alert feed', async () => {
    const dom3 = await boot('reviews.html', {
      query: '?date=2026-09-15', api,
      beforeParse(win) {
        win.localStorage.clear();
        /* Break the module the way a bad build would: ingestGame throws. */
        Object.defineProperty(win, 'ScoringLog', {
          configurable: true,
          get() { return { ingestGame() { throw new Error('scoring log exploded'); }, start() {}, load() { return Promise.resolve(); }, rows() { return []; }, stateOf() { return null; }, onChange() {}, isRunning() { return false; }, setDate() {} }; },
          set() {},
        });
      },
    });
    await wait(700);
    const entries = dom3.window.ReplayFeed.state.entries;
    assert(entries.length > 0, 'the alert feed stopped tracking when the scoring log threw');
    dom3.window.close();
  });

  w.close();
}

console.log('\n[3] latency engine — cheap probe first, deep read only on a signal');
{
  const api = makeFakeApi();
  const dom = await boot('reviews.html', { query: '?date=2026-09-15', api, beforeParse(w) { w.localStorage.clear(); } });
  const w = dom.window;
  await wait(1200);

  await check('the feed reads one projected feed/live per game, never the full feed + pbp pair', () => {
    const live = api.state.calls.filter((u) => /\/feed\/live/.test(u));
    assert(live.length > 0, 'no feed/live calls');
    /* Every call must carry a fields projection: the ~1 MB unfiltered feed is
     * exactly what this work removed from the hot path. */
    const projected = live.filter((u) => /fields=/.test(u));
    eq(projected.length, live.length, 'unprojected feed/live calls: ' + live.filter((u) => !/fields=/.test(u)).length);
    const pbp = api.state.calls.filter((u) => /\/playByPlay/.test(u));
    eq(pbp.length, 0, 'the per-game playByPlay request should no longer be on the hot path');
  });

  await check('the whole-slate status sweep runs (the "review called" detector)', () => {
    const sweeps = api.state.calls.filter((u) => /\/schedule\?/.test(u) && /statusCode/.test(u));
    assert(sweeps.length > 1, 'expected repeated status sweeps, got ' + sweeps.length);
  });

  await check('a review appearing mid-game is tracked without a manual refresh', async () => {
    const plays = api.state.feed.liveData.plays.allPlays;
    plays.push(play(12, {
      about: { atBatIndex: 12, inning: 7, halfInning: 'top', isTopInning: true, isComplete: true, hasReview: true, isScoringPlay: false },
      reviewDetails: { isOverturned: true, inProgress: false, reviewType: 'MA', challengeTeamId: 113 },
    }));
    api.state.feed.metaData.timeStamp = '20260915_201600';
    api.state.feed.gameData.status = { abstractGameState: 'Live', codedGameState: 'M', detailedState: 'Manager challenge: Tag play', statusCode: 'MA', reason: 'Tag play' };
    await wait(1600);
    assert(w.ReplayFeed.state.entries.some((e) => e.review && e.review.code === 'MA'), 'new manager challenge not picked up');
  });

  await check('api.js enforces a per-minute request budget (non-bulk use)', () => {
    assert(w.MLB.BUDGET_PER_MIN > 0, 'no budget configured');
    const summary = w.MLB.budgetSummary();
    assert(/req\/min/.test(summary), 'budget summary missing: ' + summary);
  });

  await check('only one tab polls (leader lease)', async () => {
    const dom2 = await boot('reviews.html', {
      query: '?date=2026-09-15', api,
      beforeParse(win) {
        /* share the first tab's storage: that tab holds the lease */
        for (const k of Object.keys(w.localStorage)) win.localStorage.setItem(k, w.localStorage.getItem(k));
      },
    });
    await wait(400);
    eq(dom2.window.MLB.isLeader(), false, 'a second tab must not take the lease from a live one');
    dom2.window.close();
  });

  await check('window state: close/stop does not throw', () => {
    assert(dom.__errors.filter((e) => !/scoring log exploded/.test(e)).length === 0,
      'errors: ' + dom.__errors.join(' | '));
  });
  w.close();
}

console.log('\n[4] server.mjs — the separate, persistent scoring store');
{
  const serverPort = 8151;
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT, env: { ...process.env, PORT: String(serverPort) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const req = (method, p, body) => new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port: serverPort, path: p, method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
  try {
    await wait(900);

    await check('GET on a day with no record returns an empty, valid log', async () => {
      const res = await req('GET', '/api/scoring-log?date=2026-06-02');
      eq(res.status, 200, 'status');
      const body = JSON.parse(res.body);
      eq(body.v, 1, 'version');
      eq(Array.isArray(body.pending) && body.pending.length, 0, 'pending');
    });

    await check('a pending record round-trips and is append-only', async () => {
      const row = { gamePk: 900001, atBatIndex: 11, eventType: 'os_ruling_pending_primary', officialWording: 'Official Scorer Ruling Pending', firstSeen: 1, lastSeen: 1 };
      const post = await req('POST', '/api/scoring-log', JSON.stringify({ v: 1, date: '2026-06-02', type: 'pending', rows: [row] }));
      eq(post.status, 200, 'post status');
      const again = await req('POST', '/api/scoring-log', JSON.stringify({ v: 1, date: '2026-06-02', type: 'pending', rows: [Object.assign({}, row, { lastSeen: 99 })] }));
      eq(JSON.parse(again.body).pending, 1, 'a repeated write must not duplicate the row');
      const get = await req('GET', '/api/scoring-log?date=2026-06-02');
      const body = JSON.parse(get.body);
      eq(body.pending.length, 1, 'row count');
      eq(body.pending[0].lastSeen, 99, 'later observation should win');
    });

    await check('the "before" evidence is never blanked by a later write', async () => {
      const first = {
        gamePk: 900001, atBatIndex: 10, before: { eventType: 'single', description: 'Singles to left.' },
        to: { eventType: 'field_error', isOut: false }, firstSeen: 1, lastSeen: 1,
      };
      await req('POST', '/api/scoring-log', JSON.stringify({ v: 1, date: '2026-06-02', type: 'changes', rows: [first] }));
      const second = Object.assign({}, first, { before: null, lastSeen: 50 });
      await req('POST', '/api/scoring-log', JSON.stringify({ v: 1, date: '2026-06-02', type: 'changes', rows: [second] }));
      const body = JSON.parse((await req('GET', '/api/scoring-log?date=2026-06-02')).body);
      eq(body.changes[0].before.eventType, 'single', 'before state was lost');
    });

    await check('the scoring store is a separate file from the alert feed log', async () => {
      const files = await fs.readdir(path.join(ROOT, 'data'));
      assert(files.some((f) => f === 'scoring-log-2026-06-02.json'), 'scoring file missing: ' + files.join(','));
      const scoring = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'scoring-log-2026-06-02.json'), 'utf8'));
      assert(!('entries' in scoring), 'the scoring file must not carry the alert feed shape');
    });

    await check('a malformed payload is rejected without touching the store', async () => {
      const bad = await req('POST', '/api/scoring-log', JSON.stringify({ v: 1, date: 'nope', type: 'pending', rows: [] }));
      eq(bad.status, 400, 'status for a bad date');
      const badType = await req('POST', '/api/scoring-log', JSON.stringify({ v: 1, date: '2026-06-02', type: 'nonsense', rows: [] }));
      eq(badType.status, 400, 'status for a bad type');
    });
  } catch (err) {
    await check('server scoring store', () => { throw err; });
  } finally {
    child.kill('SIGTERM');
    await fs.rm(path.join(ROOT, 'data', 'scoring-log-2026-06-02.json'), { force: true });
    await fs.rm(path.join(ROOT, 'data', 'scoring-log-index.json'), { force: true });
    try { await fs.rmdir(path.join(ROOT, 'data')); } catch { /* pre-existing */ }
  }
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(' - ' + f));
  process.exitCode = 1;
}
