import React from "react";
import { useCurrentFrame } from "remotion";
import { KineticText } from "./KineticText";
import { C, inter, mono } from "../theme";
import {
  COUNT_END,
  EASE_IN,
  EASE_IN_OUT,
  EASE_OUT,
  EASE_SOFT,
  NCR,
  PROOF_EXIT,
  TO_AXIS,
  axisX,
  axisY,
  p,
  statShift,
  statValue,
} from "../timeline";

/**
 * The band, the stat fill and the iDental marker live in Flow.tsx (they are
 * the same elements as the pipeline track). This layer holds the numbers and
 * labels that sit on top of them.
 */

const exitStyle = (f: number, delay = 0): React.CSSProperties => {
  const e = p(f, PROOF_EXIT + delay, PROOF_EXIT + delay + 12, EASE_IN);
  const fade = p(f, PROOF_EXIT + delay, PROOF_EXIT + delay + 12, EASE_IN_OUT);
  return {
    opacity: 1 - fade,
    transform: `translateY(${-24 * e}px)`,
    filter: e > 0 ? `blur(${6 * e}px)` : undefined,
  };
};

export const Proof: React.FC = () => {
  const f = useCurrentFrame();
  if (f < TO_AXIS[0] || f > PROOF_EXIT + 30) return null;

  const shift = statShift(f);
  const ay = axisY(f);
  const v = statValue(f);

  // The number resolves out of the travelling claim, counts, then lands.
  const numIn = p(f, 466, 480, EASE_OUT);
  const settle = p(f, COUNT_END - 8, COUNT_END + 6, EASE_OUT);
  const pop = Math.sin(Math.PI * settle) * 0.035;

  const bandLabel = p(f, 500, 516, EASE_OUT);
  const markerLabel = p(f, 506, 520, EASE_OUT);
  const bracket = p(f, 514, 532, EASE_IN_OUT);

  // Secondary stats arrive once 98.7% has had its beat.
  const divider = p(f, 544, 564, EASE_IN_OUT);
  const ccr = Math.round(98 * p(f, 544, 566, EASE_SOFT));
  const ar = Math.round(21 * p(f, 546, 568, EASE_SOFT));

  const gap = axisX(NCR) - axisX(95);

  return (
    <>
      {/* eyebrow */}
      <div style={{ position: "absolute", inset: 0, transform: `translateY(${shift}px)` }}>
        <KineticText
          text="Net collection rate"
          start={468}
          exit={PROOF_EXIT}
          x={960}
          y={148}
          size={40}
          weight={600}
          align="center"
          color="rgba(255,255,255,0.78)"
          tracking="-0.005em"
          stagger={3}
        />
      </div>

      {/* the big number */}
      <div
        style={{
          position: "absolute",
          left: 0,
          width: 1920,
          top: 205 + shift,
          textAlign: "center",
          fontFamily: inter,
          fontWeight: 800,
          fontSize: 210,
          lineHeight: 1,
          letterSpacing: "-0.045em",
          color: C.white,
          fontVariantNumeric: "tabular-nums",
          ...exitStyle(f),
        }}
      >
        <div
          style={{
            display: "inline-block",
            opacity: numIn,
            transform: `translateY(${(1 - numIn) * 30}px) scale(${(0.92 + 0.08 * numIn) * (1 + pop)})`,
            filter: numIn < 1 ? `blur(${(1 - numIn) * 10}px)` : undefined,
            textShadow: `0 0 ${60 * settle}px rgba(244,117,33,${0.25 * Math.sin(Math.PI * settle)})`,
          }}
        >
          {v.toFixed(1)}
          <span style={{ color: C.orange }}>%</span>
        </div>
      </div>

      {/* chart labels */}
      <div style={{ position: "absolute", inset: 0, ...exitStyle(f, 2) }}>
        <div
          style={{
            position: "absolute",
            left: axisX(93) - 300,
            width: 600,
            top: ay - 82 + (1 - bandLabel) * 12,
            textAlign: "center",
            fontFamily: inter,
            fontSize: 28,
            fontWeight: 500,
            color: "rgba(255,255,255,0.72)",
            opacity: bandLabel,
          }}
        >
          Industry average: 91% to 95%
        </div>

        {/* the gap, made visible */}
        {bracket > 0 ? (
          <svg
            width={gap + 4}
            height={24}
            style={{ position: "absolute", left: axisX(95) - 2, top: ay - 46 }}
          >
            <path
              d={`M2 20 L2 8 L${gap + 2} 8 L${gap + 2} 20`}
              fill="none"
              stroke={C.orange}
              strokeWidth={2.5}
              strokeLinejoin="round"
              strokeLinecap="round"
              pathLength={1}
              strokeDasharray={1}
              strokeDashoffset={1 - bracket}
            />
          </svg>
        ) : null}

        <div
          style={{
            position: "absolute",
            left: axisX(NCR) - 200,
            width: 400,
            top: ay - 82 + (1 - markerLabel) * 12,
            textAlign: "center",
            fontFamily: inter,
            fontSize: 28,
            fontWeight: 700,
            color: C.orange,
            opacity: markerLabel,
          }}
        >
          iDental Billing
        </div>

        {/* tick labels */}
        {[90, 92, 94, 96, 98, 100].map((t, i) => {
          const tl = p(f, 466 + i * 2, 482 + i * 2, EASE_OUT);
          return (
            <div
              key={t}
              style={{
                position: "absolute",
                left: axisX(t) - 60,
                width: 120,
                top: ay + 48 + (1 - tl) * 10,
                textAlign: "center",
                fontFamily: mono,
                fontSize: 21,
                fontWeight: 500,
                color: "rgba(255,255,255,0.55)",
                opacity: tl,
              }}
            >
              {t}%
            </div>
          );
        })}
      </div>

      {/* secondary stats */}
      <div style={{ position: "absolute", inset: 0, ...exitStyle(f, 0) }}>
        <div
          style={{
            position: "absolute",
            left: 959,
            top: 825,
            width: 2,
            height: 150 * divider,
            background: "rgba(255,255,255,0.18)",
          }}
        />
        {[
          { x: 640, value: `${ccr}`, unit: "%", label: "Clean claim rate", d: 0 },
          { x: 1280, value: `${ar}`, unit: " days", label: "Average in AR", d: 4 },
        ].map((s) => {
          const t = p(f, 542 + s.d, 562 + s.d, EASE_OUT);
          return (
            <div
              key={s.label}
              style={{
                position: "absolute",
                left: s.x - 320,
                width: 640,
                top: 815 + (1 - t) * 40,
                textAlign: "center",
                fontFamily: inter,
                opacity: t,
              }}
            >
              <div
                style={{
                  fontSize: 112,
                  fontWeight: 800,
                  letterSpacing: "-0.04em",
                  lineHeight: 1,
                  color: C.white,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {s.value}
                <span
                  style={{
                    color: C.orange,
                    fontSize: s.unit === "%" ? 112 : 56,
                    letterSpacing: "-0.02em",
                    fontWeight: s.unit === "%" ? 800 : 700,
                  }}
                >
                  {s.unit}
                </span>
              </div>
              <div
                style={{
                  marginTop: 18,
                  fontSize: 32,
                  fontWeight: 500,
                  color: "rgba(255,255,255,0.72)",
                }}
              >
                {s.label}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
};
