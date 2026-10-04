import React from "react";
import { Easing, interpolateColors, useCurrentFrame } from "remotion";
import { CheckIcon } from "./ClaimCard";
import { C, inter, mono } from "../theme";
import {
  ARRIVE,
  AXIS_X0,
  AXIS_X1,
  BAR_RISE,
  BAR_THIN,
  COUNT_END,
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
  TO_AXIS,
  TO_RULE,
  TRACK_X0,
  TRACK_X1,
  UNROLL,
  axisX,
  axisY,
  cardRide,
  lerp,
  p,
  panX,
  ringRot,
  statValue,
} from "../timeline";

const EASE_SINE = Easing.inOut(Easing.sin);

/** Fade that leaves at an even rate (no single-frame pop at the end). */
const proofFade = (f: number, delay = 0) =>
  1 - p(f, PROOF_EXIT + delay, PROOF_EXIT + delay + 14, EASE_IN_OUT);

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
  // Starts and ends at rest: the report creeps, builds, then stalls at the turn.
  const grow = p(f, 26, 150, Easing.bezier(0.33, 0, 0.25, 1));
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
  const thin = p(f, BAR_THIN[0], BAR_THIN[1], EASE_IN_OUT); // bar thins to a line
  const travel = p(f, BAR_RISE[0], BAR_RISE[1], EASE_SINE); // line rises into the track as the ring lands
  const toAxis = p(f, TO_AXIS[0], TO_AXIS[1], EASE_IN_OUT); // track becomes the chart axis
  const gone = p(f, PROOF_EXIT, PROOF_EXIT + 14, EASE_IN_OUT);

  const pan = panX(f);
  const trackX0 = lerp(lerp(AGING_X, TRACK_X0 + pan, travel), AXIS_X0, toAxis);
  const trackX1Full = lerp(TRACK_X1 + pan, AXIS_X1, toAxis);
  const trackW = lerp(agingTotal, trackX1Full - trackX0, travel);
  const h = lerp(lerp(AGING_H, 6, thin), 14, toAxis);
  const ay = axisY(f);
  const cy = lerp(lerp(AGING_Y + AGING_H / 2, NODE_Y, travel), ay, toAxis);

  const labelFade = 1 - p(f, 244, 254, EASE_IN_OUT);
  const showBuckets = thin < 1;

  // Orange progress fill: bound to the track, follows the claim, then
  // retracts to the axis origin where the count-up takes over.
  const ride = cardRide(f);
  const progressW = f < ARRIVE[0] ? 0 : ride.x - TRACK_X0;
  const fillW = lerp(progressW * lerp(1, trackW / (TRACK_X1 - TRACK_X0), toAxis), 0, toAxis);
  const showProgress = f >= ARRIVE[0] && f < TO_AXIS[1];

  // Industry band: a neutral benchmark zone the orange bar runs over.
  const band = p(f, 496, 514, EASE_IN_OUT);

  // Stat fill: 90 -> 98.7 on the axis, then becomes the accent rule.
  const v = statValue(f);
  const toRule = p(f, TO_RULE[0], TO_RULE[1], EASE_IN_OUT);
  const sx0 = lerp(AXIS_X0, RULE.cx - RULE.w / 2, toRule);
  const sx1 = lerp(axisX(v), RULE.cx + RULE.w / 2, toRule);
  const sh = lerp(14, RULE.h, toRule);
  const scy = lerp(ay, RULE.y + RULE.h / 2, toRule);
  const showStat = f >= TO_AXIS[1];

  // Marker rides the end of the bar, and shrinks away as the bar becomes the rule.
  const marker = p(f, TO_AXIS[1], TO_AXIS[1] + 12, EASE_POP) * (1 - p(f, TO_RULE[0], TO_RULE[0] + 12, EASE_IN_OUT));
  const ripple = p(f, COUNT_END - 8, COUNT_END + 16, EASE_OUT);

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

      {/* bucket labels: each appears only once its segment can hold it */}
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
                  opacity: Math.max(0, Math.min(1, (w - 66) / 20)) * labelFade,
                  whiteSpace: "nowrap",
                }}
              >
                {BUCKETS[i]}
              </div>
            );
          })
        : null}

      {/* progress fill along the pipeline */}
      {showProgress && fillW > 0.5 ? (
        <div
          style={{
            position: "absolute",
            left: trackX0,
            top: cy - h / 2,
            width: fillW,
            height: h,
            borderRadius: h / 2,
            background: `linear-gradient(90deg, ${C.orangeDeep}, ${C.orange})`,
            boxShadow: `0 0 18px rgba(244,117,33,0.8)`,
          }}
        />
      ) : null}

      {/* industry average band, under the stat fill */}
      {band > 0 ? (
        <div
          style={{
            position: "absolute",
            left: axisX(91),
            top: ay - 19,
            width: (axisX(95) - axisX(91)) * band,
            height: 38,
            borderRadius: 8,
            background: "rgba(255,255,255,0.10)",
            border: "1.5px dashed rgba(255,255,255,0.32)",
            boxSizing: "border-box",
            opacity: proofFade(f, 2),
          }}
        />
      ) : null}

      {/* stat fill -> accent rule */}
      {showStat && sx1 - sx0 > 0.5 ? (
        <div
          style={{
            position: "absolute",
            left: sx0,
            top: scy - sh / 2,
            width: sx1 - sx0,
            height: sh,
            borderRadius: sh / 2,
            background: `linear-gradient(90deg, ${C.orangeDeep}, ${C.orange})`,
            boxShadow: `0 0 ${lerp(26, 14, toRule)}px rgba(244,117,33,${lerp(0.75, 0.5, toRule)})`,
          }}
        />
      ) : null}

      {/* iDental marker */}
      {showStat && marker > 0 ? (
        <>
          {ripple > 0 && ripple < 1 ? (
            <div
              style={{
                position: "absolute",
                left: sx1 - 20,
                top: scy - 20,
                width: 40,
                height: 40,
                borderRadius: 20,
                border: `3px solid ${C.orange}`,
                transform: `scale(${1 + ripple * 2.2})`,
                opacity: 1 - ripple,
              }}
            />
          ) : null}
          <div
            style={{
              position: "absolute",
              left: sx1 - 20,
              top: scy - 20,
              width: 40,
              height: 40,
              borderRadius: 20,
              background: C.orange,
              border: `5px solid ${C.white}`,
              boxSizing: "border-box",
              transform: `scale(${marker})`,
              boxShadow: "0 0 24px rgba(244,117,33,0.8)",
            }}
          />
        </>
      ) : null}
    </>
  );
};

/* ------------------------------------------------------------------ */
/* The ring of six stages. It unrolls into the pipeline: the 300° arc  */
/* through the six dots straightens onto the track.                    */
/* ------------------------------------------------------------------ */

const ARC = 300; // degrees from stage 1 to stage 6
const SAMPLES = 120;

/**
 * Point at fraction s along the six-stage arc, u = how far it has unrolled.
 * The arc runs counter-clockwise from upper left, down and round to upper
 * right, so it opens into the left-to-right track as a widening U.
 */
const arcPoint = (f: number, s: number, u: number) => {
  const theta = ((ringRot(f) - 120 - ARC * s) * Math.PI) / 180;
  const ax = RING_C.x + RING_R * Math.cos(theta);
  const ay = RING_C.y + RING_R * Math.sin(theta);
  const lx = TRACK_X0 + panX(f) + (TRACK_X1 - TRACK_X0) * s;
  return { x: lerp(ax, lx, u), y: lerp(ay, NODE_Y, u) };
};

const unrollAt = (f: number) => p(f, UNROLL[0], UNROLL[1], EASE_SINE);

export const Ring: React.FC = () => {
  const f = useCurrentFrame();
  if (f < 174 || f > UNROLL[1] + 12) return null;
  const draw = p(f, 178, 218, EASE_IN_OUT); // 0..1 around the full circle
  const u = unrollAt(f);
  const cut = 1 - p(f, UNROLL[0] - 4, UNROLL[0] + 6, EASE_IN_OUT); // the gap between stage 6 and stage 1
  const handoff = p(f, UNROLL[1] - 8, UNROLL[1] + 8, EASE_IN_OUT); // orange line hands over to the track
  const halo = 1 - p(f, UNROLL[0] - 6, UNROLL[0] + 6, EASE_IN_OUT);

  const mainDraw = Math.min(1, (draw * 360) / ARC);
  const cutDraw = Math.max(0, (draw * 360 - ARC) / (360 - ARC)) * cut;

  const main = new Array(SAMPLES + 1).fill(0).map((_, i) => arcPoint(f, i / SAMPLES, u));
  const cutPts = new Array(25).fill(0).map((_, i) => {
    const theta = ((ringRot(f) - 120 - ARC - (360 - ARC) * (i / 24)) * Math.PI) / 180;
    return { x: RING_C.x + RING_R * Math.cos(theta), y: RING_C.y + RING_R * Math.sin(theta) };
  });
  const toPath = (pts: { x: number; y: number }[]) =>
    pts.map((pt, i) => `${i === 0 ? "M" : "L"}${pt.x.toFixed(2)} ${pt.y.toFixed(2)}`).join(" ");

  const stroke = interpolateColors(handoff, [0, 1], [C.orange, "rgba(255,255,255,0.2)"]);

  return (
    <svg
      width={1920}
      height={1080}
      style={{ position: "absolute", left: 0, top: 0, overflow: "visible", opacity: 1 - handoff }}
    >
      <circle
        cx={RING_C.x}
        cy={RING_C.y}
        r={RING_R + 46}
        fill="none"
        stroke="rgba(255,255,255,0.08)"
        strokeWidth={1.5}
        strokeDasharray="4 10"
        opacity={draw * halo}
      />
      <path
        d={toPath(main)}
        fill="none"
        stroke={stroke}
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={1}
        strokeDasharray={1}
        strokeDashoffset={1 - mainDraw}
        style={{ filter: "drop-shadow(0 0 10px rgba(244,117,33,0.6))" }}
      />
      {cutDraw > 0 ? (
        <path
          d={toPath(cutPts)}
          fill="none"
          stroke={C.orange}
          strokeWidth={3}
          strokeLinecap="round"
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={1 - cutDraw}
          style={{ filter: "drop-shadow(0 0 10px rgba(244,117,33,0.6))" }}
        />
      ) : null}
    </svg>
  );
};

/* ------------------------------------------------------------------ */
/* Six points that become everything: ring dots -> pipeline stages     */
/* -> axis ticks.                                                      */
/* ------------------------------------------------------------------ */

export const Nodes: React.FC = () => {
  const f = useCurrentFrame();
  if (f < 180) return null;
  const gone = p(f, PROOF_EXIT, PROOF_EXIT + 14, EASE_IN_OUT);
  if (gone >= 1) return null;

  const u = unrollAt(f);
  const ta = p(f, TO_AXIS[0], TO_AXIS[1], EASE_IN_OUT);
  const ay = axisY(f);

  return (
    <>
      {NODE_X.map((_, k) => {
        const appear = p(f, 186 + k * 5, 200 + k * 5, EASE_POP);
        if (appear <= 0) return null;
        const lit = p(f, ARRIVE[k], ARRIVE[k] + 10, EASE_OUT);
        const checkDraw = p(f, ARRIVE[k] + 2, ARRIVE[k] + 14, EASE_OUT);
        const ripple = p(f, ARRIVE[k], ARRIVE[k] + 22, EASE_OUT);
        // Shape change is staggered; position is not, so the row stays on the line.
        const tick = p(f, TO_AXIS[0] + k, TO_AXIS[1] - 4 + k, EASE_IN_OUT);

        const onLine = arcPoint(f, k / 5, u);
        const x = lerp(onLine.x, axisX(90 + 2 * k), ta);
        const y = lerp(onLine.y, ay, ta) + 30 * tick;

        const d = lerp(22, 34, u);
        const w = lerp(d, 3, tick);
        const hgt = lerp(d, 18, tick);
        const radius = lerp(d / 2, 1.5, tick);

        // ring (orange) -> unlit stage -> lit stage -> tick (white)
        const unlit = p(u, 0.6, 1) * (1 - lit);
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
                  tick < 1 && (lit > 0 || u < 1)
                    ? `0 0 ${16 * (1 - tick)}px rgba(244,117,33,${0.7 * (1 - tick) * Math.max(lit, 1 - u)})`
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
  if (f < 262 || f > TO_AXIS[0] + 16) return null;
  const pan = panX(f);
  const out = p(f, TO_AXIS[0] - 4, TO_AXIS[0] + 10, EASE_IN);
  const outFade = p(f, TO_AXIS[0] - 4, TO_AXIS[0] + 10, EASE_IN_OUT);
  return (
    <>
      {STAGES.map((s, k) => {
        const intro = p(f, 268 + k * 3, 284 + k * 3, EASE_OUT);
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
              opacity: intro * (0.34 + 0.66 * lit) * (1 - outFade),
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
