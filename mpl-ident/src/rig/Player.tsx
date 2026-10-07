/**
 * <Player/>: a ~1.83 m athletic cricketer driven by a Pose (see solve.ts / README.md).
 *
 *   <Player pose={batDrive(t)} role="batsman" kit="graphite" position={[0,0,-8.84]} rotationY={0} bat />
 *
 * Skinned body (shirt, trousers, skin) on a flat bone list written from solvePose() every render,
 * rigid head / hands / shoes / gear in bone-local groups. Pure function of props.
 */
import React, { useMemo } from "react";
import * as THREE from "three";
import { Ball, Bat } from "../world/Props";
import type { Pose, Role, Vec3 } from "./types";
import {
  BONES,
  RIG,
  type RigPose,
  type Solved,
  ballInHand,
  batInHand,
  restSolved,
  solvePose,
} from "./solve";
import {
  type Detail,
  EAR_POS,
  EYE_POS,
  EYE_R,
  FINGERS,
  GRILLE_BARS,
  THUMB,
  getBodyGeoms,
  getCapGeoms,
  getEarGeom,
  getHeadGeom,
  getHelmetGeoms,
  getPadGeom,
  getPalmGeom,
  getPhalanx,
  getShoeGeoms,
  TOE_PIVOT,
} from "./body";
import {
  type KitName,
  SKIN_TONES,
  capMaterial,
  eyeMaterial,
  gloveCuffMaterial,
  gloveMaterial,
  grilleMaterial,
  helmetMaterial,
  neckGuardMaterial,
  padMaterial,
  shirtMaterial,
  shoeMaterial,
  skinMaterial,
  soleMaterial,
  trouserMaterial,
  webbingMaterial,
} from "./kit";

export type Headwear = "auto" | "helmet" | "cap" | "none";

export type PlayerProps = {
  pose: Pose;
  /** gear by role: batsman = helmet + pads + batting gloves; keeper = helmet + keeper pads + keeper gloves */
  role?: Role;
  /** "teal" = fielding side, "graphite" = batting side */
  kit?: KitName;
  position?: Vec3;
  rotationY?: number;
  /** React nodes rendered in right-hand space (origin at the wrist; -Y to the fingertips, +Z thumb side, palm +X) */
  rightHand?: React.ReactNode;
  /** React nodes rendered in left-hand space (origin at the wrist; -Y to the fingertips, +Z thumb side, palm -X) */
  leftHand?: React.ReactNode;
  /** render the bat in the hand the pose says (pose.bat), default true for batsmen */
  bat?: boolean;
  /** render the ball in the hand the pose says (pose.ball) */
  ball?: boolean;
  /** ball spin (Euler) when rendered in the hand */
  ballSpin?: Vec3;
  headwear?: Headwear;
  /** per-player variation: skin tone, hair */
  seed?: number;
  detail?: Detail;
  castShadow?: boolean;
  receiveShadow?: boolean;
};

/* ------------------------------------------------------------------ */
/* Shared small geometries (built once per page)                       */
/* ------------------------------------------------------------------ */

const geoCache = new Map<string, THREE.BufferGeometry>();
const cachedGeo = (key: string, make: () => THREE.BufferGeometry) => {
  let g = geoCache.get(key);
  if (!g) {
    g = make();
    geoCache.set(key, g);
  }
  return g;
};

/* ------------------------------------------------------------------ */
/* Hand rig                                                            */
/* ------------------------------------------------------------------ */

type FingerRig = { mcp: THREE.Group; pip: THREE.Group; dip: THREE.Group; splay: number };
type ThumbRig = { cmc: THREE.Group; mp: THREE.Group; ip: THREE.Group };
type HandRig = { root: THREE.Group; fingers: FingerRig[]; thumb: ThumbRig; cuff: THREE.Mesh | null };

const basisQ = (dir: THREE.Vector3, curl: THREE.Vector3) => {
  const Y = dir.clone().normalize().negate();
  const X = curl.clone().addScaledVector(Y, -curl.dot(Y)).normalize();
  const Z = new THREE.Vector3().crossVectors(X, Y).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
};
const THUMB_REST = basisQ(new THREE.Vector3(0.36, -0.68, 0.64), new THREE.Vector3(0.6, 0.1, -0.79));
const THUMB_GRIP = basisQ(new THREE.Vector3(0.62, -0.72, 0.3), new THREE.Vector3(0.6, 0.45, -0.66));

const makeHand = (detail: Detail, glove: 0 | 1 | 2, skin: THREE.Material, shadow: boolean): HandRig => {
  const root = new THREE.Group();
  const gm = glove ? gloveMaterial(glove === 2) : skin;
  const rs = glove === 2 ? 1.7 : glove === 1 ? 1.42 : 1;
  let cuffMesh: THREE.Mesh | null = null;
  const palm = new THREE.Mesh(getPalmGeom(detail, glove), gm);
  palm.castShadow = shadow;
  root.add(palm);
  const fingers: FingerRig[] = FINGERS.map((f) => {
    const mcp = new THREE.Group();
    mcp.position.set(...f.base);
    mcp.rotation.order = "XYZ";
    const m1 = new THREE.Mesh(getPhalanx(f.len[0], f.rad[0] * rs, f.rad[1] * rs, detail, glove), gm);
    const pip = new THREE.Group();
    pip.position.set(0, -f.len[0], 0);
    const m2 = new THREE.Mesh(getPhalanx(f.len[1], f.rad[1] * rs, f.rad[2] * rs, detail, glove), gm);
    const dip = new THREE.Group();
    dip.position.set(0, -f.len[1], 0);
    const m3 = new THREE.Mesh(getPhalanx(f.len[2], f.rad[2] * rs, f.rad[2] * rs * 0.88, detail, glove), gm);
    for (const m of [m1, m2, m3]) m.castShadow = shadow;
    mcp.add(m1, pip);
    pip.add(m2, dip);
    dip.add(m3);
    root.add(mcp);
    return { mcp, pip, dip, splay: f.splay };
  });
  const cmc = new THREE.Group();
  cmc.position.set(...THUMB.base);
  const t1 = new THREE.Mesh(getPhalanx(THUMB.len[0], THUMB.rad[0] * rs, THUMB.rad[1] * rs, detail, glove), gm);
  const mp = new THREE.Group();
  mp.position.set(0, -THUMB.len[0], 0);
  const t2 = new THREE.Mesh(getPhalanx(THUMB.len[1], THUMB.rad[1] * rs, THUMB.rad[2] * rs, detail, glove), gm);
  const ip = new THREE.Group();
  ip.position.set(0, -THUMB.len[1], 0);
  const t3 = new THREE.Mesh(getPhalanx(THUMB.len[2], THUMB.rad[2] * rs, THUMB.rad[2] * rs * 0.85, detail, glove), gm);
  for (const m of [t1, t2, t3]) m.castShadow = shadow;
  cmc.add(t1, mp);
  mp.add(t2, ip);
  ip.add(t3);
  root.add(cmc);
  if (glove) {
    // padded cuff over the wrist: a closed, rounded cylinder
    const k = glove === 2 ? 1.18 : 1;
    const prof = [
      [0.0, -0.022],
      [0.024, -0.022],
      [0.03, -0.016],
      [0.032, 0.01],
      [0.031, 0.055],
      [0.027, 0.066],
      [0.0, 0.068],
    ].map(([r, y]) => new THREE.Vector2(r * k, y * k));
    // the cuff rides on the FOREARM (placed by updateRig), so a bent wrist bends inside the glove
    // instead of swinging a rigid cuff off the arm
    cuffMesh = new THREE.Mesh(
      cachedGeo(`cuff${glove}`, () => new THREE.LatheGeometry(prof, 20)),
      glove === 2 ? gloveMaterial(true) : gloveCuffMaterial(),
    );
    cuffMesh.scale.set(0.82, 1, 1.0);
    cuffMesh.position.set(0.0, 0.004, 0.0);
    cuffMesh.castShadow = shadow;
    if (glove === 2) {
      // webbing between thumb and index finger (cricket keeper glove, not a mitt)
      const web = cachedGeo("web", () => {
        const g = new THREE.BufferGeometry();
        const v = [0.004, -0.03, 0.04, 0.004, -0.095, 0.036, 0.016, -0.1, 0.07, 0.014, -0.06, 0.075];
        g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
        g.setIndex([0, 1, 2, 0, 2, 3]);
        g.computeVertexNormals();
        return g;
      });
      const wm = new THREE.Mesh(web, webbingMaterial());
      root.add(wm);
    }
  }
  return { root, fingers, thumb: { cmc, mp, ip }, cuff: cuffMesh };
};

const setHandCurl = (h: HandRig, grip: number, per?: [number, number, number, number, number]) => {
  h.fingers.forEach((f, i) => {
    const g = Math.max(0, Math.min(1, per ? per[i + 1] : grip));
    f.mcp.rotation.set(f.splay * (1 - g * 0.85), 0, 0.12 + g * 1.38);
    f.pip.rotation.set(0, 0, 0.16 + g * 1.5);
    f.dip.rotation.set(0, 0, 0.08 + g * 1.0);
  });
  const gt = Math.max(0, Math.min(1, per ? per[0] : grip));
  h.thumb.cmc.quaternion.copy(THUMB_REST).slerp(THUMB_GRIP, gt);
  h.thumb.mp.rotation.set(0, 0, 0.1 + gt * 0.55);
  h.thumb.ip.rotation.set(0, 0, 0.08 + gt * 0.7);
};

/* ------------------------------------------------------------------ */
/* Rig assembly                                                        */
/* ------------------------------------------------------------------ */

type Rig = {
  bones: THREE.Bone[];
  skeletonRoot: THREE.Group;
  meshes: THREE.Object3D[];
  head: THREE.Group;
  lHand: THREE.Group;
  rHand: THREE.Group;
  lFoot: THREE.Group;
  rFoot: THREE.Group;
  lKnee: THREE.Group;
  rKnee: THREE.Group;
  hands: { l: HandRig; r: HandRig };
  /** glove cuffs on the forearm ends [left, right] */
  cuffs: THREE.Group[];
  /** toe-box hinges [left, right] */
  toes: THREE.Group[];
};

const makeRig = (
  detail: Detail,
  kit: KitName,
  role: Role,
  tone: string,
  hairStyle: number,
  headwear: Exclude<Headwear, "auto">,
  shadow: boolean,
  receive: boolean,
): Rig => {
  const rest = restSolved();
  const bones = BONES.map((b) => {
    const bone = new THREE.Bone();
    bone.name = b;
    rest[b].decompose(bone.position, bone.quaternion, bone.scale);
    return bone;
  });
  const skeletonRoot = new THREE.Group();
  bones.forEach((b) => skeletonRoot.add(b));
  const inverses = BONES.map((b) => rest[b].clone().invert());
  const skeleton = new THREE.Skeleton(bones, inverses);
  const geo = getBodyGeoms(detail);
  const skinMat = skinMaterial(tone);
  const mk = (g: THREE.BufferGeometry, m: THREE.Material) => {
    const s = new THREE.SkinnedMesh(g, m);
    s.bind(skeleton, new THREE.Matrix4());
    s.frustumCulled = false;
    s.castShadow = shadow;
    s.receiveShadow = receive;
    return s;
  };
  const meshes: THREE.Object3D[] = [
    mk(geo.shirt, shirtMaterial(kit)),
    mk(geo.trousers, trouserMaterial(kit)),
    mk(geo.skin, skinMat),
  ];

  // head
  const head = new THREE.Group();
  const headMesh = new THREE.Mesh(getHeadGeom(detail, hairStyle, true), skinMat);
  headMesh.castShadow = shadow;
  headMesh.receiveShadow = receive;
  head.add(headMesh);
  for (const sx of [1, -1]) {
    const ear = new THREE.Mesh(getEarGeom(), skinMat);
    ear.position.set(EAR_POS[0] * sx, EAR_POS[1], EAR_POS[2]);
    ear.rotation.set(0, sx * 0.25, sx * -0.08);
    head.add(ear);
  }
  if (detail !== "far") {
    const eyeGeo = cachedGeo("eye", () => new THREE.SphereGeometry(EYE_R, 16, 12));
    for (const p of EYE_POS) {
      const e = new THREE.Mesh(eyeGeo, eyeMaterial());
      e.position.set(...p);
      head.add(e);
    }
  }
  if (headwear === "cap") {
    const cg = getCapGeoms(detail);
    const crown = new THREE.Mesh(cg.crown, capMaterial());
    const peak = new THREE.Mesh(cg.peak, capMaterial());
    crown.castShadow = peak.castShadow = shadow;
    head.add(crown, peak);
  }
  if (headwear === "helmet") {
    const hg = getHelmetGeoms(detail);
    const shell = new THREE.Mesh(hg.shell, helmetMaterial());
    const peak = new THREE.Mesh(hg.peak, helmetMaterial());
    const guard = new THREE.Mesh(hg.guard, neckGuardMaterial());
    shell.castShadow = peak.castShadow = guard.castShadow = shadow;
    head.add(shell, peak, guard);
    const gm = grilleMaterial();
    const barR = 0.0032;
    for (const [a, b] of GRILLE_BARS) {
      const len = a.distanceTo(b);
      const bar = new THREE.Mesh(
        cachedGeo(`bar${len.toFixed(4)}`, () => new THREE.CylinderGeometry(barR, barR, len, 8, 1)),
        gm,
      );
      bar.position.copy(a).add(b).multiplyScalar(0.5);
      bar.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      head.add(bar);
    }
  }

  // hands
  const glove: 0 | 1 | 2 = role === "keeper" ? 2 : role === "batsman" ? 1 : 0;
  const rHandRig = makeHand(detail, glove, skinMat, shadow);
  const lHandRig = makeHand(detail, glove, skinMat, shadow);
  const rHand = new THREE.Group();
  rHand.add(rHandRig.root);
  const lHand = new THREE.Group();
  const lMirror = new THREE.Group();
  lMirror.scale.set(-1, 1, 1);
  lMirror.add(lHandRig.root);
  lHand.add(lMirror);
  const cuffs = [new THREE.Group(), new THREE.Group()];
  if (lHandRig.cuff) cuffs[0].add(lHandRig.cuff);
  if (rHandRig.cuff) cuffs[1].add(rHandRig.cuff);

  // feet: rear shoe + hinged toe box
  const sg = getShoeGeoms(detail);
  const toes: THREE.Group[] = [];
  const mkShoe = (mirror: boolean) => {
    const g = new THREE.Group();
    const inner = new THREE.Group();
    if (mirror) inner.scale.set(-1, 1, 1);
    const up = new THREE.Mesh(sg.upper, shoeMaterial());
    const so = new THREE.Mesh(sg.sole, soleMaterial());
    const toe = new THREE.Group();
    toe.position.set(...TOE_PIVOT);
    const ut = new THREE.Mesh(sg.upperToe, shoeMaterial());
    const st = new THREE.Mesh(sg.soleToe, soleMaterial());
    toe.add(ut, st);
    for (const m of [up, so, ut, st]) {
      m.castShadow = shadow;
      m.receiveShadow = receive;
    }
    inner.add(up, so, toe);
    g.add(inner);
    toes.push(toe);
    return g;
  };
  const lFoot = mkShoe(false);
  const rFoot = mkShoe(true);

  // knees (pads)
  const lKnee = new THREE.Group();
  const rKnee = new THREE.Group();
  if (role === "batsman" || role === "keeper") {
    const pg = getPadGeom(detail, role === "keeper");
    const pm = padMaterial(role === "keeper");
    const lp = new THREE.Mesh(pg, pm);
    const rpW = new THREE.Group();
    rpW.scale.set(-1, 1, 1);
    const rp = new THREE.Mesh(pg, pm);
    lp.castShadow = rp.castShadow = shadow;
    lp.receiveShadow = rp.receiveShadow = receive;
    lKnee.add(lp);
    rpW.add(rp);
    rKnee.add(rpW);
  }

  return {
    bones,
    skeletonRoot,
    meshes,
    head,
    lHand,
    rHand,
    lFoot,
    rFoot,
    lKnee,
    rKnee,
    hands: { l: lHandRig, r: rHandRig },
    cuffs,
    toes,
  };
};

/**
 * Toe-box bend: when the ball of the foot is on the ground and the heel is raised, the toes stay flat
 * (ground at y = 0 of the player's parent). Pure function of the ankle matrix.
 */
export const toeBend = (ankle: THREE.Matrix4) => {
  const ball = new THREE.Vector3(...TOE_PIVOT).applyMatrix4(ankle);
  const fwd = new THREE.Vector3(0, 0, 1).transformDirection(ankle);
  const pitchDown = Math.asin(Math.max(-1, Math.min(1, -fwd.y)));
  const contact = 1 - Math.max(0, Math.min(1, (ball.y - 0.006) / 0.05));
  return Math.max(0, Math.min(1.1, pitchDown)) * contact;
};

const WRIST_OFF = new THREE.Matrix4().makeTranslation(0, -RIG.forearm, 0);

const apply = (o: THREE.Object3D, m: THREE.Matrix4) => {
  m.decompose(o.position, o.quaternion, o.scale);
  o.scale.set(1, 1, 1);
};

const updateRig = (rig: Rig, pose: Pose, solved: Solved) => {
  BONES.forEach((b, i) => apply(rig.bones[i], solved[b]));
  apply(rig.head, solved.head);
  apply(rig.lHand, solved.lWrist);
  apply(rig.rHand, solved.rWrist);
  // cuffs: forearm (ForeB) orientation at the wrist joint
  apply(rig.cuffs[0], solved.lForeB.clone().multiply(WRIST_OFF));
  apply(rig.cuffs[1], solved.rForeB.clone().multiply(WRIST_OFF));
  apply(rig.lFoot, solved.lAnkle);
  apply(rig.rFoot, solved.rAnkle);
  apply(rig.lKnee, solved.lKnee);
  apply(rig.rKnee, solved.rKnee);
  rig.toes[0].rotation.x = -toeBend(solved.lAnkle);
  rig.toes[1].rotation.x = -toeBend(solved.rAnkle);
  const rp = pose as RigPose;
  setHandCurl(rig.hands.l, pose.lGrip, rp.lFingers);
  setHandCurl(rig.hands.r, pose.rGrip, rp.rFingers);
};

/** Stable small hash for seeds. */
const seedPick = (seed: number, n: number, salt: number) => {
  const x = Math.sin(seed * 91.17 + salt * 13.7) * 43758.5453;
  return Math.floor((x - Math.floor(x)) * n);
};

export const Player: React.FC<PlayerProps> = ({
  pose,
  role = "fielder",
  kit = role === "batsman" ? "graphite" : "teal",
  position = [0, 0, 0],
  rotationY = 0,
  rightHand,
  leftHand,
  bat,
  ball = false,
  ballSpin = [0, 0, 0],
  headwear = "auto",
  seed = 1,
  detail = "mid",
  castShadow = true,
  receiveShadow = true,
}) => {
  const hw: Exclude<Headwear, "auto"> =
    headwear !== "auto"
      ? headwear
      : role === "batsman" || role === "keeper"
        ? "helmet"
        : role === "bowler" || seedPick(seed, 3, 2) !== 0
          ? "cap"
          : "none";
  const tone = SKIN_TONES[seedPick(seed, SKIN_TONES.length, 1)];
  const hairStyle = seedPick(seed, 2, 3);
  const rig = useMemo(
    () => makeRig(detail, kit, role, tone, hairStyle, hw, castShadow, receiveShadow),
    [detail, kit, role, tone, hairStyle, hw, castShadow, receiveShadow],
  );
  const solved = solvePose(pose);
  updateRig(rig, pose, solved);
  const rp = pose as RigPose;
  const showBat = (bat ?? role === "batsman") && !!rp.bat;
  const batT = showBat && rp.bat ? batInHand(rp.bat.hand, rp.bat.grip, undefined, rp.bat.tilt, rp.bat.roll) : null;
  const showBall = ball && !!rp.ball;
  const ballT = showBall && rp.ball ? ballInHand(rp.ball.hand, rp.ball.grip) : null;
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <primitive object={rig.skeletonRoot} />
      {rig.meshes.map((m, i) => (
        <primitive key={i} object={m} />
      ))}
      <primitive object={rig.head} />
      <primitive object={rig.lFoot} />
      <primitive object={rig.rFoot} />
      <primitive object={rig.lKnee} />
      <primitive object={rig.rKnee} />
      <primitive object={rig.cuffs[0]} />
      <primitive object={rig.cuffs[1]} />
      <primitive object={rig.lHand}>
        {leftHand}
        {batT && rp.bat?.hand === "l" ? <Bat position={batT.position} rotation={batT.rotation} castShadow={castShadow} /> : null}
        {ballT && rp.ball?.hand === "l" ? (
          <group position={ballT.position} rotation={ballT.rotation}>
            <Ball spin={ballSpin} castShadow={castShadow} detail={detail === "hero" ? "hero" : "mid"} />
          </group>
        ) : null}
      </primitive>
      <primitive object={rig.rHand}>
        {rightHand}
        {batT && rp.bat?.hand === "r" ? <Bat position={batT.position} rotation={batT.rotation} castShadow={castShadow} /> : null}
        {ballT && rp.ball?.hand === "r" ? (
          <group position={ballT.position} rotation={ballT.rotation}>
            <Ball spin={ballSpin} castShadow={castShadow} detail={detail === "hero" ? "hero" : "mid"} />
          </group>
        ) : null}
      </primitive>
    </group>
  );
};
