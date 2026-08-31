/* City Fortune — WebAudio: authored one-shot samples (sfx/<name>.opus) per
 * logical event where available, with procedural synthesis (original short
 * transients, dice rattle, coin chimes, quiet city ambience, adaptive music
 * pad) as fallback while samples load or when they are missing.
 * Browser global: CFAudio.
 */
(function (root) {
  'use strict';

  var ctx = null, master = null;
  var buses = {}; // music, effects, ambience, voice
  var settings = { music: 0.6, effects: 0.9, ambience: 0.5, voice: 0.8, muted: false };
  var captions = false;
  var captionFn = null;
  var started = false;
  var musicTimer = null, ambienceNodes = null;
  var avRng = null; // seeded variants for replay consistency

  function ensureCtx() {
    if (ctx) return true;
    var AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.connect(ctx.destination);
    ['music', 'effects', 'ambience', 'voice'].forEach(function (name) {
      var g = ctx.createGain();
      g.gain.value = settings.muted ? 0 : (settings[name] != null ? settings[name] : 0.8);
      g.connect(master);
      buses[name] = g;
    });
    return true;
  }

  function applySettings(s) {
    Object.assign(settings, s || {});
    if (!ctx) return;
    Object.keys(buses).forEach(function (name) {
      var v = settings.muted ? 0 : (settings[name] != null ? settings[name] : 0.8);
      buses[name].gain.setTargetAtTime(v, ctx.currentTime, 0.05);
    });
  }

  function caption(text) {
    if (captions && captionFn && text) captionFn(text);
  }

  // ---------- primitive builders ----------
  function blip(freq, dur, type, gain, bus, when, sweepTo) {
    var t = (when || ctx.currentTime);
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (sweepTo) o.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(buses[bus || 'effects']);
    o.start(t); o.stop(t + dur + 0.05);
  }

  function noise(dur, gain, cutoff, when, type) { // filtered noise burst
    var t = when || ctx.currentTime;
    var len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    var src = ctx.createBufferSource(); src.buffer = buf;
    var f = ctx.createBiquadFilter(); f.type = type || 'lowpass'; f.frequency.value = cutoff;
    var g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(buses.effects);
    src.start(t);
  }

  function coin(when, base) { // cash-register chime
    blip(base || 1320, 0.09, 'square', 0.05, 'effects', when);
    blip((base || 1320) * 1.5, 0.14, 'square', 0.045, 'effects', (when || ctx.currentTime) + 0.05);
  }

  function variant(base) { // seeded pitch variant (±6%) when replay consistency matters
    var r = avRng ? avRng.next() : Math.random();
    return base * (0.94 + r * 0.12);
  }

  // ---------- event map ----------
  var SFX = {
    'ui':        function () { blip(660, 0.06, 'triangle', 0.12); },
    'select':    function () { blip(variant(520), 0.09, 'sine', 0.16); caption('select'); },
    'deselect':  function () { blip(390, 0.07, 'sine', 0.1); },
    'invalid':   function () { blip(160, 0.16, 'square', 0.07); blip(150, 0.14, 'square', 0.05, 'effects', ctx.currentTime + 0.05); caption('not allowed'); },
    'dice':      function () { // rattle: three short knocks
      for (var i = 0; i < 3; i++) noise(0.05, 0.25, 1800, ctx.currentTime + i * 0.07, 'bandpass');
      caption('dice roll');
    },
    'hop':       function () { blip(variant(440), 0.05, 'sine', 0.08); },
    'land':      function () { noise(0.06, 0.3, 900); blip(variant(240), 0.07, 'sine', 0.1); },
    'coin':      function () { coin(); caption('coins'); },
    'salary':    function () { coin(ctx.currentTime, 1180); coin(ctx.currentTime + 0.12, 1560); caption('salary'); },
    'buy':       function () { noise(0.05, 0.35, 1200); blip(523, 0.16, 'triangle', 0.14, 'effects', ctx.currentTime + 0.04); blip(784, 0.2, 'triangle', 0.12, 'effects', ctx.currentTime + 0.12); caption('property bought'); },
    'skip':      function () { blip(340, 0.08, 'sine', 0.09); caption('passed'); },
    'build':     function () { noise(0.07, 0.4, 700); noise(0.07, 0.35, 900, ctx.currentTime + 0.11); blip(660, 0.18, 'triangle', 0.1, 'effects', ctx.currentTime + 0.2); caption('building up'); },
    'rent-get':  function () { coin(ctx.currentTime, 990); blip(1480, 0.2, 'sine', 0.08, 'effects', ctx.currentTime + 0.1); caption('rent collected'); },
    'rent-pay':  function () { blip(300, 0.18, 'sine', 0.12, 'effects', ctx.currentTime, 220); caption('rent paid'); },
    'toll':      function () { blip(280, 0.2, 'square', 0.06, 'effects', ctx.currentTime, 200); caption('toll'); },
    'bonus':     function () { coin(); blip(1760, 0.16, 'sine', 0.07, 'effects', ctx.currentTime + 0.09); caption('bonus'); },
    'card':      function () { noise(0.09, 0.2, 2600, ctx.currentTime, 'highpass'); blip(variant(880), 0.1, 'sine', 0.08, 'effects', ctx.currentTime + 0.05); caption('chance card'); },
    'sticker':   function () { blip(1046, 0.1, 'sine', 0.1); blip(1568, 0.16, 'sine', 0.08, 'effects', ctx.currentTime + 0.07); caption('sticker'); },
    'page':      function () {
      [0, 4, 7].forEach(function (st, i) {
        blip(variant(620 * Math.pow(2, st / 12)), 0.24, 'sine', 0.13, 'effects', ctx.currentTime + i * 0.06);
      });
      caption('album page complete');
    },
    'rival':     function () { blip(variant(370), 0.08, 'triangle', 0.07); },
    'win':       function () {
      [0, 4, 7, 12].forEach(function (st, i) {
        blip(523 * Math.pow(2, st / 12), 0.5, 'triangle', 0.14, 'effects', ctx.currentTime + i * 0.12);
      });
      caption('album complete');
    },
    'lose':      function () { blip(300, 0.5, 'sine', 0.16, 'effects', ctx.currentTime, 180); blip(200, 0.6, 'sine', 0.1, 'effects', ctx.currentTime + 0.15, 120); caption('round lost'); },
    'undo':      function () { blip(500, 0.08, 'triangle', 0.1, 'effects', ctx.currentTime, 380); caption('undo'); },
    'hint':      function () { blip(990, 0.12, 'sine', 0.1); blip(1320, 0.14, 'sine', 0.07, 'effects', ctx.currentTime + 0.07); caption('hint'); },
    'star':      function () { blip(1568, 0.18, 'sine', 0.1); }
  };

  function play(name) {
    if (!started || !ctx || settings.muted) return;
    if (ctx.state === 'suspended') ctx.resume();
    var sample = sampleFor(name);
    if (sample) { playSample(sample); return; } // decoded sample wins
    var fn = SFX[name];
    if (fn) fn(); // synthesized fallback while loading or on failure
  }

  // ---------- authored samples: lazy fetch/decode/cache of sfx/<name>.opus ----------
  // After the user-gesture unlock (start), sfx/manifest.json maps logical
  // events to sample basenames. Each clip is fetched and decoded once, then
  // played through the effects bus (current volume/mute settings apply).
  var sampleMap = null;   // event name -> sample basename (null until manifest loads)
  var sampleState = {};   // basename -> 'loading' | 'ready' | 'failed'
  var sampleBuffers = {}; // basename -> AudioBuffer

  function loadManifest() {
    fetch('sfx/manifest.json').then(function (res) {
      if (!res.ok) throw new Error('manifest ' + res.status);
      return res.json();
    }).then(function (list) {
      var map = {};
      (Array.isArray(list) ? list : []).forEach(function (entry) {
        if (entry && typeof entry.name === 'string' && typeof entry.event === 'string' &&
            SFX[entry.event] && !map[entry.event]) {
          map[entry.event] = entry.name;
        }
      });
      sampleMap = map;
    }).catch(function () { sampleMap = {}; });
  }

  function requestSample(base) {
    if (sampleState[base]) return;
    sampleState[base] = 'loading';
    fetch('sfx/' + base + '.opus').then(function (res) {
      if (!res.ok) throw new Error('sample ' + res.status);
      return res.arrayBuffer();
    }).then(function (data) {
      return ctx.decodeAudioData(data);
    }).then(function (buf) {
      sampleBuffers[base] = buf;
      sampleState[base] = 'ready';
    }).catch(function () { sampleState[base] = 'failed'; });
  }

  function sampleFor(name) {
    if (!sampleMap || !ctx) return null;
    var base = sampleMap[name];
    if (!base) return null;
    if (sampleState[base] === 'ready') return sampleBuffers[base];
    requestSample(base);
    return null;
  }

  function playSample(buf) {
    var src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(buses.effects);
    src.start();
  }

  // ---------- ambience: soft city hum (filtered noise, very quiet) ----------
  function startAmbience() {
    if (!ctx || ambienceNodes) return;
    var len = ctx.sampleRate * 2;
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    var last = 0;
    for (var i = 0; i < len; i++) { // brown-ish noise
      var w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
    var src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    var f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 300;
    var g = ctx.createGain(); g.gain.value = 0.32;
    src.connect(f); f.connect(g); g.connect(buses.ambience);
    src.start();
    ambienceNodes = { src: src, gain: g };
  }

  // ---------- music: slow generative pad, seeded chord walk ----------
  var CHORDS = [
    [261.63, 329.63, 392.0],  // C  E  G
    [220.0, 261.63, 329.63],  // A  C  E
    [174.61, 220.0, 261.63],  // F  A  C
    [196.0, 246.94, 293.66]   // G  B  D
  ];
  var chordIdx = 0;
  function schedulePad() {
    if (!ctx || settings.muted) return;
    var t = ctx.currentTime + 0.1;
    var chord = CHORDS[chordIdx % CHORDS.length];
    chordIdx++;
    chord.forEach(function (freq, i) {
      var o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
      o.type = i === 0 ? 'triangle' : 'sine';
      o.frequency.value = freq * 0.5;
      f.type = 'lowpass'; f.frequency.value = 700;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.05, t + 1.8);
      g.gain.linearRampToValueAtTime(0.0001, t + 6.4);
      o.connect(f); f.connect(g); g.connect(buses.music);
      o.start(t); o.stop(t + 6.6);
    });
  }
  function startMusic() {
    if (musicTimer || !ctx) return;
    schedulePad();
    musicTimer = setInterval(schedulePad, 5200);
  }

  function start(opts) {
    if (!ensureCtx()) return false;
    if (ctx.state === 'suspended') ctx.resume();
    started = true;
    startAmbience();
    startMusic();
    loadManifest();
    return true;
  }

  function suspend() { if (ctx && ctx.state === 'running') ctx.suspend(); }
  function resume() { if (ctx && started && ctx.state === 'suspended') ctx.resume(); }

  function setAvRng(rng) { avRng = rng; }
  function setCaptions(on, fn) { captions = !!on; captionFn = fn || captionFn; }

  root.CFAudio = {
    start: start, play: play, applySettings: applySettings,
    suspend: suspend, resume: resume, setAvRng: setAvRng, setCaptions: setCaptions,
    isStarted: function () { return started; }
  };
})(typeof self !== 'undefined' ? self : this);
