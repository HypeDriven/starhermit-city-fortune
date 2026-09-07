/* City Fortune — Three.js scene: pop-up paper city around a circular board.
 * Canvas only (no DOM), no Date.now(): animation derives from a caller-supplied
 * clock. Browser global: window.CFRender (THREE must be on window first).
 */
(function (root) {
  'use strict';

  var Game = root.CFGame;
  var BOARD = Game.BOARD;

  var FRAMING = {           // authored framing constants (no magic offsets)
    CAM_Y: 2.35, CAM_Z: 2.65, LOOK_Y: 0, FOV: 48,
    TILE_W: 0.30, TILE_H: 0.055, TILE_D: 0.42,
    PROP_W: 0.24, PROP_D: 0.30, PROP_H: 0.16, BUILD_STEP: 0.14,
    TOKEN_R: 0.085, TOKEN_H: 0.24
  };

  var QUALITY = {
    low:    { pixelRatio: 1,    shadows: false, particles: 0.4, envDetail: 0.4 },
    medium: { pixelRatio: 1.5,  shadows: true,  particles: 0.7, envDetail: 0.7 },
    high:   { pixelRatio: 2,    shadows: true,  particles: 1,   envDetail: 1 }
  };

  var S = {
    ok: false, renderer: null, scene: null, camera: null, canvas: null,
    board: null,           // group holding all per-round meshes
    tileMeshes: [],        // [{group, base, top, idx}]
    tokens: {},            // you/rival -> {group, from, to, t}
    marker: null,          // selection marker ring
    ghostHighlights: [],
    particles: [],
    props: [],             // decorative pop-up buildings inside the ring
    cfg: null, theme: null, palette: null,
    quality: 'medium', reducedMotion: false, paletteHC: false,
    anims: [],             // [{dur, t, update(t01), done}]
    camShake: 0,
    raycaster: null, pointer: null,
    disposables: []
  };

  function T() { return root.THREE; }

  function track(obj) { S.disposables.push(obj); return obj; }
  function geom(g) { return track(g); }
  function mat(m) { return track(m); }

  // ---------- init / dispose ----------

  function init(canvas, opts) {
    var THREE = T();
    if (!THREE) return false;
    opts = opts || {};
    try {
      S.renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false });
    } catch (e) { return false; }
    S.canvas = canvas;
    S.renderer.outputColorSpace = THREE.SRGBColorSpace;
    S.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    S.renderer.toneMappingExposure = 1.05;
    S.scene = new THREE.Scene();
    S.camera = new THREE.PerspectiveCamera(FRAMING.FOV, 1, 0.1, 60);
    S.camera.position.set(0, FRAMING.CAM_Y, FRAMING.CAM_Z);
    S.camera.lookAt(0, FRAMING.LOOK_Y, 0);
    S.raycaster = new THREE.Raycaster();
    S.pointer = new THREE.Vector2();
    S.ok = true;
    setQuality(opts.quality || 'medium');
    return true;
  }

  function dispose() {
    clearBoard();
    if (S.renderer) { S.renderer.dispose(); S.renderer.forceContextLoss && S.renderer.forceContextLoss(); }
    S.disposables.forEach(function (d) { if (d && d.dispose) d.dispose(); });
    S.disposables = [];
    S.renderer = null; S.scene = null; S.camera = null; S.ok = false;
  }

  function setQuality(tier) {
    if (!QUALITY[tier]) tier = 'medium';
    S.quality = tier;
    if (S.renderer) {
      var pr = Math.min(root.devicePixelRatio || 1, QUALITY[tier].pixelRatio);
      S.renderer.setPixelRatio(pr);
      S.renderer.shadowMap.enabled = QUALITY[tier].shadows;
    }
  }

  function setReducedMotion(on) { S.reducedMotion = !!on; }

  // High-visibility district colors; takes effect on the next buildBoard.
  function setPaletteHC(on) { S.paletteHC = !!on; }

  // ---------- board construction ----------

  function clearBoard() {
    if (S.board) {
      S.board.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { m.dispose(); });
        }
      });
      S.scene.remove(S.board);
    }
    S.board = null; S.tileMeshes = []; S.tokens = {}; S.particles = []; S.anims = [];
    S.marker = null; S.ghostHighlights = []; S.props = [];
    clearOwnershipMarks();
    // every tracked resource belonged to the board that was just released
    S.disposables = [];
  }

  function paperMat(color, rough) {
    var THREE = T();
    return new THREE.MeshStandardMaterial({ color: color, roughness: rough == null ? 0.9 : rough, metalness: 0.02, flatShading: true });
  }

  // A pop-up paper building: two folded planes forming a tent plus a card base.
  function paperBuilding(w, h, d, color) {
    var THREE = T();
    var g = new THREE.Group();
    var m = paperMat(color);
    var roof = new THREE.Mesh(geom(new THREE.ConeGeometry(w * 0.7, h, 4)), m);
    roof.rotation.y = Math.PI / 4;
    roof.position.y = h / 2;
    roof.scale.z = d / w;
    g.add(roof);
    var base = new THREE.Mesh(geom(new THREE.BoxGeometry(w, 0.02, d)), paperMat(0xf6ecd4));
    base.position.y = 0.01;
    g.add(base);
    return g;
  }

  function buildBoard(cfg, theme) {
    var THREE = T();
    if (!S.ok) return;
    clearBoard();
    S.cfg = cfg; S.theme = theme;
    var p = theme.palette;
    S.palette = p;

    var board = new THREE.Group();
    S.board = board;
    S.scene.add(board);
    S.scene.background = new THREE.Color(p.sky);
    S.scene.fog = new THREE.Fog(p.fog, 4.5, 9);

    // lights: one dominant key + soft hemisphere fill
    var key = new THREE.DirectionalLight(p.light, 1.6);
    key.position.set(1.6, 3.2, 1.2);
    key.castShadow = QUALITY[S.quality].shadows;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -2; key.shadow.camera.right = 2;
    key.shadow.camera.top = 2; key.shadow.camera.bottom = -2;
    board.add(key);
    board.add(new THREE.HemisphereLight(p.sky, p.ground, 0.85));

    // table / ground disc
    var ground = new THREE.Mesh(geom(new THREE.CylinderGeometry(1.85, 2.0, 0.08, 48)), paperMat(p.ground, 1));
    ground.position.y = -0.1;
    ground.receiveShadow = true;
    board.add(ground);
    var rim = new THREE.Mesh(geom(new THREE.TorusGeometry(1.85, 0.035, 10, 64)), paperMat(p.edge, 0.8));
    rim.rotation.x = Math.PI / 2;
    rim.position.y = -0.065;
    board.add(rim);

    // ring path ribbon
    var ring = new THREE.Mesh(geom(new THREE.RingGeometry(BOARD.RING_R - 0.21, BOARD.RING_R + 0.21, 64)), paperMat(p.ring, 1));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -0.055;
    ring.receiveShadow = true;
    board.add(ring);

    // tiles
    var n = cfg.tiles.length;
    for (var i = 0; i < n; i++) {
      var tile = cfg.tiles[i];
      var pos = Game.tilePos(cfg, i);
      var g = new THREE.Group();
      g.position.set(pos.x * 1.0, 0, pos.z * 1.0);
      g.rotation.y = -pos.angle - Math.PI / 2;
      var color = tileColor(tile, p);
      var top = new THREE.Mesh(
        geom(new THREE.BoxGeometry(FRAMING.TILE_W, FRAMING.TILE_H, FRAMING.TILE_D)),
        paperMat(color, 0.95));
      top.position.y = FRAMING.TILE_H / 2 - 0.02;
      top.castShadow = QUALITY[S.quality].shadows;
      top.receiveShadow = true;
      top.userData.tileIdx = i;
      g.add(top);
      // district color stripe on property tiles (color + shape cue)
      if (tile.t === 'prop') {
        var stripe = new THREE.Mesh(
          geom(new THREE.BoxGeometry(FRAMING.TILE_W, 0.012, 0.06)),
          paperMat(districtColor(tile.d), 0.8));
        stripe.position.set(0, FRAMING.TILE_H - 0.012, -FRAMING.TILE_D / 2 + 0.05);
        stripe.userData.tileIdx = i;
        g.add(stripe);
      }
      if (tile.t === 'start') {
        var arch = paperBuilding(0.16, 0.3, 0.1, p.accent);
        arch.position.y = FRAMING.TILE_H - 0.02;
        g.add(arch);
      }
      board.add(g);
      S.tileMeshes.push({ group: g, top: top, idx: i, baseY: top.position.y });
    }

    // decorative pop-up city inside the ring (deterministic, seeded decor)
    var decor = root.CFRNG.derive(cfg.seed, root.CFRNG.STREAM_DECOR);
    var detail = QUALITY[S.quality].envDetail;
    var count = Math.round(10 * detail) + 4;
    for (var k = 0; k < count; k++) {
      var a = decor.next() * Math.PI * 2;
      var r = 0.15 + decor.next() * 0.45;
      var h = 0.1 + decor.next() * 0.3;
      var tint = [p.accent, p.edge, 0xffffff, p.light][decor.int(4)];
      var b = paperBuilding(0.08 + decor.next() * 0.08, h, 0.08 + decor.next() * 0.06, tint);
      b.position.set(Math.cos(a) * r, -0.05, Math.sin(a) * r);
      b.rotation.y = decor.next() * Math.PI;
      b.traverse(function (o) { o.raycast = function () {}; }); // decor never intercepts raycasts
      board.add(b);
      S.props.push(b);
    }

    // player tokens
    S.tokens.you = makeToken(p.token);
    S.tokens.rival = cfg.rival ? makeToken(p.tokenRival) : null;

    // selection marker (grounded ring, lifted tile is applied separately)
    var mk = new THREE.Mesh(geom(new THREE.RingGeometry(0.16, 0.21, 24)),
      new THREE.MeshBasicMaterial({ color: p.accent, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
    mk.rotation.x = -Math.PI / 2;
    mk.visible = false;
    mk.userData.isMarker = true;
    mk.raycast = function () {};
    board.add(mk);
    S.marker = mk;
  }

  function tileColor(tile, p) {
    switch (tile.t) {
      case 'start': return p.accent;
      case 'prop': return mixColor(p.ring, 0xffffff, 0.35);
      case 'bonus': return 0x7fbf6a;
      case 'toll': return 0xc05a4a;
      case 'card': return 0x6a8fc0;
      case 'sticker': return 0xc9a0dc;
      case 'park': return 0x8aa86a;
      default: return p.ring;
    }
  }

  function districtColor(d) {
    var C = Game.content.DISTRICTS[d];
    var hc = S.paletteHC;
    return C ? (hc ? C.colorHC : C.color) : 0x999999;
  }

  function mixColor(a, b, t) {
    var THREE = T();
    return new THREE.Color(a).lerp(new THREE.Color(b), t).getHex();
  }

  function makeToken(color) {
    var THREE = T();
    var g = new THREE.Group();
    var body = new THREE.Mesh(geom(new THREE.ConeGeometry(FRAMING.TOKEN_R, FRAMING.TOKEN_H, 12)), paperMat(color, 0.55));
    body.position.y = FRAMING.TOKEN_H / 2;
    body.castShadow = QUALITY[S.quality].shadows;
    g.add(body);
    var ringM = new THREE.Mesh(geom(new THREE.TorusGeometry(FRAMING.TOKEN_R * 1.15, 0.02, 8, 20)), paperMat(0xffffff, 0.7));
    ringM.rotation.x = Math.PI / 2;
    ringM.position.y = 0.02;
    g.add(ringM);
    g.raycast = function () {};
    g.traverse(function (o) { o.raycast = function () {}; });
    S.board.add(g);
    return { group: g, tile: 0, animFrom: null, animTo: null, animT: 1, hop: 0 };
  }

  // ---------- state sync ----------

  function tokenWorldPos(cfg, idx, lane) {
    var pos = Game.tilePos(cfg, idx);
    var off = lane === 'rival' ? 0.09 : (S.cfg.rival ? -0.09 : 0);
    // offset perpendicular to the ring tangent
    var px = -Math.sin(pos.angle), pz = Math.cos(pos.angle);
    return { x: pos.x + px * off, z: pos.z + pz * off };
  }

  // Push immutable snapshot state into the scene; events drive animation.
  function syncState(state, events, opts) {
    if (!S.ok || !S.board) return;
    opts = opts || {};
    var instant = S.reducedMotion || opts.instant;

    // buildings reflect ownership + level
    for (var idxStr in state.you.props) applyOwnership(state, +idxStr, 'you', instant);
    if (state.rival) for (var ridx in state.rival.props) applyOwnership(state, +ridx, 'rival', instant);

    // token movement
    moveToken('you', state.you.pos, instant);
    if (state.rival && S.tokens.rival) moveToken('rival', state.rival.pos, instant);

    // event-driven accents
    (events || []).forEach(function (ev) {
      if (ev.type === 'buy' || ev.type === 'build') burst(ev.tile != null ? ev.tile : state.you.pos, 0xffe08a);
      if (ev.type === 'bonus' || ev.type === 'salary' || ev.type === 'lap') burst(state.you.pos, 0xfff0a0);
      if (ev.type === 'page-complete') { burst(state.you.pos, 0xffc46a, 2); S.camShake = S.reducedMotion ? 0 : 0.012; }
      if (ev.type === 'win') { burst(state.you.pos, 0xffffff, 3); S.camShake = S.reducedMotion ? 0 : 0.02; }
    });
  }

  var ownedMarks = {}; // idx_who -> building group
  function applyOwnership(state, idx, who, instant) {
    var key = idx + '_' + who;
    var level = (who === 'you' ? state.you.props : state.rival.props)[idx];
    var existing = ownedMarks[key];
    if (existing && existing.userData.level === level) return;
    if (existing) {
      S.board.remove(existing);
      existing.traverse(function (o) { if (o.geometry) o.geometry.dispose(); });
      delete ownedMarks[key];
    }
    var tile = state.cfg.tiles[idx];
    var pos = Game.tilePos(state.cfg, idx);
    var col = who === 'you' ? S.palette.token : S.palette.tokenRival;
    var h = FRAMING.PROP_H + (level - 1) * FRAMING.BUILD_STEP;
    var b = paperBuilding(FRAMING.PROP_W, h, FRAMING.PROP_D, col);
    b.position.set(pos.x, FRAMING.TILE_H - 0.02, pos.z);
    b.rotation.y = -pos.angle - Math.PI / 2;
    b.userData.level = level;
    b.traverse(function (o) { o.raycast = function () {}; });
    S.board.add(b);
    ownedMarks[key] = b;
    if (!instant) {
      b.scale.set(0.01, 0.01, 0.01);
      addAnim(0.35, function (t) {
        var e = 1 - Math.pow(1 - t, 3);
        b.scale.set(e, e, e);
      });
    }
  }

  function clearOwnershipMarks() {
    for (var k in ownedMarks) {
      if (S.board) S.board.remove(ownedMarks[k]);
      ownedMarks[k].traverse(function (o) { if (o.geometry) o.geometry.dispose(); });
    }
    ownedMarks = {};
  }

  function moveToken(who, tileIdx, instant) {
    var tk = S.tokens[who];
    if (!tk || tk.tile === tileIdx) return;
    tk.animFrom = tk.tile;
    tk.animTo = tileIdx;
    tk.animT = instant ? 1 : 0;
    tk.tile = tileIdx;
    if (instant) placeToken(tk);
  }

  function placeToken(tk) {
    var who = tk === S.tokens.rival ? 'rival' : 'you';
    var p = tokenWorldPos(S.cfg, tk.tile, who);
    tk.group.position.set(p.x, 0, p.z);
  }

  // ---------- animation ----------

  function addAnim(dur, update, done) {
    S.anims.push({ dur: dur, t: 0, update: update, done: done });
  }

  function burst(tileIdx, color, power) {
    var THREE = T();
    var q = QUALITY[S.quality].particles;
    var count = Math.round((power || 1) * 10 * q);
    if (count <= 0) return;
    var pos = Game.tilePos(S.cfg, tileIdx);
    for (var i = 0; i < count; i++) {
      var m = new THREE.Mesh(geom(new THREE.PlaneGeometry(0.03, 0.03)),
        new THREE.MeshBasicMaterial({ color: color, transparent: true, side: THREE.DoubleSide }));
      m.position.set(pos.x, 0.15, pos.z);
      m.raycast = function () {};
      var a = Math.random() * Math.PI * 2, sp = 0.4 + Math.random() * 0.6;
      S.board.add(m);
      var vx = Math.cos(a) * sp, vz = Math.sin(a) * sp, vy = 0.8 + Math.random() * 0.7;
      var p = { mesh: m, t: 0, dur: 0.7, vx: vx, vy: vy, vz: vz };
      S.particles.push(p);
    }
  }

  // dt seconds; advances deterministic-ish cosmetic animation only.
  function update(dt) {
    if (!S.ok) return;
    if (S.reducedMotion) dt = Math.min(dt, 0.05);
    var i, tk;
    for (var key in S.tokens) {
      tk = S.tokens[key];
      if (!tk) continue;
      if (tk.animT < 1) {
        tk.animT = Math.min(1, tk.animT + dt / 0.45);
        var n = S.cfg.tiles.length;
        var from = tk.animFrom, to = tk.animTo;
        var steps = ((to - from) % n + n) % n;
        var fpos = tokenWorldPos(S.cfg, from, key);
        var tpos = tokenWorldPos(S.cfg, to, key);
        var e = tk.animT < 0.5 ? 2 * tk.animT * tk.animT : 1 - Math.pow(-2 * tk.animT + 2, 2) / 2;
        var hop = Math.sin(tk.animT * Math.PI * Math.min(steps, 4)) * 0.12;
        tk.group.position.set(
          fpos.x + (tpos.x - fpos.x) * e,
          Math.abs(hop),
          fpos.z + (tpos.z - fpos.z) * e);
        if (tk.animT >= 1) placeToken(tk);
      }
    }
    for (i = S.anims.length - 1; i >= 0; i--) {
      var an = S.anims[i];
      an.t += dt;
      var t01 = Math.min(1, an.t / an.dur);
      an.update(t01);
      if (t01 >= 1) { if (an.done) an.done(); S.anims.splice(i, 1); }
    }
    for (i = S.particles.length - 1; i >= 0; i--) {
      var p = S.particles[i];
      p.t += dt;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      p.vy -= 2.4 * dt;
      p.mesh.material.opacity = Math.max(0, 1 - p.t / p.dur);
      p.mesh.rotation.z += dt * 4;
      if (p.t >= p.dur) {
        S.board.remove(p.mesh);
        p.mesh.geometry.dispose(); p.mesh.material.dispose();
        S.particles.splice(i, 1);
      }
    }
    // camera: authored base pose + event-tiered shake, never cumulative
    var shake = S.camShake;
    if (shake > 0) {
      S.camShake = Math.max(0, shake - dt * 0.04);
      S.camera.position.set(
        (Math.random() - 0.5) * shake * 2,
        FRAMING.CAM_Y + (Math.random() - 0.5) * shake,
        FRAMING.CAM_Z);
      S.camera.lookAt(0, FRAMING.LOOK_Y, 0);
    } else {
      S.camera.position.set(0, FRAMING.CAM_Y, FRAMING.CAM_Z);
      S.camera.lookAt(0, FRAMING.LOOK_Y, 0);
    }
  }

  // Fast-forward: settle every animation into its exact end state.
  function settle() {
    var tk2;
    for (var key2 in S.tokens) { tk2 = S.tokens[key2]; if (tk2) { tk2.animT = 1; placeToken(tk2); } }
    S.anims.forEach(function (an) { an.update(1); if (an.done) an.done(); });
    S.anims = [];
    S.particles.forEach(function (p) {
      S.board.remove(p.mesh);
      p.mesh.geometry.dispose(); p.mesh.material.dispose();
    });
    S.particles = [];
    S.camShake = 0;
  }

  // ---------- selection / picking ----------

  function setSelection(tileIdx) {
    if (!S.marker) return;
    if (tileIdx == null) { S.marker.visible = false; return; }
    var pos = Game.tilePos(S.cfg, tileIdx);
    S.marker.position.set(pos.x, 0.012, pos.z);
    S.marker.visible = true;
  }

  function setHighlights(tileIdxs) {
    var THREE = T();
    S.ghostHighlights.forEach(function (m) {
      S.board.remove(m); m.geometry.dispose(); m.material.dispose();
    });
    S.ghostHighlights = [];
    (tileIdxs || []).forEach(function (idx) {
      var pos = Game.tilePos(S.cfg, idx);
      var m = new THREE.Mesh(geom(new THREE.RingGeometry(0.13, 0.17, 20)),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, side: THREE.DoubleSide }));
      m.rotation.x = -Math.PI / 2;
      m.position.set(pos.x, 0.011, pos.z);
      m.raycast = function () {};
      S.board.add(m);
      S.ghostHighlights.push(m);
    });
  }

  // Raycast against tile tops only (explicit interaction layer).
  function pick(clientX, clientY) {
    if (!S.ok || !S.board) return null;
    var rect = S.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    S.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1);
    S.raycaster.setFromCamera(S.pointer, S.camera);
    var tops = S.tileMeshes.map(function (t) { return t.top; });
    var hits = S.raycaster.intersectObjects(tops, false);
    return hits.length ? hits[0].object.userData.tileIdx : null;
  }

  // Project a tile to CSS-pixel coordinates for DOM label alignment.
  function projectTile(tileIdx, outW, outH) {
    var THREE = T();
    if (!S.ok) return null;
    var pos = Game.tilePos(S.cfg, tileIdx);
    var v = new THREE.Vector3(pos.x, 0.05, pos.z).project(S.camera);
    var rect = S.canvas.getBoundingClientRect();
    return {
      x: (v.x * 0.5 + 0.5) * rect.width,
      y: (-v.y * 0.5 + 0.5) * rect.height
    };
  }

  function setViewport(w, h) {
    if (!S.ok || !w || !h) return;
    S.camera.aspect = w / h;
    S.camera.updateProjectionMatrix();
    S.renderer.setSize(w, h, false);
  }

  function render() { if (S.ok) S.renderer.render(S.scene, S.camera); }

  function isAvailable() { return S.ok; }

  root.CFRender = {
    init: init, dispose: dispose, isAvailable: isAvailable,
    buildBoard: buildBoard, clearOwnershipMarks: clearOwnershipMarks,
    syncState: syncState, update: update, settle: settle, render: render,
    setViewport: setViewport, setQuality: setQuality, setReducedMotion: setReducedMotion,
    setPaletteHC: setPaletteHC,
    setSelection: setSelection, setHighlights: setHighlights,
    pick: pick, projectTile: projectTile,
    FRAMING: FRAMING, QUALITY: QUALITY
  };
})(typeof self !== 'undefined' ? self : this);
