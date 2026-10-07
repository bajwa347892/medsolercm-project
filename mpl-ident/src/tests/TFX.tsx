import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import * as THREE from "three";
import { CameraRig } from "../CameraRig";
import { EASE_IN_OUT, FPS, actionTime, lerp, prog } from "../config";
import { PAL } from "../theme";
import type { Vec3 } from "../rig/types";
import { BAT as BAT_T, batDrive, fielderReady } from "../rig/actions";
import { Player } from "../rig/Player";
import { batContact } from "../rig/solve";
import { DustBurst } from "../fx/DustBurst";
import { GrassSpray, GrassWipe } from "../fx/GrassSpray";
import { ImpactFlash } from "../fx/ImpactFlash";
import { LightStreak, floodStreaks } from "../fx/LightStreak";
import { SpeedTrail } from "../fx/SpeedTrail";
import { Splinters } from "../fx/Splinters";
import { TealMotes } from "../fx/TealMotes";
import { Post, flashAt, type PostProps } from "../post/Post";
import { Atmosphere } from "../world/Atmosphere";
import { Field, GrassBlades } from "../world/Field";
import { StadiumLights, floodMaster, rimDirFor } from "../world/Lights";
import { BAT_SWEET_SPOT, Ball, Bat, Wicket } from "../world/Props";
import { Stadium, stadiumStateAt } from "../world/Stadium";
import { STRIKER_STUMPS_Z } from "../world/dims";
import { wicketHitState } from "../world/wicketPhysics";
import { TestCanvas } from "./TestCanvas";
import { TFXShots } from "./TFXShots";

/**
 * T-FX (240 frames), every view with the full post stack on:
 *   0-59    GRID: the seven effects side by side on the outfield (labelled), each re-triggering
 *   60-119  MACRO: ball at the top of the run-up, 0.3 m lens, stadium lamps into bokeh, teal motes, streaks
 *   120-179 CONTACT: bat meets ball in a slow-motion ramp: ImpactFlash + Post flash, speed trail, dust
 *   180-239 SLIDE + WIPE: low turf camera, slide spray, lens-filling GrassWipe (full cover at 213 = cut),
 *           clears onto an ultra-slow stump hit with splinters
 * Storyboard of shot-like views (one setup per frame, see TFXShots.tsx): {"view":"shots"}, {"view":"shots","only":12}
 * Debug props (remotion --props): {"post":false} | {"debug":"coc"} | {"debug":"bloom"} | {"crowd":false}
 *   | {"postProps":{"focus":null,"bloom":0}} (overrides any Post prop, for A/B and profiling)
 */

const LIT = stadiumStateAt(200); // all banks on
const MASTER = floodMaster(LIT.floods);

type Seg = {
  label: string;
  cam: Vec3;
  target: Vec3;
  fov: number;
  subject: Vec3;
  focus: Vec3 | null;
  aperture: number;
  focusRange: number;
  maxBlur?: number;
  near: boolean;
  flash: number;
  content: React.ReactNode;
};

/* ------------------------------------------------------------------ */
/* A: grid                                                             */
/* ------------------------------------------------------------------ */

const GRID_C: Vec3 = [-18, 0, 22];
const cell = (col: number, row: number): Vec3 => [GRID_C[0] + (col - 1.5) * 1.55, 0, GRID_C[2] + (row - 0.5) * 1.9];
const GRID_CAM: Vec3 = [GRID_C[0] + 0.3, 1.55, GRID_C[2] + 5.4];
const GRID_TGT: Vec3 = [GRID_C[0], 0.62, GRID_C[2] - 0.3];
const GRID_FOV = 40;
const CELLS: { name: string; at: Vec3 }[] = [
  { name: "DustBurst", at: cell(0, 1) },
  { name: "GrassSpray", at: cell(1, 1) },
  { name: "ImpactFlash", at: cell(2, 1) },
  { name: "Splinters", at: cell(3, 1) },
  { name: "SpeedTrail", at: cell(0, 0) },
  { name: "TealMotes", at: cell(1, 0) },
  { name: "LightStreak", at: cell(2, 0) },
  { name: "GrassSpray slide", at: cell(3, 0) },
];

/** loop age in seconds for an event repeating every `period` frames, first at `at` */
const loopAge = (f: number, at: number, period: number) => {
  const d = f - at;
  return d < 0 ? d / FPS : (d % period) / FPS;
};

const Lamp: React.FC<{ at: Vec3; level: number }> = ({ at, level }) => {
  const mat = React.useMemo(() => new THREE.MeshBasicMaterial({ toneMapped: false }), []);
  mat.color.set(PAL.floodWhite).multiplyScalar(40 * level);
  return (
    <group position={at}>
      <mesh position={[0, 1.2, 0]}>
        <cylinderGeometry args={[0.015, 0.02, 2.4, 8]} />
        <meshStandardMaterial color={PAL.graphite} roughness={0.5} metalness={0.6} />
      </mesh>
      <mesh position={[0, 2.45, 0]}>
        <boxGeometry args={[0.26, 0.16, 0.05]} />
        <meshStandardMaterial color={PAL.graphiteDark} roughness={0.4} metalness={0.5} />
      </mesh>
      <mesh position={[0, 2.45, 0.026]} material={mat}>
        <planeGeometry args={[0.22, 0.12]} />
      </mesh>
      <LightStreak position={[at[0], at[1] + 2.45, at[2] + 0.03]} intensity={level} length={0.25} />
    </group>
  );
};

const gridSeg = (f: number): Seg => {
  const c = CELLS.map((x) => x.at);
  // ImpactFlash cell: bat vertical, face toward +Z, ball arrives from +Z and leaves back up
  const batPos: Vec3 = [c[2][0], 0.62, c[2][2]];
  const contact = new THREE.Vector3(...BAT_SWEET_SPOT).add(new THREE.Vector3(...batPos));
  const hitAge = loopAge(f, 14, 30);
  const ballIn = (t: number): Vec3 => [contact.x + 0.02 * t, contact.y - 0.4 * t, contact.z + 0.036 - 14 * t];
  const ballOut = (t: number): Vec3 => [contact.x - 0.8 * t, contact.y + 3.5 * t - 4.9 * t * t, contact.z + 0.036 + 9 * t];
  const ballAt = (t: number) => (t < 0 ? ballIn(t) : ballOut(t));
  // Splinters cell: a throw hits the middle stump at 20 (+30)
  const stumpAge = loopAge(f, 20, 30);
  const wpos = c[3];
  const wstate = wicketHitState(Math.max(0, stumpAge), { dir: [0, 0, -1], strength: 1, seed: 3 });
  const throwBall: Vec3 =
    stumpAge < 0 ? [wpos[0], 0.42, wpos[2] + 0.04 - 18 * stumpAge] : [wpos[0] + 0.3 * stumpAge, 0.42 - 0.5 * stumpAge, wpos[2] + 0.04 + 2 * stumpAge];
  // SpeedTrail cell: a ball looping on a tilted ellipse
  const loop = (t: number): Vec3 => [c[4][0] + Math.cos(t * 4.2) * 0.55, 0.8 + Math.sin(t * 4.2) * 0.35 + Math.cos(t * 2.1) * 0.1, c[4][2] + Math.sin(t * 4.2) * 0.4];
  const tt = f / FPS;
  // slide cell: emitter sweeping across the cell
  const slideT = loopAge(f, 6, 40);
  const slideO = (t: number): Vec3 => [c[7][0] + 0.5 - 1.6 * t, 0, c[7][2] + 0.2];
  return {
    label: "A grid",
    cam: GRID_CAM,
    target: GRID_TGT,
    fov: GRID_FOV,
    subject: [GRID_C[0], 0.6, GRID_C[2]],
    focus: [GRID_C[0], 0.6, GRID_C[2]],
    aperture: 0.005,
    focusRange: 1.6,
    near: false,
    flash: 0,
    content: (
      <>
        <DustBurst position={c[0]} age={loopAge(f, 2, 20)} amount={0.9} seed={1} />
        <DustBurst position={[c[0][0] + 0.5, 0, c[0][2] - 0.3]} age={loopAge(f, 12, 20)} amount={0.6} seed={2} />
        <GrassSpray origin={c[1]} direction={[0.5, 1.2, 0.4]} t={loopAge(f, 8, 30)} count={120} speed={2.6} seed={4} />
        <Bat position={batPos} rotation={[0, 0, 0]} />
        <Ball position={ballAt(hitAge)} spin={[f * 0.3, 0, 0]} />
        <ImpactFlash position={[contact.x, contact.y, contact.z + 0.036]} normal={[0, 0, 1]} age={hitAge} />
        <SpeedTrail path={ballAt} t={hitAge} length={0.12} start={0.004} width={0.03} />
        <Wicket position={wpos} state={wstate} />
        {stumpAge < 0.6 ? <Ball position={throwBall} /> : null}
        <Splinters position={[wpos[0], 0.42, wpos[2] + 0.02]} direction={[0.1, 0.2, 1]} age={stumpAge} seed={5} />
        <Ball position={loop(tt)} spin={[tt * 9, 0, 0]} />
        <SpeedTrail path={loop} t={tt} length={0.28} width={0.032} />
        <TealMotes t={tt} center={[c[5][0], 0.9, c[5][2]]} radius={0.5} height={1.6} count={110} size={0.008} rise={0.15} glint={0.8} />
        <Lamp at={c[6]} level={1} />
        <Player pose={fielderReady(f / FPS)} role="fielder" kit="teal" position={[GRID_C[0] + 0.4, 0, GRID_C[2] - 2.6]} rotationY={0.25} />
        <GrassSpray origin={slideO} t={slideT} duration={0.6} direction={[-0.6, 0.9, 0.35]} count={160} speed={2.0} seed={8} />
      </>
    ),
  };
};

/* ------------------------------------------------------------------ */
/* B: macro                                                            */
/* ------------------------------------------------------------------ */

const BALL_M: Vec3 = [0, 1.4, 26];
const macroSeg = (f: number): Seg => {
  const t = prog(f, 60, 119, EASE_IN_OUT);
  const a = lerp(-0.35, 0.25, t);
  const d = 0.3;
  const cam: Vec3 = [BALL_M[0] + Math.sin(a) * d, BALL_M[1] - 0.05, BALL_M[2] + Math.cos(a) * d];
  // look past the ball, up toward the far banks
  const target: Vec3 = [BALL_M[0] - Math.sin(a) * 0.1, BALL_M[1] + 0.045, BALL_M[2] - Math.cos(a) * 0.1];
  return {
    label: "B macro bokeh",
    cam,
    target,
    fov: 30,
    subject: BALL_M,
    // focus on the near face of the ball (the seam the camera sees), not its centre
    focus: [BALL_M[0] + Math.sin(a) * 0.034, BALL_M[1] - 0.006, BALL_M[2] + Math.cos(a) * 0.034],
    aperture: 0.05,
    focusRange: 0.015,
    maxBlur: 0.045,
    near: true,
    flash: 0,
    content: (
      <>
        <Ball position={BALL_M} spin={[0.3 + f * 0.004, 0.2, Math.PI / 2]} detail="hero" />
        <TealMotes t={f / FPS} center={[BALL_M[0], BALL_M[1] + 0.3, BALL_M[2] - 1.5]} radius={2.2} height={1.6} count={70} size={0.006} glint={0.5} />
      </>
    ),
  };
};

/* ------------------------------------------------------------------ */
/* C: contact                                                          */
/* ------------------------------------------------------------------ */

const C_HIT = 146;
const C_KEYS: [number, number][] = [
  [120, 1],
  [138, 1],
  [143, 0.12],
  [152, 0.12],
  [160, 0.6],
];
const BATSMAN_POS: Vec3 = [0, 0, -9.35];
const contactSeg = (f: number): Seg => {
  // S05-like profile: a real front-foot drive, contact exactly on the sweet spot at C_HIT,
  // camera on the off side (-X) so the bat arc is in profile
  const at = actionTime(f, C_KEYS) - actionTime(C_HIT, C_KEYS);
  const pose = batDrive(BAT_T.CONTACT_T + at);
  const hit = batContact(batDrive(BAT_T.CONTACT_T), BATSMAN_POS, 0);
  const c = hit.ballCentre;
  const n = hit.normal;
  const path = (t: number): Vec3 =>
    t < 0
      ? [c[0] + 0.02 * t, c[1] - 0.4 * t, c[2] - 30 * t]
      : [c[0] + n[0] * 28 * t, c[1] + n[1] * 28 * t + 3.5 * t - 4.9 * t * t, c[2] + n[2] * 28 * t];
  const screenAge = (f - C_HIT) / FPS;
  const k = prog(f, 120, 179);
  const sp = hit.spot;
  const cam: Vec3 = [sp[0] - lerp(3.3, 3.0, k), lerp(0.95, 0.85, k), sp[2] + lerp(0.9, 0.6, k)];
  return {
    label: "C contact + flash",
    cam,
    target: [sp[0] - 0.1, 0.92, sp[2] + 0.2],
    fov: 36,
    subject: [sp[0], 0.9, sp[2]],
    focus: [sp[0], sp[1], sp[2]],
    aperture: 0.012,
    focusRange: 0.45,
    near: true,
    flash: flashAt(f, C_HIT, 2.5),
    content: (
      <>
        <Player pose={pose} role="batsman" kit="graphite" position={BATSMAN_POS} rotationY={0} castShadow />
        <Wicket position={[0, 0, STRIKER_STUMPS_Z]} />
        <Ball position={path(at)} spin={[at * 60, 0, 0]} />
        <ImpactFlash position={sp} normal={n} age={screenAge} />
        <SpeedTrail path={path} t={at} length={0.05} start={0.002} width={0.028} />
        <DustBurst position={[0.18, 0, BATSMAN_POS[2] + 0.75]} age={at + 0.13} amount={0.8} direction={[0, 0, 0.5]} />
      </>
    ),
  };
};

/* ------------------------------------------------------------------ */
/* D: slide + wipe                                                     */
/* ------------------------------------------------------------------ */

const WIPE_FULL = 213;
const D_HIT = 224;
const D_KEYS: [number, number][] = [
  [213, 1],
  [221, 1],
  [223, 0.06],
  [239, 0.06],
];
const slideSeg = (f: number): Seg => {
  const wipeP = f < WIPE_FULL ? prog(f, 201, WIPE_FULL, (x) => x) : 1 + prog(f, WIPE_FULL, 220, (x) => x);
  if (f < WIPE_FULL) {
    const slideStart = 186;
    const so = (t: number): Vec3 => [lerp(1.6, -1.4, Math.min(1, t / 0.75)), 0, 30.5];
    const cam: Vec3 = [0.2, 0.32, 33.6];
    return {
      label: "D slide spray -> lens wipe",
      cam,
      target: [0, 0.25, 30.3],
      fov: 34,
      subject: [0, 0.3, 30.5],
      focus: [0, 0.2, 30.5],
      aperture: 0.012,
      focusRange: 0.6,
      near: true,
      flash: 0,
      content: (
        <>
          <GrassBlades center={[0, 0, 31.6]} radius={2.6} core={1.6} density={4500} wind={0.4} F={f} />
          <GrassSpray origin={so} t={(f - slideStart) / FPS} duration={0.75} direction={[-0.5, 1.0, 0.75]} count={220} speed={3.0} seed={12} />
          <GrassWipe progress={wipeP} rate={1 / (WIPE_FULL - 201)} />
        </>
      ),
    };
  }
  const at = actionTime(f, D_KEYS) - actionTime(D_HIT, D_KEYS);
  const w: Vec3 = [0, 0, STRIKER_STUMPS_Z];
  const state = wicketHitState(Math.max(0, at), { dir: [0.15, 0, -1], strength: 1.1, toward: [0.6, 0.6, 1], seed: 7 });
  // the ball strikes the front of the middle stump and rebounds off to the side (never through it)
  const ballP: Vec3 =
    at < 0 ? [w[0] - 0.02 * at, 0.36, w[2] + 0.054 - 22 * at] : [w[0] + 1.4 * at, 0.36 + 0.9 * at - 4.9 * at * at, w[2] + 0.054 + 2.2 * at];
  return {
    label: "D wipe clears -> stump hit (slow)",
    cam: [0.75, 0.38, w[2] + 1.15],
    target: [0, 0.45, w[2]],
    fov: 32,
    subject: [0, 0.4, w[2]],
    focus: [0, 0.45, w[2]],
    aperture: 0.014,
    focusRange: 0.15,
    near: true,
    flash: flashAt(f, D_HIT, 2),
    content: (
      <>
        <Wicket position={w} state={state} />
        <Ball position={ballP} spin={[at * 40, 0, 0]} />
        <Splinters position={[0, 0.36, w[2] + 0.02]} direction={[0.2, 0.3, 1]} age={at} count={26} />
        <TealMotes t={f / FPS} center={[0, 0.8, w[2]]} radius={1.6} height={1.4} count={60} size={0.005} glint={0.4} />
        <GrassWipe progress={wipeP} rate={1 / 7} />
      </>
    ),
  };
};

/* ------------------------------------------------------------------ */

export const TFX: React.FC<{
  post?: boolean;
  debug?: "coc" | "bloom";
  crowd?: boolean;
  postProps?: PostProps;
  /** "shots": the shot-like storyboard in TFXShots.tsx (one setup per frame) */
  view?: "grid" | "shots";
  /** with view "shots": render this setup on every frame */
  only?: number;
}> = (props) => (props.view === "shots" ? <TFXShots post={props.post} postProps={props.postProps} only={props.only} /> : <TFXGrid {...props} />);

const TFXGrid: React.FC<{ post?: boolean; debug?: "coc" | "bloom"; crowd?: boolean; postProps?: PostProps }> = ({
  post = true,
  debug,
  crowd,
  postProps,
}) => {
  const f = useCurrentFrame();
  const seg = f < 60 ? gridSeg(f) : f < 120 ? macroSeg(f) : f < 180 ? contactSeg(f) : slideSeg(f);
  const rim = rimDirFor(seg.cam, seg.subject, 0.55);
  // labels for the grid (camera is static there)
  let labels: { name: string; x: number; y: number }[] = [];
  if (f < 60) {
    const cam = new THREE.PerspectiveCamera(GRID_FOV, 16 / 9, 0.1, 100);
    cam.position.set(...GRID_CAM);
    cam.lookAt(new THREE.Vector3(...GRID_TGT));
    cam.updateMatrixWorld();
    labels = CELLS.map((c) => {
      const v = new THREE.Vector3(c.at[0], -0.05, c.at[2]).project(cam);
      return { name: c.name, x: (v.x * 0.5 + 0.5) * 100, y: (0.5 - v.y * 0.5) * 100 };
    });
  }
  return (
    <AbsoluteFill>
      <TestCanvas label={`T-FX · ${seg.label} · F${f}`}>
        <CameraRig position={seg.cam} target={seg.target} fov={seg.fov} />
        <Atmosphere F={200} floods={LIT.floods} motes={seg.near ? 0.6 : 1} motesRadius={seg.near ? 4 : 10} />
        <Stadium F={200 + f} floods={LIT.floods} led={1} ledSweep={1} energy={0.6} detail={seg.near ? "near" : "far"} crowd={crowd} />
        <StadiumLights intensity={MASTER} rimDir={rim} shadows shadowCenter={seg.subject} shadowSize={seg.near ? 3 : 7} />
        <Field detail={seg.near ? "near" : "far"} />
        {seg.content}
        {post ? (
          <Post
            focus={seg.focus}
            aperture={seg.aperture}
            focusRange={seg.focusRange}
            maxBlur={seg.maxBlur}
            flash={seg.flash}
            streaks={floodStreaks(LIT.floods)}
            debug={debug ?? null}
            {...postProps}
          />
        ) : null}
      </TestCanvas>
      {labels.map((l) => (
        <div
          key={l.name}
          style={{
            position: "absolute",
            left: `${l.x}%`,
            top: `${l.y}%`,
            transform: "translate(-50%, 0)",
            color: "rgba(160,255,255,0.85)",
            font: "16px monospace",
            textShadow: "0 0 4px #000",
          }}
        >
          {l.name}
        </div>
      ))}
    </AbsoluteFill>
  );
};
