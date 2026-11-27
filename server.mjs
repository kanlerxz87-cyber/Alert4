#!/usr/bin/env node
/* ============================================================================
 * server.mjs — HTTP server for MLB Live PBP with persistent feed logging.
 *
 * Serves static web assets and provides a shared persistence backend for
 * reviews, challenges, official-scorer pending rulings, and scoring changes.
 *
 * Persisted state lives in data/feed-log-<YYYY-MM-DD>.json so that any
 * client/browser visiting the website immediately receives all tracked
 * entries, scoring changes, and baselines across browsers and sessions.
 * ==========================================================================*/

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_DIR = __dirname;
const DATA_DIR = path.join(REPO_DIR, 'data');
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8000;
const HOST = '0.0.0.0';

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function sendJSON(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  });
  res.end(body);
}

function sendError(res, statusCode, message) {
  sendJSON(res, statusCode, { error: message });
}

function getLogFilePath(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  return path.join(DATA_DIR, `feed-log-${dateStr}.json`);
}

function readLogFromDisk(dateStr) {
  const filePath = getLogFilePath(dateStr);
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[server] failed to read feed log for ${dateStr}:`, err);
    return null;
  }
}

/**
 * Merge an incoming feed log into an existing disk log idempotently.
 * Preserves all distinct rows, baselines, history chains, and irregularities.
 */
function mergeFeedLogPayloads(existing, incoming, dateStr) {
  const now = Date.now();
  if (!existing || typeof existing !== 'object' || existing.v !== 1) {
    return {
      v: 1,
      date: dateStr,
      savedAt: now,
      entries: Array.isArray(incoming.entries) ? incoming.entries : [],
      order: Array.isArray(incoming.order) ? incoming.order : [],
      snapshots: (incoming.snapshots && typeof incoming.snapshots === 'object') ? incoming.snapshots : {},
      irregularities: (incoming.irregularities && typeof incoming.irregularities === 'object') ? incoming.irregularities : {},
      grace: (incoming.grace && typeof incoming.grace === 'object') ? incoming.grace : {},
      settled: Array.isArray(incoming.settled) ? incoming.settled : [],
    };
  }

  // Merge entries by key: gamePk:review.id
  const entryMap = new Map();
  const orderList = [];

  function makeKey(entry) {
    if (!entry) return null;
    if (entry.id !== undefined && entry.id !== null && entry.id !== '') return String(entry.id);
    if (!entry.review) return null;
    const rid = entry.review.id !== undefined && entry.review.id !== null && entry.review.id !== ''
      ? entry.review.id
      : (entry.review.atBatIndex !== undefined && entry.review.atBatIndex !== null ? entry.review.atBatIndex : '');
    return `${entry.gamePk}:${rid}`;
  }

  (Array.isArray(existing.entries) ? existing.entries : []).forEach((e) => {
    const k = makeKey(e);
    if (!k) return;
    entryMap.set(k, e);
    if (!orderList.includes(k)) orderList.push(k);
  });

  (Array.isArray(incoming.entries) ? incoming.entries : []).forEach((e) => {
    const k = makeKey(e);
    if (!k) return;
    const prev = entryMap.get(k);
    if (!prev) {
      entryMap.set(k, e);
      if (!orderList.includes(k)) orderList.push(k);
    } else {
      // Merge: prefer most complete / latest seen; preserve top-level fields (id, kind, change, pending, scoreTracker)
      const mergedEntry = {
        ...prev,
        ...e,
        gamePk: e.gamePk ?? prev.gamePk,
        review: (prev.review || e.review) ? { ...(prev.review || {}), ...(e.review || {}) } : undefined,
        firstSeen: Math.min(prev.firstSeen || e.firstSeen || now, e.firstSeen || prev.firstSeen || now),
        lastSeen: Math.max(prev.lastSeen || 0, e.lastSeen || 0, now),
        matchupLabel: e.matchupLabel || prev.matchupLabel || null,
      };
      // For scoring change: preserve longer history if present
      if (prev.review && prev.review.history && (!e.review.history || e.review.history.length < prev.review.history.length)) {
        mergedEntry.review.history = prev.review.history;
      }
      entryMap.set(k, mergedEntry);
    }
  });

  // Merge snapshots (per gamePk -> atBatIndex)
  const mergedSnapshots = { ...(existing.snapshots || {}) };
  if (incoming.snapshots && typeof incoming.snapshots === 'object') {
    Object.keys(incoming.snapshots).forEach((gamePk) => {
      mergedSnapshots[gamePk] = {
        ...(mergedSnapshots[gamePk] || {}),
        ...(incoming.snapshots[gamePk] || {}),
      };
    });
  }

  // Merge irregularities (per gamePk -> notes array)
  const mergedIrregularities = { ...(existing.irregularities || {}) };
  if (incoming.irregularities && typeof incoming.irregularities === 'object') {
    Object.keys(incoming.irregularities).forEach((gamePk) => {
      const prevNotes = mergedIrregularities[gamePk] || [];
      const newNotes = incoming.irregularities[gamePk] || [];
      const combined = [...prevNotes];
      newNotes.forEach((n) => {
        if (typeof n === 'string' && !combined.includes(n)) combined.push(n);
      });
      mergedIrregularities[gamePk] = combined.slice(-30);
    });
  }

  // Merge grace
  const mergedGrace = { ...(existing.grace || {}), ...(incoming.grace || {}) };

  // Merge settled
  const settledSet = new Set([
    ...(Array.isArray(existing.settled) ? existing.settled : []),
    ...(Array.isArray(incoming.settled) ? incoming.settled : []),
  ]);

  return {
    v: 1,
    date: dateStr,
    savedAt: now,
    entries: orderList.map((k) => entryMap.get(k)).filter(Boolean),
    order: orderList,
    snapshots: mergedSnapshots,
    irregularities: mergedIrregularities,
    grace: mergedGrace,
    settled: [...settledSet],
  };
}

/** Read + parse a JSON request body with the same size guard the feed-log POST uses. */
function readJsonBody(req, res, onPayload) {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 50 * 1024 * 1024) { // 50MB protection
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload too large' }));
      req.destroy();
    }
  });
  req.on('end', () => {
    try {
      onPayload(JSON.parse(body));
    } catch (err) {
      sendError(res, 400, `JSON parse error: ${err.message}`);
    }
  });
}

/* --------------------------------------------------- side stores (isolated)
 * The alert feed log above is one store.  Two more exist *beside* it, each with
 * its own file, its own endpoints and its own merge, so a problem with one can
 * never corrupt the others:
 *
 *   game-state    data/game-state-<date>.json   official state snapshots
 *   scoring-log   data/scoring-<date>.json      pending rulings / changes
 *
 * Both accept the same tiny envelope { v: 1, date, ... } and are merged (not
 * overwritten) on write, so two browsers watching the same day never lose each
 * other's observations.
 */
const STORES = {
  gameState: {
    dir: 'game-state',
    listKeys: ['games'],
    merge(existing, incoming, dateStr) {
      const base = (existing && existing.v === 1) ? existing : { v: 1, date: dateStr, games: {} };
      const out = { v: 1, date: dateStr, savedAt: Date.now(), games: { ...(base.games || {}) } };
      const incomingGames = (incoming && incoming.games) || {};
      for (const pk of Object.keys(incomingGames)) {
        const a = out.games[pk] || { gamePk: Number(pk), matchupLabel: '', snapshots: [], transitions: [], lastSeenAt: 0 };
        const b = incomingGames[pk] || {};
        const snaps = [...(a.snapshots || [])];
        const seen = new Set(snaps.map((x) => `${x && x.gameTimecode}|${x && x.capturedAt}`));
        for (const snap of (b.snapshots || [])) {
          const key = `${snap && snap.gameTimecode}|${snap && snap.capturedAt}`;
          if (!seen.has(key)) { seen.add(key); snaps.push(snap); }
        }
        const trans = [...(a.transitions || [])];
        const tse = new Set(trans.map((x) => `${x && x.gameTimecode}|${x && x.at}`));
        for (const t of (b.transitions || [])) {
          const key = `${t && t.gameTimecode}|${t && t.at}`;
          if (!tse.has(key)) { tse.add(key); trans.push(t); }
        }
        snaps.sort((x, y) => (x.capturedAt || 0) - (y.capturedAt || 0));
        trans.sort((x, y) => (x.at || 0) - (y.at || 0));
        out.games[pk] = {
          gamePk: Number(pk),
          matchupLabel: b.matchupLabel || a.matchupLabel || '',
          snapshots: snaps.slice(-240),
          transitions: trans.slice(-320),
          lastSeenAt: Math.max(a.lastSeenAt || 0, b.lastSeenAt || 0),
          lastTimecode: b.lastTimecode || a.lastTimecode || '',
        };
      }
      return out;
    },
  },
  scoringLog: {
    dir: 'scoring',
    merge(existing, incoming, dateStr) {
      const base = (existing && existing.v === 1) ? existing : { v: 1, date: dateStr, rows: [], events: [], baselines: {} };
      const rows = new Map();
      for (const row of [...(base.rows || []), ...((incoming && incoming.rows) || [])]) {
        if (!row || !row.id) continue;
        const prev = rows.get(row.id);
        rows.set(row.id, prev ? { ...prev, ...row, firstSeen: Math.min(prev.firstSeen || Infinity, row.firstSeen || Infinity), lastSeen: Math.max(prev.lastSeen || 0, row.lastSeen || 0) } : row);
      }
      const events = new Map();
      for (const ev of [...(base.events || []), ...((incoming && incoming.events) || [])]) {
        if (!ev || !ev.id) continue;
        if (!events.has(ev.id)) events.set(ev.id, ev);
      }
      const baselines = { ...(base.baselines || {}) };
      for (const key of Object.keys((incoming && incoming.baselines) || {})) {
        if (!baselines[key]) baselines[key] = incoming.baselines[key];
      }
      return {
        v: 1,
        date: dateStr,
        savedAt: Date.now(),
        rows: [...rows.values()].sort((x, y) => (y.lastSeen || 0) - (x.lastSeen || 0)).slice(0, 400),
        events: [...events.values()].sort((x, y) => (y.at || 0) - (x.at || 0)).slice(0, 400),
        baselines,
      };
    },
  },
};

function sideStorePath(store, dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  return path.join(DATA_DIR, `${store.dir}-${dateStr}.json`);
}

function readSideStore(store, dateStr) {
  const filePath = sideStorePath(store, dateStr);
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.warn(`[server] failed to read ${store.dir} store for ${dateStr}:`, err);
    return null;
  }
}

function writeSideStore(store, dateStr, incoming) {
  const filePath = sideStorePath(store, dateStr);
  if (!filePath) return false;
  try {
    const merged = store.merge(readSideStore(store, dateStr), incoming, dateStr);
    const tempPath = `${filePath}.tmp.${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(merged, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
    return merged;
  } catch (err) {
    console.error(`[server] failed to write ${store.dir} store for ${dateStr}:`, err);
    return false;
  }
}

/* --------------------------------------------------------------- push (SSE)
 * Live tail of the shared feed log. Polling it (GET /api/feed-log) leaves a
 * window of up to the poll interval between "another browser/session wrote an
 * entry" and "this page sees it" — 15s in the shipped client. A Server-Sent
 * Events stream pushes each accepted write to every connected page
 * immediately, so the Replay Feed's rows and the scoreboard's scoring-change
 * chips appear as soon as ANY browser observed them, with no polling at all
 * (the client keeps its ordinary poll as a fallback when a stream cannot be
 * established — e.g. the static GitHub Pages deployment, where this endpoint
 * does not exist).
 */
const sseClients = new Set(); // { res, date }

function sseWrite(res, chunk) {
  try {
    return res.write(chunk);
  } catch (_) {
    return false;
  }
}

/** Push one merged log payload to every stream watching that date. */
function broadcastFeedLog(dateStr, payload) {
  if (!sseClients.size) return 0;
  let body;
  try {
    body = JSON.stringify(payload);
  } catch (err) {
    console.warn(`[server] could not serialize the feed log for push:`, err);
    return 0;
  }
  const frame = `event: feed-log\ndata: ${body}\n\n`;
  let sent = 0;
  sseClients.forEach((client) => {
    if (client.date !== dateStr) return;
    if (sseWrite(client.res, frame)) sent += 1;
  });
  return sent;
}

function writeLogToDisk(dateStr, payload) {
  const filePath = getLogFilePath(dateStr);
  if (!filePath) return false;
  try {
    const existing = readLogFromDisk(dateStr);
    const merged = mergeFeedLogPayloads(existing, payload, dateStr);
    const serialized = JSON.stringify(merged, null, 2);
    // Write atomically via temporary file
    const tempPath = `${filePath}.tmp.${Date.now()}`;
    fs.writeFileSync(tempPath, serialized, 'utf8');
    fs.renameSync(tempPath, filePath);

    // Update index
    const indexPath = path.join(DATA_DIR, 'feed-log-index.json');
    let index = {};
    if (fs.existsSync(indexPath)) {
      try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) || {}; } catch (_) {}
    }
    index[dateStr] = merged.savedAt;
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8');
    return merged;
  } catch (err) {
    console.error(`[server] failed to write feed log for ${dateStr}:`, err);
    return false;
  }
}

const server = http.createServer((req, res) => {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;

  // --- API Endpoints ---

  // Health check
  if (pathname === '/api/health') {
    sendJSON(res, 200, { status: 'ok', uptime: process.uptime() });
    return;
  }

  // GET /api/feed-log/stream?date=YYYY-MM-DD — Server-Sent Events tail of the log.
  if (pathname === '/api/feed-log/stream' && req.method === 'GET') {
    const dateStr = reqUrl.searchParams.get('date');
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      sendError(res, 400, 'date query parameter in YYYY-MM-DD format is required');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Proxies (and some dev servers) buffer responses by default; these two
      // headers ask them not to, so frames are flushed as they are written.
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
    // Ask the browser's EventSource to reconnect after 3s, and tell the client
    // the date this stream is for (so a late/duplicate frame is ignorable).
    sseWrite(res, `retry: 3000\nevent: connected\ndata: {"date":"${dateStr}"}\n\n`);
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    const client = { res, date: dateStr };
    sseClients.add(client);
    // Heartbeat: keeps intermediaries from timing the connection out and lets
    // a dead peer be noticed without waiting for a write.
    const heartbeat = setInterval(() => { sseWrite(res, ': hb\n\n'); }, 20000);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();
    const cleanup = () => {
      clearInterval(heartbeat);
      sseClients.delete(client);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
    // An initial snapshot, so a page that connects while another browser is
    // active adopts the current log immediately (the client merges it
    // idempotently, exactly like its ordinary GET).
    const current = readLogFromDisk(dateStr);
    if (current) sseWrite(res, `event: feed-log\ndata: ${JSON.stringify(current)}\n\n`);
    return;
  }

  // GET /api/feed-log?date=YYYY-MM-DD or /api/log?date=YYYY-MM-DD
  if ((pathname === '/api/feed-log' || pathname === '/api/log') && req.method === 'GET') {
    const dateStr = reqUrl.searchParams.get('date');
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      sendError(res, 400, 'date query parameter in YYYY-MM-DD format is required');
      return;
    }
    const log = readLogFromDisk(dateStr);
    if (log) {
      sendJSON(res, 200, log);
    } else {
      // Return empty valid structure if not yet created on disk
      sendJSON(res, 200, {
        v: 1,
        date: dateStr,
        savedAt: Date.now(),
        entries: [],
        order: [],
        snapshots: {},
        irregularities: {},
        grace: {},
        settled: [],
      });
    }
    return;
  }

  // POST /api/feed-log or /api/log
  if ((pathname === '/api/feed-log' || pathname === '/api/log') && req.method === 'POST') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 50 * 1024 * 1024) { // 50MB protection
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        if (!payload || typeof payload !== 'object' || payload.v !== 1 || !payload.date || !/^\d{4}-\d{2}-\d{2}$/.test(payload.date)) {
          sendError(res, 400, 'Invalid payload: must be object with v: 1 and valid date (YYYY-MM-DD)');
          return;
        }
        const saved = writeLogToDisk(payload.date, payload);
        if (saved) {
          // Push the merged log to every open page for this date BEFORE the
          // POST response: the write is already durable, so another session's
          // page can show the new entry while this one is still being
          // acknowledged. (The posting page also receives it; its merge is
          // idempotent and produces no re-render.)
          const pushed = broadcastFeedLog(payload.date, saved);
          sendJSON(res, 200, {
            ok: true,
            date: payload.date,
            savedAt: saved.savedAt,
            entriesCount: saved.entries.length,
            pushed,
          });
        } else {
          sendError(res, 500, 'Failed to save feed log to disk');
        }
      } catch (err) {
        sendError(res, 400, `JSON parse error: ${err.message}`);
      }
    });
    return;
  }

  // GET/POST /api/game-state — official state snapshots, separate from the feed log.
  if (pathname === '/api/game-state') {
    const dateStr = reqUrl.searchParams.get('date');
    if (req.method === 'GET') {
      if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) { sendError(res, 400, 'date query parameter in YYYY-MM-DD format is required'); return; }
      const stored = readSideStore(STORES.gameState, dateStr);
      sendJSON(res, 200, stored || { v: 1, date: dateStr, savedAt: Date.now(), games: {} });
      return;
    }
    if (req.method === 'POST') {
      readJsonBody(req, res, (payload) => {
        if (!payload || payload.v !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(payload.date || '')) {
          sendError(res, 400, 'Invalid payload: must have v: 1 and a valid date');
          return;
        }
        const saved = writeSideStore(STORES.gameState, payload.date, payload);
        if (!saved) { sendError(res, 500, 'Failed to save game-state store'); return; }
        sendJSON(res, 200, { ok: true, date: payload.date, games: Object.keys(saved.games || {}).length });
      });
      return;
    }
  }

  // GET/POST /api/scoring-log — pending rulings + scoring changes, separate again.
  if (pathname === '/api/scoring-log') {
    const dateStr = reqUrl.searchParams.get('date');
    if (req.method === 'GET') {
      if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) { sendError(res, 400, 'date query parameter in YYYY-MM-DD format is required'); return; }
      const stored = readSideStore(STORES.scoringLog, dateStr);
      sendJSON(res, 200, stored || { v: 1, date: dateStr, savedAt: Date.now(), rows: [], events: [], baselines: {} });
      return;
    }
    if (req.method === 'POST') {
      readJsonBody(req, res, (payload) => {
        if (!payload || payload.v !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(payload.date || '')) {
          sendError(res, 400, 'Invalid payload: must have v: 1 and a valid date');
          return;
        }
        const saved = writeSideStore(STORES.scoringLog, payload.date, payload);
        if (!saved) { sendError(res, 500, 'Failed to save scoring store'); return; }
        sendJSON(res, 200, { ok: true, date: payload.date, rows: saved.rows.length, events: saved.events.length });
      });
      return;
    }
  }

  // --- Static File Serving ---
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendError(res, 405, 'Method not allowed');
    return;
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    // Malformed % escape (e.g. "/%"): decodeURIComponent throws URIError.
    // Answer 400 instead of letting the exception kill the process.
    sendError(res, 400, 'Bad request');
    return;
  }
  let safePath = path.normalize(decodedPath).replace(/^(\.\.[\/\\])+/, '');
  if (safePath === '/' || safePath === '') safePath = '/index.html';
  if (safePath === '/reviews') safePath = '/reviews.html';
  if (safePath === '/game') safePath = '/game.html';

  const filePath = path.join(REPO_DIR, safePath);

  // Security check: ensure path is within REPO_DIR. Compare against
  // REPO_DIR + separator so a sibling like "<repo>-evil" (which shares the
  // string prefix) is not accepted.
  const repoPrefix = REPO_DIR.endsWith(path.sep) ? REPO_DIR : REPO_DIR + path.sep;
  if (filePath !== REPO_DIR && !filePath.startsWith(repoPrefix)) {
    sendError(res, 403, 'Forbidden');
    return;
  }

  // Reject dotfile / hidden directory segments (e.g. /.git/..., /.github/...)
  // except /.nojekyll if requested directly.
  const relSegments = path.relative(REPO_DIR, filePath).split(path.sep).filter(Boolean);
  if (relSegments.some((seg) => seg.startsWith('.') && seg !== '.nojekyll')) {
    sendError(res, 403, 'Forbidden');
    return;
  }

  fs.lstat(filePath, (err, stats) => {
    if (err || stats.isSymbolicLink() || !stats.isFile()) {
      // 404 fallback: if asking for an html page, check 404.html
      const notFoundPath = path.join(REPO_DIR, '404.html');
      if (fs.existsSync(notFoundPath)) {
        res.writeHead(404, {
          'Content-Type': 'text/html; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
        fs.createReadStream(notFoundPath).pipe(res);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
      }
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[MLB Live PBP Server] listening on http://${HOST}:${PORT}`);
  console.log(`[MLB Live PBP Server] Serving ${REPO_DIR}`);
  console.log(`[MLB Live PBP Server] Feed log persistence directory: ${DATA_DIR}`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
