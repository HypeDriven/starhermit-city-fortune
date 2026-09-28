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

  var Gfx = root.CFGfx;

  // Colour grade + vignette, applied before tone mapping/output. Gentle
  // S-curve, a touch of saturation, warm highlights and cool shadows; the
  // curve is centred so piece and text contrast only ever increases.
  var GradeShader = {
    uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.2 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: [
      'uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;',
      'varying vec2 vUv;',
      'void main() {',
      '  vec4 src = texture2D(tDiffuse, vUv);',
      '  vec3 c = src.rgb;',
      '  vec3 lc = clamp(c, 0.0, 1.0);',
      '  vec3 s = mix(lc, lc * lc * (3.0 - 2.0 * lc), 0.18);',
      '  float l = dot(s, vec3(0.2126, 0.7152, 0.0722));',
      '  s = mix(vec3(l), s, 1.1);',
      '  s *= mix(vec3(0.97, 0.99, 1.04), vec3(1.03, 1.0, 0.96), smoothstep(0.1, 0.6, l));',
      '  c = mix(c, s + max(c - 1.0, 0.0), uAmount);',
      '  float d = length(vUv - 0.5);',
      '  c *= 1.0 - uVignette * smoothstep(0.38, 0.85, d);',
      '  gl_FragColor = vec4(c, src.a);',
      '}'
    ].join('\n')
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
    motes: null,           // drifting paper flecks (background: animated)
    key: null, hemi: null, windowMat: null,
    cfg: null, theme: null, palette: null,
    reducedMotion: false, osReducedMotion: false, paletteHC: false,
    anims: [],             // [{dur, t, update(t01), done}]
    camShake: 0, time: 0,
    raycaster: null, pointer: null,
    disposables: [],
    // graphics settings
    g: null, gpu: '', detected: 'balanced', grain: null, envTex: null,
    composer: null, gradePass: null, postKey: null, postFailed: false,
    size: [0, 0], sizeDirty: true, pixelRatio: 0, adaptiveScale: 1, frames: [], fps: 0, last: 0
  };

  function T() { return root.THREE; }
  function addons() { return root.CFThreeAddons || null; }

  function track(obj) { S.disposables.push(obj); return obj; }
  function geom(g) { return track(g); }
  function mat(m) { return track(m); }

  // ---------- init / dispose ----------

  function isMobileDevice() {
    var ua = (root.navigator && navigator.userAgent) || '';
    if (/Mobi|Android|iPhone|iPad|iPod/i.test(ua)) return true;
    try { return navigator.maxTouchPoints > 0 && root.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; }
  }

  function gpuName(r) {
    try {
      var gl = r.getContext();
      var ext = gl.getExtension('WEBGL_debug_renderer_info');
      return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
    } catch (e) { return ''; }
  }

  function init(canvas, opts) {
    var THREE = T();
    if (!THREE) return false;
    opts = opts || {};
    try {
      S.renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    } catch (e) { return false; }
    S.canvas = canvas;
    S.renderer.outputColorSpace = THREE.SRGBColorSpace;
    S.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    S.renderer.toneMappingExposure = 1.05;
    S.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    S.gpu = gpuName(S.renderer);
    S.detected = Gfx.detectPreset(S.gpu, { mobile: isMobileDevice() });
    S.scene = new THREE.Scene();
    S.camera = new THREE.PerspectiveCamera(FRAMING.FOV, 1, 0.1, 60);
    S.camera.position.set(0, FRAMING.CAM_Y, FRAMING.CAM_Z);
    S.camera.lookAt(0, FRAMING.LOOK_Y, 0);
    S.raycaster = new THREE.Raycaster();
    S.pointer = new THREE.Vector2();
    S.size = [0, 0]; S.sizeDirty = true; S.pixelRatio = 0; S.postKey = null; S.postFailed = false;
    try {
      var mq = root.matchMedia('(prefers-reduced-motion: reduce)');
      S.osReducedMotion = mq.matches;
      if (mq.addEventListener) mq.addEventListener('change', function (e) { S.osReducedMotion = e.matches; });
    } catch (e) { S.osReducedMotion = false; }
    S.ok = true;
    S.g = null;
    setGraphics(opts.graphics || {});
    return true;
  }

  function dispose() {
    clearBoard();
    disposeComposer();
    if (S.envTex) { S.envTex.dispose(); S.envTex = null; }
    if (S.grain) { S.grain.dispose(); S.grain = null; }
    if (S.renderer) { S.renderer.dispose(); S.renderer.forceContextLoss && S.renderer.forceContextLoss(); }
    S.disposables.forEach(function (d) { if (d && d.dispose) d.dispose(); });
    S.disposables = [];
    S.renderer = null; S.scene = null; S.camera = null; S.ok = false;
  }

  function motionAllowed() { return !S.reducedMotion && !S.osReducedMotion; }

  // ---------- graphics settings ----------

  /** Apply saved graphics settings live. Returns true when the board must be
   *  rebuilt (scene detail or background changed) — the caller owns the state. */
  function setGraphics(saved) {
    if (!S.ok) return false;
    var prev = S.g;
    var g = Gfx.resolve(saved || {}, S.detected);
    S.g = g;
    var r = S.renderer;
    r.shadowMap.enabled = g.shadowMap > 0;
    applyKeyShadow();
    applyEnvironment();
    applyGlow();
    S.adaptiveScale = 1; S.frames = []; S.postKey = null; S.sizeDirty = true;
    if (!g.post) S.postFailed = false;
    fpsVisible(g.showFps);
    // shadow maps and environment are compiled into the shaders
    if (S.scene) S.scene.traverse(function (o) {
      if (!o.material) return;
      (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { m.needsUpdate = true; });
    });
    if (S.canvas) S.canvas.setAttribute('data-gfx-preset', g.preset);
    return !!(prev && S.board && (prev.detail !== g.detail || prev.background !== g.background));
  }

  function applyKeyShadow() {
    if (!S.key || !S.g) return;
    var size = S.g.shadowMap;
    S.key.castShadow = size > 0;
    if (size > 0 && S.key.shadow.mapSize.x !== size) {
      S.key.shadow.mapSize.set(size, size);
      if (S.key.shadow.map) { S.key.shadow.map.dispose(); S.key.shadow.map = null; }
    }
  }

  // Image-based lighting: a PMREM-filtered room gives paper a soft sky fill
  // and the lacquered pawns real highlights.
  function applyEnvironment() {
    var THREE = T();
    var on = S.g && S.g.reflections === 'on';
    if (on && !S.envTex) {
      var A = addons();
      if (A && A.RoomEnvironment) {
        try {
          var pmrem = new THREE.PMREMGenerator(S.renderer);
          var room = new A.RoomEnvironment(S.renderer);
          S.envTex = pmrem.fromScene(room, 0.04).texture;
          if (room.dispose) room.dispose();
          pmrem.dispose();
        } catch (e) { S.envTex = null; }
      }
    }
    S.scene.environment = on ? S.envTex : null;
    if (S.hemi) S.hemi.intensity = S.scene.environment ? 0.7 : 0.85;
  }

  // The selection marker glows (HDR colour, picked up by bloom) when bloom is on.
  function applyGlow() {
    if (!S.marker || !S.palette) return;
    var THREE = T();
    var c = new THREE.Color(S.palette.accent);
    if (S.g && S.g.bloom === 'on') c.multiplyScalar(2.2);
    S.marker.material.color.copy(c);
  }

  function fpsVisible(on) {
    var el = document.getElementById('fps-meter');
    if (on && !el) {
      el = document.createElement('div');
      el.id = 'fps-meter';
      el.className = 'fps-meter';
      el.setAttribute('aria-hidden', 'true');
      el.textContent = '… fps';
      document.body.appendChild(el);
    }
    if (el) el.hidden = !on;
  }

  /** What the Graphics panel shows. */
  function graphicsInfo() {
    var px = S.size[0] && S.pixelRatio ? [Math.round(S.size[0] * S.pixelRatio), Math.round(S.size[1] * S.pixelRatio)] : null;
    return {
      gpu: S.gpu, detected: S.detected, resolved: S.g, pixels: px,
      fps: Math.round(S.fps || 0), adaptiveScale: Math.round(S.adaptiveScale * 100) / 100,
      postFailed: !!S.postFailed
    };
  }

  function disposeComposer() {
    if (S.composer) {
      S.composer.passes.forEach(function (p) { if (p.dispose) p.dispose(); });
      S.composer.dispose();
    }
    S.composer = null; S.gradePass = null;
  }

  function postKey(w, h) {
    var g = S.g;
    return g.post ? [g.ao, g.bloom, g.grade, g.antialias, w, h, S.pixelRatio].join('|') : 'none';
  }

  function buildPost(w, h) {
    var THREE = T();
    var g = S.g;
    disposeComposer();
    if (!g.post) return;
    var A = addons();
    if (!A) { S.postFailed = true; return; }
    var pr = S.pixelRatio, pw = Math.max(1, Math.round(w * pr)), ph = Math.max(1, Math.round(h * pr));
    try {
      var target = new THREE.WebGLRenderTarget(pw, ph, {
        type: THREE.HalfFloatType, samples: g.antialias === 'msaa' ? 4 : 0
      });
      var composer = new A.EffectComposer(S.renderer, target);
      composer.setPixelRatio(pr);
      composer.setSize(w, h);
      composer.addPass(new A.RenderPass(S.scene, S.camera));
      if (g.ao !== 'off') {
        var ao = new A.GTAOPass(S.scene, S.camera, pw, ph);
        ao.output = A.GTAOPass.OUTPUT.Default;
        ao.blendIntensity = 0.85;
        var hi = g.ao === 'high';
        ao.updateGtaoMaterial({ radius: 0.22, distanceExponent: 1.4, thickness: 0.6, scale: 1.0, samples: hi ? 16 : 8 });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: hi ? 6 : 4, rings: 2, samples: hi ? 16 : 8 });
        composer.addPass(ao);
      }
      if (g.bloom === 'on') {
        // High threshold: only emissive windows, the selection glow and bright highlights bloom.
        composer.addPass(new A.UnrealBloomPass(new THREE.Vector2(w, h), 0.42, 0.35, 1.0));
      }
      if (g.grade === 'on') {
        S.gradePass = new A.ShaderPass(GradeShader);
        composer.addPass(S.gradePass);
      }
      composer.addPass(new A.OutputPass());
      if (g.antialias === 'smaa') composer.addPass(new A.SMAAPass(pw, ph));
      if (g.antialias === 'fxaa') {
        var fxaa = new A.ShaderPass(A.FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / pw, 1 / ph);
        composer.addPass(fxaa);
      }
      S.composer = composer;
      S.postFailed = false;
    } catch (e) {
      // Post-processing is an enhancement: render directly if the chain cannot be built.
      disposeComposer();
      S.postFailed = true;
    }
  }

  // Adaptive resolution: step the scale down when frames are slow, back up when fast.
  function adapt(dt) {
    if (dt > 100) return false; // resumed after a pause/hidden tab: not a real frame time
    var f = S.frames;
    f.push(dt);
    if (f.length < 90) return false;
    var avg = f.reduce(function (a, b) { return a + b; }, 0) / f.length;
    f.length = 0;
    S.fps = 1000 / avg;
    var el = document.getElementById('fps-meter');
    if (el && !el.hidden) el.textContent = Math.round(S.fps) + ' fps · ' + (Math.round(S.pixelRatio * 100) / 100) + '×';
    if (!S.g.adaptive) return false;
    var before = S.adaptiveScale;
    if (avg > 26) S.adaptiveScale = Math.max(0.6, S.adaptiveScale - 0.1);
    else if (avg < 14 && S.adaptiveScale < 1) S.adaptiveScale = Math.min(1, S.adaptiveScale + 0.05);
    return before !== S.adaptiveScale;
  }

  function setReducedMotion(on) { S.reducedMotion = !!on; }

  // High-visibility district colors; takes effect on the next buildBoard.
  function setPaletteHC(on) { S.paletteHC = !!on; }

  // Procedural paper grain (fibres + speckle), shared by every paper material.
  function grainTexture() {
    var THREE = T();
    if (S.grain) return S.grain;
    var n = 128, cv = document.createElement('canvas');
    cv.width = cv.height = n;
    var ctx = cv.getContext('2d');
    var img = ctx.createImageData(n, n), d = img.data;
    var seed = 12345;
    function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
    for (var i = 0; i < n * n; i++) {
      var v = 238 + rnd() * 17;
      d[i * 4] = v; d[i * 4 + 1] = v - 1; d[i * 4 + 2] = v - 4; d[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    ctx.globalAlpha = 0.09;
    ctx.strokeStyle = '#7a6a52';
    for (var k = 0; k < 70; k++) {
      var x = rnd() * n, y = rnd() * n, a = rnd() * Math.PI, len = 4 + rnd() * 14;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); ctx.stroke();
    }
    var tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = Math.min(4, S.renderer.capabilities.getMaxAnisotropy());
    S.grain = tex;
    return tex;
  }

  function detailed() { return S.g && S.g.detail === 'detailed'; }

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
    S.marker = null; S.ghostHighlights = []; S.props = []; S.motes = null;
    S.key = null; S.hemi = null; S.windowMat = null;
    clearOwnershipMarks();
    // every tracked resource belonged to the board that was just released
    S.disposables = [];
  }

  // Card-stock material. At detailed quality it carries the paper grain and a
  // faint environment reflection; plain matches the original flat look.
  function paperMat(color, rough) {
    var THREE = T();
    var o = { color: color, roughness: rough == null ? 0.9 : rough, metalness: 0.02, flatShading: true };
    if (detailed()) { o.map = grainTexture(); o.envMapIntensity = 0.15; }
    return new THREE.MeshStandardMaterial(o);
  }

  function shadowed(obj) {
    obj.traverse(function (o) { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return obj;
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
    return shadowed(g);
  }

  // Detailed pop-up house: card walls with lit window cut-outs under a folded
  // roof. `floors` rows of windows; total height h (roof included).
  function paperHouse(w, h, d, wallColor, roofColor, floors) {
    var THREE = T();
    var g = new THREE.Group();
    var roofH = Math.min(h * 0.45, w * 0.8);
    var wallH = Math.max(0.04, h - roofH);
    var walls = new THREE.Mesh(geom(new THREE.BoxGeometry(w, wallH, d)), paperMat(wallColor));
    walls.position.y = wallH / 2 + 0.02;
    g.add(walls);
    var roof = new THREE.Mesh(geom(new THREE.ConeGeometry(w * 0.78, roofH, 4)), paperMat(roofColor, 0.8));
    roof.rotation.y = Math.PI / 4;
    roof.position.y = wallH + 0.02 + roofH / 2;
    roof.scale.z = d / w;
    g.add(roof);
    var base = new THREE.Mesh(geom(new THREE.BoxGeometry(w * 1.12, 0.02, d * 1.12)), paperMat(0xf6ecd4));
    base.position.y = 0.01;
    g.add(base);
    shadowed(g);
    if (floors > 0 && S.windowMat) {
      var ww = Math.min(0.035, w * 0.22), wh = Math.min(0.035, wallH / (floors + 1) * 0.6);
      var wg = geom(new THREE.PlaneGeometry(ww, wh));
      for (var f = 0; f < floors; f++) {
        var y = 0.02 + wallH * (f + 0.6) / (floors + 0.2);
        [-1, 1].forEach(function (side) {
          for (var c = -1; c <= 1; c += 2) {
            var win = new THREE.Mesh(wg, S.windowMat);
            win.position.set(c * w * 0.24, y, side * (d / 2 + 0.001));
            if (side < 0) win.rotation.y = Math.PI;
            g.add(win);
          }
        });
      }
    }
    return g;
  }

  function paperTree(h, color) {
    var THREE = T();
    var g = new THREE.Group();
    var trunk = new THREE.Mesh(geom(new THREE.CylinderGeometry(0.008, 0.01, h * 0.3, 5)), paperMat(0x8a6a48));
    trunk.position.y = h * 0.15;
    g.add(trunk);
    for (var i = 0; i < 2; i++) {
      var cone = new THREE.Mesh(geom(new THREE.ConeGeometry(h * (0.32 - i * 0.08), h * 0.55, 6)), paperMat(color, 0.85));
      cone.position.y = h * (0.45 + i * 0.25);
      g.add(cone);
    }
    return shadowed(g);
  }

  function isNightPalette(p) {
    var c = new (T().Color)(p.sky);
    return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) < 0.2;
  }

  function buildBoard(cfg, theme) {
    var THREE = T();
    if (!S.ok) return;
    clearBoard();
    S.cfg = cfg; S.theme = theme;
    var p = theme.palette;
    S.palette = p;
    var rich = detailed();
    var night = isNightPalette(p);

    var board = new THREE.Group();
    S.board = board;
    S.scene.add(board);
    S.scene.background = new THREE.Color(p.sky);
    S.scene.fog = new THREE.Fog(p.fog, 4.5, 9);

    // lights: one dominant key + soft hemisphere fill
    var key = new THREE.DirectionalLight(p.light, 1.6);
    key.position.set(1.6, 3.2, 1.2);
    // shadow frustum fitted to the board disc (radius 2) seen from the key
    key.shadow.camera.left = -2.1; key.shadow.camera.right = 2.1;
    key.shadow.camera.top = 2.1; key.shadow.camera.bottom = -2.1;
    key.shadow.camera.near = 1.5; key.shadow.camera.far = 6.5;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.012;
    board.add(key);
    S.key = key;
    applyKeyShadow();
    S.hemi = new THREE.HemisphereLight(p.sky, p.ground, 0.85);
    board.add(S.hemi);
    applyEnvironment();

    // window cut-outs: warm lamps; they glow (and bloom) on night themes
    if (rich) {
      S.windowMat = mat(new THREE.MeshStandardMaterial({
        color: night ? 0x3a2a18 : 0x5a4a38, roughness: 0.6, metalness: 0,
        emissive: 0xffc46a, emissiveIntensity: night ? 2.4 : 0.25
      }));
    }

    // craft table under the board (catches the board's shadow)
    if (rich) {
      var table = new THREE.Mesh(geom(new THREE.CircleGeometry(7, 48)),
        paperMat(mixColor(p.edge, p.sky, 0.35), 1));
      table.rotation.x = -Math.PI / 2;
      table.position.y = -0.145;
      table.receiveShadow = true;
      board.add(table);
    }

    // table / ground disc
    var ground = new THREE.Mesh(geom(new THREE.CylinderGeometry(1.85, 2.0, 0.08, 48)), paperMat(p.ground, 1));
    ground.position.y = -0.1;
    ground.receiveShadow = true;
    ground.castShadow = true;
    board.add(ground);
    var rim = new THREE.Mesh(geom(new THREE.TorusGeometry(1.85, 0.035, 10, 64)), paperMat(p.edge, 0.8));
    rim.rotation.x = Math.PI / 2;
    rim.position.y = -0.065;
    rim.castShadow = true;
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
      top.castShadow = true;
      top.receiveShadow = true;
      top.userData.tileIdx = i;
      g.add(top);
      // detailed: a printed card face inset on top of the tile
      if (rich) {
        var face = new THREE.Mesh(geom(new THREE.PlaneGeometry(FRAMING.TILE_W - 0.04, FRAMING.TILE_D - 0.04)),
          paperMat(mixColor(color, 0xffffff, 0.08), 0.85));
        face.rotation.x = -Math.PI / 2;
        face.position.y = FRAMING.TILE_H - 0.0195;
        face.receiveShadow = true;
        face.raycast = function () {};
        g.add(face);
      }
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
    var count = rich ? 16 : 8;
    var treeCol = mixColor(0x5d8c4a, p.fog, 0.2);
    for (var k = 0; k < count; k++) {
      var a = decor.next() * Math.PI * 2;
      var r = 0.15 + decor.next() * 0.45;
      var h = 0.1 + decor.next() * 0.3;
      var tint = [p.accent, p.edge, 0xffffff, p.light][decor.int(4)];
      var bw = 0.08 + decor.next() * 0.08, bd = 0.08 + decor.next() * 0.06;
      var b;
      if (!rich) b = paperBuilding(bw, h, bd, tint);
      else {
        var kind = decor.next();
        if (kind < 0.3) b = paperTree(0.12 + h * 0.5, treeCol);
        else if (kind < 0.85) b = paperHouse(bw, h + 0.06, bd, mixColor(p.ring, 0xffffff, 0.3), tint, Math.max(1, Math.round(h / 0.12)));
        else b = paperBuilding(bw, h, bd, tint);
      }
      b.position.set(Math.cos(a) * r, -0.05, Math.sin(a) * r);
      b.rotation.y = decor.next() * Math.PI;
      b.traverse(function (o) { o.raycast = function () {}; }); // decor never intercepts raycasts
      board.add(b);
      S.props.push(b);
    }

    // drifting paper flecks above the table (background: animated)
    if (S.g && S.g.background === 'animated') {
      var mcount = 70, mp = new Float32Array(mcount * 3);
      for (var q = 0; q < mcount; q++) {
        var ma = decor.next() * Math.PI * 2, mr = 0.3 + decor.next() * 2.4;
        mp[q * 3] = Math.cos(ma) * mr; mp[q * 3 + 1] = 0.15 + decor.next() * 1.1; mp[q * 3 + 2] = Math.sin(ma) * mr;
      }
      var mg = geom(new THREE.BufferGeometry());
      mg.setAttribute('position', new THREE.BufferAttribute(mp, 3));
      var motes = new THREE.Points(mg, new THREE.PointsMaterial({
        color: mixColor(p.light, 0xffffff, 0.5), size: 0.022, transparent: true, opacity: night ? 0.7 : 0.55, depthWrite: false
      }));
      motes.raycast = function () {};
      board.add(motes);
      S.motes = motes;
    }

    // player tokens
    S.tokens.you = makeToken(p.token);
    S.tokens.rival = cfg.rival ? makeToken(p.tokenRival) : null;

    // selection marker (grounded ring, lifted tile is applied separately)
    var mk = new THREE.Mesh(geom(new THREE.RingGeometry(0.16, 0.21, rich ? 40 : 24)),
      new THREE.MeshBasicMaterial({ color: p.accent, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
    mk.rotation.x = -Math.PI / 2;
    mk.visible = false;
    mk.userData.isMarker = true;
    mk.raycast = function () {};
    board.add(mk);
    S.marker = mk;
    applyGlow();
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
    if (detailed()) {
      // lacquered wooden pawn: smooth cone body, ball head, clear-coat shine
      var lacquer = new THREE.MeshPhysicalMaterial({
        color: color, roughness: 0.4, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.18, envMapIntensity: 1
      });
      var body = new THREE.Mesh(geom(new THREE.ConeGeometry(FRAMING.TOKEN_R, FRAMING.TOKEN_H * 0.92, 28)), lacquer);
      body.position.y = FRAMING.TOKEN_H * 0.46;
      g.add(body);
      var head = new THREE.Mesh(geom(new THREE.SphereGeometry(FRAMING.TOKEN_R * 0.55, 20, 14)), lacquer);
      head.position.y = FRAMING.TOKEN_H * 0.9;
      g.add(head);
    } else {
      var cone = new THREE.Mesh(geom(new THREE.ConeGeometry(FRAMING.TOKEN_R, FRAMING.TOKEN_H, 12)), paperMat(color, 0.55));
      cone.position.y = FRAMING.TOKEN_H / 2;
      g.add(cone);
    }
    var ringM = new THREE.Mesh(geom(new THREE.TorusGeometry(FRAMING.TOKEN_R * 1.15, 0.02, 8, 20)), paperMat(0xffffff, 0.7));
    ringM.rotation.x = Math.PI / 2;
    ringM.position.y = 0.02;
    g.add(ringM);
    g.traverse(function (o) { if (o.isMesh) o.castShadow = true; });
    g.raycast = function () {};
    g.traverse(function (o) { o.raycast = function () {}; });
    S.board.add(g);
    return { group: g, tile: 0, animFrom: null, animTo: null, animT: 1, hop: 0, phase: Math.random() * 6.28 };
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
    // detailed: a house with a roof in the owner's colour and one window row per level
    var b = detailed()
      ? paperHouse(FRAMING.PROP_W, h + 0.04, FRAMING.PROP_D, mixColor(col, 0xffffff, 0.45), col, level)
      : paperBuilding(FRAMING.PROP_W, h, FRAMING.PROP_D, col);
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
    var q = S.g ? S.g.particleScale : 1;
    var many = q >= 1;
    var count = Math.round((power || 1) * (many ? 14 : 10) * q);
    if (count <= 0) return;
    var pos = Game.tilePos(S.cfg, tileIdx);
    // high: mixed confetti colours (event colour, theme accent, white paper)
    var tints = many && S.palette ? [color, color, S.palette.accent, 0xffffff] : [color];
    for (var i = 0; i < count; i++) {
      var m = new THREE.Mesh(geom(new THREE.PlaneGeometry(0.03, many ? 0.02 : 0.03)),
        new THREE.MeshBasicMaterial({ color: tints[i % tints.length], transparent: true, side: THREE.DoubleSide }));
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
    var moving = motionAllowed();
    if (moving) S.time += dt;
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
      } else if (moving && S.g && S.g.background === 'animated') {
        // gentle idle bob while waiting
        tk.group.position.y = 0.008 * (1 + Math.sin(S.time * 2.1 + tk.phase));
      }
    }
    // ambient: marker pulse and drifting paper flecks (frozen under reduced motion)
    if (S.marker && S.marker.visible) {
      var pulse = moving ? Math.sin(S.time * 3.2) : 0;
      S.marker.scale.setScalar(1 + 0.05 * pulse);
      S.marker.material.opacity = 0.85 + 0.1 * pulse;
    }
    if (S.motes && moving) {
      S.motes.rotation.y = S.time * 0.025;
      S.motes.position.y = Math.sin(S.time * 0.4) * 0.04;
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
    if (w !== S.size[0] || h !== S.size[1]) { S.size = [w, h]; S.sizeDirty = true; }
  }

  // Pixel ratio = min(dpr, preset cap) x render scale x adaptive scale; the
  // post chain is rebuilt only when its key (effects, size, ratio) changes.
  function render() {
    if (!S.ok || !S.size[0]) return;
    var now = (root.performance && performance.now()) || 0;
    var dt = S.last ? Math.min(250, now - S.last) : 16;
    S.last = now;
    var rescale = adapt(dt);
    var w = S.size[0], h = S.size[1];
    var ratio = Math.min(root.devicePixelRatio || 1, S.g.cap) * S.g.scale * S.adaptiveScale;
    if (S.sizeDirty || rescale || ratio !== S.pixelRatio) {
      S.sizeDirty = false;
      S.pixelRatio = ratio;
      S.renderer.setPixelRatio(ratio);
      S.renderer.setSize(w, h, false);
    }
    var key = postKey(w, h);
    if (key !== S.postKey) { S.postKey = key; buildPost(w, h); }
    if (S.composer) {
      try { S.composer.render(dt / 1000); return; } catch (e) { disposeComposer(); S.postFailed = true; }
    }
    S.renderer.render(S.scene, S.camera);
  }

  function isAvailable() { return S.ok; }

  root.CFRender = {
    init: init, dispose: dispose, isAvailable: isAvailable,
    buildBoard: buildBoard, clearOwnershipMarks: clearOwnershipMarks,
    syncState: syncState, update: update, settle: settle, render: render,
    setViewport: setViewport, setGraphics: setGraphics, graphicsInfo: graphicsInfo,
    setReducedMotion: setReducedMotion,
    setPaletteHC: setPaletteHC,
    setSelection: setSelection, setHighlights: setHighlights,
    pick: pick, projectTile: projectTile,
    FRAMING: FRAMING
  };
})(typeof self !== 'undefined' ? self : this);
