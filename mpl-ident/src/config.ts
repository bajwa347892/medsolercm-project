import { Easing, interpolate } from "remotion";

export const FPS = 30;
export const DURATION = 810; // 27s
export const W = 1920;
export const H = 1080;

/* ---------------------------------------------------------------- */
/* Determinism: never use Math.random() or wall-clock time.          */
/* Every value must be a pure function of the frame.                 */
/* ---------------------------------------------------------------- */

/** Seeded PRNG (mulberry32). Same seed -> same sequence, every render. */
export const rng = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Hash any integer/string-ish key to [0,1). */
export const hash01 = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
};

export const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export const EASE_OUT = Easing.bezier(0.16, 1, 0.3, 1);
export const EASE_IN_OUT = Easing.bezier(0.65, 0, 0.35, 1);
export const EASE_IN = Easing.bezier(0.55, 0, 1, 0.45);
export const EASE_SINE = Easing.inOut(Easing.sin);

/** 0..1 progress between two frames (clamped, eased). */
export const prog = (
  f: number,
  a: number,
  b: number,
  easing: (t: number) => number = EASE_IN_OUT,
) =>
  interpolate(f, [a, b], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing,
  });

/**
 * Speed ramp / time remap for slow motion.
 * keys: [frame, speed] pairs (speed 1 = real time, 0.1 = 10x slow motion),
 * speed is linearly interpolated between keys and held outside them.
 * Returns ACTION TIME in seconds elapsed since keys[0][0].
 * Use it to drive physics and character actions so slow motion is just a remap.
 */
export const actionTime = (frame: number, keys: [number, number][]) => {
  const k = [...keys].sort((a, b) => a[0] - b[0]);
  const speedAt = (fr: number) => {
    if (fr <= k[0][0]) return k[0][1];
    for (let i = 0; i < k.length - 1; i++) {
      const [f0, s0] = k[i];
      const [f1, s1] = k[i + 1];
      if (fr <= f1) return s0 + ((s1 - s0) * (fr - f0)) / (f1 - f0);
    }
    return k[k.length - 1][1];
  };
  const start = k[0][0];
  if (frame <= start) return (frame - start) * speedAt(start) / FPS;
  // integrate with half-frame steps (exact enough, deterministic)
  let t = 0;
  const step = 0.5;
  for (let fr = start; fr < frame; fr += step) {
    const d = Math.min(step, frame - fr);
    t += (speedAt(fr) + speedAt(fr + d)) * 0.5 * d;
  }
  return t / FPS;
};
