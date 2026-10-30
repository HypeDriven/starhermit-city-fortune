# City Fortune — Game Design Document (running spec)

Present tense: this document describes what the shipped game does today. Anything the design wants but the code does not yet do is collected in the final section, "Design intent not yet implemented".

## 1. Overview

**Pitch.** Roll a die around a pop-up paper city, buy the districts before your rival snaps them up, build taller paper houses for rent, and complete every page of the board's sticker album before the turns (or the clock) run out.

| | |
|---|---|
| Genre | Solo roll-and-move board game with a deterministic rival and album (set-collection) goals |
| Players | 1 human; an optional scripted rival ("Penny", "Brick", "Moss", "Vela", "Cobalt") shares the circuit on alternating turns |
| Session | 3–9 minutes per round (par times 240–560 s); a Learn lesson is under a minute |
| Platforms | The StarHermit engine 1.30.0 (host API 1.32): natively in the StarHermit client, and in desktop and mobile browsers (portrait and landscape) through the engine's web runtime |
| Rendering | `starhermit:scene` (the three.js model) perspective scene of a circular paper board, its look per the runtime's graphics level; all UI is `starhermit:ui` (immediate mode) beside/over the playfield; a board list of tile buttons carries the same information as the 3D scene |
| Hosting | One engine package (`starhermit.txt`, entry `native/main.ts`); browsers open the loader `index.html` that `npm run package` writes; on StarHermit the platform script is `score-script.js` (leaderboard posting); `server.js` (Node 18+, no dependencies) is a local dev server that verifies scores by replaying them (tests only) |

**File map**

| Path | Owns |
|---|---|
| `starhermit.txt` | Manifest: name, description, owner, `server=score-script.js`, cover, `launch=index.html`, `engine.api=1`, `engine.entry=native/main.ts`, `engine.version=1.30.0`, `engine.minor=32`, `engine.capabilities=platform,storage,clipboard`, ten `control.*` actions with `engine.gamepad.*` defaults and groups |
| `index.html`, `starhermit-files.json` | The engine's web loader (pins 1.30.0 on wiki.starhermit.com by hash) and the package's file index, written by `npm run package`; never edited by hand |
| `native/main.ts` | Entry: navigation, command pipeline, event presentation on fixed steps, selection, round clock and time limits, lessons, results and achievements, input, lifecycle |
| `native/screens.ts` | Every screen, the round's HUD and every dialog in `starhermit:ui`; the layouts (wide / compact / phone portrait / short landscape); drawn glyphs instead of symbol fonts |
| `native/render.ts` | The paper city on `starhermit:scene`: board, tiles, pop-up decor, pawns, owner buildings, selection and build rings, confetti, the camera framed into the playfield (`setViewOffset`), picking |
| `native/quality.ts` | The old presets' looks and budgets keyed by the runtime's quality tier and level |
| `native/audio.ts` | Authored clips per event (`sfx/manifest.json`), captions, rendered ambience and pad |
| `native/platform.ts` | Save (`saves`, foreign-save migration, conflict merge), the game's settings (`settings`, legacy import), invite link, leaderboard read and posting, platform clock |
| `native/i18n.ts`, `native/style.ts`, `native/classic.ts` | Locale from the runtime's language; the UI styles (`assets/ui-style.json` from `tools/ui-style.css`); the classic-script loader with a `localStorage` shim over device storage |
| `js/rng.js` | mulberry32 PRNG, FNV-1a `hashString`, three derived streams (rules / decor / av) per master seed |
| `js/rules.js` | Pure deterministic rules engine: creation, legality, resolution, scoring, hashing, serialization, hints |
| `js/content.js` | Versioned content: districts, themes, 40 journey stages, 6 challenges, 3 practice presets, daily generator, 5 Learn lessons, 10 achievements |
| `js/store.js` | Save document (checksum, migration, `docFromSave`, `fromBrowserSave`, `mergeProgress`), the game settings' checks, local leaderboard and tie-break sort |
| `js/game.js` | Session wrapper: command log, undo stack, replay envelope and verification, shared board geometry (`tilePos`) |
| `js/i18n.js`, `js/strings.js`, `js/platform-strings.js` | `CFI18N` (`T()`, `setLocale`) and the nine-locale tables keyed by the English source strings; the platform lines' tables |
| `score-script.js` | StarHermit platform script (`server=`): range-checks a finished round's total and posts it to the `high-score` leaderboard |
| `server.js` | Local dev server (static host, `/api/v1/time`, `/daily`, `/score`, `/leaderboard`, replay verification); left out of the package |
| `tests/` | `run-tests.js` (rules, content, store, server), `save.test.mjs` (engine save and migration), `i18n.test.mjs`, `native.mjs` (tsc, `starhermit check`, the play scripts in `tests/native/`, web index) |
| `tools/` | `package-web.mjs`, `css.mjs` + `ui-style.css`, `gen-play.mjs` (play scripts from the rules), `browser-play.mjs` (headless Chrome), `validate.js` (content validator) |
| `sfx/`, `assets/` | 25 Opus clips + manifests; key art, results illustration, paper grain, `ui-style.json` |
| `coverart.png`, `cover.jpg`, `icon.png` | Store cover art, cover, 256×256 icon |
| `LICENSE.md` | PolyForm Noncommercial 1.0.0 |

## 2. Vision and design pillars

The fantasy is a craft-table diorama: a cardboard ring, folded card-stock houses, a red wooden cone for you and a blue one for the rival, and a sticker album whose pages are the goals. Everything on screen should look like it could be cut and folded by hand.

1. **The album is the objective, not the bankroll.** A round is won only by completing every album page (`Rules.checkAlbum`); coins, property and rent are means and score components, never the win condition. Rules in: district sets, laps, stickers, upgrades and rent pages; rules out: bankrupting the rival, "last player standing", open-ended play.
2. **A friend can pressure you but never wreck you.** The rival contests only property outside album districts (`Rules.protectedDistricts`), so set progress can be slowed but not destroyed. Rules in: the rival buying non-album districts and collecting rent from you; rules out: the rival buying an album tile, trading, or taking property away.
3. **Every roll is inspectable.** All randomness comes from a 32-bit seed through three named streams; the same seed and command list always produce the same hashes, and the server re-plays ranked rounds rather than trusting a total. Rules out: hidden modifiers, time-of-day luck, cosmetic randomness bleeding into rules.
4. **Paper first, spectacle second.** Flat-shaded card-stock materials, a fixed authored camera, one warm key light. Effects are small paper confetti bursts and a 1–2 cm camera nudge, all removable by Reduced motion, and never needed to read the state; the board list carries the same information as the 3D scene.
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

**Journey stars** (`native/main.ts endRound`): 1 for the win, +1 if `turn ≤ par.turns`, +1 if `par.timeSec` and elapsed ≤ par time. Stars unlock the next stage (any star) and cosmetic themes.

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
| Daily | Title or Modes → "Play today's daily" | `Content.dailyConfig(date)`: one immutable config per UTC day (server time offset applied); districts, tolls, stickers, deck, rival name and theme rotate on `day % 7`; 40 turns; time limit on rotation 6 | Undo + Hint | Yes: posted to the platform `high-score` board like every non-lesson round |
| Challenge | Modes → Challenges (6) | c1 Express Circuit (22 turns, no undo), c2 Speed Tycoon (240 s), c3 Thin Wallet (120 coins), c4 Stiff Rents (aggressive Brick), c5 Sticker Sprint, c6 Grand Constraint (turns + clock, no assists) | Per config | Yes |
| Practice | Modes → Practice | Relaxed (solo), Standard (Penny), Expert (Brick, reserve 0) | Undo + Hint | No |
| Learn | Modes → Learn (5 lessons) | t1 Roll and move, t2 Buy property (opens on a forced deed offer), t3 Build up (pre-owned Harbor 1, 400 coins), t4 Finish an album page (buy Harbor 2), t5 Second chances (undo) | Per lesson | No; completion ticks persist |

**Difficulty curve.** Prices rise from tier 0 to tier 2, ring size and page count grow, tolls climb from 30 to 100, decks widen (light → standard → full), rival reserve drops to 0 on "Spree/Push" stages, starting coins are squeezed on "Tight Purse" and "Thin Air", and time limits appear from j16.

**Unlocks.** Themes: Paper Dawn 0★, Canal Dusk 12★, Blossom Festival 30★, Midnight Metro 55★, Harvest Fair 85★ (of 120 possible). Journey stages carry their own theme; the Settings theme applies to modes without one. Achievements (10, stable lowercase keys, idempotent): first-buy, first-page, first-win, rent-500, builds-25, journey-half (20 stages), journey-done (40), daily-7, score-4000, laps-50.

## 6. Controls and interaction

**Actions** (`starhermit.txt`; players rebind keys and pads in the runtime's Options › Controls, which Settings › "Change keys and buttons" opens). Active on the round with no dialog open:

| Action | Keys | Gamepad | Effect |
|---|---|---|---|
| confirm | Enter / Space | A (South) | Primary: Buy when a deed is offered; Build if the selected tile can be built on; otherwise Roll. A focused button acts by itself instead |
| prev / next | ← ↑ / → ↓ | D-pad, left stick | Cycle the selected tile around the ring (announced with kind and build cost) |
| buy / skip | B / N | X (West) / LB | Buy / Skip the offered deed |
| undo / hint | U / H | Select / Y (North) | Undo / Hint (when the mode allows) |
| settle | C | RB | Skip the event presentation and settle the board |
| pause | P | Start | Pause |
| cancel | Esc | B (East) | Pause; closes the innermost dialog; on the mode select, back to the title |

Tab and the D-pad move the UI focus through every button; Escape/B closes dialogs. Mute is the runtime's (Options › Audio); the browser build's M key is gone.

**Pointer / touch.** A tap on the board (≤ 12 px movement, ≤ 600 ms, not over a widget) raycasts against tile tops only (`render.pick`); a hit selects the tile, a miss clears the selection. Every tile is also a button in the board list. Tray buttons are at least 44 px; on portrait phones they are rows of three equal buttons. Left-handed mode reverses the tray order.

**Input locking.** `presenting` is true while the events of one command are shown (320 ms per event, 60 ms with reduced motion, 0 after C), counted in the runtime's fixed steps (60 a second); during it the action buttons are disabled and commands are ignored. The lock ends when the last event has been shown and the board has settled. With "Confirm buys and builds" on, Buy and Build take a second press (the button reads "Confirm buy" / "Confirm build" in between).

**Feedback per input.** Accepted command: `ui` click + 12 ms vibration (if Haptics is on) + per-event sounds, City news lines, screen-reader announcement and 3D animation. Rejected command: `invalid` thud, a red news line and an announcement with the reason (`explainInvalid`). Selection: `select` tap, accent ring on the board, the description line above the status row ("Harbor 1 · property · yours, level 2 · rent 12/33/63"), the selected state in the board list. When a tray button had focus, focus follows the next decision (Buy on an offer, Roll after it).

## 7. Screens and UI flow

`title → modes → [setup dialog] → round → results`, plus dialogs: setup, pause, settings, help, achievements, leaderboards, friends, and the Album and News drawers on narrower layouts. Dialogs stack (Settings and Help open over Pause and return to it); each opens at its top. Leaving a round from Pause resigns through the rules (so the result is recorded) except in Learn, which returns to the title.

- **Title**: key art (full bleed; dropped below 420 px of height), tagline, Play, Daily challenge, daily status line, journey progress, account line, then Leaderboards / Achievements / Settings / Help, Invite a friend (signed in) and Sign in with StarHermit (guests). The panel scrolls when the window is shorter than it.
- **Modes**: up to three columns (Journey; Daily + Challenges; Practice + Learn) by width; the whole screen scrolls. Locked stages are disabled; stars and the Mastery tag are drawn.
- **Setup dialog**: name, Rules, Expected duration, Players, Assists, Ranked, Briefing; Start / Cancel.
- **Round** (wide ≥ 1024 px): left rail Album (+ rival line), centre playfield (the 3D board framed into it), selection line, optional board list, status row (phase / turn / clock / coins / score), action tray; right rail City news (last 30 lines, kept at its end). Compact: the rails are drawers opened by Album / News in the tray. Phone portrait (≤ 720 px wide): the status row on top, the tray in rows of three at the bottom. Short landscape (≤ 480 px tall): a 150 px Album rail on the left, News a drawer. The lesson card sits in flow above the playfield (Got it hides it). The board list takes at most 30 % of the height and leaves the playfield at least 40 %.
- **Results**: album illustration (windows taller than 560 px), headline, reason, the seven-row breakdown with total, newly unlocked achievement chips, next-action line, leaderboard line (signed in), then Next (journey wins), Retry, Modes, Title.
- **Settings**: Audio (where volumes live, Open Options, Captions for sounds), Graphics (where quality lives, Theme with locked themes shown disabled, Color palette), Accessibility & controls (Left-handed controls, Haptics, Always show board list, Confirm buys and builds, where reduced motion / contrast / text size live, Change keys and buttons), Done. **Help**: goal, tile legend, rival rule, the current key bindings and "Right now: legal actions".

The layout works in the window's safe area; text sizes and the interface scale follow the runtime's accessibility settings.

## 8. Art direction

**Palette (UI tokens, `tools/ui-style.css`).** Background `#f2e4c8`, panel `#fff8ea`, ink `#3a2f22`, accent `#e07f3e` (accent ink `#fff`), muted `#7a6a52`, line `#d9c49a`, focus `#2e6fe4`, danger `#b85450`, canvas well `#e8d8b8`, done-page green `#2e7d32`, pressed tile `#fff3d6`. High contrast is the runtime's and forces the UI's colours.

**Scene palettes (`Content.THEMES`).** Paper Dawn sky `#f2e4c8` / ring `#f6ecd4` / edge `#b89a6a` / light `#ffe0b0` / accent `#e07f3e` / you `#d94f3d` / rival `#4a6fa8`; Canal Dusk sky `#24324a`, accent `#7fb0ff`, you `#ffb066`, rival `#8fd6a0`; Blossom Festival sky `#f6dce4`, accent `#d95f8a`, you `#7a4fb8`; Midnight Metro sky `#161a26`, accent `#ffc46a`, you `#ffd90a`; Harvest Fair sky `#f0d8b0`, accent `#b86a2e`, you `#8a4fb8`. Tile kinds keep fixed colours across themes: bonus `#7fbf6a`, toll `#c05a4a`, card `#6a8fc0`, sticker `#c9a0dc`, park `#8aa86a`; property tiles are the ring colour mixed 35 % toward white with a district stripe: Harbor `#4a7fb8`, Market `#d9934a`, Garden `#5d9c59`, Arts `#8e6fc0`, Tech `#4aa8a8`, Old Town `#b85450` (high-visibility set `#2e6fe4 #b7791f #17a398 #8e24aa #00838f #c62828`). Colour is never the only cue: every district has an icon and label in the album and board list.

**Shape language.** Everything is folded card: tiles are thin boxes (0.30 × 0.055 × 0.42 units), the Start arch is an accent-coloured tent, and seeded decorations fill the ring interior. With Scene detail *Plain* (the Low preset), buildings are four-sided paper tents on a card base whose height grows 0.14 per level, tokens are cones with a white paper collar, and 8 decorative tents fill the ring. With *Detailed*, owned buildings are pop-up houses (walls tinted toward the owner's colour, a roof in the owner's colour, one row of window cut-outs per level), tiles carry an inset printed card face, 16 decorations mix houses, paper pine trees and tents, the board sits on a craft table that catches its shadow, and tokens are lacquered pawns (cone body, ball head, clear-coat `MeshPhysicalMaterial`). Paper materials are `MeshStandardMaterial` (roughness 0.8–1, metalness 0.02, flat shading; a procedural paper-grain texture at Detailed) under one warm directional key with a hemisphere fill; ACES filmic tone mapping at 1.05 exposure into sRGB output; fog from 4.5 to 9 units.

**Hero.** The board ring with its tokens is the hero; the camera is fixed at (0, 2.35, 2.65) looking at the origin, FOV 48, so the whole ring and the pop-up skyline are always framed.

**Typography.** The engine's default sans faces; h1 30 px (24 px under 560 px), rails 14.7 px, logs 13.6 px; the runtime's text size scales all UI text. Symbols (stars, check marks, pause, smiley, menu, clock, medal, note) are drawn glyphs, not font characters.

**Motion.** Token hops ease in-out over 0.45 s with up to four sine hops; buildings pop in with a cubic ease over 0.35 s; confetti planes (4 per power at Confetti *Low*, 14 in mixed event/accent/white colours at *High*) fall under gravity for 0.7 s; page/win events add a 0.012/0.02 camera nudge decaying at 0.04/s from an authored base pose (never cumulative). The selection ring pulses gently; with Ambient motion *Animated*, waiting tokens bob by under 1 cm and ~70 paper flecks drift slowly above the table. Reduced motion (the runtime's preference) freezes the ambient pulse, bob and drift, shortens event beats to 60 ms, makes token moves and pops instant, removes camera shake and clamps particle updates.

**Graphics.** A warm key directional light (the browser build's three.js r160 intensities, its shadow box fitted to the board disc) casting shadows on the higher levels, a hemisphere fill, and on Balanced and above image-based lighting (`PMREMGenerator.fromScene(new RoomEnvironment(renderer))` as each standard material's own envMap at its old envMapIntensity: paper 0.15, pawns and windows 1). Window cut-outs are emissive lamps, dim on day themes and glowing on night themes; the selection ring is HDR-bright when bloom is on. Post-processing is the runtime's: `renderer.ao` (GTAO), `renderer.bloom` (strength 0.42, radius 0.35, threshold 1.0), `renderer.grade` (gentle S-curve, +10 % saturation, cool shadows / warm highlights, vignette 0.2) and `renderer.antialias`. The look follows the runtime's graphics level (Options › Graphics): its quality tier picks the old preset (`native/quality.ts`), and the level within the tier scales the flecks and confetti (≤ 4×). Auto, render scale, adaptive resolution, the frame-rate limit and readout, shadow-map size and MSAA samples are the runtime's.

| Tier | Shadows | AO | Bloom / grade | AA | IBL | Scene detail | Ambient motion |
|---|---|---|---|---|---|---|---|
| Low | off | off | off | MSAA | off | plain | still |
| Balanced | 1024 | off | on | FXAA | on | detailed | animated |
| High | 2048 | on | on | SMAA | on | detailed | animated |
| Ultra | 4096 | high | on | MSAA | on | detailed | animated |

| Budget | Low | Balanced | High | Ultra |
|---|---|---|---|---|
| Card/paper material | Lambert | Standard | Standard | Standard |
| Pawns (detailed scene) | card | Standard lacquer | clear-coat Physical lacquer | clear-coat Physical lacquer |
| Paper-grain texture | 64² | 128² | 256² | 512² |
| Round-geometry segments | ×0.5 | ×0.75 | ×1 | ×1.5 |
| Pop-up props inside the ring | 4 | 12 | 16 | 22 |
| Drifting flecks | 24 | 40 | 70 | 120 |
| Confetti per burst | 6 | 10 | 14 | 20 |
| Bloom / GTAO resolution | ½ / ½ | ½ / ½ | ½ / ½ | full / full |

A level change rebuilds the board from the current state. Flat-shaded card is non-indexed geometry; each house's windows are one instanced draw; paper materials are shared per colour within a board.

**Visual assets the design calls for.** Title key art (paper city diorama), results illustration (open sticker album), subtle paper-grain texture for panels, a cover image in the same diorama style, and the icon/favicon. All are shipped (see §15).

## 9. Audio direction

**Mix.** The runtime's buses (Options › Audio owns volumes, mute and the voice limit): music, effects (effects and ambience), interface (the click). The old bus levels (music 0.6, effects 0.9, ambience 0.5) are folded into each sound's gain. Ambience is a quiet brown-noise city hum (low-pass 300 Hz, gain 0.32) and music a slow generative pad walking C–Am–F–G an octave down every 5.2 s; both are rendered once into clips (`createClip`) and play from the title on. Effects are the authored Opus clips (`sfx/<name>.opus`) mapped by `sfx/manifest.json`, loaded one at a time once the mixer runs (in a browser after the first press); an event whose clip has not loaded yet is silent (the browser build's synthesized stand-ins are not ported). Captions (Settings → "Captions for sounds") show a note line for 2.5 s.

**SFX event table** (source of `sfx/manifest.txt`):

| Event id | File | Sound | Usage |
|---|---|---|---|
| dice | dice-rattle.opus | Two dice rattling in a cup then tumbling on wood | Your roll |
| hop | pawn-hop.opus | Wooden pawn hopping one tile on cardboard | Landing on Start, park, own property; card-driven move |
| land | piece-land.opus | Wooden piece landing with a soft thud | Mapped in the manifest; no current trigger |
| coin | coin-clink.opus | A few coins clinking in a hand | Mapped in the manifest; no current trigger |
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

Nine locales ship: **en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT**; `<html lang>` is set to the resolved tag.

- **Strings.** English source strings are the keys; `js/strings.js` holds the tables (es-419, de-DE, fr-FR, pt-BR, it-IT in full; en-GB derived with British spelling — colour, harbour; es-ES and fr-CA list only their differences, e.g. es-ES *pegatina*, fr-CA *pointage*). Every string the client draws goes through `tr()` each frame: HUD, tray, news log, setup dialog, hints, invalid-action messages, selection and board-list labels, results, help, achievements, leaderboards, friends, toasts, announcements and captions. Content data stays English and is translated at display time (stage, challenge and practice names, briefings, lessons, districts, album pages, chance cards, themes, achievements). "City Fortune", "StarHermit" and the rival names stay as they are.
- **Language.** The runtime's interface language (Options › Language: the player's choice, else the account's preferred language or the device's) picks the nearest shipped locale (es-MX → es-419, en-AU → en-GB, fr → fr-FR); a change shows at once, the round untouched. The game's own language menu is gone.
- **Expansion.** Labels too wide for their space wrap into paragraphs; tray and button rows wrap.

## 11. Accessibility

- **Keyboard / gamepad path**: title → Play → stage → Start → Enter to roll, arrows to select, Enter to build/buy, N to skip, Esc to pause; Tab (D-pad) reaches every button, including the board list's tiles. Focus rings are 3 px `#2e6fe4`.
- **Screen reader**: `ui.announce` speaks stage start, every presented event, selection changes, invalid reasons, pause, lesson completion and the results headline with total; every widget has an accessible name (glyph buttons: Pause, Friends, Toggle board list).
- **Captions** for meaningful sounds (§9); no audio-only information exists.
- **Contrast, text size, reduced motion**: the runtime's (Options › Accessibility); high contrast forces the UI's colours. The High-visibility palette swaps district stripes and the done-page colour.
- **Targets**: buttons ≥ 44 × 44 px, 8 px gaps; board-list rows 36 px tall.
- Left-handed tray, Haptics, Always show board list and Confirm buys and builds are the game's own settings.

## 12. StarHermit integration

The runtime provides the platform (`starhermit:platform`, `starhermit:storage`); the game never sees a token.

| Feature | Status today |
|---|---|
| Packaging | `starhermit.txt` as in §1; `.starhermitignore` leaves out `tests/`, `tools/`, `server.js`, `spec.md`, `coverart.png`; `npm run package` writes the web loader and file index |
| Player | `player()`: the title's account line reads "Playing as <name>"; guests see "Offline — progress is stored on this device." and Sign in with StarHermit (`requestSignIn`); a session ending shows a toast |
| Save | `saves`: `{ v: 1, progress }` on the device and in the cloud slot, debounced by the runtime; a conflict merges both copies with `Store.mergeProgress`; another device's newer save is merged in when it arrives |
| Old cloud saves | The browser build's slot `game:city-fortune` (the JS SDK's zipped `save.json` holding the checksummed `{sum, payload}` document) shows as foreign: its progress is merged in and its game settings adopted, then it is replaced once (`replaceForeign`). Guests' old browser `localStorage` progress does not carry over |
| Settings | `settings` (game.<key>, synced with the account): theme, colorPalette, captions, leftHanded, haptics, boardMirror, confirmMoves. The browser build's per-player settings keys are imported (game keys only, unless set since) and removed |
| Controls | Ten actions with keyboard and gamepad defaults; rebinding is the runtime's |
| Invite link | Signed in, Invite a friend copies `inviteLink()` with a toast |
| Server time | `serverTime()` at start; the daily's UTC date and session ids use `serverNow()`, else the device clock |
| Leaderboard posting | Signed in, every finished round except lessons posts its total through `score-script.js` (a practice session carrying `{ type: 'result', scores: { 'high-score': n } }`); the results show "Leaderboard rank: #N" (or posted / not posted) |
| Leaderboards UI | The platform `high-score` board's top 20 (names from profiles, own row marked) when it can be read (guests too, once its id is known on the device), above the local top 20 |
| Reports, language, graphics, audio, accessibility | The runtime's Options (F1) |
| Platform achievements, presence, chat, voice | Not used: achievements stay in the save; the Friends panel lists recent local sessions |

Platform strings (sign in, invite, toasts, leaderboard line) ship in all nine locales (`js/platform-strings.js`, following the game language).

## 13. Technical architecture

- **Module graph**: `native/main.ts` imports `classic.ts` first, which installs the `localStorage` shim and loads `rng → rules → content → store → game → strings → i18n → platform-strings` as classic scripts (`loadClassic`); the same UMD files run in `server.js`, the tests and the validator.
- **Determinism**: rules never read the clock; time arrives as `atMs` and is quantised to 100 ms. The round clock and the presentation beats count fixed steps, so pauses, a hidden window and slow frames cost no time and play scripts replay exactly. Cosmetic randomness uses `Math.random` and never touches state.
- **Session/undo/replay**: `Game.createSession` keeps `initialState`, an undo stack, `invalidCount` and the replay envelope.
- **Persistence**: the engine save (§12); local boards under `cityfortune.leaderboards.v1` in device storage (last 200).
- **Time limit**: the clock runs on the round with no dialog open and stops while the window is suspended; a `timeout` command ends the round when it passes the limit.
- **Rendering**: the 3D board draws only during a round (`renderer.camera`), framed into the playfield with `camera.setViewOffset`; the page colour is painted around it. A round builds 8–17 tile groups, 4–22 decorations, 1–2 pawns and one marker; a new round or level disposes the old board.

## 14. Testing and acceptance criteria

`npm test` runs:

- `tests/run-tests.js`: RNG determinism and hashing; initial state; roll/move/resolve; every invalid reason; the buy flow; build cost, level and max-level; rival alternation and rent; protected districts; score breakdown; album win; turn-limit loss; timeout only when due; serialize round-trip; replay hashes and `verifyReplay`; tampered hash detection; undo; hints always legal; fuzzed malformed commands; content counts and legality; daily determinism; lesson setups; store checksum/migration; tie-break order; server replay verification; daily lookup.
- `tests/save.test.mjs`: the browser build's cloud save converts to `{ v: 1, progress }` plus game settings (volumes and graphics dropped); corrupt / newer saves ignored; merge keeps the better of both; settings checks; the local board through the shim.
- `tests/i18n.test.mjs`: every key `native/*.ts`, the content and the captions use exists in all nine locales with intact placeholders, no table keeps an unused key, and `setLocale` switches with the regional tables.
- `tools/validate.js`: every config played by a bot terminates with valid scores and replays.
- `tests/native.mjs`: the web index matches the files, `tsc` (strict, with the runtime's declarations), `starhermit check .` with no warnings, and the play scripts as signed-out offscreen runs: `screens.play` (dialogs, a setting toggled, the Roll and move lesson to its goal, drawers, pause → help → leave), `journey-first-steps.play` and `practice-rival.play` (generated by `tools/gen-play.mjs` from the rules: full rounds to "Album complete!", the second with the rival and builds).

`npm run test:browser` (`tools/browser-play.mjs`) loads the packaged loader in headless Chrome at 1366×768, 390×844 and 844×390, plays by keyboard and taps, and fails on console errors or warnings or the runtime's error screen.

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `assets/key-art.webp` (1280×720, 58 KB) | Title screen hero image | FLUX.2 klein, seed 8801, 1536×864, 28 steps | generated in this pass, wired (title, decorative) |
| `assets/results-album.webp` (1280×427, 30 KB) | Results screen illustration | FLUX.2 klein, seed 8802, 1536×512, 28 steps | generated in this pass, wired (results) |
| `assets/paper-grain.webp` (512×512, seamless mirror tile) | Paper texture multiplied over panels, rails, status row | FLUX.2 klein, seed 8803, 512×512, 28 steps | generated in this pass, wired as the panels' background image |
| `coverart.png` (1200×675, 324 KB) | Store cover | Key art (seed 8801) composited with title and tagline | generated in this pass (replaced a generic placeholder) |
| `icon.png` (256×256) | Launcher icon | Authored vector | shipped |
| `sfx/*.opus` (16 clips: dice-rattle, pawn-hop, piece-land, coin-clink, salary-register, buy-stamp, build-hammer, rent-collect, rent-pay, card-flip, sticker-press, page-turn, win-fanfare, lose-trombone, ui-click, invalid-thud) | Event cues (§9) | MOSS-SoundEffect v2.0, 100 steps | shipped |
| `sfx/*.opus` (9 clips: tile-tap, paper-flick, card-slide, toll-clink, bonus-coins, rival-tap, paper-rewind, hint-bell, star-chime) | Cues for select, deselect, skip, toll, bonus, rival, undo, hint, star | MOSS-SoundEffect v2.0, 100 steps | generated in this pass, wired through `manifest.json` |
| `sfx/manifest.txt` / `manifest.json` / `manifest.md` | Canonical table / loader+generator input / generator output | Hand-written / tool | shipped |
| 3D models, character animation | — | — | none required: all geometry is procedural card stock; there is no humanoid |

## 16. Known limitations

- The client does not call `server.js`'s `/api/v1/score` replay verification (only the server tests do); platform posts are range-checked, not replay-verified.
- The browser build's deep links (`#daily`, `#journey-…`) are gone: the runtime gives the game no page address.
- Clips play once loaded; until then (the first moments in a browser) events are silent rather than synthesized.
- Friends panel is a local summary; there is no platform friend list, presence or invitation.
- Events `land` and `coin` have clips but no trigger in the UI.
- The results reason for a win on a clock-only config (turnLimit 0) reads "with 0 turns to spare".
- Undo reverses a whole command including the rival's reply, so it cannot revisit a single deed decision after the rival has moved.
- A guest's progress lives on the device only; signed in it is in the cloud save.
- Tutorial lessons keep the board playable after the goal, so a lesson round can run until the 40-turn limit if the player keeps rolling.

## Design intent not yet implemented

- Use StarHermit presence and friends for the Friends panel and invitations for shared boards.
- Show the own-server verified board and a friends filter in the Leaderboards dialog.
- Trigger `land` at the end of every token move and `coin` on coin-count changes; add a soft time-warning cue at 10 s remaining.
