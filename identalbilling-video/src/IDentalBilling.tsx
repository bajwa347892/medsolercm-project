import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { Background, Finish } from "./layers/Background";
import { BrandEyebrow, Closing, HoldPill } from "./layers/Bookends";
import { Claims } from "./layers/Claims";
import { AgingToAxis, Nodes, Ring, StageLabels } from "./layers/Flow";
import { KineticText } from "./layers/KineticText";
import { Proof } from "./layers/Proof";
import { inter } from "./theme";
import { DURATION, EASE_IN_OUT } from "./timeline";

/**
 * One continuous take. Elements carry across scenes instead of cutting:
 * denied card -> clean card -> travelling claim,
 * aging bar -> pipeline track -> chart axis -> closing rule,
 * ring dots -> pipeline stages -> axis ticks.
 */
export const IDentalBilling: React.FC = () => {
  const f = useCurrentFrame();

  // Slow camera push with a breath at each scene change.
  const scale = interpolate(
    f,
    [0, 150, 270, 480, 630, DURATION],
    [1.0, 1.025, 1.01, 1.03, 1.0, 1.03],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE_IN_OUT },
  );

  return (
    <AbsoluteFill style={{ fontFamily: inter, overflow: "hidden" }}>
      <Background />
      <AbsoluteFill style={{ transform: `scale(${scale})`, transformOrigin: "50% 50%" }}>
        {/* 1. The problem */}
        <KineticText text={"Denied claims\npile up."} start={2} exit={70} x={140} y={360} size={88} weight={800} />
        <KineticText
          text={"AR ages while your\nteam sits on hold."}
          start={76}
          exit={152}
          x={140}
          y={360}
          size={88}
          weight={800}
        />
        <HoldPill />

        {/* 2. The turn */}
        <BrandEyebrow />
        <KineticText
          text={"One team runs the\nfull revenue cycle."}
          start={168}
          exit={252}
          x={140}
          y={372}
          size={88}
          weight={800}
        />
        <KineticText
          text="Nothing gets lost between handoffs."
          start={184}
          exit={254}
          x={140}
          y={600}
          size={38}
          weight={500}
          color="rgba(255,255,255,0.72)"
          tracking="-0.01em"
        />
        <Ring />

        {/* 3. The process */}
        <KineticText text="Every claim, start to finish." start={282} exit={392} x={960} y={226} size={84} weight={800} align="center" />
        <KineticText
          text="Here's what that looks like in numbers."
          start={400}
          exit={474}
          x={960}
          y={232}
          size={72}
          weight={800}
          align="center"
        />

        {/* Persistent, morphing elements */}
        <AgingToAxis />
        <StageLabels />
        <Nodes />
        <Claims />

        {/* 4. The proof */}
        <Proof />

        {/* 5. The payoff */}
        <Closing />
      </AbsoluteFill>
      <Finish />
    </AbsoluteFill>
  );
};
