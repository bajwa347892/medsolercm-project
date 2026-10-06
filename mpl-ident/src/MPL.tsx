import React from "react";
import { ThreeCanvas } from "@remotion/three";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import * as THREE from "three";
import { shotAt } from "./shots/registry";

/**
 * The film: one shared WebGL canvas. Exactly one shot is live per frame;
 * the shot renders its own environment, actors, camera and post stack.
 */
export const MPL: React.FC = () => {
  const F = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const shot = shotAt(F);
  const f = F - shot.from;
  const { Scene, Overlay } = shot;
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <ThreeCanvas
        width={width}
        height={height}
        gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, outputColorSpace: THREE.SRGBColorSpace }}
        camera={{ fov: 35, near: 0.01, far: 2000, position: [0, 2, 6] }}
      >
        <Scene key={shot.id} f={f} F={F} />
      </ThreeCanvas>
      {Overlay ? <Overlay f={f} F={F} /> : null}
    </AbsoluteFill>
  );
};
