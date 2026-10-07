/**
 * Footfall-driven locomotion (walk, jog, sprint). Pure function of time.
 *
 * Give it the list of foot plants (time, side, ground position, heading) and it returns:
 *  - both foot targets: planted feet are EXACTLY fixed during contact (no sliding), the heel peels
 *    up around the ball of the foot before toe-off, the swing foot follows a kicked-up arc and lands;
 *  - the pelvis path: passes over each stance foot at mid-stance, low at mid-stance, high in flight;
 *  - pelvis / thorax counter-rotation and an arm-swing phase synced to the opposite leg.
 */
import { type FootTarget, airFoot, plant } from "./pose";
import { RIG, type Side } from "./solve";
import { type Key, clamp, lerp, s5, track } from "./anim";

export type Footfall = {
  /** touchdown time (s) */
  t: number;
  side: Side;
  /** ankle ground position (char space) */
  x: number;
  z: number;
  /** foot heading (rad), 0 = +Z */
  yaw?: number;
  /** contact duration override (s) */
  contact?: number;
};

export type GaitOpts = {
  /** stance duration (s) */
  contact: number;
  /** swing apex height of the ankle (m) */
  lift: number;
  /** where in the swing the apex happens (0..1); low = heel kicked up behind (sprint) */
  apexAt: number;
  /** heel-up angle at toe-off (rad) */
  toeOff: number;
  /** foot pitch at touchdown (rad, <0 = toes up / heel strike) */
  strike: number;
  /** pelvis height at mid-stance */
  pelvisLow: number;
  /** pelvis rise from mid-stance to mid-flight */
  bob: number;
  /** pelvis yaw amplitude (rad) */
  pelvisYaw: number;
  /** thorax counter-rotation amplitude (rad, relative to the pelvis) */
  chestYaw: number;
  /** lateral sway of the pelvis toward the stance foot (0..1 of the foot offset) */
  sway: number;
  /** pelvis forward offset relative to the stance foot at mid-stance (m) */
  lead: number;
};

export const RUN: GaitOpts = {
  contact: 0.12,
  lift: 0.32,
  apexAt: 0.38,
  toeOff: 1.0,
  strike: 0.08,
  pelvisLow: 0.9,
  bob: 0.05,
  pelvisYaw: 0.14,
  chestYaw: 0.22,
  sway: 0.25,
  lead: 0.0,
};

export const JOG: GaitOpts = {
  contact: 0.2,
  lift: 0.2,
  apexAt: 0.42,
  toeOff: 0.7,
  strike: -0.12,
  pelvisLow: 0.94,
  bob: 0.035,
  pelvisYaw: 0.1,
  chestYaw: 0.14,
  sway: 0.3,
  lead: 0.0,
};

export const WALK: GaitOpts = {
  contact: 0.62,
  lift: 0.07,
  apexAt: 0.45,
  toeOff: 0.55,
  strike: -0.25,
  pelvisLow: 0.955,
  bob: -0.022,
  pelvisYaw: 0.08,
  chestYaw: 0.1,
  sway: 0.35,
  lead: 0.0,
};

export type GaitState = {
  l: FootTarget;
  r: FootTarget;
  /** pelvis position */
  pelvis: [number, number, number];
  /** pelvis yaw offset (rad) to add to the heading */
  pelvisYaw: number;
  /** thorax yaw relative to the pelvis */
  chestYaw: number;
  /** pelvis roll (hip drop) */
  pelvisRoll: number;
  /** +1 = right arm forward / left arm back, -1 = the opposite */
  armPhase: number;
  /** horizontal velocity (m/s, along the path) */
  speed: number;
  /** 0..1 contact flag per foot */
  lContact: number;
  rContact: number;
};

const footAt = (t: number, plants: Footfall[], o: GaitOpts): { foot: FootTarget; contact: number } => {
  // last plant at or before t
  let i = -1;
  for (let k = 0; k < plants.length; k++) if (plants[k].t <= t) i = k;
  if (i < 0) {
    // before the first plant: swing in from a virtual plant one stride earlier
    const p = plants[0];
    if (plants.length < 2) return { foot: plant(p.x, p.z, p.yaw ?? 0, 0), contact: 1 };
    const q = plants[1];
    const virt: Footfall = { t: p.t - (q.t - p.t), side: p.side, x: p.x, z: p.z - (q.z - p.z), yaw: p.yaw, contact: p.contact };
    return footAt(t, [virt, ...plants], o);
  }
  const p = plants[i];
  const c = p.contact ?? o.contact;
  const next = plants[i + 1];
  if (t <= p.t + c || !next) {
    // stance: touchdown pitch -> flat -> heel peel toward toe-off
    const u = clamp((t - p.t) / c);
    // the last plant of a foot settles flat and stays (no toe-off without a next step)
    const roll = next
      ? track(
          [
            [0, o.strike],
            [0.22, 0],
            [0.5, 0, 0],
            [1, o.toeOff],
          ],
          u,
        )
      : track(
          [
            [0, o.strike],
            [0.22, 0, 0],
          ],
          clamp(t - p.t, 0, 1) / Math.max(1e-3, Math.min(c, 1)),
        );
    return { foot: plant(p.x, p.z, p.yaw ?? 0, roll), contact: 1 };
  }
  // swing from p to next
  const s = clamp((t - (p.t + c)) / (next.t - (p.t + c)));
  const from = plant(p.x, p.z, p.yaw ?? 0, o.toeOff);
  const to = plant(next.x, next.z, next.yaw ?? 0, o.strike);
  // the foot recovers behind the body first (heel up under the hip) and only reaches forward late
  const h = s5(0, 1, Math.pow(s, 1.45));
  const fx = lerp(from.ankle.x, to.ankle.x, h);
  const fz = lerp(from.ankle.z, to.ankle.z, h);
  // apex early (heel kick) with a smooth landing
  const a = o.apexAt;
  const up = s < a ? Math.sin((s / a) * (Math.PI / 2)) : Math.cos(((s - a) / (1 - a)) * (Math.PI / 2));
  const dist = Math.hypot(next.x - p.x, next.z - p.z);
  const lift = o.lift * clamp(dist / 0.6, 0.25, 1.4) * Math.pow(Math.max(0, up), s < a ? 1.0 : 1.6);
  const fy = lerp(from.ankle.y, to.ankle.y, h) + lift;
  const pitchKeys: Key<number>[] = [
    [0, o.toeOff],
    [a * 0.6, o.toeOff * 0.75],
    [0.72, -0.28],
    [1, o.strike],
  ];
  const yaw = lerp(p.yaw ?? 0, next.yaw ?? 0, h);
  return { foot: airFoot([fx, fy, fz], yaw, track(pitchKeys, s)), contact: 0 };
};

/** Evaluate the gait at time t. Steps must alternate feet and be sorted by time. */
export const gait = (t: number, steps: Footfall[], o: GaitOpts = RUN): GaitState => {
  const sorted = [...steps].sort((a, b) => a.t - b.t);
  const L = sorted.filter((s) => s.side === "l");
  const R = sorted.filter((s) => s.side === "r");
  const lf = footAt(t, L, o);
  const rf = footAt(t, R, o);

  // pelvis anchors at mid-stance of every footfall
  const anchors = sorted.map((s) => {
    const c = Math.min(s.contact ?? o.contact, 0.3);
    return { t: s.t + c * 0.5, x: s.x, z: s.z, side: s.side, yaw: s.yaw ?? 0 };
  });
  // a final long contact means the runner stops: settle the pelvis between the last two feet
  const lastF = sorted[sorted.length - 1];
  const stops = sorted.length >= 2 && (lastF.contact ?? o.contact) >= 1;
  const midX = (k: number) => {
    const a = anchors[Math.max(0, k - 1)];
    const b = anchors[Math.min(anchors.length - 1, k + 1)];
    const c = anchors[k];
    return (a.x + b.x) * 0.25 + c.x * 0.5;
  };
  const kx: Key<number>[] = anchors.map((a, k) => [a.t, lerp(midX(k), a.x, o.sway)]);
  const kz: Key<number>[] = anchors.map((a) => [a.t, a.z + o.lead]);
  // extend the path beyond the last anchor with the final velocity so the body keeps moving
  const n = anchors.length;
  if (n >= 2 && stops) {
    const a = sorted[n - 2];
    const b = sorted[n - 1];
    kz[n - 1] = [anchors[n - 1].t, (a.z + b.z) / 2 + o.lead];
    kx[n - 1] = [anchors[n - 1].t, (a.x + b.x) / 2];
    kz.push([b.t + 0.35, (a.z + b.z) / 2 + o.lead, 0]);
    kx.push([b.t + 0.35, (a.x + b.x) / 2, 0]);
  } else if (n >= 2) {
    const a = anchors[n - 2];
    const b = anchors[n - 1];
    const dt = b.t - a.t;
    kz.push([b.t + dt, b.z + (b.z - a.z) * 0.35, 0]);
    kx.push([b.t + dt, kx[n - 1][1] as number, 0]);
  }
  const px = track(kx, t);
  const pz = track(kz, t);
  const pz2 = track(kz, t + 0.01);
  const speed = (pz2 - pz) / 0.01;

  // vertical: low at mid-stance, high between
  let k = 0;
  while (k < n - 1 && anchors[k + 1].t <= t) k++;
  let phase = 0;
  if (n >= 2) {
    const a = anchors[Math.min(k, n - 2)];
    const b = anchors[Math.min(k + 1, n - 1)];
    phase = clamp((t - a.t) / Math.max(1e-3, b.t - a.t), -1, 2);
  }
  const amp = o.bob * clamp(Math.abs(speed) / 6, stops && t > lastF.t ? 0 : 0.35, 1.2);
  let py = o.pelvisLow + amp * (0.5 - 0.5 * Math.cos(2 * Math.PI * phase));
  // reach: a foot on (or about to touch) the ground must be reachable with a slightly bent knee;
  // the pelvis sinks a little where the stride is long (as a runner's does), never the foot floating
  const reach = (RIG.thigh + RIG.shin) * 0.985;
  let drop = 0;
  for (const [f, sx] of [
    [lf.foot, 1],
    [rf.foot, -1],
  ] as const) {
    const w = 1 - clamp((f.ankle.y - 0.16) / 0.14);
    if (w <= 0) continue;
    const h = Math.hypot(f.ankle.x - (px + 0.092 * sx), f.ankle.z - pz);
    const need = h < reach ? py - 0.04 - f.ankle.y - Math.sqrt(reach * reach - h * h) : 0.08;
    drop = Math.max(drop, w * need);
  }
  py -= Math.min(0.08, drop);

  // rotations keyed at the footfalls: left strike -> left hip forward (negative yaw)
  const yawKeys: Key<number>[] = sorted.map((s) => [s.t, s.side === "l" ? -1 : 1]);
  const swing = sorted.length ? track(yawKeys, t) : 0;
  const armKeys: Key<number>[] = sorted.map((s) => [s.t + 0.03, s.side === "l" ? 1 : -1]);
  const armPhase = sorted.length ? track(armKeys, t) : 0;
  const rollKeys: Key<number>[] = sorted.map((s) => [s.t + (s.contact ?? o.contact) * 0.5, s.side === "l" ? -1 : 1]);
  const roll = sorted.length ? track(rollKeys, t) * 0.05 : 0;
  return {
    l: lf.foot,
    r: rf.foot,
    pelvis: [px, py, pz],
    pelvisYaw: swing * o.pelvisYaw,
    chestYaw: -swing * (o.pelvisYaw + o.chestYaw),
    pelvisRoll: roll,
    armPhase,
    speed,
    lContact: lf.contact,
    rContact: rf.contact,
  };
};

/**
 * Build footfalls along +Z from step times with a stride-length function.
 * @param times touchdown times
 * @param first side of the first footfall
 * @param z0    ankle z of the first footfall
 * @param stride (i, dt) => step length to footfall i from footfall i-1
 * @param width lateral half-distance of the feet
 */
export const stepsAlongZ = (
  times: number[],
  first: Side,
  z0: number,
  stride: (i: number, dt: number) => number,
  width = 0.09,
  x0 = 0,
): Footfall[] => {
  const out: Footfall[] = [];
  let z = z0;
  times.forEach((t, i) => {
    const side: Side = (i % 2 === 0) === (first === "l") ? "l" : "r";
    if (i > 0) z += stride(i, t - times[i - 1]);
    out.push({ t, side, x: x0 + (side === "l" ? width : -width), z, yaw: side === "l" ? 0.06 : -0.06 });
  });
  return out;
};
