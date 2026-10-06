/**
 * Field & turf: outfield, pitch strip, crease markings, 30-yard circle, boundary rope
 * and instanced 3D grass blades for low / macro shots.
 *
 * Everything is a pure function of props (+ frame for wind), built once in useMemo.
 * Coordinates: metres, Y up, field centre at the origin, pitch along Z (see dims.ts).
 *
 *   <Field />                                     // whole ground, receives shadows
 *   <GrassBlades center={[3, 0, -2]} radius={1.6} wind={0.5} F={F}
 *                disturb={[{ pos: [3.2, 0, -1.8], radius: 0.35, strength: 1 }]} />
 *
 * Grass blades do not cast shadows (the depth pass would not see the bend); they receive them.
 */
import React, { useMemo } from "react";
import * as THREE from "three";
import { rng } from "../config";
import { PAL } from "../theme";
import { FIELD, PITCH } from "./dims";
import type { Vec3 } from "../rig/types";

/* ================================================================== */
/* Shared GLSL                                                         */
/* ================================================================== */

/** Integer-hash value noise (stable at any world coordinate), with analytic derivatives. */
export const GLSL_NOISE = /* glsl */ `
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
vec3 mplTurfBase(vec2 p, float st) {
  vec3 c = mix(uGrassB, uGrassA, st);
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
  float lane = mplNoise2(vec2(floor(p.x / 3.05) * 7.3, 2.0));
  c = mix(c, c * vec3(1.07, 1.06, 0.93) * (0.97 + 0.07 * lane), sq * 0.7);
  // bowlers' run-ups are worn
  float az = abs(p.y);
  float run = (1.0 - smoothstep(0.9, 1.6, abs(p.x))) * smoothstep(10.8, 11.6, az) * (1.0 - smoothstep(18.0, 30.0, az));
  c = mix(c, c * vec3(1.16, 1.08, 0.78), run * (0.45 + 0.35 * mplNoise2(p * 2.3)));
  return c;
}
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
${GLSL_NOISE}
${GLSL_TURF}

float mplCov(float d, float w) { return clamp(0.5 - d / max(w, 1e-5), 0.0, 1.0); }

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
  vec3 c = mplTurfBase(p, st);

  // view-dependent stripe: blades laid away from the viewer look lighter
  vec2 vh = V.xz / max(length(V.xz), 1e-4);
  float graze = clamp(1.0 - V.y, 0.0, 1.0);
  c *= 1.0 + 0.13 * dot(lay, -vh) * (0.3 + 0.7 * graze);

  // multi-scale clump/tuft detail, faded out once a noise cell is sub-pixel (no shimmer)
  vec2 pl = vec2(p.x, p.y * 0.55);               // tufts are a little stretched along the lay
  vec2 grad = vec2(0.0);
  float v = 0.0;
  float f1 = 1.0 - smoothstep(0.25, 0.6, fdet * 3.0);
  vec3 n1 = mplNoise2D(pl * 3.0 + 11.0);
  v += (n1.x - 0.5) * 0.12 * f1;  grad += n1.yz * vec2(3.0, 1.65) * 0.004 * f1;
  float f2 = 1.0 - smoothstep(0.25, 0.6, fdet * 14.0);
  vec3 n2 = mplNoise2D(pl * 14.0 + 3.0);
  v += (n2.x - 0.5) * 0.16 * f2;  grad += n2.yz * vec2(14.0, 7.7) * 0.0016 * f2;
  float f3 = 1.0 - smoothstep(0.25, 0.6, fdet * 55.0);
  vec3 n3 = mplNoise2D(vec2(p.x, p.y * 0.4) * 55.0 + 7.0);
  v += (n3.x - 0.5) * 0.2 * f3;   grad += n3.yz * vec2(55.0, 22.0) * 0.0007 * f3;
  float f4 = 1.0 - smoothstep(0.25, 0.6, fdet * 190.0);
  vec3 n4 = mplNoise2D(vec2(p.x, p.y * 0.35) * 190.0 + 1.0);
  v += (n4.x - 0.5) * 0.22 * f4;  grad += n4.yz * vec2(190.0, 66.0) * 0.00022 * f4;
  // the average of the faded detail (soil showing between blades) when seen from far
  c *= 1.0 + v;
  // looking straight down we see more of the dark thatch between blades
  c *= mix(0.86, 1.04, graze);
  float rough = 0.86 - 0.06 * graze + 0.05 * v;

  // ---- pitch strip ----
  float edgeN = (mplNoise2(p * vec2(5.0, 0.6)) - 0.5) * 0.05 + (mplNoise2(p * 31.0) - 0.5) * 0.025;
  float dP = mplSdBox(p, vec2(0.0), vec2(${(PITCH.width / 2).toFixed(4)} + edgeN, ${(PITCH.stripLength / 2).toFixed(3)} + edgeN));
  float pm = 1.0 - smoothstep(-0.06, 0.04 + fpx, dP);
  if (pm > 0.0) {
    vec3 pc = uPitchCol;
    float az = abs(p.y);
    float b1 = mplNoise2(p * vec2(1.1, 0.33));
    float b2 = mplNoise2(p * 4.0 + 5.0);
    pc *= 0.9 + 0.12 * b1 + 0.06 * b2;
    // live grass left on the surface (more toward the edges, less where it's worn)
    float grassy = smoothstep(0.35, 0.8, mplNoise2(p * vec2(2.6, 0.9) + 2.0)) * 0.35
                 + smoothstep(1.0, 1.52, abs(p.x)) * 0.35;
    float wearZone = smoothstep(5.8, 7.6, az) * (1.0 - smoothstep(10.8, 11.1, az));
    grassy *= 1.0 - 0.7 * wearZone;
    pc = mix(pc, vec3(0.16, 0.2, 0.07), clamp(grassy, 0.0, 0.6) * 0.45);
    // ends: scuffed, darker and redder where bowlers land and batsmen take guard
    float scuffN = mplNoise2(p * vec2(7.0, 3.0) + 13.0);
    float foot = (1.0 - smoothstep(0.25, 0.75, abs(p.x - 0.05 * sign(p.y)))) * smoothstep(8.0, 8.6, az) * (1.0 - smoothstep(10.0, 10.6, az));
    float guard = (1.0 - smoothstep(0.08, 0.3, abs(p.x + 0.06))) * smoothstep(8.5, 8.75, az) * (1.0 - smoothstep(9.6, 10.0, az));
    float scuff = clamp(wearZone * 0.35 + foot * 0.85 + guard * 0.5, 0.0, 1.0) * (0.45 + 0.55 * scuffN);
    pc = mix(pc, pc * vec3(0.72, 0.62, 0.52), scuff * 0.8);
    // ball marks on a good length
    vec2 bmCell = floor(p * vec2(3.0, 3.0));
    float bmh = mplHash2(ivec2(bmCell) + 77);
    vec2 bmc = (bmCell + 0.2 + 0.6 * vec2(mplHash2(ivec2(bmCell) + 7), mplHash2(ivec2(bmCell) + 9))) / 3.0;
    float lengthZone = smoothstep(1.5, 3.0, az) * (1.0 - smoothstep(7.0, 8.0, az)) * (1.0 - smoothstep(0.5, 0.9, abs(p.x)));
    float bm = (1.0 - smoothstep(0.012, 0.03, length(p - bmc))) * step(0.72, bmh) * lengthZone;
    pc *= 1.0 - 0.28 * bm;
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
      float crack = (1.0 - smoothstep(0.0, 0.018, edge)) * crackAmt * fc;
      pc *= 1.0 - 0.32 * crack;
    }
    // dusty mottle and small dark spots (moisture, old footmarks)
    float mot = mplNoise2(p * 11.0 + 2.0) * 0.5 + mplNoise2(p * 37.0 + 8.0) * 0.5;
    float motF = 1.0 - smoothstep(0.25, 0.6, fpx * 37.0);
    pc *= 1.0 + (mot - 0.5) * 0.1 * motF;
    float spots = smoothstep(0.8, 0.92, mplNoise2(p * 26.0 + 17.0)) * (1.0 - smoothstep(0.25, 0.6, fpx * 26.0));
    pc *= 1.0 - 0.06 * spots;
    // fine grit, sand grains and the odd dead grass fleck
    float fg = 1.0 - smoothstep(0.25, 0.6, fpx * 220.0);
    float fg2 = 1.0 - smoothstep(0.25, 0.6, fpx * 700.0);
    vec3 gr1 = mplNoise2D(p * 220.0);
    vec3 gr2 = mplNoise2D(p * 700.0 + 3.0);
    pc *= 1.0 + (gr1.x - 0.5) * 0.14 * fg + (gr2.x - 0.5) * 0.16 * fg2;
    float fleck = smoothstep(0.86, 0.95, mplNoise2(p * 160.0 + 9.0)) * fg;
    pc = mix(pc, vec3(0.16, 0.16, 0.06), fleck * 0.35 * (1.0 - wearZone));
    // pitch bump: rolled flat, gentle, with a fine crumb
    vec3 pn = mplNoise2D(p * 9.0 + 3.0);
    vec3 pn2 = mplNoise2D(p * 85.0 + 1.0);
    vec2 pgrad = pn.yz * 9.0 * 0.0011 * f2 + pn2.yz * 85.0 * 0.00035 * (1.0 - smoothstep(0.25, 0.6, fpx * 85.0))
               + gr1.yz * 220.0 * 0.00008 * fg + gr2.yz * 700.0 * 0.00002 * fg2;
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
        material.specularColor = mix(diffuseColor.rgb * 0.2 + 0.004, vec3(0.04), gS.spec);
        material.specularF90 = mix(0.035, 0.6, gS.spec);`,
      );
  };
  m.customProgramCacheKey = () => "mpl-ground-v7";
  return m;
};

/* ================================================================== */
/* Boundary rope and 30-yard markers                                   */
/* ================================================================== */

const makeRopeMaterial = () => {
  const m = new THREE.MeshPhysicalMaterial({
    color: linear(PAL.white),
    roughness: 0.7,
    metalness: 0,
    sheen: 0.8,
    sheenColor: linear(PAL.silver),
    sheenRoughness: 0.35,
  });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vRopeP;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvRopeP = position;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vRopeP;")
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        float ang = atan(vRopeP.z, vRopeP.x);
        float sl = ang * ${FIELD.boundary.toFixed(1)};           // metres along the rope
        float seg = abs(fract(sl / 3.0) - 0.5) * 3.0;             // distance to a segment joint
        float joint = 1.0 - smoothstep(0.0, 0.03, seg);
        float rr = length(vRopeP.xz) - ${FIELD.boundary.toFixed(1)};
        // quilted padding: soft stitched channels running along the cushion
        float quilt = 0.5 + 0.5 * cos(rr / 0.11 * 3.14159 * 2.0);
        float weave = 0.5 + 0.5 * sin(sl * 420.0) * sin(vRopeP.y * 420.0);
        diffuseColor.rgb *= (0.9 + 0.1 * quilt) * (0.97 + 0.03 * weave) * (1.0 - 0.3 * joint);
        // a thin teal piping along the top seam (the only colour on the rope)
        float pipe = 1.0 - smoothstep(0.003, 0.006, abs(rr));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(${new THREE.Color(PAL.teal).toArray().map((v) => v.toFixed(4)).join(",")}), pipe * step(0.1, vRopeP.y) * 0.85);
        // grime where it meets the turf
        diffuseColor.rgb *= mix(0.6, 1.0, smoothstep(0.0, 0.05, vRopeP.y));`,
      );
  };
  m.customProgramCacheKey = () => "mpl-rope-v3";
  return m;
};

/** Padded boundary cushion: rounded trapezoid profile swept round the boundary, pinched at joints. */
const buildRopeGeometry = (segs: number) => {
  const W = 0.11; // half width at the base
  const H = 0.13; // height
  const prof: [number, number][] = [];
  const N = 20;
  for (let i = 0; i <= N; i++) {
    // superellipse-ish dome from the inner base round the top to the outer base
    const a = Math.PI * (1 - i / N);
    const c = Math.cos(a);
    const sn = Math.sin(a);
    const x = Math.sign(c) * Math.pow(Math.abs(c), 0.7) * W * (1 - 0.18 * sn);
    const y = Math.pow(sn, 0.8) * H;
    prof.push([x, y]);
  }
  const pos: number[] = [];
  const idx: number[] = [];
  const P = prof.length;
  const seg = 3.0; // cushion length, metres
  for (let j = 0; j <= segs; j++) {
    const ang = (j / segs) * Math.PI * 2;
    const sl = ang * FIELD.boundary;
    const dj = Math.abs((((sl / seg) % 1) + 1) % 1 - 0.5) * seg; // distance to a joint
    const pinch = 1 - 0.1 * Math.exp(-((dj / 0.07) ** 2));
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    for (const [px, py] of prof) {
      const r = FIELD.boundary + px * pinch;
      pos.push(r * ca, Math.max(0, py * pinch) - 0.004, r * sa);
    }
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
      uStripeW: { value: 5 },
      uChecks: { value: 0 },
      uRing30: { value: 0 },
    }),
    [],
  );
  uniforms.uStripeW.value = stripeWidth;
  uniforms.uChecks.value = pattern === "checks" ? 1 : 0;
  uniforms.uRing30.value = ring30Paint;

  const ground = useMemo(() => {
    const g = new THREE.CircleGeometry(FIELD.outfieldRadius, 192);
    g.rotateX(-Math.PI / 2);
    return g;
  }, []);
  const groundMat = useMemo(() => makeGroundMaterial(uniforms), [uniforms]);

  const ropeSegs = detail === "near" ? 2048 : 900;
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
  /** world centre of the patch (y ignored, blades grow from y=0) */
  center: Vec3;
  /** patch radius, metres; blades shrink to nothing toward the edge so it blends into the ground */
  radius: number;
  /** blades per square metre (default 5000; macro shots up to 9000) */
  density?: number;
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
  /** skip blades on the pitch strip (default true) */
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
uniform float uRadius;
uniform vec4 uDist[${MAX_DISTURB}];
uniform vec2 uDistDir[${MAX_DISTURB}];
attribute vec3 iRoot;   // local x, local z, yaw
attribute vec4 iParam;  // height, width, rest lean, colour variation
varying vec3 vGCol;
${GLSL_NOISE}
${GLSL_TURF}
`;

const GRASS_VERT = /* glsl */ `
  vec3 wRoot = (modelMatrix * vec4(iRoot.x, 0.0, iRoot.y, 1.0)).xyz;
  vec2 rp = wRoot.xz;
  float tAlong = position.y;
  float edge = 1.0 - smoothstep(0.55, 1.0, length(iRoot.xy) / uRadius);
  float L = iParam.x * edge;
  float yaw = iRoot.z;
  vec2 lay;
  float stp = mplStripe(rp, 0.01, lay);
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
  vec3 transformed = vec3(iRoot.x, 0.0, iRoot.y) + b3 * hx + vec3(0.0, hy, 0.0) + W3 * position.x * iParam.y * taper;
  objectNormal = normalize(cross(W3, T));
  // colour: stripe turf colour, dark thatch at the root, lighter tips, per-blade variation
  vec3 base = mplTurfBase(rp, stp);
  float cv = iParam.w;
  vec3 tint = mix(vec3(1.0), cv > 0.0 ? vec3(1.28, 1.12, 0.62) : vec3(0.86, 1.04, 1.1), abs(cv));
  vGCol = base * tint * mix(0.55, 1.55, smoothstep(0.0, 0.8, tAlong));
  // crushed blades show their pale undersides and bruise slightly
  vGCol *= 1.0 + 0.35 * clamp(crush, 0.0, 1.0);
`;

const makeGrassMaterial = (u: Record<string, { value: unknown }>) => {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.72, side: THREE.DoubleSide });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\n" + GRASS_PARS)
      // the normal must be known before beginnormal; compute everything there
      .replace("#include <beginnormal_vertex>", "vec3 objectNormal;\n" + GRASS_VERT)
      .replace("#include <begin_vertex>", "")
      .replace("#include <worldpos_vertex>", "vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vGCol;")
      .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.rgb = vGCol;")
      .replace(
        "#include <normal_fragment_begin>",
        `#include <normal_fragment_begin>
        // thin blades: bias the normal toward the sky so overhead floodlights read on both faces
        normal = normalize(normal + (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz * 1.3);`,
      )
      .replace(
        "#include <lights_physical_fragment>",
        `#include <lights_physical_fragment>
        material.specularColor = diffuseColor.rgb * 0.3 + 0.008;
        material.specularF90 = 0.08;`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        // cheap translucency: blades glow a little when seen against the light
        totalEmissiveRadiance += vGCol * 0.06;`,
      );
  };
  m.customProgramCacheKey = () => "mpl-grass-v7";
  return m;
};

/** Dark thatch under a blade patch: the shadowed soil/stems between blades, fading at the rim. */
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
      .replace("#include <common>", "#include <common>\nvarying vec3 vWPos;\nvarying vec2 vLoc;")
      .replace(
        "#include <worldpos_vertex>",
        "#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvLoc = position.xz;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vWPos;
        varying vec2 vLoc;
        uniform vec3 uGrassA;
        uniform vec3 uGrassB;
        uniform float uStripeW;
        uniform float uChecks;
        uniform float uRadius;
        ${GLSL_NOISE}
        ${GLSL_TURF}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        vec2 lay;
        float st = mplStripe(vWPos.xz, 0.01, lay);
        vec3 tc = mplTurfBase(vWPos.xz, st);
        float n = mplNoise2(vWPos.xz * 60.0) * 0.5 + mplNoise2(vWPos.xz * 210.0) * 0.5;
        diffuseColor.rgb = tc * vec3(0.7, 0.66, 0.55) * (0.65 + 0.6 * n);
        diffuseColor.a = (1.0 - smoothstep(0.55, 0.95, length(vLoc))) * 0.85;`,
      )
      .replace(
        "#include <lights_physical_fragment>",
        "#include <lights_physical_fragment>\nmaterial.specularColor = diffuseColor.rgb * 0.15;\nmaterial.specularF90 = 0.03;",
      );
  };
  m.customProgramCacheKey = () => "mpl-thatch-v4";
  return m;
};

const bladeGeometry = () => {
  // 4 rows of 2 verts + tip; x in [-0.5, 0.5] across the blade, y = 0..1 along it
  const rows = [0, 0.32, 0.6, 0.83];
  const pos: number[] = [];
  rows.forEach((y) => pos.push(-0.5, y, 0, 0.5, y, 0));
  pos.push(0, 1, 0);
  const idx: number[] = [];
  for (let r = 0; r < rows.length - 1; r++) {
    const a = r * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const last = (rows.length - 1) * 2;
  idx.push(last, last + 1, last + 2);
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(new Array(pos.length).fill(0), 3));
  g.setIndex(idx);
  return g;
};

/** Instanced 3D grass for low and macro shots. Blades bend with wind and are pushed by `disturb`. */
export const GrassBlades: React.FC<GrassBladesProps> = ({
  center,
  radius,
  density = 5000,
  wind = 0.4,
  F,
  disturb = [],
  height = 0.022,
  windDir = [1, 0.35],
  excludePitch = true,
  seed = 11,
}) => {
  const uniforms = useMemo(
    () => ({
      uGrassA: { value: linear(PAL.grassA) },
      uGrassB: { value: linear(PAL.grassB) },
      uStripeW: { value: 5 },
      uChecks: { value: 0 },
      uTime: { value: 0 },
      uWind: { value: 0.4 },
      uWindDir: { value: new THREE.Vector2(1, 0.35) },
      uRadius: { value: 1 },
      uDist: { value: Array.from({ length: MAX_DISTURB }, () => new THREE.Vector4(0, 0, 0, 0)) },
      uDistDir: { value: Array.from({ length: MAX_DISTURB }, () => new THREE.Vector2(0, 0)) },
    }),
    [],
  );
  const material = useMemo(() => makeGrassMaterial(uniforms), [uniforms]);
  const thatchMat = useMemo(() => makeThatchMaterial(uniforms), [uniforms]);
  const thatchGeo = useMemo(() => {
    const g = new THREE.CircleGeometry(1, 48);
    g.rotateX(-Math.PI / 2);
    return g;
  }, []);

  const cx = center[0];
  const cz = center[2];
  const geometry = useMemo(() => {
    const g = bladeGeometry();
    const r = rng(seed);
    const target = Math.round(density * Math.PI * radius * radius);
    const roots: number[] = [];
    const params: number[] = [];
    const px = PITCH.width / 2 + 0.03;
    const pz = PITCH.stripLength / 2 + 0.03;
    for (let i = 0; i < target; i++) {
      const a = r() * Math.PI * 2;
      const d = Math.sqrt(r()) * radius;
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d;
      const yaw = r() * Math.PI * 2;
      const hRand = r();
      const wRand = r();
      const lean = r();
      const cv = r();
      if (excludePitch && Math.abs(cx + x) < px && Math.abs(cz + z) < pz) continue;
      roots.push(x, z, yaw);
      params.push(
        height * (0.55 + 0.9 * hRand * hRand),
        0.0022 + 0.0018 * wRand,
        0.35 + 0.6 * lean,
        cv < 0.12 ? 0.5 + cv * 3 : cv > 0.85 ? -(cv - 0.85) * 5 : 0,
      );
    }
    g.setAttribute("iRoot", new THREE.InstancedBufferAttribute(new Float32Array(roots), 3));
    g.setAttribute("iParam", new THREE.InstancedBufferAttribute(new Float32Array(params), 4));
    g.instanceCount = roots.length / 3;
    return g;
  }, [density, radius, height, seed, excludePitch, cx, cz]);

  uniforms.uTime.value = F / 30;
  uniforms.uWind.value = wind;
  uniforms.uWindDir.value.set(windDir[0], windDir[1]);
  uniforms.uRadius.value = radius;
  uniforms.uDist.value.forEach((v, i) => {
    const d = disturb[i];
    if (d) v.set(d.pos[0], d.pos[2], d.radius, d.strength);
    else v.set(0, 0, 0, 0);
    uniforms.uDistDir.value[i].set(d?.dir ? d.dir[0] : 0, d?.dir ? d.dir[2] : 0);
  });

  return (
    <group position={[cx, 0, cz]}>
      <mesh geometry={thatchGeo} material={thatchMat} scale={radius} receiveShadow renderOrder={-1} />
      <mesh geometry={geometry} material={material} frustumCulled={false} receiveShadow />
    </group>
  );
};
