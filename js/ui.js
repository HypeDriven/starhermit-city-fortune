/* City Fortune — DOM shell: screens, HUD, input, accessibility, persistence.
 * Owns the session clock; rules state changes only via CFGame session commands.
 * Browser global: CFUI (classic script; THREE is provided by js/main.js module).
 */
(function (root) {
  'use strict';

  var Game = root.CFGame, Rules = Game.rules, Content = Game.content,
      Store = Game.store, Audio = root.CFAudio, Render = root.CFRender, GfxUI = root.CFGfxUI,
      RNG = root.CFRNG, Platform = root.CFPlatform;

  var $ = function (id) { return document.getElementById(id); };

  // ---------- localization (js/i18n.js: window.CFI18N) ----------
  // English source strings are the keys. T() translates now; N() only marks a
  // string for translation at display time.
  function T(key, vars) {
    if (root.CFI18N) return root.CFI18N.T(key, vars);
    return String(key).replace(/\{(\w+)\}/g, function (m, k) { return vars && k in vars ? String(vars[k]) : m; });
  }
  function N(key) { return key; }
  function curLang() { return (root.CFI18N && root.CFI18N.lang) || navigator.language || 'en-US'; }

  // Display names for content data (which stays English).
  function districtName(d) { return Content.DISTRICTS[d] ? T(Content.DISTRICTS[d].label) : d; }
  function tileLabel(t, i) {
    if (!t) return '';
    if (t.t === 'prop' && t.d) {
      var m = /(\d+)$/.exec(t.label || '');
      return T('{district} {n}', { district: districtName(t.d), n: m ? m[1] : '' });
    }
    if (t.label) return T(t.label);
    return T('Tile {n}', { n: i });
  }
  function pageName(pg) {
    if (!pg) return '';
    if (pg.type === 'district') return T('{district} set', { district: districtName(pg.d) });
    return T(pg.name);
  }
  function cfgName(cfg) {
    if (!cfg) return '';
    if (cfg.kind === 'daily' && cfg.date) return T('Daily {date}', { date: cfg.date });
    return T(cfg.name);
  }

  // ---------- app state ----------
  var doc = null;            // persisted save document
  var sess = null;           // active CFGame session
  var lesson = null;         // active tutorial lesson (Learn mode)
  var lessonStep = 0;
  var presenting = false;    // input locked during event resolution
  var skipping = false;      // fast-forward the current event presentation
  var selectedTile = null;
  var focusTargets = [];     // keyboard-navigable tile indexes
  var focusIdx = 0;
  var rafId = 0, hidden = false;
  var serverOffsetMs = 0;    // serverTime - clientTime
  var clock = { accumMs: 0, sinceMs: 0, running: false };
  var currentScreen = 'loading';
  var appliedPaletteHC = null; // last high-visibility palette pushed to the board
  var overlayStack = [];   // [{ id, prev }] — innermost dialog last

  // ---------- time ----------
  function nowMs() { return Date.now(); }
  function serverNowMs() { return nowMs() + serverOffsetMs; }
  function elapsedMs() {
    return clock.accumMs + (clock.running ? nowMs() - clock.sinceMs : 0);
  }
  function clockStart() { if (!clock.running) { clock.running = true; clock.sinceMs = nowMs(); } }
  function clockStop() { if (clock.running) { clock.accumMs += nowMs() - clock.sinceMs; clock.running = false; } }
  function clockReset() { clock.accumMs = 0; clock.sinceMs = nowMs(); clock.running = false; }

  // ---------- helpers ----------
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmtCoins(n) { return T('{n} coins', { n: n }); }
  function fmtTime(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function announce(text) {
    var el = $('live-region');
    if (el) { el.textContent = ''; setTimeout(function () { el.textContent = text; }, 30); }
  }

  function haptic() {
    if (doc.settings.haptics && navigator.vibrate) { try { navigator.vibrate(12); } catch (e) {} }
  }

  // Every save mirrors to the StarHermit cloud slot and settings KV when signed in,
  // but only once the start-up cloud restore has landed (cloudReady): booting on
  // the 3 s timeout must not push the stale local doc over a newer cloud one.
  var cloudReady = false;
  function saveDoc() {
    var wrapped = Store.save(doc);
    if (Platform.hosted && cloudReady) {
      Platform.saveCloud(wrapped);
      Platform.mirrorSettings(doc.settings);
    }
  }

  var PT = root.PlatformStrings.platformStrings(curLang()); // StarHermit UI strings (game language)
  function toast(text) {
    var host = document.body;
    var t = document.createElement('div');
    t.className = 'cf-toast';
    t.setAttribute('role', 'status');
    t.textContent = text;
    host.appendChild(t);
    setTimeout(function () { t.remove(); }, 3500);
  }

  // ---------- screens ----------
  var SCREENS = ['loading', 'title', 'modes', 'setup', 'game', 'results'];
  function show(screen) {
    SCREENS.forEach(function (s) {
      var el = $('screen-' + s);
      if (el) el.hidden = (s !== screen);
    });
    currentScreen = screen;
    document.body.dataset.screen = screen;
    if (screen === 'title') refreshTitle();
    if (screen === 'modes') refreshModes();
    var first = document.querySelector('#screen-' + screen + ' [data-autofocus]') ||
                document.querySelector('#screen-' + screen + ' button');
    if (first) first.focus({ preventScroll: true });
    resetScroll($('screen-' + screen));
  }

  // A screen or dialog opens at its top (heading visible), even when the
  // control it focuses (often Done at the bottom) is below the fold.
  function resetScroll(root) {
    if (!root) return;
    root.scrollTop = 0;
    root.querySelectorAll('*').forEach(function (e) { if (e.scrollTop) e.scrollTop = 0; });
  }

  // Background content is inert while a modal overlay is open: screen readers
  // and Tab stay inside the dialog.
  function syncInert() {
    var m = $('main');
    if (m) m.inert = overlayStack.length > 0;
  }

  function openOverlay(id) {
    var el = $(id);
    if (!el || !el.hidden) return;
    var prev = document.activeElement;
    el.hidden = false;
    overlayStack.push({ id: id, prev: prev });
    syncInert();
    var f = el.querySelector('[data-autofocus]') || el.querySelector('button, input, select');
    if (f) f.focus({ preventScroll: true });
    resetScroll(el);
    Audio.play('ui');
  }
  function closeOverlay(id) {
    var el = $(id);
    if (!el || el.hidden) return;
    el.hidden = true;
    var back = null;
    overlayStack = overlayStack.filter(function (x) {
      if (x.id !== id) return true;
      back = x.prev;
      return false;
    });
    syncInert();
    // restore focus to whatever opened this overlay, if it is still usable
    if (back && document.contains(back) && back.offsetParent !== null) back.focus();
    else {
      var top = overlayStack[overlayStack.length - 1];
      var host = top && $(top.id);
      var f = host && (host.querySelector('[data-autofocus]') || host.querySelector('button, input, select'));
      if (f) f.focus({ preventScroll: true });
    }
  }
  function closeTopOverlay() {
    if (!overlayStack.length) return false;
    closeOverlay(overlayStack[overlayStack.length - 1].id);
    return true;
  }
  function anyOverlayOpen() { return overlayStack.length > 0; }

  // Resume the round clock only when nothing is covering the board.
  function maybeResumeClock() {
    if (currentScreen === 'game' && sess && !sess.state.terminal && !anyOverlayOpen()) clockStart();
  }

  // ---------- title / menus ----------

  function refreshTitle() {
    var p = doc.progress;
    var stars = 0;
    for (var k in p.journeyStars) stars += p.journeyStars[k];
    $('title-progress').textContent = T('Journey: {done} / {total} stages · {stars} stars',
      { done: Object.keys(p.journeyStars).length, total: Content.JOURNEY.length, stars: stars });
    var today = Content.utcDateString(serverNowMs());
    $('title-daily').textContent = p.dailiesDone[today]
      ? T('Daily done — score {score}', { score: p.dailiesDone[today] }) : T('Daily challenge available');
  }

  function refreshModes() {
    // journey list
    var jl = $('journey-list');
    jl.innerHTML = '';
    Content.JOURNEY.forEach(function (lv, i) {
      var stars = doc.progress.journeyStars[lv.id] || 0;
      var unlocked = i === 0 || (doc.progress.journeyStars[Content.JOURNEY[i - 1].id] || 0) > 0;
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.className = 'list-btn';
      b.disabled = !unlocked;
      b.innerHTML = esc(T(lv.name)) + ' <span class="stars" aria-label="' + esc(T(stars === 1 ? '{n} star' : '{n} stars', { n: stars })) + '">' +
        '★'.repeat(stars) + '☆'.repeat(Math.max(0, 3 - stars)) + '</span>' +
        (lv.mastery ? ' <span class="tag">' + esc(T('Mastery')) + '</span>' : '');
      b.addEventListener('click', function () { openSetup(lv, 'journey'); });
      li.appendChild(b);
      jl.appendChild(li);
    });
    // challenges
    var cl = $('challenge-list');
    cl.innerHTML = '';
    Content.CHALLENGES.forEach(function (c) {
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.className = 'list-btn';
      b.textContent = T(c.name) + (doc.progress.challengeBest[c.id] ? ' — ' + T('best {score}', { score: doc.progress.challengeBest[c.id] }) : '');
      b.addEventListener('click', function () { openSetup(c, 'challenge'); });
      li.appendChild(b);
      cl.appendChild(li);
    });
    // practice
    var pl = $('practice-list');
    pl.innerHTML = '';
    Content.PRACTICE.forEach(function (p) {
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.className = 'list-btn';
      b.textContent = T(p.name);
      b.addEventListener('click', function () { openSetup(p, 'practice'); });
      li.appendChild(b);
      pl.appendChild(li);
    });
    // learn
    var ll = $('lesson-list');
    ll.innerHTML = '';
    Content.tutorialLessons().forEach(function (ls) {
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.className = 'list-btn';
      b.textContent = T(ls.title) + (doc.progress.tutorialDone[ls.id] ? ' ✓' : '');
      b.addEventListener('click', function () { startLesson(ls); });
      li.appendChild(b);
      ll.appendChild(li);
    });
  }

  var setupCfg = null, setupMode = null;
  function openSetup(cfg, mode) {
    setupCfg = cfg; setupMode = mode;
    renderSetup();
    openOverlay('overlay-setup');
  }

  // Setup dialog body (re-rendered in place on a language change).
  function renderSetup() {
    var cfg = setupCfg, mode = setupMode;
    if (!cfg) return;
    $('setup-title').textContent = cfgName(cfg);
    var assists = [];
    if (cfg.mechanics.undo) assists.push(T('Undo'));
    if (cfg.mechanics.hint) assists.push(T('Hint'));
    var rows = [];
    rows.push([T('Rules'), describeRules(cfg)]);
    rows.push([T('Expected duration'), cfg.par ? T('~{n} min', { n: Math.ceil((cfg.par.timeSec || 420) / 60) }) : '—']);
    rows.push([T('Players'), cfg.rival ? T('You vs {name} (local deterministic rival)', { name: cfg.rival.name }) : T('Solo')]);
    rows.push([T('Assists'), assists.join(' ') || T('None')]);
    rows.push([T('Ranked'), (mode === 'daily' || mode === 'challenge') ? T('Yes') : T('No (progress only)')]);
    if (cfg.intro) rows.push([T('Briefing'), T(cfg.intro)]);
    $('setup-rules').innerHTML = rows.map(function (r) {
      return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>';
    }).join('');
  }

  function describeRules(cfg) {
    var n = cfg.album.length;
    var base = T(n === 1 ? 'Complete {n} album page' : 'Complete {n} album pages', { n: n });
    if (cfg.turnLimit && cfg.timeLimitSec) return T('{goal} within {turns} turns in {time}', { goal: base, turns: cfg.turnLimit, time: fmtTime(cfg.timeLimitSec * 1000) });
    if (cfg.turnLimit) return T('{goal} within {turns} turns', { goal: base, turns: cfg.turnLimit });
    if (cfg.timeLimitSec) return T('{goal} in {time}', { goal: base, time: fmtTime(cfg.timeLimitSec * 1000) });
    return base;
  }

  // ---------- game start ----------

  function startGame(cfg, mode, lessonObj) {
    // wall-clock seed: session ids must be unique per round, not per game clock
    sess = Game.createSession(cfg, lessonObj || null, serverNowMs());
    lesson = lessonObj || null;
    lessonStep = 0;
    lessonCompleted = false;
    selectedTile = null;
    clockReset();
    presenting = false;
    // Retry always replays what is actually on screen (journey "Next", lessons)
    setupCfg = cfg; setupMode = mode;

    var theme = Content.THEMES.find(function (t) { return t.id === (cfg.theme || doc.settings.theme); }) || Content.THEMES[0];
    if (Render.isAvailable()) {
      Render.buildBoard(cfg, theme);
      Render.syncState(sess.state, null, { instant: true });
    }
    Audio.setAvRng(RNG.derive(cfg.seed, RNG.STREAM_AV));
    $('event-log').innerHTML = '';   // a new round starts with fresh city news
    $('selection-desc').textContent = '';
    show('game');
    fitCanvas(); // the wrap only has a size once the game screen is visible
    clockStart();
    updateHUD();
    renderBoardMirror();
    if (lesson) showLessonCard();
    else $('lesson-card').hidden = true;
    announce(T('{name}. {rules}. Your turn: roll the die.', { name: cfgName(cfg), rules: describeRules(cfg) }));
    logEvent(function () { return T('Welcome to {name}.', { name: cfgName(cfg) }) + (cfg.intro ? ' ' + T(cfg.intro) : ''); });
    // a lesson may open directly on a deed offer: surface it like any other
    if (sess.state.phase === 'buy' && sess.state.pending) promptBuy();
  }

  function startLesson(ls) {
    startGame(ls.cfg, 'learn', ls);
  }

  // ---------- lesson ----------
  function showLessonCard() {
    var card = $('lesson-card');
    card.hidden = false;
    $('lesson-title').textContent = T(lesson.title);
    $('lesson-text').textContent = doc.progress.tutorialDone[lesson.id] && lessonCompleted
      ? T('Lesson complete! You can keep playing this board or leave via Pause.') : T(lesson.text);
  }
  var lessonCompleted = false;
  function lessonEventCheck(events) {
    if (!lesson || doc.progress.tutorialDone[lesson.id]) return;
    var goal = lesson.goal;
    var hits = events.filter(function (e) {
      return e.type === goal.event || (goal.event === 'undo' && e.type === 'undo');
    }).length;
    if (hits >= goal.count) {
      doc.progress.tutorialDone[lesson.id] = true;
      saveDoc();
      lessonCompleted = true;
      $('lesson-text').textContent = T('Lesson complete! You can keep playing this board or leave via Pause.');
      announce(T('Lesson complete: {title}', { title: T(lesson.title) }));
      Audio.play('page');
    }
  }

  // ---------- command dispatch ----------

  function dispatch(cmd) {
    if (!sess || presenting) return;
    if (sess.state.terminal) return;
    var r = Game.applyToSession(sess, cmd, elapsedMs());
    if (!r.ok) {
      explainInvalid(r.reason);
      return;
    }
    Audio.play('ui');
    haptic();
    presentEvents(r.events, function () {
      updateHUD();
      renderBoardMirror();
      if (lesson) lessonEventCheck(r.events);
      if (sess.state.terminal) endRound();
      else if (sess.state.phase === 'buy') promptBuy();
      else if (isTimeUp()) handleTimeUp();
    });
  }

  function explainInvalid(reason) {
    var msgs = {
      'game-ended': N('This round is over.'),
      'wrong-phase': N('That action is not available right now.'),
      'unknown-command': N('Unknown action.'),
      'malformed-command': N('That action was not understood.'),
      'bad-tile': N('That tile cannot be built on.'),
      'unaffordable': N('Not enough coins.'),
      'not-owned': N('You do not own that property.'),
      'max-level': N('Already at maximum height.'),
      'undo-disabled': N('Undo is not allowed in this mode.'),
      'nothing-to-undo': N('Nothing to undo.')
    };
    var text = function () { return msgs[reason] ? T(msgs[reason]) : T('Cannot: {reason}', { reason: reason }); };
    Audio.play('invalid');
    announce(text());
    logEvent(function () { return '⚠ ' + text(); }, true);
  }

  function promptBuy() {
    var p = sess.state.pending;
    var tile = sess.state.cfg.tiles[p.tile];
    announce(T('{tile} is for sale for {price}. Buy or skip?', { tile: tileLabel(tile, p.tile), price: fmtCoins(p.price) }));
    selectedTile = p.tile;
    syncSelection();
  }

  function isTimeUp() {
    var tl = sess.state.cfg.timeLimitSec;
    return tl && elapsedMs() >= tl * 1000 && !sess.state.terminal;
  }
  function handleTimeUp() {
    var r = Game.applyToSession(sess, { type: 'timeout' }, elapsedMs());
    if (r.ok) presentEvents(r.events, function () { updateHUD(); endRound(); });
  }

  function doUndo() {
    if (!sess || presenting) return;
    var r = Game.undo(sess);
    if (!r.ok) { explainInvalid(r.reason); return; }
    Audio.play('undo');
    selectedTile = null;
    if (Render.isAvailable()) {
      Render.clearOwnershipMarks();
      Render.syncState(sess.state, null, { instant: true });
      Render.setSelection(null);
      Render.setHighlights([]);
    }
    if (lesson) lessonEventCheck([{ type: 'undo' }]);
    updateHUD();
    renderBoardMirror();
    announce(T('Turn undone.'));
    logEvent(function () { return '↩ ' + T('Undo'); });
  }

  function doHint() {
    if (!sess || presenting) return;
    var h = Game.hint(sess.state);
    if (!h) return;
    Audio.play('hint');
    announce(hintText(h));
    logEvent(function () { return '💡 ' + hintText(h); });
    if (h.tile != null) { selectedTile = h.tile; syncSelection(); }
  }

  function hintText(h) {
    var s = sess.state;
    switch (h.why) {
      case 'buy-district': return T('Buy {tile} — it completes a protected district page.', { tile: tileLabel(s.cfg.tiles[h.tile], h.tile) });
      case 'buy-cheap': return T('This property is affordable. Buying grows your rent income.');
      case 'skip-expensive': return T('This one is pricey. Skipping keeps coins for your districts.');
      case 'build-page': return T('Build on {tile} to finish the Developer page.', { tile: tileLabel(s.cfg.tiles[h.tile], h.tile) });
      case 'build-rent': return T('You have spare coins — build on {tile} to raise rent.', { tile: tileLabel(s.cfg.tiles[h.tile], h.tile) });
      default: return T('Roll the die to keep moving.');
    }
  }

  // ---------- event presentation (shortest non-interruptible phase) ----------

  var EVENT_SFX = {
    roll: 'dice', lap: 'salary', offer: 'select', buy: 'buy', skip: 'skip',
    build: 'build', bonus: 'bonus', toll: 'toll', card: 'card', sticker: 'sticker',
    'page-complete': 'page', win: 'win', lose: 'lose', rent: null,
    'cannot-afford': 'invalid', 'deck-reshuffle': 'ui', park: 'hop', 'own-visit': 'hop',
    'start-visit': 'hop', 'rival-pass': 'rival', 'rival-idle': 'rival', 'card-skip': 'ui',
    'card-move': 'hop', timeout: 'lose'
  };

  function eventText(ev) {
    var s = sess.state, cfg = s.cfg;
    var tileName = ev.tile != null && cfg.tiles[ev.tile] ? tileLabel(cfg.tiles[ev.tile], ev.tile) : '';
    var rn = s.rival ? s.rival.name : T('Rival');
    var you = ev.who === 'you';
    var v = { rival: rn, tile: tileName, price: ev.price, amount: ev.amount, die: ev.die, salary: ev.salary };
    switch (ev.type) {
      case 'roll': return you ? T('You rolled {die}.', v) : T('{rival} rolled {die}.', v);
      case 'lap': return (you ? T('You pass Start: +{salary} salary.', v) : T('{rival} passes Start: +{salary} salary.', v)) + (ev.tram ? ' (' + T('Express Tram') + ')' : '');
      case 'offer': return T('{tile} is for sale — {coins}.', { tile: tileName, coins: fmtCoins(ev.price) });
      case 'cannot-afford': return T('{tile} costs {coins} — you cannot afford it.', { tile: tileName, coins: fmtCoins(ev.price) });
      case 'buy': return you ? T('You buy {tile} for {price}.', v) : T('{rival} buys {tile} for {price}.', v);
      case 'skip': return T('You pass on {tile}.', v);
      case 'rival-pass': return T('{rival} passes on {tile}.', v);
      case 'own-visit': return you ? T('Your own {tile}.', v) : T('{rival}’s own {tile}.', v);
      case 'rent': return ev.from === 'you'
        ? T('You pay {amount} rent to {rival} ({tile}).', v)
        : T('{rival} pays you {amount} rent ({tile}).', v);
      case 'bonus': return you ? T('+{amount} bonus coins.', v) : T('{rival} +{amount} bonus coins.', v);
      case 'toll': return you ? T('You pay {amount} toll.', v) : T('{rival} pays {amount} toll.', v);
      case 'card': return T(you ? 'You draw “{card}”: {text}' : '{rival} draws “{card}”: {text}', { rival: rn, card: T(ev.name), text: T(ev.text) });
      case 'card-move': return ev.delta > 0 ? T('Moved forward {n} tiles.', { n: ev.delta }) : T('Moved back {n} tiles.', { n: -ev.delta });
      case 'card-skip': return T('The card deck is spent.');
      case 'deck-reshuffle': return T('The card deck is reshuffled.');
      case 'sticker': return T('Sticker collected! ({n})', { n: ev.count });
      case 'park': return you ? T('You rest in the park.') : T('{rival} rests in the park.', v);
      case 'page-complete': {
        var pg = cfg.album.find(function (x) { return x.id === ev.page; });
        return T('Album page complete: {name} (+{bonus})!', { name: pg ? pageName(pg) : T(ev.name), bonus: ev.bonus });
      }
      case 'win': return T('Album complete — you win!');
      case 'lose':
        return T({ 'turn-limit': N('Out of turns.'), 'time-up': N('Time is up.'), resigned: N('You resigned.') }[ev.reason] || N('Round over.'));
      case 'undo': return T('Undone.');
      default: return ev.type;
    }
  }

  function presentEvents(events, done) {
    presenting = true;
    skipping = false;
    updateActionButtons();
    var i = 0;
    function delay() {
      if (skipping) return 0;
      return doc.settings.reducedMotion ? 60 : 320;
    }
    function step() {
      if (!sess) { presenting = false; return; } // round left mid-presentation
      if (i >= events.length) {
        presenting = false;
        skipping = false;
        if (Render.isAvailable()) Render.settle();
        if (Render.isAvailable()) Render.syncState(sess.state, null, { instant: true });
        updateHUD();
        done();
        return;
      }
      var ev = events[i++];
      var sfx = EVENT_SFX[ev.type];
      if (ev.type === 'rent') sfx = ev.from === 'you' ? 'rent-pay' : 'rent-get';
      if (ev.type === 'roll' && ev.who === 'rival') sfx = 'rival';
      if (sfx) Audio.play(sfx);
      var text = eventText(ev);
      logEvent((function (e) { return function () { return eventText(e); }; })(ev));
      announce(text);
      if (Render.isAvailable()) Render.syncState(sess.state, [ev], { instant: skipping || doc.settings.reducedMotion });
      setTimeout(step, delay());
    }
    step();
  }

  function skipPresentation() {
    // flush the remaining event beats and settle the board into its end state
    skipping = true;
    if (Render.isAvailable() && sess) {
      Render.settle();
      Render.syncState(sess.state, null, { instant: true });
    }
  }

  // ---------- HUD ----------

  function updateHUD() {
    if (!sess) return;
    var s = sess.state, cfg = s.cfg;

    // objective + album pages
    var albumEl = $('hud-album');
    albumEl.innerHTML = '';
    cfg.album.forEach(function (pg) {
      var prog = Game.pageProgress(s, pg);
      var li = document.createElement('li');
      li.className = prog.done ? 'page done' : 'page';
      li.textContent = (prog.done ? '✓ ' : '') + pageName(pg) + ': ' + Math.min(prog.have, prog.need) + '/' + prog.need + ' (+' + pg.bonus + ')';
      albumEl.appendChild(li);
    });

    $('hud-turn').textContent = cfg.turnLimit
      ? T('Turn {n} / {limit}', { n: s.turn + 1, limit: cfg.turnLimit }) : T('Turn {n}', { n: s.turn + 1 });
    $('hud-coins').textContent = fmtCoins(s.you.coins);
    $('hud-score').textContent = T('Score {n}', { n: Rules.currentScore(s) });
    $('hud-phase').textContent = s.terminal ? T('Round over')
      : s.phase === 'buy' ? T('Decide: buy or skip') : T('Your turn — roll');

    if (s.rival) {
      var nProps = Object.keys(s.rival.props).length;
      $('hud-rival').hidden = false;
      $('hud-rival').textContent = T(nProps === 1 ? '{name}: {coins}, {n} property' : '{name}: {coins}, {n} properties',
        { name: s.rival.name, coins: fmtCoins(s.rival.coins), n: nProps });
    } else {
      $('hud-rival').hidden = true;
    }

    updateTimer();
    updateActionButtons();
    updateFocusTargets();
  }

  function updateTimer() {
    var el = $('hud-timer');
    if (!sess) { el.hidden = true; return; }
    var tl = sess.state.cfg.timeLimitSec;
    if (!tl) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = '⏱ ' + fmtTime(tl * 1000 - elapsedMs());
  }

  function updateActionButtons() {
    if (!sess) return;
    var s = sess.state;
    var over = !!s.terminal;
    var lock = presenting || over;
    $('btn-roll').disabled = lock || s.phase !== 'roll';
    $('btn-buy').disabled = lock || s.phase !== 'buy';
    $('btn-skip').disabled = lock || s.phase !== 'buy';
    $('btn-build').disabled = lock || s.phase !== 'roll' || selectedTile == null ||
      !buildLegal(selectedTile).ok;
    $('btn-undo').disabled = lock || !s.cfg.mechanics.undo || !sess.undoStack.length;
    $('btn-hint').disabled = lock || !s.cfg.mechanics.hint;
    // highlights on legal build targets
    if (Render.isAvailable() && !over) {
      var targets = Game.legalActions(s)
        .filter(function (a) { return a.type === 'build'; })
        .map(function (a) { return a.tile; });
      Render.setHighlights(s.phase === 'roll' ? targets : []);
    }
  }

  function buildLegal(idx) {
    return { ok: Game.legalActions(sess.state).some(function (a) { return a.type === 'build' && a.tile === idx; }) };
  }

  // text: a string or a function returning the text in the current language
  // (re-run when the language changes, so the news log re-renders too).
  function logEvent(text, warn) {
    var log = $('event-log');
    var li = document.createElement('li');
    if (typeof text === 'function') { li._text = text; text = text(); }
    li.textContent = text;
    if (warn) li.className = 'warn';
    log.appendChild(li);
    while (log.children.length > 30) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }

  // ---------- selection / keyboard focus ----------

  function syncSelection() {
    if (Render.isAvailable()) Render.setSelection(selectedTile);
    updateActionButtons();
    describeSelection();
    var mirror = $('board-mirror');
    if (mirror) {
      Array.prototype.forEach.call(mirror.querySelectorAll('.mirror-tile'), function (b) {
        b.setAttribute('aria-pressed', +b.dataset.tile === selectedTile ? 'true' : 'false');
      });
    }
  }

  function describeSelection() {
    if (!sess) return;
    if (selectedTile == null) { $('selection-desc').textContent = ''; return; }
    var t = sess.state.cfg.tiles[selectedTile];
    var s = sess.state;
    var parts = [tileLabel(t, selectedTile), tileKindLabel(t)];
    if (t.t === 'prop') {
      var owner = Rules.ownerOf(s, selectedTile);
      if (owner === 'you') parts.push(T('yours, level {n}', { n: s.you.props[selectedTile] }));
      else if (owner) parts.push(T('{name}’s, level {n}', { name: s.rival.name, n: s.rival.props[selectedTile] }));
      else parts.push(T('unowned, price {n}', { n: t.price }));
      parts.push(T('rent {list}', { list: t.rent.join('/') }));
    }
    $('selection-desc').textContent = parts.join(' · ');
  }

  function tileKindLabel(t) {
    var v = { n: t.amt };
    return { start: T('Start'), prop: T('property'), bonus: T('bonus +{n}', v), toll: T('toll −{n}', v),
             card: T('chance card'), sticker: T('sticker'), park: T('park') }[t.t] || t.t;
  }

  function updateFocusTargets() {
    if (!sess) { focusTargets = []; return; }
    var s = sess.state;
    focusTargets = [];
    for (var i = 0; i < s.cfg.tiles.length; i++) focusTargets.push(i);
    focusIdx = sess.state.you.pos;
  }

  function cycleFocus(dir) {
    if (!focusTargets.length || !sess) return;
    focusIdx = ((focusIdx + dir) % focusTargets.length + focusTargets.length) % focusTargets.length;
    selectedTile = focusTargets[focusIdx];
    syncSelection();
    Audio.play('select');
    var t = sess.state.cfg.tiles[selectedTile];
    announce(tileLabel(t, selectedTile) + ', ' + tileKindLabel(t) +
      (buildLegal(selectedTile).ok ? '. ' + T('Build available.') : ''));
  }

  // ---------- DOM board mirror (screen-reader / no-WebGL fallback) ----------

  function renderBoardMirror() {
    var el = $('board-mirror');
    if (!el || !sess) return;
    // keep keyboard focus on the same tile across HUD refreshes
    var focusedIdx = null;
    if (document.activeElement && el.contains(document.activeElement)) {
      focusedIdx = +document.activeElement.dataset.tile;
    }
    el.innerHTML = '';
    var s = sess.state;
    s.cfg.tiles.forEach(function (t, i) {
      var li = document.createElement('li');
      var label = tileLabel(t, i);
      var parts = [i === 0 ? T('Start') : label, tileKindLabel(t)];
      if (parts[0] === parts[1]) parts.pop();   // "Start, Start" reads badly
      if (t.t === 'prop') {
        var owner = Rules.ownerOf(s, i);
        if (owner === 'you') parts.push(T('owned by you, level {n}', { n: s.you.props[i] }));
        else if (owner) parts.push(T('owned by {name}, level {n}', { name: s.rival.name, n: s.rival.props[i] }));
        else parts.push(T('unowned, {coins}', { coins: fmtCoins(t.price) }));
      }
      if (s.you.pos === i) parts.push(T('you are here'));
      if (s.rival && s.rival.pos === i) parts.push(T('{name} is here', { name: s.rival.name }));
      // the mirror is the playable surface without WebGL: every tile selectable
      var b = document.createElement('button');
      b.className = 'mirror-tile';
      b.type = 'button';
      b.dataset.tile = String(i);
      b.textContent = parts.join(', ');
      b.setAttribute('aria-pressed', selectedTile === i ? 'true' : 'false');
      b.addEventListener('click', function () { selectTile(i); });
      li.appendChild(b);
      if (s.you.pos === i) li.className = 'here';
      el.appendChild(li);
    });
    if (focusedIdx != null && !isNaN(focusedIdx)) {
      var back = el.querySelector('[data-tile="' + focusedIdx + '"]');
      if (back) back.focus();
    }
  }

  // Single selection entry point shared by the canvas, the mirror and the keys.
  function selectTile(idx) {
    if (!sess) return;
    selectedTile = idx;
    focusIdx = idx;
    syncSelection();
    Audio.play('select');
    var t = sess.state.cfg.tiles[idx];
    announce(tileLabel(t, idx) + ', ' + tileKindLabel(t) +
      (buildLegal(idx).ok ? '. ' + T('Build available ({cost}).', { cost: buildCostText(idx) }) : ''));
  }

  // ---------- round end / results ----------

  function endRound() {
    clockStop();
    var s = sess.state;
    var won = s.terminal.won;
    var cfg = s.cfg;

    // progress + achievements
    var p = doc.progress;
    p.stats.rounds++;
    p.stats.rentCollected += s.stats.rentCollected;
    p.stats.builds += s.stats.builds;
    p.stats.laps += s.you.laps;
    p.stats.pages += Object.keys(s.albumDone).length;
    var newlyUnlocked = [];
    if (won) {
      p.stats.wins++;
      if (cfg.kind === 'journey') {
        var stars = 1;
        if (cfg.par && s.turn <= cfg.par.turns) stars++;
        if (cfg.par && cfg.par.timeSec && elapsedMs() <= cfg.par.timeSec * 1000) stars++;
        p.journeyStars[cfg.id] = Math.max(p.journeyStars[cfg.id] || 0, stars);
        p.journeyBest[cfg.id] = Math.max(p.journeyBest[cfg.id] || 0, s.score.total);
      }
      if (cfg.kind === 'challenge') {
        p.challengeBest[cfg.id] = Math.max(p.challengeBest[cfg.id] || 0, s.score.total);
      }
      if (cfg.kind === 'daily') {
        p.dailiesDone[cfg.date] = Math.max(p.dailiesDone[cfg.date] || 0, s.score.total);
      }
    }
    checkAchievements(s, newlyUnlocked);
    saveDoc();

    // leaderboard entry (local board; signed in, every non-lesson round also
    // posts its total to the platform high-score board)
    var entry = {
      sessionId: sess.id, configId: cfg.id, kind: cfg.kind,
      contentVersion: cfg.version, seed: cfg.seed >>> 0,
      won: won, score: s.score.total, invalid: sess.invalidCount,
      durationMs: elapsedMs(), assists: assistsUsed(cfg),
      date: cfg.date || null, atMs: serverNowMs()
    };
    var boards = Store.loadBoards();
    boards.entries.push(entry);
    if (boards.entries.length > 200) boards.entries = boards.entries.slice(-200);
    Store.saveBoards(boards);
    showResults(s, entry, newlyUnlocked);
    if (cfg.kind !== 'tutorial') postToLeaderboard(s.score.total);
  }

  function assistsUsed(cfg) {
    var a = [];
    if (cfg.mechanics.hint) a.push('hint');
    if (cfg.mechanics.undo) a.push('undo');
    return a.join(',') || 'none';
  }

  function checkAchievements(s, out) {
    var p = doc.progress;
    function unlock(key) {
      if (p.achievements[key]) return;
      p.achievements[key] = serverNowMs();
      out.push(key);
      Audio.play('star');
    }
    if (Object.keys(s.you.props).length) unlock('first-buy');
    if (Object.keys(s.albumDone).length) unlock('first-page');
    if (s.terminal && s.terminal.won) unlock('first-win');
    if (p.stats.rentCollected >= 500) unlock('rent-500');
    if (p.stats.builds >= 25) unlock('builds-25');
    var journeyDone = Object.keys(p.journeyStars).length;
    if (journeyDone >= 20) unlock('journey-half');
    if (journeyDone >= Content.JOURNEY.length) unlock('journey-done');
    if (Object.keys(p.dailiesDone).length >= 7) unlock('daily-7');
    if (s.score.total >= 4000) unlock('score-4000');
    if (p.stats.laps >= 50) unlock('laps-50');
  }

  var lastResults = null;   // { s, entry, newlyUnlocked } for re-rendering on a language change
  function showResults(s, entry, newlyUnlocked) {
    lastResults = { s: s, entry: entry, newlyUnlocked: newlyUnlocked };
    serverLine = null;
    renderResults();
    show('results');
    announce($('results-headline').textContent + ' ' + T('Total score {n}.', { n: s.score.total }));
  }

  function renderResults() {
    if (!lastResults) return;
    var s = lastResults.s, newlyUnlocked = lastResults.newlyUnlocked;
    var won = s.terminal.won;
    $('results-headline').textContent = won ? T('Album complete!') : T('Round over');
    var spare = Math.max(0, s.cfg.turnLimit - s.turn);
    $('results-reason').textContent = {
      'album-complete': T(spare === 1 ? 'Every album page finished with {n} turn to spare.' : 'Every album page finished with {n} turns to spare.', { n: spare }),
      'turn-limit': T('The turn limit ran out.'),
      'time-up': T('The clock ran out.'),
      resigned: T('You resigned.')
    }[s.terminal.reason] || '';

    var rows = [
      [T('Rent collected'), s.score.rent],
      [T('Salary'), s.score.salary],
      [T('Album bonuses'), s.score.album],
      [T('Property value'), s.score.property],
      [T('Coins in hand'), s.score.coins],
      [T('Turn bonus'), s.score.turnsBonus],
      [T('Time bonus'), s.score.timeBonus]
    ];
    $('results-breakdown').innerHTML = rows.map(function (r) {
      return '<tr><th scope="row">' + esc(r[0]) + '</th><td>' + r[1] + '</td></tr>';
    }).join('') + '<tr class="total"><th scope="row">' + esc(T('Total')) + '</th><td>' + s.score.total + '</td></tr>';

    $('results-achievements').innerHTML = newlyUnlocked.map(function (k) {
      var a = Content.ACHIEVEMENTS.find(function (x) { return x.key === k; });
      return '<li>🏅 ' + esc(a ? T(a.name) : k) + '</li>';
    }).join('');

    // next recommended action
    var next = '';
    if (s.cfg.kind === 'journey') {
      var idx = Content.JOURNEY.findIndex(function (l) { return l.id === s.cfg.id; });
      if (won && idx >= 0 && idx + 1 < Content.JOURNEY.length) {
        next = T('Next: {name}', { name: T(Content.JOURNEY[idx + 1].name) });
        $('btn-results-next').hidden = false;
        $('btn-results-next').textContent = next;
        $('btn-results-next').onclick = function () { startGame(Content.JOURNEY[idx + 1], 'journey'); };
      } else {
        $('btn-results-next').hidden = true;
      }
    } else {
      $('btn-results-next').hidden = true;
    }
    renderServerLine();
    $('results-progress').textContent = next || (won ? T('Well played.') : T('Try a different approach — undo and hints are available in practice.'));
  }

  // ---------- server (optional; graceful offline) ----------

  // Account + connection status line on the title screen. Offline keeps the
  // identical local-only behaviour; hosted shows the account nickname.
  function renderAccountLine() {
    var el = $('account-line');
    if (!el || !Platform) return;
    var inv = $('btn-title-invite'), sib = $('btn-title-signin');
    if (inv) { inv.textContent = PT.invite; inv.hidden = !Platform.hosted; }
    if (sib) { sib.textContent = PT.signIn; sib.hidden = !Platform.canSignIn(); }
    if (!Platform.hosted) {
      el.textContent = T('Offline — progress is stored on this device.');
      return;
    }
    var name = Platform.profile ? Platform.profile.name : '…';
    el.textContent = T('Playing as {name} — connected to the platform.', { name: name });
  }

  function probeServerTime() {
    // The own-server clock route is only asked when signed in; standalone
    // makes no requests and uses the local clock.
    if (!Platform.hosted) { serverOffsetMs = 0; return Promise.resolve(); }
    var t0 = nowMs();
    return fetch('/api/v1/time', { headers: Platform.headers() }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    }).then(function (j) {
      var t1 = nowMs();
      if (typeof j.nowMs === 'number') {
        serverOffsetMs = j.nowMs - Math.round((t0 + t1) / 2);
      }
    }).catch(function () { serverOffsetMs = 0; });
  }

  // Signed in only: post the round total through the platform and show the
  // player's rank on the results screen. Standalone shows nothing.
  var serverLine = null;   // null | 'posting' | { posted, rank }
  function postToLeaderboard(total) {
    var el = $('results-server');
    if (!el || !Platform || !Platform.hosted) return;
    serverLine = 'posting';
    renderServerLine();
    var mine = sess;
    Platform.submitScore(total).then(function (r) {
      if (sess !== mine) return;
      serverLine = r;
      renderServerLine();
    });
  }
  function renderServerLine() {
    var el = $('results-server');
    if (!el) return;
    var r = serverLine;
    el.textContent = !r ? '' : r === 'posting' ? PT.lbPosting : !r.posted ? PT.lbNotPosted
      : r.rank ? root.PlatformStrings.fmtPlatform(PT.lbRank, { rank: r.rank }) : PT.lbPosted;
  }

  // ---------- pause / resume / leave ----------

  function pauseGame() {
    if (currentScreen !== 'game') return;
    clockStop();
    openOverlay('overlay-pause');
    announce(T('Paused.'));
  }
  function resumeGame() {
    closeOverlay('overlay-pause');
    closeOverlay('overlay-settings');
    closeOverlay('overlay-help');
    if (currentScreen === 'game' && !sess.state.terminal) clockStart();
  }
  function leaveRound() {
    overlayStack.slice().forEach(function (o) { closeOverlay(o.id); });
    clockStop();
    if (sess && !sess.state.terminal) {
      // abandoning counts as resign for stats honesty, but is not persisted as a result
      logEvent(function () { return T('Left the round.'); });
    }
    sess = null; lesson = null;
    show('title');
  }

  // ---------- settings ----------

  function bindSettings() {
    var s = doc.settings;
    function bindRange(id, key) {
      var el = $(id);
      el.value = s[key];
      el.addEventListener('input', function () {
        doc.settings[key] = parseFloat(el.value);
        Audio.applySettings(doc.settings); saveDoc();
      });
    }
    function bindCheck(id, key, apply) {
      var el = $(id);
      el.checked = !!s[key];
      el.addEventListener('change', function () {
        doc.settings[key] = el.checked;
        saveDoc(); applyAllSettings();
        if (apply) apply();
      });
    }
    function bindSelect(id, key) {
      var el = $(id);
      el.value = s[key];
      el.addEventListener('change', function () {
        doc.settings[key] = el.value;
        saveDoc(); applyAllSettings();
      });
    }
    bindRange('set-music', 'music');
    bindRange('set-effects', 'effects');
    bindRange('set-ambience', 'ambience');
    bindRange('set-voice', 'voice');
    bindCheck('set-muted', 'muted');
    bindCheck('set-captions', 'captions');
    bindCheck('set-reduced-motion', 'reducedMotion');
    bindCheck('set-high-contrast', 'highContrast');
    bindCheck('set-large-text', 'largeText');
    bindCheck('set-left-handed', 'leftHanded');
    bindCheck('set-haptics', 'haptics');
    bindCheck('set-board-mirror', 'boardMirror');
    bindCheck('set-confirm-moves', 'confirmMoves');
    bindSelect('set-theme', 'theme');
    bindSelect('set-palette', 'colorPalette');
    populateThemes();
  }

  // Themes unlock with journey stars; locked ones stay visible but unselectable.
  function populateThemes() {
    var themeSel = $('set-theme');
    if (!themeSel) return;
    var stars = 0;
    for (var k in doc.progress.journeyStars) stars += doc.progress.journeyStars[k];
    themeSel.innerHTML = '';
    Content.THEMES.forEach(function (t) {
      var locked = stars < (t.unlockStars || 0);
      var o = document.createElement('option');
      o.value = t.id;
      o.disabled = locked;
      o.textContent = T(t.name) + (t.unlockStars > 0 ? ' (' + t.unlockStars + '★' + (locked ? ' — ' + T('locked') : '') + ')' : '');
      themeSel.appendChild(o);
    });
    var current = Content.THEMES.find(function (t) { return t.id === doc.settings.theme; });
    if (!current || stars < (current.unlockStars || 0)) {
      doc.settings.theme = Content.THEMES[0].id;
      saveDoc();
    }
    themeSel.value = doc.settings.theme;
  }

  function applyAllSettings() {
    var s = doc.settings;
    document.body.classList.toggle('reduced-motion', s.reducedMotion);
    document.body.classList.toggle('high-contrast', s.highContrast);
    document.body.classList.toggle('large-text', s.largeText);
    document.body.classList.toggle('left-handed', s.leftHanded);
    document.body.classList.toggle('hc-palette', s.colorPalette === 'high-visibility');
    document.body.classList.toggle('show-mirror', !!s.boardMirror || !Render.isAvailable());
    Audio.applySettings(s);
    Audio.setCaptions(s.captions, function (text) {
      var el = $('captions');
      el.textContent = '♪ ' + T(text);
      clearTimeout(applyAllSettings._capT);
      applyAllSettings._capT = setTimeout(function () { el.textContent = ''; }, 2500);
    });
    if (Render.isAvailable()) {
      Render.setReducedMotion(s.reducedMotion);
      // district stripe colors are baked at build time: rebuild when they change
      var hc = s.colorPalette === 'high-visibility';
      if (hc !== appliedPaletteHC) {
        appliedPaletteHC = hc;
        Render.setPaletteHC(hc);
        rebuildBoard();
      }
    }
  }

  // ---------- graphics ----------

  // Saved graphics settings: the preset lives in settings.graphicsTier, the
  // overrides (render scale, adaptive, fps, per-effect tiers) in settings.gfx.
  function gfxSaved() {
    var s = doc.settings;
    return Object.assign({}, s.gfx || {}, { preset: s.graphicsTier || 'auto' });
  }

  function setGfxSaved(saved) {
    var o = Object.assign({}, saved);
    doc.settings.graphicsTier = o.preset || 'auto';
    delete o.preset;
    doc.settings.gfx = o;
    saveDoc();
    applyGraphics();
  }

  // Apply live; scene detail/background changes rebuild the board from state.
  function applyGraphics() {
    if (!Render.isAvailable()) return;
    if (Render.setGraphics(gfxSaved())) rebuildBoard();
  }

  function rebuildBoard() {
    if (!sess || !Render.isAvailable()) return;
    var theme = Content.THEMES.find(function (t) {
      return t.id === (sess.state.cfg.theme || doc.settings.theme);
    }) || Content.THEMES[0];
    Render.buildBoard(sess.state.cfg, theme);
    Render.syncState(sess.state, null, { instant: true });
    Render.setSelection(selectedTile);
    updateActionButtons();
  }

  function bindGraphics() {
    GfxUI.setup({
      getSaved: gfxSaved,
      setSaved: setGfxSaved,
      info: function () { return Render.isAvailable() ? Render.graphicsInfo() : null; }
    });
  }

  // ---------- help / achievements / boards / friends ----------

  function refreshHelp() {
    var el = $('help-content');
    var k = Platform.keyLabel;
    var bindings = [
      [k('confirm'), T('Confirm: roll the die, or buy when a deed is offered')],
      [k('prev') + ' · ' + k('next'), T('Move the selection around the board')],
      [k('buy'), T('Buy the offered property')],
      [k('skip'), T('Skip the offered property')],
      [k('undo'), T('Undo (where allowed)')],
      [k('hint'), T('Hint')],
      [k('cancel') + ' · ' + k('pause'), T('Pause / close panel')],
      [k('mute'), T('Mute / unmute')],
      [k('settle'), T('Skip animations (settle the board)')]
    ];
    var cards = bindings.map(function (b) {
      return '<section class="rule-card"><h3>' + esc(b[0]) + '</h3><p>' + esc(b[1]) + '</p></section>';
    });
    var examples = '';
    if (sess) {
      var acts = Game.legalActions(sess.state);
      var ACTIONS = { roll: N('roll'), buy: N('buy'), skip: N('skip'), build: N('build'), resign: N('resign'), timeout: N('timeout') };
      examples = '<section class="rule-card"><h3>' + esc(T('Right now')) + '</h3><p>' + esc(T('Legal actions: {list}', { list:
        acts.map(function (a) {
          return a.type === 'build' ? T('build on {tile} ({cost})', { tile: tileLabel(sess.state.cfg.tiles[a.tile], a.tile), cost: a.cost }) : (ACTIONS[a.type] ? T(ACTIONS[a.type]) : a.type);
        }).join(', ') || T('none') })) + '</p></section>';
    }
    el.innerHTML =
      '<section class="rule-card"><h3>' + esc(T('Goal')) + '</h3><p>' + esc(T('Roll to move around the city circuit. Buy properties, collect bonuses and stickers, build upgrades, and complete every album page before the limits.')) + '</p></section>' +
      '<section class="rule-card"><h3>' + esc(T('Tiles')) + '</h3><p>' + esc(T('Colored stripe = property district (icon + label in the album). Green = bonus, red = toll, blue = chance card, purple = sticker, park = safe rest.')) + '</p></section>' +
      '<section class="rule-card"><h3>' + esc(T('Rival')) + '</h3><p>' + esc(T('Your rival alternates turns with you. They pay rent on your buildings but can never buy property in album districts — your set progress is protected.')) + '</p></section>' +
      cards.join('') + examples;
  }

  function refreshAchievements() {
    var el = $('achievements-list');
    el.innerHTML = '';
    Content.ACHIEVEMENTS.forEach(function (a) {
      var li = document.createElement('li');
      var got = doc.progress.achievements[a.key];
      li.className = got ? 'ach got' : 'ach';
      li.innerHTML = '<strong>' + esc(T(a.name)) + '</strong> — ' + esc(T(a.desc)) + (got ? ' <span aria-label="' + esc(T('unlocked')) + '">✓</span>' : '');
      el.appendChild(li);
    });
  }

  function refreshBoards() {
    var boards = Store.loadBoards();
    var sorted = Store.sortEntries(boards.entries).slice(0, 20);
    var el = $('boards-list');
    el.innerHTML = '';
    // Platform leaderboard (read-only): entries resolve to profile nicknames.
    // Falls back to the local board when no leaderboardId exists or offline.
    if (Platform.hosted) {
      Platform.fetchLeaderboard().then(function (entries) {
        if (!entries || !entries.length) return;
        var h = document.createElement('h3');
        h.textContent = T('Platform board');
        el.appendChild(h);
        entries.forEach(function (e, i) {
          var li = document.createElement('li');
          li.textContent = '#' + (i + 1) + ' ' + T('{n} pts', { n: e.score }) + ' — ' + e.name;
          el.appendChild(li);
        });
        var note = document.createElement('li');
        note.className = 'muted';
        note.textContent = T('— local results below —');
        el.appendChild(note);
      }).catch(function () {});
    }
    if (!sorted.length) {
      if (!el.children.length) el.innerHTML = '<li>' + esc(T('No results yet — play a round!')) + '</li>';
      return;
    }
    sorted.forEach(function (e, i) {
      var li = document.createElement('li');
      li.textContent = '#' + (i + 1) + ' ' + T('{n} pts', { n: e.score }) + ' — ' + e.configId +
        (e.won ? ' (' + T('won') + ')' : '') + ' · ' + fmtTime(e.durationMs);
      el.appendChild(li);
    });
  }

  function refreshFriends() {
    // compact local "friend board": the deterministic rival plus recent local sessions
    var el = $('friends-list');
    el.innerHTML = '';
    var boards = Store.loadBoards();
    var recent = boards.entries.slice(-5).reverse();
    var p = doc.progress;
    var items = [];
    if (sess && sess.state.rival) {
      items.push('<li><strong>' + esc(sess.state.rival.name) + '</strong> ' + esc(T('(rival on this board): {coins}', { coins: fmtCoins(sess.state.rival.coins) })) + '</li>');
    }
    items.push('<li><strong>' + esc(T('You')) + '</strong>: ' + esc(T('{wins} wins, {stages} stages cleared', { wins: p.stats.wins, stages: Object.keys(p.journeyStars).length })) + '</li>');
    recent.forEach(function (e) {
      items.push('<li>' + esc(T('Session {id}: {n} pts on {config}', { id: e.sessionId, n: e.score, config: e.configId })) + '</li>');
    });
    el.innerHTML = items.join('');
  }

  // ---------- render loop ----------

  var lastFrame = 0;
  function frame(t) {
    rafId = requestAnimationFrame(frame);
    var dt = Math.min(0.1, (t - lastFrame) / 1000 || 0.016);
    lastFrame = t;
    if (hidden) return; // background tabs: no rendering work
    if (Render.isAvailable() && currentScreen === 'game') {
      Render.update(dt);
      Render.render();
    }
    if (currentScreen === 'game' && sess && !sess.state.terminal) {
      updateTimer();
      if (isTimeUp() && !presenting) handleTimeUp();
    }
  }

  // ---------- input ----------

  function bindInput() {
    // canvas pointer: tap vs drag thresholds
    var canvas = $('board-canvas');
    var downPos = null, downTime = 0;
    canvas.addEventListener('pointerdown', function (e) {
      downPos = { x: e.clientX, y: e.clientY };
      downTime = nowMs();
      try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    });
    canvas.addEventListener('pointerup', function (e) {
      if (!downPos) return;
      var dx = e.clientX - downPos.x, dy = e.clientY - downPos.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var dtMs = nowMs() - downTime;
      downPos = null;
      if (dist > 12 || dtMs > 600) return; // drag/gesture, not a tap
      if (!sess || presenting || currentScreen !== 'game') return;
      var idx = Render.isAvailable() ? Render.pick(e.clientX, e.clientY) : null;
      if (idx == null) { selectedTile = null; syncSelection(); Audio.play('deselect'); return; }
      selectTile(idx);
    });
    canvas.addEventListener('pointercancel', function () { downPos = null; });
    canvas.addEventListener('lostpointercapture', function () { downPos = null; });

    document.addEventListener('keydown', onKey);

    document.addEventListener('visibilitychange', function () {
      hidden = document.hidden;
      if (hidden) {
        if (currentScreen === 'game' && sess && !sess.state.terminal) {
          clockStop(); // solo simulation pauses in background
        }
        Audio.suspend();
      } else {
        Audio.resume();
        maybeResumeClock();
      }
    });

    root.addEventListener('resize', fitCanvas);
    // Any change to the canvas box (drawers, chat sidebar, orientation) refits.
    if (typeof ResizeObserver === 'function' && $('canvas-wrap')) {
      new ResizeObserver(function () { fitCanvas(); }).observe($('canvas-wrap'));
    }
  }

  function buildCostText(idx) {
    var s = sess.state;
    var lvl = s.you.props[idx];
    if (!lvl) return '';
    return fmtCoins(Rules.buildCost(s.cfg.tiles[idx].price, lvl));
  }

  function onKey(e) {
    if (e.defaultPrevented) return;
    var inField = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName || '');
    var act = Platform.actionFor(e); // StarHermit control bindings
    if (e.key === 'Escape' || act === 'cancel') {
      if (anyOverlayOpen()) { closeTopOverlay(); maybeResumeClock(); }
      else if (currentScreen === 'game') pauseGame();
      e.preventDefault();
      return;
    }
    if (inField) return;
    if (act === 'mute') {
      doc.settings.muted = !doc.settings.muted;
      $('set-muted').checked = doc.settings.muted;
      Audio.applySettings(doc.settings); saveDoc();
      announce(doc.settings.muted ? T('Muted.') : T('Sound on.'));
      return;
    }
    if (currentScreen !== 'game' || !sess || anyOverlayOpen()) return;
    switch (act) {
      case 'prev': cycleFocus(-1); e.preventDefault(); break;
      case 'next': cycleFocus(1); e.preventDefault(); break;
      case 'confirm':
        e.preventDefault();
        primaryAction();
        break;
      case 'buy': if (!$('btn-buy').disabled) dispatch({ type: 'buy' }); break;
      case 'skip': if (!$('btn-skip').disabled) dispatch({ type: 'skip' }); break;
      case 'undo': doUndo(); break;
      case 'hint': doHint(); break;
      case 'settle': skipPresentation(); break;
      case 'pause': pauseGame(); break;
    }
  }

  function primaryAction() {
    if (!sess || presenting || sess.state.terminal) return;
    var s = sess.state;
    if (s.phase === 'buy') { dispatch({ type: 'buy' }); return; }
    if (selectedTile != null && buildLegal(selectedTile).ok) {
      dispatch({ type: 'build', tile: selectedTile });
      return;
    }
    dispatch({ type: 'roll' });
  }

  // ---------- canvas sizing ----------

  function fitCanvas() {
    var wrap = $('canvas-wrap');
    if (!wrap || !Render.isAvailable()) return;
    var r = wrap.getBoundingClientRect();
    Render.setViewport(Math.round(r.width), Math.round(r.height));
  }

  // ---------- boot ----------

  function bindButtons() {
    function on(id, fn) { var el = $(id); if (el) el.addEventListener('click', fn); }

    on('btn-play', function () { show('modes'); });
    on('btn-title-daily', function () {
      var d = Content.utcDateString(serverNowMs());
      openSetup(Content.dailyConfig(d), 'daily');
    });
    on('btn-title-boards', function () { refreshBoards(); openOverlay('overlay-boards'); });
    on('btn-title-signin', function () { Platform.signIn(); });
    on('btn-title-invite', function () {
      Platform.copyInvite().then(function (ok) {
        var msg = ok ? PT.inviteCopied : PT.inviteFailed;
        toast(msg); announce(msg);
      });
    });
    on('btn-title-achievements', function () { refreshAchievements(); openOverlay('overlay-achievements'); });
    on('btn-title-settings', function () { populateThemes(); GfxUI.refresh(); openOverlay('overlay-settings'); });
    on('btn-modes-daily', function () {
      openSetup(Content.dailyConfig(Content.utcDateString(serverNowMs())), 'daily');
    });
    on('btn-title-help', function () { refreshHelp(); openOverlay('overlay-help'); });
    on('btn-modes-back', function () { show('title'); });

    on('btn-setup-start', function () {
      closeOverlay('overlay-setup');
      if (setupCfg) startGame(setupCfg, setupMode);
    });
    on('btn-setup-cancel', function () { closeOverlay('overlay-setup'); });

    on('btn-roll', function () { dispatch({ type: 'roll' }); });
    on('btn-buy', function () { dispatch({ type: 'buy' }); });
    on('btn-skip', function () { dispatch({ type: 'skip' }); });
    on('btn-build', function () {
      if (selectedTile != null) dispatch({ type: 'build', tile: selectedTile });
    });
    on('btn-undo', doUndo);
    on('btn-hint', doHint);
    on('btn-pause', pauseGame);
    on('btn-friends', function () { refreshFriends(); openOverlay('overlay-friends'); });
    on('btn-mirror-toggle', function () {
      doc.settings.boardMirror = !doc.settings.boardMirror;
      $('set-board-mirror').checked = doc.settings.boardMirror;
      saveDoc(); applyAllSettings();
    });
    function setDrawer(which, open) {
      var g = document.querySelector('.game-screen');
      g.classList.toggle('rail-left-open', which === 'left' && open);
      g.classList.toggle('rail-right-open', which === 'right' && open);
      var anyOpen = g.classList.contains('rail-left-open') || g.classList.contains('rail-right-open');
      $('drawer-scrim').hidden = !anyOpen;
      $('btn-album-toggle').setAttribute('aria-expanded', g.classList.contains('rail-left-open') ? 'true' : 'false');
      $('btn-news-toggle').setAttribute('aria-expanded', g.classList.contains('rail-right-open') ? 'true' : 'false');
    }
    on('btn-album-toggle', function () {
      setDrawer('left', !document.querySelector('.game-screen').classList.contains('rail-left-open'));
    });
    on('btn-news-toggle', function () {
      setDrawer('right', !document.querySelector('.game-screen').classList.contains('rail-right-open'));
    });
    // Close controls inside each drawer, plus tap-outside dismissal.
    on('btn-album-close', function () { setDrawer('left', false); });
    on('btn-news-close', function () { setDrawer('right', false); });
    on('drawer-scrim', function () { setDrawer('left', false); });

    on('btn-resume', resumeGame);
    on('btn-pause-settings', function () { populateThemes(); GfxUI.refresh(); openOverlay('overlay-settings'); });
    on('btn-pause-help', function () { refreshHelp(); openOverlay('overlay-help'); });
    on('btn-leave', function () {
      if (sess && !sess.state.terminal && sess.state.cfg.kind !== 'tutorial') {
        dispatchResign();
      } else leaveRound();
    });
    on('btn-settings-close', function () { closeOverlay('overlay-settings'); maybeResumeClock(); });
    on('btn-help-close', function () { closeOverlay('overlay-help'); maybeResumeClock(); });
    on('btn-boards-close', function () { closeOverlay('overlay-boards'); });
    on('btn-achievements-close', function () { closeOverlay('overlay-achievements'); });
    on('btn-friends-close', function () { closeOverlay('overlay-friends'); });
    on('btn-lesson-close', function () { $('lesson-card').hidden = true; });

    on('btn-results-retry', function () {
      if (setupCfg) startGame(setupCfg, setupMode, lesson);
    });
    on('btn-results-menu', function () { show('modes'); });
    on('btn-results-title', function () { show('title'); });
  }

  function dispatchResign() {
    // resign through the rules engine so the terminal reason is recorded
    var r = Game.applyToSession(sess, { type: 'resign' }, elapsedMs());
    if (r.ok) { updateHUD(); endRound(); }
    else leaveRound();
  }

  // Signed in: the cloud slot (remote wins, checksum-verified) and then the
  // settings KV (platform value wins) land before anything reads the save.
  function restoreFromPlatform() {
    return Promise.all([Platform.loadCloud(), Platform.getSettings()]).then(function (r) {
      var remote = Store.loadRaw(r[0]);
      var d = remote || Store.load();
      var kv = r[1] || {};
      Object.keys(kv).forEach(function (key) { d.settings[key] = kv[key]; });
      if (remote || Object.keys(kv).length) {
        Store.save(d);
        // Landed after bootGame (3 s timeout): adopt it in memory as well, or the
        // next saveDoc would write the stale local doc back over it.
        if (doc) { doc = Store.load(); applyAllSettings(); refreshTitle(); }
      }
    }).catch(function () { /* local save stays authoritative */ })
      .then(function () { cloudReady = true; });
  }

  function boot() {
    // platform identity (the SDK already read the token in index.html)
    try { Platform.init(); } catch (e) { /* offline */ }
    if (!Platform.hosted) { cloudReady = true; bootGame(); return; }
    Promise.race([restoreFromPlatform(), new Promise(function (r) { setTimeout(r, 3000); })]).then(bootGame, bootGame);
  }

  function bootGame() {
    doc = Store.load();

    // audio starts on first gesture (autoplay policy)
    var kick = function () {
      if (!Audio.isStarted()) Audio.start();
      document.removeEventListener('pointerdown', kick);
      document.removeEventListener('keydown', kick);
    };
    document.addEventListener('pointerdown', kick);
    document.addEventListener('keydown', kick);

    // WebGL capability
    var glOk = false;
    try {
      glOk = Render.init($('board-canvas'), { graphics: gfxSaved() });
    } catch (e) { glOk = false; }
    if (!glOk) {
      $('webgl-warning').hidden = false;
      doc.settings.boardMirror = true; // DOM mirror becomes the playable surface
    }

    bindButtons();
    bindSettings();
    bindGraphics();
    bindInput();
    applyAllSettings();
    fitCanvas();

    probeServerTime().finally(function () {
      show('title');
      rafId = requestAnimationFrame(frame);
      // refresh daily label once server offset is known
      refreshTitle();
      try {
        var wasHosted = Platform.hosted;
        Platform.onUpdate(function () {
          if (wasHosted && !Platform.hosted) toast(PT.signedOut); // renewal refused
          wasHosted = Platform.hosted;
          renderAccountLine();
        });
        renderAccountLine();
        Platform.loadBindings().then(function () { if (!$('overlay-help').hidden) refreshHelp(); });
        // Save conflict: merge the newer cloud progress into this device's,
        // adopt it and save the merge (Store.mergeProgress keeps the better of both).
        Platform.onConflict(function (raw) {
          var remote = Store.loadRaw(raw);
          if (remote && doc) doc.progress = Store.mergeProgress(doc.progress, remote.progress);
          saveDoc();
          if (currentScreen === 'title') refreshTitle();
          if (currentScreen === 'modes') refreshModes();
        });
      } catch (e) { /* offline */ }
      // deep links: #daily, #practice-<id>, #journey-<n>, #challenge-<n>
      var hash = (location.hash || '').slice(1);
      if (hash === 'daily') {
        startGame(Content.dailyConfig(Content.utcDateString(serverNowMs())), 'daily');
      } else {
        var m = /^(practice|journey|challenge)-(.+)$/.exec(hash);
        if (m) {
          var pool = m[1] === 'practice' ? Content.PRACTICE
            : m[1] === 'journey' ? Content.JOURNEY : Content.CHALLENGES;
          var cfg = pool.find(function (c) { return c.id === m[2]; }) ||
                    pool[Math.max(0, parseInt(m[2], 10) - 1)];
          if (cfg) startGame(cfg, m[1]);
        }
      }
    });

    root.addEventListener('webglcontextlost', function (e) {
      // attempt recovery by rebuilding GPU resources from CPU descriptors
      e.preventDefault && e.preventDefault();
      var wasCfg = sess ? sess.state.cfg : null;
      setTimeout(function () {
        try {
          Render.dispose();
          if (Render.init($('board-canvas'), { graphics: gfxSaved() })) {
            $('webgl-warning').hidden = true;
            if (wasCfg && sess) {
              var theme = Content.THEMES.find(function (t) { return t.id === wasCfg.theme; }) || Content.THEMES[0];
              Render.buildBoard(wasCfg, theme);
              Render.syncState(sess.state, null, { instant: true });
            }
            fitCanvas();
          }
        } catch (err) { $('webgl-warning').hidden = false; }
      }, 300);
    }, true);
  }

  // Game language changed (Settings → Language, or the account preference
  // arrived): js/i18n.js has re-applied the static markup; re-render every
  // code-built string in place. The round, clock, board and overlays stay put.
  function onLanguage() {
    PT = root.PlatformStrings.platformStrings(curLang());
    if (!doc) return;
    if (GfxUI.relocalize) GfxUI.relocalize();
    populateThemes();
    refreshTitle();
    renderAccountLine();
    if (currentScreen === 'modes') refreshModes();
    if (!$('overlay-setup').hidden) renderSetup();
    if (!$('overlay-help').hidden) refreshHelp();
    if (!$('overlay-achievements').hidden) refreshAchievements();
    if (!$('overlay-boards').hidden) refreshBoards();
    if (!$('overlay-friends').hidden) refreshFriends();
    if (sess) {
      updateHUD();
      renderBoardMirror();
      describeSelection();
      if (lesson && !$('lesson-card').hidden) showLessonCard();
      Array.prototype.forEach.call($('event-log').children, function (li) { if (li._text) li.textContent = li._text(); });
    }
    if (currentScreen === 'results') renderResults();
  }
  document.addEventListener('cf-language', onLanguage);

  root.CFUI = { boot: boot, _state: function () { return { sess: sess, doc: doc }; } };
})(typeof self !== 'undefined' ? self : this);
