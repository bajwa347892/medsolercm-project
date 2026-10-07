import React, { useMemo } from "react";
import { useCurrentFrame } from "remotion";
import * as THREE from "three";
import { CameraRig } from "../CameraRig";
import { EASE_IN_OUT, actionTime, lerp, prog } from "../config";
import { BALL, BOWLER_STUMPS_Z, STRIKER_STUMPS_Z, STUMPS } from "../world/dims";
import { Field, GrassBlades } from "../world/Field";
import { BALL_REST_Y, BAT_SWEET_SPOT, Ball, Bat, Wicket } from "../world/Props";
import { wicketHitState } from "../world/wicketPhysics";
import type { Vec3 } from "../rig/types";
import { StandInLights, StandInStadium } from "./TField";
import { rimDirFor } from "../world/Lights";
import { TestCanvas } from "./TestCanvas";

const R = BALL.radius;

/** Segment A: macro of bat face and ball meeting at the sweet spot (slow motion). */
const MacroContact: React.FC<{ frame: number }> = ({ frame }) => {
  // bat in a hitting position: blade slightly forward of vertical, face toward +Z, open a touch
  const batPos: Vec3 = [0, 0.95, 0];
  const batRot: Vec3 = [0.32, -0.25, 0.05];
  const { contact, normal } = useMemo(() => {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(...batPos),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...batRot)),
      new THREE.Vector3(1, 1, 1),
    );
    const c = new THREE.Vector3(...BAT_SWEET_SPOT).applyMatrix4(m);
    const n = new THREE.Vector3(0, 0, 1).transformDirection(m);
    return { contact: c, normal: n };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // action time: approach at 0.5 m/s, contact at frame 40, rebound slower
  const tc = (frame - 40) / 30;
  const dist = tc < 0 ? -tc * 0.5 : tc * 0.32;
  const ballC = contact.clone().add(normal.clone().multiplyScalar(R + dist));
  // incoming from slightly below (a drive): offset along the path direction
  ballC.y += tc < 0 ? tc * 0.12 : tc * 0.18;
  const spinA = frame * 0.045;
  const t = prog(frame, 0, 79, EASE_IN_OUT);
  const orbit = lerp(0.55, 1.15, t);
  const camD = 0.42;
  const cam: Vec3 = [contact.x + Math.sin(orbit) * camD, contact.y + 0.06, contact.z + Math.cos(orbit) * camD];
  return (
    <>
      <CameraRig position={cam} target={[contact.x, contact.y + 0.01, contact.z + 0.02]} fov={30} />
      <StandInLights focus={[0, 0.8, 0]} rimDir={[-0.6, 0.5, -0.8]} shadows={false} />
      <Bat position={batPos} rotation={batRot} />
      <Ball position={[ballC.x, ballC.y, ballC.z]} spin={[spinA, 0.4, 1.2]} detail="hero" />
    </>
  );
};

/** Segment B: a fast delivery hits middle stump, bails explode in slow motion, one bail flies into the lens. */
const SLOW_KEYS: [number, number][] = [
  [80, 1],
  [94, 1],
  [97, 0.12],
  [159, 0.12],
];
const HIT = 98;
const LENS_AT = 156; // the hero bail fills the frame here
const camAt = (frame: number): Vec3 => {
  const t = prog(frame, 80, 159, EASE_IN_OUT);
  return [lerp(0.62, 0.74, t), lerp(0.36, 0.4, t), STRIKER_STUMPS_Z - lerp(1.15, 1.05, t)];
};
const WicketHit: React.FC<{ frame: number }> = ({ frame }) => {
  const at = actionTime(frame, SLOW_KEYS);
  const tHit = actionTime(HIT, SLOW_KEYS);
  const tt = at - tHit;
  const wz = STRIKER_STUMPS_Z;
  const tgt: Vec3 = [0, 0.5, wz];
  const cam = camAt(frame);
  // hero bail: 0.2 m in front of the lens (wicket-local) exactly at LENS_AT
  const lens = useMemo(() => {
    const c = new THREE.Vector3(...camAt(LENS_AT));
    const toW = new THREE.Vector3(0, 0.62, wz).sub(c).normalize();
    return c.addScaledVector(toW, 0.2).sub(new THREE.Vector3(0, 0, wz));
  }, [wz]);
  const state = wicketHitState(tt, {
    dir: [0.05, 0, -1],
    stump: 1,
    strength: 1,
    heroBail: 1,
    heroTarget: [lens.x, lens.y, lens.z],
    heroTime: actionTime(LENS_AT, SLOW_KEYS) - tHit,
    heroSpin: 13,
    seed: 3,
  });
  // ball: 30 m/s along -Z, low, deflects off the stump
  const v = 30;
  const hitPos = new THREE.Vector3(0.0, 0.42, wz + STUMPS.radius + R);
  let bp: THREE.Vector3;
  if (tt < 0) bp = hitPos.clone().add(new THREE.Vector3(-0.05 * tt * v * 0.02, 0, -tt * v));
  // rebounds off the front of the stump (back toward the bowler, off side and up): never through a stump
  else bp = hitPos.clone().add(new THREE.Vector3(-2.6 * tt, 2.2 * tt - 4.9 * tt * tt, 4.2 * tt));
  return (
    <>
      <CameraRig position={cam} target={tgt} fov={34} />
      <StandInLights focus={[0, 0, wz]} rimDir={[0.4, 0.5, 1]} shadowSize={5} />
      <Wicket position={[0, 0, wz]} state={state} />
      <Ball position={[bp.x, bp.y, bp.z]} spin={[-at * 40, 0.3, 0]} detail="mid" />
      <GrassBlades center={[cam[0] + 0.6, 0, cam[2] + 0.3]} radius={1.6} density={4000} wind={0.3} F={frame} />
    </>
  );
};

/** Segment C1 (160-199): bat lineup - face, edge, back and 3/4 - slowly turning. */
const BatLineup: React.FC<{ frame: number }> = ({ frame }) => {
  const wz = BOWLER_STUMPS_Z;
  const turn = ((frame - 160) / 40) * 0.5;
  const views = [0, Math.PI / 2, Math.PI, Math.PI * 1.25];
  return (
    <>
      <CameraRig position={[0, 0.55, wz - 2.9]} target={[0, 0.5, wz - 1.2]} fov={30} />
      <StandInLights focus={[0, 0.5, wz - 1.2]} rimDir={[0.3, 0.6, 1]} shadowSize={4} />
      {views.map((v, i) => (
        <Bat key={i} position={[-0.42 + i * 0.28, 0.86, wz - 1.2]} rotation={[0, v + turn, 0]} />
      ))}
      <Wicket position={[0, 0, wz]} />
    </>
  );
};

/** Segment C2 (200-239): ball at close, mid and far distance on the pitch (seam readability). */
const BallTrio: React.FC<{ frame: number }> = ({ frame }) => {
  const wz = BOWLER_STUMPS_Z;
  const sp = (frame - 200) * 0.03;
  return (
    <>
      <CameraRig position={[0.0, 0.17, wz - 2.3]} target={[0.0, 0.05, wz - 1.5]} fov={30} />
      <StandInLights focus={[0, 0, wz - 1.2]} rimDir={[0.2, 0.5, 1]} shadowSize={3} />
      <Ball position={[0.075, BALL_REST_Y, wz - 1.86]} spin={[0.4 + sp, 0.5, 1.4]} detail="hero" groundShadow />
      <Ball position={[-0.12, BALL_REST_Y, wz - 1.4]} spin={[1.57, sp, 0.2]} detail="mid" groundShadow />
      <Ball position={[0.3, BALL_REST_Y, wz - 0.35]} spin={[0.3, 0.6 + sp, 1.35]} detail="low" groundShadow />
      <Wicket position={[0, 0, wz]} />
    </>
  );
};

/**
 * T-Props
 *   0-79    macro: ball meets the bat's sweet spot (slow motion), slow orbit
 *   80-159  wicket hit in slow motion, one bail flies at the camera
 *   160-199 bat lineup: face, edge, back, 3/4 (slowly turning)
 *   200-239 balls at close / mid / far distance on the pitch
 */
export const TProps: React.FC<{ view?: string; dbg?: string }> = ({ view = "" }) => {
  const frame = useCurrentFrame();
  if (view) return <PropsView view={view} frame={frame} />;
  const seg = frame < 80 ? "A macro" : frame < 160 ? "B wicket hit" : frame < 200 ? "C bat lineup" : "D balls";
  return (
    <TestCanvas label={`T-Props ${seg} f${frame}`}>
      <color attach="background" args={["#05080a"]} />
      <fog attach="fog" args={["#0b1418", 90, 420]} />
      <StandInStadium />
      <Field detail="near" />
      {frame < 80 ? (
        <MacroContact frame={frame} />
      ) : frame < 160 ? (
        <WicketHit frame={frame} />
      ) : frame < 200 ? (
        <BatLineup frame={frame} />
      ) : (
        <BallTrio frame={frame} />
      )}
    </TestCanvas>
  );
};

/* ------------------------------------------------------------------ */
/* Director views (prop `view`): the props as the film's shots use them */
/* ------------------------------------------------------------------ */

/**
 *   stumps  S09 opening: lens 0.55 m from the striker's stumps at bail height, intact wicket
 *   s06     ball-follow: lens 0.7 m behind/below a ball climbing at 28 m/s with backspin
 *   s06far  the same at 2.5 m (the ball ~60 px at 1080p)
 *   s05     side-on bat contact from the off side at 1.6 m (the bat ~1/3 of the frame height)
 */
const PropsView: React.FC<{ view: string; frame: number }> = ({ view, frame }) => {
  const f = frame;
  let cam: Vec3 = [0, 1, 3];
  let tgt: Vec3 = [0, 0.5, 0];
  let fov = 32;
  let content: React.ReactNode = null;
  const wz = STRIKER_STUMPS_Z;
  if (view === "stumps") {
    const a = -0.5 + f * 0.01;
    cam = [Math.sin(a) * 0.62, 0.66, wz + Math.cos(a) * 0.62];
    tgt = [0, 0.62, wz];
    fov = 34;
    content = (
      <>
        <StandInLights focus={[0, 0.5, wz]} rimDir={rimDirFor(cam, [0, 0.5, wz])} shadowSize={3} />
        <Wicket position={[0, 0, wz]} />
      </>
    );
  } else if (view === "stumpbase") {
    // S09 low lens: 12 cm off the pitch, 0.7 m in front of the striker's stumps
    cam = [0.25, 0.12, wz + 0.7];
    tgt = [0, 0.12, wz];
    fov = 34;
    content = (
      <>
        <StandInLights focus={[0, 0.3, wz]} rimDir={rimDirFor(cam, [0, 0.3, wz])} shadowSize={3} />
        <Wicket position={[0, 0, wz]} />
        <Ball position={[0.19, BALL_REST_Y, wz + 0.32]} spin={[0.3, 0.8, 1.2]} detail="hero" groundShadow />
      </>
    );
  } else if (view === "stumptop" || view === "stumptop2") {
    // extreme close-up of the left stump top at bail height (seating check); stumptop2 from above
    const x0 = -STUMPS.spacing;
    cam = view === "stumptop" ? [x0 + 0.02, 0.712, wz + 0.3] : [x0 + 0.08, 0.86, wz + 0.22];
    tgt = [x0 + 0.008, 0.712, wz];
    fov = 10;
    content = (
      <>
        <StandInLights focus={[0, 0.5, wz]} rimDir={rimDirFor(cam, [0, 0.5, wz])} shadowSize={3} />
        <Wicket position={[0, 0, wz]} />
      </>
    );
  } else if (view === "s06" || view === "s06far") {
    const t = f / 30;
    const v0 = new THREE.Vector3(6, 16, 22);
    const p0 = new THREE.Vector3(0.3, 1.0, -8.6);
    const bp = p0.clone().addScaledVector(v0, t);
    bp.y -= 4.905 * t * t;
    const vel = v0.clone();
    vel.y -= 9.81 * t;
    const dir = vel.clone().normalize();
    const back = view === "s06" ? 0.7 : 2.5;
    const c = bp.clone().addScaledVector(dir, -back);
    c.y -= back * 0.22;
    cam = [c.x, c.y, c.z];
    tgt = [bp.x, bp.y, bp.z];
    fov = 30;
    // backspin about the axis across the flight (seam upright, rotating back toward the batsman)
    const spinAxis = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
    const q = new THREE.Quaternion().setFromAxisAngle(spinAxis, -t * 2 * Math.PI * 9);
    const seamUp = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), spinAxis);
    const e = new THREE.Euler().setFromQuaternion(q.multiply(seamUp));
    content = (
      <>
        <StandInLights focus={[bp.x, bp.y, bp.z]} rimDir={rimDirFor(cam, [bp.x, bp.y, bp.z], 0.5, 0.3)} shadows={false} />
        <Ball position={[bp.x, bp.y, bp.z]} spin={[e.x, e.y, e.z]} detail={view === "s06" ? "hero" : "mid"} />
      </>
    );
  } else if (view === "s05") {
    const batPos: Vec3 = [0.05, 0.95, -8.75];
    const batRot: Vec3 = [0.18, 0, 0.0];
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(...batPos),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...batRot)),
      new THREE.Vector3(1, 1, 1),
    );
    const contact = new THREE.Vector3(...BAT_SWEET_SPOT).applyMatrix4(m);
    const n = new THREE.Vector3(0, 0, 1).transformDirection(m);
    const tc = (f - 20) / 30;
    const ballC = contact.clone().addScaledVector(n, R + Math.abs(tc) * (tc < 0 ? 2.5 : 1.6));
    ballC.y += tc < 0 ? tc * 0.3 : tc * 0.5;
    cam = [contact.x - 1.6, contact.y + 0.25, contact.z + 0.1];
    tgt = [contact.x, contact.y + 0.15, contact.z];
    fov = 30;
    content = (
      <>
        <StandInLights focus={[contact.x, 0.5, contact.z]} rimDir={rimDirFor(cam, [contact.x, 0.5, contact.z])} shadowSize={3} />
        <Bat position={batPos} rotation={batRot} />
        <Ball position={[ballC.x, ballC.y, ballC.z]} spin={[f * 0.2, 0.3, 0.2]} detail="hero" />
        <Wicket position={[0, 0, wz]} />
      </>
    );
  }
  return (
    <TestCanvas label={`T-Props view ${view} f${frame}`}>
      <color attach="background" args={["#05080a"]} />
      <fog attach="fog" args={["#0b1418", 90, 420]} />
      <StandInStadium />
      <Field detail="near" />
      <CameraRig position={cam} target={tgt} fov={fov} />
      {content}
    </TestCanvas>
  );
};
