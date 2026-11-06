// Sound, as the browser build's js/audio.js: the authored one-shots
// (sfx/<name>.opus, mapped to the game's logical events by
// sfx/manifest.json), the captions it showed for meaningful sounds when
// "Captions for sounds" is on, the quiet city ambience (brown-ish noise
// lowpassed at 300 Hz) and the slow generative pad (C, Am, F, G an octave
// down: three voices a chord, rising over 1.8 s and gone by 6.4 s, a chord
// every 5.2 s).
//
// The browser build's four buses become the runtime's (Options › Audio owns
// the volumes, the mute and the voice limit): music → "music", effects and
// ambience → "effects", the menu click → "interface"; the old default bus
// levels (music 60 %, effects 90 %, ambience 50 %) are folded into each
// sound's gain. The pad and the ambience are offline graphs rendered once into
// clips; the synthesized stand-ins the browser build played while a sample
// loaded are not ported. Every clip loads and every voice renders at once in
// onStart; the beds and the pad start once the mixer runs (in a browser after
// the first press).
import { files } from "starhermit:engine";
import { OfflineAudioContext, context, createClip, loadClip, play as playClip, type AudioClip, type Bus, type Sound } from "starhermit:audio";

const LEVEL = { music: 0.6, effects: 0.9, ambience: 0.5 };
/** Caption text per logical event (js/audio.js CAPTIONS). */
const CAPTIONS: Record<string, string> = {
  select: "select", invalid: "not allowed", dice: "dice roll", coin: "coins", salary: "salary",
  buy: "property bought", skip: "passed", build: "building up", "rent-get": "rent collected",
  "rent-pay": "rent paid", toll: "toll", bonus: "bonus", card: "chance card", sticker: "sticker",
  page: "album page complete", win: "album complete", lose: "round lost", undo: "undo",
  hint: "hint", star: "achievement", rival: "rival moves", land: "landed",
};
const eventFile = new Map<string, string>();
const clips = new Map<string, AudioClip>();
/** Reads the manifest and loads every clip at once (onStart); a cue whose clip is still loading is silent. */
export function loadSfx(): void {
  void renderVoices().catch((e: unknown) => console.warn(`audio: ${String(e)}`));
  try {
    const list = files.readJson("sfx/manifest.json") as unknown as { name?: string; event?: string }[];
    for (const e of Array.isArray(list) ? list : []) {
      if (e && typeof e.name === "string" && typeof e.event === "string" && !eventFile.has(e.event)) eventFile.set(e.event, e.name);
    }
  } catch (e) { console.warn(`sfx manifest: ${String(e)}`); }
  for (const name of new Set(eventFile.values())) {
    loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); }, (e: unknown) => console.warn(`sfx ${name}: ${String(e)}`));
  }
}

let captionFn: ((text: string) => void) | null = null;
/** fn(caption key) for each meaningful sound (the browser build's caption strip). */
export function onCaption(fn: (text: string) => void): void { captionFn = fn; }

/** Plays a logical event's sample (js/audio.js play); unknown or still-loading samples are silent. */
export function play(event: string): void {
  const file = eventFile.get(event);
  const clip = file ? clips.get(file) : undefined;
  if (clip) {
    const bus: Bus = event === "ui" ? "interface" : "effects";
    try { playClip(clip, { bus, gain: LEVEL.effects }); }
    catch { /* the mixer is full this frame: skip it */ }
  }
  const cap = CAPTIONS[event];
  if (cap && captionFn) captionFn(cap);
}

// -- rendered voices ------------------------------------------------------------------------
const RATE = 11025;
/** One pad chord an octave down: a triangle root and two sines, up to 0.05 over 1.8 s, gone by 6.4 s. */
async function renderChord(freqs: number[]): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, Math.round(6.6 * RATE), RATE);
  const env = off.createGain();
  env.gain.setValueAtTime(0, 0);
  env.gain.linearRampToValueAtTime(0.05, 1.8);
  env.gain.linearRampToValueAtTime(0, 6.4);
  env.connect(off.destination);
  freqs.forEach((f0, vi) => {
    const osc = off.createOscillator();
    osc.type = vi === 0 ? "triangle" : "sine";
    osc.frequency.value = f0 * 0.5;
    osc.connect(env);
    osc.start();
  });
  return createClip(await off.startRendering());
}
/** The city hum: brown noise lowpassed at 300 Hz, Q 0.707 (−3 dB), a seamless 4 s loop (filtered periodic noise is periodic once settled). */
const HUM_GAIN = 0.3163; // measured: rms 0.0586, the old hum's
async function renderHum(): Promise<AudioClip> {
  const n = 4 * RATE, settle = Math.round(0.25 * RATE);
  const off = new OfflineAudioContext(1, settle + n, RATE);
  const noise = off.createNoise({ color: "brown", seed: 4242, seconds: 4 });
  const lp = off.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 300;
  lp.Q.value = -3.01;
  const g = off.createGain();
  g.gain.value = HUM_GAIN;
  noise.connect(lp).connect(g).connect(off.destination);
  noise.start();
  const r = await off.startRendering();
  return createClip([r.getChannelData(0).slice(settle)], RATE);
}
const CHORDS = [[261.63, 329.63, 392.0], [220.0, 261.63, 329.63], [174.61, 220.0, 261.63], [196.0, 246.94, 293.66]];
const chords: AudioClip[] = [];
let hum: AudioClip | null = null;
/** Every voice, one graph at a time; the hum last, as update() waits on it. */
async function renderVoices(): Promise<void> {
  for (const c of CHORDS) chords.push(await renderChord(c));
  hum = await renderHum();
}

// -- music and ambience ---------------------------------------------------------------------
let ambSound: Sound | null = null;
let ambStarted = false;
let nextChord = 0;
let step = 0;

/** Each frame once the mixer runs and the voices are rendered: the ambience loop and the pad's chords by mixer time. */
export function update(): void {
  if (context.state !== "running" || !hum) return;
  const now = context.currentTime;
  if (!ambStarted) {
    ambStarted = true;
    try { ambSound = playClip(hum, { bus: "effects", gain: 0.0001, loop: true }); ambSound.fade(LEVEL.ambience, 1.5); }
    catch { ambSound = null; }
    return; // the pad starts on a frame of its own
  }
  if (now >= nextChord) {
    if (nextChord === 0 || now - nextChord > 1) nextChord = now;
    const clip = chords[step % chords.length];
    if (clip) { try { playClip(clip, { bus: "music", gain: LEVEL.music }); } catch { /* the mixer is full */ } }
    step++;
    nextChord += 5.2;
  }
}
