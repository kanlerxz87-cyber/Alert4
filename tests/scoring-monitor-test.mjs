#!/usr/bin/env node
/* tests/scoring-monitor-test.mjs — the Official Scoring Monitor writer and
 * the game-state tracker, end to end against the real shipped modules with a
 * stubbed localStorage (GitHub Pages behavior). No network, no dependencies.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------- shims */
const store = new Map();
const localStorageShim = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear(),
};
globalThis.window = globalThis;
globalThis.self = globalThis;
globalThis.localStorage = localStorageShim;
globalThis.location = { hostname: 'kanlerxz87-cyber.github.io' }; // static host: no server calls
globalThis.fetch = () => Promise.reject(new Error('offline in test'));

const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)));
await load('assets/js/api.js');
await load('assets/js/ui.js');
await load('assets/js/reviews.js');
await load('assets/js/persistent-log.js');
await load('assets/js/scoring-log.js');
await load('assets/js/state-log.js');
await load('assets/js/scoring-monitor.js');
await load('assets/js/state-tracker.js');

const { ScoringMonitor, StateTracker, Reviews } = globalThis;

const failures = [];
const passes = [];
function check(name, condition, detail) {
  if (condition) passes.push(name);
  else failures.push(`${name}${detail ? ' — ' + detail : ''}`);
}

const DATE = '2026-08-28';
const PK = 824638;
const teams = { away: { id: 113, name: 'Cincinnati Reds' }, home: { id: 112, name: 'Chicago Cubs' } };
const teamsAbbr = { away: { abbr: 'CIN' }, home: { abbr: 'CHC' } };

function mkPlay(abi, eventType, description, opts = {}) {
  return {
    about: { atBatIndex: abi, inning: opts.inning || 7, halfInning: 'top', isTopInning: true, isComplete: true, isScoringPlay: !!opts.scoring },
    matchup: {
      batter: { id: 691718, fullName: 'Pete Crow-Armstrong' },
      pitcher: { id: 682825, fullName: 'Luis Mey' },
    },
    count: { balls: 3, strikes: 2, outs: opts.outs === undefined ? 1 : opts.outs },
    playEvents: opts.pitches || [],
    result: {
      eventType,
      event: opts.event || '',
      description,
      isOut: opts.isOut === true,
      rbi: typeof opts.rbi === 'number' ? opts.rbi : 0,
      awayScore: typeof opts.awayScore === 'number' ? opts.awayScore : 0,
      homeScore: typeof opts.homeScore === 'number' ? opts.homeScore : 0,
    },
    runners: [],
  };
}

/* ==================================================== scoring monitor ==== */
{
  ScoringMonitor.beginDate(DATE);
  const plays = [mkPlay(10, 'os_ruling_pending_primary', 'Pete Crow-Armstrong reaches on a sharp grounder to second.', { event: 'Fielding Error' })];
  const pending = Reviews.pendingRulings(plays, { gamePk: PK, teams, feed: null });
  const snapshot = Reviews.snapshotPlays(plays);
  ScoringMonitor.observe({
    date: DATE, gamePk: PK, teams, teamsAbbr, plays,
    diff: { changes: [] }, pending,
  });
  let all = ScoringMonitor.all();
  check('scoring: pending ruling logged', all.length === 1 && all[0].kind === 'pending', JSON.stringify(all.map(e => e.kind)));
  check('scoring: official wording kept verbatim', all[0].before.description === 'Pete Crow-Armstrong reaches on a sharp grounder to second.'
    && all[0].before.eventType === 'os_ruling_pending_primary', JSON.stringify(all[0].before));
  check('scoring: timestamped to the second', typeof all[0].ts === 'number' && all[0].ts > 0 && typeof all[0].lastSeen === 'number');

  /* the scorer resolves it to a single — the diff carries the change */
  const plays2 = [mkPlay(10, 'single', 'Pete Crow-Armstrong singles on a line drive to center fielder Dane Myers.', { event: 'Single', rbi: 1, awayScore: 1 })];
  const diff = Reviews.diffSnapshots(snapshot, Reviews.snapshotPlays(plays2));
  ScoringMonitor.observe({ date: DATE, gamePk: PK, teams, teamsAbbr, plays: plays2, diff, pending: [] });
  all = ScoringMonitor.all();
  const entry = all.find(e => e.id === PK + ':10:scoring');
  check('scoring: pending → resolved on official change', entry && entry.kind === 'pending_resolved'
    && entry.outcome === 'Pending → Resolved', JSON.stringify(entry && { kind: entry.kind, outcome: entry.outcome }));
  check('scoring: before preserved, after recorded verbatim', entry && entry.before.eventType === 'os_ruling_pending_primary'
    && entry.after.eventType === 'single' && entry.after.description.startsWith('Pete Crow-Armstrong singles'),
    JSON.stringify(entry && { before: entry.before.eventType, after: entry.after.eventType }));

  /* an already-scored play reclassified: single → error */
  const snapA = Reviews.snapshotPlays(plays2);
  const plays3 = [mkPlay(10, 'field_error', 'Pete Crow-Armstrong reaches on a throwing error by the second baseman.', { event: 'Fielding Error', rbi: 0 })];
  const diff2 = Reviews.diffSnapshots(snapA, Reviews.snapshotPlays(plays3));
  ScoringMonitor.observe({ date: DATE, gamePk: PK, teams, teamsAbbr, plays: plays3, diff: diff2, pending: [] });
  all = ScoringMonitor.all();
  const resolved = all.find(e => e.id === PK + ':10:scoring');
  check('scoring: reclassified after resolution keeps the ORIGINAL before', resolved && resolved.before.eventType === 'os_ruling_pending_primary'
    && resolved.after.eventType === 'field_error', JSON.stringify(resolved && { b: resolved.before.eventType, a: resolved.after.eventType }));
  check('scoring: full history chain preserved (pending → single → field_error)',
    resolved && Array.isArray(resolved.history) && resolved.history.length === 2
    && resolved.history[0].fromType === 'os_ruling_pending_primary' && resolved.history[0].toType === 'single'
    && resolved.history[1].fromType === 'single' && resolved.history[1].toType === 'field_error',
    JSON.stringify(resolved && resolved.history));

  /* persistence round-trip through localStorage */
  const raw = store.get('mlbp.scoringlog.' + DATE);
  check('scoring: persisted to localStorage', !!raw && JSON.parse(raw).entries.length >= 1, raw ? 'entries=' + JSON.parse(raw).entries.length : 'missing');
}

/* ========================================================= state tracker ==== */
{
  StateTracker.beginDate(DATE);
  const game = {
    gamePk: PK,
    status: { abstractGameState: 'Live', codedGameState: 'I', detailedState: 'In Progress', statusCode: 'I' },
    gameDate: '2026-08-28T18:20:00Z',
    teams: { away: { team: { id: 113, name: 'Cincinnati Reds' }, probablePitcher: { fullName: 'Rhett Lowder' } }, home: { team: { id: 112, name: 'Chicago Cubs' }, probablePitcher: { fullName: 'David Peterson' } } },
    decisions: { winner: { id: 695076, fullName: 'Rhett Lowder' }, loser: { id: 663423, fullName: 'Trent Thornton' }, save: { id: 641941, fullName: 'Emilio Pagán' } },
  };
  const pitch1 = { isPitch: true, pitchNumber: 1, details: { description: 'Called Strike' }, count: { balls: 0, strikes: 1 }, index: 0 };
  const playsLive = [
    {
      about: { atBatIndex: 0, inning: 1, halfInning: 'top', isTopInning: true, isComplete: true },
      matchup: { batter: { id: 9, fullName: 'Batter Zero' }, pitcher: { id: 20, fullName: 'Pitcher One' } },
      count: { balls: 3, strikes: 2, outs: 0 },
      playEvents: [],
      result: { eventType: 'strikeout', description: 'Batter Zero strikes out swinging.', isOut: true, awayScore: 0, homeScore: 0 },
      runners: [],
    },
    {
      about: { atBatIndex: 1, inning: 1, halfInning: 'top', isTopInning: true, isComplete: false },
      matchup: { batter: { id: 10, fullName: 'Batter One' }, pitcher: { id: 20, fullName: 'Pitcher One' } },
      count: { balls: 0, strikes: 1, outs: 0 },
      playEvents: [pitch1],
      result: {},
      runners: [],
    },
  ];
  const r1 = StateTracker.observe({ date: DATE, game, payload: { allPlays: playsLive }, teams, matchupLabel: 'CIN @ CHC' });
  const kinds1 = StateTracker.all().map(e => e.subtype);
  check('state: first live observation emits first pitch + game_start', r1.emitted >= 2
    && kinds1.includes('game_start') && kinds1.includes('pitch'), JSON.stringify(kinds1));

  /* re-observing the same payload emits nothing new */
  const r2 = StateTracker.observe({ date: DATE, game, payload: { allPlays: playsLive }, teams, matchupLabel: 'CIN @ CHC' });
  check('state: no duplicate emissions on identical poll', r2.emitted === 0, String(r2.emitted));

  /* a second pitch appears */
  const pitch2 = { isPitch: true, pitchNumber: 2, details: { description: 'Ball' }, count: { balls: 1, strikes: 1 }, index: 1 };
  const playsLive2 = [playsLive[0], { ...playsLive[1], playEvents: [pitch1, pitch2], count: { balls: 1, strikes: 1, outs: 0 } }];
  const r3 = StateTracker.observe({ date: DATE, game, payload: { allPlays: playsLive2 }, teams, matchupLabel: 'CIN @ CHC' });
  const pitchEvents = StateTracker.all().filter(e => e.subtype === 'pitch');
  check('state: only the new pitch is emitted', r3.emitted === 1 && pitchEvents.length === 2, `emitted=${r3.emitted} pitches=${pitchEvents.length}`);
  check('state: pitch carries official wording + count', pitchEvents.some(e => /Called Strike/.test(e.description)) && pitchEvents.some(e => /Ball/.test(e.description)));

  /* score change: play completes, CIN scores */
  const playsScored = [
    playsLive[0],
    {
      about: { atBatIndex: 1, inning: 1, halfInning: 'top', isTopInning: true, isComplete: true, isScoringPlay: true },
      matchup: { batter: { id: 10, fullName: 'Batter One' }, pitcher: { id: 20, fullName: 'Pitcher One' } },
      count: { balls: 3, strikes: 2, outs: 0 },
      playEvents: [pitch1, pitch2, { isPitch: true, pitchNumber: 3, details: { description: 'In play' }, count: { balls: 3, strikes: 2 }, index: 2 }],
      result: { eventType: 'home_run', event: 'Home Run', description: 'Batter One homers to left center.', isOut: false, rbi: 1, awayScore: 1, homeScore: 0 },
      runners: [{ details: { isScoringEvent: true, playIndex: 2, rbi: true, runner: { fullName: 'Batter One' } }, movement: {} }],
    },
  ];
  StateTracker.observe({ date: DATE, game, payload: { allPlays: playsScored }, teams, matchupLabel: 'CIN @ CHC' });
  const scoreEvents = StateTracker.all().filter(e => e.subtype === 'score_change');
  check('state: score change captured before → after', scoreEvents.length === 1
    && scoreEvents[0].before.away === 0 && scoreEvents[0].after.away === 1
    && /homers/.test(scoreEvents[0].description), JSON.stringify(scoreEvents.map(e => [e.before, e.after])));

  /* game goes final */
  const finalGame = { ...game, status: { abstractGameState: 'Final', codedGameState: 'F', detailedState: 'Final', statusCode: 'F' } };
  StateTracker.observe({ date: DATE, game: finalGame, payload: { allPlays: playsScored }, teams, matchupLabel: 'CIN @ CHC' });
  const finals = StateTracker.all().filter(e => e.subtype === 'game_final');
  check('state: game final captured with official decisions', finals.length === 1 && /Winning pitcher: Rhett Lowder/.test(finals[0].description), JSON.stringify(finals.map(e => e.description)));

  const raw = store.get('mlbp.statelog.' + DATE);
  check('state: persisted to localStorage', !!raw && JSON.parse(raw).entries.length >= 4, raw ? 'entries=' + JSON.parse(raw).entries.length : 'missing');

  /* order of all events: newest first */
  const all = StateTracker.all();
  const sorted = all.every((e, i, arr) => i === 0 || (arr[i - 1].ts || 0) >= (e.ts || 0));
  check('state: timeline sorted newest first', sorted);
}

console.log(`scoring-monitor-test: ${passes.length} passed`);
if (failures.length) {
  console.error(`scoring-monitor-test: ${failures.length} FAILED`);
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('scoring-monitor-test: OK');
