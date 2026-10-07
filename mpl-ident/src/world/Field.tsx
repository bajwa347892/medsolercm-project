/**
 * Field & turf: outfield, pitch strip, crease markings, 30-yard circle, boundary rope
 * and 3D grass blades for low / macro shots.
 *
 * Everything is a pure function of props (+ frame for wind), built once in useMemo.
 * Coordinates: metres, Y up, field centre at the origin, pitch along Z (see dims.ts).
 *
 *   <Field />                                     // whole ground, receives shadows
 *   <GrassBlades center={[3, 0, -2]} radius={5} wind={0.5} F={F}
 *                disturb={[{ pos: [3.2, 0, -1.8], radius: 0.35, strength: 1 }]} />
 *
 * Turf reads as turf at every distance: mowing stripes and broad tonal drift from the air, upright
 * blade imposters in the ground shader from ~1 to 25 m (world-anchored, filtered: no shimmer), and
 * real 3D blades (GrassBlades) inside a window that can ride along with a low camera.
 * <GrassBlades/> follows the <Field/>'s mowing pattern through TURF_UNIFORMS.
 * Grass blades do not cast shadows (the depth pass would not see the bend); the near rings receive them.
 * Boundary contact: ropeRadiusAt(angle) (centre line), ropeFaceRadius(angle, y) (inner face), ROPE_DIMS.
 */
import React, { useMemo } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { FPS, rng } from "../config";
import { PAL } from "../theme";
import { FIELD, PITCH, STUMPS } from "./dims";
import type { Vec3 } from "../rig/types";
import { RIM_UNIFORMS } from "./Lights";

/**
 * The mowing pattern the <Field/> in the scene uses, shared by every turf shader (ground, blades,
 * thatch, baked turf texture) so <GrassBlades/> always matches it. <Field/> writes it during render,
 * like RIM_UNIFORMS; without a Field the defaults (5 m stripes) apply.
 */
export const TURF_UNIFORMS = {
  uStripeW: { value: 5 },
  uChecks: { value: 0 },
  uTurf: { value: null as THREE.Texture | null },
};

/** Side of the square the turf texture covers (m), centred on the origin. */
const TURF_SPAN = 2 * FIELD.outfieldRadius + 4;
const TURF_RES = 1024;

/* ================================================================== */
/* Shared GLSL                                                         */
/* ================================================================== */

/** Integer-hash value noise (stable at any world coordinate), with analytic derivatives. */
export const GLSL_NOISE = /* glsl */ `
// turf tint on the palette greens (shared by the ground, the blades and the thatch)
#define MPL_TURF_TINT vec3(1.07, 1.0, 0.78)
uint mplPcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
// pcg2d / pcg3d (Jarzynski & Olano 2020): cheap, well distributed integer hashes
float mplHash2(ivec2 p) {
  uvec2 v = uvec2(p + 1048576) * 1664525u + 1013904223u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v ^= v >> 16u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v ^= v >> 16u;
  return float(v.x) * (1.0 / 4294967295.0);
}
float mplHash3(ivec3 p) {
  uvec3 v = uvec3(p + 1048576) * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return float(v.x) * (1.0 / 4294967295.0);
}
float mplNoise2(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  ivec2 ii = ivec2(i);
  float a = mplHash2(ii), b = mplHash2(ii + ivec2(1, 0));
  float c = mplHash2(ii + ivec2(0, 1)), d = mplHash2(ii + ivec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// value + d/dx + d/dy
vec3 mplNoise2D(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 du = 6.0 * f * (1.0 - f);
  ivec2 ii = ivec2(i);
  float a = mplHash2(ii), b = mplHash2(ii + ivec2(1, 0));
  float c = mplHash2(ii + ivec2(0, 1)), d = mplHash2(ii + ivec2(1, 1));
  float k1 = b - a, k2 = c - a, k4 = a - b - c + d;
  return vec3(a + k1 * u.x + k2 * u.y + k4 * u.x * u.y, du * vec2(k1 + k4 * u.y, k2 + k4 * u.x));
}
float mplNoise3(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  ivec3 ii = ivec3(i);
  float n000 = mplHash3(ii), n100 = mplHash3(ii + ivec3(1,0,0));
  float n010 = mplHash3(ii + ivec3(0,1,0)), n110 = mplHash3(ii + ivec3(1,1,0));
  float n001 = mplHash3(ii + ivec3(0,0,1)), n101 = mplHash3(ii + ivec3(1,0,1));
  float n011 = mplHash3(ii + ivec3(0,1,1)), n111 = mplHash3(ii + ivec3(1,1,1));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
             mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
// value + gradient (x, y, z)
vec4 mplNoise3D(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  vec3 du = 6.0 * f * (1.0 - f);
  ivec3 ii = ivec3(i);
  float a = mplHash3(ii), b = mplHash3(ii + ivec3(1,0,0));
  float c = mplHash3(ii + ivec3(0,1,0)), d = mplHash3(ii + ivec3(1,1,0));
  float e = mplHash3(ii + ivec3(0,0,1)), f1 = mplHash3(ii + ivec3(1,0,1));
  float g = mplHash3(ii + ivec3(0,1,1)), h = mplHash3(ii + ivec3(1,1,1));
  float k0 = a, k1 = b - a, k2 = c - a, k3 = e - a, k4 = a - b - c + d;
  float k5 = a - c - e + g, k6 = a - b - e + f1, k7 = -a + b + c - d + e - f1 - g + h;
  float v = k0 + k1 * u.x + k2 * u.y + k3 * u.z + k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x + k7 * u.x * u.y * u.z;
  vec3 dv = du * vec3(k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z,
                      k2 + k5 * u.z + k4 * u.x + k7 * u.z * u.x,
                      k3 + k6 * u.x + k5 * u.y + k7 * u.x * u.y);
  return vec4(v, dv);
}
float mplSdBox(vec2 p, vec2 c, vec2 hs) {
  vec2 d = abs(p - c) - hs;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}
`;

/**
 * Turf colour model shared by the ground shader and the grass blades so they always agree.
 * Needs uniforms uGrassA, uGrassB, uStripeW, uChecks.
 */
const GLSL_TURF = /* glsl */ `
// 0/1 mowing stripe and the blade lay direction (xz) for that stripe
float mplStripe(vec2 p, float fpx, out vec2 lay) {
  float u = p.x / uStripeW + 0.5;
  u += (mplNoise2(vec2(p.y * 0.035, 3.7)) - 0.5) * 0.035; // mower wobble
  float tri = abs(fract(u * 0.5) * 2.0 - 1.0);
  float aa = fpx / uStripeW * 1.2 + 0.012;
  float st = smoothstep(0.5 - aa, 0.5 + aa, tri);
  lay = vec2(0.0, st * 2.0 - 1.0);
  if (uChecks > 0.5) {
    float v = p.y / uStripeW + 0.5 + (mplNoise2(vec2(p.x * 0.035, 9.1)) - 0.5) * 0.035;
    float tv = abs(fract(v * 0.5) * 2.0 - 1.0);
    float sv = smoothstep(0.5 - aa, 0.5 + aa, tv);
    lay = normalize(vec2(sv * 2.0 - 1.0, st * 2.0 - 1.0));
    st = st + sv - 2.0 * st * sv;
  }
  return st;
}
// stripe colour (chlorophyll absorbs blue: keeps the turf a natural yellow-green under the cool recipe)
vec3 mplStripeCol(float st) { return mix(uGrassB, uGrassA, st) * MPL_TURF_TINT; }
// everything else about the turf colour is a per-channel multiplier independent of the stripe (baked)
vec3 mplTurfMul(vec2 p) {
  vec3 c = vec3(1.0);
  float n = mplNoise2(p * 0.045) * 0.5 + mplNoise2(p * 0.13 + 7.1) * 0.3 + mplNoise2(p * 0.55 + 3.3) * 0.2;
  c *= 0.86 + 0.28 * n;
  // mower passes: faint wheel tracks and overlap seams inside each stripe
  float pass = fract(p.x / (uStripeW * 0.5) + 0.5);
  c *= 1.0 - 0.035 * (1.0 - smoothstep(0.0, 0.06, abs(pass - 0.5))) ;
  c *= 1.0 + 0.03 * sin(p.x * 6.2832 / 0.9 + mplNoise2(vec2(p.y * 0.2, 1.0)) * 2.0);
  // a few tired, yellower patches
  float y = smoothstep(0.58, 0.86, mplNoise2(p * 0.075 + 21.0));
  c = mix(c, c * vec3(1.22, 1.06, 0.72), y * 0.32);
  // the square (pitch block) is cut tighter and reads a touch paler
  float sq = 1.0 - smoothstep(-0.6, 0.6, mplSdBox(p, vec2(0.0), vec2(10.5, 13.0)));
  if (sq > 0.0) {
    float lane = mplNoise2(vec2(floor(p.x / 3.05) * 7.3, 2.0));
    // old pitches on the square: lanes one pitch wide, each a slightly different shade of worn grass
    float laneEdge = 1.0 - smoothstep(0.0, 0.08, abs(fract(p.x / 3.05 + 0.5) - 0.5) * 3.05);
    c = mix(c, c * vec3(1.1, 1.07, 0.86) * (0.93 + 0.14 * lane) * (1.0 - 0.05 * laneEdge), sq * 0.75);
  }
  // bowlers' run-ups are worn
  float az = abs(p.y);
  float run = (1.0 - smoothstep(0.9, 1.6, abs(p.x))) * smoothstep(10.8, 11.6, az) * (1.0 - smoothstep(18.0, 30.0, az));
  if (run > 0.0) c = mix(c, c * vec3(1.16, 1.08, 0.78), run * (0.45 + 0.35 * mplNoise2(p * 2.3)));
  return c;
}
vec3 mplTurfBase(vec2 p, float st) { return mplStripeCol(st) * mplTurfMul(p); }
`;

/* ================================================================== */
/* Ground shader (grass + pitch + markings in one pass)                */
/* ================================================================== */

const GROUND_FRAG_PARS = /* glsl */ `
varying vec3 vWPos;
uniform vec3 uGrassA;
uniform vec3 uGrassB;
uniform vec3 uPitchCol;
uniform vec3 uPaint;
uniform float uStripeW;
uniform float uChecks;
uniform float uRing30;
uniform sampler2D uTurf;
${GLSL_NOISE}
${GLSL_TURF}

float mplCov(float d, float w) { return clamp(0.5 - d / max(w, 1e-5), 0.0, 1.0); }

// Blade imposters on the ground plane: one soft blade per world cell (rows shifted at random so the
// lattice never shows). A blade stands up, so on the ground it is drawn elongated along the line of
// sight (dir: horizontal direction away from the camera, elong ~ 1/sin(elevation)); on screen it then
// reads as a short upright stroke from any viewing angle, like real turf. The cells are fixed to the
// world: as the camera moves each blade pivots about its root, nothing swims. Each blade stays inside
// its cell, so there is no neighbour search. Returns the blade intensity minus its expected mean.
// pxm / pxM: the pixel footprint (minimum / maximum axis) in cells. Blades never get thinner than about
// a pixel: below that they are widened and dimmed by the same factor (same energy), so they cannot
// sparkle in motion; the caller fades each layer to zero once even its cells approach pixel size.
float mplBladeImp(vec2 p, float F, int seed, vec2 dir, float elong, float pxm, float pxM) {
  vec2 q = p * F;
  float row = floor(q.y);
  q.x += mplHash2(ivec2(seed, int(row)) + 7) * 3.0;
  vec2 c = floor(q);
  vec2 f = fract(q) - 0.5;
  ivec2 ci = ivec2(c) + ivec2(seed * 31, seed);
  float h1 = mplHash2(ci);
  float h2 = mplHash2(ci + 57);
  vec2 d = f - (vec2(mplHash2(ci + 101), mplHash2(ci + 211)) - 0.5) * 0.08;
  float a = dot(d, dir);
  float b = dot(d, vec2(-dir.y, dir.x));
  // two thin blades side by side in each cell, one usually brighter than the other
  float acc = 0.0;
  for (int k = 0; k < 2; k++) {
    float hk = k == 0 ? h1 : h2;
    float bo = k == 0 ? -0.17 : 0.17;
    float minor0 = 0.065 + 0.045 * fract(hk * 7.13);
    float minor = max(minor0, 0.55 * pxm);
    float major0 = min(0.41, minor0 * elong);
    float major = min(0.41, max(major0, 0.55 * pxM));
    float energy = (minor0 * major0) / (minor * major);
    float ak = a - (fract(hk * 3.7) - 0.5) * 0.08;
    float e = length(vec2(ak / major, (b - bo) / minor));
    float m = 1.0 - smoothstep(0.45, 1.0, e);
    // lit tip (further from the camera), shaded root; bright and dark blades alike (zero mean)
    float tip = 0.6 + 0.4 * clamp(ak / major * 0.5 + 0.5, 0.0, 1.0);
    acc += m * tip * (hk * 2.0 - 1.0) * energy;
  }
  return acc;
}

// Crease markings per Law 7: the crease is the back edge of the marking.
float mplCreases(vec2 p, float fpx) {
  const float LW = 0.05;
  vec2 q = vec2(p.x, abs(p.y));
  // tiny hand-painted wobble on the edges
  float wob = (mplNoise2(p * 9.0) - 0.5) * 0.004;
  float d = mplSdBox(q, vec2(0.0, ${PITCH.stumpsZ.toFixed(3)} - LW * 0.5), vec2(${PITCH.returnCreaseX.toFixed(3)} + LW, LW * 0.5));
  float pz = ${(PITCH.stumpsZ - PITCH.poppingOffset).toFixed(3)};
  d = min(d, mplSdBox(q, vec2(0.0, pz - LW * 0.5), vec2(1.83, LW * 0.5)));
  float rx = ${PITCH.returnCreaseX.toFixed(3)};
  d = min(d, mplSdBox(vec2(abs(q.x), q.y), vec2(rx + LW * 0.5, (pz - LW + pz + 2.44) * 0.5), vec2(LW * 0.5, (2.44 + LW) * 0.5)));
  d += wob;
  float cov = mplCov(d, fpx * 1.3 + 0.002);
  // paint is not perfectly opaque on turf
  cov *= 0.86 + 0.14 * mplNoise2(p * 140.0);
  return cov;
}

// 30-yard fielding circle: two semicircles of 27.43 m on the middle stumps joined by straights.
float mplRing30(vec2 p, float fpx) {
  vec2 q = vec2(abs(p.x), max(abs(p.y) - ${PITCH.stumpsZ.toFixed(3)}, 0.0));
  float d = abs(length(q) - 27.43) - 0.035;
  // arc-length parameter for dashes
  float s = abs(p.y) <= ${PITCH.stumpsZ.toFixed(3)} ? abs(p.y) : ${PITCH.stumpsZ.toFixed(3)} + 27.43 * atan(q.y, q.x);
  float dash = smoothstep(0.18, 0.22, abs(fract(s / 0.9) - 0.5));
  return mplCov(d, fpx * 1.3 + 0.002) * (1.0 - dash);
}

struct MplGround { vec3 albedo; float rough; vec3 nW; float spec; };

MplGround mplGround(vec2 p, float fpx, float fdet, vec3 V) {
  MplGround g;
  vec2 lay;
  float st = mplStripe(p, fpx, lay);
  // the square is cut closer: its mowing stripes read much weaker than the outfield's
  float sqCut = 1.0 - smoothstep(-0.4, 0.4, mplSdBox(p, vec2(0.0), vec2(10.5, 13.0)));
  float stC = mix(st, 0.5 + (st - 0.5) * 0.3, sqCut);
  vec3 c = mplStripeCol(stC) * texture(uTurf, p / ${TURF_SPAN.toFixed(1)} + 0.5).rgb;

  // view-dependent stripe: blades laid away from the viewer look lighter
  vec2 vh = V.xz / max(length(V.xz), 1e-4);
  float graze = clamp(1.0 - V.y, 0.0, 1.0);
  c *= 1.0 + 0.13 * dot(lay, -vh) * (0.3 + 0.7 * graze);

  // multi-scale clump/tuft detail, faded out once a noise cell is sub-pixel (no shimmer)
  vec2 pl = vec2(p.x, p.y * 0.8);                // tufts are only a little stretched along the lay
  vec2 grad = vec2(0.0);
  float v = 0.0;
  float f1 = 1.0 - smoothstep(0.3, 0.8, fdet * 3.0);
  if (f1 > 0.0) {
    vec3 n1 = mplNoise2D(pl * 3.0 + 11.0);
    v += (n1.x - 0.5) * 0.1 * f1;  grad += n1.yz * vec2(3.0, 2.4) * 0.004 * f1;
  }
  float f2 = 1.0 - smoothstep(0.3, 0.8, fdet * 14.0);
  if (f2 > 0.0) {
    vec3 n2 = mplNoise2D(pl * 14.0 + 3.0);
    v += (n2.x - 0.5) * 0.1 * f2;  grad += n2.yz * vec2(14.0, 11.2) * 0.0016 * f2;
  }
  // tufts, clumps and single blades as upright imposters (see mplBladeImp): crisp grain that reads
  // as cut turf from 1-25 m. Each layer fades to its mean once its cell is sub-pixel (no shimmer);
  // contrast drops at grazing angles where blades overlap.
  vec2 bDir = normalize(mix(-vh, lay, smoothstep(0.75, 0.97, V.y)) + vec2(1e-4, 0.0));
  float bElong = 1.5 / max(V.y, 0.18);
  float bCon = 1.0 - 0.4 * graze;
  float fc1 = 1.0 - smoothstep(0.3, 0.75, fdet * 22.0);
  if (fc1 > 0.0) v += mplBladeImp(p, 22.0, 5, bDir, bElong, fdet * 22.0, fpx * 22.0) * 0.45 * bCon * fc1;
  float fc2 = 1.0 - smoothstep(0.3, 0.75, fdet * 50.0);
  if (fc2 > 0.0) v += (mplBladeImp(p + vec2(0.13, 0.29), 50.0, 11, bDir, bElong, fdet * 50.0, fpx * 50.0)
                     + mplBladeImp(p + vec2(0.63, 0.79), 50.0, 12, bDir, bElong, fdet * 50.0, fpx * 50.0)) * 0.5 * bCon * fc2;
  float fb1 = 1.0 - smoothstep(0.3, 0.75, fdet * 110.0);
  if (fb1 > 0.0) v += (mplBladeImp(p + vec2(0.37, 0.11), 110.0, 17, bDir, bElong, fdet * 110.0, fpx * 110.0)
                     + mplBladeImp(p + vec2(0.87, 0.61), 110.0, 18, bDir, bElong, fdet * 110.0, fpx * 110.0)) * 0.6 * bCon * fb1;
  float fb2 = 1.0 - smoothstep(0.3, 0.75, fdet * 260.0);
  if (fb2 > 0.0) v += mplBladeImp(p + vec2(0.71, 0.53), 260.0, 43, bDir, bElong, fdet * 260.0, fpx * 260.0) * 0.8 * bCon * fb2;
  // the average of the faded detail (soil showing between blades) when seen from far
  c *= max(0.3, 1.0 + v);
  // broad, slow tonal drift (watering, wear, soil) at 20-80 m scales
  c *= 0.93 + 0.1 * mplNoise2(p * 0.013 + 5.0) + 0.04 * mplNoise2(p * 0.05 + 17.0);
  // looking straight down we see more of the dark thatch between blades
  c *= mix(0.86, 1.04, graze);
  float rough = 0.86 - 0.06 * graze + 0.05 * v;

  // ---- pitch strip ----
  float edgeN = (mplNoise2(p * vec2(5.0, 0.6)) - 0.5) * 0.05 + (mplNoise2(p * 31.0) - 0.5) * 0.012;
  float dP = mplSdBox(p, vec2(0.0), vec2(${(PITCH.width / 2).toFixed(4)} + edgeN, ${(PITCH.stripLength / 2).toFixed(3)} + edgeN));
  // the grass fringe: a few blades reach over the mown edge
  float fringe = (mplNoise2(vec2(p.x * 260.0, p.y * 70.0)) - 0.5) * 0.02 * (1.0 - smoothstep(0.001, 0.004, fpx));
  float pm = 1.0 - smoothstep(-0.012 - fpx, 0.012 + fpx, dP + fringe);
  if (pm > 0.0) {
    vec3 pc = uPitchCol * vec3(0.66, 0.64, 0.62);
    float az = abs(p.y);
    float b1 = mplNoise2(p * vec2(1.1, 0.33));
    float b2 = mplNoise2(p * 4.0 + 5.0);
    pc *= 0.82 + 0.24 * b1 + 0.1 * b2;
    // live grass left on the surface (more toward the edges, less where it's worn)
    float grassy = smoothstep(0.35, 0.8, mplNoise2(p * vec2(2.6, 0.9) + 2.0)) * 0.35
                 + smoothstep(1.0, 1.52, abs(p.x)) * 0.35;
    float wearZone = smoothstep(5.8, 7.6, az) * (1.0 - smoothstep(10.8, 11.1, az));
    grassy *= 1.0 - 0.7 * wearZone;
    pc = mix(pc, vec3(0.1, 0.13, 0.045), clamp(grassy, 0.0, 0.6) * 0.5);
    // ends: scuffed, darker and redder where bowlers land and batsmen take guard
    float scuffN = mplNoise2(p * vec2(7.0, 3.0) + 13.0);
    float foot = (1.0 - smoothstep(0.25, 0.75, abs(p.x - 0.05 * sign(p.y)))) * smoothstep(8.0, 8.6, az) * (1.0 - smoothstep(10.0, 10.6, az));
    float guard = (1.0 - smoothstep(0.08, 0.3, abs(p.x + 0.06))) * smoothstep(8.5, 8.75, az) * (1.0 - smoothstep(9.6, 10.0, az));
    float scuff = clamp(wearZone * 0.35 + foot * 0.85 + guard * 0.5, 0.0, 1.0) * (0.45 + 0.55 * scuffN);
    pc = mix(pc, pc * vec3(0.6, 0.5, 0.4), scuff * 0.85);
    // ball marks on a good length
    vec2 bmCell = floor(p * vec2(3.0, 3.0));
    float bmh = mplHash2(ivec2(bmCell) + 77);
    vec2 bmc = (bmCell + 0.2 + 0.6 * vec2(mplHash2(ivec2(bmCell) + 7), mplHash2(ivec2(bmCell) + 9))) / 3.0;
    float lengthZone = smoothstep(1.5, 3.0, az) * (1.0 - smoothstep(7.0, 8.0, az)) * (1.0 - smoothstep(0.5, 0.9, abs(p.x)));
    float bm = (1.0 - smoothstep(0.012, 0.03, length(p - bmc))) * step(0.72, bmh) * lengthZone;
    pc *= 1.0 - 0.32 * bm;
    // hairline cracks (jittered cellular edges), only while resolvable, mostly toward the ends
    float fc = 1.0 - smoothstep(0.0015, 0.005, fpx);
    if (fc > 0.0) {
      vec2 cp = p * vec2(9.0, 7.0) + (vec2(mplNoise2(p * 23.0), mplNoise2(p * 23.0 + 5.0)) - 0.5) * 0.35;
      vec2 ci = floor(cp);
      float d1 = 9.0, d2 = 9.0;
      for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
        ivec2 cc = ivec2(ci) + ivec2(i, j);
        vec2 o = vec2(mplHash2(cc + 31), mplHash2(cc + 57));
        float dd = length(cp - (vec2(cc) + o));
        if (dd < d1) { d2 = d1; d1 = dd; } else if (dd < d2) { d2 = dd; }
      }
      float edge = d2 - d1;
      float patchy = smoothstep(0.45, 0.75, mplNoise2(p * 1.7 + 40.0));
      float crackAmt = (0.15 + 0.85 * wearZone) * patchy;
      float crack = (1.0 - smoothstep(0.0, 0.022, edge)) * crackAmt * fc;
      pc *= 1.0 - 0.45 * crack;
    }
    // dusty mottle and small dark spots (moisture, old footmarks)
    float mot = mplNoise2(p * 11.0 + 2.0) * 0.5 + mplNoise2(p * 37.0 + 8.0) * 0.5;
    float motF = 1.0 - smoothstep(0.3, 0.8, fpx * 37.0);
    pc *= 1.0 + (mot - 0.5) * 0.16 * motF;
    float spots = smoothstep(0.8, 0.92, mplNoise2(p * 26.0 + 17.0)) * (1.0 - smoothstep(0.25, 0.6, fpx * 26.0));
    pc *= 1.0 - 0.06 * spots;
    // fine grit, sand grains and the odd dead grass fleck
    float fg = 1.0 - smoothstep(0.25, 0.6, fpx * 220.0);
    float fg2 = 1.0 - smoothstep(0.25, 0.6, fpx * 700.0);
    vec3 gr1 = mplNoise2D(p * 220.0);
    vec3 gr2 = mplNoise2D(p * 700.0 + 3.0);
    pc *= 1.0 + (gr1.x - 0.5) * 0.24 * fg + (gr2.x - 0.5) * 0.3 * fg2;
    // loose crumbs (dark clods) and pale dusty grains
    float crumb = smoothstep(0.8, 0.9, mplNoise2(p * 420.0 + 41.0)) * fg2;
    float grain = smoothstep(0.84, 0.94, mplNoise2(p * 520.0 + 77.0)) * fg2;
    pc *= 1.0 - 0.3 * crumb;
    pc = mix(pc, pc * 1.25 + 0.02, grain * 0.5);
    float fleck = smoothstep(0.86, 0.95, mplNoise2(p * 160.0 + 9.0)) * fg;
    pc = mix(pc, vec3(0.06, 0.1, 0.025), fleck * 0.55 * (1.0 - 0.7 * wearZone));
    // pitch bump: rolled flat, gentle, with a fine crumb
    vec3 pn = mplNoise2D(p * 9.0 + 3.0);
    vec3 pn2 = mplNoise2D(p * 85.0 + 1.0);
    vec2 pgrad = pn.yz * 9.0 * 0.0011 * f2 + pn2.yz * 85.0 * 0.00035 * (1.0 - smoothstep(0.25, 0.6, fpx * 85.0))
               + gr1.yz * 220.0 * 0.00016 * fg + gr2.yz * 700.0 * 0.00005 * fg2;
    c = mix(c, pc, pm);
    rough = mix(rough, 0.92 + 0.05 * scuff, pm);
    grad = mix(grad, pgrad, pm);
  }

  // ---- paint ----
  float paint = mplCreases(p, fpx);
  if (uRing30 > 0.0) paint = max(paint, mplRing30(p, fpx) * uRing30);
  c = mix(c, uPaint, paint);
  rough = mix(rough, 0.62, paint);
  grad *= 1.0 - 0.7 * paint;

  // the stump holes: each stump is driven into the clay, leaving a dark, crumbly collar round it
  // (after the paint: the crease marking does not fill a hole)
  float hz = abs(p.y);
  if (hz > 9.95 && hz < 10.17 && abs(p.x) < 0.2) {
    float sx = ${STUMPS.spacing.toFixed(4)};
    vec2 hq = vec2(p.x - clamp(floor(p.x / sx + 0.5), -1.0, 1.0) * sx, hz - ${PITCH.stumpsZ.toFixed(3)});
    float hd = length(hq);
    float hole = 1.0 - smoothstep(${(STUMPS.radius + 0.001).toFixed(4)}, ${(STUMPS.radius + 0.01).toFixed(4)}, hd + (mplNoise2(p * 400.0) - 0.5) * 0.005);
    float collar = (1.0 - smoothstep(0.022, 0.05, hd)) * (0.55 + 0.45 * mplNoise2(p * 160.0 + 3.0));
    c *= (1.0 - 0.6 * hole) * (1.0 - 0.22 * collar);
    rough = mix(rough, 0.95, collar);
  }
  g.albedo = c;
  g.rough = rough;
  g.spec = mix(mix(0.0, 0.45, pm), 0.7, paint);
  g.nW = normalize(vec3(-grad.x, 1.0, -grad.y));
  return g;
}
`;

const linear = (hex: string) => new THREE.Color(hex);

type GroundUniforms = {
  uGrassA: { value: THREE.Color };
  uGrassB: { value: THREE.Color };
  uPitchCol: { value: THREE.Color };
  uPaint: { value: THREE.Color };
  uStripeW: { value: number };
  uChecks: { value: number };
  uRing30: { value: number };
  uTurf: { value: THREE.Texture | null };
};

const makeGroundMaterial = (u: GroundUniforms) => {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWPos;")
      .replace(
        "#include <worldpos_vertex>",
        "#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\n" + GROUND_FRAG_PARS)
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        vec2 gp = vWPos.xz;
        vec2 gfw = fwidth(gp);
        float gfpx = max(max(gfw.x, gfw.y), 1e-5);
        float gfdet = max(sqrt(gfw.x * gfw.y), gfpx * 0.3);
        vec3 gV = normalize(cameraPosition - vWPos);
        MplGround gS = mplGround(gp, gfpx, gfdet, gV);
        diffuseColor.rgb = gS.albedo;`,
      )
      .replace("#include <roughnessmap_fragment>", "float roughnessFactor = gS.rough;")
      .replace(
        "#include <normal_fragment_maps>",
        "#include <normal_fragment_maps>\nnormal = normalize((viewMatrix * vec4(gS.nW, 0.0)).xyz);",
      )
      .replace(
        "#include <lights_physical_fragment>",
        `#include <lights_physical_fragment>
        // turf scatters its sheen: weaker, slightly green grazing reflection (no grey wash)
        // (three >= 0.18x reads direct-light F0 from specularColorBlended: set both, or every flood
        //  gets a neutral 0.04 F0 and backlit turf goes milky)
        // turf F0: half the waxy cuticle's neutral 4%, half green (scattered through the blades)
        material.specularColor = mix(mix(diffuseColor.rgb * 0.3 + 0.003, vec3(0.036), 0.5), vec3(0.04), gS.spec);
        material.specularColorBlended = material.specularColor;
        material.specularF90 = mix(0.028, 0.6, gS.spec);`,
      );
  };
  m.customProgramCacheKey = () => "mpl-ground-v21";
  return m;
};

/* ================================================================== */
/* Boundary rope and 30-yard markers                                   */
/* ================================================================== */

/** Screen-space bump: perturb a view-space normal by the derivatives of a height field (metres). */
const GLSL_DBUMP = /* glsl */ `
vec3 mplDBump(vec3 pos, vec3 n, float h) {
  vec3 sx = dFdx(pos);
  vec3 sy = dFdy(pos);
  vec3 r1 = cross(sy, n);
  vec3 r2 = cross(n, sx);
  float det = dot(sx, r1);
  vec2 dh = vec2(dFdx(h), dFdy(h));
  vec3 g = sign(det) * (dh.x * r1 + dh.y * r2);
  return normalize(abs(det) * n - g);
}
`;

const ROPE_SEG = 3.0; // cushion length, metres
const ROPE_W = 0.11; // half width at the base
const ROPE_H = 0.13; // profile height
const ROPE_SINK = 0.004; // the cushion settles into the turf

const makeRopeMaterial = () => {
  const m = new THREE.MeshPhysicalMaterial({
    color: linear(PAL.white),
    roughness: 0.62,
    metalness: 0,
    sheen: 0.7,
    sheenColor: linear(PAL.silver),
    sheenRoughness: 0.4,
  });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec2 aRope;\nvarying vec2 vRope;\nvarying float vRopeY;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvRope = aRope;\nvRopeY = position.y;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec2 vRope;
        varying float vRopeY;
        ${GLSL_NOISE}
        ${GLSL_DBUMP}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        float ru = vRope.x;                                   // 0 inner base .. 0.5 crown .. 1 outer base
        float sl = vRope.y;                                   // metres along the rope
        float seg = abs(fract(sl / ${ROPE_SEG.toFixed(1)}) - 0.5) * ${ROPE_SEG.toFixed(1)};   // distance to a joint
        float joint = 1.0 - smoothstep(0.004, 0.012, seg);
        float strap = (1.0 - smoothstep(0.03, 0.036, seg)) * (1.0 - joint);
        float rfw = fwidth(sl) + fwidth(ru) * 0.3;
        // quilted channels along the cushion, fabric wrinkles across it, a fine weave while resolvable
        float quilt = 0.5 - 0.5 * cos(ru * 6.2832 * 3.0);
        float wr = mplNoise2(vec2(sl * 4.5, ru * 3.0)) * 0.7 + mplNoise2(vec2(sl * 13.0, ru * 7.0 + 4.0)) * 0.3;
        // creases: sharp ridged noise, mostly running round the cushion (it is squashed along its length)
        float cr1 = 1.0 - abs(mplNoise2(vec2(sl * 22.0, ru * 2.5 + 9.0)) * 2.0 - 1.0);
        float cr2 = 1.0 - abs(mplNoise2(vec2(sl * 9.0 + 3.0, ru * 5.0)) * 2.0 - 1.0);
        float creaseF = 1.0 - smoothstep(0.004, 0.02, rfw);
        float crease = (pow(cr1, 2.2) * 0.6 + pow(cr2, 2.2) * 0.4) * creaseF;
        float weaveF = 1.0 - smoothstep(0.0006, 0.002, rfw);
        float weave = (0.5 + 0.5 * sin(sl * 1400.0) * sin(ru * 900.0)) * weaveF;
        float ropeH = -0.006 * quilt - 0.004 * wr * (1.0 - strap) - 0.0016 * crease * (1.0 - strap) - 0.0003 * weave + 0.002 * strap;
        ropeH -= 0.006 * joint;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(${new THREE.Color(PAL.silver).toArray().map((v) => v.toFixed(4)).join(",")}), 0.35);
        diffuseColor.rgb *= (0.9 + 0.1 * (1.0 - quilt)) * (0.92 + 0.08 * wr) * (1.0 - 0.45 * joint);
        // velcro straps either side of each joint: graphite
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(${new THREE.Color(PAL.graphite).toArray().map((v) => v.toFixed(4)).join(",")}), strap * 0.92);
        // a thin teal piping along the crown seam (the only colour on the rope)
        float pipe = 1.0 - smoothstep(0.006, 0.011, abs(ru - 0.5) - 0.0);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(${new THREE.Color(PAL.teal).toArray().map((v) => v.toFixed(4)).join(",")}), pipe * 0.85 * (1.0 - strap));
        // contact shadow and grass grime where it sits on the turf
        float base = smoothstep(0.0, 0.045, vRopeY);
        diffuseColor.rgb *= mix(0.42, 1.0, base);
        diffuseColor.rgb = mix(diffuseColor.rgb * vec3(0.8, 0.9, 0.72), diffuseColor.rgb, smoothstep(0.0, 0.02, vRopeY));`,
      )
      .replace("#include <roughnessmap_fragment>", "float roughnessFactor = mix(0.62, 0.45, strap) + 0.1 * (1.0 - base);")
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
        normal = mplDBump(-vViewPosition, normal, ropeH);`,
      );
  };
  m.customProgramCacheKey = () => "mpl-rope-v4";
  return m;
};

const ROPE_PHASE = (() => {
  const r = rng(91);
  return [r() * 6.28, r() * 6.28, r() * 6.28];
})();

/**
 * Radius (m) of the boundary rope's centre line at azimuth `angle` (radians, from +X toward +Z).
 * The rope is laid by hand: it wanders a few cm around FIELD.boundary. Use it to land a ball on the rope.
 */
export const ropeRadiusAt = (angle: number) =>
  FIELD.boundary +
  0.035 * Math.sin(angle * 7 + ROPE_PHASE[0]) +
  0.022 * Math.sin(angle * 19 + ROPE_PHASE[1]) +
  0.012 * Math.sin(angle * 53 + ROPE_PHASE[2]);
/**
 * Boundary cushion: `height` is the crown above the turf (m) away from the joints (a ball resting on the
 * rope has its centre at height + BALL.radius), `halfWidth` the half width at the base, `segment` the
 * cushion length; the crown dips ~1.8 cm at each strapped joint.
 */
export const ROPE_DIMS = { height: ROPE_H - ROPE_SINK, halfWidth: ROPE_W, segment: ROPE_SEG } as const;

/**
 * Padded boundary cushion: rounded profile swept round the boundary in 3 m cushions, pinched and
 * strapped at the joints, with a gentle hand-laid wander in radius (never a perfect CG circle).
 * Attribute aRope = (u around the profile 0..1, metres along the rope).
 */
/** Cushion cross-section (x across, + outward; y up before sinking), inner base -> crown -> outer base. */
const ropeProfile = (N: number) => {
  const prof: [number, number][] = [];
  for (let i = 0; i <= N; i++) {
    // superellipse-ish dome from the inner base round the top to the outer base
    const a = Math.PI * (1 - i / N);
    const c = Math.cos(a);
    const sn = Math.sin(a);
    const x = Math.sign(c) * Math.pow(Math.abs(c), 0.7) * ROPE_W * (1 - 0.18 * sn);
    const y = Math.pow(sn, 0.8) * ROPE_H;
    prof.push([x, y]);
  }
  return prof;
};
const ROPE_FACE = ropeProfile(200).slice(0, 101); // inner half, y rising

/**
 * Radius (m) of the cushion's inner face (the side facing the field) at height `y` above the turf,
 * at azimuth `angle` (away from the joints). A ball of radius r rolling into the rope touches it with
 * its centre at radius ropeFaceRadius(angle, r) - r, height r.
 */
export const ropeFaceRadius = (angle: number, y: number) => {
  const yy = Math.min(ROPE_H - 1e-4, Math.max(0, y + ROPE_SINK));
  let x = ROPE_FACE[0][0];
  for (let i = 1; i < ROPE_FACE.length; i++) {
    const [x1, y1] = ROPE_FACE[i];
    const [x0, y0] = ROPE_FACE[i - 1];
    if (y1 >= yy) {
      x = x0 + ((x1 - x0) * (yy - y0)) / Math.max(1e-9, y1 - y0);
      break;
    }
  }
  return ropeRadiusAt(angle) + x;
};

const buildRopeGeometry = (segs: number) => {
  const prof = ropeProfile(22);
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const P = prof.length;
  for (let j = 0; j <= segs; j++) {
    const ang = (j / segs) * Math.PI * 2;
    const sl = ang * FIELD.boundary;
    const dj = Math.abs((((sl / ROPE_SEG) % 1) + 1) % 1 - 0.5) * ROPE_SEG; // distance to a joint
    const pinch = 1 - 0.14 * Math.exp(-((dj / 0.06) ** 2));
    // laid by hand: a few cm of wander, periodic round the circle so it closes
    const rc = ropeRadiusAt(ang);
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    prof.forEach(([px, py], i) => {
      const rr = rc + px * pinch;
      pos.push(rr * ca, Math.max(0, py * pinch) - ROPE_SINK, rr * sa);
      uv.push(i / (P - 1), sl);
    });
  }
  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < P - 1; i++) {
      const a = j * P + i;
      const b = (j + 1) * P + i;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("aRope", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
};

/** 30-yard circle marker centres (two semicircles of 27.43 m joined by straights). */
export const ring30Points = (spacing = 4.57): [number, number][] => {
  const R = 27.43;
  const zc = PITCH.stumpsZ;
  const pts: [number, number][] = [];
  // straights at x = +-R, |z| <= zc
  const nStraight = Math.max(1, Math.round((2 * zc) / spacing));
  for (const sx of [-1, 1]) {
    for (let i = 0; i < nStraight; i++) pts.push([sx * R, -zc + ((i + 0.5) * 2 * zc) / nStraight]);
  }
  // semicircles
  const nArc = Math.round((Math.PI * R) / spacing);
  for (const sz of [-1, 1]) {
    for (let i = 0; i <= nArc; i++) {
      const a = (i / nArc) * Math.PI; // 0..pi from +x to -x
      pts.push([R * Math.cos(a), sz * (zc + R * Math.sin(a))]);
    }
  }
  return pts;
};

export type FieldProps = {
  /** "stripes" (parallel to the pitch) or "checks" (criss-cross). Default "stripes". */
  pattern?: "stripes" | "checks";
  /** mowing stripe width, metres (default 5) */
  stripeWidth?: number;
  /** boundary rope (default true) */
  rope?: boolean;
  /** 30-yard circle disc markers (default true) and painted dashes (0..1, default 0.85) */
  markers?: boolean;
  ring30Paint?: number;
  /** "far" for aerial / wide shots, "near" for low shots (denser rope tessellation) */
  detail?: "far" | "near";
  receiveShadow?: boolean;
};

/** The playing surface: outfield disc to FIELD.outfieldRadius, pitch, creases, circle markers, rope. */
export const Field: React.FC<FieldProps> = ({
  pattern = "stripes",
  stripeWidth = 5,
  rope = true,
  markers = true,
  ring30Paint = 0.85,
  detail = "far",
  receiveShadow = true,
}) => {
  const uniforms = useMemo<GroundUniforms>(
    () => ({
      uGrassA: { value: linear(PAL.grassA) },
      uGrassB: { value: linear(PAL.grassB) },
      uPitchCol: { value: linear(PAL.pitch) },
      uPaint: { value: linear(PAL.white).multiplyScalar(0.92) },
      uStripeW: TURF_UNIFORMS.uStripeW,
      uChecks: TURF_UNIFORMS.uChecks,
      uRing30: { value: 0 },
      uTurf: TURF_UNIFORMS.uTurf,
    }),
    [],
  );
  const gl = useThree((st) => st.gl);
  TURF_UNIFORMS.uStripeW.value = stripeWidth;
  TURF_UNIFORMS.uChecks.value = pattern === "checks" ? 1 : 0;
  TURF_UNIFORMS.uTurf.value = getTurfTexture(gl, stripeWidth, pattern === "checks");
  uniforms.uRing30.value = ring30Paint;

  const ground = useMemo(() => {
    const g = new THREE.CircleGeometry(FIELD.outfieldRadius, 192);
    g.rotateX(-Math.PI / 2);
    return g;
  }, []);
  const groundMat = useMemo(() => makeGroundMaterial(uniforms), [uniforms]);

  const ropeSegs = detail === "near" ? 3072 : 1024;
  const ropeGeo = useMemo(() => buildRopeGeometry(ropeSegs), [ropeSegs]);
  const ropeMat = useMemo(makeRopeMaterial, []);

  const markerData = useMemo(() => {
    const geo = new THREE.CylinderGeometry(0.105, 0.115, 0.014, 28, 1);
    geo.translate(0, 0.006, 0);
    const mat = new THREE.MeshPhysicalMaterial({
      color: linear(PAL.white),
      roughness: 0.35,
      clearcoat: 0.4,
      clearcoatRoughness: 0.3,
    });
    const pts = ring30Points();
    const mesh = new THREE.InstancedMesh(geo, mat, pts.length);
    const m4 = new THREE.Matrix4();
    pts.forEach(([x, z], i) => {
      m4.makeTranslation(x, 0, z);
      mesh.setMatrixAt(i, m4);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    return mesh;
  }, []);
  markerData.receiveShadow = receiveShadow;
  markerData.castShadow = false;

  return (
    <group>
      <mesh geometry={ground} material={groundMat} receiveShadow={receiveShadow} />
      {rope ? <mesh geometry={ropeGeo} material={ropeMat} receiveShadow={receiveShadow} castShadow={false} /> : null}
      {markers ? <primitive object={markerData} /> : null}
    </group>
  );
};

/* ================================================================== */
/* Baked turf colour (for the blades' vertex shader)                   */
/* ================================================================== */

const turfCache = new WeakMap<THREE.WebGLRenderer, Map<string, THREE.Texture>>();

/**
 * The outfield's turf colour multiplier (rgb: patches, wear, square, run-ups) and mowing stripe (a),
 * rendered once per renderer with exactly the ground shader's GLSL into a 1024^2 half-float texture
 * (13.7 cm texels). The ground, the blades and the thatch read it with one fetch instead of ~8 noise
 * lookups; the ground keeps its procedural stripe so stripe edges stay crisp.
 * Pure function of constants: deterministic.
 */
const getTurfTexture = (gl: THREE.WebGLRenderer, stripeW = 5, checks = false): THREE.Texture => {
  const key = `${stripeW.toFixed(3)}|${checks ? 1 : 0}`;
  let byKey = turfCache.get(gl);
  if (!byKey) {
    byKey = new Map();
    turfCache.set(gl, byKey);
  }
  const cached = byKey.get(key);
  if (cached) return cached;
  const rt = new THREE.WebGLRenderTarget(TURF_RES, TURF_RES, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    magFilter: THREE.LinearFilter,
    minFilter: THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer: false,
  });
  rt.texture.colorSpace = THREE.NoColorSpace;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uGrassA: { value: linear(PAL.grassA) },
      uGrassB: { value: linear(PAL.grassB) },
      uStripeW: { value: stripeW },
      uChecks: { value: checks ? 1 : 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uGrassA;
      uniform vec3 uGrassB;
      uniform float uStripeW;
      uniform float uChecks;
      varying vec2 vUv;
      ${GLSL_NOISE}
      ${GLSL_TURF}
      void main() {
        vec2 p = (vUv - 0.5) * ${TURF_SPAN.toFixed(1)};
        vec2 lay;
        float st = mplStripe(p, ${(TURF_SPAN / TURF_RES).toFixed(4)}, lay);
        gl_FragColor = vec4(mplTurfMul(p), st);
      }`,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prevRT = gl.getRenderTarget();
  const prevTone = gl.toneMapping;
  gl.toneMapping = THREE.NoToneMapping;
  gl.setRenderTarget(rt);
  gl.render(scene, cam);
  gl.setRenderTarget(prevRT);
  gl.toneMapping = prevTone;
  quad.geometry.dispose();
  mat.dispose();
  byKey.set(key, rt.texture);
  return rt.texture;
};

/* ================================================================== */
/* Instanced grass blades                                              */
/* ================================================================== */

export type GrassDisturb = {
  /** world position of the disturbance centre (y ignored) */
  pos: Vec3;
  /** radius of influence, metres */
  radius: number;
  /** 0..1.5: 1 flattens blades at the centre (a planted boot, a sliding body) */
  strength: number;
  /** optional comb direction (xz used): blades are laid along it (slides). Default: pushed radially out (footsteps). */
  dir?: Vec3;
};

export type GrassBladesProps = {
  /**
   * World centre of the grass window (y ignored). It may move every frame: blades are anchored to the
   * world (they never slide), so a tracking shot simply drags the window along under / ahead of the camera.
   */
  center: Vec3;
  /** window radius, metres; blades shrink to nothing toward the rim so it blends into the ground */
  radius: number;
  /** blades per square metre in the core (default 5000; macro shots up to 9000) */
  density?: number;
  /**
   * radius of the full-density core (default min(radius, 1.5)). Beyond it every doubling of distance keeps
   * a quarter of the blades, drawn wider, so a 6-10 m window for low tracking shots stays affordable.
   */
  core?: number;
  /** 0..1 wind strength */
  wind?: number;
  /** frame number that drives the wind animation */
  F: number;
  /** up to 8 disturbances (footsteps, slides) */
  disturb?: GrassDisturb[];
  /** mean blade height in metres (default 0.022: a match-day outfield cut) */
  height?: number;
  /** wind direction in xz (default [1, 0.35]) */
  windDir?: [number, number];
  /** no blades on the pitch strip (default true) */
  excludePitch?: boolean;
  seed?: number;
};

const MAX_DISTURB = 8;

const GRASS_PARS = /* glsl */ `
uniform vec3 uGrassA;
uniform vec3 uGrassB;
uniform float uStripeW;
uniform float uChecks;
uniform float uTime;
uniform float uWind;
uniform vec2 uWindDir;
uniform vec2 uCenter;
uniform float uRadius;
uniform float uExcludePitch;
uniform vec4 uDist[${MAX_DISTURB}];
uniform vec2 uDistDir[${MAX_DISTURB}];
uniform vec3 uRimDirW;
uniform vec3 uRimColor;
uniform sampler2D uTurf;
attribute vec4 iRoot;   // tile x, tile z, yaw, rank (thinning order)
attribute vec4 iParam;  // height, width, rest lean, colour variation
uniform vec4 uLayer;    // this ring: inner radius, outer radius, tile size, outermost flag
varying vec3 vGCol;
varying vec3 vGGlow;
varying float vGUp;
${GLSL_NOISE}
`;

const GRASS_VERT = /* glsl */ `
  // world anchoring: each instance owns the lattice of points iRoot.xy + k * tile; draw the copy nearest
  // the window centre. Moving the centre never moves a blade; copies swap only where the weight is zero.
  float tile = uLayer.z;
  vec2 dd = iRoot.xy - uCenter;
  dd -= tile * floor(dd / tile + 0.5);
  vec2 rp = uCenter + dd;
  float rr = length(dd);
  float tAlong = position.y;
  // layer cross-fade (density, by rank) and the soft rim of the whole window (height)
  float bIn = 0.15 * uLayer.x;
  float bOut = 0.15 * uLayer.y;
  float keep = (uLayer.x > 0.0 ? smoothstep(uLayer.x - bIn, uLayer.x + bIn, rr) : 1.0)
             * (uLayer.w > 0.5 ? 1.0 : 1.0 - smoothstep(uLayer.y - bOut, uLayer.y + bOut, rr));
  // the rim of the window thins out (dithered by rank) as well as shortening, so it has no edge line
  float rim = 1.0 - smoothstep(uRadius * 0.5, uRadius, rr);
  float vis = clamp((keep * rim * 1.15 - iRoot.w) * 7.0, 0.0, 1.0) * (0.45 + 0.55 * rim);
  // the mown pitch strip (same ragged edge as the ground shader) and the end of the outfield
  if (uExcludePitch > 0.5 && abs(rp.x) < ${(PITCH.width / 2 + 0.2).toFixed(2)} && abs(rp.y) < ${(PITCH.stripLength / 2 + 0.2).toFixed(2)}) {
    float eN = (mplNoise2(rp * vec2(5.0, 0.6)) - 0.5) * 0.05 + (mplNoise2(rp * 31.0) - 0.5) * 0.012;
    float dP = mplSdBox(rp, vec2(0.0), vec2(${(PITCH.width / 2).toFixed(4)} + eN, ${(PITCH.stripLength / 2).toFixed(3)} + eN));
    vis *= smoothstep(-0.005, 0.03, dP);
  }
  vis *= 1.0 - smoothstep(${(FIELD.outfieldRadius - 0.35).toFixed(2)}, ${(FIELD.outfieldRadius - 0.1).toFixed(2)}, length(rp));
  float L = iParam.x * vis;
  vec3 transformed;
  if (L < 1e-5) {
    // culled (outside its ring, thinned, on the pitch): a degenerate point, nothing else to compute
    transformed = vec3(rp.x, -1.0, rp.y);
    objectNormal = vec3(0.0, 1.0, 0.0);
    vGCol = vec3(0.0);
    vGGlow = vec3(0.0);
    vGUp = 1.0;
  } else {
  float yaw = iRoot.z;
  vec2 lay;
  vec4 turf = textureLod(uTurf, rp / ${TURF_SPAN.toFixed(1)} + 0.5, 0.0);
  float stp = turf.a;
  lay = vec2(0.0, stp * 2.0 - 1.0);
  // rest lean follows the mowing lay with a random spread
  vec2 rnd = vec2(cos(yaw * 2.3 + 1.0), sin(yaw * 1.7));
  vec2 B = normalize(lay * 0.8 + rnd * 0.6) * iParam.z;
  // wind: slow gusts rolling across + fast flutter, all from the frame clock
  vec2 wd = normalize(uWindDir);
  float gust = 0.5 + 0.5 * sin(uTime * 1.3 - dot(rp, wd) * 0.9 + sin(dot(rp, vec2(0.31, 0.77)) * 1.7));
  float flutter = sin(uTime * 7.1 + rp.x * 13.0 + rp.y * 9.0 + yaw * 3.0);
  B += wd * uWind * (0.15 + 0.55 * gust) + vec2(-wd.y, wd.x) * uWind * 0.06 * flutter;
  // disturbances push blades out (or comb them along a direction) and flatten them
  float crush = 0.0;
  for (int i = 0; i < ${MAX_DISTURB}; i++) {
    vec4 d = uDist[i];
    if (d.z <= 0.0) continue;
    vec2 off = rp - d.xy;
    float dl = length(off);
    float w = (1.0 - smoothstep(d.z * 0.35, d.z, dl)) * d.w;
    vec2 cd = uDistDir[i];
    vec2 dir = dot(cd, cd) > 1e-6 ? normalize(cd) : (dl > 1e-4 ? off / dl : vec2(1.0, 0.0));
    B = mix(B, dir * 1.5, clamp(w, 0.0, 1.0));
    crush = max(crush, w);
  }
  float th = clamp(length(B), 0.001, 1.5);
  vec2 bd = B / max(length(B), 1e-5);
  vec3 b3 = vec3(bd.x, 0.0, bd.y);
  // circular-arc bend (length preserving)
  float a = th * tAlong;
  float hx = L * (1.0 - cos(a)) / th;
  float hy = L * sin(a) / th;
  vec3 T = vec3(bd.x * sin(a), cos(a), bd.y * sin(a));
  // blade width axis: fixed per blade (does not twist when the wind changes)
  vec2 wv = vec2(cos(yaw), sin(yaw));
  vec3 W3 = normalize(vec3(wv.x, 0.0, wv.y) - T * dot(vec3(wv.x, 0.0, wv.y), T));
  float taper = 1.0 - pow(tAlong, 1.6) * 0.9;
  float wid = iParam.y * taper * step(1e-5, L);
  transformed = vec3(rp.x, 0.0, rp.y) + b3 * hx + vec3(0.0, hy, 0.0) + W3 * position.x * wid;
  // a slight lengthwise fold (V section) so blades catch the light on one half
  transformed += cross(W3, T) * abs(position.x) * wid * 0.35;
  objectNormal = normalize(cross(W3, T) + W3 * sign(position.x + 1e-4) * 0.35);
  // colour: stripe turf colour, dark thatch at the root, lighter tips, per-blade variation
  vec3 base = mix(uGrassB, uGrassA, stp) * MPL_TURF_TINT * turf.rgb;
  float cv = iParam.w;
  vec3 tint = cv > 1.5 ? vec3(2.3, 1.75, 1.0) * (0.75 + 0.25 * (cv - 2.0))                   // straw (dead blade)
            : mix(vec3(1.0), cv > 0.0 ? vec3(1.3, 1.12, 0.55) : vec3(0.8, 1.0, 1.08), abs(cv)); // sun-yellow / deep blue-green
  vGCol = base * tint * mix(0.48, 1.6, smoothstep(0.0, 0.85, tAlong));
  // crushed blades show their pale undersides
  vGCol *= 1.0 + 0.35 * clamp(crush, 0.0, 1.0);
  // translucency: blades glow yellow-green when the camera looks toward the rim light through them
  vec3 toBlade = normalize(transformed - cameraPosition);
  // seen from further away a canopy shades like the turf under it: normals converge to the sky
  vGUp = mix(1.1, 4.5, smoothstep(1.0, 4.5, length(transformed - cameraPosition)));
  float back = smoothstep(0.55, 0.98, dot(toBlade, normalize(uRimDirW)));
  vGGlow = vGCol * vec3(0.75, 1.0, 0.35) * uRimColor * back * 0.16 * smoothstep(0.15, 0.9, tAlong);
  }
`;

const makeGrassMaterial = (u: Record<string, { value: unknown }>) => {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, side: THREE.DoubleSide });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\n" + GRASS_PARS)
      // the normal must be known before beginnormal; compute everything there
      .replace("#include <beginnormal_vertex>", "vec3 objectNormal;\n" + GRASS_VERT)
      .replace("#include <begin_vertex>", "")
      .replace("#include <worldpos_vertex>", "vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vGCol;\nvarying vec3 vGGlow;\nvarying float vGUp;")
      .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.rgb = vGCol;")
      .replace(
        "#include <normal_fragment_begin>",
        `#include <normal_fragment_begin>
        // thin blades: bias the normal toward the sky so overhead floodlights read on both faces
        normal = normalize(normal + (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz * vGUp);`,
      )
      .replace(
        "#include <lights_physical_fragment>",
        `#include <lights_physical_fragment>
        // waxy cuticle: a small, slightly green specular
        material.specularColor = mix(diffuseColor.rgb * 0.45 + 0.008, vec3(0.036), 0.5);
        material.specularColorBlended = material.specularColor; // direct-light F0 (three >= 0.18x)
        material.specularF90 = 0.08;`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += vGGlow;`,
      );
  };
  m.customProgramCacheKey = () => "mpl-grass-v14";
  return m;
};

/** Dark thatch under the blades: the shadowed soil and stems between them, fading out with distance. */
const makeThatchMaterial = (u: Record<string, { value: unknown }>) => {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.95,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWPos;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vWPos;
        uniform vec3 uGrassA;
        uniform vec3 uGrassB;
        uniform float uStripeW;
        uniform float uChecks;
        uniform vec2 uCenter;
        uniform float uRadius;
        uniform float uCore;
        uniform float uExcludePitch;
        uniform sampler2D uTurf;
        ${GLSL_NOISE}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        vec4 tt = texture(uTurf, vWPos.xz / ${TURF_SPAN.toFixed(1)} + 0.5);
        vec3 tc = mix(uGrassB, uGrassA, tt.a) * MPL_TURF_TINT * tt.rgb;
        float n = mplNoise2(vWPos.xz * 60.0) * 0.5 + mplNoise2(vWPos.xz * 210.0) * 0.5;
        diffuseColor.rgb = mix(tc * 0.42, vec3(0.022, 0.03, 0.008), 0.3) * (0.5 + 0.7 * n);
        float rr = length(vWPos.xz - uCenter);
        float a = 0.8 * (1.0 - smoothstep(uCore, min(uRadius, uCore * 2.4), rr));
        if (uExcludePitch > 0.5) a *= smoothstep(0.0, 0.05, mplSdBox(vWPos.xz, vec2(0.0), vec2(${(PITCH.width / 2 + 0.03).toFixed(3)}, ${(PITCH.stripLength / 2 + 0.03).toFixed(3)})));
        diffuseColor.a = a;`,
      )
      .replace(
        "#include <lights_physical_fragment>",
        "#include <lights_physical_fragment>\nmaterial.specularColor = diffuseColor.rgb * 0.15;\nmaterial.specularColorBlended = material.specularColor;\nmaterial.specularF90 = 0.03;",
      );
  };
  m.customProgramCacheKey = () => "mpl-thatch-v7";
  return m;
};

/** One blade template: rows of 2 verts + a tip; x in [-0.5, 0.5] across the blade, y = 0..1 along it. */
const bladeTemplate = (rows: number[]) => {
  const pos: number[] = [];
  rows.forEach((y) => pos.push(-0.5, y, 0.5, y));
  pos.push(0, 1);
  const idx: number[] = [];
  for (let r = 0; r < rows.length - 1; r++) {
    const a = r * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const last = (rows.length - 1) * 2;
  idx.push(last, last + 1, last + 2);
  return { pos, idx, nv: pos.length / 2 };
};

type GrassLayer = { a: number; b: number; tile: number; rho: number; wMul: number; outer: boolean };

/** Concentric LOD rings: [0, core], [core, 2 core], ... up to radius; each keeps 1/4 of the density. */
const grassLayers = (radius: number, core: number, density: number): GrassLayer[] => {
  const out: GrassLayer[] = [];
  let a = 0;
  let b = Math.min(core, radius);
  for (let k = 0; k < 6; k++) {
    const outer = b >= radius - 1e-6 || k === 5;
    out.push({ a, b, tile: 2 * b * 1.15 + 0.1, rho: density / Math.pow(4, k), wMul: Math.pow(1.75, k), outer });
    if (outer) break;
    a = b;
    b = Math.min(radius, b * 2);
  }
  return out;
};

/**
 * Instanced 3D grass for low and macro shots. Blades bend with wind and are pushed by `disturb`.
 * The window (center, radius) can follow a tracking camera; blades stay fixed to the turf.
 */
export const GrassBlades: React.FC<GrassBladesProps> = ({
  center,
  radius,
  density = 5000,
  core,
  wind = 0.4,
  F,
  disturb = [],
  height = 0.022,
  windDir = [1, 0.35],
  excludePitch = true,
  seed = 11,
}) => {
  const coreR = Math.min(radius, core ?? 1.5);
  const gl = useThree((st) => st.gl);
  const uniforms = useMemo(
    () => ({
      uGrassA: { value: linear(PAL.grassA) },
      uGrassB: { value: linear(PAL.grassB) },
      uStripeW: TURF_UNIFORMS.uStripeW,
      uChecks: TURF_UNIFORMS.uChecks,
      uTime: { value: 0 },
      uWind: { value: 0.4 },
      uWindDir: { value: new THREE.Vector2(1, 0.35) },
      uCenter: { value: new THREE.Vector2(0, 0) },
      uRadius: { value: 1 },
      uCore: { value: 1 },
      uExcludePitch: { value: 1 },
      uDist: { value: Array.from({ length: MAX_DISTURB }, () => new THREE.Vector4(0, 0, 0, 0)) },
      uDistDir: { value: Array.from({ length: MAX_DISTURB }, () => new THREE.Vector2(0, 0)) },
      uTurf: TURF_UNIFORMS.uTurf,
      // shared with <StadiumLights/>: blades glow when seen against the shot's rim light
      uRimDirW: RIM_UNIFORMS.uRimDirW,
      uRimColor: RIM_UNIFORMS.uRimColor,
    }),
    [],
  );

  const thatchMat = useMemo(() => makeThatchMaterial(uniforms), [uniforms]);
  const thatchGeo = useMemo(() => {
    const g = new THREE.CircleGeometry(1, 64);
    g.rotateX(-Math.PI / 2);
    return g;
  }, []);

  const geometries = useMemo(() => {
    const r = rng(seed);
    return grassLayers(radius, coreR, density).map((L, k) => {
      // Merged (not instanced) geometry: the software rasterizer pays a large fixed cost per
      // instance, so every blade's vertices are written out with its attributes repeated.
      // Near blades: 3 segments + tip; middle ring: 1 segment + tip; far rings: a single triangle.
      const T = bladeTemplate(k === 0 ? [0, 0.38, 0.72] : k === 1 ? [0, 0.5] : [0]);
      const n = Math.round(L.rho * L.tile * L.tile);
      const pos = new Float32Array(n * T.nv * 3);
      const roots = new Float32Array(n * T.nv * 4);
      const params = new Float32Array(n * T.nv * 4);
      const index = new Uint32Array(n * T.idx.length);
      for (let i = 0; i < n; i++) {
        const hR = r();
        const cv = r();
        const rootV = [r() * L.tile, r() * L.tile, r() * Math.PI * 2, r()];
        const parV = [
            height * (hR < 0.06 ? 1.5 + 4 * hR : 0.5 + 0.95 * hR * hR),
            (0.0014 + 0.0024 * Math.pow(r(), 1.5)) * L.wMul,
            0.2 + 0.85 * r(),
            // colour class: 0 normal, (0, 1] yellow-green, [-1, 0) deep blue-green, [2, 3] dead straw
            cv < 0.035 ? 2 + cv / 0.035 : cv < 0.17 ? 0.35 + (cv - 0.035) * 4.5 : cv > 0.86 ? -0.35 - (cv - 0.86) * 4.5 : 0,
          ];
        const v0 = i * T.nv;
        for (let v = 0; v < T.nv; v++) {
          const o = v0 + v;
          pos[o * 3] = T.pos[v * 2];
          pos[o * 3 + 1] = T.pos[v * 2 + 1];
          roots.set(rootV, o * 4);
          params.set(parV, o * 4);
        }
        const i0 = i * T.idx.length;
        for (let j = 0; j < T.idx.length; j++) index[i0 + j] = v0 + T.idx[j];
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      // the shader builds its own normals, but without a normal attribute three.js switches the material
      // to derivative-based flat normals (edge-on blades then glint white); 3 bytes per vertex avoids that
      g.setAttribute("normal", new THREE.BufferAttribute(new Int8Array(pos.length), 3, true));
      g.setAttribute("iRoot", new THREE.BufferAttribute(roots, 4));
      g.setAttribute("iParam", new THREE.BufferAttribute(params, 4));
      g.setIndex(new THREE.BufferAttribute(index, 1));
      return { g, layer: new THREE.Vector4(L.a, L.b, L.tile, L.outer ? 1 : 0), near: k < 2 };
    });
  }, [density, radius, coreR, height, seed]);
  // one material per ring: shared uniforms, its own uLayer
  const materials = useMemo(
    () => geometries.map((G) => makeGrassMaterial({ ...uniforms, uLayer: { value: G.layer } })),
    [geometries, uniforms],
  );

  // follow the scene's <Field/> mowing pattern (TURF_UNIFORMS); the texture always comes from this
  // renderer's cache (a texture baked by another renderer would read black)
  TURF_UNIFORMS.uTurf.value = getTurfTexture(gl, TURF_UNIFORMS.uStripeW.value, TURF_UNIFORMS.uChecks.value > 0.5);
  uniforms.uTime.value = F / FPS;
  uniforms.uWind.value = wind;
  uniforms.uWindDir.value.set(windDir[0], windDir[1]);
  uniforms.uCenter.value.set(center[0], center[2]);
  uniforms.uRadius.value = radius;
  uniforms.uCore.value = coreR;
  uniforms.uExcludePitch.value = excludePitch ? 1 : 0;
  uniforms.uDist.value.forEach((v, i) => {
    const d = disturb[i];
    if (d) v.set(d.pos[0], d.pos[2], d.radius, d.strength);
    else v.set(0, 0, 0, 0);
    uniforms.uDistDir.value[i].set(d?.dir ? d.dir[0] : 0, d?.dir ? d.dir[2] : 0);
  });

  return (
    <group>
      <mesh
        geometry={thatchGeo}
        material={thatchMat}
        position={[center[0], 0, center[2]]}
        scale={radius}
        receiveShadow
        renderOrder={-1}
      />
      {geometries.map((G, i) => (
        // far rings skip shadow lookups (their blades are a few pixels tall)
        <mesh key={i} geometry={G.g} material={materials[i]} frustumCulled={false} receiveShadow={G.near} />
      ))}
    </group>
  );
};

/** Number of blade instances a GrassBlades window will draw (for budgeting). */
export const grassBladeCount = (radius: number, density = 5000, core = 1.5) =>
  grassLayers(radius, Math.min(radius, core), density).reduce((s, L) => s + Math.round(L.rho * L.tile * L.tile), 0);
