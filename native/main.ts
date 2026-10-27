// City Fortune on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules, content, session (undo, replay log),
// save document and local board are the browser build's js/*.js, unchanged
// in what they decide; this module is what js/ui.js did around them —
// navigation (title → modes → the setup dialog → the round ⇄ pause →
// results → next stage / retry / modes / title), the command pipeline with
// its invalid-action explanations and haptics, the event presentation (one
// beat of sound, news line, announcement and board animation per rules
// event, shorter with reduced motion, flushed by Skip animations), the tile
// selection (pointer, the board list, the arrow keys) with Build on a
// selected tile, Undo and Hint, the round clock and time limits, the
// lessons and their goals, the results with stars, bests, achievements, the
// local board and posting to the high-score board, the City news log, the
// Friends panel, captions and toasts, and the lifecycle (a hidden window
// pauses the clock, as the browser build's visibilitychange did).
// The screens and HUD are drawn by screens.ts (starhermit:ui), the paper
// city by render.ts (starhermit:scene).
//
// Time is the runtime's fixed steps (60 a second): the round clock and the
// presentation beats count them, so pauses, a hidden window and slow frames
// never cost time and play scripts replay exactly.
import "./classic.ts";
import { frame, onFixedUpdate, onPreferencesChange, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate, clipboard } from "starhermit:engine";
import { onAction, onPointerButton, onTouch, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded, onPlayerChange, requestSignIn } from "starhermit:platform";
import {
  Content as C, Game as G, Rules as R, Store as S,
  type Achievement, type BoardEntry, type Cfg, type Cmd, type Ev, type Lesson, type Page, type Session, type State, type Theme, type Tile,
} from "./classic.ts";
import * as audio from "./audio.ts";
import { tr, N, pt, onLocaleChange } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens } from "./screens.ts";
import { initStyles } from "./style.ts";

export type ScreenName = "title" | "modes" | "game" | "results";
export type OverlayName = "setup" | "pause" | "settings" | "help" | "achievements" | "boards" | "friends" | "album" | "news";
export type Mode = "journey" | "challenge" | "practice" | "daily" | "learn";
export interface Toast { text: () => string; until: number }
export interface LogLine { text: () => string; warn: boolean }

const STEP_MS = 1000 / 60;
export const app = {
  screen: "title" as ScreenName,
  /** Open dialogs, innermost last (Settings and Help open over Pause). */
  overlays: [] as OverlayName[],
  /** Frame the screen or top dialog opened on (the press that opened it must not also act on it). */
  openedFrame: 0,
  focusNext: null as string | null,
  setupCfg: null as Cfg | null,
  setupMode: "journey" as Mode,
  toast: null as Toast | null,
  caption: null as { text: string; until: number } | null,
  results: null as { s: State; entry: BoardEntry; unlocked: string[] } | null,
  lb: null as { state: "lbPosting" | "lbRank" | "lbPosted" | "lbNotPosted"; rank?: number | null } | null,
  boardRows: null as { name: string; score: string }[] | null,
  boardNote: "",
  signedOut: false,
  lessonCardHidden: false,
};
export const settings = platform.settings;
export let sess: Session | null = null;
export let lesson: Lesson | null = null;
export let lessonCompleted = false;
export let selectedTile: number | null = null;
export let presenting = false;
/** A buy or build waiting for its second press ("Confirm buys and builds"). */
export let confirmPending: string | null = null;
export const log: LogLine[] = [];
let clockMs = 0;
let suspended = false;
const now = (): number => frame().time;

// ------------------------------------------------------------------ text helpers
export function districtName(d: string): string { return C.DISTRICTS[d] ? tr(C.DISTRICTS[d]!.label) : d; }
export function tileLabel(t: Tile | undefined, i: number): string {
  if (!t) return "";
  if (t.t === "prop" && t.d) {
    const m = /(\d+)$/.exec(t.label || "");
    return tr("{district} {n}", { district: districtName(t.d), n: m ? m[1]! : "" });
  }
  if (t.label) return tr(t.label);
  return tr("Tile {n}", { n: i });
}
export function tileKindLabel(t: Tile): string {
  const v = { n: t.amt ?? 0 };
  const map: Record<string, string> = {
    start: tr("Start"), prop: tr("property"), bonus: tr("bonus +{n}", v), toll: tr("toll −{n}", v),
    card: tr("chance card"), sticker: tr("sticker"), park: tr("park"),
  };
  return map[t.t] ?? t.t;
}
export function pageName(pg: Page | undefined): string {
  if (!pg) return "";
  if (pg.type === "district" && pg.d) return tr("{district} set", { district: districtName(pg.d) });
  return tr(pg.name);
}
export function cfgName(cfg: Cfg | null): string {
  if (!cfg) return "";
  if (cfg.kind === "daily" && cfg.date) return tr("Daily {date}", { date: cfg.date });
  return tr(cfg.name);
}
export function fmtCoins(n: number): string { return tr("{n} coins", { n }); }
export function fmtTime(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}
export function describeRules(cfg: Cfg): string {
  const n = cfg.album.length;
  const base = tr(n === 1 ? "Complete {n} album page" : "Complete {n} album pages", { n });
  if (cfg.turnLimit && cfg.timeLimitSec) return tr("{goal} within {turns} turns in {time}", { goal: base, turns: cfg.turnLimit, time: fmtTime(cfg.timeLimitSec * 1000) });
  if (cfg.turnLimit) return tr("{goal} within {turns} turns", { goal: base, turns: cfg.turnLimit });
  if (cfg.timeLimitSec) return tr("{goal} in {time}", { goal: base, time: fmtTime(cfg.timeLimitSec * 1000) });
  return base;
}
export function announce(text: string, kind: "status" | "error" = "status"): void {
  if (text) ui.announce(text.slice(0, 500), { politeness: kind === "error" ? "assertive" : "polite" });
}
/** A toast (3.5 s); `text` re-reads in the current language. */
export function toast(text: () => string): void {
  app.toast = { text, until: now() + 3.5 };
  announce(text());
}
function haptic(): void { if (settings.haptics) vibrate(12); }
export function progress(): ReturnType<typeof platform.getDoc>["progress"] { return platform.getDoc().progress; }
export function totalStars(): number { let n = 0; for (const v of Object.values(progress().journeyStars)) n += v; return n; }
export function today(): string { return C.utcDateString(platform.nowMs()); }
export function elapsedMs(): number { return clockMs; }

// ------------------------------------------------------------------ navigation
export function showScreen(name: ScreenName, focus: string | null = null): void {
  app.screen = name;
  app.openedFrame = frame().frame;
  app.focusNext = focus;
  ui.setFocus(null);
  render.setActive(name === "game" && !!sess);
}
export function topOverlay(): OverlayName | null { return app.overlays[app.overlays.length - 1] ?? null; }
export function openOverlay(name: OverlayName, focus: string | null = null): void {
  if (app.overlays.includes(name)) return;
  app.overlays.push(name);
  app.openedFrame = frame().frame;
  app.focusNext = focus;
  if (name === "boards") refreshBoard();
  if (name === "settings") ensureTheme();
  audio.play("ui");
}
export function closeOverlay(name?: OverlayName): void {
  const o = name ?? topOverlay();
  if (!o) return;
  app.overlays = app.overlays.filter((x) => x !== o);
  app.openedFrame = frame().frame;
}
export function toTitle(): void {
  sess = null; lesson = null;
  app.overlays = [];
  render.clear();
  showScreen("title", "btn-play");
}
export function toModes(): void {
  app.overlays = [];
  if (app.screen !== "game") { sess = null; lesson = null; render.clear(); }
  showScreen("modes", "journey-0");
}

// ------------------------------------------------------------------ setup and starting a round
export function openSetup(cfg: Cfg, mode: Mode): void {
  app.setupCfg = cfg; app.setupMode = mode;
  openOverlay("setup", "btn-setup-start");
}
export function openDaily(): void { openSetup(C.dailyConfig(today()), "daily"); }
export function startFromSetup(): void {
  closeOverlay("setup");
  if (app.setupCfg) startGame(app.setupCfg, app.setupMode);
}
function themeFor(cfg: Cfg): Theme {
  return C.THEMES.find((t) => t.id === (cfg.theme || settings.theme)) || C.THEMES[0]!;
}
export function startGame(cfg: Cfg, mode: Mode, lessonObj: Lesson | null = null): void {
  // wall-clock seed: session ids must be unique per round, not per game clock
  sess = G.createSession(cfg, lessonObj, platform.nowMs());
  lesson = lessonObj;
  lessonCompleted = false;
  app.lessonCardHidden = false;
  selectedTile = null;
  confirmPending = null;
  clockMs = 0;
  presenting = false;
  queue = null;
  app.results = null;
  app.lb = null;
  // Retry always replays what is actually on screen (journey "Next", lessons)
  app.setupCfg = cfg; app.setupMode = mode;
  app.overlays = [];
  log.length = 0;
  render.buildBoard(cfg, themeFor(cfg));
  render.syncState(sess.state, null, true);
  render.setSelection(null);
  showScreen("game", null);
  updateHighlights();
  announce(tr("{name}. {rules}. Your turn: roll the die.", { name: cfgName(cfg), rules: describeRules(cfg) }));
  logEvent(() => tr("Welcome to {name}.", { name: cfgName(cfg) }) + (cfg.intro ? " " + tr(cfg.intro) : ""));
  // a lesson may open directly on a deed offer: surface it like any other
  if (sess.state.phase === "buy" && sess.state.pending) promptBuy();
}
export function startLesson(ls: Lesson): void { startGame(ls.cfg, "learn", ls); }

// ------------------------------------------------------------------ the news log
/** text: re-read in the current language each frame. */
export function logEvent(text: () => string, warn = false): void {
  log.push({ text, warn });
  while (log.length > 30) log.shift();
}

// ------------------------------------------------------------------ lessons
function lessonEventCheck(events: Ev[]): void {
  if (!lesson || progress().tutorialDone[lesson.id]) return;
  const goal = lesson.goal;
  const hits = events.filter((e) => e.type === goal.event).length;
  if (hits >= goal.count) {
    progress().tutorialDone[lesson.id] = true;
    platform.persist();
    lessonCompleted = true;
    app.lessonCardHidden = false;
    announce(tr("Lesson complete: {title}", { title: tr(lesson.title) }));
    audio.play("page");
  }
}

// ------------------------------------------------------------------ commands
export function canAct(): boolean { return !!sess && app.screen === "game" && !app.overlays.length && !presenting && !sess.state.terminal; }
function trayFocused(): boolean {
  const f = ui.focused();
  return !!f && [tr("Roll"), tr("Buy"), tr("Skip"), tr("Build"), tr("Confirm buy"), tr("Confirm build")].includes(f);
}
let refocus = false;
export function dispatch(cmd: Cmd): void {
  if (!sess || presenting || sess.state.terminal) return;
  refocus = trayFocused();
  confirmPending = null;
  const r = G.applyToSession(sess, cmd, clockMs);
  if (!r.ok) { explainInvalid(r.reason ?? "unknown-command"); return; }
  audio.play("ui");
  haptic();
  const events = r.events ?? [];
  presentEvents(events, () => {
    if (!sess) return;
    if (lesson) lessonEventCheck(events);
    if (sess.state.terminal) endRound();
    else if (sess.state.phase === "buy") promptBuy();
    else if (isTimeUp()) handleTimeUp();
    if (refocus && sess && !sess.state.terminal) ui.setFocus(sess.state.phase === "buy" ? "btn-buy" : "btn-roll");
  });
}
/** Buy / build: with "Confirm buys and builds" on, the first press asks and the second commits. */
export function confirmed(kind: string): boolean {
  if (!settings.confirmMoves) return true;
  if (confirmPending === kind) { confirmPending = null; return true; }
  confirmPending = kind;
  announce(tr("Press again to confirm."));
  return false;
}
export function buy(): void { if (canAct() && sess!.state.phase === "buy" && confirmed("buy")) dispatch({ type: "buy" }); }
export function skip(): void { if (canAct() && sess!.state.phase === "buy") dispatch({ type: "skip" }); }
export function roll(): void { if (canAct() && sess!.state.phase === "roll") dispatch({ type: "roll" }); }
export function build(): void {
  if (!canAct() || selectedTile == null) return;
  if (confirmed("build:" + selectedTile)) dispatch({ type: "build", tile: selectedTile });
}

export function explainInvalid(reason: string): void {
  const msgs: Record<string, string> = {
    "game-ended": N("This round is over."),
    "wrong-phase": N("That action is not available right now."),
    "unknown-command": N("Unknown action."),
    "malformed-command": N("That action was not understood."),
    "bad-tile": N("That tile cannot be built on."),
    unaffordable: N("Not enough coins."),
    "not-owned": N("You do not own that property."),
    "max-level": N("Already at maximum height."),
    "undo-disabled": N("Undo is not allowed in this mode."),
    "nothing-to-undo": N("Nothing to undo."),
  };
  const text = (): string => (msgs[reason] ? tr(msgs[reason]!) : tr("Cannot: {reason}", { reason }));
  audio.play("invalid");
  announce(text(), "error");
  logEvent(text, true);
}
function promptBuy(): void {
  const p = sess!.state.pending!;
  const tile = sess!.state.cfg.tiles[p.tile];
  announce(tr("{tile} is for sale for {price}. Buy or skip?", { tile: tileLabel(tile, p.tile), price: fmtCoins(p.price) }));
  selectTileQuiet(p.tile);
}
function isTimeUp(): boolean {
  const tl = sess!.state.cfg.timeLimitSec;
  return !!tl && clockMs >= tl * 1000 && !sess!.state.terminal;
}
function handleTimeUp(): void {
  const r = G.applyToSession(sess!, { type: "timeout" }, clockMs);
  if (r.ok) presentEvents(r.events ?? [], () => endRound());
}
export function doUndo(): void {
  if (!sess || presenting || app.overlays.length) return;
  const r = G.undo(sess);
  if (!r.ok) { explainInvalid(r.reason ?? "nothing-to-undo"); return; }
  audio.play("undo");
  selectedTile = null;
  confirmPending = null;
  render.clearOwnership();
  render.syncState(sess.state, null, true);
  render.setSelection(null);
  updateHighlights();
  if (lesson) lessonEventCheck([{ type: "undo" }]);
  announce(tr("Turn undone."));
  logEvent(() => "↩ " + tr("Undo"));
}
export function doHint(): void {
  if (!sess || presenting || app.overlays.length || sess.state.terminal) return;
  if (!sess.state.cfg.mechanics.hint) return;
  const h = G.hint(sess.state);
  if (!h) return;
  audio.play("hint");
  announce(hintText(h));
  logEvent(() => hintText(h));
  if (h.tile != null) selectTileQuiet(h.tile);
}
function hintText(h: { why: string; tile?: number }): string {
  const s = sess!.state;
  const t = h.tile != null ? tileLabel(s.cfg.tiles[h.tile], h.tile) : "";
  switch (h.why) {
    case "buy-district": return tr("Buy {tile} — it completes a protected district page.", { tile: t });
    case "buy-cheap": return tr("This property is affordable. Buying grows your rent income.");
    case "skip-expensive": return tr("This one is pricey. Skipping keeps coins for your districts.");
    case "build-page": return tr("Build on {tile} to finish the Developer page.", { tile: t });
    case "build-rent": return tr("You have spare coins — build on {tile} to raise rent.", { tile: t });
    default: return tr("Roll the die to keep moving.");
  }
}

// ------------------------------------------------------------------ event presentation
const EVENT_SFX: Record<string, string | null> = {
  roll: "dice", lap: "salary", offer: "select", buy: "buy", skip: "skip",
  build: "build", bonus: "bonus", toll: "toll", card: "card", sticker: "sticker",
  "page-complete": "page", win: "win", lose: "lose", rent: null,
  "cannot-afford": "invalid", "deck-reshuffle": "ui", park: "hop", "own-visit": "hop",
  "start-visit": "hop", "rival-pass": "rival", "rival-idle": "rival", "card-skip": "ui",
  "card-move": "hop", timeout: "lose",
};
export function eventText(ev: Ev): string {
  const s = sess!.state, cfg = s.cfg;
  const tileName = ev.tile != null && cfg.tiles[ev.tile] ? tileLabel(cfg.tiles[ev.tile], ev.tile) : "";
  const rn = s.rival ? s.rival.name : tr("Rival");
  const you = ev.who === "you";
  const v = { rival: rn, tile: tileName, price: ev.price ?? 0, amount: ev.amount ?? 0, die: ev.die ?? 0, salary: ev.salary ?? 0 };
  switch (ev.type) {
    case "roll": return you ? tr("You rolled {die}.", v) : tr("{rival} rolled {die}.", v);
    case "lap": return (you ? tr("You pass Start: +{salary} salary.", v) : tr("{rival} passes Start: +{salary} salary.", v)) + (ev.tram ? " (" + tr("Express Tram") + ")" : "");
    case "offer": return tr("{tile} is for sale — {coins}.", { tile: tileName, coins: fmtCoins(ev.price ?? 0) });
    case "cannot-afford": return tr("{tile} costs {coins} — you cannot afford it.", { tile: tileName, coins: fmtCoins(ev.price ?? 0) });
    case "buy": return you ? tr("You buy {tile} for {price}.", v) : tr("{rival} buys {tile} for {price}.", v);
    case "skip": return tr("You pass on {tile}.", v);
    case "rival-pass": return tr("{rival} passes on {tile}.", v);
    case "own-visit": return you ? tr("Your own {tile}.", v) : tr("{rival}’s own {tile}.", v);
    case "rent": return ev.from === "you" ? tr("You pay {amount} rent to {rival} ({tile}).", v) : tr("{rival} pays you {amount} rent ({tile}).", v);
    case "bonus": return you ? tr("+{amount} bonus coins.", v) : tr("{rival} +{amount} bonus coins.", v);
    case "toll": return you ? tr("You pay {amount} toll.", v) : tr("{rival} pays {amount} toll.", v);
    case "card": return tr(you ? "You draw “{card}”: {text}" : "{rival} draws “{card}”: {text}", { rival: rn, card: tr(ev.name ?? ""), text: tr(ev.text ?? "") });
    case "card-move": return (ev.delta ?? 0) > 0 ? tr("Moved forward {n} tiles.", { n: ev.delta ?? 0 }) : tr("Moved back {n} tiles.", { n: -(ev.delta ?? 0) });
    case "card-skip": return tr("The card deck is spent.");
    case "deck-reshuffle": return tr("The card deck is reshuffled.");
    case "sticker": return tr("Sticker collected! ({n})", { n: ev.count ?? 0 });
    case "park": return you ? tr("You rest in the park.") : tr("{rival} rests in the park.", v);
    case "page-complete": {
      const pg = cfg.album.find((x) => x.id === ev.page);
      return tr("Album page complete: {name} (+{bonus})!", { name: pg ? pageName(pg) : tr(ev.name ?? ""), bonus: ev.bonus ?? 0 });
    }
    case "win": return tr("Album complete — you win!");
    case "lose": {
      const m: Record<string, string> = { "turn-limit": N("Out of turns."), "time-up": N("Time is up."), resigned: N("You resigned.") };
      return tr(m[ev.reason ?? ""] ?? N("Round over."));
    }
    case "undo": return tr("Undone.");
    default: return ev.type;
  }
}
interface Queue { events: Ev[]; i: number; wait: number; done: () => void }
let queue: Queue | null = null;
let skipping = false;
function presentEvents(events: Ev[], done: () => void): void {
  presenting = true;
  skipping = false;
  queue = { events, i: 0, wait: 0, done };
}
/** One beat: the next event's sound, news line, announcement and board change. */
function presentStep(): void {
  const q = queue;
  if (!q || !sess) { queue = null; presenting = false; return; }
  while (q.wait <= 0) {
    if (q.i >= q.events.length) {
      queue = null;
      presenting = false;
      skipping = false;
      render.settle();
      render.syncState(sess.state, null, true);
      updateHighlights();
      q.done();
      return;
    }
    const ev = q.events[q.i++]!;
    let sfx = EVENT_SFX[ev.type] ?? null;
    if (ev.type === "rent") sfx = ev.from === "you" ? "rent-pay" : "rent-get";
    if (ev.type === "roll" && ev.who === "rival") sfx = "rival";
    if (sfx) audio.play(sfx);
    const e = ev;
    logEvent(() => eventText(e));
    if (!skipping) announce(eventText(ev));
    render.syncState(sess.state, [ev], skipping || preferences().reducedMotion);
    q.wait = skipping ? 0 : Math.round((preferences().reducedMotion ? 60 : 320) / STEP_MS);
  }
  q.wait--;
}
/** Flush the remaining event beats and settle the board into its end state. */
export function skipPresentation(): void {
  skipping = true;
  if (queue) queue.wait = 0;
  render.settle();
}

// ------------------------------------------------------------------ selection
export function updateHighlights(): void {
  if (!sess || sess.state.terminal || sess.state.phase !== "roll") { render.setHighlights([]); return; }
  render.setHighlights(G.legalActions(sess.state).filter((a) => a.type === "build").map((a) => a.tile!));
}
export function buildLegal(idx: number | null): boolean {
  if (!sess || idx == null) return false;
  return G.legalActions(sess.state).some((a) => a.type === "build" && a.tile === idx);
}
export function buildCostText(idx: number): string {
  const s = sess!.state;
  const lvl = s.you.props[idx];
  if (!lvl) return "";
  return fmtCoins(R.buildCost(s.cfg.tiles[idx]!.price, lvl));
}
function selectTileQuiet(idx: number | null): void {
  selectedTile = idx;
  confirmPending = null;
  render.setSelection(idx);
}
/** Single selection entry point shared by the board, the board list and the keys. */
export function selectTile(idx: number | null): void {
  if (!sess) return;
  selectTileQuiet(idx);
  if (idx == null) { audio.play("deselect"); return; }
  audio.play("select");
  const t = sess.state.cfg.tiles[idx]!;
  announce(tileLabel(t, idx) + ", " + tileKindLabel(t) + (buildLegal(idx) ? ". " + tr("Build available ({cost}).", { cost: buildCostText(idx) }) : ""));
}
export function describeSelection(): string {
  if (!sess || selectedTile == null) return "";
  const s = sess.state;
  const t = s.cfg.tiles[selectedTile]!;
  const parts = [tileLabel(t, selectedTile), tileKindLabel(t)];
  if (t.t === "prop") {
    const owner = R.ownerOf(s, selectedTile);
    if (owner === "you") parts.push(tr("yours, level {n}", { n: s.you.props[selectedTile]! }));
    else if (owner) parts.push(tr("{name}’s, level {n}", { name: s.rival!.name, n: s.rival!.props[selectedTile]! }));
    else parts.push(tr("unowned, price {n}", { n: t.price }));
    parts.push(tr("rent {list}", { list: t.rent.join("/") }));
  }
  return parts.join(" · ");
}
function cycleFocus(dir: number): void {
  if (!sess) return;
  const n = sess.state.cfg.tiles.length;
  const from = selectedTile ?? sess.state.you.pos;
  selectTile((((from + dir) % n) + n) % n);
}

// ------------------------------------------------------------------ round end and results
function endRound(): void {
  const s = sess!.state;
  const won = !!s.terminal!.won;
  const cfg = s.cfg;
  const p = progress();
  p.stats.rounds++;
  p.stats.rentCollected += s.stats.rentCollected;
  p.stats.builds += s.stats.builds;
  p.stats.laps += s.you.laps;
  p.stats.pages += Object.keys(s.albumDone).length;
  const unlocked: string[] = [];
  if (won) {
    p.stats.wins++;
    if (cfg.kind === "journey") {
      let stars = 1;
      if (cfg.par && s.turn <= cfg.par.turns) stars++;
      if (cfg.par && cfg.par.timeSec && clockMs <= cfg.par.timeSec * 1000) stars++;
      p.journeyStars[cfg.id] = Math.max(p.journeyStars[cfg.id] || 0, stars);
      p.journeyBest[cfg.id] = Math.max(p.journeyBest[cfg.id] || 0, s.score.total);
    }
    if (cfg.kind === "challenge") p.challengeBest[cfg.id] = Math.max(p.challengeBest[cfg.id] || 0, s.score.total);
    if (cfg.kind === "daily" && cfg.date) p.dailiesDone[cfg.date] = Math.max(p.dailiesDone[cfg.date] || 0, s.score.total);
  }
  checkAchievements(s, unlocked);
  platform.persist();
  const entry: BoardEntry = {
    sessionId: sess!.id, configId: cfg.id, kind: cfg.kind,
    contentVersion: cfg.version, seed: cfg.seed >>> 0,
    won, score: s.score.total, invalid: sess!.invalidCount,
    durationMs: clockMs, assists: assistsUsed(cfg),
    date: cfg.date || null, atMs: platform.nowMs(),
  };
  const boards = S.loadBoards();
  boards.entries.push(entry);
  if (boards.entries.length > 200) boards.entries = boards.entries.slice(-200);
  S.saveBoards(boards);
  app.results = { s, entry, unlocked };
  app.overlays = [];
  showScreen("results", "btn-results-next");
  if (!(won && nextJourney())) app.focusNext = "btn-results-retry";
  announce((won ? tr("Album complete!") : tr("Round over")) + " " + tr("Total score {n}.", { n: s.score.total }));
  if (cfg.kind !== "tutorial") postToLeaderboard(s.score.total);
}
function assistsUsed(cfg: Cfg): string {
  const a: string[] = [];
  if (cfg.mechanics.hint) a.push("hint");
  if (cfg.mechanics.undo) a.push("undo");
  return a.join(",") || "none";
}
function checkAchievements(s: State, out: string[]): void {
  const p = progress();
  const unlock = (k: string): void => {
    if (p.achievements[k]) return;
    p.achievements[k] = platform.nowMs();
    out.push(k);
    audio.play("star");
  };
  if (Object.keys(s.you.props).length) unlock("first-buy");
  if (Object.keys(s.albumDone).length) unlock("first-page");
  if (s.terminal && s.terminal.won) unlock("first-win");
  if (p.stats.rentCollected >= 500) unlock("rent-500");
  if (p.stats.builds >= 25) unlock("builds-25");
  const journeyDone = Object.keys(p.journeyStars).length;
  if (journeyDone >= 20) unlock("journey-half");
  if (journeyDone >= C.JOURNEY.length) unlock("journey-done");
  if (Object.keys(p.dailiesDone).length >= 7) unlock("daily-7");
  if (s.score.total >= 4000) unlock("score-4000");
  if (p.stats.laps >= 50) unlock("laps-50");
}
export function achievementName(k: string): string {
  const a: Achievement | undefined = C.ACHIEVEMENTS.find((x) => x.key === k);
  return a ? tr(a.name) : k;
}
/** The journey stage after the one just won, if any. */
export function nextJourney(): Cfg | null {
  const r = app.results;
  if (!r || r.s.cfg.kind !== "journey" || !r.s.terminal?.won) return null;
  const idx = C.JOURNEY.findIndex((l) => l.id === r.s.cfg.id);
  return idx >= 0 && idx + 1 < C.JOURNEY.length ? C.JOURNEY[idx + 1]! : null;
}
export function retry(): void { if (app.setupCfg) startGame(app.setupCfg, app.setupMode, lesson); }
/** Signed in: every non-lesson round posts its total; the results show the rank. */
function postToLeaderboard(total: number): void {
  app.lb = null;
  if (!platform.signedIn()) return;
  const line = { state: "lbPosting" as const };
  app.lb = line;
  void platform.postLeaderboard(total).then((r) => {
    if (app.lb !== line) return;
    app.lb = { state: !r.posted ? "lbNotPosted" : r.rank ? "lbRank" : "lbPosted", rank: r.rank };
  });
}

// ------------------------------------------------------------------ pause, leave
export function pauseGame(): void {
  if (app.screen !== "game" || !sess || app.overlays.length) return;
  openOverlay("pause", "btn-resume");
  announce(tr("Paused."));
}
export function resumeGame(): void {
  app.overlays = [];
  app.openedFrame = frame().frame;
}
export function leaveRound(): void {
  // Abandoning a ranked or journey round resigns through the rules (recorded as a result);
  // a lesson simply ends.
  if (sess && !sess.state.terminal && sess.state.cfg.kind !== "tutorial") {
    const r = G.applyToSession(sess, { type: "resign" }, clockMs);
    queue = null; presenting = false;
    if (r.ok) { endRound(); return; }
  }
  app.overlays = [];
  toTitle();
}

// ------------------------------------------------------------------ settings, boards, platform
/** Themes unlock with journey stars; a locked choice falls back to the first. */
export function ensureTheme(): void {
  const cur = C.THEMES.find((t) => t.id === settings.theme);
  if (!cur || totalStars() < (cur.unlockStars || 0)) {
    if (settings.theme !== C.THEMES[0]!.id) platform.setSetting("theme", C.THEMES[0]!.id);
  }
}
export function refreshBoard(): void {
  app.boardRows = null;
  app.boardNote = "";
  void platform.fetchLeaderboard().then((r) => {
    app.boardRows = r.entries.map((e) => ({ name: e.name, score: tr("{n} pts", { n: e.score }) }));
  });
}
export async function copyInvite(): Promise<void> {
  const link = platform.inviteLink();
  let ok = false;
  if (link) { try { clipboard.writeText(link); ok = true; } catch { ok = false; } }
  toast(() => (ok ? pt("inviteCopied") : pt("inviteFailed")));
}
export function signIn(): void { void requestSignIn().catch(() => undefined); }

// ------------------------------------------------------------------ input
onAction((e) => {
  if (!e.pressed) return;
  const fresh = frame().frame !== app.openedFrame;
  const top = topOverlay();
  if (top) {
    // Escape closes the innermost dialog (the pause menu resumes); the dialogs' own Back handling is in screens.ts.
    return;
  }
  if (app.screen !== "game") {
    if (e.action === "cancel" && fresh && app.screen === "modes") { audio.play("ui"); toTitle(); }
    return;
  }
  if (!sess) return;
  switch (e.action) {
    case "pause": pauseGame(); return;
    case "cancel": if (fresh) pauseGame(); return;
    case "undo": doUndo(); return;
    case "hint": doHint(); return;
    case "settle": skipPresentation(); return;
    default: break;
  }
  if (sess.state.terminal) return;
  switch (e.action) {
    case "prev": ui.setFocus(null); cycleFocus(-1); break;
    case "next": ui.setFocus(null); cycleFocus(1); break;
    case "buy": buy(); break;
    case "skip": skip(); break;
    case "confirm":
      // A focused widget (a tray button, a board-list tile) acts by itself.
      if (ui.focused()) break;
      primaryAction();
      break;
  }
});
/** Enter / A: buy the offered deed, build on a selected buildable tile, else roll. */
function primaryAction(): void {
  if (!canAct()) return;
  const s = sess!.state;
  if (s.phase === "buy") { buy(); return; }
  if (selectedTile != null && buildLegal(selectedTile)) { build(); return; }
  roll();
}

// Board taps select a tile (a tap, not a drag: within 12 px and 600 ms).
let down: { x: number; y: number; at: number } | null = null;
let lastTouch = -1e9;
function boardDown(x: number, y: number): void { down = app.screen === "game" && sess && !app.overlays.length && !ui.pointerOver() ? { x, y, at: now() } : null; }
function boardUp(x: number, y: number): void {
  const d = down;
  down = null;
  if (!d || !sess || presenting || app.overlays.length || app.screen !== "game") return;
  if (Math.hypot(x - d.x, y - d.y) > 12 * frame().scale || now() - d.at > 0.6) return;
  const idx = render.pick(x, y);
  selectTile(idx);
}
onPointerButton((e) => {
  if (e.button !== 0 || now() - lastTouch < 0.6) return;
  if (e.pressed) boardDown(e.x, e.y); else boardUp(e.x, e.y);
});
onTouch((e) => {
  if (!e.primary) return;
  lastTouch = now();
  if (e.phase === "start") boardDown(e.x, e.y);
  else if (e.phase === "end") boardUp(e.x, e.y);
  else if (e.phase === "cancel") down = null;
});

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}

onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  audio.loadSfx();
  audio.onCaption((text) => { if (settings.captions) app.caption = { text, until: now() + 2.5 }; });
  render.setReducedMotion(preferences().reducedMotion);
  render.setPaletteHC(settings.colorPalette === "high-visibility");
  applyLook();
  toTitle();
});
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));
platform.onSettingsChange(() => render.setPaletteHC(settings.colorPalette === "high-visibility"));
onLocaleChange(() => { if (topOverlay() === "boards") refreshBoard(); });
onSessionEnded(() => { app.signedOut = true; toast(() => pt("signedOut")); });
onPlayerChange((p) => { if (p) app.signedOut = false; });
onSuspend(() => { suspended = true; platform.flush(); });
onResume(() => { suspended = false; });

onFixedUpdate(() => {
  if (suspended || !sess || app.screen !== "game") return;
  if (presenting) presentStep();
  // The round clock runs while nothing covers the board (the browser build stopped it under its dialogs).
  if (!sess.state.terminal && !app.overlays.length) {
    clockMs += STEP_MS;
    if (!presenting && isTimeUp()) handleTimeUp();
  }
});

let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  audio.update();
  const t0 = now();
  if (app.toast && app.toast.until < t0) app.toast = null;
  if (app.caption && t0 > app.caption.until) app.caption = null;
});
onRender(() => {
  drawScreens();
  render.update(frameDt);
});
