/* City Fortune — Settings → Graphics section: quality preset, render scale,
 * per-effect overrides, adaptive resolution, frame-rate readout and a cost
 * summary. Strings are localized here (the rest of the game is English);
 * the locale comes from navigator.language. Browser global: window.CFGfxUI.
 */
(function (root) {
  'use strict';

  var Gfx = root.CFGfx;

  var EN = {
    legend: 'Graphics', quality: 'Quality', auto: 'Auto (detected: {tier})',
    renderScale: 'Render scale', fromPreset: 'From preset ({tier})',
    adaptive: 'Adaptive resolution', showFps: 'Show frame rate',
    postNote: 'Post-processing is unavailable in this browser, so bloom, ambient occlusion, color grading and FXAA/SMAA are off.',
    unknownGpu: 'unknown GPU', perEffect: 'Effects',
    presets: { low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra' },
    cats: { shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Bloom', grade: 'Color grade', antialias: 'Anti-aliasing',
      reflections: 'Reflections', particles: 'Confetti', detail: 'Scene detail', background: 'Ambient motion' },
    tiers: { off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
      static: 'Still', animated: 'Animated', plain: 'Plain', detailed: 'Detailed' },
    cost: { noShadows: 'no shadows', shadows: '{n}² shadows', ao: 'ambient occlusion', aoHigh: 'full ambient occlusion',
      bloom: 'bloom', reflections: 'reflections', noAA: 'no anti-aliasing' }
  };

  var ES = {
    legend: 'Gráficos', quality: 'Calidad', auto: 'Automática (detectada: {tier})',
    renderScale: 'Escala de renderizado', fromPreset: 'Según el ajuste ({tier})',
    adaptive: 'Resolución adaptativa', showFps: 'Mostrar fotogramas por segundo',
    postNote: 'El posprocesado no está disponible en este navegador: el resplandor, la oclusión ambiental, la corrección de color y FXAA/SMAA están desactivados.',
    unknownGpu: 'GPU desconocida', perEffect: 'Efectos',
    presets: { low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
    cats: { shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Corrección de color', antialias: 'Antialiasing',
      reflections: 'Reflejos', particles: 'Confeti', detail: 'Detalle de la escena', background: 'Movimiento ambiental' },
    tiers: { off: 'No', on: 'Sí', low: 'Bajo', medium: 'Medio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
      static: 'Quieto', animated: 'Animado', plain: 'Simple', detailed: 'Detallado' },
    cost: { noShadows: 'sin sombras', shadows: 'sombras {n}²', ao: 'oclusión ambiental', aoHigh: 'oclusión ambiental completa',
      bloom: 'resplandor', reflections: 'reflejos', noAA: 'sin antialiasing' }
  };

  var DE = {
    legend: 'Grafik', quality: 'Qualität', auto: 'Automatisch (erkannt: {tier})',
    renderScale: 'Renderskalierung', fromPreset: 'Aus Voreinstellung ({tier})',
    adaptive: 'Adaptive Auflösung', showFps: 'Bildrate anzeigen',
    postNote: 'Nachbearbeitung ist in diesem Browser nicht verfügbar; Glühen, Umgebungsverdeckung, Farbkorrektur und FXAA/SMAA sind aus.',
    unknownGpu: 'unbekannte GPU', perEffect: 'Effekte',
    presets: { low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra' },
    cats: { shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Glühen', grade: 'Farbkorrektur', antialias: 'Kantenglättung',
      reflections: 'Spiegelungen', particles: 'Konfetti', detail: 'Szenendetails', background: 'Umgebungsbewegung' },
    tiers: { off: 'Aus', on: 'An', low: 'Niedrig', medium: 'Mittel', high: 'Hoch', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
      static: 'Still', animated: 'Animiert', plain: 'Einfach', detailed: 'Detailliert' },
    cost: { noShadows: 'keine Schatten', shadows: '{n}²-Schatten', ao: 'Umgebungsverdeckung', aoHigh: 'volle Umgebungsverdeckung',
      bloom: 'Glühen', reflections: 'Spiegelungen', noAA: 'keine Kantenglättung' }
  };

  var FR = {
    legend: 'Graphismes', quality: 'Qualité', auto: 'Automatique (détectée : {tier})',
    renderScale: 'Échelle de rendu', fromPreset: 'Selon le préréglage ({tier})',
    adaptive: 'Résolution adaptative', showFps: 'Afficher la fréquence d’images',
    postNote: 'Le post-traitement n’est pas disponible dans ce navigateur : le halo lumineux, l’occlusion ambiante, l’étalonnage des couleurs et FXAA/SMAA sont désactivés.',
    unknownGpu: 'GPU inconnu', perEffect: 'Effets',
    presets: { low: 'Basse', balanced: 'Équilibrée', high: 'Élevée', ultra: 'Ultra' },
    cats: { shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Halo lumineux', grade: 'Étalonnage des couleurs', antialias: 'Anticrénelage',
      reflections: 'Reflets', particles: 'Confettis', detail: 'Détail de la scène', background: 'Mouvement ambiant' },
    tiers: { off: 'Désactivé', on: 'Activé', low: 'Bas', medium: 'Moyen', high: 'Élevé', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
      static: 'Immobile', animated: 'Animé', plain: 'Simple', detailed: 'Détaillé' },
    cost: { noShadows: 'sans ombres', shadows: 'ombres {n}²', ao: 'occlusion ambiante', aoHigh: 'occlusion ambiante complète',
      bloom: 'halo lumineux', reflections: 'reflets', noAA: 'sans anticrénelage' }
  };

  var PT = {
    legend: 'Gráficos', quality: 'Qualidade', auto: 'Automática (detectada: {tier})',
    renderScale: 'Escala de renderização', fromPreset: 'Da predefinição ({tier})',
    adaptive: 'Resolução adaptativa', showFps: 'Mostrar taxa de quadros',
    postNote: 'O pós-processamento não está disponível neste navegador; brilho, oclusão ambiente, correção de cor e FXAA/SMAA estão desligados.',
    unknownGpu: 'GPU desconhecida', perEffect: 'Efeitos',
    presets: { low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
    cats: { shadows: 'Sombras', ao: 'Oclusão ambiente', bloom: 'Brilho', grade: 'Correção de cor', antialias: 'Antisserrilhamento',
      reflections: 'Reflexos', particles: 'Confete', detail: 'Detalhes da cena', background: 'Movimento ambiente' },
    tiers: { off: 'Desligado', on: 'Ligado', low: 'Baixo', medium: 'Médio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
      static: 'Parado', animated: 'Animado', plain: 'Simples', detailed: 'Detalhado' },
    cost: { noShadows: 'sem sombras', shadows: 'sombras {n}²', ao: 'oclusão ambiente', aoHigh: 'oclusão ambiente completa',
      bloom: 'brilho', reflections: 'reflexos', noAA: 'sem antisserrilhamento' }
  };

  var IT = {
    legend: 'Grafica', quality: 'Qualità', auto: 'Automatica (rilevata: {tier})',
    renderScale: 'Scala di rendering', fromPreset: 'Dal preset ({tier})',
    adaptive: 'Risoluzione adattiva', showFps: 'Mostra frequenza fotogrammi',
    postNote: 'La post-elaborazione non è disponibile in questo browser: bagliore, occlusione ambientale, correzione colore e FXAA/SMAA sono disattivati.',
    unknownGpu: 'GPU sconosciuta', perEffect: 'Effetti',
    presets: { low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra' },
    cats: { shadows: 'Ombre', ao: 'Occlusione ambientale', bloom: 'Bagliore', grade: 'Correzione colore', antialias: 'Antialiasing',
      reflections: 'Riflessi', particles: 'Coriandoli', detail: 'Dettaglio scena', background: 'Movimento ambientale' },
    tiers: { off: 'No', on: 'Sì', low: 'Basso', medium: 'Medio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
      static: 'Fermo', animated: 'Animato', plain: 'Semplice', detailed: 'Dettagliato' },
    cost: { noShadows: 'senza ombre', shadows: 'ombre {n}²', ao: 'occlusione ambientale', aoHigh: 'occlusione ambientale completa',
      bloom: 'bagliore', reflections: 'riflessi', noAA: 'senza antialiasing' }
  };

  function variant(base, patch) {
    var out = JSON.parse(JSON.stringify(base));
    Object.keys(patch).forEach(function (k) {
      if (typeof patch[k] === 'object') Object.assign(out[k], patch[k]);
      else out[k] = patch[k];
    });
    return out;
  }

  var STRINGS = {
    'en-US': EN,
    'en-GB': variant(EN, { postNote: EN.postNote.replace('color grading', 'colour grading'), cats: { grade: 'Colour grade' } }),
    'es-419': ES,
    'es-ES': variant(ES, { cats: { antialias: 'Suavizado de bordes' }, cost: { noAA: 'sin suavizado de bordes' } }),
    'de-DE': DE,
    'fr-FR': FR,
    'fr-CA': variant(FR, { tiers: { off: 'Désactivée', on: 'Activée' } }),
    'pt-BR': PT,
    'it-IT': IT
  };

  function pickLocale(langs) {
    var list = (langs || []).filter(Boolean);
    for (var i = 0; i < list.length; i++) {
      var l = String(list[i]);
      if (STRINGS[l]) return l;
      var lang = l.split('-')[0].toLowerCase(), region = (l.split('-')[1] || '').toUpperCase();
      if (lang === 'en') return /^(GB|IE|AU|NZ|ZA|IN)$/.test(region) ? 'en-GB' : 'en-US';
      if (lang === 'es') return region === 'ES' || !region ? 'es-ES' : 'es-419';
      if (lang === 'fr') return region === 'CA' ? 'fr-CA' : 'fr-FR';
      if (lang === 'de') return 'de-DE';
      if (lang === 'pt') return 'pt-BR';
      if (lang === 'it') return 'it-IT';
    }
    return 'en-US';
  }

  function $(id) { return document.getElementById(id); }

  var ctl = null; // { getSaved, setSaved, info }
  var t = EN, locale = 'en-US';

  function opt(value, text) {
    var o = document.createElement('option');
    o.value = value; o.textContent = text;
    return o;
  }

  function build() {
    var langs = (root.navigator && (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language])) || [];
    locale = pickLocale(langs);
    t = STRINGS[locale];
    var box = $('gfx-settings');
    box.setAttribute('lang', locale);
    box.querySelectorAll('[data-gfx-i18n]').forEach(function (el) { el.textContent = t[el.getAttribute('data-gfx-i18n')]; });
    var legend = $('gfx-legend');
    if (legend) { legend.textContent = t.legend; legend.setAttribute('lang', locale); }

    var tier = $('set-tier');
    tier.innerHTML = '';
    tier.appendChild(opt('auto', t.auto));
    Gfx.PRESETS.forEach(function (p) { tier.appendChild(opt(p, t.presets[p])); });

    var cats = $('gfx-categories');
    cats.innerHTML = '';
    Object.keys(Gfx.CATEGORIES).forEach(function (cat) {
      var label = document.createElement('label');
      label.className = 'gfx-cat';
      var span = document.createElement('span');
      span.textContent = t.cats[cat];
      var sel = document.createElement('select');
      sel.id = 'set-gfx-' + cat;
      sel.setAttribute('data-gfx-cat', cat);
      sel.appendChild(opt('preset', t.fromPreset));
      Gfx.CATEGORIES[cat].forEach(function (v) { sel.appendChild(opt(v, t.tiers[v])); });
      sel.addEventListener('change', function () {
        var s = ctl.getSaved();
        if (sel.value === 'preset') delete s[cat]; else s[cat] = sel.value;
        ctl.setSaved(s);
        refresh();
      });
      label.appendChild(span);
      label.appendChild(sel);
      cats.appendChild(label);
    });
  }

  function bind() {
    $('set-tier').addEventListener('change', function () {
      // choosing a preset clears the per-effect overrides
      ctl.setSaved(Gfx.choosePreset(ctl.getSaved(), $('set-tier').value));
      refresh();
    });
    var scale = $('set-gfx-scale');
    scale.addEventListener('input', function () {
      $('set-gfx-scale-val').textContent = scale.value + '%';
    });
    scale.addEventListener('change', function () {
      var s = ctl.getSaved();
      s.render_scale = parseInt(scale.value, 10);
      ctl.setSaved(s);
      refresh();
    });
    $('set-gfx-adaptive').addEventListener('change', function () {
      var s = ctl.getSaved();
      s.adaptive = $('set-gfx-adaptive').checked;
      ctl.setSaved(s);
      refresh();
    });
    $('set-gfx-fps').addEventListener('change', function () {
      var s = ctl.getSaved();
      s.show_fps = $('set-gfx-fps').checked;
      ctl.setSaved(s);
      refresh();
    });
  }

  /** Sync every control with the saved settings and the renderer's state. */
  function refresh() {
    if (!ctl) return;
    var s = ctl.getSaved();
    var info = ctl.info();
    var detected = info ? info.detected : 'balanced';
    var r = info && info.resolved ? info.resolved : Gfx.resolve(s, detected);
    var tier = $('set-tier');
    tier.options[0].textContent = t.auto.replace('{tier}', t.presets[detected] || detected);
    tier.value = Gfx.PRESETS.indexOf(s.preset) >= 0 ? s.preset : 'auto';
    Object.keys(Gfx.CATEGORIES).forEach(function (cat) {
      var sel = $('set-gfx-' + cat);
      if (!sel) return;
      sel.options[0].textContent = t.fromPreset.replace('{tier}', t.tiers[Gfx.presetTier(r.preset, cat)]);
      sel.value = Gfx.CATEGORIES[cat].indexOf(s[cat]) >= 0 ? s[cat] : 'preset';
    });
    var pct = Math.round(r.scale * 100);
    $('set-gfx-scale').value = pct;
    $('set-gfx-scale-val').textContent = pct + '%';
    $('set-gfx-adaptive').checked = r.adaptive;
    $('set-gfx-fps').checked = r.showFps;
    var parts = [info && info.gpu ? info.gpu : t.unknownGpu, Gfx.describe(r, info ? info.pixels : null, t.cost)];
    $('gfx-summary').textContent = parts.join(' · ');
    $('gfx-post-note').hidden = !(info && info.postFailed);
    document.body.setAttribute('data-gfx-preset', r.preset);
    document.body.setAttribute('data-gfx-auto', r.auto ? 'true' : 'false');
  }

  /**
   * opts.getSaved(): a fresh copy of the saved graphics settings
   * opts.setSaved(saved): persist + apply live
   * opts.info(): Render.graphicsInfo() or null without WebGL
   */
  function setup(opts) {
    ctl = opts;
    build();
    bind();
    refresh();
  }

  root.CFGfxUI = { setup: setup, refresh: refresh, pickLocale: pickLocale, STRINGS: STRINGS };
})(typeof self !== 'undefined' ? self : this);
