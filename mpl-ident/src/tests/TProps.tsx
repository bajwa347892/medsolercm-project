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

/** Segment B: a fast delivery hits middle stump, bails explode, slow motion. */
const WicketHit: React.FC<{ frame: number }> = ({ frame }) => {
  const HIT = 98;
  // action time: real time, ramping into 12% speed just before the hit
  const at = actionTime(frame, [
    [80, 1],
    [94, 1],
    [97, 0.12],
    [150, 0.12],
    [158, 0.5],
  ]);
  const tHit = actionTime(HIT, [
    [80, 1],
    [94, 1],
    [97, 0.12],
    [150, 0.12],
    [158, 0.5],
  ]);
  const tt = at - tHit;
  const wz = STRIKER_STUMPS_Z;
  const cam: Vec3 = [0.85, 0.42, wz - 1.25];
  const toward: Vec3 = [cam[0] - (-STUMPS.spacing / 2), cam[1] - 0.72, cam[2] - wz];
  const state = wicketHitState(tt, { dir: [0.05, 0, -1], stump: 1, strength: 1, toward, towardSpeed: 2.6, seed: 3 });
  // ball: 30 m/s along -Z, low, deflects off the stump
  const v = 30;
  const hitPos = new THREE.Vector3(0.0, 0.42, wz + STUMPS.radius + R);
  let bp: THREE.Vector3;
  if (tt < 0) bp = hitPos.clone().add(new THREE.Vector3(-0.05 * tt * v * 0.02, 0, -tt * v));
  // deflects off the stump: away to +X and up, clearing the stump it hit
  else bp = hitPos.clone().add(new THREE.Vector3(7.5 * tt, 3.2 * tt - 4.9 * tt * tt, -2.2 * tt));
  const t = prog(frame, 80, 159, EASE_IN_OUT);
  const camP: Vec3 = [lerp(cam[0], cam[0] + 0.15, t), lerp(cam[1], cam[1] + 0.03, t), cam[2]];
  return (
    <>
      <CameraRig position={camP} target={[0, 0.5, wz]} fov={34} />
      <StandInLights focus={[0, 0, wz]} rimDir={[0.4, 0.5, 1]} shadowSize={5} />
      <Wicket position={[0, 0, wz]} state={state} />
      <Ball position={[bp.x, bp.y, bp.z]} spin={[-at * 40, 0.3, 0]} detail="mid" />
      <GrassBlades center={[1.4, 0, wz - 1.2]} radius={0.9} density={2600} wind={0.3} F={frame} />
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
export const TProps: React.FC = () => {
  const frame = useCurrentFrame();
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
