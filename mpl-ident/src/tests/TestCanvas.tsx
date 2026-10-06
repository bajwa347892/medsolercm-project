import React from "react";
import { ThreeCanvas } from "@remotion/three";
import { AbsoluteFill, useVideoConfig } from "remotion";
import * as THREE from "three";

/** Wraps a module test scene in a canvas with the same renderer settings as the film. */
export const TestCanvas: React.FC<{ children: React.ReactNode; label?: string }> = ({ children, label }) => {
  const { width, height } = useVideoConfig();
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <ThreeCanvas
        width={width}
        height={height}
        gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, outputColorSpace: THREE.SRGBColorSpace }}
        camera={{ fov: 35, near: 0.01, far: 2000, position: [0, 2, 6] }}
      >
        {children}
      </ThreeCanvas>
      {label ? (
        <div style={{ position: "absolute", left: 16, top: 12, color: "#9ff", font: "20px monospace" }}>{label}</div>
      ) : null}
    </AbsoluteFill>
  );
};
