/* City Fortune — versioned content: districts, themes, journey, challenges,
 * practice presets, daily ruleset generator, tutorial lessons, achievements.
 * Shared browser (window.CFContent) / Node. Content is data-only; all
 * randomness enters through the config seed.
 */
(function (root, factory) {
  var RNG = (typeof module === 'object' && module.exports) ? require('./rng.js') : root.CFRNG;
  var api = factory(RNG);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CFContent = api;
})(typeof self !== 'undefined' ? self : this, function (RNG) {
  'use strict';

  var CONTENT_VERSION = 1;

  // ---------- districts (color + icon + label: color is never the only cue) ----------
  var DISTRICT_ORDER = ['harbor', 'market', 'garden', 'arts', 'tech', 'oldtown'];
  var DISTRICTS = {
    harbor:  { label: 'Harbor',   icon: '⚓', color: 0x4a7fb8, colorHC: 0x2e6fe4 },
    market:  { label: 'Market',   icon: '🧺', color: 0xd9934a, colorHC: 0xb7791f },
    garden:  { label: 'Garden',   icon: '🌿', color: 0x5d9c59, colorHC: 0x17a398 },
    arts:    { label: 'Arts',     icon: '🎭', color: 0x8e6fc0, colorHC: 0x8e24aa },
    tech:    { label: 'Tech',     icon: '💡', color: 0x4aa8a8, colorHC: 0x00838f },
    oldtown: { label: 'Old Town', icon: '🏘', color: 0xb85450, colorHC: 0xc62828 }
  };

  var RIVAL_NAMES = ['Penny', 'Brick', 'Moss', 'Vela', 'Cobalt'];

  // ---------- themes (cosmetic only: materials, light, ambience) ----------
  var THEMES = [
    { id: 'paper',    name: 'Paper Dawn',      unlockStars: 0,
      palette: { sky: 0xf2e4c8, fog: 0xe8d8b8, ground: 0xd9c49a, ring: 0xf6ecd4, edge: 0xb89a6a,
                 light: 0xffe0b0, accent: 0xe07f3e, token: 0xd94f3d, tokenRival: 0x4a6fa8 } },
    { id: 'canal',    name: 'Canal Dusk',      unlockStars: 12,
      palette: { sky: 0x24324a, fog: 0x2c3c58, ground: 0x33455e, ring: 0x48607e, edge: 0x24344a,
                 light: 0x9fc8ff, accent: 0x7fb0ff, token: 0xffb066, tokenRival: 0x8fd6a0 } },
    { id: 'blossom',  name: 'Blossom Festival', unlockStars: 30,
      palette: { sky: 0xf6dce4, fog: 0xf0ccd8, ground: 0xe4c4cc, ring: 0xfae8ea, edge: 0xc49aa8,
                 light: 0xffd0e0, accent: 0xd95f8a, token: 0x7a4fb8, tokenRival: 0x4a8a5a } },
    { id: 'midnight', name: 'Midnight Metro',  unlockStars: 55,
      palette: { sky: 0x161a26, fog: 0x1c2130, ground: 0x232838, ring: 0x323a4e, edge: 0x141824,
                 light: 0x8fb8ff, accent: 0xffc46a, token: 0xffd90a, tokenRival: 0x6ac8e0 } },
    { id: 'harvest',  name: 'Harvest Fair',    unlockStars: 85,
      palette: { sky: 0xf0d8b0, fog: 0xe6cba0, ground: 0xc9ad7e, ring: 0xf0e2c0, edge: 0xa8854f,
                 light: 0xffe8c0, accent: 0xb86a2e, token: 0x8a4fb8, tokenRival: 0x3f7a5a } }
  ];

  // ---------- price tiers ----------
  function tierPrice(tier) { return 60 + tier * 40; }
  function tierRent(price) {
    return [Math.round(price * 0.2), Math.round(price * 0.55), Math.round(price * 1.05)];
  }

  // ---------- ring builder ----------
  // spec: { seed, districts:[[dIdx,count,tier]...],
  //         bonus:[amt...], toll:[amt...], card:n, sticker:n, park:n }
  // Deterministic layout: Start at 0; each district block is followed by one
  // special tile (seeded order); leftover specials trail the last block.
  function buildTiles(spec) {
    var rng = RNG.derive(spec.seed >>> 0, RNG.STREAM_DECOR);
    var specials = [];
    (spec.bonus || []).forEach(function (a) { specials.push({ t: 'bonus', amt: a }); });
    (spec.toll || []).forEach(function (a) { specials.push({ t: 'toll', amt: a }); });
    for (var i = 0; i < (spec.card || 0); i++) specials.push({ t: 'card' });
    for (i = 0; i < (spec.sticker || 0); i++) specials.push({ t: 'sticker' });
    for (i = 0; i < (spec.park || 0); i++) specials.push({ t: 'park' });
    rng.shuffle(specials);

    var tiles = [{ t: 'start' }];
    spec.districts.forEach(function (db) {
      var d = DISTRICT_ORDER[db[0]], n = db[1], price = tierPrice(db[2]);
      for (var k = 0; k < n; k++) {
        tiles.push({ t: 'prop', d: d, price: price, rent: tierRent(price), label: DISTRICTS[d].label + ' ' + (k + 1) });
      }
      if (specials.length) tiles.push(specials.pop());
    });
    while (specials.length) tiles.push(specials.pop());
    return tiles;
  }

  var DECKS = {
    light: ['grant', 'fine', 'advance', 'grant'],
    standard: ['grant', 'fine', 'advance', 'setback', 'dividend', 'grant', 'fine'],
    full: ['grant', 'fine', 'advance', 'setback', 'dividend', 'repair', 'tram', 'grant', 'fine', 'advance']
  };

  function albumFrom(rows) {
    return rows.map(function (r, i) {
      var p = { id: 'pg' + i, type: r[0], bonus: r[r.length - 1] };
      if (r[0] === 'district') { p.d = DISTRICT_ORDER[r[1]]; p.name = DISTRICTS[p.d].label + ' set'; }
      else { p.count = r[1]; p.name = ({ upgrades: 'Developer', laps: 'Globetrotter', stickers: 'Sticker book', rent: 'Rent baron' })[r[0]]; }
      return p;
    });
  }

  // ---------- journey ----------
  // [id, name, seed, districts, specials, album, turnLimit, timeLimitSec,
  //  startCoins, salary, rival(0/1), parTurns, parTimeSec, themeIdx, deck, intro]
  var J = [
    ['j01','First Steps',      101,[[0,2,0],[1,2,0]],  [[50],[],0,0,2], [['district',0,200],['laps',2,150]], 30,0,300,200,0, 22,300,0,'light','Roll the die and move around the circuit. Buy every Harbor property to complete the set.'],
    ['j02','Market Morning',   102,[[1,2,0],[2,2,0]],  [[50],[30],0,0,1], [['district',1,200],['laps',2,150]], 30,0,300,200,0, 22,300,0,'light',''],
    ['j03','Park Loop',        103,[[2,2,0],[0,2,1]],  [[60],[30],0,0,2], [['district',2,200],['laps',3,150]], 32,0,320,200,0, 24,320,0,'light',''],
    ['j04','A Rival Arrives',  104,[[0,2,0],[1,2,0]],  [[50],[30],1,0,1], [['district',0,200],['district',1,200]], 34,0,320,200,1, 26,340,0,'light','Penny plays the same circuit on alternating turns. She pays you rent — and snaps up property you ignore.'],
    ['j05','Canal Side',       105,[[1,2,1],[2,2,0]],  [[60],[40],1,0,1], [['district',1,220],['laps',3,150]], 32,0,320,200,1, 24,320,0,'light',''],
    ['j06','Sticker Hunt',     106,[[0,2,0],[2,2,0]],  [[50],[30],1,2,1], [['district',0,200],['stickers',2,150]], 34,0,320,200,1, 26,340,0,'light','New: sticker tiles. Land on them to fill the sticker book page.'],
    ['j07','Garden Rows',      107,[[2,3,0],[1,2,1]],  [[60],[40],1,1,1], [['district',2,250],['laps',3,150]], 36,0,340,200,1, 28,360,0,'light',''],
    ['j08','First Crane',      108,[[0,2,1],[1,2,1]],  [[50],[40],1,1,1], [['district',0,220],['upgrades',2,200]], 36,0,360,200,1, 28,380,0,'light','New: building upgrades. Between rolls, tap your property to build — taller buildings charge higher rent.'],
    ['j09','Arts Quarter',     109,[[3,2,1],[0,2,1]],  [[60],[40],2,1,1], [['district',3,220],['stickers',2,150]], 36,0,360,200,1, 28,380,0,'standard','A new district: the Arts Quarter.'],
    ['j10','Corner Mastery',   110,[[0,2,1],[1,2,1],[2,2,0]],[[60],[40],2,1,1], [['district',0,220],['district',1,220],['upgrades',2,200]], 38,0,360,200,1, 30,400,1,'standard','MASTERY: two sets and a crane, with Penny at your heels.'],
    ['j11','Toll Road',        111,[[1,3,1],[3,2,1]],  [[50],[60],2,1,1], [['district',1,260],['laps',4,180]], 40,0,380,200,1, 30,420,1,'standard',''],
    ['j12','Rent Baron',       112,[[0,3,1],[2,2,1]],  [[60],[50],2,1,1], [['district',0,260],['rent',150,200]], 40,0,380,200,1, 30,420,1,'standard','New page: collect rent from your rival. Own what she lands on.'],
    ['j13','Tech Sprint',      113,[[4,2,1],[1,2,1]],  [[60],[50],2,2,1], [['district',4,240],['stickers',3,180]], 38,0,380,200,1, 30,400,1,'standard','A new district: Tech.'],
    ['j14','Double Duty',      114,[[2,2,1],[3,2,1]],  [[60],[50],2,1,1], [['district',2,240],['district',3,240]], 40,0,400,200,1, 32,420,1,'standard',''],
    ['j15','Old Town Charm',   115,[[5,2,1],[0,2,1]],  [[60],[50],2,2,1], [['district',5,240],['laps',4,180]], 40,0,400,200,1, 32,440,1,'standard','A new district: Old Town.'],
    ['j16','Beat the Clock',   116,[[1,2,1],[4,2,1]],  [[60],[50],2,1,1], [['district',1,240],['upgrades',2,200]], 40,300,400,200,1, 32,280,2,'standard','New: a time limit. Think briskly.'],
    ['j17','Wide Circuit',     117,[[0,3,1],[1,3,1]],  [[70],[60],2,2,1], [['district',0,280],['district',1,280]], 42,0,420,220,1, 34,460,2,'standard',''],
    ['j18','High Rises',       118,[[4,3,2],[2,2,1]],  [[70],[60],2,1,1], [['district',4,300],['upgrades',3,220]], 42,0,440,220,1, 34,460,2,'standard',''],
    ['j19','Full Deck',        119,[[3,2,1],[5,2,1]],  [[70],[60],3,2,1], [['district',3,260],['stickers',3,200]], 42,0,420,220,1, 34,460,2,'full','The full card deck is in play, including the Express Tram.'],
    ['j20','Grand Tour',       120,[[0,2,1],[1,2,1],[2,2,1]],[[70],[60],3,2,1], [['district',0,240],['district',1,240],['laps',5,220]], 44,300,440,220,1, 36,280,3,'full','MASTERY: two sets, five laps, clock running.'],
    ['j21','Penny’s Push',     121,[[1,3,2],[4,2,1]],  [[70],[70],3,1,1], [['district',1,300],['rent',200,220]], 42,0,440,220,1, 34,460,3,'full',''],
    ['j22','Garden City',      122,[[2,3,1],[3,3,1]],  [[70],[70],3,2,1], [['district',2,300],['district',3,300]], 46,0,460,220,1, 38,500,3,'full',''],
    ['j23','Tight Purse',      123,[[5,2,2],[0,2,1]],  [[60],[70],3,1,1], [['district',5,300],['upgrades',3,240]], 40,0,320,220,1, 32,440,3,'full','Slim starting funds. Spend with care.'],
    ['j24','Sticker Spree',    124,[[4,2,1],[1,2,1]],  [[70],[60],3,3,1], [['stickers',4,260],['district',4,260]], 44,0,440,220,1, 36,480,3,'full',''],
    ['j25','Six Corners',      125,[[0,2,1],[2,2,1],[5,2,1]],[[70],[70],3,2,1], [['district',0,260],['district',5,260],['laps',4,220]], 46,0,460,220,1, 38,500,4,'full',''],
    ['j26','Rush Hour',        126,[[1,2,2],[3,2,2]],  [[70],[80],3,1,1], [['district',1,320],['rent',250,240]], 40,280,460,220,1, 32,260,4,'full',''],
    ['j27','Old Money',        127,[[5,3,2],[2,2,1]],  [[70],[80],3,2,1], [['district',5,320],['upgrades',3,240]], 44,0,460,220,1, 36,480,4,'full',''],
    ['j28','Tram Lines',       128,[[4,2,1],[0,2,1],[3,2,1]],[[70],[70],3,2,1], [['district',4,280],['district',0,280]], 46,0,460,220,1, 38,500,4,'full',''],
    ['j29','Harbor Lights',    129,[[0,3,2],[4,2,2]],  [[80],[80],3,2,1], [['district',0,340],['stickers',3,220]], 44,0,480,240,1, 36,500,4,'full',''],
    ['j30','Metro Mastery',    130,[[1,2,2],[2,2,2],[4,2,2]],[[80],[80],3,2,1], [['district',1,300],['district',2,300],['upgrades',4,280]], 46,300,480,240,1, 38,280,0,'full','MASTERY: premium districts, tall buildings, little time.'],
    ['j31','Long Way Round',   131,[[0,2,1],[1,2,1],[2,2,1],[3,2,1]],[[80],[80],3,2,1], [['district',0,260],['laps',6,300]], 50,0,500,240,1, 42,540,0,'full',''],
    ['j32','Deep Pockets',     132,[[5,3,2],[3,3,2]],  [[80],[90],3,2,1], [['district',5,360],['rent',300,260]], 46,0,500,240,1, 38,520,0,'full',''],
    ['j33','Swift Sticks',     133,[[2,2,2],[4,2,2]],  [[80],[90],3,3,1], [['stickers',4,280],['upgrades',3,260]], 42,260,480,240,1, 34,240,0,'full',''],
    ['j34','Grand Bazaar',     134,[[1,3,2],[5,3,2]],  [[80],[90],3,2,1], [['district',1,360],['district',5,360]], 48,0,500,240,1, 40,540,1,'full',''],
    ['j35','Penny’s Spree',    135,[[4,3,2],[0,2,2]],  [[80],[90],3,2,1], [['district',4,340],['rent',350,280]], 44,0,500,240,1, 36,500,1,'full','Penny holds a fat wallet this stage (she buys aggressively).'],
    ['j36','Paper Metropolis', 136,[[0,2,2],[2,2,2],[3,2,2]],[[80],[90],3,2,1], [['district',2,320],['district',3,320],['laps',5,260]], 50,0,520,240,1, 42,560,1,'full',''],
    ['j37','Thin Air',         137,[[5,2,2],[1,2,2]],  [[70],[100],3,2,1], [['district',5,340],['upgrades',4,300]], 40,0,300,240,1, 32,460,1,'full','A thin wallet and tall cranes.'],
    ['j38','Night Market',     138,[[1,2,2],[3,2,2],[5,2,2]],[[90],[100],3,2,1], [['district',1,340],['stickers',4,280]], 48,300,520,240,1, 40,280,2,'full',''],
    ['j39','Six Districts',    139,[[0,2,2],[1,2,2],[4,2,2]],[[90],[100],3,2,1], [['district',0,320],['district',1,320],['rent',300,280]], 48,0,520,240,1, 40,540,2,'full',''],
    ['j40','City Fortune',     140,[[0,2,2],[2,2,2],[5,2,2]],[[90],[100],3,3,1], [['district',0,340],['district',2,340],['upgrades',4,300]], 50,320,540,240,1, 42,300,3,'full','MASTERY: the definitive circuit. Everything at once. Good luck.']
  ];

  function expandLevel(row, idx) {
    var spec = {
      seed: row[2], districts: row[3],
      bonus: row[4][0], toll: row[4][1], card: row[4][2], sticker: row[4][3], park: row[4][4]
    };
    return {
      id: row[0], version: CONTENT_VERSION, kind: 'journey', index: idx,
      name: row[1], seed: row[2],
      tiles: buildTiles(spec),
      album: albumFrom(row[5]),
      cards: DECKS[row[14]] || DECKS.light,
      dice: 6,
      turnLimit: row[6] || 0, timeLimitSec: row[7] || 0,
      startCoins: row[8], salary: row[9],
      rival: row[10] ? { name: RIVAL_NAMES[idx % RIVAL_NAMES.length] } : null,
      rivalReserve: /Spree|Push/.test(row[1]) ? 0 : 40,
      par: { turns: row[11], timeSec: row[12] },
      mechanics: { undo: true, hint: true },
      theme: THEMES[row[13]].id,
      intro: row[15] || '',
      mastery: /MASTERY/.test(row[15] || '')
    };
  }

  var JOURNEY = J.map(expandLevel);

  // ---------- challenges ----------
  function challengeCfg(c) {
    c.version = CONTENT_VERSION;
    c.kind = 'challenge';
    c.tiles = buildTiles(c.spec);
    c.album = albumFrom(c.albumRows);
    delete c.spec; delete c.albumRows;
    return c;
  }
  var CHALLENGES = [
    challengeCfg({ id: 'c1', name: 'Express Circuit', seed: 501,
      spec: { seed: 501, districts: [[0, 2, 0], [1, 2, 0]], bonus: [50], toll: [40], card: 1, sticker: 0, park: 1 },
      albumRows: [['district', 0, 200], ['district', 1, 200]],
      cards: DECKS.light, dice: 6, turnLimit: 22, timeLimitSec: 0, startCoins: 320, salary: 200,
      rival: null, rivalReserve: 40, par: { turns: 16, timeSec: 240 },
      mechanics: { undo: false, hint: true }, theme: 'paper',
      intro: 'Two sets in 22 turns. No undo.' }),
    challengeCfg({ id: 'c2', name: 'Speed Tycoon', seed: 502,
      spec: { seed: 502, districts: [[1, 2, 1], [2, 2, 1]], bonus: [60], toll: [50], card: 2, sticker: 1, park: 1 },
      albumRows: [['district', 1, 240], ['upgrades', 2, 220]],
      cards: DECKS.standard, dice: 6, turnLimit: 0, timeLimitSec: 240, startCoins: 400, salary: 200,
      rival: { name: 'Vela' }, rivalReserve: 40, par: { turns: 30, timeSec: 220 },
      mechanics: { undo: false, hint: true }, theme: 'canal',
      intro: 'Four minutes on the clock.' }),
    challengeCfg({ id: 'c3', name: 'Thin Wallet', seed: 503,
      spec: { seed: 503, districts: [[4, 2, 1], [0, 2, 1]], bonus: [50], toll: [60], card: 2, sticker: 1, park: 1 },
      albumRows: [['district', 4, 260], ['upgrades', 3, 240]],
      cards: DECKS.standard, dice: 6, turnLimit: 40, timeLimitSec: 0, startCoins: 120, salary: 180,
      rival: { name: 'Moss' }, rivalReserve: 40, par: { turns: 32, timeSec: 420 },
      mechanics: { undo: true, hint: true }, theme: 'midnight',
      intro: 'Start with 120 coins. Salary is your lifeline.' }),
    challengeCfg({ id: 'c4', name: 'Stiff Rents', seed: 504,
      spec: { seed: 504, districts: [[3, 3, 2], [5, 2, 2]], bonus: [70], toll: [90], card: 2, sticker: 1, park: 0 },
      albumRows: [['district', 3, 320], ['rent', 250, 260]],
      cards: DECKS.full, dice: 6, turnLimit: 44, timeLimitSec: 0, startCoins: 460, salary: 220,
      rival: { name: 'Brick' }, rivalReserve: 0, par: { turns: 36, timeSec: 480 },
      mechanics: { undo: true, hint: true }, theme: 'harvest',
      intro: 'Brick buys everything in reach. Tolls are steep.' }),
    challengeCfg({ id: 'c5', name: 'Sticker Sprint', seed: 505,
      spec: { seed: 505, districts: [[2, 2, 1], [4, 2, 1]], bonus: [60], toll: [50], card: 2, sticker: 3, park: 1 },
      albumRows: [['stickers', 4, 300], ['laps', 4, 220]],
      cards: DECKS.standard, dice: 6, turnLimit: 36, timeLimitSec: 0, startCoins: 360, salary: 220,
      rival: { name: 'Cobalt' }, rivalReserve: 40, par: { turns: 28, timeSec: 400 },
      mechanics: { undo: false, hint: true }, theme: 'blossom',
      intro: 'Four stickers and four laps. Keep moving.' }),
    challengeCfg({ id: 'c6', name: 'Grand Constraint', seed: 506,
      spec: { seed: 506, districts: [[0, 2, 2], [2, 2, 2], [4, 2, 2]], bonus: [80], toll: [90], card: 3, sticker: 1, park: 0 },
      albumRows: [['district', 0, 300], ['district', 2, 300], ['upgrades', 3, 280]],
      cards: DECKS.full, dice: 6, turnLimit: 42, timeLimitSec: 300, startCoins: 460, salary: 220,
      rival: { name: 'Penny' }, rivalReserve: 0, par: { turns: 34, timeSec: 280 },
      mechanics: { undo: false, hint: false }, theme: 'midnight',
      intro: 'Turn limit, time limit, no assists. The full test.' })
  ];

  // ---------- practice presets ----------
  function practiceCfg(p) {
    p.version = CONTENT_VERSION;
    p.kind = 'practice';
    p.seed = p.spec.seed;
    p.tiles = buildTiles(p.spec);
    p.album = albumFrom(p.albumRows);
    delete p.spec; delete p.albumRows;
    return p;
  }
  var PRACTICE = [
    practiceCfg({ id: 'relaxed', name: 'Relaxed',
      spec: { seed: 701, districts: [[0, 2, 0], [2, 2, 0]], bonus: [60], toll: [30], card: 1, sticker: 1, park: 2 },
      albumRows: [['district', 0, 200], ['laps', 3, 150]],
      cards: DECKS.light, dice: 6, turnLimit: 40, timeLimitSec: 0, startCoins: 360, salary: 220,
      rival: null, rivalReserve: 40, par: { turns: 30, timeSec: 480 },
      mechanics: { undo: true, hint: true } }),
    practiceCfg({ id: 'standard', name: 'Standard',
      spec: { seed: 702, districts: [[1, 2, 1], [3, 2, 1]], bonus: [60], toll: [50], card: 2, sticker: 1, park: 1 },
      albumRows: [['district', 1, 240], ['upgrades', 2, 200]],
      cards: DECKS.standard, dice: 6, turnLimit: 40, timeLimitSec: 0, startCoins: 380, salary: 200,
      rival: { name: 'Penny' }, rivalReserve: 40, par: { turns: 32, timeSec: 420 },
      mechanics: { undo: true, hint: true } }),
    practiceCfg({ id: 'expert', name: 'Expert',
      spec: { seed: 703, districts: [[5, 3, 2], [4, 2, 2]], bonus: [70], toll: [80], card: 3, sticker: 2, park: 0 },
      albumRows: [['district', 5, 340], ['rent', 250, 260]],
      cards: DECKS.full, dice: 6, turnLimit: 40, timeLimitSec: 0, startCoins: 420, salary: 220,
      rival: { name: 'Brick' }, rivalReserve: 0, par: { turns: 32, timeSec: 420 },
      mechanics: { undo: true, hint: true } })
  ];

  // ---------- daily ----------
  // One immutable ruleset per UTC day, derived purely from the date string.
  function dailyConfig(dateStr) {
    var seed = RNG.hashString('cityfortune-daily-v' + CONTENT_VERSION + '-' + dateStr);
    var day = Math.floor(Date.parse(dateStr + 'T00:00:00Z') / 86400000);
    var rot = ((day % 7) + 7) % 7;
    var dA = rot % 6, dB = (rot + 2) % 6;
    if (dB === dA) dB = (dA + 1) % 6;
    var spec = {
      seed: seed, districts: [[dA, 2, 1 + (rot % 2)], [dB, 2, 1]],
      bonus: [50 + rot * 5], toll: [40 + rot * 10], card: 2, sticker: 1 + (rot % 2), park: 1
    };
    var albumRows = rot % 2 === 0
      ? [['district', dA, 260], ['laps', 3, 180]]
      : [['district', dA, 260], ['upgrades', 2, 220]];
    return {
      id: 'daily-' + dateStr, version: CONTENT_VERSION, kind: 'daily',
      name: 'Daily ' + dateStr, seed: seed, date: dateStr,
      tiles: buildTiles(spec),
      album: albumFrom(albumRows),
      cards: rot >= 4 ? DECKS.full : DECKS.standard,
      dice: 6,
      turnLimit: 40, timeLimitSec: rot === 6 ? 300 : 0,
      startCoins: 380, salary: 200,
      rival: { name: RIVAL_NAMES[rot % RIVAL_NAMES.length] },
      rivalReserve: 40,
      par: { turns: 32, timeSec: 420 },
      mechanics: { undo: true, hint: true },
      theme: THEMES[rot % THEMES.length].id,
      intro: 'One shared seed for everyone, today only.'
    };
  }

  function utcDateString(nowMs) {
    var d = new Date(nowMs == null ? Date.now() : nowMs);
    return d.getUTCFullYear() + '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(d.getUTCDate()).padStart(2, '0');
  }

  // ---------- tutorial (Learn) ----------
  function lessonCfg(id, seed, spec, albumRows, over) {
    var cfg = {
      id: id, version: CONTENT_VERSION, kind: 'tutorial', name: 'Lesson', seed: seed,
      tiles: buildTiles(spec),
      album: albumFrom(albumRows),
      cards: DECKS.light, dice: 6,
      turnLimit: 40, timeLimitSec: 0, startCoins: 400, salary: 200,
      rival: null, rivalReserve: 40, par: null,
      mechanics: { undo: false, hint: true }
    };
    return Object.assign(cfg, over || {});
  }
  function tutorialLessons() {
    return [
      { id: 't1', title: 'Roll and move',
        text: 'This is your city circuit. Press Roll (or Enter) to throw the die — your pawn moves that many tiles and the tile you land on is resolved. Pass Start to collect your salary. Roll once to finish the lesson.',
        goal: { event: 'roll', count: 1 },
        cfg: lessonCfg('t1', 9001, { seed: 9001, districts: [[0, 2, 0]], bonus: [50], toll: [], card: 0, sticker: 0, park: 1 },
          [['district', 0, 200], ['laps', 9, 100]]) },
      { id: 't2', title: 'Buy property',
        text: 'When you land on an unowned property you may buy it. The deed is offered now: tap Buy (or press Enter). Owned property earns rent when your rival lands on it, and full districts complete album pages.',
        goal: { event: 'buy', count: 1 },
        force: { offerFirst: true },
        cfg: lessonCfg('t2', 9002, { seed: 9002, districts: [[0, 2, 0]], bonus: [50], toll: [], card: 0, sticker: 0, park: 1 },
          [['district', 0, 200], ['laps', 9, 100]]) },
      { id: 't3', title: 'Build up',
        text: 'Between rolls you can build on property you own: tap your Harbor 1 tile, then Build. Taller buildings charge much higher rent. Build one upgrade to finish the lesson.',
        goal: { event: 'build', count: 1 },
        force: { youProps: 'first', coins: 400 },
        cfg: lessonCfg('t3', 9003, { seed: 9003, districts: [[0, 2, 0]], bonus: [50], toll: [], card: 0, sticker: 0, park: 1 },
          [['district', 0, 200], ['upgrades', 9, 100]]) },
      { id: 't4', title: 'Finish an album page',
        text: 'The album (left rail) lists this board’s pages. You already own Harbor 1 — buy Harbor 2 to complete the Harbor set page and claim its bonus.',
        goal: { event: 'page-complete', count: 1 },
        force: { youProps: 'first', offerSecond: true },
        cfg: lessonCfg('t4', 9004, { seed: 9004, districts: [[0, 2, 0]], bonus: [50], toll: [], card: 0, sticker: 0, park: 1 },
          [['district', 0, 200], ['laps', 9, 100]]) },
      { id: 't5', title: 'Second chances',
        text: 'In relaxed modes you can undo a turn (U) or ask for a hint (H). Roll once, then undo it to finish the lesson.',
        goal: { event: 'undo', count: 1 },
        cfg: lessonCfg('t5', 9005, { seed: 9005, districts: [[0, 2, 0]], bonus: [50], toll: [], card: 0, sticker: 0, park: 1 },
          [['district', 0, 200], ['laps', 9, 100]], { mechanics: { undo: true, hint: true } }) }
    ];
  }

  // ---------- achievements (stable lowercase keys, idempotent) ----------
  var ACHIEVEMENTS = [
    { key: 'first-buy',    name: 'First Deed',     desc: 'Buy your first property.' },
    { key: 'first-page',   name: 'Page Turner',    desc: 'Complete your first album page.' },
    { key: 'first-win',    name: 'Album Complete', desc: 'Finish every album page in a stage.' },
    { key: 'rent-500',     name: 'Rent Baron',     desc: 'Collect 500 coins of rent across all play.' },
    { key: 'builds-25',    name: 'City Planner',   desc: 'Build 25 upgrades across all play.' },
    { key: 'journey-half', name: 'Half the City',  desc: 'Finish 20 journey stages.' },
    { key: 'journey-done', name: 'Master Curator', desc: 'Finish all 40 journey stages.' },
    { key: 'daily-7',      name: 'Regular',        desc: 'Finish 7 daily challenges.' },
    { key: 'score-4000',   name: 'Tycoon',         desc: 'Score 4000+ in a single round.' },
    { key: 'laps-50',      name: 'Circuit Legend', desc: 'Complete 50 laps across all play.' }
  ];

  return {
    CONTENT_VERSION: CONTENT_VERSION,
    DISTRICTS: DISTRICTS,
    DISTRICT_ORDER: DISTRICT_ORDER,
    THEMES: THEMES,
    JOURNEY: JOURNEY,
    CHALLENGES: CHALLENGES,
    PRACTICE: PRACTICE,
    ACHIEVEMENTS: ACHIEVEMENTS,
    RIVAL_NAMES: RIVAL_NAMES,
    buildTiles: buildTiles,
    dailyConfig: dailyConfig,
    utcDateString: utcDateString,
    tutorialLessons: tutorialLessons
  };
});
