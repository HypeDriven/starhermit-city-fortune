// The browser build's DOM shell (index.html + js/ui.js + css/style.css) as
// starhermit:ui, built every frame: the title over its key art, the mode
// select (Journey, Daily and Challenges, Practice and Learn), the round (the
// Album rail, the City news rail, the playfield the paper city is framed
// into, the selection line, the status row, the action tray, the board
// list and the lesson card), the results with their score breakdown, and
// the dialogs (setup, pause, settings, help, achievements, leaderboards,
// friends, and the Album and News drawers of the narrower layouts), the
// toast and the caption strip. The browser's media queries are layouts
// picked by the window's logical size: wide (≥ 1024 px: both rails
// docked), compact (the rails are drawers), phone portrait (≤ 720 px wide:
// the status row on top, the tray in rows of three) and short landscape
// (≤ 480 px tall: the Album rail docked narrow, News a drawer); the
// left-handed setting reverses the tray.
import { frame, openMenu } from "starhermit:engine";
import { bindingLabel, requestRebind } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { TextureLoader, type Texture } from "starhermit:scene";
import { Content as C, Game as G, Rules as R, Store as S } from "./classic.ts";
import { tr, N, pt } from "./i18n.ts";
import * as platform from "./platform.ts";
import * as render from "./render.ts";
import {
  app, achievementName, build, buildLegal, buy, cfgName, closeOverlay, confirmPending, copyInvite,
  describeRules, describeSelection, doHint, doUndo, elapsedMs, fmtCoins, fmtTime, leaveRound, lesson, lessonCompleted, log,
  nextJourney, openDaily, openOverlay, openSetup, pageName, pauseGame, presenting, progress, resumeGame, retry, roll, selectTile,
  selectedTile, sess, settings, signIn, skip, startFromSetup, startGame, startLesson, tileKindLabel, tileLabel, toModes, toTitle,
  today, topOverlay, totalStars,
} from "./main.ts";
import { PAPER } from "./style.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; ox: number; oy: number; wide: boolean; compact: boolean; phone: boolean; shortLand: boolean }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  const shortLand = lw > lh && lh <= 480;
  const wide = !shortLand && lw >= 1024;
  const phone = !shortLand && lw <= 720 && lh >= lw;
  return { lw, lh, sc, ox: sa.left / sc, oy: sa.top / sc, wide, compact: !wide && !phone && !shortLand, phone, shortLand };
}
const lastHeight = new Map<string, number>();

function textWidth(text: string, style: string | readonly string[], kind?: "button"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: typeof style === "string" ? style : [...style] }).width / ui.preferences().scale;
}
const buttonWidth = (text: string, style: readonly string[]): number => textWidth(text, style, "button") + 2;

interface Btn { id: string; text: string; style?: string[]; disabled?: boolean; selected?: boolean; act: () => void; content?: () => void; width?: number }
const PLAIN = ["btn"];
/** A button `width` wide (null: its text's); a label too long for it wraps inside. */
function button(b: Btn, width: number | null = null): void {
  const style = b.style ?? PLAIN;
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  if (b.selected !== undefined) opts.selected = b.selected;
  const s: ui.Style = width != null ? { width } : {};
  if (b.content) opts.content = b.content;
  else if (width != null && buttonWidth(b.text, style) > width) {
    const inner = Math.max(20, width - 24);
    opts.content = () => { ui.style({ text: { align: "center" } }).paragraph(b.text, inner); };
  }
  if (ui.style(...style, s).id(b.id).button(b.text, opts)) b.act();
}
/** Buttons at their own widths in rows that wrap at `width` (CSS flex-wrap). */
function flow(label: string, list: Btn[], width: number, align: "start" | "center" | "end" = "center", gap = 8, reverse = false): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  for (const b of list) {
    const bw = Math.min(width, b.width ?? buttonWidth(b.text, b.style ?? PLAIN));
    if (rows[rows.length - 1]!.length && used + gap + bw > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + bw;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      for (const b of reverse ? [...row].reverse() : row) button(b, b.width ?? (buttonWidth(b.text, b.style ?? PLAIN) > width ? width : null));
    }, { spacing: gap, align: "center" }));
  }, { spacing: gap, align, width });
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls: string | null = "body", id?: string, center = false): void {
  if (!text) return;
  const styles: (string | ui.Style)[] = cls ? [cls] : ["body"];
  if (center) styles.push({ text: { align: "center" } });
  let u = ui.style(...styles);
  if (id) u = u.id(id);
  if (ui.measureText(text, { style: styles }).width / ui.preferences().scale <= width) u.label(text);
  else u.paragraph(text, width);
}
function heading(cls: "h1" | "h1-small" | "h2" | "h3", text: string, width: number, id?: string, center = false): void {
  const styles: (string | ui.Style)[] = [cls];
  if (center) styles.push({ text: { align: "center" } });
  if (ui.measureText(text, { kind: "heading", style: styles }).width / ui.preferences().scale <= width) (id ? ui.id(id) : ui).style(...styles).heading(text);
  else ui.style(...styles).paragraph(text, width);
}
function kbd(action: string): string { return bindingLabel(action, "keyboard"); }

// ------------------------------------------------------------------ glyphs (no emoji or symbol fonts)
type Glyph = "star" | "starOutline" | "check" | "pause" | "smile" | "menu" | "clock" | "medal" | "note" | "close";
function starPts(cx: number, cy: number, r: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5; const rr = i % 2 ? r * 0.42 : r; pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]); }
  return pts;
}
function circle(cx: number, cy: number, r: number, color: string, w: number): void {
  let px = cx + r, py = cy;
  for (let i = 1; i <= 24; i++) { const a = (i / 24) * Math.PI * 2; const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r; draw.line(px, py, x, y, color, w); px = x; py = y; }
}
function drawGlyph(kind: Glyph, r: ui.Rect, color: string): void {
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2, s = Math.min(r.width, r.height) / 2;
  const w = Math.max(1.5, s * 0.2);
  switch (kind) {
    case "star": draw.polygon(starPts(cx, cy, s), color); break;
    case "starOutline": {
      const p = starPts(cx, cy, s);
      for (let i = 0; i < p.length; i++) { const a = p[i]!, b = p[(i + 1) % p.length]!; draw.line(a[0], a[1], b[0], b[1], color, Math.max(1, s * 0.12)); }
      break;
    }
    case "check": draw.line(cx - s * 0.7, cy, cx - s * 0.2, cy + s * 0.55, color, w); draw.line(cx - s * 0.2, cy + s * 0.55, cx + s * 0.75, cy - s * 0.6, color, w); break;
    case "pause": draw.rect(cx - s * 0.5, cy - s * 0.6, s * 0.32, s * 1.2, color); draw.rect(cx + s * 0.18, cy - s * 0.6, s * 0.32, s * 1.2, color); break;
    case "smile":
      circle(cx, cy, s * 0.85, color, w * 0.8);
      draw.roundRect(cx - s * 0.38, cy - s * 0.32, s * 0.18, s * 0.18, s * 0.09, color);
      draw.roundRect(cx + s * 0.2, cy - s * 0.32, s * 0.18, s * 0.18, s * 0.09, color);
      draw.line(cx - s * 0.42, cy + s * 0.2, cx, cy + s * 0.45, color, w * 0.8);
      draw.line(cx, cy + s * 0.45, cx + s * 0.42, cy + s * 0.2, color, w * 0.8);
      break;
    case "menu": for (const dy of [-0.55, 0, 0.55]) draw.line(cx - s * 0.75, cy + dy * s, cx + s * 0.75, cy + dy * s, color, w); break;
    case "clock":
      circle(cx, cy, s * 0.85, color, w * 0.8);
      draw.line(cx, cy, cx, cy - s * 0.55, color, w * 0.8);
      draw.line(cx, cy, cx + s * 0.4, cy, color, w * 0.8);
      break;
    case "medal":
      draw.polygon([[cx - s * 0.55, cy - s * 0.95], [cx - s * 0.15, cy - s * 0.95], [cx + s * 0.1, cy - s * 0.2], [cx - s * 0.3, cy - s * 0.2]], "#4a7fb8");
      draw.polygon([[cx + s * 0.55, cy - s * 0.95], [cx + s * 0.15, cy - s * 0.95], [cx - s * 0.1, cy - s * 0.2], [cx + s * 0.3, cy - s * 0.2]], "#b85450");
      draw.roundRect(cx - s * 0.5, cy - s * 0.25, s, s, s * 0.5, color);
      draw.polygon(starPts(cx, cy + s * 0.25, s * 0.3), "#fff3d6");
      break;
    case "note":
      draw.roundRect(cx - s * 0.65, cy + s * 0.2, s * 0.55, s * 0.45, s * 0.22, color);
      draw.line(cx - s * 0.12, cy + s * 0.4, cx - s * 0.12, cy - s * 0.7, color, w * 0.8);
      draw.line(cx - s * 0.12, cy - s * 0.7, cx + s * 0.5, cy - s * 0.4, color, w * 0.8);
      break;
    case "close": draw.line(cx - s * 0.6, cy - s * 0.6, cx + s * 0.6, cy + s * 0.6, color, w); draw.line(cx + s * 0.6, cy - s * 0.6, cx - s * 0.6, cy + s * 0.6, color, w); break;
  }
}
function glyph(kind: Glyph, size: number, color: string, label = ""): void {
  ui.widget(label, { role: label ? "image" : "none", size: { width: size, height: size }, draw: (r) => drawGlyph(kind, r, color) });
}
function stars(n: number, size: number, label: string): void {
  ui.row(`stars-${label}`, () => {
    for (let i = 0; i < 3; i++) glyph(i < n ? "star" : "starOutline", size, PAPER.accent, i === 0 ? label : "");
  }, { spacing: size * 0.15, align: "center" });
}
/** A button showing a glyph; `label` is its accessible name (and what play scripts click). */
function glyphButton(id: string, label: string, kind: Glyph, act: () => void, width: number | null = null, disabled = false): Btn {
  return { id, text: label, act, disabled, width: width ?? 56, content: () => glyph(kind, 18, PAPER.ink) };
}

// ------------------------------------------------------------------ art
let keyArt: Texture | null = null;
let resultsArt: Texture | null = null;
let artAsked = false;
function loadArt(): void {
  if (artAsked) return;
  artAsked = true;
  const loader = new TextureLoader();
  // Decorative: a missing file just leaves the art out.
  loader.loadAsync("assets/key-art.webp").then((t) => { keyArt = t; }, () => undefined);
  loader.loadAsync("assets/results-album.webp").then((t) => { resultsArt = t; }, () => undefined);
}
/** Art cover-fitted into w × h, its focus `fy` of the way down (CSS object-position). */
function art(id: string, tex: Texture | null, w: number, h: number, fy: number): void {
  if (!tex) return;
  const tw = tex.width || 1280, th = tex.height || 720;
  const k = Math.max(w / tw, h / th);
  const sw = w / k / tw, sh = h / k / th;
  const u0 = (1 - sw) / 2, v0 = (1 - sh) * fy;
  ui.column(`${id}-frame`, () => {
    ui.image("", tex, { width: w, height: h }, { min: [u0, v0], max: [u0 + sw, v0 + sh] });
  }, { style: "art-frame", clip: true, padding: 0 });
}

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  loadArt();
  const L = layoutNow();
  const f = frame();
  const playing = app.screen === "game" && !!sess;
  if (!playing) draw.rect(0, 0, f.width, f.height, PAPER.bg);
  switch (app.screen) {
    case "title": titleScreen(L); break;
    case "modes": modesScreen(L); break;
    case "game": if (sess) gameScreen(L); break;
    case "results": resultsScreen(L); break;
  }
  overlays(L);
  toasts(L, playing);
  if (app.focusNext) {
    const age = f.frame - app.openedFrame;
    if (age >= 1) ui.setFocus(app.focusNext);
    if (age >= 3) app.focusNext = null;
  }
}

/** A screen: one paper panel, centred, scrolling when taller than the window; `top` draws full-bleed above its padding (key art). */
function screen(key: string, L: Layout, maxW: number, build: (w: number) => void, center = true, top?: (pw: number) => void): void {
  const avail = Math.max(80, L.lh);
  const pw = Math.max(200, Math.min(maxW, L.lw * 0.92));
  const narrow = L.lw <= 560;
  const padX = narrow ? 16 : 24, padY = narrow ? 14 : 20;
  const w = pw - 2 * padX - 2;
  const h = lastHeight.get(key) ?? 0;
  ui.place(`scr-${key}`, { anchor: "top-start", x: 0, y: 0 }, () => {
    const body = (): void => {
      const r = ui.column(`${key}-panel`, () => {
        if (top) top(pw - 2);
        ui.column(`${key}-inner`, () => build(w), { width: pw - 2, spacing: 10, align: center ? "center" : "start", padding: { top: top ? 4 : padY, bottom: padY, start: padX, end: padX } });
      }, { style: "panel", width: pw, padding: 0, spacing: 0 });
      lastHeight.set(key, r.height / L.sc + 24);
    };
    if (h > avail) {
      ui.scrollArea(`${key}-scroll`, { width: L.lw, height: avail }, () => {
        ui.column(`${key}-scroll-col`, body, { width: L.lw - 12, align: "center", padding: { top: 12, bottom: 12 } });
      });
    } else ui.column(`${key}-center`, body, { height: avail, width: L.lw, justify: "center", align: "center" });
  }, { width: L.lw, height: avail });
}

// ------------------------------------------------------------------ title
function titleScreen(L: Layout): void {
  const p = progress();
  screen("title", L, 640, (w) => {
    heading(L.lw <= 560 ? "h1-small" : "h1", "City Fortune", w, "title-h", true);
    para(tr("A pop-up paper city. Roll, collect, complete the album."), w, "tagline", "tagline", true);
    button({ id: "btn-play", text: tr("Play"), style: ["btn", "btn-primary", "btn-big"], act: toModes }, w);
    button({ id: "btn-title-daily", text: tr("Daily challenge"), style: ["btn", "btn-big"], act: openDaily }, w);
    const done = p.dailiesDone[today()];
    para(done ? tr("Daily done — score {score}", { score: done }) : tr("Daily challenge available"), w, "muted", "title-daily", true);
    para(tr("Journey: {done} / {total} stages · {stars} stars", { done: Object.keys(p.journeyStars).length, total: C.JOURNEY.length, stars: totalStars() }), w, "muted", "title-progress", true);
    para(platform.signedIn() ? tr("Playing as {name} — connected to the platform.", { name: platform.displayName() }) : tr("Offline — progress is stored on this device."), w, "muted", "account-line", true);
    if (app.signedOut && !platform.signedIn()) para(pt("signedOut"), w, "small", "signed-out", true);
    const nav: Btn[] = [
      { id: "btn-title-boards", text: tr("Leaderboards"), act: () => openOverlay("boards") },
      { id: "btn-title-achievements", text: tr("Achievements"), act: () => openOverlay("achievements") },
      { id: "btn-title-settings", text: tr("Settings"), act: () => openOverlay("settings") },
      { id: "btn-title-help", text: tr("Help"), act: () => openOverlay("help") },
    ];
    if (platform.inviteLink()) nav.push({ id: "btn-title-invite", text: pt("invite"), act: () => void copyInvite() });
    if (!platform.signedIn()) nav.push({ id: "btn-title-signin", text: pt("signIn"), style: ["btn", "btn-primary"], act: signIn });
    flow("title-nav", nav, w);
  }, true, keyArt && L.lh > 420 ? (pw) => {
    const ah = Math.min(L.lh * (L.lh <= 600 ? 0.24 : L.lw <= 560 ? 0.26 : 0.38), 300, pw * 9 / 16);
    art("title-art", keyArt, pw, ah, 0.62);
  } : undefined);
}

// ------------------------------------------------------------------ modes
function listButton(id: string, text: string, w: number, act: () => void, extra?: () => void, disabled = false): void {
  const opts: ui.ButtonOptions = { disabled };
  if (extra) opts.content = () => ui.row(`${id}-face`, () => { ui.label(text); extra(); }, { spacing: 6, align: "center" });
  if (ui.style("list-btn", { width: w }).id(id).button(text, opts)) act();
}
function modesScreen(L: Layout): void {
  const p = progress();
  screen("modes", L, 900, (w) => {
    heading(L.lw <= 560 ? "h1-small" : "h1", tr("Choose a mode"), w, "modes-h");
    const cols = Math.max(1, Math.min(3, Math.floor((w + 18) / (220 + 18))));
    const cw = (w - 18 * (cols - 1)) / cols;
    const journey = (): unknown => ui.column("journey-col", () => {
      heading("h2", tr("Journey"), cw);
      C.JOURNEY.forEach((lv, i) => {
        const st = p.journeyStars[lv.id] || 0;
        const unlocked = i === 0 || (p.journeyStars[C.JOURNEY[i - 1]!.id] || 0) > 0;
        listButton(`journey-${i}`, tr(lv.name), cw, () => openSetup(lv, "journey"), () => {
          stars(st, 13, tr(st === 1 ? "{n} star" : "{n} stars", { n: st }));
          if (lv.mastery) ui.style("tag").label(tr("Mastery"));
        }, !unlocked);
      });
    }, { width: cw, spacing: 6 });
    const daily = (): unknown => ui.column("daily-col", () => {
      heading("h2", tr("Daily"), cw);
      para(tr("One shared seed per UTC day."), cw, "muted");
      button({ id: "btn-modes-daily", text: tr("Play today’s daily"), act: openDaily });
      heading("h2", tr("Challenges"), cw);
      C.CHALLENGES.forEach((c, i) => {
        const best = p.challengeBest[c.id];
        listButton(`challenge-${i}`, tr(c.name) + (best ? " — " + tr("best {score}", { score: best }) : ""), cw, () => openSetup(c, "challenge"));
      });
    }, { width: cw, spacing: 6 });
    const practice = (): unknown => ui.column("practice-col", () => {
      heading("h2", tr("Practice"), cw);
      C.PRACTICE.forEach((pr, i) => listButton(`practice-${i}`, tr(pr.name), cw, () => openSetup(pr, "practice")));
      heading("h2", tr("Learn"), cw);
      C.tutorialLessons().forEach((ls, i) => {
        const done = !!p.tutorialDone[ls.id];
        listButton(`lesson-${i}`, tr(ls.title), cw, () => startLesson(ls), done ? () => glyph("check", 14, PAPER.ink, tr("unlocked")) : undefined);
      });
    }, { width: cw, spacing: 6 });
    const parts = [journey, daily, practice];
    for (let i = 0; i < parts.length; i += cols) {
      ui.row(`modes-r${i}`, () => { for (const fn of parts.slice(i, i + cols)) fn(); }, { spacing: 18, align: "start", width: w });
    }
    button({ id: "btn-modes-back", text: tr("Back"), act: toTitle });
  }, false);
}

// ------------------------------------------------------------------ the round
let logLen = 0;
function albumRail(w: number): void {
  const s = sess!.state;
  heading("h2", tr("Album"), w, "hud-objective");
  for (const pg of s.cfg.album) {
    const prog = G.pageProgress(s, pg);
    const text = pageName(pg) + ": " + Math.min(prog.have, prog.need) + "/" + prog.need + " (+" + pg.bonus + ")";
    const cls = prog.done ? (settings.colorPalette === "high-visibility" ? "page-done-hc" : "page-done") : "page";
    ui.row(`page-${pg.id}`, () => {
      if (prog.done) glyph("check", 13, settings.colorPalette === "high-visibility" ? "#0077b6" : "#2e7d32", tr("unlocked"));
      para(text, w - (prog.done ? 20 : 0), cls + "-text");
    }, { spacing: 6, align: "center", width: w, style: cls });
  }
  if (s.rival) {
    const nProps = Object.keys(s.rival.props).length;
    para(tr(nProps === 1 ? "{name}: {coins}, {n} property" : "{name}: {coins}, {n} properties", { name: s.rival.name, coins: fmtCoins(s.rival.coins), n: nProps }), w, "muted", "hud-rival");
  }
}
function newsRail(w: number, h: number): void {
  heading("h2", tr("City news"), w);
  const scroll = log.length !== logLen;
  logLen = log.length;
  ui.scrollArea("event-log", { width: w + 10, height: Math.max(60, h) }, () => {
    ui.column("event-log-col", () => {
      log.forEach((l, i) => ui.column(`log-${i}`, () => para(l.text(), w - 4, l.warn ? "warn-text" : "log-text"), { width: w - 4, style: l.warn ? "log-warn" : "log-item" }));
    }, { width: w, spacing: 0 });
  }, scroll ? { scrollTo: { top: Infinity } } : undefined);
}
function statusItems(): { id: string; text: string; clock?: boolean }[] {
  const s = sess!.state, cfg = s.cfg;
  const items: { id: string; text: string; clock?: boolean }[] = [
    { id: "hud-phase", text: s.terminal ? tr("Round over") : s.phase === "buy" ? tr("Decide: buy or skip") : tr("Your turn — roll") },
    { id: "hud-turn", text: cfg.turnLimit ? tr("Turn {n} / {limit}", { n: s.turn + 1, limit: cfg.turnLimit }) : tr("Turn {n}", { n: s.turn + 1 }) },
  ];
  if (cfg.timeLimitSec) items.push({ id: "hud-timer", text: fmtTime(cfg.timeLimitSec * 1000 - elapsedMs()), clock: true });
  items.push({ id: "hud-coins", text: fmtCoins(s.you.coins) });
  items.push({ id: "hud-score", text: tr("Score {n}", { n: R.currentScore(s) }) });
  return items;
}
function statusRow(w: number): void {
  const items = statusItems();
  const inner = w - 26;
  const rows: typeof items[] = [[]];
  let used = 0;
  for (const it of items) {
    const iw = textWidth(it.text, "status-item") + (it.clock ? 20 : 0);
    if (rows[rows.length - 1]!.length && used + 14 + iw > inner) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? 14 : 0) + iw;
    rows[rows.length - 1]!.push(it);
  }
  ui.column("status-row", () => {
    rows.forEach((row, ri) => ui.row(`status-r${ri}`, () => {
      for (const it of row) {
        if (it.clock) ui.row(`${it.id}-row`, () => { glyph("clock", 15, PAPER.ink, tr("Time left")); ui.style("status-item").id(it.id).label(it.text); }, { spacing: 4, align: "center" });
        else ui.style("status-item").id(it.id).label(it.text);
      }
    }, { spacing: 14, align: "center" }));
  }, { style: "status-row", width: w, spacing: 2 });
}
function trayButtons(L: Layout): Btn[] {
  const s = sess!.state;
  const over = !!s.terminal;
  const lock = presenting || over || !!app.overlays.length;
  const list: Btn[] = [
    { id: "btn-roll", text: tr("Roll"), style: ["btn", "btn-primary"], disabled: lock || s.phase !== "roll", act: roll },
    { id: "btn-buy", text: confirmPending === "buy" ? tr("Confirm buy") : tr("Buy"), disabled: lock || s.phase !== "buy", act: buy },
    { id: "btn-skip", text: tr("Skip"), disabled: lock || s.phase !== "buy", act: skip },
    { id: "btn-build", text: confirmPending && confirmPending.startsWith("build") ? tr("Confirm build") : tr("Build"), disabled: lock || s.phase !== "roll" || !buildLegal(selectedTile), act: build },
    { id: "btn-undo", text: tr("Undo"), disabled: lock || !s.cfg.mechanics.undo || !sess!.undoStack.length, act: doUndo },
    { id: "btn-hint", text: tr("Hint"), disabled: lock || !s.cfg.mechanics.hint, act: doHint },
    glyphButton("btn-pause", tr("Pause"), "pause", pauseGame),
    glyphButton("btn-friends", tr("Friends"), "smile", () => openOverlay("friends", "btn-friends-close")),
    glyphButton("btn-mirror-toggle", tr("Toggle board list"), "menu", () => platform.setSetting("boardMirror", !settings.boardMirror)),
  ];
  if (!L.wide && !L.shortLand) list.push({ id: "btn-album-toggle", text: tr("Album"), act: () => openOverlay("album", "btn-album-close") });
  if (!L.wide) list.push({ id: "btn-news-toggle", text: tr("News"), act: () => openOverlay("news", "btn-news-close") });
  return list;
}
function tray(L: Layout, w: number): void {
  const list = trayButtons(L);
  if (L.phone) {
    // thumb tray: rows of three equal buttons (the last row's leftovers share it)
    const gap = 6;
    const rowsOf: Btn[][] = [];
    for (let i = 0; i < list.length; i += 3) rowsOf.push(list.slice(i, i + 3));
    ui.column("tray", () => {
      rowsOf.forEach((row, ri) => ui.row(`tray-r${ri}`, () => {
        const bw = (w - gap * (row.length - 1)) / row.length;
        for (const b of settings.leftHanded ? [...row].reverse() : row) button({ ...b, width: bw }, bw);
      }, { spacing: gap }));
    }, { spacing: gap, width: w });
  } else flow("tray", list, w, "center", 8, settings.leftHanded);
}
function mirrorText(i: number): string {
  const s = sess!.state;
  const t = s.cfg.tiles[i]!;
  const parts = [i === 0 ? tr("Start") : tileLabel(t, i), tileKindLabel(t)];
  if (parts[0] === parts[1]) parts.pop();
  if (t.t === "prop") {
    const owner = R.ownerOf(s, i);
    if (owner === "you") parts.push(tr("owned by you, level {n}", { n: s.you.props[i]! }));
    else if (owner) parts.push(tr("owned by {name}, level {n}", { name: s.rival!.name, n: s.rival!.props[i]! }));
    else parts.push(tr("unowned, {coins}", { coins: fmtCoins(t.price) }));
  }
  if (s.you.pos === i) parts.push(tr("you are here"));
  if (s.rival && s.rival.pos === i) parts.push(tr("{name} is here", { name: s.rival.name }));
  return parts.join(", ");
}
function boardMirror(w: number, h: number): void {
  const s = sess!.state;
  ui.scrollArea("board-mirror", { width: w, height: h }, () => {
    ui.column("board-mirror-col", () => {
      s.cfg.tiles.forEach((_t, i) => {
        const text = mirrorText(i);
        const here = s.you.pos === i;
        if (ui.style("mirror-tile", { width: w - 24 }, here ? { text: { color: PAPER.accent, weight: "700" } } : null).id(`tile-${i}`).button(text, {
          selected: selectedTile === i,
          content: () => ui.style(here ? "mirror-here" : "body", { text: { size: 13.6 } }).paragraph(text, w - 44),
        }) && !presenting) selectTile(i);
      });
    }, { width: w - 16, spacing: 2 });
  }, { style: "mirror" });
}
function lessonCard(w: number): void {
  if (!lesson) return;
  const text = progress().tutorialDone[lesson.id] && lessonCompleted
    ? tr("Lesson complete! You can keep playing this board or leave via Pause.") : tr(lesson.text);
  const inner = w - 36;
  ui.column("lesson-card", () => {
    heading("h3", tr(lesson!.title), inner, "lesson-title");
    para(text, inner, "body", "lesson-text");
    button({ id: "btn-lesson-close", text: tr("Got it"), act: () => { app.lessonCardHidden = true; } });
  }, { style: "lesson-card", width: w, spacing: 6 });
}

function gameScreen(L: Layout): void {
  const f = frame();
  const pad = L.phone ? 6 : 10, gap = L.phone ? 6 : 10;
  const leftW = L.wide ? Math.max(170, Math.min(240, L.lw * 0.18)) : L.shortLand ? 150 : 0;
  const rightW = L.wide ? leftW : 0;
  const cx = pad + (leftW ? leftW + gap : 0);
  const cw = L.lw - cx - pad - (rightW ? rightW + gap : 0);
  const railH = L.lh - 2 * pad;
  if (leftW) {
    ui.place("rail-left", { anchor: "top-start", x: pad, y: pad }, () => {
      ui.scrollArea("rail-left-scroll", { width: leftW - 24, height: railH - 22 }, () => ui.column("album-col", () => albumRail(leftW - 36), { width: leftW - 34, spacing: 2 }));
    }, { style: "rail", width: leftW, height: railH });
  }
  if (rightW) {
    ui.place("rail-right", { anchor: "top-start", x: L.lw - pad - rightW, y: pad }, () => {
      newsRail(rightW - 34, railH - 70);
    }, { style: "rail", width: rightW, height: railH, spacing: 6 });
  }
  // top of the centre column: the status row (phone portrait) and the lesson card
  let topH = 0;
  const showLesson = !!lesson && !app.lessonCardHidden;
  if (L.phone || showLesson) {
    const r = ui.place("center-top", { anchor: "top-start", x: cx, y: pad }, () => {
      if (L.phone) statusRow(cw);
      if (showLesson) ui.column("lesson-wrap", () => lessonCard(Math.min(cw, 620)), { width: cw, align: "center" });
    }, { width: cw, spacing: gap });
    topH = r.height / L.sc + gap;
  }
  // bottom: selection line, board list, status row, tray
  const mirrorOn = !!settings.boardMirror;
  // The board list takes what the playfield can spare (it keeps at least 40 % of the height).
  const rest = lastHeight.get("game-rest") ?? 200;
  const mirrorH = Math.max(72, Math.min(240, L.lh * 0.3, L.lh * 0.6 - rest));
  const desc = describeSelection();
  const b = ui.place("center-bottom", { anchor: "bottom-start", x: cx, y: pad }, () => {
    para(desc || " ", cw, "selection-desc", "selection-desc");
    if (mirrorOn) boardMirror(cw, L.shortLand ? Math.min(mirrorH, L.lh * 0.3) : mirrorH);
    if (!L.phone) statusRow(cw);
    tray(L, cw);
  }, { width: cw, spacing: L.phone ? 6 : 6 });
  const bottomH = b.height / L.sc + gap;
  lastHeight.set("game-rest", topH + bottomH + 2 * pad - (mirrorOn ? mirrorH + 6 : 0));
  // the playfield between them
  const py = pad + topH;
  const fieldH = Math.max(40, L.lh - py - pad - bottomH);
  const X = (L.ox + cx) * L.sc, Y = (L.oy + py) * L.sc, Wd = cw * L.sc, Hd = fieldH * L.sc;
  render.setPlayfield(X, Y, Wd, Hd, f.width, f.height);
  // the page around the playfield (the 3D view fills the window behind the UI)
  const bg = PAPER.bg;
  draw.rect(0, 0, f.width, Y, bg);
  draw.rect(0, Y + Hd, f.width, f.height - Y - Hd, bg);
  draw.rect(0, Y, X, Hd, bg);
  draw.rect(X + Wd, Y, f.width - X - Wd, Hd, bg);
  draw.strokeRoundRect(X, Y, Wd, Hd, 10 * L.sc, PAPER.line, Math.max(1, L.sc));
}

// ------------------------------------------------------------------ results
function resultsScreen(L: Layout): void {
  const r = app.results;
  if (!r) { toTitle(); return; }
  const s = r.s;
  const won = !!s.terminal?.won;
  screen("results", L, 640, (w) => {
    heading(L.lw <= 560 ? "h1-small" : "h1", won ? tr("Album complete!") : tr("Round over"), w, "results-headline", true);
    const spare = Math.max(0, s.cfg.turnLimit - s.turn);
    const reasons: Record<string, string> = {
      "album-complete": tr(spare === 1 ? "Every album page finished with {n} turn to spare." : "Every album page finished with {n} turns to spare.", { n: spare }),
      "turn-limit": tr("The turn limit ran out."),
      "time-up": tr("The clock ran out."),
      resigned: tr("You resigned."),
    };
    para(reasons[s.terminal?.reason ?? ""] ?? "", w, "body", "results-reason", true);
    const bw = Math.min(w, 360);
    const rows: [string, number][] = [
      [tr("Rent collected"), s.score.rent], [tr("Salary"), s.score.salary], [tr("Album bonuses"), s.score.album],
      [tr("Property value"), s.score.property], [tr("Coins in hand"), s.score.coins], [tr("Turn bonus"), s.score.turnsBonus], [tr("Time bonus"), s.score.timeBonus],
    ];
    ui.column("results-breakdown", () => {
      rows.forEach(([k, v], i) => ui.row(`bd-${i}`, () => { para(k, bw - 90, "bd-label"); ui.spacer(); ui.style("bd-value").label(String(v)); }, { style: "breakdown-row", width: bw, align: "center" }));
      ui.row("bd-total", () => { ui.style("bd-strong").label(tr("Total")); ui.spacer(); ui.style("bd-strong").id("results-total").label(String(s.score.total)); }, { style: "breakdown-total", width: bw, align: "center" });
    }, { width: bw, spacing: 0 });
    if (r.unlocked.length) {
      ui.column("results-ach", () => {
        for (const k of r.unlocked) ui.row(`ach-${k}`, () => { glyph("medal", 16, PAPER.accent); ui.label(achievementName(k)); }, { style: "ach-chip", spacing: 6, align: "center" });
      }, { spacing: 6, align: "center", width: w });
    }
    const next = nextJourney();
    para(next ? tr("Next: {name}", { name: tr(next.name) }) : won ? tr("Well played.") : tr("Try a different approach — undo and hints are available in practice."), w, "muted", "results-progress", true);
    if (app.lb) para(app.lb.state === "lbRank" ? pt("lbRank", { rank: app.lb.rank ?? "" }) : pt(app.lb.state), w, "muted", "results-server", true);
    const btns: Btn[] = [];
    if (next) btns.push({ id: "btn-results-next", text: tr("Next: {name}", { name: tr(next.name) }), style: ["btn", "btn-primary"], act: () => startGame(next, "journey") });
    btns.push({ id: "btn-results-retry", text: tr("Retry"), act: retry });
    btns.push({ id: "btn-results-menu", text: tr("Modes"), act: toModes });
    btns.push({ id: "btn-results-title", text: tr("Title"), act: toTitle });
    flow("results-buttons", btns, w);
  }, true, resultsArt && L.lh > 560 ? (pw) => art("results-art", resultsArt, pw, Math.min(L.lh * (L.lw <= 560 ? 0.16 : 0.24), 180, pw / 3), 0.45) : undefined);
}

// ------------------------------------------------------------------ dialogs
function dialogFrame(label: string, L: Layout, maxW: number, build: (w: number) => void, onClose: () => void = () => closeOverlay()): void {
  const w = Math.min(maxW, L.lw - 24) - 48;
  const avail = L.lh - 24 - 48;
  const h = lastHeight.get(`dlg-${label}`) ?? 0;
  const body = (): void => {
    const r = ui.column(`${label}-body`, () => build(w), { spacing: 10, width: w });
    lastHeight.set(`dlg-${label}`, r.height / L.sc);
  };
  // A dialog opens at its top (heading visible), whatever it focuses.
  const fresh = frame().frame - app.openedFrame <= 4;
  const open = ui.dialog(label, "", true, () => {
    if (h > avail) ui.scrollArea(`${label}-scroll`, { width: w + 14, height: avail }, body, fresh ? { scrollTo: { top: 0 } } : undefined);
    else body();
  });
  // The Escape (or East) that opened it must not close it the same frame.
  if (!open && frame().frame !== app.openedFrame) onClose();
}
function overlays(L: Layout): void {
  // Each open dialog is drawn, innermost last (Settings over Pause).
  for (const o of app.overlays) {
    const top = o === topOverlay();
    if (!top) continue; // input reaches only the innermost; the outer one reopens when it closes
    switch (o) {
      case "setup": setupDialog(L); break;
      case "pause": pauseDialog(L); break;
      case "settings": settingsDialog(L); break;
      case "help": helpDialog(L); break;
      case "achievements": achievementsDialog(L); break;
      case "boards": boardsDialog(L); break;
      case "friends": friendsDialog(L); break;
      case "album":
        if (!sess) { closeOverlay(); break; }
        dialogFrame("drawer-album", L, 320, (w) => {
          albumRail(w);
          button({ id: "btn-album-close", text: tr("Close album"), act: () => closeOverlay() }, w);
        });
        break;
      case "news":
        if (!sess) { closeOverlay(); break; }
        dialogFrame("drawer-news", L, 340, (w) => {
          newsRail(w - 10, Math.min(360, L.lh * 0.5));
          button({ id: "btn-news-close", text: tr("Close news"), act: () => closeOverlay() }, w);
        });
        break;
    }
  }
}
function setupDialog(L: Layout): void {
  const cfg = app.setupCfg;
  if (!cfg) { closeOverlay(); return; }
  const mode = app.setupMode;
  dialogFrame("overlay-setup", L, 560, (w) => {
    heading("h2", cfgName(cfg), w, "setup-title");
    const assists: string[] = [];
    if (cfg.mechanics.undo) assists.push(tr("Undo"));
    if (cfg.mechanics.hint) assists.push(tr("Hint"));
    const rows: [string, string][] = [
      [tr("Rules"), describeRules(cfg)],
      [tr("Expected duration"), cfg.par ? tr("~{n} min", { n: Math.ceil((cfg.par.timeSec || 420) / 60) }) : "—"],
      [tr("Players"), cfg.rival ? tr("You vs {name} (local deterministic rival)", { name: cfg.rival.name }) : tr("Solo")],
      [tr("Assists"), assists.join(" ") || tr("None")],
      [tr("Ranked"), mode === "daily" || mode === "challenge" ? tr("Yes") : tr("No (progress only)")],
    ];
    if (cfg.intro) rows.push([tr("Briefing"), tr(cfg.intro)]);
    for (const [k, v] of rows) {
      ui.column(`setup-${k}`, () => { para(k, w, "dt"); para(v, w, "dd"); }, { spacing: 2, width: w });
    }
    flow("setup-buttons", [
      { id: "btn-setup-start", text: tr("Start"), style: ["btn", "btn-primary"], act: startFromSetup },
      { id: "btn-setup-cancel", text: tr("Cancel"), act: () => closeOverlay() },
    ], w);
  });
}
function pauseDialog(L: Layout): void {
  dialogFrame("overlay-pause", L, 380, (w) => {
    heading("h2", tr("Paused"), w, "pause-h");
    button({ id: "btn-resume", text: tr("Resume"), style: ["btn", "btn-primary"], act: resumeGame }, w);
    button({ id: "btn-pause-settings", text: tr("Settings"), act: () => openOverlay("settings") }, w);
    button({ id: "btn-pause-help", text: tr("Help"), act: () => openOverlay("help") }, w);
    button({ id: "btn-leave", text: tr("Leave round"), act: leaveRound }, w);
  }, resumeGame);
}
function check(key: "captions" | "leftHanded" | "haptics" | "boardMirror" | "confirmMoves", label: string): void {
  const cur = !!settings[key];
  const next = ui.id(`set-${key}`).checkbox(label, cur);
  if (next !== cur) platform.setSetting(key, next);
}
function fieldset(id: string, legend: string, w: number, build: (inner: number) => void): void {
  ui.column(id, () => { ui.style("legend").label(legend); build(w - 30); }, { style: "fieldset", width: w, spacing: 6 });
}
function selectRow(id: string, label: string, w: number, index: number, options: (string | ui.SelectOption)[], set: (i: number) => void): void {
  ui.row(`${id}-row`, () => {
    para(label, Math.max(80, w * 0.42), "field-label");
    ui.spacer();
    const next = ui.id(id).select(label, index, options);
    if (next !== index) set(next);
  }, { width: w, align: "center", spacing: 10 });
}
function settingsDialog(L: Layout): void {
  dialogFrame("overlay-settings", L, 560, (w) => {
    heading("h2", tr("Settings"), w, "settings-h");
    fieldset("fs-audio", tr("Audio"), w, (inner) => {
      para(tr("Music, effects and voice volumes and mute are set in the StarHermit Options (F1)."), inner, "muted");
      button({ id: "btn-options-audio", text: tr("Open Options"), act: () => openMenu() });
      check("captions", tr("Captions for sounds"));
    });
    fieldset("fs-graphics", tr("Graphics"), w, (inner) => {
      para(tr("Graphics quality, render scale and the frame rate are set in the StarHermit Options (F1)."), inner, "muted");
      const st = totalStars();
      const ids = C.THEMES.map((t) => t.id);
      const opts = C.THEMES.map((t) => {
        const locked = st < (t.unlockStars || 0);
        return { text: tr(t.name) + (t.unlockStars > 0 ? ` (${t.unlockStars}★${locked ? " — " + tr("locked") : ""})` : ""), disabled: locked };
      });
      selectRow("set-theme", tr("Theme"), inner, Math.max(0, ids.indexOf(settings.theme)), opts, (i) => { if (!opts[i]!.disabled) platform.setSetting("theme", ids[i]!); });
      const pal = ["standard", "high-visibility"];
      selectRow("set-palette", tr("Color palette"), inner, Math.max(0, pal.indexOf(settings.colorPalette)), [tr("Standard"), tr("High visibility")], (i) => platform.setSetting("colorPalette", pal[i]!));
    });
    fieldset("fs-a11y", tr("Accessibility & controls"), w, (inner) => {
      check("leftHanded", tr("Left-handed controls"));
      check("haptics", tr("Haptics"));
      check("boardMirror", tr("Always show board list"));
      check("confirmMoves", tr("Confirm buys and builds"));
      para(tr("Reduced motion, high contrast and text size are set in the StarHermit Options (F1)."), inner, "muted");
      button({ id: "btn-rebind", text: tr("Change keys and buttons"), act: () => requestRebind() });
    });
    button({ id: "btn-settings-close", text: tr("Done"), style: ["btn", "btn-primary"], act: () => closeOverlay("settings") });
  });
}
function card(id: string, title: string, text: string, w: number): void {
  ui.column(id, () => { para(title, w - 26, "rule-title"); para(text, w - 26, "rule-text"); }, { style: "rule-card", width: w, spacing: 4 });
}
function helpDialog(L: Layout): void {
  dialogFrame("overlay-help", L, 720, (w) => {
    heading("h2", tr("How to play"), w, "help-h");
    const cols = w >= 440 ? 2 : 1;
    const cw = (w - 10 * (cols - 1)) / cols;
    const k = kbd;
    const cards: [string, string][] = [
      [tr("Goal"), tr("Roll to move around the city circuit. Buy properties, collect bonuses and stickers, build upgrades, and complete every album page before the limits.")],
      [tr("Tiles"), tr("Colored stripe = property district (icon + label in the album). Green = bonus, red = toll, blue = chance card, purple = sticker, park = safe rest.")],
      [tr("Rival"), tr("Your rival alternates turns with you. They pay rent on your buildings but can never buy property in album districts — your set progress is protected.")],
      [k("confirm"), tr("Confirm: roll the die, or buy when a deed is offered")],
      [k("prev") + " · " + k("next"), tr("Move the selection around the board")],
      [k("buy"), tr("Buy the offered property")],
      [k("skip"), tr("Skip the offered property")],
      [k("undo"), tr("Undo (where allowed)")],
      [k("hint"), tr("Hint")],
      [k("cancel") + " · " + k("pause"), tr("Pause / close panel")],
      [k("settle"), tr("Skip animations (settle the board)")],
    ];
    if (sess) {
      const acts = G.legalActions(sess.state);
      const names: Record<string, string> = { roll: N("roll"), buy: N("buy"), skip: N("skip"), build: N("build"), resign: N("resign"), timeout: N("timeout") };
      const list = acts.map((a) => a.type === "build" ? tr("build on {tile} ({cost})", { tile: tileLabel(sess!.state.cfg.tiles[a.tile!], a.tile!), cost: a.cost ?? 0 }) : names[a.type] ? tr(names[a.type]!) : a.type).join(", ") || tr("none");
      cards.push([tr("Right now"), tr("Legal actions: {list}", { list })]);
    }
    for (let i = 0; i < cards.length; i += cols) {
      ui.row(`help-r${i}`, () => { cards.slice(i, i + cols).forEach(([t, x], j) => card(`help-${i + j}`, t, x, cw)); }, { spacing: 10, align: "stretch" });
    }
    button({ id: "btn-help-close", text: tr("Close"), style: ["btn", "btn-primary"], act: () => closeOverlay("help") });
  });
}
function achievementsDialog(L: Layout): void {
  const p = progress();
  dialogFrame("overlay-achievements", L, 560, (w) => {
    heading("h2", tr("Achievements"), w, "ach-h");
    for (const a of C.ACHIEVEMENTS) {
      const got = !!p.achievements[a.key];
      ui.row(`ach-${a.key}`, () => {
        para(tr(a.name) + " — " + tr(a.desc), w - 30, "body");
        if (got) glyph("check", 16, PAPER.ink, tr("unlocked"));
      }, { style: got ? "ach-got" : "ach", width: w, spacing: 8, align: "center" });
    }
    button({ id: "btn-achievements-close", text: tr("Close"), style: ["btn", "btn-primary"], act: () => closeOverlay("achievements") });
  });
}
function boardsDialog(L: Layout): void {
  dialogFrame("overlay-boards", L, 560, (w) => {
    heading("h2", tr("Leaderboards"), w, "boards-h");
    const rows = app.boardRows;
    if (rows && rows.length) {
      heading("h3", tr("Platform board"), w);
      rows.forEach((e, i) => para(`#${i + 1} ${e.score} — ${e.name}`, w, "body", `board-${i}`));
      para(tr("— local results below —"), w, "muted");
    }
    const sorted = S.sortEntries(S.loadBoards().entries).slice(0, 20);
    if (!sorted.length) { if (!rows || !rows.length) para(tr("No results yet — play a round!"), w, "body", "boards-empty"); }
    else sorted.forEach((e, i) => para(`#${i + 1} ${tr("{n} pts", { n: e.score })} — ${e.configId}${e.won ? " (" + tr("won") + ")" : ""} · ${fmtTime(e.durationMs)}`, w, "body", `local-${i}`));
    button({ id: "btn-boards-close", text: tr("Close"), style: ["btn", "btn-primary"], act: () => closeOverlay("boards") });
  });
}
function friendsDialog(L: Layout): void {
  const p = progress();
  dialogFrame("overlay-friends", L, 480, (w) => {
    heading("h2", tr("Friends"), w, "friends-h");
    if (sess && sess.state.rival) para(sess.state.rival.name + " " + tr("(rival on this board): {coins}", { coins: fmtCoins(sess.state.rival.coins) }), w, "body");
    para(tr("You") + ": " + tr("{wins} wins, {stages} stages cleared", { wins: p.stats.wins, stages: Object.keys(p.journeyStars).length }), w, "body");
    for (const e of S.loadBoards().entries.slice(-5).reverse()) para(tr("Session {id}: {n} pts on {config}", { id: e.sessionId, n: e.score, config: e.configId }), w, "body");
    button({ id: "btn-friends-close", text: tr("Close"), style: ["btn", "btn-primary"], act: () => closeOverlay("friends") });
  });
}

// ------------------------------------------------------------------ toast and captions
function toasts(L: Layout, playing: boolean): void {
  const bottom = playing ? (L.phone ? 230 : 130) : 20;
  if (app.caption) {
    const text = tr(app.caption.text);
    ui.place("captions", { anchor: "bottom", y: bottom + (app.toast ? 56 : 0) + 4 }, () => {
      ui.row("caption-row", () => { glyph("note", 12, "#ffffff"); ui.style({ text: { color: "#ffffff", size: 14.4 } }).id("caption-text").label(text); }, { spacing: 4, align: "center" });
    }, { style: "captions" });
  }
  if (!app.toast) return;
  const text = app.toast.text();
  const w = Math.min(L.lw - 32, 512);
  ui.place("toast", { anchor: "bottom", y: bottom }, () => {
    if (textWidth(text, "toast") + 40 <= w) ui.style("toast").id("toast").label(text);
    else ui.style("toast").id("toast").paragraph(text, w - 34);
  }, { width: w, align: "center" });
}
