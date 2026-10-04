import React from "react";
import { AbsoluteFill, interpolate, interpolateColors, random, useCurrentFrame } from "remotion";
import { C } from "../theme";
import { EASE_IN_OUT } from "../timeline";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

const PARTICLES = new Array(34).fill(0).map((_, i) => ({
  x: random(`px${i}`) * 1920,
  y: random(`py${i}`) * 1080,
  size: 2 + random(`ps${i}`) * 5,
  depth: 0.3 + random(`pd${i}`) * 1.3,
  warm: random(`pw${i}`) > 0.55,
  square: random(`pq${i}`) > 0.5,
}));

/**
 * Layered backdrop: base color that warms from charcoal to navy at the turn,
 * a parallax dot grid, drifting glows and particles at several depths.
 */
export const Background: React.FC = () => {
  const f = useCurrentFrame();

  // The "before" world is cold and grey. Color arrives with the turn.
  const warmth = interpolate(f, [146, 196], [0, 1], { ...clamp, easing: EASE_IN_OUT });
  const base = interpolateColors(warmth, [0, 1], [C.charcoal, C.navy]);
  const baseLow = interpolateColors(warmth, [0, 1], ["#0B0C0F", "#06101F"]);

  const glowA = interpolate(f, [150, 220, 600, 700], [0, 0.22, 0.18, 0.3], clamp);
  const glowB = interpolate(f, [150, 230], [0, 0.55], clamp);
  const greyGlow = interpolate(f, [0, 150, 200], [0.06, 0.06, 0], clamp);

  const gridX = -f * 0.4;
  const gridY = -f * 0.12;

  return (
    <AbsoluteFill style={{ background: `linear-gradient(160deg, ${base} 0%, ${baseLow} 100%)` }}>
      {/* drifting glows */}
      <div
        style={{
          position: "absolute",
          width: 1500,
          height: 1500,
          left: 1050 + Math.sin(f / 70) * 40,
          top: -650 + Math.cos(f / 90) * 30,
          borderRadius: "50%",
          background: `radial-gradient(circle, rgba(244,117,33,${glowA}) 0%, rgba(244,117,33,0) 62%)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 1600,
          height: 1600,
          left: -700 + Math.cos(f / 80) * 40,
          top: 250,
          borderRadius: "50%",
          background: `radial-gradient(circle, rgba(26,49,85,${glowB}) 0%, rgba(26,49,85,0) 65%)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 1400,
          height: 1400,
          left: 700,
          top: -300,
          borderRadius: "50%",
          background: `radial-gradient(circle, rgba(255,255,255,${greyGlow}) 0%, rgba(255,255,255,0) 60%)`,
        }}
      />

      {/* parallax dot grid */}
      <svg
        width={2200}
        height={1300}
        style={{
          position: "absolute",
          left: -140,
          top: -110,
          transform: `translate(${gridX % 48}px, ${gridY % 48}px)`,
          opacity: 0.55,
        }}
      >
        <defs>
          <pattern id="dots" width="48" height="48" patternUnits="userSpaceOnUse">
            <circle cx="2" cy="2" r="1.6" fill="rgba(255,255,255,0.13)" />
          </pattern>
          <radialGradient id="gridFade" cx="50%" cy="45%" r="65%">
            <stop offset="0%" stopColor="white" stopOpacity="1" />
            <stop offset="100%" stopColor="white" stopOpacity="0" />
          </radialGradient>
          <mask id="gridMask">
            <rect width="2200" height="1300" fill="url(#gridFade)" />
          </mask>
        </defs>
        <rect width="2200" height="1300" fill="url(#dots)" mask="url(#gridMask)" />
      </svg>

      {/* particles at several depths */}
      {PARTICLES.map((pt, i) => {
        const x = (((pt.x - f * 0.55 * pt.depth) % 2000) + 2000) % 2000 - 40;
        const y = (((pt.y - f * 0.28 * pt.depth) % 1160) + 1160) % 1160 - 40;
        const warmOn = pt.warm ? warmth : 0;
        const color = interpolateColors(warmOn, [0, 1], ["rgba(255,255,255,1)", "rgba(244,117,33,1)"]);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x,
              top: y,
              width: pt.size * pt.depth,
              height: pt.size * pt.depth,
              borderRadius: pt.square ? 2 : "50%",
              background: color,
              opacity: 0.05 + 0.1 * (pt.depth / 1.6),
              filter: pt.depth > 1.2 ? "blur(2px)" : undefined,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};

/** Vignette and film grain, on top of everything. */
export const Finish: React.FC = () => {
  const f = useCurrentFrame();
  const gx = Math.floor(random(`gx${f % 8}`) * 90);
  const gy = Math.floor(random(`gy${f % 8}`) * 90);
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(ellipse 75% 70% at 50% 48%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.5) 100%)",
        }}
      />
      <svg
        width={2020}
        height={1180}
        style={{
          position: "absolute",
          left: -gx,
          top: -gy,
          opacity: 0.07,
          mixBlendMode: "overlay",
        }}
      >
        <filter id="grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#grain)" />
      </svg>
    </AbsoluteFill>
  );
};
