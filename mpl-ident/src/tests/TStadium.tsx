import React, { useMemo } from "react";
import { Easing, useCurrentFrame } from "remotion";
import * as THREE from "three";
import { CameraRig } from "../CameraRig";
import { EASE_IN_OUT, EASE_OUT, lerp, prog } from "../config";
import { floodStreaks } from "../fx/LightStreak";
import { Post } from "../post/Post";
import { PAL } from "../theme";
import type { Vec3 } from "../rig/types";
import { Atmosphere } from "../world/Atmosphere";
import { Field } from "../world/Field";
import { StadiumLights, floodMaster, rimDirFor, withStadiumRim } from "../world/Lights";
import { Stadium, stadiumStateAt } from "../world/Stadium";
import { TestCanvas } from "./TestCanvas";

/**
 * T-Stadium test (240 frames), with the real <Field/> and <Post/> so the stadium is judged the way
 * shots will show it:
 *   0-65    S01 aerial establishing move, cue-accurate (floods on at the flood_on cues, LED sweep at
 *           led_sweep): ~230m up / ~190m out, descending with a 20deg orbit to ~40m over the bowler's end
 *   66-129  ground level from the striker's end looking at the bowler's end, slow pan
 *   130-179 outfield, 0.4m off the grass by the LED boards, looking up at the stand; crowd energy ramps to 1
 *   180-209 long lens toward the big screen and the upper tiers (crowd detail)
 *   210-239 lighting calibration on the pitch (StadiumLights + shadows), detail="near", slow orbit
 *
 * Review mode (--props '{"review":true}'): frame N renders director view N (REVIEW below: S01 x4,
 * S02 bokeh, S03, S05, S06, S07, S08, S10, S12, the -X seam check, S15 roof edge, S15 hero), each
 * at its shot's global frame (stadium state) with its lens and DOF. {"view":N} renders one view on
 * every frame; {"view":N,"F":f} at another stadium frame; {"detail":"near"} forces the detail level.
 *   npx remotion render T-Stadium out/t/stadium/rev --sequence --frames=0-14 --image-format=png \
 *     --scale=0.5 --props '{"review":true}'
 *
 * Debug props (remotion --props): {"beams":0,"haze":0,"motes":0,"post":false,"keyMul":1,"rimMul":1,...}
 */

/* ---------- calibration props: two kit mannequins, material spheres and a ball ---------- */

const Limb: React.FC<{ a: Vec3; b: Vec3; r: number; mat: THREE.Material }> = ({ a, b, r, mat }) => {
  const va = new THREE.Vector3(...a);
  const vb = new THREE.Vector3(...b);
  const d = vb.clone().sub(va);
  const len = d.length();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  const mid = va.clone().add(vb).multiplyScalar(0.5);
  return (
    <mesh position={mid} quaternion={q} material={mat} castShadow>
      <capsuleGeometry args={[r, Math.max(0.01, len - 2 * r), 6, 14]} />
    </mesh>
  );
};

const Mannequin: React.FC<{
  position: Vec3;
  rotY: number;
  shirt: string;
  trousers: string;
  pads?: boolean;
  helmet?: boolean;
}> = ({ position, rotY, shirt, trousers, pads, helmet }) => {
  const m = useMemo(
    () => ({
      // fabric: rough with a soft sheen; every athlete material opts into the stadium rim
      shirt: withStadiumRim(
        new THREE.MeshPhysicalMaterial({ color: shirt, roughness: 0.62, sheen: 0.6, sheenRoughness: 0.45, sheenColor: "#9aa6ab" }),
        1,
      ),
      trousers: withStadiumRim(
        new THREE.MeshPhysicalMaterial({ color: trousers, roughness: 0.7, sheen: 0.5, sheenRoughness: 0.5, sheenColor: "#8a969b" }),
        1,
      ),
      skin: withStadiumRim(new THREE.MeshStandardMaterial({ color: "#8a5a3e", roughness: 0.55 }), 0.6),
      pad: withStadiumRim(new THREE.MeshStandardMaterial({ color: PAL.white, roughness: 0.55 }), 0.4),
      helmet: withStadiumRim(
        new THREE.MeshPhysicalMaterial({ color: "#1b2330", roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.08 }),
        0.8,
      ),
      shoe: withStadiumRim(new THREE.MeshStandardMaterial({ color: PAL.white, roughness: 0.5 }), 0.4),
      bat: withStadiumRim(new THREE.MeshStandardMaterial({ color: PAL.willow, roughness: 0.5 }), 0.6),
    }),
    [shirt, trousers],
  );
  return (
    <group position={position} rotation={[0, rotY, 0]}>
      {/* legs */}
      <Limb a={[-0.11, 0.95, 0]} b={[-0.14, 0.5, 0.04]} r={0.075} mat={m.trousers} />
      <Limb a={[-0.14, 0.5, 0.04]} b={[-0.15, 0.1, -0.02]} r={0.058} mat={pads ? m.pad : m.trousers} />
      <Limb a={[0.11, 0.95, 0]} b={[0.16, 0.5, 0.06]} r={0.075} mat={m.trousers} />
      <Limb a={[0.16, 0.5, 0.06]} b={[0.18, 0.1, 0.0]} r={0.058} mat={pads ? m.pad : m.trousers} />
      <Limb a={[-0.15, 0.06, 0.04]} b={[-0.15, 0.06, -0.12]} r={0.045} mat={m.shoe} />
      <Limb a={[0.18, 0.06, 0.08]} b={[0.18, 0.06, -0.08]} r={0.045} mat={m.shoe} />
      {/* torso: hips, chest, shoulder line */}
      <Limb a={[-0.06, 0.98, 0]} b={[0.06, 0.98, 0]} r={0.13} mat={m.trousers} />
      <mesh position={[0, 1.22, 0.02]} scale={[1, 1, 0.62]} castShadow material={m.shirt}>
        <capsuleGeometry args={[0.16, 0.3, 6, 16]} />
      </mesh>
      <Limb a={[-0.2, 1.42, 0.02]} b={[0.2, 1.42, 0.02]} r={0.075} mat={m.shirt} />
      {/* arms */}
      <Limb a={[-0.24, 1.42, 0.02]} b={[-0.28, 1.13, 0.1]} r={0.055} mat={m.shirt} />
      <Limb a={[-0.28, 1.13, 0.1]} b={[-0.18, 0.95, 0.28]} r={0.045} mat={m.skin} />
      <Limb a={[0.24, 1.42, 0.02]} b={[0.27, 1.13, 0.12]} r={0.055} mat={m.shirt} />
      <Limb a={[0.27, 1.13, 0.12]} b={[0.12, 0.98, 0.3]} r={0.045} mat={m.skin} />
      {/* neck + head */}
      <Limb a={[0, 1.5, 0.02]} b={[0, 1.58, 0.03]} r={0.05} mat={m.skin} />
      <mesh position={[0, 1.68, 0.03]} castShadow material={helmet ? m.helmet : m.skin}>
        <sphereGeometry args={[helmet ? 0.135 : 0.11, 32, 20]} />
      </mesh>
      {/* a flat blade held in front */}
      {pads ? (
        <mesh position={[-0.03, 0.6, 0.34]} rotation={[0.12, 0, 0]} castShadow material={m.bat}>
          <boxGeometry args={[0.108, 0.56, 0.05]} />
        </mesh>
      ) : null}
    </group>
  );
};

const Calibration: React.FC = () => (
  <group>
    {[
      { x: -0.9, c: "#d8dcde", r: 0.6, m: 0 },
      { x: -0.2, c: PAL.graphite, r: 0.55, m: 0 },
      { x: 0.5, c: PAL.tealDeep, r: 0.4, m: 0.3 },
      { x: 1.2, c: PAL.silver, r: 0.12, m: 1 },
    ].map((s) => (
      <mesh key={s.x} position={[s.x, 0.3, 1.9]} castShadow>
        <sphereGeometry args={[0.3, 48, 24]} />
        <meshStandardMaterial color={s.c} roughness={s.r} metalness={s.m} />
      </mesh>
    ))}
    <mesh position={[0.15, 0.036, 1.0]} castShadow>
      <sphereGeometry args={[0.036, 32, 16]} />
      <meshPhysicalMaterial color={PAL.leather} roughness={0.45} clearcoat={1} clearcoatRoughness={0.15} />
    </mesh>
    <Mannequin position={[-1.3, 0, 0.2]} rotY={0.5} shirt={PAL.tealDeep} trousers={PAL.graphite} />
    <Mannequin position={[1.3, 0, 0.0]} rotY={-0.4} shirt={PAL.graphite} trousers="#1b3438" pads helmet />
  </group>
);

/* ---------- camera plan ---------- */

type Cam = { pos: Vec3; target: Vec3; fov: number; near: number };

// slow, high glide while the banks ignite (cues 10-47), then an accelerating push to the cut
const DRONE = Easing.bezier(0.5, 0.0, 0.85, 0.55);

const camAt = (f: number): Cam => {
  if (f < 66) {
    // S01: very high and wide, descending and pushing in with a ~20deg orbit, ending ~40m up over
    // the bowler's end looking down the pitch.
    const p = prog(f, 0, 66, DRONE);
    const ang = THREE.MathUtils.degToRad(lerp(112, 90, p));
    const rad = lerp(190, 34, p);
    const y = lerp(230, 40, p);
    return {
      pos: [Math.cos(ang) * rad, y, Math.sin(ang) * rad],
      target: [0, lerp(10, 0, p), lerp(-40, -14, p)],
      fov: lerp(40, 46, p),
      near: 1,
    };
  }
  if (f < 130) {
    const p = prog(f, 66, 130, EASE_IN_OUT);
    return {
      pos: [lerp(3.5, 1.5, p), 1.55, -15.5],
      target: [lerp(-30, 26, p), 17, 60],
      fov: 52,
      near: 0.2,
    };
  }
  if (f < 180) {
    // outfield, low by the boundary boards (an S07-style ground camera), the stand under bank 1
    const p = prog(f, 130, 180, EASE_OUT);
    const a = THREE.MathUtils.degToRad(lerp(38, 47, p));
    const r = lerp(55, 59, p);
    return {
      pos: [Math.cos(a) * r, lerp(0.4, 0.5, p), Math.sin(a) * r],
      target: [Math.cos(a + 0.14) * 100, lerp(6, 9, p), Math.sin(a + 0.14) * 100],
      fov: 42,
      near: 0.1,
    };
  }
  if (f < 210) {
    // longer lens from mid-pitch toward the big screen and the packed upper tiers
    const p = prog(f, 180, 210, EASE_IN_OUT);
    const a = THREE.MathUtils.degToRad(247.5);
    return {
      pos: [lerp(6, 2, p), 1.7, lerp(8, 10, p)],
      target: [Math.cos(a) * 100 + lerp(-12, 12, p), 30, Math.sin(a) * 100],
      fov: 22,
      near: 0.2,
    };
  }
  // calibration: low broadcast angle orbiting the two mannequins
  const p = prog(f, 210, 240, EASE_IN_OUT);
  const a = lerp(-2.05, -1.35, p);
  return {
    pos: [Math.cos(a) * 5.2, 1.35, 0.6 + Math.sin(a) * 5.2],
    target: [0, 0.95, 0.6],
    fov: 38,
    near: 0.05,
  };
};

/* ---------- review views: what each shot's director will point the lens at ---------- */

type View = {
  name: string;
  /** global frame (stadium state, crowd energy) */
  F: number;
  cam: Cam;
  detail?: "far" | "near";
  beams?: number;
  /** Post depth of field: world focus point and background blur (fraction of frame height) */
  focus?: Vec3;
  aperture?: number;
  subject?: Vec3;
};

const aerialView = (name: string, F: number): View => ({ name, F, cam: camAt(F), beams: 2.2, subject: [0, 1, 0] });

const REVIEW: View[] = [
  aerialView("S01 F8 pre-flood: graphite silhouettes", 8),
  aerialView("S01 F20 two banks on, third flickering", 20),
  aerialView("S01 F41 six banks", 41),
  aerialView("S01 F62 all banks, LED swept, end of the move", 62),
  {
    name: "S02 macro background (bokeh)",
    F: 96,
    cam: { pos: [0.3, 1.36, 26.3], target: [0, 1.42, 25.98], fov: 30, near: 0.02 },
    detail: "near",
    beams: 0.9,
    focus: [0, 1.4, 26.0],
    aperture: 0.045,
  },
  {
    name: "S03 over the bowler's shoulder to the striker's end",
    F: 172,
    cam: { pos: [0.75, 1.75, 16.5], target: [0, 1.0, -10.06], fov: 24, near: 0.1 },
    focus: [0, 1.0, -9.5],
    aperture: 0.01,
    subject: [0, 1, 12],
  },
  {
    name: "S05 off-side profile of the batsman (tele)",
    F: 240,
    cam: { pos: [-5.2, 1.15, -8.4], target: [0, 1.05, -8.6], fov: 26, near: 0.1 },
    focus: [-0.4, 1.0, -8.6],
    aperture: 0.012,
    subject: [-0.4, 1, -8.6],
  },
  {
    name: "S06 ball-follow up toward the deep mid-wicket stand",
    F: 292,
    cam: { pos: [16, 10, 14], target: [62, 24, 60], fov: 46, near: 0.1 },
    focus: [22, 13, 20],
    aperture: 0.006,
  },
  {
    name: "S07 outfield ground cam (0.3m) toward long-on boards",
    F: 336,
    cam: { pos: [20, 0.3, 50], target: [31, 2.6, 66], fov: 40, near: 0.05 },
    focus: [25, 0.9, 56],
    aperture: 0.008,
    subject: [25, 1, 56],
  },
  {
    name: "S08 boundary fielder: LED boards 5m away",
    F: 386,
    cam: { pos: [-38, 0.9, -48], target: [-46, 1.6, -58], fov: 38, near: 0.05 },
    focus: [-42, 1.0, -52.5],
    aperture: 0.01,
    subject: [-42, 1, -52.5],
  },
  {
    name: "S10 celebration orbit, low, lamps behind",
    F: 482,
    cam: { pos: [3.0, 1.1, 5.0], target: [-3.0, 3.0, 14.0], fov: 34, near: 0.1 },
    focus: [-1, 1.4, 9],
    aperture: 0.01,
    subject: [-1, 1.2, 9],
  },
  {
    name: "S12 fast through the stadium, crowd + LED ring",
    F: 600,
    cam: { pos: [-52, 7, -30], target: [-75, 14, 20], fov: 50, near: 0.1 },
  },
  {
    name: "seam check: the -X stands and boards (theta = +-180deg)",
    F: 300,
    cam: { pos: [-35, 3, 6], target: [-90, 12, -2], fov: 45, near: 0.1 },
  },
  {
    name: "S15 start: rising back over the roof edge",
    F: 745,
    cam: { pos: [12, 78, -150], target: [0, 8, 10], fov: 44, near: 0.5 },
    beams: 1.3,
  },
  {
    name: "S15 hero pull-back over the stadium",
    F: 780,
    cam: { pos: [-60, 175, -340], target: [0, 10, -10], fov: 36, near: 1 },
    beams: 1.6,
  },
];

type DebugProps = {
  beams?: number;
  haze?: number;
  motes?: number;
  post?: boolean;
  crowd?: boolean;
  keyMul?: number;
  rimMul?: number;
  lift?: number;
  fillMul?: number;
  side?: number;
  /** inspection camera override: [px,py,pz, tx,ty,tz, fov] */
  cam?: number[];
  fog?: number;
  /** review mode: frame N renders REVIEW[N] */
  review?: boolean;
  /** render one review view at every frame */
  view?: number;
  /** override the stadium state frame (with cam) */
  F?: number;
  /** force the stadium detail level */
  detail?: "far" | "near";
};

export const TStadium: React.FC<DebugProps> = ({
  beams = 1,
  haze = 1,
  motes = 1,
  post = true,
  crowd,
  keyMul = 1,
  rimMul = 1,
  lift,
  fillMul = 1,
  side,
  cam: camOv,
  fog,
  review,
  view,
  F: Fov,
  detail: detailOv,
}) => {
  const frame = useCurrentFrame();
  const vi = view ?? (review ? Math.min(frame, REVIEW.length - 1) : -1);
  const rv = vi >= 0 ? REVIEW[vi] : null;
  let cam: Cam = rv ? rv.cam : camAt(frame);
  if (camOv) cam = { pos: [camOv[0], camOv[1], camOv[2]], target: [camOv[3], camOv[4], camOv[5]], fov: camOv[6] ?? 35, near: 0.1 };
  const F = Fov ?? (rv ? rv.F : frame);
  const st = stadiumStateAt(F);
  let energy = st.energy;
  if (!rv && frame >= 130 && frame < 210) energy = lerp(0.4, 1, prog(frame, 130, 175));
  const master = floodMaster(st.floods);
  const near = detailOv ? detailOv === "near" : rv ? rv.detail === "near" : frame >= 210;
  const calib = !rv && frame >= 210;
  const subject: Vec3 = rv?.subject ?? (calib ? [0, 1.0, 0.6] : [0, 1, 0]);
  const beamGain = rv?.beams ?? (frame < 66 ? 2.2 : 1);
  const label = rv
    ? `review ${vi}: ${rv.name}`
    : frame < 66
      ? "S01 aerial / awaken"
      : frame < 130
        ? "pitch level"
        : frame < 180
          ? "outfield by the boards, energy ramp"
          : frame < 210
            ? "big screen, upper tiers"
            : "lighting calibration";
  const streaks = floodStreaks(st.floods);
  return (
    <TestCanvas label={`T-Stadium · ${label} · F${F}`}>
      <CameraRig position={cam.pos} target={cam.target} fov={cam.fov} near={cam.near} far={2400} />
      <Atmosphere
        F={F}
        floods={st.floods}
        haze={haze}
        fogDensity={fog}
        motes={motes}
        motesRadius={near ? 6 : 12}
        motesHeight={near ? 5 : 8}
      />
      <Stadium
        F={F}
        floods={st.floods}
        led={st.led}
        ledSweep={st.ledSweep}
        energy={energy}
        detail={near ? "near" : "far"}
        beams={beams * beamGain}
        crowd={crowd}
      />
      <StadiumLights
        intensity={master}
        rimDir={rimDirFor(cam.pos, subject, side, lift)}
        keyGain={keyMul}
        fill={fillMul}
        rim={rimMul}
        shadows={calib}
        shadowCenter={[0, 0, 0.6]}
        shadowSize={4}
      />
      <Field detail={near || cam.pos[1] < 3 ? "near" : "far"} />
      {calib ? <Calibration /> : null}
      {post ? (
        <Post
          focus={rv?.focus ?? (calib ? [0, 1.0, 0.6] : null)}
          aperture={rv?.aperture ?? 0.006}
          focusRange={rv?.focus ? 0.4 : 0.6}
          maxBlur={near ? 0.045 : 0.035}
          streaks={streaks}
        />
      ) : null}
    </TestCanvas>
  );
};
