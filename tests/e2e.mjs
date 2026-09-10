/**
 * City Fortune — end-to-end QA playthrough (dev only, not shipped).
 *
 * Drives the real visible UI in headless Chrome (playwright-core + system
 * Chrome): title → settings (reduced motion on, to keep event presentation
 * fast) → modes → Journey stage 1 ("First Steps") → plays real rolls/buys
 * through the on-screen buttons until the round ends → results screen →
 * back to modes/title. Also exercises pause/resume, hint, and settings
 * open/close. Runs twice: desktop 1280×800 and mobile 390×844 (touch).
 *
 * The game talks to the StarHermit platform API (/api/v1/*) only for
 * optional server time sync and ranked score submission; both degrade
 * gracefully offline ("score saved locally"), so this test serves the
 * static files with its own embedded node:http server on an ephemeral
 * port and does NOT spawn server.js (the authoritative game server).
 *
 * Reads window.CFUI._state() only for synchronization/decisions; every
 * action goes through real clicks/key presses on visible controls.
 *
 * Run: npm run test:e2e
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
  '.glb': 'model/gltf-binary', '.woff2': 'font/woff2', '.ts': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions|swiftshader|WebGL.*fallback/i;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    // Minimal offline stubs for the optional StarHermit platform API so the
    // game's graceful-offline paths don't log 404 console errors.
    if (url.pathname.startsWith('/api/')) {
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (url.pathname === '/api/v1/time') return send(200, { nowMs: Date.now() });
      if (url.pathname === '/api/v1/leaderboard') return send(200, { entries: [] });
      if (url.pathname === '/api/v1/score') return send(200, { ok: false, error: 'e2e-offline' });
      return send(404, { error: 'not-found' });
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT) || file.includes(`${path.sep}.`)) {
      res.writeHead(403); return res.end('forbidden');
    }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});

const shot = (stage, pass) => `/tmp/city-fortune-e2e-${stage}-${pass}.png`;
let browser = null;

async function readState(page) {
  return page.evaluate(() => {
    const st = window.CFUI && window.CFUI._state && window.CFUI._state();
    if (!st || !st.sess) return null;
    const s = st.sess.state;
    return {
      terminal: s.terminal ? { won: s.terminal.won, reason: s.terminal.reason } : null,
      phase: s.phase, turn: s.turn, coins: s.you.coins,
      pending: s.pending ? { tile: s.pending.tile, price: s.pending.price } : null,
      albumDone: Object.keys(s.albumDone || {}).length,
    };
  });
}

// Wait until the round is over or a real action button becomes clickable.
async function waitActionable(page) {
  await page.waitForFunction(() => {
    const st = window.CFUI && window.CFUI._state && window.CFUI._state();
    if (!st || !st.sess) return false;
    if (st.sess.state.terminal) return true;
    const enabled = (id) => { const b = document.getElementById(id); return b && !b.disabled && b.offsetParent !== null; };
    return enabled('btn-roll') || enabled('btn-buy') || enabled('btn-skip');
  }, null, { timeout: 20000 });
}

async function playRoundToTerminal(page, pass, opts = {}) {
  let rolls = 0, buys = 0, paused = false, hinted = false;
  for (let i = 0; i < 300; i++) {
    await waitActionable(page);
    const s = await readState(page);
    if (!s) throw new Error('session lost mid-round');
    if (s.terminal) return { ...s, rolls, buys };
    if (s.phase === 'buy' && s.pending) {
      if (s.coins >= s.pending.price) { await page.click('#btn-buy'); buys++; }
      else await page.click('#btn-skip');
      continue;
    }
    // phase === 'roll'
    if (!paused && rolls >= 1 && opts.exercisePause) {
      paused = true;
      await page.click('#btn-pause');
      await page.waitForSelector('#overlay-pause:not([hidden])');
      await page.screenshot({ path: shot('pause', pass) });
      await page.click('#btn-resume');
      await page.waitForSelector('#overlay-pause', { state: 'hidden' });
      console.log(`ok - pause/resume (${pass})`);
      await waitActionable(page);
      if (!hinted && await page.locator('#btn-hint').isEnabled()) {
        hinted = true;
        await page.click('#btn-hint');
        await page.waitForTimeout(300);
        console.log(`ok - hint (${pass})`);
      }
    }
    await page.click('#btn-roll');
    rolls++;
    if (rolls === 3) await page.screenshot({ path: shot('mid-play', pass) });
  }
  throw new Error(`round did not terminate after 300 actions (${pass})`);
}

async function runPass(pass, contextOpts) {
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => { const t = String(e.message || e); if (!browserNoise.test(t)) errors.push(`pageerror: ${t}`); });
  page.on('console', (m) => { if (m.type() === 'error' && !browserNoise.test(m.text())) errors.push(`console: ${m.text()}`); });
  const step = async (name, fn) => { await fn(); console.log(`ok - ${name} (${pass})`); };

  try {
    await step('load → title visible', async () => {
      await page.goto(BASE, { waitUntil: 'load' });
      await page.waitForSelector('#screen-title:not([hidden])', { timeout: 15000 });
      await page.waitForSelector('#btn-play:visible');
      await page.screenshot({ path: shot('title', pass) });
    });

    await step('settings open/close (reduced motion on)', async () => {
      await page.click('#btn-title-settings');
      await page.waitForSelector('#overlay-settings:not([hidden])');
      const rm = page.locator('#set-reduced-motion');
      if (!(await rm.isChecked())) await rm.check();
      await page.screenshot({ path: shot('settings', pass) });
      await page.click('#btn-settings-close');
      await page.waitForSelector('#overlay-settings', { state: 'hidden' });
    });

    await step('modes → journey stage 1 setup', async () => {
      await page.click('#btn-play');
      await page.waitForSelector('#screen-modes:not([hidden])');
      await page.screenshot({ path: shot('modes', pass) });
      await page.locator('#journey-list button').first().click();
      await page.waitForSelector('#overlay-setup:not([hidden])');
      await page.screenshot({ path: shot('setup', pass) });
    });

    await step('start round → game screen', async () => {
      await page.click('#btn-setup-start');
      await page.waitForSelector('#screen-game:not([hidden])');
      await page.waitForSelector('#overlay-setup', { state: 'hidden' });
      await waitActionable(page);
      const s = await readState(page);
      if (!s || s.terminal) throw new Error('round not live after start');
      await page.screenshot({ path: shot('game-start', pass) });
    });

    const result = await playRoundToTerminal(page, pass, { exercisePause: true });
    console.log(`ok - played to terminal (${pass}): won=${result.terminal.won} reason=${result.terminal.reason} turns=${result.turn + 1} rolls=${result.rolls} buys=${result.buys} albumPages=${result.albumDone}`);

    await step('results screen', async () => {
      await page.waitForSelector('#screen-results:not([hidden])', { timeout: 10000 });
      const headline = (await page.textContent('#results-headline') || '').trim();
      if (!headline) throw new Error('results headline empty');
      const rows = await page.locator('#results-breakdown tr').count();
      if (rows < 1) throw new Error('results breakdown empty');
      console.log(`  headline: ${headline}`);
      await page.screenshot({ path: shot('results', pass) });
    });

    await step('results → modes → title', async () => {
      await page.click('#btn-results-menu');
      await page.waitForSelector('#screen-modes:not([hidden])');
      await page.click('#btn-modes-back');
      await page.waitForSelector('#screen-title:not([hidden])');
      await page.screenshot({ path: shot('back-to-title', pass) });
    });
  } finally {
    const bad = errors.filter(Boolean);
    await context.close();
    if (bad.length) throw new Error(`browser errors during ${pass} pass:\n  ${bad.join('\n  ')}`);
  }
}

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

try {
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });
  await runPass('desktop', { viewport: { width: 1280, height: 800 } });
  await runPass('mobile', { viewport: { width: 390, height: 844 }, hasTouch: true });
  console.log('PASS: city-fortune e2e — desktop and mobile playthroughs completed clean');
} catch (err) {
  console.error('E2E FAILED:', err && err.message || err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.close();
}
