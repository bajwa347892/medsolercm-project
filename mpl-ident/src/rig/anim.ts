/**
 * Deterministic keyframe curves for the action library (pure functions of t).
 */
import * as THREE from "three";
import type { Vec3 } from "./types";

export const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
export const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale3 = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const len3 = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const norm3 = (a: Vec3): Vec3 => {
  const l = len3(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const v3 = (a: Vec3) => new THREE.Vector3(a[0], a[1], a[2]);
export const deg = (d: number) => (d * Math.PI) / 180;

/** 0..1 smoothstep between a and b */
export const sstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** smootherstep (C2) */
export const s5 = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a));
  return t * t * t * (t * (t * 6 - 15) + 10);
};
export const easeOut = (x: number, p = 2) => 1 - Math.pow(1 - clamp(x), p);
export const easeIn = (x: number, p = 2) => Math.pow(clamp(x), p);
/** 0 -> 1 -> 0 smooth bump over [a, b] */
export const bump = (a: number, b: number, x: number) => {
  if (x <= a || x >= b) return 0;
  const t = (x - a) / (b - a);
  return Math.sin(Math.PI * t) ** 2;
};
/** remap t from [a,b] to [0,1] clamped */
export const span = (a: number, b: number, t: number) => clamp((t - a) / (b - a));

/* ------------------------------------------------------------------ */
/* Hermite key tracks                                                  */
/* ------------------------------------------------------------------ */

/** A key: [time, value] or [time, value, tangentScale] (0 = stop at this key). */
export type Key<T> = [number, T] | [number, T, number];

const hermite = (p0: number, m0: number, p1: number, m1: number, s: number, dt: number) => {
  const s2 = s * s;
  const s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * dt * m0 + (-2 * s3 + 3 * s2) * p1 + (s3 - s2) * dt * m1;
};

const findSeg = (times: number[], t: number) => {
  let i = 0;
  while (i < times.length - 2 && t > times[i + 1]) i++;
  return i;
};

/** Generic N-dimensional Catmull-Rom (non-uniform) track; first and last keys have zero velocity. */
const trackN = (keys: Key<number[]>[], t: number): number[] => {
  const n = keys.length;
  if (n === 1 || t <= keys[0][0]) return keys[0][1].slice();
  if (t >= keys[n - 1][0]) return keys[n - 1][1].slice();
  const times = keys.map((k) => k[0]);
  const i = findSeg(times, t);
  const [t0, p0] = keys[i];
  const [t1, p1] = keys[i + 1];
  const dt = t1 - t0;
  const s = dt > 0 ? (t - t0) / dt : 1;
  const tan = (j: number, d: number) => {
    if (j <= 0 || j >= n - 1) return 0;
    const sc = keys[j][2] ?? 1;
    if (sc === 0) return 0;
    const a = keys[j - 1];
    const b = keys[j + 1];
    return (sc * (b[1][d] - a[1][d])) / (b[0] - a[0]);
  };
  return p0.map((_, d) => hermite(p0[d], tan(i, d), p1[d], tan(i + 1, d), s, dt));
};

/** Scalar track. */
export const track = (keys: Key<number>[], t: number) =>
  trackN(
    keys.map((k) => (k.length === 3 ? [k[0], [k[1]], k[2]] : [k[0], [k[1]]]) as Key<number[]>),
    t,
  )[0];

/** Vec3 track (smooth spatial arcs through the keys). */
export const track3 = (keys: Key<Vec3>[], t: number): Vec3 => {
  const r = trackN(keys as unknown as Key<number[]>[], t);
  return [r[0], r[1], r[2]];
};

/** Quaternion track: hemisphere-aligned component spline, normalised. */
export const trackQ = (keys: Key<THREE.Quaternion>[], t: number): THREE.Quaternion => {
  const arr: Key<number[]>[] = [];
  let prev: THREE.Quaternion | null = null;
  for (const k of keys) {
    const q = k[1].clone();
    if (prev && prev.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
    prev = q;
    arr.push(k.length === 3 ? [k[0], [q.x, q.y, q.z, q.w], k[2]] : [k[0], [q.x, q.y, q.z, q.w]]);
  }
  const r = trackN(arr, t);
  return new THREE.Quaternion(r[0], r[1], r[2], r[3]).normalize();
};

/** Build a rotation from a "toe/forward" axis image and an "up/face" hint (both char space). */
export const basisQ = (yAxis: Vec3, zHint: Vec3) => {
  const Y = v3(yAxis).normalize();
  const Z = v3(zHint);
  Z.addScaledVector(Y, -Z.dot(Y)).normalize();
  const X = new THREE.Vector3().crossVectors(Y, Z).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
};

/** Rotation about +Y (yaw) as a quaternion. */
export const yawQ = (a: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a);

/** Rotate a Vec3 about +Y. */
export const rotY3 = (p: Vec3, a: number): Vec3 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
};

/** Deterministic smooth noise in [-1, 1] (sum of incommensurate sines). */
export const wobble = (t: number, seed = 0) =>
  (Math.sin(t * 1.7 + seed * 3.1) * 0.5 + Math.sin(t * 2.9 + seed * 1.3 + 1.1) * 0.3 + Math.sin(t * 4.3 + seed * 0.7 + 2.3) * 0.2);
