import { Easing, interpolate } from "remotion";

export const FPS = 30;
export const DURATION = 750; // 25s
export const W = 1920;
export const H = 1080;

// Easing vocabulary used across the piece.
export const EASE_OUT = Easing.bezier(0.16, 1, 0.3, 1);
export const EASE_SOFT = Easing.bezier(0.22, 1, 0.36, 1);
export const EASE_IN_OUT = Easing.bezier(0.65, 0, 0.35, 1);
export const EASE_IN = Easing.bezier(0.55, 0, 1, 0.45);
export const EASE_POP = Easing.bezier(0.34, 1.56, 0.64, 1);

const clamp = {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
} as const;

/** Normalized 0..1 progress between two frames. */
export const p = (
  frame: number,
  start: number,
  end: number,
  easing: (t: number) => number = EASE_OUT,
) => interpolate(frame, [start, end], [0, 1], { ...clamp, easing });

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/* ------------------------------------------------------------------ */
/* Scene 1: the pile of denied claims                                  */
/* ------------------------------------------------------------------ */

export const PILE_C = { x: 1430, y: 480 };
export const CARD_W = 380;
export const CARD_H = 240;

export type PileCard = {
  t: number; // frame the card starts flying in
  dx: number;
  dy: number;
  r: number;
  id: string;
  code: string;
};

export const PILE: PileCard[] = [
  { t: 4, dx: -70, dy: 50, r: -9, id: "20475", code: "D0120" },
  { t: 13, dx: 80, dy: -40, r: 8, id: "20476", code: "D1110" },
  { t: 22, dx: -30, dy: -80, r: -5, id: "20477", code: "D2391" },
  { t: 32, dx: 100, dy: 70, r: 12, id: "20478", code: "D4341" },
  { t: 43, dx: -110, dy: -10, r: -13, id: "20479", code: "D0274" },
  { t: 55, dx: 40, dy: 30, r: 4, id: "20480", code: "D2950" },
  { t: 68, dx: -50, dy: 95, r: -7, id: "20481", code: "D7140" },
  { t: 82, dx: 110, dy: -75, r: 9, id: "20482", code: "D3330" },
  // The hero card: lands last, on top. It flips into the clean claim.
  { t: 96, dx: 0, dy: 0, r: -3, id: "20483", code: "D2740" },
];
export const HERO = PILE.length - 1;
export const CARD_FLY = 18;

/** Horizontal drift of the whole pile (parallax). */
export const pileDrift = (f: number) =>
  interpolate(f, [0, 150], [24, -24], clamp);

/** Small impact shake each time a card lands. */
export const pileShake = (f: number) => {
  let y = 0;
  for (const c of PILE) {
    const land = c.t + CARD_FLY - 4;
    const d = f - land;
    if (d > 0 && d < 24) {
      y += 7 * Math.exp(-d / 4) * Math.sin(d * 1.7);
    }
  }
  return y;
};

/* ------------------------------------------------------------------ */
/* Scene 2: the turn                                                   */
/* ------------------------------------------------------------------ */

export const RING_C = { x: 1330, y: 470 };
export const RING_R = 300;
export const ringRot = (f: number) =>
  interpolate(f, [176, 262], [-24, 12], clamp);

export const FLIP_START = 148;
export const FLIP_END = 172;

/* ------------------------------------------------------------------ */
/* Scene 3: the pipeline                                               */
/* ------------------------------------------------------------------ */

export const NODE_Y = 640;
export const NODE_X = [220, 516, 812, 1108, 1404, 1700];
export const TRACK_X0 = NODE_X[0];
export const TRACK_X1 = NODE_X[NODE_X.length - 1];
export const ARRIVE = [292, 316, 340, 364, 388, 412];
export const DWELL = 8;
export const CARD_RIDE_Y = NODE_Y - 92;
export const CARD_RIDE_SCALE = 0.42;

export const STAGES = [
  "Insurance\nverified",
  "CDT\ncoded",
  "Clean claim\nsent",
  "Payment\nposted",
  "Denial\nappealed",
  "AR\nworked",
];

/** Camera pan that tracks the claim along the pipeline. */
export const panX = (f: number) =>
  interpolate(f, [282, 420, 450, 476], [0, -36, -36, 0], {
    ...clamp,
    easing: EASE_IN_OUT,
  });

/** Where the travelling claim is, and how far through a hop it is. */
export const cardRide = (f: number) => {
  if (f <= ARRIVE[0]) return { x: NODE_X[0], hop: 0 };
  for (let i = 0; i < ARRIVE.length - 1; i++) {
    const depart = ARRIVE[i] + DWELL;
    const arrive = ARRIVE[i + 1];
    if (f < depart) return { x: NODE_X[i], hop: 0 };
    if (f < arrive) {
      const raw = (f - depart) / (arrive - depart);
      const t = EASE_IN_OUT(raw);
      return { x: lerp(NODE_X[i], NODE_X[i + 1], t), hop: Math.sin(Math.PI * raw) };
    }
  }
  return { x: NODE_X[NODE_X.length - 1], hop: 0 };
};

/* ------------------------------------------------------------------ */
/* Scene 4: the proof                                                  */
/* ------------------------------------------------------------------ */

export const AXIS_X0 = 360;
export const AXIS_X1 = 1560;
export const AXIS_MIN = 90;
export const AXIS_MAX = 100;
export const axisX = (v: number) =>
  AXIS_X0 + ((AXIS_X1 - AXIS_X0) * (v - AXIS_MIN)) / (AXIS_MAX - AXIS_MIN);

/** The proof block sits centered, then lifts to make room for two more stats. */
export const statShift = (f: number) => 70 * (1 - p(f, 552, 580, EASE_IN_OUT));
export const AXIS_BASE_Y = 650;
export const axisY = (f: number) => AXIS_BASE_Y + statShift(f);

export const NCR = 98.7;
export const COUNT_START = 490;
export const COUNT_END = 534;
export const statValue = (f: number) =>
  AXIS_MIN + (NCR - AXIS_MIN) * p(f, COUNT_START, COUNT_END, EASE_SOFT);

/* ------------------------------------------------------------------ */
/* Scene 5: the payoff                                                 */
/* ------------------------------------------------------------------ */

export const RULE = { cx: 960, y: 556, w: 140, h: 8 };
export const PROOF_EXIT = 618;
