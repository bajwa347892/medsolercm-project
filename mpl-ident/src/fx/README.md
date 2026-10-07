# FX & post (SPEC §6.5)

Everything here is a pure function of its props. Shots derive an `age` / `t` in seconds from the frame
(`(F - cueFrame) / FPS`, or action time from `actionTime()` when the effect should follow slow motion).
Nothing uses `useFrame` accumulation, `Math.random()` or wall-clock time. Verified: the same setup rendered
after different preceding shots, in a different tab, is byte-identical in raw pixels (grain is seeded by
the frame, so pass `frame` to `<Post/>` when comparing two different frame numbers).

Test: `T-FX` (240 frames: effect grid, macro bokeh, contact, slide + lens wipe + stump hit) and a shot-like
storyboard, one setup per frame: `--props='{"view":"shots"}'` (S01 aerial, S03 run-up dust, S04/S06
ball-follow trails, S07 dive spray + wipe, S08 clear, S09 splinters, S10 low orbit streaks, S12 vortex,
S02 macro bokeh, motes beside in-focus stumps). `{"view":"shots","only":12}` renders one setup.

## `<Post/>` (`src/post/Post.tsx`)

Render exactly one per shot, anywhere inside the shot's `Scene`:

```tsx
<Post focus={[0, 1.1, -9.2]} focusRange={0.4} aperture={0.012} flash={flashAt(F, CUES.events.bat_contact)}
      streaks={floodStreaks(st.floods)} />
```

| prop | default | notes |
|---|---|---|
| `focus` | `null` | world point in focus; `null` skips depth of field |
| `focusRange` | `0.25` | metres either side of the focus plane kept fully sharp |
| `aperture` | `0.01` | blur radius of the far background, fraction of frame height. 0.004 wide, 0.01 tele, 0.02 shallow, 0.04-0.05 macro. `apertureFor(fov, fStop, dist)` gives a physical value |
| `maxBlur` | `0.035` | largest blur radius, fraction of frame height (macro: 0.045) |
| `bokeh` | `2.5` | highlight emphasis inside out-of-focus areas (lamps become discs) |
| `bloom` | `1` | 0 disables the pass |
| `bloomThreshold` / `bloomKnee` | `1.4` / `0.8` | linear HDR; only lamps, LEDs and hot speculars bloom |
| `bloomRadius` | `0.78` | spread of the glow |
| `flash` | `0` | 0..1 impact exposure lift (x1.6 at 1, mean luma +30% on the contact frame). Use `flashAt(F, cue, decayFrames)` |
| `grain` / `vignette` / `chroma` | `1` | film grain, optical vignette, edge-only chromatic aberration |
| `grade` | `1` | 0 = neutral ACES (identical to rendering without Post), 1 = house grade |
| `gradeParams` | | override `lift`, `gamma`, `gain`, `contrast`, `pivot`, `saturation`, `grass` (see `HOUSE_GRADE`) |
| `exposure` | `1` | multiplier before the tone curve |
| `streaks` / `streak` | `[]` / `1` | anamorphic streak sources and global gain |
| `frame` | Remotion frame | seeds the grain |
| `debug` | `null` | `"coc"`: red = near blur, blue = far blur, green = sharp; `"bloom"`: bloom only |

Helpers: `flashAt(frame, cueFrame, decayFrames = 3)` (1 on the cue frame, nothing before, exponential
tail) and `apertureFor(fovDeg, fStop, focusDist)`. From `src/post/pipeline.ts`: `HOUSE_GRADE`,
`GradeParams`, `PostPipeline`, `getPostPipeline(gl)`.

Pipeline per frame: scene into a 4x MSAA packed-float (R11F_G11F_B10F) target with depth; thin-lens DOF
(CoC from the depth buffer, tile max + dilate, 16-80 tap scatter-as-gather bokeh at half res capped at 540
lines, the full 80 taps only for the biggest discs, per-pixel kernel rotation, highlight-compressed
averaging, fill, bilateral full-res composite that keeps the subject's silhouette clean); soft-knee bright
pass + 6-level mip bloom; streak visibility (depth-tested at each source); then one finish pass: edge CA,
bloom, streaks, exposure/flash, vignette, three's exact ACES filmic curve, grade on sRGB display values,
grain (frame-seeded, resolution independent), dither.

House grade: cool-teal shadow lift (saturated hues such as grass, skin and the ball are protected), neutral
mids, slightly warm highlight gain, cubic S-curve contrast around a low pivot, and a natural-grass
correction (`grass`: green-dominant hues -10% saturation and a few degrees toward yellow, so floodlit turf
does not drift to emerald; teal, skin and the red ball are untouched because green is not their max channel).

Streaks are horizontal in frame, white at the lamp fading to teal: a hot core that is thickest at the lamp
and thins along its length, a soft halo near the source, a tail that dies before the frame edge. A lamp
that is out of focus streaks softly (the profile widens with the DOF blur at its distance).

Why not `@react-three/postprocessing`'s `<EffectComposer>`: it builds its composer in a `useEffect`, after
Remotion has already advanced the frame, so a tab's first frame (and every still) renders black. `Post`
builds a cached pipeline per renderer synchronously and draws from a priority-1 `useFrame`. It reuses
`postprocessing`'s `MipmapBlurPass` for the bloom.

Cost at 1080p (software WebGL, differential timing over 4 frames, concurrency 1, load average 3-4):
contact shot with player + DOF + bloom + streaks 2.3 s/frame total (Post ~0.4 s of it); full-frame macro
bokeh ~1.8 s/frame (Post ~1.2 s); the lens wipe ~2.9 s/frame (Post ~0.2 s). The HDR target format matters:
4x MSAA on RGBA16F cost ~2.9 s/frame on its own in SwiftShader, R11F_G11F_B10F ~0.55 s with no visible
banding (max 4 code values of difference, checked on the macro bokeh and the night aerial).

## Effects (`src/fx/`)

| component | key props | timing |
|---|---|---|
| `DustBurst` | `position`, `age`, `amount` (0.5 step, 1 plant, 2 slide), `direction` (push m/s), `light`, `color` (`DUST_COLORS`) | life ~1.6 s; grit lands by ~0.5 s |
| `Footfalls` | `frame`, `fps`, `steps: {frame, position, amount?, direction?}[]`, `grass` (clippings flicked per step, default 10; 0 on the pitch) | one DustBurst + a turf flick per step |
| `GrassSpray` | `origin` (Vec3 or `(t) => Vec3` for a moving slider), `direction`, `t`, `duration` (emission), `count` (180), `speed`, `spread`, `dust` (0.5), `light` | clippings live 1.4 s, settle on the turf; emission front-loaded |
| `GrassWipe` | `progress`: 0 clear, 1 frame fully covered (the cut), 2 cleared; `direction` (screen), `count` (100), `light`, `rate` (progress per frame, for the shutter smear) | S07 368-378: 0 -> 1, S08 378-384: 1 -> 2 |
| `SpeedTrail` | `path(t)`, `t`, `length` (s), `start`, `headGap`, `width` (m), `opacity`, `intensity`, `minPixels` (2.5), `maxPixels` (14), `nearFade` ([0.15, 0.9] m), `nearRatio` ([0.45, 0.85]), `depth` (true) | covers [t - length, t - headGap] |
| `ImpactFlash` | `position` (sweet spot), `age` (SCREEN seconds), `normal` (bat face), `tilt`, `size` (0.08), `intensity`, `duration`, `occlude` | core ~2 frames, ring ~4 frames |
| `Splinters` | `position`, `direction`, `age` (ACTION seconds), `count`, `speed`, `ground` | white paint chips and pale ash (never spark-coloured); settle within ~1 s action time |
| `TealMotes` | `t`, `center`, `radius`, `height`, `count`, `size`, `swirl` (rad/s), `converge` (0..1), `rise`, `glint`, `depth` (true) | continuous |
| `LightStreak` | `position`, `intensity`, `length` (frame heights) | registers a streak source with `<Post/>` |
| `floodStreaks(floods, gain?, length?)` | | streak sources for the 8 flood banks |

### Notes for shots

- **Ball-follow cameras (S04, S06):** `SpeedTrail` is safe with the camera right behind the ball: the part
  of the trail running toward the lens fades (`nearFade`, `nearRatio`) and its width is capped, so it stays
  a short tracer. Keep `length` around 0.08-0.12 s.
- **Graphic trails (S11 bat-swing streak, S12 rings):** set `width` for the look you want; far trails keep
  at least `minPixels` and dim instead of shimmering.
- **Transparent FX and depth of field:** trails and motes write their bright cores to the depth buffer
  (colour writes off, drawn last), so DOF treats them at their own distance. Dust is soft and stays
  depth-less on purpose. `GrassWipe` is pre-defocused and ignores Post's focus.
- **The S07 -> S08 wipe:** both shots render `<GrassWipe progress={...}/>` with the same `direction`, `count`
  and `seed`; at progress 1 the frame is fully covered and identical in both shots, so the cut is invisible.
  Pass `rate` = progress per frame of each shot (S07 0.1, S08 ~0.17) for the right shutter smear.

Conventions: `light` props take the flood level (`floodMaster(st.floods)`); particles glow when backlit by
the shot's rim light (they read `RIM_UNIFORMS` from `world/Lights`). FX shaders include three's tone
mapping and colour space chunks, so they also look right in a shot rendered without `<Post/>`.
