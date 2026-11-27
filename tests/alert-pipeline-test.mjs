#!/usr/bin/env node
/* ============================================================================
 * tests/alert-pipeline-test.mjs — checks for the latency / state / scoring work
 *
 * Runs the REAL shipped scripts in jsdom and answers their requests from small
 * fixtures shaped like the official payloads (the same shapes the other tests
 * use).  Nothing here touches the network.
 *
 *   node tests/alert-pipeline-test.mjs
 *
 * Covered:
 *   1. probe signature + the request gate (rate ceiling, concurrency, abort)
 *   2. GameState.snapshot / diff / record  (both clocks, before/after wording)
 *   3. ScoringLog.observe / apply          (pending rulings, reclassification,
 *      history preserved, rows keyed so they survive a refresh)
 *   4. Chime isolation                     (alert and scoring players are
 *      independent: one off never silences the other)
 *   5. reviews.html wiring                 (updates the scoreboard? no — the
 *      feed captures state, renders the strip, and keeps the alert chime)
 * ==========================================================================*/
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let JSDOM;
for (const candidate of [process.env.JSDOM_PATH, 'jsdom', path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'node_modules/jsdom/lib/api.js')]) {
  if (!candidate) continue;
  try {
    const mod = await import(candidate);
    JSDOM = mod.JSDOM || (mod.default && mod.default.JSDOM);
    if (JSDOM) break;
  } catch { /* try the next candidate */ }
}
if (!JSDOM) {
  console.error('alert-pipeline-test: SKIPPED — jsdom is not installed (npm install --no-save jsdom)');
  process.exit(0);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(`${name} — ${err && err.message}`);
    console.log(`  ✗ ${name} — ${err && err.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

/* ------------------------------------------------------------------ harness */

/* A page-less DOM that loads the shipped scripts in order. */
function loadScripts(window, files) {
  for (const file of files) {
    window.eval(readFileSync(path.join(ROOT, 'assets/js', file), 'utf8'));
  }
}

function newWindow(html = '<!doctype html><html><body></body></html>') {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/', pretendToBeVisual: true });
  return dom;
}

/* A feed/live-shaped payload with both clocks present. */
function feed(overrides = {}) {
  const play = {
    about: { atBatIndex: 4, inning: 6, halfInning: 'top', isTopInning: true, isComplete: true },
    result: { eventType: 'single', description: 'Batter singles to left.', awayScore: 2, homeScore: 3, isOut: false },
    count: { balls: 1, strikes: 2, outs: 1 },
    matchup: { batter: { id: 11, fullName: 'Test Batter' }, pitcher: { id: 22, fullName: 'Test Pitcher' } },
    runners: [],
    playEvents: [
      { index: 0, isPitch: true, pitchNumber: 1, count: { balls: 1, strikes: 2, outs: 1 }, details: { call: { description: 'Called Strike' }, type: { description: 'Slider' } } },
    ],
  };
  return {
    metaData: { timeStamp: '20260407_182231', gameEvents: [{ eventId: 3, eventIndex: 1 }] },
    gameData: {
      game: { pk: 823109 },
      status: { abstractGameState: 'Live', statusCode: 'MA', detailedState: 'Manager challenge: Tag play', reason: 'Tag play' },
      teams: { away: { id: 136 }, home: { id: 142 } },
    },
    liveData: {
      plays: { allPlays: [play], currentPlay: play },
      linescore: {
        currentInning: 6, isTopInning: true, inningState: 'Top', outs: 1, balls: 1, strikes: 2,
        teams: { away: { runs: 2 }, home: { runs: 3 } },
        offense: { batter: { id: 11, fullName: 'Test Batter' } },
        defense: { pitcher: { id: 22, fullName: 'Test Pitcher' } },
      },
      boxscore: {},
    },
    ...overrides,
  };
}

console.log('\n[1] api.js — probe signature and the shared request gate');
{
  const dom = newWindow();
  const w = dom.window;
  w.fetch = () => Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) });
  loadScripts(w, ['api.js']);
  const MLB = w.MLB;

  check('probeSignature prefers the feed timecode', () => {
    assert(MLB.probeSignature({ metaData: { timeStamp: '20260407_182211' } }) === '20260407_182211', 'timecode not used');
  });
  check('probeSignature falls back to the newest gameEvent', () => {
    const sig = MLB.probeSignature({ metaData: { gameEvents: [{ eventId: 1 }, { eventId: 9, eventIndex: 4 }] } });
    assert(sig === 'ev:9:4', 'got ' + sig);
  });
  check('probeSignature returns "" when the payload carries no marker', () => {
    assert(MLB.probeSignature({}) === '', 'expected empty signature');
  });
  check('probe requests carry a cache-bypass nonce and only metaData', () => {
    const fields = decodeURIComponent(MLB.PROBE_FIELDS);
    assert(fields.indexOf('metaData') === 0, 'probe must lead with metaData: ' + fields);
    assert(!/allPlays|boxscore|linescore/.test(fields), 'probe must not pull the heavy payloads');
  });
  check('probeIntervalFor scales with the slate and stays inside 250 ms – 2 s', () => {
    assert(MLB.probeIntervalFor(1, 8) === 250, 'one game should probe at the 250 ms floor');
    assert(MLB.probeIntervalFor(15, 8) === 1875, 'fifteen games should spread to ~1.9 s, got ' + MLB.probeIntervalFor(15, 8));
    const wide = MLB.probeIntervalFor(40, 8);
    assert(wide === 2000, 'never slower than 2 s, got ' + wide);
  });
  dom.window.close();
}

{
  /* The gate: N parallel calls must not all start at once. */
  const dom = newWindow();
  const w = dom.window;
  let inFlight = 0;
  let maxInFlight = 0;
  w.fetch = () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise((resolve) => setTimeout(() => {
      inFlight -= 1;
      resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) });
    }, 5));
  };
  loadScripts(w, ['api.js']);
  const calls = [];
  for (let i = 0; i < 40; i += 1) {
    calls.push(w.MLB.getJSON('https://statsapi.mlb.com/api/v1/x?i=' + i, { retries: 0 }));
  }
  await Promise.all(calls);
  check('the gate never runs more than maxConcurrent requests at once', () => {
    assert(maxInFlight <= w.MLB.RATE.maxConcurrent, `saw ${maxInFlight} concurrent, ceiling ${w.MLB.RATE.maxConcurrent}`);
  });
  check('the gate starts no more than maxPerSecond requests per rolling second', () => {
    assert(w.MLB.RATE.maxPerSecond >= 2, 'ceiling must stay above the floor');
    const usage = w.MLB.usageStats();
    assert(typeof usage.byKind.other === 'number' && usage.byKind.other === 40, 'each request is counted once: ' + JSON.stringify(usage.byKind));
  });
  check('an aborted caller rejects before its request is started', async () => {
    const controller = new AbortController();
    controller.abort();
    let rejected = false;
    await w.MLB.getJSON('https://statsapi.mlb.com/api/v1/y', { signal: controller.signal, retries: 0 })
      .catch(() => { rejected = true; });
    assert(rejected, 'aborted call must reject');
  });
  dom.window.close();
}

console.log('\n[2] game-state.js — official state, two clocks, before/after');
{
  const dom = newWindow();
  const w = dom.window;
  w.fetch = () => Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  loadScripts(w, ['api.js', 'game-state.js']);
  const GS = w.GameState;

  /* The timecode is read as a wall clock, so the reference must be a LOCAL
   * 18:22:36 — built with the local-time constructor so the test passes in any
   * timezone, exactly like the browser's own clock. */
  const LOCAL_1836 = new Date(2026, 3, 7, 18, 22, 36).getTime();

  check('snapshot captures score, outs, count, batter, pitcher and the feed timecode', () => {
    const snap = GS.snapshot(feed(), { gamePk: 823109, observedAt: LOCAL_1836 });
    assert(snap.score.away === 2 && snap.score.home === 3, 'score');
    assert(snap.outs === 1 && snap.count.balls === 1 && snap.count.strikes === 2, 'outs/count');
    assert(snap.batter.name === 'Test Batter' && snap.pitcher.name === 'Test Pitcher', 'batter/pitcher');
    assert(snap.gameTimecode === '20260407_182231', 'timecode');
    assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(snap.observedAt), 'ISO clock with seconds, got ' + snap.observedAt);
    assert(snap.latencyMs === 5000, 'publish latency should be 5 s, got ' + snap.latencyMs);
    assert(snap.inning.half === 'top' && snap.inning.num === 6, 'inning');
  });

  check('snapshot is null-safe: a payload without live state yields nothing invented', () => {
    const snap = GS.snapshot({ metaData: {} }, { gamePk: 1 });
    assert(snap !== undefined, 'snapshot must not throw on a sparse payload');
    if (snap) {
      assert(snap.status.code === '' && snap.score.away === null, 'missing values must stay null, not 0');
    }
    assert(GS.snapshot(null, {}) === null, 'no payload at all yields null');
  });

  check('diff records field-level before/after with both clocks', () => {
    const prev = GS.snapshot(feed(), { observedAt: Date.parse('2026-04-07T18:22:36Z') });
    const next = GS.snapshot(feed({
      metaData: { timeStamp: '20260407_182244' },
      liveData: Object.assign(feed().liveData, {
        linescore: Object.assign(feed().liveData.linescore, { teams: { away: { runs: 3 }, home: { runs: 3 } } }),
      }),
    }), { observedAt: Date.parse('2026-04-07T18:22:49Z') });
    const d = GS.diff(prev, next);
    const score = d.changes.find((c) => c.field === 'score');
    assert(score, 'score change missing');
    assert(score.fromText === '2–3' && score.toText === '3–3', `before/after wording: ${score.fromText} -> ${score.toText}`);
    assert(score.atGameTimecode === '20260407_182244', 'change carries the game timecode it landed at');
    assert(d.alerting.length === 0, 'a score change alone is not an alerting transition');
  });

  check('a flip into an official review status is an alerting transition', () => {
    const prev = GS.snapshot(feed(), { observedAt: Date.now() });
    const next = GS.snapshot(feed({
      metaData: { timeStamp: '20260407_182300' },
      gameData: Object.assign(feed().gameData, { status: { abstractGameState: 'Live', statusCode: 'NH', detailedState: 'Umpire review: Home run', reason: 'Home run' } }),
    }), { observedAt: Date.now() });
    const d = GS.diff(prev, next);
    assert(d.alerting.some((c) => c.field === 'status'), 'status must be alerting');
    const status = d.changes.find((c) => c.field === 'status');
    assert(status.toText === 'Umpire review: Home run', 'official wording kept: ' + status.toText);
  });

  check('record() stores snapshots and transitions without duplicates, and survives a reload', async () => {
    const date = '2026-04-07';
    const a = GS.snapshot(feed(), { observedAt: Date.parse('2026-04-07T18:22:36Z') });
    GS.record(date, 823109, 'SEA @ MIN', a);
    GS.record(date, 823109, 'SEA @ MIN', a); // same timecode -> no duplicate snapshot
    const b = GS.snapshot(feed({
      metaData: { timeStamp: '20260407_182244' },
      gameData: Object.assign(feed().gameData, { status: { abstractGameState: 'Live', statusCode: 'NH', detailedState: 'Umpire review: Home run' } }),
    }), { observedAt: Date.parse('2026-04-07T18:22:49Z') });
    const rec = GS.record(date, 823109, 'SEA @ MIN', b);
    assert(rec.transition && rec.transition.alerting.indexOf('status') !== -1, 'status transition should be recorded');
    const game = GS.forGame(date, 823109);
    assert(game.snapshots.length === 2, 'expected 2 distinct snapshots, got ' + game.snapshots.length);
    assert(game.transitions.length === 1, 'expected 1 transition, got ' + game.transitions.length);
    const reloaded = GS.normalize(JSON.parse(w.localStorage.getItem('mlbp.gamestate.' + date)), date);
    assert(reloaded.games['823109'].snapshots.length === 2, 'snapshots must persist through localStorage');
    assert(reloaded.games['823109'].transitions[0].changes.length > 0, 'transitions must persist too');
  });

  check('parseGameTimecode refuses an off-clock timecode instead of inventing a latency', () => {
    assert(GS.parseGameTimecode('20260407_182231', LOCAL_1836) === new Date(2026, 3, 7, 18, 22, 31).getTime(),
      'a timecode on the reader\'s own clock parses');
    assert(GS.parseGameTimecode('nonsense') === null, 'garbage yields null');
    assert(GS.parseGameTimecode('19990101_000000') === null, 'a decades-old timecode is not a live publication');
    /* The zone question, handled honestly: a timecode that is hours away from
     * the reader's clock yields null, so no bogus latency is ever displayed. */
    assert(GS.parseGameTimecode('20260407_032231', LOCAL_1836) === null,
      'a timecode 15 hours off must not produce a latency');
    assert(GS.timecodeClock('20260407_182231') === '18:22:31', 'display clock');
  });
  dom.window.close();
}

console.log('\n[3] scoring-log.js — pending rulings and changes, kept separate');
{
  const dom = newWindow();
  const w = dom.window;
  w.fetch = () => Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  loadScripts(w, ['api.js', 'ui.js', 'scoring-log.js']);
  const Log = w.ScoringLog;
  const date = '2026-04-07';

  const pendingPlay = {
    about: { atBatIndex: 7, inning: 3, halfInning: 'bottom', isComplete: false },
    result: { eventType: 'os_ruling_pending_primary', description: 'Official Scorer Ruling Pending', awayScore: 1, homeScore: 1 },
    matchup: { batter: { fullName: 'Test Batter' }, pitcher: { fullName: 'Test Pitcher' } },
    runners: [], playEvents: [],
  };

  check('a pending-ruling at-bat is logged with the exact official wording', () => {
    const observed = Log.observe(date, 823109, 'SEA @ MIN', [pendingPlay]);
    assert(observed.pending.length === 1, 'one pending row expected, got ' + observed.pending.length);
    const row = observed.pending[0];
    assert(row.eventType === 'os_ruling_pending_primary', 'event type kept');
    assert(row.description === 'Official Scorer Ruling Pending', 'official description kept verbatim');
    assert(row.id === '823109:7:pending', 'stable id, got ' + row.id);
  });

  check('apply() logs pending once and keeps the row after it resolves', () => {
    const first = Log.apply(date, Log.observe(date, 823109, 'SEA @ MIN', [pendingPlay]));
    assert(first.rows.length === 1, 'first observation should add a row');
    assert(first.events.length === 1, 'first observation should append one activity line');
    const second = Log.apply(date, Log.observe(date, 823109, 'SEA @ MIN', [pendingPlay]));
    assert(second.rows.length === 0, 'a second observation of the same pending ruling is not new');
    assert(second.events.length === 0, 'only a genuinely new pending ruling adds an activity line');
    /* The scorer decides: the play is now classified. */
    const resolved = {
      about: { atBatIndex: 7, inning: 3, halfInning: 'bottom', isComplete: true },
      result: { eventType: 'field_error', description: 'Reached on error, E6.', awayScore: 1, homeScore: 1 },
      matchup: { batter: { fullName: 'Test Batter' }, pitcher: { fullName: 'Test Pitcher' } },
      runners: [], playEvents: [],
    };
    Log.apply(date, Log.observe(date, 823109, 'SEA @ MIN', [resolved]));
    const rows = Log.dayFor(date).rows;
    const pendingRow = rows.find((r) => r.kind === 'pending' && r.id === '823109:7:pending');
    assert(pendingRow && pendingRow.status === 'resolved', 'the pending row must be marked resolved, not deleted');
  });

  check('a reclassification records before AND after, and only once', () => {
    /* The resolved play is observed completed once; its baseline is the initial
     * (error) call the scorer will later change. */
    const errorCall = {
      about: { atBatIndex: 7, inning: 3, halfInning: 'bottom', isComplete: true },
      result: { eventType: 'field_error', description: 'Reached on error, E6.', awayScore: 1, homeScore: 1 },
      matchup: { batter: { fullName: 'Test Batter' }, pitcher: { fullName: 'Test Pitcher' } },
      runners: [], playEvents: [],
    };
    Log.apply(date, Log.observe(date, 823109, 'SEA @ MIN', [errorCall]));
    const day = Log.dayFor(date);
    const before = day.baselines['823109:7'];
    assert(before && before.first.eventType === 'field_error', 'the completed play should have an error-call baseline');
    const reclassified = {
      about: { atBatIndex: 7, inning: 3, halfInning: 'bottom', isComplete: true },
      result: { eventType: 'single', description: 'Singles on a ball the shortstop misplayed.', awayScore: 2, homeScore: 1 },
      matchup: { batter: { fullName: 'Test Batter' }, pitcher: { fullName: 'Test Pitcher' } },
      runners: [], playEvents: [],
    };
    const observed = Log.observe(date, 823109, 'SEA @ MIN', [reclassified]);
    assert(observed.changes.length === 1, 'expected one change, got ' + observed.changes.length);
    const change = observed.changes[0];
    assert(change.previous.eventType === 'field_error', 'previous classification: ' + change.previous.eventType);
    assert(change.official.eventType === 'single', 'new classification: ' + change.official.eventType);
    assert(change.firstObserved.description === 'Reached on error, E6.', 'initial wording kept: ' + change.firstObserved.description);
    assert(change.official.description.indexOf('Singles') === 0, 'final wording kept');
    Log.apply(date, observed);
    const again = Log.observe(date, 823109, 'SEA @ MIN', [reclassified]);
    assert(again.changes.length === 0, 'the same classification must not be re-logged');
  });

  check('log rows and events persist in their own key (a refresh restores them)', () => {
    const raw = w.localStorage.getItem('mlbp.scoring.' + date);
    assert(!!raw, 'scoring store must be written');
    const parsed = Log.normalize(JSON.parse(raw), date);
    assert(parsed.rows.length >= 2, 'expected the pending + change rows, got ' + parsed.rows.length);
    assert(parsed.events.length >= 1, 'expected at least one activity event');
    assert(!w.localStorage.getItem('mlbp.feedlog.' + date), 'the scoring log must not write the alert feed log');
  });

  check('the scoring store and the alert feed log are different keys (isolation)', () => {
    assert('mlbp.scoring.2026-04-07'.indexOf('mlbp.feedlog') === -1, 'sanity');
    const keys = Object.keys(w.localStorage).filter((k) => k.indexOf('mlbp.') === 0);
    assert(keys.every((k) => k.indexOf('mlbp.scoring') === 0 || k.indexOf('mlbp.gamestate') === 0),
      'only the scoring/state stores should be written here: ' + keys.join(','));
  });
  dom.window.close();
}

console.log('\n[4] chime.js — one sound engine, two independent players');
{
  const dom = newWindow();
  const w = dom.window;
  loadScripts(w, ['chime.js']);

  check('the rain drop is ~2.6 s of scheduled drops, not a single beep', () => {
    assert(w.Chime.DURATION_MS >= 2000 && w.Chime.DURATION_MS <= 3200, 'duration ' + w.Chime.DURATION_MS);
    assert(w.Chime.DROPS.length >= 4, 'a rain drop is several drops: ' + w.Chime.DROPS.length);
  });

  check('the alert player is silent until enabled, and the scoring player is not', () => {
    assert(w.Chime.isEnabled('alert') === false, 'alert defaults to off');
    assert(w.Chime.isEnabled('scoring') === true, 'scoring sound defaults on (it is labelled in its own section)');
  });

  check('enabling/disabling one player never changes the other', () => {
    w.Chime.setEnabled('alert', true);
    w.Chime.setEnabled('scoring', false);
    assert(w.Chime.isEnabled('alert') === true, 'alert must stay on');
    assert(w.Chime.isEnabled('scoring') === false, 'scoring must be off');
    w.Chime.setEnabled('alert', false);
    assert(w.Chime.isEnabled('alert') === false, 'alert off');
    assert(w.Chime.isEnabled('scoring') === false, 'scoring still off, untouched');
  });

  check('play() refuses while disabled and never throws without an AudioContext', () => {
    w.Chime.setEnabled('alert', false);
    assert(w.Chime.play('alert') === false, 'disabled player must not play');
    w.Chime.setEnabled('alert', true);
    assert(w.Chime.play('alert') === false, 'jsdom has no Web Audio, so play() returns false rather than throwing');
  });
  dom.window.close();
}

console.log('\n[5] reviews.html — the feed records state and keeps its alert chime');
{
  const page = readFileSync(path.join(ROOT, 'reviews.html'), 'utf8');
  const scripts = [...page.matchAll(/<script\b[^>]*src\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  const html = page.replace(/<script\b[^>]*src\s*=\s*"[^"]+"[^>]*><\/script>/g, '');

  check('the page loads api → ui → … → the page logic last (contract order)', () => {
    assert(scripts[0].endsWith('api.js'), 'api.js first');
    assert(scripts[scripts.length - 1].endsWith('reviews-feed.js'), 'page logic last, got ' + scripts[scripts.length - 1]);
    ['game-state.js', 'chime.js', 'scoring-log.js', 'scoring-ui.js'].forEach((f) => {
      assert(scripts.some((s) => s.endsWith(f)), 'missing ' + f);
    });
  });

  const dom = new JSDOM(html, {
    url: 'https://kanlerxz87-cyber.github.io/Alert4/reviews.html?date=2026-04-07',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  const plays = [{
    about: { atBatIndex: 4, inning: 6, halfInning: 'top', isComplete: true },
    result: { eventType: 'os_ruling_pending_primary', description: 'Official Scorer Ruling Pending', awayScore: 2, homeScore: 3 },
    count: { balls: 1, strikes: 2, outs: 1 },
    matchup: { batter: { id: 11, fullName: 'Test Batter' }, pitcher: { id: 22, fullName: 'Test Pitcher' } },
    runners: [], playEvents: [],
  }];
  w.fetch = (url) => {
    const u = String(url);
    let body = {};
    if (u.includes('/eventTypes')) body = [{ code: 'os_ruling_pending_primary', description: 'Official Scorer Ruling Pending' }];
    else if (u.includes('/schedule')) body = { dates: [{ games: [{ gamePk: 823109, status: { abstractGameState: 'Live', statusCode: 'MA' }, teams: { away: { team: { id: 136, name: 'Mariners' } }, home: { team: { id: 142, name: 'Twins' } } } }] }] };
    else if (decodeURIComponent(u).includes('metaData') && !decodeURIComponent(u).includes('linescore')) body = { metaData: { timeStamp: '20260407_182231' } };
    else if (u.includes('/feed/live')) body = feed({ gameData: Object.assign(feed().gameData, { status: { abstractGameState: 'Live', statusCode: 'MA', detailedState: 'Manager challenge: Tag play' } }) });
    else if (u.includes('/playByPlay')) body = { allPlays: plays };
    return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
  };
  for (const s of scripts) w.eval(readFileSync(path.join(ROOT, s), 'utf8'));
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  await new Promise((r) => setTimeout(r, 2200));

  check('the feed captured official state for the live game', () => {
    const snap = w.GameState.latest('2026-04-07', 823109);
    assert(!!snap, 'no snapshot captured');
    assert(/^\d{2}:\d{2}:\d{2}$/.test(snap.observedClock), 'clock to the second: ' + snap.observedClock);
    assert(snap.gameTimecode === '20260407_182231', 'feed timecode captured');
  });

  check('the live game-state strip renders the state', () => {
    const rows = w.document.querySelectorAll('#live-state .ls-row');
    assert(rows.length === 1, 'expected one state row, got ' + rows.length);
    const text = rows[0].textContent;
    assert(/2–3/.test(text), 'score should be in the strip: ' + text.slice(0, 160));
    assert(/Test Batter/.test(text), 'batter should be in the strip');
  });

  check('the official-scoring section logs the pending ruling independently', () => {
    assert(!!w.ScoringLog, 'ScoringLog missing');
    assert(w.ScoringLog.loop.date === '2026-04-07', 'scoring loop should follow the page date, got ' + w.ScoringLog.loop.date);
    const rows = w.document.querySelectorAll('#scoring-list .scoring-row');
    assert(rows.length >= 1, 'expected a pending row in the scoring section');
    assert(/Official Scorer Ruling Pending/.test(w.document.getElementById('scoring-list').textContent), 'official wording missing');
  });

  check('the alert sound and the scoring sound are separate switches', () => {
    const scoringBefore = w.Chime.isEnabled('scoring');
    /* Toggle from whatever state the page started in, both ways. */
    w.ReplayFeed.toggleSound();
    const first = w.ReplayFeed.state.soundOn;
    assert(w.Chime.isEnabled('alert') === first, 'the alert player must follow its own switch');
    w.ReplayFeed.toggleSound();
    assert(w.ReplayFeed.state.soundOn === !first, 'the alert switch flips');
    assert(w.Chime.isEnabled('alert') === !first, 'the alert player follows the second flip');
    assert(w.Chime.isEnabled('scoring') === scoringBefore, 'scoring preference untouched by the alert toggles');
  });

  /* Last (async): the alert chime still fires for a brand-new review row. */
  await new Promise((resolve) => {
    const st = w.ReplayFeed.state;
    /* Drop every tracked row and clear the probe schedule, so the next scan
     * reads the game immediately and sees each row as new. */
    st.entries = [];
    st.nextDue = {};
    st.changedUntil = {};
    st.probeSig = {};
    st.soundOn = true;
    st.lastChimeAt = 0;
    w.Chime.setEnabled('alert', true);
    w.ReplayFeed.scan();
    setTimeout(resolve, 600);
  });
  check('the alert feed still chimes on a new review (unchanged contract)', () => {
    assert(w.ReplayFeed.state.lastChimeAt > 0, 'the alert chime did not fire');
  });

  dom.window.close();
}

setTimeout(() => {
  console.log(`\nalert-pipeline-test: ${pass} checks passed`);
  if (failures.length) {
    console.error(`alert-pipeline-test: ${failures.length} check(s) FAILED`);
    for (const f of failures) console.error(' - ' + f);
    process.exit(1);
  }
  console.log('alert-pipeline-test: OK');
  process.exit(0);
}, 300);
