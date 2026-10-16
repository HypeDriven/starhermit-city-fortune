// platform.test.mjs — js/platform.js (window.CFPlatform) over starhermit-sdk.js
// with a stubbed fetch and launch fragment: token read, profile nickname,
// cloud save round-trip on game:<slug>, settings KV patch, bindings, invite
// link, and no network at all when standalone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { installHosted, installStandalone, UID } from './starhermit-harness.mjs';

const require = createRequire(import.meta.url);
const SLUG = 'city-fortune';
const Store = require('../js/store.js');

test('hosted: token, profile, cloud save game:<slug>, settings, bindings, invite', async () => {
  const { sdk, env, win } = installHosted(SLUG);
  const P = require('../js/platform.js');
  assert.equal(sdk.userId, UID);
  assert.ok(!/game_token/.test(win.history.url || ''), 'fragment stripped');
  assert.equal(P.init(), true);
  assert.equal(P.slug, SLUG);
  assert.equal((await P.fetchProfile()).name, 'Ada');
  assert.equal(P.headers().Authorization, 'Bearer ' + sdk.token);

  assert.equal(await P.loadCloud(), null);
  const doc = Store.fresh();
  doc.progress.stats.wins = 4;
  const wrapped = Store.save(doc);
  P.saveCloud(wrapped);
  assert.equal(await P.flushSave(), true);
  const put = env.calls.find((c) => c.method === 'PUT');
  assert.ok(put.url.endsWith('/cloud-saves/game%3Acity-fortune'), put.url);
  assert.equal(Store.loadRaw(await P.loadCloud()).progress.stats.wins, 4, 'cloud round-trip');

  assert.deepEqual(await P.getSettings(), {}, 'only preference keys pass');
  P.mirrorSettings({ music: 0.1, tutorialDone: true });
  await new Promise((r) => setTimeout(r, 900));
  const patch = env.calls.find((c) => c.method === 'PATCH');
  assert.deepEqual(JSON.parse(patch.init.body).settings, { music: 0.1 });

  await P.loadBindings();
  assert.equal(P.actionFor({ code: 'KeyB' }), 'buy');
  assert.equal(P.actionFor({ code: 'Space' }), 'confirm');
  assert.equal(P.actionFor({ key: 'm' }), 'mute');
  assert.equal(P.keyLabel('prev'), '← / ↑');
  assert.equal(P.inviteLink(), `https://dashboard.starhermit.com/game-invite/${UID}/${SLUG}`);
  assert.equal(P.canSignIn(), false);
});

test('standalone: no token, no network', async () => {
  const st = installStandalone();
  try {
    const P = require('../js/platform.js');
    assert.equal(P.init(), false);
    assert.equal(P.hosted, false);
    assert.equal(await P.loadCloud(), null);
    P.saveCloud('{}');
    await P.flushSave();
    assert.deepEqual(await P.getSettings(), {});
    P.mirrorSettings({ music: 1 });
    await P.loadBindings();
    assert.equal(P.actionFor({ code: 'KeyU' }), 'undo');
    assert.equal(await P.fetchLeaderboard(), null);
    assert.equal(P.inviteLink(), null);
    assert.deepEqual(P.headers(), {});
    assert.deepEqual(st.calls, []);
  } finally { st.restore(); }
});

test('save-conflict merge keeps the better of both devices', () => {
  const a = Store.fresh().progress, b = Store.fresh().progress;
  Object.assign(a, { tutorialDone: { t1: true }, journeyStars: { j01: 2, j02: 1 }, journeyBest: { j01: 900 }, challengeBest: { c1: 50 },
    dailiesDone: { '2026-10-01': 300 }, achievements: { 'first-buy': 500 } });
  a.stats.wins = 3; a.stats.rounds = 10; a.cosmetics = { theme: 'canal' };
  Object.assign(b, { tutorialDone: { t2: true }, journeyStars: { j01: 3, j03: 1 }, journeyBest: { j01: 700 }, challengeBest: { c1: 80 },
    dailiesDone: { '2026-10-02': 100 }, achievements: { 'first-buy': 100, 'first-win': 200 } });
  b.stats.wins = 5; b.stats.rounds = 4;
  const m = Store.mergeProgress(a, b);
  assert.deepEqual(m.tutorialDone, { t1: true, t2: true });
  assert.deepEqual(m.journeyStars, { j01: 3, j02: 1, j03: 1 });
  assert.equal(m.journeyBest.j01, 900);
  assert.equal(m.challengeBest.c1, 80);
  assert.deepEqual(Object.keys(m.dailiesDone).sort(), ['2026-10-01', '2026-10-02']);
  assert.deepEqual(m.achievements, { 'first-buy': 100, 'first-win': 200 });
  assert.equal(m.stats.wins, 5);
  assert.equal(m.stats.rounds, 10);
  assert.equal(m.cosmetics.theme, 'canal');
});

test('a refused cloud write reloads the newer copy for the game to merge and re-save', async () => {
  const { sdk, env } = installHosted(SLUG);
  delete require.cache[require.resolve('../js/platform.js')];
  const P = require('../js/platform.js');
  P.init();
  assert.equal(await P.loadCloud(), null);
  const other = Store.fresh(); other.progress.journeyStars = { j02: 3 };
  P.saveCloud(Store.save(other));
  assert.equal(await P.flushSave(), true, 'other device saved first');
  const mine = Store.fresh(); mine.progress.journeyStars = { j01: 1 };
  const merged = new Promise((resolve) => P.onConflict((raw) => {
    const remote = Store.loadRaw(raw);
    mine.progress = Store.mergeProgress(mine.progress, remote.progress);
    P.saveCloud(Store.save(mine));
    P.flushSave().then(resolve);
  }));
  env.refuseNextPut = true;
  P.saveCloud(Store.save(mine));
  assert.equal(await P.flushSave(), false, 'stale write refused');
  assert.equal(await merged, true, 'merged doc saved');
  assert.equal(sdk.saveConflicted(), false);
  const cloud = Store.loadRaw(await P.loadCloud());
  assert.deepEqual(cloud.progress.journeyStars, { j01: 1, j02: 3 });
});
