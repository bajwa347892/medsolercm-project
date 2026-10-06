import React, { useMemo } from "react";
import { useCurrentFrame } from "remotion";
import * as THREE from "three";
import { CameraRig } from "../CameraRig";
import { EASE_IN_OUT, lerp, prog } from "../config";
import { PAL } from "../theme";
import { BOWLER_STUMPS_Z, FIELD, STADIUM, STRIKER_STUMPS_Z } from "../world/dims";
import { Field, GrassBlades } from "../world/Field";
import { StadiumLights } from "../world/Lights";
import { Wicket } from "../world/Props";
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
}> = ({ focus = [0, 0, 0], rimDir = [0, 0.45, 1], shadowSize = 12, shadows = true, intensity = 1 }) => (
  <StadiumLights
    intensity={intensity}
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
 *   0-79    low camera across the pitch toward the bowler's stumps (3D grass in the foreground)
 *   80-159  aerial crane over the whole ground (stripes, square, 30-yard circle, rope)
 *   160-239 macro grass at the boundary, a sliding body flattens the blades
 */
export const TField: React.FC = () => {
  const frame = useCurrentFrame();
  let cam: Vec3;
  let tgt: Vec3;
  let fov = 35;
  let seg = "";
  let content: React.ReactNode = null;
  if (frame < 80) {
    seg = "A low across pitch";
    const t = prog(frame, 0, 79, EASE_IN_OUT);
    cam = [lerp(3.4, 2.7, t), lerp(0.28, 0.36, t), lerp(2.4, 4.0, t)];
    tgt = [0, 0.32, BOWLER_STUMPS_Z];
    fov = 32;
    content = (
      <>
        <StandInLights focus={[0, 0, 8]} rimDir={[0.2, 0.5, 1]} shadowSize={14} />
        <GrassBlades center={[3.1, 0, 3.6]} radius={1.7} wind={0.6} F={frame} />
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
    const t = prog(frame, 160, 239, EASE_IN_OUT);
    cam = [lerp(61.2, 61.6, t), lerp(0.085, 0.13, t), lerp(-0.25, 0.15, t)];
    tgt = [66, 0.08, lerp(-0.05, 0.1, t)];
    fov = 40;
    // a sliding body crossing the patch: current contact + a recovering trail behind it
    const slideAt = (fr: number): Vec3 => {
      const s = prog(fr, 172, 228, EASE_IN_OUT);
      return [lerp(62.3, 62.7, s), 0, lerp(-1.7, 1.5, s)];
    };
    const trail = [0, 4, 8, 13, 19, 26, 34, 44].map((lag, i) => ({
      pos: slideAt(frame - lag),
      radius: 0.3 - i * 0.012,
      strength: frame - lag >= 172 ? 1.1 * Math.exp(-lag / 30) : 0,
      dir: [0.12, 0, 1] as Vec3,
    }));
    content = (
      <>
        <StandInLights focus={[63, 0, 0]} rimDir={[1, 0.35, 0.2]} shadowSize={6} shadows={false} />
        <GrassBlades
          center={[62.6, 0, 0]}
          radius={1.6}
          density={8000}
          wind={0.45}
          F={frame}
          disturb={trail}
        />
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
      <Field detail={frame >= 160 ? "near" : "far"} />
      <Wicket position={[0, 0, BOWLER_STUMPS_Z]} />
      <Wicket position={[0, 0, STRIKER_STUMPS_Z]} />
    </TestCanvas>
  );
};
