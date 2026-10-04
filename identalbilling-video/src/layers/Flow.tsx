import React from "react";
import { interpolateColors, useCurrentFrame } from "remotion";
import { CheckIcon } from "./ClaimCard";
import { C, inter, mono } from "../theme";
import {
  ARRIVE,
  AXIS_X0,
  AXIS_X1,
  EASE_IN,
  EASE_IN_OUT,
  EASE_OUT,
  EASE_POP,
  NODE_X,
  NODE_Y,
  PROOF_EXIT,
  RING_C,
  RING_R,
  RULE,
  STAGES,
  TRACK_X0,
  TRACK_X1,
  axisX,
  axisY,
  cardRide,
  lerp,
  p,
  panX,
  ringRot,
  statValue,
} from "../timeline";

/* ------------------------------------------------------------------ */
/* One bar that becomes everything: aging report -> pipeline track     */
/* -> chart axis. Its orange fill becomes the closing accent rule.     */
/* ------------------------------------------------------------------ */

const AGING_X = 140;
const AGING_Y = 880; // top of bar
const AGING_H = 40;
const AGING_MAX = 1640;
const BUCKETS = ["0-30", "31-60", "61-90", "90+"];
const FR_START = [0.55, 0.25, 0.12, 0.08];
const FR_END = [0.22, 0.2, 0.22, 0.36];
const SHRINK = [0.2, 0.4, 0.7, 1];
const BUCKET_COLORS = [C.g1, C.g2, C.g3];

const agingWidths = (f: number) => {
  const grow = p(f, 26, 150, (t) => t * (2 - t) * 0.6 + t * 0.4);
  const mix = p(f, 26, 150, EASE_IN_OUT);
  const total = AGING_MAX * grow;
  const shrink = p(f, 188, 246, EASE_IN_OUT);
  return FR_START.map((s, i) => lerp(s, FR_END[i], mix) * total * (1 - SHRINK[i] * shrink));
};

export const AgingToAxis: React.FC = () => {
  const f = useCurrentFrame();

  const widths = agingWidths(f);
  const agingTotal = widths.reduce((a, b) => a + b, 0);

  // Morph timings
  const thin = p(f, 248, 262, EASE_IN_OUT); // bar thins to a line
  const travel = p(f, 256, 282, EASE_IN_OUT); // line rises and stretches into the track
  const toAxis = p(f, 450, 478, EASE_IN_OUT); // track becomes the chart axis
  const gone = p(f, PROOF_EXIT, PROOF_EXIT + 14, EASE_IN);

  const pan = panX(f);
  const trackX0 = lerp(lerp(AGING_X, TRACK_X0 + pan, travel), AXIS_X0, toAxis);
  const trackX1Full = lerp(TRACK_X1 + pan, AXIS_X1, toAxis);
  const trackW = lerp(agingTotal, trackX1Full - trackX0, travel);
  const h = lerp(lerp(AGING_H, 6, thin), 14, toAxis);
  const cy = lerp(lerp(AGING_Y + AGING_H / 2, NODE_Y, travel), axisY(f), toAxis);

  const labelFade = 1 - p(f, 244, 256, EASE_IN);
  const showBuckets = thin < 1;

  // Orange progress fill that follows the claim
  const ride = cardRide(f);
  const fillEnd = f < 282 ? TRACK_X0 : ride.x;
  const fillOpacity = (f >= 282 ? 1 : 0) * (1 - p(f, 446, 462, EASE_IN));

  // Stat fill: 90 -> 98.7 on the axis, then becomes the accent rule.
  const v = statValue(f);
  const statFillOn = f >= 486 ? 1 : 0;
  const toRule = p(f, 622, 650, EASE_IN_OUT);
  const sx0 = lerp(AXIS_X0, RULE.cx - RULE.w / 2, toRule);
  const sx1 = lerp(axisX(v), RULE.cx + RULE.w / 2, toRule);
  const sh = lerp(14, RULE.h, toRule);
  const scy = lerp(axisY(f), RULE.y + RULE.h / 2, toRule);

  const trackColor =
    toAxis > 0
      ? `rgba(255,255,255,${lerp(0.2, 0.14, toAxis)})`
      : `rgba(255,255,255,${lerp(0.0, 0.2, thin)})`;

  return (
    <>
      {/* aging report label */}
      {labelFade > 0 && f < 262 ? (
        <div
          style={{
            position: "absolute",
            left: AGING_X,
            top: AGING_Y - 44,
            fontFamily: mono,
            fontSize: 20,
            fontWeight: 500,
            letterSpacing: "0.12em",
            color: C.g1,
            opacity: p(f, 24, 36) * labelFade,
          }}
        >
          AGING REPORT · DAYS OUTSTANDING
        </div>
      ) : null}

      {/* track / bar */}
      {gone < 1 ? (
        <div
          style={{
            position: "absolute",
            left: trackX0,
            top: cy - h / 2,
            width: Math.max(0, trackW),
            height: h,
            borderRadius: h / 2,
            overflow: "hidden",
            display: "flex",
            background: trackColor,
            opacity: 1 - gone,
          }}
        >
          {showBuckets
            ? widths.map((w, i) => (
                <div
                  key={i}
                  style={{
                    width: w,
                    height: "100%",
                    flexShrink: 0,
                    opacity: 1 - thin,
                    background:
                      i < 3
                        ? BUCKET_COLORS[i]
                        : `repeating-linear-gradient(135deg, rgba(255,255,255,0.75) 0 6px, rgba(255,255,255,0.18) 6px 14px)`,
                    borderRight: i < 3 ? "2px solid rgba(0,0,0,0.35)" : undefined,
                  }}
                />
              ))
            : null}
        </div>
      ) : null}

      {/* bucket labels */}
      {showBuckets && labelFade > 0
        ? widths.map((w, i) => {
            const left = AGING_X + widths.slice(0, i).reduce((a, b) => a + b, 0);
            return (
              <div
                key={i}
                style={{
                  position: "absolute",
                  left: left + 4,
                  top: AGING_Y + AGING_H + 14,
                  fontFamily: mono,
                  fontSize: 19,
                  fontWeight: 500,
                  color: i === 3 ? C.white : C.g2,
                  opacity: Math.min(1, w / 90) * labelFade,
                  whiteSpace: "nowrap",
                }}
              >
                {BUCKETS[i]}
              </div>
            );
          })
        : null}

      {/* progress fill along the pipeline */}
      {fillOpacity > 0 ? (
        <div
          style={{
            position: "absolute",
            left: TRACK_X0 + pan,
            top: NODE_Y - 3,
            width: Math.max(0, fillEnd - TRACK_X0),
            height: 6,
            borderRadius: 3,
            background: `linear-gradient(90deg, ${C.orangeDeep}, ${C.orange})`,
            boxShadow: `0 0 18px rgba(244,117,33,0.8)`,
            opacity: fillOpacity,
          }}
        />
      ) : null}

      {/* stat fill -> accent rule */}
      {statFillOn ? (
        <div
          style={{
            position: "absolute",
            left: sx0,
            top: scy - sh / 2,
            width: Math.max(0, sx1 - sx0),
            height: sh,
            borderRadius: sh / 2,
            background: `linear-gradient(90deg, ${C.orangeDeep}, ${C.orange})`,
            boxShadow: `0 0 ${lerp(26, 14, toRule)}px rgba(244,117,33,${lerp(0.75, 0.5, toRule)})`,
          }}
        />
      ) : null}
    </>
  );
};

/* ------------------------------------------------------------------ */
/* Six points that become everything: ring dots -> pipeline stages     */
/* -> axis ticks.                                                      */
/* ------------------------------------------------------------------ */

export const Ring: React.FC = () => {
  const f = useCurrentFrame();
  if (f < 174 || f > 266) return null;
  const draw = p(f, 178, 218, EASE_IN_OUT);
  const fade = 1 - p(f, 248, 262, EASE_IN);
  const rot = ringRot(f);
  const size = RING_R * 2 + 120;
  return (
    <svg
      width={size}
      height={size}
      style={{
        position: "absolute",
        left: RING_C.x - size / 2,
        top: RING_C.y - size / 2,
        opacity: fade,
        transform: `rotate(${rot}deg)`,
      }}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={RING_R + 46}
        fill="none"
        stroke="rgba(255,255,255,0.08)"
        strokeWidth={1.5}
        strokeDasharray="4 10"
        opacity={draw}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={RING_R}
        fill="none"
        stroke={C.orange}
        strokeWidth={3}
        strokeLinecap="round"
        pathLength={1}
        strokeDasharray={1}
        strokeDashoffset={1 - draw}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ filter: "drop-shadow(0 0 10px rgba(244,117,33,0.6))" }}
      />
    </svg>
  );
};

export const Nodes: React.FC = () => {
  const f = useCurrentFrame();
  if (f < 180) return null;
  const pan = panX(f);
  const gone = p(f, PROOF_EXIT, PROOF_EXIT + 14, EASE_IN);
  if (gone >= 1) return null;

  return (
    <>
      {NODE_X.map((nx, k) => {
        const appear = p(f, 186 + k * 5, 200 + k * 5, EASE_POP);
        if (appear <= 0) return null;
        const a = ((ringRot(f) - 90 + 60 * k) * Math.PI) / 180;
        const ringPos = { x: RING_C.x + RING_R * Math.cos(a), y: RING_C.y + RING_R * Math.sin(a) };
        const fly = p(f, 250 + k * 2, 278 + k * 2, EASE_IN_OUT);
        const lit = p(f, ARRIVE[k], ARRIVE[k] + 10, EASE_OUT);
        const checkDraw = p(f, ARRIVE[k] + 2, ARRIVE[k] + 14, EASE_OUT);
        const ripple = p(f, ARRIVE[k], ARRIVE[k] + 22, EASE_OUT);
        const tick = p(f, 450 + k * 2, 476 + k * 2, EASE_IN_OUT);

        const nodePos = { x: nx + pan, y: NODE_Y };
        const tickPos = { x: axisX(90 + 2 * k), y: axisY(f) + 30 };
        const x = lerp(lerp(ringPos.x, nodePos.x, fly), tickPos.x, tick);
        const y = lerp(lerp(ringPos.y, nodePos.y, fly), tickPos.y, tick);

        const d = lerp(22, 34, fly);
        const w = lerp(d, 3, tick);
        const hgt = lerp(d, 18, tick);
        const radius = lerp(d / 2, 1.5, tick);

        // ring (orange) -> unlit stage -> lit stage -> tick (white)
        const unlit = fly * (1 - lit);
        const fill =
          tick > 0
            ? interpolateColors(tick, [0, 1], [C.orange, "rgba(255,255,255,0.5)"])
            : interpolateColors(unlit, [0, 1], [C.orange, C.navyMid]);
        const border = unlit > 0.01 ? `2px solid rgba(255,255,255,${0.4 * unlit})` : "none";

        return (
          <React.Fragment key={k}>
            {ripple > 0 && ripple < 1 && tick === 0 ? (
              <div
                style={{
                  position: "absolute",
                  left: x - d / 2,
                  top: y - d / 2,
                  width: d,
                  height: d,
                  borderRadius: "50%",
                  border: `2px solid ${C.orange}`,
                  transform: `scale(${1 + ripple * 1.9})`,
                  opacity: 1 - ripple,
                }}
              />
            ) : null}
            <div
              style={{
                position: "absolute",
                left: x - w / 2,
                top: y - hgt / 2,
                width: w,
                height: hgt,
                borderRadius: radius,
                background: fill,
                border,
                boxSizing: "border-box",
                transform: `scale(${appear * (1 + 0.25 * Math.sin(Math.PI * lit))})`,
                boxShadow:
                  tick < 1 && (lit > 0 || fly < 1)
                    ? `0 0 ${16 * (1 - tick)}px rgba(244,117,33,${0.7 * (1 - tick)})`
                    : undefined,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                opacity: 1 - gone,
              }}
            >
              {lit > 0 && tick < 0.5 ? (
                <div style={{ opacity: 1 - tick * 2 }}>
                  <CheckIcon size={22} color={C.navy} progress={checkDraw} stroke={3.4} />
                </div>
              ) : null}
            </div>
          </React.Fragment>
        );
      })}
    </>
  );
};

export const StageLabels: React.FC = () => {
  const f = useCurrentFrame();
  if (f < 270 || f > 466) return null;
  const pan = panX(f);
  const out = p(f, 446, 460, EASE_IN);
  return (
    <>
      {STAGES.map((s, k) => {
        const intro = p(f, 276 + k * 3, 292 + k * 3, EASE_OUT);
        const lit = p(f, ARRIVE[k], ARRIVE[k] + 10, EASE_OUT);
        return (
          <div
            key={k}
            style={{
              position: "absolute",
              left: NODE_X[k] + pan - 140,
              top: NODE_Y + 40 + (1 - intro) * 20 + (1 - lit) * 6 - out * 16,
              width: 280,
              textAlign: "center",
              fontFamily: inter,
              opacity: intro * (0.34 + 0.66 * lit) * (1 - out),
            }}
          >
            <div
              style={{
                fontFamily: mono,
                fontSize: 19,
                fontWeight: 600,
                letterSpacing: "0.1em",
                color: interpolateColors(lit, [0, 1], ["rgba(255,255,255,0.7)", C.orange]),
                marginBottom: 8,
              }}
            >
              0{k + 1}
            </div>
            <div
              style={{
                fontSize: 30,
                fontWeight: 600,
                lineHeight: 1.15,
                letterSpacing: "-0.01em",
                color: C.white,
                whiteSpace: "pre-line",
              }}
            >
              {s}
            </div>
          </div>
        );
      })}
    </>
  );
};
