/**
 * Procedural body geometry in the REST pose (character space, see solve.ts).
 * Smooth lofted parts with skin weights over the solver's bones, so elbows, knees,
 * the waist and the neck bend smoothly. Rigid parts (head, hands, shoes, gear) are built
 * in their own bone-local frames.
 *
 * All geometry is cached per level of detail and shared by every Player instance.
 */
import * as THREE from "three";
import { BONE_INDEX, OFFSETS, restSolved, type Bone } from "./solve";

export type Detail = "hero" | "mid" | "far";
export const RINGSEG: Record<Detail, number> = { hero: 40, mid: 26, far: 14 };

type W = [Bone, number][];

type Ring = {
  c: THREE.Vector3;
  u: THREE.Vector3;
  v: THREE.Vector3;
  /** offset in the (u, v) plane for angle th (th = 0 -> +u, pi/2 -> +v) */
  shape: (th: number) => [number, number];
};

type Part = {
  pos: number[];
  idx: number[];
  si: number[];
  sw: number[];
  part: number[];
};

const newPart = (): Part => ({ pos: [], idx: [], si: [], sw: [], part: [] });

const pushWeights = (p: Part, w: W) => {
  const ws = w.filter(([, x]) => x > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const tot = ws.reduce((a, [, x]) => a + x, 0) || 1;
  for (let i = 0; i < 4; i++) {
    p.si.push(ws[i] ? BONE_INDEX[ws[i][0]] : 0);
    p.sw.push(ws[i] ? ws[i][1] / tot : 0);
  }
};

/**
 * Loft rings into a tube. Optional end caps collapse to a point.
 * weights(p) gives the bone weights of a rest-space vertex.
 */
const loft = (
  out: Part,
  rings: Ring[],
  seg: number,
  weights: (p: THREE.Vector3) => W,
  partId: number,
  capStart = false,
  capEnd = false,
) => {
  const base = out.pos.length / 3;
  const pt = new THREE.Vector3();
  for (const r of rings) {
    for (let j = 0; j < seg; j++) {
      const th = (j / seg) * Math.PI * 2;
      const [a, b] = r.shape(th);
      pt.copy(r.c).addScaledVector(r.u, a).addScaledVector(r.v, b);
      out.pos.push(pt.x, pt.y, pt.z);
      pushWeights(out, weights(pt));
      out.part.push(partId);
    }
  }
  const P = (k: number) => new THREE.Vector3(out.pos[k * 3], out.pos[k * 3 + 1], out.pos[k * 3 + 2]);
  /** push a triangle oriented so that its normal agrees with `hint` */
  const tri = (a: number, b: number, c: number, hint: THREE.Vector3) => {
    const pa = P(a);
    const n = P(b).sub(pa).cross(P(c).sub(pa));
    if (n.dot(hint) >= 0) out.idx.push(a, b, c);
    else out.idx.push(a, c, b);
  };
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < seg; j++) {
      const a = base + i * seg + j;
      const b = base + i * seg + ((j + 1) % seg);
      const c = base + (i + 1) * seg + j;
      const d = base + (i + 1) * seg + ((j + 1) % seg);
      const hint = P(a).add(P(d)).multiplyScalar(0.5).sub(rings[i].c.clone().add(rings[i + 1].c).multiplyScalar(0.5));
      tri(a, c, b, hint);
      tri(b, c, d, hint);
    }
  }
  const cap = (ri: number) => {
    const r = rings[ri];
    // pole slightly beyond the ring along the loft direction
    const other = rings[ri === 0 ? 1 : ri - 1];
    const dir = r.c.clone().sub(other.c).normalize();
    let avg = 0;
    for (let j = 0; j < 8; j++) {
      const [a, b] = r.shape((j / 8) * Math.PI * 2);
      avg += Math.hypot(a, b) / 8;
    }
    const pole = r.c.clone().addScaledVector(dir, avg * 0.35);
    const pi = out.pos.length / 3;
    out.pos.push(pole.x, pole.y, pole.z);
    pushWeights(out, weights(pole));
    out.part.push(partId);
    for (let j = 0; j < seg; j++) {
      const a = base + ri * seg + j;
      const b = base + ri * seg + ((j + 1) % seg);
      tri(pi, a, b, dir);
    }
  };
  if (capStart) cap(0);
  if (capEnd) cap(rings.length - 1);
};

const toGeometry = (p: Part, skinned: boolean) => {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(p.pos, 3));
  if (skinned) {
    g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(p.si, 4));
    g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(p.sw, 4));
  }
  g.setAttribute("aPart", new THREE.Float32BufferAttribute(p.part, 1));
  g.setAttribute("aHair", new THREE.Float32BufferAttribute(new Float32Array(p.part.length), 1));
  g.setIndex(p.idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
};

/** Mirror a part across X (left -> right), swapping l/r bones and flipping winding. */
const mirrorInto = (src: Part, dst: Part) => {
  const base = dst.pos.length / 3;
  for (let i = 0; i < src.pos.length; i += 3) dst.pos.push(-src.pos[i], src.pos[i + 1], src.pos[i + 2]);
  const swap = new Map<number, number>();
  const names = Object.keys(BONE_INDEX) as Bone[];
  for (const n of names) {
    if (n.startsWith("l")) swap.set(BONE_INDEX[n], BONE_INDEX[("r" + n.slice(1)) as Bone]);
    if (n.startsWith("r") && n !== "root") swap.set(BONE_INDEX[n], BONE_INDEX[("l" + n.slice(1)) as Bone]);
  }
  for (const s of src.si) dst.si.push(swap.get(s) ?? s);
  for (const w of src.sw) dst.sw.push(w);
  for (const q of src.part) dst.part.push(q);
  for (let i = 0; i < src.idx.length; i += 3) dst.idx.push(base + src.idx[i], base + src.idx[i + 2], base + src.idx[i + 1]);
};

const appendPart = (src: Part, dst: Part) => {
  const base = dst.pos.length / 3;
  dst.pos.push(...src.pos);
  dst.si.push(...src.si);
  dst.sw.push(...src.sw);
  dst.part.push(...src.part);
  for (const i of src.idx) dst.idx.push(base + i);
};

/* ------------------------------------------------------------------ */
/* Shape helpers                                                       */
/* ------------------------------------------------------------------ */

const sstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const gauss = (x: number, s: number) => Math.exp(-(x * x) / (2 * s * s));

/** Asymmetric superellipse: half-widths ax+ / ax- along u, bz+ / bz- along v, exponent n. */
const superEl = (axp: number, axn: number, bzp: number, bzn: number, n: number) => (th: number): [number, number] => {
  const c = Math.cos(th);
  const s = Math.sin(th);
  const e = 2 / n;
  const x = Math.sign(c) * Math.pow(Math.abs(c), e) * (c >= 0 ? axp : axn);
  const z = Math.sign(s) * Math.pow(Math.abs(s), e) * (s >= 0 ? bzp : bzn);
  return [x, z];
};

/** piecewise-linear interpolation over a table of [s, ...values] rows (smoothstep between rows) */
const table = (rows: number[][], s: number, col: number) => {
  if (s <= rows[0][0]) return rows[0][col];
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i];
    const b = rows[i + 1];
    if (s <= b[0]) {
      const t = (s - a[0]) / (b[0] - a[0]);
      const k = t * t * (3 - 2 * t) * 0.5 + t * 0.5;
      return a[col] + (b[col] - a[col]) * k;
    }
  }
  return rows[rows.length - 1][col];
};

/* ------------------------------------------------------------------ */
/* Rest-pose joint positions                                           */
/* ------------------------------------------------------------------ */

const restPos = (b: Bone) => new THREE.Vector3().setFromMatrixPosition(restSolved()[b]);

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

/* ------------------------------------------------------------------ */
/* Torso                                                               */
/* ------------------------------------------------------------------ */

/**
 * Shirt torso: rows [y, halfWidth, frontDepth, backDepth, centreZ, exponent]
 * (rest-space heights; pelvis 0.99, chest joint 1.285, shoulder joints 1.465, neck base 1.51).
 */
const TORSO_ROWS = [
  [0.865, 0.202, 0.13, 0.144, -0.012, 2.3],
  [0.9, 0.193, 0.124, 0.138, -0.011, 2.3],
  [0.94, 0.181, 0.117, 0.128, -0.01, 2.3],
  [0.99, 0.172, 0.112, 0.116, -0.008, 2.3],
  [1.05, 0.162, 0.108, 0.104, -0.004, 2.35],
  [1.11, 0.158, 0.11, 0.102, 0.0, 2.4],
  [1.17, 0.163, 0.118, 0.107, 0.002, 2.45],
  [1.23, 0.172, 0.128, 0.112, 0.004, 2.5],
  [1.29, 0.181, 0.135, 0.116, 0.002, 2.6],
  [1.34, 0.188, 0.135, 0.12, -0.004, 2.6],
  [1.39, 0.195, 0.128, 0.122, -0.01, 2.6],
  [1.425, 0.214, 0.117, 0.118, -0.016, 2.8],
  [1.455, 0.214, 0.103, 0.108, -0.021, 2.8],
  // trapezius: a convex slope from the shoulder caps up to the neck (no coat-hanger shoulders)
  [1.477, 0.206, 0.09, 0.098, -0.025, 2.6],
  [1.495, 0.185, 0.08, 0.09, -0.027, 2.35],
  [1.512, 0.155, 0.072, 0.084, -0.029, 2.15],
  [1.53, 0.121, 0.064, 0.08, -0.032, 2.0],
  [1.548, 0.092, 0.054, 0.078, -0.036, 2.0],
  [1.565, 0.073, 0.043, 0.07, -0.038, 2.0],
  [1.578, 0.052, 0.03, 0.052, -0.036, 2.0],
];

const torsoWeights = (p: THREE.Vector3): W => {
  const y = p.y;
  const wRoot = 1 - sstep(0.96, 1.1, y);
  const wChest = sstep(1.1, 1.27, y);
  const wSpine = Math.max(0, 1 - wRoot - wChest);
  const ax = Math.abs(p.x);
  const clav = 0.85 * sstep(0.095, 0.165, ax) * sstep(1.37, 1.47, y);
  const arm = 0.4 * sstep(0.165, 0.205, ax) * sstep(1.33, 1.43, y);
  const neck = 0.55 * sstep(1.49, 1.55, y) * (1 - sstep(0.06, 0.1, ax));
  const chest = wChest * (1 - clav) * (1 - neck) * (1 - arm);
  const side: Bone = p.x >= 0 ? "lClav" : "rClav";
  const hem = 0.32 * (1 - sstep(0.875, 0.97, y)) * sstep(0.03, 0.12, ax);
  return [
    ["root", wRoot * (1 - hem)],
    [p.x >= 0 ? "lHip" : "rHip", wRoot * hem],
    ["spine", wSpine],
    ["chest", chest],
    [side, wChest * clav * (1 - arm)],
    [p.x >= 0 ? "lShoulder" : "rShoulder", wChest * arm],
    ["neck", wChest * neck * (1 - clav)],
  ];
};

const buildShirtTorso = (out: Part, seg: number) => {
  const rings: Ring[] = [];
  const ys: number[] = [];
  for (let y = 0.865; y <= 1.566; y += 0.0115) ys.push(y);
  ys.push(1.578);
  for (const y of ys) {
    const hw = table(TORSO_ROWS, y, 1);
    const fd = table(TORSO_ROWS, y, 2);
    const bd = table(TORSO_ROWS, y, 3);
    const zc = table(TORSO_ROWS, y, 4);
    const n = table(TORSO_ROWS, y, 5);
    const base = superEl(hw, hw, fd, bd, n);
    const shape = (th: number): [number, number] => {
      const [x, z] = base(th);
      const ax = Math.abs(x);
      let dz = 0;
      let dx = 0;
      if (z > 0) {
        // pectorals: two soft masses, a shallow sternum line
        dz += 0.011 * gauss(ax - 0.075, 0.045) * gauss(y - 1.32, 0.055);
        dz -= 0.004 * gauss(x, 0.018) * gauss(y - 1.3, 0.09);
        // abdominal wall, slight
        dz += 0.004 * gauss(ax - 0.035, 0.03) * gauss(y - 1.12, 0.06);
      } else {
        // shoulder blades and the spinal groove
        dz -= 0.01 * gauss(ax - 0.085, 0.045) * gauss(y - 1.37, 0.07);
        dz += 0.005 * gauss(x, 0.016) * gauss(y - 1.25, 0.2);
        // glutes under the hem
        dz -= 0.012 * gauss(ax - 0.075, 0.06) * gauss(y - 0.93, 0.04);
      }
      // lats flare
      dx += 0.008 * gauss(y - 1.35, 0.06) * Math.sign(x) * gauss(z / (fd + bd), 0.3);
      // trapezius ridge toward the neck
      return [x + dx, z + dz];
    };
    rings.push({ c: new THREE.Vector3(0, y, zc), u: X, v: Z, shape });
  }
  // the collar stand: a short ring above the neckline
  loft(out, rings, seg, torsoWeights, 0, false, false);
};

/** Trouser seat: pelvis volume under the shirt hem, closed at the crotch. */
const buildSeat = (out: Part, seg: number) => {
  const rows = [
    [0.8, 0.07, 0.045, 0.05, -0.012, 2.0],
    [0.82, 0.13, 0.08, 0.095, -0.012, 2.2],
    [0.85, 0.165, 0.098, 0.12, -0.014, 2.3],
    [0.89, 0.178, 0.106, 0.13, -0.014, 2.3],
    [0.93, 0.176, 0.108, 0.125, -0.012, 2.3],
    [0.97, 0.168, 0.104, 0.115, -0.01, 2.3],
    [1.0, 0.163, 0.102, 0.108, -0.008, 2.3],
  ];
  const rings: Ring[] = [];
  for (let y = 0.8; y <= 1.0001; y += 0.02) {
    const base = superEl(table(rows, y, 1), table(rows, y, 1), table(rows, y, 2), table(rows, y, 3), table(rows, y, 5));
    const shape = (th: number): [number, number] => {
      const [x, z] = base(th);
      let dz = 0;
      if (z < 0) dz -= 0.014 * gauss(Math.abs(x) - 0.072, 0.05) * gauss(y - 0.885, 0.045);
      return [x, z + dz];
    };
    rings.push({ c: new THREE.Vector3(0, y, table(rows, y, 4)), u: X, v: Z, shape });
  }
  const w = (p: THREE.Vector3): W => {
    // hip flexion should pull the seat a little: blend toward the hip bones at the bottom sides
    const k = 0.35 * (1 - sstep(0.82, 0.92, p.y)) * sstep(0.02, 0.1, Math.abs(p.x));
    return [
      ["root", 1 - k],
      [p.x >= 0 ? "lHip" : "rHip", k],
    ];
  };
  loft(out, rings, seg, w, 3, true, false);
};

/* ------------------------------------------------------------------ */
/* Legs (left; mirrored for right)                                     */
/* ------------------------------------------------------------------ */

/** rows [s below hip, halfWidth(x), front, back, centreZ] for fitted trousers */
const LEG_ROWS = [
  [-0.07, 0.066, 0.07, 0.08, -0.01],
  [0.0, 0.082, 0.088, 0.1, -0.006],
  [0.07, 0.094, 0.098, 0.103, 0.0],
  [0.15, 0.094, 0.097, 0.093, 0.004],
  [0.24, 0.086, 0.09, 0.083, 0.004],
  [0.33, 0.076, 0.079, 0.071, 0.002],
  [0.4, 0.068, 0.068, 0.065, 0.0],
  [0.45, 0.064, 0.064, 0.063, 0.0],
  [0.5, 0.062, 0.058, 0.069, -0.006],
  [0.58, 0.063, 0.055, 0.077, -0.012],
  [0.66, 0.057, 0.051, 0.067, -0.01],
  [0.74, 0.051, 0.049, 0.055, -0.006],
  [0.81, 0.049, 0.05, 0.052, -0.004],
  [0.86, 0.051, 0.055, 0.054, 0.0],
];

const legWeights = (side: "l") => (p: THREE.Vector3): W => {
  const hip = restPos(`${side}Hip`);
  const s = hip.y - p.y;
  const wRoot = 0.55 * (1 - sstep(-0.06, 0.13, s));
  const wKnee = sstep(0.38, 0.5, s);
  return [
    ["root", wRoot],
    [`${side}Hip`, Math.max(0, 1 - wRoot - wKnee)],
    [`${side}Knee`, wKnee],
  ];
};

const buildLeg = (out: Part, seg: number) => {
  const hip = restPos("lHip");
  const rings: Ring[] = [];
  for (let s = -0.07; s <= 0.8601; s += 0.0155) {
    const hw = table(LEG_ROWS, s, 1);
    const fr = table(LEG_ROWS, s, 2);
    const bk = table(LEG_ROWS, s, 3);
    const zc = table(LEG_ROWS, s, 4);
    const base = superEl(hw, hw * 0.96, fr, bk, 2.15);
    rings.push({ c: new THREE.Vector3(hip.x, hip.y - s, hip.z + zc), u: X, v: Z, shape: base });
  }
  loft(out, rings, seg, legWeights("l"), 3, true, false);
};

/* ------------------------------------------------------------------ */
/* Arms (left; mirrored for right)                                     */
/* ------------------------------------------------------------------ */

/** rows [s below shoulder joint, halfX (lateral), halfZ+ (front), halfZ- (back), centreX, centreZ] */
const ARM_ROWS = [
  [-0.018, 0.012, 0.02, 0.022, 0.0, 0.0],
  [-0.008, 0.028, 0.036, 0.038, 0.002, 0.0],
  [0.0, 0.04, 0.046, 0.048, 0.005, 0.0],
  [0.05, 0.052, 0.051, 0.051, 0.008, 0.0],
  [0.1, 0.052, 0.052, 0.05, 0.005, 0.0],
  [0.16, 0.047, 0.053, 0.049, 0.0, 0.002],
  [0.22, 0.044, 0.048, 0.046, 0.0, 0.0],
  [0.28, 0.04, 0.04, 0.04, 0.0, -0.002],
  [0.31, 0.039, 0.037, 0.044, 0.0, -0.004],
  [0.36, 0.045, 0.047, 0.043, 0.0, 0.0],
  [0.42, 0.04, 0.042, 0.038, 0.0, 0.0],
  [0.49, 0.032, 0.035, 0.032, 0.0, 0.0],
  [0.545, 0.024, 0.033, 0.03, 0.0, 0.0],
  [0.575, 0.023, 0.031, 0.029, 0.0, 0.0],
];

const armWeights = (p: THREE.Vector3): W => {
  const sh = restPos("lShoulder");
  const s = sh.y - p.y;
  const wFore = sstep(0.255, 0.335, s);
  const wB = sstep(0.36, 0.53, s);
  const wWrist = 0.85 * sstep(0.54, 0.575, s);
  const clav = 0.25 * (1 - sstep(-0.05, 0.03, s));
  return [
    ["lClav", clav],
    ["lShoulder", (1 - wFore) * (1 - clav)],
    ["lForeA", wFore * (1 - wB) * (1 - wWrist)],
    ["lForeB", wFore * wB * (1 - wWrist)],
    ["lWrist", wWrist],
  ];
};

const armRing = (s: number, grow = 0): Ring => {
  const sh = restPos("lShoulder");
  const hx = table(ARM_ROWS, s, 1) + grow;
  const fz = table(ARM_ROWS, s, 2) + grow;
  const bz = table(ARM_ROWS, s, 3) + grow;
  const cx = table(ARM_ROWS, s, 4);
  const cz = table(ARM_ROWS, s, 5);
  const base = superEl(hx, hx * 0.92, fz, bz, 2.1);
  const shape = (th: number): [number, number] => {
    const [x, z] = base(th);
    // biceps / triceps detail on bare skin only
    let dx = 0;
    let dz = 0;
    if (grow === 0) {
      dz += z > 0 ? 0.004 * gauss(s - 0.17, 0.05) * Math.max(0, z / fz) : 0;
      dz += z < 0 ? -0.004 * gauss(s - 0.12, 0.06) * Math.max(0, -z / bz) : 0;
      dx += 0.003 * gauss(s - 0.37, 0.04) * Math.max(0, x / hx);
    }
    return [x + dx, z + dz];
  };
  return { c: new THREE.Vector3(sh.x + cx, sh.y - s, sh.z + cz), u: X, v: Z, shape };
};

const SLEEVE_END = 0.175;

const buildSleeve = (out: Part, seg: number) => {
  const rings: Ring[] = [];
  // dome over the shoulder joint, then the sleeve, with a hem lip
  for (let s = -0.018; s <= SLEEVE_END; s += 0.0115) rings.push(armRing(s, 0.005));
  const hem = armRing(SLEEVE_END, 0.0085);
  rings.push(hem);
  // fold inward (inside of the hem) so the cut edge has thickness
  rings.push(armRing(SLEEVE_END + 0.004, 0.002));
  loft(out, rings, seg, armWeights, 1, true, false);
};

const buildArmSkin = (out: Part, seg: number) => {
  const rings: Ring[] = [];
  for (let s = SLEEVE_END - 0.06; s <= 0.5751; s += 0.0128) rings.push(armRing(s, 0));
  loft(out, rings, seg, armWeights, 2, false, true);
};

/* ------------------------------------------------------------------ */
/* Neck                                                                */
/* ------------------------------------------------------------------ */

const buildNeck = (out: Part, seg: number) => {
  const neck = restPos("neck");
  const head = restPos("head");
  const rings: Ring[] = [];
  for (let y = 1.47; y <= 1.705; y += 0.0118) {
    const t = (y - 1.47) / 0.235;
    // a strong athlete's neck: wide at the base, flaring into the trapezius
    const r = 0.071 - 0.006 * t + 0.008 * gauss(y - 1.5, 0.03);
    const zc = neck.z + (head.z - neck.z) * sstep(1.5, 1.66, y) + 0.004;
    rings.push({
      c: new THREE.Vector3(0, y, zc),
      u: X,
      v: Z,
      shape: (th) => {
        const c = Math.cos(th);
        const s = Math.sin(th);
        // sternocleidomastoid fullness toward the front-sides, slightly deeper than wide
        const k = 1 + 0.06 * Math.pow(Math.abs(Math.sin(th * 2)), 2);
        return [c * r * 0.97 * k, s * r * (s > 0 ? 1.0 : 1.04) * k];
      },
    });
  }
  const w = (p: THREE.Vector3): W => {
    const y = p.y;
    const wHead = sstep(1.6, 1.69, y);
    const wChest = 1 - sstep(1.48, 1.55, y);
    return [
      ["chest", wChest],
      ["neck", Math.max(0, 1 - wHead - wChest)],
      ["head", wHead],
    ];
  };
  loft(out, rings, seg, w, 4, false, false);
};

/* ------------------------------------------------------------------ */
/* Assembled skinned body geometries                                   */
/* ------------------------------------------------------------------ */

export type BodyGeoms = {
  shirt: THREE.BufferGeometry;
  trousers: THREE.BufferGeometry;
  skin: THREE.BufferGeometry;
};

const bodyCache = new Map<Detail, BodyGeoms>();

export const getBodyGeoms = (detail: Detail): BodyGeoms => {
  const hit = bodyCache.get(detail);
  if (hit) return hit;
  const seg = RINGSEG[detail];
  // shirt = torso + two sleeves
  const shirt = newPart();
  buildShirtTorso(shirt, seg);
  const sl = newPart();
  buildSleeve(sl, Math.max(12, Math.round(seg * 0.8)));
  appendPart(sl, shirt);
  mirrorInto(sl, shirt);
  // trousers = seat + legs
  const trousers = newPart();
  buildSeat(trousers, seg);
  const lg = newPart();
  buildLeg(lg, Math.max(12, Math.round(seg * 0.85)));
  appendPart(lg, trousers);
  mirrorInto(lg, trousers);
  // skin = arms + neck
  const skin = newPart();
  const ar = newPart();
  buildArmSkin(ar, Math.max(12, Math.round(seg * 0.7)));
  appendPart(ar, skin);
  mirrorInto(ar, skin);
  buildNeck(skin, Math.max(12, Math.round(seg * 0.7)));
  const g: BodyGeoms = {
    shirt: toGeometry(shirt, true),
    trousers: toGeometry(trousers, true),
    skin: toGeometry(skin, true),
  };
  bodyCache.set(detail, g);
  return g;
};

/* ------------------------------------------------------------------ */
/* Head (head-local: origin at the head joint, +Z face, +Y up)         */
/* ------------------------------------------------------------------ */

const HEAD_C = new THREE.Vector3(0, 0.084, 0.012);
const HEAD_R = new THREE.Vector3(0.0785, 0.119, 0.103);

/** Sculpted head surface point for a unit direction n (pure, used by head, hair and gear). */
export const headSurface = (n: THREE.Vector3, inflate = 0) => {
  // metric offsets from the head centre on the base ellipsoid
  let x = n.x * HEAD_R.x;
  const y = n.y * HEAD_R.y;
  let z = n.z * HEAD_R.z;
  const front = sstep(0.15, 0.55, n.z);
  const ax = Math.abs(x);
  // lower face: slightly narrower, squarer jaw, the chin carried forward
  const low = sstep(0.0, -0.1, y);
  x *= 1 - 0.07 * low * (0.3 + 0.7 * front);
  z += 0.012 * sstep(-0.02, -0.09, y) * front * (1 - sstep(0.02, 0.05, ax));
  // flatter, wider face plane and cheeks
  z += 0.006 * front * gauss(ax - 0.035, 0.03) * gauss(y + 0.01, 0.045);
  // fuller occiput
  if (n.z < 0) z -= 0.01 * gauss(y - 0.01, 0.06) * -n.z;
  // forehead: more upright
  z += 0.006 * front * sstep(0.02, 0.06, y) * (1 - sstep(0.09, 0.12, y));
  // brow ridge over the eyes
  z += 0.0065 * front * gauss(y - 0.024, 0.0075) * (1 - sstep(0.045, 0.07, ax));
  // eye sockets (shallow enough that the eyes catch light under a cap peak)
  for (const sx of [-1, 1]) z -= 0.0105 * front * gauss(x - sx * 0.031, 0.0125) * gauss(y - 0.004, 0.0105);
  // nose: bridge (nasion) to tip, then the base (broad, soft tip)
  const yb = y;
  const noseH = 0.004 * sstep(0.02, 0.008, yb) * sstep(-0.05, -0.04, yb) + 0.017 * gauss(yb + 0.034, 0.011) * sstep(-0.05, -0.043, yb);
  const noseW = 0.0068 + 0.0075 * sstep(0.0, -0.035, yb);
  // philtrum / upper lip fill: no dark crease between the nose and the mouth
  z += front * 0.004 * gauss(x, 0.014) * gauss(yb + 0.047, 0.007);
  z += front * noseH * gauss(x, noseW) + front * 0.0045 * gauss(yb + 0.006, 0.014) * gauss(x, 0.0065);
  // nostril wings
  z += front * 0.005 * gauss(ax - 0.013, 0.0055) * gauss(yb + 0.039, 0.006);
  // cheekbones
  const ck = front * gauss(ax - 0.048, 0.012) * gauss(y + 0.012, 0.012);
  x += 0.003 * ck * Math.sign(x);
  z += 0.004 * ck;
  // lips and the mouth line
  z += front * 0.0045 * gauss(x, 0.017) * (gauss(y + 0.056, 0.0045) + 0.8 * gauss(y + 0.069, 0.005));
  z -= front * 0.0018 * gauss(x, 0.02) * gauss(y + 0.0625, 0.0018);
  // chin
  z += front * 0.006 * gauss(x, 0.016) * gauss(y + 0.095, 0.01);
  const p = new THREE.Vector3(x, y, z).add(HEAD_C);
  if (inflate) p.addScaledVector(n, inflate);
  return p;
};

const sphereGrid = (wSeg: number, hSeg: number, fn: (n: THREE.Vector3, i: number, j: number) => THREE.Vector3) => {
  const pos: number[] = [];
  const idx: number[] = [];
  const n = new THREE.Vector3();
  for (let j = 0; j <= hSeg; j++) {
    const phi = (j / hSeg) * Math.PI;
    for (let i = 0; i <= wSeg; i++) {
      const th = (i / wSeg) * Math.PI * 2;
      // th = 0 at the back (-Z), going round through +X
      n.set(Math.sin(phi) * Math.sin(th), Math.cos(phi), -Math.sin(phi) * Math.cos(th));
      const p = fn(n, i, j);
      pos.push(p.x, p.y, p.z);
    }
  }
  for (let j = 0; j < hSeg; j++)
    for (let i = 0; i < wSeg; i++) {
      const a = j * (wSeg + 1) + i;
      const b = a + 1;
      const c = a + wSeg + 1;
      const d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("aPart", new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3), 1));
  g.setAttribute("aHair", new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3), 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
};

/** Merge seam duplicates' normals (sphere grids duplicate the first column). */
const fixSeam = (g: THREE.BufferGeometry, wSeg: number, hSeg: number) => {
  const nrm = g.getAttribute("normal") as THREE.BufferAttribute;
  for (let j = 0; j <= hSeg; j++) {
    const a = j * (wSeg + 1);
    const b = a + wSeg;
    const x = (nrm.getX(a) + nrm.getX(b)) / 2;
    const y = (nrm.getY(a) + nrm.getY(b)) / 2;
    const z = (nrm.getZ(a) + nrm.getZ(b)) / 2;
    const l = Math.hypot(x, y, z) || 1;
    nrm.setXYZ(a, x / l, y / l, z / l);
    nrm.setXYZ(b, x / l, y / l, z / l);
  }
  // poles
  for (const j of [0, hSeg]) {
    for (let i = 0; i <= wSeg; i++) nrm.setXYZ(j * (wSeg + 1) + i, 0, j === 0 ? 1 : -1, 0);
  }
  nrm.needsUpdate = true;
};

const headCache = new Map<string, THREE.BufferGeometry>();

/** Hair coverage on the head sphere (1 = hair). Short, clean cut with a natural hairline. */
export const hairMask = (n: THREE.Vector3) => {
  const az = Math.abs(Math.atan2(n.x, n.z)); // 0 front, pi back
  // hairline height (in n.y) around the head: forehead, temples, above the ears, nape
  let h = 0.52 - 0.18 * sstep(0.3, 0.85, az) - 0.32 * sstep(1.05, 1.55, az) - 0.38 * sstep(1.9, 2.7, az);
  // sideburns in front of the ears
  h -= 0.2 * gauss(az - 1.3, 0.09);
  const m = sstep(h - 0.025, h + 0.06, n.y);
  // keep the ears clear
  const ear = 1 - 0.95 * gauss(az - Math.PI / 2, 0.2) * gauss(n.y + 0.0, 0.17);
  return Math.max(0, Math.min(1, m * ear));
};

/**
 * Head with painted hair: the hair region is displaced outward a few millimetres
 * (style 0 = close crop, 1 = short) and carries an `aHair` attribute the skin shader uses.
 * hairOn = false gives a smooth scalp under a helmet or cap.
 */
export const getHeadGeom = (detail: Detail, style = 0, hairOn = true) => {
  const key = "head" + detail + style + hairOn;
  let g = headCache.get(key);
  if (g) return g;
  const w = detail === "hero" ? 80 : detail === "mid" ? 48 : 24;
  const h = detail === "hero" ? 60 : detail === "mid" ? 36 : 18;
  const thick = style === 1 ? 0.011 : 0.006;
  const masks: number[] = [];
  g = sphereGrid(w, h, (n) => {
    const m = hairOn ? hairMask(n) : 0;
    masks.push(m);
    return headSurface(n, thick * Math.pow(m, 0.7) * (1 + 0.3 * Math.max(0, n.y)));
  });
  fixSeam(g, w, h);
  g.setAttribute("aHair", new THREE.Float32BufferAttribute(masks, 1));
  g.setAttribute("aPart", new THREE.Float32BufferAttribute(new Array(masks.length).fill(8), 1));
  headCache.set(key, g);
  return g;
};

export const EYE_POS: [number, number, number][] = [
  [0.031, 0.0885, 0.0925],
  [-0.031, 0.0885, 0.0925],
];
export const EYE_R = 0.0118;

/** Ear: a flattened shell, in head-local space for the left ear (mirror X for the right). */
export const getEarGeom = () => {
  const key = "ear";
  let g = headCache.get(key);
  if (g) return g;
  g = sphereGrid(16, 10, (n) => {
    const p = new THREE.Vector3(n.x * 0.009, n.y * 0.03, n.z * 0.019);
    // rim curl
    p.x += 0.003 * Math.max(0, 1 - Math.abs(n.x)) * Math.sign(n.x || 1);
    return p;
  });
  headCache.set(key, g);
  return g;
};
export const EAR_POS: [number, number, number] = [0.0795, 0.08, -0.004];

/* ------------------------------------------------------------------ */
/* Shoe (ankle-local: origin at the ankle joint, sole at y=-0.08, +Z toe) */
/* ------------------------------------------------------------------ */

const footShape = (z: number) => {
  // rows [z, halfWidth, top(y), bottom(y)]
  const rows = [
    [-0.085, 0.022, -0.04, -0.074],
    [-0.075, 0.036, -0.0, -0.08],
    [-0.04, 0.041, 0.012, -0.08],
    [0.0, 0.042, 0.015, -0.08],
    [0.05, 0.045, -0.012, -0.08],
    [0.11, 0.05, -0.034, -0.08],
    [0.16, 0.047, -0.045, -0.08],
    [0.195, 0.036, -0.052, -0.079],
    [0.215, 0.02, -0.058, -0.075],
    [0.222, 0.008, -0.064, -0.072],
  ];
  return { hw: table(rows, z, 1), top: table(rows, z, 2), bot: table(rows, z, 3) };
};

const shoeCache = new Map<string, THREE.BufferGeometry>();

/** Ball-of-foot hinge (ankle-local): the toe box rotates about the X axis through this point. */
export const TOE_PIVOT: [number, number, number] = [0, -0.08, 0.135];

const shoeLoft = (z0: number, z1: number, seg: number, sole: boolean, capStart: boolean, capEnd: boolean) => {
  const part = newPart();
  const rings: Ring[] = [];
  const n = Math.max(2, Math.round((z1 - z0) / 0.0122));
  for (let i = 0; i <= n; i++) {
    const z = z0 + ((z1 - z0) * i) / n;
    if (sole) {
      const { hw } = footShape(Math.min(0.222, Math.max(-0.085, z)));
      const w = Math.max(0.012, hw + 0.004);
      rings.push({ c: new THREE.Vector3(0.002, -0.0735, z), u: X, v: Y, shape: superEl(w, w, 0.0075, 0.0075, 3.2) });
    } else {
      const { hw, top, bot } = footShape(z);
      const cy = (top + bot) / 2 + 0.004;
      const hh = (top - bot) / 2;
      rings.push({ c: new THREE.Vector3(0.002, cy, z), u: X, v: Y, shape: superEl(hw, hw * 0.95, hh, hh * 0.9, 2.6) });
    }
  }
  loft(part, rings, seg, () => [["root", 1]], sole ? 6 : 5, capStart, capEnd);
  return toGeometry(part, false);
};

/**
 * Left shoe in two hinged parts: rear (heel..ball, ankle-local) and toe box (ball..tip, local to
 * TOE_PIVOT). Upper is white leather, sole teal. Mirror for the right foot.
 */
export const getShoeGeoms = (detail: Detail) => {
  const key = "shoe2" + detail;
  const hit = shoeCache.get(key + "ur");
  if (hit)
    return {
      upper: hit,
      sole: shoeCache.get(key + "sr") as THREE.BufferGeometry,
      upperToe: shoeCache.get(key + "ut") as THREE.BufferGeometry,
      soleToe: shoeCache.get(key + "st") as THREE.BufferGeometry,
    };
  const seg = detail === "hero" ? 28 : detail === "mid" ? 18 : 10;
  const zb = TOE_PIVOT[2];
  const upper = shoeLoft(-0.085, zb + 0.004, seg, false, true, false);
  const sole = shoeLoft(-0.09, zb + 0.004, seg, true, true, false);
  const upperToe = shoeLoft(zb - 0.004, 0.222, seg, false, false, true);
  const soleToe = shoeLoft(zb - 0.004, 0.228, seg, true, false, true);
  upperToe.translate(-TOE_PIVOT[0], -TOE_PIVOT[1], -TOE_PIVOT[2]);
  soleToe.translate(-TOE_PIVOT[0], -TOE_PIVOT[1], -TOE_PIVOT[2]);
  shoeCache.set(key + "ur", upper);
  shoeCache.set(key + "sr", sole);
  shoeCache.set(key + "ut", upperToe);
  shoeCache.set(key + "st", soleToe);
  return { upper, sole, upperToe, soleToe };
};

/* ------------------------------------------------------------------ */
/* Hand (right hand, hand-local; see solve.ts for axes)                */
/* ------------------------------------------------------------------ */

export type FingerDef = {
  /** MCP joint position (hand-local) */
  base: [number, number, number];
  /** phalanx lengths */
  len: [number, number, number];
  /** phalanx radii */
  rad: [number, number, number];
  /** rest splay about X (rad) */
  splay: number;
};

export const FINGERS: FingerDef[] = [
  { base: [0.002, -0.094, 0.028], len: [0.044, 0.026, 0.021], rad: [0.0104, 0.0094, 0.0083], splay: 0.05 },
  { base: [0.002, -0.098, 0.009], len: [0.048, 0.03, 0.022], rad: [0.0107, 0.0097, 0.0085], splay: 0.0 },
  { base: [0.002, -0.095, -0.01], len: [0.045, 0.028, 0.021], rad: [0.0101, 0.0092, 0.0081], splay: -0.05 },
  { base: [0.001, -0.087, -0.027], len: [0.036, 0.021, 0.019], rad: [0.009, 0.0083, 0.0074], splay: -0.11 },
];
export const THUMB = {
  base: [0.012, -0.026, 0.022] as [number, number, number],
  len: [0.04, 0.03, 0.025] as [number, number, number],
  rad: [0.0125, 0.0105, 0.0092] as [number, number, number],
};

const capsuleCache = new Map<string, THREE.BufferGeometry>();
/** Capsule along -Y from 0 to -len with radii r0 (top) -> r1 (bottom). */
export const getPhalanx = (len: number, r0: number, r1: number, detail: Detail, glove = 0) => {
  const key = [len, r0, r1, detail, glove].map((x) => (typeof x === "number" ? x.toFixed(4) : x)).join("|");
  let g = capsuleCache.get(key);
  if (g) return g;
  const seg = detail === "hero" ? 14 : detail === "mid" ? 9 : 6;
  const p = newPart();
  const rings: Ring[] = [];
  const nCap = detail === "far" ? 2 : 4;
  // top hemisphere
  for (let i = 0; i <= nCap; i++) {
    const a = (Math.PI / 2) * (1 - i / nCap);
    const r = r0 * Math.cos(a);
    rings.push({ c: new THREE.Vector3(0, r0 * Math.sin(a) * 0.9, 0), u: X, v: Z, shape: (th) => [Math.cos(th) * Math.max(r, 1e-4), Math.sin(th) * Math.max(r, 1e-4) * 0.92] });
  }
  const steps = glove ? 6 : 2;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    let r = r0 + (r1 - r0) * t;
    if (glove) r *= 1 + 0.12 * Math.sin(t * Math.PI * 2) ** 2;
    rings.push({ c: new THREE.Vector3(0, -len * t, 0), u: X, v: Z, shape: (th) => [Math.cos(th) * r, Math.sin(th) * r * 0.92] });
  }
  for (let i = 1; i <= nCap; i++) {
    const a = (Math.PI / 2) * (i / nCap);
    const r = r1 * Math.cos(a);
    rings.push({ c: new THREE.Vector3(0, -len - r1 * Math.sin(a) * 0.9, 0), u: X, v: Z, shape: (th) => [Math.cos(th) * Math.max(r, 1e-4), Math.sin(th) * Math.max(r, 1e-4) * 0.92] });
  }
  loft(p, rings, seg, () => [["root", 1]], 7, false, false);
  g = toGeometry(p, false);
  capsuleCache.set(key, g);
  return g;
};

/** Palm of the right hand (hand-local). glove: 0 bare, 1 batting glove, 2 keeper glove */
export const getPalmGeom = (detail: Detail, glove = 0) => {
  const key = "palm" + detail + glove;
  let g = capsuleCache.get(key);
  if (g) return g;
  const seg = detail === "hero" ? 24 : detail === "mid" ? 16 : 10;
  const p = newPart();
  const rings: Ring[] = [];
  const gx = glove === 2 ? 1.35 : glove === 1 ? 1.22 : 1;
  const gz = glove === 2 ? 1.25 : glove === 1 ? 1.1 : 1;
  const rows = [
    [0.036, 0.02, 0.028],
    [0.012, 0.0175, 0.028],
    [0.0, 0.018, 0.031],
    [-0.025, 0.0175, 0.038],
    [-0.055, 0.0165, 0.042],
    [-0.08, 0.0145, 0.043],
    [-0.095, 0.0115, 0.04],
    [-0.104, 0.006, 0.03],
  ];
  for (let y = 0.036; y >= -0.1041; y -= 0.0083) {
    const t = -y;
    const hx = table(rows.map((r) => [-r[0], r[1], r[2]]), t, 1) * gx;
    const hz = table(rows.map((r) => [-r[0], r[1], r[2]]), t, 2) * gz;
    rings.push({
      c: new THREE.Vector3(0.001, y, 0.0005),
      u: X,
      v: Z,
      shape: (th) => {
        const [x, z] = superEl(hx * 1.1, hx * 0.9, hz, hz, 2.8)(th);
        // thenar eminence on the palm side near the thumb
        const dx = x > 0 ? 0.006 * gauss(z - 0.02, 0.012) * gauss(y + 0.035, 0.02) : 0;
        return [x + dx, z];
      },
    });
  }
  loft(p, rings, seg, () => [["root", 1]], 7, true, true);
  g = toGeometry(p, false);
  capsuleCache.set(key, g);
  return g;
};

/* ------------------------------------------------------------------ */
/* Gear                                                                */
/* ------------------------------------------------------------------ */

/**
 * Batting pad (knee-local: origin at the knee joint, shin along -Y, front +Z; left leg, +X outside).
 * Flat-fronted shell with vertical cane bolsters, a rounded knee roll, a narrower thigh flap and an
 * instep flare over the shoe; open at the back (straps are painted on the sides). keeper = shorter, plainer.
 */
export const getPadGeom = (detail: Detail, keeper = false) => {
  const key = "pad2" + detail + keeper;
  let g = capsuleCache.get(key);
  if (g) return g;
  const segA = detail === "hero" ? 44 : detail === "mid" ? 30 : 14;
  const yBot = keeper ? -0.37 : -0.405;
  const yTop = keeper ? 0.11 : 0.185;
  const rows = Math.max(12, Math.round((yTop - yBot) / (detail === "far" ? 0.025 : 0.0105)));
  const thick = keeper ? 0.018 : 0.024;
  const outer: THREE.Vector3[][] = [];
  const inner: THREE.Vector3[][] = [];
  for (let j = 0; j <= rows; j++) {
    const y = yBot + ((yTop - yBot) * j) / rows;
    const knee = gauss(y - 0.012, 0.028);
    const flap = sstep(0.05, 0.09, y);
    const instep = sstep(yBot + 0.07, yBot, y);
    const top = sstep(yTop - 0.045, yTop, y);
    const bot = sstep(yBot + 0.03, yBot, y);
    // half arc (rad): wraps the shin, narrower over the thigh, rounded top/bottom corners
    const A = (keeper ? 1.3 : 1.48) - 0.32 * flap - 0.55 * top * top - 0.35 * bot * bot;
    const W = (keeper ? 0.074 : 0.083) + 0.012 * knee + 0.008 * flap - 0.01 * top;
    const D = (keeper ? 0.066 : 0.071) + (keeper ? 0.016 : 0.026) * knee + 0.016 * flap + 0.03 * instep - 0.012 * top;
    const zc = 0.004 + 0.012 * flap;
    const oRow: THREE.Vector3[] = [];
    const iRow: THREE.Vector3[] = [];
    for (let i = 0; i <= segA; i++) {
      const a = -A + (2 * A * i) / segA;
      const sx = Math.sin(a);
      const cz = Math.cos(a);
      const e = 2 / 3.2;
      let x = W * Math.sign(sx) * Math.pow(Math.abs(sx), e);
      let z = D * Math.sign(cz) * Math.pow(Math.abs(cz), e);
      // vertical cane bolsters across the face (5), softened on the knee roll
      if (!keeper && Math.abs(a) < 1.0) {
        const b = 0.0055 * Math.pow(0.5 + 0.5 * Math.cos(a * 15.7), 1.5) * (1 - 0.8 * knee) * (1 - top);
        x += b * sx;
        z += b * cz;
      }
      const o = new THREE.Vector3(x, y, z + zc);
      const r = Math.hypot(x, z) || 1;
      const inn = new THREE.Vector3(x - (x / r) * thick, y, z - (z / r) * thick + zc);
      oRow.push(o);
      iRow.push(inn);
    }
    outer.push(oRow);
    inner.push(iRow);
  }
  const pos: number[] = [];
  const idx: number[] = [];
  const W1 = segA + 1;
  const push = (v: THREE.Vector3) => pos.push(v.x, v.y, v.z);
  for (const row of outer) row.forEach(push);
  const nO = pos.length / 3;
  for (const row of inner) row.forEach(push);
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < segA; i++) {
      const a0 = j * W1 + i;
      idx.push(a0, a0 + 1, a0 + W1, a0 + 1, a0 + W1 + 1, a0 + W1);
      const b0 = nO + a0;
      idx.push(b0, b0 + W1, b0 + 1, b0 + 1, b0 + W1, b0 + W1 + 1);
    }
  const rim = (a0: number, b0: number) => idx.push(a0, b0, a0 + nO, b0, b0 + nO, a0 + nO);
  for (let j = 0; j < rows; j++) {
    rim(j * W1, (j + 1) * W1);
    rim((j + 1) * W1 + segA, j * W1 + segA);
  }
  for (let i = 0; i < segA; i++) {
    rim(i + 1, i);
    rim(rows * W1 + i, rows * W1 + i + 1);
  }
  g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("aPart", new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3), 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  capsuleCache.set(key, g);
  return g;
};

/** Helmet rim: polar angle (from the crown) of the shell edge at azimuth phi (0 = face, +-pi = back). */
const helmetRim = (phi: number) => {
  const ap = Math.abs(Math.atan2(Math.sin(phi), Math.cos(phi)));
  return 1.2 + 0.66 * sstep(0.7, 1.45, ap) + 0.36 * sstep(1.9, 2.9, ap);
};
const helmetPoint = (phi: number, th: number, infl: number) => {
  const n = new THREE.Vector3(Math.sin(th) * Math.sin(phi), Math.cos(th), Math.sin(th) * Math.cos(phi));
  return headSurface(n, infl + 0.004 * Math.max(0, n.y));
};

/** Helmet shell with a clean rolled rim, the peak and the neck guard (head-local). */
export const getHelmetGeoms = (detail: Detail) => {
  const key = "helmet2" + detail;
  const hit = capsuleCache.get(key + "shell");
  if (hit)
    return {
      shell: hit,
      peak: capsuleCache.get(key + "peak") as THREE.BufferGeometry,
      guard: capsuleCache.get(key + "guard") as THREE.BufferGeometry,
    };
  const nP = detail === "hero" ? 72 : detail === "mid" ? 44 : 22;
  const nT = detail === "hero" ? 26 : detail === "mid" ? 16 : 9;
  const OUT = 0.027;
  const IN = 0.012;
  const pos: number[] = [];
  const idx: number[] = [];
  // outer rows (crown -> rim), then a rolled lip, then the inner surface back up
  const prof: { t: number; infl: number }[] = [];
  for (let j = 0; j <= nT; j++) prof.push({ t: j / nT, infl: OUT });
  prof.push({ t: 1.012, infl: (OUT + IN) / 2 + 0.003 });
  for (let j = nT; j >= 0; j--) prof.push({ t: j / nT, infl: IN });
  const R = prof.length;
  for (let r = 0; r < R; r++)
    for (let i = 0; i < nP; i++) {
      const phi = (i / nP) * Math.PI * 2;
      const th = prof[r].t * helmetRim(phi);
      const p = helmetPoint(phi, Math.max(1e-3, th), prof[r].infl);
      pos.push(p.x, p.y, p.z);
    }
  for (let r = 0; r < R - 1; r++)
    for (let i = 0; i < nP; i++) {
      const a0 = r * nP + i;
      const b0 = r * nP + ((i + 1) % nP);
      const c0 = (r + 1) * nP + i;
      const d0 = (r + 1) * nP + ((i + 1) % nP);
      idx.push(a0, c0, b0, b0, c0, d0);
    }
  const shell = new THREE.BufferGeometry();
  shell.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  shell.setIndex(idx);
  shell.computeVertexNormals();
  // peak: a curved visor from the front rim
  const peak = (() => {
    const pp: number[] = [];
    const ii: number[] = [];
    const nA = 18;
    const nR = 5;
    for (let j = 0; j <= nR; j++) {
      const r = j / nR;
      for (let i = 0; i <= nA; i++) {
        const a = -1.05 + (2.1 * i) / nA;
        const p = helmetPoint(a, helmetRim(a) - 0.04, OUT - 0.002);
        const out = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
        p.addScaledVector(out, r * 0.05 * (0.55 + 0.45 * Math.cos(a * 1.45)));
        p.y -= r * r * 0.014 - 0.004 * r;
        pp.push(p.x, p.y, p.z);
      }
    }
    const nTop = pp.length / 3;
    for (let k = 0; k < nTop; k++) pp.push(pp[k * 3], pp[k * 3 + 1] - 0.005, pp[k * 3 + 2]);
    const W = nA + 1;
    for (let j = 0; j < nR; j++)
      for (let i = 0; i < nA; i++) {
        const a0 = j * W + i;
        ii.push(a0, a0 + W, a0 + 1, a0 + 1, a0 + W, a0 + W + 1);
        const b0 = nTop + a0;
        ii.push(b0, b0 + 1, b0 + W, b0 + 1, b0 + W + 1, b0 + W);
      }
    for (let i = 0; i < nA; i++) {
      const a0 = nR * W + i;
      ii.push(a0, a0 + nTop, a0 + 1, a0 + 1, a0 + nTop, a0 + 1 + nTop);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pp, 3));
    g.setIndex(ii);
    g.computeVertexNormals();
    return g;
  })();
  // neck guard: a curved pad hanging under the back rim (single surface, double-sided material)
  const guard = (() => {
    const pp: number[] = [];
    const ii: number[] = [];
    const nA = 14;
    const nY = 5;
    for (let j = 0; j <= nY; j++)
      for (let i = 0; i <= nA; i++) {
        const phi = Math.PI + (-0.62 + (1.24 * i) / nA);
        const p = helmetPoint(phi, helmetRim(phi) - 0.03, OUT - 0.004);
        const v = j / nY;
        const outDir = new THREE.Vector3(Math.sin(phi), 0, Math.cos(phi));
        p.y -= v * 0.05;
        p.addScaledVector(outDir, -0.012 * v + 0.006 * Math.sin(Math.PI * v));
        pp.push(p.x, p.y, p.z);
      }
    const W = nA + 1;
    for (let j = 0; j < nY; j++)
      for (let i = 0; i < nA; i++) {
        const a0 = j * W + i;
        ii.push(a0, a0 + W, a0 + 1, a0 + 1, a0 + W, a0 + W + 1);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pp, 3));
    g.setIndex(ii);
    g.computeVertexNormals();
    return g;
  })();
  capsuleCache.set(key + "shell", shell);
  capsuleCache.set(key + "peak", peak);
  capsuleCache.set(key + "guard", guard);
  return { shell, peak, guard };
};

/** Grille bars (head-local): returns tube segment endpoints for a steel face guard. */
export const GRILLE_BARS = (() => {
  const bars: [THREE.Vector3, THREE.Vector3][] = [];
  const ring = (y: number, rx: number, rz: number, z0: number, a0: number, a1: number, n: number) => {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      pts.push(new THREE.Vector3(Math.sin(a) * rx, y, z0 + Math.cos(a) * rz));
    }
    for (let i = 0; i < n; i++) bars.push([pts[i], pts[i + 1]]);
    return pts;
  };
  // three horizontal bars in front of the face (below the peak, chin level)
  const r1 = ring(0.055, 0.09, 0.115, 0.012, -1.25, 1.25, 10);
  const r2 = ring(0.005, 0.087, 0.118, 0.012, -1.2, 1.2, 10);
  const r3 = ring(-0.045, 0.078, 0.112, 0.012, -1.05, 1.05, 10);
  // two vertical bars at the centre, joining the three rings
  for (const k of [4, 6]) {
    bars.push([r1[k], r2[k]]);
    bars.push([r2[k], r3[k]]);
  }
  // side struts back to the shell
  for (const r of [r1, r2]) {
    bars.push([r[0], new THREE.Vector3(r[0].x * 0.92, r[0].y + 0.005, r[0].z - 0.02)]);
    bars.push([r[r.length - 1], new THREE.Vector3(r[r.length - 1].x * 0.92, r[r.length - 1].y + 0.005, r[r.length - 1].z - 0.02)]);
  }
  return bars;
})();

/** Cap crown (head-local) and its peak. */
export const getCapGeoms = (detail: Detail) => {
  const key = "cap" + detail;
  const hit = capsuleCache.get(key + "crown");
  if (hit) return { crown: hit, peak: capsuleCache.get(key + "peak") as THREE.BufferGeometry };
  const w = detail === "hero" ? 48 : detail === "mid" ? 32 : 16;
  const h = detail === "hero" ? 24 : detail === "mid" ? 18 : 10;
  const crown = sphereGrid(w, h, (n) => {
    const band = 0.22 - 0.16 * n.z; // lower at the back
    const k = sstep(band - 0.05, band + 0.05, n.y);
    return headSurface(n, k > 0.01 ? 0.0115 + 0.003 * n.y : -0.004);
  });
  fixSeam(crown, w, h);
  const pos: number[] = [];
  const idx: number[] = [];
  const nA = 14;
  const nR = 4;
  for (let j = 0; j <= nR; j++) {
    const r = j / nR;
    for (let i = 0; i <= nA; i++) {
      const a = -1.0 + (2.0 * i) / nA;
      const n = new THREE.Vector3(Math.sin(a), 0.2, Math.cos(a)).normalize();
      const p = headSurface(n, 0.012);
      // a cricket cap's bill: a crescent, ~7 cm deep in front, tapering to nothing at the temples,
      // curved down at the sides (never an all-round brim)
      const depth = 0.07 * Math.pow(Math.max(0, 1 - (a / 1.04) ** 2), 0.8);
      p.addScaledVector(new THREE.Vector3(Math.sin(a), 0, Math.cos(a)), r * depth);
      p.y -= r * r * 0.014 + r * 0.012 * a * a;
      pos.push(p.x, p.y, p.z);
    }
  }
  const nTop = pos.length / 3;
  for (let k = 0; k < nTop; k++) pos.push(pos[k * 3], pos[k * 3 + 1] - 0.003, pos[k * 3 + 2]);
  const W = nA + 1;
  for (let j = 0; j < nR; j++)
    for (let i = 0; i < nA; i++) {
      const a = j * W + i;
      idx.push(a, a + W, a + 1, a + 1, a + W, a + W + 1);
      const b = nTop + a;
      idx.push(b, b + 1, b + W, b + 1, b + W + 1, b + W);
    }
  for (let i = 0; i < nA; i++) {
    const a = nR * W + i;
    idx.push(a, a + nTop, a + 1, a + 1, a + nTop, a + 1 + nTop);
  }
  const peak = new THREE.BufferGeometry();
  peak.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  peak.setIndex(idx);
  peak.computeVertexNormals();
  capsuleCache.set(key + "crown", crown);
  capsuleCache.set(key + "peak", peak);
  return { crown, peak };
};

/** Utility so other files can read the rest offsets without importing three directly. */
export const REST_HEIGHTS = {
  shoulder: OFFSETS.shoulder.y,
};
