/**
 * Splinters: barely visible flecks of paint and willow knocked off a stump by the ball. Tiny lit
 * shards that spit out of the impact point, tumble, arc under gravity and settle on the turf.
 *
 *   <Splinters position={stumpHitWorld} direction={ballDirWorld} age={actionT - hitT} />
 *
 * age: seconds since the hit in ACTION time (so they hang in the air during the S09 ultra slow motion).
 */
import React, { useMemo } from "react";
import * as THREE from "three";
import { rng } from "../config";
import { PAL } from "../theme";
import type { Vec3 } from "../rig/types";

export type SplintersProps = {
  /** impact point (world) */
  position: Vec3;
  /** main direction of the debris (world), usually the ball's direction of travel */
  direction?: Vec3;
  /** seconds since the hit (action time) */
  age: number;
  /** number of flecks (default 22) */
  count?: number;
  /** launch speed m/s (default 2.6) */
  speed?: number;
  /** cone half-angle radians (default 1.0) */
  spread?: number;
  /** fleck size multiplier (default 1) */
  size?: number;
  /** ground height the flecks settle on (default 0) */
  ground?: number;
  seed?: number;
};

const LIFE = 2.5;

export const Splinters: React.FC<SplintersProps> = ({
  position,
  direction = [0, 0.3, -1],
  age,
  count = 22,
  speed = 2.6,
  spread = 1.0,
  size = 1,
  ground = 0,
  seed = 9,
}) => {
  const { mesh, parts } = useMemo(() => {
    const r = rng(seed * 6007 + 3);
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0 });
    const m = new THREE.InstancedMesh(geo, mat, count);
    m.frustumCulled = false;
    // white paint chips and pale ash (stumps are ash, not bat willow): desaturated so that against the
    // dark stands the flecks read as debris, never as glowing sparks
    const paint = new THREE.Color(PAL.white);
    const wood = new THREE.Color(PAL.willow).lerp(new THREE.Color(PAL.silver), 0.55);
    const ps = Array.from({ length: count }, (_, i) => {
      const isPaint = r() < 0.65;
      m.setColorAt(i, (isPaint ? paint : wood).clone().multiplyScalar(isPaint ? 0.7 + r() * 0.25 : 0.55 + r() * 0.25));
      return {
        u: [r(), r(), r()] as Vec3,
        axis: new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize(),
        spin: 10 + r() * 40,
        dims: [0.0012 + r() * 0.0015, 0.0006 + r() * 0.0008, 0.003 + r() * 0.008] as Vec3,
        drag: 0.6 + r() * 1.4,
      };
    });
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    return { mesh: m, parts: ps };
  }, [count, seed]);

  if (age < 0 || age > LIFE) return null;
  const dir = new THREE.Vector3(...direction).normalize();
  const up = Math.abs(dir.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const sx = new THREE.Vector3().crossVectors(dir, up).normalize();
  const sy = new THREE.Vector3().crossVectors(sx, dir).normalize();
  const mtx = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  parts.forEach((p, i) => {
    const th = Math.sqrt(p.u[0]) * spread;
    const ph = p.u[1] * Math.PI * 2;
    const v = dir
      .clone()
      .multiplyScalar(Math.cos(th))
      .addScaledVector(sx, Math.sin(th) * Math.cos(ph))
      .addScaledVector(sy, Math.sin(th) * Math.sin(ph))
      .multiplyScalar(speed * (0.35 + 0.9 * p.u[2]));
    v.y += 0.8; // flecks pop upward off the stump
    const k = p.drag;
    const at = (tt: number) => {
      const e = (1 - Math.exp(-k * tt)) / k;
      return pos.set(position[0] + v.x * e, position[1] + v.y * e - (9.81 * (tt - e)) / k, position[2] + v.z * e);
    };
    let tt = age;
    if (at(age).y < ground + 0.001) {
      // landed: rest where and how it touched down
      // last crossing: search between the apex and now (the closed form rises then falls once)
      let lo = v.y > 0 ? Math.log(1 + (v.y * k) / 9.81) / k : 0;
      let hi = age;
      for (let n = 0; n < 14; n++) {
        const mid = (lo + hi) / 2;
        if (at(mid).y > ground + 0.001) lo = mid;
        else hi = mid;
      }
      tt = lo;
      at(tt);
      pos.y = ground + 0.001;
    }
    q.setFromAxisAngle(p.axis, p.spin * tt);
    const fade = age > LIFE - 0.4 ? (LIFE - age) / 0.4 : 1;
    scl.set(p.dims[0] * size * fade, p.dims[1] * size * fade, p.dims[2] * size * fade);
    mtx.compose(pos, q, scl);
    mesh.setMatrixAt(i, mtx);
  });
  mesh.instanceMatrix.needsUpdate = true;
  return <primitive object={mesh} />;
};
