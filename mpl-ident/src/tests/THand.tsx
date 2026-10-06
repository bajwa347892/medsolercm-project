import React from "react";
import { CameraRig } from "../CameraRig";
import { TestCanvas } from "./TestCanvas";

/** Module test scene for Hand. Replace the contents to preview the module. */
export const THand: React.FC = () => (
  <TestCanvas label="T-Hand (stub)">
    <CameraRig position={[0, 2, 6]} target={[0, 1, 0]} />
    <color attach="background" args={["#111"]} />
  </TestCanvas>
);
