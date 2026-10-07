/**
 * SpeedTrail: a thin, restrained teal ribbon behind a moving object, sampled from its path function.
 *
 *   <SpeedTrail path={ballPosAt} t={actionT} length={0.12} width={0.03} />
 *
 * path(t) -> world position at time t (seconds, same clock as `t`). The ribbon covers
 * [t - length, t - headGap], always faces the camera (expanded in the vertex shader), tapers and
 * fades toward the tail, and has a near-white hot core with a soft teal sheath (additive, HDR).
 * `start` clamps the tail so a trail can emerge from a release point instead of from before it.
 *
 * Built for tracking cameras: the on-screen width is clamped to [minPixels, maxPixels] (energy
 * compensated, so far trails never shimmer and the part passing the lens never balloons into a beam),
 * the trail fades within `nearFade` metres of the lens and, in chase views, where it runs much nearer
 * the lens than the object itself (`nearRatio`). Its core is written to the depth buffer (`depth`), so
 * <Post/> depth of field blurs it by its own distance instead of the background's.
 */
import React, { useMemo } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { PAL } from "../theme";
import type { Vec3 } from "../rig/types";

export type SpeedTrailProps = {
  /** world position along the path at time t (seconds) */
  path: (t: number) => Vec3;
  /** current time on the path (seconds) */
  t: number;
  /** trail duration in seconds (default 0.15) */
  length?: number;
  /** the trail never reaches back before this time (default: unlimited) */
  start?: number;
  /** gap between the object and the trail head, seconds (default 0) */
  headGap?: number;
  /** ribbon width at the head, metres (default 0.03) */
  width?: number;
  /** base colour (default teal) */
  color?: string;
  /** core colour (default: white blended 45% toward tealHi, so the hot line reads as light, not paint) */
  coreColor?: string;
  /** 0..1 overall opacity (default 0.6) */
  opacity?: number;
  /** HDR multiplier (default 1.4; >2 makes the core bloom) */
  intensity?: number;
  /** ribbon samples (default 40) */
  segments?: number;
  /** narrowest on-screen ribbon width in pixels at 1080 lines (default 2.5, a ~1 px core); thinner trails are dimmed instead */
  minPixels?: number;
  /** widest on-screen width in pixels at 1080 lines (default 14), so the part passing the lens stays a line */
  maxPixels?: number;
  /** [start, full] camera distance in metres over which the trail fades in (default [0.15, 0.9]) */
  nearFade?: [number, number];
  /**
   * [start, full] fade by depth relative to the head (default [0.45, 0.85]): in a chase view the part of the
   * trail nearer the lens than 45-85% of the object's distance fades out. Use [0, 0] to disable.
   */
  nearRatio?: [number, number];
  /** write the bright core into the depth buffer so <Post/> depth of field treats it at its own distance (default true) */
  depth?: boolean;
};

const VERT = /* glsl */ `
attribute vec3 aTan;
attribute float aSide;
attribute float aU;
uniform float uWidth;
uniform float uViewH;
uniform float uMinPx;
uniform float uMaxPx;
uniform vec2 uNear;
uniform vec2 uNearRatio;
uniform vec3 uHead;
varying float vSide;
varying float vU;
varying float vFade;
void main() {
  vec4 c = modelViewMatrix * vec4(position, 1.0);
  vec3 tv = (modelViewMatrix * vec4(aTan, 0.0)).xyz;
  float depth = max(-c.z, 1e-4);
  vec3 toCam = normalize(-c.xyz);
  vec3 side = cross(tv, toCam);
  float sl = length(side);
  side = sl > 1e-6 ? side / sl : vec3(0.0, 1.0, 0.0);
  // width in pixels, clamped: a far trail never drops below a hairline (dimmed instead, so it
  // never shimmers) and the part passing the lens never balloons into a beam
  float w = uWidth * mix(0.12, 1.0, pow(aU, 0.6));
  float pxPerM = projectionMatrix[1][1] * 0.5 * uViewH / depth;
  float px = w * pxPerM;
  float k = uViewH / 1080.0;
  float pxC = clamp(px, uMinPx * k, max(uMaxPx * k, uMinPx * k));
  c.xyz += side * aSide * 0.5 * pxC / pxPerM;
  // energy: thinner than a hairline -> dimmer; fade where the ribbon runs past the lens and where it
  // is seen end-on (its screen extent collapses and the side vector is unstable)
  // chase views: the part of the trail much nearer the lens than the object itself dies away, so a
  // trail behind a ball the camera follows never runs out of frame like a string
  float headDepth = max(-(viewMatrix * vec4(uHead, 1.0)).z, 1e-3);
  vFade = min(1.0, px / pxC) * smoothstep(uNear.x, uNear.y, depth) * smoothstep(0.03, 0.2, sl)
        * smoothstep(uNearRatio.x, uNearRatio.y, depth / headDepth);
  vSide = aSide;
  vU = aU;
  gl_Position = projectionMatrix * c;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uCore;
uniform float uOpacity;
uniform float uIntensity;
varying float vSide;
varying float vU;
varying float vFade;
void main() {
  float x = vSide;
  float core = exp(-x * x * 22.0);
  float sheath = exp(-x * x * 4.0) * (1.0 - 0.6 * core);
  float along = pow(clamp(vU, 0.0, 1.0), 1.6) * smoothstep(1.0, 0.94, vU);
  vec3 col = uColor * sheath * 0.5 + uCore * core * 0.95;
  gl_FragColor = vec4(col * uIntensity * uOpacity * along * vFade, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/**
 * Depth-only pass over the bright core: <Post/>'s depth of field then blurs the trail by ITS distance
 * (sharp beside an in-focus ball, soft where it passes the lens) instead of by the background behind it.
 * Drawn last (renderOrder 9) with colour writes off, so it never hides haze or beams.
 */
const DEPTH_FRAG = /* glsl */ `
varying float vSide;
varying float vU;
varying float vFade;
void main() {
  float along = pow(clamp(vU, 0.0, 1.0), 1.6) * smoothstep(1.0, 0.94, vU);
  if (abs(vSide) > 0.4 || along * vFade < 0.3) discard;
  gl_FragColor = vec4(0.0);
}`;

const DEFAULT_CORE = new THREE.Color(PAL.white).lerp(new THREE.Color(PAL.tealHi), 0.45);

export const SpeedTrail: React.FC<SpeedTrailProps> = ({
  path,
  t,
  length = 0.15,
  start = -Infinity,
  headGap = 0,
  width = 0.03,
  color = PAL.teal,
  coreColor,
  opacity = 0.6,
  intensity = 1.4,
  segments = 40,
  minPixels = 2.5,
  maxPixels = 14,
  nearFade = [0.15, 0.9],
  nearRatio = [0.45, 0.85],
  depth = true,
}) => {
  const gl = useThree((st) => st.gl);
  const { geo, mat, depthMat } = useMemo(() => {
    const n = segments + 1;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3));
    g.setAttribute("aTan", new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3));
    const side = new Float32Array(n * 2);
    const u = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      side[i * 2] = -1;
      side[i * 2 + 1] = 1;
      u[i * 2] = u[i * 2 + 1] = i / segments;
    }
    g.setAttribute("aSide", new THREE.BufferAttribute(side, 1));
    g.setAttribute("aU", new THREE.BufferAttribute(u, 1));
    const idx: number[] = [];
    for (let i = 0; i < segments; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    g.setIndex(idx);
    const uniforms = {
      uWidth: { value: 0.03 },
      uViewH: { value: 1080 },
      uMinPx: { value: 1.6 },
      uMaxPx: { value: 12 },
      uNear: { value: new THREE.Vector2(0.15, 0.9) },
      uNearRatio: { value: new THREE.Vector2(0.45, 0.85) },
      uHead: { value: new THREE.Vector3() },
      uColor: { value: new THREE.Color() },
      uCore: { value: new THREE.Color() },
      uOpacity: { value: 1 },
      uIntensity: { value: 1 },
    };
    const m = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const dm = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: DEPTH_FRAG,
      uniforms,
      transparent: true,
      depthWrite: true,
      colorWrite: false,
      side: THREE.DoubleSide,
    });
    return { geo: g, mat: m, depthMat: dm };
  }, [segments]);

  const t1 = t - headGap;
  const t0 = Math.max(start, t - length);
  const visible = t1 > t0 + 1e-4 && opacity > 0;
  if (visible) {
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const tan = geo.attributes.aTan as THREE.BufferAttribute;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= segments; i++) pts.push(new THREE.Vector3(...path(t0 + ((t1 - t0) * i) / segments)));
    for (let i = 0; i <= segments; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(segments, i + 1)];
      const d = b.clone().sub(a);
      if (d.lengthSq() < 1e-12) d.set(0, 0, 1);
      d.normalize();
      for (let s = 0; s < 2; s++) {
        pos.setXYZ(i * 2 + s, pts[i].x, pts[i].y, pts[i].z);
        tan.setXYZ(i * 2 + s, d.x, d.y, d.z);
      }
    }
    pos.needsUpdate = true;
    tan.needsUpdate = true;
    geo.computeBoundingSphere();
  }
  const u = mat.uniforms;
  u.uWidth.value = width;
  u.uViewH.value = gl.getDrawingBufferSize(new THREE.Vector2()).y;
  u.uMinPx.value = minPixels;
  u.uMaxPx.value = maxPixels;
  u.uNear.value.set(nearFade[0], Math.max(nearFade[1], nearFade[0] + 1e-3));
  u.uNearRatio.value.set(nearRatio[0], Math.max(nearRatio[1], nearRatio[0] + 1e-3));
  if (visible) u.uHead.value.set(...path(t1));
  u.uColor.value.set(color);
  if (coreColor) u.uCore.value.set(coreColor);
  else u.uCore.value.copy(DEFAULT_CORE);
  u.uOpacity.value = opacity;
  u.uIntensity.value = intensity;
  if (!visible) return null;
  return (
    <>
      <mesh geometry={geo} material={mat} renderOrder={3} frustumCulled={false} />
      {depth ? <mesh geometry={geo} material={depthMat} renderOrder={9} frustumCulled={false} /> : null}
    </>
  );
};
