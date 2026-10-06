/**
 * Character pose contract shared by every shot.
 * The rig module (src/rig/Player.tsx + src/rig/actions.ts) implements it and
 * documents the exact axis conventions in src/rig/README.md.
 */
export type Vec3 = [number, number, number];

export const JOINTS = [
  "spine", // pelvis -> lower spine
  "chest",
  "neck",
  "head",
  "lShoulder",
  "lElbow",
  "lWrist",
  "rShoulder",
  "rElbow",
  "rWrist",
  "lHip",
  "lKnee",
  "lAnkle",
  "rHip",
  "rKnee",
  "rAnkle",
] as const;
export type Joint = (typeof JOINTS)[number];

export type Pose = {
  /** pelvis position in the character's parent space (metres) */
  root: Vec3;
  /** pelvis rotation, Euler radians, order 'YXZ' (yaw first) */
  rootRot: Vec3;
  /** local joint rotations, Euler radians (order documented in rig README) */
  joints: Record<Joint, Vec3>;
  /** 0 = open hand, 1 = closed grip */
  lGrip: number;
  rGrip: number;
};

export type Role = "batsman" | "bowler" | "fielder" | "keeper";
