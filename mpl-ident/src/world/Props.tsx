/**
 * Cricket props: <Ball/>, <Bat/>, <Wicket/>.
 *
 * Ball   local frame: centre at origin, the main seam lies in the local XZ plane (equator, normal +Y).
 *        6 rows of stitching (3 per side), quarter seams on each half at 90 deg to each other
 *        (upper half in the x=0 plane, lower half in the z=0 plane). Upper half (+Y) is the shiny side.
 * Bat    local frame: origin at the grip centre (middle of the handle), +Y toward the handle top,
 *        toe toward -Y, face normal +Z (face plane at z = BAT_DIMS.faceZ), back/spine toward -Z.
 *        BAT_SWEET_SPOT is on the face 0.15 m above the toe.
 * Wicket local frame: origin on the ground under the middle stump; stumps along X; see wicketPhysics.ts.
 *        Stump tops are domed with a bail groove along X (STUMP_GROOVE); resting bails lie in the grooves
 *        (spigot axis at BAIL_REST_Y, barrel ~1.07 cm proud of the tops). The pitch shader leaves a hole
 *        round each stump of the standard wickets at z = +-PITCH.stumpsZ.
 */
import React, { useMemo } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { PAL } from "../theme";
import { BALL, BAT, STUMPS } from "./dims";
import { GLSL_NOISE } from "./Field";
import { withStadiumRim } from "./Lights";
import { BAIL, BAIL_REST_X, BAIL_REST_Y, STUMP_GROOVE, STUMP_X, WICKET_REST, type WicketState } from "./wicketPhysics";
import type { Vec3 } from "../rig/types";

const lin = (hex: string) => new THREE.Color(hex);

/* ================================================================== */
/* Procedural night-stadium environment for reflections                */
/* ================================================================== */

const envCache = new WeakMap<THREE.WebGLRenderer, THREE.Texture>();

/**
 * Small HDR equirect of a night stadium (black sky, 8 floodlight banks at ~32 deg, teal LED ring
 * at the horizon, dark stands, green field below) prefiltered with PMREM. Pure function of nothing,
 * built once per renderer. Gives lacquer, paint and clearcoat something believable to reflect.
 */
export const usePropsEnv = (): THREE.Texture => {
  const gl = useThree((s) => s.gl);
  const tex = useMemo(() => {
    const cached = envCache.get(gl);
    if (cached) return cached;
    const W = 256;
    const H = 128;
    const data = new Uint16Array(W * H * 4);
    const toH = THREE.DataUtils.toHalfFloat;
    const flood = new THREE.Color(PAL.floodWhite);
    const teal = new THREE.Color(PAL.teal);
    const grass = new THREE.Color(PAL.grassA);
    const pitch = new THREE.Color(PAL.pitch);
    const stand = new THREE.Color(PAL.graphiteDark);
    for (let y = 0; y < H; y++) {
      const el = Math.PI / 2 - ((y + 0.5) / H) * Math.PI; // +pi/2 top
      for (let x = 0; x < W; x++) {
        const az = ((x + 0.5) / W) * Math.PI * 2;
        let r = 0;
        let g = 0;
        let b = 0;
        if (el < -0.02) {
          // floodlit field: green outfield toward the horizon, the pale pitch right below
          const k = 0.7 * Math.min(1, -el * 3);
          const below = Math.min(1, Math.max(0, (-el - 0.6) * 1.2));
          r = (grass.r * (1 - below) + pitch.r * 0.6 * below) * k;
          g = (grass.g * (1 - below) + pitch.g * 0.6 * below) * k;
          b = (grass.b * (1 - below) + pitch.b * 0.6 * below) * k;
        } else if (el < 0.012) {
          // LED boards
          r = teal.r * 2.2 + 0.05;
          g = teal.g * 2.2 + 0.05;
          b = teal.b * 2.2 + 0.05;
        } else if (el < 0.42) {
          // stands, faintly lit crowd
          const n = Math.sin(az * 180) * Math.sin(el * 260) * 0.5 + 0.5;
          const k = 0.06 + 0.05 * n;
          r = stand.r * k * 8;
          g = stand.g * k * 8;
          b = stand.b * k * 8;
        } else {
          // night sky with a haze glow near the roof line
          const k = 0.012 + 0.05 * Math.exp(-(el - 0.42) * 6);
          r = 0.6 * k;
          g = 0.8 * k;
          b = 0.9 * k;
        }
        // 8 floodlight banks
        for (let i = 0; i < 8; i++) {
          let da = az - (i / 8) * Math.PI * 2;
          da = Math.atan2(Math.sin(da), Math.cos(da));
          const de = el - 0.56;
          const d2 = (da * da) / (0.11 * 0.11) + (de * de) / (0.055 * 0.055);
          if (d2 < 40) {
            const k = 22 * Math.exp(-d2) + 1.2 * Math.exp(-d2 * 0.1);
            r += flood.r * k;
            g += flood.g * k;
            b += flood.b * k;
          }
        }
        const o = (y * W + x) * 4;
        data[o] = toH(r);
        data[o + 1] = toH(g);
        data[o + 2] = toH(b);
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
  }, [gl]);
  return tex;
};

/* ================================================================== */
/* Ball                                                                */
/* ================================================================== */

const R = BALL.radius;
/** Height of the seam ridge above the leather (metres). */
export const BALL_SEAM_HEIGHT = 0.0009;
/** Centre height of a ball resting on a hard surface at y=0 (it can sit on its seam). On grass, BALL.radius is fine. */
export const BALL_REST_Y = R + BALL_SEAM_HEIGHT;

/** Height field of the ball surface (metres) and thread mask. p in local space. */
const GLSL_BALL = /* glsl */ `
uniform float uWear;
uniform mat3 normalMatrix; // object -> view for normals (three sets it per object)
varying vec3 vBP;
${GLSL_NOISE}
const float BR = ${R.toFixed(5)};
const float NST = 82.0;                 // stitches per row
const float BPI = 3.14159265;

// distance (m) from a point at arc offset s (across the row) and phase u (along) to a stitch capsule
float mplStitch(float L, float ds, float slant, float phase, out float m) {
  float P = 2.0 * BPI * BR / NST;
  float u = (L + slant * ds) / P + phase;
  float along = abs(fract(u) - 0.5) * P;
  float d = length(vec2(max(along - 0.00085, 0.0), ds));
  m = 1.0 - smoothstep(0.00028, 0.00046, d);
  return d;
}

float mplBallH(vec3 p, float detail, out float thread, out float band) {
  vec3 d = normalize(p);
  float s = BR * asin(clamp(d.y, -1.0, 1.0));
  float as = abs(s);
  float phi = atan(d.z, d.x);
  float L = phi * BR;
  float h = 0.0;
  thread = 0.0;
  // raised joint where the two halves meet, with a fine centre line
  h += 0.00078 * exp(-pow(as / 0.00115, 2.0));
  h -= 0.0002 * exp(-pow(as / 0.00022, 2.0));
  // stitched band, slightly proud overall
  band = 1.0 - smoothstep(0.0062, 0.0072, as);
  h += 0.00012 * band;
  // three rows each side
  float sgn = s >= 0.0 ? 1.0 : -1.0;
  for (int k = 0; k < 3; k++) {
    float sk = 0.0021 + float(k) * 0.00175;
    float ds = as - sk;
    float m;
    float slant = (k == 1 ? -0.55 : 0.55) * sgn;
    float dist = mplStitch(L, ds, slant, float(k) * 0.33 + (sgn > 0.0 ? 0.0 : 0.5), m);
    // stitch: a rounded thread bump; the leather dimples where the needle went in
    float bump = 0.0003 * sqrt(max(0.0, 1.0 - pow(dist / 0.00048, 2.0)));
    float row = exp(-pow(ds / 0.0005, 2.0));
    h += mix(-0.00007 * row, bump, detail);
    thread = max(thread, mix(row * 0.62, m, detail));
  }
  // quarter seams: upper half in the x=0 plane, lower half in the z=0 plane (90 deg apart)
  float qd = sgn > 0.0 ? abs(d.x) : abs(d.z);
  float qMask = smoothstep(0.0075, 0.0095, as);
  float qs = qd * BR;
  h -= 0.00012 * exp(-pow(qs / 0.00028, 2.0)) * qMask;
  // hidden stitch dimples along the quarter seam
  float qL = (sgn > 0.0 ? atan(d.y, d.z) : atan(d.y, d.x)) * BR;
  float qdim = (1.0 - smoothstep(0.0002, 0.0004, length(vec2(abs(fract(qL / 0.0021) - 0.5) * 0.0021, abs(qs) - 0.0009))));
  h -= 0.00005 * qdim * qMask * detail;
  // leather pebble grain
  float gN = mplNoise3(p * 1100.0) * 0.6 + mplNoise3(p * 2600.0 + 3.0) * 0.4;
  return h;
}
`;

const BALL_VERT_PARS = /* glsl */ `
varying vec3 vBP;
const float BRv = ${R.toFixed(5)};
`;

const BALL_VERT = /* glsl */ `
#include <begin_vertex>
vBP = position;
{
  vec3 dn = normalize(position);
  float sv = abs(BRv * asin(clamp(dn.y, -1.0, 1.0)));
  float hv = 0.00078 * exp(-pow(sv / 0.00115, 2.0)) + 0.00012 * (1.0 - smoothstep(0.0062, 0.0072, sv));
  transformed = dn * (BRv + hv);
}
`;

const BALL_FRAG = /* glsl */ `
#include <color_fragment>
float bfw = length(fwidth(vBP));
// stitch-level detail only while it can be resolved (avoids sparkle on a distant ball)
float bDetail = 1.0 - smoothstep(0.00025, 0.0009, bfw);
float thr0, band0;
float h0 = mplBallH(vBP, bDetail, thr0, band0);
vec3 n0 = normalize(vBP);
vec3 gradH = vec3(0.0);
// seam relief: finite differences, only where there is any (main seam band, quarter seams)
float bAs = abs(asin(clamp(n0.y, -1.0, 1.0))) * BR;
float bQs = (n0.y > 0.0 ? abs(n0.x) : abs(n0.z)) * BR;
if (bAs < 0.0078 || bQs < 0.0016) {
  const float EPS = 0.00006;
  float tA, bA;
  float hx = mplBallH(vBP + vec3(EPS, 0.0, 0.0), bDetail, tA, bA);
  float hy = mplBallH(vBP + vec3(0.0, EPS, 0.0), bDetail, tA, bA);
  float hz = mplBallH(vBP + vec3(0.0, 0.0, EPS), bDetail, tA, bA);
  gradH = vec3(hx - h0, hy - h0, hz - h0) / EPS;
}
// leather pebble grain: analytic gradient, faded with distance
float grainAmt = 0.00008 * bDetail * (1.0 - band0 * 0.6);
if (grainAmt > 0.0) {
  vec4 g1 = mplNoise3D(vBP * 1100.0);
  vec4 g2 = mplNoise3D(vBP * 2600.0 + 3.0);
  gradH += (g1.yzw * 1100.0 * 0.6 + g2.yzw * 2600.0 * 0.4) * grainAmt;
}
gradH -= n0 * dot(gradH, n0);
vec3 nObj = normalize(n0 - gradH);
// leather: deep red, mottled, darker in the pores
vec3 ln = vBP * 140.0;
float mott = mplNoise3(ln);
vec3 leather = mix(vec3(${lin("#6A0F12").toArray().map((v) => v.toFixed(4)).join(",")}), vec3(${lin(PAL.leather).toArray().map((v) => v.toFixed(4)).join(",")}), 0.62 + 0.38 * mott);
leather = mix(leather, vec3(${lin(PAL.leatherHi).toArray().map((v) => v.toFixed(4)).join(",")}), 0.22 + 0.2 * smoothstep(0.5, 0.9, mplNoise3(ln * 0.35 + 2.0)));
float shinySide = smoothstep(-0.002, 0.002, vBP.y);
// rough side: scuffs lighten and dull the leather
float scuff = shinySide < 1.0 ? smoothstep(0.55, 0.85, mplNoise3(vBP * 260.0 + 4.0)) * (1.0 - shinySide) * uWear : 0.0;
leather = mix(leather, vec3(${lin("#8E3A33").toArray().map((v) => v.toFixed(4)).join(",")}), scuff * 0.55);
vec3 threadCol = vec3(${lin("#E6DCC6").toArray().map((v) => v.toFixed(4)).join(",")}) * (thr0 > 0.0 ? 0.86 + 0.14 * mplNoise3(vBP * 900.0) : 1.0);
threadCol = mix(threadCol, leather * 2.2, 0.12 + 0.2 * uWear); // red dye bleeding into the thread
diffuseColor.rgb = mix(leather, threadCol, thr0);
float bRough = mix(mix(0.58, 0.46, shinySide) + scuff * 0.2, 0.78, thr0);
float bCoat = mix(mix(0.3, 0.85, shinySide) * (1.0 - scuff * 0.7), 0.1, thr0);
`;

const makeBallMaterial = (env: THREE.Texture, wearU: { value: number }) => {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.4,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.26,
    envMap: env,
    envMapIntensity: 0.45,
    specularIntensity: 0.5,
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uWear = wearU;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\n" + BALL_VERT_PARS)
      .replace("#include <begin_vertex>", BALL_VERT);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\n" + GLSL_BALL)
      .replace("#include <color_fragment>", BALL_FRAG)
      .replace("#include <roughnessmap_fragment>", "float roughnessFactor = bRough;")
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
        normal = normalize(normalMatrix * nObj) * faceDirection;`,
      )
      .replace(
        "#include <clearcoat_normal_fragment_maps>",
        `#include <clearcoat_normal_fragment_maps>
        clearcoatNormal = normal;`,
      )
      .replace(
        "#include <lights_physical_fragment>",
        `#include <lights_physical_fragment>
        material.clearcoat *= bCoat;`,
      );
  };
  m.customProgramCacheKey = () => "mpl-ball-v6";
  return withStadiumRim(m, 0.07, 6.0);
};

/** Sphere with latitude rows concentrated at the equator where the seam needs them. */
const ballGeometry = (lon: number, lat: number) => {
  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= lat; j++) {
    const u = (j / lat) * 2 - 1; // -1..1
    const th = (Math.PI / 2) * (0.3 * u + 0.7 * u * u * u);
    const cy = Math.sin(th);
    const cr = Math.cos(th);
    for (let i = 0; i <= lon; i++) {
      const ph = (i / lon) * Math.PI * 2;
      const x = cr * Math.cos(ph);
      const z = cr * Math.sin(ph);
      pos.push(x * R, cy * R, z * R);
      nrm.push(x, cy, z);
    }
  }
  for (let j = 0; j < lat; j++) {
    for (let i = 0; i < lon; i++) {
      const a = j * (lon + 1) + i;
      const b = a + lon + 1;
      // counter-clockwise seen from outside (front faces out)
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
};

const ballGeoCache = new Map<string, THREE.BufferGeometry>();
const getBallGeo = (detail: "hero" | "mid" | "low") => {
  const key = detail;
  let g = ballGeoCache.get(key);
  if (!g) {
    g = detail === "hero" ? ballGeometry(384, 200) : detail === "mid" ? ballGeometry(160, 80) : ballGeometry(48, 28);
    ballGeoCache.set(key, g);
  }
  return g;
};

export type BallProps = {
  position?: Vec3;
  /** Euler XYZ rotation in radians (drive it from action time for spin). */
  spin?: Vec3;
  /** "hero" for macro / close-ups, "mid" default, "low" for distant flight */
  detail?: "hero" | "mid" | "low";
  /** 0 = new ball .. 1 = scuffed rough side */
  wear?: number;
  /** soft contact shadow on the ground plane y=0 of the parent (helps it never look floating) */
  groundShadow?: boolean;
  castShadow?: boolean;
  scale?: number;
  /** reflection strength multiplier 0..1 (dim before the floodlights come on). Default 1. */
  env?: number;
};

export const Ball: React.FC<BallProps> = ({
  position = [0, 0, 0],
  spin = [0, 0, 0],
  detail = "mid",
  wear = 0.35,
  groundShadow = false,
  castShadow = true,
  scale = 1,
  env: envAmt = 1,
}) => {
  const env = usePropsEnv();
  const wearU = useMemo(() => ({ value: 0.35 }), []);
  wearU.value = wear;
  const mat = useMemo(() => makeBallMaterial(env, wearU), [env, wearU]);
  mat.envMapIntensity = 0.45 * envAmt;
  const geo = getBallGeo(detail);
  return (
    <>
      <mesh geometry={geo} material={mat} position={position} rotation={spin} scale={scale} castShadow={castShadow} />
      {groundShadow ? <BlobShadow x={position[0]} z={position[2]} height={position[1]} size={R * 2.2 * scale} /> : null}
    </>
  );
};

/* soft radial blob, fades with height */
const blobTex = (() => {
  let t: THREE.DataTexture | null = null;
  return () => {
    if (t) return t;
    const N = 64;
    const d = new Uint8Array(N * N * 4);
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const r = Math.hypot(x - N / 2 + 0.5, y - N / 2 + 0.5) / (N / 2);
        const a = Math.max(0, 1 - r);
        const o = (y * N + x) * 4;
        d[o] = d[o + 1] = d[o + 2] = 0;
        d[o + 3] = Math.round(255 * a * a * (3 - 2 * a));
      }
    t = new THREE.DataTexture(d, N, N);
    t.needsUpdate = true;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
    return t;
  };
})();

const BlobShadow: React.FC<{ x: number; z: number; height: number; size: number }> = ({ x, z, height, size }) => {
  const mat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        map: blobTex(),
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      }),
    [],
  );
  const h = Math.max(0, height);
  const spread = 1 + h * 6;
  mat.opacity = 0.75 / (1 + h * 18);
  return (
    <mesh position={[x, 0.0002, z]} rotation={[-Math.PI / 2, 0, 0]} scale={size * spread} material={mat} renderOrder={1}>
      <planeGeometry args={[1, 1]} />
    </mesh>
  );
};

/* ================================================================== */
/* Bat                                                                 */
/* ================================================================== */

const HANDLE_TOP = BAT.handleLength / 2; // 0.15
const BLADE_TOP = -BAT.handleLength / 2; // -0.15 (where the shoulders meet the handle)
const TOE = BLADE_TOP - BAT.bladeLength; // -0.71
const FACE_Z = 0.021;
const SHOULDER = 0.058; // height of the shoulder curve (face view)
const NECK = 0.14; // length over which the blade thins toward the handle (side view)

export const BAT_DIMS = {
  handleTop: HANDLE_TOP + 0.008,
  bladeTop: BLADE_TOP,
  toe: TOE,
  faceZ: FACE_Z,
  spineZ: FACE_Z - BAT.bladeDepth,
  /** half width of the blade */
  halfWidth: BAT.bladeWidth / 2,
} as const;

/** Local position on the bat face (origin = grip centre) where contact should be placed. */
export const BAT_SWEET_SPOT: Vec3 = [0, TOE + 0.15, FACE_Z];
/** Outward face normal in bat-local space. */
export const BAT_FACE_NORMAL: Vec3 = [0, 0, 1];

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Blade cross-section parameters at height y. */
const bladeSection = (y: number) => {
  const W = BAT.bladeWidth / 2;
  const t = (y - TOE) / BAT.bladeLength; // 0 toe .. 1 top
  // half width: rounded toe corners, parallel sides, sloping shoulders
  const rc = 0.03;
  let w = W;
  if (y < TOE + rc) {
    const dy = TOE + rc - y;
    w = W - rc + Math.sqrt(Math.max(0, rc * rc - dy * dy));
  }
  const yS0 = BLADE_TOP - SHOULDER;
  let us = 0;
  if (y > yS0) {
    us = Math.min(1, (y - yS0) / SHOULDER);
    const rH = 0.0175;
    // rounded corner then a straight-ish slope up to the neck
    w = rH + (W - rH) * Math.pow(Math.max(0, 1 - Math.pow(us, 1.35)), 0.62);
  }
  // edge thickness and spine depth along the length
  const e = BAT.edge * (0.88 + 0.12 * smooth(0, 0.12, t)) * (1 - 0.18 * smooth(0.6, 0.95, t));
  const peak = smooth(0.0, 0.22, t) * (1 - smooth(0.4, 0.97, t));
  let d = e + (BAT.bladeDepth - BAT.edge) * (0.22 + 0.78 * peak);
  d = Math.max(d, e + 0.004);
  let zf = FACE_Z;
  // neck: over the top of the blade the face pulls back and the depth converges to the handle
  const yN0 = BLADE_TOP - NECK;
  const un = y > yN0 ? Math.min(1, (y - yN0) / NECK) : 0;
  if (un > 0) {
    const k = smooth(0, 1, un);
    zf = FACE_Z + (0.0185 - FACE_Z) * Math.pow(un, 2.2);
    d = d + (0.037 - d) * k;
  }
  const eS = Math.min(e, d);
  return { w, e: us > 0 ? eS + (d - eS) * Math.pow(us, 1.2) : Math.min(e, d - 0.002), d, zf, us };
};

/** Half contour (x >= 0) from face centre round the edge to the spine; fixed point count. */
const halfContour = (w: number, e: number, d: number, zf: number, us: number) => {
  const pts: [number, number][] = [];
  const cfMax = Math.min(w, e / 2) * 0.98;
  const cf = 0.0045 + (cfMax - 0.0045) * Math.pow(us, 1.5);
  const cb = Math.min(0.009 + (cfMax - 0.009) * Math.pow(us, 1.5), e - cf);
  const zb = zf - d;
  // face
  const NF = 7;
  for (let i = 0; i < NF; i++) pts.push([(i / NF) * (w - cf), zf]);
  // face-edge corner
  const NC = 6;
  for (let i = 0; i <= NC; i++) {
    const a = (i / NC) * (Math.PI / 2);
    pts.push([w - cf + cf * Math.sin(a), zf - cf + cf * Math.cos(a)]);
  }
  // edge side
  const NE = 3;
  for (let i = 1; i < NE; i++) pts.push([w, zf - cf - ((e - cf - cb) * i) / NE]);
  // edge-back corner
  for (let i = 0; i <= NC; i++) {
    const a = (i / NC) * (Math.PI / 2);
    pts.push([w - cb + cb * Math.cos(a), zf - e + cb - cb * Math.sin(a)]);
  }
  // back profile to the spine ridge
  const NB = 14;
  const x0 = w - cb;
  for (let i = 1; i <= NB; i++) {
    const x = x0 * (1 - i / NB);
    const u = Math.min(1, x / Math.max(1e-4, w));
    // pronounced ridge: flat-ish shoulders of the back rising to a rounded spine
    const ur = Math.sqrt(u * u + 0.0025);
    const ridge = Math.pow(Math.max(0, 1 - ur), 1.7) * (1 + 1.7 * ur);
    const z = zf - e - (d - e) * Math.min(1, ridge / 1.0);
    pts.push([x, Math.max(zb, z)]);
  }
  return pts;
};

const buildBladeGeometry = () => {
  // stations, dense at the toe and shoulders
  const ys: number[] = [];
  const N = 64;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const tt = t < 0.5 ? 0.5 * Math.pow(t * 2, 1.35) : 1 - 0.5 * Math.pow((1 - t) * 2, 1.6);
    ys.push(TOE + tt * BAT.bladeLength);
  }
  const rings: [number, number][][] = [];
  for (const y of ys) {
    const s = bladeSection(y);
    const half = halfContour(s.w, s.e, s.d, s.zf, s.us);
    const full: [number, number][] = [...half];
    for (let i = half.length - 2; i >= 1; i--) full.push([-half[i][0], half[i][1]]);
    rings.push(full);
  }
  const M = rings[0].length;
  const pos: number[] = [];
  const idx: number[] = [];
  // toe bevel rings below the first station
  const bevel = [
    { dy: -0.0025, inset: 0.0018 },
    { dy: -0.0042, inset: 0.0048 },
  ];
  const base = rings[0];
  const cx = 0;
  const cz = base.reduce((a, p) => a + p[1], 0) / base.length;
  const insetRing = (ring: [number, number][], k: number) =>
    ring.map(([x, z]) => {
      const dx = x - cx;
      const dz = z - cz;
      const l = Math.hypot(dx, dz) || 1;
      return [x - (dx / l) * k, z - (dz / l) * k] as [number, number];
    });
  const allRings: { y: number; ring: [number, number][] }[] = [
    ...bevel
      .slice()
      .reverse()
      .map((b) => ({ y: TOE + b.dy, ring: insetRing(base, b.inset) })),
    ...rings.map((ring, i) => ({ y: ys[i], ring })),
  ];
  allRings.forEach(({ y, ring }) => ring.forEach(([x, z]) => pos.push(x, y, z)));
  for (let r = 0; r < allRings.length - 1; r++) {
    for (let i = 0; i < M; i++) {
      const a = r * M + i;
      const b = r * M + ((i + 1) % M);
      const c = (r + 1) * M + i;
      const d = (r + 1) * M + ((i + 1) % M);
      idx.push(a, b, c, b, d, c);
    }
  }
  // flat toe cap (own vertices for a crisp normal)
  const capStart = pos.length / 3;
  const capRing = allRings[0].ring;
  const capY = allRings[0].y;
  pos.push(cx, capY, cz);
  capRing.forEach(([x, z]) => pos.push(x, capY, z));
  for (let i = 0; i < M; i++) idx.push(capStart, capStart + 1 + ((i + 1) % M), capStart + 1 + i);
  // top cap (hidden in the handle)
  const topStart = pos.length / 3;
  const topRing = allRings[allRings.length - 1].ring;
  const topY = allRings[allRings.length - 1].y;
  const tcz = topRing.reduce((a, p) => a + p[1], 0) / topRing.length;
  pos.push(0, topY, tcz);
  topRing.forEach(([x, z]) => pos.push(x, topY, z));
  for (let i = 0; i < M; i++) idx.push(topStart, topStart + 1 + i, topStart + 1 + ((i + 1) % M));

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // the cap normals are averaged only within the cap, but make sure they're exact
  const n = g.getAttribute("normal") as THREE.BufferAttribute;
  for (let i = capStart; i < capStart + M + 1; i++) n.setXYZ(i, 0, -1, 0);
  for (let i = topStart; i < topStart + M + 1; i++) n.setXYZ(i, 0, 1, 0);
  g.computeBoundingSphere();
  return g;
};

const buildHandleGeometry = () => {
  // lathe profile (r, y); the handle is slightly oval (wider across the face)
  const pts: THREE.Vector2[] = [];
  const add = (r: number, y: number) => pts.push(new THREE.Vector2(r, y));
  add(0.0001, BLADE_TOP - 0.03);
  add(0.0158, BLADE_TOP - 0.03);
  add(0.0162, BLADE_TOP);
  // twine binding
  const twTop = BLADE_TOP + 0.026;
  add(0.0168, BLADE_TOP + 0.002);
  add(0.0168, twTop);
  // rubber grip with a soft lip at the bottom
  const gBot = twTop + 0.001;
  add(0.0172, gBot);
  add(0.0188, gBot + 0.004);
  add(0.0186, gBot + 0.012);
  add(0.0184, 0.0);
  add(0.0186, HANDLE_TOP - 0.02);
  add(0.0188, HANDLE_TOP - 0.006);
  // rounded end
  for (let i = 1; i <= 6; i++) {
    const a = (i / 6) * (Math.PI / 2);
    add(0.0188 * Math.cos(a) + 0.0001, HANDLE_TOP - 0.006 + 0.012 * Math.sin(a));
  }
  const g = new THREE.LatheGeometry(pts, 48);
  g.scale(1, 1, 0.9);
  g.computeVertexNormals();
  return g;
};

const BLADE_PARS = /* glsl */ `
varying vec3 vLP;
uniform float uLivery;
${GLSL_NOISE}
`;

const BLADE_FRAG = /* glsl */ `
#include <color_fragment>
vec3 lp = vLP;
// willow grain: growth rings of a tree whose heart lies well behind the blade
float wob = (mplNoise2(vec2(lp.y * 6.0, lp.x * 3.0)) - 0.5) * 0.006 + (mplNoise2(vec2(lp.y * 40.0, lp.x * 9.0)) - 0.5) * 0.0012;
float rr = length(vec2(lp.x - 0.035, lp.z + 0.42)) + wob;
float ring = fract(rr / 0.0095);
float late = smoothstep(0.8, 0.9, ring) * (1.0 - smoothstep(0.93, 1.0, ring));
float fine = mplNoise2(vec2(lp.x * 900.0, lp.y * 25.0));
vec3 willow = vec3(${lin(PAL.willow).toArray().map((v) => v.toFixed(4)).join(",")});
vec3 woodCol = willow * (0.94 + 0.08 * mplNoise2(vec2(lp.x * 30.0, lp.y * 4.0)));
woodCol = mix(woodCol, willow * vec3(0.82, 0.72, 0.55), late * 0.6);
woodCol *= 0.95 + 0.07 * fine;
// splice: V of cane visible on face and back below the shoulders
float vDepth = 0.165;
float vt = clamp((lp.y - (${BLADE_TOP.toFixed(4)} - vDepth)) / vDepth, 0.0, 1.0);
float vHalf = 0.016 * vt;
float inV = step(${(BLADE_TOP - 0.165).toFixed(4)}, lp.y) * (1.0 - smoothstep(vHalf - 0.0004, vHalf + 0.0004, abs(lp.x)));
float vLine = (1.0 - smoothstep(0.0, 0.0007, abs(abs(lp.x) - vHalf))) * step(${(BLADE_TOP - 0.165).toFixed(4)}, lp.y);
woodCol = mix(woodCol, willow * vec3(0.9, 0.78, 0.55), inV * 0.6);
woodCol *= 1.0 - 0.45 * vLine;
// edges and toe pick up grime; ball marks on the face around the middle
float faceSide = smoothstep(${(FACE_Z - 0.004).toFixed(4)}, ${(FACE_Z - 0.001).toFixed(4)}, lp.z);
float edgeSide = smoothstep(${(BAT.bladeWidth / 2 - 0.004).toFixed(4)}, ${(BAT.bladeWidth / 2).toFixed(4)}, abs(lp.x));
woodCol *= 1.0 - 0.1 * edgeSide;
float toeDirt = 1.0 - smoothstep(${TOE.toFixed(4)}, ${(TOE + 0.03).toFixed(4)}, lp.y);
woodCol = mix(woodCol, woodCol * vec3(0.7, 0.66, 0.58), toeDirt * 0.5);
vec2 bmP = vec2(lp.x, lp.y - ${(TOE + 0.17).toFixed(4)});
float bm = 0.0;
for (int k = 0; k < 7; k++) {
  float fk = float(k);
  vec2 c = vec2(sin(fk * 2.4 + 0.7) * 0.03, cos(fk * 1.7 + 0.3) * 0.075);
  float rad = 0.008 + 0.006 * fract(fk * 0.618);
  float dd = length((bmP - c) * vec2(1.0, 0.75)) / rad;
  // a soft disc with a slightly darker rim, like the dye left by the seam
  bm = max(bm, (1.0 - smoothstep(0.75, 1.0, dd)) * (0.45 + 0.55 * smoothstep(0.55, 0.95, dd)) * (0.4 + 0.6 * fract(fk * 0.37 + 0.2)));
}
bm *= 0.6 + 0.4 * mplNoise2(bmP * 300.0);
woodCol = mix(woodCol, vec3(${lin("#A04A3C").toArray().map((v) => v.toFixed(4)).join(",")}), bm * 0.16 * faceSide);
// back livery (no text): graphite panel with a teal pin stripe over the spine
float backSide = 1.0 - smoothstep(${(FACE_Z - BAT.edge - 0.002).toFixed(4)}, ${(FACE_Z - BAT.edge + 0.004).toFixed(4)}, lp.z);
float liv = step(${(TOE + 0.25).toFixed(4)}, lp.y) * (1.0 - step(${(BLADE_TOP - SHOULDER - 0.005).toFixed(4)}, lp.y)) * backSide * uLivery;
float stripe = 1.0 - smoothstep(0.0008, 0.0016, abs(abs(lp.x) - 0.0135));
float strip = 1.0 - smoothstep(0.0125, 0.0135, abs(lp.x));
vec3 livCol = mix(vec3(${lin(PAL.graphite).toArray().map((v) => v.toFixed(4)).join(",")}), vec3(${lin(PAL.teal).toArray().map((v) => v.toFixed(4)).join(",")}), stripe);
float livCut = smoothstep(0.0, 0.0015, (lp.y - ${(TOE + 0.25).toFixed(4)}) - abs(lp.x) * 1.2);
liv *= livCut * max(strip, stripe);
diffuseColor.rgb = mix(woodCol, livCol, liv);
float bladeRough = mix(0.56 - 0.1 * faceSide, 0.34, liv);
float bladeCoat = mix(0.1 + 0.25 * faceSide, 0.8, liv);
`;

const makeBladeMaterial = (env: THREE.Texture, livery: { value: number }) => {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.52,
    clearcoat: 1,
    clearcoatRoughness: 0.42,
    envMap: env,
    envMapIntensity: 0.35,
    specularIntensity: 0.6,
    sheen: 0.25,
    sheenColor: lin(PAL.willow),
    sheenRoughness: 0.6,
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uLivery = livery;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vLP;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvLP = position;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\n" + BLADE_PARS)
      .replace("#include <color_fragment>", BLADE_FRAG)
      .replace("#include <roughnessmap_fragment>", "float roughnessFactor = bladeRough;")
      .replace(
        "#include <lights_physical_fragment>",
        "#include <lights_physical_fragment>\nmaterial.clearcoat *= bladeCoat;",
      );
  };
  m.customProgramCacheKey = () => "mpl-blade-v5";
  return withStadiumRim(m, 0.2, 5.0);
};

const HANDLE_FRAG = /* glsl */ `
#include <color_fragment>
vec3 hp = vHP;
float hAng = atan(hp.z, hp.x);
float twTop = ${(BLADE_TOP + 0.026).toFixed(4)};
float isTwine = 1.0 - step(twTop, hp.y);
// grip: ribbed rubber in a shallow spiral
float rib = 0.5 + 0.5 * sin((hp.y * 520.0 + hAng * 2.0));
vec3 gripCol = vec3(${lin(PAL.graphite).toArray().map((v) => v.toFixed(4)).join(",")}) * (0.8 + 0.35 * rib);
// teal rings: a pair near the bottom, three near the top
float yy = hp.y;
float rings = 0.0;
rings += 1.0 - smoothstep(0.0012, 0.0022, abs(yy - ${(BLADE_TOP + 0.045).toFixed(4)}));
rings += 1.0 - smoothstep(0.0012, 0.0022, abs(yy - ${(BLADE_TOP + 0.054).toFixed(4)}));
rings += 1.0 - smoothstep(0.0016, 0.0026, abs(yy - ${(HANDLE_TOP - 0.03).toFixed(4)}));
rings += 1.0 - smoothstep(0.0012, 0.0022, abs(yy - ${(HANDLE_TOP - 0.041).toFixed(4)}));
rings += 1.0 - smoothstep(0.0012, 0.0022, abs(yy - ${(HANDLE_TOP - 0.05).toFixed(4)}));
rings = clamp(rings, 0.0, 1.0);
gripCol = mix(gripCol, vec3(${lin(PAL.teal).toArray().map((v) => v.toFixed(4)).join(",")}) * 0.75, rings);
// twine: tightly wound cream string
float wind = 0.5 + 0.5 * sin(hp.y * 2400.0);
vec3 twineCol = vec3(${lin("#D9CBA8").toArray().map((v) => v.toFixed(4)).join(",")}) * (0.75 + 0.3 * wind);
diffuseColor.rgb = mix(gripCol, twineCol, isTwine);
float hRough = mix(mix(0.62, 0.4, rings), 0.8, isTwine);
float hSlope = mix(cos(hp.y * 520.0 + hAng * 2.0) * 0.3 * (1.0 - rings), cos(hp.y * 2400.0) * 0.45, isTwine);
`;

const makeHandleMaterial = (env: THREE.Texture) => {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.6,
    envMap: env,
    envMapIntensity: 0.5,
    sheen: 0.4,
    sheenColor: lin(PAL.silver),
    sheenRoughness: 0.5,
  });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vHP;\nvarying vec3 vAxisV;")
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvHP = position;\nvAxisV = normalize((modelViewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vHP;\nvarying vec3 vAxisV;")
      .replace("#include <color_fragment>", HANDLE_FRAG)
      .replace("#include <roughnessmap_fragment>", "float roughnessFactor = hRough;")
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
        // ribs / twine: tilt the normal along the handle axis by the profile slope
        normal = normalize(normal - normalize(vAxisV) * hSlope);`,
      );
  };
  m.customProgramCacheKey = () => "mpl-handle-v1";
  return withStadiumRim(m, 0.45, 4.0);
};

let bladeGeoSingleton: THREE.BufferGeometry | null = null;
let handleGeoSingleton: THREE.BufferGeometry | null = null;

export type BatProps = {
  position?: Vec3;
  rotation?: Vec3;
  /** subtle graphite/teal spine strip on the back (no text). Default false (clean willow). */
  livery?: boolean;
  castShadow?: boolean;
  /** reflection strength multiplier 0..1. Default 1. */
  env?: number;
};

/**
 * A real cricket bat. Origin at the grip centre, +Y to the handle top, toe at -Y, face normal +Z.
 * Place it in a hand slot or with position/rotation.
 */
export const Bat: React.FC<BatProps> = ({ position, rotation, livery = false, castShadow = true, env: envAmt = 1 }) => {
  const env = usePropsEnv();
  const liveryU = useMemo(() => ({ value: 1 }), []);
  liveryU.value = livery ? 1 : 0;
  const bladeMat = useMemo(() => makeBladeMaterial(env, liveryU), [env, liveryU]);
  const handleMat = useMemo(() => makeHandleMaterial(env), [env]);
  bladeMat.envMapIntensity = 0.35 * envAmt;
  handleMat.envMapIntensity = 0.5 * envAmt;
  if (!bladeGeoSingleton) bladeGeoSingleton = buildBladeGeometry();
  if (!handleGeoSingleton) handleGeoSingleton = buildHandleGeometry();
  return (
    <group position={position} rotation={rotation}>
      <mesh geometry={bladeGeoSingleton} material={bladeMat} castShadow={castShadow} />
      <mesh geometry={handleGeoSingleton} material={handleMat} castShadow={castShadow} />
    </group>
  );
};

/* ================================================================== */
/* Wicket                                                              */
/* ================================================================== */

const STUMP_PARS = /* glsl */ `
varying vec3 vSP;
${GLSL_NOISE}
`;
const H_ = STUMPS.height;
const STUMP_FRAG = /* glsl */ `
#include <color_fragment>
float sy = vSP.y;
float sAng = atan(vSP.z, vSP.x);
vec3 white = vec3(${lin(PAL.white).toArray().map((v) => v.toFixed(4)).join(",")});
vec3 tealC = vec3(${lin(PAL.teal).toArray().map((v) => v.toFixed(4)).join(",")});
// gloss paint over ash: the faintest lengthwise grain shows through
float grain = mplNoise2(vec2(sAng * 9.0, sy * 2.5)) * 0.6 + mplNoise2(vec2(sAng * 40.0, sy * 7.0)) * 0.4;
vec3 sc = white * (0.965 + 0.045 * grain);
// soft ball scuffs at ball height (greyish, a hint of leather red)
float scuffZone = smoothstep(0.08, 0.16, sy) * (1.0 - smoothstep(0.48, 0.58, sy));
float scuff = smoothstep(0.74, 0.88, mplNoise2(vec2(sAng * 5.0 + 3.0, sy * 26.0))) * scuffZone;
sc = mix(sc, sc * vec3(0.84, 0.76, 0.75), scuff * 0.45);
// a thin, crisply painted teal band 7.5 cm below the top
float sfw = fwidth(sy) * 0.75 + 0.00015;
float band = smoothstep(-sfw, sfw, 0.0055 - abs(sy - ${(H_ - 0.075).toFixed(4)}));
sc = mix(sc, tealC, band);
// bail grooves: the paint is worn through to the wood where the spigots sit
float inGroove = (1.0 - smoothstep(0.0034, 0.0052, abs(vSP.z))) * smoothstep(${(H_ - 0.0068).toFixed(4)}, ${(H_ - 0.0048).toFixed(4)}, sy);
sc = mix(sc, vec3(${lin(PAL.willow).toArray().map((v) => v.toFixed(4)).join(",")}) * 0.8, inGroove * 0.85);
// grass/soil grime near the base
float grime = 1.0 - smoothstep(0.0, 0.09, sy);
sc = mix(sc, sc * vec3(0.55, 0.6, 0.45), grime * (0.6 + 0.4 * mplNoise2(vec2(sAng * 4.0, sy * 60.0))));
diffuseColor.rgb = sc;
float sRough = mix(0.3 + 0.08 * grain, 0.5, max(scuff * 0.6, inGroove));
float sCoat = (1.0 - inGroove) * (1.0 - band * 0.3);
`;
const makeStumpMaterial = (env: THREE.Texture) => {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.32,
    clearcoat: 0.45,
    clearcoatRoughness: 0.16,
    envMap: env,
    envMapIntensity: 0.3,
    specularIntensity: 0.6,
  });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vSP;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvSP = position;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\n" + STUMP_PARS)
      .replace("#include <color_fragment>", STUMP_FRAG)
      .replace("#include <roughnessmap_fragment>", "float roughnessFactor = sRough;")
      .replace("#include <lights_physical_fragment>", "#include <lights_physical_fragment>\nmaterial.clearcoat *= sCoat;");
  };
  m.customProgramCacheKey = () => "mpl-stump-v3";
  return withStadiumRim(m, 0.1, 6.0);
};

const BAIL_FRAG = /* glsl */ `
#include <color_fragment>
// bail axis is local X (barrel centre at 0)
float bx = vSP.x;
float bAng = atan(vSP.z, vSP.y);
float bfw = fwidth(bx) * 0.75 + 0.00008;
vec3 white = vec3(${lin(PAL.white).toArray().map((v) => v.toFixed(4)).join(",")});
vec3 tealC = vec3(${lin(PAL.teal).toArray().map((v) => v.toFixed(4)).join(",")});
// lacquered paint over turned ash: faint lengthwise grain and fine turning rings (while resolvable)
float grain = mplNoise2(vec2(bAng * 5.0, bx * 160.0)) * 0.6 + mplNoise2(vec2(bAng * 22.0, bx * 420.0)) * 0.4;
float turnF = 1.0 - smoothstep(0.00012, 0.0004, bfw);
float turn = (0.5 + 0.5 * sin(bx * 17000.0 + mplNoise2(vec2(bx * 300.0, 1.0)) * 3.0)) * turnF;
vec3 bc = white * (0.965 + 0.04 * grain - 0.015 * turn);
// thin teal ring round the middle of the barrel
float ring = smoothstep(-bfw, bfw, 0.0023 - abs(bx));
bc = mix(bc, tealC, ring);
// the undersides of the spigots, where they lie in the stump grooves, are worn to the wood
float tipWear = smoothstep(0.0385, 0.0415, abs(bx)) * smoothstep(0.0005, -0.0025, vSP.y);
bc = mix(bc, vec3(${lin(PAL.willow).toArray().map((v) => v.toFixed(4)).join(",")}) * 0.85, tipWear * 0.35);
diffuseColor.rgb = bc;
float bRoughB = 0.28 + 0.06 * grain + 0.1 * tipWear;
`;
const makeBailMaterial = (env: THREE.Texture) => {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.3,
    clearcoat: 0.6,
    clearcoatRoughness: 0.12,
    envMap: env,
    envMapIntensity: 0.35,
    specularIntensity: 0.6,
  });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vSP;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvSP = position;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\n" + STUMP_PARS)
      .replace("#include <color_fragment>", BAIL_FRAG)
      .replace("#include <roughnessmap_fragment>", "float roughnessFactor = bRoughB;");
  };
  m.customProgramCacheKey = () => "mpl-bail-v2";
  return withStadiumRim(m, 0.1, 6.0);
};

/**
 * Stump top (Law 8: domed except for the bail grooves): a shallow dome with a round-bottomed groove
 * running along X (the line of the wicket) that the bail spigots sit in. Height in stump-local metres.
 */
const stumpTopY = (x: number, z: number) => {
  const R = STUMPS.radius;
  const r2 = Math.min(1, (x * x + z * z) / (R * R));
  const dome = STUMPS.height - 0.0035 * r2;
  const g = STUMP_GROOVE;
  const az = Math.abs(z);
  const groove = az < g.radius ? STUMPS.height - g.depth + g.radius - Math.sqrt(g.radius * g.radius - az * az) : 1;
  // smooth minimum: the groove's lips are softened like a cut edge that has been painted over
  const k = 0.0007;
  const hh = Math.max(k - Math.abs(dome - groove), 0) / k;
  return Math.min(dome, groove) - hh * hh * k * 0.25;
};

/**
 * One stump: grooved dome on a cylinder, its base 6 cm in the ground. The top cap is a square grid
 * mapped onto the disc, so its rows run straight along the groove (crisp lips at any size); the
 * rounded rim and the side share the cap's boundary vertices (smooth normals, no seam).
 */
const buildStumpGeometry = () => {
  const R = STUMPS.radius;
  const e = 0.0013; // edge round-over
  const Rt = R - e;
  const N = 36;
  const pos: number[] = [];
  const gi = (i: number, j: number) => j * (N + 1) + i;
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const u = -1 + (2 * i) / N;
      const v = -1 + (2 * j) / N;
      const x = Rt * u * Math.sqrt(1 - (v * v) / 2);
      const z = Rt * v * Math.sqrt(1 - (u * u) / 2);
      pos.push(x, stumpTopY(x, z), z);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) idx.push(gi(i, j), gi(i, j + 1), gi(i + 1, j), gi(i + 1, j), gi(i, j + 1), gi(i + 1, j + 1));
  }
  // boundary loop of the cap, by increasing angle
  const loop: number[] = [];
  for (let i = 0; i < N; i++) loop.push(gi(i, 0));
  for (let j = 0; j < N; j++) loop.push(gi(N, j));
  for (let i = N; i > 0; i--) loop.push(gi(i, N));
  for (let j = N; j > 0; j--) loop.push(gi(0, j));
  const P = loop.length;
  const ang = loop.map((k) => Math.atan2(pos[k * 3 + 2], pos[k * 3]));
  const rimY = loop.map((k) => pos[k * 3 + 1]);
  // rows outside the cap: round-over, then the side down into the ground
  const rows: ((k: number) => [number, number])[] = [];
  for (let s2 = 1; s2 <= 4; s2++) {
    const a = (s2 / 4) * (Math.PI / 2);
    rows.push((k) => [Rt + e * Math.sin(a), rimY[k] - e * (1 - Math.cos(a))]);
  }
  rows.push((k) => [R, rimY[k] - e - 0.004]);
  rows.push(() => [R, 0.25]);
  rows.push(() => [R, 0.0]);
  rows.push(() => [R, -0.06]);
  let prev = loop;
  rows.forEach((row) => {
    const cur: number[] = [];
    for (let k = 0; k < P; k++) {
      const [r, y] = row(k);
      cur.push(pos.length / 3);
      pos.push(r * Math.cos(ang[k]), y, r * Math.sin(ang[k]));
    }
    for (let k = 0; k < P; k++) {
      const k1 = (k + 1) % P;
      idx.push(prev[k], prev[k1], cur[k], prev[k1], cur[k1], cur[k]);
    }
    prev = cur;
  });
  const bottom = pos.length / 3;
  pos.push(0, -0.06, 0);
  for (let k = 0; k < P; k++) idx.push(bottom, prev[k], prev[(k + 1) % P]);
  // orient every triangle outward (up on the cap, radially on the rim and side, down at the base)
  const vtx = (n: number) => new THREE.Vector3(pos[n * 3], pos[n * 3 + 1], pos[n * 3 + 2]);
  for (let t = 0; t < idx.length; t += 3) {
    const a = vtx(idx[t]);
    const b = vtx(idx[t + 1]);
    const c = vtx(idx[t + 2]);
    const n = b.clone().sub(a).cross(c.clone().sub(a));
    const cen = a.add(b).add(c).divideScalar(3);
    const rc = Math.hypot(cen.x, cen.z);
    const out =
      cen.y < -0.059 ? new THREE.Vector3(0, -1, 0) : rc < Rt - 1e-4 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(cen.x, cen.y > 0.5 ? 0.01 : 0, cen.z);
    if (n.dot(out) < 0) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
};

/**
 * Bail along local X, barrel centre at origin, long spigot toward -X. A turned profile: rounded
 * spigot ends, filleted shoulders, a beaded barrel with a slight swell (reads at frame-filling size).
 */
const buildBailGeometry = () => {
  const { longSpigot: ls, barrel: br, shortSpigot: ss, spigotRadius: sr, barrelRadius: rr } = BAIL;
  const yL = -br / 2 - ls; // long spigot end
  const yS = br / 2 + ss; // short spigot end
  const pts: THREE.Vector2[] = [];
  const add = (r: number, y: number) => pts.push(new THREE.Vector2(r, y));
  const NE = 8;
  // rounded long spigot end (slightly flattened dome)
  for (let i = 0; i <= NE; i++) {
    const a = (i / NE) * (Math.PI / 2);
    add(0.00005 + sr * 0.96 * Math.sin(a), yL + sr * 0.8 * (1 - Math.cos(a)));
  }
  add(sr, yL + sr * 1.2);
  add(sr * 0.985, -br / 2 - 0.009);
  // half barrel profile from its end (u = 0) to its centre (u = br/2); mirrored for the other half
  const half: [number, number][] = [];
  // fillet out of the spigot into the barrel's end face
  for (let i = 0; i <= 5; i++) {
    const a = (i / 5) * (Math.PI / 2);
    half.push([sr + (rr * 0.78 - sr) * (1 - Math.cos(a)), -0.006 + 0.006 * Math.sin(a)]);
  }
  half.push([rr * 0.9, 0.0012]);
  half.push([rr * 0.98, 0.003]);
  // bead
  half.push([rr * 1.02, 0.0045]);
  half.push([rr * 1.02, 0.0058]);
  half.push([rr * 0.985, 0.0068]);
  // turned V-groove
  half.push([rr * 0.93, 0.0079]);
  half.push([rr * 0.985, 0.009]);
  // swelling body
  for (let i = 0; i <= 6; i++) {
    const u = 0.0105 + ((br / 2 - 0.0105) * i) / 6;
    const k = (u - 0.0105) / (br / 2 - 0.0105);
    half.push([rr * (1.0 + 0.055 * Math.sin((k * Math.PI) / 2)), u]);
  }
  half.forEach(([r, u]) => add(r, -br / 2 + u));
  for (let i = half.length - 2; i >= 0; i--) add(half[i][0], br / 2 - half[i][1]);
  add(sr * 0.985, br / 2 + 0.009);
  add(sr, yS - sr * 1.2);
  for (let i = NE; i >= 0; i--) {
    const a = (i / NE) * (Math.PI / 2);
    add(0.00005 + sr * 0.96 * Math.sin(a), yS - sr * 0.8 * (1 - Math.cos(a)));
  }
  const g = new THREE.LatheGeometry(pts, 72);
  g.rotateZ(-Math.PI / 2); // lathe Y axis -> +X ... long spigot (-y) -> -X
  g.computeVertexNormals();
  return g;
};

let stumpGeo: THREE.BufferGeometry | null = null;
let bailGeo: THREE.BufferGeometry | null = null;

export type WicketProps = {
  /** ground point under the middle stump */
  position?: Vec3;
  rotationY?: number;
  /** from wicketHitState(); default intact */
  state?: WicketState;
  castShadow?: boolean;
  /** reflection strength multiplier 0..1. Default 1. */
  env?: number;
};

/** 3 stumps + 2 bails (white, thin teal band near the top). */
export const Wicket: React.FC<WicketProps> = ({
  position = [0, 0, 0],
  rotationY = 0,
  state = WICKET_REST,
  castShadow = true,
  env: envAmt = 1,
}) => {
  const env = usePropsEnv();
  const stumpMat = useMemo(() => makeStumpMaterial(env), [env]);
  const bailMat = useMemo(() => makeBailMaterial(env), [env]);
  stumpMat.envMapIntensity = 0.3 * envAmt;
  bailMat.envMapIntensity = 0.3 * envAmt;
  if (!stumpGeo) stumpGeo = buildStumpGeometry();
  if (!bailGeo) bailGeo = buildBailGeometry();
  const sg = stumpGeo;
  const bg = bailGeo;
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {state.stumps.map((s, i) => (
        <group key={`s${i}`} position={[STUMP_X[i] + s.offset[0], s.offset[1], s.offset[2]]} quaternion={s.quaternion}>
          <mesh geometry={sg} material={stumpMat} castShadow={castShadow} />
        </group>
      ))}
      {state.bails.map((b, i) => (
        <mesh key={`b${i}`} geometry={bg} material={bailMat} position={b.position} quaternion={b.quaternion} castShadow={castShadow} />
      ))}
    </group>
  );
};

/** Rest transforms of the bails, exported for shots that need exact contact points. */
export const WICKET_GEOM = { STUMP_X, BAIL_REST_X, BAIL_REST_Y, height: STUMPS.height } as const;
