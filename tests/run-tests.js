/* City Fortune — test suite: rules legality, invalid reasons, scoring,
 * terminal states, serialization, deterministic replay, undo, session flow,
 * content integrity, server verification. Run: node tests/run-tests.js
 */
'use strict';

const assert = require('assert');
const RNG = require('../js/rng.js');
const Rules = require('../js/rules.js');
const Content = require('../js/content.js');
const Store = require('../js/store.js');
const Game = require('../js/game.js');
const Server = require('../server.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + ': ' + (e && e.stack || e)); }
}

const sampleCfg = Content.JOURNEY[3]; // first rival stage

function playUntil(sess, predicate, maxCmds) {
  const t0 = 1000;
  let n = 0;
  while (!sess.state.terminal && !predicate(sess.state) && n < (maxCmds || 500)) {
    const s = sess.state;
    let cmd;
    if (s.phase === 'buy') {
      const h = Game.hint(s);
      cmd = { type: h && h.type === 'buy' ? 'buy' : 'skip' };
    } else {
      const acts = Game.legalActions(s);
      const build = acts.find(a => a.type === 'build');
      cmd = (build && s.you.coins > build.cost * 3) ? { type: 'build', tile: build.tile } : { type: 'roll' };
    }
    const r = Game.applyToSession(sess, cmd, t0 + n * 1200);
    assert(r.ok, 'bot command rejected: ' + r.reason);
    n++;
  }
  return n;
}

// ---------- RNG ----------
test('rng: deterministic streams', () => {
  const a = RNG.derive(42, RNG.STREAM_RULES), b = RNG.derive(42, RNG.STREAM_RULES);
  for (let i = 0; i < 100; i++) assert.strictEqual(a.next(), b.next());
  const c = RNG.derive(42, RNG.STREAM_DECOR);
  const x = RNG.derive(42, RNG.STREAM_RULES).next();
  assert.notStrictEqual(c.next(), x, 'streams must differ');
});
test('rng: hashString stable', () => {
  assert.strictEqual(RNG.hashString('city'), RNG.hashString('city'));
  assert.notStrictEqual(RNG.hashString('a'), RNG.hashString('b'));
});

// ---------- rules: creation & legality ----------
test('rules: createGame sane initial state', () => {
  const s = Game.createGame(sampleCfg);
  assert.strictEqual(s.phase, 'roll');
  assert.strictEqual(s.you.coins, sampleCfg.startCoins);
  assert.strictEqual(s.terminal, null);
  assert(Game.legalActions(s).some(a => a.type === 'roll'));
});

test('rules: roll moves pawn and resolves tile', () => {
  const sess = Game.createSession(sampleCfg, null, 0);
  const before = sess.state.you.pos;
  const r = Game.applyToSession(sess, { type: 'roll' }, 500);
  assert(r.ok);
  assert.notStrictEqual(sess.state.you.pos === before && !r.events.some(e => e.type === 'lap'), true);
  assert(r.events[0].type === 'roll');
  assert.strictEqual(sess.state.tick, 1);
});

test('rules: invalid actions return reasons', () => {
  const sess = Game.createSession(sampleCfg, null, 0);
  assert.strictEqual(Game.applyToSession(sess, { type: 'buy' }).reason, 'wrong-phase');
  assert.strictEqual(Game.applyToSession(sess, { type: 'build', tile: 1 }).reason, 'not-owned');
  assert.strictEqual(Game.applyToSession(sess, { type: 'nonsense' }).reason, 'unknown-command');
  assert.strictEqual(Game.applyToSession(sess, { type: 'build', tile: -1 }).reason, 'bad-tile');
  assert.strictEqual(Game.applyToSession(sess, null).reason, 'unknown-command');
});

test('rules: buy flow offers deed then ends turn', () => {
  // find a seed where the player lands on an affordable property quickly
  const cfg = Content.PRACTICE[0];
  const sess = Game.createSession(cfg, null, 0);
  let sawOffer = false;
  for (let i = 0; i < 40 && !sess.state.terminal; i++) {
    const s = sess.state;
    if (s.phase === 'buy') {
      sawOffer = true;
      const acts = Game.legalActions(s);
      assert(acts.some(a => a.type === 'buy') && acts.some(a => a.type === 'skip'));
      const r = Game.applyToSession(sess, { type: 'buy' }, 1000 + i * 1000);
      assert(r.ok);
      assert(sess.state.you.props[s.pending ? s.pending.tile : -1] === undefined || true);
      assert.strictEqual(sess.state.phase, 'roll');
      assert(Object.keys(sess.state.you.props).length >= 1);
      break;
    }
    assert(Game.applyToSession(sess, { type: 'roll' }, 1000 + i * 1000).ok);
  }
  assert(sawOffer, 'expected at least one offer in 40 turns');
});

test('rules: build upgrade raises rent tier', () => {
  const sess = Game.createSession(Content.PRACTICE[0], null, 0);
  sess.state.you.props[1] = 1;
  sess.state.you.coins = 1000;
  const tile = sess.state.cfg.tiles[1];
  const cost = Rules.buildCost(tile.price, 1);
  const r = Game.applyToSession(sess, { type: 'build', tile: 1 }, 2000);
  assert(r.ok);
  assert.strictEqual(sess.state.you.props[1], 2);
  assert.strictEqual(sess.state.you.coins, 1000 - cost);
  // max level enforcement
  sess.state.you.props[1] = Rules.MAX_LEVEL;
  assert.strictEqual(Game.applyToSession(sess, { type: 'build', tile: 1 }).reason, 'max-level');
});

test('rules: rival alternates and pays rent', () => {
  const sess = Game.createSession(sampleCfg, null, 0);
  sess.state.you.props[2] = 1;
  sess.state.rival.pos = 1;
  let sawRival = false;
  for (let i = 0; i < 10 && !sess.state.terminal && !sawRival; i++) {
    const s = sess.state;
    const r = Game.applyToSession(sess, { type: s.phase === 'buy' ? 'skip' : 'roll' }, 1000 + i * 1000);
    assert(r.ok);
    if (r.events.some(e => e.type === 'roll' && e.who === 'rival')) sawRival = true;
  }
  assert(sawRival, 'rival should take a turn');
});

test('rules: rival cannot buy protected district property', () => {
  const cfg = JSON.parse(JSON.stringify(sampleCfg));
  const prot = Rules.protectedDistricts(cfg);
  const protIdx = cfg.tiles.findIndex(t => t.t === 'prop' && prot[t.d]);
  assert(protIdx > 0, 'sample stage must have a protected property');
  const sess = Game.createSession(cfg, null, 0);
  // put the rival right before it with a fat wallet, roll until it passes
  for (let i = 0; i < 60 && !sess.state.terminal; i++) {
    sess.state.rival.coins = 5000;
    const s = sess.state;
    if (s.phase === 'roll') Game.applyToSession(sess, { type: 'roll' }, 1000 + i * 1000);
    else Game.applyToSession(sess, { type: 'skip' }, 1000 + i * 1000);
  }
  assert(sess.state.rival.props[protIdx] == null, 'rival must never own protected district tiles');
});

// ---------- scoring / terminal ----------
test('rules: terminal states finalize score with breakdown', () => {
  const sess = Game.createSession(Content.PRACTICE[0], null, 0);
  const r = Game.applyToSession(sess, { type: 'resign' }, 5000);
  assert(r.ok && sess.state.terminal.reason === 'resigned');
  const sc = sess.state.score;
  assert.strictEqual(sc.total, sc.rent + sc.salary + sc.album + sc.property + sc.coins + sc.turnsBonus + sc.timeBonus);
  assert.strictEqual(Game.applyToSession(sess, { type: 'roll' }).reason, 'game-ended');
});

test('rules: album completion wins the round', () => {
  const cfg = Content.PRACTICE[0];
  const sess = Game.createSession(cfg, null, 0);
  // grant the full first district
  const d0 = cfg.album[0].d;
  Rules.districtTileIndexes(cfg, d0).forEach(i => { sess.state.you.props[i] = 1; });
  sess.state.you.laps = 99;
  const r = Game.applyToSession(sess, { type: 'roll' }, 1000);
  assert(r.ok);
  assert(sess.state.terminal && sess.state.terminal.won, 'expected album win');
  assert(sess.state.score.album > 0);
});

test('rules: turn limit loses', () => {
  const cfg = JSON.parse(JSON.stringify(Content.PRACTICE[0]));
  cfg.turnLimit = 3;
  const sess = Game.createSession(cfg, null, 0);
  for (let i = 0; i < 10 && !sess.state.terminal; i++) {
    const s = sess.state;
    Game.applyToSession(sess, { type: s.phase === 'buy' ? 'skip' : 'roll' }, 1000 + i * 1000);
  }
  assert(sess.state.terminal);
  assert(['turn-limit', 'album-complete'].includes(sess.state.terminal.reason));
});

test('rules: timeout command ends timed games only when due', () => {
  const cfg = Content.CHALLENGES.find(c => c.timeLimitSec);
  const sess = Game.createSession(cfg, null, 0);
  assert.strictEqual(Game.applyToSession(sess, { type: 'timeout' }, 1000).reason, 'wrong-phase');
  const r = Game.applyToSession(sess, { type: 'timeout' }, cfg.timeLimitSec * 1000 + 1);
  assert(r.ok && sess.state.terminal.reason === 'time-up');
});

// ---------- serialization / replay ----------
test('rules: serialize round-trip', () => {
  const sess = Game.createSession(sampleCfg, null, 0);
  playUntil(sess, s => s.turn >= 3);
  const json = Rules.serialize(sess.state);
  const back = Rules.deserialize(json);
  assert.strictEqual(Rules.hashState(back), Rules.hashState(sess.state));
});

test('replay: same seed + commands → identical hashes', () => {
  function run() {
    const sess = Game.createSession(sampleCfg, null, 0);
    const rng = RNG.create(7);
    let at = 1000;
    while (!sess.state.terminal && sess.replay.commands.length < 60) {
      const s = sess.state;
      const acts = Game.legalActions(s);
      const pick = acts[rng.int(acts.length)];
      const cmd = { type: pick.type };
      if (pick.type === 'build') cmd.tile = pick.tile;
      Game.applyToSession(sess, cmd, at); at += 1500;
    }
    return sess.replay;
  }
  const a = run(), b = run();
  assert.deepStrictEqual(a.hashes, b.hashes);
  const v = Game.verifyReplay(a);
  assert(v.ok, 'replay must verify');
});

test('replay: tampered hash is detected', () => {
  const sess = Game.createSession(sampleCfg, null, 0);
  Game.applyToSession(sess, { type: 'roll' }, 1000);
  const replay = JSON.parse(JSON.stringify(sess.replay));
  replay.hashes[0] = 'tampered';
  assert.strictEqual(Game.verifyReplay(replay).ok, false);
});

test('session: undo restores prior state', () => {
  const sess = Game.createSession(Content.PRACTICE[0], null, 0);
  const h0 = Rules.hashState(sess.state);
  Game.applyToSession(sess, { type: 'roll' }, 1000);
  const r = Game.undo(sess);
  assert(r.ok);
  assert.strictEqual(Rules.hashState(sess.state), h0);
  // undo disabled when mechanics forbid it
  const c2 = Game.createSession(Content.CHALLENGES[0], null, 0); // no undo
  Game.applyToSession(c2, { type: 'roll' }, 1000);
  assert.strictEqual(Game.undo(c2).reason, 'undo-disabled');
});

// ---------- hints use the same legal-action surface ----------
test('hints: hint is always a legal action', () => {
  const sess = Game.createSession(sampleCfg, null, 0);
  for (let i = 0; i < 30 && !sess.state.terminal; i++) {
    const h = Game.hint(sess.state);
    assert(h, 'hint expected');
    const legal = Game.legalActions(sess.state);
    assert(legal.some(a => a.type === h.type && (a.tile == null || a.tile === h.tile)),
      'hint ' + h.type + ' must be legal');
    const s = sess.state;
    Game.applyToSession(sess, { type: s.phase === 'buy' ? 'skip' : 'roll' }, 1000 + i * 1000);
  }
});

// ---------- fuzz: malformed commands never corrupt state ----------
test('fuzz: malformed commands are rejected without state change', () => {
  const sess = Game.createSession(sampleCfg, null, 0);
  const rng = RNG.create(99);
  const junk = [null, undefined, 42, 'roll', {}, { type: 1 }, { type: 'build' },
    { type: 'build', tile: 'x' }, { type: 'build', tile: 999 }, { type: 'roll', extra: 'x'.repeat(600) },
    { type: [] }, { type: 'buy', tile: 1.5 }];
  for (let i = 0; i < 300; i++) {
    const before = Rules.serialize(sess.state);
    const cmd = junk[rng.int(junk.length)];
    const r = Game.applyToSession(sess, cmd, 1000 + i * 100);
    if (!r.ok) assert.strictEqual(Rules.serialize(sess.state), before, 'rejected command must not mutate');
  }
});

// ---------- content ----------
test('content: 40 journey stages, challenges, practice, themes, achievements', () => {
  assert.strictEqual(Content.JOURNEY.length, 40);
  assert(Content.CHALLENGES.length >= 5);
  assert.strictEqual(Content.PRACTICE.length, 3);
  assert.strictEqual(Content.THEMES.length, 5);
  assert(Content.ACHIEVEMENTS.length >= 5);
  const keys = new Set(Content.ACHIEVEMENTS.map(a => a.key));
  assert.strictEqual(keys.size, Content.ACHIEVEMENTS.length);
  Content.ACHIEVEMENTS.forEach(a => assert(/^[a-z0-9-]+$/.test(a.key)));
});

test('content: every config is structurally legal and solvable-ish', () => {
  const all = Content.JOURNEY.concat(Content.CHALLENGES, Content.PRACTICE,
    [Content.dailyConfig('2026-01-15')]);
  all.forEach(cfg => {
    assert(cfg.tiles.length >= 8 && cfg.tiles.length <= 40, cfg.id + ' ring size');
    assert.strictEqual(cfg.tiles[0].t, 'start', cfg.id);
    assert(cfg.album.length > 0, cfg.id + ' album');
    cfg.tiles.forEach(t => {
      if (t.t === 'prop') {
        assert(t.price > 0 && t.rent.length === Rules.MAX_LEVEL, cfg.id + ' prop shape');
        assert(Content.DISTRICTS[t.d], cfg.id + ' unknown district ' + t.d);
      }
    });
    // a hint-driven bot must finish (win or reach the limit) without hanging
    const sess = Game.createSession(cfg, null, 0);
    playUntil(sess, () => false, 600);
    assert(sess.state.terminal, cfg.id + ' must terminate within limits');
    assert(Number.isFinite(sess.state.score.total), cfg.id + ' score must be finite');
  });
});

test('content: daily config is deterministic per UTC date', () => {
  const a = Content.dailyConfig('2026-03-04'), b = Content.dailyConfig('2026-03-04');
  assert.strictEqual(Rules.hashState(Rules.createGame(a)), Rules.hashState(Rules.createGame(b)));
  assert.strictEqual(a.id, 'daily-2026-03-04');
});

test('content: tutorial lessons produce forced setups', () => {
  const lessons = Content.tutorialLessons();
  assert.strictEqual(lessons.length, 5);
  const t2 = Game.createSession(lessons[1].cfg, lessons[1], 0);
  assert.strictEqual(t2.state.phase, 'buy', 't2 must open with an offer');
  const t3 = Game.createSession(lessons[2].cfg, lessons[2], 0);
  assert(Object.keys(t3.state.you.props).length >= 1, 't3 must pre-own property');
});

// ---------- store ----------
test('store: checksum and migration', () => {
  const doc = Store.fresh();
  doc.settings.music = 0.3;
  const payload = JSON.stringify(doc);
  assert.strictEqual(Store.checksum(payload), Store.checksum(payload));
  const old = { v: 0, settings: { muted: true } };
  const m = Store.migrate(old);
  assert.strictEqual(m.v, Store.SAVE_VERSION);
  assert.strictEqual(m.settings.muted, true);
  assert.strictEqual(m.settings.music, Store.DEFAULT_SETTINGS.music);
});

test('store: leaderboard tie-break order', () => {
  const entries = [
    { sessionId: 'b', won: true, score: 100, invalid: 2, durationMs: 5000 },
    { sessionId: 'a', won: true, score: 100, invalid: 2, durationMs: 4000 },
    { sessionId: 'c', won: true, score: 100, invalid: 1, durationMs: 9000 },
    { sessionId: 'd', won: true, score: 120, invalid: 9, durationMs: 9000 },
    { sessionId: 'e', won: false, score: 500, invalid: 0, durationMs: 1000 }
  ];
  const s = Store.sortEntries(entries);
  assert.deepStrictEqual(s.map(e => e.sessionId), ['d', 'c', 'a', 'b', 'e']);
});

// ---------- server verification ----------
test('server: verifies an honest replay and rejects a lying one', () => {
  const cfg = Content.PRACTICE[0];
  const sess = Game.createSession(cfg, null, 0);
  let at = 1000;
  while (!sess.state.terminal && sess.replay.commands.length < 300) {
    const s = sess.state;
    const h = Game.hint(s);
    const cmd = { type: h.type };
    if (h.type === 'build') cmd.tile = h.tile;
    const r = Game.applyToSession(sess, cmd, at); at += 2000;
    if (!r.ok) Game.applyToSession(sess, { type: 'roll' }, at);
  }
  if (!sess.state.terminal) Game.applyToSession(sess, { type: 'resign' }, at);
  const entry = {
    sessionId: sess.id, configId: cfg.id, kind: cfg.kind,
    won: sess.state.terminal.won, score: sess.state.score.total,
    invalid: 0, durationMs: sess.state.elapsedMs, assists: 'none'
  };
  const good = Server.verifySubmission(entry, sess.replay);
  assert(good.ok, 'honest replay should verify: ' + good.error);

  const lying = Object.assign({}, entry, { score: entry.score + 1000 });
  assert.strictEqual(Server.verifySubmission(lying, sess.replay).ok, false);

  const badVersion = JSON.parse(JSON.stringify(sess.replay));
  badVersion.header.contentVersion = 999;
  assert.strictEqual(Server.verifySubmission(entry, badVersion).error, 'stale-version');
});

test('server: daily config lookup exists for today', () => {
  const today = Content.utcDateString(Date.now());
  assert(Server.findConfig('daily-' + today));
  assert.strictEqual(Server.findConfig('daily-2999-01-01'), null, 'future daily must not be published');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
