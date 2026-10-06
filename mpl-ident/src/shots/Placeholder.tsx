import React from "react";
import { CameraRig } from "../CameraRig";
import type { ShotDef, ShotProps } from "./types";

/** Temporary stand-in used until a shot is built. */
export const placeholderShot = (id: string, from: number, to: number): ShotDef => {
  const Scene: React.FC<ShotProps> = () => (
    <>
      <CameraRig position={[0, 2, 6]} target={[0, 1, 0]} />
      <color attach="background" args={["#0b0f12"]} />
    </>
  );
  const Overlay: React.FC<ShotProps> = ({ f }) => (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "rgba(255,255,255,0.5)",
        fontFamily: "sans-serif",
        fontSize: 48,
      }}
    >
      {id} · frame {f}
    </div>
  );
  return { id, from, to, Scene, Overlay };
};
