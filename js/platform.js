/* City Fortune — StarHermit platform adapter (browser global: window.CFPlatform)
 * over window.StarHermit (starhermit-sdk.js, loaded and init()ed from
 * index.html before the game scripts). The SDK reads the launch token
 * (#game_token / #access_token), strips it, renews it and owns profile,
 * cloud save (slot game:<slug>), settings KV, control bindings, the
 * read-only platform leaderboard, invite link and sign-in. The game's
 * own-server validated score/board/time routes (server.js) are called from
 * ui.js with these headers, only when signed in. Standalone (no token)
 * nothing here touches the network.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CFPlatform = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var SAVE_DEBOUNCE_MS = 2000;
  function sdk() { return (typeof globalThis !== 'undefined' ? globalThis : root).StarHermit || null; }
  function signedIn() { var s = sdk(); return !!(s && s.signedIn); }

  // Keyboard actions — declared as control.<action> in starhermit.txt.
  var DEFAULT_BINDINGS = {
    prev: ['ArrowLeft', 'ArrowUp'], next: ['ArrowRight', 'ArrowDown'], confirm: ['Enter', 'Space'],
    buy: ['KeyB'], skip: ['KeyN'], undo: ['KeyU'], hint: ['KeyH'], settle: ['KeyC'],
    pause: ['KeyP'], cancel: ['Escape'], mute: ['KeyM']
  };
  // Synthetic events (no `code`) map by key.
  var KEY_FALLBACK = {
    ArrowLeft: 'prev', ArrowUp: 'prev', ArrowRight: 'next', ArrowDown: 'next', Enter: 'confirm', ' ': 'confirm',
    b: 'buy', n: 'skip', u: 'undo', h: 'hint', c: 'settle', p: 'pause', Escape: 'cancel', m: 'mute'
  };
  // Preferences mirrored to the settings KV.
  var SYNCED_SETTINGS = ['music', 'effects', 'ambience', 'voice', 'muted', 'captions', 'graphicsTier', 'gfx', 'theme',
    'reducedMotion', 'highContrast', 'colorPalette', 'largeText', 'leftHanded', 'haptics', 'boardMirror', 'confirmMoves'];
  var KEY_NAMES = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc', Space: 'Space', Enter: 'Enter' };

  function clone(b) {
    var o = {};
    Object.keys(b).forEach(function (k) { o[k] = b[k].slice(); });
    return o;
  }

  var profile = null;          // { name } for the signed-in player
  var listeners = [];
  var hooked = false;
  var bindings = clone(DEFAULT_BINDINGS);
  var codeMap = null;
  var kvReady = false, kvLast = null, kvTimer = null;

  function notify() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](); } catch (e) { /* listener errors never break */ }
    }
  }

  function init() {
    var s = sdk();
    if (s && !hooked) {
      hooked = true;
      s.on('auth', function (a) {
        if (!a.signedIn) profile = null;
        notify();
      });
    }
    if (signedIn()) {
      fetchProfile().then(notify).catch(function () {});
      try {
        root.addEventListener('pagehide', function () { flushSave(); });
        root.document.addEventListener('visibilitychange', function () { if (root.document.hidden) flushSave(); });
      } catch (e) { /* no window events */ }
    }
    return signedIn();
  }

  function headers(extra) {
    var h = extra || {};
    var s = sdk();
    if (s && s.token) h.Authorization = 'Bearer ' + s.token;
    return h;
  }

  // Nickname (never /api/v1/me, never usernames), 'Player <id>' fallback.
  function profileFor(pid) {
    if (!pid || typeof pid !== 'string') return Promise.resolve('player');
    var s = sdk();
    if (!s || !s.signedIn) return Promise.resolve('Player ' + pid.slice(0, 6));
    return s.profile(pid).then(function (p) { return (p && p.displayName) || 'Player ' + pid.slice(0, 6); },
      function () { return 'Player ' + pid.slice(0, 6); });
  }
  function fetchProfile() {
    var s = sdk();
    if (!s || !s.userId) return Promise.resolve(null);
    return profileFor(s.userId).then(function (n) {
      profile = { name: n.slice(0, 40) };
      return profile;
    });
  }

  /* Platform leaderboard (read-only; clients never submit): the game's first
   * board, entries resolved to nicknames. null when absent or signed out. */
  function fetchLeaderboard() {
    if (!signedIn()) return Promise.resolve(null);
    var me = sdk().userId;
    return sdk().leaderboard(null, { pageSize: 20 }).then(function (res) {
      if (!res || !res.board) return null;
      return Promise.all((res.items || []).slice(0, 20).map(function (e) {
        var uid = String(e.userId != null ? e.userId : (e.playerId || ''));
        return profileFor(uid).then(function (name) {
          return { name: uid === me ? 'You (' + name + ')' : name, score: e.score != null ? e.score : e.value };
        });
      }));
    }).catch(function () { return null; });
  }

  /* Cloud save: the wrapped {sum, payload} save string in game:<slug>. */
  function loadCloud() { return signedIn() ? sdk().loadSave().catch(function () { return null; }) : Promise.resolve(null); }
  function saveCloud(wrapped) {
    if (!signedIn()) return;
    try { sdk().saveJSON(JSON.parse(wrapped), SAVE_DEBOUNCE_MS); } catch (e) { /* malformed: skip */ }
  }
  function flushSave() { return signedIn() ? sdk().flushSave(true) : Promise.resolve(false); }

  /* Settings KV: preferences only; patched after the KV was read once. */
  function pick(settings) {
    var out = {};
    SYNCED_SETTINGS.forEach(function (k) { if (settings && settings[k] !== undefined && settings[k] !== null) out[k] = settings[k]; });
    return out;
  }
  function getSettings() {
    if (!signedIn()) return Promise.resolve({});
    return sdk().getSettings().then(function (kv) { kvReady = true; return pick(kv || {}); },
      function () { kvReady = true; return {}; });
  }
  function mirrorSettings(settings) {
    if (!signedIn() || !kvReady) return;
    var patch = pick(settings);
    var json = JSON.stringify(patch);
    if (json === kvLast) return;
    clearTimeout(kvTimer);
    kvTimer = setTimeout(function () { kvLast = json; sdk().patchSettings(patch); }, 800);
  }

  /* Controls: platform overrides over DEFAULT_BINDINGS. */
  function loadBindings() {
    var s = sdk();
    var p = s && s.signedIn ? s.loadBindings(DEFAULT_BINDINGS).catch(function () { return clone(DEFAULT_BINDINGS); })
      : Promise.resolve(clone(DEFAULT_BINDINGS));
    return p.then(function (b) { bindings = b; codeMap = null; return b; });
  }
  function actionFor(e) {
    if (!codeMap) {
      codeMap = {};
      Object.keys(bindings).forEach(function (a) { bindings[a].forEach(function (c) { codeMap[c] = a; }); });
    }
    if (e.code) return codeMap[e.code] || null;
    var k = e.key && e.key.length === 1 ? e.key.toLowerCase() : e.key;
    return KEY_FALLBACK[k] || null;
  }
  function keyLabel(action) {
    return (bindings[action] || []).map(function (c) { return KEY_NAMES[c] || c.replace(/^Key|^Digit/, ''); }).join(' / ');
  }

  function inviteLink() { return signedIn() ? sdk().inviteLink() : null; }
  function copyInvite() {
    var link = inviteLink();
    if (!link) return Promise.resolve(false);
    try {
      return navigator.clipboard.writeText(link).then(function () { return true; }, function () { return false; });
    } catch (e) { return Promise.resolve(false); }
  }

  return {
    init: init,
    headers: headers,
    profileFor: profileFor,
    fetchProfile: fetchProfile,
    fetchLeaderboard: fetchLeaderboard,
    refreshToken: function () { var s = sdk(); return s ? s.refresh() : Promise.resolve(null); },
    onUpdate: function (fn) { if (typeof fn === 'function') listeners.push(fn); },
    loadCloud: loadCloud,
    saveCloud: saveCloud,
    flushSave: flushSave,
    getSettings: getSettings,
    mirrorSettings: mirrorSettings,
    loadBindings: loadBindings,
    actionFor: actionFor,
    keyLabel: keyLabel,
    inviteLink: inviteLink,
    copyInvite: copyInvite,
    // Post a finished round to the leaderboards (score-script.js); resolves
    // { posted, rank } — rank on the high-score board, or null.
    submitScore: function (total) {
      var s = sdk();
      if (!s || !signedIn()) return Promise.resolve({ posted: false, rank: null });
      return s.submitScores({ 'high-score': total }).then(function (keys) {
        if (keys.indexOf('high-score') < 0) return { posted: false, rank: null };
        return s.leaderboard('high-score', { pageSize: 100 }).then(function (r) {
          var me = (r.items || []).filter(function (i) { return i.userId === s.userId; })[0];
          return { posted: true, rank: me ? me.rank : null };
        }, function () { return { posted: true, rank: null }; });
      });
    },
    canSignIn: function () { var s = sdk(); return !!(s && s.canSignIn()); },
    signIn: function () { var s = sdk(); return !!(s && s.signIn()); },
    get hosted() { return signedIn(); },
    get profile() { return profile; },
    get userId() { var s = sdk(); return s ? s.userId : null; },
    get slug() { var s = sdk(); return s ? s.slug : null; }
  };
});
