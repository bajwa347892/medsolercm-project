import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import * as THREE from "three";
import { CameraRig } from "../CameraRig";
import { FPS } from "../config";
import { EV } from "../cues";
import type { Vec3 } from "../rig/types";
import { BOWL, DIVE, FIST_PUMP_T, THROW, batStance, bowlRunUp, celebrateFistPump, diveCatch, pickupThrow } from "../rig/actions";
import { Player } from "../rig/Player";
import { playerMatrix, solvePose } from "../rig/solve";
import { Footfalls } from "../fx/DustBurst";
import { GrassSpray, GrassWipe } from "../fx/GrassSpray";
import { floodStreaks } from "../fx/LightStreak";
import { SpeedTrail } from "../fx/SpeedTrail";
import { Splinters } from "../fx/Splinters";
import { TealMotes } from "../fx/TealMotes";
import { Post, type PostProps } from "../post/Post";
import { Atmosphere } from "../world/Atmosphere";
import { Field, GrassBlades } from "../world/Field";
import { StadiumLights, floodMaster, rimDirFor } from "../world/Lights";
import { Ball, Wicket } from "../world/Props";
import { Stadium, stadiumStateAt } from "../world/Stadium";
import { STRIKER_STUMPS_Z } from "../world/dims";
import { wicketHitState } from "../world/wicketPhysics";
import { TestCanvas } from "./TestCanvas";

/**
 * T-FX storyboard (`--props='{"view":"shots"}'`): one frame per shot-like setup, so every effect is
 * judged where the film will use it (S01 aerial streaks, S03 run-up dust, S04/S06 ball-follow trails,
 * S07 dive spray + lens wipe, S08 wipe clear, S09 splinters, S10 low orbit streaks, S12 vortex motes).
 * Frame index -> setup: see SHOTS below. Every frame is independent (a hard cut each frame), which also
 * stress-tests the post pipeline across cuts.
 */

type Setup = {
  label: string;
  F: number;
  cam: Vec3;
  target: Vec3;
  fov: number;
  subject: Vec3;
  focus: Vec3 | null;
  aperture?: number;
  focusRange?: number;
  near: boolean;
  flash?: number;
  crowd?: boolean;
  content: React.ReactNode;
};

const v3 = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];
const toWorld = (p: Vec3, pos: Vec3, rotY: number) => new THREE.Vector3(...p).applyMatrix4(playerMatrix(pos, rotY));

/* ---------------- S01 aerial ---------------- */
const s01 = (F: number, cam: Vec3, target: Vec3, fov: number): Setup => ({
  label: `S01 aerial F${F}`,
  F,
  cam,
  target,
  fov,
  subject: [0, 0, 0],
  focus: null,
  near: false,
  content: <TealMotes t={F / FPS} center={[0, 6, 10]} radius={30} height={10} count={160} size={0.05} />,
});

/* ---------------- S03 run-up ---------------- */
const BOWLER_POS: Vec3 = [0, 0, 9.3];
const BOWLER_ROT = Math.PI;
const runT = (F: number) => (F - 126) / FPS;
const plantAt = (stepT: number): Vec3 => {
  const s = solvePose(bowlRunUp(stepT));
  const l = new THREE.Vector3().setFromMatrixPosition(s.lAnkle);
  const r = new THREE.Vector3().setFromMatrixPosition(s.rAnkle);
  const a = l.y < r.y ? l : r;
  const w = toWorld([a.x, 0, a.z + 0.06], BOWLER_POS, BOWLER_ROT);
  return [w.x, 0, w.z];
};
const RUN_STEPS = BOWL.runUpSteps.slice(1).map((t, i) => ({ frame: EV.footsteps[i], t }));
const runupDust = (F: number) => (
  <Footfalls
    frame={F}
    fps={FPS}
    steps={RUN_STEPS.map((s) => ({ frame: s.frame, position: plantAt(s.t), direction: [0, 0.2, -1.2] as Vec3 }))}
  />
);
const s03side = (F: number): Setup => {
  const pose = bowlRunUp(runT(F));
  const p = toWorld(pose.root, BOWLER_POS, BOWLER_ROT);
  return {
    label: `S03 run-up side F${F}`,
    F,
    cam: [p.x - 2.9, 0.5, p.z - 0.9],
    target: [p.x, 0.75, p.z - 0.2],
    fov: 38,
    subject: v3(p),
    focus: [p.x, 0.9, p.z],
    aperture: 0.012,
    focusRange: 0.5,
    near: true,
    content: (
      <>
        <GrassBlades center={[p.x - 1.6, 0, p.z - 0.6]} radius={2.4} core={1.4} density={4000} F={F} />
        <Player pose={pose} role="bowler" kit="teal" position={BOWLER_POS} rotationY={BOWLER_ROT} ball castShadow />
        {runupDust(F)}
      </>
    ),
  };
};
const s03back = (F: number): Setup => {
  const pose = bowlRunUp(runT(F));
  const p = toWorld(pose.root, BOWLER_POS, BOWLER_ROT);
  return {
    label: `S03 over-shoulder, focus on batsman F${F}`,
    F,
    cam: [p.x - 0.55, 1.72, p.z + 1.5],
    target: [0, 0.9, -9],
    fov: 30,
    subject: [0, 1, -9.3],
    focus: [0, 1.1, -9.35],
    aperture: 0.014,
    focusRange: 0.8,
    near: false,
    content: (
      <>
        <Player pose={pose} role="bowler" kit="teal" position={BOWLER_POS} rotationY={BOWLER_ROT} ball />
        <Player pose={batStance(F / FPS, { liftT: 6.2 })} role="batsman" kit="graphite" position={[0, 0, -9.35]} rotationY={0} />
        <Wicket position={[0, 0, STRIKER_STUMPS_Z]} />
        {runupDust(F)}
      </>
    ),
  };
};

/* ---------------- S04 / S06 ball follow ---------------- */
const deliv = (t: number): Vec3 => {
  const tb = 0.325;
  if (t < tb) return [0.25 - 0.06 * t, 2.15 - 4.91 * t - 4.905 * t * t, 8.7 - 36 * t];
  const u = t - tb;
  return [0.25 - 0.06 * t, 0.036 + 4.45 * u - 4.905 * u * u, 8.7 - 36 * tb - 32 * u];
};
const s04 = (t: number): Setup => {
  const b = deliv(t);
  const cam: Vec3 = [b[0] + 0.22, b[1] + 0.1, b[2] + 1.0];
  return {
    label: `S04 behind the ball, t=${t.toFixed(2)}`,
    F: 200,
    cam,
    target: [b[0] - 0.05, b[1] - 0.15, b[2] - 3],
    fov: 40,
    subject: b,
    focus: b,
    aperture: 0.012,
    focusRange: 0.3,
    near: false,
    content: (
      <>
        <Ball position={b} spin={[-t * 60, 0, 0]} detail="hero" />
        <SpeedTrail path={deliv} t={t} length={0.12} start={0} />
        <Player pose={batStance(t + 6.5, { liftT: 6.2 })} role="batsman" kit="graphite" position={[0, 0, -9.35]} rotationY={0} />
        <Wicket position={[0, 0, STRIKER_STUMPS_Z]} />
      </>
    ),
  };
};
const V6: Vec3 = [9, 15, 27];
const flight = (t: number): Vec3 => [0.3 + V6[0] * t, 0.6 + V6[1] * t - 4.905 * t * t, -8.6 + V6[2] * t];
const s06 = (t: number): Setup => {
  const b = flight(t);
  const d = new THREE.Vector3(V6[0], V6[1] - 9.81 * t, V6[2]).normalize();
  const cam: Vec3 = [b[0] - d.x * 1.3 + 0.1, b[1] - d.y * 1.3 - 0.22, b[2] - d.z * 1.3];
  return {
    label: `S06 ball flight follow, t=${t.toFixed(2)}`,
    F: 290,
    cam,
    target: [b[0] + d.x * 5, b[1] + d.y * 5 + 0.3, b[2] + d.z * 5],
    fov: 42,
    subject: b,
    focus: b,
    aperture: 0.01,
    focusRange: 0.3,
    near: false,
    content: (
      <>
        <Ball position={b} spin={[t * 70, 0, 0]} detail="hero" />
        <SpeedTrail path={flight} t={t} length={0.12} start={0} />
      </>
    ),
  };
};

/* ---------------- S07 dive / S08 throw ---------------- */
const DIVER_POS: Vec3 = [38, 0, 14];
const diverRoot = (t: number) => toWorld(diveCatch(t).root, DIVER_POS, 0);
const s07 = (t: number, wipe = 0): Setup => {
  const pose = diveCatch(t);
  const p = diverRoot(t);
  const camT = Math.min(t, 1.35);
  const pc = diverRoot(camT);
  const LD = DIVE.LAND_T;
  return {
    label: `S07 dive t=${t.toFixed(2)}${wipe ? ` wipe ${wipe.toFixed(2)}` : ""}`,
    F: 350,
    cam: [pc.x - 3.0, 0.3, pc.z + 2.2],
    target: [pc.x - 0.2, 0.32, pc.z - 0.2],
    fov: 36,
    subject: v3(p),
    focus: [p.x, 0.3, p.z],
    aperture: 0.012,
    focusRange: 0.6,
    near: true,
    content: (
      <>
        <GrassBlades center={[pc.x - 1.4, 0, pc.z + 1.0]} radius={2.6} core={1.6} density={4500} F={350} />
        <Player pose={pose} role="fielder" kit="teal" position={DIVER_POS} rotationY={0} castShadow />
        <GrassSpray
          origin={(tt) => {
            const q = diverRoot(LD + tt);
            return [q.x, 0, q.z];
          }}
          t={t - LD}
          duration={DIVE.SLIDE_END_T - LD}
          direction={[-0.45, 0.9, 1.0]}
          count={200}
          speed={3.0}
        />
        {wipe > 0 ? <GrassWipe progress={wipe} /> : null}
      </>
    ),
  };
};
const THROWER_POS: Vec3 = [12, 0, 60];
const s08 = (t: number, wipe: number): Setup => {
  const pose = pickupThrow(t);
  const p = toWorld(pose.root, THROWER_POS, Math.PI);
  return {
    label: `S08 collect t=${t.toFixed(2)} wipe ${wipe.toFixed(2)}`,
    F: 384,
    cam: [p.x + 3.2, 0.45, p.z + 2.2],
    target: [p.x, 0.7, p.z],
    fov: 36,
    subject: v3(p),
    focus: [p.x, 0.7, p.z],
    aperture: 0.01,
    focusRange: 0.8,
    near: true,
    content: (
      <>
        <Player pose={pose} role="fielder" kit="teal" position={THROWER_POS} rotationY={Math.PI} castShadow ball={t > THROW.COLLECT_T} />
        {t <= THROW.COLLECT_T ? <Ball position={[THROWER_POS[0], 0.036, THROWER_POS[2]]} /> : null}
        <GrassWipe progress={wipe} />
      </>
    ),
  };
};

/* ---------------- S09 stumps ---------------- */
const s09 = (age: number): Setup => {
  const w: Vec3 = [0, 0, STRIKER_STUMPS_Z];
  const state = wicketHitState(Math.max(0, age), { dir: [0.1, 0, -1], strength: 1.1, toward: [-0.8, 0.5, 0.4], seed: 7 });
  const ball: Vec3 = [w[0] - 0.4 * age, 0.36 + 0.6 * age - 4.9 * age * age, w[2] + 0.054 + 2.4 * age];
  return {
    label: `S09 side-on stump hit, action age ${age.toFixed(3)} s`,
    F: 440,
    cam: [-1.05, 0.42, w[2] - 0.35],
    target: [0, 0.45, w[2] + 0.05],
    fov: 30,
    subject: [0, 0.4, w[2]],
    focus: [0, 0.4, w[2]],
    aperture: 0.016,
    focusRange: 0.12,
    near: true,
    flash: 0,
    content: (
      <>
        <Wicket position={w} state={state} />
        <Ball position={ball} spin={[age * 40, 0, 0]} />
        <Splinters position={[0, 0.36, w[2] + 0.02]} direction={[0.2, 0.3, 1]} age={age} count={26} />
      </>
    ),
  };
};

/* ---------------- S10 orbit ---------------- */
const CELEB_POS: Vec3 = [1.2, 0, 7];
const s10 = (t: number, ang: number, up: number): Setup => {
  const pose = celebrateFistPump(t);
  const r = 3.4;
  const cam: Vec3 = [CELEB_POS[0] + Math.sin(ang) * r, 0.75, CELEB_POS[2] + Math.cos(ang) * r];
  return {
    label: `S10 low orbit t=${t.toFixed(2)}`,
    F: 474,
    cam,
    target: [CELEB_POS[0], up, CELEB_POS[2]],
    fov: 34,
    subject: [CELEB_POS[0], 1.2, CELEB_POS[2]],
    focus: [CELEB_POS[0], 1.5, CELEB_POS[2]],
    aperture: 0.012,
    focusRange: 0.5,
    near: false,
    content: <Player pose={pose} role="bowler" kit="teal" position={CELEB_POS} rotationY={2.4} castShadow />,
  };
};

/* ---------------- S12 vortex ---------------- */
const ring = (t: number): Vec3 => [Math.cos(t * 3.2) * 4.5, 3 + Math.sin(t * 1.1) * 0.4, Math.sin(t * 3.2) * 4.5];
const s12 = (t: number): Setup => ({
  label: `S12 vortex t=${t.toFixed(2)}`,
  F: 600,
  cam: [0, 4.2, 15],
  target: [0, 3, 0],
  fov: 40,
  subject: [0, 3, 0],
  focus: null,
  near: false,
  content: (
    <>
      <TealMotes t={t} center={[0, 3, 0]} radius={7} height={6} count={600} size={0.02} swirl={1.4} converge={0.35} rise={0.2} glint={0.6} />
      <SpeedTrail path={ring} t={t} length={0.9} width={0.06} opacity={0.8} intensity={2} segments={80} />
      <Ball position={ring(t)} spin={[t * 20, 0, 0]} />
    </>
  ),
});

/* ---------------- S02-like macro bokeh ---------------- */
const MB: Vec3 = [0, 1.4, 26];
const s02 = (a: number): Setup => ({
  label: `S02-like macro bokeh a=${a.toFixed(2)}`,
  F: 100,
  cam: [MB[0] + Math.sin(a) * 0.3, MB[1] - 0.05, MB[2] + Math.cos(a) * 0.3],
  target: [MB[0] - Math.sin(a) * 0.1, MB[1] + 0.045, MB[2] - Math.cos(a) * 0.1],
  fov: 30,
  subject: MB,
  focus: [MB[0] + Math.sin(a) * 0.034, MB[1] - 0.006, MB[2] + Math.cos(a) * 0.034],
  aperture: 0.05,
  focusRange: 0.015,
  near: true,
  content: (
    <>
      <Ball position={MB} spin={[0.5, 0.2, Math.PI / 2]} detail="hero" />
      <TealMotes t={3.3} center={[MB[0], MB[1] + 0.2, MB[2] - 0.8]} radius={1.2} height={1.2} count={60} size={0.004} glint={0.5} />
    </>
  ),
});

/* ---------------- motes beside an in-focus wicket (DOF of transparent FX) ---------------- */
const motesWicket = (): Setup => {
  const w: Vec3 = [0, 0, STRIKER_STUMPS_Z];
  return {
    label: "teal motes beside in-focus stumps",
    F: 440,
    cam: [0.75, 0.38, w[2] + 1.15],
    target: [0, 0.45, w[2]],
    fov: 32,
    subject: [0, 0.4, w[2]],
    focus: [0, 0.45, w[2]],
    aperture: 0.014,
    focusRange: 0.15,
    near: true,
    content: (
      <>
        <Wicket position={w} />
        <TealMotes t={7.5} center={[0, 0.6, w[2]]} radius={0.5} height={0.8} count={50} size={0.004} glint={0.4} />
      </>
    ),
  };
};

export const SHOTS: (() => Setup)[] = [
  () => s01(26, [70, 150, 190], [0, 0, 5], 38),
  () => s01(56, [12, 42, 62], [0, 2, -8], 40),
  () => s03side(150),
  () => s03side(153),
  () => s03back(176),
  () => s04(0.14),
  () => s04(0.24),
  () => s06(0.35),
  () => s07(1.2),
  () => s07(1.42),
  () => s07(1.75, 0.6),
  () => s07(1.78, 0.9),
  () => s07(1.8, 1.0),
  () => s08(THROW.COLLECT_T - 0.2, 1.0),
  () => s08(THROW.COLLECT_T - 0.13, 1.25),
  () => s08(THROW.COLLECT_T - 0.07, 1.6),
  () => s09(0.02),
  () => s09(0.08),
  () => s10(FIST_PUMP_T, -2.3, 1.75),
  () => s10(FIST_PUMP_T - 0.2, -2.75, 2.2),
  () => s12(1.3),
  () => s02(0.1),
  () => motesWicket(),
  () => s04(0.14),
];

export const TFXShots: React.FC<{ post?: boolean; postProps?: PostProps; only?: number }> = ({ post = true, postProps, only }) => {
  const f = useCurrentFrame();
  const idx = only ?? Math.min(f, SHOTS.length - 1);
  const s = SHOTS[idx]();
  const st = stadiumStateAt(s.F);
  const lit = s.F < 66;
  const floods = lit ? st.floods : stadiumStateAt(200).floods;
  const rim = rimDirFor(s.cam, s.subject, 0.55);
  return (
    <AbsoluteFill>
      <TestCanvas label={`T-FX shots #${idx} · ${s.label}`}>
        <CameraRig position={s.cam} target={s.target} fov={s.fov} />
        <Atmosphere F={s.F} floods={floods} motes={s.near ? 0.6 : 1} motesRadius={s.near ? 4 : 10} />
        <Stadium
          F={s.F}
          floods={floods}
          led={lit ? st.led : 1}
          ledSweep={lit ? st.ledSweep : 1}
          energy={st.energy}
          detail={s.near ? "near" : "far"}
          crowd={s.crowd}
        />
        <StadiumLights intensity={floodMaster(floods)} rimDir={rim} shadows shadowCenter={s.subject} shadowSize={s.near ? 3 : 6} />
        <Field detail={s.near ? "near" : "far"} />
        {s.content}
        {post ? (
          <Post
            focus={s.focus}
            aperture={s.aperture}
            focusRange={s.focusRange}
            flash={s.flash ?? 0}
            streaks={floodStreaks(floods)}
            {...postProps}
          />
        ) : null}
      </TestCanvas>
    </AbsoluteFill>
  );
};

