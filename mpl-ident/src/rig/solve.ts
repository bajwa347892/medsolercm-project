/**
 * Skeleton, forward kinematics, analytic two-bone IK and attachment slots.
 *
 * CHARACTER SPACE (all actions and FK): metres, Y up, the character faces +Z,
 * +X is the character's LEFT, -X its right. The ground is y = 0.
 * Rest pose (all joint rotations zero): standing straight, arms hanging at the sides
 * with palms facing the thighs (thumbs forward), feet pointing +Z.
 *
 * Joint rotations are local Euler angles (radians) relative to the parent frame:
 *   trunk  (spine, chest, neck, head) order 'YXZ': [x = bend forward(+), y = turn left(+), z = lean right(+)]
 *   limbs  (shoulder, elbow, wrist, hip, knee, ankle) order 'XZY': x first, then z, then y (twist about the bone).
 * Pure right-hand-rule rotations; see README.md for the sign table per joint.
 *
 * Everything is a pure function of its inputs (no state, no time), so it is safe in Remotion.
 */
import * as THREE from "three";
import { JOINTS, type Joint, type Pose, type Vec3 } from "./types";
import { BAT_FACE_NORMAL, BAT_SWEET_SPOT } from "../world/Props";

export type Side = "l" | "r";
export const SIDE_SIGN: Record<Side, number> = { l: 1, r: -1 };

/* ------------------------------------------------------------------ */
/* Skeleton definition                                                 */
/* ------------------------------------------------------------------ */

export const RIG = {
  /** pelvis (root) height in the rest pose; feet flat on y=0 */
  pelvisHeight: 0.99,
  upperArm: 0.3,
  forearm: 0.262,
  thigh: 0.44,
  shin: 0.43,
  /** ankle joint above the shoe sole */
  ankleHeight: 0.08,
  /** shoe sole points in ankle-local space (rest): heel contact, ball of foot, toe tip */
  heel: new THREE.Vector3(0, -0.08, -0.06),
  ball: new THREE.Vector3(0, -0.08, 0.135),
  toe: new THREE.Vector3(0, -0.08, 0.205),
  /** total standing height to the top of the head */
  height: 1.83,
} as const;

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Offsets of each joint from its parent joint (rest, parent-local). Right side mirrors X. */
export const OFFSETS = {
  spine: V(0, 0.095, -0.015),
  chest: V(0, 0.2, 0.005),
  neck: V(0, 0.225, -0.03),
  head: V(0, 0.11, 0.025),
  shoulder: V(0.18, 0.18, -0.025),
  elbow: V(0, -RIG.upperArm, 0),
  wrist: V(0, -RIG.forearm, 0),
  hip: V(0.092, -0.04, 0.005),
  knee: V(0, -RIG.thigh, 0),
  ankle: V(0, -RIG.shin, 0),
} as const;

export const ORDER: Record<Joint, THREE.EulerOrder> = {
  spine: "YXZ",
  chest: "YXZ",
  neck: "YXZ",
  head: "YXZ",
  lShoulder: "XZY",
  lElbow: "XZY",
  lWrist: "XZY",
  rShoulder: "XZY",
  rElbow: "XZY",
  rWrist: "XZY",
  lHip: "XZY",
  lKnee: "XZY",
  lAnkle: "XZY",
  rHip: "XZY",
  rKnee: "XZY",
  rAnkle: "XZY",
};

/** Bones produced by the solver (joints + derived helper bones used for skinning). */
export const BONES = [
  "root",
  "spine",
  "chest",
  "neck",
  "head",
  "lClav",
  "lShoulder",
  "lForeA",
  "lForeB",
  "lWrist",
  "rClav",
  "rShoulder",
  "rForeA",
  "rForeB",
  "rWrist",
  "lHip",
  "lKnee",
  "lAnkle",
  "rHip",
  "rKnee",
  "rAnkle",
] as const;
export type Bone = (typeof BONES)[number];
export const BONE_INDEX = Object.fromEntries(BONES.map((b, i) => [b, i])) as Record<Bone, number>;

export type Solved = Record<Bone, THREE.Matrix4>;

/* ------------------------------------------------------------------ */
/* Small math helpers                                                  */
/* ------------------------------------------------------------------ */

const ONE = new THREE.Vector3(1, 1, 1);
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();

export const quatFromEuler = (r: Vec3, order: THREE.EulerOrder) =>
  new THREE.Quaternion().setFromEuler(_e.set(r[0], r[1], r[2], order));

export const eulerFromQuat = (q: THREE.Quaternion, order: THREE.EulerOrder): Vec3 => {
  _e.setFromQuaternion(q, order);
  return [_e.x, _e.y, _e.z];
};

const mat = (p: THREE.Vector3, q: THREE.Quaternion) => new THREE.Matrix4().compose(p, q, ONE);

const sideOff = (v: THREE.Vector3, s: Side) => new THREE.Vector3(v.x * SIDE_SIGN[s], v.y, v.z);

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Rotation quaternion of a matrix (no scale assumed). */
export const rotOf = (m: THREE.Matrix4) => new THREE.Quaternion().setFromRotationMatrix(m);
export const posOf = (m: THREE.Matrix4) => new THREE.Vector3().setFromMatrixPosition(m);

/** Quaternion from an orthonormal basis given as the images of the local X, Y, Z axes. */
export const quatFromBasis = (x: THREE.Vector3, y: THREE.Vector3, z: THREE.Vector3) =>
  new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));

/* ------------------------------------------------------------------ */
/* Clavicle: automatic shoulder girdle motion                          */
/* ------------------------------------------------------------------ */

/**
 * The shoulder joint rides on the clavicle/scapula: raising the arm overhead lifts and
 * draws the joint in, reaching forward protracts it. Derived from the shoulder rotation
 * (chest-local) so the Pose contract needs no extra joint.
 */
export const clavicleOffset = (qShoulderLocal: THREE.Quaternion, s: Side) => {
  const d = new THREE.Vector3(0, -1, 0).applyQuaternion(qShoulderLocal);
  const elev = Math.acos(Math.max(-1, Math.min(1, -d.y)));
  const k = smooth(1.15, 2.9, elev);
  const fwd = Math.max(0, d.z);
  const back = Math.max(0, -d.z);
  return new THREE.Vector3(-0.014 * k * SIDE_SIGN[s], 0.034 * k, 0.022 * fwd * (1 - 0.5 * k) - 0.014 * back);
};

/* ------------------------------------------------------------------ */
/* Forward kinematics                                                  */
/* ------------------------------------------------------------------ */

const trunkLocal = (off: THREE.Vector3, r: Vec3) => mat(off, quatFromEuler(r, "YXZ"));

/** Root (pelvis) matrix in character space. */
export const rootMatrix = (pose: Pose) => mat(new THREE.Vector3(...pose.root), quatFromEuler(pose.rootRot, "YXZ"));

/** Trunk matrices only (root, spine, chest, neck, head). */
export const solveTrunk = (pose: Pose) => {
  const root = rootMatrix(pose);
  const spine = root.clone().multiply(trunkLocal(OFFSETS.spine, pose.joints.spine));
  const chest = spine.clone().multiply(trunkLocal(OFFSETS.chest, pose.joints.chest));
  const neck = chest.clone().multiply(trunkLocal(OFFSETS.neck, pose.joints.neck));
  const head = neck.clone().multiply(trunkLocal(OFFSETS.head, pose.joints.head));
  return { root, spine, chest, neck, head };
};

const J = (s: Side, j: "Shoulder" | "Elbow" | "Wrist" | "Hip" | "Knee" | "Ankle") => `${s}${j}` as Joint;

/**
 * Forward kinematics: Pose -> character-space matrices for every bone.
 * Hands: `${side}Wrist` is the hand frame (origin at the wrist joint; see README for axes).
 * Feet: `${side}Ankle` is the foot frame (origin at the ankle joint, sole at y = -RIG.ankleHeight).
 */
export const solvePose = (pose: Pose): Solved => {
  const t = solveTrunk(pose);
  const out = { ...t } as Solved;
  for (const s of ["l", "r"] as Side[]) {
    const qSh = quatFromEuler(pose.joints[J(s, "Shoulder")], "XZY");
    const clavPos = sideOff(OFFSETS.shoulder, s).add(clavicleOffset(qSh, s));
    const clav = t.chest.clone().multiply(mat(clavPos, new THREE.Quaternion()));
    const shoulder = clav.clone().multiply(mat(new THREE.Vector3(), qSh));
    const el = pose.joints[J(s, "Elbow")];
    const foreA = shoulder.clone().multiply(mat(OFFSETS.elbow, quatFromEuler([el[0], 0, el[2]], "XZY")));
    const foreB = shoulder.clone().multiply(mat(OFFSETS.elbow, quatFromEuler(el, "XZY")));
    const wrist = foreB.clone().multiply(mat(OFFSETS.wrist, quatFromEuler(pose.joints[J(s, "Wrist")], "XZY")));
    out[`${s}Clav`] = clav;
    out[`${s}Shoulder`] = shoulder;
    out[`${s}ForeA`] = foreA;
    out[`${s}ForeB`] = foreB;
    out[`${s}Wrist`] = wrist;

    const hip = t.root.clone().multiply(mat(sideOff(OFFSETS.hip, s), quatFromEuler(pose.joints[J(s, "Hip")], "XZY")));
    const knee = hip.clone().multiply(mat(OFFSETS.knee, quatFromEuler(pose.joints[J(s, "Knee")], "XZY")));
    const ankle = knee.clone().multiply(mat(OFFSETS.ankle, quatFromEuler(pose.joints[J(s, "Ankle")], "XZY")));
    out[`${s}Hip`] = hip;
    out[`${s}Knee`] = knee;
    out[`${s}Ankle`] = ankle;
  }
  return out;
};

/** Bind (rest) matrices: FK of the zero pose. */
export const REST_POSE: Pose = {
  root: [0, RIG.pelvisHeight, 0],
  rootRot: [0, 0, 0],
  joints: Object.fromEntries(JOINTS.map((j) => [j, [0, 0, 0]])) as unknown as Record<Joint, Vec3>,
  lGrip: 0,
  rGrip: 0,
};

let restCache: Solved | null = null;
export const restSolved = () => {
  if (!restCache) restCache = solvePose(REST_POSE);
  return restCache;
};

/* ------------------------------------------------------------------ */
/* Two-bone IK                                                          */
/* ------------------------------------------------------------------ */

const perpUnit = (v: THREE.Vector3, axis: THREE.Vector3, fallback: THREE.Vector3) => {
  const p = v.clone().addScaledVector(axis, -v.dot(axis));
  if (p.lengthSq() < 1e-10) {
    const f = fallback.clone().addScaledVector(axis, -fallback.dot(axis));
    if (f.lengthSq() < 1e-10) {
      const alt = Math.abs(axis.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
      return alt.addScaledVector(axis, -alt.dot(axis)).normalize();
    }
    return f.normalize();
  }
  return p.normalize();
};

export type ArmIKResult = {
  shoulder: Vec3;
  elbow: Vec3;
  wrist: Vec3;
  /** distance between the requested and the reached wrist (m) */
  err: number;
  /** forearm twist actually used (rad, + = supination for the right arm) */
  twist: number;
  /** squared excess (rad^2) of wrist / forearm angles beyond the human range after the swivel */
  strain: number;
  /** elbow swivel used (rad, about the shoulder-wrist axis, relative to the requested pole) */
  swivel: number;
};

/** Forearm pronation/supination available to the IK (beyond it the wrist takes the rest). */
const MAX_TWIST = THREE.MathUtils.degToRad(115);
/** Comfortable forearm twist; beyond it the IK swivels the elbow (humeral rotation) to take the load. */
const SOFT_TWIST = THREE.MathUtils.degToRad(80);
/** Elbow swivel search: +-SWIVEL_MAX rad in 2*SWIVEL_N+1 samples, pole regularisation, soft-min temperature. */
const SWIVEL_MAX = 2.4;
const SWIVEL_STEPS = 24;
const SWIVEL_REG = 0.1;
const SWIVEL_TEMP = 0.012;

type ArmSolve = { qLocal: THREE.Quaternion; flex: number; twist: number; rawTwist: number; wristQ: THREE.Quaternion; err: number };

const armSolve = (
  chest: THREE.Matrix4,
  s: Side,
  wrist: THREE.Vector3,
  handQ: THREE.Quaternion | null,
  pole: THREE.Vector3,
  swivel: number,
): ArmSolve => {
  const L1 = RIG.upperArm;
  const L2 = RIG.forearm;
  const qC = rotOf(chest);
  const qCi = qC.clone().invert();
  const base = sideOff(OFFSETS.shoulder, s);
  let qLocal = new THREE.Quaternion();
  let S = new THREE.Vector3();
  let E = new THREE.Vector3();
  let qU = new THREE.Quaternion();
  let reached = wrist.clone();
  for (let it = 0; it < 3; it++) {
    const clav = clavicleOffset(qLocal, s);
    S = base.clone().add(clav).applyMatrix4(chest);
    const D = wrist.clone().sub(S);
    let d = D.length();
    const u = d > 1e-6 ? D.clone().divideScalar(d) : new THREE.Vector3(0, -1, 0);
    d = Math.max(Math.abs(L1 - L2) + 0.02, Math.min(L1 + L2 - 0.0004, d));
    reached = S.clone().addScaledVector(u, d);
    const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    const v = perpUnit(pole, u, new THREE.Vector3(0, 0, -1));
    if (swivel) v.applyAxisAngle(u, swivel);
    E = S.clone().addScaledVector(u, a).addScaledVector(v, h);
    const Y = S.clone().sub(E).normalize();
    // the forearm bends toward +Z (away from the elbow point): take it from the solved triangle
    const fore = reached.clone().sub(E);
    let Z = fore.addScaledVector(Y, -fore.dot(Y));
    if (Z.lengthSq() < 1e-8) Z = v.clone().negate();
    Z = perpUnit(Z, Y, v.clone().negate());
    const X = new THREE.Vector3().crossVectors(Y, Z).normalize();
    qU = quatFromBasis(X, Y, Z);
    qLocal = qCi.clone().multiply(qU);
  }
  const Sv = S.clone().sub(E);
  const Wv = reached.clone().sub(E);
  const cosI = Math.max(-1, Math.min(1, Sv.dot(Wv) / (Sv.length() * Wv.length())));
  const flex = Math.PI - Math.acos(cosI);
  const qF = qU.clone().multiply(_q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -flex));
  let twist = 0;
  let rawTwist = 0;
  let wristQ = new THREE.Quaternion();
  if (handQ) {
    const rel = qF.clone().invert().multiply(handQ);
    rawTwist = 2 * Math.atan2(rel.y, rel.w);
    if (rawTwist > Math.PI) rawTwist -= 2 * Math.PI;
    if (rawTwist < -Math.PI) rawTwist += 2 * Math.PI;
    twist = Math.max(-MAX_TWIST, Math.min(MAX_TWIST, rawTwist));
    const tq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), twist);
    wristQ = tq.clone().invert().multiply(rel);
  }
  return { qLocal, flex, twist, rawTwist, wristQ, err: reached.distanceTo(wrist) };
};

/** Comfortable wrist range (deg): flexion toward the palm / extension, ulnar / radial deviation. */
export const WRIST_RANGE = { flex: 70, ext: 60, ulnar: 32, radial: 18 } as const;

/**
 * Wrist decomposition of a local wrist rotation (swing about the forearm axis removed):
 * flex > 0 = toward the palm, dev > 0 = ulnar (toward the little finger), radians.
 */
export const wristAngles = (wristQ: THREE.Quaternion, s: Side) => {
  const q = wristQ.clone();
  if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
  const tw = 2 * Math.atan2(q.y, q.w);
  const sw = q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -tw));
  if (sw.w < 0) sw.set(-sw.x, -sw.y, -sw.z, -sw.w);
  const ang = 2 * Math.acos(Math.min(1, sw.w));
  const sn = Math.sqrt(Math.max(1e-12, 1 - sw.w * sw.w));
  const ax = sw.x / sn;
  const az = sw.z / sn;
  // +z bends the fingers toward local +X: the palm of the right hand, the back of the left hand
  return { dev: ax * ang, flex: az * ang * (s === "r" ? 1 : -1), twist: tw };
};

const D2R = Math.PI / 180;
/** Squared excess (rad^2) of forearm twist and wrist angles beyond the comfortable range. */
const wristStrain = (r: ArmSolve, s: Side) => {
  const w = wristAngles(r.wristQ, s);
  const ex = (v: number, lo: number, hi: number) => (v > hi ? v - hi : v < lo ? lo - v : 0);
  const eT = Math.max(0, Math.abs(r.rawTwist) - SOFT_TWIST);
  const eF = ex(w.flex, -WRIST_RANGE.ext * D2R, WRIST_RANGE.flex * D2R);
  const eD = ex(w.dev, -WRIST_RANGE.radial * D2R, WRIST_RANGE.ulnar * D2R);
  return eT * eT + eF * eF + eD * eD;
};

/**
 * Arm IK in character space.
 * @param chest  chest matrix (character space)
 * @param wrist  wrist joint target (character space)
 * @param handQ  desired hand frame rotation (character space) or null (relaxed wrist, no twist)
 * @param pole   direction the elbow should point (character space)
 *
 * When the requested hand orientation would need more forearm twist or wrist bend than a human
 * wrist allows (SOFT_TWIST, WRIST_RANGE), the elbow swivels about the shoulder-wrist axis
 * (humeral rotation) to the position that brings the wrist back into range, staying as close to
 * the requested pole as possible. This removes candy-wrapper forearms and broken-looking wrists
 * without per-action tuning.
 */
export const armIK = (
  chest: THREE.Matrix4,
  s: Side,
  wrist: THREE.Vector3,
  handQ: THREE.Quaternion | null,
  pole: THREE.Vector3,
  opts: { swivelN?: number; swivel?: number } = {},
): ArmIKResult => {
  let best = armSolve(chest, s, wrist, handQ, pole, opts.swivel ?? 0);
  let used = opts.swivel ?? 0;
  const SWIVEL_N = opts.swivelN ?? SWIVEL_STEPS;
  if (handQ && opts.swivel === undefined) {
    // soft-argmin over the elbow swivel: a continuous function of the targets (no frame-to-frame
    // jumps between competing solutions), close to the true minimum of wrist strain + pole deviation
    let wsum = 0;
    let ssum = 0;
    let cmin = Infinity;
    const costs: [number, number][] = [];
    for (let k = -SWIVEL_N; k <= SWIVEL_N; k++) {
      const sw = (k / SWIVEL_N) * SWIVEL_MAX;
      const c = wristStrain(armSolve(chest, s, wrist, handQ, pole, sw), s) + SWIVEL_REG * sw * sw;
      costs.push([sw, c]);
      cmin = Math.min(cmin, c);
    }
    for (const [sw, c] of costs) {
      const w = Math.exp(-(c - cmin) / SWIVEL_TEMP);
      wsum += w;
      ssum += w * sw;
    }
    const sw = ssum / wsum;
    if (Math.abs(sw) > 1e-4) best = armSolve(chest, s, wrist, handQ, pole, sw);
    used = sw;
  }
  return {
    shoulder: eulerFromQuat(best.qLocal, "XZY"),
    elbow: [-best.flex, best.twist, 0],
    wrist: eulerFromQuat(best.wristQ, "XZY"),
    err: best.err,
    twist: best.twist,
    strain: handQ ? wristStrain(best, s) : 0,
    swivel: used,
  };
};

export type LegIKResult = { hip: Vec3; knee: Vec3; ankle: Vec3; err: number };

/**
 * Leg IK in character space.
 * @param root   root (pelvis) matrix
 * @param ankle  ankle joint target
 * @param footQ  foot frame rotation (character space); rest = facing +Z, flat
 * @param pole   direction the knee should point
 */
export const legIK = (
  root: THREE.Matrix4,
  s: Side,
  ankle: THREE.Vector3,
  footQ: THREE.Quaternion,
  pole: THREE.Vector3,
): LegIKResult => {
  const L1 = RIG.thigh;
  const L2 = RIG.shin;
  const H = sideOff(OFFSETS.hip, s).applyMatrix4(root);
  const D = ankle.clone().sub(H);
  let d = D.length();
  const u = d > 1e-6 ? D.clone().divideScalar(d) : new THREE.Vector3(0, -1, 0);
  d = Math.max(0.12, Math.min(L1 + L2 - 0.0004, d));
  const reached = H.clone().addScaledVector(u, d);
  const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
  const v = perpUnit(pole, u, new THREE.Vector3(0, 0, 1));
  const K = H.clone().addScaledVector(u, a).addScaledVector(v, h);
  const Y = H.clone().sub(K).normalize();
  // the shin bends toward -Z (the knee points +Z): take it from the solved triangle
  const shin = reached.clone().sub(K);
  let Z = shin.addScaledVector(Y, -shin.dot(Y)).negate();
  if (Z.lengthSq() < 1e-8) Z = v.clone();
  Z = perpUnit(Z, Y, v.clone());
  const X = new THREE.Vector3().crossVectors(Y, Z).normalize();
  const qT = quatFromBasis(X, Y, Z);
  const Hv = H.clone().sub(K);
  const Av = reached.clone().sub(K);
  const cosI = Math.max(-1, Math.min(1, Hv.dot(Av) / (Hv.length() * Av.length())));
  const flex = Math.PI - Math.acos(cosI);
  const qS = qT.clone().multiply(_q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), flex));
  const qR = rotOf(root);
  return {
    hip: eulerFromQuat(qR.clone().invert().multiply(qT), "XZY"),
    knee: [flex, 0, 0],
    ankle: eulerFromQuat(qS.clone().invert().multiply(footQ), "XZY"),
    err: reached.distanceTo(ankle),
  };
};

/* ------------------------------------------------------------------ */
/* Hand frames, held props, attachment slots                           */
/* ------------------------------------------------------------------ */

/**
 * Hand-local axes (origin at the wrist joint):
 *   -Y  wrist -> fingertips
 *   +Z  thumb side
 *   palm normal: +X on the RIGHT hand, -X on the LEFT hand (back of the hand is the opposite)
 * In the rest pose both palms face the thighs and both thumbs point forward (+Z).
 */
export const handBasis = (s: Side, fingers: THREE.Vector3, palm: THREE.Vector3) => {
  const Y = fingers.clone().normalize().negate();
  const X = perpUnit(palm.clone().multiplyScalar(SIDE_SIGN[s] === 1 ? -1 : 1), Y, new THREE.Vector3(1, 0, 0));
  const Z = new THREE.Vector3().crossVectors(X, Y).normalize();
  return quatFromBasis(X, Y, Z);
};

/** Point on the handle axis inside a closed fist, hand-local. */
export const FIST_CENTER: Record<Side, Vec3> = { l: [-0.036, -0.083, 0.0], r: [0.036, -0.083, 0.0] };

export type BatGrip = "bat" | "carry";
export type BatHold = {
  /** which hand the bat is parented to */
  hand: Side;
  /** 'bat' = two-handed batting grip position on the handle; 'carry' = one hand near the top of the
   *  handle (running, raising the bat). Both hold the bat the cricket way: thumb and forefinger 'V'
   *  pointing DOWN the handle toward the blade, the handle running diagonally across the palm,
   *  the bat face toward the back of the top hand / the palm of the bottom hand. */
  grip: BatGrip;
  /** diagonal angle of the handle across the palm (rad, default BAT_GRIP_TILT[grip]); chosen per pose by build() */
  tilt?: number;
  /** rotation of the hand around the handle (rad, + = the V moves toward the face's leg-side edge for the top hand); chosen by build() */
  roll?: number;
};

const deg = THREE.MathUtils.degToRad;

/**
 * Diagonal of the handle across the palm: from the heel of the hand on the little-finger side to the
 * middle of the index finger. Batsmen hold it ~40-50 deg off square; build() adapts it per pose within
 * BAT_GRIP_RANGE (and the hand's roll around the handle) to keep the wrists in their natural range.
 */
export const BAT_GRIP_TILT: Record<BatGrip, number> = { bat: deg(42), carry: deg(30) };
export const BAT_GRIP_RANGE = { tilt: [deg(30), deg(58)] as [number, number], roll: deg(24) };

/** Rotation of the bat inside the hand (bat-local -> hand-local). */
export const batGripQuat = (grip: BatGrip, tilt = BAT_GRIP_TILT[grip], roll = 0) => {
  // bat +Y (handle top) -> hand -Z (little-finger side), blade out of the thumb side;
  // bat face (+Z) -> hand +X (right palm / back of the left hand)
  const base = quatFromBasis(new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(1, 0, 0));
  // the handle crosses the palm diagonally: its top end tilts toward the wrist
  const tq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), tilt);
  // the hand's roll around the handle (bat-local Y)
  const rq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), roll);
  return tq.multiply(base).multiply(rq);
};

/** Bat-local height (along the handle) where each hand's fist centre sits. */
export const BAT_HAND_Y = { top: 0.088, bottom: -0.024, carry: 0.07 } as const;

/** Bat transform inside a hand slot: render <Bat position rotation/> as a child of that hand. */
export const batInHand = (
  hand: Side,
  grip: BatGrip,
  role: "top" | "bottom" = hand === "l" ? "top" : "bottom",
  tilt?: number,
  roll?: number,
) => {
  const q = batGripQuat(grip, tilt, roll);
  const yb = grip === "carry" ? BAT_HAND_Y.carry : role === "top" ? BAT_HAND_Y.top : BAT_HAND_Y.bottom;
  const fist = new THREE.Vector3(...FIST_CENTER[hand]);
  const pos = fist.sub(new THREE.Vector3(0, yb, 0).applyQuaternion(q));
  const m = mat(pos, q);
  const e = eulerFromQuat(q, "XYZ");
  return { matrix: m, position: [pos.x, pos.y, pos.z] as Vec3, rotation: e, quaternion: q };
};

export type BallGrip = "seam" | "throw" | "cup" | "keeper" | "palm";
export type BallHold = { hand: Side; grip: BallGrip };

/** Ball centre (hand-local) for each ball grip. Rotation puts the seam upright between index and middle fingers. */
export const ballInHand = (hand: Side, grip: BallGrip) => {
  const sx = hand === "r" ? 1 : -1;
  const p: Record<BallGrip, Vec3> = {
    seam: [0.038 * sx, -0.128, 0.004],
    throw: [0.04 * sx, -0.122, 0.006],
    cup: [0.052 * sx, -0.098, 0.0],
    keeper: [0.07 * sx, -0.11, 0.0],
    palm: [0.05 * sx, -0.085, 0.0],
  };
  return { position: p[grip], rotation: [Math.PI / 2, 0, 0] as Vec3 };
};

export type Slot =
  | "leftHand"
  | "rightHand"
  | "head"
  | "chest"
  | "pelvis"
  | "leftFoot"
  | "rightFoot"
  | "bat"
  | "ball";

/** Extra, optional channels carried with a Pose by the action library. */
export type RigPose = Pose & {
  bat?: BatHold | null;
  ball?: BallHold | null;
  /** per-finger curl override [thumb, index, middle, ring, little] 0..1 */
  lFingers?: [number, number, number, number, number];
  rFingers?: [number, number, number, number, number];
};

/** Character-space matrix of an attachment slot. */
export const slotMatrix = (pose: Pose, slot: Slot, solved?: Solved): THREE.Matrix4 => {
  const m = solved ?? solvePose(pose);
  const rp = pose as RigPose;
  switch (slot) {
    case "leftHand":
      return m.lWrist.clone();
    case "rightHand":
      return m.rWrist.clone();
    case "head":
      return m.head.clone();
    case "chest":
      return m.chest.clone();
    case "pelvis":
      return m.root.clone();
    case "leftFoot":
      return m.lAnkle.clone();
    case "rightFoot":
      return m.rAnkle.clone();
    case "bat": {
      const hold = rp.bat ?? { hand: "l", grip: "bat" };
      const hm = hold.hand === "l" ? m.lWrist : m.rWrist;
      return hm.clone().multiply(batInHand(hold.hand, hold.grip, undefined, hold.tilt, hold.roll).matrix);
    }
    case "ball": {
      const hold = rp.ball ?? { hand: "r", grip: "seam" };
      const hm = hold.hand === "l" ? m.lWrist : m.rWrist;
      const b = ballInHand(hold.hand, hold.grip);
      return hm.clone().multiply(mat(new THREE.Vector3(...b.position), quatFromEuler(b.rotation, "XYZ")));
    }
  }
};

/** Character -> world matrix for a player placed at `pos` rotated by `rotY` about +Y. */
export const playerMatrix = (pos: Vec3, rotY: number) =>
  mat(new THREE.Vector3(...pos), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY));

/** World matrix of a slot. */
export const slotWorldMatrix = (pose: Pose, slot: Slot, playerPos: Vec3, playerRotY: number) =>
  playerMatrix(playerPos, playerRotY).multiply(slotMatrix(pose, slot));

/**
 * World position of `localPoint` expressed in `slot` space, for a player at playerPos / playerRotY.
 * e.g. attachmentWorld(pose, "bat", pos, rotY, BAT_SWEET_SPOT) -> where the ball meets the bat.
 */
export const attachmentWorld = (
  pose: Pose,
  slot: Slot,
  playerPos: Vec3,
  playerRotY: number,
  localPoint: Vec3 = [0, 0, 0],
): Vec3 => {
  const p = new THREE.Vector3(...localPoint).applyMatrix4(slotWorldMatrix(pose, slot, playerPos, playerRotY));
  return [p.x, p.y, p.z];
};

/** World direction of a slot-local direction (e.g. the bat face normal [0,0,1]). */
export const attachmentDir = (pose: Pose, slot: Slot, playerRotY: number, localDir: Vec3): Vec3 => {
  const q = rotOf(slotWorldMatrix(pose, slot, [0, 0, 0], playerRotY));
  const d = new THREE.Vector3(...localDir).applyQuaternion(q);
  return [d.x, d.y, d.z];
};

/**
 * Where a ball of radius r sits when it meets the bat's sweet spot (world space), plus the face normal.
 * Use it to make the incoming ball path arrive exactly at contact and the outgoing path leave from it.
 */
export const batContact = (pose: Pose, playerPos: Vec3, playerRotY: number, r = 0.036) => {
  const n = attachmentDir(pose, "bat", playerRotY, BAT_FACE_NORMAL);
  const spot = attachmentWorld(pose, "bat", playerPos, playerRotY, BAT_SWEET_SPOT);
  const ballCentre: Vec3 = [spot[0] + n[0] * r, spot[1] + n[1] * r, spot[2] + n[2] * r];
  return { spot, normal: n, ballCentre };
};

/* ------------------------------------------------------------------ */
/* Pose blending                                                       */
/* ------------------------------------------------------------------ */

/**
 * Blend only one arm (shoulder, elbow, wrist, grip) of `a` toward `b` (w = 0 -> a, 1 -> b).
 * Arm joints are chest-local, so this is exact when both poses share the trunk.
 */
export const blendArm = <P extends Pose>(a: P, b: Pose, s: Side, w: number): P => {
  const k = Math.max(0, Math.min(1, w));
  if (k <= 0) return a;
  const joints = { ...a.joints };
  for (const j of [`${s}Shoulder`, `${s}Elbow`, `${s}Wrist`] as Joint[]) {
    const qa = quatFromEuler(a.joints[j], ORDER[j]);
    const qb = quatFromEuler(b.joints[j], ORDER[j]);
    joints[j] = eulerFromQuat(qa.slerp(qb, k), ORDER[j]);
  }
  const g = s === "l" ? "lGrip" : "rGrip";
  return { ...a, joints, [g]: a[g] + (b[g] - a[g]) * k };
};

/** Blend two poses (quaternion slerp per joint, lerp root). Extra channels come from the nearer pose. */
export const blendPose = <P extends Pose>(a: P, b: P, w: number): P => {
  const k = Math.max(0, Math.min(1, w));
  if (k <= 0) return a;
  if (k >= 1) return b;
  const joints = {} as Record<Joint, Vec3>;
  for (const j of JOINTS) {
    const qa = quatFromEuler(a.joints[j], ORDER[j]);
    const qb = quatFromEuler(b.joints[j], ORDER[j]);
    joints[j] = eulerFromQuat(qa.slerp(qb, k), ORDER[j]);
  }
  const qa = quatFromEuler(a.rootRot, "YXZ");
  const qb = quatFromEuler(b.rootRot, "YXZ");
  const lerp3 = (x: Vec3, y: Vec3): Vec3 => [x[0] + (y[0] - x[0]) * k, x[1] + (y[1] - x[1]) * k, x[2] + (y[2] - x[2]) * k];
  const near = k < 0.5 ? a : b;
  const ra = a as RigPose;
  const rb = b as RigPose;
  const bat =
    ra.bat && rb.bat && ra.bat.hand === rb.bat.hand && ra.bat.grip === rb.bat.grip
      ? {
          ...ra.bat,
          tilt: (ra.bat.tilt ?? BAT_GRIP_TILT[ra.bat.grip]) * (1 - k) + (rb.bat.tilt ?? BAT_GRIP_TILT[rb.bat.grip]) * k,
          roll: (ra.bat.roll ?? 0) * (1 - k) + (rb.bat.roll ?? 0) * k,
        }
      : (near as RigPose).bat;
  return {
    ...near,
    bat,
    root: lerp3(a.root, b.root),
    rootRot: eulerFromQuat(qa.slerp(qb, k), "YXZ"),
    joints,
    lGrip: a.lGrip + (b.lGrip - a.lGrip) * k,
    rGrip: a.rGrip + (b.rGrip - a.rGrip) * k,
  };
};
