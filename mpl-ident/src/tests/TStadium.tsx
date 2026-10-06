import React, { useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  BlendFunction,
  BloomEffect,
  EffectComposer,
  EffectPass,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from "postprocessing";
import { useCurrentFrame } from "remotion";
import * as THREE from "three";
import { CameraRig } from "../CameraRig";
import { EASE_IN_OUT, EASE_OUT, lerp, prog, rng } from "../config";
import { PAL } from "../theme";
import type { Vec3 } from "../rig/types";
import { Atmosphere } from "../world/Atmosphere";
import { StadiumLights, floodMaster, rimDirFor } from "../world/Lights";
import { Stadium, stadiumStateAt } from "../world/Stadium";
import { FIELD, PITCH } from "../world/dims";
import { TestCanvas } from "./TestCanvas";

/**
 * T-Stadium test (240 frames):
 *   0-65    aerial establishing move, cue-accurate (floods on at the flood_on cues, LED sweep at led_sweep)
 *   66-129  ground level from the striker's end looking at the bowler's end, slow pan
 *   130-179 low angle by the boundary up at the stand under bank 1; crowd energy ramps to 1
 *   180-209 long lens toward the big screen and the upper tiers (crowd detail)
 *   210-239 lighting calibration on the pitch (StadiumLights + shadows), detail="near"
 */

/* ---------- private stand-ins (the real field and post live in other modules) ---------- */

const StandInField: React.FC = () => {
  const { mat, pitchMat } = useMemo(() => {
    const W = 256;
    const data = new Uint8Array(W * W * 4);
    const r = rng(12);
    const a = new THREE.Color(PAL.grassA);
    const b = new THREE.Color(PAL.grassB);
    a.convertLinearToSRGB();
    b.convertLinearToSRGB();
    for (let y = 0; y < W; y++)
      for (let x = 0; x < W; x++) {
        const c = x < W / 2 ? a : b;
        const n = 0.9 + r() * 0.2;
        const i = (y * W + x) * 4;
        data[i] = Math.min(255, c.r * 255 * n);
        data[i + 1] = Math.min(255, c.g * 255 * n);
        data[i + 2] = Math.min(255, c.b * 255 * n);
        data[i + 3] = 255;
      }
    const tex = new THREE.DataTexture(data, W, W);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(FIELD.outfieldRadius / 5, FIELD.outfieldRadius / 5);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0 });
    const pm = new THREE.MeshStandardMaterial({ color: PAL.pitch, roughness: 0.9 });
    return { mat: m, pitchMat: pm };
  }, []);
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} material={mat} receiveShadow>
        <circleGeometry args={[FIELD.outfieldRadius, 128]} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.004, 0]} material={pitchMat} receiveShadow>
        <planeGeometry args={[PITCH.width, PITCH.stripLength]} />
      </mesh>
    </>
  );
};

/**
 * Synchronous composer: built in useMemo so it exists before Remotion's first advance().
 * (@react-three/postprocessing's <EffectComposer> creates its composer in a useEffect, which
 * runs after Remotion has already advanced the frame, so stills come out black.)
 */
const StandInPost: React.FC = () => {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const composer = useMemo(() => {
    const c = new EffectComposer(gl, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
    c.addPass(new RenderPass(scene, camera));
    c.addPass(
      new EffectPass(
        camera,
        new BloomEffect({ mipmapBlur: true, intensity: 0.85, luminanceThreshold: 0.9, luminanceSmoothing: 0.25, radius: 0.72 }),
        new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }),
        new VignetteEffect({ blendFunction: BlendFunction.NORMAL, offset: 0.32, darkness: 0.5 }),
      ),
    );
    return c;
  }, [gl, scene, camera]);
  composer.setSize(size.width, size.height);
  useFrame(() => composer.render(), 1);
  return null;
};

const Calibration: React.FC = () => (
  <group>
    <mesh position={[-0.9, 0.3, 1.5]} castShadow>
      <sphereGeometry args={[0.3, 48, 24]} />
      <meshStandardMaterial color="#d8dcde" roughness={0.6} />
    </mesh>
    <mesh position={[-0.2, 0.3, 1.5]} castShadow>
      <sphereGeometry args={[0.3, 48, 24]} />
      <meshStandardMaterial color={PAL.graphite} roughness={0.55} />
    </mesh>
    <mesh position={[0.5, 0.3, 1.5]} castShadow>
      <sphereGeometry args={[0.3, 48, 24]} />
      <meshStandardMaterial color={PAL.tealDeep} roughness={0.4} metalness={0.3} />
    </mesh>
    <mesh position={[1.2, 0.3, 1.5]} castShadow>
      <sphereGeometry args={[0.3, 48, 24]} />
      <meshStandardMaterial color={PAL.silver} roughness={0.12} metalness={1} />
    </mesh>
    <mesh position={[0.15, 0.036, 0.7]} castShadow>
      <sphereGeometry args={[0.036, 32, 16]} />
      <meshPhysicalMaterial color={PAL.leather} roughness={0.45} clearcoat={1} clearcoatRoughness={0.15} />
    </mesh>
    {/* mannequin: graphite body to judge rim and fill */}
    <group position={[2.2, 0, 2.6]}>
      <mesh position={[0, 0.95, 0]} castShadow>
        <capsuleGeometry args={[0.2, 0.9, 8, 16]} />
        <meshStandardMaterial color={PAL.graphite} roughness={0.7} />
      </mesh>
      <mesh position={[0, 1.68, 0]} castShadow>
        <sphereGeometry args={[0.12, 32, 16]} />
        <meshStandardMaterial color="#7a5640" roughness={0.6} />
      </mesh>
    </group>
  </group>
);

/* ---------- camera plan ---------- */

type Cam = { pos: Vec3; target: Vec3; fov: number; near: number };

const camAt = (f: number): Cam => {
  if (f < 66) {
    // drone: high over the city, descending over the roof rim into the bowl
    const p = prog(f, 0, 66, EASE_IN_OUT);
    const ang = THREE.MathUtils.degToRad(lerp(116, 97, p));
    const rad = lerp(340, 100, p);
    const y = lerp(250, 70, p);
    return {
      pos: [Math.cos(ang) * rad, y, Math.sin(ang) * rad],
      target: [0, lerp(-20, 0, p), lerp(-10, -18, p)],
      fov: lerp(38, 46, p),
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
    // low by the boundary looking up at the stand under bank 1 (45deg)
    const p = prog(f, 130, 180, EASE_OUT);
    return {
      pos: [lerp(36, 40, p), lerp(1.3, 1.6, p), lerp(30, 34, p)],
      target: [lerp(84, 80, p), lerp(24, 30, p), lerp(66, 74, p)],
      fov: 50,
      near: 0.2,
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
  const p = prog(f, 210, 240, EASE_IN_OUT);
  return {
    pos: [lerp(-1.0, 0.4, p), 1.25, lerp(-2.6, -2.2, p)],
    target: [0.4, 0.55, 2.0],
    fov: 40,
    near: 0.05,
  };
};

export const TStadium: React.FC = () => {
  const frame = useCurrentFrame();
  const cam = camAt(frame);
  // sections after the aerial use the fully-lit state, but keep their own clock for animation
  const F = frame;
  const st = stadiumStateAt(F);
  let energy = st.energy;
  if (frame >= 130 && frame < 210) energy = lerp(0.4, 1, prog(frame, 130, 175));
  const master = floodMaster(st.floods);
  const near = frame >= 210;
  const subject: Vec3 = near ? [0.3, 0.6, 1.5] : [0, 1, 0];
  const label =
    frame < 66
      ? "aerial / awaken"
      : frame < 130
        ? "pitch level"
        : frame < 180
          ? "boundary, energy ramp"
          : frame < 210
            ? "big screen, upper tiers"
            : "lighting calibration";
  return (
    <TestCanvas label={`T-Stadium · ${label} · F${frame}`}>
      <CameraRig position={cam.pos} target={cam.target} fov={cam.fov} near={cam.near} far={2400} />
      <Atmosphere F={F} floods={st.floods} motesCenter={near ? [0, 4, 3] : [0, 9, 0]} motesRadius={near ? 8 : 32} motesHeight={near ? 8 : 18} />
      <Stadium F={F} floods={st.floods} led={st.led} ledSweep={st.ledSweep} energy={energy} detail={near ? "near" : "far"} />
      <StadiumLights
        intensity={master}
        rimDir={rimDirFor(cam.pos, subject)}
        shadows={near}
        shadowCenter={[0.3, 0, 1.5]}
        shadowSize={4}
      />
      <StandInField />
      {near ? <Calibration /> : null}
      <StandInPost />
    </TestCanvas>
  );
};
