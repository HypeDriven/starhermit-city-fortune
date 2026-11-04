// The look per graphics level. The engine-owned effects come from the frame's
// level (levelSettings()): shadows and their map size, ambient occlusion
// (resolution and samples), bloom resolution, the grade and anti-aliasing.
// The game's own art (materials, paper grain, round-geometry LOD, pop-up
// props, reflections, the detailed scene and its animation) stays keyed by
// the quality tier (frame().quality), as the browser build's presets were
// (js/gfx.js BUDGETS, each tuned to hold 60 FPS on the weakest GPU Auto gave
// it). Motes and confetti scale with the level's particle budget against the
// tier's anchor level (quantum, molecular, terrestrial, galactic), at most
// four times the tier's budget. The game sets the shadow-map size itself:
// at engine.minor 23 and up the runtime keeps a light's mapSize whatever the
// level. The runtime owns the rest of what the old Graphics panel did: Auto
// and the level choice, render scale and the pixel-ratio cap, adaptive
// resolution, the frame-rate limit and readout. The per-category overrides
// of the old panel are not offered (the runtime's Options choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export type Preset = QualityTier;
export interface Budget {
  /** Paper and card: Lambert or standard PBR; pawns lacquered with a clear coat on High and Ultra. */
  material: "lambert" | "standard" | "physical";
  /** Paper-grain texture size in px (detailed scene only), at most the level's texture size. */
  grain: number;
  /** Round-geometry LOD (multiplies radial segments; at least 4). */
  segments: number;
  /** Pop-up props inside the ring. */
  decor: number;
  /** Drifting paper flecks (animated background). */
  motes: number;
  /** Confetti pieces per landing burst. */
  confetti: number;
}
export interface Look {
  preset: Preset;
  /** The level's shadow-map size; 0: no shadows. */
  shadows: number;
  /** The level's ambient occlusion; null: off. */
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution; null: no bloom. */
  bloom: number | null;
  grade: boolean;
  antialias: AntialiasMode;
  reflections: boolean;
  /** Mixed confetti colours (the old particles "high" tier). */
  richParticles: boolean;
  /** Paper grain, card faces, lit windows, houses and trees, the craft table. */
  detailed: boolean;
  /** Drifting flecks and the pawns' idle bob. */
  animated: boolean;
  budget: Budget;
}

type Art = Pick<Look, "reflections" | "richParticles" | "detailed" | "animated">;
const ART: Record<Preset, Art> = {
  low: { reflections: false, richParticles: false, detailed: false, animated: false },
  balanced: { reflections: true, richParticles: true, detailed: true, animated: true },
  high: { reflections: true, richParticles: true, detailed: true, animated: true },
  ultra: { reflections: true, richParticles: true, detailed: true, animated: true },
};
const BUDGETS: Record<Preset, Budget> = {
  low: { material: "lambert", grain: 64, segments: 0.5, decor: 4, motes: 24, confetti: 6 },
  balanced: { material: "standard", grain: 128, segments: 0.75, decor: 12, motes: 40, confetti: 10 },
  high: { material: "physical", grain: 256, segments: 1, decor: 16, motes: 70, confetti: 14 },
  ultra: { material: "physical", grain: 512, segments: 1.5, decor: 22, motes: 120, confetti: 20 },
};
const CONFETTI_CAP: Record<Preset, number> = { low: 6, balanced: 60, high: 60, ultra: 60 };
const MOTE_CAP = 300;
/** Each tier's anchor level: its budgets are tuned for it. */
const ANCHOR: Record<Preset, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };

/** The look for a graphics level (default: this frame's). */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = BUDGETS[preset];
  // The level's particle budget doubles a level: counts grow with it above
  // the tier's anchor, at most four times the tier's budget.
  const k = Math.min(4, Math.max(1, s.particles / levelSettings(ANCHOR[preset]).particles));
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    // Engine issue (1.36.1, reported 2026-11-04; fix due in 1.36.2): antialias "off" recolours fog,
    // haze and translucent overlays, so Low keeps the MSAA it always had until that release.
    antialias: s.antialias === "off" ? "msaa" : s.antialias,
    budget: {
      ...b,
      grain: Math.min(b.grain, s.maxTextureSize),
      motes: Math.min(MOTE_CAP, Math.round(b.motes * k)),
      confetti: Math.min(CONFETTI_CAP[preset], Math.round(b.confetti * k)),
    },
  };
}
