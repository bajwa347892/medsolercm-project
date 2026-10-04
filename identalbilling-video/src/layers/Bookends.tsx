import React from "react";
import { useCurrentFrame } from "remotion";
import { KineticText } from "./KineticText";
import { C, inter } from "../theme";
import { EASE_IN, EASE_IN_OUT, EASE_OUT, EASE_POP, p } from "../timeline";

/* ------------------------------------------------------------------ */
/* Scene 1: the front desk, stuck on hold                              */
/* ------------------------------------------------------------------ */

const PHONE =
  "M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1l-2.3 2.2z";

export const HoldPill: React.FC = () => {
  const f = useCurrentFrame();
  const START = 88;
  if (f < START || f > 166) return null;
  const inP = p(f, START, START + 14, EASE_OUT);
  const out = p(f, 152, 164, EASE_IN);
  const outFade = p(f, 152, 164, EASE_IN_OUT);
  return (
    <div
      style={{
        position: "absolute",
        left: 140,
        top: 610 + (1 - inP) * 20 - out * 20,
        height: 68,
        padding: "0 28px 0 22px",
        borderRadius: 34,
        display: "flex",
        alignItems: "center",
        gap: 16,
        background: "rgba(255,255,255,0.06)",
        border: "1.5px solid rgba(255,255,255,0.12)",
        fontFamily: inter,
        opacity: inP * (1 - outFade),
        filter: out > 0 ? `blur(${out * 6}px)` : undefined,
      }}
    >
      <svg width={26} height={26} viewBox="0 0 24 24">
        <path d={PHONE} fill={C.g1} />
      </svg>
      <div style={{ fontSize: 26, fontWeight: 600, color: "rgba(255,255,255,0.85)" }}>
        On hold with the payer
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 4, height: 26 }}>
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            style={{
              width: 4,
              borderRadius: 2,
              background: C.g1,
              height: 8 + 16 * Math.abs(Math.sin(f / 5 + i * 1.3)),
            }}
          />
        ))}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Scene 2: brand eyebrow                                              */
/* ------------------------------------------------------------------ */

export const BrandEyebrow: React.FC = () => {
  const f = useCurrentFrame();
  if (f < 156 || f > 266) return null;
  const bar = p(f, 164, 178, EASE_OUT);
  const out = p(f, 244, 254, EASE_IN_OUT);
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: 140,
          top: 296,
          width: 8,
          height: 50,
          borderRadius: 4,
          background: C.orange,
          transform: `scaleY(${bar * (1 - out)})`,
          transformOrigin: "50% 100%",
          boxShadow: "0 0 18px rgba(244,117,33,0.7)",
        }}
      />
      <KineticText
        text="iDental Billing"
        start={166}
        exit={244}
        x={168}
        y={296}
        size={44}
        weight={700}
        color={C.orange}
        stagger={3}
        tracking="-0.015em"
      />
    </>
  );
};

/* ------------------------------------------------------------------ */
/* Scene 5: the payoff                                                 */
/* ------------------------------------------------------------------ */

const ARROW = "M5 12h13M13 6l6 6-6 6";

export const Closing: React.FC = () => {
  const f = useCurrentFrame();
  if (f < 630) return null;
  const cta = p(f, 674, 692, EASE_POP);
  const ctaFade = p(f, 672, 686, EASE_OUT);
  const shine = p(f, 712, 736, EASE_IN_OUT);
  const nudge = Math.sin(Math.max(0, f - 700) / 6) * 4 * p(f, 700, 712);
  const glow = p(f, 680, 720, EASE_OUT);
  const footer = p(f, 688, 704, EASE_OUT);

  return (
    <>
      {/* soft glow that gathers behind the call to action */}
      <div
        style={{
          position: "absolute",
          left: 960 - 520,
          top: 748 - 260,
          width: 1040,
          height: 520,
          borderRadius: "50%",
          background: `radial-gradient(ellipse, rgba(244,117,33,${0.2 * glow}) 0%, rgba(244,117,33,0) 65%)`,
        }}
      />

      <KineticText
        text={"Good dentistry deserves\n*better billing.*"}
        start={634}
        x={960}
        y={268}
        size={110}
        weight={800}
        align="center"
        stagger={3}
        dur={16}
        lineHeight={1.06}
        tracking="-0.035em"
      />

      <KineticText
        text="iDental Billing"
        start={664}
        x={960}
        y={600}
        size={58}
        weight={700}
        align="center"
        stagger={4}
        tracking="-0.02em"
      />

      {/* call to action */}
      <div
        style={{
          position: "absolute",
          left: 0,
          width: 1920,
          top: 702,
          display: "flex",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            position: "relative",
            overflow: "hidden",
            display: "flex",
            alignItems: "center",
            gap: 18,
            height: 96,
            padding: "0 46px 0 52px",
            borderRadius: 48,
            background: C.orange,
            color: C.navy,
            fontFamily: inter,
            fontSize: 36,
            fontWeight: 700,
            letterSpacing: "-0.01em",
            opacity: ctaFade,
            transform: `scale(${0.86 + 0.14 * cta})`,
            boxShadow: `0 18px 50px rgba(244,117,33,${0.35 * glow}), 0 0 ${28 * (1 - glow)}px rgba(244,117,33,${0.45 * (1 - glow) * ctaFade})`,
          }}
        >
          {shine > 0 && shine < 1 ? (
            <div
              style={{
                position: "absolute",
                top: -20,
                bottom: -20,
                width: 120,
                left: -160 + shine * 820,
                transform: "skewX(-20deg)",
                background:
                  "linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.55) 50%, rgba(255,255,255,0) 100%)",
              }}
            />
          ) : null}
          <span style={{ position: "relative", zIndex: 1, display: "flex", alignItems: "center", gap: 18 }}>
            Get your free billing review
            <svg
              width={34}
              height={34}
              viewBox="0 0 24 24"
              style={{ transform: `translateX(${nudge}px)` }}
            >
              <path
                d={ARROW}
                fill="none"
                stroke={C.navy}
                strokeWidth={2.6}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          left: 0,
          width: 1920,
          top: 836 + (1 - footer) * 14,
          textAlign: "center",
          fontFamily: inter,
          fontSize: 28,
          fontWeight: 500,
          color: "rgba(255,255,255,0.68)",
          opacity: footer,
        }}
      >
        No setup fees. No long-term contracts.
      </div>
    </>
  );
};

