/**
 * LightStreak: horizontal anamorphic lens streaks on bright lamps (white core, subtle teal tails).
 *
 * Streaks are drawn by <Post/> in screen space (always horizontal in frame, like an anamorphic lens),
 * and each source is depth-tested against the scene, so a lamp hidden behind a player or the roof
 * does not streak. Its brightness also follows what is actually visible at the source (a lamp that is
 * off, or flickering on, streaks accordingly).
 *
 * Two ways to add sources (they are merged; max 12 visible per frame):
 *   <Post streaks={floodStreaks(st.floods)} />                // from props
 *   <LightStreak position={floodBankPos(3)} intensity={0.8} />  // anywhere in the scene graph
 *
 * Without a <Post/> in the shot, LightStreak renders nothing.
 */
import React, { useId, useLayoutEffect } from "react";
import type { Vec3 } from "../rig/types";
import { FLOOD_BANKS } from "../world/Lights";

export type StreakSource = {
  /** world position of the lamp (e.g. a flood bank head) */
  position: Vec3;
  /** 0..~2 (default 1). Scaled by the visible lamp brightness, so 1 is right for flood banks. */
  intensity?: number;
  /** half length of the streak in frame heights (default 0.32) */
  length?: number;
};

export const STREAK_DEFAULT_LENGTH = 0.32;

/** Streak sources for the 8 flood banks, following their power levels (stadiumStateAt(F).floods). */
export const floodStreaks = (floods: number[], gain = 1, length = STREAK_DEFAULT_LENGTH): StreakSource[] =>
  FLOOD_BANKS.map((b, i) => ({
    position: [b.pos.x, b.pos.y, b.pos.z] as Vec3,
    intensity: (floods[i] ?? 0) * gain,
    length,
  })).filter((s) => (s.intensity ?? 0) > 0.001);

/** Registry written during render by <LightStreak/> components, read by <Post/> when it draws. */
const registry = new Map<string, StreakSource>();

/** All sources registered by mounted <LightStreak/> components (read by Post). */
export const registeredStreaks = (): StreakSource[] => Array.from(registry.values());

export const LightStreak: React.FC<StreakSource> = ({ position, intensity = 1, length = STREAK_DEFAULT_LENGTH }) => {
  const id = useId();
  // Written during render so the source is in place before Remotion advances the frame.
  registry.set(id, { position, intensity, length });
  useLayoutEffect(
    () => () => {
      registry.delete(id);
    },
    [id],
  );
  return null;
};
