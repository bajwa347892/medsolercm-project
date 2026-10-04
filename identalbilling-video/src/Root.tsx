import { Composition } from "remotion";
import { IDentalBilling } from "./IDentalBilling";
import { DURATION, FPS, H, W } from "./timeline";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="IDentalBilling"
      component={IDentalBilling}
      durationInFrames={DURATION}
      fps={FPS}
      width={W}
      height={H}
    />
  );
};
