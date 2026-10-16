// Localization coverage: every English key the markup, code and content use is
// translated in every locale (en-GB → en-US, es-ES → es-419, fr-CA → fr-FR
// inherit), placeholders survive, and the language follows sh-language.js and
// switches live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadTables, codeKeys, htmlKeys, audit, bootI18n } from './i18n-common.mjs';

const require = createRequire(import.meta.url);
const Content = require('../js/content.js');
const Rules = require('../js/rules.js');
const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

export function usedKeys() {
  const keys = new Set(htmlKeys(read('index.html')));
  for (const f of ['js/ui.js', 'js/main.js', 'js/platform.js']) codeKeys(read(f), ['tr']).forEach((k) => keys.add(k));
  const audio = read('js/audio.js');
  for (const m of audio.matchAll(/caption\('([^']+)'\)/g)) keys.add(m[1]);
  const caps = audio.slice(audio.indexOf('var CAPTIONS'), audio.indexOf('};', audio.indexOf('var CAPTIONS')));
  for (const m of caps.matchAll(/:\s*'([^']+)'/g)) keys.add(m[1]);
  for (const d of Object.values(Content.DISTRICTS)) keys.add(d.label);
  for (const t of Content.THEMES) keys.add(t.name);
  for (const c of [...Content.JOURNEY, ...Content.CHALLENGES, ...Content.PRACTICE]) {
    keys.add(c.name);
    if (c.intro) keys.add(c.intro);
    for (const pg of c.album) if (pg.type !== 'district') keys.add(pg.name);
  }
  keys.add(Content.dailyConfig('2026-10-16').intro);
  for (const l of Content.tutorialLessons()) { keys.add(l.title); keys.add(l.text); }
  for (const a of Content.ACHIEVEMENTS) { keys.add(a.name); keys.add(a.desc); }
  for (const c of Object.values(Rules.CARD_DEFS)) { keys.add(c.name); keys.add(c.text); }
  return [...keys].filter((k) => /[A-Za-z]/.test(k) && k.length > 1).sort(); // single-key titles (U, H) stay as they are
}

test('every used key is translated in every locale; placeholders and markup intact', () => {
  assert.deepEqual(audit(loadTables(ROOT, 'js/strings.js', 'CF_STRINGS'), usedKeys()), []);
});

test('the locale follows sh-language and switches live', () => {
  const { I18N, events, doc } = bootI18n(ROOT, { strings: 'js/strings.js', i18n: 'js/i18n.js', global: 'CFI18N', languages: ['de-DE'] });
  assert.equal(I18N.lang, 'de-DE');
  assert.equal(doc.documentElement.lang, 'de-DE');
  assert.equal(I18N.T('Resume'), 'Fortsetzen');
  I18N.language.setChoice('fr-CA');
  assert.equal(I18N.lang, 'fr-CA');
  assert.equal(events.at(-1), 'fr-CA');
  I18N.language.setChoice('en-GB');
  assert.equal(I18N.T('Harbor'), 'Harbour');
  assert.equal(I18N.T('{n} coins', { n: 5 }), '5 coins');
});
