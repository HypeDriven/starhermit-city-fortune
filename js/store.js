/* City Fortune — persistence: versioned, checksummed local save document.
 * Never stores credentials or tokens. Browser global: window.CFStore.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CFStore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SAVE_VERSION = 1;
  var KEY = 'cityfortune.save.v1';
  var LB_KEY = 'cityfortune.leaderboards.v1';

  var DEFAULT_SETTINGS = {
    music: 0.6, effects: 0.9, ambience: 0.5, voice: 0.8,
    muted: false, captions: false,
    graphicsTier: 'auto',       // graphics preset: auto | low | balanced | high | ultra
    gfx: null,                  // graphics overrides: render_scale, adaptive, show_fps, <category>: tier
    theme: 'paper',
    reducedMotion: false,
    highContrast: false,
    colorPalette: 'standard',   // standard | high-visibility
    largeText: false,
    leftHanded: false,
    haptics: true,
    boardMirror: false,         // always-visible DOM board
    confirmMoves: false         // timing assistance: confirm buys/builds
  };

  function defaultProgress() {
    return {
      tutorialDone: {},        // lessonId -> true
      journeyStars: {},        // levelId -> 0..3
      journeyBest: {},         // levelId -> score
      challengeBest: {},       // challengeId -> score
      dailiesDone: {},         // dateStr -> score
      achievements: {},        // key -> unlockedAtMs
      stats: { rounds: 0, wins: 0, rentCollected: 0, builds: 0, laps: 0, pages: 0, playMs: 0 },
      cosmetics: { theme: 'paper' }
    };
  }

  function checksum(str) { // FNV-1a, decimal string
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  }

  function migrate(doc) {
    // v1 is current; older shapes are upgraded field-by-field here.
    if (!doc || typeof doc !== 'object') return null;
    if (doc.v > SAVE_VERSION) return null; // future format: don't clobber
    doc.v = SAVE_VERSION;
    doc.settings = Object.assign({}, DEFAULT_SETTINGS, doc.settings || {});
    // pre-preset tiers: medium became balanced
    if (doc.settings.graphicsTier === 'medium') doc.settings.graphicsTier = 'balanced';
    if (!doc.settings.gfx || typeof doc.settings.gfx !== 'object') doc.settings.gfx = {};
    doc.progress = Object.assign(defaultProgress(), doc.progress || {});
    return doc;
  }

  function fresh() {
    return { v: SAVE_VERSION, settings: Object.assign({}, DEFAULT_SETTINGS, { gfx: {} }), progress: defaultProgress() };
  }

  var memoryFallback = null; // used when localStorage is unavailable

  // Parses a wrapped {sum, payload} string into a migrated doc; null when it
  // is missing, corrupt or from a newer version (local cache and cloud slot).
  function loadRaw(raw) {
    if (raw == null) return null;
    try {
      var doc = JSON.parse(raw);
      if (!doc || doc.sum !== checksum(doc.payload)) return null; // corrupt
      return migrate(JSON.parse(doc.payload));
    } catch (e) { return null; }
  }

  function load() {
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { /* private mode */ }
    if (raw == null && memoryFallback) raw = memoryFallback;
    return loadRaw(raw) || fresh();
  }

  function save(doc) {
    doc.v = SAVE_VERSION;
    var payload = JSON.stringify(doc);
    var wrapped = JSON.stringify({ sum: checksum(payload), payload: payload });
    memoryFallback = wrapped;
    try { localStorage.setItem(KEY, wrapped); } catch (e) { /* memory fallback keeps session */ }
    return wrapped;
  }

  // ---------- leaderboards (local; host adapter may sync) ----------
  function loadBoards() {
    try {
      var raw = localStorage.getItem(LB_KEY);
      return raw ? JSON.parse(raw) : { entries: [] };
    } catch (e) { return { entries: [] }; }
  }
  function saveBoards(b) {
    try { localStorage.setItem(LB_KEY, JSON.stringify(b)); } catch (e) {}
  }

  // Ties: objective completion first, then higher score, fewer invalid
  // actions, lower elapsed, then stable session id. Returns sorted copy.
  function sortEntries(entries) {
    return entries.slice().sort(function (a, b) {
      if (!!b.won !== !!a.won) return (b.won ? 1 : 0) - (a.won ? 1 : 0);
      if (b.score !== a.score) return b.score - a.score;
      if ((a.invalid || 0) !== (b.invalid || 0)) return (a.invalid || 0) - (b.invalid || 0);
      if ((a.durationMs || 0) !== (b.durationMs || 0)) return (a.durationMs || 0) - (b.durationMs || 0);
      return String(a.sessionId).localeCompare(String(b.sessionId));
    });
  }

  // Cloud-save conflict (another device saved first): the better of both
  // progress records so neither device loses anything — every finished lesson,
  // the higher stars/best per stage, challenge and daily, every achievement at
  // its earliest unlock, the larger lifetime stats; this device's cosmetics.
  function mergeProgress(local, remote) {
    var a = Object.assign(defaultProgress(), local || {});
    var b = Object.assign(defaultProgress(), remote || {});
    function maxMap(x, y) {
      var out = Object.assign({}, y || {});
      Object.keys(x || {}).forEach(function (k) { out[k] = Math.max(Number(x[k]) || 0, Number(out[k]) || 0); });
      return out;
    }
    var achievements = Object.assign({}, b.achievements);
    Object.keys(a.achievements).forEach(function (k) {
      achievements[k] = achievements[k] ? Math.min(achievements[k], a.achievements[k]) : a.achievements[k];
    });
    var stats = Object.assign({}, b.stats);
    Object.keys(a.stats).forEach(function (k) { stats[k] = Math.max(Number(a.stats[k]) || 0, Number(stats[k]) || 0); });
    return Object.assign({}, b, a, {
      tutorialDone: Object.assign({}, b.tutorialDone, a.tutorialDone),
      journeyStars: maxMap(a.journeyStars, b.journeyStars),
      journeyBest: maxMap(a.journeyBest, b.journeyBest),
      challengeBest: maxMap(a.challengeBest, b.challengeBest),
      dailiesDone: maxMap(a.dailiesDone, b.dailiesDone),
      achievements: achievements,
      stats: stats,
      cosmetics: a.cosmetics
    });
  }

  // ---------- the engine client (native/platform.ts) ----------
  // The engine save is { v: 1, progress } — this document without its
  // settings (the runtime's Options and the game's own settings below now)
  // and without the checksum envelope (the engine keeps the save whole).
  function docFromSave(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (data.v > SAVE_VERSION) return null;
    var d = migrate(JSON.parse(JSON.stringify(data)));
    return d ? { v: SAVE_VERSION, progress: d.progress } : null;
  }

  var bool = function (v) { return typeof v === 'boolean'; };
  var THEME_IDS = ['paper', 'canal', 'blossom', 'midnight', 'harvest'];
  /** The game's own settings (game.<key> in the runtime's settings) with their checks. */
  var GAME_SETTINGS = {
    theme: function (v) { return THEME_IDS.indexOf(v) >= 0; },
    colorPalette: function (v) { return v === 'standard' || v === 'high-visibility'; },
    captions: bool, leftHanded: bool, haptics: bool, boardMirror: bool, confirmMoves: bool
  };
  var GAME_SETTING_KEYS = Object.keys(GAME_SETTINGS);
  /** What the browser build mirrored to the account's settings (its SYNCED_SETTINGS). */
  var BROWSER_SETTING_KEYS = ['music', 'effects', 'ambience', 'voice', 'muted', 'captions', 'graphicsTier', 'gfx', 'theme',
    'reducedMotion', 'highContrast', 'colorPalette', 'largeText', 'leftHanded', 'haptics', 'boardMirror', 'confirmMoves'];
  /** A valid value for one of the game's settings, else undefined. */
  function checkSetting(key, v) {
    var ok = GAME_SETTINGS[key];
    return ok && ok(v) ? v : undefined;
  }
  /** The game's settings among a browser-build settings object. */
  function gameSettingsFrom(s) {
    var out = {};
    if (!s || typeof s !== 'object') return out;
    GAME_SETTING_KEYS.forEach(function (k) { if (checkSetting(k, s[k]) !== undefined) out[k] = s[k]; });
    return out;
  }
  /** The browser build's cloud save (save.json: the wrapped {sum, payload} text): its doc and game settings. */
  function fromBrowserSave(text) {
    var d = typeof text === 'string' ? loadRaw(text) : null;
    if (!d) return { doc: null, settings: null };
    return { doc: { v: SAVE_VERSION, progress: d.progress }, settings: gameSettingsFrom(d.settings) };
  }

  return {
    SAVE_VERSION: SAVE_VERSION,
    docFromSave: docFromSave,
    fromBrowserSave: fromBrowserSave,
    GAME_SETTING_KEYS: GAME_SETTING_KEYS,
    BROWSER_SETTING_KEYS: BROWSER_SETTING_KEYS,
    checkSetting: checkSetting,
    defaultProgress: defaultProgress,
    mergeProgress: mergeProgress,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    load: load, loadRaw: loadRaw, save: save, fresh: fresh, migrate: migrate,
    checksum: checksum,
    loadBoards: loadBoards, saveBoards: saveBoards, sortEntries: sortEntries
  };
});
