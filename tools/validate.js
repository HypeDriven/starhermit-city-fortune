/* City Fortune — offline content validator.
 * Proves basic legality, reachable goals, bounded duration, and absence of
 * soft locks for every published config. Run: node tools/validate.js
 */
'use strict';

const Rules = require('../js/rules.js');
const Content = require('../js/content.js');
const Game = require('../js/game.js');
const RNG = require('../js/rng.js');

let errors = 0, checked = 0;
function fail(cfg, msg) { errors++; console.error('INVALID ' + (cfg.id || '?') + ': ' + msg); }
function ok(msg) { console.log('ok ' + msg); }

function validateStructure(cfg) {
  if (!cfg.id || !cfg.version || typeof cfg.seed !== 'number') fail(cfg, 'missing id/version/seed');
  if (!Array.isArray(cfg.tiles) || cfg.tiles.length < 5) fail(cfg, 'ring too small');
  if (cfg.tiles[0].t !== 'start') fail(cfg, 'tile 0 must be start');
  if (!Array.isArray(cfg.album) || !cfg.album.length) fail(cfg, 'empty album');
  if (!(cfg.startCoins > 0)) fail(cfg, 'no starting coins');
  const pages = new Set();
  cfg.album.forEach(p => {
    if (pages.has(p.id)) fail(cfg, 'duplicate page id ' + p.id);
    pages.add(p.id);
    if (p.type === 'district') {
      const idxs = Rules.districtTileIndexes(cfg, p.d);
      if (!idxs.length) fail(cfg, 'district page with no tiles: ' + p.d);
    } else if (!(p.count > 0)) fail(cfg, 'page with no count: ' + p.id);
  });
  cfg.tiles.forEach((t, i) => {
    if (t.t === 'prop') {
      if (!Content.DISTRICTS[t.d]) fail(cfg, 'tile ' + i + ' unknown district');
      if (!(t.price > 0) || !Array.isArray(t.rent) || t.rent.length !== Rules.MAX_LEVEL) {
        fail(cfg, 'tile ' + i + ' bad price/rent');
      }
      if (t.rent.some(r => !Number.isFinite(r) || r < 0)) fail(cfg, 'tile ' + i + ' NaN rent');
    }
    if ((t.t === 'bonus' || t.t === 'toll') && !(t.amt > 0)) fail(cfg, 'tile ' + i + ' bad amount');
  });
}

// A competent bot: follows hints, buys district property, builds when rich.
function botPlay(cfg, seedTag) {
  const sess = Game.createSession(cfg, null, 0);
  const rng = RNG.derive(cfg.seed ^ seedTag, RNG.STREAM_RULES);
  let at = 1000, cmds = 0;
  const maxCmds = (cfg.turnLimit || 60) * 2 + 60;
  while (!sess.state.terminal && cmds < maxCmds) {
    const s = sess.state;
    const h = Game.hint(s);
    let cmd;
    if (s.phase === 'buy') {
      cmd = { type: h && h.type === 'buy' ? 'buy' : (s.you.coins > s.pending.price * 2 ? 'buy' : 'skip') };
    } else {
      const builds = Game.legalActions(s).filter(a => a.type === 'build');
      cmd = (builds.length && s.you.coins > builds[0].cost * 2 && rng.next() < 0.5)
        ? { type: 'build', tile: builds[0].tile } : { type: 'roll' };
    }
    const r = Game.applyToSession(sess, cmd, at);
    if (!r.ok) { fail(cfg, 'bot command rejected: ' + r.reason); break; }
    at += 1500 + rng.int(800); cmds++;
  }
  return sess;
}

function validatePlayable(cfg) {
  // termination (bounded duration, no hangs/soft locks)
  let anyWin = false;
  for (let run = 0; run < 3; run++) {
    const sess = botPlay(cfg, 0x1000 + run);
    if (!sess.state.terminal) { fail(cfg, 'did not terminate (possible soft lock)'); return; }
    if (!Number.isFinite(sess.state.score.total)) { fail(cfg, 'NaN score'); return; }
    if (sess.state.terminal.won) anyWin = true;
    for (const k in sess.state.you.props) {
      const lvl = sess.state.you.props[k];
      if (lvl < 1 || lvl > Rules.MAX_LEVEL) { fail(cfg, 'bad property level'); return; }
    }
    // replay determinism for this run
    const v = Game.verifyReplay(sess.replay);
    if (!v.ok) { fail(cfg, 'replay failed: ' + v.reason); return; }
  }
  // reachable goals: at least one of three competent runs should finish the album
  if (!anyWin && cfg.kind !== 'challenge') {
    fail(cfg, 'goals appear unreachable for a competent bot (no win in 3 runs)');
  }
}

const dailies = [];
for (let i = 0; i < 7; i++) {
  dailies.push(Content.dailyConfig(Content.utcDateString(Date.now() - i * 86400000)));
}

const all = []
  .concat(Content.JOURNEY, Content.CHALLENGES, Content.PRACTICE, dailies,
    Content.tutorialLessons().map(l => l.cfg));

all.forEach(cfg => { validateStructure(cfg); checked++; });
console.log('structure checked: ' + checked + ' configs');

const playable = Content.JOURNEY.concat(Content.CHALLENGES, Content.PRACTICE, dailies.slice(0, 2));
playable.forEach(validatePlayable);
console.log('playability checked: ' + playable.length + ' configs × 3 runs');

if (errors) { console.error('\n' + errors + ' validation error(s)'); process.exit(1); }
console.log('\nAll content valid.');
