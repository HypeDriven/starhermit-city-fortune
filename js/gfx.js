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

  // Each preset is a row of tiers plus a device-pixel-ratio cap.
  var TABLE = {
    low:      { cap: 1,   shadows: 'off',    ao: 'off',  bloom: 'off', grade: 'off', antialias: 'msaa', reflections: 'off', particles: 'low',  detail: 'plain',    background: 'static' },
    balanced: { cap: 1.5, shadows: 'low',    ao: 'off',  bloom: 'on',  grade: 'on',  antialias: 'fxaa', reflections: 'on',  particles: 'high', detail: 'detailed', background: 'animated' },
    high:     { cap: 2,   shadows: 'medium', ao: 'on',   bloom: 'on',  grade: 'on',  antialias: 'smaa', reflections: 'on',  particles: 'high', detail: 'detailed', background: 'animated' },
    ultra:    { cap: 2,   shadows: 'high',   ao: 'high', bloom: 'on',  grade: 'on',  antialias: 'msaa', reflections: 'on',  particles: 'high', detail: 'detailed', background: 'animated' }
  };

  var SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };
  var PARTICLES = { low: 0.4, high: 1 };

  /** Best preset for this GPU, from the unmasked renderer string. */
  function detectPreset(gpu, opts) {
    var g = String(gpu || '').toLowerCase();
    var p;
    if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(g)) p = 'low';
    else if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|amd radeon(?!.*graphics)|apple m\d/.test(g)) p = 'high';
    else p = 'balanced';
    // Phones and tablets: Auto never goes above Balanced.
    if (opts && opts.mobile && p === 'high') p = 'balanced';
    return p;
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
  function resolve(saved, detected) {
    var s = saved || {};
    var auto = PRESETS.indexOf(s.preset) < 0;
    var preset = auto ? (PRESETS.indexOf(detected) >= 0 ? detected : 'balanced') : s.preset;
    var row = TABLE[preset];
    var out = { preset: preset, auto: auto, cap: row.cap, scale: scaleOf(s) };
    Object.keys(CATEGORIES).forEach(function (cat) {
      out[cat] = CATEGORIES[cat].indexOf(s[cat]) >= 0 ? s[cat] : row[cat];
    });
    out.adaptive = s.adaptive !== false;
    out.showFps = !!s.show_fps;
    out.shadowMap = SHADOW_MAP[out.shadows];
    out.particleScale = PARTICLES[out.particles];
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
    detectPreset: detectPreset, resolve: resolve, choosePreset: choosePreset,
    presetTier: presetTier, describe: describe
  };
});
