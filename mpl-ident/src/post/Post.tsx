/**
 * <Post/>: the film's post stack. Render exactly one inside each shot's Scene (anywhere in the tree).
 *
 *   <Post focus={[0, 1.2, -9]} focusRange={0.6} aperture={0.012} flash={flashAt(F)} streaks={floodStreaks(st.floods)} />
 *
 * Order (HDR, linear): scene (4x MSAA, packed float) -> depth of field -> bloom + anamorphic streaks + edge chromatic
 * aberration -> exposure / impact flash -> vignette -> ACES filmic (three's exact curve, so shots look the
 * same tonally with or without Post) -> colour grade -> film grain.
 *
 * Depth of field is a thin-lens model aimed at a WORLD point:
 *   blur radius(z) = aperture * frameHeight * max(|z - s| - focusRange, 0) / z     (s = focus plane distance)
 * so `aperture` is the blur radius of the far background as a fraction of the frame height:
 *   0.004 subtle (wide shots) · 0.01 broadcast tele · 0.02 shallow · 0.04+ macro (S02). Clamped at maxBlur.
 * apertureFor(fov, fStop, focusDist) gives the physical value for a full-frame camera.
 *
 * Determinism: params are applied during render and drawn in a priority-1 useFrame; grain is seeded by
 * the frame. Nothing accumulates across frames, so frames can render in any order.
 */
import React, { useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { useCurrentFrame } from "remotion";
import * as THREE from "three";
import { PAL } from "../theme";
import type { Vec3 } from "../rig/types";
import { STREAK_DEFAULT_LENGTH, registeredStreaks, type StreakSource } from "../fx/LightStreak";
import { HOUSE_GRADE, getPostPipeline, type GradeParams, type PostParams } from "./pipeline";

export type PostProps = {
  /** world point to focus on; null/undefined = no depth of field (cheaper) */
  focus?: Vec3 | null;
  /** metres in front of and behind the focus plane that stay fully sharp (default 0.25) */
  focusRange?: number;
  /** background blur radius as a fraction of frame height (default 0.01). See header. */
  aperture?: number;
  /** largest blur radius, fraction of frame height (default 0.035) */
  maxBlur?: number;
  /** bokeh highlight emphasis 0..4 (default 2.5): out-of-focus lamps become crisp discs */
  bokeh?: number;
  /** bloom strength (default 1; 0 disables the pass) */
  bloom?: number;
  /** linear HDR level where bloom starts (default 1.4): lamps, LEDs and hot speculars only */
  bloomThreshold?: number;
  /** soft knee width around the threshold (default 0.8) */
  bloomKnee?: number;
  /** 0..1 how wide the glow spreads (default 0.78) */
  bloomRadius?: number;
  /** 0..1 impact exposure lift (bat contact, stump hit, logo hit); animate over 1-4 frames */
  flash?: number;
  /** film grain amount (default 1) */
  grain?: number;
  /** vignette amount (default 1) */
  vignette?: number;
  /** edge chromatic aberration amount (default 1, very subtle) */
  chroma?: number;
  /** colour grade mix: 0 = neutral ACES, 1 = house grade (default 1) */
  grade?: number;
  /** override parts of the house grade (lift, gamma, gain, contrast, pivot, saturation, grass) */
  gradeParams?: Partial<GradeParams>;
  /** exposure multiplier (default 1) */
  exposure?: number;
  /** anamorphic streak sources (see fx/LightStreak: floodStreaks()); an out-of-focus lamp streaks softly */
  streaks?: StreakSource[];
  /** global streak gain (default 1) */
  streak?: number;
  /** frame used to seed the grain (default: the Remotion frame) */
  frame?: number;
  /** debug views: "coc" (red near blur, blue far blur, green sharp) or "bloom" */
  debug?: "coc" | "bloom" | null;
};

/**
 * Physical aperture: blur radius at infinity (fraction of frame height) for a full-frame camera
 * (24 mm sensor height) with the given vertical fov (deg), f-number and focus distance (m).
 */
export const apertureFor = (fovDeg: number, fStop: number, focusDist: number) => {
  const f = 0.012 / Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2); // focal length (m)
  const coc = (f * f) / (fStop * Math.max(focusDist - f, 1e-3)); // blur DIAMETER on the sensor (m)
  return coc / 2 / 0.024;
};

/** Impact flash envelope: 1 on the cue frame, nothing before it, exponential tail of ~`decay` frames. */
export const flashAt = (frame: number, at: number, decay = 3) => {
  const d = frame - at;
  if (d < 0 || d > decay * 4) return 0;
  return Math.exp(-d / Math.max(0.25, decay * 0.5));
};

const streakCore = new THREE.Color(PAL.floodWhite);
const streakTint = new THREE.Color(PAL.teal).lerp(new THREE.Color(PAL.tealHi), 0.35);

export const Post: React.FC<PostProps> = ({
  focus = null,
  focusRange = 0.25,
  aperture = 0.01,
  maxBlur = 0.035,
  bokeh = 2.5,
  bloom = 1,
  bloomThreshold = 1.4,
  bloomKnee = 0.8,
  bloomRadius = 0.78,
  flash = 0,
  grain = 1,
  vignette = 1,
  chroma = 1,
  grade = 1,
  gradeParams,
  exposure = 1,
  streaks,
  streak = 1,
  frame,
  debug = null,
}) => {
  const gl = useThree((s) => s.gl);
  const remotionFrame = useCurrentFrame();
  const pipe = useMemo(() => getPostPipeline(gl), [gl]);
  const focusV = useMemo(() => new THREE.Vector3(), []);

  // Resolve params during render (deterministic), draw in useFrame.
  const resolveStreaks = (list: StreakSource[]) =>
    list.map((s) => ({
      pos: new THREE.Vector3(...s.position),
      intensity: (s.intensity ?? 1) * streak,
      length: s.length ?? STREAK_DEFAULT_LENGTH,
    }));
  const own = resolveStreaks(streaks ?? []);
  const params: PostParams = {
    focus: focus ? focusV.set(focus[0], focus[1], focus[2]) : null,
    focusRange,
    aperture,
    maxBlur,
    bokeh,
    bloom,
    bloomThreshold,
    bloomKnee,
    bloomRadius,
    flash: Math.max(0, flash),
    grain,
    vignette,
    chroma,
    grade,
    gradeParams: { ...HOUSE_GRADE, ...gradeParams },
    exposure,
    streaks: own,
    streakCore,
    streakTint,
    frame: frame ?? remotionFrame,
    debug: debug === "coc" ? 1 : debug === "bloom" ? 2 : 0,
  };
  pipe.params = params;

  useFrame((state) => {
    // <LightStreak/> sources anywhere in the tree have all rendered by now
    params.streaks = [...own, ...resolveStreaks(registeredStreaks())];
    pipe.params = params;
    pipe.render(state.scene, state.camera);
  }, 1);
  return null;
};
