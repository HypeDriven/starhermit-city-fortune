/* City Fortune — graphics quality model: presets, per-category overrides, GPU
 * detection and a cost summary. Pure (no three.js), so the settings panel,
 * the renderer and the tests agree on what a setting means.
 * UMD: window.CFGfx in the browser, module.exports under Node.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CFGfx = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PRESETS = ['low', 'balanced', 'high', 'ultra'];

  // Category -> allowed tiers, cheapest first.
  var CATEGORIES = {
    shadows: ['off', 'low', 'medium', 'high'],
    ao: ['off', 'on', 'high'],
    bloom: ['off', 'on'],
    grade: ['off', 'on'],
    antialias: ['off', 'fxaa', 'smaa', 'msaa'],
    reflections: ['off', 'on'],
    particles: ['low', 'high'],
    detail: ['plain', 'detailed'],
    background: ['static', 'animated']
  };

  // Each preset is a row of tiers plus a device-pixel-ratio cap and a preset render scale (`rs`).
  var TABLE = {
    low:      { cap: 1,   shadows: 'off',    ao: 'off',  bloom: 'off', grade: 'off', antialias: 'msaa', reflections: 'off', particles: 'low',  detail: 'plain',    background: 'static' },
    balanced: { cap: 1.5, rs: 0.9, shadows: 'low',    ao: 'off',  bloom: 'on',  grade: 'on',  antialias: 'fxaa', reflections: 'on',  particles: 'high', detail: 'detailed', background: 'animated' },
    high:     { cap: 2,   shadows: 'medium', ao: 'on',   bloom: 'on',  grade: 'on',  antialias: 'smaa', reflections: 'on',  particles: 'high', detail: 'detailed', background: 'animated' },
    ultra:    { cap: 2,   shadows: 'high',   ao: 'high', bloom: 'on',  grade: 'on',  antialias: 'msaa', reflections: 'on',  particles: 'high', detail: 'detailed', background: 'animated' }
  };

  var SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };
  var PARTICLES = { low: 0.4, high: 1 };

  // Auto picks the preset from the StarHermit hardware level (0 = Galaxy S20 / Intel UHD or weaker, 20 = RTX
  // 5090; js/gpu-level.js → window.StarHermitGpu): Low from 0, Balanced from 4, High from 10, Ultra from 17.
  // Phones, tablets and ≤ 4 GB machines are capped at level 9 (Balanced); software renderers are level 0.
  var PRESET_LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };
  function gpuApi() { return (typeof self !== 'undefined' ? self : globalThis).StarHermitGpu; }

  /** Hardware level (0–20) for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
  function detectLevel(gpu, system) {
    var G = gpuApi();
    if (!G) return PRESET_LEVELS.balanced;
    return G.detectLevel(Object.assign({}, system || {}, { gpu: String(gpu || '') }));
  }

  /** The preset Auto starts from for a hardware level. */
  function presetForLevel(level) {
    var G = gpuApi();
    if (G) return G.presetForLevel(level, PRESET_LEVELS);
    return level >= 17 ? 'ultra' : level >= 10 ? 'high' : level >= 4 ? 'balanced' : 'low';
  }

  /** Best preset for a GPU (the hardware level already caps phones/tablets at Balanced). */
  function detectPreset(gpu, system) {
    return presetForLevel(detectLevel(gpu, system));
  }

  /** Scale a count tuned at the preset's floor level up for faster GPUs (≤ 4×, never below the floor). */
  function scaleCount(n, preset, level) {
    var G = gpuApi();
    var floor = PRESET_LEVELS[preset] || 0;
    return Math.round(G ? G.scaleBudget(n, Math.max(Number(level) || 0, floor), floor) : n);
  }

  /*
   * Per-preset asset and effect budget. Each preset is tuned to hold 60 FPS on the weakest GPU Auto gives
   * it (Low → level 0, Balanced → 4, High → 10, Ultra → 17; measured with tests/gfx-bench.mjs).
   *   material     paper/card: 'lambert' | 'standard'; pawns: lacquer 'physical' (clear coat) on High+;
   *   grain        paper-grain texture size in px (detailed scene only);
   *   segments     round-geometry LOD: multiplies the radial segments of table, ground, rims, rings, pawns,
   *                trees and markers (min 4);
   *   decor        pop-up props (tents, houses, trees) inside the ring — each is 2–4 draw calls;
   *   motes        drifting paper flecks at the floor level (Ambient motion: animated);
   *   confetti     confetti pieces per landing burst at the floor level (Confetti: low caps it at 6);
   *   bloomRes / aoRes  bloom and GTAO resolution as a fraction of the frame.
   */
  var BUDGETS = {
    low:      { material: 'lambert',  grain: 64,  segments: 0.5,  decor: 4,  motes: 24, confetti: 6,  bloomRes: 0.5, aoRes: 0.5 },
    balanced: { material: 'standard', grain: 128, segments: 0.75, decor: 12, motes: 40, confetti: 10, bloomRes: 0.5, aoRes: 0.5 },
    high:     { material: 'physical', grain: 256, segments: 1,    decor: 16, motes: 70, confetti: 14, bloomRes: 0.5, aoRes: 0.5 },
    ultra:    { material: 'physical', grain: 512, segments: 1.5,  decor: 22, motes: 120, confetti: 20, bloomRes: 1, aoRes: 1 }
  };
  var CONFETTI_CAP = { low: 6, high: 60 };
  var MOTE_CAP = 300;

  /** A preset's concrete budget for a hardware level and Confetti (particles) tier. */
  function budgetFor(preset, level, particles) {
    var b = Object.assign({}, BUDGETS[preset] || BUDGETS.balanced);
    b.motes = Math.min(MOTE_CAP, scaleCount(b.motes, preset, level));
    b.confetti = Math.min(CONFETTI_CAP[particles] || CONFETTI_CAP.high, scaleCount(b.confetti, preset, level));
    return b;
  }

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  /** Render scale as a fraction (0.5..2) from a saved percentage (50..200). */
  function scaleOf(saved) {
    var pct = Number(saved && saved.render_scale);
    if (!isFinite(pct) || pct <= 0) pct = 100;
    return clamp(pct, 50, 200) / 100;
  }

  /**
   * Resolve saved settings into concrete tiers.
   * saved: { preset: 'auto'|preset, render_scale (50..200), adaptive, show_fps,
   *          <category>: tier (absent = from preset) }.
   */
  function resolve(saved, detected, level) {
    var s = saved || {};
    var auto = PRESETS.indexOf(s.preset) < 0;
    var preset = auto ? (PRESETS.indexOf(detected) >= 0 ? detected : 'balanced') : s.preset;
    var row = TABLE[preset];
    var out = { preset: preset, auto: auto, cap: row.cap, scale: scaleOf(s), presetScale: row.rs || 1 };
    Object.keys(CATEGORIES).forEach(function (cat) {
      out[cat] = CATEGORIES[cat].indexOf(s[cat]) >= 0 ? s[cat] : row[cat];
    });
    out.adaptive = s.adaptive !== false;
    out.showFps = !!s.show_fps;
    out.shadowMap = SHADOW_MAP[out.shadows];
    out.particleScale = PARTICLES[out.particles];
    out.level = level == null ? PRESET_LEVELS[preset] : level;
    out.budget = budgetFor(preset, out.level, out.particles);
    // Post-processing runs only when something needs it; otherwise the canvas MSAA is used.
    out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' ||
      out.antialias === 'fxaa' || out.antialias === 'smaa';
    return out;
  }

  /** New saved settings after choosing a preset: overrides are cleared. */
  function choosePreset(saved, preset) {
    var s = saved || {};
    var out = { preset: PRESETS.indexOf(preset) >= 0 ? preset : 'auto' };
    if (s.render_scale != null) out.render_scale = s.render_scale;
    if (s.adaptive != null) out.adaptive = s.adaptive;
    if (s.show_fps != null) out.show_fps = s.show_fps;
    return out;
  }

  /** The preset's own tier for a category (for "From preset (…)" labels). */
  function presetTier(preset, cat) {
    return TABLE[preset] ? TABLE[preset][cat] : undefined;
  }

  var EN = {
    noShadows: 'no shadows', shadows: '{n}² shadows', ao: 'ambient occlusion', aoHigh: 'full ambient occlusion',
    bloom: 'bloom', reflections: 'reflections', noAA: 'no anti-aliasing'
  };

  /** Cost summary, e.g. "2048² shadows · ambient occlusion · bloom · SMAA · 1280×800 px". */
  function describe(r, pixels, labels) {
    var t = labels || EN;
    var parts = [
      r.shadows === 'off' ? t.noShadows : t.shadows.replace('{n}', SHADOW_MAP[r.shadows]),
      r.ao === 'off' ? null : r.ao === 'high' ? t.aoHigh : t.ao,
      r.bloom === 'on' ? t.bloom : null,
      r.reflections === 'on' ? t.reflections : null,
      r.antialias === 'off' ? t.noAA : r.antialias.toUpperCase(),
      pixels ? pixels[0] + '×' + pixels[1] + ' px' : null
    ];
    return parts.filter(Boolean).join(' · ');
  }

  return {
    PRESETS: PRESETS, CATEGORIES: CATEGORIES, SHADOW_MAP: SHADOW_MAP,
    PRESET_LEVELS: PRESET_LEVELS, BUDGETS: BUDGETS, CONFETTI_CAP: CONFETTI_CAP,
    detectLevel: detectLevel, presetForLevel: presetForLevel, budgetFor: budgetFor,
    detectPreset: detectPreset, resolve: resolve, choosePreset: choosePreset,
    presetTier: presetTier, describe: describe
  };
});
