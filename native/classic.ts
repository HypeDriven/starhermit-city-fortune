// The browser build's pure game scripts, shared with the Node tests and the
// verifying server.js: the seeded random streams, the rules, the content,
// the save document and local board (store), the session with undo and
// replay (game), the string tables (js/*.js, UMD), evaluated as classic
// scripts so their globals are this module's exports.
//
// js/store.js keeps the device's local leaderboard in `localStorage`: here
// that is a small shim over the device's starhermit:storage, installed
// before the scripts run. Progress itself is the game's save (platform.ts).
import { storage } from "starhermit:storage";
import { loadClassic } from "starhermit:script";

const shim = {
  getItem(key: string): string | null {
    try { return storage.getText(key); } catch { return null; }
  },
  setItem(key: string, value: string): void {
    try { storage.set(key, String(value)); } catch (e) { console.warn(`storage ${key}: ${String(e)}`); }
  },
  removeItem(key: string): void {
    try { storage.remove(key); } catch { /* gone */ }
  },
};
(globalThis as unknown as { localStorage: typeof shim }).localStorage = shim;

for (const f of ["js/rng.js", "js/rules.js", "js/content.js", "js/store.js", "js/game.js", "js/strings.js", "js/i18n.js", "js/platform-strings.js"]) loadClassic(f);

// -- The shapes this client reads -------------------------------------------------
export type TileKind = "start" | "prop" | "bonus" | "toll" | "card" | "sticker" | "park";
export interface Tile { t: TileKind; d?: string; price: number; rent: number[]; amt?: number; label?: string }
export interface Page { id: string; type: string; d?: string; name: string; count?: number; bonus: number }
export interface Cfg {
  id: string; kind: string; name: string; version: number; seed: number; date?: string; theme?: string; intro?: string;
  tiles: Tile[]; album: Page[]; turnLimit: number; timeLimitSec: number;
  rival: { name: string } | null; par: { turns: number; timeSec?: number } | null;
  mechanics: { undo: boolean; hint: boolean }; mastery?: boolean;
}
export interface Lesson { id: string; title: string; text: string; goal: { event: string; count: number }; force?: unknown; cfg: Cfg }
export interface Seat { pos: number; coins: number; props: Record<string, number>; laps: number }
export interface State {
  cfg: Cfg; seed: number; turn: number; phase: "roll" | "buy"; pending: { tile: number; price: number } | null;
  you: Seat; rival: (Seat & { name: string }) | null;
  albumDone: Record<string, unknown>;
  score: { rent: number; salary: number; album: number; property: number; coins: number; turnsBonus: number; timeBonus: number; total: number };
  stats: { rentCollected: number; builds: number };
  terminal: { reason: string; won: boolean } | null; elapsedMs: number;
}
export interface Ev { type: string; who?: string; from?: string; tile?: number; price?: number; amount?: number; die?: number; salary?: number; tram?: boolean; name?: string; text?: string; delta?: number; count?: number; page?: string; bonus?: number; reason?: string }
export interface Cmd { type: string; tile?: number }
export interface Session {
  id: string; cfgId: string; state: State; undoStack: State[]; invalidCount: number;
}
export interface Action { type: string; tile?: number; cost?: number }
export interface Hint { type: string; tile?: number; why: string }
export interface Theme { id: string; name: string; unlockStars: number; palette: Record<"sky" | "fog" | "ground" | "ring" | "edge" | "light" | "accent" | "token" | "tokenRival", number> }
export interface Achievement { key: string; name: string; desc: string }
export interface Progress {
  tutorialDone: Record<string, boolean>; journeyStars: Record<string, number>; journeyBest: Record<string, number>;
  challengeBest: Record<string, number>; dailiesDone: Record<string, number>; achievements: Record<string, number>;
  stats: { rounds: number; wins: number; rentCollected: number; builds: number; laps: number; pages: number; playMs: number };
  cosmetics: { theme: string };
}
export interface Doc { v: number; progress: Progress }
export interface BoardEntry { sessionId: string; configId: string; kind: string; won: boolean; score: number; invalid: number; durationMs: number; date: string | null; atMs: number; contentVersion: number; seed: number; assists: string }

interface RulesApi {
  ownerOf(s: State, idx: number): "you" | "rival" | null;
  buildCost(price: number, level: number): number;
  currentScore(s: State): number;
}
interface GameApi {
  BOARD: { RING_R: number };
  tilePos(cfg: Cfg, idx: number): { x: number; z: number; angle: number };
  createSession(cfg: Cfg, lesson: Lesson | null, atMs: number): Session;
  applyToSession(sess: Session, cmd: Cmd, atMs: number): { ok: boolean; reason?: string; state?: State; events?: Ev[] };
  undo(sess: Session): { ok: boolean; reason?: string };
  legalActions(s: State): Action[];
  hint(s: State): Hint | null;
  pageProgress(s: State, pg: Page): { have: number; need: number; done: boolean };
}
interface ContentApi {
  CONTENT_VERSION: number;
  DISTRICTS: Record<string, { label: string; color: number; colorHC: number }>;
  THEMES: Theme[]; JOURNEY: Cfg[]; CHALLENGES: Cfg[]; PRACTICE: Cfg[]; ACHIEVEMENTS: Achievement[];
  dailyConfig(date: string): Cfg;
  utcDateString(ms: number): string;
  tutorialLessons(): Lesson[];
}
interface StoreApi {
  SAVE_VERSION: number;
  docFromSave(d: unknown): Doc | null;
  fromBrowserSave(text: string | null): { doc: Doc | null; settings: Record<string, unknown> | null };
  GAME_SETTING_KEYS: string[]; BROWSER_SETTING_KEYS: string[];
  DEFAULT_SETTINGS: Record<string, unknown>;
  checkSetting(key: string, v: unknown): unknown;
  defaultProgress(): Progress;
  mergeProgress(local: Progress, remote: Progress): Progress;
  loadBoards(): { entries: BoardEntry[] };
  saveBoards(b: { entries: BoardEntry[] }): void;
  sortEntries(e: BoardEntry[]): BoardEntry[];
}
interface RngApi { derive(seed: number, stream: number): { next(): number; int(n: number): number }; STREAM_DECOR: number }
interface I18nApi {
  T(key: string, vars?: Record<string, string | number> | null): string;
  setLocale(tag: string): string;
  readonly lang: string;
  locales: string[];
}
interface PlatformStringsApi {
  platformStrings(lang: string): Record<string, string>;
  fmtPlatform(s: string, vars?: Record<string, string | number>): string;
}

const g = globalThis as unknown as {
  CFRules: RulesApi; CFGame: GameApi; CFContent: ContentApi; CFStore: StoreApi; CFRNG: RngApi; CFI18N: I18nApi; PlatformStrings: PlatformStringsApi;
};
export const Rules = g.CFRules;
export const Game = g.CFGame;
export const Content = g.CFContent;
export const Store = g.CFStore;
export const RNG = g.CFRNG;
export const I18n = g.CFI18N;
export const PlatformStrings = g.PlatformStrings;
