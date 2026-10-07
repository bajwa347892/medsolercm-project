/**
 * TealMotes: floating metallic-teal flecks. They drift slowly through a cylindrical volume and catch
 * the light now and then (a brief, sharp glint that blooms), like foil confetti in the floodlights.
 *
 *   <TealMotes t={F / FPS} center={[0, 2, 24]} radius={8} height={5} />           // S01 / S02 ambience
 *   <TealMotes t={F / FPS} center={[0, 4, 0]} radius={20} swirl={1.2} converge={k} /> // S12 vortex
 *
 * Sub-pixel motes are drawn at a minimum size with reduced alpha (energy preserving), so they never
 * shimmer when far away. Additive and depth-tested; a second, colourless pass writes each visible mote's
 * core to the depth buffer (`depth`, default on) so <Post/> blurs motes by their own distance. All motion
 * is in the vertex shader.
 */
import React, { useMemo } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { PAL } from "../theme";
import type { Vec3 } from "../rig/types";
import { BIG_SPHERE, makeQuadInstanced, randAttr } from "./common";

export type TealMotesProps = {
  /** seconds (drives drift and glints) */
  t: number;
  /** centre of the volume (world) */
  center?: Vec3;
  /** horizontal radius of the volume, m (default 6) */
  radius?: number;
  /** height of the volume, m (default 4) */
  height?: number;
  /** number of motes (default 180) */
  count?: number;
  /** mote size, m (default 0.008) */
  size?: number;
  /** brightness multiplier (default 1) */
  intensity?: number;
  /** angular speed of a vortex around the volume axis, rad/s (default 0) */
  swirl?: number;
  /** 0..1 pull toward the axis (default 0) */
  converge?: number;
  /** upward drift m/s (default 0.05) */
  rise?: number;
  /** glints per second per mote, roughly (default 0.35) */
  glint?: number;
  /**
   * write each mote's core into the depth buffer (default true), so <Post/> depth of field blurs a mote
   * by its own distance: motes beside an in-focus subject stay crisp instead of turning into teal bokeh discs
   */
  depth?: boolean;
  seed?: number;
};

const VERT = /* glsl */ `
attribute vec4 aRand;
attribute vec4 aRand2;
uniform float uT;
uniform vec3 uCenter;
uniform float uRadius;
uniform float uHeight;
uniform float uSize;
uniform float uSwirl;
uniform float uConverge;
uniform float uRise;
uniform float uGlintRate;
uniform float uViewH;
varying vec2 vUv;
varying float vGlint;
varying float vAlpha;
varying float vTone;
void main() {
  float t = uT;
  float r0 = sqrt(aRand.x) * uRadius;
  float a = aRand.y * 6.2831853 + uSwirl * t * (0.6 + 0.8 * aRand.w) / (0.35 + r0 / max(uRadius, 1e-3));
  float r = r0 * (1.0 - 0.85 * uConverge) + sin(t * 0.37 + aRand2.x * 6.28) * 0.2;
  float yn = fract(aRand.z + uRise * t * (0.5 + aRand.w) / max(uHeight, 1e-3));
  vec3 p = uCenter + vec3(cos(a) * r, (yn - 0.5) * uHeight, sin(a) * r);
  p += vec3(sin(t * 0.53 + aRand2.y * 6.28), 0.6 * sin(t * 0.41 + aRand2.x * 6.28), cos(t * 0.47 + aRand2.y * 6.28)) * 0.16;
  float edge = smoothstep(0.0, 0.12, yn) * smoothstep(1.0, 0.88, yn);
  // glint: a flat flake turning through the light reflects for a moment
  float ph = t * uGlintRate * (0.6 + 0.8 * aRand2.z) * 6.2831853 + aRand2.w * 6.2831853;
  float g = pow(max(sin(ph), 0.0), 40.0);
  vGlint = g;
  vTone = aRand2.z;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float depth = max(-mv.z, 1e-3);
  float px = uSize * projectionMatrix[1][1] * 0.5 * uViewH / depth;
  float k = max(1.0, 1.5 / max(px, 1e-4));
  vAlpha = edge / (k * k);
  float sz = uSize * k * (1.0 + 0.8 * g);
  vUv = position.xy;
  mv.xy += position.xy * sz;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uDeep;
uniform vec3 uTeal;
uniform vec3 uHi;
uniform float uI;
varying vec2 vUv;
varying float vGlint;
varying float vAlpha;
varying float vTone;
void main() {
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0) discard;
  float body = exp(-r2 * 5.0);
  vec3 base = mix(uDeep, uTeal, vTone) * 0.8;
  vec3 hot = mix(uTeal, uHi, 0.35 + 0.4 * vGlint) * vGlint * 5.0;
  gl_FragColor = vec4((base + hot) * body * vAlpha * uI, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** Depth-only pass (colour writes off, drawn last) over the core of motes that are at least ~a pixel wide. */
const DEPTH_FRAG = /* glsl */ `
varying vec2 vUv;
varying float vAlpha;
void main() {
  if (dot(vUv, vUv) > 0.2 || vAlpha < 0.3) discard;
  gl_FragColor = vec4(0.0);
}`;

export const TealMotes: React.FC<TealMotesProps> = ({
  t,
  center = [0, 2, 0],
  radius = 6,
  height = 4,
  count = 180,
  size = 0.008,
  intensity = 1,
  swirl = 0,
  converge = 0,
  rise = 0.05,
  glint = 0.35,
  depth = true,
  seed = 11,
}) => {
  const gl = useThree((s) => s.gl);
  const { geo, mat, depthMat } = useMemo(() => {
    const g = makeQuadInstanced(count);
    g.setAttribute("aRand", randAttr(count, seed * 15485863 + 1));
    g.setAttribute("aRand2", randAttr(count, seed * 32452843 + 2));
    g.boundingSphere = BIG_SPHERE;
    const m = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uT: { value: 0 },
        uCenter: { value: new THREE.Vector3() },
        uRadius: { value: 6 },
        uHeight: { value: 4 },
        uSize: { value: 0.01 },
        uSwirl: { value: 0 },
        uConverge: { value: 0 },
        uRise: { value: 0.05 },
        uGlintRate: { value: 0.35 },
        uViewH: { value: 1080 },
        uDeep: { value: new THREE.Color(PAL.tealDeep) },
        uTeal: { value: new THREE.Color(PAL.teal) },
        uHi: { value: new THREE.Color(PAL.tealHi) },
        uI: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const dm = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: DEPTH_FRAG,
      uniforms: m.uniforms,
      transparent: true,
      depthWrite: true,
      colorWrite: false,
    });
    return { geo: g, mat: m, depthMat: dm };
  }, [count, seed]);
  const u = mat.uniforms;
  u.uT.value = t;
  u.uCenter.value.set(...center);
  u.uRadius.value = radius;
  u.uHeight.value = height;
  u.uSize.value = size;
  u.uSwirl.value = swirl;
  u.uConverge.value = converge;
  u.uRise.value = rise;
  u.uGlintRate.value = glint;
  u.uViewH.value = gl.getDrawingBufferSize(new THREE.Vector2()).y;
  u.uI.value = intensity;
  if (intensity <= 0) return null;
  return (
    <>
      <mesh geometry={geo} material={mat} frustumCulled={false} renderOrder={5} />
      {depth ? <mesh geometry={geo} material={depthMat} frustumCulled={false} renderOrder={9} /> : null}
    </>
  );
};
