import React from "react";
import { C, inter, mono } from "../theme";
import { CARD_H, CARD_W } from "../timeline";

export const CheckIcon: React.FC<{
  size: number;
  color: string;
  progress?: number;
  stroke?: number;
}> = ({ size, color, progress = 1, stroke = 3 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: "block" }}>
    <path
      d="M5 12.5l4.5 4.5L19 7.5"
      fill="none"
      stroke={color}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      pathLength={1}
      strokeDasharray={1}
      strokeDashoffset={1 - progress}
    />
  </svg>
);

const XIcon: React.FC<{ size: number; color: string }> = ({ size, color }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: "block" }}>
    <path
      d="M7 7l10 10M17 7L7 17"
      fill="none"
      stroke={color}
      strokeWidth={3}
      strokeLinecap="round"
    />
  </svg>
);

type Props = {
  variant: "denied" | "clean";
  id: string;
  code: string;
  /** 0..1, how far the DENIED stamp has landed. */
  stamp?: number;
  /** 0..1, check mark draw on the clean card. */
  check?: number;
};

const Skeleton: React.FC<{ w: string; color: string; h?: number }> = ({
  w,
  color,
  h = 12,
}) => <div style={{ width: w, height: h, borderRadius: h / 2, background: color }} />;

export const ClaimCard: React.FC<Props> = ({
  variant,
  id,
  code,
  stamp = 0,
  check = 1,
}) => {
  const clean = variant === "clean";
  const bg = clean ? C.white : C.cardDark;
  const line = clean ? "#E7EAF0" : C.cardDarkLine;
  const label = clean ? "#5B6575" : C.g2;

  return (
    <div
      style={{
        width: CARD_W,
        height: CARD_H,
        borderRadius: 22,
        background: bg,
        border: clean ? "none" : "1.5px solid rgba(255,255,255,0.07)",
        padding: "26px 28px",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        position: "relative",
        overflow: "hidden",
        fontFamily: inter,
      }}
    >
      {clean ? (
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: 8,
            background: C.orange,
          }}
        />
      ) : null}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div
          style={{
            fontFamily: mono,
            fontSize: 17,
            fontWeight: 500,
            letterSpacing: "0.06em",
            color: label,
          }}
        >
          CLAIM #{id}
        </div>
        <div
          style={{
            fontFamily: mono,
            fontSize: 16,
            fontWeight: 600,
            padding: "6px 12px",
            borderRadius: 8,
            color: clean ? C.orangeDeep : C.g1,
            background: clean ? "#FFF0E5" : "rgba(255,255,255,0.05)",
          }}
        >
          {code}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Skeleton w="72%" color={line} />
        <Skeleton w="48%" color={line} />
        <Skeleton w="60%" color={line} />
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Skeleton w="28%" color={line} h={10} />
        {clean ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: C.orange,
              color: C.navy,
              fontSize: 19,
              fontWeight: 700,
              padding: "8px 16px 8px 10px",
              borderRadius: 999,
            }}
          >
            <div
              style={{
                width: 24,
                height: 24,
                borderRadius: 12,
                background: C.navy,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <CheckIcon size={18} color={C.orange} progress={check} stroke={3.2} />
            </div>
            Clean claim
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: "rgba(255,255,255,0.06)",
              color: C.g1,
              fontSize: 19,
              fontWeight: 600,
              padding: "8px 16px 8px 10px",
              borderRadius: 999,
            }}
          >
            <XIcon size={20} color={C.g1} />
            Denied
          </div>
        )}
      </div>

      {!clean && stamp > 0 ? (
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "46%",
            transform: `translate(-50%, -50%) rotate(-12deg) scale(${1.9 - 0.9 * stamp})`,
            opacity: Math.min(1, stamp * 1.4) * 0.92,
            border: "5px solid rgba(255,255,255,0.88)",
            borderRadius: 10,
            padding: "4px 18px",
            fontSize: 46,
            fontWeight: 800,
            letterSpacing: "0.14em",
            color: "rgba(255,255,255,0.9)",
            background: "rgba(17,19,23,0.55)",
          }}
        >
          DENIED
        </div>
      ) : null}
    </div>
  );
};
