// The pop-up paper city on starhermit:scene, as the browser build's
// js/render.js drew it: the round board on its ground disc with the rim and
// the ring path ribbon, the circuit's tiles (a coloured card per kind, the
// district stripe on properties, a pop-up arch on Start, a printed face when
// detailed), the seeded pop-up decor inside the ring (tents; houses with lit
// window cut-outs and paper trees when detailed), the craft table under the
// board, drifting paper flecks, the pawns (lacquered wood with a clear coat
// on the higher levels, card cones on Low), the owners' buildings that grow
// a floor per level, the selection ring and the white rings on legal build
// targets, confetti bursts on buys, builds, bonuses, pages and the win, and
// the small camera shake on a completed page and the win. The camera keeps
// the authored framing (48°, from 2.35 up and 2.65 back toward the centre),
// framed into the playfield the HUD leaves (setViewOffset), as the browser
// build's canvas sat between its rails.
//
// Lights, the fitted shadow box and the room environment are the page's own
// (three.js r160 parity at engine minor 28; r160 scaled scene.environment by
// each material's envMapIntensity, so each standard material takes the room
// as its own envMap); flat shading is non-indexed geometry; the post chain is
// renderer.ao / bloom / grade / antialias.
import {
  ACESFilmicToneMapping, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, CircleGeometry, Color, ConeGeometry, CylinderGeometry,
  DirectionalLight, DoubleSide, Fog, Group, HemisphereLight, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial,
  MeshPhysicalMaterial, MeshStandardMaterial, Object3D, PMREMGenerator, PerspectiveCamera, PlaneGeometry, Points, PointsMaterial,
  Raycaster, RepeatWrapping, RingGeometry, RoomEnvironment, SRGBColorSpace, SphereGeometry, TorusGeometry, Vector3, pointerToNdc,
  renderer, scene, type Material, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas } from "starhermit:canvas";
import { Content, Game, RNG, type Cfg, type Ev, type State, type Theme } from "./classic.ts";
import type { Look } from "./quality.ts";

const PI = Math.PI;
const FRAMING = {
  CAM_Y: 2.35, CAM_Z: 2.65, LOOK_Y: 0, FOV: 48,
  TILE_W: 0.30, TILE_H: 0.055, TILE_D: 0.42,
  PROP_W: 0.24, PROP_D: 0.30, PROP_H: 0.16, BUILD_STEP: 0.14,
  TOKEN_R: 0.085, TOKEN_H: 0.24,
};
/** Paper's envMapIntensity at detailed quality (js/render.js makePaperMat); others take three's default 1. */
const envI = new WeakMap<Material, number>();

const camera = new PerspectiveCamera(FRAMING.FOV, 16 / 9, 0.1, 60);
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

let look: Look | null = null;
let reducedMotion = false;
let paletteHC = false;
let time = 0;
let envTex: Texture | null = null;
let grain: Texture | null = null;

type Palette = Theme["palette"];
let cfg: Cfg | null = null;
let theme: Theme | null = null;
let palette: Palette | null = null;
let board: Group | null = null;
let tileTops: Mesh[] = [];
let marker: Mesh | null = null;
let highlights: Mesh[] = [];
let motes: Points | null = null;
let windowMat: Material | null = null;
let hemi: HemisphereLight | null = null;
interface Token { group: Group; tile: number; from: number; to: number; t: number; phase: number }
const tokens: { you: Token | null; rival: Token | null } = { you: null, rival: null };
interface Anim { dur: number; t: number; update: (t01: number) => void }
let anims: Anim[] = [];
interface Particle { mesh: Mesh; mat: MeshBasicMaterial; t: number; dur: number; vx: number; vy: number; vz: number }
let particles: Particle[] = [];
let camShake = 0;
let lastState: State | null = null;
let selection: number | null = null;
let highlightKey = "";

const detailed = (): boolean => !!look && look.detailed;
/** Round-geometry LOD: radial segments scaled by the level's budget (at least `min`, default 4). */
const seg = (n: number, min = 4): number => Math.max(min, Math.round(n * (look ? look.budget.segments : 1)));
function mixColor(a: number, b: number, t: number): number { return new Color(a).lerp(new Color(b), t).getHex(); }
/** Faceted card: the geometry without its index, so each face keeps its own normal. */
function flat(g: BufferGeometry): BufferGeometry {
  const f = g.toNonIndexed();
  f.computeVertexNormals();
  return f;
}

// ---------------------------------------------------------------- materials
/** Procedural paper grain (fibres + speckle), shared by every paper material. */
function grainTexture(): Texture {
  if (grain) return grain;
  const n = look ? look.budget.grain : 128;
  const cv = new OffscreenCanvas(n, n);
  const ctx = cv.getContext("2d");
  const img = ctx.createImageData(n, n), d = img.data;
  let seed = 12345;
  const rnd = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < n * n; i++) {
    const v = 238 + rnd() * 17;
    d[i * 4] = v; d[i * 4 + 1] = v - 1; d[i * 4 + 2] = v - 4; d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  ctx.globalAlpha = 0.09;
  ctx.strokeStyle = "#7a6a52";
  for (let k = 0; k < Math.round(70 * (n / 128) * (n / 128)); k++) {
    const x = rnd() * n, y = rnd() * n, a = rnd() * PI, len = (4 + rnd() * 14) * Math.max(1, n / 256);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); ctx.stroke();
  }
  const tex = new CanvasTexture(cv);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.anisotropy = 4;
  grain = tex;
  return tex;
}
// Paper materials are shared per (colour, roughness) within a board.
let paperCache = new Map<string, Material>();
function paperMat(color: number, rough = 0.9): Material {
  const key = `${color}|${rough}`;
  let m = paperCache.get(key);
  if (!m) {
    const map = detailed() ? grainTexture() : null;
    m = look && look.budget.material === "lambert"
      ? new MeshLambertMaterial({ color, map })
      : new MeshStandardMaterial({ color, roughness: rough, metalness: 0.02, map });
    if (map) envI.set(m, 0.15);
    paperCache.set(key, m);
  }
  return m;
}
function shadowed<T extends Object3D>(obj: T): T {
  obj.traverse((o) => { if (o instanceof Mesh) { o.castShadow = true; o.receiveShadow = true; } });
  return obj;
}

// ---------------------------------------------------------------- pop-ups
/** A pop-up paper building: a folded four-sided tent on a card base. */
function paperBuilding(w: number, h: number, d: number, color: number): Group {
  const g = new Group();
  const roof = new Mesh(flat(new ConeGeometry(w * 0.7, h, 4)), paperMat(color));
  roof.rotation.y = PI / 4;
  roof.position.y = h / 2;
  roof.scale.z = d / w;
  g.add(roof);
  const base = new Mesh(new BoxGeometry(w, 0.02, d), paperMat(0xf6ecd4));
  base.position.y = 0.01;
  g.add(base);
  return shadowed(g);
}
const winMatrix = new Matrix4();
/** Detailed pop-up house: card walls with lit window cut-outs under a folded roof; `floors` window rows. */
function paperHouse(w: number, h: number, d: number, wallColor: number, roofColor: number, floors: number): Group {
  const g = new Group();
  const roofH = Math.min(h * 0.45, w * 0.8);
  const wallH = Math.max(0.04, h - roofH);
  const walls = new Mesh(new BoxGeometry(w, wallH, d), paperMat(wallColor));
  walls.position.y = wallH / 2 + 0.02;
  g.add(walls);
  const roof = new Mesh(flat(new ConeGeometry(w * 0.78, roofH, 4)), paperMat(roofColor, 0.8));
  roof.rotation.y = PI / 4;
  roof.position.y = wallH + 0.02 + roofH / 2;
  roof.scale.z = d / w;
  g.add(roof);
  const base = new Mesh(new BoxGeometry(w * 1.12, 0.02, d * 1.12), paperMat(0xf6ecd4));
  base.position.y = 0.01;
  g.add(base);
  shadowed(g);
  if (floors > 0 && windowMat) {
    const ww = Math.min(0.035, w * 0.22), wh = Math.min(0.035, wallH / (floors + 1) * 0.6);
    // One instanced draw for all of a house's window cut-outs.
    const wins = new InstancedMesh(new PlaneGeometry(ww, wh), windowMat, floors * 4);
    const o = new Object3D();
    let wi = 0;
    for (let f = 0; f < floors; f++) {
      const y = 0.02 + wallH * (f + 0.6) / (floors + 0.2);
      for (const side of [-1, 1]) {
        for (const c of [-1, 1]) {
          o.position.set(c * w * 0.24, y, side * (d / 2 + 0.001));
          o.rotation.set(0, side < 0 ? PI : 0, 0);
          o.updateMatrixWorld();
          winMatrix.copy(o.matrixWorld);
          wins.setMatrixAt(wi++, winMatrix);
        }
      }
    }
    g.add(wins);
  }
  return g;
}
function paperTree(h: number, color: number): Group {
  const g = new Group();
  const trunk = new Mesh(new CylinderGeometry(0.008, 0.01, h * 0.3, seg(5)), paperMat(0x8a6a48));
  trunk.position.y = h * 0.15;
  g.add(trunk);
  for (let i = 0; i < 2; i++) {
    const cone = new Mesh(flat(new ConeGeometry(h * (0.32 - i * 0.08), h * 0.55, seg(6))), paperMat(color, 0.85));
    cone.position.y = h * (0.45 + i * 0.25);
    g.add(cone);
  }
  return shadowed(g);
}
function isNight(p: Palette): boolean {
  const c = new Color(p.sky);
  return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) < 0.2;
}
function tileColor(t: Cfg["tiles"][number], p: Palette): number {
  switch (t.t) {
    case "start": return p.accent;
    case "prop": return mixColor(p.ring, 0xffffff, 0.35);
    case "bonus": return 0x7fbf6a;
    case "toll": return 0xc05a4a;
    case "card": return 0x6a8fc0;
    case "sticker": return 0xc9a0dc;
    case "park": return 0x8aa86a;
    default: return p.ring;
  }
}
function districtColor(d: string | undefined): number {
  const c = d ? Content.DISTRICTS[d] : undefined;
  return c ? (paletteHC ? c.colorHC : c.color) : 0x999999;
}

// ---------------------------------------------------------------- lights
const key = new DirectionalLight(0xffe0b0, 1.6);
key.position.set(1.6, 3.2, 1.2);
key.target.position.set(0, 0, 0);
// shadow frustum fitted to the board disc (radius 2) seen from the key
Object.assign(key.shadow.camera, { left: -2.1, right: 2.1, top: 2.1, bottom: -2.1, near: 1.5, far: 6.5 });
key.shadow.camera.updateProjectionMatrix();
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.012;
scene.add(key, key.target);

// ---------------------------------------------------------------- the board
function disposeBoard(): void {
  if (board) {
    board.traverse((o) => { if (o instanceof Mesh || o instanceof Points) o.geometry.dispose(); });
    scene.remove(board);
  }
  for (const m of paperCache.values()) m.dispose();
  paperCache = new Map();
  for (const p of particles) p.mat.dispose();
  for (const h of highlights) (h.material as Material).dispose();
  if (marker) (marker.material as Material).dispose();
  if (windowMat) windowMat.dispose();
  if (hemi) scene.remove(hemi);
  board = null; tileTops = []; marker = null; highlights = []; motes = null; windowMat = null; hemi = null;
  tokens.you = tokens.rival = null; anims = []; particles = []; owned.clear(); highlightKey = "";
}

/** Builds the round's board in a theme (js/render.js buildBoard). */
export function buildBoard(c: Cfg, t: Theme): void {
  disposeBoard();
  cfg = c; theme = t;
  if (!look) return;
  const p = t.palette;
  palette = p;
  const rich = detailed();
  const night = isNight(p);
  const g = new Group();
  board = g;
  scene.add(g);
  scene.background = new Color(p.sky);
  scene.fog = new Fog(p.fog, 4.5, 9);

  key.color.set(p.light);
  const shadows = look.shadows > 0;
  renderer.shadowMap.enabled = shadows;
  key.castShadow = shadows;
  if (shadows) key.shadow.mapSize = look.shadows;
  hemi = new HemisphereLight(p.sky, p.ground, look.reflections ? 0.7 : 0.85);
  scene.add(hemi);
  if (look.reflections) {
    if (!envTex) {
      try { envTex = new PMREMGenerator(renderer).fromScene(new RoomEnvironment(renderer), 0.04).texture; }
      catch (e) { console.warn("environment:", e instanceof Error ? e.message : String(e)); }
    }
  }
  scene.environment = null;

  // window cut-outs: warm lamps; they glow (and bloom) on night themes
  if (rich) {
    windowMat = new MeshStandardMaterial({
      color: night ? 0x3a2a18 : 0x5a4a38, roughness: 0.6, metalness: 0,
      emissive: 0xffc46a, emissiveIntensity: night ? 2.4 : 0.25,
    });
  }
  // craft table under the board (catches the board's shadow)
  if (rich) {
    const table = new Mesh(new CircleGeometry(7, seg(48, 40)), paperMat(mixColor(p.edge, p.sky, 0.35), 1));
    table.rotation.x = -PI / 2;
    table.position.y = -0.145;
    table.receiveShadow = true;
    g.add(table);
  }
  const ground = new Mesh(new CylinderGeometry(1.85, 2.0, 0.08, seg(48, 40)), paperMat(p.ground, 1));
  ground.position.y = -0.1;
  ground.receiveShadow = true;
  ground.castShadow = true;
  g.add(ground);
  const rim = new Mesh(new TorusGeometry(1.85, 0.035, seg(10, 6), seg(64, 40)), paperMat(p.edge, 0.8));
  rim.rotation.x = PI / 2;
  rim.position.y = -0.065;
  rim.castShadow = true;
  g.add(rim);
  const ring = new Mesh(new RingGeometry(Game.BOARD.RING_R - 0.21, Game.BOARD.RING_R + 0.21, seg(64, 40)), paperMat(p.ring, 1));
  ring.rotation.x = -PI / 2;
  ring.position.y = -0.055;
  ring.receiveShadow = true;
  g.add(ring);

  // tiles
  const n = c.tiles.length;
  for (let i = 0; i < n; i++) {
    const tile = c.tiles[i]!;
    const pos = Game.tilePos(c, i);
    const tg = new Group();
    tg.position.set(pos.x, 0, pos.z);
    tg.rotation.y = -pos.angle - PI / 2;
    const color = tileColor(tile, p);
    const top = new Mesh(new BoxGeometry(FRAMING.TILE_W, FRAMING.TILE_H, FRAMING.TILE_D), paperMat(color, 0.95));
    top.position.y = FRAMING.TILE_H / 2 - 0.02;
    top.castShadow = true;
    top.receiveShadow = true;
    top.userData.tileIdx = i;
    tg.add(top);
    if (rich) {
      const face = new Mesh(new PlaneGeometry(FRAMING.TILE_W - 0.04, FRAMING.TILE_D - 0.04), paperMat(mixColor(color, 0xffffff, 0.08), 0.85));
      face.rotation.x = -PI / 2;
      face.position.y = FRAMING.TILE_H - 0.0195;
      face.receiveShadow = true;
      tg.add(face);
    }
    if (tile.t === "prop") {
      const stripe = new Mesh(new BoxGeometry(FRAMING.TILE_W, 0.012, 0.06), paperMat(districtColor(tile.d), 0.8));
      stripe.position.set(0, FRAMING.TILE_H - 0.012, -FRAMING.TILE_D / 2 + 0.05);
      tg.add(stripe);
    }
    if (tile.t === "start") {
      const arch = paperBuilding(0.16, 0.3, 0.1, p.accent);
      arch.position.y = FRAMING.TILE_H - 0.02;
      tg.add(arch);
    }
    g.add(tg);
    tileTops.push(top);
  }

  // decorative pop-up city inside the ring (deterministic, seeded decor)
  const decor = RNG.derive(c.seed, RNG.STREAM_DECOR);
  const treeCol = mixColor(0x5d8c4a, p.fog, 0.2);
  for (let k = 0; k < look.budget.decor; k++) {
    const a = decor.next() * PI * 2;
    const r = 0.15 + decor.next() * 0.45;
    const h = 0.1 + decor.next() * 0.3;
    const tint = [p.accent, p.edge, 0xffffff, p.light][decor.int(4)]!;
    const bw = 0.08 + decor.next() * 0.08, bd = 0.08 + decor.next() * 0.06;
    let b: Group;
    if (!rich) b = paperBuilding(bw, h, bd, tint);
    else {
      const kind = decor.next();
      if (kind < 0.3) b = paperTree(0.12 + h * 0.5, treeCol);
      else if (kind < 0.85) b = paperHouse(bw, h + 0.06, bd, mixColor(p.ring, 0xffffff, 0.3), tint, Math.max(1, Math.round(h / 0.12)));
      else b = paperBuilding(bw, h, bd, tint);
    }
    b.position.set(Math.cos(a) * r, -0.05, Math.sin(a) * r);
    b.rotation.y = decor.next() * PI;
    g.add(b);
  }

  // drifting paper flecks above the table (animated background)
  if (look.animated) {
    const mcount = look.budget.motes, mp = new Float32Array(mcount * 3);
    for (let q = 0; q < mcount; q++) {
      const ma = decor.next() * PI * 2, mr = 0.3 + decor.next() * 2.4;
      mp[q * 3] = Math.cos(ma) * mr; mp[q * 3 + 1] = 0.15 + decor.next() * 1.1; mp[q * 3 + 2] = Math.sin(ma) * mr;
    }
    const mg = new BufferGeometry();
    mg.setAttribute("position", new BufferAttribute(mp, 3));
    motes = new Points(mg, new PointsMaterial({ color: mixColor(p.light, 0xffffff, 0.5), size: 0.022, transparent: true, opacity: night ? 0.7 : 0.55, depthWrite: false }));
    g.add(motes);
  }

  // pawns
  tokens.you = makeToken(p.token);
  tokens.rival = c.rival ? makeToken(p.tokenRival) : null;

  // selection marker (grounded ring); it glows (and blooms) when bloom is on
  const mc = new Color(p.accent);
  if (look.bloom) mc.multiplyScalar(2.2);
  marker = new Mesh(new RingGeometry(0.16, 0.21, seg(rich ? 40 : 24)), new MeshBasicMaterial({ color: mc, transparent: true, opacity: 0.9, side: DoubleSide }));
  marker.rotation.x = -PI / 2;
  marker.visible = false;
  g.add(marker);

  applyEnv(g);
  if (lastState && lastState.cfg.id === c.id) syncState(lastState, null, true);
  setSelection(selection);
}

/** Each standard material gets the room as its own envMap at its envMapIntensity (as r160 drew it). */
function applyEnv(g: Group): void {
  const env = look?.reflections ? envTex : null;
  g.traverse((o) => {
    const m = (o as Mesh).material as Material | Material[] | undefined;
    if (!m) return;
    for (const mat of Array.isArray(m) ? m : [m]) {
      if (!(mat instanceof MeshStandardMaterial)) continue;
      mat.envMap = env;
      mat.envMapIntensity = envI.get(mat) ?? 1;
    }
  });
}

function makeToken(color: number): Token {
  const g = new Group();
  if (detailed() && look) {
    // lacquered wooden pawn: smooth cone body, ball head, clear-coat shine on High and Ultra
    const kind = look.budget.material;
    const lacquer = kind === "physical"
      ? new MeshPhysicalMaterial({ color, roughness: 0.4, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.18 })
      : kind === "standard" ? new MeshStandardMaterial({ color, roughness: 0.32, metalness: 0 }) : paperMat(color, 0.55);
    const body = new Mesh(new ConeGeometry(FRAMING.TOKEN_R, FRAMING.TOKEN_H * 0.92, seg(28)), lacquer);
    body.position.y = FRAMING.TOKEN_H * 0.46;
    g.add(body);
    const head = new Mesh(new SphereGeometry(FRAMING.TOKEN_R * 0.55, seg(20), seg(14)), lacquer);
    head.position.y = FRAMING.TOKEN_H * 0.9;
    g.add(head);
  } else {
    const cone = new Mesh(new ConeGeometry(FRAMING.TOKEN_R, FRAMING.TOKEN_H, seg(12)), paperMat(color, 0.55));
    cone.position.y = FRAMING.TOKEN_H / 2;
    g.add(cone);
  }
  const ringM = new Mesh(new TorusGeometry(FRAMING.TOKEN_R * 1.15, 0.02, seg(8), seg(20)), paperMat(0xffffff, 0.7));
  ringM.rotation.x = PI / 2;
  ringM.position.y = 0.02;
  g.add(ringM);
  g.traverse((o) => { if (o instanceof Mesh) o.castShadow = true; });
  board!.add(g);
  const tk: Token = { group: g, tile: -1, from: 0, to: 0, t: 1, phase: Math.random() * 6.28 };
  return tk;
}

// ---------------------------------------------------------------- state sync
function tokenWorldPos(idx: number, lane: "you" | "rival"): { x: number; z: number } {
  const pos = Game.tilePos(cfg!, idx);
  const off = lane === "rival" ? 0.09 : (cfg!.rival ? -0.09 : 0);
  const px = -Math.sin(pos.angle), pz = Math.cos(pos.angle);
  return { x: pos.x + px * off, z: pos.z + pz * off };
}

const owned = new Map<string, Group>();
function applyOwnership(state: State, idx: number, who: "you" | "rival", instant: boolean): void {
  const k = `${idx}_${who}`;
  const level = (who === "you" ? state.you.props : state.rival!.props)[idx]!;
  const existing = owned.get(k);
  if (existing && existing.userData.level === level) return;
  if (existing) {
    board!.remove(existing);
    existing.traverse((o) => { if (o instanceof Mesh) o.geometry.dispose(); });
    owned.delete(k);
  }
  const pos = Game.tilePos(state.cfg, idx);
  const col = who === "you" ? palette!.token : palette!.tokenRival;
  const h = FRAMING.PROP_H + (level - 1) * FRAMING.BUILD_STEP;
  const b = detailed()
    ? paperHouse(FRAMING.PROP_W, h + 0.04, FRAMING.PROP_D, mixColor(col, 0xffffff, 0.45), col, level)
    : paperBuilding(FRAMING.PROP_W, h, FRAMING.PROP_D, col);
  b.position.set(pos.x, FRAMING.TILE_H - 0.02, pos.z);
  b.rotation.y = -pos.angle - PI / 2;
  b.userData.level = level;
  board!.add(b);
  owned.set(k, b);
  if (!instant) {
    b.scale.set(0.01, 0.01, 0.01);
    anims.push({ dur: 0.35, t: 0, update: (t) => { const e = Math.max(0.01, 1 - Math.pow(1 - t, 3)); b.scale.set(e, e, e); } });
  }
}
/** Removes every owner's building (an undo rebuilds them from the state). */
export function clearOwnership(): void {
  for (const b of owned.values()) {
    board?.remove(b);
    b.traverse((o) => { if (o instanceof Mesh) o.geometry.dispose(); });
  }
  owned.clear();
}

function moveToken(who: "you" | "rival", tileIdx: number, instant: boolean): void {
  const tk = tokens[who];
  if (!tk || tk.tile === tileIdx) return;
  tk.from = tk.tile < 0 ? tileIdx : tk.tile;
  tk.to = tileIdx;
  tk.tile = tileIdx;
  tk.t = instant || tk.from === tk.to ? 1 : 0;
  if (tk.t >= 1) placeToken(tk, who);
}
function placeToken(tk: Token, who: "you" | "rival"): void {
  const p = tokenWorldPos(tk.tile, who);
  tk.group.position.set(p.x, 0, p.z);
}

/** Pushes a state into the scene; its events drive the accents (js/render.js syncState). */
export function syncState(state: State, events: Ev[] | null, instant: boolean): void {
  lastState = state;
  if (!board || !cfg || state.cfg.id !== cfg.id) return;
  const inst = reducedMotion || instant;
  for (const k of Object.keys(state.you.props)) applyOwnership(state, +k, "you", inst);
  if (state.rival) for (const k of Object.keys(state.rival.props)) applyOwnership(state, +k, "rival", inst);
  moveToken("you", state.you.pos, inst);
  if (state.rival && tokens.rival) moveToken("rival", state.rival.pos, inst);
  for (const ev of events ?? []) {
    if (ev.type === "buy" || ev.type === "build") burst(ev.tile != null ? ev.tile : state.you.pos, 0xffe08a);
    if (ev.type === "bonus" || ev.type === "lap") burst(state.you.pos, 0xfff0a0);
    if (ev.type === "page-complete") { burst(state.you.pos, 0xffc46a, 2); camShake = reducedMotion ? 0 : 0.012; }
    if (ev.type === "win") { burst(state.you.pos, 0xffffff, 3); camShake = reducedMotion ? 0 : 0.02; }
  }
}

const confettiGeo = { big: new PlaneGeometry(0.03, 0.03), small: new PlaneGeometry(0.03, 0.02) };
function burst(tileIdx: number, color: number, power = 1): void {
  if (!look || !board || !cfg) return;
  const many = look.richParticles;
  const count = Math.round(power * look.budget.confetti);
  const pos = Game.tilePos(cfg, tileIdx);
  const tints = many && palette ? [color, color, palette.accent, 0xffffff] : [color];
  for (let i = 0; i < count; i++) {
    const mat = new MeshBasicMaterial({ color: tints[i % tints.length], transparent: true, side: DoubleSide });
    const m = new Mesh(many ? confettiGeo.small : confettiGeo.big, mat);
    m.position.set(pos.x, 0.15, pos.z);
    const a = Math.random() * PI * 2, sp = 0.4 + Math.random() * 0.6;
    board.add(m);
    particles.push({ mesh: m, mat, t: 0, dur: 0.7, vx: Math.cos(a) * sp, vy: 0.8 + Math.random() * 0.7, vz: Math.sin(a) * sp });
  }
}

/** Fast-forward: every animation in its end state. */
export function settle(): void {
  for (const who of ["you", "rival"] as const) { const tk = tokens[who]; if (tk) { tk.t = 1; placeToken(tk, who); } }
  for (const an of anims) an.update(1);
  anims = [];
  for (const p of particles) { board?.remove(p.mesh); p.mat.dispose(); }
  particles = [];
  camShake = 0;
}

// ---------------------------------------------------------------- selection and picking
export function setSelection(tileIdx: number | null): void {
  selection = tileIdx;
  if (!marker || !cfg) return;
  if (tileIdx == null) { marker.visible = false; return; }
  const pos = Game.tilePos(cfg, tileIdx);
  marker.position.set(pos.x, 0.012, pos.z);
  marker.visible = true;
}
/** White rings on the legal build targets. */
export function setHighlights(idxs: number[]): void {
  const k = idxs.join(",");
  if (k === highlightKey || !board || !cfg) return;
  highlightKey = k;
  for (const m of highlights) { board.remove(m); m.geometry.dispose(); (m.material as Material).dispose(); }
  highlights = [];
  for (const idx of idxs) {
    const pos = Game.tilePos(cfg, idx);
    const m = new Mesh(new RingGeometry(0.13, 0.17, 20), new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, side: DoubleSide }));
    m.rotation.x = -PI / 2;
    m.position.set(pos.x, 0.011, pos.z);
    board.add(m);
    highlights.push(m);
  }
}
const ray = new Raycaster();
/** The tile under a window pixel (tile tops only), or null. */
export function pick(x: number, y: number): number | null {
  if (!renderer.camera || !board || !inPlayfield(x, y)) return null;
  ray.setFromCamera(pointerToNdc(x, y), camera);
  const hits = ray.intersectObjects(tileTops, false);
  const idx = hits.length ? hits[0]!.object.userData.tileIdx : null;
  return typeof idx === "number" ? idx : null;
}

// ---------------------------------------------------------------- camera and playfield
let view = { x: 0, y: 0, w: 1, h: 1, W: 1, H: 1 };
function inPlayfield(x: number, y: number): boolean { return x >= view.x && y >= view.y && x <= view.x + view.w && y <= view.y + view.h; }
/** The playfield (window pixels) the board is framed into, within the W × H window. */
export function setPlayfield(x: number, y: number, w: number, h: number, W: number, H: number): void {
  const next = { x, y, w: Math.max(1, w), h: Math.max(1, h), W: Math.max(1, W), H: Math.max(1, H) };
  if (Object.entries(next).every(([k, v]) => Math.abs(v - (view as Record<string, number>)[k]!) < 0.5)) return;
  view = next;
  camera.aspect = view.w / view.h; // the browser build's canvas was the playfield
  camera.setViewOffset(view.w, view.h, -view.x, -view.y, view.W, view.H);
  camera.updateProjectionMatrix();
}
const lookAt = new Vector3(0, FRAMING.LOOK_Y, 0);
function placeCamera(): void {
  if (camShake > 0) {
    camera.position.set((Math.random() - 0.5) * camShake * 2, FRAMING.CAM_Y + (Math.random() - 0.5) * camShake, FRAMING.CAM_Z);
  } else camera.position.set(0, FRAMING.CAM_Y, FRAMING.CAM_Z);
  camera.lookAt(lookAt);
}
placeCamera();
/** Whether the board draws (only in a round: the menus sit on their own backgrounds). */
export function setActive(on: boolean): void { renderer.camera = on ? camera : null; }

// ---------------------------------------------------------------- the look
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  if (look && look.budget.grain !== next.budget.grain && grain) { grain.dispose(); grain = null; }
  look = next;
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: 0.85, radius: 0.22, distanceExponent: 1.4, thickness: 0.6, scale: 1.0,
    samples: next.ao === "high" ? 16 : 8, resolution: next.budget.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: next.ao === "high" ? 6 : 4, rings: 2, samples: next.ao === "high" ? 16 : 8, radiusExponent: 2 },
  };
  // High threshold: only emissive windows, the selection glow and bright highlights bloom.
  renderer.bloom = next.bloom ? { strength: 0.42, radius: 0.35, threshold: 1.0, resolution: next.budget.bloomRes } : null;
  // The browser build's grade pass: a gentle S-curve (0.18), saturation 1.1,
  // cool shadows / warm highlights, the 0.2 vignette.
  renderer.grade = next.grade ? {
    space: "display", contrast: 0.09, saturation: 1.1,
    shadows: [0.97, 0.99, 1.04], highlights: [1.03, 1.0, 0.96], split: [0.1, 0.6],
    vignette: { amount: 0.2, inner: 0.38, outer: 0.85 },
  } : null;
  renderer.antialias = next.antialias;
  if (cfg && theme) buildBoard(cfg, theme);
}
export function setReducedMotion(on: boolean): void { reducedMotion = on; if (on) camShake = 0; }
/** High-visibility district colours; rebuilds the board. */
export function setPaletteHC(on: boolean): void {
  if (paletteHC === on) return;
  paletteHC = on;
  if (cfg && theme) buildBoard(cfg, theme);
}
/** Leaves the round: nothing on the table. */
export function clear(): void { disposeBoard(); cfg = null; theme = null; lastState = null; selection = null; }

// ---------------------------------------------------------------- the frame
/** Cosmetic animation, `dt` seconds: pawn hops, the idle bob, the marker pulse, the flecks, builds growing, confetti, the shake. */
export function update(dtIn: number): void {
  let dt = Math.min(0.1, Math.max(0, dtIn));
  if (reducedMotion) dt = Math.min(dt, 0.05);
  const moving = !reducedMotion;
  if (moving) time += dt;
  for (const who of ["you", "rival"] as const) {
    const tk = tokens[who];
    if (!tk || !cfg) continue;
    if (tk.t < 1) {
      tk.t = Math.min(1, tk.t + dt / 0.45);
      const n = cfg.tiles.length;
      const steps = (((tk.to - tk.from) % n) + n) % n;
      const f = tokenWorldPos(tk.from, who), t = tokenWorldPos(tk.to, who);
      const e = tk.t < 0.5 ? 2 * tk.t * tk.t : 1 - Math.pow(-2 * tk.t + 2, 2) / 2;
      const hop = Math.sin(tk.t * PI * Math.min(steps, 4)) * 0.12;
      tk.group.position.set(f.x + (t.x - f.x) * e, Math.abs(hop), f.z + (t.z - f.z) * e);
      if (tk.t >= 1) placeToken(tk, who);
    } else if (moving && look?.animated) {
      tk.group.position.y = 0.008 * (1 + Math.sin(time * 2.1 + tk.phase));
    }
  }
  if (marker && marker.visible) {
    const pulse = moving ? Math.sin(time * 3.2) : 0;
    marker.scale.setScalar(1 + 0.05 * pulse);
    (marker.material as MeshBasicMaterial).opacity = 0.85 + 0.1 * pulse;
  }
  if (motes && moving) {
    motes.rotation.y = time * 0.025;
    motes.position.y = Math.sin(time * 0.4) * 0.04;
  }
  for (let i = anims.length - 1; i >= 0; i--) {
    const an = anims[i]!;
    an.t += dt;
    const t01 = Math.min(1, an.t / an.dur);
    an.update(t01);
    if (t01 >= 1) anims.splice(i, 1);
  }
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]!;
    p.t += dt;
    p.mesh.position.x += p.vx * dt;
    p.mesh.position.y += p.vy * dt;
    p.mesh.position.z += p.vz * dt;
    p.vy -= 2.4 * dt;
    p.mat.opacity = Math.max(0, 1 - p.t / p.dur);
    p.mesh.rotation.z += dt * 4;
    if (p.t >= p.dur) { board?.remove(p.mesh); p.mat.dispose(); particles.splice(i, 1); }
  }
  if (camShake > 0) camShake = Math.max(0, camShake - dt * 0.04);
  placeCamera();
}
