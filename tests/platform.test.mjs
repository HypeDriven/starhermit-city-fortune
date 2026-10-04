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
