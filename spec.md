# City Fortune — Game Design Document (running spec)

Present tense: this document describes what the shipped game does today. Anything the design wants but the code does not yet do is collected in the final section, "Design intent not yet implemented".

## 1. Overview

**Pitch.** Roll a die around a pop-up paper city, buy the districts before your rival snaps them up, build taller paper houses for rent, and complete every page of the board's sticker album before the turns (or the clock) run out.

| | |
|---|---|
| Genre | Solo roll-and-move board game with a deterministic rival and album (set-collection) goals |
| Players | 1 human; an optional scripted rival ("Penny", "Brick", "Moss", "Vela", "Cobalt") shares the circuit on alternating turns |
| Session | 3–9 minutes per round (par times 240–560 s); a Learn lesson is under a minute |
| Platforms | Desktop and mobile browsers (portrait and landscape); WebGL optional |
| Rendering | Three.js r-module (`vendor/three.module.min.js`) perspective scene of a circular paper board; all UI is semantic HTML beside/over the canvas; a DOM "board list" is the playable fallback without WebGL |
| Hosting | Static files plus `server.js` (Node 18+, no dependencies) which also verifies ranked scores by replaying them |

**File map**

| Path | Owns |
|---|---|
| `index.html` | All screens and overlays as static DOM; loads classic scripts in dependency order, then `js/main.js` as a module |
| `css/style.css` | Palette tokens, responsive shell (wide / compact / portrait / landscape), accessibility modes |
| `js/rng.js` | mulberry32 PRNG, FNV-1a `hashString`, three derived streams (rules / decor / av) per master seed |
| `js/rules.js` | Pure deterministic rules engine: creation, legality, resolution, scoring, hashing, serialization, hints |
| `js/content.js` | Versioned content: districts, themes, 40 journey stages, 6 challenges, 3 practice presets, daily generator, 5 Learn lessons, 10 achievements |
| `js/store.js` | Checksummed versioned save document in `localStorage`, local leaderboard, tie-break sort |
| `js/game.js` | Session wrapper: command log, undo stack, replay envelope and verification, shared board geometry (`tilePos`) |
| `js/audio.js` | WebAudio buses, per-event synth cues, lazy loading of authored Opus clips from `sfx/manifest.json`, ambience and generative pad |
| `js/render.js` | Three.js scene: ring of tiles, pop-up buildings, tokens, selection marker, highlights, particles, quality tiers, picking |
| `js/ui.js` | Screens, HUD, input, event presentation, lessons, results, settings, achievements, server calls; owns the round clock |
| `js/main.js` | Module bootstrap: exposes `THREE` on `window`, calls `CFUI.boot()`, shows a readable error if boot throws |
| `server.js` | Static host with `/api/v1/time`, `/daily`, `/score`, `/leaderboard`; replay-verifies submissions into `server-boards.json` |
| `tests/run-tests.js` | 27 unit/property tests (`npm test`) |
| `tests/e2e.mjs` | Playwright playthrough of the real UI at desktop and mobile viewports (`npm run test:e2e`) |
| `tools/validate.js` | Offline content validator (structure + bot playability + replay) (`npm run validate`) |
| `tools/smoke.html` | Dev-only headless smoke driver |
| `sfx/` | 25 Opus clips, `manifest.txt` (canonical), `manifest.json` (loader + generator input), `manifest.md` (generator output) |
| `assets/` | `key-art.webp`, `results-album.webp`, `paper-grain.webp` |
| `coverart.png`, `icon.png`, `favicon.svg` | Store cover (1200×675), 256×256 icon, tab icon |
| `starhermit.txt` | `name=City Fortune`, `launch=index.html`, `owner=…`, `server=server.js`, `cover=coverart.png` |
| `LICENSE.md` | PolyForm Noncommercial 1.0.0 |

## 2. Vision and design pillars

The fantasy is a craft-table diorama: a cardboard ring, folded card-stock houses, a red wooden cone for you and a blue one for the rival, and a sticker album whose pages are the goals. Everything on screen should look like it could be cut and folded by hand.

1. **The album is the objective, not the bankroll.** A round is won only by completing every album page (`Rules.checkAlbum`); coins, property and rent are means and score components, never the win condition. Rules in: district sets, laps, stickers, upgrades and rent pages; rules out: bankrupting the rival, "last player standing", open-ended play.
2. **A friend can pressure you but never wreck you.** The rival contests only property outside album districts (`Rules.protectedDistricts`), so set progress can be slowed but not destroyed. Rules in: the rival buying non-album districts and collecting rent from you; rules out: the rival buying an album tile, trading, or taking property away.
3. **Every roll is inspectable.** All randomness comes from a 32-bit seed through three named streams; the same seed and command list always produce the same hashes, and the server re-plays ranked rounds rather than trusting a total. Rules out: hidden modifiers, time-of-day luck, cosmetic randomness bleeding into rules.
4. **Paper first, spectacle second.** Flat-shaded card-stock materials, a fixed authored camera, one warm key light. Effects are small paper confetti bursts and a 1–2 cm camera nudge, all removable by Reduced motion, and never needed to read the state; the DOM board list carries the same information as the 3D scene.
5. **Two inputs from the title to a die roll.** Play → stage → Start, or the Daily button → Start. Undo and hints exist wherever the mode allows so a wrong tap costs a second, not a round.

## 3. Player experience

**Target player.** Someone who enjoys light board games on a phone or laptop for a few minutes at a time, wants a daily shared puzzle, and prefers progress (stars, pages, themes) over ranked stress.

**First 60 seconds.** The title shows key art, a one-line tagline, Play, Daily challenge and the journey progress line. Play opens the mode screen; only "First Steps" is unlocked in the journey list. Its setup dialog states the rules in one sentence ("Complete 2 album pages within 30 turns"), expected duration, players, assists and whether it is ranked, plus the briefing "Roll the die and move around the circuit. Buy every Harbor property to complete the set." On Start the live region announces the stage and "Your turn: roll the die"; Roll is the only enabled primary button. Landing on Harbor 1 disables Roll and enables Buy/Skip with the deed announced; the HUD phase reads "Decide: buy or skip". The left rail lists the two pages with 0/2 and 0/2 progress. Every later mechanic is introduced by a stage briefing the first time it appears (rival in j04, stickers j06, building j08, rent page j12, time limit j16, full deck j19), and the Learn list offers five one-goal lessons with an in-flow lesson card.

**Session shape.** Pick a stage or the daily → 20–45 rolls with a handful of buy/skip decisions and a few builds between rolls → results table → "Next: <stage>" or Retry. A mastery stage every ten journey stages combines everything learned so far.

**Emotional beat.** The moment a page flips: the album line turns green with a check mark, a confetti burst and a tiny camera nudge fire, the page-turn sound plays and "+bonus" appears in City news. The round-ending version of that beat (last page) is the win.

## 4. Core loop and rules contract

All rules live in `js/rules.js`; `js/game.js` wraps them in a session with a command log. Nothing outside these files mutates rules state.

### Board and entities

- A **config** (`cfg`) is a versioned data object: `id, version, kind, seed, name, tiles[], album[], cards[], dice (6), turnLimit, timeLimitSec, startCoins, salary, rival|null, rivalReserve, par{turns,timeSec}, mechanics{undo,hint}, theme, intro`.
- **Tiles** are built by `Content.buildTiles`: tile 0 is `start`; each district block of `n` property tiles is followed by one special tile drawn from a seeded shuffle (decor stream) of the stage's specials; leftovers trail the last block. Ring sizes are 8–17 tiles. Tile kinds: `start`, `prop {d, price, rent[3], label}`, `bonus {amt}`, `toll {amt}`, `card`, `sticker`, `park`.
- **Prices** are tiered: 60 / 100 / 140 (`tierPrice`). **Rent** per building level is `round(price × 0.2 / 0.55 / 1.05)`: 12/33/63, 20/55/105, 28/77/147. **Build cost** (`Rules.buildCost`) is `ceil(price × 0.6)` from level 1→2 and `ceil(price × 0.8)` from 2→3; `MAX_LEVEL = 3`.
- **State** (`Rules.createGame`): `tick, turn, phase ('roll'|'buy'), you{pos,coins,laps,stickers,props{idx:level}}, rival{name,pos,coins,laps,props}|null, deck, discard, pending, albumDone, albumBonus, stats, score, elapsedMs, terminal, events`. The card deck is shuffled once at creation with the rules stream; `rngState` is stored in the state so every command continues the same stream.

### Legal actions (`Rules.legalActions`)

| Phase | Actions |
|---|---|
| `roll` | `roll`; `build {tile}` for each owned property below level 3 whose build cost you can afford |
| `buy` (a deed is pending) | `buy`, `skip` |
| any, not terminal | `resign`; `timeout` only when `timeLimitSec` is set and `atMs ≥ limit` |

Rejections return a reason from `Rules.INVALID`: `game-ended, wrong-phase, unknown-command, malformed-command, bad-tile, unaffordable, not-owned, max-level`; the session adds `undo-disabled, nothing-to-undo`. `validateCommandShape` bounds payloads to 512 bytes and ids to 64 chars at the replay/network boundary. Rejected commands never mutate state and increment `sess.invalidCount`.

### Resolution order (`Rules.applyCommand`)

1. Clone the state, `tick++`, quantise `atMs` to 100 ms into `elapsedMs`, rehydrate the rules RNG from `rngState`.
2. `roll`: die = `rng.range(1, 6)`; `moveActor` advances you; passing Start increments `laps` and pays `salary`; `resolveLanding` runs the tile:
   - `prop` unowned and affordable → `phase = 'buy'`, `pending = {tile, price}` (turn does not end yet); unaffordable → `cannot-afford` event and the turn ends.
   - `prop` owned by the other side → pay `rent[level-1]`, capped at your coins.
   - `bonus` +amt; `toll` −amt (capped); `sticker` +1 (rival ignores it); `park`/`start` no effect; `card` draws (see below).
   - If no deed is pending, `endTurn` runs.
3. `buy`: pay `pending.price`, own the tile at level 1, `endTurn`. `skip`: drop the offer, `endTurn`.
4. `build`: pay the build cost, level +1, `stats.builds++`; the album is checked immediately (a Developer page can win between rolls) but the turn does **not** end and the rival does not move.
5. `endTurn`: check album → win; check the clock → `time-up`; rival turn (roll, move, resolve with the rival's own buy rule); check album again (rival rent can finish a Rent page); `turn++`; `turn ≥ turnLimit` → `turn-limit` loss.
6. Save `rngState`; if terminal, `finalizeScore`.

**Rival buy rule.** On an unowned property the rival buys iff the district is not referenced by any district album page and `rival.coins ≥ price + rivalReserve` (reserve 40; 0 on "Spree"/"Push" journey stages, challenges c4 and c6, and Expert practice). The rival never builds and never buys stickers.

**Chance cards** (`CARD_DEFS`; decks `light` 4 cards, `standard` 7, `full` 10): City Grant +120; Parking Fine −80; Tailwind +3 tiles then resolve; Detour −2 tiles then resolve (moving backwards never pays salary); Dividends +30 per property; Repairs −25 per building level; Express Tram to Start with salary. Drawn cards go to the discard; an empty deck reshuffles the discard with the rules stream; card→move→card chains stop at `CARD_DEPTH_CAP = 4`.

### Album pages (`Rules.pageProgress`)

| Type | Progress | Example bonus |
|---|---|---|
| `district` | owned tiles in district `d` / all tiles of that district | 200–360 |
| `upgrades` ("Developer") | sum of (level − 1) over your properties / count | 200–300 |
| `laps` ("Globetrotter") | laps / count | 150–300 |
| `stickers` ("Sticker book") | stickers / count | 150–300 |
| `rent` ("Rent baron") | rent collected from the rival / count | 200–280 |

A page completes once, adds its bonus to `albumBonus`, and emits `page-complete`. All pages done → `terminal = {reason: 'album-complete', won: true}`.

### Terminal states and scoring (`Rules.finalizeScore`)

Reasons: `album-complete` (won), `turn-limit`, `time-up`, `resigned`. Score components are integers:

```
rent       = stats.rentCollected
salary     = stats.salary
album      = albumBonus
property   = Σ investedValue(tile, level)   // price + build costs paid
coins      = you.coins
turnsBonus = won && turnLimit ? (turnLimit − turn) × 10 : 0
timeBonus  = won && par.timeSec && 0 < elapsedMs < par.timeSec×1000
             ? floor((par.timeSec×1000 − elapsedMs)/1000) × 5 : 0
total      = sum of the seven
```

**Worked example (j01 "First Steps", 8 tiles: Start, Harbor 1, Harbor 2, +50 bonus, Market 1, Market 2, park, park).** You win on turn index 18 with both Harbor deeds at level 1 (60 each), two laps, 470 coins in hand, after 200 s: rent 0 + salary 400 + album 350 (200 + 150) + property 120 + coins 470 + turn bonus (30 − 18) × 10 = 120 + time bonus (300 − 200) × 5 = 500 → **total 1960**. The HUD's running score (`Rules.currentScore`) omits the two win bonuses.

**Journey stars** (`ui.js endRound`): 1 for the win, +1 if `turn ≤ par.turns`, +1 if `par.timeSec` and elapsed ≤ par time. Stars unlock the next stage (any star) and cosmetic themes.

**Tie-breaks** (`Store.sortEntries`, used by both local and server boards): won before lost, higher score, fewer invalid actions, lower duration, then session id string order.

### RNG and seeding (`js/rng.js`)

`streams(seed)` derives `rules` (seed ^ 0x9e3779b9), `decor` (^ 0x85ebca6b) and `av` (^ 0xc2b2ae35) mulberry32 generators. Rules use only the rules stream; tile layout and the decorative city use decor; audio pitch variants use av. Daily seeds are `hashString('cityfortune-daily-v1-YYYY-MM-DD')`; session ids are `hashString('cf-session-' + serverNowMs)` in base 36.

### Undo, hints, replay (`js/game.js`)

- `undo` pops the previous state when `cfg.mechanics.undo` is true and the round is not over; it also pops the replay command and hash. One undo reverses one command (a whole roll including the rival's response).
- `hint` (`Rules.hint`) uses the same legality surface: in `buy` phase it recommends Buy for protected-district tiles or when price ≤ 60 % of coins, else Skip; in `roll` phase it prefers a build that advances an unfinished Developer page, then a build when coins exceed twice its cost, else Roll. Hints are always legal (tested).
- Replay envelope: `{header{schemaVersion, contentVersion, configId, seed, initHash}, initialState, commands[], hashes[], terminal}`. `verifyReplay` rebuilds from `initialState` and compares every hash.

## 5. Modes and progression

| Mode | Entry | Content | Assists | Ranked |
|---|---|---|---|---|
| Journey | Play → Journey list (40 stages; stage n+1 unlocks with ≥1 star on n) | `Content.JOURNEY`: seeds 101–140, 8–17 tiles, 2–3 pages, turn limits 30–50, time limits on j16/j20/j26/j30/j33/j38/j40; rival from j04; four MASTERY stages (j10, j20, j30, j40) | Undo + Hint | No (stars, best score) |
| Daily | Title or Modes → "Play today's daily" | `Content.dailyConfig(date)`: one immutable config per UTC day (server time offset applied); districts, tolls, stickers, deck, rival name and theme rotate on `day % 7`; 40 turns; time limit on rotation 6 | Undo + Hint | Yes: submitted to `/api/v1/score` |
| Challenge | Modes → Challenges (6) | c1 Express Circuit (22 turns, no undo), c2 Speed Tycoon (240 s), c3 Thin Wallet (120 coins), c4 Stiff Rents (aggressive Brick), c5 Sticker Sprint, c6 Grand Constraint (turns + clock, no assists) | Per config | Yes |
| Practice | Modes → Practice | Relaxed (solo), Standard (Penny), Expert (Brick, reserve 0) | Undo + Hint | No |
| Learn | Modes → Learn (5 lessons) | t1 Roll and move, t2 Buy property (opens on a forced deed offer), t3 Build up (pre-owned Harbor 1, 400 coins), t4 Finish an album page (buy Harbor 2), t5 Second chances (undo) | Per lesson | No; completion ticks persist |

Deep links: `#daily`, `#practice-<id>`, `#journey-<id or number>`, `#challenge-<id or number>` start a round directly after boot.

**Difficulty curve.** Prices rise from tier 0 to tier 2, ring size and page count grow, tolls climb from 30 to 100, decks widen (light → standard → full), rival reserve drops to 0 on "Spree/Push" stages, starting coins are squeezed on "Tight Purse" and "Thin Air", and time limits appear from j16.

**Unlocks.** Themes: Paper Dawn 0★, Canal Dusk 12★, Blossom Festival 30★, Midnight Metro 55★, Harvest Fair 85★ (of 120 possible). Journey stages carry their own theme; the Settings theme applies to modes without one. Achievements (10, stable lowercase keys, idempotent): first-buy, first-page, first-win, rent-500, builds-25, journey-half (20 stages), journey-done (40), daily-7, score-4000, laps-50.

## 6. Controls and interaction

**Desktop / keyboard (`ui.js onKey`, active only on the game screen with no overlay open):**

| Key | Action |
|---|---|
| Enter / Space | Primary: Buy when a deed is offered; Build if the selected tile can be built on; otherwise Roll |
| ← ↑ / → ↓ | Cycle the selected tile backwards / forwards around the ring (announced with kind and build availability) |
| B / N | Buy / Skip the offered deed |
| U / H | Undo / Hint (when the mode allows) |
| C | Skip the event presentation and settle the board |
| P, Esc | Pause; Esc also closes the top overlay |
| M | Mute toggle (works on every screen) |
| Tab | Standard focus order; overlays make `main` inert so focus stays inside the dialog |

**Pointer / touch.** A tap on the canvas (≤ 12 px movement, ≤ 600 ms, pointer capture held) raycasts against tile tops only (`Render.pick`); a hit selects the tile, a miss clears the selection. Longer or moving presses are ignored (no camera gestures exist). Every tile is also a `<button class="mirror-tile">` in the board list, so touch and screen readers never depend on the canvas. The action tray buttons are 44 px minimum; on portrait phones they grow to a third of the width each and stick to the bottom above the safe-area inset. Left-handed mode reverses the tray order.

**Input locking.** `presenting` is true while the events of one command are shown (320 ms per event, 60 ms with Reduced motion, 0 after C); during it every action button is disabled and `dispatch` ignores input. The lock ends when the last event has been shown and `Render.settle()` has placed everything at its exact end state. Settings "Confirm buys and builds" is stored but has no effect today (see Known limitations).

**Feedback per input.** Accepted command: `ui` click + 12 ms haptic (if enabled) + per-event sounds, log lines in City news, live-region announcement and 3D animation. Rejected command: `invalid` thud, a red ⚠ log line, and an announcement with the reason text (`explainInvalid`). Selection: `select` tap, accent ring marker on the board, description line under the canvas ("Harbor 1 · property · yours, level 2 · rent 12/33/63"), pressed state in the board list.

## 7. Screens and UI flow

`loading → title → modes → [setup overlay] → game → results`, plus modal overlays: setup, pause, settings, help, achievements, leaderboards, friends. `show(screen)` hides all others, sets `body[data-screen]`, and focuses the `[data-autofocus]` control. Overlays stack (`overlayStack`); closing one restores focus to its opener. Leaving a round from Pause resigns through the rules (so the result is recorded) except in Learn.

- **Title**: key art, tagline, Play (primary, full width), Daily challenge, daily status line, journey progress line, then Leaderboards / Achievements / Settings / Help.
- **Modes**: three columns (Journey ol, Daily + Challenges, Practice + Learn); the page itself scrolls so the 40-stage list is never trapped in an inner scroller. Locked stages are disabled buttons with ☆☆☆.
- **Setup overlay**: name, Rules, Expected duration, Players, Assists, Ranked, Briefing; Start / Cancel.
- **Game** (wide ≥ 1024 px): left rail Album (+ rival line), centre playfield (canvas, selection line, status row with phase / turn / ⏱ / coins / score, action tray, optional board list), right rail City news (last 30 lines). Compact (< 1024 px): rails become slide-in drawers toggled by Album / News buttons that appear only in the tray. Portrait phone: status row on top, square canvas, tray sticky at the bottom. Landscape phone (≤ 480 px tall): a 150 px static album rail on the left, no news rail, canvas fills the rest. The lesson card is in normal flow above the grid so it can never cover the tray.
- **Results**: album illustration, headline ("Album complete!" / "Round over"), reason, seven-row breakdown table with total, newly unlocked achievement chips, next-action line, server verification line, then Next (journey wins), Retry, Modes, Title.
- **Settings**: Audio (4 sliders, mute, captions), Graphics (tier, theme, palette), Accessibility & controls (7 checkboxes). **Help**: goal, tile legend, rival rule, key bindings, and "Right now: legal actions" generated from the live state.

Safe areas: every fixed/sticky element pads by `env(safe-area-inset-*)`; the WebGL banner and game grid pad the top inset. Nothing critical sits under browser chrome: the tray is the bottom-most element and the Pause button lives in it.

## 8. Art direction

**Palette (CSS tokens, `css/style.css`).** Background `#f2e4c8`, panel `#fff8ea`, ink `#3a2f22`, accent `#e07f3e` (accent ink `#fff`), muted `#7a6a52`, line `#d9c49a`, focus `#2e6fe4`, danger `#b85450`, canvas well `#e8d8b8`, done-page green `#2e7d32`, pressed tile `#fff3d6`. High contrast swaps to bg `#000`, panel `#111`, ink `#fff`, line `#888`, accent `#ffb000`, muted `#ccc`, focus `#00c2ff`.

**Scene palettes (`Content.THEMES`).** Paper Dawn sky `#f2e4c8` / ring `#f6ecd4` / edge `#b89a6a` / light `#ffe0b0` / accent `#e07f3e` / you `#d94f3d` / rival `#4a6fa8`; Canal Dusk sky `#24324a`, accent `#7fb0ff`, you `#ffb066`, rival `#8fd6a0`; Blossom Festival sky `#f6dce4`, accent `#d95f8a`, you `#7a4fb8`; Midnight Metro sky `#161a26`, accent `#ffc46a`, you `#ffd90a`; Harvest Fair sky `#f0d8b0`, accent `#b86a2e`, you `#8a4fb8`. Tile kinds keep fixed colours across themes: bonus `#7fbf6a`, toll `#c05a4a`, card `#6a8fc0`, sticker `#c9a0dc`, park `#8aa86a`; property tiles are the ring colour mixed 35 % toward white with a district stripe: Harbor `#4a7fb8`, Market `#d9934a`, Garden `#5d9c59`, Arts `#8e6fc0`, Tech `#4aa8a8`, Old Town `#b85450` (high-visibility set `#2e6fe4 #b7791f #17a398 #8e24aa #00838f #c62828`). Colour is never the only cue: every district has an icon and label in the album and board list.

**Shape language.** Everything is folded card: tiles are thin boxes (0.30 × 0.055 × 0.42 units), buildings are four-sided paper tents on a card base whose height grows 0.14 per level, tokens are cones with a white paper collar, the Start arch is an accent-coloured tent, and 8–14 seeded decorative tents fill the ring interior. Materials are `MeshStandardMaterial` with roughness 0.9, metalness 0.02, flat shading, under one warm directional key (with 1024² shadow map on medium/high) and a hemisphere fill; ACES tone mapping at 1.05 exposure; fog from 4.5 to 9 units.

**Hero.** The board ring with its tokens is the hero; the camera is fixed at (0, 2.35, 2.65) looking at the origin, FOV 48, so the whole ring and the pop-up skyline are always framed.

**Typography.** System UI stack; h1 1.9 rem (1.5 rem under 560 px), rails 0.92 rem, logs 0.85 rem; Larger text raises the root to 1.2 rem. Numbers in the breakdown use tabular figures.

**Motion.** Token hops ease in-out over 0.45 s with up to four sine hops; buildings pop in with a cubic ease over 0.35 s; confetti planes (10 × power × tier factor) fall under gravity for 0.7 s; page/win events add a 0.012/0.02 camera nudge decaying at 0.04/s from an authored base pose (never cumulative). Reduced motion: every CSS transition off, event beats shortened to 60 ms, token moves and pops become instant, no camera shake, particle updates clamped.

**Visual assets the design calls for.** Title key art (paper city diorama), results illustration (open sticker album), subtle paper-grain texture for panels, a cover image in the same diorama style, and the icon/favicon. All are shipped (see §15).

## 9. Audio direction

**Mix.** Four gain buses (`music 0.6`, `effects 0.9`, `ambience 0.5`, `voice 0.8` defaults) into a master; Mute zeroes all buses. Sound starts on the first pointer/key gesture; the tab going hidden suspends the context. Ambience is a quiet brown-noise city hum (low-pass 300 Hz, gain 0.32) and music a slow generative pad walking C–Am–F–G every 5.2 s through a 700 Hz low-pass; both are synthesized, never streamed. Effects are authored Opus clips (`sfx/<name>.opus`) mapped by `sfx/manifest.json`; each is fetched and decoded once on first use, and until then (or if it fails) the WebAudio synth cue for the same event plays, so no event is ever silent. Pitch variants in synth cues use the av stream so replays sound identical. Captions (Settings → "Captions for sounds") show a ♪ line for 2.5 s for both authored and synth cues.

**SFX event table** (source of `sfx/manifest.txt`):

| Event id | File | Sound | Usage |
|---|---|---|---|
| dice | dice-rattle.opus | Two dice rattling in a cup then tumbling on wood | Your roll |
| hop | pawn-hop.opus | Wooden pawn hopping one tile on cardboard | Landing on Start, park, own property; card-driven move |
| land | piece-land.opus | Wooden piece landing with a soft thud | Bound in audio.js; no current trigger |
| coin | coin-clink.opus | A few coins clinking in a hand | Bound in audio.js; no current trigger |
| salary | salary-register.opus | Register bell then drawer with coin clatter | Passing Start / Express Tram |
| buy | buy-stamp.opus | Rubber stamp thump then a cheerful chime | Deed bought (you or rival) |
| build | build-hammer.opus | Two hammer taps then a toy house set down | Upgrade built |
| rent-get | rent-collect.opus | Coins pouring into a tin box, bright jingle | Rival pays you rent |
| rent-pay | rent-pay.opus | Coins counted out one by one, subdued | You pay rent |
| card | card-flip.opus | One card flipped onto felt | Chance card drawn |
| sticker | sticker-press.opus | Sticker peeled and pressed onto a page | Sticker tile |
| page | page-turn.opus | Thick album page turning | Album page complete; lesson complete |
| win | win-fanfare.opus | Small brass fanfare with poppers | Round won |
| lose | lose-trombone.opus | Muted descending trombone | Turn limit, time up, resign |
| ui | ui-click.opus | Soft plastic button click | Every accepted command and overlay open; deck notices |
| invalid | invalid-thud.opus | Dull wooden knock | Rejected command; cannot afford |
| select | tile-tap.opus | Pawn tip tapping a cardboard tile once | Tile selected; deed offer opens |
| deselect | paper-flick.opus | Fingertip flicking a card corner | Selection cleared |
| skip | card-slide.opus | Card slid face-down across felt | Deed skipped |
| toll | toll-clink.opus | One brass coin into a metal toll box | Toll tile |
| bonus | bonus-coins.opus | Three coins landing in quick succession | Bonus tile |
| rival | rival-tap.opus | Pawn tapping twice, slightly distant | Rival roll, rival pass, rival idle |
| undo | paper-rewind.opus | Sheet of paper pulled back, reverse swish | Undo |
| hint | hint-bell.opus | Tiny desk bell, one ding | Hint |
| star | star-chime.opus | One small glass chime | Achievement unlocked |

Event priority when several fire in one command: they play in event order with 320 ms spacing, so a roll reads as dice → tile cue → (rival) → page/win.

## 10. Localization

The game ships in **English only**: every string is authored in `index.html` (static labels) and `js/ui.js` (`eventText`, `explainInvalid`, `hintText`, `describeRules`, help cards, results rows) and `js/content.js` (stage names, briefings, card text, achievement names). `<html lang="en">` is fixed; there is no language selector and no locale detection. Layout allowances already in place: buttons and list rows wrap, the tray wraps to multiple rows, panels cap line length at 70 ch under 560 px, and no label depends on a fixed width. Shipping en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR and it-IT is design intent (see the final section).

## 11. Accessibility

- **Keyboard-only path**: title → Play → stage button → Start → Enter to roll, arrows to select, Enter to build/buy, N to skip, Esc to pause, Tab into the board list to select tiles; results buttons are ordinary buttons. Focus is visible (3 px `#2e6fe4` outline) and restored after every overlay; `main` is inert while a dialog is open.
- **Screen reader**: `#live-region` (polite) announces stage start, every presented event, selection changes, invalid reasons, pause, lesson completion and the results headline with total; the board list buttons read "Harbor 1, property, owned by you, level 2, you are here"; the canvas is `role="img"` with a label; album and log are ordered lists.
- **No WebGL**: `Render.init` failure shows the banner and forces the board list on; the list is the complete playable surface.
- **Captions** for meaningful sounds (§9); no audio-only information exists.
- **Contrast**: ink `#3a2f22` on `#fff8ea` is about 10.7:1; muted `#7a6a52` on panel is about 4.6:1; High contrast mode goes to black/white/amber with `#00c2ff` focus and disables the paper grain; High-visibility palette swaps district stripes and the done-page colour.
- **Reduced motion**: Settings checkbox (also forces 60 ms event beats); not auto-detected from the OS.
- **Targets**: all buttons ≥ 44 × 44 CSS px, 8 px gaps; board-list rows 36 px tall (full width).
- Larger text, Left-handed tray, Haptics off, Always show board list are persisted settings.

## 12. StarHermit integration

Conventions follow https://wiki.starhermit.com/ (manifest at the distribution root, `launch` entry point, optional `server` script, same-origin `/api` routes).

| Feature | Status today |
|---|---|
| Packaging | `starhermit.txt` with `name`, `launch=index.html`, `owner`, `server=server.js`, `cover=coverart.png`; `LICENSE.md` at the root; `tests/` and `tools/` are dev-only |
| Server script | `server.js` serves static files (refuses dotfiles) and `/api/v1/time`, `/api/v1/daily`, `/api/v1/score`, `/api/v1/leaderboard` |
| Platform time | `probeServerTime()` at boot computes `serverOffsetMs` from `/api/v1/time` with round-trip halving; daily date and session ids use it; offline falls back to the client clock |
| Ranked results | Daily and challenge rounds POST `{entry, replay}`; the server rejects stale versions, unknown or future configs, seed/config mismatches, > 1000 commands, illegal or hash-mismatched replays, unfinished rounds, score/won discrepancies and wins under 3 s; accepted entries are stored once per session+config and ranked with `Store.sortEntries`; the client shows "Verified by server. Rank #r of n" or "Offline — score saved locally" |
| Leaderboards UI | Local top-20 from `localStorage` across all configs; the server board endpoint exists but is not read by the UI |
| Identity, presence, friends, invitations, chat, voice, sessions, cloud save, achievement sync, launch activity | Not used. Progress and achievements are local (`cityfortune.save.v1`); the Friends panel shows the current rival and the five most recent local sessions |

## 13. Technical architecture

- **Module graph** (classic scripts, load order fixed in `index.html`): `rng → rules → content → store → audio → game → render → ui`, then `main.js` (ES module) provides `THREE` and boots. `rules`, `content`, `store`, `game`, `rng` are UMD and shared with `server.js`, the tests and the validator, so client and server run identical code.
- **Determinism**: rules never read the clock; time arrives as `atMs` and is quantised to 100 ms. Cosmetic randomness (particles, camera nudge) uses `Math.random` and never touches state. `hashState` is FNV-1a over a key-sorted JSON of the state minus `events`.
- **Session/undo/replay**: `Game.createSession` keeps `initialState`, an undo stack of full states, `invalidCount`, and the replay envelope; `applyToSession` validates shape, applies, records command and hash.
- **Persistence**: `Store.save` writes `{sum, payload}` (FNV-1a checksum) under `cityfortune.save.v1`, with an in-memory fallback when `localStorage` throws; corrupt or future-version documents yield a fresh save; `migrate` merges defaults field by field. Local boards under `cityfortune.leaderboards.v1` (last 200). Server boards in `server-boards.json` (last 2000).
- **Rendering budget**: quality tiers `low` (DPR 1, no shadows, 40 % particles/decor), `medium` (1.5, shadows), `high` (2, full); `auto` picks low on mobile user agents or widths under 720 px. A round builds 8–17 tile groups, up to 14 decor tents, 1–2 tokens, and one marker; per-round resources are tracked and disposed in `clearBoard`. The frame loop stops rendering entirely while the tab is hidden; the solo clock pauses too. WebGL context loss triggers dispose → re-init → rebuild from the current state.
- **Time limit**: the UI clock (`clock.accumMs`) runs only on the game screen with no overlay open; the frame loop issues a `timeout` command when it passes the limit.
- **How the e2e test drives the UI**: `tests/e2e.mjs` serves the folder from an embedded `node:http` server on an ephemeral port with stubs for `/api/v1/*`, launches system Chrome through `playwright-core`, and clicks real controls (`#btn-title-settings`, `#set-reduced-motion`, `#btn-play`, first journey button, `#btn-setup-start`, `#btn-roll`/`#btn-buy`/`#btn-skip`, `#btn-pause`, `#btn-resume`, `#btn-hint`, `#btn-results-menu`, `#btn-modes-back`). It reads `window.CFUI._state()` only to decide buy vs. skip and to detect the terminal state.

## 14. Testing and acceptance criteria

`npm test` (`tests/run-tests.js`, 27 tests) verifies: RNG stream determinism and hashing; initial state; roll/move/resolve; every invalid reason; the buy flow; build cost, level and max-level; rival alternation and rent; rival never owns protected tiles; score breakdown sums; album win; turn-limit loss; timeout only when due; serialize round-trip; identical hashes for identical seed+commands and `verifyReplay`; tampered hash detection; undo (and `undo-disabled`); hints always legal; 300 fuzzed malformed commands never mutate state; content counts (40/6/3/5 themes/10 achievements, unique keys); every config structurally legal and terminating under a bot within 600 commands; daily determinism; lesson forced setups; store checksum/migration; tie-break order; server accepts an honest replay and rejects a lying score and a stale version; daily lookup rejects future dates.

`npm run validate` additionally plays every journey, challenge, practice and the last two dailies three times with a competent bot and requires termination, finite scores, valid levels, replay verification, and at least one win per non-challenge config.

`npm run test:e2e` passes when both the 1280×800 desktop pass and the 390×844 touch pass complete title → settings → modes → setup → full round → results → modes → title with zero console errors or page errors (GPU driver noise filtered).

QA bar as checkable statements: (1) a new player can reach a die roll in two clicks from the title and the setup dialog states the rules; (2) every implemented feature (all modes, undo, hint, pause, settings, help, achievements, boards, friends, board list, deep links) is reachable through visible controls; (3) no console errors or warnings during a full round at desktop and mobile sizes; (4) no text or control is cut off in the title, modes, game, results, and every overlay at 1280×800, 390×844 portrait and 844×390 landscape; (5) the game remains playable with WebGL disabled through the board list.

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `assets/key-art.webp` (1280×720, 58 KB) | Title screen hero image | FLUX.2 klein, seed 8801, 1536×864, 28 steps | generated in this pass, wired (`#title-art`, hidden on error) |
| `assets/results-album.webp` (1280×427, 30 KB) | Results screen illustration | FLUX.2 klein, seed 8802, 1536×512, 28 steps | generated in this pass, wired (`.results-art`) |
| `assets/paper-grain.webp` (512×512, seamless mirror tile) | Paper texture multiplied over panels, rails, status row | FLUX.2 klein, seed 8803, 512×512, 28 steps | generated in this pass, wired in CSS (off in high contrast) |
| `coverart.png` (1200×675, 324 KB) | Store cover | Key art (seed 8801) composited with title and tagline | generated in this pass (replaced a generic placeholder) |
| `icon.png` (256×256), `favicon.svg` | Launcher icon, tab icon | Authored vector | shipped |
| `sfx/*.opus` (16 clips: dice-rattle, pawn-hop, piece-land, coin-clink, salary-register, buy-stamp, build-hammer, rent-collect, rent-pay, card-flip, sticker-press, page-turn, win-fanfare, lose-trombone, ui-click, invalid-thud) | Event cues (§9) | MOSS-SoundEffect v2.0, 100 steps | shipped |
| `sfx/*.opus` (9 clips: tile-tap, paper-flick, card-slide, toll-clink, bonus-coins, rival-tap, paper-rewind, hint-bell, star-chime) | Cues for select, deselect, skip, toll, bonus, rival, undo, hint, star | MOSS-SoundEffect v2.0, 100 steps | generated in this pass, wired through `manifest.json` |
| `sfx/manifest.txt` / `manifest.json` / `manifest.md` | Canonical table / loader+generator input / generator output | Hand-written / tool | shipped |
| `vendor/three.module.min.js` | Renderer | Three.js (MIT) | shipped |
| 3D models, character animation | — | — | none required: all geometry is procedural card stock; there is no humanoid |

## 16. Known limitations

- English only; no locale switch.
- "Confirm buys and builds" is persisted but no confirmation step exists; buys and builds apply immediately.
- The Leaderboards overlay shows only the local board; the server's `/api/v1/leaderboard` is not displayed, and ranked verification depends on `server.js` being the host (the e2e stub returns "rejected", the game reports "Kept locally").
- Friends panel is a local summary; there is no platform friend list, presence or invitation.
- Events `land` and `coin` have clips but no trigger in the UI.
- The results reason for a win on a clock-only config (turnLimit 0) reads "with 0 turns to spare".
- Reduced motion is a manual setting; `prefers-reduced-motion` is not read.
- Undo reverses a whole command including the rival's reply, so it cannot revisit a single deed decision after the rival has moved.
- Journey best scores and stars are stored locally only; clearing site data resets progress.
- Tutorial lessons keep the board playable after the goal, so a lesson round can run until the 40-turn limit if the player keeps rolling.

## Design intent not yet implemented

- Ship the nine locales (en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT) with a string table and a language selector honouring `navigator.languages`, with 30 % expansion room on the tray and setup dialog.
- Use StarHermit identity, presence and friends for the Friends panel, invitations for shared boards, cloud save for progress, and the platform leaderboard/achievement endpoints instead of local storage and `server-boards.json`.
- Show the server leaderboard (global and friends filter) in the Leaderboards overlay.
- Implement the confirm-moves assist as a second press or inline confirm on Buy/Build.
- Trigger `land` at the end of every token move and `coin` on coin-count changes; add a soft time-warning cue at 10 s remaining.
- Honour `prefers-reduced-motion` as the default for the Reduced motion setting.
- Extend the e2e playthrough to a Learn lesson, the daily, and a landscape phone viewport.
