import type React from "react";

export type ShotProps = {
  /** frame relative to the shot start (0 at the shot's first frame) */
  f: number;
  /** global frame in the 810-frame film */
  F: number;
};

export type ShotDef = {
  id: string;
  from: number; // first global frame (inclusive)
  to: number; // last global frame (exclusive)
  /** 3D content: rendered inside the single shared ThreeCanvas. Must render one <CameraRig/>. */
  Scene: React.FC<ShotProps>;
  /** optional 2D layer drawn above the canvas (titles, flashes, grain overlays) */
  Overlay?: React.FC<ShotProps>;
};
