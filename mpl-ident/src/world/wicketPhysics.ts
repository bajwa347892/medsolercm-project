/**
 * Wicket hit physics: a PURE function of time since the hit.
 *
 * Wicket-local frame (same as world when the <Wicket/> has no rotation):
 *   origin = ground point under the middle stump, Y up,
 *   the three stumps stand along X at x = -spacing, 0, +spacing,
 *   bails lie along X on top of the stumps.
 *
 *   const s = wicketHitState(t, { dir: [0, 0, -1], stump: 1, toward: [0.3, 0.2, -1] });
 *   <Wicket position={[0, 0, STRIKER_STUMPS_Z]} state={s} />
 *
 * Hero bail into the lens (S09 -> S10 transition): give the wicket-local point just in front of
 * the camera and the action time at which the bail must be there; the launch is solved exactly.
 *   const T = actionTime(465, keys) - actionTime(438, keys);         // slow-motion seconds
 *   const lens = camWorld - wicketWorld + 0.22 m toward the wicket; // wicket-local target
 *   wicketHitState(t, { dir, stump: 1, heroTarget: lens, heroTime: T, heroSpin: 14 });
 *
 * `t` is ACTION time in seconds since the ball touched the stumps (use actionTime()
 * for slow motion). For t <= 0 the wicket is intact.
 *
 * Timing (strength 1): the struck stump is kicked back, peaks at ~0.09s and settles
 * leaning ~16 deg by ~0.5s. Bails lift off immediately, apex ~0.25-0.35s,
 * first ground contact ~0.55-0.75s, at rest by ~1.4s.
 */
import * as THREE from "three";
import { STUMPS } from "./dims";
import type { Vec3 } from "../rig/types";

export const GRAVITY = 9.81;

/** Bail geometry shared with Props.tsx so physics and mesh agree. */
export const BAIL = {
  longSpigot: 0.0349,
  barrel: 0.054,
  shortSpigot: 0.0206,
  spigotRadius: 0.0047,
  barrelRadius: 0.0094,
} as const;
/**
 * The bail groove cut across each stump top (along X): round-bottomed, `radius` wide on each side of
 * the centre line, its floor `depth` below the dome's apex (STUMPS.height). Props.tsx models it.
 */
export const STUMP_GROOVE = { depth: 0.004, radius: 0.0052 } as const;
/**
 * Height of a resting bail's axis: the spigots lie on the groove floors. The barrel then stands
 * ~1.07 cm above the stump tops (Law 8 allows at most 1.27 cm).
 */
export const BAIL_REST_Y = STUMPS.height - STUMP_GROOVE.depth + BAIL.spigotRadius;
/** x of each bail's barrel centre (between stumps 0-1 and 1-2). */
export const BAIL_REST_X = [-STUMPS.spacing / 2, STUMPS.spacing / 2] as const;
export const STUMP_X = [-STUMPS.spacing, 0, STUMPS.spacing] as const;

export type WicketHit = {
  /** horizontal direction the ball (or throw) was travelling, wicket-local. y is ignored. */
  dir: Vec3;
  /** stump that takes the hit: 0 = -X stump, 1 = middle, 2 = +X stump. Default 1. */
  stump?: 0 | 1 | 2;
  /** 0.4 (nudge) .. 1 (fast direct hit) .. 1.4 (rocket). Default 1. */
  strength?: number;
  /** optional direction (wicket-local, any length) for the hero bail, e.g. toward the camera. */
  toward?: Vec3;
  /** hero bail launch speed in m/s along `toward` (default 3.4 * strength). */
  towardSpeed?: number;
  /** which bail flies along `toward` / to `heroTarget`; default the bail nearest the struck stump. */
  heroBail?: 0 | 1;
  /**
   * Exact aim for the hero bail (wicket-local, metres): its barrel centre passes through this point
   * at action time `heroTime` after the hit (ballistic, solved analytically). Overrides `toward`.
   * Keep the point above ~0.05 m so the arc does not touch the ground first.
   */
  heroTarget?: Vec3;
  /** seconds (action time) for the hero bail to reach heroTarget. Default 0.45. */
  heroTime?: number;
  /** hero bail tumble rate, rad/s (default 16 * strength). */
  heroSpin?: number;
  /**
   * hero bail tumble axis (wicket-local). Default: its flight direction, so the bail cartwheels
   * face-on to a camera it flies at (the long axis sweeps across the frame).
   */
  heroSpinAxis?: Vec3;
  /** variation seed */
  seed?: number;
};

export type StumpState = {
  /** rotation about the stump's base point (ground), Euler XYZ radians */
  rotation: Vec3;
  quaternion: [number, number, number, number];
  /** small translation of the base, metres */
  offset: Vec3;
};
export type BailState = {
  /** barrel centre, wicket-local metres */
  position: Vec3;
  /** Euler XYZ radians (the bail's long axis is local X, long spigot toward -X) */
  rotation: Vec3;
  quaternion: [number, number, number, number];
  /** true once the bail has left the stumps */
  flying: boolean;
};
export type WicketState = {
  stumps: [StumpState, StumpState, StumpState];
  bails: [BailState, BailState];
};

const Q_ID: [number, number, number, number] = [0, 0, 0, 1];
// Rest orientation of each bail: long spigot toward the outside stump.
const BAIL_REST_Q: [number, number, number, number][] = [
  [0, 0, 0, 1],
  [0, 1, 0, 0], // 180 deg about Y
];

const restStump = (): StumpState => ({ rotation: [0, 0, 0], quaternion: [...Q_ID], offset: [0, 0, 0] });
const restBail = (i: 0 | 1): BailState => ({
  position: [BAIL_REST_X[i], BAIL_REST_Y, 0],
  rotation: i === 0 ? [0, 0, 0] : [0, Math.PI, 0],
  quaternion: [...BAIL_REST_Q[i]],
  flying: false,
});

/** The intact wicket. */
export const WICKET_REST: WicketState = {
  stumps: [restStump(), restStump(), restStump()],
  bails: [restBail(0), restBail(1)],
};

// deterministic per-seed variation in [0,1)
const h = (seed: number, k: number) => {
  const x = Math.sin((seed + 1) * 12.9898 + k * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _axis = new THREE.Vector3();

const pack = (q: THREE.Quaternion) => {
  _e.setFromQuaternion(q, "XYZ");
  return {
    rotation: [_e.x, _e.y, _e.z] as Vec3,
    quaternion: [q.x, q.y, q.z, q.w] as [number, number, number, number],
  };
};

/* ------------------------------------------------------------------ */
/* Stumps: kicked impulse + permanent lean (displaced in the soil).    */
/* ------------------------------------------------------------------ */
const stumpAngle = (t: number, rest: number, kick: number, w: number, lambda: number) => {
  if (t <= 0) return 0;
  const e = Math.exp(-lambda * t);
  return rest * (1 - e) + kick * e * Math.sin(w * t);
};

/* ------------------------------------------------------------------ */
/* Bails: ballistic arcs with analytic bounces, friction slide, settle.*/
/* ------------------------------------------------------------------ */
type BailLaunch = { v: THREE.Vector3; spinAxis: THREE.Vector3; spin: number };

const CLEAR = 0.0088; // centre height of a bail lying on the grass
const REST_E = 0.32; // vertical restitution
const FRICTION = 0.55; // horizontal speed kept per bounce
const SPIN_KEEP = 0.45;
const SLIDE_DECEL = 3.2; // m/s^2 once the bounces are over
const MAX_BOUNCES = 3;

const simulateBail = (t: number, p0: THREE.Vector3, L: BailLaunch) => {
  // returns position, accumulated spin angle and the time it came to rest (or -1)
  const p = p0.clone();
  const v = L.v.clone();
  let spin = L.spin;
  let angle = 0;
  let tt = 0;
  for (let b = 0; b <= MAX_BOUNCES; b++) {
    // time to reach clearance height
    const disc = v.y * v.y + 2 * GRAVITY * (p.y - CLEAR);
    const tau = (v.y + Math.sqrt(Math.max(0, disc))) / GRAVITY;
    if (t <= tt + tau) {
      const d = t - tt;
      return {
        pos: new THREE.Vector3(p.x + v.x * d, p.y + v.y * d - 0.5 * GRAVITY * d * d, p.z + v.z * d),
        angle: angle + spin * d,
        settle: 0,
        airborne: true,
      };
    }
    p.set(p.x + v.x * tau, CLEAR, p.z + v.z * tau);
    angle += spin * tau;
    tt += tau;
    const vyImpact = v.y - GRAVITY * tau;
    v.set(v.x * FRICTION, -vyImpact * REST_E, v.z * FRICTION);
    spin *= SPIN_KEEP;
    if (v.y < 0.25) break;
  }
  // slide to a stop along the ground
  const speed = Math.hypot(v.x, v.z);
  const tStop = speed / SLIDE_DECEL;
  const d = Math.min(t - tt, tStop);
  const dirx = speed > 1e-6 ? v.x / speed : 0;
  const dirz = speed > 1e-6 ? v.z / speed : 0;
  const s = speed * d - 0.5 * SLIDE_DECEL * d * d;
  // spin decays to zero over the slide
  const spinAngle = tStop > 0 ? spin * (d - (0.5 * d * d) / tStop) : 0;
  return {
    pos: new THREE.Vector3(p.x + dirx * s, CLEAR, p.z + dirz * s),
    angle: angle + spinAngle,
    settle: Math.min(1, (t - tt) / Math.max(0.12, tStop)),
    airborne: false,
  };
};

/**
 * State of the wicket `tSinceHit` seconds (action time) after the ball hits it.
 * Pure: same inputs, same output, any evaluation order.
 */
export const wicketHitState = (tSinceHit: number, hit: WicketHit): WicketState => {
  if (!(tSinceHit > 0)) return WICKET_REST;
  const t = tSinceHit;
  const seed = hit.seed ?? 7;
  const s = hit.strength ?? 1;
  const k = hit.stump ?? 1;
  const dir = new THREE.Vector3(hit.dir[0], 0, hit.dir[2]);
  if (dir.lengthSq() < 1e-8) dir.set(0, 0, -1);
  dir.normalize();
  // axis that tips a stump's top along dir
  const tipAxis = new THREE.Vector3(0, 1, 0).cross(dir).normalize();

  const stumps = [0, 1, 2].map((i) => {
    const dist = Math.abs(i - k);
    let rest: number, kick: number, w: number, lambda: number;
    if (dist === 0) {
      rest = (0.24 + 0.08 * h(seed, 1)) * s;
      kick = (0.2 + 0.06 * h(seed, 2)) * s;
      w = 15;
      lambda = 7.5;
    } else {
      // neighbours shudder from the bails/soil and keep a tiny lean
      const near = dist === 1 ? 1 : 0.35;
      rest = (0.015 + 0.02 * h(seed, 3 + i)) * s * near;
      kick = 0.045 * s * near;
      w = 38;
      lambda = 9;
    }
    const a = stumpAngle(t, rest, kick, w, lambda);
    // a touch of twist on the struck stump so it doesn't look hinged
    const side = (h(seed, 11) - 0.5) * 0.25 * (dist === 0 ? 1 : 0.3);
    _axis.copy(tipAxis).applyAxisAngle(new THREE.Vector3(0, 1, 0), side).normalize();
    _q.setFromAxisAngle(_axis, a);
    if (dist === 0) {
      _q2.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (h(seed, 12) - 0.5) * 0.3 * Math.min(1, t * 6) * s);
      _q.multiply(_q2);
    }
    const push = dist === 0 ? 0.018 * s * (1 - Math.exp(-14 * t)) : 0;
    return { ...pack(_q), offset: [dir.x * push, 0, dir.z * push] as Vec3 };
  }) as [StumpState, StumpState, StumpState];

  // bail nearest the struck stump is the hero by default
  const hero: 0 | 1 = hit.heroBail ?? (k === 0 ? 0 : k === 2 ? 1 : h(seed, 20) < 0.5 ? 0 : 1);

  const bails = ([0, 1] as const).map((i) => {
    const p0 = new THREE.Vector3(BAIL_REST_X[i], BAIL_REST_Y, 0);
    // which side of the struck stump is this bail (outward spread direction along X)
    const bx = BAIL_REST_X[i] - STUMP_X[k];
    const outward = Math.abs(bx) < 1e-6 ? (i === 0 ? -1 : 1) : Math.sign(bx);
    const adjacent = Math.abs(bx) < STUMPS.spacing * 0.75;
    const energy = adjacent ? 1 : 0.62;
    let v: THREE.Vector3;
    let heroAxis: THREE.Vector3 | null = null;
    if (hit.heroTarget && i === hero) {
      const T = Math.max(0.05, hit.heroTime ?? 0.45);
      v = new THREE.Vector3(...hit.heroTarget).sub(p0).divideScalar(T);
      v.y += 0.5 * GRAVITY * T;
      const ax = hit.heroSpinAxis ? new THREE.Vector3(...hit.heroSpinAxis) : v.clone().setY(v.y * 0.2);
      if (ax.lengthSq() < 1e-8) ax.set(0, 0, 1);
      // a little precession so it never looks like a perfect propeller
      heroAxis = ax.normalize().add(new THREE.Vector3(0.12 * (h(seed, 50) - 0.5), 0.1, 0)).normalize();
    } else if (hit.toward && i === hero) {
      const T = new THREE.Vector3(...hit.toward);
      if (T.lengthSq() < 1e-8) T.set(0, 0.3, 1);
      T.normalize();
      const sp = hit.towardSpeed ?? 3.4 * s;
      // a little extra lift so the arc carries toward the target instead of dropping at once
      v = T.multiplyScalar(sp).add(new THREE.Vector3(0, 1.1 * s, 0));
    } else {
      const along = (2.0 + 1.0 * h(seed, 30 + i)) * s * energy;
      const up = (2.3 + 1.1 * h(seed, 32 + i)) * s * energy;
      const lat = (0.5 + 0.9 * h(seed, 34 + i)) * s * outward;
      v = new THREE.Vector3(dir.x * along, up, dir.z * along).add(new THREE.Vector3(lat, 0, 0));
    }
    // tumble mostly end-over-end: spin axis roughly perpendicular to the bail axis (X)
    const ang = h(seed, 40 + i) * Math.PI * 2;
    const spinAxis = heroAxis ?? new THREE.Vector3(0.25 * (h(seed, 42 + i) - 0.5), Math.cos(ang), Math.sin(ang)).normalize();
    const spin =
      heroAxis !== null
        ? (hit.heroSpin ?? 16 * s)
        : (16 + 14 * h(seed, 44 + i)) * s * (h(seed, 46 + i) < 0.5 ? -1 : 1);
    // a short delay for the non-adjacent bail (it is knocked by its neighbour); never for an aimed hero
    const delay = adjacent || heroAxis !== null ? 0 : 0.008 + 0.01 * h(seed, 48 + i);
    const tb = t - delay;
    if (tb <= 0) return restBail(i);
    const sim = simulateBail(tb, p0, { v, spinAxis, spin });
    _q.setFromAxisAngle(spinAxis, sim.angle);
    _q2.set(...BAIL_REST_Q[i]);
    _q.multiply(_q2); // world spin applied after rest orientation
    if (!sim.airborne && sim.settle > 0) {
      // blend to lying flat: keep the heading of the long axis, level it
      const ax = _v.set(1, 0, 0).applyQuaternion(_q);
      const yaw = Math.atan2(-ax.z, ax.x);
      const flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      const e = sim.settle * sim.settle * (3 - 2 * sim.settle);
      _q.slerp(flat, e);
    }
    return { position: [sim.pos.x, sim.pos.y, sim.pos.z] as Vec3, ...pack(_q), flying: true };
  }) as [BailState, BailState];

  return { stumps, bails };
};
