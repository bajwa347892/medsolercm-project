/**
 * T-Player: preview of the character rig and every action.
 *
 * Default (no props): 8 one-second segments, each showing two actions, each from the SIDE (left panel)
 * and a THREE-QUARTER front view (right panel), real-time speed over the action's key window,
 * with bat, ball and stumps in place.
 *
 * Focused: --props='{"action":"bowlDelivery","speed":0.5}' plays one action over 240 frames
 * (side + 3/4 panels). --props='{"view":"body"}' / '{"view":"face"}' turntables of the kits.
 */
import React, { useMemo } from "react";
import { ThreeCanvas } from "@remotion/three";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import * as THREE from "three";
import { CameraRig } from "../CameraRig";
import { PAL } from "../theme";
import { BALL, FIELD, FIELDERS, STADIUM } from "../world/dims";
import { actionTime } from "../config";
import { Field } from "../world/Field";
import { StadiumLights, rimDirFor } from "../world/Lights";
import { BAT_SWEET_SPOT, BAT_FACE_NORMAL, Ball, Wicket } from "../world/Props";
import { Player } from "../rig/Player";
import {
  ACTIONS,
  type ActionDef,
  BAT,
  BOWL,
  DIVE,
  KEEPER,
  THROW,
  batDrive,
  batStance,
  bowlDelivery,
  bowlRunUp,
  celebrateFistPump,
  celebrateJump,
  diveCatch,
  fielderReady,
  keeperCollect,
  keeperCrouch,
  pickupThrow,
  runBetweenWickets,
  runToTeammate,
} from "../rig/actions";
import { attachmentDir, attachmentWorld, batContact } from "../rig/solve";
import { build, plant } from "../rig/pose";
import type { Pose, Vec3 } from "../rig/types";

type TPlayerProps = {
  /** "overview" (default) | "body" | "face" | "hands" | "perf" | "shot" (director views, see DIRECTOR) */
  view?: string;
  /** view "shot": s03low | s03back | s04 | s05 | s07 | s08 | s09 | s10 */
  shot?: string;
  /** view "shot": render this global frame instead of from + frame */
  at?: number;
  /** view "shot": camera override (offsets from the shot's target unless abs) */
  camOff?: { cam: Vec3; target?: Vec3; fov?: number; abs?: boolean };
  /** focused action name (see ACTIONS) */
  action?: string;
  /** focused playback speed (default 0.5) */
  speed?: number;
  /** focused start time override (s) */
  from?: number;
  /** focused: explicit time per frame (frame i shows times[i]) */
  times?: number[];
  /** focused: camera distance multiplier (default 1) and target height */
  zoom?: number;
  ty?: number;
};

/* ------------------------------------------------------------------ */
/* Scene pieces                                                         */
/* ------------------------------------------------------------------ */

const Backdrop: React.FC = () => {
  const mats = useMemo(() => {
    const bowl = new THREE.MeshStandardMaterial({ color: PAL.graphiteDark, roughness: 1, side: THREE.DoubleSide });
    const led = new THREE.MeshStandardMaterial({
      color: "#000",
      emissive: new THREE.Color(PAL.tealDeep),
      emissiveIntensity: 0.6,
      side: THREE.DoubleSide,
    });
    const lamp = new THREE.MeshBasicMaterial({ color: new THREE.Color(PAL.floodWhite).multiplyScalar(5) });
    return { bowl, led, lamp };
  }, []);
  return (
    <group>
      <mesh position={[0, 21, 0]} material={mats.bowl}>
        <cylinderGeometry args={[125, 73, 42, 64, 1, true]} />
      </mesh>
      <mesh position={[0, 0.45, 0]} material={mats.led}>
        <cylinderGeometry args={[FIELD.ledRadius, FIELD.ledRadius, 0.9, 128, 1, true]} />
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
            <planeGeometry args={[14, 6]} />
          </mesh>
        );
      })}
    </group>
  );
};

const Panel: React.FC<{
  w: number;
  h: number;
  cam: Vec3;
  target: Vec3;
  fov?: number;
  shadowCenter: Vec3;
  shadowSize?: number;
  children: React.ReactNode;
}> = ({ w, h, cam, target, fov = 30, shadowCenter, shadowSize = 4, children }) => (
  <ThreeCanvas
    width={w}
    height={h}
    gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, outputColorSpace: THREE.SRGBColorSpace }}
    camera={{ fov: 35, near: 0.01, far: 2000, position: [0, 2, 6] }}
  >
    <CameraRig position={cam} target={target} fov={fov} />
    <color attach="background" args={["#04070a"]} />
    <fog attach="fog" args={["#0b1418", 60, 300]} />
    <StadiumLights
      rimDir={rimDirFor(cam, target, 0.5, 0.4)}
      shadows
      shadowCenter={shadowCenter}
      shadowSize={shadowSize}
      shadowMapSize={w > 1000 ? 2048 : 1024}
    />
    <Field detail="near" />
    <Backdrop />
    {children}
  </ThreeCanvas>
);

const label: React.CSSProperties = {
  position: "absolute",
  color: "#9ff",
  font: "18px monospace",
  textShadow: "0 0 4px #000",
  pointerEvents: "none",
};

/* ------------------------------------------------------------------ */
/* Per-action staging: camera side, props (bat, ball, stumps)          */
/* ------------------------------------------------------------------ */

type Stage = {
  /** camera side for the side view: +1 = from +X, -1 = from -X */
  side: 1 | -1;
  dist: number;
  /** overview window (s) */
  win: [number, number];
  kit?: "teal" | "graphite";
  /** camera target height (default 0.85) */
  ty?: number;
  props?: (t: number, pose: Pose, def: ActionDef) => React.ReactNode;
};

const STRIKER_STUMPS: Vec3 = [0, 0, -1.22];

/** Ball arriving at the bat's sweet spot at contact and leaving along the face normal. */
const driveBall = (t: number, tc: number, fn: (t: number) => Pose) => {
  const pc = fn(tc);
  const n = attachmentDir(pc, "bat", 0, BAT_FACE_NORMAL);
  const c = attachmentWorld(pc, "bat", [0, 0, 0], 0, [
    BAT_SWEET_SPOT[0] + BAT_FACE_NORMAL[0] * BALL.radius,
    BAT_SWEET_SPOT[1],
    BAT_SWEET_SPOT[2] + BAT_FACE_NORMAL[2] * BALL.radius,
  ]);
  const dt = t - tc;
  if (dt < 0) {
    // incoming from the bowler (+Z), slightly rising after the bounce
    return [c[0] + 0.02 * dt, c[1] - 1.6 * dt * 0.25, c[2] - 30 * dt] as Vec3;
  }
  const v = 28;
  return [c[0] + n[0] * v * dt, c[1] + n[1] * v * dt + 3.5 * dt - 4.9 * dt * dt, c[2] + n[2] * v * dt] as Vec3;
};

const STAGES: Record<string, Stage> = {
  batStance: {
    side: -1,
    dist: 4.2,
    win: [1.0, 2.0],
    kit: "graphite",
    props: () => <Wicket position={STRIKER_STUMPS} />,
  },
  batDrive: {
    side: -1,
    dist: 4.4,
    win: [BAT.CONTACT_T - 0.6, BAT.CONTACT_T + 0.4],
    kit: "graphite",
    props: (t, _p, def) => (
      <>
        <Wicket position={STRIKER_STUMPS} />
        <Ball position={driveBall(t, BAT.CONTACT_T, def.fn)} spin={[t * 40, 0, 0]} />
      </>
    ),
  },
  batCoverDrive: {
    side: -1,
    dist: 4.4,
    win: [BAT.COVER_CONTACT_T - 0.6, BAT.COVER_CONTACT_T + 0.4],
    kit: "graphite",
    props: (t, _p, def) => (
      <>
        <Wicket position={STRIKER_STUMPS} />
        <Ball position={driveBall(t, BAT.COVER_CONTACT_T, def.fn)} spin={[t * 40, 0, 0]} />
      </>
    ),
  },
  raiseBat: { side: 1, dist: 5.4, win: [0.0, 1.0], kit: "graphite", ty: 1.3 },
  runBetweenWickets: {
    side: -1,
    dist: 5.5,
    win: [0.6, 1.6],
    kit: "graphite",
    props: () => <Wicket position={[0, 0, 1.22]} />,
  },
  bowlRunUp: { side: -1, dist: 6.5, win: [0.9, 1.9] },
  bowlDelivery: {
    side: -1,
    dist: 5.5,
    win: [0.0, 1.0],
    props: (t, _p, def) => {
      const pr = def.fn(BOWL.RELEASE_T);
      const rel = attachmentWorld(pr, "ball", [0, 0, 0], 0);
      const dt = t - BOWL.RELEASE_T;
      return (
        <>
          <Wicket position={[-0.3, 0, -1.22]} />
          {dt > 0 ? <Ball position={[rel[0] - 0.01 * dt, rel[1] - 1.2 * dt - 4.9 * dt * dt, rel[2] + 36 * dt]} spin={[-t * 60, 0, 0]} /> : null}
        </>
      );
    },
  },
  keeperCrouch: { side: 1, dist: 4.0, win: [0.4, 1.4], props: () => <Wicket position={[0, 0, 0.75]} /> },
  keeperCollect: {
    side: 1,
    dist: 4.0,
    win: [0.1, 1.1],
    props: (t, _p, def) => {
      const C = KEEPER.COLLECT_T;
      const dt = t - C;
      if (dt >= 0) return <Wicket position={[0, 0, 0.75]} />;
      // the throw arrives from the bowler's end straight into the gloves
      const c = attachmentWorld(def.fn(C), "ball", [0, 0, 0], 0);
      return (
        <>
          <Wicket position={[0, 0, 0.75]} />
          <Ball position={[c[0] + 0.4 * dt, c[1] - 0.6 * dt, c[2] - 25 * dt]} spin={[t * 30, 0, 0]} />
        </>
      );
    },
  },
  fielderReady: { side: 1, dist: 4.4, win: [0.6, 1.6] },
  sprint: { side: 1, dist: 6.5, win: [0.0, 1.0] },
  diveCatch: {
    side: 1,
    dist: 6.0,
    win: [DIVE.LAUNCH_T - 0.35, DIVE.LAUNCH_T + 0.75],
    props: (t, _p, def) => {
      const C = DIVE.CATCH_T;
      if (t >= C) return null;
      const pc = def.fn(C);
      const c = attachmentWorld(pc, "ball", [0, 0, 0], 0);
      const dt = t - C;
      return <Ball position={[c[0] + 1.5 * dt, c[1] - 9 * dt - 4.9 * dt * dt, c[2] - 6 * dt]} spin={[t * 20, 0, 0]} />;
    },
  },
  pickupThrow: {
    side: 1,
    dist: 6.0,
    win: [THROW.COLLECT_T - 0.4, THROW.COLLECT_T + 0.75],
    props: (t, _p, def) => {
      const C = THROW.COLLECT_T;
      const R = THROW.THROW_RELEASE_T;
      if (t < C) return <Ball position={[0.02, BALL.radius, (C - t) * 3]} spin={[-(C - t) * 80, 0, 0]} />;
      if (t < R) return null;
      const rel = attachmentWorld(def.fn(R), "ball", [0, 0, 0], 0);
      const dt = t - R;
      return <Ball position={[rel[0], rel[1] + 2.5 * dt - 4.9 * dt * dt, rel[2] + 30 * dt]} spin={[-t * 50, 0, 0]} />;
    },
  },
  appeal: { side: 1, dist: 4.2, win: [0.0, 1.0] },
  celebrateFistPump: { side: 1, dist: 4.2, win: [0.0, 1.0] },
  celebrateJump: { side: 1, dist: 4.2, win: [0.1, 1.1] },
  runToTeammate: { side: 1, dist: 6.0, win: [0.4, 1.4] },
};

/** Smoothed tracking target (pelvis xz, fixed height) so the camera does not bob. */
const trackTarget = (fn: (t: number) => Pose, t: number): Vec3 => {
  let x = 0;
  let z = 0;
  const N = 7;
  for (let i = 0; i < N; i++) {
    const p = fn(t + (i - (N - 1) / 2) * 0.06);
    x += p.root[0] / N;
    z += p.root[2] / N;
  }
  return [x, 0.85, z];
};

/** One action from two cameras (side, 3/4) inside a rect. */
const ActionPanels: React.FC<{
  def: ActionDef;
  t: number;
  x: number;
  y: number;
  w: number;
  h: number;
  tag?: string;
  zoom?: number;
  ty?: number;
}> = ({ def, t, x, y, w, h, tag, zoom = 1, ty }) => {
  const st = STAGES[def.name];
  const pose = def.fn(t);
  const tgt = trackTarget(def.fn, t);
  if (ty !== undefined) tgt[1] = ty;
  else if (st.ty !== undefined) tgt[1] = st.ty;
  const d = st.dist * zoom;
  const camY = ty ?? (st.ty !== undefined ? st.ty + 0.2 : 1.05);
  const sideCam: Vec3 = [tgt[0] + st.side * d, camY, tgt[2]];
  const a = st.side * 0.75;
  const qCam: Vec3 = [tgt[0] + Math.sin(a) * d * 1.05, camY + 0.3, tgt[2] + Math.cos(a) * d * 1.05];
  const content = (
    <>
      <Player
        pose={pose}
        role={def.role}
        kit={st.kit ?? (def.role === "batsman" ? "graphite" : "teal")}
        seed={def.name.length}
        bat={def.role === "batsman"}
        ball
        detail="mid"
      />
      {st.props ? st.props(t, pose, def) : null}
    </>
  );
  const keyTxt = Object.entries(def.keys)
    .map(([k, v]) => `${k}${Math.abs(t - v) < 0.02 ? "*" : ""}@${v.toFixed(2)}`)
    .join(" ");
  return (
    <>
      <div style={{ position: "absolute", left: x, top: y, width: w / 2, height: h }}>
        <Panel w={w / 2} h={h} cam={sideCam} target={tgt} shadowCenter={[tgt[0], 0, tgt[2]]}>
          {content}
        </Panel>
      </div>
      <div style={{ position: "absolute", left: x + w / 2, top: y, width: w / 2, height: h }}>
        <Panel w={w / 2} h={h} cam={qCam} target={tgt} shadowCenter={[tgt[0], 0, tgt[2]]}>
          {content}
        </Panel>
      </div>
      <div style={{ ...label, left: x + 8, top: y + 6 }}>
        {tag ?? ""}
        {def.name} t={t.toFixed(3)} {keyTxt}
      </div>
      <div style={{ ...label, left: x + w / 2 + 8, top: y + 6, color: "#ff9" }}>3/4</div>
    </>
  );
};

/* ------------------------------------------------------------------ */
/* Turntables (kits, faces)                                            */
/* ------------------------------------------------------------------ */

const standPose = (look: Vec3) =>
  build({
    root: [0, 0.975, 0],
    rootRot: [0, 0, 0],
    spine: [0.04, 0, 0],
    chest: [0.03, 0, 0],
    look,
    lFoot: plant(0.13, 0.04, 0.14),
    rFoot: plant(-0.13, -0.04, -0.14),
    lArm: { aim: [0.22, -1, 0.06], pole: [0.25, 0, -1], flex: 0.35, pron: 0.2 },
    rArm: { aim: [-0.22, -1, 0.06], pole: [-0.25, 0, -1], flex: 0.35, pron: 0.2 },
  });

/** Hands: a fielder's right hand closing 0 -> 1 (left panel) and the batsman's grip (right panel). */
const HandsView: React.FC<{ frame: number; w: number; h: number }> = ({ frame, w, h }) => {
  const g = Math.min(1, frame / 60);
  const pose = { ...standPose([0, 1.6, 8]), rGrip: g, lGrip: g };
  const a = 0.6 + (frame / 240) * 1.2;
  const handPos: Vec3 = [-0.33, 0.83, 0.1];
  const cam: Vec3 = [handPos[0] - Math.sin(a) * 0.45, handPos[1] + 0.12, handPos[2] + Math.cos(a) * 0.45];
  const st = ACTIONS.find((d) => d.name === "batStance");
  const sp = st ? st.fn(0.2) : pose;
  return (
    <>
      <div style={{ position: "absolute", left: 0, top: 0 }}>
        <Panel w={w / 2} h={h} cam={cam} target={handPos} fov={30} shadowCenter={[0, 0, 0]} shadowSize={2}>
          <Player pose={pose} role="fielder" seed={3} detail="hero" />
        </Panel>
      </div>
      <div style={{ position: "absolute", left: w / 2, top: 0 }}>
        <Panel w={w / 2} h={h} cam={[-0.55 - Math.sin(a) * 0.2, 0.95, 0.35]} target={[0.02, 0.78, 0.02]} fov={30} shadowCenter={[0, 0, 0]} shadowSize={2}>
          <Player pose={sp} role="batsman" seed={2} detail="hero" bat />
        </Panel>
      </div>
      <div style={{ ...label, left: 12, top: 8 }}>hands grip {g.toFixed(2)}</div>
    </>
  );
};

const Turntable: React.FC<{ face: boolean; frame: number; w: number; h: number }> = ({ face, frame, w, h }) => {
  if (face) {
    const a = -0.9 + (frame / 240) * Math.PI * 2;
    const cam: Vec3 = [Math.sin(a) * 0.9, 1.62, Math.cos(a) * 0.9];
    return (
      <Panel w={w} h={h} cam={cam} target={[0, 1.55, 0]} shadowCenter={[0, 0, 0]} shadowSize={2}>
        <Player pose={standPose([0, 1.65, 6])} role="bowler" seed={3} detail="hero" />
        <Player pose={standPose([0, 1.65, 6])} role="batsman" seed={2} detail="hero" position={[-0.55, 0, -0.5]} />
        <Player pose={standPose([0, 1.65, 6])} role="fielder" seed={4} detail="hero" headwear="none" position={[0.6, 0, -0.5]} />
      </Panel>
    );
  }
  const a = (frame / 240) * Math.PI * 2;
  const cam: Vec3 = [Math.sin(a) * 4.2, 1.25, Math.cos(a) * 4.2];
  return (
    <Panel w={w} h={h} cam={cam} target={[0, 0.95, 0]} fov={32} shadowCenter={[0, 0, 0]}>
      <Player pose={standPose([0, 1.6, 8])} role="bowler" seed={3} detail="hero" />
      <Player pose={standPose([0, 1.6, 8])} role="batsman" seed={2} position={[-0.75, 0, -0.35]} />
      <Player pose={standPose([0, 1.6, 8])} role="keeper" seed={5} position={[0.75, 0, -0.35]} />
    </Panel>
  );
};

/* ------------------------------------------------------------------ */
/* Director views: the film's own camera angles (SHOTS.md), cue-locked  */
/* ------------------------------------------------------------------ */

type DirFrame = {
  cam: Vec3;
  target: Vec3;
  fov: number;
  shadowCenter: Vec3;
  shadowSize?: number;
  actors: React.ReactNode;
  note?: string;
};

/** Bowling-frame origin for a right-arm-over bowler bowling toward world -Z (front foot just behind the popping crease). */
const BOWL_O: Vec3 = [-0.3, 0, 8.9];
const BAT_O: Vec3 = [0, 0, -8.84];
const lerpV = (a: Vec3, b: Vec3, k: number): Vec3 => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const sm = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const toWorld = (o: Vec3, rotY: number, p: Vec3): Vec3 => [
  o[0] + p[0] * Math.cos(rotY) + p[2] * Math.sin(rotY),
  o[1] + p[1],
  o[2] - p[0] * Math.sin(rotY) + p[2] * Math.cos(rotY),
];

/** Background field players (static ready poses) so the frame reads like a match. */
const Fielders: React.FC<{ t: number; skip?: string[] }> = ({ t, skip = [] }) => (
  <>
    {(Object.entries(FIELDERS) as [string, readonly number[]][])
      .filter(([n]) => n !== "keeper" && !skip.includes(n))
      .map(([n, p], i) => {
        const rot = Math.atan2(-p[0], -8.84 - p[2]);
        return <Player key={n} pose={fielderReady(t + 2 + i * 0.13)} role="fielder" position={[p[0], 0, p[2]]} rotationY={rot} seed={11 + i} detail="far" castShadow={false} />;
      })}
  </>
);

const DIRECTOR: Record<string, { from: number; to: number; at: (F: number) => DirFrame }> = {
  /** S03a: low tracking camera alongside the bowler's run-up. */
  s03low: {
    from: 126,
    to: 160,
    at: (F) => {
      const t = (F - 126) / 30;
      const pose = bowlRunUp(t);
      const p = toWorld(BOWL_O, Math.PI, pose.root);
      const cam: Vec3 = [p[0] + 3.0, 0.5, p[2] - 0.6];
      return {
        cam,
        target: [p[0], 0.95, p[2] - 0.3],
        fov: 38,
        shadowCenter: [p[0], 0, p[2]],
        actors: <Player pose={pose} role="bowler" position={BOWL_O} rotationY={Math.PI} seed={3} detail="hero" ball />,
      };
    },
  },
  /** S03b: over the bowler's right shoulder, the batsman, keeper and slip ahead. */
  s03back: {
    from: 160,
    to: 196,
    at: (F) => {
      const t = (F - 126) / 30;
      const pose = bowlRunUp(t);
      const p = toWorld(BOWL_O, Math.PI, pose.root);
      const k = sm(160, 186, F);
      const cam: Vec3 = lerpV([p[0] + 2.2, 1.2, p[2] + 2.2], [p[0] + 0.75, 1.95, p[2] + 2.6], k);
      return {
        cam,
        target: lerpV([p[0], 1.2, p[2] - 3], [0, 1.0, -8.0], k),
        fov: lerpV([34, 0, 0], [26, 0, 0], k)[0],
        shadowCenter: [0, 0, 0],
        shadowSize: 14,
        actors: (
          <>
            <Player pose={bowlRunUp(t)} role="bowler" position={BOWL_O} rotationY={Math.PI} seed={3} detail="mid" ball />
            <Player pose={batStance((F - 126) / 30, { liftT: (196 - 126) / 30 })} role="batsman" position={BAT_O} seed={2} detail="mid" />
            <Player pose={keeperCrouch((F - 126) / 30, { riseT: (194 - 126) / 30 })} role="keeper" position={[0, 0, -12.4]} seed={5} detail="mid" />
            <Player pose={fielderReady((F - 126) / 30 - 0.4)} role="fielder" position={[-1.4, 0, -13.4]} seed={7} detail="far" />
            <Wicket position={[0, 0, -10.06]} />
            <Wicket position={[0, 0, 10.06]} />
            <Fielders t={(F - 126) / 30} skip={["slip1"]} />
          </>
        ),
      };
    },
  },
  /** S04: delivery stride, slow motion at release, close on the bowling hand. */
  s04: {
    from: 184,
    to: 216,
    at: (F) => {
      const keys: [number, number][] = [[184, 1], [190, 1], [192.5, 0.25], [203, 0.25], [207, 1]];
      const a = (f: number) => actionTime(f, keys);
      const pose = bowlDelivery(a(F), { tFFC: a(192), tRelease: a(196) });
      const hand = attachmentWorld(pose, "rightHand", BOWL_O, Math.PI);
      const p = toWorld(BOWL_O, Math.PI, pose.root);
      const k = sm(186, 200, F);
      // wide side-on of the stride -> push in on the hand and ball at release
      const camA: Vec3 = [p[0] - 4.6, 1.3, p[2] - 0.6];
      const camB: Vec3 = [hand[0] - 1.25, hand[1] + 0.1, hand[2] - 0.55];
      const tgt = lerpV([p[0], 1.25, p[2]], hand, k);
      const rel = attachmentWorld(bowlDelivery(a(196), { tFFC: a(192), tRelease: a(196) }), "ball", BOWL_O, Math.PI);
      const dt = a(F) - a(196);
      return {
        cam: lerpV(camA, camB, k),
        target: tgt,
        fov: lerpV([36, 0, 0], [24, 0, 0], k)[0],
        shadowCenter: [p[0], 0, p[2]],
        shadowSize: 4,
        actors: (
          <>
            <Player pose={pose} role="bowler" position={BOWL_O} rotationY={Math.PI} seed={3} detail="hero" ball ballSpin={[a(F) * 20, 0, 0]} />
            {dt > 0 ? <Ball position={[rel[0] + 0.05 * dt, rel[1] - 1.5 * dt - 4.9 * dt * dt, rel[2] - 36 * dt]} spin={[-dt * 60, 0, 0]} detail="hero" /> : null}
            <Wicket position={[0, 0, 10.06]} />
          </>
        ),
        note: `a=${a(F).toFixed(3)} ffc@${a(192).toFixed(3)} rel@${a(196).toFixed(3)}`,
      };
    },
  },
  /** S05: batsman in profile from the off side, contact on the cue in micro slow motion. */
  s05: {
    from: 216,
    to: 276,
    at: (F) => {
      const keys: [number, number][] = [[210, 1], [234, 1], [237, 0.15], [246, 0.15], [250, 1]];
      const a = (f: number) => actionTime(f, keys);
      const tc = a(240);
      const pose = batDrive(a(F), { contactT: tc });
      const pc = batDrive(tc, { contactT: tc });
      const c = batContact(pc, BAT_O, 0);
      const dt = a(F) - tc;
      const ball: Vec3 =
        dt < 0
          ? [c.ballCentre[0] + 0.02 * dt, c.ballCentre[1] - 0.9 * dt, c.ballCentre[2] - 30 * dt]
          : [c.ballCentre[0] - 0.05 * 26 * dt, c.ballCentre[1] + 9 * dt - 4.9 * dt * dt, c.ballCentre[2] + 24 * dt];
      return {
        cam: [-4.2, 1.0, -8.5],
        target: [0.1, 0.85, -8.35],
        fov: 32,
        shadowCenter: [0, 0, -8.8],
        shadowSize: 3.5,
        actors: (
          <>
            <Player pose={pose} role="batsman" position={BAT_O} seed={2} detail="hero" />
            <Ball position={ball} spin={[a(F) * 40, 0, 0]} detail="hero" />
            <Wicket position={[0, 0, -10.06]} />
            <Player pose={keeperCollect(a(F) - tc + 0.3, { at: [0.1, 0.7, 0.4] })} role="keeper" position={[0, 0, -12.4]} seed={5} detail="mid" />
          </>
        ),
        note: `a=${a(F).toFixed(3)} contact@${tc.toFixed(3)}`,
      };
    },
  },
  /** S07: ground-level tracking of the diving catch; slow motion at the catch. */
  s07: {
    from: 318,
    to: 378,
    at: (F) => {
      const keys: [number, number][] = [[318, 1], [342, 1], [345, 0.3], [356, 0.3], [359, 1]];
      const a = (f: number) => actionTime(f, keys);
      const o = { launchT: a(340), catchT: a(350), landT: a(352), slideEndT: a(372), steps: [320, 326, 332, 337].map((f) => a(f)) };
      const O: Vec3 = [24, 0, 34];
      const rot = -0.6;
      const pose = diveCatch(a(F), o);
      const p = toWorld(O, rot, pose.root);
      const fwd: Vec3 = [Math.sin(rot), 0, Math.cos(rot)];
      const right: Vec3 = [-Math.cos(rot), 0, Math.sin(rot)];
      const cam: Vec3 = [p[0] + right[0] * 3.2 + fwd[0] * 2.4, 0.32, p[2] + right[2] * 3.2 + fwd[2] * 2.4];
      const pc = diveCatch(o.catchT, o);
      const cb = attachmentWorld(pc, "ball", O, rot);
      const dt = a(F) - o.catchT;
      const ball: Vec3 | null = dt < 0 ? [cb[0] - fwd[0] * 9 * dt, cb[1] - 7 * dt - 4.9 * dt * dt, cb[2] - fwd[2] * 9 * dt] : null;
      return {
        cam,
        target: [p[0] - right[0] * 0.3, 0.55, p[2] - right[2] * 0.3],
        fov: 34,
        shadowCenter: [p[0], 0, p[2]],
        shadowSize: 4,
        actors: (
          <>
            <Player pose={pose} role="fielder" position={O} rotationY={rot} seed={9} detail="hero" ball />
            {ball ? <Ball position={ball} spin={[a(F) * 30, 0, 0]} /> : null}
          </>
        ),
        note: `a=${a(F).toFixed(3)} launch@${o.launchT.toFixed(3)} catch@${o.catchT.toFixed(3)}`,
      };
    },
  },
  /** S08: boundary pick-up and throw on the cues (collect 384, release 392). */
  s08: {
    from: 376,
    to: 420,
    at: (F) => {
      const C = THROW.COLLECT_T;
      const t = C + (F - 384) / 30;
      const pose = pickupThrow(t, { collectT: C, releaseT: C + 8 / 30 });
      const O: Vec3 = [-40, 0, 44];
      const rot = Math.atan2(0 - O[0], -10 - O[2]);
      const p = toWorld(O, rot, pose.root);
      const right: Vec3 = [-Math.cos(rot), 0, Math.sin(rot)];
      return {
        cam: [p[0] + right[0] * 5, 1.0, p[2] + right[2] * 5],
        target: [p[0], 0.9, p[2]],
        fov: 34,
        shadowCenter: [p[0], 0, p[2]],
        shadowSize: 4,
        actors: (
          <>
            <Player pose={pose} role="fielder" position={O} rotationY={rot} seed={4} detail="hero" ball />
            {t < C ? <Ball position={toWorld(O, rot, [0.02, BALL.radius, (C - t) * 6])} spin={[(C - t) * 80, 0, 0]} /> : null}
          </>
        ),
      };
    },
  },
  /** S09: keeper gathers and breaks the wicket; the batsman's bat slides in short of the crease. */
  s09: {
    from: 420,
    to: 465,
    at: (F) => {
      const keys: [number, number][] = [[420, 1], [432, 1], [435, 0.12], [452, 0.12], [460, 0.5]];
      const a = (f: number) => actionTime(f, keys);
      const hit = a(438);
      const K: Vec3 = [0, 0, -10.06 - 0.75];
      const kp = keeperCollect(a(F), { collectT: hit - 0.22, finish: "break", at: [0.25, 0.6, 0.35] });
      const bp = runBetweenWickets(a(F), { groundT: hit + 0.05 });
      return {
        cam: [1.4, 0.35, -11.2],
        target: [0, 0.5, -9.6],
        fov: 40,
        shadowCenter: [0, 0, -10],
        shadowSize: 4,
        actors: (
          <>
            <Player pose={kp} role="keeper" position={K} seed={5} detail="hero" ball />
            <Player pose={bp} role="batsman" position={[0.25, 0, -8.84 + 0.35]} rotationY={Math.PI} seed={2} detail="mid" />
            <Wicket position={[0, 0, -10.06]} />
          </>
        ),
        note: `a=${a(F).toFixed(3)} hit@${hit.toFixed(3)}`,
      };
    },
  },
  /** S10: celebration group; fast orbit. */
  s10: {
    from: 465,
    to: 510,
    at: (F) => {
      const t = (F - 465) / 30;
      const G: Vec3 = [-2, 0, 6];
      const ang = -0.9 + t * 1.6;
      return {
        cam: [G[0] + Math.sin(ang) * 4.6, 1.35, G[2] + Math.cos(ang) * 4.6],
        target: [G[0] + 0.3, 1.15, G[2] + 0.3],
        fov: 36,
        shadowCenter: G,
        shadowSize: 5,
        actors: (
          <>
            <Player pose={celebrateFistPump(t, { pumpT: (474 - 465) / 30 })} role="bowler" position={G} rotationY={-0.4} seed={3} detail="hero" />
            <Player pose={runToTeammate(t + 0.35, { stopT: 1.25 })} role="fielder" position={toWorld(G, -0.4, [1.1, 0, 0.6])} rotationY={-0.4 - 2.2} seed={9} detail="mid" />
            <Player pose={celebrateJump(t, { jumpT: 0.9 })} role="fielder" position={toWorld(G, -0.4, [-1.0, 0, 1.1])} rotationY={-0.4 + 2.6} seed={4} detail="mid" />
          </>
        ),
      };
    },
  },
};

const DirectorView: React.FC<{
  shot: string;
  frame: number;
  w: number;
  h: number;
  at?: number;
  /** camera override, relative to the shot's own target: [dx, dy, dz] offset of the camera, target offset, fov */
  camOff?: { cam: Vec3; target?: Vec3; fov?: number; abs?: boolean };
}> = ({ shot, frame, w, h, at, camOff }) => {
  const d = DIRECTOR[shot] ?? DIRECTOR.s05;
  const F = at ?? Math.min(d.to, d.from + frame);
  const s0 = d.at(F);
  const s = camOff
    ? {
        ...s0,
        cam: camOff.abs ? camOff.cam : ([s0.target[0] + camOff.cam[0], s0.target[1] + camOff.cam[1], s0.target[2] + camOff.cam[2]] as Vec3),
        target: camOff.target ? (camOff.abs ? camOff.target : ([s0.target[0] + camOff.target[0], s0.target[1] + camOff.target[1], s0.target[2] + camOff.target[2]] as Vec3)) : s0.target,
        fov: camOff.fov ?? s0.fov,
      }
    : s0;
  return (
    <>
      <Panel w={w} h={h} cam={s.cam} target={s.target} fov={s.fov} shadowCenter={s.shadowCenter} shadowSize={s.shadowSize ?? 4}>
        {s.actors}
      </Panel>
      <div style={{ ...label, left: 12, top: 8 }}>
        {shot} F{F.toFixed(1)} {s.note ?? ""}
      </div>
    </>
  );
};

/* ------------------------------------------------------------------ */
/* Composition                                                          */
/* ------------------------------------------------------------------ */

/** Overview pairs: 8 segments x 30 frames, two actions each. */
const OVERVIEW: [string, string][] = [
  ["bowlRunUp", "bowlDelivery"],
  ["batStance", "batDrive"],
  ["batCoverDrive", "raiseBat"],
  ["runBetweenWickets", "keeperCrouch"],
  ["keeperCollect", "fielderReady"],
  ["sprint", "diveCatch"],
  ["pickupThrow", "appeal"],
  ["celebrateFistPump", "celebrateJump"],
];

export const TPlayer: React.FC<TPlayerProps> = ({ view, shot, at, camOff, action, speed = 0.5, from, times, zoom, ty }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  if (view === "shot") {
    return (
      <AbsoluteFill style={{ backgroundColor: "#000" }}>
        <DirectorView shot={shot ?? "s05"} frame={frame} w={width} h={height} at={at} camOff={camOff} />
      </AbsoluteFill>
    );
  }
  if (view === "perf") {
    // film-like single canvas: batsman in profile (hero), keeper and slip behind, bowler in the distance
    const t = 0.4 + frame / 30;
    const fnOf = (n: string) => (ACTIONS.find((d) => d.name === n) ?? ACTIONS[0]).fn;
    const bd = fnOf("batDrive");
    const kc = fnOf("keeperCrouch");
    const fr = fnOf("fielderReady");
    const bw = fnOf("bowlDelivery");
    const cam: Vec3 = [-3.2, 1.05, -8.6];
    const tgt: Vec3 = [0.1, 0.9, -8.4];
    return (
      <AbsoluteFill style={{ backgroundColor: "#000" }}>
        <Panel w={width} h={height} cam={cam} target={tgt} fov={32} shadowCenter={[0, 0, -9]} shadowSize={5}>
          <Player pose={bd(t)} role="batsman" position={[0, 0, -8.84]} seed={2} detail="hero" />
          <Player pose={kc(t)} role="keeper" position={[0, 0, -12.4]} seed={5} />
          <Player pose={fr(t + 0.8)} role="fielder" position={[-1.4, 0, -13.4]} rotationY={0} seed={7} />
          <Player pose={bw(Math.min(t, 1.6))} role="bowler" position={[-0.3, 0, 8.9]} rotationY={Math.PI} seed={3} detail="far" ball />
          <Wicket position={[0, 0, -10.06]} />
        </Panel>
        <div style={{ ...label, left: 12, top: 8 }}>T-Player perf f{frame}</div>
      </AbsoluteFill>
    );
  }
  if (view === "hands") {
    return (
      <AbsoluteFill style={{ backgroundColor: "#000" }}>
        <HandsView frame={frame} w={width} h={height} />
      </AbsoluteFill>
    );
  }
  if (view === "body" || view === "face") {
    return (
      <AbsoluteFill style={{ backgroundColor: "#000" }}>
        <Turntable face={view === "face"} frame={frame} w={width} h={height} />
        <div style={{ ...label, left: 12, top: 8 }}>T-Player {view} f{frame}</div>
      </AbsoluteFill>
    );
  }
  if (action) {
    const def = ACTIONS.find((d) => d.name === action) ?? ACTIONS[0];
    const t = times ? times[Math.min(times.length - 1, frame)] : Math.min(def.t1, (from ?? def.t0) + (frame / 30) * speed);
    return (
      <AbsoluteFill style={{ backgroundColor: "#000" }}>
        <ActionPanels def={def} t={t} x={0} y={0} w={width} h={height} zoom={zoom} ty={ty} />
      </AbsoluteFill>
    );
  }
  // overview
  const seg = Math.min(OVERVIEW.length - 1, Math.floor(frame / 30));
  const f = frame - seg * 30;
  const pair = OVERVIEW[seg];
  // the 17th action (runToTeammate) shares the last segment's second half
  const names = seg === OVERVIEW.length - 1 && f >= 15 ? [pair[0], "runToTeammate"] : pair;
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {names.map((n, i) => {
        const def = ACTIONS.find((d) => d.name === n) ?? ACTIONS[0];
        const st = STAGES[n];
        const span = st.win[1] - st.win[0];
        const t = st.win[0] + (f / 29) * span;
        return <ActionPanels key={n} def={def} t={t} x={0} y={(i * height) / 2} w={width} h={height / 2} tag={`[${seg + 1}/8] `} />;
      })}
    </AbsoluteFill>
  );
};
