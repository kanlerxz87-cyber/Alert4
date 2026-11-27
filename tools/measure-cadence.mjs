#!/usr/bin/env node
/* ============================================================================
 * tools/measure-cadence.mjs — measure what the Replay Feed actually requests
 *
 * Boots the REAL reviews.html with the REAL shipped scripts in jsdom, answers
 * every request from a synthetic 15-game slate with one live review, and prints
 * the request rate per second and per surface.  Use it to check that a change
 * to the polling cadence stays inside the budget in assets/js/api.js.
 *
 *   node tools/measure-cadence.mjs            # 8 seconds, 15 games
 *   node tools/measure-cadence.mjs 12 8       # 12 seconds, 8 games
 *
 * No network: every response is synthesised in the shapes the official payloads
 * use.  This measures OUR cadence, not MLB's latency.
 * ==========================================================================*/
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let JSDOM;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const candidate of [process.env.JSDOM_PATH, 'jsdom', path.join(ROOT, 'node_modules/jsdom/lib/api.js')]) {
  if (!candidate) continue;
  try {
    const mod = await import(candidate);
    JSDOM = mod.JSDOM || (mod.default && mod.default.JSDOM);
    if (JSDOM) break;
  } catch { /* next */ }
}
if (!JSDOM) {
  console.error('measure-cadence: SKIPPED — jsdom is not installed (npm install --no-save jsdom)');
  process.exit(0);
}

const SECONDS = Number(process.argv[2]) || 8;
const GAMES = Number(process.argv[3]) || 15;
const DATE = '2026-04-07';
const TC = '20260407_182231';

const games = Array.from({ length: GAMES }, (_, i) => ({
  gamePk: 820000 + i,
  status: { abstractGameState: 'Live', statusCode: i === 0 ? 'MA' : 'I', detailedState: i === 0 ? 'Manager challenge: Tag play' : 'In Progress' },
  teams: {
    away: { team: { id: 136, name: 'Mariners' }, score: 2 },
    home: { team: { id: 142, name: 'Twins' }, score: 3 },
  },
}));

const play = {
  about: { atBatIndex: 4, inning: 6, halfInning: 'top', isComplete: true, hasReview: true },
  result: { eventType: 'single', description: 'Singles.', awayScore: 2, homeScore: 3, isOut: false },
  count: { balls: 1, strikes: 2, outs: 1 },
  matchup: { batter: { id: 11, fullName: 'Test Batter' }, pitcher: { id: 22, fullName: 'Test Pitcher' } },
  reviewDetails: { isOverturned: true, inProgress: false, reviewType: 'MA', challengeTeamId: 136 },
  runners: [], playEvents: [],
};

const linescore = {
  currentInning: 6, isTopInning: true, outs: 1, balls: 1, strikes: 2,
  teams: { away: { runs: 2 }, home: { runs: 3 } },
  offense: { batter: { id: 11, fullName: 'Test Batter' } },
  defense: { pitcher: { id: 22, fullName: 'Test Pitcher' } },
};

function respond(url) {
  const u = String(url);
  const decoded = decodeURIComponent(u);
  if (u.includes('/eventTypes')) return [];
  if (u.includes('/gameStatus')) return [{ statusCode: 'MA', reason: 'Tag play', detailedState: 'Manager challenge: Tag play' }];
  if (u.includes('/schedule')) return { dates: [{ games }] };
  if (decoded.includes('linescore')) {
    return {
      metaData: { timeStamp: TC },
      gameData: { game: { pk: 1 }, status: games[0].status, review: { hasChallenges: true, away: { used: 1, remaining: 0 }, home: { used: 0, remaining: 1 } } },
      liveData: { linescore, plays: { currentPlay: null } },
    };
  }
  if (decoded.includes('metaData')) return { metaData: { timeStamp: TC } };
  if (u.includes('/playByPlay')) return { allPlays: [play] };
  return {};
}

const page = readFileSync(path.join(ROOT, 'reviews.html'), 'utf8');
const scripts = [...page.matchAll(/<script\b[^>]*src\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
const html = page.replace(/<script\b[^>]*src\s*=\s*"[^"]+"[^>]*><\/script>/g, '');

const dom = new JSDOM(html, {
  url: `https://kanlerxz87-cyber.github.io/Alert4/reviews.html?date=${DATE}`,
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const w = dom.window;
const log = [];
w.fetch = (url) => {
  const u = String(url);
  const decoded = decodeURIComponent(u);
  const kind = decoded.includes('linescore') ? 'feed(state+counters)'
    : decoded.includes('metaData') ? 'probe'
      : u.includes('/playByPlay') ? 'playByPlay'
        : u.includes('/schedule') ? 'schedule'
          : u.includes('/eventTypes') || u.includes('/gameStatus') ? 'reference' : 'other';
  log.push([Date.now(), kind]);
  return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => respond(url) });
};
for (const s of scripts) w.eval(readFileSync(path.join(ROOT, s), 'utf8'));
w.document.dispatchEvent(new w.Event('DOMContentLoaded'));

await new Promise((r) => setTimeout(r, SECONDS * 1000));

const t0 = log[0][0];
const total = log.filter(([t]) => t - t0 > 500).length;
const span = (log[log.length - 1][0] - t0 - 500) / 1000;
const perKind = {};
for (const [, kind] of log) perKind[kind] = (perKind[kind] || 0) + 1;
const buckets = {};
for (const [t, kind] of log) {
  const b = Math.floor((t - t0) / 1000);
  if (!buckets[b]) buckets[b] = { total: 0, byKind: {} };
  buckets[b].total += 1;
  buckets[b].byKind[kind] = (buckets[b].byKind[kind] || 0) + 1;
}

const usage = w.MLB.usageStats();
console.log(`measure-cadence: ${GAMES} live games, ${SECONDS}s\n`);
console.log('per second   total  ' + Object.keys(perKind).map((k) => k.padStart(20)).join(''));
for (const b of Object.keys(buckets)) {
  const row = buckets[b];
  const cells = Object.keys(perKind).map((k) => String((row.byKind[k] || 0)).padStart(20));
  console.log(`  ${String(b).padStart(6)}     ${String(row.total).padStart(5)}  ${cells.join('')}`);
}
console.log('\ntotals       total  ' + Object.keys(perKind).map((k) => k.padStart(20)).join(''));
console.log('             ' + String(total).padStart(5) + '  ' + Object.keys(perKind).map((k) => String(perKind[k]).padStart(20)).join(''));
console.log(`\nsteady state : ${(total / Math.max(1, span)).toFixed(1)} req/s`);
console.log(`gate ceiling : ${usage.ceiling} req/s, ${w.MLB.RATE.maxConcurrent} concurrent`);
console.log(`live figure  : ${usage.perSecond} req/s in the last second (as the page reports it)`);
console.log(`probe interval: ${w.MLB.probeIntervalFor(GAMES, 8)} ms per game at this slate size`);
process.exit(0);
