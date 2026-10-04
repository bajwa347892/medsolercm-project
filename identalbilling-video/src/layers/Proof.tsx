import React from "react";
import { useCurrentFrame } from "remotion";
import { KineticText } from "./KineticText";
import { C, inter, mono } from "../theme";
import {
  COUNT_END,
  EASE_IN,
  EASE_IN_OUT,
  EASE_OUT,
  EASE_POP,
  EASE_SOFT,
  PROOF_EXIT,
  axisX,
  NCR,
  axisY,
  p,
  statShift,
  statValue,
} from "../timeline";

const exitStyle = (f: number, delay = 0): React.CSSProperties => {
  const e = p(f, PROOF_EXIT + delay, PROOF_EXIT + delay + 12, EASE_IN);
  return {
    opacity: 1 - e,
    transform: `translateY(${-24 * e}px)`,
    filter: e > 0 ? `blur(${6 * e}px)` : undefined,
  };
};

export const Proof: React.FC = () => {
  const f = useCurrentFrame();
  if (f < 470 || f > PROOF_EXIT + 30) return null;

  const shift = statShift(f);
  const ay = axisY(f);
  const v = statValue(f);
  const settle = p(f, COUNT_END, COUNT_END + 14, EASE_OUT);
  const numIn = p(f, 482, 498, EASE_OUT);
  const pop = Math.sin(Math.PI * settle) * 0.035;

  const band = p(f, 494, 514, EASE_IN_OUT);
  const bandLabel = p(f, 500, 516, EASE_OUT);
  const marker = p(f, 486, 498, EASE_POP);
  const markerLabel = p(f, 526, 540, EASE_OUT);
  const bracket = p(f, 538, 558, EASE_IN_OUT);
  const ripple = p(f, COUNT_END, COUNT_END + 24, EASE_OUT);
  const tickLabels = p(f, 474, 492, EASE_OUT);

  // Secondary stats
  const secIn = p(f, 556, 578, EASE_OUT);
  const divider = p(f, 560, 580, EASE_IN_OUT);
  const ccr = Math.round(98 * p(f, 560, 586, EASE_SOFT));
  const ar = Math.round(21 * p(f, 562, 588, EASE_SOFT));

  return (
    <>
      {/* eyebrow */}
      <div style={{ position: "absolute", inset: 0, transform: `translateY(${shift}px)` }}>
        <KineticText
          text="Net collection rate"
          start={482}
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
            transform: `translateY(${(1 - numIn) * 40}px) scale(${1 + pop})`,
            filter: numIn < 1 ? `blur(${(1 - numIn) * 10}px)` : undefined,
            textShadow: `0 0 ${60 * settle}px rgba(244,117,33,${0.25 * Math.sin(Math.PI * settle)})`,
          }}
        >
          {v.toFixed(1)}
          <span style={{ color: C.orange }}>%</span>
        </div>
      </div>

      {/* industry average band */}
      <div style={{ position: "absolute", inset: 0, ...exitStyle(f, 2) }}>
        <div
          style={{
            position: "absolute",
            left: axisX(91),
            top: ay - 19,
            width: (axisX(95) - axisX(91)) * band,
            height: 38,
            borderRadius: 8,
            background: "rgba(255,255,255,0.13)",
            border: band > 0 ? "1.5px dashed rgba(255,255,255,0.45)" : "none",
            boxSizing: "border-box",
          }}
        />
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
            color: "rgba(255,255,255,0.7)",
            opacity: bandLabel,
          }}
        >
          Industry average: 91% to 95%
        </div>

        {/* the gap, made visible */}
        {bracket > 0 ? (
          <svg
            width={axisX(NCR) - axisX(95) + 4}
            height={40}
            style={{ position: "absolute", left: axisX(95) - 2, top: ay - 46 }}
          >
            <path
              d={`M2 30 L2 14 L${axisX(NCR) - axisX(95) + 2} 14 L${axisX(NCR) - axisX(95) + 2} 30`}
              fill="none"
              stroke={C.orange}
              strokeWidth={2.5}
              strokeLinejoin="round"
              pathLength={1}
              strokeDasharray={1}
              strokeDashoffset={1 - bracket}
            />
          </svg>
        ) : null}

        {/* iDental marker */}
        {f >= 486 ? (
          <>
            {ripple > 0 && ripple < 1 ? (
              <div
                style={{
                  position: "absolute",
                  left: axisX(v) - 20,
                  top: ay - 20,
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
                left: axisX(v) - 20,
                top: ay - 20,
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
          </>
        ) : null}

        {/* tick labels */}
        {[90, 92, 94, 96, 98, 100].map((t, i) => (
          <div
            key={t}
            style={{
              position: "absolute",
              left: axisX(t) - 60,
              width: 120,
              top: ay + 48 + (1 - tickLabels) * 10,
              textAlign: "center",
              fontFamily: mono,
              fontSize: 21,
              fontWeight: 500,
              color: "rgba(255,255,255,0.55)",
              opacity: p(f, 474 + i * 2, 490 + i * 2, EASE_OUT),
            }}
          >
            {t}%
          </div>
        ))}
      </div>

      {/* secondary stats */}
      <div style={{ position: "absolute", inset: 0, ...exitStyle(f, 0) }}>
        <div
          style={{
            position: "absolute",
            left: 959,
            top: 800,
            width: 2,
            height: 150 * divider,
            background: "rgba(255,255,255,0.18)",
          }}
        />
        {[
          { x: 640, value: `${ccr}`, unit: "%", label: "Clean claim rate", d: 0 },
          { x: 1280, value: `${ar}`, unit: " days", label: "Average in AR", d: 4 },
        ].map((s) => {
          const t = p(f, 556 + s.d, 578 + s.d, EASE_OUT);
          return (
            <div
              key={s.label}
              style={{
                position: "absolute",
                left: s.x - 320,
                width: 640,
                top: 790 + (1 - t) * 40,
                textAlign: "center",
                fontFamily: inter,
                opacity: t * secIn,
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

