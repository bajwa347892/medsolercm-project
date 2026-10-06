/**
 * Night stadium lighting recipe (SPEC §5) plus the floodlight-bank geometry shared by
 * Stadium.tsx (lamp heads, volumetric beams) and Atmosphere.tsx (haze and dust lit by beams).
 *
 * Usage in a shot:
 *   const st = stadiumStateAt(F);                       // from ./Stadium
 *   <StadiumLights intensity={floodMaster(st.floods)} rimDir={rimDirFor(camPos, subjectPos)} />
 *
 * Everything here is a pure function of props: no per-frame accumulation.
 */
import React, { useMemo } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { rng } from "../config";
import { PAL } from "../theme";
import type { Vec3 } from "../rig/types";
import { STADIUM } from "./dims";

/* ------------------------------------------------------------------ */
/* Floodlight banks                                                    */
/* ------------------------------------------------------------------ */

/** Beam aim: depression of the beam axis below the horizon. */
export const BEAM_DEPRESSION = THREE.MathUtils.degToRad(29.5);
/** Horizontal / vertical half-angle tangents of the (elliptical) beam frustum. */
export const BEAM_TAN_X = Math.tan(THREE.MathUtils.degToRad(15));
export const BEAM_TAN_Y = Math.tan(THREE.MathUtils.degToRad(8.5));
/** Lamp head panel half size (m). The beam frustum starts exactly at the panel. */
export const HEAD_HALF_H = 3.0;
export const HEAD_HALF_W = 3.0 * (BEAM_TAN_X / BEAM_TAN_Y);
/** Distance from the virtual apex to the lamp panel along the beam axis. */
export const BEAM_Z_HEAD = HEAD_HALF_H / BEAM_TAN_Y;
/** Lamp grid per bank. */
export const LAMP_COLS = 8;
export const LAMP_ROWS = 5;

export type FloodBank = {
  index: number;
  /** azimuth (rad), measured from +X toward +Z */
  angle: number;
  /** lamp panel centre (world) */
  pos: THREE.Vector3;
  /** unit beam direction (world) */
  axis: THREE.Vector3;
  /** unit horizontal vector across the panel */
  right: THREE.Vector3;
  /** unit vector up the panel (right x up = axis) */
  up: THREE.Vector3;
  /** virtual apex of the beam frustum (behind the panel) */
  apex: THREE.Vector3;
};

/** Bank i sits at azimuth i*45deg (bank 0 on +X, bank 2 on +Z), radius 118m, height 66m. */
export const FLOOD_BANKS: FloodBank[] = Array.from({ length: STADIUM.floodTowers }, (_, i) => {
  const angle = (i * Math.PI * 2) / STADIUM.floodTowers;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const pos = new THREE.Vector3(c * STADIUM.floodRadius, STADIUM.floodHeight, s * STADIUM.floodRadius);
  const axis = new THREE.Vector3(
    -c * Math.cos(BEAM_DEPRESSION),
    -Math.sin(BEAM_DEPRESSION),
    -s * Math.cos(BEAM_DEPRESSION),
  ).normalize();
  const right = new THREE.Vector3(-s, 0, c);
  const up = new THREE.Vector3().crossVectors(axis, right).normalize();
  const apex = pos.clone().addScaledVector(axis, -BEAM_Z_HEAD);
  return { index: i, angle, pos, axis, right, up, apex };
});

/** World position of a flood bank head (useful for lens flares, rim placement). */
export const floodBankPos = (i: number): Vec3 => {
  const p = FLOOD_BANKS[((i % 8) + 8) % 8].pos;
  return [p.x, p.y, p.z];
};

/** Mean of the 8 bank levels = overall flood power (0..1). */
export const floodMaster = (floods: number[]) =>
  floods.length ? floods.reduce((a, b) => a + b, 0) / floods.length : 0;

/* ------------------------------------------------------------------ */
/* Shared GLSL: beam field (used by haze, dust and the beams)          */
/* ------------------------------------------------------------------ */

export const BEAM_GLSL = /* glsl */ `
uniform vec3 uBeamApex[8];
uniform vec3 uBeamR[8];
uniform vec3 uBeamU[8];
uniform vec3 uBeamA[8];
uniform float uFlood[8];
const float BEAM_TX = ${BEAM_TAN_X.toFixed(6)};
const float BEAM_TY = ${BEAM_TAN_Y.toFixed(6)};
const float BEAM_ZH = ${BEAM_Z_HEAD.toFixed(6)};

// Density of one beam at local frustum coords q (x right, y up, z along the axis from the apex).
// Bright near the lamp head (inverse-square-ish), soft elliptical edge, a faint floor far away.
float beamLocalDensity(vec3 q) {
  if (q.z < BEAM_ZH) return 0.0;
  vec2 e = q.xy / (vec2(BEAM_TX, BEAM_TY) * q.z);
  float r = length(e);
  float radial = 1.0 - smoothstep(0.2, 1.0, r);
  radial *= radial;
  float core = exp(-r * r * 6.0);
  float len = pow(BEAM_ZH / q.z, 2.0) + 0.004;
  len *= smoothstep(BEAM_ZH, BEAM_ZH + 2.5, q.z);
  return (radial * 0.75 + core * 0.4) * len;
}

// Sum of all powered beams at world position p (0 = dark, ~1 = inside a beam near the head).
float beamField(vec3 p) {
  float sum = 0.0;
  for (int i = 0; i < 8; i++) {
    if (uFlood[i] <= 0.001) continue;
    vec3 d = p - uBeamApex[i];
    vec3 q = vec3(dot(d, uBeamR[i]), dot(d, uBeamU[i]), dot(d, uBeamA[i]));
    sum += uFlood[i] * beamLocalDensity(q);
  }
  return sum * smoothstep(0.0, 6.0, p.y);
}
`;

export type BeamUniforms = {
  uBeamApex: { value: THREE.Vector3[] };
  uBeamR: { value: THREE.Vector3[] };
  uBeamU: { value: THREE.Vector3[] };
  uBeamA: { value: THREE.Vector3[] };
  uFlood: { value: number[] };
};

export const makeBeamUniforms = (): BeamUniforms => ({
  uBeamApex: { value: FLOOD_BANKS.map((b) => b.apex.clone()) },
  uBeamR: { value: FLOOD_BANKS.map((b) => b.right.clone()) },
  uBeamU: { value: FLOOD_BANKS.map((b) => b.up.clone()) },
  uBeamA: { value: FLOOD_BANKS.map((b) => b.axis.clone()) },
  uFlood: { value: new Array(8).fill(0) },
});

export const setFloodUniform = (u: { value: number[] }, floods: number[]) => {
  for (let i = 0; i < 8; i++) u.value[i] = floods[i] ?? 0;
};

/* ------------------------------------------------------------------ */
/* Deterministic 3D noise texture (shared, built once per tab)         */
/* ------------------------------------------------------------------ */

let noise3D: THREE.Data3DTexture | null = null;
/** 32^3 tileable smooth value noise (two octaves), R8, trilinear, repeat. */
export const getNoise3D = () => {
  if (noise3D) return noise3D;
  const N = 32;
  const r = rng(9137);
  const lat = (n: number) => {
    const g = new Float32Array(n * n * n);
    for (let i = 0; i < g.length; i++) g[i] = r();
    return g;
  };
  const g1 = lat(8);
  const g2 = lat(16);
  const sample = (g: Float32Array, n: number, x: number, y: number, z: number) => {
    const fx = (x / N) * n;
    const fy = (y / N) * n;
    const fz = (z / N) * n;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const z0 = Math.floor(fz);
    const tx = fx - x0;
    const ty = fy - y0;
    const tz = fz - z0;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const sz = tz * tz * (3 - 2 * tz);
    const at = (a: number, b: number, c: number) => g[((a % n) * n + (b % n)) * n + (c % n)];
    const l = (a: number, b: number, t: number) => a + (b - a) * t;
    return l(
      l(l(at(x0, y0, z0), at(x0 + 1, y0, z0), sx), l(at(x0, y0 + 1, z0), at(x0 + 1, y0 + 1, z0), sx), sy),
      l(
        l(at(x0, y0, z0 + 1), at(x0 + 1, y0, z0 + 1), sx),
        l(at(x0, y0 + 1, z0 + 1), at(x0 + 1, y0 + 1, z0 + 1), sx),
        sy,
      ),
      sz,
    );
  };
  const data = new Uint8Array(N * N * N);
  for (let z = 0; z < N; z++)
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const v = sample(g1, 8, x, y, z) * 0.65 + sample(g2, 16, x, y, z) * 0.35;
        data[(z * N + y) * N + x] = Math.round(Math.max(0, Math.min(1, v)) * 255);
      }
  const t = new THREE.Data3DTexture(data, N, N, N);
  t.format = THREE.RedFormat;
  t.type = THREE.UnsignedByteType;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  noise3D = t;
  return t;
};

/* ------------------------------------------------------------------ */
/* Procedural stadium environment map (reflections on ball, helmets)   */
/* ------------------------------------------------------------------ */

const ENV_FRAG = /* glsl */ `
varying vec3 vDir;
uniform vec3 uFloodCol;
uniform vec3 uTeal;
uniform vec3 uGrass;
uniform vec3 uWarm;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec3 d = normalize(vDir);
  float el = d.y;
  float az = atan(d.z, d.x);
  // night sky with a faint lit-haze dome
  vec3 col = mix(vec3(0.020, 0.028, 0.032), vec3(0.006, 0.008, 0.010), smoothstep(0.45, 1.0, el));
  // stands band (dark, faint warm/teal speckle = crowd + concourses)
  float stand = smoothstep(-0.01, 0.01, el) * (1.0 - smoothstep(0.36, 0.40, el));
  float sp = hash(floor(vec2(az * 160.0, el * 90.0)));
  vec3 standCol = vec3(0.010, 0.011, 0.012) + uWarm * 0.010 * step(0.93, sp) + vec3(0.02) * step(0.5, sp) * 0.3;
  col = mix(col, standCol, stand);
  // roof canopy underside
  float roof = smoothstep(0.37, 0.40, el) * (1.0 - smoothstep(0.43, 0.46, el));
  col = mix(col, vec3(0.006, 0.007, 0.008), roof);
  // LED ring at the horizon
  col += uTeal * 0.9 * smoothstep(-0.012, -0.004, el) * (1.0 - smoothstep(0.004, 0.012, el));
  // lit field below
  float field = 1.0 - smoothstep(-0.03, -0.005, el);
  col = mix(col, uGrass * 0.55, field);
  // eight floodlight banks (elevation ~29deg seen from the centre)
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.7853982;
    float da = atan(sin(az - a), cos(az - a));
    float dx = abs(da) * cos(asin(clamp(el, -1.0, 1.0)));
    float dy = abs(el - 0.49);
    float spot = (1.0 - smoothstep(0.035, 0.05, dx)) * (1.0 - smoothstep(0.018, 0.03, dy));
    float halo = exp(-(dx * dx + dy * dy) * 300.0);
    col += uFloodCol * (spot * 26.0 + halo * 0.6);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

const ENV_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const linear = (hex: string) => new THREE.Color(hex);

let envCache: { gl: THREE.WebGLRenderer; tex: THREE.Texture } | null = null;
const getStadiumEnv = (gl: THREE.WebGLRenderer) => {
  if (envCache && envCache.gl === gl) return envCache.tex;
  const scene = new THREE.Scene();
  const mat = new THREE.ShaderMaterial({
    vertexShader: ENV_VERT,
    fragmentShader: ENV_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uFloodCol: { value: linear(PAL.floodWhite) },
      uTeal: { value: linear(PAL.teal) },
      uGrass: { value: linear(PAL.grassA) },
      uWarm: { value: linear(PAL.warm) },
    },
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(40, 96, 48), mat);
  scene.add(mesh);
  const pmrem = new THREE.PMREMGenerator(gl);
  const rt = pmrem.fromScene(scene, 0, 0.1, 100);
  pmrem.dispose();
  mat.dispose();
  mesh.geometry.dispose();
  envCache = { gl, tex: rt.texture };
  return rt.texture;
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Rim direction for a subject seen from a camera: points from the subject toward a light
 * placed behind the subject (opposite the camera), offset sideways and raised.
 * side: -1..1 (which side of the frame the rim edge appears), lift: 0..1 (elevation).
 */
export const rimDirFor = (camera: Vec3, subject: Vec3, side = 0.45, lift = 0.42): Vec3 => {
  const back = new THREE.Vector3(subject[0] - camera[0], 0, subject[2] - camera[2]);
  if (back.lengthSq() < 1e-6) back.set(0, 0, 1);
  back.normalize();
  const lat = new THREE.Vector3(-back.z, 0, back.x);
  const d = back.clone().addScaledVector(lat, side);
  d.normalize().multiplyScalar(Math.cos(lift * 1.2));
  d.y = Math.sin(lift * 1.2);
  d.normalize();
  return [d.x, d.y, d.z];
};

/** Direction from the field toward flood bank i, at the given elevation (deg). */
const bankDir = (i: number, elevDeg: number) => {
  const a = (i * Math.PI * 2) / 8;
  const e = THREE.MathUtils.degToRad(elevDeg);
  return new THREE.Vector3(Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e));
};

/* ------------------------------------------------------------------ */
/* <StadiumLights/>                                                    */
/* ------------------------------------------------------------------ */

export type StadiumLightsProps = {
  /** 0..1 overall flood power (keys, rim and environment scale with it). Default 1. */
  intensity?: number;
  /** Unit-ish world direction from the subject TOWARD the rim light. Default: from +Z, raised. */
  rimDir?: Vec3;
  /** Rim strength multiplier (default 1). */
  rim?: number;
  /** Key strength multiplier (default 1). */
  key?: number;
  /** Which two opposite flood banks act as keys (default [1, 5] = 45deg and 225deg). */
  keyBanks?: [number, number];
  /** Key elevation in degrees (default 35). */
  keyElevation?: number;
  /** Hemisphere fill multiplier (default 1). */
  fill?: number;
  /** Teal LED-board accent 0..1 (default 0.35); a low directional from the boards. */
  accent?: number;
  /** Direction from the subject toward the LED boards that give the accent (default [0, 0.1, -1]). */
  accentDir?: Vec3;
  /** Key A (keyBanks[0]) casts shadows. Enables the renderer shadow map. Default false. */
  shadows?: boolean;
  /** Centre of the shadow camera (default [0,0,0]). */
  shadowCenter?: Vec3;
  /** Half-extent of the shadow camera in metres (default 8). */
  shadowSize?: number;
  /** Shadow map resolution (default 2048, max 2048). */
  shadowMapSize?: number;
  /** Procedural stadium environment map strength; 0 disables (default 1). */
  env?: number;
};

const KEY_INTENSITY = 2.3;
const RIM_INTENSITY = 9.0;
const FILL_INTENSITY = 7.0;
const ACCENT_INTENSITY = 1.1;
const ENV_INTENSITY = 0.55;

export const StadiumLights: React.FC<StadiumLightsProps> = ({
  intensity = 1,
  rimDir = [0, 0.45, 1],
  rim = 1,
  key = 1,
  keyBanks = [1, 5],
  keyElevation = 35,
  fill = 1,
  accent = 0.35,
  accentDir = [0, 0.1, -1],
  shadows = false,
  shadowCenter = [0, 0, 0],
  shadowSize = 8,
  shadowMapSize = 2048,
  env = 1,
}) => {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);

  const objs = useMemo(() => {
    const targets = [new THREE.Object3D(), new THREE.Object3D(), new THREE.Object3D(), new THREE.Object3D()];
    const keyCol = linear(PAL.floodWhite);
    const keyColWarm = linear(PAL.floodWhite).lerp(linear(PAL.warm), 0.22);
    const rimCol = linear(PAL.floodWhite).lerp(linear(PAL.teal), 0.15);
    return { targets, keyCol, keyColWarm, rimCol };
  }, []);

  const k = Math.max(0, Math.min(1, intensity));
  const c = new THREE.Vector3(...shadowCenter);
  const dA = bankDir(keyBanks[0], keyElevation);
  const dB = bankDir(keyBanks[1], keyElevation);
  const dR = new THREE.Vector3(...rimDir).normalize();
  const dAcc = new THREE.Vector3(...accentDir).normalize();
  const far = 120;
  const pA = c.clone().addScaledVector(dA, far);
  const pB = c.clone().addScaledVector(dB, far);
  const pR = c.clone().addScaledVector(dR, far);
  const pAcc = c.clone().addScaledVector(dAcc, far);
  objs.targets.forEach((t) => {
    t.position.copy(c);
    t.updateMatrixWorld();
  });

  // Shadow map: enabled synchronously during render so the first draw already has it.
  if (shadows && !gl.shadowMap.enabled) {
    gl.shadowMap.enabled = true;
    gl.shadowMap.type = THREE.PCFShadowMap;
  }

  // Environment (reflections). Set during render: Remotion advances R3F in an effect.
  const envTex = env > 0 ? getStadiumEnv(gl) : null;
  if (scene.environment !== envTex) scene.environment = envTex;
  scene.environmentIntensity = env * ENV_INTENSITY * (0.08 + 0.92 * k);

  const msz = Math.min(2048, shadowMapSize);
  return (
    <>
      {objs.targets.map((t, i) => (
        <primitive key={i} object={t} />
      ))}
      <directionalLight
        position={pA.toArray()}
        target={objs.targets[0]}
        color={objs.keyCol}
        intensity={KEY_INTENSITY * key * k}
        castShadow={shadows}
        shadow-mapSize-width={msz}
        shadow-mapSize-height={msz}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
        shadow-radius={3}
        shadow-camera-left={-shadowSize}
        shadow-camera-right={shadowSize}
        shadow-camera-top={shadowSize}
        shadow-camera-bottom={-shadowSize}
        shadow-camera-near={far - 60}
        shadow-camera-far={far + 60}
      />
      <directionalLight
        position={pB.toArray()}
        target={objs.targets[1]}
        color={objs.keyColWarm}
        intensity={KEY_INTENSITY * 0.85 * key * k}
      />
      <directionalLight
        position={pR.toArray()}
        target={objs.targets[2]}
        color={objs.rimCol}
        intensity={RIM_INTENSITY * rim * k}
      />
      {accent > 0 ? (
        <directionalLight
          position={pAcc.toArray()}
          target={objs.targets[3]}
          color={PAL.teal}
          intensity={ACCENT_INTENSITY * accent * (0.3 + 0.7 * k)}
        />
      ) : null}
      <hemisphereLight color="#1b2a33" groundColor="#20381f" intensity={FILL_INTENSITY * fill * (0.35 + 0.65 * k)} />
    </>
  );
};
