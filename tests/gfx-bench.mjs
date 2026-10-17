// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in the real Settings
// overlay, starts Journey stage 1 and keeps playing through the visible Roll / Buy / Skip buttons
// (pawn hops, confetti bursts, ownership pops, drifting flecks and the post chain all run), starting
// a new round from the results screen when one ends.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForSelector('#screen-title:not([hidden])', { timeout: 20000 });
  await page.click('#btn-title-settings');
  await page.waitForSelector('#overlay-settings:not([hidden])');
  await page.locator('#set-tier').scrollIntoViewIfNeeded();
  await page.selectOption('#set-tier', preset);
  await page.waitForFunction((p) => document.body.dataset.gfxPreset === p, preset);
  await page.click('#btn-settings-close');
  await page.waitForSelector('#overlay-settings', { state: 'hidden' });
}

async function startRound(page) {
  await page.click('#btn-play');
  await page.waitForSelector('#screen-modes:not([hidden])');
  await page.locator('#journey-list button').first().click();
  await page.waitForSelector('#overlay-setup:not([hidden])');
  await page.click('#btn-setup-start');
  await page.waitForSelector('#screen-game:not([hidden])', { timeout: 15000 });
}

const visible = (page, sel) => page.locator(`${sel}:visible:not([disabled])`).count();

async function step(page) {
  if (await page.locator('#screen-results:not([hidden])').count()) {
    await page.click('#btn-results-menu', { timeout: 5000 });
    if (await visible(page, '#btn-modes-back')) await page.click('#btn-modes-back', { timeout: 5000 });
    await startRound(page);
    return;
  }
  if (await visible(page, '#btn-buy')) return page.click('#btn-buy', { timeout: 5000 });
  if (await visible(page, '#btn-skip')) return page.click('#btn-skip', { timeout: 5000 });
  if (await visible(page, '#btn-roll')) return page.click('#btn-roll', { timeout: 5000 });
}

export async function start(page) {
  await startRound(page);
  let open = true;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try { await step(page); await page.waitForTimeout(250); } catch (e) { if (!open) return; if (process.env.BENCH_DEBUG) console.error(e.message); }
    }
  })();
  await page.waitForTimeout(1000);
}
