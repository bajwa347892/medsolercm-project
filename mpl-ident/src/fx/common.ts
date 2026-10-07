/**
 * Shared helpers for the FX components. Every effect is a pure function of its props (usually an
 * `age` / `t` in seconds that the shot derives from the frame), so frames can render in any order.
 */
import * as THREE from "three";
import { rng } from "../config";
import { RIM_UNIFORMS } from "../world/Lights";

/** Unit quad corners for instanced billboards (two triangles, xy in -1..1). */
export const makeQuadInstanced = (count: number) => {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.instanceCount = count;
  return g;
};

/** Per-instance random vec4 attribute from a seed (deterministic). */
export const randAttr = (count: number, seed: number) => {
  const r = rng(seed);
  const a = new Float32Array(count * 4);
  for (let i = 0; i < a.length; i++) a[i] = r();
  return new THREE.InstancedBufferAttribute(a, 4);
};

/** Large bounding sphere so instanced FX are never frustum-culled by their tiny base quad. */
export const BIG_SPHERE = new THREE.Sphere(new THREE.Vector3(), 1e5);

/** GLSL: hashes and value noise. */
export const FX_NOISE_GLSL = /* glsl */ `
float fxHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float fxNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(fxHash(i), fxHash(i + vec2(1.0, 0.0)), f.x), mix(fxHash(i + vec2(0.0, 1.0)), fxHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
`;

/**
 * Uniforms shared with the stadium rim light (StadiumLights writes them every frame):
 * particles glow when the camera looks toward the rim light through them (forward scattering).
 */
export const rimUniforms = () => ({
  uRimDirW: RIM_UNIFORMS.uRimDirW,
  uRimColor: RIM_UNIFORMS.uRimColor,
});

/** Linear colour from a palette hex. */
export const lin = (hex: string) => new THREE.Color(hex);

/** Smoothstep on numbers. */
export const sstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
