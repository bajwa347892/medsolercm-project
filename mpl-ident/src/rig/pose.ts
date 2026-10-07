/**
 * Authoring layer: describe a body with targets (feet on the ground, hands on a bat,
 * a point to look at) and get a Pose (joint Euler angles) back through the IK in solve.ts.
 * Everything is in CHARACTER SPACE (Y up, facing +Z, +X = character's left).
 */
import * as THREE from "three";
import { JOINTS, type Joint, type Vec3 } from "./types";
import {
  OFFSETS,
  RIG,
  SIDE_SIGN,
  armIK,
  batGripQuat,
  batInHand,
  BAT_HAND_Y,
  BAT_GRIP_RANGE,
  BAT_GRIP_TILT,
  type BallHold,
  type BatGrip,
  clavicleOffset,
  FIST_CENTER,
  handBasis,
  legIK,
  quatFromBasis,
  quatFromEuler,
  eulerFromQuat,
  WRIST_RANGE,
  wristAngles,
  rotOf,
  type RigPose,
  type Side,
  solvePose,
  solveTrunk,
} from "./solve";
import { v3 } from "./anim";

/* ------------------------------------------------------------------ */
/* Feet                                                                */
/* ------------------------------------------------------------------ */

export type FootTarget = { ankle: THREE.Vector3; q: THREE.Quaternion };

/**
 * A foot on (or near) the ground.
 * @param x,z   ground position of the ankle when the foot is flat
 * @param yaw   heading (rad); 0 = toes toward +Z, +yaw turns the toes toward +X
 * @param roll  >0 heel raised (pivot on the ball of the foot), <0 toes raised (pivot on the heel)
 * @param lift  extra height of the whole foot (m)
 * @param bank  roll about the foot's long axis (rad, + = outside edge down for the left foot)
 */
export const plant = (x: number, z: number, yaw = 0, roll = 0, lift = 0, bank = 0): FootTarget => {
  const q0 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const qb = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), bank);
  const ankle0 = new THREE.Vector3(x, RIG.ankleHeight + lift, z);
  const pivotLocal = roll >= 0 ? RIG.ball : RIG.heel;
  const pivot = ankle0.clone().add(pivotLocal.clone().applyQuaternion(q0));
  const q = q0.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), roll)).multiply(qb);
  const ankle = pivot.clone().sub(pivotLocal.clone().applyQuaternion(q));
  return { ankle, q };
};

/** A foot in the air: ankle position + heading/pitch (pitch > 0 = toes down). */
export const airFoot = (ankle: Vec3, yaw = 0, pitch = 0, bank = 0): FootTarget => ({
  ankle: v3(ankle),
  q: new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitch))
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), bank)),
});

/** Sole contact point (ball of the foot) of a foot target, for ground checks. */
export const footBall = (f: FootTarget) => f.ankle.clone().add(RIG.ball.clone().applyQuaternion(f.q));

/* ------------------------------------------------------------------ */
/* Arms                                                                */
/* ------------------------------------------------------------------ */

/** Arm by IK: wrist target + hand orientation + elbow pole (all char space). */
export type ArmIKSpec = {
  wrist: Vec3;
  /** hand frame rotation; or give fingers + palm directions */
  hand?: THREE.Quaternion;
  fingers?: Vec3;
  palm?: Vec3;
  /** direction the elbow points */
  pole: Vec3;
  /** fixed elbow swivel about the shoulder-wrist axis (rad); omit to let the solver choose */
  swivel?: number;
};

/**
 * Arm by aim (FK in disguise): upper-arm direction + elbow pole + elbow flexion.
 * space 'chest' (default) means the vectors are in the chest frame (swing relative to the torso),
 * 'char' means character space.
 */
export type ArmAimSpec = {
  aim: Vec3;
  pole: Vec3;
  /** elbow flexion (rad, 0 = straight) */
  flex: number;
  /** forearm pronation (rad, + = palm turns back/down) */
  pron?: number;
  /** wrist [flexion (+ toward palm), deviation (+ toward little finger)] */
  wflex?: [number, number];
  space?: "chest" | "char";
  /** upper-arm rotation in `space` (overrides aim/pole; set by blends so they never pass through a singular aim) */
  q?: THREE.Quaternion;
};

/** Upper-arm rotation (rest arm hanging along -Y) for an aim direction and an elbow pole, in the same space. */
export const aimQuat = (aim: Vec3, pole: Vec3) => {
  const Y = v3(aim).normalize().negate();
  const Z = v3(pole);
  Z.addScaledVector(Y, -Z.dot(Y));
  if (Z.lengthSq() < 1e-8) Z.set(0, 0, -1).addScaledVector(Y, -Y.z);
  Z.normalize().negate();
  const X = new THREE.Vector3().crossVectors(Y, Z).normalize();
  return quatFromBasis(X, Y, Z);
};

/**
 * Arm by reach: the wrist is placed `dist` from the shoulder joint along `dir` (char space),
 * with an explicit hand frame. Good for straight-arm actions (bowling, throwing, appeals).
 */
export type ArmReachSpec = {
  dir: Vec3;
  /** shoulder -> wrist distance (default nearly straight: 0.552) */
  dist?: number;
  fingers: Vec3;
  palm: Vec3;
  pole: Vec3;
  swivel?: number;
};

export type ArmSpec = ArmIKSpec | ArmAimSpec | ArmReachSpec;

/* ------------------------------------------------------------------ */
/* Bat held in the hands                                               */
/* ------------------------------------------------------------------ */

export type BatSpec = {
  /** bat origin (grip centre) in char space */
  pos: Vec3;
  /** bat rotation (bat-local -> char) */
  q: THREE.Quaternion;
  /** 'both' = right-hander's grip: left hand on top, right hand below */
  hands: "both" | Side;
  grip?: BatGrip;
  lPole?: Vec3;
  rPole?: Vec3;
  /** fixed grips / elbow swivels (else chosen per pose); see stableBuild */
  lGrip?: { tilt: number; roll: number };
  rGrip?: { tilt: number; roll: number };
  lSwivel?: number;
  rSwivel?: number;
  /**
   * 0..1: how strongly both wrists are held inside the human range (WRIST_RANGE, with 15% slack).
   * The bat rides on the top hand, so where the authored bat orientation would need an impossible
   * wrist the BAT gives way instead of the wrist (used through follow-throughs; 0 = exact bat).
   */
  wristLimit?: number;
};

/** Where the wrist and hand must be for the fist to sit at bat-local height yb. */
export const handOnBat = (bat: { pos: Vec3; q: THREE.Quaternion }, s: Side, grip: BatGrip, yb: number, tilt?: number, roll?: number) => {
  const G = batGripQuat(grip, tilt, roll);
  const H = bat.q.clone().multiply(G.clone().invert());
  const onAxis = v3(bat.pos).add(new THREE.Vector3(0, yb, 0).applyQuaternion(bat.q));
  const wrist = onAxis.sub(new THREE.Vector3(...FIST_CENTER[s]).applyQuaternion(H));
  return { wrist, hand: H };
};

/** Inverse: bat transform implied by a hand frame (char space). */
export const batFromHand = (handPos: THREE.Vector3, handQ: THREE.Quaternion, s: Side, grip: BatGrip, tilt?: number, roll?: number) => {
  const b = batInHand(s, grip, undefined, tilt, roll);
  const q = handQ.clone().multiply(b.quaternion);
  const p = new THREE.Vector3(...b.position).applyQuaternion(handQ).add(handPos);
  return { pos: [p.x, p.y, p.z] as Vec3, q };
};

/**
 * Choose how a hand sits on the handle (diagonal tilt across the palm, roll around the handle) so the
 * wrist stays in its natural range for this bat position. Soft-argmin over a small grid: continuous
 * in time, close to the best grip, and biased toward the textbook grip (BAT_GRIP_TILT, roll 0).
 */
export const gripFor = (
  chest: THREE.Matrix4,
  s: Side,
  bat: { pos: Vec3; q: THREE.Quaternion },
  grip: BatGrip,
  yb: number,
  pole: Vec3,
) => {
  const t0 = BAT_GRIP_TILT[grip];
  const [tl, th] = BAT_GRIP_RANGE.tilt;
  const rr = BAT_GRIP_RANGE.roll;
  const cs: [number, number, number][] = [];
  let cmin = Infinity;
  for (let i = 0; i <= 6; i++) {
    const tilt = tl + ((th - tl) * i) / 6;
    for (let j = -2; j <= 2; j++) {
      const roll = (rr * j) / 2;
      const h = handOnBat(bat, s, grip, yb, tilt, roll);
      const r = armIK(chest, s, h.wrist, h.hand, v3(pole), { swivelN: 4 });
      const c = r.strain + 6 * r.err * r.err + 0.05 * ((tilt - t0) ** 2 + roll * roll);
      cs.push([tilt, roll, c]);
      cmin = Math.min(cmin, c);
    }
  }
  let ws = 0;
  let ts = 0;
  let rs = 0;
  for (const [tilt, roll, c] of cs) {
    const w = Math.exp(-(c - cmin) / 0.01);
    ws += w;
    ts += w * tilt;
    rs += w * roll;
  }
  return { tilt: ts / ws, roll: rs / ws };
};

/* ------------------------------------------------------------------ */
/* Whole body                                                          */
/* ------------------------------------------------------------------ */

export type BodySpec = {
  /** pelvis position (char space) */
  root: Vec3;
  /** pelvis rotation [pitch fwd, yaw left, roll right] Euler YXZ */
  rootRot: Vec3;
  /** lower trunk [bend fwd, twist left, lean right] relative to the pelvis */
  spine?: Vec3;
  /** upper trunk relative to the spine */
  chest?: Vec3;
  neck?: Vec3;
  head?: Vec3;
  /** char-space point the eyes look at (overrides neck/head) */
  look?: Vec3;
  /** head roll added to the look (rad, + = tilt right) */
  lookRoll?: number;
  /** 0..1 how much of the look the head takes (rest from the neck). Default 0.55. */
  lookHead?: number;
  lFoot: FootTarget;
  rFoot: FootTarget;
  /** knee pole directions (default: along the foot heading) */
  lKnee?: Vec3;
  rKnee?: Vec3;
  lArm?: ArmSpec;
  rArm?: ArmSpec;
  lGrip?: number;
  rGrip?: number;
  bat?: BatSpec | null;
  /** bat hold without IK (bat simply follows that hand) */
  batHold?: { hand: Side; grip: BatGrip } | null;
  ball?: BallHold | null;
  lFingers?: [number, number, number, number, number];
  rFingers?: [number, number, number, number, number];
};

const zero = (): Vec3 => [0, 0, 0];

const isAim = (a: ArmSpec): a is ArmAimSpec => (a as ArmAimSpec).aim !== undefined;
const isReach = (a: ArmSpec): a is ArmReachSpec => (a as ArmReachSpec).dir !== undefined;
const isIK = (a: ArmSpec): a is ArmIKSpec => !isAim(a) && !isReach(a);

const DEFAULT_ARM = (s: Side): ArmAimSpec => ({
  aim: [0.12 * SIDE_SIGN[s], -1, 0.02],
  pole: [0.2 * SIDE_SIGN[s], 0, -1],
  flex: 0.25,
  pron: 0,
});

/** Look rotation that keeps the eyes level (no roll) and faces `dir`. */
const lookQuat = (dir: THREE.Vector3, roll = 0) => {
  const Z = dir.clone().normalize();
  const up = new THREE.Vector3(0, 1, 0);
  let X = new THREE.Vector3().crossVectors(up, Z);
  if (X.lengthSq() < 1e-8) X = new THREE.Vector3(1, 0, 0);
  X.normalize();
  const Y = new THREE.Vector3().crossVectors(Z, X).normalize();
  const q = quatFromBasis(X, Y, Z);
  if (roll) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll));
  return q;
};

/** What the solver chose for an IK arm (elbow swivel, bat grip) and the wrist strain left (rad^2). */
export type ArmChoice = { swivel: number; tilt: number; roll: number; strain: number; err: number };
export type BuiltPose = RigPose & {
  ikErr: number;
  ikErrs?: Record<string, number>;
  /** per IK arm: the solver's choices (used by stableBuild) */
  armSel?: Partial<Record<Side, ArmChoice>>;
};

/** Solve a BodySpec into a Pose. */
export const build = (spec: BodySpec): BuiltPose => {
  const joints = Object.fromEntries(JOINTS.map((j) => [j, zero()])) as Record<Joint, Vec3>;
  joints.spine = spec.spine ?? zero();
  joints.chest = spec.chest ?? zero();
  joints.neck = spec.neck ?? zero();
  joints.head = spec.head ?? zero();
  const pose: BuiltPose = {
    root: spec.root,
    rootRot: spec.rootRot,
    joints,
    lGrip: spec.lGrip ?? 0.25,
    rGrip: spec.rGrip ?? 0.25,
    bat: null,
    ball: spec.ball ?? null,
    lFingers: spec.lFingers,
    rFingers: spec.rFingers,
    ikErr: 0,
    ikErrs: {},
  };
  let trunk = solveTrunk(pose);

  // head look-at (eyes level), split between neck and head
  if (spec.look) {
    const headPos = new THREE.Vector3().setFromMatrixPosition(trunk.head);
    const eye = headPos.clone().add(new THREE.Vector3(0, 0.1, 0.08).applyQuaternion(rotOf(trunk.head)));
    const dir = v3(spec.look).sub(eye);
    const qWorld = lookQuat(dir, spec.lookRoll ?? 0);
    const qChest = rotOf(trunk.chest);
    const rel = qChest.clone().invert().multiply(qWorld);
    const kHead = spec.lookHead ?? 0.55;
    const qNeck = new THREE.Quaternion().slerp(rel, 1 - kHead);
    const qHead = qNeck.clone().invert().multiply(rel);
    joints.neck = eulerFromQuat(qNeck, "YXZ");
    joints.head = eulerFromQuat(qHead, "YXZ");
    trunk = solveTrunk(pose);
  }

  // legs
  for (const s of ["l", "r"] as Side[]) {
    const f = s === "l" ? spec.lFoot : spec.rFoot;
    const poleIn = s === "l" ? spec.lKnee : spec.rKnee;
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(f.q);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1);
    fwd.normalize();
    const pole = poleIn ? v3(poleIn) : fwd.add(new THREE.Vector3(0.12 * SIDE_SIGN[s], 0.05, 0)).normalize();
    const r = legIK(trunk.root, s, f.ankle, f.q, pole);
    // feet near the ground must reach exactly; airborne feet may be pulled in by the IK
    if (pose.ikErrs) pose.ikErrs[f.ankle.y < 0.2 ? `${s}Leg` : `${s}LegAir`] = r.err;
    joints[`${s}Hip` as Joint] = r.hip;
    joints[`${s}Knee` as Joint] = r.knee;
    joints[`${s}Ankle` as Joint] = r.ankle;
    if (f.ankle.y < 0.2) pose.ikErr = Math.max(pose.ikErr, r.err);
  }

  // arms (bat grip overrides)
  const arms: Record<Side, ArmSpec> = {
    l: spec.lArm ?? DEFAULT_ARM("l"),
    r: spec.rArm ?? DEFAULT_ARM("r"),
  };
  const lGripSel = { tilt: BAT_GRIP_TILT.bat, roll: 0 };
  const gripSel: Partial<Record<Side, { tilt: number; roll: number }>> = {};
  if (spec.bat) {
    const grip = spec.bat.grip ?? "bat";
    const bat = spec.bat;
    const mk = (s: Side, yb: number, pole: Vec3): ArmIKSpec => {
      const g = (s === "l" ? bat.lGrip : bat.rGrip) ?? gripFor(trunk.chest, s, bat, grip, yb, pole);
      const h = handOnBat(bat, s, grip, yb, g.tilt, g.roll);
      if (s === "l") Object.assign(lGripSel, g);
      gripSel[s] = { tilt: g.tilt, roll: g.roll };
      return { wrist: [h.wrist.x, h.wrist.y, h.wrist.z], hand: h.hand, pole, swivel: s === "l" ? bat.lSwivel : bat.rSwivel };
    };
    if (bat.hands === "both") {
      arms.l = mk("l", BAT_HAND_Y.top, bat.lPole ?? [0.3, -0.2, 1]);
      arms.r = { wrist: [0, 0, 0], pole: bat.rPole ?? [-0.3, -0.5, -1] };
      pose.bat = { hand: "l", grip: "bat", tilt: lGripSel.tilt, roll: lGripSel.roll };
    } else {
      const s = bat.hands;
      const yb = grip === "carry" ? BAT_HAND_Y.carry : s === "l" ? BAT_HAND_Y.top : BAT_HAND_Y.bottom;
      const pl = (s === "l" ? bat.lPole : bat.rPole) ?? [SIDE_SIGN[s] * 0.5, -0.3, -1];
      const g = (s === "l" ? bat.lGrip : bat.rGrip) ?? gripFor(trunk.chest, s, bat, grip, yb, pl);
      const h = handOnBat(bat, s, grip, yb, g.tilt, g.roll);
      gripSel[s] = { tilt: g.tilt, roll: g.roll };
      arms[s] = { wrist: [h.wrist.x, h.wrist.y, h.wrist.z], hand: h.hand, pole: pl, swivel: s === "l" ? bat.lSwivel : bat.rSwivel };
      pose.bat = { hand: s, grip, tilt: g.tilt, roll: g.roll };
    }
  } else if (spec.batHold) {
    pose.bat = spec.batHold;
  }

  const qChest = rotOf(trunk.chest);
  for (const s of ["l", "r"] as Side[]) {
    let a = arms[s];
    if (s === "r" && spec.bat && spec.bat.hands === "both") {
      // the bottom hand grips the bat where the (solved) top hand actually holds it
      const lw = solvePose(pose).lWrist;
      const bm = lw.clone().multiply(batInHand("l", "bat", "top", lGripSel.tilt, lGripSel.roll).matrix);
      const bp = new THREE.Vector3().setFromMatrixPosition(bm);
      const actual = { pos: [bp.x, bp.y, bp.z] as Vec3, q: rotOf(bm) };
      const rPole = (arms.r as ArmIKSpec).pole;
      const g = spec.bat.rGrip ?? gripFor(trunk.chest, "r", actual, "bat", BAT_HAND_Y.bottom, rPole);
      gripSel.r = { tilt: g.tilt, roll: g.roll };
      const h = handOnBat(actual, "r", "bat", BAT_HAND_Y.bottom, g.tilt, g.roll);
      a = { wrist: [h.wrist.x, h.wrist.y, h.wrist.z], hand: h.hand, pole: rPole, swivel: spec.bat.rSwivel };
    }
    if (isReach(a)) {
      // shoulder position including the clavicle shift for this arm direction (two passes)
      const d = v3(a.dir).normalize();
      const sh = shoulderWorld(trunk.chest, s, d);
      const w = sh.clone().addScaledVector(d, a.dist ?? 0.552);
      a = { wrist: [w.x, w.y, w.z], fingers: a.fingers, palm: a.palm, pole: a.pole, swivel: a.swivel };
    }
    if (isIK(a)) {
      const hq = a.hand ?? (a.fingers && a.palm ? handBasis(s, v3(a.fingers), v3(a.palm)) : null);
      const r = armIK(trunk.chest, s, v3(a.wrist), hq, v3(a.pole), { swivel: a.swivel });
      if (spec.bat?.wristLimit && holdsBat(spec, s)) r.wrist = limitWrist(r.wrist, s, spec.bat.wristLimit);
      if (pose.ikErrs) pose.ikErrs[`${s}Arm`] = r.err;
      if (hq) {
        const g = gripSel[s] ?? { tilt: 0, roll: 0 };
        (pose.armSel ??= {})[s] = { swivel: r.swivel, tilt: g.tilt, roll: g.roll, strain: r.strain, err: r.err };
      }
      joints[`${s}Shoulder` as Joint] = r.shoulder;
      joints[`${s}Elbow` as Joint] = r.elbow;
      joints[`${s}Wrist` as Joint] = r.wrist;
      pose.ikErr = Math.max(pose.ikErr, r.err);
    } else {
      const qS = a.q ?? aimQuat(a.aim, a.pole);
      const qU = a.space === "char" ? qS.clone() : qChest.clone().multiply(qS);
      const qL = qChest.clone().invert().multiply(qU);
      const sg = SIDE_SIGN[s];
      joints[`${s}Shoulder` as Joint] = eulerFromQuat(qL, "XZY");
      joints[`${s}Elbow` as Joint] = [-a.flex, -(a.pron ?? 0) * sg, 0];
      const w = a.wflex ?? [0, 0];
      // wrist Euler XZY: x = deviation (+ little-finger side), z = flexion toward +X (right palm / left back)
      joints[`${s}Wrist` as Joint] = [w[1], 0, w[0] * -sg];
    }
  }
  return pose;
};

/* ------------------------------------------------------------------ */
/* Temporal stabilisation of the arm solutions                         */
/* ------------------------------------------------------------------ */

type Choice = { swivel: number; tilt: number; roll: number };
type StableTrack = { t0: number; dt: number; l: Choice[]; r: Choice[] };
const stableCache = new Map<string, StableTrack>();

/** Apply chosen swivels / grips to the IK arms of a spec. */
const applyChoice = (spec: BodySpec, s: Side, c: Choice): BodySpec => {
  if (spec.bat && (spec.bat.hands === "both" || spec.bat.hands === s)) {
    const bat: BatSpec = { ...spec.bat };
    if (s === "l") {
      bat.lGrip = { tilt: c.tilt, roll: c.roll };
      bat.lSwivel = c.swivel;
    } else {
      bat.rGrip = { tilt: c.tilt, roll: c.roll };
      bat.rSwivel = c.swivel;
    }
    return { ...spec, bat };
  }
  const a = s === "l" ? spec.lArm : spec.rArm;
  if (!a || isAim(a)) return spec;
  return s === "l" ? { ...spec, lArm: { ...a, swivel: c.swivel } } : { ...spec, rArm: { ...a, swivel: c.swivel } };
};

const holdsBat = (spec: BodySpec, s: Side) => !!spec.bat && (spec.bat.hands === "both" || spec.bat.hands === s);

/** Arms whose elbow swivel is free (IK with a hand orientation, or holding the bat). */
const freeArm = (spec: BodySpec, s: Side) => {
  if (holdsBat(spec, s)) return true;
  const a = s === "l" ? spec.lArm : spec.rArm;
  if (!a || isAim(a)) return false;
  if (isReach(a)) return true;
  const k = a as ArmIKSpec;
  return !!(k.hand || (k.fingers && k.palm));
};

const choiceCost = (spec: BodySpec, s: Side, c: Choice, prev: Choice | null, grip: BatGrip) => {
  const p = build(applyChoice(spec, s, c));
  const sel = p.armSel?.[s];
  if (!sel) return 0;
  let k = sel.strain + 8 * sel.err * sel.err + 0.08 * c.swivel * c.swivel;
  if (holdsBat(spec, s)) k += 0.05 * ((c.tilt - BAT_GRIP_TILT[grip]) ** 2 + c.roll * c.roll);
  if (prev) k += 2.5 * ((c.swivel - prev.swivel) ** 2 + (c.tilt - prev.tilt) ** 2 + (c.roll - prev.roll) ** 2);
  return k;
};

const clampChoice = (c: Choice): Choice => ({
  swivel: Math.max(-2.4, Math.min(2.4, c.swivel)),
  tilt: Math.max(BAT_GRIP_RANGE.tilt[0], Math.min(BAT_GRIP_RANGE.tilt[1], c.tilt)),
  roll: Math.max(-BAT_GRIP_RANGE.roll, Math.min(BAT_GRIP_RANGE.roll, c.roll)),
});

/** Local search for one arm at one anchor, starting from the previous anchor's choice. */
const searchArm = (spec: BodySpec, s: Side, start: Choice, prev: Choice | null): Choice => {
  const grip = spec.bat?.grip ?? "bat";
  const keys: (keyof Choice)[] = holdsBat(spec, s) ? ["swivel", "tilt", "roll"] : ["swivel"];
  let best = clampChoice(start);
  let bc = choiceCost(spec, s, best, prev, grip);
  for (let round = 0; round < 3; round++) {
    for (const key of keys) {
      for (const d of [-0.3, -0.12, -0.04, 0.04, 0.12, 0.3]) {
        const c = clampChoice({ ...best, [key]: best[key] + d });
        const v = choiceCost(spec, s, c, prev, grip);
        if (v < bc) {
          bc = v;
          best = c;
        }
      }
    }
  }
  return best;
};

/**
 * Build with temporally coherent arm solutions. The elbow swivels and bat grips are optimised at
 * anchors every `dt` over [t0, t1] (each anchor starts from the previous one, so the solution
 * tracks one family of poses instead of jumping between equally good ones), memoised under `key`,
 * and interpolated (Catmull-Rom) in between. Pure: the same inputs always give the same pose.
 */
export const stableBuild = (key: string, specAt: (t: number) => BodySpec, t: number, t0: number, t1: number, dt = 1 / 30): BuiltPose => {
  let tr = stableCache.get(key);
  if (!tr) {
    const n = Math.max(2, Math.ceil((t1 - t0) / dt) + 1);
    const track: StableTrack = { t0, dt: (t1 - t0) / (n - 1), l: [], r: [] };
    let pl: Choice | null = null;
    let pr: Choice | null = null;
    for (let i = 0; i < n; i++) {
      const spec = specAt(t0 + i * track.dt);
      const g0 = BAT_GRIP_TILT[spec.bat?.grip ?? "bat"];
      // the first anchor starts from the per-pose solver's own choice
      const free = pl && pr ? {} : (build(spec).armSel ?? {});
      const init = (s: Side, prev: Choice | null): Choice =>
        prev ?? { swivel: free[s]?.swivel ?? 0, tilt: free[s]?.tilt || g0, roll: free[s]?.roll ?? 0 };
      let cl = init("l", pl);
      let cr = init("r", pr);
      // hold the other arm at its current choice while searching one (no nested per-pose searches)
      let sp = freeArm(spec, "r") ? applyChoice(spec, "r", cr) : spec;
      if (freeArm(spec, "l")) {
        cl = searchArm(sp, "l", cl, pl);
        sp = applyChoice(sp, "l", cl);
      }
      if (freeArm(spec, "r")) cr = searchArm(sp, "r", cr, pr);
      track.l.push(cl);
      track.r.push(cr);
      pl = cl;
      pr = cr;
    }
    tr = track;
    stableCache.set(key, tr);
    if (stableCache.size > 64) stableCache.delete(stableCache.keys().next().value as string);
  }
  const u = Math.max(0, Math.min(tr.l.length - 1 - 1e-9, (t - tr.t0) / tr.dt));
  const i = Math.floor(u);
  const f = u - i;
  const pick = (arr: Choice[]) => {
    const a = arr[Math.max(0, i - 1)];
    const b = arr[i];
    const c = arr[Math.min(arr.length - 1, i + 1)];
    const d = arr[Math.min(arr.length - 1, i + 2)];
    const cr = (p0: number, p1: number, p2: number, p3: number) =>
      0.5 * (2 * p1 + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f);
    return {
      swivel: cr(a.swivel, b.swivel, c.swivel, d.swivel),
      tilt: cr(a.tilt, b.tilt, c.tilt, d.tilt),
      roll: cr(a.roll, b.roll, c.roll, d.roll),
    };
  };
  let spec = specAt(t);
  if (freeArm(spec, "l")) spec = applyChoice(spec, "l", clampChoice(pick(tr.l)));
  if (freeArm(spec, "r")) spec = applyChoice(spec, "r", clampChoice(pick(tr.r)));
  return build(spec);
};

/** Hold a wrist (XZY Euler, local) inside the human range; w blends from the input (0) to the clamped wrist (1). */
export const limitWrist = (e: Vec3, s: Side, w: number, slack = 1.15): Vec3 => {
  if (w <= 0) return e;
  const q = quatFromEuler(e, "XZY");
  const a = wristAngles(q, s);
  const d2r = Math.PI / 180;
  const dev = Math.max(-WRIST_RANGE.radial * slack * d2r, Math.min(WRIST_RANGE.ulnar * slack * d2r, a.dev));
  const flex = Math.max(-WRIST_RANGE.ext * slack * d2r, Math.min(WRIST_RANGE.flex * slack * d2r, a.flex));
  if (dev === a.dev && flex === a.flex) return e;
  const v = new THREE.Vector3(dev, 0, flex * (s === "r" ? 1 : -1));
  const ang = v.length();
  const sw = ang > 1e-9 ? new THREE.Quaternion().setFromAxisAngle(v.normalize(), ang) : new THREE.Quaternion();
  const q2 = sw.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a.twist));
  return eulerFromQuat(q.slerp(q2, Math.min(1, w)), "XZY");
};

/** Shoulder joint position (char space) for an upper arm pointing along d (char space). */
const shoulderWorld = (chest: THREE.Matrix4, s: Side, d: THREE.Vector3) => {
  const qC = rotOf(chest);
  const dl = d.clone().applyQuaternion(qC.clone().invert());
  // rotation taking rest (0,-1,0) to dl, enough to drive the clavicle model
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dl);
  const off = new THREE.Vector3(OFFSETS.shoulder.x * SIDE_SIGN[s], OFFSETS.shoulder.y, OFFSETS.shoulder.z).add(clavicleOffset(q, s));
  return off.applyMatrix4(chest);
};

/** Convenience: char-space hand frame for "fingers along f, palm facing p". */
export const handQ = (s: Side, fingers: Vec3, palm: Vec3) => handBasis(s, v3(fingers), v3(palm));
