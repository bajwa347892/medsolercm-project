/**
 * MacroHand: the bowler's right hand and wrist gripping the ball, built for the S02 extreme close-up
 * (camera 0.2-0.6 m away). See SPEC.md §6.4. Preview: T-Hand (src/tests/THand.tsx).
 *
 * Construction
 *   The hand is a signed distance field of sculpted parts (palm slab, thenar / hypothenar eminences,
 *   metacarpal heads and ridges, three-phalanx fingers with waisted shafts, palmar pads and knuckle condyles,
 *   flattened fingertips, a thumb on its metacarpal, carpus and ulnar styloid) blended with smooth unions
 *   (wide blends for the webs, tight ones at the joints, none between neighbouring fingers), polygonised
 *   ONCE per tab by a block-sparse surface-nets mesher (0.6 mm cells, ~190k vertices, vertices projected
 *   onto the surface, normals from the field gradient; ~3 s). The grip is SOLVED, not keyed: every finger
 *   closes like a real grasp (knuckle until the proximal phalanx meets the leather, then PIP/DIP until the
 *   pads press 0.7 mm in and flatten), index and middle straddle the seam 12 mm either side, the thumb
 *   pad lands under the ball ON the seam, ring and little fingers fold at the side. CPU linear-blend
 *   skinning on 17 bones drives the micro motion; pads can never enter the ball.
 *
 * Shading
 *   Skin: MeshPhysicalMaterial patched with gently wrapped (red-biased) diffuse and a weak translucency
 *   glow at the silhouette of thin parts against the rim light, a palmar / dorsal pigment split along the
 *   mid-lateral line, knuckle pigment, long wavy dorsal joint wrinkles, palmar flexion creases and palm
 *   lines, veins and extensor tendons (stronger with grip tension), skin plates and pores, fingerprints,
 *   convex glossy nails (U-shaped cuticle, plate blending into the lateral folds, lunula, translucent free
 *   edge), baked SDF ambient occlusion (hand + ball; the cuff's contact shadow is a separate factor so the
 *   wrist is clean without it). Every micro feature fades by its own pixels-per-period (no derivative-bump
 *   aliasing at 1080p; skin plates, pores and leather grain resolve at 4K or closer than ~0.2 m).
 *   Ball: the film ball's construction (seam in its local XZ plane, 6 rows x 82 stitches as real geometry,
 *   quarter seams, polished +Y half) with a soft leather grain under the lacquer clearcoat, sweat-polish
 *   smears and the teal LED-board reflection: a soft streak (only the lit segment of the board sweep is
 *   bright) that travels across the lacquer over the shot and never reads as a second seam ring.
 *   Cuff: a ribbed knit wristband in deep teal with a graphite band, rolled lips shaded by the wrist;
 *   cuff="none" gives a bare wrist. Shadows are analytic (no shadow map): every directional light is
 *   cone-traced against capsules for the phalanges, thumb and palm and a sphere for the ball, giving soft
 *   floodlight penumbras on the lacquer and the ball's shadow on the pads; capsule AO on ball and cuff.
 *   Materials carry their own night-stadium environment map (floodlight banks as lamp grids, LED ring,
 *   stands, lit grass) seen from the S02 hand position.
 *
 * Local frame of <MacroHand/> (metres)
 *   Origin at the BALL CENTRE at rest. +Y up, -Z is the bowler's forward (toward the batsman), +X the
 *   bowler's right. The seam plane is the local YZ plane (upright, pointing down the pitch) once settled;
 *   index and middle fingers lie over the top either side of it, the palm is behind the ball (+Z), the
 *   wrist is cocked and the forearm runs down and back. For S02 (bowler at the top of his run, facing -Z):
 *     const t = f / 30;
 *     <MacroHandLights center={HAND} rimDir={rimDirFor(cam, HAND)} />      // instead of <StadiumLights/>
 *     <group position={HAND}><MacroHand t={t} skinTone={bowlerTone} /></group>   // HAND = [0, 1.4, 26]
 *     <Post focus={macroSeamFocus(t, HAND, cam)} focusRange={0.006} aperture={0.05} maxBlur={0.05} />
 *   macroSeamFocus returns the point of the actual seam ring nearest the camera (any angle), so the
 *   stitches are the sharpest thing in frame. Keep the camera >= 0.2 m from the ball centre.
 *   Good angles: in front of the hand (the seam reads as a vertical rope between the fingertips) or
 *   3/4 behind (knuckles, veins, seam between index and middle), from slightly below so the floodlight
 *   banks sit behind the hand as bokeh. From +-X exactly the seam lies on the ball's outline.
 *
 * Timing (t = seconds since the start of S02, global frame 66; all derived from cues.json)
 *   MACRO_T.handle   [0.200, 0.867, 1.467]  ball_handle: the fingers roll the ball (seam tilt 17deg -> 0,
 *                                           seam yaw -14deg -> 0, the leather turns 29deg about the seam
 *                                           normal); motion starts 2 frames before each cue, ~0.33 s long;
 *                                           index and middle travel with the leather, lift a hair and
 *                                           re-settle astride the seam ~0.25 s later
 *   MACRO_T.breath   [0.400, 1.267]         breath: the wrist lifts (~4 mm) on the inhale (moving from the
 *                                           cue frame, fastest ~0.2 s after it), settles over 1.1 s
 *   MACRO_T.settle   1.467 -> ~2.0          last turn puts the seam upright; grip tightens from 1.71 s
 *   MACRO_T.runStart 1.733 (frame 118)      the run begins: the hand accelerates forward / down (~10 cm
 *                                           forward, 5 cm down by frame 126, 26 mm/frame at the cut),
 *                                           motivating the cut; S02 has no motion blur, so frame the last
 *                                           frames so the hand leaves toward / past the lens
 *
 * Exports: MacroHand, MacroBall, MacroHandLights, macroHandState(t), macroBallCenter(t),
 *   macroSeamFocus(t, handPos, cam), MACRO_T, MACRO_BALL_CENTER, macroHandStats() (debug).
 * Continuity: the rig's bowler wears short sleeves. S02 must match whatever S03 shows on his right wrist:
 *   pass cuff="none" for a bare wrist, or keep the default band and give the Player a matching wristband;
 *   pass the bowler's skin tone (SKIN_TONES from rig/kit.ts, picked by the Player's seed).
 * Determinism: every value is a pure function of t. Geometry, rig and environment are built once per tab
 * and cached; nothing accumulates across frames.
 */
import React, { useMemo } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import cues from "../cues.json";
import { PAL } from "../theme";
import { BALL } from "../world/dims";
import type { Vec3 } from "./types";

/* ================================================================== */
/* Timing                                                              */
/* ================================================================== */

const FPS_ = 30;
const S02_START = cues.shots.S02_macro_grip[0];
const S02_END = cues.shots.S02_macro_grip[1];
const lt = (F: number) => (F - S02_START) / FPS_;

/** Local cue times (seconds since the start of S02). */
export const MACRO_T = {
  handle: cues.events.ball_handle.map(lt),
  breath: cues.events.breath.map(lt),
  settle: lt(cues.events.ball_handle[2]),
  runStart: lt(S02_END) - 8 / FPS_,
  end: lt(S02_END),
};

/* ================================================================== */
/* Small vector / frame math (plain tuples, cheap)                     */
/* ================================================================== */

type V = [number, number, number];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vlen = (a: V) => Math.hypot(a[0], a[1], a[2]);
const nrm = (a: V): V => mul(a, 1 / (vlen(a) || 1));
const lerpV = (a: V, b: V, t: number): V => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Rigid frame: origin + orthonormal basis (columns), all in the parent space. */
type Frame = { o: V; x: V; y: V; z: V };
const ID: Frame = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const fPt = (F: Frame, l: V): V => [
  F.o[0] + F.x[0] * l[0] + F.y[0] * l[1] + F.z[0] * l[2],
  F.o[1] + F.x[1] * l[0] + F.y[1] * l[1] + F.z[1] * l[2],
  F.o[2] + F.x[2] * l[0] + F.y[2] * l[1] + F.z[2] * l[2],
];
const fDir = (F: Frame, l: V): V => [
  F.x[0] * l[0] + F.y[0] * l[1] + F.z[0] * l[2],
  F.x[1] * l[0] + F.y[1] * l[1] + F.z[1] * l[2],
  F.x[2] * l[0] + F.y[2] * l[1] + F.z[2] * l[2],
];
const fLoc = (F: Frame, p: V): V => {
  const d = sub(p, F.o);
  return [dot(d, F.x), dot(d, F.y), dot(d, F.z)];
};
const fMul = (A: Frame, B: Frame): Frame => ({ o: fPt(A, B.o), x: fDir(A, B.x), y: fDir(A, B.y), z: fDir(A, B.z) });
const fInv = (F: Frame): Frame => ({
  o: [-dot(F.o, F.x), -dot(F.o, F.y), -dot(F.o, F.z)],
  x: [F.x[0], F.y[0], F.z[0]],
  y: [F.x[1], F.y[1], F.z[1]],
  z: [F.x[2], F.y[2], F.z[2]],
});
const fTrans = (F: Frame, l: V): Frame => ({ ...F, o: fPt(F, l) });
/** rotate about the frame's own x: +a tilts y toward z */
const fRotX = (F: Frame, a: number): Frame => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { o: F.o, x: F.x, y: add(mul(F.y, c), mul(F.z, s)), z: add(mul(F.y, -s), mul(F.z, c)) };
};
/** rotate about the frame's own y: +a tilts z toward x */
const fRotY = (F: Frame, a: number): Frame => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { o: F.o, x: add(mul(F.x, c), mul(F.z, -s)), y: F.y, z: add(mul(F.x, s), mul(F.z, c)) };
};
/** rotate about the frame's own z: +a tilts x toward y */
const fRotZ = (F: Frame, a: number): Frame => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { o: F.o, x: add(mul(F.x, c), mul(F.y, s)), y: add(mul(F.x, -s), mul(F.y, c)), z: F.z };
};
/** rotate a frame about a world axis through a world pivot */
const fRotAxis = (F: Frame, pivot: V, axis: V, a: number): Frame => {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis), a);
  const r = (v: V): V => new THREE.Vector3(...v).applyQuaternion(q).toArray() as V;
  return { o: add(pivot, r(sub(F.o, pivot))), x: r(F.x), y: r(F.y), z: r(F.z) };
};

/* ================================================================== */
/* Anatomy (adult male right hand, ~19.5 cm long)                      */
/* ================================================================== */
/*
 * Palm-local space ("P"): origin at the wrist (radiocarpal) joint centre, +y distal along the middle
 * metacarpal, +z dorsal (back of the hand), +x ulnar (toward the little finger). The palm faces -z.
 * Each bone frame: origin at its proximal joint, +y along the bone, +z dorsal (nail side), +x lateral.
 */

const R = BALL.radius;
const NB = 17;
/** bone indices */
const FORE = 0;
const PALM = 1;
const ph = (f: number, j: number) => 2 + f * 3 + j; // finger f (0 index .. 3 little), phalanx j (0..2)
const TMC = 14;
const TP1 = 15;
const TP2 = 16;
const PARENT = [-1, 0, 1, 2, 3, 1, 5, 6, 1, 8, 9, 1, 11, 12, 1, 14, 15];

type FingerDef = { mcp: V; len: [number, number, number]; rad: [number, number, number, number] };
/** MCP joint centres (palm-local), phalanx lengths joint-to-joint (distal: to the fleshy tip), radii at MCP/PIP/DIP/tip */
const FING: FingerDef[] = [
  { mcp: [-0.0245, 0.0655, -0.0015], len: [0.0425, 0.025, 0.0215], rad: [0.0108, 0.0099, 0.009, 0.0077] },
  { mcp: [-0.004, 0.069, 0.0], len: [0.0465, 0.0285, 0.0225], rad: [0.0112, 0.0103, 0.0093, 0.008] },
  { mcp: [0.0155, 0.0645, -0.0025], len: [0.0435, 0.027, 0.0215], rad: [0.0105, 0.0096, 0.0087, 0.0076] },
  { mcp: [0.033, 0.0555, -0.008], len: [0.034, 0.0205, 0.0195], rad: [0.0093, 0.0085, 0.0077, 0.0068] },
];
const THUMB = {
  cmc: [-0.0215, 0.016, -0.011] as V,
  len: [0.044, 0.031, 0.0285] as [number, number, number],
  rad: [0.0128, 0.011, 0.0103, 0.0086] as [number, number, number, number],
};

const BONE_LEN: number[] = [0.06, 0.069];
const BONE_RAD: [number, number][] = [
  [0.02, 0.023],
  [0.012, 0.012],
];
for (let f = 0; f < 4; f++) {
  const d = FING[f];
  for (let j = 0; j < 3; j++) {
    BONE_LEN[ph(f, j)] = d.len[j];
    BONE_RAD[ph(f, j)] = [d.rad[j], d.rad[j + 1]];
  }
}
for (let j = 0; j < 3; j++) {
  BONE_LEN[TMC + j] = THUMB.len[j];
  BONE_RAD[TMC + j] = [THUMB.rad[j], THUMB.rad[j + 1]];
}

/* ================================================================== */
/* Grip solve (rest pose)                                              */
/* ================================================================== */

/** Art direction of the grip (palm-local). */
const GRIP = {
  /** ball centre in palm-local space */
  ball: [0.0015, 0.086, -0.0505] as V,
  /** wrist flexion (+ toward the palm) and ulnar deviation, radians: cocked back */
  wristFlex: -0.5,
  wristDev: 0.1,
  /** pads squash this far into the leather (they are flattened against it) */
  pen: 0.0007,
  fingers: [
    { mcp: 0.62, kDip: 0.62, tx: -0.012, twist: 0.06 }, // index: left of the seam
    { mcp: 0.58, kDip: 0.6, tx: 0.012, twist: -0.03 }, // middle: right of the seam
    { mcp: 1.05, kDip: 0.8, tx: 0.031, twist: -0.22 }, // ring: folded at the side
  ],
  little: { abd: 0.1, mcp: 1.2, pip: 1.5, dip: 0.95, twist: -0.3 },
  /** thumb: IP flexion (rad); the pad lands on the seam under the ball, where the metacarpal length allows */
  thumb: { ip: 0.21 },
  /** tilt of the hold about the seam normal (rad): + rolls the fingers back over the top */
  tilt: -0.12,
};

type FingerAngles = { abd: number; mcp: number; pip: number; dip: number; twist: number };

const fingerChain = (palm: Frame, f: number, a: FingerAngles): [Frame, Frame, Frame] => {
  const d = FING[f];
  let F1 = fTrans(palm, d.mcp);
  F1 = fRotZ(F1, -a.abd);
  F1 = fRotX(F1, -a.mcp);
  F1 = fRotY(F1, a.twist);
  const F2 = fRotX(fTrans(F1, [0, d.len[0], 0]), -a.pip);
  const F3 = fRotX(fTrans(F2, [0, d.len[1], 0]), -a.dip);
  return [F1, F2, F3];
};

/** min over the pad line of (distance to ball centre - R - pad offset); negative = pressing in */
const padGap = (frames: Frame[], bones: number[], c: V, from = 0.15) => {
  let g = 1e9;
  let at: V = [0, 0, 0];
  for (let i = 0; i < frames.length; i++) {
    const L = BONE_LEN[bones[i]];
    const [ra, rb] = BONE_RAD[bones[i]];
    const end = i === frames.length - 1 ? 0.8 : 1;
    for (let s = 0; s <= 12; s++) {
      const u = from + ((end - from) * s) / 12;
      const p = fPt(frames[i], [0, u * L, -0.25 * (ra + (rb - ra) * u)]);
      const r = (ra + (rb - ra) * u) * 0.7;
      const gg = vlen(sub(p, c)) - R - r;
      if (gg < g) {
        g = gg;
        at = p;
      }
    }
  }
  return { g, at };
};

/** smallest a in [lo, hi] with gap(a) <= 0 (scan + bisection); `miss` if it never closes */
const closeUntil = (gap: (a: number) => number, lo: number, hi: number, miss: number) => {
  const n = Math.max(4, Math.ceil((hi - lo) / 0.02));
  let prev = lo;
  for (let i = 0; i <= n; i++) {
    const a = lo + ((hi - lo) * i) / n;
    if (gap(a) <= 0) {
      if (i === 0) return lo;
      let l = prev;
      let h = a;
      for (let k = 0; k < 22; k++) {
        const m = (l + h) / 2;
        if (gap(m) <= 0) h = m;
        else l = m;
      }
      return h;
    }
    prev = a;
  }
  return miss;
};

type Solved = {
  /** rest frames of every bone in palm-local space */
  P: Frame[];
  /** contact points (palm-local) used for the hold orientation */
  topContact: V;
  thumbContact: V;
};

/** hand space in palm-local space: origin at the ball centre, +Y toward the index / middle contact (tilted
 *  by GRIP.tilt about the seam normal), +X = palm x (the seam normal), +Z back toward the palm */
const handFrameOf = (topContact: V): Frame => {
  const c = GRIP.ball;
  const hx: V = [1, 0, 0];
  let up = nrm(sub(topContact, c));
  up = nrm(sub(up, mul(hx, dot(up, hx))));
  const hz0 = cross(hx, up);
  const ct = Math.cos(GRIP.tilt);
  const st = Math.sin(GRIP.tilt);
  const hy = add(mul(up, ct), mul(hz0, st));
  return { o: c, x: hx, y: hy, z: cross(hx, hy) };
};

const solveGrip = (): Solved => {
  const c = GRIP.ball;
  const palm = ID;
  const P: Frame[] = [];
  P[PALM] = palm;
  // forearm: inverse of the wrist rotation
  const palmInFore = fRotZ(fRotX(ID, -GRIP.wristFlex), -GRIP.wristDev);
  P[FORE] = fInv(palmInFore);

  const contacts: V[] = [];
  for (let f = 0; f < 3; f++) {
    const g = GRIP.fingers[f];
    const solvePip = (abd: number) => {
      // grasp closure: the knuckle closes until the proximal phalanx meets the leather (or its limit),
      // then the middle and distal joints close until their pads press in
      const chainAt = (mcp: number, pip: number) =>
        fingerChain(palm, f, { abd, mcp, pip, dip: pip * g.kDip, twist: g.twist });
      const p1Gap = (mcp: number) => padGap([chainAt(mcp, 0)[0]], [ph(f, 0)], c, 0.35).g + GRIP.pen * 0.5;
      const mcp = closeUntil(p1Gap, 0, g.mcp, g.mcp);
      const p23Gap = (pip: number) => {
        const ch = chainAt(mcp, pip);
        return padGap([ch[1], ch[2]], [ph(f, 1), ph(f, 2)], c).g + GRIP.pen;
      };
      const pip = closeUntil(p23Gap, 0, 2.0, 1.2);
      return { pip, ch: chainAt(mcp, pip) };
    };
    // abduction so the middle phalanx sits at the lateral target
    let lo = -0.6;
    let hi = 0.6;
    for (let i = 0; i < 26; i++) {
      const m = (lo + hi) / 2;
      const { ch } = solvePip(m);
      const mid = fPt(ch[1], [0, BONE_LEN[ph(f, 1)] * 0.5, 0]);
      if (mid[0] - c[0] < g.tx) lo = m;
      else hi = m;
    }
    const { ch } = solvePip((lo + hi) / 2);
    P[ph(f, 0)] = ch[0];
    P[ph(f, 1)] = ch[1];
    P[ph(f, 2)] = ch[2];
    contacts.push(padGap([ch[1], ch[2]], [ph(f, 1), ph(f, 2)], c).at);
  }
  {
    const l = GRIP.little;
    const ch = fingerChain(palm, 3, l);
    P[ph(3, 0)] = ch[0];
    P[ph(3, 1)] = ch[1];
    P[ph(3, 2)] = ch[2];
  }
  // thumb: built from its contact, so no part of it can pass through the ball. The pad sits under the ball
  // ON the seam; the distal phalanx lies tangent to the leather pointing away from the thumb's base, the IP
  // joint is gently flexed (GRIP.thumb.ip) and the whole thumb lies in one hinge plane through the CMC joint.
  // How far forward of the bottom the pad lands is solved so the metacarpal keeps its length; with this
  // hand (wrist cocked, ball held in the fingers) that is ~26 deg forward of the bottom, MCP flexed ~22 deg.
  const topContact = lerpV(contacts[0], contacts[1], 0.5);
  const H0 = handFrameOf(topContact);
  const cmc = THUMB.cmc;
  const [L0, L1, L2] = THUMB.len;
  const rPad = THUMB.rad[2] + (THUMB.rad[3] - THUMB.rad[2]) * 0.55;
  const axisDist = R + 0.95 * rPad - GRIP.pen;
  const ip = GRIP.thumb.ip;
  const thumbAt = (beta: number) => {
    const nC = nrm(add(mul(H0.y, -Math.cos(beta)), mul(H0.z, Math.sin(beta))));
    const pAxis = add(c, mul(nC, axisDist));
    const toCmc = sub(cmc, pAxis);
    const tDir = nrm(mul(sub(toCmc, mul(nC, dot(toCmc, nC))), -1));
    const o2 = sub(pAxis, mul(tDir, 0.55 * L2));
    const y1 = add(mul(tDir, Math.cos(ip)), mul(nC, Math.sin(ip)));
    const o1 = sub(o2, mul(y1, L1));
    return { nC, tDir, o2, y1, o1, f: vlen(sub(o1, cmc)) - L0 };
  };
  let blo = -1.0;
  let bhi = 0.4;
  for (let i = 0; i < 40; i++) {
    const m = (blo + bhi) / 2;
    if (thumbAt(m).f > 0) blo = m;
    else bhi = m;
  }
  const th = thumbAt((blo + bhi) / 2);
  const X = nrm(cross(th.tDir, th.nC));
  const frameAlong = (o: V, y: V): Frame => ({ o, x: X, y, z: cross(X, y) });
  P[TMC] = frameAlong(cmc, nrm(sub(th.o1, cmc)));
  P[TP1] = frameAlong(th.o1, th.y1);
  P[TP2] = { o: th.o2, x: X, y: th.tDir, z: th.nC };
  const thumbContact = add(c, mul(th.nC, R));
  return { P, topContact, thumbContact };
};

type Rig = {
  /** rest frames in hand space (H: ball centre origin, +Y up, -Z forward) */
  rest: Frame[];
  /** rest local frames (relative to parent) */
  local: Frame[];
  /** hand space expressed in palm-local space */
  H: Frame;
};

let rigCache: Rig | null = null;
const getRig = (): Rig => {
  if (rigCache) return rigCache;
  const s = solveGrip();
  const H = handFrameOf(s.topContact);
  const toH = fInv(H);
  const rest = s.P.map((F) => fMul(toH, F));
  const local = rest.map((F, b) => (PARENT[b] < 0 ? F : fMul(fInv(rest[PARENT[b]]), F)));
  rigCache = { rest, local, H };
  return rigCache;
};

/* ================================================================== */
/* Signed distance field of the hand (rest pose, hand space)           */
/* ================================================================== */

const STRIDE = 24;
const T_CONE = 0;
const T_ELL = 1;
const T_SLAB = 2;

type PrimDef = { type: number; bone: number; k: number; F: Frame; p: number[] };

/** smooth union radii */
const K_WEB = 0.0055;
const K_THENAR = 0.009;
const K_WRIST = 0.008;
const K_J = 0.0022;
const K_C = 0.0012;
const K_MAX = 0.012;
const R_CONTACT = R + 0.00012;

const smin = (a: number, b: number, k: number) => {
  const d = a - b;
  const ad = d < 0 ? -d : d;
  if (ad >= k) return a < b ? a : b;
  const h = (k - ad) / k;
  return (a < b ? a : b) - h * h * k * 0.25;
};
const smax = (a: number, b: number, k: number) => -smin(-a, -b, k);

/** the hand mesh's forearm stub: an elliptical cone in the FORE frame (the forearm loft continues it) */
const FORE_CONE = { y0: -0.058, z: 0.001, len: 0.066, ra: 0.0225, rb: 0.0196, sx: 1.42 };

/** forearm cap plane (FORE frame origin / +y axis in hand space), set by buildPrims */
const CAP = { o: [0, 0, 0] as V, n: [0, 1, 0] as V };
const CAP_Y = -0.05;

type HandSDF = {
  prims: Float64Array;
  start: Int32Array;
  end: Int32Array;
};

const buildPrims = (rig: Rig): HandSDF => {
  const defs: PrimDef[] = [];
  const at = (b: number, F: Frame) => fMul(rig.rest[b], F);
  const local = (o: V, x: V = [1, 0, 0], y: V = [0, 1, 0]): Frame => {
    const yy = nrm(y);
    const xx = nrm(sub(x, mul(yy, dot(x, yy))));
    return { o, x: xx, y: yy, z: cross(xx, yy) };
  };
  const cone = (b: number, F: Frame, L: number, ra: number, rb: number, sx: number, szD: number, szP: number, k: number) =>
    defs.push({ type: T_CONE, bone: b, k, F: at(b, F), p: [L, ra, rb, sx, szD, szP] });
  const ell = (b: number, F: Frame, rx: number, ry: number, rz: number, k: number) =>
    defs.push({ type: T_ELL, bone: b, k, F: at(b, F), p: [rx, ry, rz] });

  /* ---- forearm + wrist (FORE frame: origin at the wrist joint, +y toward the hand) ---- */
  cone(FORE, local([0, FORE_CONE.y0, FORE_CONE.z]), FORE_CONE.len, FORE_CONE.ra, FORE_CONE.rb, FORE_CONE.sx, 1, 1, 0);
  ell(FORE, local([0.0235, -0.012, 0.0085]), 0.0062, 0.0075, 0.0058, 0.006); // ulnar styloid
  ell(FORE, local([-0.006, 0.004, -0.0035]), 0.025, 0.015, 0.0165, 0.01); // carpus
  /* ---- palm (palm-local == PALM bone frame) ---- */
  defs.push({
    type: T_SLAB,
    bone: PALM,
    k: 0,
    F: at(PALM, local([0.0045, 0.037, -0.0005])),
    p: [0.0185, 0.0262, 0.0255, 0.0038, 0.0088, 5.2],
  });
  for (let f = 0; f < 4; f++) {
    const m = FING[f].mcp;
    const r = FING[f].rad[0];
    // metacarpal head (knuckle) and shaft ridge on the back of the hand
    ell(PALM, local(add(m, [0, -0.002, 0.0015])), r * 0.86, r * 0.9, r * 0.86, 0.005);
    cone(PALM, local([m[0] * 0.55 + 0.003, 0.012, 0.0035], [1, 0, 0], sub(m, [m[0] * 0.55 + 0.003, 0.012, 0.0035])), vlen(sub(m, [m[0] * 0.55 + 0.003, 0.012, 0.0035])), 0.0062, 0.0075, 1.2, 1, 1, 0.006);
    // distal palmar pad below the knuckle
    ell(PALM, local(add(m, [0, -0.004, -0.0085])), r * 1.0, r * 1.15, r * 0.72, 0.005);
  }
  // thenar eminence along the thumb metacarpal, hypothenar along the ulnar edge
  {
    const tm = rig.local[TMC]; // TMC in palm space
    const dir = tm.y;
    const o = add(add(tm.o, mul(dir, 0.016)), [0.004, 0.0, -0.004]);
    ell(PALM, local(o, [1, 0, 0], dir), 0.0135, 0.023, 0.0118, K_THENAR);
  }
  ell(PALM, local([0.031, 0.031, -0.0055], [1, 0, 0], [0.08, 1, 0]), 0.0105, 0.027, 0.0105, 0.008);

  /* ---- fingers ---- */
  for (let f = 0; f < 4; f++) {
    for (let j = 0; j < 3; j++) {
      const b = ph(f, j);
      const L = BONE_LEN[b];
      const [ra, rb] = BONE_RAD[b];
      if (j < 2) {
        // two cones with a slight waist mid-shaft: joints read wider than the bone between them
        const rm = (ra + rb) * 0.5 * 0.988;
        cone(b, ID, L * 0.5, ra, rm, 1.0, 0.86, 0.92, 0);
        cone(b, local([0, L * 0.5, 0]), L * 0.5, rm, rb, 1.0, 0.86, 0.92, 0.004);
        // palmar pad
        ell(b, local([0, L * 0.5, -0.32 * (ra + rb) * 0.5]), ra * 0.84, L * 0.4, ra * 0.62, 0.0024);
        // condyle at the head of the phalanx (shows on the back of a bent joint)
        ell(b, local([0, L - 0.0012, 0.04 * rb]), rb * 0.74, rb * 0.52, rb * 0.72, 0.0024);
      } else {
        // distal phalanx: flatter on the nail side, fleshy pad, rounded tip
        cone(b, ID, L - rb, ra, rb, 1.1, 0.7, 0.9, 0);
        ell(b, local([0, L * 0.55, -0.32 * ra]), ra * 0.9, L * 0.4, ra * 0.62, 0.0026);
      }
    }
  }
  /* ---- thumb ---- */
  {
    const L0 = BONE_LEN[TMC];
    cone(TMC, ID, L0, THUMB.rad[0], THUMB.rad[1], 1.12, 0.95, 1, 0);
    const L1 = BONE_LEN[TP1];
    cone(TP1, ID, L1, THUMB.rad[1], THUMB.rad[2], 1.1, 0.88, 0.95, 0);
    ell(TP1, local([0, L1 * 0.5, -0.3 * THUMB.rad[1]]), THUMB.rad[1] * 0.85, L1 * 0.4, THUMB.rad[1] * 0.62, 0.0026);
    ell(TP1, local([0, L1 - 0.0015, 0.12 * THUMB.rad[2]]), THUMB.rad[2] * 0.92, THUMB.rad[2] * 0.62, THUMB.rad[2] * 0.82, 0.002);
    const L2 = BONE_LEN[TP2];
    cone(TP2, ID, L2 - THUMB.rad[3], THUMB.rad[2], THUMB.rad[3], 1.16, 0.7, 0.92, 0);
    ell(TP2, local([0, L2 * 0.55, -0.28 * THUMB.rad[2]]), THUMB.rad[2] * 0.98, L2 * 0.42, THUMB.rad[2] * 0.72, 0.0028);
  }

  defs.sort((a, b) => a.bone - b.bone);
  const prims = new Float64Array(defs.length * STRIDE);
  const start = new Int32Array(NB).fill(0);
  const end = new Int32Array(NB).fill(0);
  defs.forEach((d, i) => {
    const o = i * STRIDE;
    prims[o] = d.type;
    prims[o + 1] = d.bone;
    prims[o + 2] = d.k;
    prims.set(d.F.o, o + 3);
    prims.set(d.F.x, o + 6);
    prims.set(d.F.y, o + 9);
    prims.set(d.F.z, o + 12);
    for (let j = 0; j < d.p.length; j++) prims[o + 15 + j] = d.p[j];
  });
  for (let b = 0; b < NB; b++) {
    start[b] = defs.findIndex((d) => d.bone === b);
    let e = start[b];
    while (e >= 0 && e < defs.length && defs[e].bone === b) e++;
    end[b] = e;
  }
  CAP.o = rig.rest[FORE].o;
  CAP.n = rig.rest[FORE].y;
  return { prims, start, end };
};

const evalPrim = (P: Float64Array, i: number, px: number, py: number, pz: number): number => {
  const dx = px - P[i + 3];
  const dy = py - P[i + 4];
  const dz = pz - P[i + 5];
  let qx = dx * P[i + 6] + dy * P[i + 7] + dz * P[i + 8];
  const qy = dx * P[i + 9] + dy * P[i + 10] + dz * P[i + 11];
  let qz = dx * P[i + 12] + dy * P[i + 13] + dz * P[i + 14];
  const t = P[i];
  if (t === T_CONE) {
    const L = P[i + 15];
    const ra = P[i + 16];
    const rb = P[i + 17];
    const sx = P[i + 18];
    const sz = qz > 0 ? P[i + 19] : P[i + 20];
    qx /= sx;
    qz /= sz;
    const b = (ra - rb) / L;
    const a = Math.sqrt(1 - b * b);
    const qr = Math.sqrt(qx * qx + qz * qz);
    const kk = -b * qr + a * qy;
    let d: number;
    if (kk < 0) d = Math.sqrt(qr * qr + qy * qy) - ra;
    else if (kk > a * L) d = Math.sqrt(qr * qr + (qy - L) * (qy - L)) - rb;
    else d = qr * a + qy * b - ra;
    return d * (sx < sz ? sx : sz);
  }
  if (t === T_ELL) {
    const rx = P[i + 15];
    const ry = P[i + 16];
    const rz = P[i + 17];
    const ax = qx / rx;
    const ay = qy / ry;
    const az = qz / rz;
    const k0 = Math.sqrt(ax * ax + ay * ay + az * az);
    const bx = ax / rx;
    const by = ay / ry;
    const bz = az / rz;
    const k1 = Math.sqrt(bx * bx + by * by + bz * bz);
    if (k1 < 1e-9) return -Math.min(rx, ry, rz);
    return (k0 * (k0 - 1)) / k1;
  }
  // T_SLAB: tapered, cupped rounded box. p: hxA (wrist end), hxB (knuckle end), hy, hz, round, cup
  const hxA = P[i + 15];
  const hxB = P[i + 16];
  const hy = P[i + 17];
  const hz = P[i + 18];
  const rr = P[i + 19];
  const cup = P[i + 20];
  const tt = clamp01((qy + hy) / (2 * hy));
  const hx = hxA + (hxB - hxA) * tt;
  qz += cup * qx * qx;
  const ex = Math.abs(qx) - hx;
  const ey = Math.abs(qy) - hy;
  const ez = Math.abs(qz) - hz;
  const ox = ex > 0 ? ex : 0;
  const oy = ey > 0 ? ey : 0;
  const oz = ez > 0 ? ez : 0;
  const inner = Math.max(ex, ey, ez);
  return Math.sqrt(ox * ox + oy * oy + oz * oz) + (inner < 0 ? inner : 0) - rr;
};

const ALL_BONES = (1 << NB) - 1;

/** per-bone distances (bones outside mask = 1e9) */
const boneDists = (S: HandSDF, px: number, py: number, pz: number, mask: number, out: Float64Array) => {
  const P = S.prims;
  for (let b = 0; b < NB; b++) {
    if (!(mask & (1 << b)) || S.start[b] < 0) {
      out[b] = 1e9;
      continue;
    }
    let d = 1e9;
    for (let i = S.start[b]; i < S.end[b]; i++) {
      const o = i * STRIDE;
      const di = evalPrim(P, o, px, py, pz);
      d = i === S.start[b] ? di : smin(d, di, P[o + 2]);
    }
    out[b] = d;
  }
};

/** compose bone distances into the hand surface */
const composeHand = (db: Float64Array, px: number, py: number, pz: number, contact = true) => {
  const base = smin(db[PALM], db[FORE], K_WRIST);
  let hand = base;
  for (let f = 0; f < 4; f++) {
    const b1 = db[ph(f, 0)];
    const b2 = db[ph(f, 1)];
    const b3 = db[ph(f, 2)];
    const w = smin(base, b1, K_WEB);
    if (w < hand) hand = w;
    const fing = smin(smin(b1, b2, K_J), b3, K_J);
    if (fing < hand) hand = fing;
  }
  const t0 = db[TMC];
  const th0 = smin(base, t0, K_THENAR);
  if (th0 < hand) hand = th0;
  const th = smin(smin(t0, db[TP1], K_J), db[TP2], K_J);
  if (th < hand) hand = th;
  if (contact) {
    const rb = Math.sqrt(px * px + py * py + pz * pz);
    hand = smax(hand, R_CONTACT - rb, K_C);
  }
  // close the forearm stub with a flat cap inside the cuff
  const yf = (px - CAP.o[0]) * CAP.n[0] + (py - CAP.o[1]) * CAP.n[1] + (pz - CAP.o[2]) * CAP.n[2];
  const cap = CAP_Y - yf;
  return cap > hand ? cap : hand;
};

const scratchDb = new Float64Array(NB);
const handSDF = (S: HandSDF, px: number, py: number, pz: number, mask = ALL_BONES) => {
  boneDists(S, px, py, pz, mask, scratchDb);
  return composeHand(scratchDb, px, py, pz);
};

/* ================================================================== */
/* Block-sparse surface nets                                           */
/* ================================================================== */

type RawMesh = { pos: Float32Array; nrm: Float32Array; idx: Uint32Array; masks: Int32Array };

const meshHand = (S: HandSDF, lo: V, hi: V, h: number): RawMesh => {
  const BS = 8; // cells per block side
  const nx = Math.ceil((hi[0] - lo[0]) / h);
  const ny = Math.ceil((hi[1] - lo[1]) / h);
  const nz = Math.ceil((hi[2] - lo[2]) / h);
  const nbx = Math.ceil(nx / BS);
  const nby = Math.ceil(ny / BS);
  const nbz = Math.ceil(nz / BS);
  const halfDiag = (Math.sqrt(3) * BS * h) / 2;
  const db = new Float64Array(NB);
  type Block = { bx: number; by: number; bz: number; vals: Float32Array; mask: number };
  const blocks: Block[] = [];
  const blockOf = new Map<number, Block>();
  const S1 = BS + 1;
  for (let bz = 0; bz < nbz; bz++)
    for (let by = 0; by < nby; by++)
      for (let bx = 0; bx < nbx; bx++) {
        const cx = lo[0] + (bx * BS + BS / 2) * h;
        const cy = lo[1] + (by * BS + BS / 2) * h;
        const cz = lo[2] + (bz * BS + BS / 2) * h;
        boneDists(S, cx, cy, cz, ALL_BONES, db);
        const dc = composeHand(db, cx, cy, cz);
        if (Math.abs(dc) > halfDiag * 1.3 + h) continue;
        let mask = 0;
        for (let b = 0; b < NB; b++) if (db[b] - halfDiag * 1.3 < K_MAX) mask |= 1 << b;
        const vals = new Float32Array(S1 * S1 * S1);
        for (let k = 0; k <= BS; k++)
          for (let j = 0; j <= BS; j++)
            for (let i = 0; i <= BS; i++) {
              const x = lo[0] + (bx * BS + i) * h;
              const y = lo[1] + (by * BS + j) * h;
              const z = lo[2] + (bz * BS + k) * h;
              vals[i + S1 * (j + S1 * k)] = handSDF(S, x, y, z, mask);
            }
        const blk = { bx, by, bz, vals, mask };
        blocks.push(blk);
        blockOf.set(bx + nbx * (by + nby * bz), blk);
      }

  // vertices: one per sign-changing cell
  const vIndex = new Map<number, number>();
  const pos: number[] = [];
  const vmask: number[] = [];
  const corner = new Float32Array(8);
  const EDGES = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  for (const blk of blocks) {
    const { vals } = blk;
    for (let k = 0; k < BS; k++)
      for (let j = 0; j < BS; j++)
        for (let i = 0; i < BS; i++) {
          let neg = 0;
          for (let c = 0; c < 8; c++) {
            const v = vals[i + (c & 1) + S1 * (j + ((c >> 1) & 1) + S1 * (k + ((c >> 2) & 1)))];
            corner[c] = v;
            if (v < 0) neg++;
          }
          if (neg === 0 || neg === 8) continue;
          let sx = 0;
          let sy = 0;
          let sz = 0;
          let n = 0;
          for (const [a, b] of EDGES) {
            const va = corner[a];
            const vb = corner[b];
            if (va < 0 === vb < 0) continue;
            const t = va / (va - vb);
            sx += (a & 1) + ((b & 1) - (a & 1)) * t;
            sy += ((a >> 1) & 1) + (((b >> 1) & 1) - ((a >> 1) & 1)) * t;
            sz += ((a >> 2) & 1) + (((b >> 2) & 1) - ((a >> 2) & 1)) * t;
            n++;
          }
          const gx = blk.bx * BS + i;
          const gy = blk.by * BS + j;
          const gz = blk.bz * BS + k;
          vIndex.set(gx + nx * (gy + ny * gz), pos.length / 3);
          pos.push(lo[0] + (gx + sx / n) * h, lo[1] + (gy + sy / n) * h, lo[2] + (gz + sz / n) * h);
          vmask.push(blk.mask);
        }
  }
  // faces: one quad per sign-changing grid edge
  const idx: number[] = [];
  const P = pos;
  const quad = (a: number, b: number, c: number, d: number) => {
    // split along the shorter diagonal
    const d1 = (P[a * 3] - P[c * 3]) ** 2 + (P[a * 3 + 1] - P[c * 3 + 1]) ** 2 + (P[a * 3 + 2] - P[c * 3 + 2]) ** 2;
    const d2 = (P[b * 3] - P[d * 3]) ** 2 + (P[b * 3 + 1] - P[d * 3 + 1]) ** 2 + (P[b * 3 + 2] - P[d * 3 + 2]) ** 2;
    if (d1 < d2) idx.push(a, b, c, a, c, d);
    else idx.push(a, b, d, b, c, d);
  };
  const cell = (gx: number, gy: number, gz: number) => vIndex.get(gx + nx * (gy + ny * gz));
  for (const blk of blocks) {
    const { vals } = blk;
    for (let k = 0; k < BS; k++)
      for (let j = 0; j < BS; j++)
        for (let i = 0; i < BS; i++) {
          const v0 = vals[i + S1 * (j + S1 * k)];
          const gx = blk.bx * BS + i;
          const gy = blk.by * BS + j;
          const gz = blk.bz * BS + k;
          // +x edge
          const vx = vals[i + 1 + S1 * (j + S1 * k)];
          if (v0 < 0 !== vx < 0 && gy > 0 && gz > 0) {
            const a = cell(gx, gy, gz);
            const b = cell(gx, gy - 1, gz);
            const c = cell(gx, gy - 1, gz - 1);
            const d = cell(gx, gy, gz - 1);
            if (a !== undefined && b !== undefined && c !== undefined && d !== undefined) {
              if (v0 < 0) quad(a, b, c, d);
              else quad(a, d, c, b);
            }
          }
          const vy = vals[i + S1 * (j + 1 + S1 * k)];
          if (v0 < 0 !== vy < 0 && gx > 0 && gz > 0) {
            const a = cell(gx, gy, gz);
            const b = cell(gx, gy, gz - 1);
            const c = cell(gx - 1, gy, gz - 1);
            const d = cell(gx - 1, gy, gz);
            if (a !== undefined && b !== undefined && c !== undefined && d !== undefined) {
              if (v0 < 0) quad(a, b, c, d);
              else quad(a, d, c, b);
            }
          }
          const vz = vals[i + S1 * (j + S1 * (k + 1))];
          if (v0 < 0 !== vz < 0 && gx > 0 && gy > 0) {
            const a = cell(gx, gy, gz);
            const b = cell(gx - 1, gy, gz);
            const c = cell(gx - 1, gy - 1, gz);
            const d = cell(gx, gy - 1, gz);
            if (a !== undefined && b !== undefined && c !== undefined && d !== undefined) {
              if (v0 < 0) quad(a, b, c, d);
              else quad(a, d, c, b);
            }
          }
        }
  }
  // project vertices onto the surface, normals from the gradient
  const nV = pos.length / 3;
  const out = new Float32Array(pos.length);
  const nor = new Float32Array(pos.length);
  const e = h * 0.2;
  const grad = (x: number, y: number, z: number, m: number): V => {
    // tetrahedral differences
    const a = handSDF(S, x + e, y - e, z - e, m);
    const b = handSDF(S, x - e, y - e, z + e, m);
    const c = handSDF(S, x - e, y + e, z - e, m);
    const d = handSDF(S, x + e, y + e, z + e, m);
    return [a - b - c + d, -a - b + c + d, -a + b - c + d];
  };
  for (let v = 0; v < nV; v++) {
    let x = pos[v * 3];
    let y = pos[v * 3 + 1];
    let z = pos[v * 3 + 2];
    const m = vmask[v];
    for (let it = 0; it < 3; it++) {
      const d = handSDF(S, x, y, z, m);
      const g = nrm(grad(x, y, z, m));
      const step = Math.max(-h, Math.min(h, d));
      x -= g[0] * step;
      y -= g[1] * step;
      z -= g[2] * step;
    }
    const g = nrm(grad(x, y, z, m));
    out[v * 3] = x;
    out[v * 3 + 1] = y;
    out[v * 3 + 2] = z;
    nor[v * 3] = g[0];
    nor[v * 3 + 1] = g[1];
    nor[v * 3 + 2] = g[2];
  }
  // make the winding agree with the field normal
  const I = new Uint32Array(idx);
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3;
    const b = I[t + 1] * 3;
    const c = I[t + 2] * 3;
    const ux = out[b] - out[a];
    const uy = out[b + 1] - out[a + 1];
    const uz = out[b + 2] - out[a + 2];
    const wx = out[c] - out[a];
    const wy = out[c + 1] - out[a + 1];
    const wz = out[c + 2] - out[a + 2];
    const cx = uy * wz - uz * wy;
    const cy = uz * wx - ux * wz;
    const cz = ux * wy - uy * wx;
    const nx_ = nor[a] + nor[b] + nor[c];
    const ny_ = nor[a + 1] + nor[b + 1] + nor[c + 1];
    const nz_ = nor[a + 2] + nor[b + 2] + nor[c + 2];
    if (cx * nx_ + cy * ny_ + cz * nz_ < 0) {
      const tmp = I[t + 1];
      I[t + 1] = I[t + 2];
      I[t + 2] = tmp;
    }
  }
  return { pos: out, nrm: nor, idx: I, masks: new Int32Array(vmask) };
};


/* ================================================================== */
/* Hand geometry: skin weights and shading attributes                  */
/* ================================================================== */

/** Mesh resolution (m). */
const CELL = 0.0006;

type HandGeo = {
  /** rest geometry with every attribute; instances clone position/normal for skinning */
  geo: THREE.BufferGeometry;
  restPos: Float32Array;
  restNrm: Float32Array;
  skinIdx: Uint8Array;
  skinW: Float32Array;
};

/** joint kind of the joint at the proximal end of each bone: 1 MCP, 2 PIP, 3 DIP, 4 thumb MCP, 5 thumb IP */
const JOINT_KIND: number[] = new Array(NB).fill(0);
for (let f = 0; f < 4; f++) {
  JOINT_KIND[ph(f, 0)] = 1;
  JOINT_KIND[ph(f, 1)] = 2;
  JOINT_KIND[ph(f, 2)] = 3;
}
JOINT_KIND[TP1] = 4;
JOINT_KIND[TP2] = 5;
const CHILD: number[] = new Array(NB).fill(-1);
for (let b = 0; b < NB; b++) if (PARENT[b] > 1) CHILD[PARENT[b]] = b;
const isDistal = (b: number) => b === TP2 || (b >= 2 && b < 14 && (b - 2) % 3 === 2);

/** cuff (wristband) span along the forearm, FORE-frame y (m) */
const CUFF_Y0 = -0.0165;
const CUFF_Y1 = -0.078;
/** forearm half-width / half-thickness (m) along FORE-frame y (negative toward the elbow) */
const forearmProfile = (y: number): [number, number] => {
  const t = sstep(0, 1, (-y - 0.05) / 0.19);
  return [0.0313 + 0.0062 * t, 0.0221 + 0.0085 * t];
};
const cuffOffset = (s: number) => {
  // s 0..1 across the band: rolled edges tuck into the skin, a soft crown in the middle
  const e = Math.abs(2 * s - 1);
  return 0.0043 * Math.pow(Math.max(0, 1 - Math.pow(e, 7)), 0.3) - 0.0016;
};

let handGeoCache: HandGeo | null = null;

const buildHandGeo = (): HandGeo => {
  if (handGeoCache) return handGeoCache;
  const rig = getRig();
  const S = buildPrims(rig);
  const lo: V = [1, 1, 1];
  const hi: V = [-1, -1, -1];
  const grow = (p: V, m: number) => {
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], p[a] - m);
      hi[a] = Math.max(hi[a], p[a] + m);
    }
  };
  rig.rest.forEach((F, b) => {
    if (b === FORE) return;
    for (let s = 0; s <= 4; s++) grow(fPt(F, [0, (BONE_LEN[b] * s) / 4, 0]), b === PALM ? 0.04 : 0.016);
  });
  grow(fPt(rig.rest[FORE], [0, CAP_Y, 0]), 0.04);
  const raw = meshHand(S, lo, hi, CELL);
  const nV = raw.pos.length / 3;
  const skinIdx = new Uint8Array(nV * 4);
  const skinW = new Float32Array(nV * 4);
  const aRest = new Float32Array(nV * 3);
  const aJ = new Float32Array(nV * 4);
  const aK = new Float32Array(nV * 4);
  const aM = new Float32Array(nV * 4);
  const aN = new Float32Array(nV * 3);
  const jbOf = new Int16Array(nV);
  const db = new Float64Array(NB);
  const fore = rig.rest[FORE];
  // occluders for the baked AO: the hand itself and the ball; the cuff separately (it is optional)
  const occ = (x: number, y: number, z: number, mask: number) => {
    const d = handSDF(S, x, y, z, mask);
    const rb = Math.sqrt(x * x + y * y + z * z) - R;
    return rb < d ? rb : d;
  };
  const cuffDist = (x: number, y: number, z: number) => {
    const q = fLoc(fore, [x, y, z]);
    const [hw, ht] = forearmProfile(q[1]);
    const ec = (Math.sqrt((q[0] / (hw + 0.0027)) ** 2 + (q[2] / (ht + 0.0027)) ** 2) - 1) * (ht + 0.0027);
    return Math.max(ec, q[1] - CUFF_Y0, CUFF_Y1 - q[1]);
  };
  const aC = new Float32Array(nV).fill(1);
  for (let v = 0; v < nV; v++) {
    const x = raw.pos[v * 3];
    const y = raw.pos[v * 3 + 1];
    const z = raw.pos[v * 3 + 2];
    const n: V = [raw.nrm[v * 3], raw.nrm[v * 3 + 1], raw.nrm[v * 3 + 2]];
    aRest[v * 3] = x;
    aRest[v * 3 + 1] = y;
    aRest[v * 3 + 2] = z;
    /* ---- skin weights (bones outside the block's relevance mask have no influence) ---- */
    boneDists(S, x, y, z, raw.masks[v], db);
    let dmin = 1e9;
    for (let b = 0; b < NB; b++) dmin = Math.min(dmin, db[b]);
    const w: [number, number][] = [];
    for (let b = 0; b < NB; b++) {
      const sigma = b === FORE || b === PALM ? 0.0035 : 0.0016;
      const ww = Math.exp(-(db[b] - dmin) / sigma);
      if (ww > 0.01) w.push([b, ww]);
    }
    w.sort((a, b) => b[1] - a[1]);
    const top = w.slice(0, 4);
    const sum = top.reduce((s, a) => s + a[1], 0);
    top.forEach(([b, ww], i) => {
      skinIdx[v * 4 + i] = b;
      skinW[v * 4 + i] = ww / sum;
    });
    const dom = top[0][0];
    const p: V = [x, y, z];
    /* ---- feature joint: the nearest joint along the dominant digit ---- */
    let jb = -1;
    // fade of the feature confidence toward the edge of a joint's region (no hard switch-over line)
    let regionFade = 1;
    if (dom === PALM) {
      let best = 0.016;
      for (let f = 0; f < 4; f++) {
        const dd = vlen(sub(p, rig.rest[ph(f, 0)].o));
        if (dd < best) {
          best = dd;
          jb = ph(f, 0);
        }
      }
      regionFade = 1 - sstep(0.0105, 0.015, best);
    } else if (dom === TMC) {
      jb = TP1;
      regionFade = 1 - sstep(0.013, 0.019, vlen(sub(p, rig.rest[TP1].o)));
    } else if (dom !== FORE) {
      const cands = [dom, CHILD[dom]].filter((b) => b >= 0 && JOINT_KIND[b] > 0);
      let best = 1e9;
      for (const b of cands) {
        const u = Math.abs(fLoc(rig.rest[b], p)[1]);
        if (u < best) {
          best = u;
          jb = b;
        }
      }
    }
    jbOf[v] = jb;
    if (jb >= 0) {
      const q = fLoc(rig.rest[jb], p);
      const r = BONE_RAD[jb][0];
      aJ[v * 4] = q[1] * 1000;
      aJ[v * 4 + 1] = q[2] * 1000;
      aJ[v * 4 + 2] = q[0] * 1000;
      aJ[v * 4 + 3] = r * 1000;
      const kind = JOINT_KIND[jb];
      // [dorsal wrinkle strength, palmar crease 1 (mm along), crease 2]
      const feat: [number, number, number] =
        kind === 1
          ? [0.3, BONE_LEN[jb] * 370, 999]
          : kind === 2
            ? [1, -0.9, 0.95]
            : kind === 3
              ? [0.7, -0.6, 999]
              : kind === 4
                ? [0.65, -1.3, 1.5]
                : [0.9, -0.35, 999];
      aK[v * 4] = feat[0];
      aK[v * 4 + 1] = feat[1];
      aK[v * 4 + 2] = feat[2];
      aK[v * 4 + 3] = kind;
      if (isDistal(jb) && (dom === jb || CHILD[dom] === jb || dom === PARENT[jb])) {
        aN[v * 3] = BONE_LEN[jb] * 1000;
        aN[v * 3 + 1] = dom === jb ? 1 : 0;
      }
      // confidence: 0 where the nearest joint switches (mid-bone), so interpolated features never streak
      const segL = q[1] >= 0 ? BONE_LEN[jb] : PARENT[jb] >= 2 ? BONE_LEN[PARENT[jb]] : 0.03;
      aN[v * 3 + 2] = (isDistal(jb) && q[1] >= 0 ? 1 : 1 - sstep(0.34 * segL, 0.44 * segL, Math.abs(q[1]))) * regionFade;
    } else {
      aJ[v * 4] = 999;
      aJ[v * 4 + 3] = 10;
      aK[v * 4 + 1] = 999;
      aK[v * 4 + 2] = 999;
    }
    /* ---- AO, thickness, pigment side, dorsum mask ---- */
    let o = 0;
    let oc = 0;
    let sca = 1;
    let aoMask = 0;
    for (let b = 0; b < NB; b++) if (db[b] < 0.016) aoMask |= 1 << b;
    for (let i = 1; i <= 5; i++) {
      const hh = 0.0013 * i;
      const px = x + n[0] * hh;
      const py = y + n[1] * hh;
      const pz = z + n[2] * hh;
      const d = occ(px, py, pz, aoMask);
      const dc = Math.min(d, cuffDist(px, py, pz));
      o += Math.max(0, hh - d) * sca;
      oc += Math.max(0, hh - dc) * sca;
      sca *= 0.6;
    }
    const ao = clamp01(1 - (o / 0.0042) * 1.25);
    // extra occlusion from the cuff as a factor, applied only when the cuff is worn
    const aoC = clamp01(1 - (oc / 0.0042) * 1.25);
    aC[v] = ao > 1e-3 ? Math.min(1, aoC / ao) : 1;
    // palm side: blended over the skinning bones so it never jumps between bones
    let palmar = 0;
    for (let i = 0; i < 4; i++) {
      const wb = skinW[v * 4 + i];
      if (!wb) continue;
      const b = skinIdx[v * 4 + i];
      // position around the bone axis: the palmar / dorsal border runs along the mid-lateral line
      const ql = fLoc(rig.rest[b], p);
      const rr = b === PALM ? 0.012 : b === FORE ? 0.02 : BONE_RAD[b][0];
      const zc = b === PALM ? ql[2] + 0.0005 : ql[2];
      const pb = sstep(0.18, -0.3, zc / rr);
      palmar += wb * (b === FORE ? 0.5 * pb : pb);
    }
    // thickness proxy for translucency, blended over the skinning bones
    let thick = 0;
    for (let i = 0; i < 4; i++) {
      const wb = skinW[v * 4 + i];
      if (!wb) continue;
      const b = skinIdx[v * 4 + i];
      const tb = b === PALM ? 0.03 : b === FORE ? 0.044 : b === TMC ? 0.028 : 2 * (BONE_RAD[b][0] + BONE_RAD[b][1]) * 0.45;
      thick += wb * tb;
    }
    let palmW = 0;
    for (let i = 0; i < 4; i++) if (skinIdx[v * 4 + i] === PALM || skinIdx[v * 4 + i] === FORE) palmW += skinW[v * 4 + i];
    aM[v * 4] = ao;
    aM[v * 4 + 1] = sstep(0.026, 0.014, thick);
    aM[v * 4 + 2] = palmar;
    aM[v * 4 + 3] = palmW;
  }
  // where neighbouring vertices measure their features from different joints, the interpolated joint
  // coordinates sweep through every value inside the triangle: switch the features off along that border
  {
    const I = raw.idx;
    const off = new Uint8Array(nV);
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t];
      const b = I[t + 1];
      const c = I[t + 2];
      if (jbOf[a] !== jbOf[b] || jbOf[a] !== jbOf[c]) off[a] = off[b] = off[c] = 1;
    }
    for (let v = 0; v < nV; v++) if (off[v]) aN[v * 3 + 2] = 0;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(raw.pos.slice(), 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(raw.nrm.slice(), 3));
  geo.setAttribute("aRest", new THREE.BufferAttribute(aRest, 3));
  geo.setAttribute("aJ", new THREE.BufferAttribute(aJ, 4));
  geo.setAttribute("aK", new THREE.BufferAttribute(aK, 4));
  geo.setAttribute("aM", new THREE.BufferAttribute(aM, 4));
  geo.setAttribute("aN", new THREE.BufferAttribute(aN, 3));
  geo.setAttribute("aC", new THREE.BufferAttribute(aC, 1));
  geo.setIndex(new THREE.BufferAttribute(raw.idx, 1));
  geo.computeBoundingSphere();
  handGeoCache = { geo, restPos: raw.pos, restNrm: raw.nrm, skinIdx, skinW };
  return handGeoCache;
};

/* ---- forearm (bare skin beyond the cuff) and the knitted cuff: rigid on the FORE bone ---- */

const neutralSkinAttrs = (g: THREE.BufferGeometry, palmarOf: (i: number) => number) => {
  const n = g.attributes.position.count;
  const aRest = new Float32Array(n * 3);
  aRest.set((g.attributes.position.array as Float32Array).subarray(0, n * 3));
  const aJ = new Float32Array(n * 4);
  const aK = new Float32Array(n * 4);
  const aM = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    aJ[i * 4] = 999;
    aJ[i * 4 + 3] = 10;
    aK[i * 4 + 1] = 999;
    aK[i * 4 + 2] = 999;
    aM[i * 4] = 1;
    aM[i * 4 + 2] = palmarOf(i);
    aM[i * 4 + 3] = 1;
  }
  g.setAttribute("aRest", new THREE.BufferAttribute(aRest, 3));
  g.setAttribute("aJ", new THREE.BufferAttribute(aJ, 4));
  g.setAttribute("aK", new THREE.BufferAttribute(aK, 4));
  g.setAttribute("aM", new THREE.BufferAttribute(aM, 4));
  g.setAttribute("aN", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute("aC", new THREE.BufferAttribute(new Float32Array(n).fill(1), 1));
};

/** Loft rings along FORE-frame y; ring(y, theta) -> [x, z] offset in the frame. Geometry in hand space (rest). */
const loft = (ys: number[], seg: number, ring: (y: number, th: number, j: number) => [number, number], fore: Frame, cap: boolean) => {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  ys.forEach((y, j) => {
    for (let i = 0; i <= seg; i++) {
      const th = (i / seg) * Math.PI * 2;
      const [x, z] = ring(y, th, j);
      pos.push(...fPt(fore, [x, y, z]));
      uv.push(i / seg, j / (ys.length - 1));
    }
  });
  const W = seg + 1;
  for (let j = 0; j < ys.length - 1; j++)
    for (let i = 0; i < seg; i++) {
      const a = j * W + i;
      const b = a + W;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  if (cap) {
    const c = pos.length / 3;
    const yl = ys[ys.length - 1];
    pos.push(...fPt(fore, [0, yl - 0.004, 0]));
    uv.push(0.5, 1);
    const base = (ys.length - 1) * W;
    for (let i = 0; i < seg; i++) idx.push(base + i + 1, base + i, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // orient: normals must point away from the forearm axis
  const p = g.attributes.position;
  const nn = g.attributes.normal;
  const a0: V = [p.getX(1), p.getY(1), p.getZ(1)];
  const ax = fLoc(fore, a0);
  const out = fDir(fore, [ax[0], 0, ax[2]]);
  if (dot([nn.getX(1), nn.getY(1), nn.getZ(1)], out) < 0) {
    const ii = g.index!.array as Uint32Array | Uint16Array;
    for (let k = 0; k < ii.length; k += 3) {
      const tmp = ii[k + 1];
      ii[k + 1] = ii[k + 2];
      ii[k + 2] = tmp;
    }
    g.computeVertexNormals();
  }
  return g;
};

let armGeoCache: { forearm: THREE.BufferGeometry; cuff: THREE.BufferGeometry } | null = null;
const buildArmGeo = () => {
  if (armGeoCache) return armGeoCache;
  const fore = getRig().rest[FORE];
  // muscle relief on the forearm: a slightly flattened, asymmetric ellipse
  const ys: number[] = [];
  for (let y = -0.046; y >= -0.27; y -= 0.0045) ys.push(y);
  const forearm = loft(
    ys,
    96,
    (y, th) => {
      // where it overlaps the hand mesh the loft follows the hand SDF's forearm cone exactly (elliptical,
      // centred 1 mm dorsal): just inside it, then flared 0.15 mm past its capped rim at CAP_Y; further
      // up the arm it blends into the muscle profile
      const rc = FORE_CONE.ra + ((FORE_CONE.rb - FORE_CONE.ra) * (y - FORE_CONE.y0)) / FORE_CONE.len;
      const [pw, pt] = forearmProfile(y);
      const k = sstep(-0.052, -0.085, y);
      const hw = rc * FORE_CONE.sx + (pw - rc * FORE_CONE.sx) * k;
      const ht = rc + (pt - rc) * k;
      const zc = FORE_CONE.z * (1 - k);
      const s = 0.996 + 0.011 * sstep(-0.047, -0.0505, y);
      const bulge = 1 + 0.035 * Math.cos(th - 0.6) * sstep(0.08, 0.2, -y);
      return [Math.cos(th) * hw * s * bulge, zc + Math.sin(th) * ht * s * bulge];
    },
    fore,
    true,
  );
  {
    // palmar / dorsal pigment exactly as the hand mesh assigns it to forearm-dominated vertices
    const pp = forearm.attributes.position;
    neutralSkinAttrs(forearm, (i) => {
      const q = fLoc(fore, [pp.getX(i), pp.getY(i), pp.getZ(i)]);
      return 0.5 * sstep(0.18, -0.3, q[2] / 0.02);
    });
  }
  const cys: number[] = [];
  const NC = 70;
  for (let j = 0; j <= NC; j++) {
    // denser at the rolled edges
    const u = j / NC;
    const s = 0.5 - 0.5 * Math.cos(u * Math.PI);
    cys.push(CUFF_Y0 + (CUFF_Y1 - CUFF_Y0) * (0.5 * s + 0.5 * u));
  }
  const cuff = loft(
    cys,
    180,
    (y, th) => {
      const [hw, ht] = forearmProfile(y);
      const s = (y - CUFF_Y0) / (CUFF_Y1 - CUFF_Y0);
      const off = cuffOffset(s);
      // offset along the ellipse normal
      const ex = Math.cos(th) * hw;
      const ez = Math.sin(th) * ht;
      const nx = Math.cos(th) / hw;
      const nz = Math.sin(th) / ht;
      const nl = Math.hypot(nx, nz);
      return [ex + (nx / nl) * off, ez + (nz / nl) * off];
    },
    fore,
    false,
  );
  armGeoCache = { forearm, cuff };
  return armGeoCache;
};

/* ================================================================== */
/* Ball geometry and stitches (matches the ball of SPEC §6.2)          */
/* ================================================================== */

/** stitch rows: arc distance from the seam centre line (m), 82 stitches per row, as the film's Ball */
const ROWS = [0.0021, 0.00385, 0.0056];
const NST = 82;
const seamHeight = (s: number) => {
  const as = Math.abs(s);
  return 0.00078 * Math.exp(-((as / 0.00115) ** 2)) + 0.00012 * (1 - sstep(0.0062, 0.0072, as));
};

let ballGeoCache: { ball: THREE.BufferGeometry; stitch: THREE.BufferGeometry; stitchM: THREE.Matrix4[] } | null = null;
const buildBallGeo = () => {
  if (ballGeoCache) return ballGeoCache;
  const lon = 256;
  const lat = 176;
  const pos: number[] = [];
  const nr: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= lat; j++) {
    const u = (j / lat) * 2 - 1;
    const th = (Math.PI / 2) * (0.25 * u + 0.75 * u * u * u);
    for (let i = 0; i <= lon; i++) {
      const p = (i / lon) * Math.PI * 2;
      const x = Math.cos(th) * Math.cos(p);
      const y = Math.sin(th);
      const z = Math.cos(th) * Math.sin(p);
      pos.push(x * R, y * R, z * R);
      nr.push(x, y, z);
    }
  }
  for (let j = 0; j < lat; j++)
    for (let i = 0; i < lon; i++) {
      const a = j * (lon + 1) + i;
      const b = a + lon + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  const ball = new THREE.BufferGeometry();
  ball.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  ball.setAttribute("normal", new THREE.Float32BufferAttribute(nr, 3));
  ball.setIndex(idx);
  ball.computeBoundingSphere();
  // one stitch: a plump thread loop, unit size, long axis +X, up +Y
  const stitch = new THREE.SphereGeometry(1, 10, 6);
  {
    const p = stitch.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      // flatten the underside into the leather
      p.setY(i, y < 0 ? y * 0.35 : y);
    }
    stitch.computeVertexNormals();
  }
  const stitchM: THREE.Matrix4[] = [];
  const m = new THREE.Matrix4();
  for (let side = -1; side <= 1; side += 2)
    for (let k = 0; k < 3; k++) {
      const s = ROWS[k];
      const beta = (side * s) / R;
      const slant = (k === 1 ? -1 : 1) * side * 0.55;
      const phase = k * 0.33 + (side > 0 ? 0 : 0.5);
      for (let i = 0; i < NST; i++) {
        const phi = ((i + phase) / NST) * Math.PI * 2;
        const n = new THREE.Vector3(Math.cos(beta) * Math.cos(phi), Math.sin(beta), Math.cos(beta) * Math.sin(phi));
        const tAlong = new THREE.Vector3(-Math.sin(phi), 0, Math.cos(phi));
        const tAcross = new THREE.Vector3().crossVectors(n, tAlong).normalize();
        const ax = tAlong.clone().multiplyScalar(Math.cos(slant)).addScaledVector(tAcross, Math.sin(slant)).normalize();
        const az = new THREE.Vector3().crossVectors(ax, n).normalize();
        const jitter = 0.92 + 0.16 * (Math.abs(Math.sin(i * 12.9898 + k * 78.233 + side * 3.1) * 43758.5453) % 1);
        const h = seamHeight(s);
        const c = n.clone().multiplyScalar(R + h + 0.00003);
        m.makeBasis(ax.clone().multiplyScalar(0.00128 * jitter), n.clone().multiplyScalar(0.0003), az.clone().multiplyScalar(0.00036));
        m.setPosition(c);
        stitchM.push(m.clone());
      }
    }
  ballGeoCache = { ball, stitch, stitchM };
  return ballGeoCache;
};

/* ================================================================== */
/* Animation (pure function of t)                                      */
/* ================================================================== */

const smoother = (x: number) => {
  const t = clamp01(x);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
const tw = (t: number, t0: number, dur: number) => smoother((t - t0) / dur);
const pulse = (t: number, t0: number, dur: number) => {
  const x = (t - t0) / dur;
  return x <= 0 || x >= 1 ? 0 : Math.sin(Math.PI * x) ** 2;
};

/** seam tilt about the forward axis, seam yaw, and leather turn about the seam normal: before / after each handle cue */
const ROLL = [0.3, 0.17, 0.055, 0];
const YAW = [-0.24, -0.12, -0.035, 0];
const SPIN = [-0.5, -0.27, -0.09, 0];

export type MacroHandState = {
  /** bone frames in hand space (root motion included) */
  frames: Frame[];
  /** root motion: breathing lift and the start of the run (hand space) */
  root: Frame;
  /** the ball's carrier frame (hand space): the palm's motion, so the ball moves with the hand that holds
   *  it (wrist cock on the inhale included); the ball's own turn in the fingers is ballQ */
  ball: Frame;
  /** ball orientation relative to the root */
  ballQ: THREE.Quaternion;
  /** grip tension 0..1 (tendons on the back of the hand, firmer pads) */
  tension: number;
  /** relative azimuth of the travelling LED reflection segment on the lacquer (rad, -1.4 .. 1.4) */
  ledSweep: number;
};

const qAxis = (x: number, y: number, z: number, a: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(x, y, z), a);
const BALL_BASE_Q = qAxis(0, 0, 1, -Math.PI / 2); // ball seam normal (local +Y) along hand +X

/** Pure function of t: bone frames, ball orientation, tension, LED sweep. */
export const macroHandState = (t: number, rootMotion = true): MacroHandState => {
  const rig = getRig();
  const [h0, h1, h2] = MACRO_T.handle;
  const hs = [h0, h1, h2];
  // each ball_handle cue: the fingers roll the ball (motion starts 2 frames before the cue)
  const roll3 = [tw(t, h0 - 0.06, 0.34), tw(t, h1 - 0.06, 0.36), tw(t, h2 - 0.05, 0.3)];
  let roll = ROLL[0];
  let yaw = YAW[0];
  let spin = SPIN[0];
  let carry = 0;
  let lift = 0;
  for (let i = 0; i < 3; i++) {
    roll += (ROLL[i + 1] - ROLL[i]) * roll3[i];
    yaw += (YAW[i + 1] - YAW[i]) * roll3[i];
    spin += (SPIN[i + 1] - SPIN[i]) * roll3[i];
    // fingers travel with the leather, then lift a hair and re-settle astride the seam
    carry += (ROLL[i + 1] - ROLL[i]) * (roll3[i] - tw(t, hs[i] + 0.26, 0.42));
    lift += pulse(t, hs[i] + 0.22, 0.46);
  }
  const tight = tw(t, h2 + 0.24, 0.5);
  let breath = 0;
  for (const b of MACRO_T.breath) {
    const x = t - b;
    // inhale: zero start velocity but an early peak (u = 1/3), so the lift reads on the breath cue even
    // while the previous breath is still settling; then a long exhale
    const u = x / 0.6;
    if (x > 0) breath += x < 0.6 ? 1 - (1 - u) ** 3 * (1 + 3 * u) : 1 - smoother((x - 0.6) / 1.1);
  }
  const live = Math.sin(t * 2.3 + 0.4) * 0.6 + Math.sin(t * 3.9 + 1.3) * 0.4;

  // root: breathing lifts the wrist about the elbow; the run starts at runStart
  let root: Frame = ID;
  if (rootMotion) {
    const elbow = fPt(rig.rest[FORE], [0, -0.27, 0]);
    root = fRotAxis(root, elbow, [1, 0, 0], 0.016 * breath + 0.0012 * live);
    const tr = Math.max(0, t - MACRO_T.runStart);
    if (tr > 0) {
      const a = 2.2; // m/s^2: the first push of the run-up
      const d = 0.5 * a * tr * tr;
      root = fRotAxis(root, elbow, [1, 0, 0], -1.3 * d);
      root = { ...root, o: add(root.o, [0, -0.25 * d, -d]) };
    }
  }

  // joint deltas [x: -flex, y: twist, z: -abduction] per bone
  const dl: V[] = Array.from({ length: NB }, () => [0, 0, 0] as V);
  const abdCarry = (carry * R) / 0.062; // rolling the top of the ball sideways carries index and middle with it
  for (const f of [0, 1]) {
    dl[ph(f, 0)][2] += abdCarry;
    dl[ph(f, 0)][0] += 0.035 * lift - 0.018 * tight + 0.003 * live;
    dl[ph(f, 1)][0] += 0.035 * lift - 0.045 * tight;
    dl[ph(f, 2)][0] += 0.02 * lift - 0.05 * tight;
  }
  dl[ph(2, 1)][0] += -0.03 * tight + 0.01 * lift;
  dl[ph(2, 2)][0] += -0.03 * tight;
  dl[ph(3, 1)][0] += -0.035 * tight;
  dl[TP1][0] += -0.03 * tight + 0.02 * lift;
  dl[TP2][0] += -0.05 * tight + 0.03 * lift;
  dl[TMC][2] += -abdCarry * 0.5;
  dl[PALM][0] += -0.025 * breath; // the wrist cocks a touch on the inhale

  const frames: Frame[] = [];
  for (let b = 0; b < NB; b++) {
    const d = dl[b];
    let L = rig.local[b];
    if (d[0] || d[1] || d[2]) L = fRotY(fRotX(fRotZ(L, d[2]), d[0]), d[1]);
    frames[b] = PARENT[b] < 0 ? fMul(root, L) : fMul(frames[PARENT[b]], L);
  }
  const ballQ = qAxis(0, 1, 0, yaw).multiply(qAxis(0, 0, 1, roll)).multiply(qAxis(1, 0, 0, spin)).multiply(BALL_BASE_Q);
  const ledSweep = -1.35 + 2.7 * sstep(0.15, 1.9, t);
  const ball = fMul(frames[PALM], fInv(rig.rest[PALM]));
  return { frames, root, ball, ballQ, tension: tight, ledSweep };
};

/** Hand-space centre of the ball at time t (includes the root motion). Useful for focus pulls. */
export const macroBallCenter = (t: number, rootMotion = true): Vec3 => {
  const st = macroHandState(t, rootMotion);
  return [st.ball.o[0], st.ball.o[1], st.ball.o[2]];
};

/**
 * World point for the depth-of-field focus: the seam on the near side of the ball (assumes the hand group
 * is only translated to `handPos`, as in S02). Pass the camera position.
 */
export const macroSeamFocus = (t: number, handPos: Vec3, cam: Vec3, rootMotion = true): Vec3 => {
  const st = macroHandState(t, rootMotion);
  const c = st.ball.o;
  const w: V = [handPos[0] + c[0], handPos[1] + c[1], handPos[2] + c[2]];
  // seam plane normal (ball-local +Y) in hand space
  const q = new THREE.Quaternion(...rootQuat(st.ball)).multiply(st.ballQ);
  const n = new THREE.Vector3(0, 1, 0).applyQuaternion(q).toArray() as V;
  // the point of the seam ring nearest the camera; seen along the normal every seam point is equally far,
  // so lean toward the top of the ball (between the fingers)
  const d = sub([cam[0], cam[1], cam[2]], w);
  let inPlane = sub(d, mul(n, dot(d, n)));
  const k = vlen(inPlane) / (vlen(d) || 1);
  const upIn = sub([0, 1, 0], mul(n, n[1]));
  inPlane = add(mul(nrm(inPlane), sstep(0.05, 0.35, k)), mul(nrm(upIn), 1 - sstep(0.05, 0.35, k)));
  const p = mul(nrm(inPlane), R + 0.0008);
  return [w[0] + p[0], w[1] + p[1], w[2] + p[2]];
};

const frameMatrix = (F: Frame, m = new THREE.Matrix4()) =>
  m.set(F.x[0], F.y[0], F.z[0], F.o[0], F.x[1], F.y[1], F.z[1], F.o[1], F.x[2], F.y[2], F.z[2], F.o[2], 0, 0, 0, 1);

/** CPU linear-blend skinning of the hand mesh into `pos` / `nor`; pads pressed into the ball are pushed back onto the leather */
const skinHand = (hg: HandGeo, frames: Frame[], ball: Frame, pos: Float32Array, nor: Float32Array) => {
  const rest = getRig().rest;
  const M = new Float64Array(NB * 12);
  for (let b = 0; b < NB; b++) {
    const D = fMul(frames[b], fInv(rest[b]));
    M.set([D.x[0], D.x[1], D.x[2], D.y[0], D.y[1], D.y[2], D.z[0], D.z[1], D.z[2], D.o[0], D.o[1], D.o[2]], b * 12);
  }
  const { restPos, restNrm, skinIdx, skinW } = hg;
  const n = restPos.length / 3;
  const bc = ball.o;
  for (let v = 0; v < n; v++) {
    const x = restPos[v * 3];
    const y = restPos[v * 3 + 1];
    const z = restPos[v * 3 + 2];
    const nx = restNrm[v * 3];
    const ny = restNrm[v * 3 + 1];
    const nz = restNrm[v * 3 + 2];
    let px = 0;
    let py = 0;
    let pz = 0;
    let qx = 0;
    let qy = 0;
    let qz = 0;
    for (let i = 0; i < 4; i++) {
      const w = skinW[v * 4 + i];
      if (w === 0) continue;
      const o = skinIdx[v * 4 + i] * 12;
      px += w * (M[o] * x + M[o + 3] * y + M[o + 6] * z + M[o + 9]);
      py += w * (M[o + 1] * x + M[o + 4] * y + M[o + 7] * z + M[o + 10]);
      pz += w * (M[o + 2] * x + M[o + 5] * y + M[o + 8] * z + M[o + 11]);
      qx += w * (M[o] * nx + M[o + 3] * ny + M[o + 6] * nz);
      qy += w * (M[o + 1] * nx + M[o + 4] * ny + M[o + 7] * nz);
      qz += w * (M[o + 2] * nx + M[o + 5] * ny + M[o + 8] * nz);
    }
    // contact: never inside the leather
    const dx = px - bc[0];
    const dy = py - bc[1];
    const dz = pz - bc[2];
    const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (r < R_CONTACT) {
      const k = R_CONTACT / r;
      px = bc[0] + dx * k;
      py = bc[1] + dy * k;
      pz = bc[2] + dz * k;
    }
    const ql = Math.sqrt(qx * qx + qy * qy + qz * qz) || 1;
    pos[v * 3] = px;
    pos[v * 3 + 1] = py;
    pos[v * 3 + 2] = pz;
    nor[v * 3] = qx / ql;
    nor[v * 3 + 1] = qy / ql;
    nor[v * 3 + 2] = qz / ql;
  }
};

/** penumbra sharpness of the analytic hand shadows: half-angle ~0.5 / K rad (floodlight banks are broad) */
const SHADOW_K = 7;

/** capsules (hand space) approximating phalanges, thumb and palm: occluders for the ball / cuff AO */
const NCAP = 16;
const capsulesOf = (frames: Frame[], A: THREE.Vector4[], B: THREE.Vector4[]) => {
  let i = 0;
  for (let b = 2; b < NB; b++) {
    const F = frames[b];
    const L = BONE_LEN[b];
    const r = (BONE_RAD[b][0] + BONE_RAD[b][1]) * 0.5;
    const a = fPt(F, [0, isDistal(b) ? 0 : 0.002, 0]);
    const e = fPt(F, [0, L - (isDistal(b) ? BONE_RAD[b][1] : 0.002), 0]);
    A[i].set(a[0], a[1], a[2], r);
    B[i].set(e[0], e[1], e[2], 0);
    i++;
  }
  const P = frames[PALM];
  const a = fPt(P, [0.004, 0.018, -0.002]);
  const e = fPt(P, [0.004, 0.058, -0.002]);
  A[i].set(a[0], a[1], a[2], 0.021);
  B[i].set(e[0], e[1], e[2], 0);
};

/* ================================================================== */
/* Shading                                                             */
/* ================================================================== */

const lin = (hex: string) => new THREE.Color(hex);
const g3 = (c: THREE.Color) => `vec3(${c.r.toFixed(5)}, ${c.g.toFixed(5)}, ${c.b.toFixed(5)})`;

const GLSL_COMMON = /* glsl */ `
float mhHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float mhNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(mhHash(i), mhHash(i + vec3(1.0, 0.0, 0.0)), u.x),
                 mix(mhHash(i + vec3(0.0, 1.0, 0.0)), mhHash(i + vec3(1.0, 1.0, 0.0)), u.x), u.y),
             mix(mix(mhHash(i + vec3(0.0, 0.0, 1.0)), mhHash(i + vec3(1.0, 0.0, 1.0)), u.x),
                 mix(mhHash(i + vec3(0.0, 1.0, 1.0)), mhHash(i + vec3(1.0, 1.0, 1.0)), u.x), u.y), u.z);
}
// F1 / F2 cell distances: skin plates and leather pebbling
vec2 mhCell(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  float d1 = 8.0;
  float d2 = 8.0;
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec3 o = vec3(float(x), float(y), float(z));
    vec3 h = vec3(mhHash(i + o), mhHash(i + o + 17.31), mhHash(i + o + 41.7));
    vec3 r = o + h - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
  }
  return vec2(sqrt(d1), sqrt(d2));
}
// derivative-based bump: height h (metres) over the view-space surface
vec3 mhBump(vec3 pos, vec3 n, float h) {
  vec3 dpx = dFdx(pos);
  vec3 dpy = dFdy(pos);
  vec3 r1 = cross(dpy, n);
  vec3 r2 = cross(n, dpx);
  float det = dot(dpx, r1);
  vec3 grad = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
  return normalize(abs(det) * n - grad);
}
float mhSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * t);
}
`;

/** vertex side: hand-space position / normal and the hand -> view rotation (for light directions) */
const VERT_HAND_PARS = /* glsl */ `
uniform mat4 uLocalToHand;
varying vec3 vHP;
varying vec3 vHN;
varying vec3 vHR0;
varying vec3 vHR1;
varying vec3 vHR2;
`;
const vertHand = (instanced: boolean) => /* glsl */ `
{
  mat4 l2h = uLocalToHand${instanced ? " * instanceMatrix" : ""};
  vHP = (l2h * vec4(transformed, 1.0)).xyz;
  vHN = normalize(mat3(l2h) * objectNormal);
  mat3 hr = mat3(modelViewMatrix) * transpose(mat3(uLocalToHand));
  vHR0 = hr[0];
  vHR1 = hr[1];
  vHR2 = hr[2];
}
`;

/**
 * Contact occlusion and soft shadows from the hand, analytic: the phalanges, thumb and palm are capsules,
 * the ball a sphere (all in hand space). Every directional light is cone-traced against them, so the
 * fingers cast soft penumbras on the lacquer (floodlight banks are broad sources) and the ball shades the
 * pads, with no shadow map. Capsules the fragment sits on (its own bone, its neighbours) are skipped.
 */
const GLSL_CAPS = /* glsl */ `
uniform vec4 uCapA[${NCAP}];
uniform vec4 uCapB[${NCAP}];
uniform vec4 uBallC;
uniform float uShadowK;
uniform float uSkip;
varying vec3 vHP;
varying vec3 vHN;
varying vec3 vHR0;
varying vec3 vHR1;
varying vec3 vHR2;
float mhCapsAO(vec3 p, vec3 n) {
  float vis = 1.0;
  for (int i = 0; i < ${NCAP}; i++) {
    vec3 a = uCapA[i].xyz;
    vec3 ba = uCapB[i].xyz - a;
    float t = clamp(dot(p - a, ba) / dot(ba, ba), 0.0, 1.0);
    vec3 d = a + ba * t - p;
    float l = max(length(d), 1e-5);
    float r = uCapA[i].w;
    float o = clamp(dot(n, d / l) * 0.6 + 0.4, 0.0, 1.0) * (r * r) / (l * l);
    vis *= 1.0 - clamp(o * 1.15, 0.0, 0.92);
  }
  return vis;
}
float mhRayCap(vec3 ro, vec3 rd, vec3 a, vec3 b, float r) {
  vec3 ba = b - a;
  vec3 oa = ro - a;
  float oad = dot(oa, rd);
  float dba = dot(rd, ba);
  float baba = dot(ba, ba);
  float oaba = dot(oa, ba);
  vec2 th = vec2(-oad * baba + dba * oaba, oaba - oad * dba) / max(baba - dba * dba, 1e-12);
  th.x = max(th.x, 1e-4);
  th.y = clamp(th.y, 0.0, 1.0);
  vec3 pq = a + ba * th.y - (ro + rd * th.x);
  float d = length(pq) - r;
  float s = clamp(uShadowK * d / th.x + 0.5, 0.0, 1.0);
  return s * s * (3.0 - 2.0 * s);
}
float mhRaySph(vec3 ro, vec3 rd, vec3 c, float r) {
  vec3 oc = c - ro;
  float t = dot(oc, rd);
  if (t <= 0.0) return 1.0;
  float d = length(oc - rd * t) - r;
  float s = clamp(uShadowK * d / t + 0.5, 0.0, 1.0);
  return s * s * (3.0 - 2.0 * s);
}
// visibility of a directional light (view-space direction toward the light)
float mhVis(vec3 dirView) {
  if (uShadowK <= 0.0) return 1.0;
  vec3 rd = normalize(transpose(mat3(vHR0, vHR1, vHR2)) * dirView);
  vec3 ro = vHP;
  float v = 1.0;
  float cone = 0.5 / uShadowK;
  for (int i = 0; i < ${NCAP}; i++) {
    vec3 a = uCapA[i].xyz;
    vec3 b = uCapB[i].xyz;
    float r = uCapA[i].w;
    // bounding sphere of the capsule vs the penumbra cone around the ray: most capsules are culled here
    vec3 m = (a + b) * 0.5;
    float rb = length(b - a) * 0.5 + r;
    vec3 om = m - ro;
    float tm = dot(om, rd);
    if (tm < -rb) continue;
    if (length(om - rd * tm) - rb > max(tm, 0.0) * cone) continue;
    vec3 ba = b - a;
    float h = clamp(dot(ro - a, ba) / dot(ba, ba), 0.0, 1.0);
    if (length(ro - a - ba * h) < r * uSkip + 0.0012) continue;
    v *= mhRayCap(ro, rd, a, b, r * 0.92);
  }
  if (uBallC.w > 0.0) v *= mhRaySph(ro, rd, uBallC.xyz, uBallC.w);
  return v;
}
`;

/** physical lighting chunk with the analytic shadows applied to every direct light */
const shadowedLights = (chunk = THREE.ShaderChunk.lights_physical_pars_fragment) =>
  chunk
    .replace(
      "vec3 irradiance = dotNL * directLight.color;",
      // only surfaces the light reaches are traced; weak lights (the teal accent) are never traced
      "float mhV = dotNL > 0.0 && max( directLight.color.r, max( directLight.color.g, directLight.color.b ) ) > 0.5 ? mhVis( directLight.direction ) : 1.0;\n\tvec3 irradiance = dotNL * directLight.color * mhV;",
    )
    .replace("vec3 ccIrradiance = dotNLcc * directLight.color;", "vec3 ccIrradiance = dotNLcc * directLight.color * mhV;");

/* ---- LED reflection: the boundary boards as a teal band at the horizon, a lit segment sweeping along it ---- */
const GLSL_LED = /* glsl */ `
uniform float uLed;
uniform float uLedSweep;
uniform float uLedTime;
// The boards sit ~1-2 deg below the horizon seen from the hand. Seen in lacquer (roughness ~0.1) they are
// not a crisp line: a soft band, and only the lit segment of the sweep is bright, so it reads as a
// travelling teal streak and never as a second seam ring around the ball.
vec3 mhLed(vec3 nView, vec3 vView, float blur) {
  vec3 nW = normalize((vec4(nView, 0.0) * viewMatrix).xyz);
  vec3 vW = normalize((vec4(vView, 0.0) * viewMatrix).xyz);
  vec3 rW = reflect(-vW, nW);
  float el = asin(clamp(rW.y, -1.0, 1.0));
  float w = 0.03 + blur;
  float band = exp(-pow((el + 0.022) / w, 2.0));
  float az = atan(rW.z, rW.x);
  float rel = az - atan(vW.z, vW.x);
  rel = atan(sin(rel), cos(rel));
  float seg = exp(-pow((rel - uLedSweep) / 0.3, 2.0));
  float chev = 0.85 + 0.15 * sin(az * 70.0 - uLedTime * 5.0);
  float fr = 0.04 + 0.96 * pow(1.0 - clamp(dot(nW, vW), 0.0, 1.0), 5.0);
  return ${g3(lin(PAL.teal))} * band * (0.015 + 0.9 * seg) * chev * uLed * (0.3 + 0.7 * fr) * 1.3;
}
`;

/* ---------------- skin ---------------- */

type SkinUniforms = { [k: string]: THREE.IUniform };

const SKIN_VERT_PARS = /* glsl */ `
attribute vec3 aRest;
attribute vec4 aJ;
attribute vec4 aK;
attribute vec4 aM;
attribute vec3 aN;
attribute float aC;
varying float vC;
varying vec3 vRest;
varying vec4 vJ;
varying vec4 vK;
varying vec4 vM;
varying vec3 vN;
`;
const SKIN_VERT = /* glsl */ `
#include <begin_vertex>
${vertHand(false)}
vRest = aRest;
vJ = aJ;
vK = aK;
vM = aM;
vN = aN;
vC = aC;
`;

/** hand-space vein, crease and tendon paths in palm-local millimetres */
const VEINS = [
  [[-26, 2], [-22, 24], [-17, 44], [-13, 58]],
  [[5, -4], [3, 20], [-4, 39], [-6, 56]],
  [[23, 0], [21, 24], [17, 43], [20, 56]],
  [[-17, 44], [-6, 39], [5, 37], [17, 43]],
];
const CREASES = [
  [[40, 51], [22, 55], [3, 58], [-13, 62]], // distal transverse ("heart line")
  [[-32, 47], [-15, 42], [4, 36], [19, 31]], // proximal transverse ("head line")
  [[-30, 47], [-21, 35], [-13, 22], [-9, 7]], // thenar crease ("life line")
];
const pathGlsl = (name: string, paths: number[][][]) => {
  const segs: string[] = [];
  paths.forEach((pth) => {
    for (let i = 0; i < pth.length - 1; i++)
      segs.push(`d = min(d, mhSeg(p, vec2(${pth[i][0].toFixed(1)}, ${pth[i][1].toFixed(1)}), vec2(${pth[i + 1][0].toFixed(1)}, ${pth[i + 1][1].toFixed(1)})));`);
  });
  return `float ${name}(vec2 p) { float d = 1e3; ${segs.join(" ")} return d; }`;
};
const pathGlslEach = (name: string, paths: number[][][]) =>
  paths
    .map((pth, k) => {
      const segs: string[] = [];
      for (let i = 0; i < pth.length - 1; i++)
        segs.push(`d = min(d, mhSeg(p, vec2(${pth[i][0].toFixed(1)}, ${pth[i][1].toFixed(1)}), vec2(${pth[i + 1][0].toFixed(1)}, ${pth[i + 1][1].toFixed(1)})));`);
      return `float ${name}${k}(vec2 p) { float d = 1e3; ${segs.join(" ")} return d; }`;
    })
    .join("\n");

const SKIN_FRAG_PARS = /* glsl */ `
varying vec3 vRest;
varying vec4 vJ;
varying vec4 vK;
varying vec4 vM;
varying vec3 vN;
uniform vec3 uToneD;
uniform vec3 uToneP;
uniform vec3 uToneK;
uniform vec3 uNail;
uniform float uTension;
uniform float uSss;
uniform vec3 uPalmO;
uniform mat3 uPalmR;
uniform float uDetail;
uniform float uDebug;
uniform float uCuff;
varying float vC;
${GLSL_COMMON}
${GLSL_CAPS}
${GLSL_LED}
${pathGlsl("mhVein", VEINS)}
${pathGlslEach("mhCrease", CREASES)}
float mhRough;
float mhCoat;
float mhAO;
float mhThin;
float mhNailM;
`;

const SKIN_COLOR = /* glsl */ `
#include <color_fragment>
float mmPerPx = length(fwidth(vRest)) * 1000.0;
// derivative bumps alias below ~5 px per feature: each scale fades by its own pixels-per-period
// (mmPerPx = |fwidth| reads ~1.4x the true pixel footprint on a surface facing the camera)
float fine = 1.0 - smoothstep(0.06, 0.11, mmPerPx);  // plates, pores, prints, nail ridges (0.35-0.5 mm)
float mid = 1.0 - smoothstep(0.16, 0.26, mmPerPx);   // joint wrinkles, skin lines (~0.85 mm)
vec3 rp = vRest * 1000.0;                            // rest position, mm
float u = vJ.x, v = vJ.y, w = vJ.z, rj = max(vJ.w, 1.0);
float palmar = vM.z;
float conf = vN.z;
float dors = smoothstep(0.1, 0.55, v / rj) * (1.0 - palmar) * conf;
float palmS = smoothstep(-0.15, -0.55, v / rj) * palmar * conf;
float hgt = 0.0;                                     // bump height, mm
/* ---- pigment ---- */
float mott = mhNoise(rp * 0.35) * 0.6 + mhNoise(rp * 1.1 + 3.0) * 0.4;
vec3 skin = mix(uToneD, uToneP, smoothstep(0.25, 0.85, palmar));
skin *= 0.93 + 0.12 * mott;
// blood: fingertip pulps, joint creases and the thenar pad run redder; the palm hollow paler
float pulp = step(0.5, vN.x) * smoothstep(0.3, 0.8, palmar) * smoothstep(0.35, 0.8, u / max(vN.x, 1.0));
float flush = pulp * 0.8 + 0.35 * exp(-pow(u / (0.9 * rj), 2.0)) * conf + 0.25 * smoothstep(0.55, 0.85, mhNoise(rp * 0.12 + 5.0));
skin *= mix(vec3(1.0), vec3(1.05, 0.9, 0.88), clamp(flush, 0.0, 1.0));
// knuckles: slightly darker and redder over the joints on the back of the fingers
float kn = exp(-pow(u / (0.85 * rj), 2.0)) * dors * step(0.5, vK.w) * (vK.w > 1.5 ? 1.0 : 0.55);
skin = mix(skin, uToneK, kn * 0.6);
/* ---- dorsal joint wrinkles ---- */
{
  float ang = w / rj;
  float uu = u + 0.35 * rj * ang * ang;              // wrinkles curve toward the palm at the sides
  float env = exp(-pow(uu / (0.55 * rj), 2.0)) * dors * vK.x;
  // a few long, wavy, unevenly spaced creases across the knuckle (not a regular comb of dashes)
  float wob = mhNoise(vec3(w * 0.22, 0.0, vK.w * 3.1)) - 0.5;
  float ph = uu / 1.05 + 1.1 * wob + 0.3 * mhNoise(vec3(w * 0.6, 1.0, vK.w));
  float cell = floor(ph);
  float gw = max(0.16, 0.8 * mmPerPx / 1.05);       // groove width (phase units), never below ~1 px
  float g = exp(-pow((fract(ph) - 0.5) / gw, 2.0)) * (0.16 / gw);
  float brk = smoothstep(0.1, 0.5, mhNoise(vec3(w * 0.16, cell * 1.7, vK.w)));
  float str = 0.55 + 0.45 * mhNoise(vec3(cell * 2.3, vK.w, 1.0));
  hgt -= 0.05 * g * brk * str * env * mid;
  skin *= 1.0 - 0.13 * g * brk * str * env * mid;
}
/* ---- palmar flexion creases ---- */
{
  float cr = exp(-pow((u - vK.y) / 0.42, 2.0)) + exp(-pow((u - vK.z) / 0.42, 2.0));
  cr *= 0.6 + 0.4 * mhNoise(vec3(w * 0.8, u * 0.2, vK.w));
  hgt -= 0.06 * cr * palmS;
  skin *= 1.0 - 0.12 * cr * palmS;
}
/* ---- palm lines (palm-local) ---- */
vec3 pq = uPalmR * (vRest - uPalmO) * 1000.0;
{
  // palm proper only (not the thumb), lines wander organically off their polyline guides and break up
  float m = smoothstep(0.6, 0.9, palmar) * smoothstep(0.7, 0.95, vM.w) * smoothstep(-1.0, -3.0, pq.z);
  vec2 wq = pq.xy + vec2(mhNoise(vec3(pq.xy * 0.12, 11.0)) - 0.5, mhNoise(vec3(pq.xy * 0.12, 17.0)) - 0.5) * 4.5;
  float c0 = mhCrease0(wq);
  float c1 = mhCrease1(wq);
  float c2 = mhCrease2(wq);
  float brk = smoothstep(0.2, 0.7, mhNoise(vec3(pq.xy * 0.18, 4.0)));
  float cr = (exp(-pow(c0 / 0.7, 2.0)) + exp(-pow(c1 / 0.65, 2.0)) * 0.85 + exp(-pow(c2 / 0.7, 2.0))) * brk;
  hgt -= 0.035 * cr * m;
  skin *= 1.0 - 0.07 * cr * m;
}
/* ---- veins and tendons on the back of the hand ---- */
{
  float m = vM.w * smoothstep(0.35, 0.0, palmar) * smoothstep(3.0, 9.0, pq.z);
  vec2 wq = pq.xy + vec2(mhNoise(vec3(pq.xy * 0.09, 2.0)) - 0.5, mhNoise(vec3(pq.xy * 0.09, 7.0)) - 0.5) * 5.0;
  float dv = mhVein(wq);
  float vein = exp(-pow(dv / 1.9, 2.0)) * (0.55 + 0.45 * mhNoise(rp * 0.25)) * smoothstep(-6.0, 8.0, pq.y) * (1.0 - smoothstep(52.0, 62.0, pq.y));
  hgt += 0.11 * vein * m;
  skin = mix(skin, skin * vec3(0.9, 0.92, 1.0), vein * m * 0.35);
  float ten = 0.0;
  for (int i = 0; i < 4; i++) {
    float fx = i == 0 ? -24.5 : i == 1 ? -4.0 : i == 2 ? 15.5 : 33.0;
    ten += exp(-pow(mhSeg(pq.xy, vec2(fx * 0.35, 10.0), vec2(fx, 56.0)) / 2.6, 2.0));
  }
  hgt += (0.025 + 0.07 * uTension) * ten * m * smoothstep(8.0, 22.0, pq.y) * (1.0 - smoothstep(46.0, 58.0, pq.y));
}
/* ---- nails ---- */
float nailM = 0.0;
{
  float L = vN.x;
  float th = atan(w, v);                             // 0 on the nail centre line
  float thN = abs(th) / 0.88;
  float uc = 0.38 * L;                                // proximal nail fold (cuticle): U-shaped
  float cut = u - uc - 0.3 * rj * thN * thN;
  float tipU = L - 0.4 * rj;
  // the lateral folds overlap the plate softly; the plate runs out at the free edge
  float side = 1.0 - smoothstep(0.7, 1.0, thN);
  float inN = vN.y * smoothstep(-0.2, 0.35, cut) * side * (1.0 - smoothstep(tipU, tipU + 0.6, u)) * smoothstep(-0.3, 0.3, v);
  nailM = inN;
  // fold groove at the cuticle and along the sides
  float border = vN.y * step(0.0, v) * (exp(-pow(cut / 0.25, 2.0)) * (1.0 - smoothstep(0.85, 1.05, thN)) + exp(-pow((thN - 0.9) / 0.07, 2.0)) * smoothstep(-0.2, 0.4, cut));
  // a convex plate: transverse crown (catches a long highlight), slightly proud of the folds
  hgt += (0.03 + 0.07 * (1.0 - thN * thN)) * inN - 0.03 * border;
  // lunula, free edge, longitudinal ridges
  float lun = inN * (1.0 - smoothstep(0.0, 0.16 * L * sqrt(max(0.0, 1.0 - thN * thN)), cut)) * (L > 25.0 ? 1.0 : 0.45);
  float edge = inN * smoothstep(tipU - 1.2, tipU - 0.3, u);
  // the bed shows through the plate: pinker in the middle, taking the skin's colour toward the folds and
  // under the cuticle; a soft lunula and a thin translucent free edge
  vec3 nail = uNail * (0.95 + 0.07 * mhNoise(vec3(w * 3.0, u * 0.3, L)));
  nail = mix(nail, skin * 1.05, 0.6 * smoothstep(0.4, 1.0, thN));
  nail = mix(nail, skin, 0.4 * (1.0 - smoothstep(0.0, 1.8, cut)));
  nail = mix(nail, nail * 1.12 + 0.008, lun * 0.35);
  nail = mix(nail, nail * 1.15 + vec3(0.02, 0.017, 0.014), edge * 0.4);
  hgt += 0.006 * sin(w * 18.0) * inN * fine;
  skin = mix(skin, nail, inN);
  skin *= 1.0 - 0.1 * border;
}
/* ---- fingerprint ridges on the pads ---- */
{
  float pad = step(0.5, vN.x) * palmS;
  vec2 c = vec2(u - vN.x * 0.6, w * 1.2);
  float rings = sin(length(c) * 13.0 + atan(c.y, c.x) * 0.5);
  hgt += 0.012 * rings * pad * fine;
}
/* ---- micro relief: skin plates and pores ---- */
if (fine > 0.0) {
  vec2 cel = mhCell(rp * (palmar > 0.5 ? 2.6 : 2.0));
  float plate = smoothstep(0.0, 0.16, cel.y - cel.x);
  float pore = smoothstep(0.22, 0.0, cel.x) * (1.0 - palmar);
  hgt += (0.014 * plate - 0.02 * pore) * fine * (1.0 - nailM);
  float lines = mhNoise(rp * vec3(0.9, 3.2, 0.9));
  hgt -= 0.008 * smoothstep(0.55, 0.85, lines) * mid * (1.0 - nailM);
}
// keep the tone natural under hard white light: a touch less chroma
skin = mix(vec3(dot(skin, vec3(0.2126, 0.7152, 0.0722))), skin, 0.8);
diffuseColor.rgb = skin;
mhNailM = nailM;
mhAO = vM.x * mix(1.0, vC, uCuff);
mhThin = vM.y;
mhRough = mix(0.53, 0.47, palmar) + 0.06 * mott - 0.04 * uTension * palmS;
mhRough = mix(mhRough, 0.26, nailM);
mhCoat = mix(0.045, 0.09, palmar) + 0.5 * nailM;
`;

const SKIN_NORMAL = /* glsl */ `
#include <normal_fragment_maps>
normal = mhBump(-vViewPosition, normal, hgt * 0.001 * uDetail);
`;

const skinLightsChunk = () =>
  shadowedLights().replace(
    "reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );",
    /* glsl */ `{
      // wrapped diffuse: red light bleeds past the terminator (subsurface look)
      float nlRaw = dot( geometryNormal, directLight.direction );
      vec3 wrapW = vec3( 0.18, 0.08, 0.05 ) * uSss;
      vec3 wrapNL = clamp( ( vec3( nlRaw ) + wrapW ) / ( 1.0 + wrapW ), 0.0, 1.0 );
      reflectedLight.directDiffuse += wrapNL * directLight.color * mix( 0.12, 1.0, mhV ) * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );
      // thin parts glow at their edges when lit from behind (fingers against the rim light)
      float back = pow( clamp( dot( geometryViewDir, - directLight.direction ), 0.0, 1.0 ), 3.0 );
      float away = smoothstep( 0.25, -0.35, nlRaw );
      // a finger is ~15 mm of tissue: light only gets through near the silhouette, and only a little
      float rimEdge = pow( 1.0 - clamp( dot( geometryNormal, geometryViewDir ), 0.0, 1.0 ), 2.0 );
      reflectedLight.directDiffuse += directLight.color * vec3( 0.55, 0.16, 0.08 ) * ( mhThin * mhThin ) * back * away * ( 0.08 + 0.92 * rimEdge ) * 0.075 * uSss * ( 1.0 - 0.3 * mhNailM );
    }`,
  );

const makeSkinMaterial = (env: THREE.Texture, U: SkinUniforms, local: THREE.IUniform<THREE.Matrix4>) => {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.5,
    metalness: 0,
    specularIntensity: 0.5,
    sheen: 0.18,
    sheenRoughness: 0.5,
    sheenColor: new THREE.Color(0.2, 0.17, 0.15),
    clearcoat: 1,
    clearcoatRoughness: 0.36,
    envMap: env,
    envMapIntensity: 0.6,
  });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U, { uLocalToHand: local, uSkip: { value: 1.3 } });
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\n" + SKIN_VERT_PARS + VERT_HAND_PARS)
      .replace("#include <begin_vertex>", SKIN_VERT);
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\n" + SKIN_FRAG_PARS)
      .replace("#include <lights_physical_pars_fragment>", skinLightsChunk())
      .replace("#include <color_fragment>", SKIN_COLOR)
      .replace("#include <roughnessmap_fragment>", "float roughnessFactor = mhRough;")
      .replace("#include <normal_fragment_maps>", SKIN_NORMAL)
      .replace("#include <clearcoat_normal_fragment_maps>", "#include <clearcoat_normal_fragment_maps>\nclearcoatNormal = normal;")
      .replace(
        "#include <lights_physical_fragment>",
        "#include <lights_physical_fragment>\nmaterial.clearcoat *= mhCoat;\nmaterial.clearcoatRoughness = mix(material.clearcoatRoughness, 0.14, mhNailM);",
      )
      .replace(
        "#include <aomap_fragment>",
        /* glsl */ `
        reflectedLight.indirectDiffuse *= mhAO;
        reflectedLight.indirectSpecular *= mix(1.0, mhAO, 0.85);
        reflectedLight.directDiffuse *= mix(1.0, mhAO, 0.4);
        reflectedLight.directSpecular *= mix(1.0, mhAO, 0.5);
        clearcoatSpecularIndirect *= mhAO;
        sheenSpecularIndirect *= mhAO;`,
      )
      .replace(
        "#include <opaque_fragment>",
        `outgoingLight += mhLed(normal, geometryViewDir, 0.06) * (0.12 + 0.3 * mhNailM) * mhAO;
        if (uDebug > 0.5) {
          outgoingLight = uDebug < 1.5 ? vec3(vM.x) : uDebug < 2.5 ? vec3(vM.z) : uDebug < 3.5 ? vec3(vM.y) : uDebug < 4.5 ? vec3(vN.z) : uDebug < 5.5 ? vec3(vM.w) : normal * 0.5 + 0.5;
        }
        #include <opaque_fragment>`,
      );
  };
  m.customProgramCacheKey = () => "mpl-macro-skin-v1";
  return m;
};

/* ---------------- ball leather ---------------- */

const BR_S = R.toFixed(6);
const BALL_VERT_PARS = /* glsl */ `
varying vec3 vBP;
${VERT_HAND_PARS}
`;
const BALL_VERT = /* glsl */ `
#include <begin_vertex>
vBP = position;
{
  vec3 dn = normalize(position);
  float sv = abs(${BR_S} * asin(clamp(dn.y, -1.0, 1.0)));
  float hv = 0.00078 * exp(-pow(sv / 0.00115, 2.0)) + 0.00012 * (1.0 - smoothstep(0.0062, 0.0072, sv));
  transformed = dn * (${BR_S} + hv);
}
${vertHand(false)}
`;
const BALL_FRAG_PARS = /* glsl */ `
uniform mat3 normalMatrix;
uniform float uWear;
varying vec3 vBP;
${GLSL_COMMON}
${GLSL_CAPS}
${GLSL_LED}
const float BR = ${BR_S};
float bRough;
float bCoat;
float bCoatR;
float bAO;
float bWet;
`;
const BALL_COLOR = /* glsl */ `
#include <color_fragment>
vec3 bn = normalize(vBP);
float bs = BR * asin(clamp(bn.y, -1.0, 1.0));
float bas = abs(bs);
float bsgn = bs >= 0.0 ? 1.0 : -1.0;
float bmmPx = length(fwidth(vBP)) * 1000.0;
// bmmPx = |fwidth| reads ~1.4x the true pixel footprint
float bfine = 1.0 - smoothstep(0.08, 0.14, bmmPx);   // leather grain cells (0.8 mm): >= 8 px each
float bfine2 = 1.0 - smoothstep(0.035, 0.06, bmmPx); // finest noise (0.33 mm)
float bpx = bmmPx * 0.0007;
// geometric seam ridge slope (matches the vertex displacement) -> object-space normal
float dh = -2.0 * bas / (0.00115 * 0.00115) * 0.00078 * exp(-pow(bas / 0.00115, 2.0));
vec3 tv = vec3(0.0, 1.0, 0.0) - bn * bn.y;
vec3 tS = tv * inversesqrt(max(dot(tv, tv), 1e-10)) * bsgn;
vec3 nObj = normalize(bn - tS * dh);
// detail height (metres): join line, band edges, quarter seam, leather pebble
float bh = 0.0;
// narrow grooves widen with the pixel footprint (same volume) so they never alias
float wj = max(0.0002, 1.3 * bpx);
bh -= 0.00018 * (0.0002 / wj) * exp(-pow(bas / wj, 2.0));
float band = 1.0 - smoothstep(0.0062, 0.0072, bas);
bh -= 0.00006 * exp(-pow((bas - 0.0069) / 0.00025, 2.0));
float qd = (bsgn > 0.0 ? abs(bn.x) : abs(bn.z)) * BR;
float qMask = smoothstep(0.0078, 0.0098, bas);
float qL = (bsgn > 0.0 ? atan(bn.y, bn.z) : atan(bn.y, bn.x)) * BR;
float qdim = 1.0 - smoothstep(0.00012, 0.0003, length(vec2((fract(qL / 0.0021) - 0.5) * 0.0021, abs(qd) - 0.00075)));
float wq = max(0.00022, 1.3 * bpx);
bh -= (0.00012 * (0.00022 / wq) * exp(-pow(qd / wq, 2.0)) + 0.00005 * qdim * bfine) * qMask;
float pebble = 0.5;
if (bfine > 0.0) {
  vec2 pc = mhCell(vBP * 1250.0);
  // a new ball: soft, shallow grain under the lacquer (not crocodile cells)
  pebble = mix(0.5, smoothstep(0.0, 0.6, pc.y - pc.x), bfine);
  bh += 0.000018 * pebble * (1.0 - band * 0.7) * bfine;
  bh += 0.00001 * (mhNoise(vBP * 3000.0) - 0.5) * bfine2;
}
// leather colour
vec3 ln = vBP * 140.0;
float mott = mhNoise(ln);
vec3 leather = mix(${g3(lin("#5E0D10"))}, ${g3(lin(PAL.leather))}, 0.6 + 0.4 * mott);
leather = mix(leather, ${g3(lin(PAL.leatherHi))}, 0.25 * smoothstep(0.5, 0.9, mhNoise(ln * 0.35 + 2.0)));
float shiny = smoothstep(-0.002, 0.002, vBP.y);
float scuff = (1.0 - shiny) * smoothstep(0.55, 0.85, mhNoise(vBP * 260.0 + 4.0)) * uWear;
leather = mix(leather, ${g3(lin("#8E3A33"))}, scuff * 0.5);
leather *= 0.9 + 0.1 * pebble;
// moisture: sweat-polished smears on the leather
float wet = smoothstep(0.44, 0.7, mhNoise(vBP * vec3(48.0, 90.0, 48.0) + 7.0) * 0.75 + mhNoise(vBP * 160.0 + 3.0) * 0.25) * (0.45 + 0.55 * shiny) * (1.0 - band);
leather *= 1.0 - 0.14 * wet;
diffuseColor.rgb = leather;
bWet = wet;
bRough = clamp(mix(0.52, 0.38, shiny) + scuff * 0.2 - wet * 0.12 + band * 0.06, 0.2, 1.0);
bCoat = clamp(mix(0.4, 0.92, shiny) * (1.0 - scuff * 0.7) + wet * 0.35 - band * 0.2, 0.0, 1.0);
bCoatR = mix(mix(0.24, 0.11, shiny), 0.055, wet);
bAO = mhCapsAO(vHP, normalize(vHN));
`;
const BALL_NORMAL = /* glsl */ `
#include <normal_fragment_maps>
normal = normalize(normalMatrix * nObj) * faceDirection;
normal = mhBump(-vViewPosition, normal, bh);
`;

const makeBallMaterial = (env: THREE.Texture, U: SkinUniforms) => {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.45,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.2,
    specularIntensity: 0.5,
    envMap: env,
    envMapIntensity: 0.55,
  });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U, { uSkip: { value: 1.0 } });
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\n" + BALL_VERT_PARS).replace("#include <begin_vertex>", BALL_VERT);
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\n" + BALL_FRAG_PARS)
      .replace("#include <lights_physical_pars_fragment>", shadowedLights())
      .replace("#include <color_fragment>", BALL_COLOR)
      .replace("#include <roughnessmap_fragment>", "float roughnessFactor = bRough;")
      .replace("#include <normal_fragment_maps>", BALL_NORMAL)
      .replace("#include <clearcoat_normal_fragment_maps>", "#include <clearcoat_normal_fragment_maps>\nclearcoatNormal = normalize(mix(nonPerturbedNormal, normal, 0.55));")
      .replace("#include <lights_physical_fragment>", "#include <lights_physical_fragment>\nmaterial.clearcoat *= bCoat;\nmaterial.clearcoatRoughness = max(bCoatR, 0.0525);")
      .replace(
        "#include <aomap_fragment>",
        /* glsl */ `
        reflectedLight.indirectDiffuse *= bAO;
        reflectedLight.indirectSpecular *= bAO;
        reflectedLight.directDiffuse *= mix(1.0, bAO, 0.45);
        reflectedLight.directSpecular *= mix(1.0, bAO, 0.6);
        clearcoatSpecularIndirect *= bAO;
        clearcoatSpecularDirect *= mix(1.0, bAO, 0.6);`,
      )
      .replace("#include <opaque_fragment>", "outgoingLight += mhLed(clearcoatNormal, geometryViewDir, 0.0) * bCoat * bAO;\n#include <opaque_fragment>");
  };
  m.customProgramCacheKey = () => "mpl-macro-ball-v1";
  return m;
};

/* ---------------- seam thread ---------------- */

const makeThreadMaterial = (env: THREE.Texture, U: SkinUniforms) => {
  const m = new THREE.MeshPhysicalMaterial({
    // warm cream: it must still read as cream thread under the cool teal fill
    color: lin("#F7D8C8").lerp(lin(PAL.leather).multiplyScalar(2.2), 0.08),
    roughness: 0.72,
    sheen: 0.35,
    sheenRoughness: 0.5,
    sheenColor: new THREE.Color(0.42, 0.33, 0.24),
    envMap: env,
    envMapIntensity: 0.25,
  });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U, { uSkip: { value: 1.0 } });
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vSP;\n" + VERT_HAND_PARS)
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvSP = position;\n" + vertHand(true));
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vSP;\n${GLSL_COMMON}\n${GLSL_CAPS}`)
      .replace("#include <lights_physical_pars_fragment>", shadowedLights())
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        // twisted strands across the stitch, darker where it dives into the leather
        float strand = 0.5 + 0.5 * sin((vSP.x * 3.0 + vSP.z * 9.0) * 3.14159);
        float sink = smoothstep(0.55, 1.0, abs(vSP.x));
        diffuseColor.rgb *= (0.84 + 0.16 * strand) * (1.0 - 0.45 * sink);
        float tAO = mhCapsAO(vHP, normalize(vHN));
        tAO *= mhCapsAO(vHP + normalize(vHN) * 0.0006, normalize(vHN)) * 0.5 + 0.5;`,
      )
      .replace("#include <normal_fragment_maps>", "#include <normal_fragment_maps>\nnormal = mhBump(-vViewPosition, normal, strand * 0.00004);")
      .replace(
        "#include <aomap_fragment>",
        "reflectedLight.indirectDiffuse *= tAO * (1.0 - 0.5 * sink) * vec3(1.0, 0.88, 0.97);\nreflectedLight.directDiffuse *= mix(1.0, tAO, 0.45);\nreflectedLight.indirectSpecular *= tAO;",
      );
  };
  m.customProgramCacheKey = () => "mpl-macro-thread-v1";
  return m;
};

/* ---------------- knitted cuff ---------------- */

const makeCuffMaterial = (env: THREE.Texture, U: SkinUniforms, local: THREE.IUniform<THREE.Matrix4>) => {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.82,
    sheen: 0.6,
    sheenRoughness: 0.6,
    sheenColor: lin(PAL.teal).multiplyScalar(0.2).add(new THREE.Color(0.035, 0.035, 0.035)),
    envMap: env,
    envMapIntensity: 0.35,
  });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U, { uLocalToHand: local, uSkip: { value: 1.0 } });
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vCuv;\n" + VERT_HAND_PARS)
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvCuv = uv;\n" + vertHand(false));
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec2 vCuv;\n${GLSL_COMMON}\n${GLSL_CAPS}`)
      .replace("#include <lights_physical_pars_fragment>", shadowedLights())
      .replace(
        "#include <color_fragment>",
        /* glsl */ `#include <color_fragment>
        // ribbed knit: columns of V loops running along the arm
        float around = vCuv.x * 92.0;
        float along = vCuv.y * ${((CUFF_Y0 - CUFF_Y1) * 1000).toFixed(2)} / 1.15;
        float col = fract(around);
        // band-limit every knit frequency by its screen footprint (no moire at 1080p or at a distance)
        float fwA = fwidth(around);
        float fwL = fwidth(along);
        float ribF = 1.0 - smoothstep(0.2, 0.5, fwA);
        float loopF = 1.0 - smoothstep(0.2, 0.5, max(fwL, fwA));
        float fuzzF = 1.0 - smoothstep(0.25, 0.7, fwidth(vCuv.x * 900.0));
        // sinusoidal profiles: a triangle wave's derivative is a square wave and the relief stair-steps
        float rib = mix(0.5, 0.5 - 0.5 * cos(6.2832 * col), ribF);
        float loopV = fract(along + (0.5 - 0.5 * cos(6.2832 * col)) * 0.65);
        float loopH = mix(0.5, 0.5 - 0.5 * cos(6.2832 * loopV), loopF) * 0.6 + 0.4;
        float fuzz = mix(0.5, mhNoise(vec3(vCuv * vec2(900.0, 260.0), 1.0)), fuzzF);
        float kh = rib * (0.55 + 0.45 * loopH) + 0.15 * fuzz;
        // colours: deep teal band with a graphite stripe, tucked rolled edges
        float s = vCuv.y;
        float stripe = smoothstep(0.30, 0.315, s) * (1.0 - smoothstep(0.52, 0.535, s));
        vec3 teal = ${g3(lin(PAL.tealDeep))} * 0.82;
        vec3 graph = ${g3(lin(PAL.graphite))};
        vec3 knit = mix(teal, graph, stripe);
        knit *= 0.84 + 0.24 * kh;
        float edge = smoothstep(0.06, 0.0, s) + smoothstep(0.94, 1.0, s);
        diffuseColor.rgb = knit * (1.0 - 0.35 * edge);
        float cAO = mhCapsAO(vHP, normalize(vHN));
        // the rolled lips tuck against the skin: the wrist / forearm shade them (no bright sheen rim)
        float cEdge = mix(0.3, 1.0, smoothstep(0.0, 0.14, s)) * mix(0.55, 1.0, smoothstep(1.0, 0.88, s));`,
      )
      .replace("#include <normal_fragment_maps>", "#include <normal_fragment_maps>\nnormal = mhBump(-vViewPosition, normal, kh * 0.0002 * ribF);")
      .replace(
        "#include <aomap_fragment>",
        "reflectedLight.indirectDiffuse *= cAO * cEdge * (0.75 + 0.25 * kh);\nreflectedLight.directDiffuse *= mix(1.0, cAO, 0.5) * cEdge * (0.8 + 0.2 * kh);\nsheenSpecularIndirect *= cAO * cEdge;\nsheenSpecularDirect *= cEdge * cEdge;\nreflectedLight.directSpecular *= cEdge;",
      );
  };
  m.customProgramCacheKey = () => "mpl-macro-cuff-v1";
  return m;
};

/* ================================================================== */
/* Environment: night stadium seen from the top of the run-up          */
/* ================================================================== */

const envCache = new WeakMap<THREE.WebGLRenderer, THREE.Texture>();
/** Reference point of the environment (the S02 hand position). */
const ENV_EYE: V = [0, 1.4, 26];

const getMacroEnv = (gl: THREE.WebGLRenderer) => {
  const hit = envCache.get(gl);
  if (hit) return hit;
  const W = 1024;
  const H = 512;
  const data = new Uint16Array(W * H * 4);
  const toH = THREE.DataUtils.toHalfFloat;
  const flood = lin(PAL.floodWhite);
  const teal = lin(PAL.teal);
  const grass = lin(PAL.grassA);
  const stand = lin(PAL.graphite);
  // floodlight banks as seen from the eye: azimuth / elevation of the panel centre and its size
  const banks = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI * 2) / 8;
    const p: V = [118 * Math.cos(a), 66, 118 * Math.sin(a)];
    const d = sub(p, ENV_EYE);
    const hd = Math.hypot(d[0], d[2]);
    return { az: Math.atan2(d[2], d[0]), el: Math.atan2(d[1], hd), hw: 5.4 / hd, hh: 3.0 / hd };
  });
  for (let y = 0; y < H; y++) {
    const el = -Math.PI / 2 + ((y + 0.5) / H) * Math.PI;
    for (let x = 0; x < W; x++) {
      const az = ((x + 0.5) / W - 0.5) * Math.PI * 2;
      const ca = Math.cos(az);
      const sa = Math.sin(az);
      // distance to the LED ring along this azimuth
      const b = ENV_EYE[2] * sa;
      const tRing = -b + Math.sqrt(b * b + 70.5 * 70.5 - ENV_EYE[2] * ENV_EYE[2]);
      const ledLo = Math.atan2(-ENV_EYE[1], tRing);
      const ledHi = Math.atan2(0.9 - ENV_EYE[1], tRing);
      const standTop = Math.atan2(42 - ENV_EYE[1], tRing + 52);
      let r = 0;
      let g = 0;
      let bl = 0;
      if (el < ledLo) {
        const k = 0.16 + 0.12 * Math.min(1, (ledLo - el) * 4);
        r = grass.r * k;
        g = grass.g * k;
        bl = grass.b * k;
        // the mown stripes, faint
        if (Math.sin(Math.atan2(sa, ca) * 0 + (tRing * Math.cos(el)) / 5) > 0.7) {
          r *= 1.1;
          g *= 1.1;
        }
      } else if (el < ledHi) {
        // the LED ring: only a faint teal tint here (the travelling streak is added in the shaders);
        // a bright band would print a crisp ring around the ball that reads as a second seam
        const chev = 0.85 + 0.15 * Math.sin(az * 70);
        r = teal.r * 0.45 * chev;
        g = teal.g * 0.45 * chev;
        bl = teal.b * 0.45 * chev;
      } else if (el < standTop) {
        // tiers and a broken-up crowd at low frequency only (finer patterns alias in the equirect / PMREM
        // and print stripes on the lacquer)
        const tier = 0.5 + 0.5 * Math.sin(el * 70);
        const crowd = 0.5 + 0.5 * Math.sin(az * 23 + Math.sin(el * 31) * 2) * Math.sin(el * 47 + az * 5);
        const n = 0.6 * tier + 0.4 * crowd;
        const k = 0.03 + 0.03 * n;
        r = stand.r * k * 4 + 0.004;
        g = stand.g * k * 4 + 0.005;
        bl = stand.b * k * 4 + 0.006;
      } else {
        const k = 0.006 + 0.035 * Math.exp(-(el - standTop) * 7);
        r = 0.55 * k;
        g = 0.75 * k;
        bl = 0.9 * k;
      }
      for (const bk of banks) {
        let da = az - bk.az;
        da = Math.atan2(Math.sin(da), Math.cos(da));
        const de = el - bk.el;
        if (Math.abs(da) > bk.hw * 3 || Math.abs(de) > bk.hh * 3) continue;
        // panel glow + an 8 x 5 grid of lamps
        const gx = da / bk.hw;
        const gy = de / bk.hh;
        const glow = Math.exp(-(gx * gx + gy * gy) * 0.9) * 3.0;
        let lamp = 0;
        if (Math.abs(gx) < 1.05 && Math.abs(gy) < 1.05) {
          const cx = ((gx + 1) / 2) * 8;
          const cy = ((gy + 1) / 2) * 5;
          const fx = cx - Math.floor(cx) - 0.5;
          const fy = cy - Math.floor(cy) - 0.5;
          lamp = 90 * Math.exp(-(fx * fx + fy * fy) / 0.045);
        }
        r += flood.r * (glow + lamp);
        g += flood.g * (glow + lamp);
        bl += flood.b * (glow + lamp);
      }
      const o = (y * W + x) * 4;
      data[o] = toH(r);
      data[o + 1] = toH(g);
      data[o + 2] = toH(bl);
      data[o + 3] = toH(1);
    }
  }
  const eq = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  eq.mapping = THREE.EquirectangularReflectionMapping;
  eq.colorSpace = THREE.LinearSRGBColorSpace;
  eq.magFilter = THREE.LinearFilter;
  eq.minFilter = THREE.LinearFilter;
  eq.needsUpdate = true;
  const pm = new THREE.PMREMGenerator(gl);
  const out = pm.fromEquirectangular(eq).texture;
  pm.dispose();
  eq.dispose();
  envCache.set(gl, out);
  return out;
};

/* ================================================================== */
/* Components                                                          */
/* ================================================================== */

const darken = (c: THREE.Color, k: number) => c.clone().multiplyScalar(k);

export type MacroBallProps = {
  /** hand-space (or parent-space) transform of the ball: position of its centre and orientation */
  position?: Vec3;
  quaternion?: THREE.Quaternion;
  /** teal LED reflection strength (0 = off, default 1) */
  led?: number;
  /** relative azimuth (rad) of the bright segment travelling along the LED reflection */
  ledSweep?: number;
  /** seconds, scrolls the LED chevrons */
  time?: number;
  /** 0 new .. 1 scuffed rough side (default 0.3) */
  wear?: number;
  /** occluder capsules (hand space) for contact occlusion and soft shadows; omit for a free ball */
  capsules?: { a: THREE.Vector4[]; b: THREE.Vector4[] };
  /** analytic shadows from the capsules (default true) */
  shadows?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
};

const farCaps = () => ({
  a: Array.from({ length: NCAP }, () => new THREE.Vector4(10, 10, 10, 0.0001)),
  b: Array.from({ length: NCAP }, () => new THREE.Vector4(10, 10, 10.01, 0)),
});

/**
 * The macro ball: same construction as the film's <Ball/> (seam in the local XZ plane, 6 rows of 82 stitches,
 * quarter seams at 90 deg on each half, polished +Y half) with geometric stitches, sweat sheen on the lacquer
 * and the teal LED-board reflection. Radius BALL.radius, origin at its centre.
 */
export const MacroBall: React.FC<MacroBallProps> = ({
  position = [0, 0, 0],
  quaternion,
  led = 1,
  ledSweep = 0,
  time = 0,
  wear = 0.3,
  capsules,
  shadows = true,
  castShadow = true,
  receiveShadow = true,
}) => {
  const gl = useThree((s) => s.gl);
  const env = getMacroEnv(gl);
  const bg = buildBallGeo();
  const U = useMemo(
    () => ({
      uLocalToHand: { value: new THREE.Matrix4() },
      uBallC: { value: new THREE.Vector4(0, 0, 0, 0) },
      uShadowK: { value: SHADOW_K },
      uWear: { value: 0.3 },
      uLed: { value: 1 },
      uLedSweep: { value: 0 },
      uLedTime: { value: 0 },
      uCapA: { value: farCaps().a },
      uCapB: { value: farCaps().b },
    }),
    [],
  );
  const mats = useMemo(() => ({ ball: makeBallMaterial(env, U), thread: makeThreadMaterial(env, U) }), [env, U]);
  const stitches = useMemo(() => {
    const im = new THREE.InstancedMesh(bg.stitch, mats.thread, bg.stitchM.length);
    bg.stitchM.forEach((m, i) => im.setMatrixAt(i, m));
    im.instanceMatrix.needsUpdate = true;
    im.frustumCulled = false;
    return im;
  }, [bg, mats]);
  stitches.castShadow = castShadow;
  stitches.receiveShadow = receiveShadow;
  const q = quaternion ?? new THREE.Quaternion();
  U.uLocalToHand.value.compose(new THREE.Vector3(...position), q, new THREE.Vector3(1, 1, 1));
  U.uWear.value = wear;
  U.uLed.value = led;
  U.uLedSweep.value = ledSweep;
  U.uLedTime.value = time;
  U.uShadowK.value = shadows && capsules ? SHADOW_K : 0;
  if (capsules) {
    for (let i = 0; i < NCAP; i++) {
      U.uCapA.value[i].copy(capsules.a[i]);
      U.uCapB.value[i].copy(capsules.b[i]);
    }
  }
  return (
    <group position={position} quaternion={q}>
      <mesh geometry={bg.ball} material={mats.ball} castShadow={castShadow} receiveShadow={receiveShadow} />
      <primitive object={stitches} />
    </group>
  );
};

export type MacroHandProps = {
  /** local time in seconds since the start of S02 (cue-synced, see MACRO_T) */
  t: number;
  /** base skin tone, sRGB hex (default: a warm brown from the rig's palette) */
  skinTone?: string;
  /** apply breathing and the start of the run to the whole hand (default true) */
  rootMotion?: boolean;
  /** teal LED reflection strength on the lacquer (default 1) */
  led?: number;
  /** ball wear 0..1 (default 0.3) */
  wear?: number;
  /** subsurface strength multiplier (default 1) */
  sss?: number;
  /** micro relief strength multiplier (default 1) */
  detail?: number;
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** debug: replace the skin material (e.g. a clay material for form checks) */
  overrideMaterial?: THREE.Material;
  /** analytic contact shadows between hand and ball (default true) */
  shadows?: boolean;
  /** debug view of the skin attributes: 1 AO, 2 palmar, 3 thin, 4 feature confidence, 5 dorsum, 6 normal */
  debug?: number;
  /**
   * wrist: "band" (default, SPEC 6.4: deep-teal knit cuff with a graphite band) or "none" (bare wrist).
   * Continuity: the rig's bowler wears short sleeves, so S02 must match whatever S03 shows on his right
   * wrist (a matching wristband on the Player, or "none" here).
   */
  cuff?: "band" | "none";
};

/**
 * <MacroHand t /> : the bowler's right hand gripping the ball, hand-space origin at the ball centre
 * (+Y up, -Z toward the batsman, +X the bowler's right). Pure function of t.
 */
export const MacroHand: React.FC<MacroHandProps> = ({
  t,
  skinTone = "#8a5a3e",
  rootMotion = true,
  led = 1,
  wear = 0.3,
  sss = 1,
  detail = 1,
  castShadow = true,
  receiveShadow = true,
  overrideMaterial,
  shadows = true,
  debug = 0,
  cuff = "band",
}) => {
  const gl = useThree((s) => s.gl);
  const env = getMacroEnv(gl);
  const hg = buildHandGeo();
  const arm = buildArmGeo();
  const rig = getRig();

  // per-instance skinned copy (static attributes shared)
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    for (const name of ["aRest", "aJ", "aK", "aM", "aN", "aC"]) g.setAttribute(name, hg.geo.getAttribute(name));
    g.setAttribute("position", new THREE.BufferAttribute(hg.restPos.slice(), 3));
    g.setAttribute("normal", new THREE.BufferAttribute(hg.restNrm.slice(), 3));
    g.setIndex(hg.geo.index);
    g.boundingSphere = hg.geo.boundingSphere!.clone();
    g.boundingSphere.radius += 0.05;
    return g;
  }, [hg]);

  const U = useMemo(() => {
    const palm = rig.rest[PALM];
    const tone = lin(skinTone);
    return {
      uToneD: { value: tone.clone() },
      uToneP: { value: tone.clone().lerp(lin("#c39a88"), 0.42) },
      uToneK: { value: darken(tone, 0.72).lerp(lin("#5a2f2a"), 0.25) },
      uNail: { value: tone.clone().lerp(lin("#c9958a"), 0.38) },
      uTension: { value: 0 },
      uSss: { value: 1 },
      uDetail: { value: 1 },
      uDebug: { value: 0 },
      uCuff: { value: 1 },
      uPalmO: { value: new THREE.Vector3(...palm.o) },
      uPalmR: { value: new THREE.Matrix3().set(...palm.x, ...palm.y, ...palm.z) },
      uLed: { value: 1 },
      uLedSweep: { value: 0 },
      uLedTime: { value: 0 },
      uCapA: { value: Array.from({ length: NCAP }, () => new THREE.Vector4()) },
      uCapB: { value: Array.from({ length: NCAP }, () => new THREE.Vector4()) },
      uBallC: { value: new THREE.Vector4(0, 0, 0, R) },
      uShadowK: { value: SHADOW_K },
    };
  }, [rig, skinTone]);
  const locals = useMemo(() => ({ hand: { value: new THREE.Matrix4() }, arm: { value: new THREE.Matrix4() } }), []);
  const mats = useMemo(
    () => ({ skin: makeSkinMaterial(env, U, locals.hand), arm: makeSkinMaterial(env, U, locals.arm), cuff: makeCuffMaterial(env, U, locals.arm) }),
    [env, U, locals],
  );

  const st = macroHandState(t, rootMotion);
  // skin the hand for this frame
  const pa = geo.attributes.position as THREE.BufferAttribute;
  const na = geo.attributes.normal as THREE.BufferAttribute;
  skinHand(hg, st.frames, st.ball, pa.array as Float32Array, na.array as Float32Array);
  pa.needsUpdate = true;
  na.needsUpdate = true;
  capsulesOf(st.frames, U.uCapA.value, U.uCapB.value);
  U.uTension.value = st.tension;
  U.uSss.value = sss;
  U.uDetail.value = detail;
  U.uDebug.value = debug;
  U.uCuff.value = cuff === "band" ? 1 : 0;
  U.uLed.value = led;
  U.uLedSweep.value = st.ledSweep;
  U.uLedTime.value = t;

  const foreM = frameMatrix(fMul(st.frames[FORE], fInv(rig.rest[FORE])));
  locals.arm.value.copy(foreM);
  U.uBallC.value.set(st.ball.o[0], st.ball.o[1], st.ball.o[2], R);
  U.uShadowK.value = shadows ? SHADOW_K : 0;
  const ballQ = new THREE.Quaternion(...rootQuat(st.ball)).multiply(st.ballQ);
  return (
    <group>
      <mesh geometry={geo} material={overrideMaterial ?? mats.skin} castShadow={castShadow} receiveShadow={receiveShadow} frustumCulled={false} />
      <group matrix={foreM} matrixAutoUpdate={false}>
        <mesh geometry={arm.forearm} material={overrideMaterial ?? mats.arm} castShadow={castShadow} receiveShadow={receiveShadow} />
        {cuff === "band" ? <mesh geometry={arm.cuff} material={mats.cuff} castShadow={castShadow} receiveShadow={receiveShadow} /> : null}
      </group>
      <MacroBall
        position={[st.ball.o[0], st.ball.o[1], st.ball.o[2]]}
        quaternion={ballQ}
        led={led}
        ledSweep={st.ledSweep}
        time={t}
        wear={wear}
        capsules={{ a: U.uCapA.value, b: U.uCapB.value }}
        shadows={shadows}
        castShadow={castShadow}
        receiveShadow={receiveShadow}
      />
    </group>
  );
};

const rootQuat = (F: Frame): [number, number, number, number] => {
  const q = new THREE.Quaternion().setFromRotationMatrix(frameMatrix({ ...F, o: [0, 0, 0] }));
  return [q.x, q.y, q.z, q.w];
};

/* ================================================================== */
/* Macro light rig (SPEC §5 recipe at hand scale)                      */
/* ================================================================== */

const bankDir = (i: number, elevDeg: number): V => {
  const a = (i * Math.PI * 2) / 8;
  const e = (elevDeg * Math.PI) / 180;
  return [Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e)];
};

export type MacroHandLightsProps = {
  /** world position of the hand (the ball centre); the shadow camera is fitted around it */
  center?: Vec3;
  /** world direction from the hand toward the rim light (behind the hand relative to the camera) */
  rimDir?: Vec3;
  /** overall flood power 0..1 */
  intensity?: number;
  keyGain?: number;
  rim?: number;
  fill?: number;
  /** teal LED-board accent 0..1 */
  accent?: number;
  /** which two opposite flood banks act as keys (default [1, 5]) */
  keyBanks?: [number, number];
  keyElevation?: number;
};

/**
 * Lights for the S02 macro, following the §5 recipe (two crossed floodlight keys from opposite banks at 35deg,
 * a floodWhite + 15% teal rim from behind, a dark hemisphere fill, a low teal accent from the LED boards).
 * No shadow map: the hand and ball shade each other analytically (soft capsule / sphere shadows from
 * every directional light). Use it INSTEAD of <StadiumLights/> in macro shots.
 */
export const MacroHandLights: React.FC<MacroHandLightsProps> = ({
  center = [0, 1.4, 26],
  rimDir = [0, 0.4, -1],
  intensity = 1,
  keyGain = 1,
  rim = 1,
  fill = 1,
  accent = 0.25,
  keyBanks = [1, 5],
  keyElevation = 35,
}) => {
  const targets = useMemo(() => [0, 1, 2, 3].map(() => new THREE.Object3D()), []);
  const k = clamp01(intensity);
  const c = center;
  targets.forEach((tg) => {
    tg.position.set(...c);
    tg.updateMatrixWorld();
  });
  const dA = bankDir(keyBanks[0], keyElevation);
  const dB = bankDir(keyBanks[1], keyElevation);
  const dR = nrm(rimDir);
  const at = (d: V, dist: number) => add(c, mul(d, dist)) as Vec3;
  const keyCol = lin(PAL.floodWhite);
  const keyWarm = lin(PAL.floodWhite).lerp(lin(PAL.warm), 0.22);
  const rimCol = lin(PAL.floodWhite).lerp(lin(PAL.teal), 0.15);
  return (
    <>
      {targets.map((tg, i) => (
        <primitive key={i} object={tg} />
      ))}
      <directionalLight
        position={at(dA, 1.5)}
        target={targets[0]}
        color={keyCol}
        intensity={1.7 * keyGain * k}
      />
      <directionalLight position={at(dB, 1.5)} target={targets[1]} color={keyWarm} intensity={1.1 * keyGain * k} />
      <directionalLight position={at(dR, 1.5)} target={targets[2]} color={rimCol} intensity={4.5 * rim * k} />
      {accent > 0 ? (
        <directionalLight position={at(nrm([0, 0.08, -1]), 1.5)} target={targets[3]} color={PAL.teal} intensity={1.2 * accent * (0.3 + 0.7 * k)} />
      ) : null}
      <hemisphereLight color="#1b2a33" groundColor="#20381f" intensity={6.0 * fill * (0.35 + 0.65 * k)} />
    </>
  );
};

/** Debug: mesh statistics. */
export const macroHandStats = () => {
  const hg = buildHandGeo();
  return { verts: hg.restPos.length / 3, tris: (hg.geo.index?.count ?? 0) / 3 };
};

/** Hand-space centre of the ball at rest. */
export const MACRO_BALL_CENTER: Vec3 = [0, 0, 0];

/** Debug: the rest-pose hand mesh (hand space, metres) for offline checks. */
export const macroHandRestMesh = () => {
  const hg = buildHandGeo();
  return { pos: hg.restPos, idx: hg.geo.index!.array as Uint32Array };
};

/**
 * Debug: gap (m) between the leather and the index, middle, ring and thumb pads at time t (negative =
 * pressed in; the skinning pushes pressed skin back onto the leather). Used to check the ball never floats.
 */
export const macroContactGaps = (t: number) => {
  const st = macroHandState(t);
  const c = st.ball.o;
  const fingerGap = (f: number) => padGap([st.frames[ph(f, 1)], st.frames[ph(f, 2)]], [ph(f, 1), ph(f, 2)], c).g;
  return {
    index: fingerGap(0),
    middle: fingerGap(1),
    ring: fingerGap(2),
    thumb: padGap([st.frames[TP2]], [TP2], c, 0.1).g,
  };
};
