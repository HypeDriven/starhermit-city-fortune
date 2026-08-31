/* City Fortune — authoritative server + static host.
 *
 * Serves the browser distribution and the same-origin /api routes:
 *   GET  /api/v1/time          → { nowMs } platform time (daily boundaries, countdowns)
 *   GET  /api/v1/daily         → today's daily config descriptor (id, date, seed)
 *   POST /api/v1/score         → { entry, replay } — verified server-side by
 *                                 replaying every command through the rules engine;
 *                                 the client's claimed score is never trusted.
 *   GET  /api/v1/leaderboard?configId=… → sorted verified entries
 *
 * No dependencies; Node 18+. Run: node server.js [port]
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const Rules = require('./js/rules.js');
const Content = require('./js/content.js');
const Game = require('./js/game.js');
const Store = require('./js/store.js');

const ROOT = __dirname;
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const MAX_BODY = 64 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.opus': 'audio/ogg'
};

// ---------- server-authoritative leaderboard (JSON file, versioned entries) ----------
const BOARD_FILE = path.join(ROOT, 'server-boards.json');
function loadServerBoards() {
  try { return JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8')); }
  catch (e) { return { v: 1, entries: [] }; }
}
function saveServerBoards(b) {
  try { fs.writeFileSync(BOARD_FILE, JSON.stringify(b)); } catch (e) { /* read-only fs */ }
}

// Verify a submitted result by replaying its commands through the rules engine.
// Rejects: unknown config, version mismatch, malformed commands, illegal moves,
// score/elapsed discrepancies, impossible durations. Never trusts client totals.
function verifySubmission(entry, replay) {
  if (!entry || !replay || !replay.header || !Array.isArray(replay.commands)) {
    return { ok: false, error: 'malformed-submission' };
  }
  if (replay.header.schemaVersion !== Rules.STATE_VERSION ||
      replay.header.contentVersion !== Content.CONTENT_VERSION) {
    return { ok: false, error: 'stale-version' };
  }
  if (typeof entry.configId !== 'string' || entry.configId !== replay.header.configId) {
    return { ok: false, error: 'config-mismatch' };
  }
  // the config must be one we actually publish
  const known = findConfig(entry.configId);
  if (!known) return { ok: false, error: 'unknown-config' };
  if ((known.seed >>> 0) !== (replay.header.seed >>> 0)) return { ok: false, error: 'seed-mismatch' };
  if (replay.commands.length > 1000) return { ok: false, error: 'too-many-commands' };

  const v = Game.verifyReplay(replay);
  if (!v.ok) return { ok: false, error: 'replay-' + v.reason };

  const s = v.state;
  if (!s.terminal) return { ok: false, error: 'round-not-finished' };
  // authoritative score comes from the replayed state, not from the entry
  const score = s.score.total;
  const won = s.terminal.won;
  if (entry.score !== score || entry.won !== won) return { ok: false, error: 'score-mismatch' };
  if (won && s.elapsedMs < 3000) return { ok: false, error: 'impossible-duration' };

  return {
    ok: true,
    verified: {
      sessionId: String(entry.sessionId || 'anon').slice(0, 32),
      configId: entry.configId, kind: known.kind,
      contentVersion: Content.CONTENT_VERSION, seed: known.seed >>> 0,
      won: won, score: score,
      invalid: Math.max(0, Math.min(999, entry.invalid | 0)),
      durationMs: s.elapsedMs,
      assists: String(entry.assists || 'none').slice(0, 40),
      date: known.date || null,
      atMs: Date.now()
    }
  };
}

function findConfig(id) {
  const all = Content.JOURNEY.concat(Content.CHALLENGES, Content.PRACTICE);
  const hit = all.find(c => c.id === id);
  if (hit) return hit;
  if (/^daily-\d{4}-\d{2}-\d{2}$/.test(id)) {
    const cfg = Content.dailyConfig(id.slice(6));
    // only accept today or past dates; future dailies are not yet published
    const today = Content.utcDateString(Date.now());
    if (cfg.date <= today) return cfg;
  }
  return null;
}

// ---------- HTTP ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('payload-too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/v1/time' && req.method === 'GET') {
    return sendJson(res, 200, { nowMs: Date.now() });
  }
  if (url.pathname === '/api/v1/daily' && req.method === 'GET') {
    const d = Content.utcDateString(Date.now());
    const cfg = Content.dailyConfig(d);
    return sendJson(res, 200, {
      id: cfg.id, date: d, seed: cfg.seed >>> 0,
      contentVersion: Content.CONTENT_VERSION, name: cfg.name,
      turnLimit: cfg.turnLimit, timeLimitSec: cfg.timeLimitSec
    });
  }
  if (url.pathname === '/api/v1/score' && req.method === 'POST') {
    let parsed;
    try { parsed = JSON.parse(await readBody(req)); }
    catch (e) { return sendJson(res, 400, { error: 'bad-json' }); }
    const v = verifySubmission(parsed.entry, parsed.replay);
    if (!v.ok) return sendJson(res, 422, { error: v.error });
    const boards = loadServerBoards();
    // idempotent by sessionId + configId: a duplicate submit returns the same rank
    const dup = boards.entries.find(e => e.sessionId === v.verified.sessionId && e.configId === v.verified.configId);
    if (!dup) {
      boards.entries.push(v.verified);
      if (boards.entries.length > 2000) boards.entries = boards.entries.slice(-2000);
      saveServerBoards(boards);
    }
    const boardEntries = Store.sortEntries(boards.entries.filter(e => e.configId === v.verified.configId));
    const rank = boardEntries.findIndex(e => e.sessionId === v.verified.sessionId) + 1;
    return sendJson(res, 200, { ok: true, rank: rank, of: boardEntries.length, entry: v.verified });
  }
  if (url.pathname === '/api/v1/leaderboard' && req.method === 'GET') {
    const configId = url.searchParams.get('configId');
    const boards = loadServerBoards();
    let entries = boards.entries;
    if (configId) entries = entries.filter(e => e.configId === configId);
    return sendJson(res, 200, { entries: Store.sortEntries(entries).slice(0, 50) });
  }
  return sendJson(res, 404, { error: 'not-found' });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT) || file.includes(`${path.sep}.`)) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch(() => sendJson(res, 500, { error: 'internal' }));
  } else {
    serveStatic(req, res, url);
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`City Fortune server on http://localhost:${PORT}`);
  });
}

module.exports = { server, verifySubmission, findConfig };
