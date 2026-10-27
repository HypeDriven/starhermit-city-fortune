// The engine save and the migration from the browser build: the old cloud
// slot's save.json (the checksummed { sum, payload } document the JS SDK
// stored) becomes { v: 1, progress } plus the game's own settings; two
// devices' copies merge to the better of both; the settings checks.
// (native/platform.ts wires these into starhermit:storage; signed-in paths
// cannot run here, so their logic is covered by these tests.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const memory = new Map();
globalThis.localStorage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, String(v)), removeItem: (k) => memory.delete(k) };
const Store = require('../js/store.js');

function browserSave(progress, settings) {
  const doc = Store.fresh();
  Object.assign(doc.progress, progress);
  Object.assign(doc.settings, settings);
  return Store.save(doc); // the wrapped text the SDK's saveJSON stored as save.json
}

test('the browser build\'s cloud save converts to the engine save and the game settings', () => {
  const text = browserSave({ journeyStars: { j01: 2 }, tutorialDone: { t1: true }, achievements: { 'first-buy': 5 } },
    { theme: 'canal', colorPalette: 'high-visibility', haptics: false, music: 0.2, graphicsTier: 'high' });
  const { doc, settings } = Store.fromBrowserSave(text);
  assert.equal(doc.v, 1);
  assert.deepEqual(Object.keys(doc), ['v', 'progress']);
  assert.equal(doc.progress.journeyStars.j01, 2);
  assert.equal(doc.progress.tutorialDone.t1, true);
  assert.equal(settings.theme, 'canal');
  assert.equal(settings.colorPalette, 'high-visibility');
  assert.equal(settings.haptics, false);
  assert.equal(settings.music, undefined, 'volumes are the runtime\'s now');
  assert.equal(settings.graphicsTier, undefined, 'graphics are the runtime\'s now');
});

test('a corrupt, foreign or newer save is ignored', () => {
  assert.deepEqual(Store.fromBrowserSave('not json'), { doc: null, settings: null });
  assert.deepEqual(Store.fromBrowserSave(JSON.stringify({ sum: 'x', payload: '{}' })), { doc: null, settings: null });
  assert.deepEqual(Store.fromBrowserSave(null), { doc: null, settings: null });
  assert.equal(Store.docFromSave({ v: 99, progress: {} }), null);
  assert.equal(Store.docFromSave('text'), null);
});

test('engine saves round-trip and fill missing parts', () => {
  const d = Store.docFromSave({ v: 1, progress: { journeyStars: { j02: 3 } } });
  assert.equal(d.progress.journeyStars.j02, 3);
  assert.deepEqual(d.progress.stats.rounds, 0);
  assert.deepEqual(Object.keys(d), ['v', 'progress']);
});

test('two devices merge to the better of both', () => {
  const a = Object.assign(Store.defaultProgress(), { journeyStars: { j01: 1, j02: 3 }, achievements: { 'first-buy': 50 }, stats: { rounds: 4, wins: 1, rentCollected: 10, builds: 0, laps: 2, pages: 1, playMs: 0 } });
  const b = Object.assign(Store.defaultProgress(), { journeyStars: { j01: 2 }, achievements: { 'first-buy': 20, 'first-win': 30 }, tutorialDone: { t2: true }, stats: { rounds: 2, wins: 2, rentCollected: 40, builds: 3, laps: 1, pages: 0, playMs: 0 } });
  const m = Store.mergeProgress(a, b);
  assert.deepEqual(m.journeyStars, { j01: 2, j02: 3 });
  assert.equal(m.achievements['first-buy'], 20);
  assert.equal(m.achievements['first-win'], 30);
  assert.equal(m.tutorialDone.t2, true);
  assert.equal(m.stats.rounds, 4);
  assert.equal(m.stats.wins, 2);
  assert.equal(m.stats.builds, 3);
});

test('game settings are checked', () => {
  assert.equal(Store.checkSetting('theme', 'midnight'), 'midnight');
  assert.equal(Store.checkSetting('theme', 'neon'), undefined);
  assert.equal(Store.checkSetting('boardMirror', true), true);
  assert.equal(Store.checkSetting('boardMirror', 'yes'), undefined);
  assert.equal(Store.checkSetting('music', 0.5), undefined);
  for (const k of Store.GAME_SETTING_KEYS) assert.ok(Store.BROWSER_SETTING_KEYS.includes(k), k);
});

test('the local board keeps through the localStorage shim', () => {
  Store.saveBoards({ entries: [{ sessionId: 'a', score: 5, won: true }] });
  assert.equal(Store.loadBoards().entries[0].score, 5);
});
