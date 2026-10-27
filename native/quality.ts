// The look per graphics level: the browser build's four presets and budgets
// (js/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU
// Auto gave it) keyed by the runtime's quality tier (frame().quality), with
// the motes and confetti scaled within the tier by the level
// (frame().levelIndex), as the browser build scaled them by its hardware
// level. The runtime owns the rest of what the old Graphics panel did: Auto
// and the level choice, render scale and the pixel-ratio cap, adaptive
// resolution, the frame-rate limit and readout, and the shadow-map size and
// MSAA samples it holds to the level. The per-category overrides of the old
// panel are not offered (the runtime's Options choose a level).
import type { QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export type Preset = QualityTier;
export interface Budget {
  /** Paper and card: Lambert or standard PBR; pawns lacquered with a clear coat on High and Ultra. */
  material: "lambert" | "standard" | "physical";
  /** Paper-grain texture size in px (detailed scene only). */
  grain: number;
  /** Round-geometry LOD (multiplies radial segments; at least 4). */
  segments: number;
  /** Pop-up props inside the ring. */
  decor: number;
  /** Drifting paper flecks (animated background). */
  motes: number;
  /** Confetti pieces per landing burst. */
  confetti: number;
  bloomRes: number;
  aoRes: number;
}
export interface Look {
  preset: Preset;
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
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

const TABLE: Record<Preset, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "msaa", reflections: false, richParticles: false, detailed: false, animated: false },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, richParticles: true, detailed: true, animated: true },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, richParticles: true, detailed: true, animated: true },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, richParticles: true, detailed: true, animated: true },
};
const BUDGETS: Record<Preset, Budget> = {
  low: { material: "lambert", grain: 64, segments: 0.5, decor: 4, motes: 24, confetti: 6, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", grain: 128, segments: 0.75, decor: 12, motes: 40, confetti: 10, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", grain: 256, segments: 1, decor: 16, motes: 70, confetti: 14, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", grain: 512, segments: 1.5, decor: 22, motes: 120, confetti: 20, bloomRes: 1, aoRes: 1 },
};
const CONFETTI_CAP: Record<Preset, number> = { low: 6, balanced: 60, high: 60, ultra: 60 };
const MOTE_CAP = 300;
/** The first level index of each tier (quantum, molecular, terrestrial, galactic). */
const TIER_FLOOR: Record<Preset, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };

/** The look for a quality tier at a level index (0 quantum … 9 infinite). */
export function lookFor(preset: Preset, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  // Levels are about 1.64× apart in GPU throughput: counts grow with the
  // level above the tier's first, at most four times the tier's budget.
  const k = Math.min(4, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.motes = Math.min(MOTE_CAP, Math.round(b.motes * k));
  b.confetti = Math.min(CONFETTI_CAP[preset], Math.round(b.confetti * k));
  return { preset, ...TABLE[preset], budget: b };
}
