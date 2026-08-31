/* City Fortune — session, replay, undo, and shared board geometry.
 * Pure: no DOM, no THREE, no Date.now() (time arrives via atMs arguments).
 * UMD: browser global window.CFGame / Node require.
 */
(function (root, factory) {
  var Rules = (typeof module === 'object' && module.exports) ? require('./rules.js') : root.CFRules;
  var Content = (typeof module === 'object' && module.exports) ? require('./content.js') : root.CFContent;
  var Store = (typeof module === 'object' && module.exports) ? require('./store.js') : root.CFStore;
  var RNG = (typeof module === 'object' && module.exports) ? require('./rng.js') : root.CFRNG;
  var api = factory(Rules, Content, Store, RNG);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CFGame = api;
})(typeof self !== 'undefined' ? self : this, function (Rules, Content, Store, RNG) {
  'use strict';

  // ---------- session id (stable, derived from creation time) ----------
  function sessionId(atMs) {
    return RNG.hashString('cf-session-' + Math.floor(atMs || 0)).toString(36);
  }

  // ---------- replay envelope ----------
  // schema version, content version, seed, initial state + hash, ordered
  // commands, periodic state hashes, terminal result.
  function replayHeader(state) {
    return {
      schemaVersion: Rules.STATE_VERSION,
      contentVersion: Content.CONTENT_VERSION,
      configId: state.cfg.id,
      seed: state.seed >>> 0,
      initHash: Rules.hashState(state).toString(36)
    };
  }

  // ---------- board geometry (unit circle; scaled by the view) ----------
  var BOARD = { RING_R: 1.0, TOKEN_YOFF: 0.16 };

  function tilePos(cfg, idx) {
    var n = cfg.tiles.length;
    var a = (idx / n) * Math.PI * 2 - Math.PI / 2; // tile 0 at top
    return { x: Math.cos(a) * BOARD.RING_R, z: Math.sin(a) * BOARD.RING_R, angle: a };
  }

  // ---------- game creation (tutorial force-flags applied here, not in rules) ----------
  function createGame(cfg, lesson) {
    var s = Rules.createGame(cfg);
    if (lesson && lesson.force) applyLessonForce(s, lesson.force);
    return s;
  }

  function applyLessonForce(s, force) {
    if (force.youProps === 'first') {
      // grant the first property tile of the circuit
      for (var i = 1; i < s.cfg.tiles.length; i++) {
        if (s.cfg.tiles[i].t === 'prop') { s.you.props[i] = 1; break; }
      }
    }
    if (force.offerFirst != null || force.offerSecond != null) {
      var target = force.offerFirst != null ? 1 : 0;
      if (force.offerSecond != null) {
        // find the second property tile
        var seen = 0;
        for (var j = 1; j < s.cfg.tiles.length; j++) {
          if (s.cfg.tiles[j].t === 'prop') { seen++; if (seen === 2) { target = j; break; } }
        }
      } else {
        for (var k = 1; k < s.cfg.tiles.length; k++) {
          if (s.cfg.tiles[k].t === 'prop') { target = k; break; }
        }
      }
      if (target > 0) {
        s.phase = 'buy';
        s.pending = { tile: target, price: s.cfg.tiles[target].price };
      }
    }
    if (typeof force.coins === 'number') s.you.coins = force.coins;
  }

  // ---------- session (commands + undo + replay log) ----------
  function createSession(cfg, lesson, atMs) {
    var state = createGame(cfg, lesson);
    return {
      id: sessionId(atMs),
      cfgId: cfg.id,
      state: state,
      initialState: Rules.serialize(state),
      undoStack: [],
      invalidCount: 0,
      replay: {
        header: replayHeader(state),
        initialState: Rules.serialize(state),
        commands: [],
        hashes: [],
        terminal: null
      }
    };
  }

  function applyToSession(sess, cmd, atMs) {
    if (!sess || !sess.state) return { ok: false, reason: 'no-session' };
    var full = Object.assign({}, cmd);
    if (atMs != null) full.atMs = Math.max(0, Math.floor(atMs));
    var shapeErr = Rules.validateCommandShape(full);
    if (shapeErr) { sess.invalidCount++; return { ok: false, reason: shapeErr }; }
    var r = Rules.applyCommand(sess.state, full);
    if (!r.ok) { sess.invalidCount++; return { ok: false, reason: r.reason }; }
    sess.undoStack.push(sess.state);
    sess.state = r.state;
    sess.replay.commands.push(full);
    sess.replay.hashes.push(Rules.hashState(r.state).toString(36));
    if (r.state.terminal) {
      sess.replay.terminal = {
        reason: r.state.terminal.reason,
        won: r.state.terminal.won,
        score: r.state.score.total
      };
    }
    return { ok: true, state: r.state, events: r.events };
  }

  function undo(sess) {
    if (!sess || !sess.state) return { ok: false, reason: 'no-session' };
    if (!sess.state.cfg.mechanics || !sess.state.cfg.mechanics.undo) {
      return { ok: false, reason: 'undo-disabled' };
    }
    if (sess.state.terminal) return { ok: false, reason: 'game-ended' };
    if (!sess.undoStack.length) return { ok: false, reason: 'nothing-to-undo' };
    sess.state = sess.undoStack.pop();
    sess.replay.commands.pop();
    sess.replay.hashes.pop();
    sess.replay.terminal = null;
    return { ok: true, state: sess.state, events: [{ type: 'undo' }] };
  }

  // Deterministic replay verification: rebuild from the initial state and
  // confirm every recorded hash matches.
  function verifyReplay(replay) {
    var state = Rules.deserialize(replay.initialState);
    var initHash = Rules.hashState(state).toString(36);
    if (initHash !== replay.header.initHash) {
      return { ok: false, reason: 'init-hash-mismatch', at: -1 };
    }
    for (var i = 0; i < replay.commands.length; i++) {
      var r = Rules.applyCommand(state, replay.commands[i]);
      if (!r.ok) return { ok: false, reason: 'illegal-command', at: i };
      state = r.state;
      var h = Rules.hashState(state).toString(36);
      if (replay.hashes[i] !== h) return { ok: false, reason: 'hash-mismatch', at: i };
    }
    return { ok: true, state: state, commands: replay.commands.length };
  }

  // ---------- thin pass-throughs (single rules surface for UI and hints) ----------
  function applyCommand(prevState, cmd) { return Rules.applyCommand(prevState, cmd); }
  function legalActions(state) { return Rules.legalActions(state); }
  function hint(state) { return Rules.hint(state); }
  function pageProgress(state, page) { return Rules.pageProgress(state, page); }
  function protectedDistricts(cfg) { return Rules.protectedDistricts(cfg); }
  function scoreTotal(s) { return s.score.total; }

  // ---------- settings merge ----------
  function mergeSettings(base, over) {
    var out = Object.assign({}, base);
    if (!over) return out;
    for (var k in over) if (over[k] != null) out[k] = over[k];
    return out;
  }

  function sortedEntries(entries) { return Store.sortEntries(entries); }

  return {
    BOARD: BOARD,
    tilePos: tilePos,
    sessionId: sessionId,
    replayHeader: replayHeader,
    createGame: createGame,
    createSession: createSession,
    applyToSession: applyToSession,
    undo: undo,
    verifyReplay: verifyReplay,
    applyCommand: applyCommand,
    legalActions: legalActions,
    hint: hint,
    pageProgress: pageProgress,
    protectedDistricts: protectedDistricts,
    scoreTotal: scoreTotal,
    mergeSettings: mergeSettings,
    sortedEntries: sortedEntries,
    rules: Rules,
    content: Content,
    store: Store
  };
});
