/**
 * Night-stadium atmosphere (SPEC §6.1): scene fog (graphite-teal), a camera-centred night sky
 * with the glow of lit haze over the bowl, drifting haze cards lit by the floodlight beams, and
 * dust motes that are only visible inside the beams.
 *
 *   <Atmosphere F floods haze fogDensity motes motesCenter motesRadius sky />
 *
 * Pure function of F and props. Sets `scene.fog` during render (Remotion advances R3F in an effect).
 */
import React, { useEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { FPS, rng } from "../config";
import { PAL } from "../theme";
import type { Vec3 } from "../rig/types";
import { BEAM_GLSL, floodMaster, getNoise3D, makeBeamUniforms, setFloodUniform } from "./Lights";
import { stadiumStateAt } from "./Stadium";

const FOG_DARK = new THREE.Color("#05080a");
const FOG_LIT = new THREE.Color("#152025");
/** Default FogExp2 density. ~7% veil at 100m, ~25% at 200m. */
export const FOG_DENSITY = 0.0026;

/** Fog colour for a given overall flood power (0..1). */
export const fogColorFor = (master: number) => FOG_DARK.clone().lerp(FOG_LIT, Math.max(0, Math.min(1, master)));

const TONE = /* glsl */ `
#include <tonemapping_fragment>
#include <colorspace_fragment>
`;

const FOG_GLSL = /* glsl */ `
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
`;

const v3 = (hex: string) => {
  const c = new THREE.Color(hex);
  return new THREE.Vector3(c.r, c.g, c.b);
};

/* ------------------------------------------------------------------ */
/* Sky                                                                 */
/* ------------------------------------------------------------------ */

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec3 wp = cameraPosition + position;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  gl_Position.z = gl_Position.w * 0.99999;
}
`;

const SKY_FRAG = /* glsl */ `
uniform float uLit;
uniform vec3 uCamPos;
uniform vec3 uTeal;
uniform vec3 uWarm;
varying vec3 vDir;
float hash21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main() {
  vec3 d = normalize(vDir);
  float el = d.y;
  vec3 zen = vec3(0.0016, 0.0022, 0.0028);
  vec3 hor = vec3(0.006, 0.0085, 0.010) + uWarm * 0.002;
  vec3 col = mix(hor, zen, smoothstep(-0.05, 0.6, el));
  // lit haze dome above the bowl: strongest looking up from inside, a halo on the horizon from outside
  float inside = 1.0 - smoothstep(60.0, 160.0, length(uCamPos.xz));
  float dome = mix(smoothstep(0.0, 0.25, el) * (1.0 - smoothstep(0.55, 1.0, el)) * 0.6 + smoothstep(0.3, 1.0, el) * 0.4, exp(-abs(el - 0.05) * 6.0), 1.0 - inside);
  vec3 glow = mix(vec3(0.020, 0.028, 0.031), uTeal * 0.02, 0.25);
  col += glow * dome * uLit;
  // very fine dither so the gradient never bands
  col += (hash21(gl_FragCoord.xy) - 0.5) * 0.0015;
  gl_FragColor = vec4(max(col, 0.0), 1.0);
  ${TONE}
}
`;

const Sky: React.FC<{ lit: number }> = ({ lit }) => {
  const camera = useThree((s) => s.camera);
  const { geo, mat } = useMemo(() => {
    const g = new THREE.SphereGeometry(900, 48, 24);
    const m = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uLit: { value: 0 },
        uCamPos: { value: new THREE.Vector3() },
        uTeal: { value: v3(PAL.teal) },
        uWarm: { value: v3(PAL.warm) },
      },
    });
    return { geo: g, mat: m };
  }, []);
  mat.uniforms.uLit.value = lit;
  mat.uniforms.uCamPos.value.copy(camera.position);
  return <mesh geometry={geo} material={mat} frustumCulled={false} renderOrder={-100} />;
};

/* ------------------------------------------------------------------ */
/* Haze cards                                                          */
/* ------------------------------------------------------------------ */

const HAZE_VERT = /* glsl */ `
${FOG_GLSL}
${BEAM_GLSL}
attribute vec4 iCard; // centre xyz, size
attribute vec2 iSeed;
uniform float uTime;
varying vec2 vUv;
varying vec2 vSeed;
varying float vBeam;
varying float vFade;
varying float vFogDepth;
varying float vY;
void main() {
  vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  // slow drift with the breeze
  vec3 c = iCard.xyz + vec3(sin(uTime * 0.05 + iSeed.x * 6.28) * 6.0 + uTime * 0.6, sin(uTime * 0.07 + iSeed.y * 6.28) * 1.5, cos(uTime * 0.04 + iSeed.y * 6.28) * 6.0);
  vec3 wp = c + (camR * position.x + camU * position.y) * iCard.w;
  vUv = position.xy;
  vSeed = iSeed;
  vBeam = beamField(wp);
  vY = wp.y;
  float dc = length(cameraPosition - c);
  vFade = smoothstep(iCard.w * 0.25, iCard.w * 0.8, dc);
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const HAZE_FRAG = /* glsl */ `
${FOG_GLSL}
uniform sampler3D uNoise;
uniform float uTime;
uniform float uLit;
uniform float uGain;
uniform vec3 uHazeCol;
uniform vec3 uBeamCol;
varying vec2 vUv;
varying vec2 vSeed;
varying float vBeam;
varying float vFade;
varying float vFogDepth;
varying float vY;
void main() {
  float r = length(vUv) * 2.0;
  float soft = 1.0 - smoothstep(0.2, 1.0, r);
  soft *= soft;
  vec3 nc = vec3(vUv * 1.6 + vSeed * 7.0, uTime * 0.02 + vSeed.x);
  float n = texture(uNoise, nc).r * 0.65 + texture(uNoise, nc * 2.3 + vec3(0.0, uTime * 0.015, 0.3)).r * 0.35;
  n = smoothstep(0.35, 0.9, n);
  float a = soft * n * vFade * smoothstep(0.0, 8.0, vY);
  vec3 col = (uHazeCol * uLit * 0.6 + uBeamCol * vBeam * 0.9) * a * uGain;
  col *= 1.0 - fogAmount(vFogDepth) * 0.5;
  gl_FragColor = vec4(col, 1.0);
  ${TONE}
}
`;

const HazeCards: React.FC<{ t: number; floods: number[]; lit: number; gain: number; noise: THREE.Data3DTexture }> = ({
  t,
  floods,
  lit,
  gain,
  noise,
}) => {
  const { geo, mat } = useMemo(() => {
    const r = rng(8080);
    const N = 22;
    const card = new Float32Array(N * 4);
    const seed = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      const a = r() * Math.PI * 2;
      const rad = Math.sqrt(r()) * 80;
      const y = 10 + r() * 34;
      card.set([Math.cos(a) * rad, y, Math.sin(a) * rad, 45 + r() * 55], i * 4);
      seed.set([r(), r()], i * 2);
    }
    const quad = new THREE.PlaneGeometry(1, 1, 7, 7);
    const g = new THREE.InstancedBufferGeometry();
    g.index = quad.index;
    g.setAttribute("position", quad.attributes.position);
    g.setAttribute("iCard", new THREE.InstancedBufferAttribute(card, 4));
    g.setAttribute("iSeed", new THREE.InstancedBufferAttribute(seed, 2));
    g.instanceCount = N;
    const m = new THREE.ShaderMaterial({
      vertexShader: HAZE_VERT,
      fragmentShader: HAZE_FRAG,
      fog: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        ...makeBeamUniforms(),
        uNoise: { value: noise },
        uTime: { value: 0 },
        uLit: { value: 0 },
        uGain: { value: 1 },
        uHazeCol: { value: v3("#2a3a40") },
        uBeamCol: { value: v3(PAL.floodWhite) },
      },
    });
    return { geo: g, mat: m };
  }, [noise]);
  setFloodUniform(mat.uniforms.uFlood, floods);
  mat.uniforms.uTime.value = t;
  mat.uniforms.uLit.value = lit;
  mat.uniforms.uGain.value = 0.022 * gain;
  return <mesh geometry={geo} material={mat} frustumCulled={false} renderOrder={6} />;
};

/* ------------------------------------------------------------------ */
/* Dust motes (visible only inside beams)                              */
/* ------------------------------------------------------------------ */

const MOTE_VERT = /* glsl */ `
${FOG_GLSL}
${BEAM_GLSL}
attribute vec4 aSeed;
uniform float uTime;
uniform vec3 uCenter;
uniform float uRadius;
uniform float uHeight;
uniform float uViewH;
uniform float uAmount;
varying float vI;
varying float vFogDepth;
void main() {
  float t = uTime;
  // deterministic drift: slow wind + gentle curls + a faint rise, wrapped inside the volume
  vec3 base = position * vec3(uRadius * 2.0, uHeight, uRadius * 2.0);
  vec3 drift = vec3(t * 0.35, t * 0.04, t * 0.12)
    + vec3(sin(t * (0.3 + aSeed.x * 0.5) + aSeed.y * 6.28), sin(t * (0.25 + aSeed.y * 0.4) + aSeed.z * 6.28) * 0.6, cos(t * (0.28 + aSeed.z * 0.45) + aSeed.x * 6.28)) * (0.4 + aSeed.w * 0.8);
  vec3 rel = base + drift;
  vec3 size = vec3(uRadius * 2.0, uHeight, uRadius * 2.0);
  rel = mod(rel + size * 0.5, size) - size * 0.5;
  vec3 wp = uCenter + rel;
  float b = beamField(wp);
  float tw = 0.45 + 0.55 * pow(0.5 + 0.5 * sin(t * (1.5 + aSeed.w * 3.0) + aSeed.x * 40.0), 3.0);
  float on = step(aSeed.w, uAmount);
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
  float pxPerM = projectionMatrix[1][1] * uViewH * 0.5;
  float px = (0.005 + aSeed.z * 0.01) * pxPerM / max(-mv.z, 0.05);
  float ps = clamp(px, 1.0, 14.0);
  // energy conservation: sub-pixel motes get dimmer, big (out of focus) ones spread their light
  float area = (px * px) / (ps * ps);
  vI = b * tw * on * min(area, 1.0);
  vI *= px > 14.0 ? (14.0 * 14.0) / (px * px) : 1.0;
  gl_PointSize = vI > 0.0005 ? ps : 0.0;
}
`;

const MOTE_FRAG = /* glsl */ `
${FOG_GLSL}
uniform vec3 uCol;
uniform float uGain;
varying float vI;
varying float vFogDepth;
void main() {
  if (vI < 0.0005) discard;
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c) * 2.0;
  float a = 1.0 - smoothstep(0.35, 1.0, r);
  vec3 col = uCol * vI * a * uGain;
  col *= 1.0 - fogAmount(vFogDepth) * 0.6;
  gl_FragColor = vec4(col, 1.0);
  ${TONE}
}
`;

const MOTE_COUNT = 2600;

const Motes: React.FC<{
  t: number;
  floods: number[];
  amount: number;
  center: Vec3;
  radius: number;
  height: number;
}> = ({ t, floods, amount, center, radius, height }) => {
  const viewH = useThree((s) => s.size.height);
  const { geo, mat } = useMemo(() => {
    const r = rng(6061);
    const pos = new Float32Array(MOTE_COUNT * 3);
    const seed = new Float32Array(MOTE_COUNT * 4);
    for (let i = 0; i < MOTE_COUNT; i++) {
      pos.set([(r() - 0.5) * 2, r() - 0.5, (r() - 0.5) * 2], i * 3);
      seed.set([r(), r(), r(), r()], i * 4);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 4));
    const m = new THREE.ShaderMaterial({
      vertexShader: MOTE_VERT,
      fragmentShader: MOTE_FRAG,
      fog: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        ...makeBeamUniforms(),
        uTime: { value: 0 },
        uCenter: { value: new THREE.Vector3() },
        uRadius: { value: 30 },
        uHeight: { value: 20 },
        uViewH: { value: 1080 },
        uAmount: { value: 1 },
        uCol: { value: v3("#F7F4EC") },
        uGain: { value: 1 },
      },
    });
    return { geo: g, mat: m };
  }, []);
  // positions are unit-cube seeds, scaled into the volume in the shader
  const u = mat.uniforms;
  setFloodUniform(u.uFlood, floods);
  u.uTime.value = t;
  u.uCenter.value.set(center[0], center[1], center[2]);
  u.uRadius.value = radius;
  u.uHeight.value = height;
  u.uViewH.value = viewH;
  u.uAmount.value = amount;
  u.uGain.value = 2.2;
  return (
    <points geometry={geo} material={mat} frustumCulled={false} renderOrder={7} />
  );
};

/* ------------------------------------------------------------------ */
/* <Atmosphere/>                                                       */
/* ------------------------------------------------------------------ */

export type AtmosphereProps = {
  /** global frame */
  F: number;
  /** 8 flood bank levels (default: stadiumStateAt(F).floods) */
  floods?: number[];
  /** haze-card strength multiplier (default 1) */
  haze?: number;
  /** FogExp2 density (default FOG_DENSITY = 0.0026); 0 disables the scene fog */
  fogDensity?: number;
  /** dust mote amount 0..1 (default 1) */
  motes?: number;
  /** centre of the dust-mote volume (default [0, 9, 0]) */
  motesCenter?: Vec3;
  /** half-width of the dust-mote volume in metres (default 32) */
  motesRadius?: number;
  /** height of the dust-mote volume in metres (default 18) */
  motesHeight?: number;
  /** draw the night sky dome (default true) */
  sky?: boolean;
};

export const Atmosphere: React.FC<AtmosphereProps> = ({
  F,
  floods,
  haze = 1,
  fogDensity = FOG_DENSITY,
  motes = 1,
  motesCenter = [0, 9, 0],
  motesRadius = 32,
  motesHeight = 18,
  sky = true,
}) => {
  const scene = useThree((s) => s.scene);
  const fl = floods ?? stadiumStateAt(F).floods;
  const master = floodMaster(fl);
  const t = F / FPS;
  const { fog, noise } = useMemo(
    () => ({ fog: new THREE.FogExp2(FOG_DARK.getHex(), FOG_DENSITY), noise: getNoise3D() }),
    [],
  );
  fog.color.copy(fogColorFor(master));
  fog.density = fogDensity;
  const wantFog = fogDensity > 0 ? fog : null;
  if (scene.fog !== wantFog) scene.fog = wantFog;
  useEffect(
    () => () => {
      if (scene.fog === fog) scene.fog = null;
    },
    [scene, fog],
  );
  return (
    <>
      {sky ? <Sky lit={master} /> : null}
      {haze > 0 ? <HazeCards t={t} floods={fl} lit={master} gain={haze} noise={noise} /> : null}
      {motes > 0 ? (
        <Motes
          t={t}
          floods={fl}
          amount={motes}
          center={motesCenter}
          radius={motesRadius}
          height={motesHeight}
        />
      ) : null}
    </>
  );
};
