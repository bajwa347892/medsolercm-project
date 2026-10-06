import { Composition } from "remotion";
import { DURATION, FPS, H, W } from "./config";
import { MPL } from "./MPL";
import { TFX } from "./tests/TFX";
import { TField } from "./tests/TField";
import { THand } from "./tests/THand";
import { TPlayer } from "./tests/TPlayer";
import { TProps } from "./tests/TProps";
import { TStadium } from "./tests/TStadium";

export const RemotionRoot: React.FC = () => (
  <>
    <Composition id="MPL" component={MPL} durationInFrames={DURATION} fps={FPS} width={W} height={H} />
    <Composition id="MPL-4K" component={MPL} durationInFrames={DURATION} fps={FPS} width={3840} height={2160} />
    {/* Module test scenes: 240 frames each so modules can preview animation. */}
    <Composition id="T-Stadium" component={TStadium} durationInFrames={240} fps={FPS} width={W} height={H} />
    <Composition id="T-Field" component={TField} durationInFrames={240} fps={FPS} width={W} height={H} />
    <Composition id="T-Props" component={TProps} durationInFrames={240} fps={FPS} width={W} height={H} />
    <Composition id="T-Player" component={TPlayer} durationInFrames={240} fps={FPS} width={W} height={H} />
    <Composition id="T-Hand" component={THand} durationInFrames={240} fps={FPS} width={W} height={H} />
    <Composition id="T-FX" component={TFX} durationInFrames={240} fps={FPS} width={W} height={H} />
  </>
);
