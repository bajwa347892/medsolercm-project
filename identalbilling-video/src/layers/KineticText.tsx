import React from "react";
import { useCurrentFrame } from "remotion";
import { C, inter } from "../theme";
import { EASE_IN, EASE_IN_OUT, EASE_OUT, p } from "../timeline";

type Props = {
  /** Use "\n" for line breaks and *asterisks* to mark accent words. */
  text: string;
  start: number;
  exit?: number;
  x: number;
  y: number;
  size: number;
  weight?: number;
  color?: string;
  accent?: string;
  align?: "left" | "center";
  stagger?: number;
  dur?: number;
  lineHeight?: number;
  tracking?: string;
};

export const EXIT_DUR = 10;

/**
 * Word-by-word masked reveal. Each word rises out of its own clip box,
 * so lines read as they build. The block exits as one unit.
 */
export const KineticText: React.FC<Props> = ({
  text,
  start,
  exit,
  x,
  y,
  size,
  weight = 700,
  color = C.white,
  accent = C.orange,
  align = "left",
  stagger = 2,
  dur = 14,
  lineHeight = 1.08,
  tracking = "-0.025em",
}) => {
  const frame = useCurrentFrame();
  if (frame < start - 1) return null;
  if (exit !== undefined && frame > exit + EXIT_DUR + 1) return null;

  // Motion accelerates away; opacity fades evenly so nothing pops off.
  const exitP = exit === undefined ? 0 : p(frame, exit, exit + EXIT_DUR, EASE_IN);
  const fadeP = exit === undefined ? 0 : p(frame, exit, exit + EXIT_DUR, EASE_IN_OUT);
  const pad = size * 0.16;

  let wordIndex = 0;
  let accentOn = false;

  return (
    <div
      style={{
        position: "absolute",
        left: align === "center" ? x - 960 : x,
        top: y,
        width: align === "center" ? 1920 : undefined,
        textAlign: align,
        fontFamily: inter,
        fontSize: size,
        fontWeight: weight,
        letterSpacing: tracking,
        lineHeight,
        color,
        opacity: 1 - fadeP,
        transform: `translateY(${-30 * exitP}px)`,
        filter: exitP > 0 ? `blur(${exitP * 8}px)` : undefined,
      }}
    >
      {text.split("\n").map((line, li) => {
        const words = line.split(" ");
        return (
          <div key={li} style={{ whiteSpace: "nowrap" }}>
            {words.map((raw, wi) => {
              let w = raw;
              let isAccent = accentOn;
              if (w.startsWith("*")) {
                w = w.slice(1);
                accentOn = true;
                isAccent = true;
              }
              if (w.endsWith("*")) {
                w = w.slice(0, -1);
                accentOn = false;
              }
              const i = wordIndex++;
              const t = p(frame, start + i * stagger, start + i * stagger + dur, EASE_OUT);
              return (
                <span
                  key={wi}
                  style={{
                    display: "inline-block",
                    overflow: "hidden",
                    verticalAlign: "top",
                    paddingTop: pad,
                    paddingBottom: pad,
                    marginTop: -pad,
                    marginBottom: -pad,
                    marginRight: wi < words.length - 1 ? "0.24em" : 0,
                  }}
                >
                  <span
                    style={{
                      display: "inline-block",
                      color: isAccent ? accent : undefined,
                      transform: `translateY(${(1 - t) * 115}%) rotate(${(1 - t) * 6}deg)`,
                      transformOrigin: "0% 100%",
                      opacity: Math.min(1, t * 1.6),
                    }}
                  >
                    {w}
                  </span>
                </span>
              );
            })}
          </div>
        );
      })}
    </div>
  );
};
