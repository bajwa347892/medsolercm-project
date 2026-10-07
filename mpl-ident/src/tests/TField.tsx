import React, { useMemo } from "react";
import { useCurrentFrame } from "remotion";
import * as THREE from "three";
import { CameraRig } from "../CameraRig";
import { EASE_IN_OUT, lerp, prog } from "../config";
import { PAL } from "../theme";
import { BALL, BOWLER_STUMPS_Z, FIELD, STADIUM, STRIKER_STUMPS_Z } from "../world/dims";
import { Field, GrassBlades, GrassBlades as GrassBladesReal, ropeFaceRadius } from "../world/Field";
import { StadiumLights, rimDirFor } from "../world/Lights";
import { Ball, Wicket } from "../world/Props";
import { Player } from "../rig/Player";
import { sprint } from "../rig/actions";
import type { Vec3 } from "../rig/types";
import { TestCanvas } from "./TestCanvas";

/* ------------------------------------------------------------------ */
/* Test lighting: the real SPEC §5 recipe from the stadium module.     */
/* ------------------------------------------------------------------ */
export const StandInLights: React.FC<{
  focus?: Vec3;
  /** direction from the subject toward the rim light (behind the subject relative to camera) */
  rimDir?: Vec3;
  shadowSize?: number;
  shadows?: boolean;
  intensity?: number;
  rim?: number;
  env?: number;
}> = ({ focus = [0, 0, 0], rimDir = [0, 0.45, 1], shadowSize = 12, shadows = true, intensity = 1, rim = 1, env = 1 }) => (
  <StadiumLights
    intensity={intensity}
    rim={rim}
    env={env}
    rimDir={rimDir}
    shadows={shadows}
    shadowCenter={focus}
    shadowSize={shadowSize}
  />
);

/** Minimal dark bowl, LED ring and lamp banks so the field has context in tests (not the real stadium). */
export const StandInStadium: React.FC = () => {
  const mats = useMemo(() => {
    const bowl = new THREE.MeshStandardMaterial({ color: PAL.graphiteDark, roughness: 1, side: THREE.DoubleSide });
    const led = new THREE.MeshStandardMaterial({
      color: "#000",
      emissive: new THREE.Color(PAL.tealDeep),
      emissiveIntensity: 0.25,
      side: THREE.DoubleSide,
    });
    const lamp = new THREE.MeshBasicMaterial({ color: new THREE.Color(PAL.floodWhite).multiplyScalar(6), toneMapped: true });
    return { bowl, led, lamp };
  }, []);
  return (
    <group>
      <mesh position={[0, 21, 0]} material={mats.bowl}>
        <cylinderGeometry args={[125, 73, 42, 96, 1, true]} />
      </mesh>
      <mesh position={[0, 0.45, 0]} material={mats.led}>
        <cylinderGeometry args={[FIELD.ledRadius, FIELD.ledRadius, 0.9, 256, 1, true]} />
      </mesh>
      <mesh position={[0, -0.01, 0]} rotation={[-Math.PI / 2, 0, 0]} material={mats.bowl}>
        <ringGeometry args={[FIELD.outfieldRadius - 0.05, 74, 128]} />
      </mesh>
      {Array.from({ length: STADIUM.floodTowers }, (_, i) => {
        const a = (i / STADIUM.floodTowers) * Math.PI * 2;
        return (
          <mesh
            key={i}
            position={[Math.cos(a) * STADIUM.floodRadius, STADIUM.floodHeight, Math.sin(a) * STADIUM.floodRadius]}
            rotation={[0, -a - Math.PI / 2, 0]}
            material={mats.lamp}
          >
            <planeGeometry args={[14, 5]} />
          </mesh>
        );
      })}
    </group>
  );
};

/**
 * T-Field
 *   0-79    low tracking camera across the pitch toward the bowler's stumps: a 6 m GrassBlades window
 *           rides with the lens (blades stay anchored to the turf; LOD rings thin out with distance)
 *   80-159  aerial crane over the whole ground (stripes, closer-cut square, 30-yard circle, rope)
 *   160-239 macro grass at the boundary: a sliding body combs and flattens the blades (160-212),
 *           then a push in to the padded rope (212-239)
 * Debug props: grassShift (move the window to prove anchoring), dbg "nograss" / "noground" (profiling).
 */
export const TField: React.FC<{
  /** debug: shift the segment-A grass window (verifies blades are world-anchored: the core must not change) */
  grassShift?: [number, number];
  /** debug: profile switches, e.g. "nograss,noground" */
  dbg?: string;
  /** director views that mirror the film's shots (see DirectorView); overrides the timeline */
  view?: string;
}> = ({ grassShift = [0, 0], dbg = "", view = "" }) => {
  const noGrass = dbg.includes("nograss");
  const noGround = dbg.includes("noground");
  const frame = useCurrentFrame();
  if (view) return <DirectorView view={view} frame={frame} dbg={dbg} />;
  let cam: Vec3;
  let tgt: Vec3;
  let fov = 35;
  let seg = "";
  let content: React.ReactNode = null;
  if (frame < 80) {
    seg = "A low tracking across pitch";
    const t = prog(frame, 0, 79, EASE_IN_OUT);
    cam = [lerp(4.6, 2.4, t), lerp(0.42, 0.3, t), lerp(2.2, 5.6, t)];
    tgt = [0, 0.3, BOWLER_STUMPS_Z];
    fov = 32;
    // the grass window rides along just ahead of the lens; blades stay fixed to the turf
    const fwd = new THREE.Vector3(tgt[0] - cam[0], 0, tgt[2] - cam[2]).normalize();
    const gc: Vec3 = [cam[0] + fwd.x * 2.2 + grassShift[0], 0, cam[2] + fwd.z * 2.2 + grassShift[1]];
    content = (
      <>
        <StandInLights focus={[0, 0, 8]} rimDir={[-0.25, 0.42, 1]} shadowSize={14} />
        <GrassBlades center={gc} radius={6} wind={0.6} F={frame} />
      </>
    );
  } else if (frame < 160) {
    seg = "B aerial";
    const t = prog(frame, 80, 159, EASE_IN_OUT);
    const a = lerp(-2.2, -1.75, t);
    const r = lerp(118, 96, t);
    cam = [Math.cos(a) * r, lerp(92, 70, t), Math.sin(a) * r];
    tgt = [0, 0, lerp(6, 0, t)];
    fov = 38;
    content = <StandInLights focus={[0, 0, 0]} rimDir={[0.3, 0.5, 1]} shadowSize={20} shadows={false} />;
  } else {
    seg = "C macro grass + rope";
    // 160-212 the slide crosses ~1.3 m in front of the lens; 212-239 push in to the rope
    const t = prog(frame, 160, 212, EASE_IN_OUT);
    const t2 = prog(frame, 212, 239, EASE_IN_OUT);
    cam = [lerp(lerp(61.0, 61.3, t), 64.2, t2), lerp(lerp(0.085, 0.11, t), 0.17, t2), lerp(lerp(-0.25, 0.1, t), 0.35, t2)];
    tgt = [66, 0.08, lerp(-0.05, 0.1, t)];
    fov = 40;
    // a sliding body crossing the patch: current contact + a recovering trail behind it
    const slideAt = (fr: number): Vec3 => {
      const s = prog(fr, 170, 206, EASE_IN_OUT);
      return [lerp(62.05, 62.35, s), 0, lerp(-1.5, 1.4, s)];
    };
    const trail = [0, 4, 8, 13, 19, 26, 34, 44].map((lag, i) => ({
      pos: slideAt(frame - lag),
      radius: 0.3 - i * 0.012,
      strength: frame - lag >= 170 ? 1.1 * Math.exp(-lag / 30) : 0,
      dir: [0.12, 0, 1] as Vec3,
    }));
    content = (
      <>
        <StandInLights focus={[63, 0, 0]} rimDir={[1, 0.35, 0.2]} shadowSize={6} shadows={false} />
        {noGrass ? null : <GrassBlades
          center={[cam[0] + 1.2, 0, cam[2]]}
          radius={3.3}
          core={1.4}
          density={8000}
          wind={0.45}
          F={frame}
          disturb={trail}
        />}
      </>
    );
  }
  return (
    <TestCanvas label={`T-Field ${seg} f${frame}`}>
      <CameraRig position={cam} target={tgt} fov={fov} />
      <color attach="background" args={["#05080a"]} />
      <fog attach="fog" args={["#0b1418", 90, 420]} />
      {content}
      <StandInStadium />
      {noGround ? null : <Field detail={frame >= 160 ? "near" : "far"} />}
      <Wicket position={[0, 0, BOWLER_STUMPS_Z]} />
      <Wicket position={[0, 0, STRIKER_STUMPS_Z]} />
    </TestCanvas>
  );
};

/* ------------------------------------------------------------------ */
/* Director views: the film's hardest uses of the field, at shot speed */
/* ------------------------------------------------------------------ */

/**
 * view (frame = local frame of the view):
 *   s01a / s01b  aerial establishing: start (~230 m up, 190 m out) / end (~40 m over the bowler's end)
 *   s01          the whole S01 descent (0-66)
 *   s03          run-up tracking: lens 0.5 m high, 3 m beside a bowler running at ~6.5 m/s (0-40)
 *   s07          outfield sprint at 7.5 m/s, lens 0.3 m high, then a slide that combs the grass (0-60)
 *   s05          side-on of the striker's end from the off side (pitch, creases, stumps)
 *   s10          mid-height orbit on the outfield, backlit by the rim (turf at 3-40 m)
 *   s11          the boundary rope at long-on: a ball rolls into the cushion's inner face at f30
 *   drift        the s10 framing creeping 4 mm per frame (shimmer check)
 * dbg: "nograss", "noplayer", "checks" (criss-cross mowing; the blades must follow it)
 */
const DirectorView: React.FC<{ view: string; frame: number; dbg: string }> = ({ view, frame, dbg }) => {
  const f = frame;
  const noGrass = dbg.includes("nograss");
  const GrassBlades: typeof GrassBladesReal = (p) => (noGrass ? null : <GrassBladesReal {...p} />);
  let cam: Vec3 = [0, 2, 6];
  let tgt: Vec3 = [0, 0, 0];
  let fov = 35;
  let near = true;
  let content: React.ReactNode = null;
  const lights = (focus: Vec3, c: Vec3, shadows = true, size = 8) => (
    <StandInLights focus={focus} rimDir={rimDirFor(c, focus)} shadowSize={size} shadows={shadows} rim={dbg.includes("norim") ? 0 : 1} env={dbg.includes("noenv") ? 0 : 1} />
  );
  if (view === "s01a" || view === "s01b" || view === "s01") {
    const t = view === "s01a" ? 0 : view === "s01b" ? 1 : prog(f, 0, 66, EASE_IN_OUT);
    const orbit = lerp(-0.35, 0, t);
    const r = lerp(190, 30, t);
    cam = [Math.sin(orbit) * r, lerp(230, 40, t), Math.cos(orbit) * r];
    tgt = [0, 0, lerp(0, -4, t)];
    fov = lerp(38, 42, t);
    near = false;
    content = <StandInLights focus={[0, 0, 0]} rimDir={[0, 0.5, -1]} shadows={false} />;
  } else if (view === "s03") {
    // bowler runs toward -Z at x = 0.6; the lens tracks 3 m to his right, 0.5 m up
    const t = f / 30;
    const zb = 27 - 6.5 * t - 0.6 * t * t;
    const pos: Vec3 = [0.6, 0, 27];
    cam = [0.6 - 3.0, 0.5, zb - 0.5];
    tgt = [0.6, 0.85, zb];
    fov = 34;
    const fwd = new THREE.Vector3(tgt[0] - cam[0], 0, tgt[2] - cam[2]).normalize();
    const gc: Vec3 = [cam[0] + fwd.x * 2.2, 0, cam[2] + fwd.z * 2.2];
    const pose = sprint(t, { speed: 6.5 + 0.6 * t });
    content = (
      <>
        {lights([0.6, 0, zb], cam, true, 6)}
        {dbg.includes("noplayer") ? null : <Player pose={pose} role="bowler" kit="teal" position={pos} rotationY={Math.PI} />}
        <GrassBlades center={gc} radius={6} wind={0.5} F={f} />
      </>
    );
  } else if (view === "s07") {
    // a deep fielder sprints along +Z at x = 44; slide from f40 (decelerating), lens 0.3 m up, 2.8 m to his side
    const t = f / 30;
    const sprintZ = (tt: number) => 8 + 7.5 * tt;
    const T0 = 40 / 30;
    const zAt = (tt: number) =>
      tt < T0 ? sprintZ(tt) : sprintZ(T0) + 7.5 * (tt - T0) - 0.5 * 9 * Math.min(tt - T0, 0.83) ** 2 - 0;
    const zp = zAt(t);
    cam = [44 + 2.8, 0.3, zp + 0.5];
    tgt = [44, 0.55, zp];
    fov = 34;
    const fwd = new THREE.Vector3(tgt[0] - cam[0], 0, tgt[2] - cam[2]).normalize();
    const gc: Vec3 = [cam[0] + fwd.x * 2.0, 0, cam[2] + fwd.z * 2.0];
    // footfalls every 0.2 s while sprinting; after f40 a sliding body combs the grass along +Z
    const dist: { pos: Vec3; radius: number; strength: number; dir?: Vec3 }[] = [];
    if (f < 40) {
      for (let k = 0; k < 4; k++) {
        const ts = Math.floor(t / 0.2) * 0.2 - k * 0.2;
        if (ts < 0) continue;
        const age = t - ts;
        dist.push({ pos: [44 + (k % 2 ? 0.09 : -0.09), 0, sprintZ(ts)], radius: 0.16, strength: Math.exp(-age * 5) * 1.2 });
      }
    } else {
      [0, 3, 6, 10, 15, 21, 28, 36].forEach((lag) => {
        const fl = f - lag;
        if (fl < 40) return;
        dist.push({ pos: [44, 0, zAt(fl / 30) - 0.3], radius: 0.32, strength: 1.1 * Math.exp(-lag / 30), dir: [0, 0, 1] });
      });
    }
    content = (
      <>
        {lights([44, 0, zp], cam, true, 6)}
        {f < 40 && !dbg.includes("noplayer") ? (
          <Player pose={sprint(t)} role="fielder" kit="teal" position={[44, 0, 8]} rotationY={0} />
        ) : null}
        <GrassBlades center={gc} radius={6} wind={0.5} F={f} disturb={dist} />
      </>
    );
  } else if (view === "s05") {
    cam = [-5.2, 1.05, -8.7];
    tgt = [0.2, 0.75, -9.2];
    fov = 32;
    content = lights([0, 0, -9.2], cam, true, 6);
  } else if (view === "s10" || view === "drift") {
    // drift: the s10 framing creeping 4 mm per frame (sub-pixel motion exposes any shimmer)
    const a = view === "drift" ? 0.6 : 0.6 + f * 0.02;
    const c: Vec3 = [8, 0, 2];
    cam = [c[0] + Math.cos(a) * 5.5 + (view === "drift" ? f * 0.004 : 0), 1.6, c[2] + Math.sin(a) * 5.5];
    tgt = [c[0], 1.0, c[2]];
    fov = 30;
    content = lights(c, cam, true, 8);
  } else if (view === "s11") {
    // a boundary at long-on: the ball rolls into the rope's inner face at f30 and kicks back a little
    const az = Math.atan2(58, 26);
    const R = BALL.radius;
    const rc = ropeFaceRadius(az, R) - R;
    const inward = new THREE.Vector3(-Math.cos(az), 0, -Math.sin(az));
    const side = new THREE.Vector3(-Math.sin(az), 0, Math.cos(az));
    const hit = new THREE.Vector3(Math.cos(az) * rc, R, Math.sin(az) * rc);
    const c = hit.clone().addScaledVector(inward, 2.6).addScaledVector(side, 1.1);
    cam = [c.x, 0.32, c.z];
    tgt = [hit.x, 0.1, hit.z];
    fov = 30;
    const tt = (f - 30) / 30;
    const d = tt < 0 ? -tt * 9 : Math.min(tt, 0.4) * 1.1 - Math.min(tt, 0.4) ** 2 * 1.4;
    const bp = hit.clone().addScaledVector(inward, d).addScaledVector(side, tt < 0 ? tt * 1.5 : tt * 0.2);
    // rolling: rotation about the horizontal axis across the motion (deterministic, from the distance)
    const roll = (tt < 0 ? tt * 9 : -d) / R;
    const re = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromAxisAngle(side, roll));
    content = (
      <>
        {lights([hit.x, 0, hit.z], cam, true, 5)}
        <Ball position={[bp.x, bp.y, bp.z]} spin={[re.x, re.y, re.z]} groundShadow />
        <GrassBlades center={[c.x - inward.x * 1.4, 0, c.z - inward.z * 1.4]} radius={4} wind={0.4} F={f} />
      </>
    );
  }
  return (
    <TestCanvas label={`T-Field view ${view} f${frame}`}>
      <CameraRig position={cam} target={tgt} fov={fov} />
      <color attach="background" args={["#05080a"]} />
      <fog attach="fog" args={["#0b1418", 90, 420]} />
      {content}
      <StandInStadium />
      <Field detail={near ? "near" : "far"} pattern={dbg.includes("checks") ? "checks" : "stripes"} />
      <Wicket position={[0, 0, BOWLER_STUMPS_Z]} />
      <Wicket position={[0, 0, STRIKER_STUMPS_Z]} />
    </TestCanvas>
  );
};
