/* City Fortune — pure deterministic rules engine.
 * No rendering, no DOM, no Date.now(): every transition derives from
 * (state, command) only. Usable from browser (window.CFRules) and Node.
 *
 * Core loop: roll the die, move around the city circuit, resolve the
 * landing tile (buy property, pay rent, draw a card, collect bonuses),
 * spend coins on building upgrades between rolls, and complete the album
 * pages before the turn limit. A deterministic rival ("friend board")
 * takes alternating turns on the same circuit; it can contest unprotected
 * property and pays you rent, but it can never buy property that belongs
 * to an album district page (protected progress).
 */
(function (root, factory) {
  var RNG = (typeof module === 'object' && module.exports) ? require('./rng.js') : root.CFRNG;
  var api = factory(RNG);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CFRules = api;
})(typeof self !== 'undefined' ? self : this, function (RNG) {
  'use strict';

  var STATE_VERSION = 1;
  var MAX_LEVEL = 3;          // 1 = owned, 2 and 3 = building upgrades
  var CARD_DEPTH_CAP = 4;     // bound on card → move → card chains
  var TURN_BONUS_PT = 10;     // win bonus per unused turn
  var TIME_PT_PER_SEC = 5;    // win bonus per second under par time

  var TERMINAL = {
    ALBUM: 'album-complete',
    TURNS: 'turn-limit',
    TIME: 'time-up',
    RESIGN: 'resigned'
  };

  var INVALID = {
    ENDED: 'game-ended',
    PHASE: 'wrong-phase',
    BAD_CMD: 'unknown-command',
    BAD_SHAPE: 'malformed-command',
    BAD_TILE: 'bad-tile',
    UNAFFORDABLE: 'unaffordable',
    NOT_OWNED: 'not-owned',
    MAX_LEVEL: 'max-level'
  };

  // ---------- chance cards (fixed definitions; decks are authored in content) ----------
  var CARD_DEFS = {
    grant:    { id: 'grant',    name: 'City Grant',   text: 'Collect 120 coins.' },
    fine:     { id: 'fine',     name: 'Parking Fine', text: 'Pay 80 coins.' },
    advance:  { id: 'advance',  name: 'Tailwind',     text: 'Move forward 3 tiles and resolve it.' },
    setback:  { id: 'setback',  name: 'Detour',       text: 'Move back 2 tiles and resolve it.' },
    dividend: { id: 'dividend', name: 'Dividends',    text: 'Collect 30 coins per property you own.' },
    repair:   { id: 'repair',   name: 'Repairs',      text: 'Pay 25 coins per building level you own.' },
    tram:     { id: 'tram',     name: 'Express Tram', text: 'Ride to Start and collect your salary.' }
  };

  // ---------- helpers ----------

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // Stable stringify: object keys sorted recursively → canonical hashing.
  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) {
      var out = '[';
      for (var i = 0; i < v.length; i++) out += (i ? ',' : '') + stableStringify(v[i]);
      return out + ']';
    }
    var keys = Object.keys(v).sort(), s = '{';
    for (var k = 0; k < keys.length; k++) {
      s += (k ? ',' : '') + JSON.stringify(keys[k]) + ':' + stableStringify(v[keys[k]]);
    }
    return s + '}';
  }

  function hashState(state) {
    var copy = clone(state);
    delete copy.events;
    return RNG.hashString(stableStringify(copy));
  }

  function otherSide(who) { return who === 'you' ? 'rival' : 'you'; }

  function ownerOf(state, tileIdx) {
    if (state.you.props[tileIdx] != null) return 'you';
    if (state.rival && state.rival.props[tileIdx] != null) return 'rival';
    return null;
  }

  function buildCost(price, fromLevel) {
    if (fromLevel === 1) return Math.ceil(price * 0.6);
    if (fromLevel === 2) return Math.ceil(price * 0.8);
    return 0;
  }

  function investedValue(tile, level) { // price + all build costs paid
    var v = tile.price;
    for (var l = 1; l < level; l++) v += buildCost(tile.price, l);
    return v;
  }

  function netWorth(state, who) {
    var side = state[who];
    if (!side) return 0;
    var w = side.coins;
    for (var idx in side.props) w += investedValue(state.cfg.tiles[idx], side.props[idx]);
    return w;
  }

  // Districts referenced by album district pages: the rival may never buy
  // these, so friend-board interaction cannot destroy protected progress.
  function protectedDistricts(cfg) {
    var set = {};
    (cfg.album || []).forEach(function (p) { if (p.type === 'district') set[p.d] = true; });
    return set;
  }

  function districtTileIndexes(cfg, d) {
    var out = [];
    cfg.tiles.forEach(function (t, i) { if (t.t === 'prop' && t.d === d) out.push(i); });
    return out;
  }

  // ---------- album pages ----------

  function pageProgress(state, page) {
    var have = 0, need = page.count || 0;
    if (page.type === 'district') {
      var idxs = districtTileIndexes(state.cfg, page.d);
      need = idxs.length;
      idxs.forEach(function (i) { if (state.you.props[i] != null) have++; });
    } else if (page.type === 'upgrades') {
      for (var idx in state.you.props) have += state.you.props[idx] - 1;
    } else if (page.type === 'laps') {
      have = state.you.laps;
    } else if (page.type === 'stickers') {
      have = state.you.stickers;
    } else if (page.type === 'rent') {
      have = state.stats.rentCollected;
    }
    return { have: have, need: need, done: have >= need };
  }

  // Marks newly completed pages; returns true when every page is done.
  function checkAlbum(state, events) {
    var all = true;
    (state.cfg.album || []).forEach(function (p) {
      if (state.albumDone[p.id]) return;
      var prog = pageProgress(state, p);
      if (prog.done) {
        state.albumDone[p.id] = true;
        state.albumBonus += p.bonus;
        events.push({ type: 'page-complete', page: p.id, name: p.name, bonus: p.bonus });
      }
    });
    (state.cfg.album || []).forEach(function (p) { if (!state.albumDone[p.id]) all = false; });
    return all && (state.cfg.album || []).length > 0;
  }

  // ---------- game creation ----------

  // cfg: { id, version, kind, seed, name, tiles:[], album:[], cards:[],
  //        dice, turnLimit, timeLimitSec, startCoins, salary,
  //        rival:{name} | null, rivalReserve, par:{turns,timeSec},
  //        mechanics:{undo,hint} }
  function createGame(cfg) {
    var seed = cfg.seed >>> 0;
    var rng = RNG.derive(seed, RNG.STREAM_RULES);
    var state = {
      v: STATE_VERSION,
      cfg: clone(cfg),
      seed: seed,
      rngState: 0,
      tick: 0,
      turn: 0,
      phase: 'roll', // 'roll' | 'buy'
      you: { pos: 0, coins: cfg.startCoins, laps: 0, stickers: 0, props: {} },
      rival: cfg.rival ? { name: cfg.rival.name, pos: 0, coins: cfg.startCoins, laps: 0, props: {} } : null,
      deck: rng.shuffle((cfg.cards || []).slice()),
      discard: [],
      pending: null,
      albumDone: {},
      albumBonus: 0,
      stats: { rentCollected: 0, rentPaid: 0, salary: 0, bonuses: 0, tolls: 0, builds: 0 },
      score: { rent: 0, salary: 0, album: 0, property: 0, coins: 0, turnsBonus: 0, timeBonus: 0, total: 0 },
      elapsedMs: 0,
      terminal: null,
      events: []
    };
    state.rngState = rng.state;
    return state;
  }

  // ---------- movement & tile resolution ----------

  function moveActor(state, who, n, events) {
    var side = state[who];
    var len = state.cfg.tiles.length;
    var from = side.pos;
    var to = ((from + n) % len + len) % len;
    if (n > 0 && from + n >= len) {
      side.laps++;
      side.coins += state.cfg.salary;
      if (who === 'you') state.stats.salary += state.cfg.salary;
      events.push({ type: 'lap', who: who, laps: side.laps, salary: state.cfg.salary });
    }
    side.pos = to;
    return to;
  }

  function drawCard(state, who, depth, events, rng) {
    if (!state.deck.length) {
      if (!state.discard.length) { events.push({ type: 'card-skip', who: who }); return; }
      state.deck = rng.shuffle(state.discard);
      state.discard = [];
      events.push({ type: 'deck-reshuffle', who: who });
    }
    var id = state.deck.shift();
    var card = CARD_DEFS[id];
    state.discard.push(id);
    events.push({ type: 'card', who: who, card: id, name: card.name, text: card.text });
    var side = state[who];
    if (id === 'grant') {
      side.coins += 120; if (who === 'you') state.stats.bonuses += 120;
    } else if (id === 'fine') {
      var p = Math.min(side.coins, 80); side.coins -= p; if (who === 'you') state.stats.tolls += p;
    } else if (id === 'dividend') {
      var n = Object.keys(side.props).length;
      var g = 30 * n; side.coins += g; if (who === 'you') state.stats.bonuses += g;
    } else if (id === 'repair') {
      var lv = 0;
      for (var idx in side.props) lv += side.props[idx];
      var c = Math.min(side.coins, 25 * lv); side.coins -= c; if (who === 'you') state.stats.tolls += c;
    } else if (id === 'advance' || id === 'setback') {
      var delta = id === 'advance' ? 3 : -2;
      events.push({ type: 'card-move', who: who, delta: delta, from: side.pos });
      moveActor(state, who, delta, events);
      resolveLanding(state, who, depth + 1, events, rng);
    } else if (id === 'tram') {
      if (side.pos !== 0) {
        side.pos = 0;
        side.laps++;
        side.coins += state.cfg.salary;
        if (who === 'you') state.stats.salary += state.cfg.salary;
        events.push({ type: 'lap', who: who, laps: side.laps, salary: state.cfg.salary, tram: true });
      }
    }
  }

  function resolveLanding(state, who, depth, events, rng) {
    var side = state[who];
    var idx = side.pos;
    var tile = state.cfg.tiles[idx];
    switch (tile.t) {
      case 'prop': {
        var owner = ownerOf(state, idx);
        if (!owner) {
          if (who === 'you') {
            if (side.coins >= tile.price) {
              state.phase = 'buy';
              state.pending = { tile: idx, price: tile.price };
              events.push({ type: 'offer', tile: idx, price: tile.price });
            } else {
              events.push({ type: 'cannot-afford', tile: idx, price: tile.price });
            }
          } else {
            var prot = protectedDistricts(state.cfg);
            var reserve = state.cfg.rivalReserve == null ? 40 : state.cfg.rivalReserve;
            if (!prot[tile.d] && side.coins >= tile.price + reserve) {
              side.coins -= tile.price;
              side.props[idx] = 1;
              events.push({ type: 'buy', who: 'rival', tile: idx, price: tile.price });
            } else {
              events.push({ type: 'rival-pass', tile: idx });
            }
          }
        } else if (owner === who) {
          events.push({ type: 'own-visit', who: who, tile: idx });
        } else {
          var lvl = state[owner].props[idx];
          var due = tile.rent[lvl - 1];
          var paid = Math.min(side.coins, due);
          side.coins -= paid;
          state[owner].coins += paid;
          if (who === 'you') state.stats.rentPaid += paid;
          else state.stats.rentCollected += paid;
          events.push({ type: 'rent', from: who, to: owner, tile: idx, amount: paid, due: due, level: lvl });
        }
        break;
      }
      case 'bonus':
        side.coins += tile.amt;
        if (who === 'you') state.stats.bonuses += tile.amt;
        events.push({ type: 'bonus', who: who, amount: tile.amt });
        break;
      case 'toll': {
        var p = Math.min(side.coins, tile.amt);
        side.coins -= p;
        if (who === 'you') state.stats.tolls += p;
        events.push({ type: 'toll', who: who, amount: p, due: tile.amt });
        break;
      }
      case 'card':
        if (depth < CARD_DEPTH_CAP) drawCard(state, who, depth, events, rng);
        else events.push({ type: 'card-skip', who: who });
        break;
      case 'sticker':
        if (who === 'you') {
          side.stickers++;
          events.push({ type: 'sticker', count: side.stickers });
        } else {
          events.push({ type: 'rival-idle', tile: idx });
        }
        break;
      case 'park':
        events.push({ type: 'park', who: who });
        break;
      default: // 'start'
        events.push({ type: 'start-visit', who: who });
        break;
    }
  }

  function rivalTurn(state, events, rng) {
    var die = rng.range(1, state.cfg.dice || 6);
    events.push({ type: 'roll', who: 'rival', die: die, from: state.rival.pos });
    moveActor(state, 'rival', die, events);
    resolveLanding(state, 'rival', 0, events, rng);
  }

  // Wraps up a player turn: album victory, clock, rival turn, turn limit.
  function endTurn(state, events, rng) {
    if (checkAlbum(state, events)) {
      state.terminal = { reason: TERMINAL.ALBUM, won: true };
      events.push({ type: 'win', reason: TERMINAL.ALBUM });
      return;
    }
    if (state.cfg.timeLimitSec && state.elapsedMs >= state.cfg.timeLimitSec * 1000) {
      state.terminal = { reason: TERMINAL.TIME, won: false };
      events.push({ type: 'lose', reason: TERMINAL.TIME });
      return;
    }
    if (state.rival) {
      rivalTurn(state, events, rng);
      // Rival rent income may complete a 'rent' album page.
      if (checkAlbum(state, events)) {
        state.terminal = { reason: TERMINAL.ALBUM, won: true };
        events.push({ type: 'win', reason: TERMINAL.ALBUM });
        return;
      }
    }
    state.turn++;
    if (state.cfg.turnLimit && state.turn >= state.cfg.turnLimit) {
      state.terminal = { reason: TERMINAL.TURNS, won: false };
      events.push({ type: 'lose', reason: TERMINAL.TURNS });
    }
  }

  // ---------- legality ----------

  function legalActions(state) {
    if (state.terminal) return [];
    if (state.phase === 'buy') {
      return [
        { type: 'buy', tile: state.pending.tile, price: state.pending.price },
        { type: 'skip' }
      ];
    }
    var acts = [{ type: 'roll' }];
    for (var idx in state.you.props) {
      var lvl = state.you.props[idx];
      if (lvl < MAX_LEVEL) {
        var cost = buildCost(state.cfg.tiles[idx].price, lvl);
        if (state.you.coins >= cost) acts.push({ type: 'build', tile: +idx, cost: cost, level: lvl + 1 });
      }
    }
    return acts;
  }

  function checkCommand(state, cmd) {
    if (state.terminal) return INVALID.ENDED;
    if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') return INVALID.BAD_SHAPE;
    if (cmd.type === 'roll') return state.phase === 'roll' ? null : INVALID.PHASE;
    if (cmd.type === 'buy' || cmd.type === 'skip') return state.phase === 'buy' ? null : INVALID.PHASE;
    if (cmd.type === 'resign') return null;
    if (cmd.type === 'timeout') {
      if (!state.cfg.timeLimitSec) return INVALID.PHASE;
      var at = typeof cmd.atMs === 'number' ? cmd.atMs : state.elapsedMs;
      return at >= state.cfg.timeLimitSec * 1000 ? null : INVALID.PHASE;
    }
    if (cmd.type === 'build') {
      if (state.phase !== 'roll') return INVALID.PHASE;
      var i = cmd.tile;
      var tile = state.cfg.tiles[i];
      if (!Number.isInteger(i) || !tile || tile.t !== 'prop') return INVALID.BAD_TILE;
      var lvl = state.you.props[i];
      if (lvl == null) return INVALID.NOT_OWNED;
      if (lvl >= MAX_LEVEL) return INVALID.MAX_LEVEL;
      if (state.you.coins < buildCost(tile.price, lvl)) return INVALID.UNAFFORDABLE;
      return null;
    }
    return INVALID.BAD_CMD;
  }

  // ---------- resolution ----------

  function applyCommand(state, cmd) {
    var reason = checkCommand(state, cmd);
    if (reason) return { ok: false, reason: reason, state: state, events: [] };

    var s = clone(state);
    s.events = [];
    s.tick++;
    if (typeof cmd.atMs === 'number' && isFinite(cmd.atMs) && cmd.atMs >= 0) {
      s.elapsedMs = Math.floor(cmd.atMs / 100) * 100; // quantized, replay-safe
    }
    var rng = RNG.create(s.rngState);
    var events = s.events;

    if (cmd.type === 'resign') {
      s.terminal = { reason: TERMINAL.RESIGN, won: false };
      events.push({ type: 'lose', reason: TERMINAL.RESIGN });
    } else if (cmd.type === 'timeout') {
      s.terminal = { reason: TERMINAL.TIME, won: false };
      events.push({ type: 'lose', reason: TERMINAL.TIME });
    } else if (cmd.type === 'roll') {
      var die = rng.range(1, s.cfg.dice || 6);
      events.push({ type: 'roll', who: 'you', die: die, from: s.you.pos });
      moveActor(s, 'you', die, events);
      resolveLanding(s, 'you', 0, events, rng);
      if (s.phase === 'roll') endTurn(s, events, rng); // no pending offer
    } else if (cmd.type === 'buy') {
      var p = s.pending;
      s.you.coins -= p.price;
      s.you.props[p.tile] = 1;
      events.push({ type: 'buy', who: 'you', tile: p.tile, price: p.price });
      s.pending = null;
      s.phase = 'roll';
      endTurn(s, events, rng);
    } else if (cmd.type === 'skip') {
      events.push({ type: 'skip', tile: s.pending.tile });
      s.pending = null;
      s.phase = 'roll';
      endTurn(s, events, rng);
    } else if (cmd.type === 'build') {
      var t = s.cfg.tiles[cmd.tile];
      var lvl = s.you.props[cmd.tile];
      var cost = buildCost(t.price, lvl);
      s.you.coins -= cost;
      s.you.props[cmd.tile] = lvl + 1;
      s.stats.builds++;
      events.push({ type: 'build', tile: cmd.tile, level: lvl + 1, cost: cost });
      if (checkAlbum(s, events)) {
        s.terminal = { reason: TERMINAL.ALBUM, won: true };
        events.push({ type: 'win', reason: TERMINAL.ALBUM });
      }
    }

    s.rngState = rng.state;
    if (s.terminal) finalizeScore(s);
    return { ok: true, state: s, events: events };
  }

  function finalizeScore(s) {
    var sc = s.score;
    sc.rent = s.stats.rentCollected;
    sc.salary = s.stats.salary;
    sc.album = s.albumBonus;
    sc.property = 0;
    for (var idx in s.you.props) sc.property += investedValue(s.cfg.tiles[idx], s.you.props[idx]);
    sc.coins = s.you.coins;
    sc.turnsBonus = 0;
    if (s.terminal.won && s.cfg.turnLimit) {
      sc.turnsBonus = Math.max(0, s.cfg.turnLimit - s.turn) * TURN_BONUS_PT;
    }
    sc.timeBonus = 0;
    if (s.terminal.won && s.cfg.par && s.cfg.par.timeSec && s.elapsedMs > 0 &&
        s.elapsedMs < s.cfg.par.timeSec * 1000) {
      sc.timeBonus = Math.floor((s.cfg.par.timeSec * 1000 - s.elapsedMs) / 1000) * TIME_PT_PER_SEC;
    }
    sc.total = sc.rent + sc.salary + sc.album + sc.property + sc.coins + sc.turnsBonus + sc.timeBonus;
  }

  // Running total for the HUD before the game ends.
  function currentScore(s) {
    var property = 0;
    for (var idx in s.you.props) property += investedValue(s.cfg.tiles[idx], s.you.props[idx]);
    return s.stats.rentCollected + s.stats.salary + s.albumBonus + property + s.you.coins;
  }

  // ---------- hints (same legality surface as play) ----------

  function hint(state) {
    var acts = legalActions(state);
    if (!acts.length) return null;
    if (state.phase === 'buy') {
      var p = state.pending;
      var tile = state.cfg.tiles[p.tile];
      var needed = protectedDistricts(state.cfg)[tile.d];
      if (needed) return { type: 'buy', tile: p.tile, why: 'buy-district' };
      if (p.price <= state.you.coins * 0.6) return { type: 'buy', tile: p.tile, why: 'buy-cheap' };
      return { type: 'skip', why: 'skip-expensive' };
    }
    // Prefer a build that works toward an incomplete upgrades page.
    var upgradePage = (state.cfg.album || []).find(function (pg) {
      return pg.type === 'upgrades' && !state.albumDone[pg.id];
    });
    var builds = acts.filter(function (a) { return a.type === 'build'; });
    if (builds.length && upgradePage) return { type: 'build', tile: builds[0].tile, why: 'build-page' };
    if (builds.length && state.you.coins > 2 * builds[0].cost) {
      return { type: 'build', tile: builds[0].tile, why: 'build-rent' };
    }
    return { type: 'roll', why: 'roll' };
  }

  // ---------- validation (network / replay boundary) ----------

  function validateCommandShape(cmd, maxLen) {
    if (!cmd || typeof cmd !== 'object') return INVALID.BAD_SHAPE;
    if (JSON.stringify(cmd).length > (maxLen || 512)) return INVALID.BAD_SHAPE;
    var types = { roll: 1, buy: 1, skip: 1, build: 1, resign: 1, timeout: 1 };
    if (!types[cmd.type]) return INVALID.BAD_CMD;
    if (cmd.id != null && (typeof cmd.id !== 'string' || cmd.id.length > 64)) return INVALID.BAD_SHAPE;
    if (cmd.type === 'build' && !Number.isInteger(cmd.tile)) return INVALID.BAD_SHAPE;
    return null;
  }

  // ---------- serialization ----------

  function serialize(state) { return JSON.stringify(state); }
  function deserialize(json) {
    var s = JSON.parse(json);
    if (s.v !== STATE_VERSION) throw new Error('unsupported state version ' + s.v);
    return s;
  }

  return {
    STATE_VERSION: STATE_VERSION,
    MAX_LEVEL: MAX_LEVEL,
    TERMINAL: TERMINAL,
    INVALID: INVALID,
    CARD_DEFS: CARD_DEFS,
    createGame: createGame,
    applyCommand: applyCommand,
    checkCommand: checkCommand,
    legalActions: legalActions,
    hint: hint,
    pageProgress: pageProgress,
    protectedDistricts: protectedDistricts,
    districtTileIndexes: districtTileIndexes,
    ownerOf: ownerOf,
    buildCost: buildCost,
    investedValue: investedValue,
    netWorth: netWorth,
    currentScore: currentScore,
    finalizeScore: finalizeScore,
    hashState: hashState,
    stableStringify: stableStringify,
    serialize: serialize,
    deserialize: deserialize,
    clone: clone,
    validateCommandShape: validateCommandShape
  };
});
