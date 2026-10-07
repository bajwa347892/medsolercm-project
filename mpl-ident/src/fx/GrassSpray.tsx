/**
 * GrassSpray: turf thrown up by a slide or dive (tumbling grass clippings + a little soil dust),
 * and GrassWipe: the lens-filling version that wipes S07 -> S08.
 *
 *   // slide from frame 352 to 372, emitter follows the sliding hip
 *   <GrassSpray origin={(t) => hipAt(352 + t * FPS)} t={(F - 352) / FPS} duration={0.66} direction={[0, 0.5, -3]} />
 *
 *   // S07 end: clippings fly at the lens until the frame is full (progress 0 -> 1 over 368-378),
 *   // S08 start: they clear to reveal the throw (progress 1 -> 2 over 378-384)
 *   <GrassWipe progress={...} />
 *
 * Clippings are lit by the scene lights (MeshStandardMaterial, instanced, matrices from closed-form
 * ballistics with drag every render) plus light transmitted through the leaf (scaled by `light`), and
 * the emission is front-loaded (thickest when the body first ploughs in).
 *
 * GrassWipe is locked to the camera in its vertex shader: real-sized clippings (2-6 cm) at real
 * distances from the lens (1.1 m down to 4 cm), so perspective makes far ones small and crisp and near
 * ones frame-filling; near ones are pre-defocused (soft, rounded), all are smeared by a short sports
 * shutter, and a soft mass of out-of-focus blades covers the frame exactly at progress 1. It does not
 * depend on the shot's <Post/> focus, and both shots at the cut draw the identical cover frame.
 */
import React, { useMemo } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { rng } from "../config";
import { PAL } from "../theme";
import type { Vec3 } from "../rig/types";
import { DustBurst } from "./DustBurst";
import { BIG_SPHERE, FX_NOISE_GLSL, makeQuadInstanced, randAttr } from "./common";

/* ------------------------------------------------------------------ */
/* World spray                                                         */
/* ------------------------------------------------------------------ */

export type GrassSprayProps = {
  /** emission point (world), or a function of emission time (s) for a moving emitter */
  origin: Vec3 | ((t: number) => Vec3);
  /** main throw velocity direction (world; length is ignored, use `speed`) */
  direction: Vec3;
  /** seconds since emission started */
  t: number;
  /** emission duration in seconds (0 = a single burst) */
  duration?: number;
  /** number of clippings (default 180) */
  count?: number;
  /** throw speed m/s (default 3.2) */
  speed?: number;
  /** cone half-angle in radians (default 0.65) */
  spread?: number;
  /** soil dust amount 0..2 (default 0.5; 0 = none) */
  dust?: number;
  /** flood light level 0..1 (default 1): the dust and the light coming through the clippings */
  light?: number;
  /** clipping size multiplier (default 1) */
  size?: number;
  seed?: number;
};

const LIFE = 1.4;

type Clip = {
  birth: number;
  v: THREE.Vector3;
  axis: THREE.Vector3;
  spin: number;
  len: number;
  wid: number;
  q0: THREE.Quaternion;
  drag: number;
};

let clipGeo: THREE.BufferGeometry | null = null;
/** A short, slightly curled clipping: unit length along +Y, centred. */
const getClipGeo = () => {
  if (clipGeo) return clipGeo;
  const g = new THREE.PlaneGeometry(1, 1, 1, 4);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const x = p.getX(i);
    p.setXYZ(i, x * (1 - Math.abs(y) * 0.6), y, (y * y - 0.25) * 0.35);
  }
  g.computeVertexNormals();
  clipGeo = g;
  return g;
};

/** Fresh clippings: the turf's own greens, a touch lighter (cut stalks), never straw. */
const GRASS_SHADES = ["#3b7630", "#447f34", "#33692a", "#4e8a3a", "#5a9142", "#2f6229"];

export const GrassSpray: React.FC<GrassSprayProps> = ({
  origin,
  direction,
  t,
  duration = 0,
  count = 180,
  speed = 3.2,
  spread = 0.65,
  dust = 0.5,
  light = 1,
  size = 1,
  seed = 3,
}) => {
  const { mesh, clips } = useMemo(() => {
    const r = rng(seed * 4099 + 7);
    // thin, translucent leaf: bright albedo plus a little self-glow for the light coming through it
    // thin, translucent leaf: lit by the scene, plus light transmitted through it (emissive, scaled by
    // the flood level each render) so a blade seen edge-on or from its shadow side stays turf-green
    const mat = new THREE.MeshStandardMaterial({
      roughness: 0.55,
      metalness: 0,
      side: THREE.DoubleSide,
      envMapIntensity: 0.4,
      emissive: new THREE.Color("#3a7a2c"),
      emissiveIntensity: 0.5,
    });
    const m = new THREE.InstancedMesh(getClipGeo(), mat, count);
    m.frustumCulled = false;
    const cs: Clip[] = [];
    const col = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const axis = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize();
      cs.push({
        // front-loaded: the spray is thickest when the body first ploughs into the turf
        birth: Math.pow(r(), 1.6),
        v: new THREE.Vector3(r(), r(), r()),
        axis,
        spin: 8 + r() * 26,
        len: 0.018 + r() * 0.04,
        wid: 0.0035 + r() * 0.003,
        q0: new THREE.Quaternion().setFromEuler(new THREE.Euler(r() * 6.3, r() * 6.3, r() * 6.3)),
        drag: 1.2 + r() * 2.2,
      });
      col.set(GRASS_SHADES[Math.floor(r() * GRASS_SHADES.length)]).multiplyScalar(0.8 + r() * 0.4);
      m.setColorAt(i, col);
    }
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    return { mesh: m, clips: cs };
  }, [count, seed]);

  (mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.5 * Math.max(0, light);
  const dir = new THREE.Vector3(...direction);
  if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0);
  dir.normalize();
  // basis around the throw direction
  const up = Math.abs(dir.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const sx = new THREE.Vector3().crossVectors(dir, up).normalize();
  const sy = new THREE.Vector3().crossVectors(sx, dir).normalize();
  const originAt = (tt: number): Vec3 => (typeof origin === "function" ? origin(tt) : origin);
  const ground = originAt(0)[1];

  const mtx = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  let alive = 0;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const b = c.birth * duration;
    const a = t - b;
    if (a < 0 || a > LIFE) {
      mtx.makeScale(0, 0, 0);
      mesh.setMatrixAt(i, mtx);
      continue;
    }
    alive++;
    // velocity inside the cone, speed varies
    const th = Math.sqrt(c.v.x) * spread;
    const ph = c.v.y * Math.PI * 2;
    const v = dir
      .clone()
      .multiplyScalar(Math.cos(th))
      .addScaledVector(sx, Math.sin(th) * Math.cos(ph))
      .addScaledVector(sy, Math.sin(th) * Math.sin(ph))
      .multiplyScalar(speed * (0.45 + 0.75 * c.v.z));
    const k = c.drag;
    const o = originAt(b);
    const at = (tt: number) => {
      const e = (1 - Math.exp(-k * tt)) / k;
      return pos.set(o[0] + v.x * e, o[1] + v.y * e - (9.81 * (tt - e)) / k, o[2] + v.z * e);
    };
    let tt = a;
    if (at(a).y < ground + 0.004) {
      // landed: find the touchdown time (bisection on the closed form) and rest there
      // last crossing: search between the apex and now (the closed form rises then falls once)
      let lo = v.y > 0 ? Math.log(1 + (v.y * k) / 9.81) / k : 0;
      let hi = a;
      for (let n = 0; n < 14; n++) {
        const mid = (lo + hi) / 2;
        if (at(mid).y > ground + 0.004) lo = mid;
        else hi = mid;
      }
      tt = lo;
      at(tt);
      pos.y = ground + 0.004;
    }
    q.setFromAxisAngle(c.axis, c.spin * tt).multiply(c.q0);
    const fade = 1 - Math.max(0, (a - LIFE * 0.8) / (LIFE * 0.2));
    scl.set(c.wid * size * fade, c.len * size * fade, 1);
    mtx.compose(pos, q, scl);
    mesh.setMatrixAt(i, mtx);
  }
  mesh.instanceMatrix.needsUpdate = true;

  const dustBursts = dust > 0 ? (duration > 0 ? [0, 0.3, 0.6, 0.9] : [0]) : [];
  return (
    <>
      {alive > 0 ? <primitive object={mesh} /> : null}
      {dustBursts.map((f, i) => {
        const o = originAt(f * duration);
        return (
          <DustBurst
            key={i}
            position={[o[0], ground, o[2]]}
            age={t - f * duration}
            amount={dust * 1.1}
            direction={[dir.x * 1.2, 0, dir.z * 1.2]}
            light={light}
            color="#7f8064"
            count={36}
            seed={seed * 10 + i}
          />
        );
      })}
    </>
  );
};

/* ------------------------------------------------------------------ */
/* Lens-filling wipe                                                   */
/* ------------------------------------------------------------------ */

export type GrassWipeProps = {
  /** 0 = clear, 1 = frame completely filled (the cut frame), 2 = cleared again (continuing the same motion) */
  progress: number;
  /** screen direction the clippings travel (default up-left, as thrown from a slide at the lens) */
  direction?: [number, number];
  /** clipping count (default 100) */
  count?: number;
  /** flood light level 0..1 (default 1) */
  light?: number;
  /**
   * motion blur: progress covered per frame (default 0.1 = the 10-frame S07 build-up). Clippings are
   * smeared along their travel by 7% of that motion (a short sports-camera shutter); 0 disables it.
   */
  rate?: number;
  seed?: number;
};

/**
 * Each clipping is a real-sized blade (2-6 cm) at a real distance from the lens (1.1 m down to 4 cm), so
 * perspective alone makes the far ones small and crisp and the near ones frame-filling. Later clippings
 * fly nearer (the spray reaching the lens). Depth-dependent defocus, a swept (motion-blurred) silhouette,
 * lit-turf colour with light coming through the leaf near its edges.
 */
const WIPE_VERT = /* glsl */ `
attribute vec4 aRand;
attribute vec4 aRand2;
uniform float uP;
uniform vec2 uDir;
uniform float uRate;
uniform float uViewH;
varying vec2 vP;
varying vec2 vM;
varying float vHW;
varying float vHL;
varying float vB;
varying float vSoft;
varying float vShade;
varying float vFace;
void main() {
  // entries run from before the wipe to just after the cut; the spray is nearest the lens at the cut,
  // and the clippings that pass after it carry the same motion through the clear
  float start = aRand.y * 1.45 - 0.2;
  float near = start < 0.88 ? clamp((start + 0.2) / 1.08, 0.0, 1.0) : 1.0 - (start - 0.88) * 0.9;
  float z = mix(1.1, 0.045, pow(near, 0.7)) * mix(0.8, 1.2, aRand.x);
  float dur = mix(0.55, 0.3, near) * mix(0.8, 1.25, aRand.z);
  float s = (uP - start) / dur;
  if (s < 0.0 || s > 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec2 ext = vec2(1.0 / projectionMatrix[0][0], 1.0 / projectionMatrix[1][1]) * z;
  vec2 perp = vec2(-uDir.y, uDir.x);
  float lane = (aRand.w - 0.5) * 2.5;
  float bend = (aRand2.x - 0.5) * 0.7;
  vec2 path = -uDir * 1.65 + uDir * 3.3 * s + perp * (lane + bend * (s - 0.5) * (s - 0.5) * 4.0);
  vec2 c = path * ext;
  // metres per progress unit along the path; smear over a short sports-camera shutter (~1/500 s):
  // the blades stay crisp in time and only defocus softens them
  vec2 vel = (uDir * 3.3 + perp * bend * (s - 0.5) * 8.0) * ext / dur;
  vec2 m = vel * uRate * 0.07;
  // real clipping size; tumbling turns it on screen and foreshortens it
  float len = mix(0.022, 0.06, aRand2.y);
  float wid = len * mix(0.05, 0.09, aRand2.z) * (1.0 + 0.5 * near);
  float spin = (aRand2.x - 0.5) * 7.0;
  float ang = atan(uDir.y, uDir.x) + (aRand2.w - 0.5) * 2.2 + s * spin;
  float tumble = cos(s * spin * 0.8 + aRand2.y * 6.2831853);
  float hl = 0.5 * len * (0.5 + 0.5 * abs(tumble));
  float hw = 0.5 * wid;
  // defocus: the camera is focused metres away, so blades near the lens melt into soft shapes
  float soft = smoothstep(0.6, 0.05, z);
  float px = 2.0 * ext.y / uViewH;
  float b = max(hw * mix(0.05, 0.9, soft), px * 0.8);
  vec2 q = position.xy * vec2(hw + b, hl + b);
  mat2 R = mat2(cos(ang), sin(ang), -sin(ang), cos(ang));
  vec2 off = R * q;
  // stretch the quad along the motion so it covers the swept silhouette
  off += m * sign(dot(off, m) + 1e-6) * 0.5;
  mat2 Ri = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
  vP = Ri * off;
  vM = Ri * m;
  vHW = hw;
  vHL = hl;
  vB = b;
  vSoft = soft;
  vShade = aRand2.z;
  vFace = tumble;
  gl_Position = projectionMatrix * vec4(c + off, -z, 1.0);
}
`;

const WIPE_FRAG = /* glsl */ `
uniform vec3 uA;
uniform vec3 uB;
uniform vec3 uGlow;
uniform float uLight;
varying vec2 vP;
varying vec2 vM;
varying float vHW;
varying float vHL;
varying float vB;
varying float vSoft;
varying float vShade;
varying float vFace;
// blade: tapered to a point at +y, rounded cut end at -y (rounded so defocus never shows box corners)
float bladeSD(vec2 p) {
  float t = clamp(p.y / vHL, -1.0, 1.0);
  float hw = vHW * (1.0 - 0.8 * smoothstep(0.15, 1.0, t));
  vec2 q = vec2(abs(p.x) - hw * 0.5, abs(p.y) - (vHL - hw * 0.5));
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - hw * 0.5;
}
void main() {
  // swept along the shutter motion (motion blur): min distance over a few points of the segment
  float k = dot(vM, vM) > 1e-12 ? clamp(dot(vP, vM) / dot(vM, vM), -0.5, 0.5) : 0.0;
  float sd = min(min(bladeSD(vP - vM * k), bladeSD(vP)), min(bladeSD(vP + vM * 0.5), bladeSD(vP - vM * 0.5)));
  float cov = smoothstep(vB, -vB, sd);
  if (cov <= 0.004) discard;
  vec2 dm = normalize(vM + vec2(1e-6, 0.0));
  float extent = 2.0 * (vHL * abs(dm.y) + vHW * abs(dm.x)) + 2.0 * vB;
  float smear = extent / (extent + length(vM));
  float a = cov * mix(1.0, smear, 0.4);
  // shading: the blade is folded along its midrib (one half faces the light), lighter toward the tip,
  // light comes through the thin leaf at its edges
  float xs = vP.x / max(vHW, 1e-5);
  float across = clamp(abs(xs), 0.0, 1.0);
  float along = clamp(vP.y / max(vHL, 1e-5) * 0.5 + 0.5, 0.0, 1.0);
  float fold = mix(0.62, 1.12, smoothstep(-0.35, 0.35, xs * sign(vFace + 1e-3)));
  fold = mix(fold, 0.85, vSoft);
  vec3 base = mix(uA, uB, vShade) * (0.6 + 0.4 * abs(vFace)) * fold * (0.85 + 0.25 * along);
  vec3 col = base * (0.22 + 1.15 * uLight);
  col += uGlow * uLight * (0.05 + 0.3 * across * across) * mix(1.0, 0.4, vSoft);
  // sheen: a tumbling blade flashes as its face turns to the floods
  col += vec3(0.2, 0.3, 0.12) * uLight * pow(abs(vFace), 12.0) * (1.0 - 0.8 * vSoft) * (0.4 + 0.6 * along);
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/**
 * The cover: an out-of-focus mass of blades pressed against the lens. Six huge, soft blades at angles
 * near the travel direction drift across at their own speeds over a dark, shadowed layer behind them.
 */
const FILL_FRAG = /* glsl */ `
uniform vec3 uA;
uniform vec3 uB;
uniform vec3 uGlow;
uniform float uLight;
uniform float uEnter;
uniform float uExit;
uniform float uP;
uniform vec2 uDir;
uniform float uAspect;
varying vec2 vUv;
${FX_NOISE_GLSL}
void main() {
  vec2 uv = vUv;
  vec2 sp = vec2((uv.x - 0.5) * uAspect, uv.y - 0.5);
  vec2 perp = vec2(-uDir.y, uDir.x);
  float span = 0.5 * (abs(uDir.x) * uAspect + abs(uDir.y));
  float kk = 0.5 + dot(sp, uDir) / (2.0 * span);
  float a1 = dot(sp, perp);
  float n = fxNoise(vec2(a1 * 2.6, kk * 1.3) + 3.7) * 0.6 + fxNoise(vec2(a1 * 6.0, kk * 2.2) - 1.3) * 0.4;
  float edge = kk + (n - 0.5) * 0.24;
  float fIn = mix(-0.2, 1.3, uEnter);
  float fOut = mix(-0.2, 1.3, uExit);
  float a = (1.0 - smoothstep(fIn - 0.12, fIn, edge)) * smoothstep(fOut - 0.12, fOut, edge);
  if (a <= 0.003) discard;
  // back layer: shadowed blades, soft mottling
  float mott = fxNoise(sp * 3.0 + 11.0) * 0.6 + fxNoise(sp * 7.0 - 4.0) * 0.4;
  vec3 col = mix(uA * 0.3, uA * 0.55, mott) * (0.2 + 1.0 * uLight);
  // front layer: big defocused blades
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float h1 = fract(sin(fi * 12.9898 + 4.1) * 43758.5453);
    float h2 = fract(sin(fi * 78.233 + 1.7) * 43758.5453);
    float h3 = fract(sin(fi * 39.425 + 7.3) * 43758.5453);
    float ang = atan(uDir.y, uDir.x) + (h1 - 0.5) * 0.9;
    vec2 d = vec2(cos(ang), sin(ang));
    vec2 nrm = vec2(-d.y, d.x);
    // each blade's centre line drifts along the travel at its own speed (parallax)
    vec2 c0 = perp * (h2 - 0.5) * 1.6 * span + uDir * (uP - 1.0) * (0.6 + 0.8 * h3);
    vec2 r = sp - c0;
    float across = dot(r, nrm);
    float alongB = dot(r, d);
    float w = mix(0.07, 0.17, h3) * (1.0 - 0.35 * smoothstep(-0.2, 0.9, alongB));
    float blur = 0.06 + 0.05 * h1;
    float cov = 1.0 - smoothstep(w - blur, w + blur, abs(across));
    float fold = mix(0.65, 1.1, smoothstep(-w * 0.5, w * 0.5, across * (h2 > 0.5 ? 1.0 : -1.0)));
    vec3 bc = mix(uA, uB, h2) * fold * (0.2 + 1.05 * uLight);
    bc += uGlow * uLight * 0.3 * smoothstep(w * 0.4, w + blur, abs(across));
    col = mix(col, bc, cov * 0.92);
  }
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const FILL_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  // full-screen card at the near plane
  gl_Position = vec4(position.xy, -0.999, 1.0);
}
`;

export const GrassWipe: React.FC<GrassWipeProps> = ({ progress, direction = [-0.82, 0.57], count = 100, light = 1, rate = 0.1, seed = 5 }) => {
  const gl = useThree((st) => st.gl);
  const { geo, mat, fill } = useMemo(() => {
    const g = makeQuadInstanced(count);
    g.setAttribute("aRand", randAttr(count, seed * 31 + 1));
    g.setAttribute("aRand2", randAttr(count, seed * 977 + 5));
    g.boundingSphere = BIG_SPHERE;
    // calibrated to the lit turf (grassA under the floods reads ~1.4x its albedo)
    const a = new THREE.Color(PAL.grassA);
    const b = new THREE.Color("#3f7a2f");
    const glow = new THREE.Color("#7fae3c").multiplyScalar(0.3);
    const m = new THREE.ShaderMaterial({
      vertexShader: WIPE_VERT,
      fragmentShader: WIPE_FRAG,
      uniforms: {
        uP: { value: 0 },
        uDir: { value: new THREE.Vector2() },
        uRate: { value: 0.1 },
        uViewH: { value: 1080 },
        uA: { value: a },
        uB: { value: b },
        uGlow: { value: glow },
        uLight: { value: 1 },
      },
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    });
    const fm = new THREE.ShaderMaterial({
      vertexShader: FILL_VERT,
      fragmentShader: FILL_FRAG,
      uniforms: {
        uA: { value: a },
        uB: { value: b },
        uGlow: { value: glow },
        uLight: { value: 1 },
        uEnter: { value: 0 },
        uExit: { value: 0 },
        uP: { value: 0 },
        uDir: { value: new THREE.Vector2() },
        uAspect: { value: 16 / 9 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    return { geo: g, mat: m, fill: fm };
  }, [count, seed]);
  const size = gl.getDrawingBufferSize(new THREE.Vector2());
  const d = new THREE.Vector2(...direction).normalize();
  const u = mat.uniforms;
  u.uP.value = progress;
  u.uDir.value.copy(d);
  u.uLight.value = light;
  u.uRate.value = rate;
  u.uViewH.value = size.y;
  const fu = fill.uniforms;
  fu.uLight.value = light;
  fu.uDir.value.copy(d);
  fu.uP.value = progress;
  fu.uAspect.value = size.x / Math.max(1, size.y);
  // full cover exactly at progress 1 (the cut frame), cleared quickly after it
  const enter = Math.max(0, Math.min(1, (progress - 0.66) / 0.34));
  const exit = Math.max(0, Math.min(1, (progress - 1) / 0.34));
  fu.uEnter.value = enter;
  fu.uExit.value = exit;
  if (progress <= 0 || progress >= 2) return null;
  return (
    <>
      <mesh geometry={geo} material={mat} frustumCulled={false} renderOrder={10} />
      {enter > 0 && exit < 1 ? <FillCard mat={fill} /> : null}
    </>
  );
};

const fillGeo = (() => {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  return g;
})();

const FillCard: React.FC<{ mat: THREE.ShaderMaterial }> = ({ mat }) => (
  <mesh geometry={fillGeo} material={mat} frustumCulled={false} renderOrder={11} />
);
