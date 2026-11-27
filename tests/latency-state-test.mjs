#!/usr/bin/env node
/* tests/latency-state-test.mjs — the latency engine, official state capture,
 * the separate scoring log and the alert sound, checked against the real
 * shipped scripts in jsdom.
 *
 *   node tests/latency-state-test.mjs
 *
 * Fixtures are assembled to the SHAPES verified live against the MLB StatsAPI
 * on 2026-11-27 (see docs/latency.md §Verification):
 *
 *   GET /api/v1.1/game/{pk}/feed/live?fields=metaData,timeStamp,wait,...
 *     -> {"metaData":{"wait":10,"timeStamp":"20260828_212805","gameEvents":[...]}}
 *   GET /api/v1.1/game/{pk}/feed/live?fields=liveData,linescore,offense,...&timecode=...
 *     -> {"liveData":{"linescore":{"currentInning":7,...},"plays":{"currentPlay":{...}}}}
 *   GET /api/v1/game/{pk}/playByPlay?fields=allPlays,...
 *     -> {"allPlays":[{"result":{"eventType":"walk",...},"about":{...}}]}
 *
 * Nothing here is mocked except the HTTP layer, and every value in the
 * fixtures is copied from those responses (the two-step revision pair is the
 * real 20260828_204406 -> 20260828_212805 window, trimmed to the fields the
 * page asks for).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let JSDOM;
let VirtualConsole;
for (const candidate of [process.env.JSDOM_PATH, 'jsdom', path.join(ROOT, 'node_modules/jsdom/lib/api.js')]) {
  if (!candidate) continue;
  try {
    const mod = await import(candidate);
    JSDOM = mod.JSDOM || (mod.default && mod.default.JSDOM);
    VirtualConsole = mod.VirtualConsole || (mod.default && mod.default.VirtualConsole);
    if (JSDOM) break;
  } catch { /* try next */ }
}
if (!JSDOM) {
  console.error('latency-state-test: SKIPPED — jsdom is not installed (npm install --no-save jsdom)');
  process.exit(0);
}

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
function text(el) { return (el && el.textContent ? el.textContent : '').replace(/\s+/g, ' ').trim(); }

/* ------------------------------------------------------------------ fixtures */

const TEAMS = {
  away: { team: { id: 113, name: 'Cincinnati Reds', abbreviation: 'CIN' } },
  home: { team: { id: 112, name: 'Chicago Cubs', abbreviation: 'CHC' } },
};

const SCHEDULE = {
  dates: [{
    date: '2026-08-28',
    games: [{
      gamePk: 824638,
      gameDate: '2026-08-28T18:20:00Z',
      officialDate: '2026-08-28',
      status: { abstractGameState: 'Live', codedGameState: 'I', detailedState: 'In Progress', statusCode: 'I' },
      teams: TEAMS,
    }],
  }],
};

/* Revision 1: the real 20260828_204406 document (7th inning, one ball). */
const SNAP_T1 = {
  metaData: { timeStamp: '20260828_204406' },
  gameData: {
    status: { abstractGameState: 'Live', detailedState: 'In Progress', statusCode: 'I' },
    teams: { away: { team: { id: 113, name: 'Cincinnati Reds', abbreviation: 'CIN' } }, home: { team: { id: 112, name: 'Chicago Cubs', abbreviation: 'CHC' } } },
    review: { hasChallenges: true, away: { used: 0, remaining: 1 }, home: { used: 0, remaining: 1 } },
    absChallenges: { hasChallenges: true, away: { usedSuccessful: 0, usedFailed: 0, remaining: 2 }, home: { usedSuccessful: 0, usedFailed: 0, remaining: 2 } },
  },
  liveData: {
    linescore: {
      currentInning: 7, inningState: 'Bottom', isTopInning: false,
      teams: { away: { runs: 9, hits: 12, errors: 0 }, home: { runs: 4, hits: 8, errors: 2 } },
      offense: { batter: { id: 683737, fullName: 'Michael Busch' }, first: { id: 673548, fullName: 'Seiya Suzuki' }, second: { id: 691718, fullName: 'Pete Crow-Armstrong' }, pitcher: { id: 650644, fullName: 'Aaron Civale' } },
      defense: { pitcher: { id: 656271, fullName: 'Brock Burke' } },
      balls: 1, strikes: 0, outs: 2,
    },
    plays: {
      currentPlay: {
        about: { atBatIndex: 68, isComplete: false },
        result: { eventType: 'at_bat_start', description: '' },
        count: { balls: 1, strikes: 0, outs: 2 },
        matchup: { batter: { id: 683737, fullName: 'Michael Busch' }, pitcher: { id: 656271, fullName: 'Brock Burke' } },
      },
    },
  },
};

/* Revision 2: the real 20260828_212805 document — the at-bat ended (flyout,
 * third out) and the game went final.  This is the exact pair of values the
 * live API returned on 2026-11-27. */
const SNAP_T2 = {
  metaData: { timeStamp: '20260828_212805' },
  gameData: {
    status: { abstractGameState: 'Final', detailedState: 'Final', statusCode: 'F' },
    teams: SNAP_T1.gameData.teams,
    review: SNAP_T1.gameData.review,
    absChallenges: { hasChallenges: true, away: { usedSuccessful: 3, usedFailed: 0, remaining: 2 }, home: { usedSuccessful: 5, usedFailed: 0, remaining: 2 } },
  },
  liveData: {
    linescore: {
      currentInning: 9, inningState: 'End', isTopInning: false,
      teams: { away: { runs: 10, hits: 13, errors: 0 }, home: { runs: 8, hits: 11, errors: 1 } },
      offense: { batter: { id: 663538, fullName: 'Nico Hoerner' }, pitcher: { id: 694037, fullName: 'Daniel Palencia' } },
      defense: { pitcher: { id: 694037, fullName: 'Daniel Palencia' } },
      balls: 1, strikes: 1, outs: 3,
    },
    plays: {
      currentPlay: {
        about: { atBatIndex: 87, isComplete: true },
        result: { eventType: 'field_out', event: 'Flyout', description: 'Nico Hoerner flies out to left fielder TJ Friedl.' },
        count: { balls: 1, strikes: 1, outs: 3 },
        matchup: { batter: { id: 663538, fullName: 'Nico Hoerner' }, pitcher: { id: 694037, fullName: 'Emilio Pagán' } },
      },
    },
  },
};

const BOX = {
  teams: {
    away: {
      team: { id: 113 },
      teamStats: { pitching: { numberOfPitches: 173 } },
      players: {
        ID695076: { person: { id: 695076, fullName: 'Rhett Lowder' }, stats: { pitching: { inningsPitched: '6.0', hits: 5, runs: 2, earnedRuns: 2, baseOnBalls: 1, strikeOuts: 7, homeRuns: 1, numberOfPitches: 96, strikes: 61 } } },
        ID656271: { person: { id: 656271, fullName: 'Brock Burke' }, stats: { pitching: { inningsPitched: '0.1', hits: 0, runs: 0, earnedRuns: 0, baseOnBalls: 0, strikeOuts: 0, homeRuns: 0, numberOfPitches: 10, strikes: 7 } } },
        ID668709: { person: { id: 668709, fullName: 'JJ Bleday' }, stats: { batting: { atBats: 4, runs: 1, hits: 2, rbi: 1, baseOnBalls: 0, strikeOuts: 1 } } },
      },
    },
    home: {
      team: { id: 112 },
      teamStats: { pitching: { numberOfPitches: 179 } },
      players: {
        ID694037: { person: { id: 694037, fullName: 'Daniel Palencia' }, stats: { pitching: { inningsPitched: '1.0', hits: 1, runs: 1, earnedRuns: 1, baseOnBalls: 0, strikeOuts: 1, homeRuns: 0, numberOfPitches: 15, strikes: 10 } } },
        ID683737: { person: { id: 683737, fullName: 'Michael Busch' }, stats: { batting: { atBats: 4, runs: 1, hits: 1, rbi: 0, baseOnBalls: 1, strikeOuts: 2 } } },
      },
    },
  },
};

const GAME_STATUS = [
  { statusCode: 'MA', detailedState: 'Manager challenge: Tag play', reason: 'Tag play', abstractGameState: 'Live' },
  { statusCode: 'NH', detailedState: 'Umpire review: Home run', reason: 'Home run', abstractGameState: 'Live' },
];

/* Play-by-play for the game: one completed at-bat, then an official-scorer
 * pending ruling (the API's own event type), then a play whose classification
 * the scorer changes on the second read. */
const PBP_T1 = {
  allPlays: [
    {
      result: { eventType: 'walk', description: 'Dane Myers walks.', rbi: 0, awayScore: 0, homeScore: 0, isOut: false },
      about: { atBatIndex: 0, isComplete: true, hasReview: false, inning: 1, halfInning: 'top' },
      count: { outs: 0 },
      matchup: { batter: { fullName: 'Dane Myers' }, pitcher: { fullName: 'David Peterson' } },
      atBatIndex: 0,
    },
    {
      result: { eventType: 'os_ruling_pending_primary', description: 'Official Scorer Ruling Pending', awayScore: 10, homeScore: 8 },
      about: { atBatIndex: 88, isComplete: true, hasReview: false, inning: 9, halfInning: 'top' },
      count: { outs: 3 },
      matchup: { batter: { fullName: 'Elly De La Cruz' }, pitcher: { fullName: 'Daniel Palencia' } },
      atBatIndex: 88,
    },
  ],
};
const PBP_T2 = JSON.parse(JSON.stringify(PBP_T1));
/* The scorer reclassifies at-bat 0 (walk -> field error after 2026-11-27 the
 * game was re-scored).  Same shape, different classification. */
PBP_T2.allPlays[0].result.eventType = 'field_error';
PBP_T2.allPlays[0].result.description = 'Dane Myers reaches on a fielding error by shortstop.';

/* --------------------------------------------------------------- HTTP layer */

const requested = [];
let phase = 1;              /* 1 = revision 20260828_204406, 2 = 20260828_212805 */
let metaTimecode = '20260828_204406';
const overrides = { meta: null, snapshot: null, pbp: null };

function json(data) {
  return Promise.resolve({
    ok: true, status: 200,
    headers: { get: () => null },
    json: async () => JSON.parse(JSON.stringify(data)),
  });
}

function serve(url) {
  const u = String(url);
  requested.push(u);
  if (u.includes('/gameStatus')) return json(GAME_STATUS);
  if (u.includes('/eventTypes')) return json([{ code: 'field_error', description: 'Field Error' }, { code: 'walk', description: 'Walk' }]);
  if (u.includes('/schedule?')) return json(SCHEDULE);
  if (/\/boxscore/.test(u)) return json(BOX);
  if (/\/playByPlay/.test(u)) return json(overrides.pbp || (phase === 1 ? PBP_T1 : PBP_T2));
  if (/\/feed\/live/.test(u)) {
    /* The meta poll is `fields=metaData,timeStamp,wait,...`; the structured
     * snapshot also starts with metaData, so match the full stamp projection. */
    if (/fields=metaData%2CtimeStamp%2Cwait/.test(u)) {
      return json(overrides.meta || { metaData: { wait: 10, timeStamp: metaTimecode, gameEvents: [], logicalEvents: [] } });
    }
    return json(overrides.snapshot || (phase === 1 ? SNAP_T1 : SNAP_T2));
  }
  if (u.includes('/api/state-log')) return json({ v: 1, date: '2026-08-28', events: [], atBats: [], snapshots: {}, scoring: [] });
  if (u.includes('/api/feed-log')) return json({ v: 1, date: '2026-08-28', entries: [], order: [], snapshots: {}, irregularities: {}, grace: {}, settled: [] });
  return Promise.resolve({ ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, 'http://127.0.0.1');
  const file = path.join(ROOT, decodeURIComponent(parsed.pathname));
  try {
    const body = readFileSync(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const PORT = server.address().port;

async function boot(file, { query = '', beforeParse } = {}) {
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on('jsdomError', (err) => errors.push(err.message));
  const dom = await JSDOM.fromURL(`http://127.0.0.1:${PORT}/${file}${query}`, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.fetch = serve;
      window.AbortController = window.AbortController || class {
        constructor() { this.signal = { aborted: false, addEventListener() {} }; }
        abort() { this.signal.aborted = true; }
      };
      window.scrollTo = () => {};
      if (typeof window.EventSource !== 'function') {
        window.EventSource = class {
          constructor() { this.listeners = {}; }
          addEventListener(n, f) { this.listeners[n] = f; }
          close() {}
        };
      }
      if (beforeParse) beforeParse(window);
    },
  });
  const deadline = Date.now() + 2500;
  while (dom.window.document.readyState !== 'complete' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  await new Promise((r) => setTimeout(r, 150));
  dom.__errors = errors;
  return dom;
}

async function settle(dom, ms = 700) {
  await new Promise((r) => setTimeout(r, ms));
  const st = dom.window.ReplayFeed.state;
  const until = Date.now() + 4000;
  while (st.scanning && Date.now() < until) await new Promise((r) => setTimeout(r, 40));
}

/* Turn the page's automatic loop off so a test controls every read. */
function manual(dom) {
  const st = dom.window.ReplayFeed.state;
  dom.window.clearTimeout(st.timers.scan);
  dom.window.clearInterval(st.timers.sweep);
  st.scanQueued = null;
}

/* --------------------------------------------------------------- pure checks */

console.log('\n[1] latency.js — pacing, timecodes and the state diff (pure)');
{
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window;
  w.eval(readFileSync(path.join(ROOT, 'assets/js/latency.js'), 'utf8'));
  const L = w.Latency;

  await check('single live game polls at 500 ms; 15 games spread the same 10 req/s budget', () => {
    assert(L.metaIntervalMs(1, 0) === 500, 'one game: ' + L.metaIntervalMs(1, 0));
    assert(L.metaIntervalMs(15, 0) === 1500, 'fifteen games: ' + L.metaIntervalMs(15, 0));
    const ratio = L.metaIntervalMs(15, 0) / L.metaIntervalMs(15, 0);
    const rps = 15 / (L.metaIntervalMs(15, 0) / 1000);
    assert(Math.abs(rps - L.META_TARGET_RPS) < 0.01, '15 games should be 10 req/s, got ' + rps);
    assert(ratio === 1, 'sanity');
  });

  await check('a game under review gets double share (half the interval) but never below 500 ms', () => {
    assert(L.metaIntervalMs(1, 1) === 500, 'review floor: ' + L.metaIntervalMs(1, 1));
    assert(L.metaIntervalMs(9, 1) === 500, 'nine games + review: ' + L.metaIntervalMs(9, 1));
    assert(L.metaIntervalMs(15, 2) === 750, 'fifteen games + reviews: ' + L.metaIntervalMs(15, 2));
  });

  await check('parseTimecode reads the official revision stamp as UTC to the second', () => {
    const t = L.parseTimecode('20260828_212805');
    assert(t.valid === true, 'should parse');
    assert(t.iso === '2026-08-28T21:28:05Z', 'iso: ' + t.iso);
    assert(L.parseTimecode('20260828_2128').valid === false, 'short stamp must be invalid');
    assert(L.parseTimecode('20261328_212805').valid === false, 'month 13 must be invalid');
    assert(L.parseTimecode('20260828_246000').valid === false, 'hour 24 must be invalid');
    assert(L.parseTimecode('').valid === false, 'empty must be invalid');
    assert(L.timecodeLabel('20260828_212805') === '21:28:05 UTC', 'label');
    assert(L.timecodeLabel('nope') === '—', 'invalid label must be an em dash, never invented');
  });

  let s1 = null;
  let s2 = null;
  await check('readState normalizes the official payload (count, outs, runners, batters, counters)', () => {
    s1 = L.readState(SNAP_T1, { gamePk: 824638, teams: SNAP_T1.gameData && SNAP_T1.gameData.teams });
    assert(s1.timecode === '20260828_204406', 'stamp');
    assert(s1.time.iso === '2026-08-28T20:44:06Z', 'iso stamp');
    assert(s1.score.away === 9 && s1.score.home === 4, 'score ' + L.scoreLabel(s1));
    assert(s1.balls === 1 && s1.strikes === 0, 'count');
    assert(s1.outs === 2, 'outs');
    assert(s1.bases.first && s1.bases.first.name === 'Seiya Suzuki', 'runner on first');
    assert(s1.bases.second && s1.bases.second.name === 'Pete Crow-Armstrong', 'runner on second');
    assert(s1.bases.third === null, 'third must be empty (never invented)');
    assert(s1.batter.name === 'Michael Busch', 'batter');
    assert(s1.pitcher.name === 'Brock Burke', 'pitcher');
    assert(s1.atBat.index === 68 && s1.atBat.complete === false, 'at-bat');
    assert(s1.counters.manager.away.remaining === 1, 'manager counters');
    assert(s1.counters.abs.home.remaining === 2, 'abs counters');
    assert(s1.lineScore.away.runs === 9 && s1.lineScore.home.hits === 8, 'linescore');
    s2 = L.readState(SNAP_T2, { gamePk: 824638 });
  });

  await check('diffStates produces official before → after wording for the changed fields', () => {
    /* s2 carries the real published counter values (unchanged from s1), so the
     * counter diff is exercised separately below with a counter that moved. */
    const rows = L.diffStates(s1, s2);
    const byKind = {};
    rows.forEach((r) => { byKind[r.kind] = r; });
    assert(byKind.score, 'score change missing');
    assert(byKind.score.label === 'Score: 9–4 → 10–8', 'score label: ' + byKind.score.label);
    assert(byKind.outs && byKind.outs.after === 3, 'outs');
    assert(byKind.status, 'status change missing');
    assert(byKind.status.label === 'Official status: In Progress → Final', 'status: ' + byKind.status.label);
    assert(byKind.inning && /→/.test(byKind.inning.label), 'inning');
    assert(byKind.atbat_complete, 'completed at-bat row missing');
    assert(byKind.atbat_complete.label === 'Nico Hoerner flies out to left fielder TJ Friedl.',
      'the at-bat row must carry MLB\'s own description verbatim');
    assert(byKind.atbat_complete.official.eventType === 'field_out', 'official event type');
  });

  await check('a challenge counter that moved is its own row with official wording', () => {
    /* Shape-only fixture: the counters are set to different values on purpose
     * (the diff, not the values, is what is under test here). */
    const moved = JSON.parse(JSON.stringify(SNAP_T2));
    moved.gameData.absChallenges = {
      hasChallenges: true,
      away: { usedSuccessful: 3, usedFailed: 0, remaining: 1 },
      home: { usedSuccessful: 5, usedFailed: 0, remaining: 2 },
    };
    const s3 = L.readState(moved, { gamePk: 824638 });
    const rows = L.diffStates(s2, s3);
    const row = rows.find((r) => r.kind === 'counters');
    assert(row, 'counter row missing');
    assert(/Challenge counters/.test(row.label), 'label: ' + row.label);
    assert(/CIN/.test(row.label) && /CHC/.test(row.label), 'both teams must be named: ' + row.label);
  });

  await check('buildEvents stamps every row twice: MLB revision and observation time', () => {
    const events = L.buildEvents(824638, s1, s2, null, 'CIN @ CHC');
    assert(events.length >= 5, 'expected several rows, got ' + events.length);
    const score = events.find((e) => e.kind === 'score');
    assert(score.officialTime === '2026-08-28T21:28:05Z', 'official time: ' + score.officialTime);
    assert(score.timecode === '20260828_212805', 'timecode');
    assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(score.observedAt), 'observedAt second resolution');
    assert(score.observedMs > 0, 'observedMs');
    const ids = events.map((e) => e.id);
    assert(new Set(ids).size === ids.length, 'event ids must be unique');
  });

  await check('event ids are deterministic: the same revision never double-logs', () => {
    const a = L.buildEvents(824638, s1, s2, null, 'CIN @ CHC').map((e) => e.id);
    const b = L.buildEvents(824638, s1, s2, null, 'CIN @ CHC').map((e) => e.id);
    assert(JSON.stringify(a) === JSON.stringify(b), 'ids changed between builds');
  });

  await check('readPitchCounts / readPlayerLines read the official box score only', () => {
    const pc = L.readPitchCounts(BOX, { pitcher: { id: 656271, name: 'Brock Burke' }, half: 'bottom' });
    /* Bottom half = home team batting = the away team pitches. */
    assert(pc.away === 173 && pc.home === 179, 'team pitch totals');
    assert(pc.pitcher === 10, 'current pitcher pitches: ' + pc.pitcher);
    assert(pc.lines.pitchers.some((p) => p.name === 'Rhett Lowder' && p.pitches === 96), 'Lowder line');
    assert(pc.lines.batters.some((b) => b.name === 'JJ Bleday' && b.h === 2), 'Bleday line');
    assert(L.readPitchCounts(null, null) === null, 'absent box score -> null, never zero-filled');
  });
}

/* ------------------------------------------------------------ page behaviour */

console.log('\n[2] Replay Feed — two-tier polling (real scripts, fixture shapes)');
const dom = await boot('reviews.html', { query: '?date=2026-08-28' });
await settle(dom);
manual(dom);
const w = dom.window;
const doc = w.document;
const RF = w.ReplayFeed;
const st = RF.state;

await check('the first read hits the few-hundred-byte revision stamp, not the full feed', () => {
  const meta = requested.filter((u) => /feed\/live\?fields=metaData/.test(u));
  assert(meta.length > 0, 'no meta poll was issued');
  const heavy = requested.filter((u) => /fields=metaData%2CtimeStamp%2CgameData/.test(u));
  assert(heavy.length <= 2, 'expected the confirm read only, got ' + heavy.length);
  assert(meta.some((u) => /fields=metaData%2CtimeStamp%2Cwait/.test(u)), 'meta projection is not the documented one');
});

await check('an unchanged stamp does not trigger a parse (that is the latency win)', async () => {
  const before = st.latency.parses;
  const reads = requested.length;
  await RF.scan();
  await settle(dom, 300);
  const newRequests = requested.slice(reads);
  assert(newRequests.length > 0, 'the poll should still run');
  const parsed = newRequests.filter((u) => /playByPlay/.test(u)).length;
  /* The safety re-read is time-based (15 s); a single extra tick must not parse. */
  assert(st.latency.parses - before === 0, 'parsed ' + (st.latency.parses - before) + ' extra time(s) with no new stamp');
  assert(parsed === 0, 'playByPlay was re-fetched ' + parsed + ' time(s) without a new stamp');
});

await check('a changed stamp triggers exactly one confirm read + one parse', async () => {
  phase = 2;
  metaTimecode = '20260828_212805';
  const snapCount = () => requested.filter((u) => /fields=metaData%2CtimeStamp%2CgameData/.test(u)).length;
  const before = { parses: st.latency.parses, snapshots: snapCount() };
  await RF.scan({ force: false });
  await settle(dom, 500);
  assert(st.latency.parses === before.parses + 1, 'parses: expected 1, got ' + (st.latency.parses - before.parses));
  const snaps = snapCount();
  assert(snaps === before.snapshots + 1, 'structured reads: expected 1, got ' + (snaps - before.snapshots));
  assert(st.latency.stampChanges >= 2, 'stamp changes recorded');
});

await check('the captured official state is on the page (score, count, outs, runners, batter, pitcher)', () => {
  const txt = text(doc.getElementById('live-state'));
  assert(/CIN @ CHC/.test(txt), 'matchup missing: ' + txt.slice(0, 120));
  assert(/10–8/.test(txt), 'score missing: ' + txt);
  assert(/9/.test(txt) && /out/i.test(txt), 'outs missing');
  assert(/Nico Hoerner/.test(txt), 'batter missing');
  assert(/Daniel Palencia/.test(txt), 'pitcher missing');
  assert(/rev 21:28:05 UTC/.test(txt), 'official revision stamp missing from the card');
});

await check('every captured change is logged with both timestamps and before/after wording', () => {
  const events = st.stateEvents;
  assert(events.length >= 5, 'expected several state rows, got ' + events.length);
  const score = events.find((e) => e.kind === 'score');
  assert(score, 'no score row');
  assert(score.before === '9–4' && score.after === '10–8', 'before/after: ' + JSON.stringify([score.before, score.after]));
  assert(score.officialTime === '2026-08-28T21:28:05Z', 'official stamp');
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(score.observedAt), 'observed stamp');
  const ab = events.find((e) => e.kind === 'atbat_complete');
  assert(ab && ab.label === 'Nico Hoerner flies out to left fielder TJ Friedl.', 'official at-bat wording');
  const stateLog = text(doc.getElementById('state-log'));
  assert(/Official live game state log/.test(stateLog), 'log section missing');
  assert(/flies out/.test(stateLog), 'at-bat wording missing from the rendered log');
});

await check('the state log is persisted per date and restored after a refresh', async () => {
  const raw = w.localStorage.getItem('mlbp.statelog.2026-08-28');
  assert(raw, 'nothing written to localStorage');
  const parsed = JSON.parse(raw);
  assert(parsed.v === 1 && parsed.date === '2026-08-28',
    'schema: ' + JSON.stringify({ v: parsed.v, date: parsed.date, keys: Object.keys(parsed) }));
  assert(parsed.events.length === st.stateEvents.length,
    'event count: disk ' + parsed.events.length + ' vs ' + st.stateEvents.length);
  assert(parsed.snapshots['824638'] && parsed.snapshots['824638'].timecode === '20260828_212805',
    'latest snapshot: ' + JSON.stringify(parsed.snapshots['824638'] && parsed.snapshots['824638'].timecode));
  assert(parsed.snapshots['824638'].lineScore.away.runs === 10, 'linescore captured');
  assert(parsed.snapshots['824638'].playerLines.pitchers.some((p) => p.name === 'Rhett Lowder'), 'player lines captured');
});

await check('a denied structured read is never recorded as an official observation', async () => {
  /* Regression: a 15-game slate can spend the governor's burst on tier-2
   * reads, and the denied read used to come back as "the official state" with
   * every field null — inventing rows.  Absence must be skipped, not logged. */
  const eventsBefore = st.stateEvents.length;
  const snapsBefore = JSON.stringify(st.stateLog.snapshots['824638'] || {});
  let denied = 0;
  const realFetch = w.fetch;
  w.fetch = (url, opts) => {
    if (/fields=metaData%2CtimeStamp%2CgameData/.test(String(url))) {
      denied += 1;
      const err = new Error('request budget exhausted');
      err.budget = true;
      return Promise.reject(err);
    }
    return realFetch(url, opts);
  };
  metaTimecode = '20260828_212806';
  try {
    await RF.scan({ force: true });
    await settle(dom, 500);
  } finally {
    w.fetch = realFetch;
  }
  assert(denied > 0, 'the harness never denied a structured read');
  assert(st.stateEvents.length === eventsBefore, 'a denied read added ' +
    (st.stateEvents.length - eventsBefore) + ' state row(s)');
  assert(JSON.stringify(st.stateLog.snapshots['824638'] || {}) === snapsBefore,
    'a denied read overwrote the stored official snapshot');
  assert(!st.stateEvents.some((e) => /null/.test(String(e.after))), 'a null observation was logged');
});

await check('the scoring section logs the pending ruling and the reclassification separately', () => {
  const scoring = st.stateLog.scoring || [];
  const pending = scoring.find((r) => r.kind === 'scoring_pending');
  const change = scoring.find((r) => r.kind === 'scoring_change');
  assert(pending, 'pending ruling row missing: ' + JSON.stringify(scoring.map((r) => r.kind)));
  assert(pending.before === 'Official Scorer Ruling Pending', 'pending official description');
  assert(change, 'scoring-change row missing');
  assert(change.beforeEventType === 'walk' && change.afterEventType === 'field_error',
    'before/after classification: ' + JSON.stringify([change.beforeEventType, change.afterEventType]));
  assert(change.before === 'Dane Myers walks.' && /fielding error/.test(change.after), 'official wording before/after');
  const txt = text(doc.getElementById('scoring-section'));
  assert(/Official scoring pending/.test(txt), 'section heading missing');
  assert(/Initial call/.test(txt) && /Final ruling/.test(txt), 'before/after labels missing: ' + txt.slice(0, 200));
});

await check('scoring rows never chime: the two pipelines are independent', async () => {
  const before = st.lastChimeAt;
  /* Re-render after clearing the alert entries: nothing may sound. */
  st.entries = [];
  RF.setFilter('all');
  assert(st.lastChimeAt === before, 'rendering the scoring log changed the alert state');
  const alertLog = JSON.parse(w.localStorage.getItem('mlbp.feedlog.2026-08-28') || '{"entries":[]}');
  assert(!(alertLog.entries || []).some((e) => e.kind === 'state_event' || e.kind === 'state'),
    'state rows must not be written into the alert log');
});

console.log('\n[3] Restart — a refresh restores the log instead of losing it');
{
  const dom2 = await boot('reviews.html', { query: '?date=2026-08-28', beforeParse(win) {
    win.localStorage.setItem('mlbp.statelog.2026-08-28', w.localStorage.getItem('mlbp.statelog.2026-08-28'));
  } });
  await settle(dom2);
  manual(dom2);
  await check('restored rows render before any new read lands', () => {
    const txt = text(dom2.window.document.getElementById('state-log'));
    assert(/Official live game state log/.test(txt), 'state log missing after restart');
    assert(/flies out|Score: 9–4/.test(txt), 'restored rows missing: ' + txt.slice(0, 240));
    const restored = dom2.window.ReplayFeed.state.stateEvents;
    const disk = JSON.parse(w.localStorage.getItem('mlbp.statelog.2026-08-28')).events.map((e) => String(e.id));
    assert(restored.length >= 5, 'restored event count: ' + restored.length);
    const fromDisk = restored.filter((e) => disk.indexOf(String(e.id)) !== -1);
    assert(fromDisk.length >= 5, 'rows from disk did not come back: ' + fromDisk.length);
    assert(fromDisk.every((e) => e.restored === true),
      'persisted rows must be marked restored (never re-chimed)');
  });
  await check('restoring the log does not fire an alert', () => {
    assert(dom2.window.ReplayFeed.state.lastChimeAt === 0, 'a chime fired on restore');
  });
  dom2.window.close();
}

console.log('\n[4] Alert sound — the on/off toggle and the Test control');
{
  const sdom = await boot('reviews.html', { query: '?date=2026-08-28' });
  await settle(sdom);
  manual(sdom);
  const sw = sdom.window;
  const sd = sw.document;

  await check('the sound controls are self-describing before any click', () => {
    const note = text(sd.getElementById('sound-test-note'));
    assert(/Alerts are OFF/.test(note), 'no contract line on first paint: ' + note);
    assert(/Test/.test(note), 'the note should point at the Test control: ' + note);
    const btn = sd.getElementById('sound-toggle-btn');
    assert(/Sound Off/.test(btn.textContent), 'button label: ' + btn.textContent);
    assert(btn.getAttribute('aria-pressed') === 'false', 'aria-pressed');
  });

  await check('toggle is off by default, flips on/off and persists the preference', () => {
    assert(sw.ReplayFeed.state.soundOn === false, 'sound must start off');
    sd.getElementById('sound-toggle-btn').dispatchEvent(new sw.MouseEvent('click', { bubbles: true }));
    assert(sw.ReplayFeed.state.soundOn === true, 'toggle did not turn on');
    assert(sw.AlertSound.isEnabled() === true, 'AlertSound not enabled');
    assert(sw.localStorage.getItem('mlbp.pref.sound') === '1', 'preference not saved');
    assert(/Sound On/.test(sd.getElementById('sound-toggle-btn').textContent), 'button label');
    sd.getElementById('sound-toggle-btn').dispatchEvent(new sw.MouseEvent('click', { bubbles: true }));
    assert(sw.ReplayFeed.state.soundOn === false, 'toggle did not turn off');
    assert(sw.localStorage.getItem('mlbp.pref.sound') === '0', 'off preference not saved');
  });

  await check('the Test button fires the alert while Sound is OFF (proves the system works)', () => {
    /* A headless jsdom has no audio device, so assert on the alert pipeline:
     * the test must reach AlertSound and report either a scheduled tone or an
     * honest "no audio here" — never nothing. */
    sw.AlertSound.state.plays = 0;
    sw.AlertSound.state.attempts = 0;
    sd.getElementById('sound-test-btn').dispatchEvent(new sw.MouseEvent('click', { bubbles: true }));
    const S = sw.AlertSound.state;
    assert(S.plays + S.attempts === 1, 'the test never reached the audio layer');
    const note = text(sd.getElementById('sound-test-note'));
    assert(/Test alert|No audio/.test(note), 'no feedback: ' + note);
    assert(/raindrop|blocked|Web Audio/.test(note), 'feedback should name the tone or the reason: ' + note);
  });

  await check('the tone is a ~3 s raindrop under a hard gain ceiling', () => {
    const S = sw.AlertSound;
    assert(S.LENGTH_S >= 2.8 && S.LENGTH_S <= 3.2, 'length ' + S.LENGTH_S);
    assert(S.MASTER_PEAK <= 0.2, 'peak gain ' + S.MASTER_PEAK);
    const drops = S.PRESETS.review.drops;
    assert(drops.length >= 4, 'a raindrop needs several drops');
    drops.forEach((d) => assert(d[1] <= 4000, 'partial above 4 kHz: ' + d[1]));
    assert(S.PRESETS.preview.drops.length > 0, 'preview preset');
  });

  await check('alerts are off means silent: the alert path never reaches the audio layer', async () => {
    const S = sw.AlertSound.state;
    const before = { plays: S.plays, attempts: S.attempts, chime: sw.ReplayFeed.state.lastChimeAt };
    sw.ReplayFeed.state.soundOn = false;
    await sw.ReplayFeed.scan({ force: true });
    await settle(sdom, 400);
    assert(S.plays === before.plays && S.attempts === before.attempts,
      'the audio layer was touched while Sound was Off');
    assert(sw.ReplayFeed.state.lastChimeAt === before.chime, 'the alert path fired while Sound was Off');
  });
  sdom.window.close();
}

console.log('\n[5] Pacing — a big slate stays inside the shared request budget');
{
  const L = w.Latency;
  await check('worst case (15 live games) is ≤ 10 meta polls/s and a full minute is ≤ 2400 requests', () => {
    const perGameMs = L.metaIntervalMs(15, 0);
    const rps = 15 / (perGameMs / 1000);
    assert(rps <= L.META_TARGET_RPS + 0.001, rps + ' req/s');
    const worstPerMinute = rps * 60 + 1;      /* + the once-a-minute schedule read */
    assert(worstPerMinute <= 620, 'meta requests/min: ' + worstPerMinute);
    assert(w.MLB.BUDGET.maxPerWindow === 2400, 'rolling-minute cap');
    assert(w.MLB.BUDGET.refillPerSec === 20, 'token rate');
  });
}

server.close();
console.log(`\nlatency-state-test: ${pass} passed, ${fail} failed`);
/* jsdom keeps timers/audio handles alive; the suite is done, so exit with a
 * code the runner can trust instead of lingering. */
process.exit(fail ? 1 : 0);
if (fail) {
  console.log('Failures:\n' + failures.map((f) => ' - ' + f).join('\n'));
  process.exit(1);
}
