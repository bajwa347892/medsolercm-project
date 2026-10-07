/**
 * The stadium bowl (SPEC §6.1): three-tier oval stands with aisles and lit vomitories, a
 * standing-seam roof canopy ring with 24 ribs, tier fascias with subtle teal LED strips, a raked
 * diagrid facade glowing warm at the concourse levels, ~29.5k instanced spectators (two LODs,
 * hair/caps, energy-driven sway, cheers, a travelling wave and bounce) over a painted crowd,
 * phone flashes (and a sea of phone screens while the floods are off), eight floodlight banks on
 * lattice masts (lamp grids on a closed mounting plate, glow sprites, volumetric beams), the LED
 * boundary boards with their light spill on the grass, a big screen, sight-screens, TV gantries
 * and camera towers, and the lit precinct and city around the ground.
 *
 * API
 *   <Stadium F floods led ledSweep energy detail="far"|"near" beams crowd />
 *     floods   8 bank levels 0..1 (bank i at azimuth i*45deg from +X toward +Z)
 *     led      LED boards, big screen, LED strips and the roof-edge lines, power 0..1
 *     ledSweep 0..1 power-up sweep from the +Z end round both sides to the -Z end
 *     energy   crowd energy 0..1 (sitting/idle sway -> standing, cheering, the wave, bouncing)
 *     detail   "near" skips the 3D crowd and the exterior (macro / close / heavily blurred shots)
 *     beams    beam gain: 1 for ground-level shots (looking toward the lamps), ~2-2.5 for aerials
 *              (beams seen side-on from above read weaker)
 *     crowd    force the 3D spectators on/off (default: on for "far")
 *   stadiumStateAt(F) -> { floods[8], led, ledSweep, energy }   (defaults from the cue sheet)
 *   floodLevel(dfFrames, bank) flicker-then-on curve; bankOn(F, i); crowdCount()
 *   SCREEN, SIGHTSCREEN, TIERS, ovalScale(theta): layout constants for shots
 *
 * Crowd continuity across detail levels: the painted crowd on the rakes is people at every
 * distance unless 3D spectators are drawn; only then does it give way to bare seats close to the
 * camera (by world distance, 24-40 m, so the look does not change with the output resolution).
 * Without the 3D crowd the painted one is densified (rows behind fill the gaps), so a cut between a
 * "far" shot and a "near" one keeps the same packed stand at the same level.
 *
 * Lighting: the bowl's own shaders take the flood level, plus a night-sky / lit-haze-dome term
 * weighted by how much sky each surface sees (roof tops most): before the floods the bowl reads as
 * faint graphite silhouettes, and the roof stays a defined graphite ring from the air.
 *
 * The beams are ray-marched inside per-bank frustum hulls (soft elliptical edge, length falloff,
 * lamp shafts, drifting haze, forward-scattering phase) and end on an analytic copy of the bowl
 * (ground, raked stands, roof), which stands in for a depth texture.
 *
 * Patterns that run around the bowl take their screen derivatives from world coordinates and use
 * periods that divide the circumference, so nothing breaks along the atan seam (theta = +-180deg,
 * the -X side). No shader takes pow() of a negative base (undefined in GLSL: NaN on SwiftShader,
 * which the post bloom would spread into blocks).
 *
 * Every visual is a pure function of F, the camera and the props.
 */
import React, { useMemo } from "react";
import { useThree } from "@react-three/fiber";
import { interpolate } from "remotion";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { EASE_OUT, FPS, prog, rng } from "../config";
import { EV } from "../cues";
import { PAL } from "../theme";
import { FIELD, STADIUM } from "./dims";
import {
  BEAM_GLSL,
  BEAM_EDGE,
  BEAM_TAN_X,
  BEAM_TAN_Y,
  BEAM_Z_HEAD,
  FLOOD_BANKS,
  HEAD_HALF_H,
  HEAD_HALF_W,
  LAMP_COLS,
  LAMP_ROWS,
  getNoise2D,
  getNoise3D,
  makeBeamUniforms,
  setFloodUniform,
} from "./Lights";

/* ================================================================== */
/* State from the cue sheet                                            */
/* ================================================================== */

/** Flicker sequences (per frame after the cue) before a bank settles at full power. */
const FLICKER = [
  [1.0, 0.18, 0.85, 0.3, 0.95, 0.7, 1.0],
  [0.9, 0.35, 0.1, 0.8, 0.45, 1.0],
  [1.0, 0.25, 0.6, 0.15, 1.0, 0.85],
];

/** Level of one flood bank `df` frames after its cue (0 before the cue). */
export const floodLevel = (df: number, bank: number) => {
  if (df < 0) return 0;
  const seq = FLICKER[bank % FLICKER.length];
  const i = Math.floor(df);
  if (i < seq.length) {
    const a = seq[i];
    const b = i + 1 < seq.length ? seq[i + 1] : 1;
    return a + (b - a) * (df - i) * 0.25;
  }
  return 1;
};

export type StadiumState = { floods: number[]; led: number; ledSweep: number; energy: number };

/**
 * Crowd energy keys (global frame, energy). A cheer at bat contact (240: arms up, ~25% on their
 * feet), the stands rising together from crowd_rise (278: ~78% standing by 292, so S06 shows the
 * rise), the roar at the catch (350), full from the stump hit (438) through the montage.
 */
const ENERGY_KEYS: [number, number][] = [
  [0, 0.12],
  [50, 0.22],
  [120, 0.3],
  [236, 0.36],
  [244, 0.5],
  [276, 0.56],
  [292, 0.84],
  [348, 0.86],
  [356, 0.98],
  [438, 1],
  [560, 1],
  [640, 0.85],
  [810, 0.85],
];

/** Sensible defaults for every frame of the film, from src/cues.json. */
export const stadiumStateAt = (F: number): StadiumState => ({
  floods: EV.flood_on.map((f, i) => floodLevel(F - f, i)),
  led: prog(F, EV.led_sweep - 1, EV.led_sweep + 3),
  ledSweep: prog(F, EV.led_sweep, EV.led_sweep + 24, EASE_OUT),
  energy: interpolate(
    F,
    ENERGY_KEYS.map((k) => k[0]),
    ENERGY_KEYS.map((k) => k[1]),
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  ),
});

/* ================================================================== */
/* Layout                                                              */
/* ================================================================== */

/** Slight oval: stands are 4.5% wider along X than along Z. */
export const ovalScale = (theta: number) => 1 + 0.045 * Math.cos(theta) ** 2;

type P2 = [number, number];
type Seg = { kind: number; tier: number; a: P2; b: P2; circA?: boolean };

/** Bowl cross-section (unscaled radius, height). The visible side is to the LEFT of a->b. */
const K = {
  rake: 0,
  fascia: 1,
  soffit: 2,
  back: 3,
  parapet: 4,
  apron: 5,
  facade: 6,
  roofTop: 7,
  roofUnder: 8,
  roofEdge: 9,
  cap: 10,
};
export const TIERS: { a: P2; b: P2; aisles: number }[] = [
  { a: [STADIUM.standInner, 1.6], b: [93, 12.2], aisles: 48 },
  { a: [90, 19], b: [105.5, 28], aisles: 56 },
  { a: [104, 33], b: [122, 43], aisles: 64 },
];
/** Outer facade: raked outward from the street (foot) to the roof (top), radii in metres. */
const FACADE = { foot: 118.5, top: 125.4 };
const ROOF_IN: P2 = [96.5, 46.3];
const ROOF_IN_TOP: P2 = [96.5, 48.6];
const ROOF_OUT_TOP: P2 = [127.5, 52.6];
const ROOF_OUT: P2 = [127.5, 50.6];

const PROFILE: Seg[] = [
  { kind: K.apron, tier: 0, a: [FIELD.ledRadius + 0.35, 0], b: [STADIUM.standInner, 0], circA: true },
  { kind: K.parapet, tier: 0, a: [STADIUM.standInner, 0], b: [STADIUM.standInner, 1.6] },
  { kind: K.rake, tier: 0, a: TIERS[0].a, b: TIERS[0].b },
  { kind: K.back, tier: 0, a: [93, 12.2], b: [93, 14.5] },
  { kind: K.soffit, tier: 0, a: [93, 14.5], b: [90, 14.5] },
  { kind: K.fascia, tier: 0, a: [90, 14.5], b: [90, 19] },
  { kind: K.rake, tier: 1, a: TIERS[1].a, b: TIERS[1].b },
  { kind: K.back, tier: 1, a: [105.5, 28], b: [105.5, 30] },
  { kind: K.soffit, tier: 1, a: [105.5, 30], b: [104, 30] },
  { kind: K.fascia, tier: 1, a: [104, 30], b: [104, 33] },
  { kind: K.rake, tier: 2, a: TIERS[2].a, b: TIERS[2].b },
  { kind: K.cap, tier: 2, a: [122, 43], b: [122, 45] },
  { kind: K.cap, tier: 2, a: [122, 45], b: [124, 45] },
  { kind: K.back, tier: 2, a: [124, 45], b: [124, 51] },
  { kind: K.facade, tier: 0, a: [FACADE.top, 51], b: [FACADE.foot, -0.5] },
  { kind: K.roofEdge, tier: 0, a: ROOF_IN, b: ROOF_IN_TOP },
  { kind: K.roofTop, tier: 0, a: ROOF_IN_TOP, b: ROOF_OUT_TOP },
  { kind: K.roofEdge, tier: 1, a: ROOF_OUT_TOP, b: ROOF_OUT },
  { kind: K.roofUnder, tier: 0, a: ROOF_OUT, b: ROOF_IN },
];

const ROW_PITCH = 0.913;
const SEAT_W = 0.55;
/** Big screen: azimuth (rad) and placement on the upper tier. */
export const SCREEN = { angle: THREE.MathUtils.degToRad(247.5), r: 107, y: 41.4, w: 24, h: 10 };
/** Sight-screens at both ends of the pitch (beyond the boundary on the Z axis). */
export const SIGHTSCREEN = { z: 72.1, w: 22, h: 9.5 };
const SCREEN_TILT = 0.1;

const angDiff = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

/** Same masks as the stand shader: true when a seat at (tier, theta, prof along rake) is usable. */
const seatUsable = (tier: number, th: number, rr: number, prof: number) => {
  const n = TIERS[tier].aisles;
  const block = (Math.PI * 2 * rr) / n;
  const u = (th / (Math.PI * 2)) * n;
  const fu = u - Math.floor(u);
  const distAisle = Math.min(fu, 1 - fu) * block;
  if (distAisle < 0.75) return false;
  if (tier === 0) {
    const k = Math.round(u);
    if (k % 2 === 0 && distAisle < 1.9 && prof > 6.8 && prof < 13.2) return false; // vomitory
    for (const end of [Math.PI / 2, -Math.PI / 2])
      if (Math.abs(angDiff(th, end)) * rr < SIGHTSCREEN.w / 2 + 1.2 && prof < 16) return false;
  }
  if (tier === 2 && Math.abs(angDiff(th, SCREEN.angle)) * rr < SCREEN.w / 2 + 1 && prof > 1 && prof < 16) return false;
  return true;
};

/* ================================================================== */
/* Shared GLSL                                                         */
/* ================================================================== */

const COMMON_GLSL = /* glsl */ `
#ifdef USE_FOG
uniform vec3 fogColor;
uniform float fogNear;
uniform float fogFar;
uniform float fogDensity;
#endif
float fogAmount(float depth) {
#ifdef USE_FOG
  #ifdef FOG_EXP2
  return 1.0 - exp(-fogDensity * fogDensity * depth * depth);
  #else
  return smoothstep(fogNear, fogFar, depth);
  #endif
#else
  return 0.0;
#endif
}
vec3 applyFog(vec3 c, float depth) {
#ifdef USE_FOG
  return mix(c, fogColor, fogAmount(depth));
#else
  return c;
#endif
}
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float ovalScale(float th) { float c = cos(th); return 1.0 + 0.045 * c * c; }
float angDiff(float a, float b) { return atan(sin(a - b), cos(a - b)); }
// Night sky (moon + city glow) and, with the floods up, the lit haze dome above the bowl, for a
// surface that sees a share skyV of the sky. The night part eases off as the floods come up (the
// exposure adapts), so it lets the dark bowl read as graphite without lifting the lit one.
vec3 skyLight(vec3 N, float skyV, float flood) {
  vec3 moonDir = normalize(vec3(-0.4, 0.75, 0.5));
  float sky = 0.3 + 0.7 * max(dot(N, moonDir), 0.0);
  vec3 night = vec3(0.16, 0.19, 0.24) * sky * (1.0 - 0.75 * flood);
  vec3 dome = vec3(0.12, 0.135, 0.14) * flood * max(N.y, 0.0);
  return (night + dome) * skyV;
}
float sdSeg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
// "MPL" wordmark, cap height 1, width ~3.1, slanted. Signed distance in cap-height units.
float mplSDF(vec2 p) {
  p.x -= p.y * 0.18;
  float w = 0.105;
  float d = sdSeg(p, vec2(0.1, 0.0), vec2(0.1, 1.0));
  d = min(d, sdSeg(p, vec2(0.1, 1.0), vec2(0.5, 0.38)));
  d = min(d, sdSeg(p, vec2(0.5, 0.38), vec2(0.9, 1.0)));
  d = min(d, sdSeg(p, vec2(0.9, 1.0), vec2(0.9, 0.0)));
  d = min(d, sdSeg(p, vec2(1.22, 0.0), vec2(1.22, 1.0)));
  d = min(d, sdSeg(p, vec2(1.22, 1.0), vec2(1.68, 1.0)));
  d = min(d, sdSeg(p, vec2(1.22, 0.44), vec2(1.68, 0.44)));
  vec2 c = p - vec2(1.68, 0.72);
  d = min(d, c.x > 0.0 ? abs(length(c) - 0.28) : 1e3);
  d = min(d, sdSeg(p, vec2(2.24, 0.0), vec2(2.24, 1.0)));
  d = min(d, sdSeg(p, vec2(2.24, 0.0), vec2(2.92, 0.0)));
  return d - w;
}
`;

/** Fragment-only helpers (fwidth is not available in vertex shaders). */
const FRAG_GLSL = /* glsl */ `
// screen-space derivative of arc length around the bowl, from world derivatives: fwidth() of an
// atan()-based coordinate blows up along the theta = +-pi seam (the -X side)
float fwArcW(vec3 w) { vec2 d = fwidth(w.xz); return d.x + d.y; }
`;

const TONE = /* glsl */ `
#include <tonemapping_fragment>
#include <colorspace_fragment>
`;

const lin = (hex: string) => new THREE.Color(hex);

const fogUniforms = () => THREE.UniformsUtils.clone(THREE.UniformsLib.fog);

/** Crowd shirt palette (sRGB hex) with weights. ~32% home colours (teal/graphite). */
const SHIRTS: [string, number][] = [
  ["#1C7E82", 0.06],
  ["#166A6E", 0.07],
  [PAL.tealDeep, 0.05],
  [PAL.graphite, 0.06],
  ["#2C3237", 0.05],
  ["#3C4349", 0.03],
  ["#CDD2D5", 0.1],
  ["#AEB4B8", 0.07],
  ["#B49C82", 0.05],
  ["#8E705A", 0.05],
  ["#6C4C40", 0.04],
  ["#4A5A6E", 0.07],
  ["#5C6450", 0.06],
  ["#7E8489", 0.08],
  ["#3E4258", 0.06],
  ["#6A5260", 0.04],
];
const SKINS = ["#C99C7A", "#A87A58", "#8A5A3C", "#5E3D2B", "#DDB494", "#3A2A22"];

const pickShirt = (u: number) => {
  let acc = 0;
  const tot = SHIRTS.reduce((a, s) => a + s[1], 0);
  for (const [hex, w] of SHIRTS) {
    acc += w / tot;
    if (u < acc) return hex;
  }
  return SHIRTS[SHIRTS.length - 1][0];
};

/* ================================================================== */
/* Stand bowl surfaces                                                 */
/* ================================================================== */

const BOWL_SEGS = 720;

const buildBowl = () => {
  const pos: number[] = [];
  const nor: number[] = [];
  const kind: number[] = [];
  const tier: number[] = [];
  const prof: number[] = [];
  const len: number[] = [];
  const idx: number[] = [];
  for (const s of PROFILE) {
    const dr = s.b[0] - s.a[0];
    const dy = s.b[1] - s.a[1];
    const L = Math.hypot(dr, dy);
    const nr = -dy / L;
    const ny = dr / L;
    const base = pos.length / 3;
    for (let j = 0; j <= BOWL_SEGS; j++) {
      const th = (j / BOWL_SEGS) * Math.PI * 2;
      const sc = ovalScale(th);
      const c = Math.cos(th);
      const sn = Math.sin(th);
      const ends: [P2, boolean, number][] = [
        [s.a, !!s.circA, 0],
        [s.b, false, L],
      ];
      for (const [p, circ, pr] of ends) {
        const r = p[0] * (circ ? 1 : sc);
        pos.push(r * c, p[1], r * sn);
        nor.push(nr * c, ny, nr * sn);
        kind.push(s.kind);
        tier.push(s.tier);
        prof.push(pr);
        len.push(L);
      }
    }
    // winding check on the first quad
    const v = (i: number) => new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    const p0 = v(base);
    const p1 = v(base + 1);
    const p2 = v(base + 2);
    const fn = new THREE.Vector3().subVectors(p1, p0).cross(new THREE.Vector3().subVectors(p2, p0));
    const n0 = new THREE.Vector3(nor[base * 3], nor[base * 3 + 1], nor[base * 3 + 2]);
    const flip = fn.dot(n0) < 0;
    for (let j = 0; j < BOWL_SEGS; j++) {
      const i0 = base + j * 2;
      const i1 = i0 + 1;
      const i2 = i0 + 2;
      const i3 = i0 + 3;
      if (!flip) idx.push(i0, i1, i2, i1, i3, i2);
      else idx.push(i0, i2, i1, i1, i2, i3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("aKind", new THREE.Float32BufferAttribute(kind, 1));
  g.setAttribute("aTier", new THREE.Float32BufferAttribute(tier, 1));
  g.setAttribute("aProf", new THREE.Float32BufferAttribute(prof, 1));
  g.setAttribute("aLen", new THREE.Float32BufferAttribute(len, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
};

const BOWL_VERT = /* glsl */ `
attribute float aKind;
attribute float aTier;
attribute float aProf;
attribute float aLen;
varying vec3 vW;
varying vec3 vN;
varying float vKind;
varying float vTier;
varying float vProf;
varying float vLen;
varying float vFogDepth;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vKind = aKind; vTier = aTier; vProf = aProf; vLen = aLen;
  vec4 mv = viewMatrix * w;
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const BOWL_FRAG = /* glsl */ `
${COMMON_GLSL}
${FRAG_GLSL}
uniform float uTime;
uniform float uFlood;
uniform float uLed;
uniform float uSeats;
uniform vec3 uPal[16];
uniform vec3 uPalMean;
uniform vec3 uTeal;
uniform vec3 uWarm;
uniform vec3 uSilver;
uniform vec3 uGraphite;
uniform vec3 uGraphiteDark;
uniform float uScreenAng;
uniform float uScreenHalf;
uniform float uSightHalf;
uniform vec2 uTierA[3];
varying vec3 vW;
varying vec3 vN;
varying float vKind;
varying float vTier;
varying float vProf;
varying float vLen;
varying float vFogDepth;

vec3 crowdCell(float th, float rr, float tier, float seatK, out float occupied) {
  float rowF = vProf / ${ROW_PITCH.toFixed(3)};
  float row = floor(rowF);
  int ti = int(tier + 0.5);
  float rowR = uTierA[ti].x + (row + 0.5) * ${ROW_PITCH.toFixed(3)} * uTierA[ti].y;
  float seatF = th * rowR / ${SEAT_W.toFixed(3)} + mod(row, 2.0) * 0.5;
  vec2 cell = vec2(floor(seatF), row);
  vec2 f = vec2(fract(seatF), fract(rowF));
  float h = hash21(cell + tier * vec2(131.0, 17.0));
  float h2 = hash21(cell.yx + 7.3 + tier);
  float h3 = hash21(cell + 3.1);
  occupied = step(h, 0.95);
  // fan clusters: some blocks lean to the home colours
  vec2 blk = floor(vec2(seatF / 9.0, rowF / 4.0));
  float home = step(0.72, hash21(blk + tier * 9.0));
  int pi = int(h2 * 15.99);
  if (home > 0.5 && h3 < 0.6) pi = int(h3 * 8.3);
  vec3 shirt = uPal[pi] * (0.8 + 0.6 * h3);
  vec3 gap = mix(uGraphiteDark * 0.4, uPalMean * 0.35, 0.5);
  // with no 3D spectators in front (detail="near"), the painted crowd alone has to read as a packed
  // stand from any angle: the row behind fills the gaps and the bodies are broader, so the stand
  // matches the 3D crowd's density and level across a cut between detail levels
  float solo = 1.0 - uSeats;
  vec3 behind = uPal[int(hash21(cell + vec2(0.0, 1.0) + tier * 5.0) * 15.99)] * 0.62;
  gap = mix(gap, behind, 0.6 * solo);
  float bodyW = 0.4 + 0.08 * h3 + 0.07 * solo;
  shirt *= 1.0 + 0.12 * solo;
  float body = (1.0 - smoothstep(bodyW - 0.03, bodyW + 0.03, abs(f.x - 0.5) * 2.0 * (1.0 + 0.35 * smoothstep(0.55, 0.8, f.y))))
    * smoothstep(0.08, 0.16, f.y) * (1.0 - smoothstep(0.74, 0.8, f.y));
  vec2 hc = vec2(0.5 + (h - 0.5) * 0.18, 0.87);
  float head = 1.0 - smoothstep(0.12, 0.16, length((f - hc) * vec2(1.0, 0.6)));
  vec3 skin = mix(vec3(0.30, 0.17, 0.10), vec3(0.05, 0.035, 0.03), h2 * h2);
  vec3 col = gap;
  col = mix(col, shirt, body * occupied);
  col = mix(col, skin * (0.7 + 0.25 * solo), head * occupied);
  // shoulders of the row in front overlap the bottom of the cell
  col *= mix(0.55, 1.0, smoothstep(0.0, 0.12, f.y));
  float fw = max(fwArcW(vW) / ${SEAT_W.toFixed(3)}, fwidth(rowF));
  // where the 3D spectators are drawn and the camera is close (seatK, by world distance so the
  // look does not depend on the output resolution) the painted people give way to the seats
  // themselves: graphite tip-up seats on a concrete tread with a lit nosing
  float back = (1.0 - smoothstep(0.38, 0.44, abs(f.x - 0.5))) * smoothstep(0.3, 0.36, f.y) * (1.0 - smoothstep(0.72, 0.78, f.y));
  float pan = (1.0 - smoothstep(0.36, 0.42, abs(f.x - 0.5))) * smoothstep(0.2, 0.24, f.y) * (1.0 - smoothstep(0.3, 0.34, f.y));
  vec3 tread = vec3(0.045, 0.047, 0.05) * mix(0.7, 1.0, smoothstep(0.0, 0.18, f.y));
  vec3 seatC = uGraphite * (0.9 + 0.25 * h3);
  vec3 seats = mix(tread, seatC, max(back, pan * 0.8));
  seats += vec3(0.05) * (1.0 - smoothstep(0.0, 0.035, f.y));
  col = mix(col, seats, seatK * (1.0 - smoothstep(0.25, 0.5, fw)));
  vec3 avg = mix(gap, uPalMean * (0.85 + 0.3 * hash21(blk)), (0.62 + 0.12 * solo) * occupied);
  return mix(col, avg, smoothstep(0.35, 0.95, fw));
}

void main() {
  float th = atan(vW.z, vW.x);
  float sc = ovalScale(th);
  float rr = length(vW.xz) / sc;
  float arc = th * rr;
  int kind = int(vKind + 0.5);
  float v = vProf / max(vLen, 1e-3);
  vec3 alb = uGraphite * 0.6;
  vec3 emi = vec3(0.0);
  float spill = 0.5;
  // share of the night sky / lit haze dome each surface sees (roof tops most, soffits least)
  float skyV = 0.3;
  float fwArc = fwArcW(vW);

  if (kind == ${K.rake}) {
    float tier = vTier;
    float n = tier < 0.5 ? ${TIERS[0].aisles.toFixed(1)} : (tier < 1.5 ? ${TIERS[1].aisles.toFixed(1)} : ${TIERS[2].aisles.toFixed(1)});
    float block = 6.2831853 * rr / n;
    float u = th / 6.2831853 * n;
    float fu = fract(u);
    float dA = min(fu, 1.0 - fu) * block;
    float occ;
    float camD = length(cameraPosition - vW);
    float seatK = uSeats * (1.0 - smoothstep(24.0, 40.0, camD));
    vec3 c = crowdCell(th, rr, tier, seatK, occ);
    // aisle stairs: light concrete with step lines
    float stepL = smoothstep(0.3, 0.5, abs(fract(vProf / 0.4565) - 0.5));
    vec3 aisle = vec3(0.09, 0.095, 0.1) * mix(0.55, 1.0, stepL);
    float aisleM = 1.0 - smoothstep(0.62, 0.78 + fwArc, dA);
    c = mix(c, aisle, aisleM);
    if (tier < 0.5) {
      // vomitories (every second aisle, mid-tier)
      float k = floor(u + 0.5);
      float isV = step(mod(k, 2.0), 0.5);
      float vm = isV * (1.0 - smoothstep(1.7, 1.9 + fwArc, dA)) * step(6.8, vProf) * step(vProf, 13.2);
      float rail = isV * (1.0 - smoothstep(0.0, 0.06 + fwArc, abs(dA - 1.8))) * step(6.8, vProf) * step(vProf, 13.4);
      vec3 vomCol = vec3(0.004) + uWarm * 0.01 * smoothstep(13.2, 7.0, vProf);
      c = mix(c, vomCol, vm);
      // the tunnel mouth is lit from the concourse behind it (never a black hole)
      float vIn = (1.0 - smoothstep(0.6, 1.8, dA)) * smoothstep(6.8, 8.6, vProf) * (1.0 - smoothstep(11.5, 13.2, vProf));
      emi += vm * mix(uWarm, vec3(1.0), 0.4) * (0.004 + 0.012 * vIn);
      c = mix(c, uSilver * 0.35, rail);
      // empty dark block behind each sight-screen
      float dS = min(abs(angDiff(th, 1.5707963)), abs(angDiff(th, -1.5707963))) * rr;
      float sm = (1.0 - smoothstep(uSightHalf, uSightHalf + 0.6, dS)) * step(vProf, 16.0);
      c = mix(c, uGraphiteDark * 0.35, sm);
    }
    if (tier > 1.5) {
      float dS = abs(angDiff(th, uScreenAng)) * rr;
      float sm = (1.0 - smoothstep(uScreenHalf, uScreenHalf + 0.5, dS)) * step(1.0, vProf) * step(vProf, 16.0);
      c = mix(c, uGraphiteDark * 0.3, sm);
    }
    alb = c;
    skyV = tier < 0.5 ? 0.4 : (tier < 1.5 ? 0.22 : 0.14);
    // spill: lower tier brightest; back rows under the overhang/roof darker
    spill = tier < 0.5 ? mix(1.0, 0.62, smoothstep(0.55, 1.0, v)) : (tier < 1.5 ? mix(0.82, 0.55, smoothstep(0.5, 1.0, v)) : mix(0.62, 0.32, v));
  } else if (kind == ${K.fascia}) {
    float hgt = vProf;
    float pw = 3.0;
    float panel = fract(arc / pw);
    float mull = smoothstep(0.0, 0.03 + fwArc / pw, panel) * (1.0 - smoothstep(0.97 - fwArc / pw, 1.0, panel));
    float glass = step(vLen * 0.3, hgt) * step(hgt, vLen * 0.7);
    float lit = hash11(floor(arc / pw) + vTier * 50.0);
    alb = mix(uGraphite * 0.55, vec3(0.006, 0.008, 0.009), glass * mull);
    emi += glass * mull * mix(uWarm, vec3(1.0), 0.45) * 0.012 * step(0.8, lit);
    // glass picks up the lit bowl
    vec3 Vf = normalize(cameraPosition - vW);
    emi += glass * mull * vec3(0.03, 0.04, 0.045) * pow(clamp(1.0 - dot(normalize(vN), Vf), 0.0, 1.0), 3.0) * uFlood;
    // subtle teal LED strip along the top of each facade band
    float strip = smoothstep(vLen - 0.36, vLen - 0.33, hgt) * (1.0 - smoothstep(vLen - 0.26, vLen - 0.23, hgt));
    emi += strip * uTeal * 1.1 * uLed;
    float rail = smoothstep(vLen - 0.1, vLen - 0.06, hgt) + (1.0 - smoothstep(0.05, 0.09, hgt));
    alb = mix(alb, uSilver * 0.35, clamp(rail, 0.0, 1.0));
    spill = 0.55;
    skyV = 0.2;
  } else if (kind == ${K.soffit}) {
    alb = uGraphiteDark * 0.5;
    vec2 g = vec2(fract(arc / 3.0) - 0.5, v - 0.5);
    float dl = 1.0 - smoothstep(0.05, 0.12, length(g * vec2(3.0, vLen)));
    emi += dl * uWarm * 0.9;
    spill = 0.1;
    skyV = 0.03;
  } else if (kind == ${K.back}) {
    alb = uGraphiteDark * 0.6;
    float op = step(0.3, fract(arc / 9.0)) * step(fract(arc / 9.0), 0.75) * step(0.15, v) * step(v, 0.9);
    emi += op * uWarm * (0.002 + 0.008 * hash11(floor(arc / 9.0) + vTier * 7.0)) * v;
    spill = 0.15;
    skyV = 0.1;
  } else if (kind == ${K.parapet}) {
    alb = uGraphiteDark;
    float rail = smoothstep(vLen - 0.08, vLen - 0.04, vProf);
    alb = mix(alb, uSilver * 0.45, rail);
    spill = 0.7;
  } else if (kind == ${K.apron}) {
    // turf verge behind the boards, then a concrete walkway at the foot of the stand
    float walk = smoothstep(${(STADIUM.standInner - 1.4).toFixed(1)}, ${(STADIUM.standInner - 1.2).toFixed(1)}, rr);
    alb = mix(vec3(0.03, 0.05, 0.032), vec3(0.06, 0.062, 0.064), walk);
    spill = 0.95;
    skyV = 0.35;
  } else if (kind == ${K.facade}) {
    // raked diagrid skin (graphite members) over a glazed inner wall: the concourse levels glow
    // warm through the lattice, plaza uplights wash the lower members, a lit entrance band at
    // street level. Reads as architecture from the S15 pull-back, silhouette-first.
    float y = vW.y;
    float bays = floor(6.2831853 * ${FACADE.top.toFixed(1)} / 7.2 + 0.5);
    float u = th / 6.2831853 * bays;
    float w = y / 10.3;
    float a1 = u + w, a2 = u - w;
    float f1 = abs(fract(a1) - 0.5), f2 = abs(fract(a2) - 0.5);
    float fwa = fwArc * bays / (6.2831853 * rr) + fwidth(w);
    float mem = max(smoothstep(0.455 - fwa, 0.455 + fwa, f1), smoothstep(0.455 - fwa, 0.455 + fwa, f2));
    float fy = fwidth(y);
    float ring = 0.0;
    ring = max(ring, 1.0 - smoothstep(0.22, 0.22 + fy, abs(y - 11.6)));
    ring = max(ring, 1.0 - smoothstep(0.22, 0.22 + fy, abs(y - 26.4)));
    ring = max(ring, 1.0 - smoothstep(0.22, 0.22 + fy, abs(y - 40.6)));
    ring = max(ring, smoothstep(49.6, 49.6 + fy, y));
    float frame = max(mem, ring);
    float bay = hash11(floor(u * 2.0) + 17.0);
    vec4 gq = (vec4(y) - vec4(13.2, 27.9, 42.0, 2.6)) / vec4(2.4, 2.3, 2.1, 1.9);
    float g = dot(exp(-gq * gq), vec4(1.0, 0.8, 0.55, 1.1));
    vec3 glowC = mix(uWarm, vec3(1.0), 0.35);
    // inner glazing: faint mullions, the glow, and a dark band where the stands' backs sit
    float mullI = 1.0 - smoothstep(0.03, 0.03 + fwArc / 1.8, abs(fract(arc / 1.8) - 0.5) - 0.44);
    vec3 inner = glowC * (0.004 + 0.07 * g * (0.6 + 0.4 * bay)) * mix(1.0, 0.45, mullI);
    float up = exp(-max(y, 0.0) / 14.0);
    vec3 memC = uSilver * 0.075;
    emi += mix(inner, memC * (glowC * 0.9 * up + 0.06), frame);
    alb = mix(vec3(0.004), memC, frame);
    spill = 0.04;
    skyV = 0.5;
  } else if (kind == ${K.roofTop}) {
    // standing-seam metal roof: dark graphite panels, radial seams, concentric laps, 24 structural
    // ribs, trims at both edges; a cool sheen from the lit haze at grazing angles
    float ang = th / 6.2831853;
    float uS = ang * 360.0;
    float fS = fract(uS);
    float fwAng = fwArc / (6.2831853 * rr);
    float seamR = 1.0 - smoothstep(0.0, 0.035 + fwAng * 360.0 * 1.5, min(fS, 1.0 - fS));
    float uC = vProf / 10.5;
    float fC = fract(uC);
    float seamC = (1.0 - smoothstep(0.0, 0.01 + fwidth(uC) * 1.5, min(fC, 1.0 - fC))) * 0.5;
    float uB = ang * 24.0;
    float fB = fract(uB);
    float rib = 1.0 - smoothstep(0.012, 0.016 + fwAng * 24.0 * 1.5, min(fB, 1.0 - fB));
    float pid = hash21(vec2(floor(uS), floor(uC)));
    vec3 base = uSilver * (0.075 + 0.025 * pid);
    alb = mix(base, base * 0.6, max(seamR, seamC) * 0.7);
    alb = mix(alb, uSilver * 0.13, rib);
    float trim = smoothstep(0.965, 0.985, v) + 1.0 - smoothstep(0.015, 0.035, v);
    alb = mix(alb, uSilver * 0.16, clamp(trim, 0.0, 1.0));
    vec3 V = normalize(cameraPosition - vW);
    float fres = pow(clamp(1.0 - dot(normalize(vN), V), 0.0, 1.0), 4.0);
    emi += vec3(0.035, 0.05, 0.055) * fres * (0.3 + 0.7 * uFlood) * (0.7 + 0.3 * pid + rib);
    // the glow of the lit bowl reaching over the inner edge
    emi += vec3(0.006, 0.008, 0.009) * uFlood * (1.0 - v) * (1.0 - v);
    spill = 0.1;
    skyV = 1.0;
  } else if (kind == ${K.roofUnder}) {
    float truss = 1.0 - smoothstep(0.0, 0.06 + fwArc * 96.0 / (6.2831853 * rr), abs(fract(th * 96.0 / 6.2831853) - 0.5) - 0.42);
    alb = mix(uGraphiteDark * 0.45, uGraphite * 0.7, truss);
    // catwalk lights near the inner edge
    float cw = 1.0 - smoothstep(0.06, 0.14, length(vec2((fract(arc / 5.0) - 0.5) * 5.0, (v - 0.9) * vLen)));
    emi += cw * mix(uWarm, vec3(1.0), 0.5) * 2.2;
    spill = 0.12;
    skyV = 0.04;
  } else if (kind == ${K.roofEdge}) {
    alb = uGraphite * 0.75;
    float line = smoothstep(0.86, 0.9, v) + (1.0 - smoothstep(0.08, 0.12, v));
    alb = mix(alb, uSilver * 0.5, clamp(line, 0.0, 1.0));
    float crown = smoothstep(0.42, 0.46, v) * (1.0 - smoothstep(0.54, 0.58, v));
    emi += crown * uTeal * (vTier < 0.5 ? 0.9 : 0.55) * uLed;
    alb = mix(alb, uSilver * 0.12, step(0.5, vTier) * 0.5);
    spill = 0.45;
    skyV = 0.7;
  } else {
    alb = uGraphite * 0.6;
    spill = 0.3;
  }

  vec3 N = normalize(vN);
  vec3 L = normalize(vec3(-vW.x, 0.9 * length(vW.xz), -vW.z));
  float diff = 0.35 + 0.65 * max(dot(N, L), 0.0);
  // broad pools of light between the banks
  float pool = 0.85 + 0.15 * cos(th * 8.0 + 3.14159);
  float light = 0.012 + uFlood * 0.42 * spill * diff * pool;
  vec3 col = alb * (light + skyLight(N, skyV, uFlood)) + emi;
  col = applyFog(col, vFogDepth);
  gl_FragColor = vec4(col, 1.0);
  ${TONE}
}
`;

const paletteUniform = () => {
  const cols = SHIRTS.map(([hex]) => lin(hex));
  const mean = new THREE.Color(0, 0, 0);
  const tot = SHIRTS.reduce((a, s) => a + s[1], 0);
  SHIRTS.forEach(([, w], i) => {
    mean.r += (cols[i].r * w) / tot;
    mean.g += (cols[i].g * w) / tot;
    mean.b += (cols[i].b * w) / tot;
  });
  return { cols: cols.map((c) => new THREE.Vector3(c.r, c.g, c.b)), mean: new THREE.Vector3(mean.r, mean.g, mean.b) };
};

const vec3Of = (hex: string) => {
  const c = lin(hex);
  return new THREE.Vector3(c.r, c.g, c.b);
};

const Bowl: React.FC<{ t: number; flood: number; led: number; seats: boolean }> = ({ t, flood, led, seats }) => {
  const { geo, mat } = useMemo(() => {
    const pal = paletteUniform();
    const m = new THREE.ShaderMaterial({
      vertexShader: BOWL_VERT,
      fragmentShader: BOWL_FRAG,
      fog: true,
      uniforms: {
        ...fogUniforms(),
        uTime: { value: 0 },
        uFlood: { value: 0 },
        uLed: { value: 0 },
        uSeats: { value: 1 },
        uPal: { value: pal.cols },
        uPalMean: { value: pal.mean },
        uTeal: { value: vec3Of(PAL.teal) },
        uWarm: { value: vec3Of(PAL.warm) },
        uSilver: { value: vec3Of(PAL.silver) },
        uGraphite: { value: vec3Of(PAL.graphite) },
        uGraphiteDark: { value: vec3Of(PAL.graphiteDark) },
        uScreenAng: { value: Math.atan2(Math.sin(SCREEN.angle), Math.cos(SCREEN.angle)) },
        uScreenHalf: { value: SCREEN.w / 2 + 0.5 },
        uSightHalf: { value: SIGHTSCREEN.w / 2 + 1.2 },
        uTierA: {
          value: TIERS.map(
            (T) => new THREE.Vector2(T.a[0], (T.b[0] - T.a[0]) / Math.hypot(T.b[0] - T.a[0], T.b[1] - T.a[1])),
          ),
        },
      },
    });
    return { geo: buildBowl(), mat: m };
  }, []);
  mat.uniforms.uTime.value = t;
  mat.uniforms.uFlood.value = flood;
  mat.uniforms.uLed.value = led;
  mat.uniforms.uSeats.value = seats ? 1 : 0;
  return <mesh geometry={geo} material={mat} frustumCulled={false} />;
};

/* ================================================================== */
/* Crowd                                                               */
/* ================================================================== */

type Seat = { x: number; y: number; z: number; th: number; tier: number };

/** All 3D spectators, deterministic. ~30k figures. */
const buildSeats = (): Seat[] => {
  const r = rng(4242);
  // lower tier fullest (it is the one cameras see up close); the painted crowd on the rake fills the
  // gaps at distance
  const fill = [0.8, 0.45, 0.3];
  const out: Seat[] = [];
  TIERS.forEach((T, tier) => {
    const dr = T.b[0] - T.a[0];
    const dy = T.b[1] - T.a[1];
    const L = Math.hypot(dr, dy);
    const rows = Math.floor(L / ROW_PITCH);
    for (let k = 0; k < rows; k++) {
      const prof = (k + 0.55) * ROW_PITCH;
      const rr = T.a[0] + (dr * prof) / L;
      const y = T.a[1] + (dy * prof) / L;
      const n = Math.floor((Math.PI * 2 * rr) / SEAT_W);
      for (let s = 0; s < n; s++) {
        const th = ((s + 0.5) * SEAT_W) / rr - Math.PI;
        if (r() > fill[tier]) continue;
        if (!seatUsable(tier, th, rr, prof)) continue;
        const sc = ovalScale(th);
        const jit = (r() - 0.5) * 0.12;
        const rad = rr * sc + 0.1;
        out.push({ x: Math.cos(th + jit / rr) * rad, y, z: Math.sin(th + jit / rr) * rad, th, tier });
      }
    }
  });
  return out;
};

let seatCache: Seat[] | null = null;
const getSeats = () => (seatCache ??= buildSeats());

const tagPart = (g: THREE.BufferGeometry, part: number, armLen = 0) => {
  const n = g.attributes.position.count;
  const pa = new Float32Array(n).fill(part);
  const aa = new Float32Array(n);
  if (armLen > 0) for (let i = 0; i < n; i++) aa[i] = Math.min(1, Math.max(0, -g.attributes.position.getY(i) / armLen));
  g.setAttribute("aPart", new THREE.BufferAttribute(pa, 1));
  g.setAttribute("aArm", new THREE.BufferAttribute(aa, 1));
  g.deleteAttribute("uv");
  return g;
};

/**
 * Spectator figure, local +Z faces the field. Parts: 0 torso, 1 head, 2/3 arms (pivot at the
 * shoulder, (+-0.235, 1.0, 0)), 4 lower body. Two levels of detail with identical part layout:
 *   near: smooth indexed capsules/spheres (~600 verts), for stands within ~40m of the camera
 *   far:  indexed boxes (~110 verts), for everything else
 */
const buildFigure = (lod: "near" | "far") => {
  const parts: THREE.BufferGeometry[] = [];
  if (lod === "near") {
    const torso = new THREE.CapsuleGeometry(0.15, 0.3, 3, 10);
    const tp = torso.attributes.position;
    for (let i = 0; i < tp.count; i++) {
      const y = tp.getY(i);
      // broad shoulders, narrower waist, flattened front-to-back
      const k = y > 0.05 ? 1.32 : 1.12 + (y + 0.3) * 0.5;
      tp.setX(i, tp.getX(i) * k);
      tp.setZ(i, tp.getZ(i) * 0.68);
    }
    torso.computeVertexNormals();
    torso.translate(0, 0.76, 0);
    parts.push(tagPart(torso, 0));
    const head = new THREE.SphereGeometry(0.104, 10, 8);
    head.scale(0.9, 1.12, 1.0);
    head.translate(0, 1.17, 0.012);
    parts.push(tagPart(head, 1));
    const neck = new THREE.CylinderGeometry(0.045, 0.05, 0.1, 6, 1, true);
    neck.translate(0, 1.07, 0);
    parts.push(tagPart(neck, 1));
    for (const side of [-1, 1]) {
      const arm = new THREE.CapsuleGeometry(0.045, 0.46, 2, 6);
      arm.translate(0, -0.27, 0);
      tagPart(arm, side < 0 ? 2 : 3, 0.56);
      arm.translate(side * 0.235, 1.0, 0);
      parts.push(arm);
    }
    const legs = new THREE.CapsuleGeometry(0.12, 0.22, 2, 8);
    legs.scale(1.25, 1, 0.8);
    legs.translate(0, 0.28, 0.02);
    parts.push(tagPart(legs, 4));
  } else {
    const torso = new THREE.BoxGeometry(0.4, 0.55, 0.22);
    const tp = torso.attributes.position;
    for (let i = 0; i < tp.count; i++) if (tp.getY(i) < 0) tp.setX(i, tp.getX(i) * 0.8);
    torso.translate(0, 0.75, 0);
    parts.push(tagPart(torso, 0));
    const head = new THREE.SphereGeometry(0.112, 6, 4);
    head.scale(0.9, 1.1, 0.95);
    head.translate(0, 1.16, 0.01);
    parts.push(tagPart(head, 1));
    for (const side of [-1, 1]) {
      const arm = new THREE.BoxGeometry(0.085, 0.56, 0.085);
      arm.translate(0, -0.28, 0);
      tagPart(arm, side < 0 ? 2 : 3, 0.56);
      arm.translate(side * 0.235, 1.0, 0);
      parts.push(arm);
    }
    const legs = new THREE.BoxGeometry(0.3, 0.45, 0.18);
    legs.translate(0, 0.255, 0.02);
    parts.push(tagPart(legs, 4));
  }
  const g = mergeGeometries(parts, false);
  if (!g) throw new Error("figure merge failed");
  return g;
};

const CROWD_VERT = /* glsl */ `
${COMMON_GLSL}
attribute float aPart;
attribute float aArm;
attribute vec3 iPos;
attribute vec4 iData; // yaw, seedA, seedB, tier
attribute vec3 iShirt;
attribute vec3 iHead;
attribute vec4 iHair; // rgb, coverage (0 bald .. 1 cap)
uniform float uTime;
uniform float uEnergy;
varying vec3 vCol;
varying vec3 vN;
varying vec3 vW;
varying float vFogDepth;

mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
mat3 rotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }

void main() {
  float yaw = iData.x, sa = iData.y, sb = iData.z;
  float e = uEnergy;
  vec3 p = position;
  vec3 n = normal;

  // who is standing (more people stand as energy rises)
  float stand = smoothstep(0.0, 0.12, e - (0.25 + sa * 0.75));
  // cheering episodes: random per person, more frequent with energy
  float rate = 0.22 + sb * 0.3;
  float cyc = uTime * rate + sa * 13.7;
  float ep = floor(cyc);
  float ph = fract(cyc);
  float cheerOn = step(hash11(ep * 1.37 + sa * 91.3 + sb * 7.1), e * 1.1 - 0.25);
  float raise = cheerOn * smoothstep(0.0, 0.16, ph) * (1.0 - smoothstep(0.55, 0.78, ph));
  // travelling arms-up wave around the bowl (~15 m/s at the stands, like a real one)
  float ang = atan(iPos.z, iPos.x);
  float wpos = mod(uTime * 0.16 + 1.2, 6.2831853) - 3.1415927;
  float dw = angDiff(ang, wpos);
  float wave = smoothstep(0.5, 0.75, e) * exp(-dw * dw * 38.0);
  raise = max(raise, wave);
  stand = max(stand, max(wave, raise * 0.7));

  float up = stand * 0.42;
  // bounce when the place is rocking
  float bounce = max(0.0, sin(uTime * 8.6 + sa * 6.2831853)) * 0.1 * smoothstep(0.8, 1.0, e) * step(0.55, sb) * stand;

  vec3 lp = p;
  if (aPart > 1.5 && aPart < 3.5) {
    float side = aPart > 2.5 ? 1.0 : -1.0;
    float both = side > 0.0 ? 1.0 : step(0.35, sb);
    float a = raise * both * (2.55 + 0.25 * sin(uTime * 7.0 + sa * 30.0));
    // idle: arms slightly forward (resting on knees)
    a = max(a, 0.35 * (1.0 - stand));
    vec3 sh = vec3(side * 0.235, 1.0, 0.0);
    vec3 v = p - sh;
    mat3 R = rotZ(-side * 0.3 * raise * both) * rotX(-a);
    v = R * v;
    n = R * n;
    p = sh + v;
    p.y += up;
  } else if (aPart > 3.5) {
    p.y = 0.03 + (p.y - 0.03) * (1.0 + stand * 0.93);
  } else {
    p.y += up;
  }
  // idle sway (lean around the hips)
  float sway = sin(uTime * (0.8 + sb * 0.9) + sa * 40.0) * 0.05 * (0.35 + e);
  if (aPart < 3.5) {
    mat3 S = rotZ(sway * 0.6) * rotX(sin(uTime * 0.6 + sb * 20.0) * 0.04);
    vec3 hip = vec3(0.0, 0.48 + up, 0.0);
    p = hip + S * (p - hip);
    n = S * n;
  }
  p.y += bounce;

  mat3 Y = rotY(yaw);
  vec3 wp = iPos + Y * p;
  vN = normalize(Y * n);
  vW = wp;
  vec3 legCol = mix(vec3(0.012, 0.014, 0.018), vec3(0.03, 0.04, 0.06), step(0.5, sb));
  // hair / cap on the top and back of the head (local, before animation)
  float hy = lp.y - 1.17;
  float hairM = smoothstep(0.0, 0.03, hy + 0.035 - (1.0 - iHair.w) * 0.09 - lp.z * 0.6) * step(0.02, iHair.w);
  vec3 headCol = mix(iHead, iHair.rgb, hairM);
  vCol = aPart < 0.5 ? iShirt : (aPart < 1.5 ? headCol : (aPart < 3.5 ? iShirt * 0.92 : legCol));
  // skin on the forearms of short sleeves
  if (aPart > 1.5 && aPart < 3.5 && aArm > 0.45 && sb < 0.6) vCol = iHead;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const CROWD_FRAG = /* glsl */ `
${COMMON_GLSL}
uniform float uFlood;
varying vec3 vCol;
varying vec3 vN;
varying vec3 vW;
varying float vFogDepth;
void main() {
  vec3 N = normalize(vN);
  vec3 L = normalize(vec3(-vW.x, 0.9 * length(vW.xz), -vW.z));
  float diff = 0.3 + 0.7 * max(dot(N, L), 0.0);
  float tierK = vW.y < 14.0 ? 1.0 : (vW.y < 30.0 ? 0.78 : 0.55);
  float th = atan(vW.z, vW.x);
  float pool = 0.85 + 0.15 * cos(th * 8.0 + 3.14159);
  // rim from the opposite banks
  vec3 V = normalize(cameraPosition - vW);
  float rim = pow(clamp(1.0 - dot(N, V), 0.0, 1.0), 3.0) * 0.25;
  float light = 0.012 + uFlood * 0.42 * tierK * (diff + rim) * pool;
  float skyV = vW.y < 14.0 ? 0.4 : (vW.y < 30.0 ? 0.22 : 0.14);
  vec3 col = vCol * (light + skyLight(N, skyV, uFlood));
  col = applyFog(col, vFogDepth);
  gl_FragColor = vec4(col, 1.0);
  ${TONE}
}
`;

const CROWD_SECTORS = 24;
/** Stands closer than this (m) to the camera use the smooth near-LOD figure. */
const CROWD_NEAR_LOD = 42;

const HAIRS: [string, number][] = [
  ["#120d0a", 0.42],
  ["#2a1b12", 0.2],
  ["#5a4636", 0.06],
  ["#7c7a78", 0.06],
  [PAL.tealDeep, 0.07], // home caps
  [PAL.graphite, 0.05], // home caps
  ["#000000", 0.14], // bald / shaved (coverage 0)
];

const Crowd: React.FC<{ t: number; flood: number; energy: number }> = ({ t, flood, energy }) => {
  const { meshes, mat } = useMemo(() => {
    const seats = getSeats();
    const figNear = buildFigure("near");
    const figFar = buildFigure("far");
    const r = rng(777);
    const buckets: Seat[][] = Array.from({ length: CROWD_SECTORS }, () => []);
    seats.forEach((s) => {
      const k = Math.floor(((s.th + Math.PI) / (Math.PI * 2)) * CROWD_SECTORS) % CROWD_SECTORS;
      buckets[k].push(s);
    });
    const shirtCache = new Map<string, THREE.Color>();
    const col = (hex: string) => {
      let c = shirtCache.get(hex);
      if (!c) {
        c = lin(hex);
        shirtCache.set(hex, c);
      }
      return c;
    };
    const hairTot = HAIRS.reduce((a, h) => a + h[1], 0);
    const pickHair = (u: number) => {
      let acc = 0;
      for (let i = 0; i < HAIRS.length; i++) {
        acc += HAIRS[i][1] / hairTot;
        if (u < acc) return i;
      }
      return 0;
    };
    const m = new THREE.ShaderMaterial({
      vertexShader: CROWD_VERT,
      fragmentShader: CROWD_FRAG,
      fog: true,
      uniforms: {
        ...fogUniforms(),
        uTime: { value: 0 },
        uEnergy: { value: 0 },
        uFlood: { value: 0 },
      },
    });
    const out: THREE.Mesh[] = [];
    buckets.forEach((list) => {
      const n = list.length;
      const ip = new Float32Array(n * 3);
      const id = new Float32Array(n * 4);
      const ish = new Float32Array(n * 3);
      const ih = new Float32Array(n * 3);
      const ihr = new Float32Array(n * 4);
      const box = new THREE.Box3();
      list.forEach((s, i) => {
        ip.set([s.x, s.y, s.z], i * 3);
        box.expandByPoint(new THREE.Vector3(s.x, s.y, s.z));
        const yaw = Math.atan2(-Math.cos(s.th), -Math.sin(s.th)) + (r() - 0.5) * 0.5;
        id.set([yaw, r(), r(), s.tier], i * 4);
        const sh = col(pickShirt(r()));
        const v = 0.8 + r() * 0.35;
        ish.set([sh.r * v, sh.g * v, sh.b * v], i * 3);
        const sk = col(SKINS[Math.floor(r() * SKINS.length)]);
        ih.set([sk.r, sk.g, sk.b], i * 3);
        const hi = pickHair(r());
        const hc = col(HAIRS[hi][0]);
        const cover = HAIRS[hi][0] === "#000000" ? 0 : hi === 4 || hi === 5 ? 1 : 0.55 + r() * 0.3;
        ihr.set([hc.r, hc.g, hc.b, cover], i * 4);
      });
      const attrs = {
        iPos: new THREE.InstancedBufferAttribute(ip, 3),
        iData: new THREE.InstancedBufferAttribute(id, 4),
        iShirt: new THREE.InstancedBufferAttribute(ish, 3),
        iHead: new THREE.InstancedBufferAttribute(ih, 3),
        iHair: new THREE.InstancedBufferAttribute(ihr, 4),
      };
      box.expandByScalar(3);
      const mk = (fig: THREE.BufferGeometry) => {
        const g = new THREE.InstancedBufferGeometry();
        g.index = fig.index;
        g.setAttribute("position", fig.attributes.position);
        g.setAttribute("normal", fig.attributes.normal);
        g.setAttribute("aPart", fig.attributes.aPart);
        g.setAttribute("aArm", fig.attributes.aArm);
        for (const [k, a] of Object.entries(attrs)) g.setAttribute(k, a);
        g.instanceCount = n;
        g.boundingBox = box.clone();
        g.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
        return g;
      };
      const gNear = mk(figNear);
      const gFar = mk(figFar);
      // LOD is chosen at draw time from the camera that actually renders (deterministic per frame)
      const meshNear = new THREE.Mesh(gNear, m);
      const meshFar = new THREE.Mesh(gFar, m);
      meshNear.onBeforeRender = (_r, _s, cam) => {
        gNear.instanceCount = box.distanceToPoint(cam.position) < CROWD_NEAR_LOD ? n : 0;
      };
      meshFar.onBeforeRender = (_r, _s, cam) => {
        gFar.instanceCount = box.distanceToPoint(cam.position) < CROWD_NEAR_LOD ? 0 : n;
      };
      out.push(meshNear, meshFar);
    });
    return { meshes: out, mat: m };
  }, []);
  mat.uniforms.uTime.value = t;
  mat.uniforms.uEnergy.value = energy;
  mat.uniforms.uFlood.value = flood;
  return (
    <>
      {meshes.map((mesh, i) => (
        <primitive key={i} object={mesh} />
      ))}
    </>
  );
};

/* ================================================================== */
/* Phone flashes                                                       */
/* ================================================================== */

const FLASH_VERT = /* glsl */ `
${COMMON_GLSL}
attribute vec3 aSeed;
uniform float uTime;
uniform float uEnergy;
uniform float uViewH;
uniform float uDark;
varying float vI;
varying float vFogDepth;
void main() {
  float period = 1.4 + aSeed.x * 4.5;
  float ph = fract(uTime / period + aSeed.y);
  float frames = period * ${FPS.toFixed(1)};
  float flash = 1.0 - smoothstep(1.2, 2.2, ph * frames);
  float torch = step(0.86, aSeed.z) * smoothstep(0.35, 0.6, uEnergy) * (0.55 + 0.45 * sin(uTime * 1.3 + aSeed.x * 40.0));
  float act = step(aSeed.z * 0.85 + aSeed.y * 0.15, 0.12 + 0.8 * uEnergy);
  vI = max(flash * act * step(aSeed.z, 0.86), torch * 0.22);
  // before the floods: a sea of phone screens and torches held up in the dark, gently wavering
  float screen = step(aSeed.z, 0.4) * uDark * (0.55 + 0.45 * sin(uTime * (0.6 + aSeed.x * 1.1) + aSeed.y * 37.0));
  vI = max(vI, screen * (0.035 + 0.05 * aSeed.x));
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
  float sz = clamp(260.0 / max(-mv.z, 1.0), 1.6, 3.6) * (uViewH / 1080.0);
  gl_PointSize = vI > 0.001 ? max(sz, 1.0) : 0.0;
}
`;

const FLASH_FRAG = /* glsl */ `
${COMMON_GLSL}
varying float vI;
varying float vFogDepth;
void main() {
  if (vI < 0.001) discard;
  vec2 c = gl_PointCoord - 0.5;
  float a = 1.0 - smoothstep(0.15, 0.5, length(c));
  vec3 col = vec3(1.0, 0.98, 0.95) * vI * 7.0 * a;
  col *= 1.0 - fogAmount(vFogDepth) * 0.8;
  gl_FragColor = vec4(col, 1.0);
  ${TONE}
}
`;

const PhoneFlashes: React.FC<{ t: number; energy: number; dark: number }> = ({ t, energy, dark }) => {
  const viewH = useThree((s) => s.size.height);
  const { geo, mat } = useMemo(() => {
    const seats = getSeats();
    const r = rng(5150);
    const N = 3200;
    const pos = new Float32Array(N * 3);
    const seed = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const s = seats[Math.floor(r() * seats.length)];
      const th = s.th;
      pos.set([s.x - Math.cos(th) * 0.3, s.y + 1.45 + r() * 0.3, s.z - Math.sin(th) * 0.3], i * 3);
      seed.set([r(), r(), r()], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 3));
    g.computeBoundingSphere();
    const m = new THREE.ShaderMaterial({
      vertexShader: FLASH_VERT,
      fragmentShader: FLASH_FRAG,
      fog: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        ...fogUniforms(),
        uTime: { value: 0 },
        uEnergy: { value: 0 },
        uViewH: { value: 1080 },
        uDark: { value: 0 },
      },
    });
    return { geo: g, mat: m };
  }, []);
  mat.uniforms.uTime.value = t;
  mat.uniforms.uEnergy.value = energy;
  mat.uniforms.uViewH.value = viewH;
  mat.uniforms.uDark.value = dark;
  return <points geometry={geo} material={mat} frustumCulled={false} renderOrder={2} />;
};

/* ================================================================== */
/* Floodlight banks: masts, heads, lamps, glows                        */
/* ================================================================== */

const basisOf = (b: (typeof FLOOD_BANKS)[number]) => new THREE.Matrix4().makeBasis(b.right, b.up, b.axis);

const FloodStructures: React.FC = () => {
  const mesh = useMemo(() => {
    const mats: THREE.Matrix4[] = [];
    const box = (center: THREE.Vector3, size: THREE.Vector3, rot: THREE.Matrix4) => {
      const m = new THREE.Matrix4().compose(
        center,
        new THREE.Quaternion().setFromRotationMatrix(rot),
        size,
      );
      mats.push(m);
    };
    const ident = new THREE.Matrix4();
    const bar = (a: THREE.Vector3, b: THREE.Vector3, w: number) => {
      const d = new THREE.Vector3().subVectors(b, a);
      const len = d.length();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
      mats.push(
        new THREE.Matrix4().compose(a.clone().addScaledVector(d, 0.5), q, new THREE.Vector3(w, len, w)),
      );
    };
    FLOOD_BANKS.forEach((b) => {
      const B = basisOf(b);
      // head frame: perimeter beams, row rails behind the lamp housings, rear bracing
      const back = b.pos.clone().addScaledVector(b.axis, -0.95);
      const fw = HEAD_HALF_W * 2 + 0.5;
      const fh = HEAD_HALF_H * 2 + 0.4;
      for (const s of [-1, 1]) {
        box(b.pos.clone().addScaledVector(b.up, s * fh * 0.5).addScaledVector(b.axis, -0.35), new THREE.Vector3(fw + 0.3, 0.22, 0.5), B);
        box(b.pos.clone().addScaledVector(b.right, s * fw * 0.5).addScaledVector(b.axis, -0.35), new THREE.Vector3(0.22, fh, 0.5), B);
      }
      for (let r = 0; r <= LAMP_ROWS; r++) {
        const y = (r / LAMP_ROWS - 0.5) * HEAD_HALF_H * 2 * 0.98;
        box(b.pos.clone().addScaledVector(b.up, y).addScaledVector(b.axis, -0.8), new THREE.Vector3(fw, 0.1, 0.14), B);
      }
      // solid mounting plate behind the lamp housings (from behind or above the bank reads as a
      // closed head, not an open rack; from the front it backs the gaps between the lamps)
      box(b.pos.clone().addScaledVector(b.axis, -0.86), new THREE.Vector3(fw - 0.2, fh - 0.2, 0.08), B);
      // rear X bracing and a service walkway under the head
      const corners = [
        [-1, -1],
        [1, 1],
        [-1, 1],
        [1, -1],
      ].map(([sx, sy]) => back.clone().addScaledVector(b.right, sx * fw * 0.5).addScaledVector(b.up, sy * fh * 0.5));
      bar(corners[0], corners[1], 0.14);
      bar(corners[2], corners[3], 0.14);
      const walk = b.pos.clone().addScaledVector(b.up, -fh * 0.5 - 0.35).addScaledVector(b.axis, -0.1);
      box(walk, new THREE.Vector3(fw, 0.08, 1.6), B);
      for (let i = 0; i <= 8; i++) {
        const x = (i / 8 - 0.5) * fw;
        const post = walk.clone().addScaledVector(b.right, x).addScaledVector(b.axis, 0.75);
        box(post.clone().addScaledVector(b.up, 0.5), new THREE.Vector3(0.05, 1.0, 0.05), B);
      }
      box(walk.clone().addScaledVector(b.axis, 0.75).addScaledVector(b.up, 1.0), new THREE.Vector3(fw, 0.06, 0.06), B);
      // mast: four tapered legs from the roof up to behind the head, with braces
      const out = new THREE.Vector3(Math.cos(b.angle), 0, Math.sin(b.angle));
      const side = new THREE.Vector3(-Math.sin(b.angle), 0, Math.cos(b.angle));
      const baseC = new THREE.Vector3().copy(out).multiplyScalar(STADIUM.floodRadius + 1.2);
      const topC = back.clone().addScaledVector(b.axis, -0.6).addScaledVector(b.up, -1.2);
      const y0 = 47.5;
      const legs: [THREE.Vector3, THREE.Vector3][] = [];
      for (const [sx, so] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        const a = baseC.clone().addScaledVector(side, sx * 2.0).addScaledVector(out, so * 2.0).setY(y0);
        const t = topC.clone().addScaledVector(side, sx * 0.9).addScaledVector(out, so * 0.9);
        legs.push([a, t]);
        bar(a, t, 0.32);
      }
      const levels = 6;
      for (let l = 1; l < levels; l++) {
        const f = l / levels;
        const pts = legs.map(([a, t]) => a.clone().lerp(t, f));
        const pts2 = legs.map(([a, t]) => a.clone().lerp(t, Math.min(1, f + 1 / levels)));
        for (let i = 0; i < 4; i++) {
          bar(pts[i], pts[(i + 1) % 4], 0.14);
          bar(pts[i], pts2[(i + 1) % 4], 0.1);
        }
      }
      box(topC, new THREE.Vector3(2.4, 0.4, 2.4), ident);
    });
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ color: PAL.graphite, metalness: 0.6, roughness: 0.5 });
    const im = new THREE.InstancedMesh(geo, mat, mats.length);
    mats.forEach((m, i) => im.setMatrixAt(i, m));
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    im.frustumCulled = false;
    return im;
  }, []);
  return <primitive object={mesh} />;
};

const LAMP_VERT = /* glsl */ `
${COMMON_GLSL}
attribute float aBank;
attribute float aSeed;
varying float vBank;
varying float vSeed;
varying vec3 vW;
varying vec3 vNw;
varying vec3 vLocal;
varying float vFogDepth;
void main() {
  vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vNw = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  vLocal = position;
  vBank = aBank;
  vSeed = aSeed;
  vec4 mv = viewMatrix * w;
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const LAMP_FRAG = /* glsl */ `
${COMMON_GLSL}
uniform float uFlood[8];
uniform vec3 uFloodCol;
uniform vec3 uWarm;
uniform vec3 uGraphite;
uniform vec3 uSilver;
varying float vBank;
varying float vSeed;
varying vec3 vW;
varying vec3 vNw;
varying vec3 vLocal;
varying float vFogDepth;
void main() {
  int b = int(vBank + 0.5);
  float fl = uFlood[b];
  vec3 N = normalize(vNw);
  vec3 V = normalize(cameraPosition - vW);
  float facing = dot(N, V);
  // front face of the housing (local +z) carries the lens
  float front = step(0.04, vLocal.z);
  vec2 q = vLocal.xy / 0.4;
  float rq = length(q);
  float lens = 1.0 - smoothstep(0.86, 1.0, rq);
  float bezel = smoothstep(0.86, 0.95, rq) * (1.0 - smoothstep(1.02, 1.1, rq));
  float hot = exp(-rq * rq * 2.2);
  vec3 tint = mix(uFloodCol, uWarm, step(0.88, vSeed) * 0.5);
  float vis = smoothstep(-0.05, 0.45, facing);
  float k = fl * (0.88 + 0.24 * vSeed);
  vec3 emi = tint * (lens * 3.2 + hot * 9.0) * k * vis * front;
  // housing: dark painted metal lit by the other banks and the haze (follows the overall flood
  // level), top faces catch a little more, edges catch the sky
  float master = 0.0;
  for (int i = 0; i < 8; i++) master += uFlood[i];
  master *= 0.125;
  float up = max(N.y, 0.0);
  vec3 housing = uSilver * 0.045 * (0.35 + 0.65 * up) * (0.25 + 0.75 * master) + vec3(0.02, 0.025, 0.028) * pow(clamp(1.0 - abs(facing), 0.0, 1.0), 4.0);
  vec3 glassOff = vec3(0.01, 0.012, 0.014) + vec3(0.05) * pow(clamp(1.0 - facing, 0.0, 1.0), 5.0);
  vec3 col = mix(housing, mix(glassOff, uGraphite * 0.3, bezel), front * (lens + bezel)) + emi;
  col *= 1.0 - fogAmount(vFogDepth) * 0.55;
  gl_FragColor = vec4(col, 1.0);
  ${TONE}
}
`;

const GLOW_VERT = /* glsl */ `
${COMMON_GLSL}
attribute vec3 iCenter;
attribute vec3 iAxis;
attribute vec2 iInfo; // bank, size
uniform float uFlood[8];
varying vec2 vUv;
varying float vI;
varying float vFogDepth;
void main() {
  int b = int(iInfo.x + 0.5);
  vec3 toCam = normalize(cameraPosition - iCenter);
  float facing = dot(iAxis, toCam);
  vI = uFlood[b] * smoothstep(0.05, 0.85, facing);
  vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  // pull the sprite toward the camera so the head housing never clips it
  vec3 c = iCenter + toCam * 4.0;
  vec3 wp = c + (camR * position.x + camU * position.y) * iInfo.y;
  vUv = position.xy;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const GLOW_FRAG = /* glsl */ `
${COMMON_GLSL}
uniform vec3 uFloodCol;
uniform float uGain;
varying vec2 vUv;
varying float vI;
varying float vFogDepth;
void main() {
  if (vI < 0.001) discard;
  float r = length(vUv) * 2.0;
  float g = exp(-r * r * 7.0) * 1.2 + exp(-r * 3.2) * 0.25;
  g *= 1.0 - smoothstep(0.75, 1.0, r);
  vec3 col = uFloodCol * g * vI * uGain;
  col *= 1.0 - fogAmount(vFogDepth) * 0.5;
  gl_FragColor = vec4(col, 1.0);
  ${TONE}
}
`;

const FloodLamps: React.FC<{ floods: number[] }> = ({ floods }) => {
  const { lamps, lampMat, glowGeo, glowMat, bigGeo, bigMat } = useMemo(() => {
    const count = FLOOD_BANKS.length * LAMP_COLS * LAMP_ROWS;
    const geo = new THREE.BoxGeometry(0.98, 0.86, 0.8, 1, 1, 1);
    geo.translate(0, 0, -0.35);
    const bank = new Float32Array(count);
    const seed = new Float32Array(count);
    const r = rng(31);
    const mats: THREE.Matrix4[] = [];
    const centers: number[] = [];
    const axes: number[] = [];
    const info: number[] = [];
    let k = 0;
    FLOOD_BANKS.forEach((b, bi) => {
      const B = basisOf(b);
      const q = new THREE.Quaternion().setFromRotationMatrix(B);
      for (let row = 0; row < LAMP_ROWS; row++)
        for (let col = 0; col < LAMP_COLS; col++) {
          const x = ((col + 0.5) / LAMP_COLS - 0.5) * HEAD_HALF_W * 2 * 0.98;
          const y = ((row + 0.5) / LAMP_ROWS - 0.5) * HEAD_HALF_H * 2 * 0.98;
          // each lamp is aimed a touch differently (real banks fan out)
          const aim = new THREE.Quaternion().setFromEuler(new THREE.Euler((r() - 0.5) * 0.08, (r() - 0.5) * 0.08, 0));
          const p = b.pos.clone().addScaledVector(b.right, x).addScaledVector(b.up, y);
          mats.push(new THREE.Matrix4().compose(p, q.clone().multiply(aim), new THREE.Vector3(1, 1, 1)));
          bank[k] = bi;
          seed[k] = r();
          const cp = p.clone().addScaledVector(b.axis, 0.4);
          centers.push(cp.x, cp.y, cp.z);
          axes.push(b.axis.x, b.axis.y, b.axis.z);
          info.push(bi, 2.4);
          k++;
        }
    });
    geo.setAttribute("aBank", new THREE.InstancedBufferAttribute(bank, 1));
    geo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seed, 1));
    const beamU = makeBeamUniforms();
    const lm = new THREE.ShaderMaterial({
      vertexShader: LAMP_VERT,
      fragmentShader: LAMP_FRAG,
      fog: true,
      uniforms: {
        ...fogUniforms(),
        uFlood: beamU.uFlood,
        uFloodCol: { value: vec3Of(PAL.floodWhite) },
        uWarm: { value: vec3Of(PAL.warm) },
        uGraphite: { value: vec3Of(PAL.graphite) },
        uSilver: { value: vec3Of(PAL.silver) },
      },
    });
    const im = new THREE.InstancedMesh(geo, lm, count);
    mats.forEach((m, i) => im.setMatrixAt(i, m));
    im.instanceMatrix.needsUpdate = true;
    im.frustumCulled = false;

    const quad = new THREE.PlaneGeometry(1, 1);
    const mkGlow = (c: number[], a: number[], inf: number[]) => {
      const g = new THREE.InstancedBufferGeometry();
      g.index = quad.index;
      g.setAttribute("position", quad.attributes.position);
      g.setAttribute("iCenter", new THREE.InstancedBufferAttribute(new Float32Array(c), 3));
      g.setAttribute("iAxis", new THREE.InstancedBufferAttribute(new Float32Array(a), 3));
      g.setAttribute("iInfo", new THREE.InstancedBufferAttribute(new Float32Array(inf), 2));
      g.instanceCount = inf.length / 2;
      return g;
    };
    const mkGlowMat = (gain: number) =>
      new THREE.ShaderMaterial({
        vertexShader: GLOW_VERT,
        fragmentShader: GLOW_FRAG,
        fog: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          ...fogUniforms(),
          uFlood: beamU.uFlood,
          uFloodCol: { value: vec3Of(PAL.floodWhite) },
          uGain: { value: gain },
        },
      });
    const bc: number[] = [];
    const ba: number[] = [];
    const bi: number[] = [];
    FLOOD_BANKS.forEach((b, i) => {
      const c = b.pos.clone().addScaledVector(b.axis, 0.6);
      bc.push(c.x, c.y, c.z);
      ba.push(b.axis.x, b.axis.y, b.axis.z);
      bi.push(i, 40);
    });
    return {
      lamps: im,
      lampMat: lm,
      glowGeo: mkGlow(centers, axes, info),
      glowMat: mkGlowMat(0.45),
      bigGeo: mkGlow(bc, ba, bi),
      bigMat: mkGlowMat(0.3),
    };
  }, []);
  setFloodUniform(lampMat.uniforms.uFlood, floods);
  return (
    <>
      <primitive object={lamps} />
      <mesh geometry={glowGeo} material={glowMat} frustumCulled={false} renderOrder={5} />
      <mesh geometry={bigGeo} material={bigMat} frustumCulled={false} renderOrder={5} />
    </>
  );
};

/* ================================================================== */
/* Volumetric beams                                                    */
/* ================================================================== */

const BEAM_Z_MAX = 250;

const buildBeamHull = () => {
  const seg = 40;
  const pad = BEAM_EDGE * 1.03;
  // several rings along the length so the vertex shader can pull the hull in front of the stands
  const rings = [BEAM_Z_HEAD - 0.4, 28, 38, 52, 70, 95, 130, 175, BEAM_Z_MAX];
  const geos: THREE.BufferGeometry[] = [];
  FLOOD_BANKS.forEach((b, bi) => {
    const pos: number[] = [];
    const idx: number[] = [];
    for (const z of rings)
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        pos.push(Math.cos(a) * BEAM_TAN_X * z * pad, Math.sin(a) * BEAM_TAN_Y * z * pad, z);
      }
    for (let r = 0; r < rings.length - 1; r++)
      for (let i = 0; i < seg; i++) {
        const a = r * (seg + 1) + i;
        const c = a + seg + 1;
        idx.push(a, a + 1, c, a + 1, c + 1, c);
      }
    // caps (near and far)
    const last = (rings.length - 1) * (seg + 1);
    const nc = pos.length / 3;
    pos.push(0, 0, rings[0]);
    const fc = pos.length / 3;
    pos.push(0, 0, rings[rings.length - 1]);
    for (let i = 0; i < seg; i++) {
      idx.push(nc, i + 1, i);
      idx.push(fc, last + i, last + i + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    const M = basisOf(b).setPosition(b.apex);
    g.applyMatrix4(M);
    g.setAttribute("aBank", new THREE.Float32BufferAttribute(new Array(pos.length / 3).fill(bi), 1));
    geos.push(g.toNonIndexed());
  });
  const g = mergeGeometries(geos, false);
  if (!g) throw new Error("beam merge failed");
  g.computeBoundingSphere();
  return g;
};

/**
 * Analytic stand-in for the opaque bowl, used by the beams instead of a depth texture: the ground,
 * the raked stands (a cone through the front of tier 1 and the back of tier 3) and the roof slab.
 * Returns the distance along the ray to the first hit (1e6 when it reaches the sky).
 */
const OCCLUDER_GLSL = /* glsl */ `
float bowlHit(vec3 ro, vec3 rd, bool ground) {
  float tHit = 1e6;
  // ground
  if (ground && rd.y < -1e-5) tHit = -ro.y / rd.y;
  // stands: r = A + K y for y in [1.6, 43]
  const float K = ${(49 / 41.4).toFixed(5)};
  const float A = ${(73 - 1.6 * (49 / 41.4)).toFixed(4)};
  float ca = rd.x * rd.x + rd.z * rd.z - K * K * rd.y * rd.y;
  float base = A + K * ro.y;
  float cb = 2.0 * (ro.x * rd.x + ro.z * rd.z - K * rd.y * base);
  float cc = ro.x * ro.x + ro.z * ro.z - base * base;
  float disc = cb * cb - 4.0 * ca * cc;
  if (abs(ca) > 1e-6 && disc > 0.0) {
    float sq = sqrt(disc);
    float r1 = (-cb - sq) / (2.0 * ca);
    float r2 = (-cb + sq) / (2.0 * ca);
    float lo = min(r1, r2), hi = max(r1, r2);
    float y1 = ro.y + rd.y * lo;
    float y2 = ro.y + rd.y * hi;
    if (lo > 0.0 && y1 > 1.6 && y1 < 43.0) tHit = min(tHit, lo);
    else if (hi > 0.0 && y2 > 1.6 && y2 < 43.0) tHit = min(tHit, hi);
  }
  // roof slab (underside from below, top from above)
  float yr = rd.y > 0.0 ? 46.3 : 51.0;
  if (abs(rd.y) > 1e-5) {
    float tr = (yr - ro.y) / rd.y;
    vec2 pr = ro.xz + rd.xz * tr;
    float rr = length(pr);
    if (tr > 0.0 && rr > 96.5 && rr < 127.5) tHit = min(tHit, tr);
  }
  return tHit;
}
`;

const BEAM_VERT = /* glsl */ `
${OCCLUDER_GLSL}
attribute float aBank;
varying vec3 vW;
varying float vBank;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  // Pull hull vertices that sit behind the stands/roof/ground to just in front of them, along the
  // view ray: the hull covers the same pixels, but the stadium no longer depth-rejects the haze in
  // front of it (the fragment shader ends the march at the same analytic surface).
  vec3 d = w.xyz - cameraPosition;
  float L = length(d);
  vec3 rd = d / max(L, 1e-4);
  // (not against the ground: the haze near the grass is faint anyway, and leaving the buried
  // part of the hull to the depth test keeps it cheap)
  float tOcc = bowlHit(cameraPosition, rd, false);
  if (L > tOcc * 0.85) w.xyz = cameraPosition + rd * max(tOcc * 0.85, 0.5);
  vW = w.xyz;
  vBank = aBank;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const BEAM_FRAG = /* glsl */ `
${COMMON_GLSL}
${BEAM_GLSL}
${OCCLUDER_GLSL}
uniform sampler3D uNoise;
uniform sampler2D uNoise2;
uniform float uTime;
uniform float uGain;
uniform vec3 uFloodCol;
varying vec3 vW;
varying float vBank;
const float ZMAX = ${BEAM_Z_MAX.toFixed(1)};
void main() {
  int i = int(vBank + 0.5);
  float fl = uFlood[i];
  if (fl < 0.002) discard;
  vec3 R = uBeamR[i], U = uBeamU[i], A = uBeamA[i];
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vW - ro);
  vec3 o0 = ro - uBeamApex[i];
  vec3 o = vec3(dot(o0, R), dot(o0, U), dot(o0, A));
  vec3 d = vec3(dot(rd, R), dot(rd, U), dot(rd, A));
  // cone normalised to the beam edge (density is zero beyond BEAM_EDGE)
  vec3 on = vec3(o.x / (BEAM_TX * BEAM_EDGE), o.y / (BEAM_TY * BEAM_EDGE), o.z);
  vec3 dn = vec3(d.x / (BEAM_TX * BEAM_EDGE), d.y / (BEAM_TY * BEAM_EDGE), d.z);
  bool camInside = (on.x * on.x + on.y * on.y < on.z * on.z * 1.06) && on.z > BEAM_ZH - 0.4 && on.z < ZMAX;
  if (gl_FrontFacing == camInside) discard;
  float a = dn.x * dn.x + dn.y * dn.y - dn.z * dn.z;
  float b = 2.0 * (on.x * dn.x + on.y * dn.y - on.z * dn.z);
  float c = on.x * on.x + on.y * on.y - on.z * on.z;
  float t0 = -1e6, t1 = 1e6;
  if (abs(a) < 1e-7) {
    if (abs(b) < 1e-7) discard;
    float tr = -c / b;
    if (b > 0.0) t1 = tr; else t0 = tr;
  } else {
    float disc = b * b - 4.0 * a * c;
    if (disc < 0.0) {
      if (a > 0.0) discard;
    } else {
      float sq = sqrt(disc);
      float r1 = (-b - sq) / (2.0 * a);
      float r2 = (-b + sq) / (2.0 * a);
      float lo = min(r1, r2), hi = max(r1, r2);
      if (a > 0.0) { t0 = lo; t1 = hi; }
      else if (dn.z > 0.0) { t0 = hi; }
      else { t1 = lo; }
    }
  }
  // positive nappe and length range
  if (abs(dn.z) > 1e-6) {
    float ta = (BEAM_ZH - on.z) / dn.z;
    float tb = (ZMAX - on.z) / dn.z;
    t0 = max(t0, min(ta, tb));
    t1 = min(t1, max(ta, tb));
  } else if (on.z < BEAM_ZH || on.z > ZMAX) discard;
  // stop at the ground, the stands and the roof (depth softness without a depth texture)
  t1 = min(t1, bowlHit(ro, rd, true));
  t0 = max(t0, 0.0);
  if (t1 <= t0) discard;
  // March: 4 samples, importance-sampled uniformly in 1/z (z = distance from the apex along the
  // axis) so the bright stretch near the lamp gets its share, dithered with interleaved gradient
  // noise. One 2D noise fetch per sample (the lamp shafts) plus one 3D fetch per fragment (haze
  // patches).
  const int NS = 4;
  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float z0 = max(o.z + d.z * t0, 1.0);
  float z1 = max(o.z + d.z * t1, 1.0);
  bool imp = abs(z1 - z0) > 6.0 && abs(d.z) > 0.02;
  float u0 = 1.0 / z0, u1 = 1.0 / z1;
  float tB = mix(z0 < z1 ? t0 : t1, 0.5 * (t0 + t1), 0.35);
  float haze = texture(uNoise, (ro + rd * tB) * 0.0095 + vec3(uTime * 0.012, -uTime * 0.003, uTime * 0.008)).r;
  float hz = mix(0.4, 1.55, smoothstep(0.12, 0.88, haze));
  float sum = 0.0;
  for (int k = 0; k < NS; k++) {
    float sk = (float(k) + jit) / float(NS);
    float t, w;
    if (imp) {
      float z = 1.0 / mix(u0, u1, sk);
      t = (z - o.z) / d.z;
      w = z * z * abs(u1 - u0) / (abs(d.z) * float(NS));
    } else {
      t = mix(t0, t1, sk);
      w = (t1 - t0) / float(NS);
    }
    vec3 q = o + d * t;
    vec3 pw = ro + rd * t;
    float dens = beamLocalDensity(q);
    // shafts from the individual lamps: angular noise, slowly drifting along the beam
    vec2 e = q.xy / (vec2(BEAM_TX, BEAM_TY) * q.z);
    float streak = texture(uNoise2, vec2(e.x * 1.3 + float(i) * 0.37, e.y * 0.95 + float(i) * 0.11 + q.z * 0.001 - uTime * 0.004)).r;
    streak = smoothstep(0.22, 0.82, streak);
    // forward scattering: bright looking toward the lamp, faint looking away from it
    float ph = hazePhase(dot(q, -d) / max(length(q), 1e-3));
    // soft near the camera (depth softness) and near the ground
    sum += dens * mix(0.1, 1.6, streak) * ph * smoothstep(0.0, 9.0, pw.y) * smoothstep(1.5, 18.0, t) * w;
  }
  sum *= hz;
  float x = sum * fl * uGain;
  vec3 col = uFloodCol * 0.55 * (1.0 - exp(-x / 0.55));
  // haze attenuation with distance (but the beam IS haze, so keep most of it)
  float mid = mix(t0, t1, 0.5);
  col *= 1.0 - fogAmount(mid) * 0.6;
  gl_FragColor = vec4(col, 1.0);
  ${TONE}
}
`;

const Beams: React.FC<{ t: number; floods: number[]; gain: number }> = ({ t, floods, gain }) => {
  const { geo, mat } = useMemo(() => {
    const m = new THREE.ShaderMaterial({
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      fog: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        ...fogUniforms(),
        ...makeBeamUniforms(),
        uNoise: { value: getNoise3D() },
        uNoise2: { value: getNoise2D() },
        uTime: { value: 0 },
        uGain: { value: 1 },
        uFloodCol: { value: vec3Of(PAL.floodWhite) },
      },
    });
    return { geo: buildBeamHull(), mat: m };
  }, []);
  setFloodUniform(mat.uniforms.uFlood, floods);
  mat.uniforms.uTime.value = t;
  mat.uniforms.uGain.value = 0.016 * gain;
  return <mesh geometry={geo} material={mat} frustumCulled={false} renderOrder={4} />;
};

/* ================================================================== */
/* LED boundary boards                                                 */
/* ================================================================== */

const LED_H = 0.9;
const LED_TILT = 0.16;

const LED_VERT = /* glsl */ `
varying vec3 vW;
varying float vFogDepth;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vec4 mv = viewMatrix * w;
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

/** LED ring layout: every period divides the circumference exactly, so the ring has no seam. */
const LED_C = Math.PI * 2 * FIELD.ledRadius;
const LED_PANELS = Math.round(LED_C / 9.6);
const LED_PANEL = LED_C / LED_PANELS;
const LED_GLSL = /* glsl */ `
const float LED_PANEL = ${LED_PANEL.toFixed(5)};
const float LED_PITCH = ${(LED_PANEL / 12).toFixed(5)};
const float K_SWELL = ${((Math.PI * 2 * 3) / LED_C).toFixed(6)};
const float K_PULSE = ${((Math.PI * 2 * 6) / LED_C).toFixed(6)};
// travelling pulse envelope along the ring (0..1), shared by the boards and their spill
float ledPulse(float s, float t) { return pow(max(0.5 + 0.5 * sin(s * K_PULSE - t * 1.7), 0.0), 6.0); }
`;

const LED_FRAG = /* glsl */ `
${COMMON_GLSL}
${FRAG_GLSL}
${LED_GLSL}
uniform float uTime;
uniform float uLed;
uniform float uSweep;
uniform vec3 uTeal;
uniform vec3 uTealDeep;
uniform vec3 uTealHi;
uniform vec3 uGraphite;
uniform vec3 uWhite;
varying vec3 vW;
varying float vFogDepth;
void main() {
  float th = atan(vW.z, vW.x);
  float s = th * ${FIELD.ledRadius.toFixed(2)};
  float h = clamp((vW.y - 0.06) / ${LED_H.toFixed(2)}, 0.0, 1.0);
  float fw = fwArcW(vW);
  float t = uTime;
  // base: deep graphite at the foot to deep teal at the top, with a slow travelling swell
  float swell = 0.5 + 0.5 * sin(s * K_SWELL - t * 0.5);
  vec3 col = mix(uGraphite * 0.3, uTealDeep * 0.34, smoothstep(0.05, 1.0, h) * (0.45 + 0.55 * swell));
  // content cycle (10 s): chevron groups, then the wordmark, each panel switching content with a
  // spatial wipe across it (staggered per panel on the way in), never a crossfade
  float pid = floor(s / LED_PANEL);
  float cyc = mod(t, 10.0);
  float st = fract(pid * 0.618) * 0.6;
  float xn = fract(s / LED_PANEL);
  float fwx = fw / LED_PANEL;
  float wIn = clamp((cyc - 6.4 - st) / 0.45, 0.0, 1.0) * 1.04 - 0.02;
  float wOut = clamp((cyc - 9.4) / 0.45, 0.0, 1.0) * 1.04 - 0.02;
  float wordOn = smoothstep(xn - fwx, xn + fwx, wIn) * (1.0 - smoothstep(xn - fwx, xn + fwx, wOut));
  float eIn = (xn - wIn) * LED_PANEL / 0.12;
  float eOut = (xn - wOut) * LED_PANEL / 0.12;
  float wipeEdge = exp(-eIn * eIn) * step(0.0, wIn) * step(wIn, 1.0) + exp(-eOut * eOut) * step(0.0, wOut) * step(wOut, 1.0);
  // outlined chevrons in groups of three, scrolling along the ring; dim at rest, lit by the
  // travelling pulses (restraint: an accent, never a neon wall)
  float sc = s - t * 2.4;
  float u = sc / LED_PITCH + abs(h - 0.5) * 1.15;
  float fu = fw / LED_PITCH + fwidth(h) * 1.15;
  float stroke = 1.0 - smoothstep(0.045, 0.045 + fu * 1.2, abs(fract(u) - 0.5));
  // the group is chosen per chevron (by its index along u), so chevrons are never cut
  float grp = step(mod(floor(u), 6.0), 2.5);
  float band = smoothstep(0.2, 0.23, h) * (1.0 - smoothstep(0.77, 0.8, h));
  float env = ledPulse(s, t);
  col += uTeal * 0.9 * stroke * grp * band * (0.1 + 0.9 * env) * (1.0 - wordOn);
  // thin accent lines along the top and the foot
  float lines = (1.0 - smoothstep(0.012, 0.012 + fwidth(h) * 1.2, abs(h - 0.9))) + (1.0 - smoothstep(0.008, 0.008 + fwidth(h) * 1.2, abs(h - 0.1)));
  col += uTeal * 0.4 * lines;
  // wordmark, once per panel, with a teal underline
  vec2 wp = vec2(fract(s / LED_PANEL) * LED_PANEL - (LED_PANEL - 2.6) * 0.5, (h - 0.2) * ${LED_H.toFixed(2)}) / 0.52;
  float d = mplSDF(wp);
  float aa = fw / 0.52 * 0.8 + fwidth(h) + 0.01;
  float word = 1.0 - smoothstep(-aa, aa, d);
  float under = step(-0.3, wp.y) * step(wp.y, -0.2) * step(-0.15, wp.x) * step(wp.x, 3.05);
  col = mix(col, uWhite * 1.15, word * wordOn);
  col = mix(col, uTeal * 1.0, under * wordOn);
  col += uTeal * 0.45 * wipeEdge * smoothstep(0.12, 0.2, h) * (1.0 - smoothstep(0.8, 0.88, h));
  // LED pixel pitch (fades out with distance) and module seams every half panel
  vec2 px = vec2(s, vW.y) / 0.02;
  float grid = smoothstep(0.5, 0.2, length(fract(px) - 0.5));
  float gfade = 1.0 - smoothstep(0.15, 0.6, fw / 0.02);
  col *= mix(1.0, 0.55 + 0.6 * grid, gfade);
  float mHalf = fract(s / (LED_PANEL * 0.5));
  col *= 1.0 - 0.8 * (1.0 - smoothstep(0.0015, 0.0015 + fw / (LED_PANEL * 0.5), min(mHalf, 1.0 - mHalf)));
  // dark frame top/bottom
  col *= smoothstep(0.0, 0.04, h) * (1.0 - smoothstep(0.96, 1.0, h));
  // power + sweep from the +Z end (both directions), with a bright leading edge
  float p = abs(angDiff(th, 1.5707963)) / 3.1415927;
  float on = smoothstep(p - 0.004, p + 0.004, uSweep);
  float ed = (uSweep - p) * 45.0;
  float edge = exp(-ed * ed) * step(0.001, uSweep) * (1.0 - step(0.999, uSweep));
  vec3 lit = col * on * uLed + uTealHi * edge * 1.6 * uLed * band;
  vec3 off = vec3(0.006, 0.007, 0.008);
  vec3 outc = off + lit;
  outc *= 1.0 - fogAmount(vFogDepth) * 0.7;
  gl_FragColor = vec4(outc, 1.0);
  ${TONE}
}
`;

/** Teal light from the boards spilling onto the grass in front of them (additive decal). */
const SPILL_FRAG = /* glsl */ `
${COMMON_GLSL}
${FRAG_GLSL}
${LED_GLSL}
uniform float uTime;
uniform float uLed;
uniform float uSweep;
uniform vec3 uTeal;
uniform vec3 uTealHi;
varying vec3 vW;
varying float vFogDepth;
void main() {
  float th = atan(vW.z, vW.x);
  float r = length(vW.xz) / ovalScale(0.0);
  float s = th * ${FIELD.ledRadius.toFixed(2)};
  float fall = exp(-max(${FIELD.ledRadius.toFixed(2)} - r, 0.0) / 0.75) * (1.0 - smoothstep(${(FIELD.ledRadius - 0.05).toFixed(2)}, ${FIELD.ledRadius.toFixed(2)}, r));
  float env = ledPulse(s, uTime);
  float p = abs(angDiff(th, 1.5707963)) / 3.1415927;
  float on = smoothstep(p - 0.004, p + 0.004, uSweep);
  float ed = (uSweep - p) * 45.0;
  float edge = exp(-ed * ed) * step(0.001, uSweep) * (1.0 - step(0.999, uSweep));
  vec3 col = (uTeal * (0.045 + 0.04 * env) * on + uTealHi * 0.35 * edge) * fall * uLed;
  col *= 1.0 - fogAmount(vFogDepth) * 0.7;
  gl_FragColor = vec4(col, 1.0);
  ${TONE}
}
`;

const LedBoards: React.FC<{ t: number; led: number; sweep: number }> = ({ t, led, sweep }) => {
  const { face, frame, mat, frameMat, spillGeo, spillMat } = useMemo(() => {
    const r0 = FIELD.ledRadius;
    const r1 = r0 + LED_H * LED_TILT;
    const face = new THREE.CylinderGeometry(r1, r0, LED_H, 720, 1, true);
    face.translate(0, 0.06 + LED_H / 2, 0);
    const back = new THREE.CylinderGeometry(r1 + 0.25, r0 + 0.25, LED_H + 0.1, 360, 1, true);
    back.translate(0, 0.06 + LED_H / 2, 0);
    const top = new THREE.RingGeometry(r1 - 0.02, r1 + 0.27, 360, 1);
    top.rotateX(-Math.PI / 2);
    top.translate(0, 0.06 + LED_H + 0.03, 0);
    const frame = mergeGeometries([back.toNonIndexed(), top.toNonIndexed()], false);
    const m = new THREE.ShaderMaterial({
      vertexShader: LED_VERT,
      fragmentShader: LED_FRAG,
      fog: true,
      side: THREE.BackSide,
      uniforms: {
        ...fogUniforms(),
        uTime: { value: 0 },
        uLed: { value: 0 },
        uSweep: { value: 0 },
        uTeal: { value: vec3Of(PAL.teal) },
        uTealDeep: { value: vec3Of(PAL.tealDeep) },
        uTealHi: { value: vec3Of(PAL.tealHi) },
        uGraphite: { value: vec3Of(PAL.graphite) },
        uWhite: { value: vec3Of(PAL.white) },
      },
    });
    const fm = new THREE.MeshStandardMaterial({ color: PAL.graphiteDark, roughness: 0.7, metalness: 0.2, side: THREE.DoubleSide });
    const spillGeo = new THREE.RingGeometry(r0 - 4.5, r0 - 0.02, 720, 1);
    spillGeo.rotateX(-Math.PI / 2);
    spillGeo.translate(0, 0.03, 0);
    const sm = new THREE.ShaderMaterial({
      vertexShader: LED_VERT,
      fragmentShader: SPILL_FRAG,
      fog: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        ...fogUniforms(),
        uTime: m.uniforms.uTime,
        uLed: m.uniforms.uLed,
        uSweep: m.uniforms.uSweep,
        uTeal: m.uniforms.uTeal,
        uTealHi: m.uniforms.uTealHi,
      },
    });
    return { face, frame, mat: m, frameMat: fm, spillGeo, spillMat: sm };
  }, []);
  mat.uniforms.uTime.value = t;
  mat.uniforms.uLed.value = led;
  mat.uniforms.uSweep.value = sweep;
  return (
    <>
      <mesh geometry={face} material={mat} frustumCulled={false} />
      {frame ? <mesh geometry={frame} material={frameMat} frustumCulled={false} /> : null}
      <mesh geometry={spillGeo} material={spillMat} frustumCulled={false} renderOrder={1} />
    </>
  );
};

/* ================================================================== */
/* Big screen, sight-screens, gantries, camera towers                  */
/* ================================================================== */

const SCREEN_FRAG = /* glsl */ `
${COMMON_GLSL}
uniform float uTime;
uniform float uLed;
uniform vec3 uTeal;
uniform vec3 uTealDeep;
uniform vec3 uWhite;
uniform vec3 uGraphite;
varying vec2 vUv;
varying float vFogDepth;
void main() {
  vec2 p = (vUv - 0.5) * vec2(${SCREEN.w.toFixed(1)}, ${SCREEN.h.toFixed(1)});
  float r = length(p * vec2(0.6, 1.0));
  vec3 bg = mix(uTealDeep * 0.5, uGraphite * 0.22, smoothstep(0.0, 11.0, r));
  // soft light sweep
  float swd = (p.x + p.y * 0.4) - (mod(uTime * 6.0, 60.0) - 30.0);
  float sw = exp(-swd * swd * 0.02);
  bg += uTeal * sw * 0.25;
  vec2 wp = (p + vec2(3.1 * 1.6, 1.6) * 0.5 * vec2(1.0, 1.0)) / 3.2;
  wp = p / 3.2 + vec2(1.52, 0.5);
  float d = mplSDF(wp);
  float aa = fwidth(d) + 0.01;
  float word = 1.0 - smoothstep(-aa, aa, d);
  float glow = exp(-max(d, 0.0) * 6.0) * 0.35;
  vec3 col = bg + uTeal * glow + uWhite * word * 1.3;
  float bezel = step(0.012, vUv.x) * step(vUv.x, 0.988) * step(0.025, vUv.y) * step(vUv.y, 0.975);
  col = mix(vec3(0.01), col * uLed, bezel);
  col *= 1.0 - fogAmount(vFogDepth) * 0.7;
  gl_FragColor = vec4(col, 1.0);
  ${TONE}
}
`;

const SCREEN_VERT = /* glsl */ `
varying vec2 vUv;
varying float vFogDepth;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

/** Sight-screen face: matte graphite fabric panels in a frame, a thin teal strip along the top. */
const SIGHT_FRAG = /* glsl */ `
${COMMON_GLSL}
uniform float uFlood;
uniform float uLed;
uniform vec3 uGraphite;
uniform vec3 uTeal;
uniform vec3 uSilver;
varying vec2 vUv;
varying float vFogDepth;
void main() {
  vec2 p = vUv * vec2(${SIGHTSCREEN.w.toFixed(1)}, ${SIGHTSCREEN.h.toFixed(1)});
  float fx = fract(p.x / 2.2);
  float fwx = fwidth(p.x / 2.2);
  float seam = 1.0 - smoothstep(0.0, 0.012 + fwx, min(fx, 1.0 - fx));
  float sag = 0.04 * sin(fx * 3.14159) * (0.6 + 0.4 * sin(p.y * 0.9 + floor(p.x / 2.2) * 2.1));
  vec3 alb = uGraphite * (0.42 + sag);
  alb = mix(alb, uGraphite * 0.2, seam);
  // frame
  float fr = step(p.x, 0.18) + step(${(SIGHTSCREEN.w - 0.18).toFixed(2)}, p.x) + step(p.y, 0.18) + step(${(SIGHTSCREEN.h - 0.3).toFixed(2)}, p.y);
  alb = mix(alb, uSilver * 0.18, clamp(fr, 0.0, 1.0));
  vec3 col = alb * (0.02 + uFlood * 0.3);
  float strip = smoothstep(${(SIGHTSCREEN.h - 0.42).toFixed(2)}, ${(SIGHTSCREEN.h - 0.39).toFixed(2)}, p.y) * (1.0 - smoothstep(${(SIGHTSCREEN.h - 0.34).toFixed(2)}, ${(SIGHTSCREEN.h - 0.31).toFixed(2)}, p.y));
  col += uTeal * 0.55 * strip * uLed;
  col = applyFog(col, vFogDepth);
  gl_FragColor = vec4(col, 1.0);
  ${TONE}
}
`;

const Structures: React.FC<{ t: number; led: number; flood: number }> = ({ t, led, flood }) => {
  const { screenMat, screenPose, boxes, lights, sightMat } = useMemo(() => {
    const sm = new THREE.ShaderMaterial({
      vertexShader: SCREEN_VERT,
      fragmentShader: SCREEN_FRAG,
      fog: true,
      uniforms: {
        ...fogUniforms(),
        uTime: { value: 0 },
        uLed: { value: 0 },
        uTeal: { value: vec3Of(PAL.teal) },
        uTealDeep: { value: vec3Of(PAL.tealDeep) },
        uWhite: { value: vec3Of(PAL.white) },
        uGraphite: { value: vec3Of(PAL.graphite) },
      },
    });
    const a = SCREEN.angle;
    const sc = ovalScale(a);
    const pos = new THREE.Vector3(Math.cos(a) * SCREEN.r * sc, SCREEN.y, Math.sin(a) * SCREEN.r * sc);
    const rotY = Math.atan2(-Math.cos(a), -Math.sin(a));
    const screenPose = { pos, rotY };

    // dark structural boxes: screen housing, sight-screens, gantries, camera towers
    const mats: THREE.Matrix4[] = [];
    const add = (p: THREE.Vector3, s: THREE.Vector3, ry = 0) =>
      mats.push(new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0)), s));
    const back = pos.clone().add(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(0.9));
    mats.push(
      new THREE.Matrix4().compose(
        back,
        new THREE.Quaternion().setFromEuler(new THREE.Euler(SCREEN_TILT, rotY, 0, "YXZ")),
        new THREE.Vector3(SCREEN.w + 1.2, SCREEN.h + 1.2, 1.6),
      ),
    );
    // hangers up to the roof
    for (const s of [-1, 1]) {
      const lp = back.clone().add(new THREE.Vector3(-Math.sin(a), 0, Math.cos(a)).multiplyScalar(s * SCREEN.w * 0.35));
      lp.y = SCREEN.y + SCREEN.h / 2 + 0.9;
      add(lp, new THREE.Vector3(0.35, 1.8, 0.35), rotY);
    }
    const lightPts: number[] = [];
    // TV gantries hanging under the roof at both ends
    for (const end of [1, -1]) {
      const z = end * 99.5;
      add(new THREE.Vector3(0, 45.0, z), new THREE.Vector3(34, 2.2, 2.6));
      add(new THREE.Vector3(0, 46.5, z), new THREE.Vector3(34.5, 0.2, 3.0));
      for (let i = 0; i < 9; i++) {
        const x = (i - 4) * 3.8;
        add(new THREE.Vector3(x, 46.7, z), new THREE.Vector3(0.15, 1.2, 0.15));
        add(new THREE.Vector3(x, 44.5, z - end * 1.6), new THREE.Vector3(0.7, 0.6, 1.1));
        lightPts.push(x, 43.85, z - end * 1.35);
      }
    }
    // sight-screens (matte black) at both ends
    for (const end of [1, -1]) {
      add(new THREE.Vector3(0, SIGHTSCREEN.h / 2, end * SIGHTSCREEN.z), new THREE.Vector3(SIGHTSCREEN.w, SIGHTSCREEN.h, 0.35));
      add(new THREE.Vector3(0, SIGHTSCREEN.h + 0.1, end * SIGHTSCREEN.z), new THREE.Vector3(SIGHTSCREEN.w + 0.3, 0.2, 0.5));
    }
    // camera towers on the apron flanking the bowler's end
    for (const deg of [62, 118]) {
      const ang = THREE.MathUtils.degToRad(deg);
      const c = new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang)).multiplyScalar(FIELD.ledRadius + 1.7);
      const ry = Math.atan2(-Math.cos(ang), -Math.sin(ang));
      const H = 8.5;
      for (const [sx, sz] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        const off = new THREE.Vector3(sx * 0.75, H / 2, sz * 0.75).applyEuler(new THREE.Euler(0, ry, 0));
        add(c.clone().add(off), new THREE.Vector3(0.1, H, 0.1), ry);
      }
      for (let l = 1; l <= 4; l++) add(c.clone().setY((l * H) / 4), new THREE.Vector3(1.6, 0.08, 1.6), ry);
      add(c.clone().setY(H + 0.1), new THREE.Vector3(2.0, 0.15, 2.0), ry);
      const cam = new THREE.Vector3(0, H + 0.75, 0.2).applyEuler(new THREE.Euler(0, ry, 0));
      add(c.clone().add(cam), new THREE.Vector3(0.45, 0.5, 0.9), ry);
      const lens = new THREE.Vector3(0, H + 0.75, 0.85).applyEuler(new THREE.Euler(0, ry, 0));
      add(c.clone().add(lens), new THREE.Vector3(0.22, 0.22, 0.5), ry);
    }
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ color: "#0d1012", roughness: 0.8, metalness: 0.3 });
    const im = new THREE.InstancedMesh(geo, mat, mats.length);
    mats.forEach((m, i) => im.setMatrixAt(i, m));
    im.instanceMatrix.needsUpdate = true;
    im.frustumCulled = false;
    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.Float32BufferAttribute(lightPts, 3));
    const sightMat = new THREE.ShaderMaterial({
      vertexShader: SCREEN_VERT,
      fragmentShader: SIGHT_FRAG,
      fog: true,
      uniforms: {
        ...fogUniforms(),
        uFlood: { value: 0 },
        uLed: { value: 0 },
        uGraphite: { value: vec3Of(PAL.graphite) },
        uTeal: { value: vec3Of(PAL.teal) },
        uSilver: { value: vec3Of(PAL.silver) },
      },
    });
    return { screenMat: sm, screenPose, boxes: im, lights: lg, sightMat };
  }, []);
  screenMat.uniforms.uTime.value = t;
  screenMat.uniforms.uLed.value = led;
  sightMat.uniforms.uFlood.value = flood;
  sightMat.uniforms.uLed.value = led;
  return (
    <>
      <mesh
        position={screenPose.pos}
        rotation={new THREE.Euler(SCREEN_TILT, screenPose.rotY, 0, "YXZ")}
        material={screenMat}
        frustumCulled={false}
      >
        <planeGeometry args={[SCREEN.w, SCREEN.h]} />
      </mesh>
      <primitive object={boxes} />
      {[1, -1].map((end) => (
        <mesh
          key={end}
          position={[0, SIGHTSCREEN.h / 2, end * (SIGHTSCREEN.z - 0.18)]}
          rotation={[0, end > 0 ? Math.PI : 0, 0]}
          material={sightMat}
        >
          <planeGeometry args={[SIGHTSCREEN.w, SIGHTSCREEN.h]} />
        </mesh>
      ))}
      <points geometry={lights} frustumCulled={false}>
        <pointsMaterial color={new THREE.Color(PAL.warm).multiplyScalar(4)} size={2.5} sizeAttenuation={false} toneMapped />
      </points>
    </>
  );
};

/* ================================================================== */
/* Exterior: dark ground and distant city lights                       */
/* ================================================================== */

const CITY_VERT = /* glsl */ `
${COMMON_GLSL}
attribute vec3 aCol;
uniform float uViewH;
varying vec3 vCol;
varying float vFogDepth;
void main() {
  vCol = aCol;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(900.0 / max(-mv.z, 1.0), 1.0, 2.6) * (uViewH / 1080.0);
}
`;

const CITY_FRAG = /* glsl */ `
${COMMON_GLSL}
varying vec3 vCol;
varying float vFogDepth;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a = 1.0 - smoothstep(0.2, 0.5, length(c));
  vec3 col = vCol * a * (1.0 - fogAmount(vFogDepth) * 0.85);
  gl_FragColor = vec4(col, 1.0);
  ${TONE}
}
`;

/** Precinct layout around the bowl (metres / radians): ring road, plaza, avenues, car parks. */
const PRECINCT = {
  ringRoad: 172,
  plazaIn: FACADE.foot + 1,
  plazaOut: 150,
  avenues: [0.35, 1.4, 2.45, 3.5, 4.55, 5.6],
  avenueFrom: 176,
  avenueTo: 1100,
  // car parks: centre x, z, half-width, half-depth, rotation
  parks: [
    [205, 120, 34, 22, 0.52],
    [-150, -190, 40, 24, -0.9],
    [-215, 60, 26, 36, 0.2],
  ] as [number, number, number, number, number][],
};

const GROUND_FRAG = /* glsl */ `
${COMMON_GLSL}
uniform vec3 uWarm;
uniform vec3 uCool;
uniform float uAv[6];
uniform vec4 uPark[3];
uniform float uParkRot[3];
varying vec3 vW;
varying float vFogDepth;
void main() {
  float r = length(vW.xz);
  float th = atan(vW.z, vW.x);
  float ro = r / ovalScale(th);
  vec3 col = vec3(0.005, 0.006, 0.007);
  // concourse plaza around the bowl: paving lit by the facade and path lights
  float plaza = smoothstep(${PRECINCT.plazaIn.toFixed(1)}, ${(PRECINCT.plazaIn + 2).toFixed(1)}, ro) * (1.0 - smoothstep(${(PRECINCT.plazaOut - 3).toFixed(1)}, ${PRECINCT.plazaOut.toFixed(1)}, r));
  col += vec3(0.010, 0.011, 0.012) * plaza;
  // warm wash at the foot of the facade (entrance glazing and uplights), fading out over the plaza
  col += mix(uWarm, vec3(1.0), 0.3) * 0.014 * exp(-max(ro - ${FACADE.foot.toFixed(1)}, 0.0) * 0.16);
  // ring road: dark asphalt with warm pools under the streetlights (staggered, every 16m)
  float dr = r - ${PRECINCT.ringRoad.toFixed(1)};
  float road = 1.0 - smoothstep(7.0, 8.5, abs(dr));
  col *= 1.0 - 0.4 * road;
  float s16 = th * ${PRECINCT.ringRoad.toFixed(1)} / 16.0;
  vec2 pa = vec2((fract(s16) - 0.5) * 16.0, dr + 6.0);
  vec2 pb = vec2((fract(s16 + 0.5) - 0.5) * 16.0, dr - 6.0);
  float pools = exp(-dot(pa, pa) / 10.0) + exp(-dot(pb, pb) / 10.0);
  col += uWarm * 0.018 * pools + uWarm * 0.006 * road;
  // avenues leaving the precinct
  for (int i = 0; i < 6; i++) {
    float a = uAv[i];
    float along = r * cos(th - a);
    float lat = r * sin(th - a);
    float on = step(${PRECINCT.avenueFrom.toFixed(1)}, along) * (1.0 - smoothstep(600.0, ${PRECINCT.avenueTo.toFixed(1)}, along));
    vec2 q1 = vec2((fract(along / 22.0) - 0.5) * 22.0, abs(lat) - 9.0);
    float p2 = exp(-dot(q1, q1) / 10.0);
    float lane = 1.0 - smoothstep(9.0, 10.5, abs(lat));
    col *= 1.0 - 0.4 * lane * on;
    col += uWarm * on * (0.016 * p2 + 0.005 * lane);
  }
  // car parks: cool LED floods on a grid
  for (int i = 0; i < 3; i++) {
    vec2 d = vW.xz - uPark[i].xy;
    float c = cos(uParkRot[i]), s = sin(uParkRot[i]);
    d = vec2(c * d.x + s * d.y, -s * d.x + c * d.y);
    vec2 q = abs(d) - uPark[i].zw;
    float box = 1.0 - smoothstep(-2.0, 6.0, max(q.x, q.y));
    vec2 g = abs(fract(d / 28.0) - 0.5) * 28.0;
    float pool = exp(-dot(g, g) / 60.0);
    col += uCool * box * (0.004 + 0.01 * pool);
  }
  col = applyFog(col, vFogDepth);
  gl_FragColor = vec4(col, 1.0);
  ${TONE}
}
`;

const Exterior: React.FC = () => {
  const viewH = useThree((s) => s.size.height);
  const { ground, groundMat, city, cityMat } = useMemo(() => {
    const ground = new THREE.RingGeometry(FACADE.foot - 2.5, 1900, 128, 6);
    ground.rotateX(-Math.PI / 2);
    ground.translate(0, -0.4, 0);
    const gm = new THREE.ShaderMaterial({
      vertexShader: BOWL_VERT.replace("vN = normalize(mat3(modelMatrix) * normal);", "vN = vec3(0.0, 1.0, 0.0);"),
      fragmentShader: GROUND_FRAG,
      fog: true,
      uniforms: {
        ...fogUniforms(),
        uWarm: { value: vec3Of(PAL.warm) },
        uCool: { value: vec3Of("#DCE6F2") },
        uAv: { value: PRECINCT.avenues },
        uPark: { value: PRECINCT.parks.map((p) => new THREE.Vector4(p[0], p[1], p[2], p[3])) },
        uParkRot: { value: PRECINCT.parks.map((p) => p[4]) },
      },
    });
    // supply the attributes the shared vertex shader expects
    const n = ground.attributes.position.count;
    for (const k of ["aKind", "aTier", "aProf", "aLen"]) ground.setAttribute(k, new THREE.BufferAttribute(new Float32Array(n), 1));
    const r = rng(1999);
    const pos: number[] = [];
    const col: number[] = [];
    const warm = lin("#FFC98A");
    const cool = lin("#DDE6FF");
    const street = lin("#FFD9A8");
    const led = lin("#E8EEFF");
    const push = (x: number, y: number, z: number, c: THREE.Color, k: number) => {
      pos.push(x, y, z);
      col.push(c.r * k, c.g * k, c.b * k);
    };
    // precinct: plaza path lights, ring-road streetlights, avenue streetlights, car-park masts
    for (let i = 0; i < 90; i++) {
      const a = (i / 90) * Math.PI * 2;
      push(Math.cos(a) * 139, 0.6, Math.sin(a) * 139, led, 0.45);
    }
    const ringN = Math.round((Math.PI * 2 * PRECINCT.ringRoad) / 16);
    for (let i = 0; i < ringN; i++) {
      const a = (i / ringN) * Math.PI * 2;
      const rr = PRECINCT.ringRoad + (i % 2 ? 6 : -6);
      push(Math.cos(a) * rr, 9, Math.sin(a) * rr, street, 0.9);
    }
    for (const a of PRECINCT.avenues) {
      for (let d = PRECINCT.avenueFrom; d < PRECINCT.avenueTo; d += 22) {
        for (const side of [-1, 1]) {
          const lat = side * 9;
          push(Math.cos(a) * d - Math.sin(a) * lat, 9, Math.sin(a) * d + Math.cos(a) * lat, street, 0.75);
        }
      }
    }
    for (const [cx, cz, hw, hd, rot] of PRECINCT.parks) {
      const c = Math.cos(rot);
      const sn = Math.sin(rot);
      for (let x = -hw + 6; x <= hw - 6; x += 28)
        for (let z = -hd + 6; z <= hd - 6; z += 28) push(cx + c * x - sn * z, 11, cz + sn * x + c * z, led, 1.0);
    }
    // the city: neighbourhood clusters on a loose street grid, sparse scatter, a few towers
    const grid = 0.35;
    const cs = Math.cos(grid);
    const sn = Math.sin(grid);
    const clusters = Array.from({ length: 46 }, () => {
      const a = r() * Math.PI * 2;
      const rad = 330 + Math.pow(r(), 0.8) * 1350;
      return [Math.cos(a) * rad, Math.sin(a) * rad, 30 + r() * 90];
    });
    const N = 2600;
    for (let i = 0; i < N; i++) {
      let x: number;
      let z: number;
      const kind = r();
      if (kind < 0.7) {
        const c = clusters[Math.floor(r() * clusters.length)];
        // snap to a street grid inside the cluster (rotated grid)
        let u = (r() - 0.5) * 2 * c[2];
        let v = (r() - 0.5) * 2 * c[2];
        if (r() < 0.5) u = Math.round(u / 24) * 24;
        else v = Math.round(v / 24) * 24;
        x = c[0] + u * cs - v * sn;
        z = c[1] + u * sn + v * cs;
      } else {
        const a = r() * Math.PI * 2;
        const rad = 300 + Math.pow(r(), 0.6) * 1500;
        x = Math.cos(a) * rad;
        z = Math.sin(a) * rad;
      }
      if (Math.hypot(x, z) < 240) {
        const k = 240 / Math.hypot(x, z);
        x *= k;
        z *= k;
      }
      const c = r() < 0.72 ? warm : cool;
      push(x, 0.5 + r() * 8, z, c, 0.35 + Math.pow(r(), 2.0) * 1.3);
    }
    // a few lit towers on the skyline (vertical strings of windows)
    for (let t = 0; t < 14; t++) {
      const a = r() * Math.PI * 2;
      const rad = 600 + r() * 900;
      const h = 40 + r() * 90;
      const x0 = Math.cos(a) * rad;
      const z0 = Math.sin(a) * rad;
      for (let y = 6; y < h; y += 3.5)
        for (let w = -2; w <= 2; w++) {
          if (r() < 0.45) continue;
          push(x0 + w * 4 * Math.cos(a + 1.57), y, z0 + w * 4 * Math.sin(a + 1.57), r() < 0.6 ? warm : cool, 0.35 + r() * 0.6);
        }
    }
    const cg = new THREE.BufferGeometry();
    cg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    cg.setAttribute("aCol", new THREE.Float32BufferAttribute(col, 3));
    const cm = new THREE.ShaderMaterial({
      vertexShader: CITY_VERT,
      fragmentShader: CITY_FRAG,
      fog: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { ...fogUniforms(), uViewH: { value: 1080 } },
    });
    return { ground, groundMat: gm, city: cg, cityMat: cm };
  }, []);
  cityMat.uniforms.uViewH.value = viewH;
  return (
    <>
      <mesh geometry={ground} material={groundMat} frustumCulled={false} />
      <points geometry={city} material={cityMat} frustumCulled={false} />
    </>
  );
};

/* ================================================================== */
/* <Stadium/>                                                          */
/* ================================================================== */

export type StadiumProps = {
  /** global frame (drives every animation) */
  F: number;
  /** 8 bank levels 0..1 (bank i at azimuth i*45deg from +X toward +Z) */
  floods?: number[];
  /** LED boards + big screen power 0..1 */
  led?: number;
  /** LED power-up sweep progress 0..1 (from the +Z end around both sides to the -Z end) */
  ledSweep?: number;
  /** crowd energy 0..1 */
  energy?: number;
  /** "near" skips crowd geometry and the city (macro / close shots) */
  detail?: "far" | "near";
  /** volumetric beam strength multiplier (default 1) */
  beams?: number;
  /** force the 3D crowd on/off (default: on for "far") */
  crowd?: boolean;
};

export const Stadium: React.FC<StadiumProps> = ({
  F,
  floods,
  led,
  ledSweep,
  energy,
  detail = "far",
  beams = 1,
  crowd,
}) => {
  const def = stadiumStateAt(F);
  const fl = floods ?? def.floods;
  const L = led ?? def.led;
  const S = ledSweep ?? def.ledSweep;
  const E = energy ?? def.energy;
  const t = F / FPS;
  const master = fl.reduce((a, b) => a + b, 0) / Math.max(1, fl.length);
  const showCrowd = crowd ?? detail === "far";
  return (
    <group>
      <Bowl t={t} flood={master} led={L} seats={showCrowd} />
      {showCrowd ? <Crowd t={t} flood={master} energy={E} /> : null}
      <PhoneFlashes t={t} energy={E} dark={1 - Math.min(1, master * 1.6)} />
      <FloodStructures />
      <FloodLamps floods={fl} />
      {beams > 0 ? <Beams t={t} floods={fl} gain={beams} /> : null}
      <LedBoards t={t} led={L} sweep={S} />
      <Structures t={t} led={L} flood={master} />
      {detail === "far" ? <Exterior /> : null}
    </group>
  );
};

/** Deterministic helper for shots: is bank i lit at frame F (>= 0.5)? */
export const bankOn = (F: number, i: number) => stadiumStateAt(F).floods[i] >= 0.5;

/** Exposed for tests: crowd figure count. */
export const crowdCount = () => getSeats().length;
