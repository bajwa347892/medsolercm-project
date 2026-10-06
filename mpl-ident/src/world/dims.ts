/**
 * World layout. Units are metres. Y is up. The field centre is the origin.
 * The pitch runs along Z. Play goes from +Z (bowler's end) to -Z (striker's end).
 * Batsman faces +Z (towards the bowler). The bowler runs in along -Z.
 */
export const PITCH = {
  length: 20.12, // stump to stump
  width: 3.05,
  stripLength: 22.0, // mown strip incl. run-ups at each end
  stumpsZ: 10.06, // bowler's stumps at +stumpsZ, striker's stumps at -stumpsZ
  poppingOffset: 1.22, // popping crease is 1.22m in front of stumps
  returnCreaseX: 1.32, // half-distance between return creases
};
export const BOWLER_STUMPS_Z = PITCH.stumpsZ;
export const STRIKER_STUMPS_Z = -PITCH.stumpsZ;
export const BOWLER_POPPING_Z = PITCH.stumpsZ - PITCH.poppingOffset; // 8.84
export const STRIKER_POPPING_Z = -PITCH.stumpsZ + PITCH.poppingOffset; // -8.84

export const STUMPS = {
  height: 0.711,
  spacing: 0.1143, // centre-to-centre of adjacent stumps (total width 22.86cm)
  radius: 0.0175,
  bailLength: 0.1111,
  bailRise: 0.013,
};

export const BALL = { radius: 0.036 }; // 71-72mm diameter

export const BAT = {
  bladeLength: 0.56,
  bladeWidth: 0.108,
  bladeDepth: 0.065, // at the spine
  edge: 0.04,
  handleLength: 0.30,
  handleRadius: 0.017,
};

export const FIELD = {
  boundary: 66, // rope radius
  outfieldRadius: 70, // grass ends, LED boards start
  ledRadius: 70.5,
};

export const STADIUM = {
  standInner: 73,
  standOuter: 125,
  standTopHeight: 42,
  tiers: 3,
  roofHeight: 52,
  floodTowers: 8, // banks of floodlights, evenly spaced, first at angle 0 (+X)
  floodRadius: 118,
  floodHeight: 66,
};

/** Fielding positions used across shots (right-handed batsman). */
export const FIELDERS = {
  keeper: [0, 0, -12.4],
  slip1: [-1.4, 0, -13.4],
  point: [-21, 0, -6],
  cover: [-26, 0, 6],
  midOff: [-12, 0, 24],
  midOn: [12, 0, 24],
  midWicket: [25, 0, 2],
  deepMidWicket: [48, 0, 18],
  longOn: [26, 0, 58],
  fineLeg: [14, 0, -55],
  thirdMan: [-22, 0, -52],
} as const;
