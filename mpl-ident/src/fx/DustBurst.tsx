/**
 * DustBurst: a footstep / slide / impact puff. Soft, wispy dust that kicks out low, rises a little,
 * drifts and settles, plus a few grit specks that arc and drop back to the turf.
 *
 *   <DustBurst position={footPos} age={(F - stepFrame) / FPS} />            // footstep
 *   <DustBurst position={p} age={a} direction={[0, 0, -2]} amount={2} />    // slide / dive landing
 *
 * age: seconds since the impact (screen or action time, the shot decides; < 0 or > life draws nothing).
 * Motion is closed-form (drag + weak gravity) in the vertex shader: one draw call, no JS per frame.
 * Lit like haze: dim body, bright when backlit by the shot's rim light (reads RIM_UNIFORMS).
 */
import React, { useMemo } from "react";
import * as THREE from "three";
import { PAL } from "../theme";
import type { Vec3 } from "../rig/types";
import { BIG_SPHERE, FX_NOISE_GLSL, lin, makeQuadInstanced, randAttr, rimUniforms } from "./common";
import { GrassSpray } from "./GrassSpray";

export type DustBurstProps = {
  /** ground contact point (world) */
  position: Vec3;
  /** seconds since the impact */
  age: number;
  /** particle count (default 70; grit is ~20% of it) */
  count?: number;
  /** size / spread / density multiplier (default 1). 0.5 light footstep, 1 hard plant, 2 slide */
  amount?: number;
  /** extra push velocity (m/s, world), e.g. the slide direction or the foot's push-off */
  direction?: Vec3;
  /** dust colour (default: dry pitch soil) */
  color?: string;
  /** overall opacity (default 1) */
  opacity?: number;
  /** flood light level 0..1 (default 1) */
  light?: number;
  /** puff lifetime in seconds (default 1.6) */
  life?: number;
  seed?: number;
};

const VERT = /* glsl */ `
attribute vec4 aRand;
attribute vec4 aRand2;
uniform vec3 uOrigin;
uniform vec3 uPush;
uniform float uAge;
uniform float uAmount;
uniform float uLife;
varying vec2 vUv;
varying float vAlpha;
varying float vGrit;
varying vec3 vWorld;
varying float vSeed;
void main() {
  float grit = step(0.8, aRand.w);
  float t = uAge * (0.8 + 0.4 * aRand.x);
  float life = uLife * (0.55 + 0.65 * aRand.y);
  // initial velocity: low radial kick, modest rise, plus the push direction
  float ang = aRand.z * 6.2831853;
  float hs = (0.35 + 1.1 * aRand2.x) * mix(0.75, 1.6, grit) * sqrt(uAmount);
  float vs = mix(0.18 + 0.55 * aRand2.y, 1.1 + 1.6 * aRand2.y, grit) * sqrt(uAmount);
  vec3 v0 = vec3(cos(ang) * hs, vs, sin(ang) * hs) + uPush * mix(0.6 + 0.6 * aRand2.z, 0.9, grit);
  float k = mix(4.2, 1.2, grit);
  float e = (1.0 - exp(-k * t)) / k;
  vec3 p = uOrigin + v0 * e;
  float g = mix(0.28, 9.81, grit);
  p.y -= g * (t - e) / k;
  // slow turbulent drift of the puff
  p.xz += (1.0 - grit) * vec2(sin(t * 1.7 + aRand2.w * 6.28), cos(t * 1.3 + aRand.x * 6.28)) * 0.06 * t * uAmount;
  float sz = mix((0.025 + 0.04 * aRand2.w) * (1.0 + 2.2 * sqrt(max(t, 0.0))) * uAmount,
                 0.0035 + 0.004 * aRand2.w, grit);
  // keep puffs off the ground plane (no hard intersection line), grit dies when it lands
  float floorY = uOrigin.y + mix(sz * 0.55, 0.0, grit);
  float landed = grit * step(p.y, uOrigin.y) * step(0.05, t);
  p.y = max(p.y, floorY);
  float a = smoothstep(0.0, mix(0.06, 0.01, grit), t) * (1.0 - smoothstep(life * 0.3, life, t));
  a *= mix(0.075 / (1.0 + 1.6 * t), 0.8, grit) * (1.0 - landed);
  a *= step(0.0, uAge);
  vAlpha = a;
  vGrit = grit;
  vSeed = aRand.y * 17.0;
  vUv = position.xy;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  vec4 mv = viewMatrix * wp;
  // a slowly turning sprite so the wisps do not look stamped
  float rot = aRand.x * 6.28 + t * (aRand2.z - 0.5);
  mat2 R = mat2(cos(rot), sin(rot), -sin(rot), cos(rot));
  mv.xy += (R * position.xy) * sz;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uLight;
uniform float uOpacity;
uniform vec3 uRimDirW;
uniform vec3 uRimColor;
varying vec2 vUv;
varying float vAlpha;
varying float vGrit;
varying vec3 vWorld;
varying float vSeed;
${FX_NOISE_GLSL}
void main() {
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0 || vAlpha <= 0.001) discard;
  float body;
  if (vGrit > 0.5) {
    body = 1.0 - smoothstep(0.35, 1.0, r2);
  } else {
    float n = fxNoise(vUv * 2.2 + vSeed) * 0.55 + fxNoise(vUv * 4.7 - vSeed) * 0.3 + fxNoise(vUv * 9.1 + vSeed * 1.7) * 0.15;
    body = pow(1.0 - r2, 1.5) * smoothstep(0.38, 0.9, n + 0.15 * (1.0 - r2));
  }
  vec3 V = normalize(vWorld - cameraPosition);
  float fwd = pow(max(dot(V, normalize(uRimDirW)), 0.0), 3.0);
  vec3 col = uColor * (0.08 + 0.6 * uLight) * mix(1.0, 0.4, vGrit);
  col += uRimColor * fwd * mix(0.16, 0.1, vGrit);
  gl_FragColor = vec4(col, vAlpha * body * uOpacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export const DustBurst: React.FC<DustBurstProps> = ({
  position,
  age,
  count = 70,
  amount = 1,
  direction = [0, 0, 0],
  color = "#a3987c",
  opacity = 1,
  light = 1,
  life = 1.6,
  seed = 1,
}) => {
  const { geo, mat } = useMemo(() => {
    const g = makeQuadInstanced(count);
    g.setAttribute("aRand", randAttr(count, seed * 7919 + 13));
    g.setAttribute("aRand2", randAttr(count, seed * 104729 + 71));
    g.boundingSphere = BIG_SPHERE;
    const m = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uOrigin: { value: new THREE.Vector3() },
        uPush: { value: new THREE.Vector3() },
        uAge: { value: 0 },
        uAmount: { value: 1 },
        uLife: { value: 1.6 },
        uColor: { value: new THREE.Color() },
        uLight: { value: 1 },
        uOpacity: { value: 1 },
        ...rimUniforms(),
      },
      transparent: true,
      depthWrite: false,
    });
    return { geo: g, mat: m };
  }, [count, seed]);
  const u = mat.uniforms;
  u.uOrigin.value.set(...position);
  u.uPush.value.set(...direction);
  u.uAge.value = age;
  u.uAmount.value = amount;
  u.uLife.value = life;
  u.uColor.value.copy(lin(color));
  u.uLight.value = light;
  u.uOpacity.value = opacity;
  if (age < 0 || age > life * 1.25) return null;
  return <mesh geometry={geo} material={mat} frustumCulled={false} renderOrder={2} />;
};

/**
 * Convenience: dust plus a small flick of turf for a list of footfalls. `frame` is the current frame,
 * events are frames. `grass` = clippings flicked per step (default 10; 0 = dust only, e.g. on the pitch).
 */
export const Footfalls: React.FC<{
  frame: number;
  fps: number;
  steps: { frame: number; position: Vec3; amount?: number; direction?: Vec3 }[];
  light?: number;
  color?: string;
  grass?: number;
}> = ({ frame, fps, steps, light, color, grass = 10 }) => (
  <>
    {steps.map((s, i) => {
      const age = (frame - s.frame) / fps;
      if (age < 0 || age > 2) return null;
      const d = s.direction ?? [0, 0, 0];
      return (
        <React.Fragment key={i}>
          <DustBurst
            position={s.position}
            age={age}
            amount={s.amount ?? 0.7}
            direction={s.direction}
            light={light}
            color={color}
            seed={i + 1}
            count={40}
          />
          {grass > 0 ? (
            <GrassSpray
              origin={s.position}
              direction={[d[0] * 0.6, 1, d[2] * 0.6]}
              t={age}
              count={grass}
              speed={1.7 * Math.sqrt(s.amount ?? 0.7)}
              spread={0.75}
              dust={0}
              size={0.75}
              seed={i + 21}
            />
          ) : null}
        </React.Fragment>
      );
    })}
  </>
);

export const DUST_COLORS = { soil: "#a3987c", turf: "#7f8064", pitch: PAL.pitch } as const;
