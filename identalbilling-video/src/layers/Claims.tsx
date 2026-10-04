import React from "react";
import { useCurrentFrame } from "remotion";
import { ClaimCard } from "./ClaimCard";
import {
  CARD_FLY,
  CARD_H,
  CARD_RIDE_SCALE,
  CARD_RIDE_Y,
  CARD_W,
  EASE_IN,
  EASE_IN_OUT,
  EASE_OUT,
  FLIP_END,
  FLIP_START,
  HERO,
  NODE_X,
  PILE,
  PILE_C,
  RING_C,
  cardRide,
  lerp,
  p,
  panX,
  pileDrift,
  pileShake,
} from "../timeline";

const place = (x: number, y: number) => ({
  position: "absolute" as const,
  left: x - CARD_W / 2,
  top: y - CARD_H / 2,
  width: CARD_W,
  height: CARD_H,
});

/** Where a card sits in the pile at frame f (after it has landed). */
const pilePos = (i: number, f: number) => {
  const c = PILE[i];
  return {
    x: PILE_C.x + c.dx + pileDrift(f),
    y: PILE_C.y + c.dy + pileShake(f),
    r: c.r,
  };
};

/** Fly-in from off-screen, top right. */
const flyIn = (i: number, f: number) => {
  const c = PILE[i];
  const t = p(f, c.t, c.t + CARD_FLY, EASE_OUT);
  const end = pilePos(i, f);
  return {
    x: lerp(end.x + 560, end.x, t),
    y: lerp(end.y - 780, end.y, t),
    r: lerp(end.r + 34, end.r, t),
    visible: f >= c.t,
  };
};

const stampAt = (i: number, f: number) => p(f, PILE[i].t + 11, PILE[i].t + 18, EASE_OUT);

/** Cards stacked above card i dim it, which reads as depth. */
const depthDim = (i: number, f: number) => {
  let above = 0;
  for (let j = i + 1; j < PILE.length; j++) {
    above += p(f, PILE[j].t + 6, PILE[j].t + CARD_FLY);
  }
  return Math.max(0.5, 1 - above * 0.075);
};

const Shadow: React.FC<{ strength: number }> = ({ strength }) => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      borderRadius: 22,
      boxShadow: `0 ${30 * strength}px ${80 * strength}px rgba(0,0,0,${0.45 * strength}), 0 ${8 * strength}px ${20 * strength}px rgba(0,0,0,${0.3 * strength})`,
    }}
  />
);

export const Claims: React.FC = () => {
  const f = useCurrentFrame();

  const others = PILE.slice(0, HERO).map((c, i) => {
    if (f < c.t || f > 175) return null;
    const pos = flyIn(i, f);
    // Fall away when iDental Billing takes over.
    const e = p(f, 136 + i * 1.6, 160 + i * 1.6, EASE_IN);
    const dir = i % 2 === 0 ? -1 : 1;
    return (
      <div
        key={c.id}
        style={{
          ...place(pos.x + dir * 60 * e, pos.y + 460 * e),
          transform: `rotate(${pos.r + dir * 14 * e}deg) scale(${1 - 0.1 * e})`,
          opacity: 1 - e,
          filter: `brightness(${depthDim(i, f)})${e > 0 ? ` blur(${e * 6}px)` : ""}`,
        }}
      >
        <Shadow strength={0.8} />
        <ClaimCard variant="denied" id={c.id} code={c.code} stamp={stampAt(i, f)} />
      </div>
    );
  });

  // ---- The hero card: denied -> flips clean -> rides the pipeline -> resolves into the stat.
  const h = PILE[HERO];
  let x: number;
  let y: number;
  let r: number;
  let scale = 1;
  let opacity = 1;

  if (f < 140) {
    const pos = flyIn(HERO, f);
    x = pos.x;
    y = pos.y;
    r = pos.r;
  } else if (f < 250) {
    const m = p(f, 140, 164, EASE_IN_OUT);
    const from = pilePos(HERO, f);
    const bob = f > 172 ? Math.sin((f - 172) / 16) * 5 : 0;
    x = lerp(from.x, RING_C.x, m);
    y = lerp(from.y, RING_C.y, m) + bob * m;
    r = lerp(from.r, 0, m);
    scale = lerp(1, 1.12, m);
  } else {
    const m = p(f, 250, 280, EASE_IN_OUT);
    const ride = cardRide(f);
    const bobEnd = Math.sin((250 - 172) / 16) * 5;
    const rideX = (f < 282 ? NODE_X[0] : ride.x) + panX(f);
    const rideY = CARD_RIDE_Y - ride.hop * 16;
    x = lerp(RING_C.x, rideX, m);
    y = lerp(RING_C.y + bobEnd, rideY, m);
    r = ride.hop * 3;
    scale = lerp(1.12, CARD_RIDE_SCALE, m);
    // Resolve into the stat.
    const out = p(f, 448, 466, EASE_IN);
    scale *= 1 - 0.35 * out;
    opacity = 1 - out;
  }

  const flip = p(f, FLIP_START, FLIP_END, EASE_IN_OUT);
  const angle = flip * 180;
  const lift = Math.sin(Math.PI * flip);
  const showBack = angle > 90;
  const faceAngle = showBack ? angle - 180 : angle;
  const check = p(f, FLIP_END - 2, FLIP_END + 12, EASE_OUT);

  const hero =
    f >= h.t && opacity > 0.001 ? (
      <div
        style={{
          ...place(x, y),
          transform: `perspective(1800px) rotate(${r}deg) scale(${scale * (1 + 0.1 * lift)}) rotateY(${faceAngle}deg)`,
          opacity,
          filter: !showBack && f < 150 ? `brightness(${depthDim(HERO, f)})` : undefined,
        }}
      >
        <Shadow strength={showBack ? 1 + lift * 0.5 : 0.8 + lift * 0.7} />
        {showBack ? (
          <ClaimCard variant="clean" id={h.id} code={h.code} check={check} />
        ) : (
          <ClaimCard variant="denied" id={h.id} code={h.code} stamp={stampAt(HERO, f)} />
        )}
        {/* glint that sweeps across as the card turns */}
        {lift > 0.02 ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: 22,
              background: `linear-gradient(105deg, rgba(255,255,255,0) 30%, rgba(255,255,255,${0.35 * lift}) 50%, rgba(255,255,255,0) 70%)`,
            }}
          />
        ) : null}
      </div>
    ) : null;

  return (
    <>
      {others}
      {hero}
    </>
  );
};
