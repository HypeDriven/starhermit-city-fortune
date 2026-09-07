/* City Fortune — DOM shell: screens, HUD, input, accessibility, persistence.
 * Owns the session clock; rules state changes only via CFGame session commands.
 * Browser global: CFUI (classic script; THREE is provided by js/main.js module).
 */
(function (root) {
  'use strict';

  var Game = root.CFGame, Rules = Game.rules, Content = Game.content,
      Store = Game.store, Audio = root.CFAudio, Render = root.CFRender,
      RNG = root.CFRNG;

  var $ = function (id) { return document.getElementById(id); };

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
  function fmtCoins(n) { return n + ' coins'; }
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

  function saveDoc() { Store.save(doc); }

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
    if (first) first.focus();
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
    if (f) f.focus();
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
      if (f) f.focus();
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
    $('title-progress').textContent =
      'Journey: ' + Object.keys(p.journeyStars).length + ' / ' + Content.JOURNEY.length + ' stages · ' + stars + ' stars';
    var today = Content.utcDateString(serverNowMs());
    $('title-daily').textContent = p.dailiesDone[today]
      ? 'Daily done — score ' + p.dailiesDone[today] : 'Daily challenge available';
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
      b.innerHTML = esc(lv.name) + ' <span class="stars" aria-label="' + stars + ' stars">' +
        '★'.repeat(stars) + '☆'.repeat(Math.max(0, 3 - stars)) + '</span>' +
        (lv.mastery ? ' <span class="tag">Mastery</span>' : '');
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
      b.textContent = c.name + (doc.progress.challengeBest[c.id] ? ' — best ' + doc.progress.challengeBest[c.id] : '');
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
      b.textContent = p.name;
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
      b.textContent = ls.title + (doc.progress.tutorialDone[ls.id] ? ' ✓' : '');
      b.addEventListener('click', function () { startLesson(ls); });
      li.appendChild(b);
      ll.appendChild(li);
    });
  }

  var setupCfg = null, setupMode = null;
  function openSetup(cfg, mode) {
    setupCfg = cfg; setupMode = mode;
    $('setup-title').textContent = cfg.name;
    var rows = [];
    rows.push(['Rules', describeRules(cfg)]);
    rows.push(['Expected duration', cfg.par ? '~' + Math.ceil((cfg.par.timeSec || 420) / 60) + ' min' : '—']);
    rows.push(['Players', cfg.rival ? 'You vs ' + cfg.rival.name + ' (local deterministic rival)' : 'Solo']);
    rows.push(['Assists', (cfg.mechanics.undo ? 'Undo ' : '') + (cfg.mechanics.hint ? 'Hint' : '') || 'None']);
    rows.push(['Ranked', (mode === 'daily' || mode === 'challenge') ? 'Yes' : 'No (progress only)']);
    if (cfg.intro) rows.push(['Briefing', cfg.intro]);
    $('setup-rules').innerHTML = rows.map(function (r) {
      return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>';
    }).join('');
    openOverlay('overlay-setup');
  }

  function describeRules(cfg) {
    var parts = [];
    parts.push('Complete ' + cfg.album.length + ' album page' + (cfg.album.length > 1 ? 's' : ''));
    if (cfg.turnLimit) parts.push('within ' + cfg.turnLimit + ' turns');
    if (cfg.timeLimitSec) parts.push('in ' + fmtTime(cfg.timeLimitSec * 1000));
    return parts.join(' ');
  }

  // ---------- game start ----------

  function startGame(cfg, mode, lessonObj) {
    // wall-clock seed: session ids must be unique per round, not per game clock
    sess = Game.createSession(cfg, lessonObj || null, serverNowMs());
    lesson = lessonObj || null;
    lessonStep = 0;
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
    clockStart();
    updateHUD();
    renderBoardMirror();
    if (lesson) showLessonCard();
    else $('lesson-card').hidden = true;
    announce(cfg.name + '. ' + describeRules(cfg) + '. Your turn: roll the die.');
    logEvent('Welcome to ' + cfg.name + '. ' + (cfg.intro || ''));
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
    $('lesson-title').textContent = lesson.title;
    $('lesson-text').textContent = lesson.text;
  }
  function lessonEventCheck(events) {
    if (!lesson || doc.progress.tutorialDone[lesson.id]) return;
    var goal = lesson.goal;
    var hits = events.filter(function (e) {
      return e.type === goal.event || (goal.event === 'undo' && e.type === 'undo');
    }).length;
    if (hits >= goal.count) {
      doc.progress.tutorialDone[lesson.id] = true;
      saveDoc();
      $('lesson-text').textContent = 'Lesson complete! You can keep playing this board or leave via Pause.';
      announce('Lesson complete: ' + lesson.title);
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
      'game-ended': 'This round is over.',
      'wrong-phase': 'That action is not available right now.',
      'unknown-command': 'Unknown action.',
      'malformed-command': 'That action was not understood.',
      'bad-tile': 'That tile cannot be built on.',
      'unaffordable': 'Not enough coins.',
      'not-owned': 'You do not own that property.',
      'max-level': 'Already at maximum height.',
      'undo-disabled': 'Undo is not allowed in this mode.',
      'nothing-to-undo': 'Nothing to undo.'
    };
    var msg = msgs[reason] || ('Cannot: ' + reason);
    Audio.play('invalid');
    announce(msg);
    logEvent('⚠ ' + msg, true);
  }

  function promptBuy() {
    var p = sess.state.pending;
    var tile = sess.state.cfg.tiles[p.tile];
    announce(tile.label + ' is for sale for ' + fmtCoins(p.price) + '. Buy or skip?');
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
    announce('Turn undone.');
    logEvent('↩ Undo');
  }

  function doHint() {
    if (!sess || presenting) return;
    var h = Game.hint(sess.state);
    if (!h) return;
    Audio.play('hint');
    var text = hintText(h);
    announce(text);
    logEvent('💡 ' + text);
    if (h.tile != null) { selectedTile = h.tile; syncSelection(); }
  }

  function hintText(h) {
    var s = sess.state;
    switch (h.why) {
      case 'buy-district': return 'Buy ' + s.cfg.tiles[h.tile].label + ' — it completes a protected district page.';
      case 'buy-cheap': return 'This property is affordable. Buying grows your rent income.';
      case 'skip-expensive': return 'This one is pricey. Skipping keeps coins for your districts.';
      case 'build-page': return 'Build on ' + s.cfg.tiles[h.tile].label + ' to finish the Developer page.';
      case 'build-rent': return 'You have spare coins — build on ' + s.cfg.tiles[h.tile].label + ' to raise rent.';
      default: return 'Roll the die to keep moving.';
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
    var tileName = ev.tile != null && cfg.tiles[ev.tile] ? cfg.tiles[ev.tile].label : '';
    var rn = s.rival ? s.rival.name : 'Rival';
    switch (ev.type) {
      case 'roll': return (ev.who === 'you' ? 'You' : rn) + ' rolled ' + ev.die + '.';
      case 'lap': return (ev.who === 'you' ? 'You pass' : rn + ' passes') + ' Start: +' + ev.salary + ' salary.' + (ev.tram ? ' (Express Tram)' : '');
      case 'offer': return tileName + ' is for sale — ' + fmtCoins(ev.price) + '.';
      case 'cannot-afford': return tileName + ' costs ' + fmtCoins(ev.price) + ' — you cannot afford it.';
      case 'buy': return (ev.who === 'you' ? 'You buy ' : rn + ' buys ') + tileName + ' for ' + ev.price + '.';
      case 'skip': return 'You pass on ' + tileName + '.';
      case 'rival-pass': return rn + ' passes on ' + tileName + '.';
      case 'own-visit': return (ev.who === 'you' ? 'Your own ' : rn + '’s own ') + tileName + '.';
      case 'rent': return ev.from === 'you'
        ? 'You pay ' + ev.amount + ' rent to ' + rn + ' (' + tileName + ').'
        : rn + ' pays you ' + ev.amount + ' rent (' + tileName + ').';
      case 'bonus': return (ev.who === 'you' ? '+' : rn + ' +') + ev.amount + ' bonus coins.';
      case 'toll': return (ev.who === 'you' ? 'You pay ' : rn + ' pays ') + ev.amount + ' toll.';
      case 'card': return (ev.who === 'you' ? 'You draw' : rn + ' draws') + ' “' + ev.name + '”: ' + ev.text;
      case 'card-move': return 'Moved ' + (ev.delta > 0 ? 'forward ' + ev.delta : 'back ' + (-ev.delta)) + ' tiles.';
      case 'card-skip': return 'The card deck is spent.';
      case 'deck-reshuffle': return 'The card deck is reshuffled.';
      case 'sticker': return 'Sticker collected! (' + ev.count + ')';
      case 'park': return (ev.who === 'you' ? 'You rest' : rn + ' rests') + ' in the park.';
      case 'page-complete': return 'Album page complete: ' + ev.name + ' (+' + ev.bonus + ')!';
      case 'win': return 'Album complete — you win!';
      case 'lose':
        return { 'turn-limit': 'Out of turns.', 'time-up': 'Time is up.', resigned: 'You resigned.' }[ev.reason] || 'Round over.';
      case 'undo': return 'Undone.';
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
      logEvent(text);
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
      li.textContent = (prog.done ? '✓ ' : '') + pg.name + ': ' + Math.min(prog.have, prog.need) + '/' + prog.need + ' (+' + pg.bonus + ')';
      albumEl.appendChild(li);
    });

    $('hud-turn').textContent = cfg.turnLimit
      ? 'Turn ' + (s.turn + 1) + ' / ' + cfg.turnLimit : 'Turn ' + (s.turn + 1);
    $('hud-coins').textContent = fmtCoins(s.you.coins);
    $('hud-score').textContent = 'Score ' + Rules.currentScore(s);
    $('hud-phase').textContent = s.terminal ? 'Round over'
      : s.phase === 'buy' ? 'Decide: buy or skip' : 'Your turn — roll';

    if (s.rival) {
      $('hud-rival').hidden = false;
      $('hud-rival').textContent = s.rival.name + ': ' + fmtCoins(s.rival.coins) +
        ', ' + Object.keys(s.rival.props).length + ' properties';
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

  function logEvent(text, warn) {
    var log = $('event-log');
    var li = document.createElement('li');
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
    var parts = [t.label || ('Tile ' + selectedTile), tileKindLabel(t)];
    if (t.t === 'prop') {
      var owner = Rules.ownerOf(s, selectedTile);
      if (owner === 'you') parts.push('yours, level ' + s.you.props[selectedTile]);
      else if (owner) parts.push(s.rival.name + '’s, level ' + s.rival.props[selectedTile]);
      else parts.push('unowned, price ' + t.price);
      parts.push('rent ' + t.rent.join('/'));
    }
    $('selection-desc').textContent = parts.join(' · ');
  }

  function tileKindLabel(t) {
    return { start: 'Start', prop: 'property', bonus: 'bonus +' + t.amt, toll: 'toll −' + t.amt,
             card: 'chance card', sticker: 'sticker', park: 'park' }[t.t] || t.t;
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
    announce((t.label || 'Tile ' + selectedTile) + ', ' + tileKindLabel(t) +
      (buildLegal(selectedTile).ok ? '. Build available.' : ''));
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
      var label = t.label || ('Tile ' + i);
      var parts = [i === 0 ? 'Start' : label, tileKindLabel(t)];
      if (parts[0] === parts[1]) parts.pop();   // "Start, Start" reads badly
      if (t.t === 'prop') {
        var owner = Rules.ownerOf(s, i);
        if (owner === 'you') parts.push('owned by you, level ' + s.you.props[i]);
        else if (owner) parts.push('owned by ' + s.rival.name + ', level ' + s.rival.props[i]);
        else parts.push('unowned, ' + t.price + ' coins');
      }
      if (s.you.pos === i) parts.push('you are here');
      if (s.rival && s.rival.pos === i) parts.push(s.rival.name + ' is here');
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
    announce((t.label || 'Tile ' + idx) + ', ' + tileKindLabel(t) +
      (buildLegal(idx).ok ? '. Build available (' + buildCostText(idx) + ').' : ''));
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

    // leaderboard entry (local board + server submit for daily/challenge)
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
    var serverNote = '';
    if (cfg.kind === 'daily' || cfg.kind === 'challenge') {
      submitScore(entry, sess.replay, function (msg) {
        serverNote = msg;
        var el = $('results-server');
        if (el) el.textContent = msg;
      });
    }

    showResults(s, entry, newlyUnlocked);
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

  function showResults(s, entry, newlyUnlocked) {
    var won = s.terminal.won;
    $('results-headline').textContent = won ? 'Album complete!' : 'Round over';
    $('results-reason').textContent = {
      'album-complete': 'Every album page finished with ' + Math.max(0, s.cfg.turnLimit - s.turn) + ' turns to spare.',
      'turn-limit': 'The turn limit ran out.',
      'time-up': 'The clock ran out.',
      resigned: 'You resigned.'
    }[s.terminal.reason] || '';

    var rows = [
      ['Rent collected', s.score.rent],
      ['Salary', s.score.salary],
      ['Album bonuses', s.score.album],
      ['Property value', s.score.property],
      ['Coins in hand', s.score.coins],
      ['Turn bonus', s.score.turnsBonus],
      ['Time bonus', s.score.timeBonus]
    ];
    $('results-breakdown').innerHTML = rows.map(function (r) {
      return '<tr><th scope="row">' + r[0] + '</th><td>' + r[1] + '</td></tr>';
    }).join('') + '<tr class="total"><th scope="row">Total</th><td>' + s.score.total + '</td></tr>';

    $('results-achievements').innerHTML = newlyUnlocked.map(function (k) {
      var a = Content.ACHIEVEMENTS.find(function (x) { return x.key === k; });
      return '<li>🏅 ' + esc(a ? a.name : k) + '</li>';
    }).join('');

    // next recommended action
    var next = '';
    if (s.cfg.kind === 'journey') {
      var idx = Content.JOURNEY.findIndex(function (l) { return l.id === s.cfg.id; });
      if (won && idx >= 0 && idx + 1 < Content.JOURNEY.length) {
        next = 'Next: ' + Content.JOURNEY[idx + 1].name;
        $('btn-results-next').hidden = false;
        $('btn-results-next').textContent = 'Next: ' + Content.JOURNEY[idx + 1].name;
        $('btn-results-next').onclick = function () { startGame(Content.JOURNEY[idx + 1], 'journey'); };
      } else {
        $('btn-results-next').hidden = true;
      }
    } else {
      $('btn-results-next').hidden = true;
    }
    $('results-server').textContent = '';
    $('results-progress').textContent = next || (won ? 'Well played.' : 'Try a different approach — undo and hints are available in practice.');
    show('results');
    announce($('results-headline').textContent + ' Total score ' + s.score.total + '.');
  }

  // ---------- server (optional; graceful offline) ----------

  function probeServerTime() {
    var t0 = nowMs();
    return fetch('/api/v1/time').then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    }).then(function (j) {
      var t1 = nowMs();
      if (typeof j.nowMs === 'number') {
        serverOffsetMs = j.nowMs - Math.round((t0 + t1) / 2);
      }
    }).catch(function () { serverOffsetMs = 0; });
  }

  function submitScore(entry, replay, cb) {
    fetch('/api/v1/score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entry: entry, replay: replay })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok) cb('Verified by server. Rank #' + j.rank + ' of ' + j.of + ' on this board.');
      else cb('Server rejected the score: ' + ((j && j.error) || 'unknown') + '. Kept locally.');
    }).catch(function () { cb('Offline — score saved locally.'); });
  }

  // ---------- pause / resume / leave ----------

  function pauseGame() {
    if (currentScreen !== 'game') return;
    clockStop();
    openOverlay('overlay-pause');
    announce('Paused.');
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
      logEvent('Left the round.');
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
    bindSelect('set-tier', 'graphicsTier');
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
      o.textContent = t.name + (t.unlockStars > 0 ? ' (' + t.unlockStars + '★' + (locked ? ' — locked' : '') + ')' : '');
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
      el.textContent = '♪ ' + text;
      clearTimeout(applyAllSettings._capT);
      applyAllSettings._capT = setTimeout(function () { el.textContent = ''; }, 2500);
    });
    if (Render.isAvailable()) {
      var tier = s.graphicsTier === 'auto' ? autoTier() : s.graphicsTier;
      Render.setQuality(tier);
      Render.setReducedMotion(s.reducedMotion);
      // district stripe colors are baked at build time: rebuild when they change
      var hc = s.colorPalette === 'high-visibility';
      if (hc !== appliedPaletteHC) {
        appliedPaletteHC = hc;
        Render.setPaletteHC(hc);
        if (sess) {
          var theme = Content.THEMES.find(function (t) {
            return t.id === (sess.state.cfg.theme || s.theme);
          }) || Content.THEMES[0];
          Render.buildBoard(sess.state.cfg, theme);
          Render.syncState(sess.state, null, { instant: true });
          Render.setSelection(selectedTile);
          updateActionButtons();
        }
      }
    }
  }

  function autoTier() {
    var mobile = /Mobi|Android/i.test(navigator.userAgent) || (root.innerWidth || 1024) < 720;
    return mobile ? 'low' : 'high';
  }

  // ---------- help / achievements / boards / friends ----------

  function refreshHelp() {
    var el = $('help-content');
    var bindings = [
      ['Enter / Space', 'Confirm: roll the die, or buy when a deed is offered'],
      ['Arrow keys', 'Move the selection around the board'],
      ['B', 'Buy the offered property'],
      ['N', 'Skip the offered property'],
      ['U', 'Undo (where allowed)'],
      ['H', 'Hint'],
      ['Esc', 'Pause / close panel'],
      ['M', 'Mute / unmute'],
      ['C', 'Skip animations (settle the board)']
    ];
    var cards = bindings.map(function (b) {
      return '<section class="rule-card"><h3>' + esc(b[0]) + '</h3><p>' + esc(b[1]) + '</p></section>';
    });
    var examples = '';
    if (sess) {
      var acts = Game.legalActions(sess.state);
      examples = '<section class="rule-card"><h3>Right now</h3><p>Legal actions: ' +
        esc(acts.map(function (a) {
          return a.type === 'build' ? 'build on ' + sess.state.cfg.tiles[a.tile].label + ' (' + a.cost + ')' : a.type;
        }).join(', ') || 'none') + '</p></section>';
    }
    el.innerHTML =
      '<section class="rule-card"><h3>Goal</h3><p>Roll to move around the city circuit. Buy properties, collect bonuses and stickers, build upgrades, and complete every album page before the limits.</p></section>' +
      '<section class="rule-card"><h3>Tiles</h3><p>Colored stripe = property district (icon + label in the album). Green = bonus, red = toll, blue = chance card, purple = sticker, park = safe rest.</p></section>' +
      '<section class="rule-card"><h3>Rival</h3><p>Your rival alternates turns with you. They pay rent on your buildings but can never buy property in album districts — your set progress is protected.</p></section>' +
      cards.join('') + examples;
  }

  function refreshAchievements() {
    var el = $('achievements-list');
    el.innerHTML = '';
    Content.ACHIEVEMENTS.forEach(function (a) {
      var li = document.createElement('li');
      var got = doc.progress.achievements[a.key];
      li.className = got ? 'ach got' : 'ach';
      li.innerHTML = '<strong>' + esc(a.name) + '</strong> — ' + esc(a.desc) + (got ? ' <span aria-label="unlocked">✓</span>' : '');
      el.appendChild(li);
    });
  }

  function refreshBoards() {
    var boards = Store.loadBoards();
    var sorted = Store.sortEntries(boards.entries).slice(0, 20);
    var el = $('boards-list');
    el.innerHTML = '';
    if (!sorted.length) {
      el.innerHTML = '<li>No results yet — play a round!</li>';
      return;
    }
    sorted.forEach(function (e, i) {
      var li = document.createElement('li');
      li.textContent = '#' + (i + 1) + ' ' + e.score + ' pts — ' + e.configId +
        (e.won ? ' (won)' : '') + ' · ' + fmtTime(e.durationMs);
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
      items.push('<li><strong>' + esc(sess.state.rival.name) + '</strong> (rival on this board): ' +
        esc(String(sess.state.rival.coins)) + ' coins</li>');
    }
    items.push('<li><strong>You</strong>: ' + p.stats.wins + ' wins, ' +
      Object.keys(p.journeyStars).length + ' stages cleared</li>');
    recent.forEach(function (e) {
      items.push('<li>Session ' + esc(e.sessionId) + ': ' + e.score + ' pts on ' + esc(e.configId) + '</li>');
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
  }

  function buildCostText(idx) {
    var s = sess.state;
    var lvl = s.you.props[idx];
    if (!lvl) return '';
    return Rules.buildCost(s.cfg.tiles[idx].price, lvl) + ' coins';
  }

  function onKey(e) {
    if (e.defaultPrevented) return;
    var inField = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName || '');
    if (e.key === 'Escape') {
      if (anyOverlayOpen()) { closeTopOverlay(); maybeResumeClock(); }
      else if (currentScreen === 'game') pauseGame();
      e.preventDefault();
      return;
    }
    if (inField) return;
    if (e.key === 'm' || e.key === 'M') {
      doc.settings.muted = !doc.settings.muted;
      $('set-muted').checked = doc.settings.muted;
      Audio.applySettings(doc.settings); saveDoc();
      announce(doc.settings.muted ? 'Muted.' : 'Sound on.');
      return;
    }
    if (currentScreen !== 'game' || !sess || anyOverlayOpen()) return;
    switch (e.key) {
      case 'ArrowLeft': case 'ArrowUp': cycleFocus(-1); e.preventDefault(); break;
      case 'ArrowRight': case 'ArrowDown': cycleFocus(1); e.preventDefault(); break;
      case 'Enter': case ' ':
        e.preventDefault();
        primaryAction();
        break;
      case 'b': case 'B': if (!$('btn-buy').disabled) dispatch({ type: 'buy' }); break;
      case 'n': case 'N': if (!$('btn-skip').disabled) dispatch({ type: 'skip' }); break;
      case 'u': case 'U': doUndo(); break;
      case 'h': case 'H': doHint(); break;
      case 'c': case 'C': skipPresentation(); break;
      case 'p': case 'P': pauseGame(); break;
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
    on('btn-title-achievements', function () { refreshAchievements(); openOverlay('overlay-achievements'); });
    on('btn-title-settings', function () { populateThemes(); openOverlay('overlay-settings'); });
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
    on('btn-album-toggle', function () {
      var g = document.querySelector('.game-screen');
      g.classList.toggle('rail-left-open');
      g.classList.remove('rail-right-open');
    });
    on('btn-news-toggle', function () {
      var g = document.querySelector('.game-screen');
      g.classList.toggle('rail-right-open');
      g.classList.remove('rail-left-open');
    });

    on('btn-resume', resumeGame);
    on('btn-pause-settings', function () { populateThemes(); openOverlay('overlay-settings'); });
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

  function boot() {
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
      glOk = Render.init($('board-canvas'), { quality: doc.settings.graphicsTier === 'auto' ? autoTier() : doc.settings.graphicsTier });
    } catch (e) { glOk = false; }
    if (!glOk) {
      $('webgl-warning').hidden = false;
      doc.settings.boardMirror = true; // DOM mirror becomes the playable surface
    }

    bindButtons();
    bindSettings();
    bindInput();
    applyAllSettings();
    fitCanvas();

    probeServerTime().finally(function () {
      show('title');
      rafId = requestAnimationFrame(frame);
      // refresh daily label once server offset is known
      refreshTitle();
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
          if (Render.init($('board-canvas'), {})) {
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

  root.CFUI = { boot: boot, _state: function () { return { sess: sess, doc: doc }; } };
})(typeof self !== 'undefined' ? self : this);
