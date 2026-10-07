/**
 * T-Hand: the macro hand (SPEC §6.4).
 *
 * Default view "orbit" (240 frames):
 *   0-59    S02 exactly: t = frame / 30 (cue-synced ball handling, breathing, run start at frame 52),
 *           camera arcing ~40deg in front of the hand from slightly below (0.34 -> 0.29 m), focus on the seam,
 *           stadium floodlights and LED boards as bokeh.
 *   60-239  slow 120deg orbit from front-left, past the thumb side, rising to 3/4 behind (knuckles, seam
 *           between index and middle) while the grip replays at ~0.3x (t 0 -> 1.72 s), focus on the seam.
 * Post: the film's <Post/> (thin-lens DOF focused on the seam, aperture 0.05 = S02 macro).
 * Debug views (remotion --props): {"view":"grid"} four angles without post ("angles":[[az,el],...] to choose
 *   them), {"view":"one","az":-90,"el":5,"dist":0.3,"t":1.7} a single angle ("look":[x,y,z] aim offset from
 *   the hand), {"clay":true} form check, {"post":false} no post stack, {"bg":false} no stadium,
 *   {"cuff":"none"} bare wrist, {"skinTone":"#6f4632"} another bowler tone, {"debug":1..6} skin attributes.
 *   az 0 = camera behind the bowler (+Z), 180 = in front (batsman side), -90 = thumb side (-X).
 */
import React from "react";
import { ThreeCanvas } from "@remotion/three";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import * as THREE from "three";
import { CameraRig } from "../CameraRig";
import { Post } from "../post/Post";
import { MacroHand, MacroHandLights, MACRO_T, macroBallCenter, macroSeamFocus } from "../rig/MacroHand";
import type { Vec3 } from "../rig/types";
import { Atmosphere } from "../world/Atmosphere";
import { rimDirFor } from "../world/Lights";
import { Stadium } from "../world/Stadium";

type THandProps = {
  view?: string;
  az?: number;
  el?: number;
  dist?: number;
  t?: number;
  clay?: boolean;
  post?: boolean;
  bg?: boolean;
  shadows?: boolean;
  debug?: number;
  /** grid view: [az, el] pairs (default four fixed angles) */
  angles?: [number, number][];
  /** grid / one view: look-at offset from the hand position (default [0, -0.01, 0.02]) */
  look?: Vec3;
  /** MacroHand wrist: "band" (default) or "none" */
  cuff?: "band" | "none";
  /** MacroHand skin tone */
  skinTone?: string;
};

/** S02 places the hand at the top of the bowler's run-up. */
const HAND_POS: Vec3 = [0, 1.4, 26];
/** global frame of the stadium state behind the hand (S02 starts at 66) */
const S02_F = 66;

const clayMat = new THREE.MeshStandardMaterial({ color: "#b8b2aa", roughness: 0.62 });

const ShapeLights: React.FC = () => (
  <>
    <directionalLight position={[-2, 3, 1.5]} intensity={2.4} />
    <directionalLight position={[3, 1.5, -2]} intensity={2.2} color="#cfe" />
    <hemisphereLight args={["#667", "#332", 1.0]} />
  </>
);

/* ---------- scene ---------- */

const orbitCam = (az: number, el: number, dist: number, target: Vec3): Vec3 => {
  const a = (az * Math.PI) / 180;
  const e = (el * Math.PI) / 180;
  return [target[0] + dist * Math.cos(e) * Math.sin(a), target[1] + dist * Math.sin(e), target[2] + dist * Math.cos(e) * Math.cos(a)];
};

const Scene: React.FC<{
  cam: Vec3;
  target: Vec3;
  fov: number;
  t: number;
  focus: Vec3 | null;
  clay?: boolean;
  bg?: boolean;
  post?: boolean;
  shadows?: boolean;
  debug?: number;
  cuff?: "band" | "none";
  skinTone?: string;
}> = ({ cam, target, fov, t, focus, clay, bg = true, post = true, shadows = true, debug = 0, cuff, skinTone }) => (
  <>
    <CameraRig position={cam} target={target} fov={fov} near={0.02} far={1500} />
    <color attach="background" args={[bg ? "#020304" : "#202428"]} />
    {bg ? (
      <>
        <Stadium F={S02_F + Math.round(t * 30)} detail="near" beams={0.9} />
        <Atmosphere F={S02_F + Math.round(t * 30)} motes={0.6} />
      </>
    ) : null}
    {clay ? <ShapeLights /> : <MacroHandLights center={HAND_POS} rimDir={rimDirFor(cam, HAND_POS, 0.55, 0.32)} />}
    <group position={HAND_POS}>
      <MacroHand t={t} overrideMaterial={clay ? clayMat : undefined} debug={debug} shadows={shadows} cuff={cuff} skinTone={skinTone} />
    </group>
    {post && focus ? <Post focus={focus} focusRange={0.006} aperture={0.05} maxBlur={0.05} bokeh={3} bloomThreshold={1.8} /> : null}
  </>
);

const Canvas: React.FC<{ w: number; h: number; children: React.ReactNode }> = ({ w, h, children }) => (
  <ThreeCanvas
    width={w}
    height={h}
    gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, outputColorSpace: THREE.SRGBColorSpace }}
    camera={{ fov: 30, near: 0.02, far: 1500, position: [0, 2, 6] }}
  >
    {children}
  </ThreeCanvas>
);

const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

export const THand: React.FC<THandProps> = ({
  view = "orbit",
  az = 0,
  el = 10,
  dist = 0.3,
  t: tFix,
  clay = false,
  post = true,
  bg = true,
  shadows = true,
  debug = 0,
  angles: anglesProp,
  look = [0, -0.01, 0.02],
  cuff,
  skinTone,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();

  if (view === "grid") {
    const t = tFix ?? frame / 30;
    const angles: [number, number][] = anglesProp ?? [
      [-90, 5],
      [-35, 20],
      [60, 10],
      [160, 5],
    ];
    return (
      <AbsoluteFill style={{ backgroundColor: "#000", display: "flex", flexWrap: "wrap" }}>
        {angles.map(([a, e], i) => {
          const target = add3(HAND_POS, look);
          return (
            <div key={i} style={{ width: width / 2, height: height / 2, position: "relative" }}>
              <Canvas w={width / 2} h={height / 2}>
                <Scene
                  cam={orbitCam(a, e, dist, target)}
                  target={target}
                  fov={30}
                  t={t}
                  focus={null}
                  clay={clay}
                  bg={false}
                  post={false}
                  shadows={shadows}
                  debug={debug}
                  cuff={cuff}
                  skinTone={skinTone}
                />
              </Canvas>
              <div style={{ position: "absolute", left: 8, top: 6, color: "#9ff", font: "18px monospace" }}>
                az {a} el {e}
              </div>
            </div>
          );
        })}
      </AbsoluteFill>
    );
  }

  let cam: Vec3;
  let target: Vec3;
  let t: number;
  let fov = 28;
  if (view === "one") {
    t = tFix ?? frame / 30;
    target = add3(HAND_POS, look);
    cam = orbitCam(az, el, dist, target);
  } else if (frame < 60) {
    // S02: a ~40deg arc in front of the hand, from slightly below (floodlight banks behind it),
    // 0.34 -> 0.29 m; the run starts at frame 52 and the hand comes at the lens
    t = frame / 30;
    const k = frame / 59;
    const s = k * k * (3 - 2 * k);
    const ball = add3(HAND_POS, macroBallCenter(Math.min(t, MACRO_T.runStart)));
    target = add3(ball, [0, -0.008, 0.008]);
    cam = orbitCam(150 + 40 * s, -27 + 7 * s, 0.34 - 0.05 * s, target);
    fov = 26;
  } else {
    // slow orbit; the grip plays again at ~0.3x (ball handling, settle, tighten), stopping before the run
    const k = (frame - 60) / 179;
    t = 1.72 * k;
    target = add3(HAND_POS, [0.002, -0.012, 0.014]);
    cam = orbitCam(-150 + 120 * k, -20 + 34 * k * k, 0.32 - 0.03 * k, target);
    fov = 28;
  }
  // focus: the seam on the near side of the ball
  const focus = macroSeamFocus(t, HAND_POS, cam);
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <Canvas w={width} h={height}>
        <Scene cam={cam} target={target} fov={fov} t={t} focus={focus} clay={clay} bg={bg} post={post} shadows={shadows} debug={debug} cuff={cuff} skinTone={skinTone} />
      </Canvas>
    </AbsoluteFill>
  );
};
