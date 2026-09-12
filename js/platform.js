/* City Fortune — StarHermit platform adapter (browser global: window.CFPlatform).
 * Launch-token lifecycle (fragment read + strip, Bearer, 45-min refresh),
 * profile nickname resolution, and the read-only platform leaderboard.
 * The game's own-server validated score submit/board/time routes are its
 * backend (declared server=server.js) and are called from ui.js with these
 * headers. Everything degrades to offline local play: no token → no hosted
 * calls at all. Tokens are kept in memory only — never persisted.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CFPlatform = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var REFRESH_MS = 45 * 60 * 1000; // token lives 60 min; re-mint at 45
  var RETRY_MS = 60 * 1000;

  var token = null, userId = null, slug = null;
  var hosted = false;
  var profile = null;          // { name } for the signed-in player
  var profileNames = {};       // userId -> Promise<string>
  var refreshTimer = null, retryTimer = null;
  var listeners = [];

  function decodeJwt(t) {
    try {
      var seg = String(t).split('.')[1];
      if (!seg) return null;
      var b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
      b64 += '='.repeat((4 - (b64.length % 4)) % 4);
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) { return null; }
  }

  // Fragment first (platform contract); query forms are local-dev only.
  function readLaunchToken() {
    try {
      var h = new URLSearchParams(String(root.location.hash || '').replace(/^#/, ''));
      var t = h.get('game_token');
      if (t) {
        h.delete('game_token');
        h.delete('session_id');
        var rest = h.toString();
        root.history.replaceState(null, '',
          root.location.pathname + root.location.search + (rest ? '#' + rest : ''));
        return t;
      }
      var q = new URLSearchParams(root.location.search);
      return q.get('game_token') || q.get('token') || q.get('launch_token') || null;
    } catch (e) { return null; }
  }

  function notify() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](); } catch (e) { /* listener errors never break */ }
    }
  }

  function api() {
    token = readLaunchToken();
    if (token) {
      var claims = decodeJwt(token);
      if (!claims) token = null;
      else {
        if (typeof claims.sub === 'string' && claims.sub) userId = claims.sub;
        if (typeof claims.game_scope === 'string' && claims.game_scope) slug = claims.game_scope;
        if (!userId || !slug) token = null; // not a usable launch token
      }
    }
    hosted = !!token;
    if (hosted) {
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = setInterval(refreshToken, REFRESH_MS);
      fetchProfile().then(notify).catch(function () {});
    }
    return hosted;
  }

  // Scoped tokens may re-mint via the game's launch-token route; retry a
  // failed re-mint after ~60 s.
  function refreshToken() {
    if (!token || !slug) return Promise.resolve(false);
    return fetch('/api/v1/games/' + encodeURIComponent(slug) + '/launch-token', {
      method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: '{}'
    }).then(function (r) { return r.json().catch(function () { return null; }); }).then(function (j) {
      if (j && typeof j.token === 'string' && j.token) {
        token = j.token;
        var claims = decodeJwt(token);
        if (claims && claims.sub) userId = claims.sub;
        if (claims && claims.game_scope) slug = claims.game_scope;
        notify();
        return true;
      }
      retryRefresh();
      return false;
    }).catch(function () { retryRefresh(); return false; });
  }
  function retryRefresh() {
    if (retryTimer || !token) return;
    retryTimer = setTimeout(function () { retryTimer = null; refreshToken(); }, RETRY_MS);
  }

  function headers(extra) {
    var h = extra || {};
    if (token) h.Authorization = 'Bearer ' + token;
    return h;
  }

  // Nickname via GET /api/v1/users/{id}/profile — the only profile read a
  // game-scoped token may make. Never /api/v1/me, never usernames.
  function profileFor(pid) {
    if (!pid || typeof pid !== 'string') return Promise.resolve('player');
    if (profileNames[pid]) return profileNames[pid];
    var p = fetch('/api/v1/users/' + encodeURIComponent(pid) + '/profile', { headers: headers() })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var n = j && typeof j.nickname === 'string' && j.nickname ? j.nickname : null;
        return n || ('Player ' + pid.slice(0, 8));
      })
      .catch(function () { return 'Player ' + pid.slice(0, 8); });
    profileNames[pid] = p;
    return p;
  }
  function fetchProfile() {
    if (!userId) return Promise.resolve(null);
    return profileFor(userId).then(function (n) {
      profile = { name: n.slice(0, 40) };
      return profile;
    });
  }

  /* Platform leaderboard (read-only; clients never submit): the game record
   * yields leaderboardId, entries resolve to nicknames. null when absent. */
  function fetchLeaderboard() {
    if (!hosted || !slug) return Promise.resolve(null);
    return fetch('/api/v1/games/' + encodeURIComponent(slug), { headers: headers() })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (g) {
        if (!g || !g.leaderboardId) return null;
        return fetch('/api/v1/leaderboards/' + encodeURIComponent(g.leaderboardId) +
          '/entries?page=1&pageSize=20', { headers: headers() });
      })
      .then(function (r) { return r ? (r.ok ? r.json() : null) : null; })
      .then(function (j) {
        if (!j) return null;
        var raw = (j.entries || j.items) || [];
        return Promise.all(raw.slice(0, 20).map(function (e) {
          var uid = e.userId != null ? e.userId : e.playerId;
          return profileFor(String(uid || '')).then(function (name) {
            return {
              name: String(uid || '') === userId ? 'You (' + name + ')' : name,
              score: e.score != null ? e.score : e.value,
            };
          });
        }));
      })
      .catch(function () { return null; });
  }

  return {
    init: api,
    headers: headers,
    profileFor: profileFor,
    fetchProfile: fetchProfile,
    fetchLeaderboard: fetchLeaderboard,
    refreshToken: refreshToken,
    onUpdate: function (fn) { if (typeof fn === 'function') listeners.push(fn); },
    get hosted() { return hosted; },
    get profile() { return profile; },
    get userId() { return userId; },
    get slug() { return slug; }
  };
});
