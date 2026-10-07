/**
 * ImpactFlash: the bat-contact accent. A tiny white-hot burst with a faint four-point glint, and a thin
 * shock ring that expands and fades in the plane of the bat face. On screen it should last one or two
 * frames (pair it with <Post flash={flashAt(F, cue)} />).
 *
 *   <ImpactFlash position={contactWorld} normal={batFaceNormalWorld} age={(F - CUE) / FPS} />
 *
 * age is in SCREEN seconds (frames / FPS), not slow-motion action time, so the flash stays a 1-2 frame
 * accent even inside a 0.1x ramp. Additive, HDR (the core blooms). The ring is depth-tested; the core is
 * not by default (it is a lens-level glint, and the ball / bat edge would otherwise swallow it).
 */
import React, { useMemo } from "react";
import * as THREE from "three";
import { PAL } from "../theme";
import type { Vec3 } from "../rig/types";

export type ImpactFlashProps = {
  /** contact point (world) */
  position: Vec3;
  /** seconds since contact (screen time) */
  age: number;
  /** ring plane normal (world), e.g. the bat face normal; default faces the camera */
  normal?: Vec3;
  /** how far the ring leans from camera-facing into the `normal` plane, 0..1 (default 0.4) */
  tilt?: number;
  /** burst radius in metres (default 0.08, about two ball diameters) */
  size?: number;
  /** brightness multiplier (default 1) */
  intensity?: number;
  /** total duration of the ring, seconds (default 0.12 = ~4 frames; the core is ~2) */
  duration?: number;
  /** let the bat / ball / body hide the burst core (default false: the core is a lens-level accent) */
  occlude?: boolean;
};

const CORE_VERT = /* glsl */ `
uniform float uSize;
uniform float uLift;
varying vec2 vUv;
void main() {
  vUv = position.xy;
  vec4 c = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  // pulled toward the lens so the ball itself (whose centre this is) does not hide the burst
  c.xyz += normalize(-c.xyz) * uLift;
  c.xy += position.xy * uSize;
  gl_Position = projectionMatrix * c;
}
`;

const CORE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uI;
uniform float uRot;
varying vec2 vUv;
void main() {
  float r = length(vUv);
  float core = exp(-r * r * 90.0) * 6.0 + exp(-r * r * 12.0) * 0.45;
  // four-point glint, thin and short (a lens star, not sparks)
  vec2 q = mat2(cos(uRot), sin(uRot), -sin(uRot), cos(uRot)) * vUv;
  float star = (exp(-abs(q.y) * 80.0) * exp(-abs(q.x) * 3.8) + exp(-abs(q.x) * 80.0) * exp(-abs(q.y) * 3.8)) * 0.8;
  float a = (core + star) * (1.0 - smoothstep(0.7, 1.0, r));
  gl_FragColor = vec4(uColor * a * uI, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const RING_VERT = /* glsl */ `
uniform vec3 uN;      // ring plane normal (world); zero = face the camera
uniform float uTilt;  // 0 = face the camera, 1 = lie exactly in the plane given by uN
uniform float uScale;
varying vec2 vUv;
void main() {
  vUv = position.xy;
  vec4 c = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec3 bx = vec3(1.0, 0.0, 0.0);
  vec3 by = vec3(0.0, 1.0, 0.0);
  if (dot(uN, uN) > 1e-6 && uTilt > 0.0) {
    vec3 nv = normalize((viewMatrix * vec4(uN, 0.0)).xyz);
    vec3 toCam = normalize(-c.xyz);
    if (dot(nv, toCam) < 0.0) nv = -nv;
    vec3 n = normalize(mix(toCam, nv, uTilt));
    vec3 a = abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    bx = normalize(cross(a, n));
    by = cross(n, bx);
  }
  c.xyz += (bx * position.x + by * position.y) * uScale;
  gl_Position = projectionMatrix * c;
}
`;

const RING_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uTint;
uniform float uI;
uniform float uR;
uniform float uW;
varying vec2 vUv;
void main() {
  float r = length(vUv);
  float d = (r - uR) / uW;
  float ring = exp(-d * d * 2.2);
  float inner = smoothstep(uR * 0.2, uR, r) * (1.0 - smoothstep(uR, uR + uW, r)) * 0.1;
  vec3 col = mix(uColor, uTint, smoothstep(0.0, 1.0, r / max(uR, 1e-4)) * 0.6);
  gl_FragColor = vec4(col * (ring + inner) * uI, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const plane = new THREE.PlaneGeometry(2, 2);

export const ImpactFlash: React.FC<ImpactFlashProps> = ({
  position,
  age,
  normal,
  tilt = 0.4,
  size = 0.08,
  intensity = 1,
  duration = 0.12,
  occlude = false,
}) => {
  const { core, ring } = useMemo(() => {
    const common = {
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    } as const;
    const c = new THREE.ShaderMaterial({
      vertexShader: CORE_VERT,
      fragmentShader: CORE_FRAG,
      uniforms: {
        uSize: { value: 0.1 },
        uLift: { value: 0.05 },
        uColor: { value: new THREE.Color(PAL.floodWhite).lerp(new THREE.Color(PAL.warm), 0.25) },
        uI: { value: 0 },
        uRot: { value: 0.35 },
      },
      ...common,
    });
    const r = new THREE.ShaderMaterial({
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      uniforms: {
        uColor: { value: new THREE.Color(PAL.floodWhite) },
        uTint: { value: new THREE.Color(PAL.tealHi) },
        uI: { value: 0 },
        uR: { value: 0.3 },
        uW: { value: 0.05 },
        uN: { value: new THREE.Vector3() },
        uTilt: { value: 0.4 },
        uScale: { value: 0.1 },
      },
      ...common,
    });
    return { core: c, ring: r };
  }, []);

  core.depthTest = occlude;
  if (age < -0.0001 || age > duration) return null;
  const p = Math.max(0, age) / duration; // 0..1
  // core: peaks on the contact frame, gone after ~2 frames
  const coreI = intensity * Math.exp(-Math.max(0, age) / 0.022);
  core.uniforms.uI.value = coreI;
  core.uniforms.uSize.value = size * (1 + 0.6 * p);
  core.uniforms.uLift.value = size * 0.8;
  // ring: expands fast (ease-out) and thins as it fades
  const ease = 1 - Math.pow(1 - p, 3);
  const R = 0.25 + 0.75 * ease; // in units of the ring quad half-size
  ring.uniforms.uR.value = R;
  ring.uniforms.uW.value = 0.028 * (1 - 0.5 * p) + 0.008;
  ring.uniforms.uI.value = intensity * 1.3 * (1 - p) * (1 - p) * Math.min(1, age / 0.008 + 0.35);
  ring.uniforms.uScale.value = size * 1.6;
  if (normal) ring.uniforms.uN.value.set(...normal).normalize();
  else ring.uniforms.uN.value.set(0, 0, 0);
  ring.uniforms.uTilt.value = tilt;
  return (
    <group position={position}>
      <mesh geometry={plane} material={core} frustumCulled={false} renderOrder={4} />
      <mesh geometry={plane} material={ring} frustumCulled={false} renderOrder={4} />
    </group>
  );
};
