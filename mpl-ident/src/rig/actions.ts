/**
 * Cricket action library: pure functions (t: seconds, opts?) => RigPose.
 * Every action documents its frame (origin, +Z) and its key times; see README.md for the tables.
 *
 * Conventions: character space (Y up, +X = the player's left). Each action has its own
 * "action frame": +Z is the direction of play for that action (toward the bowler for the batsman,
 * toward the batsman for the bowler, the running direction for runs, sprints and dives).
 * Place it with <Player position rotationY/>; e.g. the bowler runs toward world -Z, so rotationY = PI.
 */
import * as THREE from "three";
import type { Vec3 } from "./types";
import { type ArmAimSpec, type ArmReachSpec, type ArmSpec, type BodySpec, type BuiltPose, type FootTarget, aimQuat, airFoot, build, plant, stableBuild } from "./pose";
import { type Footfall, type GaitOpts, JOG, RUN, WALK, gait } from "./gait";
import { BAT_GRIP_TILT, RIG, SIDE_SIGN, type Side, blendArm, blendPose, posOf, rotOf, slotMatrix, solvePose } from "./solve";
import { type Key, basisQ, bump, clamp, deg, lerp, lerp3, s5, span, sstep, track, track3, v3, wobble } from "./anim";

export type ActionPose = BuiltPose;

/* ================================================================== */
/* Shared helpers                                                      */
/* ================================================================== */

/** Foot planted by the ball of the foot (pivots about the ball when yaw changes). */
const plantBall = (bx: number, bz: number, yaw: number, roll = 0) => {
  const bl = RIG.ball;
  const ax = bx - (Math.sin(yaw) * bl.z + Math.cos(yaw) * bl.x);
  const az = bz - (Math.cos(yaw) * bl.z - Math.sin(yaw) * bl.x);
  return plant(ax, az, yaw, roll);
};

/** Running arm (aim spec, chest space). phase +1 = right arm forward. k = amplitude 0..1 */
export const runArm = (s: Side, phase: number, k = 1, elbow = 1.5): ArmAimSpec => {
  const fwd = s === "r" ? phase : -phase;
  const phi = 0.12 + (fwd > 0 ? fwd * 0.95 : fwd * 0.8) * k;
  const out = SIDE_SIGN[s] * 0.16;
  return {
    aim: [out, -Math.cos(phi), Math.sin(phi)],
    pole: [out * 2.2, -Math.sin(phi), -Math.cos(phi)],
    flex: elbow + 0.32 * fwd * k,
    pron: 0.35,
    wflex: [0.15, 0.05],
  };
};

const isIKArm = (a: ArmSpec) => (a as ArmAimSpec).aim === undefined;

/** Mix two arm aims (both aim specs, same space): the upper arm slerps, so the blend never flips. */
const mixAim = (a: ArmAimSpec, b: ArmAimSpec, w: number): ArmAimSpec => {
  const qa = a.q ?? aimQuat(a.aim, a.pole);
  const qb = b.q ?? aimQuat(b.aim, b.pole);
  return {
    aim: lerp3(a.aim, b.aim, w),
    pole: lerp3(a.pole, b.pole, w),
    q: (a.space ?? "chest") === (b.space ?? "chest") ? qa.clone().slerp(qb, clamp(w)) : undefined,
    flex: lerp(a.flex, b.flex, w),
    pron: lerp(a.pron ?? 0, b.pron ?? 0, w),
    wflex: [lerp(a.wflex?.[0] ?? 0, b.wflex?.[0] ?? 0, w), lerp(a.wflex?.[1] ?? 0, b.wflex?.[1] ?? 0, w)],
    space: a.space,
  };
};

/** Aim arm from keyframes [t, aim, pole, flex, pron]. */
const aimTrack = (
  keys: [number, Vec3, Vec3, number, number?][],
  t: number,
  space: "chest" | "char" = "chest",
  wrist: [number, number] = [0.1, 0],
): ArmAimSpec => ({
  aim: track3(keys.map((k) => [k[0], k[1]] as Key<Vec3>), t),
  pole: track3(keys.map((k) => [k[0], k[2]] as Key<Vec3>), t),
  flex: track(keys.map((k) => [k[0], k[3]] as Key<number>), t),
  pron: track(keys.map((k) => [k[0], k[4] ?? 0.2] as Key<number>), t),
  wflex: wrist,
  space,
});

const v3keys = (keys: [number, Vec3][]) => keys as Key<Vec3>[];

/** A foot placed relative to the pelvis frame (for airborne legs). off = ankle offset in pelvis space. */
const bodyFoot = (pelvis: Vec3, rootRot: Vec3, off: Vec3, pitch = 0, yawRel = 0): FootTarget => {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rootRot[0], rootRot[1], rootRot[2], "YXZ"));
  const p = v3(off).applyQuaternion(q).add(v3(pelvis));
  const fq = q
    .clone()
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawRel))
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitch));
  return { ankle: p, q: fq };
};

/** Blend two foot targets (position lerp, rotation slerp). */
const mixFoot = (a: FootTarget, b: FootTarget, w: number): FootTarget => ({
  ankle: a.ankle.clone().lerp(b.ankle, w),
  q: a.q.clone().slerp(b.q, w),
});

const seamFingers: [number, number, number, number, number] = [0.55, 0.32, 0.32, 0.78, 0.88];

/* ================================================================== */
/* Running family                                                      */
/* ================================================================== */

export type SprintOpts = {
  /** touchdown times (s); default every 0.2 s from -0.6 */
  steps?: number[];
  /** m/s along +Z */
  speed?: number;
  /** first footfall side */
  first?: Side;
  /** forward lean (rad), default 0.2 */
  lean?: number;
};

const sprintSteps = (o: SprintOpts, gopts: GaitOpts): Footfall[] => {
  const speed = o.speed ?? 7.5;
  const times = o.steps ?? Array.from({ length: 30 }, (_, i) => -0.6 + i * 0.2);
  const first = o.first ?? "l";
  return times.map((tt, i) => {
    const side: Side = (i % 2 === 0) === (first === "l") ? "l" : "r";
    return {
      t: tt,
      side,
      x: side === "l" ? 0.085 : -0.085,
      z: speed * (tt + gopts.contact * 0.5),
      yaw: side === "l" ? 0.05 : -0.05,
    };
  });
};

/**
 * sprint: full-speed running along +Z. Frame: the pelvis is at z ~ speed * t, x = 0.
 * Footfalls at `steps` (default every 0.2 s); arms pump opposite the legs.
 */
export const sprint = (t: number, o: SprintOpts = {}): ActionPose => {
  const steps = sprintSteps(o, RUN);
  const g = gait(t, steps, RUN);
  const lean = o.lean ?? 0.2;
  return build({
    root: g.pelvis,
    rootRot: [0.1 + lean * 0.3, g.pelvisYaw, g.pelvisRoll],
    spine: [lean * 0.4, g.chestYaw * 0.45, 0],
    chest: [lean * 0.3, g.chestYaw * 0.55, 0],
    look: [g.pelvis[0], 1.45, g.pelvis[2] + 12],
    lFoot: g.l,
    rFoot: g.r,
    lArm: runArm("l", g.armPhase, 1),
    rArm: runArm("r", g.armPhase, 1),
    lGrip: 0.6,
    rGrip: 0.6,
  });
};

/* ================================================================== */
/* Bowling                                                             */
/* ================================================================== */

/**
 * BOWLING FRAME: origin = the front foot's ankle ground position at front-foot landing
 * (just behind the bowler's popping crease); +Z toward the batsman; run-up from -Z.
 * For a right-arm-over bowler put the origin ~0.3 m to his left of middle stump and use rotationY = PI
 * when bowling toward world -Z.
 *
 * The delivery is authored on a NATURAL clock (take-off plant 0, back-foot contact 0.38, front-foot
 * contact 0.52, release 0.62: a real 0.28 s bound) and warped onto the requested key times.
 * The defaults are cue-locked (take-off plant = frame 184, FFC = 192, release = 196).
 */
export const BOWL = {
  /** run-up footfalls (s, from the run-up start = S03 frame 126); the last one is the take-off plant */
  runUpSteps: [-0.1, 0.2, 0.5, 0.8, 1.0667, 1.3333, 1.5667, 1.7667, 1.9333],
  /** take-off plant of the bound, in run-up time (= delivery t 0) */
  TAKEOFF_T: 1.9333,
  /** delivery key times (s from the take-off plant), cue-locked defaults */
  BFC_T: 0.17,
  FFC_T: 0.2667,
  RELEASE_T: 0.4,
  /** the same keys at natural speed (use these when the shot has time to show the leap) */
  NATURAL: { tBFC: 0.3, tFFC: 0.42, tRelease: 0.54 },
  /** take-off plant position (left foot ankle): close enough that the cue-locked bound keeps the run-up's speed */
  takeoff: [0.12, -2.3] as [number, number],
  /** back-foot contact position (right ankle) */
  bfc: [-0.06, -1.15] as [number, number],
  /** release height of the ball above the ground (approx.) */
  releaseHeight: 2.2,
  /** run-up length from the first cue footstep to the take-off plant (m) */
  runUpLength: 8.6,
} as const;

export type RunUpOpts = { steps?: number[]; length?: number };

const runUpFootfalls = (o: RunUpOpts) => {
  const times = o.steps ?? [...BOWL.runUpSteps];
  const n = times.length;
  const tTO = times[n - 1];
  // speed ramps up; strides scaled to the requested run-up length
  const v = (tt: number) => lerp(3.0, 6.6, Math.pow(clamp(tt / tTO), 1.1));
  const raw: number[] = [];
  for (let i = 1; i < n; i++) raw.push(v((times[i] + times[i - 1]) / 2) * (times[i] - times[i - 1]));
  const total = raw.slice(1).reduce((a, b) => a + b, 0);
  const k = (o.length ?? BOWL.runUpLength) / total;
  const zs: number[] = new Array(n).fill(0);
  zs[n - 1] = BOWL.takeoff[1];
  for (let i = n - 2; i >= 0; i--) zs[i] = zs[i + 1] - raw[i] * k;
  const steps: Footfall[] = times.map((tt, i) => {
    const side: Side = (n - 1 - i) % 2 === 0 ? "l" : "r";
    return {
      t: tt,
      side,
      x: side === "l" ? BOWL.takeoff[0] : -0.06,
      z: zs[i],
      yaw: side === "l" ? 0.06 : -0.08,
      contact: lerp(0.17, 0.11, clamp(tt / tTO)),
    };
  });
  // the back foot's next contact (so its swing heads there through the take-off)
  steps.push({ t: tTO + NB, side: "r", x: BOWL.bfc[0], z: BOWL.bfc[1], yaw: -1.35, contact: 0.2 });
  // a pre-step for the trailing foot so the first frames are already in motion
  steps.unshift({ t: times[0] - 0.33, side: steps[0].side === "l" ? "r" : "l", x: steps[0].side === "l" ? -0.06 : 0.12, z: zs[0] - 0.9, contact: 0.2 });
  return steps;
};

const BOWLER_GAIT: GaitOpts = { ...RUN, pelvisLow: 0.9, bob: 0.04, pelvisYaw: 0.1, chestYaw: 0.12, lift: 0.26, apexAt: 0.42 };

let takeoffCache: ReturnType<typeof gait> | null = null;
/** Run-up gait state at the take-off plant: the delivery starts exactly from it. */
const takeoffState = () => {
  if (!takeoffCache) takeoffCache = gait(BOWL.TAKEOFF_T, runUpFootfalls({}), BOWLER_GAIT);
  return takeoffCache;
};
let preCache: ReturnType<typeof gait> | null = null;
/** Run-up gait state 0.05 s before the take-off plant (lead-in key: the delivery keeps the run's velocity). */
const preTakeoffState = () => {
  if (!preCache) preCache = gait(BOWL.TAKEOFF_T - 0.05, runUpFootfalls({}), BOWLER_GAIT);
  return preCache;
};
/** Run-up trunk lean at the take-off (matches bowlRunUp). */
const TO_LEAN = 0.12;

/** The ball carried by the chest during the run-up. */
const CARRY: ArmAimSpec = { aim: [-0.12, -0.9, 0.42], pole: [-0.35, -0.3, -1], flex: 1.95, pron: 0.55, wflex: [0.3, 0] };

/**
 * The gather (last stride into the jump): both hands come up together in front of the chest, the
 * ball under the chin in the bowling hand, the front arm cocked high in front of the face.
 * The run-up blends into it before the take-off plant and the delivery leaves from it.
 */
const GATHER_L: ArmAimSpec = { aim: [0.2, -0.2, 0.96], pole: [0.6, -0.6, -0.3], flex: 1.75, pron: 0.25, wflex: [0.1, 0] };
const GATHER_R: ArmAimSpec = { aim: [-0.18, -0.42, 0.89], pole: [-0.5, -0.6, -0.4], flex: 2.25, pron: 0.65, wflex: [0.35, 0] };
/** Gather window before the take-off plant (s, run-up clock). */
const GATHER_T: [number, number] = [-0.3, -0.02];

/**
 * bowlRunUp: approach run, accelerating. Footfalls on BOWL.runUpSteps (cue frames 132..184 when
 * t = 0 is frame 126); the last footfall (t = BOWL.TAKEOFF_T) is the take-off plant of the bound and
 * hands over seamlessly to bowlDelivery(t - BOWL.TAKEOFF_T). Ball held in the right hand at the chest.
 */
export const bowlRunUp = (t: number, o: RunUpOpts = {}): ActionPose => {
  const times = o.steps ?? [...BOWL.runUpSteps];
  const tTO = times[times.length - 1];
  if (t >= tTO) return bowlDelivery(t - tTO);
  const steps = runUpFootfalls(o);
  const g = gait(t, steps, BOWLER_GAIT);
  const sp = clamp(t / tTO);
  const lean = lerp(0.24, 0.12, sp);
  const rFwd = g.armPhase;
  const rArm: ArmAimSpec = {
    ...CARRY,
    aim: [-0.12, -Math.cos(0.38 + 0.3 * rFwd), Math.sin(0.38 + 0.3 * rFwd)],
    flex: 1.95 + 0.12 * rFwd,
  };
  const lRun = runArm("l", g.armPhase, lerp(0.85, 1, sp));
  const spec: BodySpec = {
    root: g.pelvis,
    rootRot: [0.06 + lean * 0.3, g.pelvisYaw, g.pelvisRoll],
    spine: [lean * 0.4, g.chestYaw * 0.45, 0],
    chest: [lean * 0.3, g.chestYaw * 0.55, 0],
    look: [0, 0.6, 19],
    lFoot: g.l,
    rFoot: g.r,
    lArm: lRun,
    rArm,
    lGrip: 0.55,
    rGrip: 0.5,
    rFingers: seamFingers,
    ball: { hand: "r", grip: "seam" },
  };
  const pose = build(spec);
  const gw = s5(tTO + GATHER_T[0], tTO + GATHER_T[1], t);
  if (gw <= 0) return pose;
  const gather = build({ ...spec, lArm: GATHER_L, rArm: GATHER_R });
  return blendArm(blendArm(pose, gather, "l", gw), gather, "r", gw);
};

export type DeliveryOpts = {
  /** back-foot contact time (s from the take-off plant) */
  tBFC?: number;
  /** front-foot contact time */
  tFFC?: number;
  /** ball release time */
  tRelease?: number;
};

/** Natural clock key times. */
const NB = 0.38;
const NF = 0.52;
const NR = 0.62;

/**
 * Map action time to the natural delivery clock: a C1 monotone cubic (Fritsch-Carlson) through
 * (0,0) (BFC,NB) (FFC,NF) (release,NR) with slope 1 at the take-off plant and after the follow-through,
 * so retimed deliveries hit the cue frames exactly without speed jumps at the keys.
 */
const deliveryClock = (t: number, o: DeliveryOpts) => {
  const b = o.tBFC ?? BOWL.BFC_T;
  const f = o.tFFC ?? BOWL.FFC_T;
  const r = o.tRelease ?? BOWL.RELEASE_T;
  if (t <= 0) return t;
  const xs = [0, b, f, r, r + 0.5];
  const ys = [0, NB, NF, NR, NR + 0.5];
  if (t >= xs[4]) return ys[4] + (t - xs[4]);
  const d = xs.map((_, i) => (i < 4 ? (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]) : 1));
  const m = xs.map((_, i) => (i === 0 || i === 4 ? 1 : d[i - 1] * d[i] <= 0 ? 0 : (2 * d[i - 1] * d[i]) / (d[i - 1] + d[i])));
  for (let i = 0; i < 4; i++) {
    // Fritsch-Carlson limiter keeps the warp monotone (time never runs backwards)
    const a = m[i] / d[i];
    const bb = m[i + 1] / d[i];
    const h = a * a + bb * bb;
    if (h > 9) {
      const tau = 3 / Math.sqrt(h);
      m[i] = tau * a * d[i];
      m[i + 1] = tau * bb * d[i];
    }
  }
  let i = 0;
  while (i < 3 && t > xs[i + 1]) i++;
  const hS = xs[i + 1] - xs[i];
  const u = (t - xs[i]) / hS;
  const u2 = u * u;
  const u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * ys[i] + (u3 - 2 * u2 + u) * hS * m[i] + (-2 * u3 + 3 * u2) * ys[i + 1] + (u3 - u2) * hS * m[i + 1];
};

/**
 * Keep a trailing foot within reach of its hip: the toe drags toward the hip along the ground
 * (at most maxDrag), then the foot lifts off and trails on a straight leg.
 */
const dragToReach = (foot: FootTarget, hip: THREE.Vector3, maxDrag = 0.16, maxLen = RIG.thigh + RIG.shin - 0.01): FootTarget => {
  const d = foot.ankle.clone().sub(hip);
  if (d.length() <= maxLen) return foot;
  const dy = foot.ankle.y - hip.y;
  const h = new THREE.Vector3(d.x, 0, d.z);
  const hl = h.length() || 1;
  const horizNeeded = Math.sqrt(Math.max(0, maxLen * maxLen - dy * dy));
  const drag = Math.min(maxDrag, Math.max(0, hl - horizNeeded));
  const a = foot.ankle.clone().addScaledVector(h, -drag / hl);
  const hl2 = hl - drag;
  if (hl2 > horizNeeded) {
    // lift: straight leg trailing behind
    const horiz = Math.min(hl2, maxLen * 0.999);
    a.y = hip.y - Math.sqrt(Math.max(0, maxLen * maxLen - horiz * horiz));
    a.x = hip.x + (h.x / hl) * horiz;
    a.z = hip.z + (h.z / hl) * horiz;
  }
  return { ankle: a, q: foot.q };
};

/** Hip joint position (char space) for a root position/rotation. */
const hipOf = (root: Vec3, rootRot: Vec3, s: Side) => {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rootRot[0], rootRot[1], rootRot[2], "YXZ"));
  return new THREE.Vector3(0.092 * SIDE_SIGN[s], -0.04, 0.005).applyQuaternion(q).add(v3(root));
};

/**
 * bowlDelivery: right-arm fast-medium, side-on action. t = 0 at the take-off plant (left foot).
 * Phases: take-off push -> BOUND (front arm climbs, body turns side-on) -> back-foot contact BFC
 * (right foot parallel to the crease, front arm high, looking past it) -> front-foot contact FFC at the
 * origin (braced front leg, hips open before the shoulders) -> RELEASE (straight arm just past vertical,
 * wrist behind the ball, ~2.2 m) -> follow-through: arm across to the left knee, back leg through,
 * run-off veering to the bowler's left. Cue-locked defaults: BFC 0.17, FFC 0.2667, release 0.4 (s);
 * pass {tBFC, tFFC, tRelease} to retime (BOWL.NATURAL for real-speed leap).
 */
export const bowlDelivery = (tReal: number, o: DeliveryOpts = {}): ActionPose => {
  const c = deliveryClock(tReal, o);
  if (c < 0) return bowlRunUp(BOWL.TAKEOFF_T + tReal);
  const spec = deliverySpec(c);
  let pose = build(spec);
  // per-arm joint-space blends. Front arm: the gather (held from the run-up) -> the delivery keys.
  // Bowling arm: the gather -> a fixed key of the over-the-top arm (as it is at ARM_KEY_C) -> the live
  // arm; every slerp stays well under 180 deg (a direct gather -> live blend flips the humerus).
  if (c < ARM_KEY_C) {
    const gather = build({ ...spec, lArm: GATHER_L, rArm: GATHER_R });
    pose = blendArm(pose, gather, "l", 1 - s5(0.0, 0.2, c));
    const keyed = blendArm(gather, armKeyPose(), "r", s5(0.0, ARM_KEY_C - 0.06, c));
    pose = blendArm(pose, keyed, "r", 1 - s5(ARM_KEY_C - 0.12, ARM_KEY_C, c));
  }
  const runW = s5(0.95, 1.3, c);
  if (runW > 0) {
    const ph = gait(c, followSteps(), JOG).armPhase;
    pose = blendPose(pose, build({ ...spec, rArm: runArm("r", ph, 0.55), lArm: runArm("l", ph, 0.55) }), runW);
  }
  return pose;
};

/** Natural-clock time where the bowling arm stops being keyed from the gather (see bowlDelivery). */
const ARM_KEY_C = 0.42;
let armKeyCache: ActionPose | null = null;
const armKeyPose = () => (armKeyCache ??= build(deliverySpec(ARM_KEY_C)));

/** The delivery body on the natural clock c (take-off plant 0, BFC 0.38, FFC 0.52, release 0.62). */
const deliverySpec = (c: number): BodySpec => {
  const [tox, toz] = BOWL.takeoff;
  const [bx, bz] = BOWL.bfc;
  /** bound keys were authored for a take-off 3.35 m back; squeeze them onto the actual take-off..BFC span */
  const AZ = -3.35;
  const zb = (z: number) => (z >= bz ? z : toz + ((z - AZ) * (bz - toz)) / (bz - AZ));

  /* ---------- pelvis ---------- */
  const g0 = takeoffState();
  const gPre = preTakeoffState();
  const pelvisKeys = v3keys([
      [-0.05, gPre.pelvis],
      [0, g0.pelvis],
      [0.05, [0.09, 0.925, zb(AZ + 0.08)]],
      [0.1, [0.07, 0.97, zb(AZ + 0.4)]],
      [0.24, [0.02, 1.055, zb(-2.02)]],
      [NB, [-0.01, 0.935, bz + 0.08]],
      [0.45, [0.0, 0.87, -0.78]],
      [NF, [0.02, 0.835, -0.5]],
      [0.57, [0.04, 0.9, -0.3]],
      [NR, [0.06, 0.96, -0.14]],
      [0.7, [0.1, 0.93, 0.2]],
      [0.76, [0.15, 0.895, 0.48]],
      [0.82, [0.21, 0.875, 0.82]],
      [0.95, [0.34, 0.91, 1.38]],
      [1.1, [0.55, 0.95, 2.0]],
      [1.3, [0.82, 0.965, 2.65]],
      [1.55, [1.05, 0.975, 3.15]],
      [1.85, [1.2, 0.98, 3.48]],
      [2.1, [1.25, 0.98, 3.58]],
    ]);
  const pelvis = track3(pelvisKeys, c);
  const yawKeys: Key<number>[] = [
      [0, g0.pelvisYaw],
      [0.1, -0.25],
      [0.24, -0.8],
      [NB, -1.25],
      [0.45, -1.15],
      [NF, -0.85],
      [0.57, -0.5],
      [NR, -0.12],
      [0.7, 0.3],
      [0.8, 0.5],
      [1.0, 0.45],
      [1.5, 0.4],
    ];
  const pYaw = track(yawKeys, c);
  const pitchKeys: Key<number>[] = [
      [0, 0.06 + TO_LEAN * 0.3],
      [0.1, 0.08],
      [0.24, 0.0],
      [NB, -0.06],
      [NF, 0.0],
      [NR, 0.15],
      [0.7, 0.32],
      [0.8, 0.42],
      [1.0, 0.22],
      [1.4, 0.1],
      [1.8, 0.06],
    ];
  const pPitch = track(pitchKeys, c);
  const rollKeys: Key<number>[] = [[0, g0.pelvisRoll], [NB, 0.08], [NF, 0.04], [NR, -0.1], [0.8, 0]];
  const pRoll = track(rollKeys, c);
  const rootRot: Vec3 = [pPitch, pYaw, pRoll];
  const rootRotAt = (cc: number): Vec3 => [track(pitchKeys, cc), track(yawKeys, cc), track(rollKeys, cc)];

  /* ---------- trunk ---------- */
  const spine = track3(
    v3keys([
      [0, [TO_LEAN * 0.4, g0.chestYaw * 0.45, 0.0]],
      [0.24, [0.0, -0.15, 0.03]],
      [NB, [-0.06, -0.16, 0.06]],
      [NF, [0.0, -0.18, 0.0]],
      [0.57, [0.08, -0.04, -0.14]],
      [NR, [0.14, 0.1, -0.2]],
      [0.7, [0.36, 0.22, -0.1]],
      [0.8, [0.42, 0.14, 0.0]],
      [1.0, [0.2, 0.0, 0.0]],
      [1.4, [0.1, 0.0, 0.0]],
    ]),
    c,
  );
  const chest = track3(
    v3keys([
      [0, [TO_LEAN * 0.3, g0.chestYaw * 0.55, 0.0]],
      [0.24, [-0.02, -0.25, 0.05]],
      [NB, [-0.08, -0.26, 0.1]],
      [NF, [0.0, -0.3, -0.04]],
      [0.57, [0.1, 0.0, -0.2]],
      [NR, [0.18, 0.16, -0.26]],
      [0.7, [0.32, 0.26, -0.05]],
      [0.8, [0.3, 0.1, 0.08]],
      [1.0, [0.15, 0.0, 0.0]],
      [1.4, [0.06, 0.0, 0.0]],
    ]),
    c,
  );

  /* ---------- feet ---------- */
  const ffYaw = -0.28;
  const ffBall: [number, number] = [Math.sin(ffYaw) * RIG.ball.z, Math.cos(ffYaw) * RIG.ball.z];
  const fSteps = followSteps();
  let lFoot: FootTarget;
  if (c <= 0.1) lFoot = plant(tox, toz, 0.06, track([[0, BOWLER_GAIT.strike], [0.03, 0], [0.1, 0.95]], c));
  else if (c < NF) {
    const p = track3(
      v3keys([
        [0.1, [tox, 0.16, toz + 0.12]],
        [0.18, [0.11, 0.4, zb(AZ + 0.42)]],
        [0.3, [0.08, 0.5, zb(-1.75)]],
        [NB, [0.06, 0.44, -0.86]],
        [0.45, [0.03, 0.3, -0.42]],
        [NF, [0.0, RIG.ankleHeight + 0.045, 0.0]],
      ]),
      c,
    );
    const pitch = track([[0.1, 0.95], [0.18, 0.85], [0.3, 0.35], [NB, 0.1], [0.45, -0.25], [NF, -0.32]], c);
    const yaw = track([[0.1, 0.06], [NB, -0.45], [NF, ffYaw]], c);
    lFoot = airFoot(p, yaw, pitch);
  } else if (c <= 0.76) {
    const roll = track([[NF, -0.32], [0.56, 0.0], [0.64, 0.0, 0], [0.76, 0.95]], c);
    lFoot = plantBall(ffBall[0], ffBall[1], ffYaw, roll);
  } else if (c < fSteps[2].t) {
    const s = span(0.76, fSteps[2].t, c);
    const from = plantBall(ffBall[0], ffBall[1], ffYaw, 0.95);
    const to = plant(fSteps[2].x, fSteps[2].z, fSteps[2].yaw ?? 0, -0.15);
    const fp = from.ankle.clone().lerp(to.ankle, s5(0, 1, s));
    fp.y += 0.22 * Math.sin(Math.PI * Math.pow(s, 0.8));
    lFoot = airFoot([fp.x, fp.y, fp.z], lerp(ffYaw, fSteps[2].yaw ?? 0, s), track([[0, 0.95], [0.6, -0.2], [1, -0.15]], s));
  } else {
    lFoot = gait(c, fSteps, JOG).l;
  }
  let rFoot: FootTarget;
  const bfcBall: [number, number] = [bx + Math.sin(-1.35) * RIG.ball.z, bz + Math.cos(-1.35) * RIG.ball.z];
  if (c < NB) {
    // the last run-up foot swings through the bound (knee drives up) to land side-on
    const p = track3(
      v3keys([
        // the trailing leg drives through: heel up behind -> knee forward and up -> reaches down side-on
        [-0.05, [gPre.r.ankle.x, gPre.r.ankle.y, gPre.r.ankle.z]],
        [0, [g0.r.ankle.x, g0.r.ankle.y, g0.r.ankle.z]],
        [0.1, [-0.07, 0.46, toz - 0.15]],
        [0.2, [-0.08, 0.5, toz + 0.42]],
        [0.29, [-0.07, 0.3, bz - 0.28]],
        [NB, [bx, RIG.ankleHeight, bz]],
      ]),
      Math.max(c, 0),
    );
    const pitch = track([[0.05, 0.6], [0.14, 0.3], [0.24, 0.1], [NB, 0.0]], c);
    const yaw = track([[0, -0.08], [0.2, -0.5], [0.31, -1.15], [NB, -1.35]], c);
    rFoot = airFoot(p, yaw, pitch);
    // continuous orientation from the gait's swing foot
    rFoot.q = g0.r.q.clone().slerp(rFoot.q, s5(0, 0.06, c));
  } else if (c <= 0.66) {
    // planted side-on; the heel peels and the foot pivots on the ball as the hips turn; the toe drags
    const yaw = track([[NB, -1.35], [NF, -1.25], [NR, -0.75], [0.66, -0.62]], c);
    const roll = track([[NB, 0], [0.45, 0.15], [NF, 0.55], [NR, 0.95], [0.66, 1.05]], c);
    // the toe is dragged forward by the hips from front-foot contact (spikes scraping the crease)
    const drag = track([[NF, 0], [0.57, 0.12], [NR, 0.3], [0.66, 0.4]], c);
    rFoot = plantBall(bfcBall[0] + drag * 0.1, bfcBall[1] + drag, yaw, roll);
    rFoot = dragToReach(rFoot, hipOf(pelvis, rootRot, "r"), 0.08);
  } else if (c < fSteps[1].t) {
    const s = span(0.66, fSteps[1].t, c);
    const from = dragToReach(plantBall(bfcBall[0] + 0.04, bfcBall[1] + 0.4, -0.62, 1.05), hipOf(track3(pelvisKeys, 0.66), rootRotAt(0.66), "r"), 0.08);
    const to = plant(fSteps[1].x, fSteps[1].z, fSteps[1].yaw ?? 0, -0.1);
    const fp = from.ankle.clone().lerp(to.ankle, s5(0, 1, s));
    fp.y += 0.36 * Math.sin(Math.PI * Math.pow(s, 0.7));
    rFoot = airFoot([fp.x, fp.y, fp.z], lerp(-0.62, fSteps[1].yaw ?? 0, s), track([[0, 1.0], [0.5, 0.3], [1, -0.1]], s));
  } else {
    rFoot = gait(c, fSteps, JOG).r;
  }

  /* ---------- bowling arm (right): straight arm over the top ---------- */
  // theta in the delivery plane: 0 down, pi/2 back, pi up, 3pi/2 forward
  const th = track(
    [
      [0.1, 0.2],
      [0.24, 0.3],
      [NB, 0.55],
      [0.45, 1.0],
      [NF, 1.55],
      [0.57, 2.4],
      [NR, 3.3],
      [0.66, 4.15],
      [0.71, 4.85],
      [0.8, 5.55],
      [0.95, 5.9],
    ],
    c,
  );
  const across = track([[0.1, -0.32], [NF, -0.22], [NR, -0.08], [0.66, 0.05], [0.71, 0.3], [0.8, 0.62], [0.95, 0.55]], c);
  const dirV = v3([across, -Math.cos(th), -Math.sin(th)]).normalize();
  const tanV = v3([0, Math.sin(th), -Math.cos(th)]).normalize();
  // wrist cocked back before release, snapped through after
  const wr = track([[0.1, 0.2], [0.57, 0.6], [0.61, 0.45], [NR, 0.15], [0.65, -0.45], [0.75, -0.35]], c);
  const fingers = dirV.clone().multiplyScalar(Math.cos(wr)).addScaledVector(tanV, -Math.sin(wr));
  const palm = tanV.clone().multiplyScalar(Math.cos(wr)).addScaledVector(dirV, Math.sin(wr));
  const overArm: ArmReachSpec = {
    dir: [dirV.x, dirV.y, dirV.z],
    dist: 0.5612 - track([[0.8, 0.0], [0.95, 0.07]], c),
    fingers: [fingers.x, fingers.y, fingers.z],
    palm: [palm.x, palm.y, palm.z],
    pole: [-tanV.x - 0.3, -tanV.y, -tanV.z],
  };

  /* ---------- front arm (left) ---------- */
  const lArm = aimTrack(
    [
      [0, [0.16, -0.75, -0.6], [0.6, -0.5, -0.6], 1.3, 0.2],
      [0.1, [0.2, -0.15, 0.97], [0.7, -0.6, -0.2], 1.0, 0.1],
      [0.24, [0.12, 0.55, 0.82], [0.8, 0.0, -0.5], 0.6, 0.1],
      [NB, [0.06, 0.78, 0.62], [0.9, 0.2, -0.4], 0.35, 0.2],
      [NF, [0.16, 0.3, 0.94], [0.9, 0.0, -0.4], 0.45, 0.4],
      [0.57, [0.45, -0.3, 0.6], [0.6, -0.4, -0.7], 1.1, 0.5],
      [NR, [0.38, -0.78, -0.12], [0.3, -0.2, -1], 1.75, 0.4],
      [0.7, [0.3, -0.8, -0.45], [0.3, 0.2, -1], 1.5, 0.3],
      [0.8, [0.25, -0.7, -0.55], [0.4, 0.3, -1], 1.3, 0.3],
      [0.95, [0.2, -0.85, 0.2], [0.5, -0.3, -1], 1.4, 0.3],
    ],
    c,
    "char",
    [0.1, 0],
  );

  // eyes on the target over the front arm, then follow the ball down the pitch
  const look: Vec3 = c < 0.66 ? [0, 0.55, 19] : lerp3([0, 0.55, 19], [0, 0.4, 14], s5(0.66, 1.2, c));
  const spec: BodySpec = {
    root: pelvis,
    rootRot,
    spine,
    chest,
    look,
    lookHead: 0.6,
    lFoot,
    rFoot,
    rKnee: c > NB && c < 0.7 ? [-0.9, 0.1, 0.4] : undefined,
    lArm,
    rArm: overArm,
    lGrip: c < 0.24 ? 0.5 : track([[0.24, 0.2], [NF, 0.3], [NR, 0.75], [0.8, 0.5]], c),
    rGrip: c < NR ? 0.5 : track([[NR, 0.15], [0.75, 0.3], [1.1, 0.4]], c),
    rFingers: c < NR ? seamFingers : undefined,
    ball: c < NR ? { hand: "r", grip: "seam" } : null,
  };
  return spec;
};

/** Follow-through run-off footfalls (bowling frame, natural clock). */
const followSteps = (): Footfall[] => [
  { t: NF, side: "l", x: Math.sin(-0.28) * 0.0, z: 0.0, yaw: -0.28, contact: 0.24 },
  { t: 0.8, side: "r", x: 0.2, z: 1.12, yaw: 0.2, contact: 0.16 },
  { t: 1.02, side: "l", x: 0.58, z: 2.05, yaw: 0.3, contact: 0.16 },
  { t: 1.26, side: "r", x: 0.82, z: 2.8, yaw: 0.3, contact: 0.18 },
  { t: 1.52, side: "l", x: 1.1, z: 3.28, yaw: 0.35, contact: 0.2 },
  { t: 1.8, side: "r", x: 1.1, z: 3.52, yaw: 0.35, contact: 3 },
  { t: 2.02, side: "l", x: 1.28, z: 3.6, yaw: 0.35, contact: 3 },
];

/* ================================================================== */
/* Batting                                                             */
/* ================================================================== */

/**
 * BATTING FRAME: origin = the striker's popping crease on the middle-stump line; +Z toward the bowler;
 * off side = -X. Place with position [0, 0, STRIKER_POPPING_Z], rotationY = 0. Right-handed batsman:
 * stands side-on with the chest to the off side, feet either side of the crease, bat in both hands
 * (left hand on top) attached to the LEFT hand slot (pose.bat).
 */
export const BAT = {
  /** stance feet (ankle ground positions) */
  frontFoot: [0.24, 0.17] as [number, number],
  backFoot: [0.24, -0.26] as [number, number],
  /** batStance tap period (s) */
  TAP_PERIOD: 0.62,
  /** batDrive contact time (s) */
  CONTACT_T: 1.0,
  /** batCoverDrive contact time (s) */
  COVER_CONTACT_T: 0.62,
  /** ball centre at contact for batDrive (batting frame) */
  driveContact: [-0.02, 0.24, 0.98] as Vec3,
} as const;

/**
 * Bat orientation from swing parameters (batting frame):
 *  phi   bat angle in its swing plane: 0 toe down, +pi/2 toe back (toward the keeper), pi toe up,
 *        -pi/2 toe forward (toward the bowler)
 *  psi   face rotation about the handle: + turns the face toward the leg side (+X), - opens it to the off side
 *  plane swing-plane yaw (+ toward the leg side)
 *  lean  sideways tilt of the handle (- leans the handle toward +X)
 */
export const swingQ = (phi: number, psi: number, plane = 0, lean = 0) => {
  const Y = new THREE.Vector3(0, Math.cos(phi), Math.sin(phi));
  const F = new THREE.Vector3(0, -Math.sin(phi), Math.cos(phi));
  const X = new THREE.Vector3().crossVectors(Y, F);
  const base = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, F));
  base.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), psi));
  const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), plane);
  const roll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), lean);
  return roll.multiply(yaw).multiply(base);
};

/** Bat-local sweet spot (matches world/Props BAT_SWEET_SPOT: 0.15 m above the toe, on the face). */
const SWEET: Vec3 = [0, -0.56, 0.021];

/** Bat grip-centre position that puts the ball centre `ball` on the sweet spot with rotation q. */
const gripForContact = (ball: Vec3, q: THREE.Quaternion) => {
  const face = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  const s = v3(ball).addScaledVector(face, -0.036);
  const p = s.sub(v3(SWEET).applyQuaternion(q));
  return [p.x, p.y, p.z] as Vec3;
};

/** Stance: bat grounded just behind the back toe, handle leaning to the front thigh. */
const STANCE_SW = { phi: 0.26, psi: -0.12, plane: 0.0, lean: -0.1 };
const STANCE_GRIP: Vec3 = (() => {
  const q = swingQ(STANCE_SW.phi, STANCE_SW.psi, STANCE_SW.plane, STANCE_SW.lean);
  // toe (bat-local [0, -0.71, 0]) on the ground behind the back toe
  const toe = v3([-0.085, 0.004, -0.2]);
  const p = toe.sub(new THREE.Vector3(0, -0.71, 0).applyQuaternion(q));
  return [p.x, p.y, p.z] as Vec3;
})();

const STANCE_ROOT: Vec3 = [0.34, 0.9, -0.04];
const STANCE_ROT: Vec3 = [0.5, -Math.PI / 2 + 0.12, 0.0];

const stanceSpec = (t: number, tapAmt: number): BodySpec => {
  const breathe = Math.sin(t * 2.4) * 0.004;
  const sway = wobble(t * 0.6, 3) * 0.005;
  // bat tap: the toe lifts ~6 cm and taps down, rotating about the hands
  const tapPh = (t % BAT.TAP_PERIOD) / BAT.TAP_PERIOD;
  const tap = tapAmt * Math.max(0, Math.sin(tapPh * Math.PI * 2)) ** 1.5;
  const q = swingQ(STANCE_SW.phi + 0.12 * tap, STANCE_SW.psi, STANCE_SW.plane, STANCE_SW.lean);
  const pos: Vec3 = [STANCE_GRIP[0], STANCE_GRIP[1] + 0.012 * tap, STANCE_GRIP[2]];
  return {
    root: [STANCE_ROOT[0] + sway, STANCE_ROOT[1] + breathe, STANCE_ROOT[2]],
    rootRot: STANCE_ROT,
    spine: [0.13, 0.08, 0.0],
    chest: [0.1, 0.2, -0.07 + breathe * 2],
    look: [0, 1.9, 19],
    lookHead: 0.65,
    lFoot: plant(BAT.frontFoot[0], BAT.frontFoot[1], -Math.PI / 2 + 0.22),
    rFoot: plant(BAT.backFoot[0], BAT.backFoot[1], -Math.PI / 2 + 0.06),
    lKnee: [-1, 0, 0.32],
    rKnee: [-1, 0, -0.12],
    bat: { pos, q, hands: "both", lPole: [0.2, -0.3, 1], rPole: [-0.1, -0.6, -0.8] },
    lGrip: 0.82,
    rGrip: 0.82,
  };
};

export type StanceOpts = {
  /** time the backlift starts (s); omit for continuous tapping */
  liftT?: number;
};

/**
 * batStance: guard at the crease, bat tapping every BAT.TAP_PERIOD, breathing, head still with eyes
 * level on the bowler. With liftT, the bat rises into the backlift (the batDrive backlift, from
 * liftT) and holds at the top, ready.
 */
export const batStance = (t: number, o: StanceOpts = {}): ActionPose => {
  if (o.liftT === undefined) return build(stanceSpec(t, 1));
  const lt = o.liftT;
  const specAt = (tt: number) =>
    tt < lt ? stanceSpec(tt, 1 - sstep(lt - 0.5, lt, tt)) : batDriveSpec(BAT.CONTACT_T - 0.72 + (tt - lt), { hold: true });
  return stableBuild(`batStance:${lt}`, specAt, t, lt - 0.8, lt + 0.6);
};

export type DriveOpts = {
  /** contact time (s); default BAT.CONTACT_T */
  contactT?: number;
  /** shot direction (rad): 0 lofted straight / long-on, -0.6 = cover drive */
  direction?: number;
  /** freeze at the top of the backlift (used by batStance) */
  hold?: boolean;
};

/**
 * batDrive: front-foot lofted straight drive. Key times relative to contact Tc (default 1.0 s):
 * stance until Tc-0.72 -> backlift (toe up toward the slips, face open) -> front foot lifts Tc-0.45 ->
 * top of the backlift Tc-0.25 -> front foot lands Tc-0.13 (heel, knee flexes) -> downswing in a
 * vertical plane, front elbow high -> CONTACT at Tc: straight bat beside the front pad, head over the
 * ball, face to long-on (sweet spot = attachmentWorld(pose, 'bat', ..., BAT_SWEET_SPOT)) ->
 * follow-through up through the line and over the left shoulder (high finish Tc+0.32) -> hold.
 */
export const batDrive = (t: number, o: DriveOpts = {}): ActionPose => {
  const Tc = o.contactT ?? BAT.CONTACT_T;
  const key = `batDrive:${Tc}:${o.direction ?? 0}:${o.hold ? 1 : 0}`;
  return stableBuild(key, (tt) => batDriveSpec(tt, o), t, Tc - 0.8, o.hold ? Tc - 0.2 : Tc + 1.3);
};

const batDriveSpec = (t: number, o: DriveOpts): BodySpec => {
  const Tc = o.contactT ?? BAT.CONTACT_T;
  const dir = o.direction ?? 0;
  let u = t - Tc;
  if (o.hold) u = Math.min(u, -0.25);
  const cov = clamp(-dir / 0.6); // 0 straight, 1 cover

  /* ---- feet ---- */
  const backRoll = track([[-0.2, 0], [-0.05, 0.25], [0.1, 0.55], [0.35, 0.95], [0.8, 0.9]], u);
  const backYaw = track([[-0.2, -Math.PI / 2 + 0.06], [0.2, -Math.PI / 2 + 0.3], [0.45, -Math.PI / 2 + 0.55]], u);
  const bb: [number, number] = [BAT.backFoot[0] + Math.sin(-Math.PI / 2 + 0.06) * RIG.ball.z, BAT.backFoot[1] + Math.cos(-Math.PI / 2 + 0.06) * RIG.ball.z];
  const rFoot0 = plantBall(bb[0], bb[1], backYaw, backRoll);
  const ffLand: [number, number] = [lerp(0.2, 0.12, cov), lerp(0.78, 0.7, cov)];
  const ffYaw = lerp(-0.5, -0.95, cov);
  const ffStart = plant(BAT.frontFoot[0], BAT.frontFoot[1], -Math.PI / 2 + 0.22);
  let lFoot: FootTarget;
  if (u < -0.45) lFoot = ffStart;
  else if (u < -0.13) {
    const s = span(-0.45, -0.13, u);
    const to = plant(ffLand[0], ffLand[1], ffYaw, -0.25);
    const fp = ffStart.ankle.clone().lerp(to.ankle, s5(0, 1, s));
    fp.y += 0.12 * Math.sin(Math.PI * Math.pow(s, 0.85));
    lFoot = { ankle: fp, q: ffStart.q.clone().slerp(to.q, sstep(0.0, 0.85, s)) };
  } else lFoot = plant(ffLand[0], ffLand[1], ffYaw, track([[-0.13, -0.25], [-0.05, 0], [0.5, 0]], u));

  /* ---- pelvis + trunk ---- */
  const root = track3(
    v3keys([
      [-0.72, STANCE_ROOT],
      [-0.45, [0.32, 0.905, -0.08]],
      [-0.25, [0.28, 0.9, 0.04]],
      [-0.13, [0.22, 0.85, 0.24]],
      [0, [lerp(0.2, 0.17, cov), 0.8, 0.4]],
      [0.16, [0.19, 0.82, 0.45]],
      [0.32, [0.2, 0.85, 0.46]],
      [1.2, [0.21, 0.87, 0.44]],
    ]),
    u,
  );
  const yaw = track(
    [
      [-0.72, STANCE_ROT[1]],
      [-0.45, -Math.PI / 2 + 0.06],
      [-0.13, -Math.PI / 2 + 0.2],
      [0, -Math.PI / 2 + lerp(0.45, 0.32, cov)],
      [0.16, -Math.PI / 2 + 0.8],
      [0.32, -Math.PI / 2 + 1.0],
      [1.2, -Math.PI / 2 + 0.95],
    ],
    u,
  );
  const pitch = track([[-0.72, STANCE_ROT[0]], [-0.25, 0.4], [0, 0.42], [0.3, 0.24], [1.2, 0.16]], u);
  const roll = track([[-0.72, 0], [-0.13, -0.06], [0, -0.12], [0.4, -0.04]], u);
  const spine = track3(
    v3keys([
      [-0.72, [0.13, 0.08, 0.0]],
      [-0.25, [0.09, -0.04, 0.0]],
      [0, [0.2, 0.1, -0.1]],
      [0.16, [0.12, 0.22, -0.04]],
      [0.32, [0.04, 0.28, 0.0]],
      [1.2, [0.05, 0.22, 0.0]],
    ]),
    u,
  );
  const chest = track3(
    v3keys([
      [-0.72, [0.1, 0.2, -0.07]],
      [-0.25, [0.06, -0.12, 0.06]],
      [-0.1, [0.1, 0.0, -0.04]],
      [0, [0.18, 0.22, -0.12]],
      [0.16, [0.06, 0.34, -0.08]],
      [0.32, [-0.04, 0.42, -0.04]],
      [1.2, [-0.02, 0.36, 0.0]],
    ]),
    u,
  );

  /* ---- bat: swing parameters ---- */
  const plane0 = lerp(0.12, -0.42, cov);
  const phiC = lerp(-0.06, 0.05, cov);
  const psiC = lerp(0.28, -0.5, cov);
  const ball: Vec3 = [lerp(-0.02, -0.2, cov), lerp(0.24, 0.22, cov), lerp(0.98, 0.86, cov)];
  const qC = swingQ(phiC, psiC, plane0, 0);
  const gC = gripForContact(ball, qC);
  const phi = track(
    [
      [-0.72, STANCE_SW.phi],
      [-0.6, 0.55],
      [-0.45, 1.55],
      [-0.25, 2.75],
      [-0.13, 2.45],
      [-0.06, 1.25],
      [0, phiC],
      [0.06, -1.0],
      [0.14, -2.1],
      [0.22, -3.35],
      [0.32, -4.75],
      [0.6, -4.95],
      [1.2, -4.7],
    ],
    u,
  );
  const psi = track(
    [
      [-0.72, STANCE_SW.psi],
      [-0.45, -0.7],
      [-0.25, -1.1],
      [-0.13, -0.9],
      [-0.06, -0.3],
      [0, psiC],
      [0.14, psiC + 0.25],
      [0.32, 0.6],
      [1.2, 0.6],
    ],
    u,
  );
  // swing-plane yaw: while the toe points back (backlift, downswing) a + yaw takes it toward the slips,
  // i.e. away from the body; through contact the plane turns to the shot direction
  const plane = track(
    [
      [-0.72, STANCE_SW.plane],
      [-0.45, 0.22],
      [-0.25, 0.28],
      [-0.1, lerp(0.2, 0.16, cov)],
      [-0.04, lerp(0.16, 0.0, cov)],
      [0, plane0],
      [0.14, plane0 + 0.15],
      [0.22, -0.3],
      [0.32, -0.85],
      [1.2, -0.8],
    ],
    u,
  );
  const lean = track([[-0.72, STANCE_SW.lean], [-0.45, -0.05], [0, 0], [0.32, 0.1]], u);
  const grip = track3(
    v3keys([
      [-0.72, STANCE_GRIP],
      [-0.45, [0.13, 0.85, -0.12]],
      [-0.25, [0.16, 1.08, -0.08]],
      [-0.13, [0.12, 1.03, 0.1]],
      [-0.06, [lerp(0.06, 0.04, cov), 0.92, 0.5]],
      [0, gC],
      [0.06, [gC[0] + 0.04, 0.95, gC[2] + 0.12]],
      [0.14, [0.12, 1.25, 0.95]],
      [0.22, [0.3, 1.52, 0.82]],
      [0.32, [0.44, 1.6, 0.68]],
      [0.6, [0.45, 1.58, 0.66]],
      [1.2, [0.42, 1.5, 0.6]],
    ]),
    u,
  );
  const bq = Math.abs(u) < 1e-4 ? qC : swingQ(phi, psi, plane, lean);
  const lPole = track3(
    v3keys([
      [-0.72, [0.2, -0.3, 1]],
      [-0.3, [0.3, -0.1, 1]],
      [-0.1, [0.0, 0.6, 1]],
      [0, [-0.1, 0.5, 1]],
      [0.16, [0.3, 0.2, 1]],
      [0.32, [0.8, -0.4, 0.4]],
      [1.2, [0.8, -0.4, 0.4]],
    ]),
    u,
  );
  const rPole = track3(
    v3keys([
      [-0.72, [-0.1, -0.6, -0.8]],
      [-0.3, [0.2, -1, -0.3]],
      [0, [0.3, -0.8, -0.3]],
      [0.16, [0.1, -1, 0.2]],
      [0.32, [-0.3, -0.6, 0.8]],
      [1.2, [-0.3, -0.6, 0.8]],
    ]),
    u,
  );
  // eyes: bowler -> the ball onto the bat -> watch it go
  const look = track3(
    v3keys([
      [-0.72, [0, 1.9, 19]],
      [-0.35, [0, 1.6, 12]],
      [-0.1, [ball[0], 0.6, 3.0]],
      [0, ball],
      [0.15, [0.2, 0.8, 3.5]],
      [0.5, [3, 6, 20]],
      [1.2, [6, 10, 30]],
    ]),
    u,
  );
  // the back toe may drag forward a little as the weight goes through
  const rFoot = dragToReach(rFoot0, hipOf(root, [pitch, yaw, roll], "r"));
  return {
    root,
    rootRot: [pitch, yaw, roll],
    spine,
    chest,
    look,
    lookHead: 0.6,
    lFoot,
    rFoot,
    lKnee: lerp3([-1, 0, 0.32], [lerp(-0.6, -0.75, cov), 0, 0.8], s5(-0.5, -0.32, u)),
    rKnee: [-1, -0.1, 0.1],
    // exact authored bat up to contact; through the follow-through the wrists stay human and the bat follows
    bat: { pos: grip, q: bq, hands: "both", lPole, rPole },
    lGrip: 0.82,
    rGrip: 0.82,
  };
};

/**
 * batCoverDrive: front-foot cover drive (for the montage). Same mechanics as batDrive with the front
 * foot toward the off side and the face to cover. Contact at BAT.COVER_CONTACT_T (0.62 s): backlift
 * from 0, front foot lands 0.49, follow-through high over the left shoulder by 0.94.
 */
export const batCoverDrive = (t: number, o: { contactT?: number } = {}): ActionPose =>
  batDrive(t - (o.contactT ?? BAT.COVER_CONTACT_T) + BAT.CONTACT_T, { direction: -0.6 });

/**
 * raiseBat: milestone celebration. Bat in the RIGHT hand (carry grip, blade up, face to the crowd).
 * 0 -> 0.25 turn toward the crowd (+Z), bat rises 0.15 -> RAISE_T 0.7 (arm high), left glove raised;
 * gentle acknowledgement sway to 2.5 s.
 */
export const RAISE_T = 0.7;
export const raiseBat = (t: number): ActionPose => {
  const w = s5(0.12, RAISE_T, t);
  const sway = Math.sin(Math.max(0, t - RAISE_T) * 2.2) * 0.06 * sstep(RAISE_T, RAISE_T + 0.4, t);
  const yaw = lerp(-0.25, 0.15, s5(0, 0.6, t)) + sway * 0.5;
  // right arm: hanging with the bat -> raised high, slightly forward
  // right arm: bat hanging beside the leg (thumb down the handle) -> raised high, blade up, face out
  const rArm: ArmReachSpec = {
    dir: lerp3([-0.22, -0.96, 0.1], [-0.3 + sway, 0.93, 0.2], w),
    dist: lerp(0.5, 0.548, w),
    // the blade swings forward and up (never back through the body)
    fingers: track3(v3keys([[0, [0.0, -0.55, -0.83]], [0.45, [-0.3, -0.3, 0.9]], [1, [-0.75, 0.6, 0.2]]]), w),
    palm: track3(v3keys([[0, [1.0, 0.0, 0.0]], [0.45, [0.7, 0.1, 0.7]], [1, [0.05, 0.25, 1.0]]]), w),
    pole: lerp3([-0.3, 0.2, -1], [-0.6, -0.1, -0.8], w),
  };
  const lArm: ArmAimSpec = mixAim(
    { aim: [0.25, -1, 0.1], pole: [0.3, 0.1, -1], flex: 0.35, pron: 0.2, space: "chest" },
    { aim: [0.75, 0.55, 0.35], pole: [0.6, -0.5, -0.6], flex: 0.55, pron: -0.6, space: "chest", wflex: [-0.2, 0] },
    s5(0.3, RAISE_T + 0.15, t),
  );
  return build({
    root: [0.0, lerp(0.965, 0.98, w), 0],
    rootRot: [0.02, yaw, 0],
    spine: [lerp(0.04, -0.06, w), 0.04, 0],
    chest: [lerp(0.03, -0.08, w), 0.06, lerp(0, 0.08, w)],
    look: [lerp(0, 1.5, w), lerp(1.6, 6, w), 25],
    lFoot: plant(0.13, 0.04, 0.2),
    rFoot: plant(-0.14, -0.06, -0.15),
    lArm,
    rArm,
    lGrip: lerp(0.3, 0.15, w),
    rGrip: 0.8,
    batHold: { hand: "r", grip: "carry" },
  });
};

export type RunBetweenOpts = {
  /** time the bat toe touches the ground (s) */
  groundT?: number;
  /** running speed (m/s) */
  speed?: number;
};

/**
 * runBetweenWickets: batsman sprinting with the bat in the RIGHT hand (carry grip, blade forward-down),
 * left arm pumping; footfalls every 0.2 s (cue batsman_steps 400/406/412 when t = 0 is frame 382).
 * From groundT-0.3 he reaches forward and down, lowering into the last strides; at RUN_GROUND_T the
 * bat toe touches down at the frame ORIGIN and slides along +Z on the grass until groundT+0.45,
 * while he decelerates over three steps and pulls up by groundT+1.0.
 */
export const RUN_GROUND_T = 1.1;
export const runBetweenWickets = (t: number, o: RunBetweenOpts = {}): ActionPose => {
  const gT = o.groundT ?? RUN_GROUND_T;
  const sp = runSpec(t, o);
  if (!sp.bat) return build(sp);
  const pose = stableBuild(`run:${gT}:${o.speed ?? 7}`, (tt) => runSpec(tt, o), t, gT - 0.4, gT + 0.85);
  // hand back to (and take over from) the carried arm smoothly at both ends of the reach
  const reach = s5(gT - 0.34, gT - 0.07, t) * (1 - s5(gT + 0.45, gT + 0.8, t));
  const carried = build({ ...sp, bat: null, batHold: { hand: "r", grip: "carry" } });
  return blendArm(pose, carried, "r", 1 - s5(0.0, 0.3, reach));
};

const runSpec = (t: number, o: RunBetweenOpts): BodySpec => {
  const gT = o.groundT ?? RUN_GROUND_T;
  const speed = o.speed ?? 7.0;
  const vAt = (tt: number) => speed * (1 - s5(gT + 0.05, gT + 0.95, tt));
  /** pelvis travel relative to the moment of grounding (integrated speed) */
  const travel = (tt: number) => {
    const n = 48;
    const a = Math.min(tt, gT);
    const b = Math.max(tt, gT);
    let acc = 0;
    for (let i = 0; i < n; i++) acc += vAt(a + ((b - a) * (i + 0.5)) / n) * ((b - a) / n);
    return tt >= gT ? acc : -acc;
  };
  const P0 = -1.08; // pelvis z when the toe touches down
  const times: number[] = [];
  for (let tt = gT - 1.7; tt <= gT + 0.12; tt += 0.2) times.push(tt);
  times.push(gT + 0.36, gT + 0.62, gT + 0.9);
  const steps: Footfall[] = times.map((tt, i) => {
    const side: Side = (times.length - 1 - i) % 2 === 0 ? "r" : "l";
    const last = i >= times.length - 2;
    return {
      t: tt,
      side,
      x: side === "l" ? 0.085 : -0.105,
      z: P0 + travel(tt + 0.06) + (last ? (side === "l" ? 0.12 : -0.05) : 0),
      yaw: side === "l" ? 0.05 : -0.08,
      contact: last ? 3 : tt > gT ? 0.16 : 0.11,
    };
  });
  const g = gait(t, steps, { ...RUN, contact: 0.11 });
  const reach = s5(gT - 0.34, gT - 0.07, t) * (1 - s5(gT + 0.45, gT + 0.8, t));
  const lower = reach * 0.19;
  const pel: Vec3 = [g.pelvis[0], g.pelvis[1] - lower, P0 + travel(t)];
  const lean = 0.2 + reach * 0.5;
  const spec: BodySpec = {
    root: pel,
    rootRot: [0.12 + lean * 0.35, g.pelvisYaw * (1 - reach * 0.7), g.pelvisRoll],
    spine: [lean * 0.45, g.chestYaw * 0.45 * (1 - reach) + reach * 0.15, 0],
    chest: [lean * 0.4, g.chestYaw * 0.55 * (1 - reach) + reach * 0.22, 0],
    look: [0, 0.5, pel[2] + 5],
    lFoot: g.l,
    rFoot: g.r,
    lArm: runArm("l", g.armPhase, 1 - reach * 0.5),
    // bat carried in the bottom hand, blade forward and outside the right leg, swinging with the stride
    rArm: {
      aim: [-0.34, -Math.cos(0.12 + 0.22 * g.armPhase), Math.sin(0.12 + 0.22 * g.armPhase)],
      pole: [-0.6, -0.2, -1],
      flex: 0.55 + 0.2 * g.armPhase,
      pron: -0.85,
      wflex: [0.1, -0.3],
    },
    lGrip: 0.65,
    rGrip: 0.85,
    batHold: { hand: "r", grip: "carry" },
  };
  if (reach <= 0) return spec;
  const carried = build(spec);
  // grounded bat: toe pinned on the grass, handle back up toward the hand, face down
  const slide = clamp((t - gT) / 0.45);
  const toeZ = travel(Math.min(t, gT + 0.45));
  const toeY = 0.006 + 0.38 * Math.pow(clamp((gT - t) / 0.34), 1.3);
  const toe: Vec3 = [-0.3, toeY, toeZ];
  const ang = lerp(0.9, 0.8, slide);
  const Y: Vec3 = [0.12, Math.sin(ang), -Math.cos(ang)];
  const q = basisQ(Y, [0, -Math.cos(ang), -Math.sin(ang)]);
  // The bat travels in Cartesian space (toe point + handle direction) from the carried bat to the grounded
  // one and back after the slide, with ONE IK arm seeded with the carried arm's elbow plane: no joint-space
  // seams, and the toe never sweeps through the turf.
  const cs = solvePose(carried);
  const cb = slotMatrix(carried, "bat", cs);
  const cToe = new THREE.Vector3(0, -0.71, 0).applyMatrix4(cb);
  const bq = rotOf(cb).slerp(q, reach);
  const tp = cToe.lerp(v3(toe), reach);
  tp.y = Math.max(tp.y, 0.006);
  const bp = tp.addScaledVector(new THREE.Vector3(0, 1, 0).applyQuaternion(bq), 0.71);
  const sh = posOf(cs.rShoulder);
  const wr = posOf(cs.rWrist);
  const pole = posOf(cs.rForeA).sub(sh.add(wr).multiplyScalar(0.5));
  return {
    ...spec,
    batHold: null,
    bat: {
      pos: [bp.x, bp.y, bp.z],
      q: bq,
      hands: "r",
      grip: "carry",
      rPole: [pole.x, pole.y, pole.z],
      rGrip: { tilt: BAT_GRIP_TILT.carry, roll: 0 },
      rSwivel: 0,
    },
  };
};

/* ================================================================== */
/* Keeper                                                              */
/* ================================================================== */

/**
 * KEEPER FRAME: origin = between the keeper's feet; +Z toward the bowler (stumps in front of him).
 */
export const KEEPER = {
  /** keeperCrouch: time he starts to rise with the delivery (s) */
  RISE_T: 1.0,
  /** keeperCollect default collect time */
  COLLECT_T: 0.55,
  /** default collect point (frame space) */
  collectAt: [0.12, 0.72, 0.42] as Vec3,
  /** default stumps position relative to the keeper (for finish: 'break') */
  stumps: [0.0, 0.0, 0.75] as Vec3,
};

const crouchSpec = (t: number, rise: number): BodySpec => {
  const rock = wobble(t * 0.9, 7) * 0.008;
  const h = lerp(0.47, 0.72, rise);
  return {
    root: [rock, h + Math.sin(t * 2.6) * 0.004, lerp(-0.12, -0.05, rise)],
    rootRot: [lerp(0.55, 0.35, rise), 0, 0],
    spine: [lerp(0.2, 0.12, rise), 0, 0],
    chest: [lerp(0.1, 0.08, rise), 0, 0],
    look: [0, 1.6, 21],
    lookHead: 0.7,
    lFoot: plant(0.24, 0.03, 0.32, lerp(0.38, 0.12, rise)),
    rFoot: plant(-0.24, 0.03, -0.32, lerp(0.38, 0.12, rise)),
    lKnee: [0.55, 0.0, 1],
    rKnee: [-0.55, 0.0, 1],
    lArm: {
      wrist: lerp3([0.07, 0.3, 0.42], [0.13, 0.72, 0.42], rise),
      fingers: lerp3([0.05, -1, 0.15], [0.1, -0.6, 0.6], rise),
      palm: lerp3([-0.25, 0.0, 1], [-0.3, 0.1, 1], rise),
      pole: [0.9, 0.0, -0.3],
    },
    rArm: {
      wrist: lerp3([-0.07, 0.3, 0.42], [-0.13, 0.72, 0.42], rise),
      fingers: lerp3([-0.05, -1, 0.15], [-0.1, -0.6, 0.6], rise),
      palm: lerp3([0.25, 0.0, 1], [0.3, 0.1, 1], rise),
      pole: [-0.9, 0.0, -0.3],
    },
    lGrip: 0.2,
    rGrip: 0.2,
  };
};

/** keeperCrouch: deep squat on the balls of the feet behind the stumps, gloves together low, eyes on
 * the bowler; gentle rocking. From opts.riseT (default KEEPER.RISE_T) he rises into a half crouch over 0.3 s. */
export const keeperCrouch = (t: number, o: { riseT?: number } = {}): ActionPose =>
  build(crouchSpec(t, s5(o.riseT ?? KEEPER.RISE_T, (o.riseT ?? KEEPER.RISE_T) + 0.3, t)));

export type CollectOpts = {
  collectT?: number;
  /** where the ball is taken (frame space) */
  at?: Vec3;
  /** 'hold' = soft hands and show the ball; 'break' = sweep the gloves into the stumps */
  finish?: "hold" | "break";
  /** stumps position (frame space) for 'break' */
  stumps?: Vec3;
};

/**
 * keeperCollect: rises from the crouch (from collectT-0.55), moves to the line, gloves meet the ball at
 * COLLECT_T (ball between the gloves: slot 'ball' with pose.ball = keeper grip in the right glove),
 * gives with soft hands 0.12 s, then either holds the ball up (finish 'hold') or sweeps the gloves into
 * the stumps (finish 'break', glove contact at collectT + 0.22).
 */
export const keeperCollect = (t: number, o: CollectOpts = {}): ActionPose => {
  const cT = o.collectT ?? KEEPER.COLLECT_T;
  const at = o.at ?? KEEPER.collectAt;
  const st = o.stumps ?? KEEPER.stumps;
  const u = t - cT;
  const rise = s5(-0.55, -0.25, u);
  const base = crouchSpec(t, rise);
  // body shuffles toward the line of the ball
  const shift = s5(-0.4, -0.1, u) * clamp(at[0] * 0.6, -0.25, 0.25);
  const bodyH = lerp(0.47, lerp(0.62, 0.78, clamp((at[1] - 0.3) / 0.8)), rise);
  base.root = [shift, bodyH, lerp(-0.12, -0.05, rise)];
  base.lFoot = plant(0.24 + shift, 0.03, 0.32, lerp(0.38, 0.1, rise));
  base.rFoot = plant(-0.24 + shift, 0.03, -0.32, lerp(0.38, 0.1, rise));
  const breakP: Vec3 = [st[0] + 0.08, 0.66, st[2] - 0.12];
  const give: Vec3 = [at[0] * 0.8, at[1] - 0.03, at[2] - 0.16];
  const hold: Vec3 = [0.15, 1.05, 0.25];
  const finish = o.finish ?? "hold";
  // ball position (between the gloves) along the action
  const ballKeys: Key<Vec3>[] =
    finish === "break"
      ? [
          [-0.55, [0.0, 0.32, 0.45]],
          [-0.2, [at[0] * 0.6, at[1] * 0.92, at[2] + 0.05]],
          [0, at],
          [0.1, give],
          [0.22, breakP, 0],
          [0.45, [breakP[0] + 0.1, 0.75, breakP[2] - 0.15]],
          [1.0, [0.2, 0.95, 0.3]],
        ]
      : [
          [-0.55, [0.0, 0.32, 0.45]],
          [-0.2, [at[0] * 0.6, at[1] * 0.92, at[2] + 0.05]],
          [0, at],
          [0.12, give],
          [0.5, hold],
          [1.0, hold],
        ];
  const bp = track3(ballKeys, u);
  // gloves either side of the ball, fingers pointing out/down toward the ball's arrival
  const open = 1 - s5(-0.02, 0.06, u);
  const half = 0.045 + 0.03 * open;
  const fingers: Vec3 = [0, lerp(-0.5, 0.2, clamp((bp[1] - 0.4) / 0.8)), 0.85];
  base.lArm = { wrist: [bp[0] + half + 0.02, bp[1] + 0.03, bp[2] - 0.1], fingers: [0.15, fingers[1], fingers[2]], palm: [-1, 0.0, 0.2], pole: [0.8, -0.6, -0.2] };
  base.rArm = { wrist: [bp[0] - half - 0.02, bp[1] + 0.03, bp[2] - 0.1], fingers: [-0.15, fingers[1], fingers[2]], palm: [1, 0.0, 0.2], pole: [-0.8, -0.6, -0.2] };
  base.lGrip = lerp(0.2, 0.75, s5(-0.02, 0.05, u));
  base.rGrip = lerp(0.2, 0.75, s5(-0.02, 0.05, u));
  const lookIn: Vec3 = [lerp(0, at[0], 0.5), lerp(1.6, at[1], s5(-0.4, 0, u)), lerp(21, at[2], s5(-0.4, 0, u))];
  base.look = lerp3(lookIn, [bp[0], bp[1], bp[2] + 0.6], s5(0.06, 0.24, u));
  base.lookHead = 0.6;
  base.spine = [lerp(0.2, 0.1, rise), 0, 0];
  base.ball = u >= 0 ? { hand: "r", grip: "keeper" } : null;
  return build(base);
};

/* ================================================================== */
/* Fielding                                                            */
/* ================================================================== */

export const FIELD_READY = {
  /** time the fielder lands the split step and is set (s) */
  SET_T: 1.25,
};

/**
 * fielderReady: walks in two strides (0 -> 0.9 s), split-step at SET_T (1.25) into the ready position:
 * feet wide, knees bent, weight forward on the balls of the feet, hands low and open in front, eyes on
 * the batsman (+Z). Frame: origin = the set position (between the feet); approaches from z = -1.7.
 */
export const fielderReady = (t: number): ActionPose => {
  const setT = FIELD_READY.SET_T;
  // walk in: the last two steps shorten into the split step
  const walk: Footfall[] = [
    { t: -0.62, side: "l", x: 0.1, z: -2.05, contact: 0.6 },
    { t: -0.1, side: "r", x: -0.1, z: -1.4, contact: 0.6 },
    { t: 0.4, side: "l", x: 0.1, z: -0.78, contact: 0.58 },
    { t: 0.85, side: "r", x: -0.1, z: -0.24, contact: 2 },
  ];
  const g = gait(t, walk, WALK);
  // split step: both feet leave the ground together, land wide and set
  const h0 = setT - 0.24;
  const h1 = setT - 0.02;
  const hs = span(h0, h1, t);
  const hop = t > h0 && t < h1 ? Math.sin(Math.PI * hs) * 0.075 : 0;
  const setL = plant(0.27, 0.02, 0.28, 0.12);
  const setR = plant(-0.27, -0.02, -0.28, 0.12);
  let lFoot: FootTarget;
  let rFoot: FootTarget;
  if (t <= h0) {
    lFoot = g.l;
    rFoot = g.r;
  } else {
    const from = gait(h0, walk, WALK);
    const k = s5(0, 1, hs);
    lFoot = mixFoot(from.l, setL, k);
    rFoot = mixFoot(from.r, setR, k);
    lFoot.ankle.y += hop;
    rFoot.ankle.y += hop;
  }
  const w = s5(h0 - 0.15, setT + 0.05, t);
  const land = bump(setT - 0.04, setT + 0.3, t);
  const breathe = Math.sin(t * 2.2) * 0.004;
  const shift = sstep(setT + 0.2, setT + 0.7, t) * wobble(t * 0.8, 11) * 0.015;
  const root: Vec3 = lerp3(g.pelvis, [shift, 0.82 + breathe + hop * 0.9 - land * 0.03, 0.0], w);
  const walkArmL = runArm("l", g.armPhase, 0.35, 0.35);
  const walkArmR = runArm("r", g.armPhase, 0.35, 0.35);
  const readyL: ArmAimSpec = { aim: [0.32, -0.85, 0.45], pole: [0.7, 0.0, -0.6], flex: 0.9, pron: -0.7, wflex: [-0.3, 0] };
  const readyR: ArmAimSpec = { aim: [-0.32, -0.85, 0.45], pole: [-0.7, 0.0, -0.6], flex: 0.9, pron: -0.7, wflex: [-0.3, 0] };
  return build({
    root,
    rootRot: [lerp(0.05, 0.72, w), lerp(g.pelvisYaw, 0, w), lerp(g.pelvisRoll, 0, w)],
    spine: [lerp(0.04, 0.16, w), lerp(g.chestYaw * 0.4, 0, w), 0],
    chest: [lerp(0.02, 0.04, w), lerp(g.chestYaw * 0.6, 0, w), 0],
    look: [0, 1.0, 25],
    lFoot,
    rFoot,
    lKnee: [0.4, 0, 1],
    rKnee: [-0.4, 0, 1],
    lArm: mixAim(walkArmL, readyL, w),
    rArm: mixAim(walkArmR, readyR, w),
    lGrip: lerp(0.3, 0.12, w),
    rGrip: lerp(0.3, 0.12, w),
  });
};

/** Diving catch timing (s). Defaults match cues 320/326/332/337 steps, 340 launch, 350 catch, 352-372 slide with t = 0 at frame 318. */
export const DIVE = {
  steps: [-0.333, -0.133, 0.067, 0.267, 0.467, 0.633],
  LAUNCH_T: 0.733,
  CATCH_T: 1.067,
  LAND_T: 1.12,
  SLIDE_END_T: 1.8,
  speed: 7.2,
};

export type DiveOpts = {
  steps?: number[];
  launchT?: number;
  catchT?: number;
  landT?: number;
  slideEndT?: number;
  /** dive to the right (-X) = 1 (default) or left (+X) = -1 */
  side?: 1 | -1;
};

/**
 * diveCatch: sprint along +Z, plant (last step = take-off foot) and LAUNCH (push-off at launchT) into a
 * full-length horizontal dive to the right, arms reaching ahead, two-hand CATCH at catchT (hands cupped,
 * ball in slot 'ball' = right-hand 'cup' grip), chest/forearms LAND at landT holding the ball off the
 * ground, SLIDE on the grass to slideEndT, then the catching hand lifts the ball.
 * Frame: origin at the start (pelvis z ~ speed * t during the run).
 */
export const diveCatch = (t: number, o: DiveOpts = {}): ActionPose => {
  const L = o.launchT ?? DIVE.LAUNCH_T;
  const C = o.catchT ?? DIVE.CATCH_T;
  const LD = o.landT ?? DIVE.LAND_T;
  const SE = o.slideEndT ?? DIVE.SLIDE_END_T;
  const side = o.side ?? 1;
  const stepT = o.steps ?? DIVE.steps;
  const sp = DIVE.speed;
  const runSteps: Footfall[] = stepT.map((tt, i) => {
    const sd: Side = (stepT.length - 1 - i) % 2 === 0 ? "l" : "r";
    return { t: tt, side: sd, x: sd === "l" ? 0.085 : -0.085, z: sp * (tt + 0.055), yaw: sd === "l" ? 0.05 : -0.05, contact: 0.11 };
  });
  const last = runSteps[runSteps.length - 1]; // take-off plant
  const TP = last.t;
  // the swing leg's would-be next step keeps it moving through the take-off
  runSteps.push({ t: TP + 0.2, side: last.side === "l" ? "r" : "l", x: last.side === "l" ? -0.085 : 0.085, z: last.z + 1.45, contact: 0.11 });
  const g = gait(Math.min(t, TP), runSteps, RUN);

  /* ---- pelvis path: run -> plant & push -> flat ballistic flight -> landing -> slide ---- */
  const zp = last.z;
  const yL = 0.84;
  const pL: Vec3 = [last.x * 0.4, yL, zp + 0.45];
  const f = LD - L;
  const vz = 6.2;
  const vx = (-side * 0.75) / f;
  const yLand = 0.17;
  const vy = (yLand - yL + 4.9 * f * f) / f;
  const landP: Vec3 = [pL[0] + vx * f, yLand, pL[2] + vz * f];
  const slideV = 4.4;
  const slideT = SE - LD;
  const rootAt = (t: number): Vec3 => {
  if (t <= TP) return gait(t, runSteps, RUN).pelvis;
  if (t <= L) {
    // continuous velocity at both ends: the run's pelvis before the plant, the ballistic flight after launch
    const gp0 = gait(TP - 0.06, runSteps, RUN).pelvis;
    const gp = gait(TP, runSteps, RUN).pelvis;
    const fl = 0.06;
    return track3(
      v3keys([
        [TP - 0.06, gp0],
        [TP, gp],
        [(TP + L) / 2, [last.x * 0.6, 0.8, zp + 0.08]],
        [L, pL],
        [L + fl, [pL[0] + vx * fl, yL + vy * fl - 4.9 * fl * fl, pL[2] + vz * fl]],
      ]),
      t,
    );
  }
  if (t <= LD) {
    const u = t - L;
    return [pL[0] + vx * u, yL + vy * u - 4.9 * u * u, pL[2] + vz * u];
  }
  const u = Math.min(t - LD, slideT);
  const d = slideV * u - (slideV / (2 * slideT)) * u * u;
  return [landP[0] - side * 0.12 * (d / (slideV * slideT * 0.5)), yLand - 0.02 * clamp(u / slideT), landP[2] + d];
  };
  const root = rootAt(t);

  /* ---- body attitude ---- */
  const gTP = gait(TP, runSteps, RUN);
  const rotAt = (t: number): Vec3 => [
    track([[TP - 0.2, 0.18], [TP, 0.3], [L, 0.62], [L + 0.15, 1.36], [LD, 1.48], [SE, 1.5]], t),
    t <= TP ? gait(t, runSteps, RUN).pelvisYaw : track([[TP, gTP.pelvisYaw], [L, -side * 0.08], [LD, -side * 0.15]], t),
    side * track([[TP, 0], [L, 0.1], [C, 0.45], [LD, 0.6], [SE, 0.78], [SE + 0.4, 0.95]], t),
  ];
  const rootRot = rotAt(t);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rootRot[0], rootRot[1], rootRot[2], "YXZ"));
  const toChar = (p: Vec3): Vec3 => {
    const w = v3(p).applyQuaternion(q).add(v3(root));
    return [w.x, w.y, w.z];
  };
  const dirChar = (d: Vec3): Vec3 => {
    const w = v3(d).applyQuaternion(q);
    return [w.x, w.y, w.z];
  };

  /* ---- legs ---- */
  // after landing the legs stretch out straight behind on the turf (knees never dig in)
  const stretch = s5(LD - 0.06, LD + 0.16, t);
  const air = (sd: Side, off: Vec3, pitchF: number): FootTarget => {
    const o2 = lerp3(off, [sd === "l" ? 0.1 : -0.1, -0.902, -0.02], stretch);
    const ft = bodyFoot(root, rootRot, o2, pitchF);
    const floor = lerp(0.065, 0.11, stretch);
    if (ft.ankle.y < floor) ft.ankle.y = floor;
    return ft;
  };
  let lFoot: FootTarget;
  let rFoot: FootTarget;
  if (t <= TP) {
    lFoot = g.l;
    rFoot = g.r;
  } else {
    // take-off foot (last plant) pushes off, the other leg drives through then both trail
    const plantF = plant(last.x, last.z, last.yaw ?? 0, track([[TP, 0.05], [TP + 0.03, 0], [L, 1.0]], t));
    const kick = s5(L, L + 0.22, t);
    // full-length dive: the push-off leg trails long and nearly straight, toes pointed
    const trailT = air(last.side, [last.side === "l" ? 0.11 : -0.11, -0.895, -0.07], 0.95);
    const takeoff = t <= L ? plantF : mixFoot(plant(last.x, last.z, last.yaw ?? 0, 1.0), trailT, s5(L, L + 0.12, t));
    const driveKnee = air(last.side === "l" ? "r" : "l", [last.side === "l" ? -0.1 : 0.1, lerp(-0.45, -0.885, kick), lerp(0.25, -0.06, kick)], lerp(0.3, 0.95, kick));
    const swingFrom = gait(TP, runSteps, RUN)[last.side === "l" ? "r" : "l"];
    const other = mixFoot(swingFrom, driveKnee, s5(TP, TP + 0.08, t));
    if (last.side === "l") {
      lFoot = takeoff;
      rFoot = other;
    } else {
      rFoot = takeoff;
      lFoot = other;
    }
  }

  /* ---- arms: run -> reach ahead -> cupped catch -> protect the ball -> raise it ---- */
  const reachK = s5(TP - 0.08, C - 0.12, t);
  const after = s5(C + 0.02, LD + 0.12, t);
  const lift = s5(SE - 0.05, SE + 0.35, t);
  const hc: Vec3 = lerp3(lerp3([0, 0.72, 0.42], [0, 1.1, 0.02], reachK), [-side * 0.04, 0.98, -0.12], after);
  const sep = lerp(0.13, 0.055, s5(C - 0.1, C - 0.01, t));
  const fingers: Vec3 = [0, 0.9, -0.35];
  let wl = toChar([hc[0] + sep, hc[1] - 0.06, hc[2]]);
  let wr = toChar([hc[0] - sep, hc[1] - 0.06, hc[2]]);
  if (t < C) {
    // before the catch the hands reach for the CATCH POINT (where the ball will be met), not along the body
    // axis: from the running carriage they go forward and down to the ball, never up over the head
    const rC = rootAt(C);
    const oC = rotAt(C);
    const qC = new THREE.Quaternion().setFromEuler(new THREE.Euler(oC[0], oC[1], oC[2], "YXZ"));
    const at = (off: Vec3): Vec3 => {
      const w = v3(off).applyQuaternion(qC).add(v3(rC));
      return [w.x, w.y, w.z];
    };
    const runL = toChar([0.13, 0.66, 0.42]);
    const runR = toChar([-0.13, 0.66, 0.42]);
    wl = lerp3(runL, at([sep, 1.1 - 0.06, 0.02]), reachK);
    wr = lerp3(runR, at([-sep, 1.1 - 0.06, 0.02]), reachK);
  }
  // never put the hands into the turf (the ball is held up off the grass)
  wl[1] = Math.max(wl[1], 0.13);
  wr[1] = Math.max(wr[1], 0.13);
  const ikL: ArmSpec = {
    wrist: wl,
    fingers: dirChar([0.15, fingers[1], fingers[2]]),
    palm: dirChar([-0.55, 0.2, -0.8]),
    pole: dirChar([0.8, -0.2, 0.5]),
  };
  const ikR: ArmSpec = {
    wrist: wr,
    fingers: dirChar([-0.15, fingers[1], fingers[2]]),
    palm: dirChar([0.55, 0.2, -0.8]),
    pole: dirChar([-0.8, -0.2, 0.5]),
  };
  const spec: BodySpec = {
    root,
    rootRot,
    spine: [lerp(0.1, -0.12, reachK), t <= TP ? g.chestYaw * 0.45 : 0, side * 0.08 * reachK],
    chest: [lerp(0.08, -0.12, reachK), t <= TP ? g.chestYaw * 0.55 : 0, side * 0.06 * reachK],
    look: t < C + 0.05 ? [root[0] - side * 0.2, 0.45, root[2] + 2.0] : [root[0], 0.5, root[2] + 2.5],
    lookHead: 0.75,
    lFoot,
    rFoot,
    // knees point along the body's front (toward the turf once horizontal), never flipping at launch
    lKnee: dirChar([0.12, 0.05, 1]),
    rKnee: dirChar([-0.12, 0.05, 1]),
    lArm: ikL,
    rArm: ikR,
    lGrip: lerp(0.3, 0.78, s5(C - 0.02, C + 0.05, t)),
    rGrip: lerp(0.3, 0.78, s5(C - 0.02, C + 0.05, t)),
    ball: t >= C ? { hand: "r", grip: "cup" } : null,
  };
  let pose = build(spec);
  const runW = 1 - reachK;
  if (runW > 0) pose = blendPose(pose, build({ ...spec, lArm: runArm("l", g.armPhase, 1), rArm: runArm("r", g.armPhase, 1) }), runW);
  if (lift > 0) {
    const up: ArmReachSpec = { dir: [-0.25, 0.85, 0.45], dist: 0.5, fingers: [-0.2, 0.8, 0.5], palm: [0.4, 0.2, 0.9], pole: [-0.6, -0.3, -0.7] };
    pose = blendPose(pose, build({ ...spec, rArm: up, rGrip: 0.8 }), lift);
  }
  return pose;
};

export const THROW = {
  COLLECT_T: 0.6,
  THROW_RELEASE_T: 1.2,
};

export type ThrowOpts = { collectT?: number; releaseT?: number };

/**
 * pickupThrow: runs in along +Z, bends to collect the ball with the right hand beside the left foot at
 * collectT (ball on the ground at the frame origin), crow-hops (right foot side-on), front foot toward
 * the target, powerful overarm throw (elbow leads, arm extends) with release at releaseT along +Z,
 * follow-through across the body. The post-collect phases scale with (releaseT - collectT).
 */
export const pickupThrow = (t: number, o: ThrowOpts = {}): ActionPose => {
  const C = o.collectT ?? THROW.COLLECT_T;
  const R = o.releaseT ?? THROW.THROW_RELEASE_T;
  const D = Math.max(0.2, R - C);
  // canonical post-collect clock: 0 collect, 0.6 release
  const k = t <= C ? t - C : ((t - C) / D) * 0.6;
  const approach: Footfall[] = [
    { t: C - 0.85, side: "l", x: 0.1, z: -4.1, contact: 0.16 },
    { t: C - 0.62, side: "r", x: -0.08, z: -3.0, contact: 0.16 },
    { t: C - 0.4, side: "l", x: 0.08, z: -1.95, contact: 0.18 },
    { t: C - 0.17, side: "r", x: -0.12, z: -0.95, contact: 0.2 },
  ];
  const stoop = s5(-0.32, -0.02, k) * (1 - s5(0.03, 0.2, k));
  // feet
  let lFoot: FootTarget;
  let rFoot: FootTarget;
  const g = gait(Math.min(t, C), approach, JOG);
  // L plants beside the ball, R crow-hops side-on, L strides to the target
  const lPick = plant(0.18, -0.1, 0.15);
  const rHop1 = plant(-0.05, 0.55, -1.35);
  const rHop2 = plant(-0.02, 1.0, -1.4);
  const lStride = plant(0.12, 2.0, -0.25);
  const lToe = plant(0.18, -0.1, 0.15, 0.9);
  if (k < -0.17) {
    lFoot = g.l;
  } else if (k < 0.0) {
    const s = span(-0.17, -0.02, k);
    const from = g.l;
    lFoot = mixFoot(from, lPick, s5(0, 1, s));
    lFoot.ankle.y += 0.1 * Math.sin(Math.PI * s);
  } else if (k < 0.32) {
    lFoot = plant(0.18, -0.1, 0.15, track([[0, 0], [0.06, 0.4], [0.12, 0.9]], k));
    if (k > 0.12) {
      const s = span(0.12, 0.32, k);
      const fp = lToe.ankle.clone().lerp(lStride.ankle, s5(0, 1, s * 0.45));
      fp.y += 0.2 * Math.sin(Math.PI * s * 0.6);
      lFoot = airFoot([fp.x, fp.y, fp.z], lerp(0.15, -0.25, s), 0.6);
    }
  } else if (k < 0.48) {
    const s = span(0.32, 0.48, k);
    const from = lToe.ankle.clone().lerp(lStride.ankle, s5(0, 1, 0.45));
    from.y += 0.2 * Math.sin(Math.PI * 0.6);
    const fp = from.clone().lerp(lStride.ankle, s5(0, 1, s));
    fp.y += 0.08 * Math.sin(Math.PI * s);
    lFoot = airFoot([fp.x, fp.y, fp.z], -0.25, lerp(0.4, -0.25, s));
  } else {
    lFoot = plant(0.12, 2.0, -0.25, track([[0.48, -0.25], [0.53, 0], [0.75, 0], [0.95, 0.6]], k));
  }
  if (k < 0.0) {
    rFoot = g.r;
  } else if (k < 0.14) {
    const s = span(0.0, 0.14, k);
    const from = gait(C, approach, JOG).r;
    const fp = from.ankle.clone().lerp(rHop1.ankle, s5(0, 1, s));
    fp.y += 0.18 * Math.sin(Math.PI * s);
    rFoot = { ankle: fp, q: from.q.clone().slerp(rHop1.q, s) };
  } else if (k < 0.2) {
    rFoot = rHop1;
  } else if (k < 0.34) {
    // the hop: the same foot skips forward
    const s = span(0.2, 0.34, k);
    const fp = rHop1.ankle.clone().lerp(rHop2.ankle, s5(0, 1, s));
    fp.y += 0.09 * Math.sin(Math.PI * s);
    rFoot = { ankle: fp, q: rHop1.q.clone().slerp(rHop2.q, s) };
  } else if (k < 0.62) {
    rFoot = plant(-0.02, 1.0, -1.4, track([[0.34, 0], [0.5, 0.2], [0.6, 0.9]], k));
  } else {
    const s = span(0.62, 0.85, k);
    const from = plant(-0.02, 1.0, -1.4, 0.9);
    const to = plant(0.15, 2.9, 0.2, -0.1);
    const fp = from.ankle.clone().lerp(to.ankle, s5(0, 1, s));
    fp.y += 0.3 * Math.sin(Math.PI * s);
    rFoot = s >= 1 ? to : { ankle: fp, q: from.q.clone().slerp(to.q, s) };
  }
  // pelvis
  const root = k < -0.17
    ? g.pelvis
    : track3(
        v3keys([
          [-0.17, g.pelvis],
          [0.0, [0.1, 0.6, -0.3]],
          [0.1, [0.06, 0.82, 0.2]],
          [0.2, [0.02, 0.95, 0.55]],
          [0.27, [0.0, 1.0, 0.8]],
          [0.34, [0.0, 0.93, 1.0]],
          [0.48, [0.02, 0.9, 1.35]],
          [0.6, [0.06, 0.92, 1.68]],
          [0.75, [0.12, 0.86, 2.15]],
          [1.0, [0.2, 0.92, 2.7]],
        ]),
        k,
      );
  const yaw = track([[-0.17, 0], [0, 0.05], [0.14, -0.9], [0.34, -1.35], [0.48, -1.2], [0.6, -0.15], [0.75, 0.35], [1.0, 0.3]], k);
  const pitch = track([[-0.3, 0.15], [0, 0.85], [0.12, 0.3], [0.3, 0.02], [0.48, 0.0], [0.6, 0.2], [0.75, 0.45], [1.0, 0.2]], k);
  const chestYaw = track([[0, 0], [0.34, -0.35], [0.48, -0.4], [0.56, 0.0], [0.6, 0.3], [0.75, 0.25], [1.0, 0.0]], k);
  const chestRoll = track([[0, 0], [0.34, 0.12], [0.48, 0.18], [0.6, -0.22], [0.8, 0]], k);
  // throwing arm
  let rArm: ArmSpec;
  let reachW = 1;
  // reach down to the ball beside the left foot (joint-space blend from the running arm, below)
  const pickArm: ArmSpec = {
    wrist: [0.02 - 0.04, 0.036 + 0.075, -0.07],
    fingers: [0.1, -0.85, 0.5],
    palm: [0.3, -0.2, 0.9],
    pole: [-0.6, 0.4, -0.5],
  };
  if (k < 0.02) {
    reachW = s5(-0.32, -0.04, k);
    rArm = reachW > 0 ? pickArm : runArm("r", g.armPhase, 1);
  } else if (k < 0.6) {
    // collect -> bring to the chest -> take back (cocked, high elbow) -> whip through
    // upper-arm angle in the throwing plane (0 down, pi/2 back, pi up, 3pi/2 forward), +2pi for continuity:
    // take-back, 'L' cock with the elbow at shoulder height and the ball high behind the head (layback),
    // elbow leads, forearm whips through, release in front of the head ~45 deg above horizontal
    // release ~38 deg in front of vertical: a flat, hard return (not a lob)
    const th = track([[0.02, 5.6], [0.15, 6.55], [0.3, 7.6], [0.45, 7.95], [0.52, 8.35], [0.57, 9.35], [0.6, 10.08]], k);
    const flexE = track([[0.02, 1.4], [0.15, 1.95], [0.3, 0.55], [0.45, 1.65], [0.52, 1.9], [0.56, 1.5], [0.6, 0.25]], k);
    const a = th - 2 * Math.PI;
    const across = track([[0.05, -0.2], [0.3, -0.45], [0.45, -0.55], [0.55, -0.4], [0.6, -0.2]], k);
    const upper: Vec3 = [across, -Math.cos(a), -Math.sin(a)];
    // the elbow points down (cock) and the forearm stands up behind the head; later it points forward
    const pole: Vec3 = k < 0.3 ? [-0.3, -0.6, -0.8] : lerp3([-0.2, -1, -0.2], [0.0, -0.4, 0.9], s5(0.5, 0.6, k));
    rArm = { aim: upper, pole, flex: flexE, pron: track([[0.05, 0.6], [0.45, -0.4], [0.6, 0.7]], k), wflex: [track([[0.3, -0.4], [0.52, -0.7], [0.6, 0.4]], k), 0], space: "char" };
  } else {
    // follow-through: the arm keeps rotating down and across; the elbow pole continues from the release
    const a = track([[0.6, 3.8], [0.7, 4.6], [0.85, 5.3], [1.0, 5.6]], k);
    rArm = {
      aim: [track([[0.6, -0.2], [0.85, 0.45], [1.0, 0.4]], k), -Math.cos(a), -Math.sin(a)],
      pole: [0.2 * (1 - s5(0.6, 0.7, k)), Math.sin(a), -Math.cos(a)],
      flex: track([[0.6, 0.25], [0.8, 0.3], [1.0, 0.4]], k),
      pron: track([[0.6, 0.7], [0.8, 0.8]], k),
      wflex: [0.4, 0],
      space: "char",
    };
  }
  // front (glove) arm: points at the target, then pulls in
  const lThrow = aimTrack(
    [
      [0.0, [0.25, -0.8, 0.4], [0.7, 0.0, -0.6], 0.8, 0.2],
      [0.2, [0.1, 0.1, 1], [0.7, -0.6, -0.3], 0.5, 0.3],
      [0.45, [0.05, 0.25, 1], [0.8, -0.4, -0.3], 0.3, 0.4],
      [0.6, [0.5, -0.6, -0.2], [0.4, -0.2, -1], 1.6, 0.3],
      [0.85, [0.35, -0.85, -0.3], [0.4, 0.2, -1], 1.2, 0.3],
    ],
    Math.max(0, k),
    "char",
  );
  // the glove arm leaves the running swing for the throwing set-up through a joint-space blend (below)
  const lArm: ArmSpec = k < -0.12 ? runArm("l", g.armPhase, 1 - stoop) : lThrow;
  // eyes on the ball until it is in the hand, then up to the target (one continuous move)
  const lookT: Vec3 = lerp3(lerp3([0.02, 0.04, 0.45], [0.02, 0.4, 2], s5(-0.04, 0.06, k)), [0, 1.0, 30], s5(0.04, 0.25, k));
  // after the follow-through he comes up out of it, arms drop, eyes follow the throw in (no frozen hold)
  const settle = s5(1.0, 2.2, k);
  const breathe = Math.sin(k * 3.1) * 0.004 * settle;
  const relaxL: ArmAimSpec = { aim: [0.2, -1, 0.1], pole: [0.3, 0.1, -1], flex: 0.45, pron: 0.2, space: "char" };
  const relaxR: ArmAimSpec = { aim: [-0.2, -1, 0.1], pole: [-0.3, 0.1, -1], flex: 0.45, pron: 0.2 };
  const spec: BodySpec = {
    root: [root[0], root[1] + 0.05 * settle + breathe, root[2]],
    rootRot: [pitch - 0.12 * settle, yaw, track([[0.34, 0.08], [0.6, -0.1], [0.8, 0]], k)],
    spine: [lerp(0.15, 0.5, stoop) + (k > 0.55 ? 0.15 * s5(0.55, 0.75, k) : 0) - 0.12 * settle, chestYaw * 0.4, chestRoll * 0.4],
    chest: [lerp(0.08, 0.3, stoop) - 0.04 * settle, chestYaw * 0.6, chestRoll * 0.6],
    look: lerp3(lookT, [0, 1.3, 30], settle),
    lookHead: 0.6,
    lFoot,
    rFoot,
    lArm: settle > 0 && !isIKArm(lArm) ? mixAim(lArm as ArmAimSpec, relaxL, settle) : lArm,
    rArm: settle > 0 && !isIKArm(rArm) ? mixAim(rArm as ArmAimSpec, { ...relaxR, space: "char", aim: [-0.25, -1, 0.15], pole: [-0.2, 0.1, -1] }, settle) : rArm,
    lGrip: 0.35,
    rGrip: k < 0 ? 0.4 : k < 0.6 ? 0.55 : 0.25,
    rFingers: k >= 0 && k < 0.6 ? [0.55, 0.35, 0.35, 0.75, 0.85] : undefined,
    ball: k >= 0 && k < 0.6 ? { hand: "r", grip: "throw" } : null,
  };
  let pose = build(spec);
  // per-arm joint-space blends (the trunk is shared): pick-up IK -> throwing arm, running swings -> set-up
  if (k >= -0.02 && k < 0.14) pose = blendArm(pose, build({ ...spec, rArm: pickArm }), "r", 1 - s5(0.02, 0.14, k));
  if (k >= -0.12 && k < 0.04) pose = blendArm(pose, build({ ...spec, lArm: runArm("l", g.armPhase, 1 - stoop) }), "l", 1 - s5(-0.12, 0.04, k));
  if (reachW < 1) pose = blendArm(pose, build({ ...spec, rArm: runArm("r", g.armPhase, 1) }), "r", 1 - reachW);
  return pose;
};

/* ================================================================== */
/* Celebrations                                                        */
/* ================================================================== */

/** appeal: from a bent follow-through facing +Z, he pivots on the right foot toward the umpire behind
 * him (-Z), the left knee lifts, right arm straight up with the index finger pointing, left arm up and
 * out, chest open, head up: peak APPEAL_T (0.45 s); holds with small pulses, left foot down by 1.1 s. */
export const APPEAL_T = 0.45;
export const appeal = (t: number): ActionPose => {
  const w = s5(0.05, APPEAL_T, t);
  const pulse = Math.sin(Math.max(0, t - APPEAL_T) * 7) * 0.02 * sstep(APPEAL_T, APPEAL_T + 0.2, t) * (1 - sstep(0.95, 1.15, t));
  const yaw = lerp(0, 2.75, s5(0.0, APPEAL_T - 0.03, t));
  const rot = (x: number, z: number): [number, number] => [x * Math.cos(yaw) + z * Math.sin(yaw), -x * Math.sin(yaw) + z * Math.cos(yaw)];
  // right foot: planted, pivots on its ball
  const rBall: [number, number] = [-0.12, 0.02 + RIG.ball.z];
  const rF = plantBall(rBall[0], rBall[1], yaw * 0.85, lerp(0.15, 0.4, w));
  // left foot: lifts off the follow-through spot, knee up at the peak, sets down beside the right foot
  const start = plant(0.14, 0.42, 0.1, 0.2);
  const [ex, ez] = rot(0.16, 0.0);
  const end = plant(ex, ez, yaw, 0);
  const lift = s5(0.04, 0.2, t) * (1 - s5(0.92, 1.12, t));
  const travel = s5(0.04, 1.1, t);
  const la = start.ankle.clone().lerp(end.ankle, travel);
  la.y += lift * 0.26 + pulse;
  const lF: FootTarget = { ankle: la, q: start.q.clone().slerp(end.q, travel).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), lift * 0.5)) };
  const fwd = rot(0, 1);
  return build({
    root: [0.0, lerp(0.86, 0.995, w) + pulse, 0.08 * (1 - w)],
    rootRot: [lerp(0.45, -0.06, w), yaw, 0],
    spine: [lerp(0.3, -0.12, w), 0, 0],
    chest: [lerp(0.2, -0.18, w), 0, lerp(0, 0.06, w)],
    look: lerp3([0, 0.3, 4], [fwd[0] * 20, 4.5, fwd[1] * 20], s5(0.0, APPEAL_T, t)),
    lookHead: 0.6,
    lFoot: lF,
    rFoot: rF,
    lKnee: [Math.sin(yaw) + 0.3 * Math.cos(yaw), 0.2, Math.cos(yaw) - 0.3 * Math.sin(yaw)],
    lArm: mixAim(
      { aim: [0.2, -0.9, -0.3], pole: [0.4, 0.3, -1], flex: 0.6, pron: 0.2 },
      { aim: [0.75, 0.62, 0.2], pole: [0.6, -0.5, -0.5], flex: 0.35 + pulse, pron: -0.5, wflex: [-0.2, 0] },
      w,
    ),
    rArm: mixAim(
      { aim: [0.35, -0.85, 0.35], pole: [-0.3, 0.3, -1], flex: 0.3, pron: 0.5 },
      { aim: [-0.12, 1, 0.12], pole: [-0.6, -0.1, -0.8], flex: 0.08 + pulse, pron: -0.3, wflex: [0.1, 0] },
      w,
    ),
    lGrip: 0.2,
    rGrip: 0.85,
    rFingers: w > 0.6 ? [0.8, 0.0, 0.92, 0.95, 0.95] : undefined,
  });
};

/** celebrateFistPump: turns to the teammates (to his left), stepping the left foot round
 * (P-0.45 -> P-0.12), loads (fist by the ear at P-0.18), then pulls the fist down hard to the hip at
 * FIST_PUMP_T (0.4 s) with a knee dip and a short crunch; a smaller second pump at P+0.35; settles by P+0.9. */
export const FIST_PUMP_T = 0.4;
export const celebrateFistPump = (t: number, o: { pumpT?: number } = {}): ActionPose => {
  const P = o.pumpT ?? FIST_PUMP_T;
  const u = t - P;
  const turn = lerp(0, 0.9, s5(-0.45, -0.1, u));
  const load = s5(-0.4, -0.16, u) * (1 - s5(-0.12, 0.0, u));
  const pump = s5(-0.14, 0.0, u) * (1 - s5(0.15, 0.5, u));
  const pump2 = bump(0.22, 0.55, u) * 0.6;
  const dip = s5(-0.1, 0.02, u) * (1 - s5(0.1, 0.45, u)) + pump2 * 0.4;
  // right foot pivots on its ball; left foot steps round
  const rF = plantBall(-0.17, -0.02 + RIG.ball.z * Math.cos(-0.25), -0.25 + turn * 0.6, 0.06 + 0.3 * bump(-0.5, -0.05, u));
  const lStart = plant(0.15, 0.02, 0.15, 0);
  const lx = 0.15 * Math.cos(turn) + 0.12 * Math.sin(turn);
  const lz = -0.15 * Math.sin(turn) + 0.12 * Math.cos(turn);
  const lEnd = plant(lx, lz, turn * 0.9 + 0.15, 0);
  const sk = s5(-0.45, -0.12, u);
  const la = lStart.ankle.clone().lerp(lEnd.ankle, sk);
  la.y += Math.sin(Math.PI * sk) * 0.08;
  const lF: FootTarget = { ankle: la, q: lStart.q.clone().slerp(lEnd.q, sk) };
  const fistUp: ArmAimSpec = { aim: [-0.55, 0.2, 0.55], pole: [-0.7, -0.6, -0.3], flex: 2.1, pron: 0.4, wflex: [0.0, 0] };
  const fistDown: ArmAimSpec = { aim: [-0.25, -0.9, -0.35], pole: [-0.4, 0.2, -1], flex: 1.65, pron: 0.6, wflex: [0.2, 0] };
  const rest: ArmAimSpec = { aim: [-0.25, -0.95, 0.1], pole: [-0.3, 0.1, -1], flex: 0.6, pron: 0.3 };
  let rArm = mixAim(rest, fistUp, load);
  rArm = mixAim(rArm, fistDown, Math.max(pump, pump2));
  return build({
    root: [0.02 * Math.sin(turn), 0.965 - dip * 0.12, 0.02],
    rootRot: [0.05 + dip * 0.2, turn * 0.6, 0],
    spine: [0.04 + dip * 0.18 - load * 0.06, turn * 0.25, 0],
    chest: [0.02 + dip * 0.15 - load * 0.08, turn * 0.15, -load * 0.1],
    look: [8 * Math.sin(turn + 0.2), 1.5, 8 * Math.cos(turn + 0.2)],
    lookHead: 0.55,
    lFoot: lF,
    rFoot: rF,
    lArm: mixAim(
      { aim: [0.25, -0.95, 0.05], pole: [0.3, 0.1, -1], flex: 0.5, pron: 0.2 },
      { aim: [0.6, -0.7, 0.15], pole: [0.6, 0.3, -0.8], flex: 0.7, pron: 0.1 },
      Math.max(load, dip),
    ),
    rArm,
    lGrip: 0.4,
    rGrip: lerp(0.4, 1.0, s5(-0.45, -0.3, u)),
  });
};

/** celebrateJump: crouch (anticipation from J-0.42), toes push off at J-0.2, apex JUMP_T (0.52 s) with
 * the right fist punching up and knees tucked, toes touch at J+0.2, soft landing bend, recover by J+0.6. */
export const JUMP_T = 0.52;
export const celebrateJump = (t: number, o: { jumpT?: number } = {}): ActionPose => {
  const A = o.jumpT ?? JUMP_T;
  const u = t - A;
  const T0 = -0.2;
  const T1 = 0.2;
  const H = 0.22;
  const crouch = s5(-0.44, -0.3, u) * (1 - s5(-0.3, T0 + 0.01, u));
  const land = s5(T1, T1 + 0.08, u) * (1 - s5(T1 + 0.12, T1 + 0.45, u));
  const air = u > T0 && u < T1;
  const fs = clamp((u - T0) / (T1 - T0));
  const y = air ? 4 * H * fs * (1 - fs) : 0;
  const tuck = air ? Math.sin(Math.PI * fs) ** 2 : 0;
  // toes: push off (heel peels from J-0.3), pointed in the air, toes first on landing
  const roll = track([[-0.3, 0], [T0, 0.95], [T0 + 0.05, 0.75], [T1 - 0.05, 0.7], [T1, 0.55], [T1 + 0.08, 0]], u);
  const lF = plant(0.14, 0.02, 0.15, roll);
  const rF = plant(-0.14, 0.0, -0.15, roll);
  lF.ankle.y += y + tuck * 0.16;
  rF.ankle.y += y + tuck * 0.13;
  lF.ankle.z -= tuck * 0.05;
  rF.ankle.z -= tuck * 0.04;
  const up = s5(-0.25, -0.05, u) * (1 - s5(0.3, 0.6, u));
  const pel: Vec3 = [0, 0.97 - crouch * 0.22 - land * 0.18 + y + roll * 0.06, 0];
  return build({
    root: pel,
    rootRot: [0.08 + crouch * 0.45 + land * 0.32 - up * 0.1, 0, 0],
    spine: [0.04 + crouch * 0.2 + land * 0.14 - up * 0.08, 0, 0],
    chest: [crouch * 0.15 - up * 0.1, 0, 0],
    look: [0, lerp(1.6, 3.5, up), 10],
    lFoot: lF,
    rFoot: rF,
    lKnee: [0.2, 0, 1],
    rKnee: [-0.2, 0, 1],
    lArm: mixAim(
      mixAim({ aim: [0.2, -0.95, 0.1], pole: [0.3, 0.1, -1], flex: 0.5 }, { aim: [0.25, -0.75, -0.6], pole: [0.3, 0.5, -1], flex: 0.4 }, crouch),
      { aim: [0.7, 0.55, 0.3], pole: [0.6, -0.5, -0.6], flex: 0.6, pron: -0.4 },
      up,
    ),
    rArm: mixAim(
      mixAim({ aim: [-0.2, -0.95, 0.1], pole: [-0.3, 0.1, -1], flex: 0.5 }, { aim: [-0.25, -0.75, -0.6], pole: [-0.3, 0.5, -1], flex: 0.4 }, crouch),
      { aim: [-0.2, 1, 0.15], pole: [-0.6, -0.2, -0.8], flex: 0.15, pron: 0.0 },
      up,
    ),
    lGrip: 0.35,
    rGrip: lerp(0.4, 1.0, up),
  });
};

export type RunToOpts = { stopT?: number };

/** runToTeammate: runs in along +Z decelerating (steps every ~0.23 s, lengthening gaps), arms opening
 * from 0.75 s, stops at STOP_T (1.2 s) at the origin with arms wide, right hand raised for a high five. */
export const RUN_TO_STOP_T = 1.2;
export const runToTeammate = (t: number, o: RunToOpts = {}): ActionPose => {
  const S = o.stopT ?? RUN_TO_STOP_T;
  const times = [S - 1.73, S - 1.5, S - 1.27, S - 1.04, S - 0.8, S - 0.56, S - 0.3, S - 0.06];
  const zs = [-8.1, -6.6, -5.1, -3.75, -2.5, -1.4, -0.5, -0.18];
  const steps: Footfall[] = times.map((tt, i) => {
    const sd: Side = (times.length - 1 - i) % 2 === 0 ? "l" : "r";
    return { t: tt, side: sd, x: sd === "l" ? 0.12 : -0.12, z: zs[i] + (sd === "l" ? 0.05 : 0), yaw: sd === "l" ? 0.12 : -0.12, contact: i >= times.length - 2 ? 3 : 0.15 };
  });
  const g = gait(t, steps, JOG);
  const open = s5(S - 0.45, S + 0.1, t);
  const settle = s5(S - 0.2, S + 0.25, t);
  const lOpen: ArmAimSpec = { aim: [0.8, 0.1, 0.55], pole: [0.5, -0.6, -0.6], flex: 0.5, pron: -0.6 };
  const rHigh: ArmAimSpec = { aim: [-0.35, 0.9, 0.3], pole: [-0.6, -0.2, -0.8], flex: 0.45, pron: -0.6 };
  const pel: Vec3 = [g.pelvis[0], lerp(g.pelvis[1], 0.965, settle), g.pelvis[2]];
  return build({
    root: pel,
    rootRot: [lerp(0.15, -0.02, settle), g.pelvisYaw * (1 - settle), g.pelvisRoll * (1 - settle)],
    spine: [lerp(0.1, -0.03, settle), g.chestYaw * 0.45 * (1 - settle), 0],
    chest: [lerp(0.08, -0.06, settle), g.chestYaw * 0.55 * (1 - settle), 0],
    look: [0, 1.65, 3],
    lFoot: g.l,
    rFoot: g.r,
    lArm: mixAim(runArm("l", g.armPhase, 0.9), lOpen, open),
    rArm: mixAim(runArm("r", g.armPhase, 0.9), rHigh, open),
    lGrip: lerp(0.55, 0.1, open),
    rGrip: lerp(0.55, 0.1, open),
  });
};

/* ================================================================== */
/* Spec-named key times (aliases)                                      */
/* ================================================================== */

/** batDrive contact (s). */
export const CONTACT_T = BAT.CONTACT_T;
/** bowlDelivery release (s from the take-off plant, cue-locked default). */
export const RELEASE_T = BOWL.RELEASE_T;
/** diveCatch catch (s). */
export const CATCH_T = DIVE.CATCH_T;
/** pickupThrow release (s). */
export const THROW_RELEASE_T = THROW.THROW_RELEASE_T;

/* ================================================================== */
/* Registry (for the test scene and tools)                             */
/* ================================================================== */

export type ActionDef = {
  name: string;
  fn: (t: number) => ActionPose;
  /** preview range (s) */
  t0: number;
  t1: number;
  role: "batsman" | "bowler" | "fielder" | "keeper";
  /** key times to mark (s) */
  keys: Record<string, number>;
};

export const ACTIONS: ActionDef[] = [
  { name: "batStance", fn: (t) => batStance(t, { liftT: 1.6 }), t0: 0, t1: 2.2, role: "batsman", keys: { lift: 1.6 } },
  { name: "batDrive", fn: (t) => batDrive(t), t0: 0.1, t1: 2.0, role: "batsman", keys: { contact: BAT.CONTACT_T } },
  { name: "batCoverDrive", fn: (t) => batCoverDrive(t), t0: 0, t1: 1.5, role: "batsman", keys: { contact: BAT.COVER_CONTACT_T } },
  { name: "raiseBat", fn: raiseBat, t0: 0, t1: 2.0, role: "batsman", keys: { raised: RAISE_T } },
  { name: "runBetweenWickets", fn: (t) => runBetweenWickets(t), t0: 0, t1: 1.9, role: "batsman", keys: { ground: RUN_GROUND_T } },
  { name: "bowlRunUp", fn: (t) => bowlRunUp(t), t0: 0, t1: 1.95, role: "bowler", keys: { takeoff: BOWL.TAKEOFF_T } },
  { name: "bowlDelivery", fn: (t) => bowlDelivery(t), t0: 0, t1: 1.8, role: "bowler", keys: { bfc: BOWL.BFC_T, ffc: BOWL.FFC_T, release: BOWL.RELEASE_T } },
  { name: "keeperCrouch", fn: (t) => keeperCrouch(t), t0: 0, t1: 1.6, role: "keeper", keys: { rise: KEEPER.RISE_T } },
  { name: "keeperCollect", fn: (t) => keeperCollect(t, { finish: "break" }), t0: 0, t1: 1.4, role: "keeper", keys: { collect: KEEPER.COLLECT_T } },
  { name: "fielderReady", fn: fielderReady, t0: 0, t1: 2.0, role: "fielder", keys: { set: FIELD_READY.SET_T } },
  { name: "sprint", fn: (t) => sprint(t), t0: 0, t1: 1.2, role: "fielder", keys: {} },
  { name: "diveCatch", fn: (t) => diveCatch(t), t0: 0.2, t1: 2.2, role: "fielder", keys: { launch: DIVE.LAUNCH_T, catch: DIVE.CATCH_T } },
  { name: "pickupThrow", fn: (t) => pickupThrow(t), t0: 0, t1: 1.8, role: "fielder", keys: { collect: THROW.COLLECT_T, release: THROW.THROW_RELEASE_T } },
  { name: "appeal", fn: appeal, t0: 0, t1: 1.3, role: "bowler", keys: { peak: APPEAL_T } },
  { name: "celebrateFistPump", fn: (t) => celebrateFistPump(t), t0: 0, t1: 1.4, role: "bowler", keys: { pump: FIST_PUMP_T } },
  { name: "celebrateJump", fn: (t) => celebrateJump(t), t0: 0, t1: 1.3, role: "fielder", keys: { apex: JUMP_T } },
  { name: "runToTeammate", fn: (t) => runToTeammate(t), t0: 0, t1: 1.8, role: "fielder", keys: { stop: RUN_TO_STOP_T } },
];

/** Re-exports for convenience. */
export { rotOf, deg, wobble };
