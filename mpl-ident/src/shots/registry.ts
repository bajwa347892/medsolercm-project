import { CUES } from "../cues";
import { placeholderShot } from "./Placeholder";
import type { ShotDef } from "./types";

// Each shot module replaces its placeholder by exporting a ShotDef and being listed here.
const ranges = CUES.shots as unknown as Record<string, [number, number]>;

export const SHOTS: ShotDef[] = Object.entries(ranges).map(([id, [from, to]]) =>
  placeholderShot(id, from, to),
);

export const shotAt = (F: number) => SHOTS.find((s) => F >= s.from && F < s.to) ?? SHOTS[SHOTS.length - 1];
