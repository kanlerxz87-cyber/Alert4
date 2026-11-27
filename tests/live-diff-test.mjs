#!/usr/bin/env node
/* tests/live-diff-test.mjs — RFC 6902 engine (asset json-patch.js) and the
 * feed/live diffPatch tracker (asset live-diff.js), verified against the
 * shapes observed on the official endpoint. No network, no dependencies.
 *
 * The embedded patch fragment was captured from the official
 *   GET /api/v1.1/game/824638/feed/live/diffPatch?startTimecode=20260828_203856&endTimecode=20260828_203907
 * on 2026-11-27 (game 824638, Top 7, CIN @ CHC) — see docs/latency-and-tos.md.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.window = globalThis;
globalThis.self = globalThis;

const patchModule = await import(pathToFileURL(path.join(ROOT, 'assets', 'js', 'json-patch.js')));
const JsonPatch = globalThis.JsonPatch || patchModule;
const diffModule = await import(pathToFileURL(path.join(ROOT, 'assets', 'js', 'live-diff.js')));
const LiveDiff = globalThis.LiveDiff || diffModule;

const failures = [];
const passes = [];
function check(name, condition, detail) {
  if (condition) passes.push(name);
  else failures.push(`${name}${detail ? ' — ' + detail : ''}`);
}

/* ----------------------------------------------------------- json-patch core */
{
  const doc = { metaData: { timeStamp: '20260828_203856', logicalEvents: ['field_out', 'game_finished'] }, count: 2 };
  JsonPatch.apply(doc, [
    { op: 'replace', path: '/metaData/timeStamp', value: '20260828_203907' },
    { op: 'add', path: '/metaData/logicalEvents/3', value: 'runnersOnFirstAndThird' }, // observed: appends
    { op: 'add', path: '/count', value: 3 },
  ]);
  check('patch: replace + append-beyond-length + add', doc.metaData.timeStamp === '20260828_203907'
    && doc.metaData.logicalEvents.length === 3
    && doc.metaData.logicalEvents[2] === 'runnersOnFirstAndThird'
    && doc.count === 3, JSON.stringify(doc));
}
{
  const doc = { a: { b: [10, 20, 30] }, keep: 'x' };
  JsonPatch.apply(doc, [
    { op: 'add', path: '/a/b/1', value: 99 },
    { op: 'remove', path: '/a/b/0' },
    { op: 'test', path: '/keep', value: 'x' },
  ]);
  check('patch: insert semantics + remove + test',
    JSON.stringify(doc.a.b) === JSON.stringify([99, 20, 30]) && doc.keep === 'x', JSON.stringify(doc));
}
{
  const doc = { result: { isOut: false }, runnerIndex: {}, players: [{ id: 1 }] };
  JsonPatch.apply(doc, [
    { op: 'copy', path: '/players/0/note', from: '/result/isOut' },   // observed endpoint pattern
    { op: 'copy', path: '/runnerIndex/1', from: '/players/0/id' },
    { op: 'move', path: '/moved', from: '/players/0/note' },
  ]);
  check('patch: copy (incl. cross-type) + move', doc.players[0].note === undefined
    && doc.moved === false && doc.runnerIndex['1'] === 1, JSON.stringify(doc));
}
{
  const doc = { 'a/b': { '~key': 1 } };
  JsonPatch.apply(doc, [{ op: 'replace', path: '/a~1b/~0key', value: 42 }]); // JSON pointer escapes
  check('patch: pointer escaping', doc['a/b']['~key'] === 42, JSON.stringify(doc));
}
{
  const doc = { arr: ['x', 'y'] };
  JsonPatch.apply(doc, [{ op: 'add', path: '/arr/-', value: 'z' }]);
  check('patch: "-" appends', JSON.stringify(doc.arr) === JSON.stringify(['x', 'y', 'z']), JSON.stringify(doc));
}
{
  let threw = false;
  try { JsonPatch.apply({ a: 1 }, [{ op: 'copy', path: '/b', from: '/missing' }]); } catch (e) { threw = true; }
  check('patch: copy from a missing source throws', threw);
  threw = false;
  try { JsonPatch.apply({ a: 1 }, [{ op: 'replace', path: '/nope', value: 1 }]); } catch (e) { threw = true; }
  check('patch: replace of missing key throws', threw);
  threw = false;
  try { JsonPatch.apply({ a: 'x' }, [{ op: 'test', path: '/a', value: 'y' }]); } catch (e) { threw = true; }
  check('patch: failed test throws', threw);
}

/* ------------------------------------ real captured patch (2026-11-27, CIN @ CHC) */
const capturedOps = [
  { op: 'replace', path: '/metaData/timeStamp', value: '20260828_203907' },
  { op: 'replace', path: '/metaData/gameEvents/0', value: 'single' },
  { op: 'add', path: '/metaData/logicalEvents/3', value: 'runnersOnFirstAndThird' },
  { op: 'add', path: '/liveData/plays/allPlays/66/result/event', value: 'Single' },
  { op: 'add', path: '/liveData/plays/allPlays/66/result/eventType', value: 'single' },
  { op: 'replace', path: '/liveData/plays/allPlays/66/about/isComplete', value: true },
  { op: 'copy', path: '/liveData/plays/allPlays/66/about/hasReview', from: '/liveData/plays/allPlays/66/result/isOut' },
  { op: 'copy', path: '/liveData/plays/allPlays/66/runnerIndex/1', from: '/liveData/linescore/innings/6/home/errors' },
  { op: 'copy', path: '/liveData/plays/allPlays/66/runnerIndex/2', from: '/liveData/linescore/teams/home/errors' },
  { op: 'replace', path: '/liveData/linescore/innings/6/home/hits', value: 1 },
  { op: 'replace', path: '/liveData/linescore/teams/home/hits', value: 7 },
];

function baseDoc() {
  return {
    metaData: { timeStamp: '20260828_203856', gameEvents: ['field_out', 'game_finished'], logicalEvents: ['field_out', 'game_finished', 'midInning'] },
    gameData: { game: { pk: 824638 }, status: { abstractGameState: 'Live', detailedState: 'In Progress', statusCode: 'I' } },
    liveData: {
      plays: { allPlays: [ { about: { isComplete: false }, result: { isOut: false }, runnerIndex: [] }, ] },
      linescore: { innings: [0, 1, 2, 3, 4, 5, 6].map(() => ({ home: { errors: 0, hits: 0 } })), teams: { home: { errors: 0, hits: 6 } } },
    },
  };
}

{
  /* pad allPlays to index 66 like the real game */
  const base = baseDoc();
  while (base.liveData.plays.allPlays.length < 66) base.liveData.plays.allPlays.push({ about: {}, result: {}, runnerIndex: [] });
  base.liveData.plays.allPlays[66] = { about: { isComplete: false }, result: { isOut: false }, runnerIndex: ['seed'] };
  /* innings[6] carries { errors: 0, hits: 0 } like the capture's 7th-inning slot */
  const clone = JSON.parse(JSON.stringify(base));
  JsonPatch.apply(clone, capturedOps);
  check('captured patch: timeStamp advanced by the patch itself', clone.metaData.timeStamp === '20260828_203907', clone.metaData.timeStamp);
  check('captured patch: scoring fields landed on play 66', clone.liveData.plays.allPlays[66].result.eventType === 'single'
    && clone.liveData.plays.allPlays[66].about.isComplete === true, JSON.stringify(clone.liveData.plays.allPlays[66].result));
  check('captured patch: copy ops resolved from real sources', clone.liveData.plays.allPlays[66].about.hasReview === false
    && clone.liveData.plays.allPlays[66].runnerIndex[1] === 0
    && clone.liveData.plays.allPlays[66].runnerIndex[2] === 0, JSON.stringify(clone.liveData.plays.allPlays[66].runnerIndex));
  check('captured patch: linescore updated', clone.liveData.linescore.teams.home.hits === 7
    && clone.liveData.linescore.innings[6].home.hits === 1, JSON.stringify(clone.liveData.linescore));
}

/* --------------------------------------------------------------- live-diff tracker */
{
  const tracker = LiveDiff.create(824638);
  const base = baseDoc();
  while (base.liveData.plays.allPlays.length < 66) base.liveData.plays.allPlays.push({ about: {}, result: {}, runnerIndex: [] });
  base.liveData.plays.allPlays[66] = { about: { isComplete: false }, result: { isOut: false }, runnerIndex: ['seed'] };
  LiveDiff.adoptFullFeed(tracker, base, '20260828_203856');
  check('tracker: adopts a full feed and timecode', tracker.timecode === '20260828_203856' && tracker.syncs === 1);
  const out = LiveDiff.applyPatch(tracker, [{ diff: capturedOps }], '20260828_203907');
  check('tracker: applies an adjacent-pair patch', out.via === 'diffPatch' && tracker.timecode === '20260828_203907' && out.opCount === capturedOps.length, `via=${out.via} ts=${tracker.timecode}`);
  check('tracker: base object is the patched doc', tracker.base.metaData.timeStamp === '20260828_203907');
}
{
  const tracker = LiveDiff.create(824638);
  LiveDiff.adoptFullFeed(tracker, baseDoc(), '20260828_203856');
  const before = tracker.base;
  let threw = false;
  try {
    LiveDiff.applyPatch(tracker, [{ diff: [{ op: 'replace', path: '/missing/path', value: 1 }] }], '20260828_203907');
  } catch (e) { threw = true; }
  check('tracker: bad patch throws and base is untouched', threw && tracker.base === before, `threw=${threw}`);
}
{
  /* failure budget: 3 consecutive failures disable the fast path, base intact */
  const tracker = LiveDiff.create(999);
  LiveDiff.adoptFullFeed(tracker, baseDoc(), '20260828_203856');
  const snapshot = JSON.stringify(tracker.base);
  for (let i = 0; i < 3; i += 1) {
    try { LiveDiff.applyPatch(tracker, [{ diff: [{ op: 'replace', path: '/nope', value: i }] }], 'x'); } catch (e) { LiveDiff.noteFailure(tracker, e); }
  }
  check('tracker: 3 failures disable the fast path', tracker.disabled === true && tracker.failures === 3, `disabled=${tracker.disabled} failures=${tracker.failures}`);
  check('tracker: failed patches never corrupt the base', JSON.stringify(tracker.base) === snapshot);
}
{
  /* MLB's own fallback: diffPatch can answer with the FULL feed */
  const tracker = LiveDiff.create(824638);
  LiveDiff.adoptFullFeed(tracker, baseDoc(), '20260828_203856');
  const full = baseDoc();
  full.metaData.timeStamp = '20260828_220000';
  const out = LiveDiff.applyPatch(tracker, full, '20260828_220000');
  check('tracker: full-feed response is adopted as a resync, not an error', out.via === 'full' && tracker.timecode === '20260828_220000' && tracker.syncs === 2, JSON.stringify({ via: out.via, ts: tracker.timecode, syncs: tracker.syncs }));
}
{
  const flat = LiveDiff.flattenPatchResponse([{ diff: [{ op: 'test', path: '/a', value: 1 }] }, { diff: [] }]);
  check('tracker: flattens multi-entry patch responses', Array.isArray(flat) && flat.length === 1);
  check('tracker: garbage response is rejected', LiveDiff.flattenPatchResponse({ nope: true }) === null && LiveDiff.flattenPatchResponse([{ nope: 1 }]) === null);
  check('tracker: isFullFeed distinguishes shapes', LiveDiff.isFullFeed(baseDoc()) === true && LiveDiff.isFullFeed([]) === false && LiveDiff.isFullFeed(null) === false);
}

console.log(`live-diff-test: ${passes.length} passed`);
if (failures.length) {
  console.error(`live-diff-test: ${failures.length} FAILED`);
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('live-diff-test: OK');
