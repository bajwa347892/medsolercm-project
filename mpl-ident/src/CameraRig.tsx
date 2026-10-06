import React from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { Vec3 } from "./rig/types";

/**
 * Sets the scene camera every frame. Render exactly one per shot.
 * position/target in world metres, fov in degrees (vertical), roll in radians.
 */
export const CameraRig: React.FC<{
  position: Vec3;
  target: Vec3;
  fov?: number;
  roll?: number;
  near?: number;
  far?: number;
}> = ({ position, target, fov = 35, roll = 0, near = 0.01, far = 2000 }) => {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  // Applied synchronously during render so it is in place before the frame draws.
  camera.position.set(...position);
  camera.up.set(0, 1, 0);
  camera.lookAt(new THREE.Vector3(...target));
  if (roll) camera.rotateZ(roll);
  if (camera.fov !== fov || camera.near !== near || camera.far !== far) {
    camera.fov = fov;
    camera.near = near;
    camera.far = far;
    camera.updateProjectionMatrix();
  }
  camera.updateMatrixWorld();
  return null;
};
