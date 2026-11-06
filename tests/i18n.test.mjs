// Localization coverage: every English key the engine client (native/*.ts)
// and the content show is translated in every locale (en-GB → en-US,
// es-ES → es-419, fr-CA → fr-FR inherit), placeholders and markup survive,
// no table keeps a key nothing shows, and the classic js/i18n.js switches
// locale as native/i18n.ts drives it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { codeKeys, audit } from './i18n-common.mjs';

const require = createRequire(import.meta.url);
const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

export function usedKeys() {
  const keys = new Set();
  for (const f of readdirSync(new URL('native/', ROOT)).filter((n) => n.endsWith('.ts'))) {
    codeKeys(read('native/' + f), ['tr']).forEach((k) => keys.add(k));
  }
  const C = require('../js/content.js');
  const R = require('../js/rules.js');
  const cfgs = [...C.JOURNEY, ...C.CHALLENGES, ...C.PRACTICE, ...C.tutorialLessons().map((l) => l.cfg), C.dailyConfig('2026-01-01')];
  for (const c of cfgs) {
    if (c.kind !== 'daily' && c.kind !== 'tutorial') keys.add(c.name);
    if (c.intro) keys.add(c.intro);
    for (const t of c.tiles) if (t.label && t.t !== 'prop') keys.add(t.label);
    for (const p of c.album) if (p.type !== 'district') keys.add(p.name);
  }
  for (const l of C.tutorialLessons()) { keys.add(l.title); keys.add(l.text); }
  for (const t of C.THEMES) keys.add(t.name);
  for (const d of Object.values(C.DISTRICTS)) keys.add(d.label);
  for (const a of C.ACHIEVEMENTS) { keys.add(a.name); keys.add(a.desc); }
  for (const c of Object.values(R.CARD_DEFS)) { keys.add(c.name); keys.add(c.text); }
  // Caption texts (native/audio.ts CAPTIONS, shown with tr()).
  const audio = read('native/audio.ts');
  const caps = audio.slice(audio.indexOf('const CAPTIONS'), audio.indexOf('};', audio.indexOf('const CAPTIONS')));
  for (const m of caps.matchAll(/:\s*"([^"]+)"/g)) keys.add(m[1]);
  return [...keys].filter((k) => /[A-Za-z]/.test(k) && !k.startsWith('starhermit.')).sort();
}

test('every used key is translated in every locale; placeholders and markup intact', () => {
  assert.deepEqual(audit(JSON.parse(read('assets/strings.json')), usedKeys()), []);
});
