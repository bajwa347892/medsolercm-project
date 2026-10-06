# MPL opening ident: build spec

A 27-second, 16:9, 30fps opening ident for the **Madsol Premier League (MPL)**, a professional
T20-style cricket tournament. Built in Remotion with React Three Fiber (Three.js) and rendered
frame by frame on the CPU (software WebGL). Final output 3840×2160; we iterate at 1920×1080 or below.

This file is the contract between everyone building parts of the film. Read all of it before writing code.

---

## 1. Creative target

The opening ident of a major international cricket league, in the style of a premium broadcast. It is one
continuous, tightly connected sequence in which every action leads into the next, and everything converges into the MPL logo.

Story: dark stadium awakens → bowler grips ball (macro) → run-up → delivery → batsman strikes (visible contact) →
ball flight → diving catch → throw → run-out, bails explode → celebration → rapid montage → elements wrap into a
vortex → MPL logo forms → the logo's batsman hits a ball through the P into the L's wickets → hero reveal
"MADSOL PREMIER LEAGUE".

**Look.** A night stadium under powerful floodlights with haze and volumetric beams. Dramatic rim light on the athletes. The grass is naturally green.
The palette is deep metallic teal (the identity colour, used as an *accent* only), dark graphite, black, clean white, subtle silver,
and controlled warm stadium highlights. Restraint is the brand: **cricket first, motion graphics second.**

**Production reality.** Players are procedural, articulated 3D figures, not scanned humans. They must read as
premium, athletic and correct in their cricket movement. Lighting does the heavy lifting: strong rim light, a dark key,
graphite and teal kit, depth of field and bloom. Silhouettes and motion must be convincing. Avoid anything toy-like:
no primary colours, no flat unlit plastic, no stubby proportions, no bobbing heads.

### Hard "never" list (from the client)
No baseball equipment, actions or gloves. No incorrect wickets (always 3 stumps + 2 bails). No ball passing
through the bat. No floating balls. No extra limbs or fingers, and no merging bat with hands. No uniform changes between shots.
No architecture changes between shots. No cartoon look, neon overload, fire, lightning, fantasy portals, sci-fi or random text.
No sponsors or other logos. The only branding is "MPL" / "MADSOL PREMIER LEAGUE".

---

## 2. Palette (use these exact values)

| Token | Hex | Use |
|---|---|---|
| tealDeep | `#0B5E66` | kit panels, metal base |
| teal | `#0FA3A8` | accents, LEDs, trails, rim tint |
| tealHi | `#5FE3E6` | hottest highlights only, sparingly |
| graphite | `#1D2226` | kit, structures |
| graphiteDark | `#121518` | stands, shadows |
| black | `#050607` | |
| white | `#F4F7F8` | kit accents, creases, text |
| silver | `#B9C3C8` | metal, rope |
| floodWhite | `#F2F5FF` | floodlight colour (slightly cool) |
| warm | `#FFD8A6` | warm highlights, ~10% of light mix |
| grassA / grassB | `#2D6A2B` / `#26592A` | mowing stripes (lit by floodlights they read brighter) |
| pitch | `#B9A57A` | worn pitch strip |
| leather | `#7E1416` | ball base (deep cricket red), highlights `#B3262A` |
| willow | `#E3C996` | bat blade |

Export them from `src/theme.ts` (already present; extend it, don't fork it).

---

## 3. Coordinates, scale, timing

- Units are **metres**, Y up, field centre at the origin. See `src/world/dims.ts` for every dimension.
- The pitch runs along Z. The **bowler's stumps are at z=+10.06** and the **striker's stumps at z=-10.06**.
  The bowler runs in along -Z. The batsman (right-handed) stands at the -Z end facing +Z, off side toward -X.
- `src/config.ts`: FPS=30, DURATION=810. Use `rng(seed)` / `hash01()` for randomness, `prog()` for eased
  progress, and `actionTime(frame, [[frame, speed], ...])` to remap time for slow motion (drive physics and
  actions with action time).
- `src/cues.json`: **every sync event's global frame** (flood lights on, footsteps, release, bat contact, catch,
  throw, stump hit, logo locks...). The sound is generated from this file, so actions MUST land on those
  frames exactly.

### Determinism (hard rule)
Every pixel must be a pure function of the frame number. Never use `Math.random()`, `Date`, `performance.now()`,
`useFrame` accumulation, physics engines with internal state or CSS animations. Remotion renders frames out of
order and in parallel tabs. Build geometry once in `useMemo` and animate with the frame value.

---

## 4. Architecture

- `src/MPL.tsx` renders ONE `<ThreeCanvas>` for the film. `src/shots/registry.ts` lists the shots; exactly one is live
  per frame. A shot's `Scene` gets `{ f, F }` (local and global frame) and renders its own environment pieces,
  actors, camera (`<CameraRig/>` from `src/CameraRig.tsx`) and post stack (`<Post/>`). An optional `Overlay`
  draws 2D on top.
- Renderer: ACES filmic tone mapping, sRGB output, antialias on. Physically based materials (`MeshStandardMaterial` /
  `MeshPhysicalMaterial`) or custom `ShaderMaterial` where needed.
- Shadows are allowed but expensive: at most one shadow-casting light, map ≤ 2048, and only when the
  shot needs contact shadows (players on grass).

### Module ownership (edit only your own files)
| Module | Files | Test composition |
|---|---|---|
| Stadium & atmosphere | `src/world/Stadium.tsx`, `src/world/Atmosphere.tsx`, `src/world/Lights.tsx` | `src/tests/TStadium.tsx` → `T-Stadium` |
| Field & props | `src/world/Field.tsx`, `src/world/Props.tsx`, `src/world/wicketPhysics.ts` | `src/tests/TField.tsx`, `src/tests/TProps.tsx` |
| Character rig & actions | `src/rig/*` except `MacroHand.tsx` and `types.ts` (read-only) | `src/tests/TPlayer.tsx` |
| Macro hand | `src/rig/MacroHand.tsx` | `src/tests/THand.tsx` |
| FX & post | `src/fx/*`, `src/post/*` | `src/tests/TFX.tsx` |
| Audio | `audio/*`, writes `public/audio/*` | n/a |

Don't edit `Root.tsx`, `MPL.tsx`, `config.ts`, `cues.json`, `dims.ts`, `rig/types.ts`, `CameraRig.tsx`, `shots/*`
or `theme.ts` colour values (you may append new tokens to theme.ts only if no other module will). If you
need a change there, say so in your final report.

---

## 5. Night lighting recipe (everyone uses it so shots match)

`src/world/Lights.tsx` (owned by the stadium module) exports `<StadiumLights intensity={0..1} rim="..." />`:
- **Key:** 2 directional lights from opposite floodlight banks high up (elevation ~35°), floodWhite, giving crossed
  shadows like real stadiums. Only one casts shadows.
- **Rim:** a strong directional from behind the subject relative to camera (shots pass `rimDir`), floodWhite with
  ~15% teal tint, which makes the bright edge on shoulders, helmets and bats.
- **Fill:** a hemisphere light, sky `#1b2a33`, ground `#20381f`, low intensity, so shadows never crush to black.
- **Accent:** an optional low teal point/spot from the LED boards near ground level, subtle.
Until it exists, other modules use a local copy of the same recipe in their test scenes.

---

## 6. Module specs

### 6.1 Stadium & atmosphere (`T-Stadium`)
- A huge modern bowl: 3 tiers of stands (inner radius 73, outer 125, top ~42m), slight oval, a roof canopy ring,
  vomitories/aisles breaking up the seating, upper-tier facade bands with subtle teal LED strips.
- **Crowd:** 20–30k spectators as instanced low-poly figures (head + torso). Shirt colours are muted and varied, with ~30% in
  teal or graphite (home fans), plus white and warm tones. Animation is driven by `energy` (0..1): idle sway, arms-up waves,
  and phone-flash sparkles (tiny white points that blink deterministically). It must read as "packed" at broadcast distance.
- **Floodlights:** 8 banks (`STADIUM.floodTowers`) on tall masts or roof mounts, each a grid of lamp emitters.
  `floods: number[]` (8 values 0..1) controls each bank. Turning on means a quick flicker then full power, with
  emissive lamps, glow sprites and a **volumetric beam** into the haze (a custom additive shader cone/frustum with soft edges,
  falloff along length, noise that drifts, and depth softness). Beams must look like light in haze, not solid cones.
- **LED boundary boards** at `FIELD.ledRadius`, about 0.9m high, ringing the field. A shader with deep teal and graphite
  gradients, slow scrolling chevrons and an occasional "MPL" wordmark (the only text allowed). `led` 0..1 powers them up as a
  sweep around the ring (`ledSweep` 0..1 = angle progress).
- Scoreboard/screen on one stand with a soft teal glow (no readable text except "MPL"). Camera towers or
  gantries. Sight-screen at each end (dark).
- **Atmosphere:** scene fog (graphite-teal), drifting haze layers, and **dust motes** that are visible only inside beams
  (points with soft sprites, deterministic drift).
- `src/world/Lights.tsx`: `<StadiumLights/>` per §5.
- API: `<Stadium F floods led ledSweep energy detail="far"|"near" />` plus `stadiumStateAt(F)` returning
  sensible defaults from the cue sheet (floods ramp on at `events.flood_on`, LED sweep at `led_sweep`, energy
  rising through the film). Keep it cheap: when `detail="near"` (macro/close shots) skip the crowd geometry beyond
  what the blurred background needs.
- Test: the aerial establishing move (frames 0–66 timing) plus a ground-level view from the pitch.

### 6.2 Field & props (`T-Field`, `T-Props`)
- Outfield disc to `FIELD.outfieldRadius` with a grass shader: parallel mowing stripes (~5m), fine noise and
  subtle sheen. It must look like real turf lit by floodlights, never flat paint.
- The pitch strip, worn and lighter, with correct white crease markings at both ends (bowling crease,
  popping crease, return creases, per `dims.ts`). 30-yard circle markers. The boundary rope at `FIELD.boundary`
  (white/silver rope, padded).
- `<GrassBlades center radius density wind F />`: instanced 3D grass blades for low and macro shots, bending in wind
  and pushed by `disturb` points (position + radius + strength) for footsteps and slides.
- **Ball** `<Ball spin={[x,y,z]} />` with radius `BALL.radius`. Deep red leather (`leather`) with fine grain, a lacquer
  shine (clearcoat), a **raised seam** around the equator (local XZ plane) with **6 rows of stitching** (3 per side) and a
  subtle quarter seam. The seam must read clearly at both mid distance and close up.
- **Bat** `<Bat/>`: a real cricket bat (never a round baseball bat). The blade has a flat face, a pronounced spine ridge on the back,
  thick edges, a rounded toe and shoulders. The handle has a rubber grip (graphite with teal rings). Local frame: origin at the
  **grip centre**, +Y toward the handle top, the toe toward -Y, the face normal +Z. Export `BAT_SWEET_SPOT` (local position on the
  face, about 0.15m above the toe) so shots can place ball contact exactly.
- **Wicket** `<Wicket position state />`: 3 stumps + 2 bails, correct proportions (`STUMPS`), white with a thin teal
  band near the top. `src/world/wicketPhysics.ts`: a pure function `wicketHitState(tSinceHit, hit)` that returns the stump tilts and
  each bail's position and rotation (ballistic arc, tumbling, with one bail flying toward a given direction, e.g. the camera).
- Tests: low camera across the pitch toward the stumps, a macro of ball and bat, and a wicket hit in slow motion.

### 6.3 Character rig & actions (`T-Player`)
- `src/rig/Player.tsx`: `<Player pose role kit position rotationY rightHand leftHand />` builds a ~1.83m athletic male from
  smooth sculpted parts (tapered limbs, shaped torso with chest/back/shoulder mass, neck, head) with correct
  proportions. Kit:
  - **Fielding side (`kit="teal"`):** deep-teal shirt with graphite side panels and white piping, graphite trousers, white
    shoes with teal soles. Fielders and bowler wear a graphite cap or no cap (short dark hair).
  - **Batting side (`kit="graphite"`):** graphite shirt with teal shoulder yokes, teal-graphite trousers, white pads,
    batting gloves, and a helmet (navy-graphite shell, peak, steel grille, teal neck guard).
  - **Keeper:** fielding kit + keeper pads + large keeper gloves (webbed, cricket style, never baseball mitts) + helmet.
  - A small "MPL" chest mark is allowed. No numbers or names.
- Hands: palm + 4 fingers + thumb with a `grip` 0..1 curl. Each hand has an attachment slot: `rightHand` / `leftHand`
  React nodes rendered in hand-local space (document the axes). Bat grip: top hand is the left (right-hander), bottom hand
  the right, both on the handle.
- `src/rig/actions.ts`: pure functions `(t: seconds, opts?) => Pose`. Each documents its key times. Required:
  `batStance`, `batDrive` (front-foot straight/cover drive with documented `CONTACT_T`), `batCoverDrive` (montage),
  `raiseBat`, `runBetweenWickets` (bat extended, slide in), `bowlRunUp` + `bowlDelivery` (side-on gather, leap,
  back-foot land, front-foot land, **straight bowling arm** rotating over the top, documented `RELEASE_T`,
  follow-through), `keeperCrouch`, `keeperCollect`, `fielderReady`, `sprint`, `diveCatch` (sprint → launch →
  full horizontal dive → two-hand catch at documented `CATCH_T` → land → slide), `pickupThrow` (collect → crow-hop
  → powerful overarm throw, documented `THROW_RELEASE_T`), `appeal`, `celebrateFistPump`, `celebrateJump`, `runToTeammate`.
- `src/rig/solve.ts`: forward kinematics `solvePose(pose)` → world-in-character-space matrices for every joint and both
  hands; `attachmentWorld(pose, slot, playerPos, playerRotY, localPoint)` → world position (used to place the ball exactly on
  the bat face at contact, in the keeper's gloves, and in the catcher's hands).
- `src/rig/README.md`: joint conventions, axes, slots and every action's timing table.
- Quality bar: weight shift, anticipation, follow-through, arcs and overlapping action. Planted feet don't slide. Joints stay
  within human limits. The bat never intersects the body. Read the motion in silhouette: it must look like real cricket.

### 6.4 Macro hand (`T-Hand`)
- `src/rig/MacroHand.tsx`: `<MacroHand t />` is a high-detail bowler's right hand and wrist for an extreme close-up (camera
  0.2–0.6m away). It has three-phalanx fingers, knuckles, nails, skin creases suggested by normal detail, a skin shader
  (warm, slight sheen, plausible subsurface feel via `MeshPhysicalMaterial` sheen/transmission tricks), and a sleeve cuff
  (deep-teal kit with graphite band) at the wrist.
- It holds its own `MacroBall` matching §6.2: the seam upright between the index and middle fingers, thumb underneath on the seam,
  and ring and little fingers tucked at the side. Over shot 2 (60 frames) the fingers slowly rotate the ball, settle
  onto the seam, and tighten (micro motion only). `t` is the local time in seconds and the
  `ball_handle` cues are when the leather turns.
- Subtle moisture/shine on the leather and a teal LED reflection streak across the ball from an environment light.
- Test: slow orbit around the hand with shallow depth of field and a dark bokeh stadium background.

### 6.5 FX & post (`T-FX`)
- `src/post/Post.tsx`: `<Post focus={Vec3|null} focusRange aperture bloom flash grain vignette chroma grade />` using
  `@react-three/postprocessing`. It has mipmap bloom (threshold high: only lamps, LEDs and highlights bloom), world-target depth of
  field, a film grain overlay, vignette, very subtle chromatic aberration at the frame edges, and a **colour grade** effect
  (custom `Effect`: lift/gamma/gain with cool-teal shadows, neutral mids, slightly warm highlights; contrast; keeps skin
  and grass natural). `flash` (0..1) adds a short exposure lift for impacts.
- `src/fx/`: all deterministic and frame-driven.
  - `DustBurst` (footsteps, slides): soft particles that rise and settle.
  - `GrassSpray` (slide spray, and a lens-filling version for the shot-7→8 wipe).
  - `SpeedTrail` (thin teal ribbon behind a moving object from a path function; restrained; fades).
  - `ImpactFlash` (bat contact: a tiny bright burst plus a ring; one or two frames).
  - `Splinters` (barely visible wood flecks at stump impact).
  - `TealMotes` (floating metallic-teal particles).
  - `LightStreak` (horizontal anamorphic streak on bright lamps, subtle teal).
- Test: each effect in a small grid with the post stack on.

### 6.6 Audio (`audio/`)
- Python (`.venv/bin/python`, numpy+scipy available) synthesises every layer at 48 kHz stereo from `src/cues.json`:
  - **Ambience:** low cinematic rumble, a crowd bed (layered filtered noise with formant-ish movement, distant to
    close) whose level follows the story, crowd swells at `bat_contact`, `catch`, `stump_hit` and `fist_pump`, peaking at the
    final hit, then fading.
  - **SFX:** floodlight clunk and electrical hum per `flood_on`, leather handling, breaths, footsteps on grass, the release
    whoosh, a **sharp bat crack** (wood resonance), ball air-rush, catch slap, grass slide, throw whoosh, stump crack and bail
    clatter, metallic assembly locks (`logo_locks`), the final logo bat hit and wicket hit, a teal-pulse shimmer, and a final
    **deep cinematic bass impact** with metallic shimmer.
  - **Music:** a modern sports-broadcast cue of hybrid cinematic percussion (taiko-like drums, toms, sub hits), a
    low string-like drone or ostinato from additive synthesis and a subtle electronic pulse. It builds from the sparse
    opening to the montage peak and resolves on the final hit. No cheerful corporate pop.
- Output `public/audio/mpl_mix.wav` (and stems in `public/audio/stems/`), loudness-normalised to about -16 LUFS,
  true peak ≤ -1 dBTP (use ffmpeg `loudnorm`).

---

## 7. Performance budget (software WebGL)

Target ≤ 6 s per 1080p frame for the heaviest shot. Instance everything repeated. Avoid real-time shadows unless needed,
and never more than one shadow map. Use low-segment geometry where it's out of focus or far away, and custom shaders over
many lights. Particle counts in the low thousands. Measure your test renders and report seconds per frame.

---

## 8. How to verify (required before you report done)

```bash
cd /home/user/medsolercm-project/mpl-ident
npx tsc --noEmit && npx eslint src            # must pass
scripts/still.sh T-Player 60 out/t/player_60.png 0.5   # render one frame (scale 0.5 = 960x540)
scripts/clip.sh  T-Player 0 119 out/t/player.mp4 0.5   # render a clip
scripts/sheet.sh out/t/player.mp4 out/t/player_sheet.png 4   # contact sheet, every 4th frame
```

Look at the images with the Read tool. Judge them like a demanding broadcast motion designer and iterate until the
result meets the quality bar. Put your scratch renders in `out/t/<module>/` (gitignored).

Final report: what you built, the exported API (component props, functions, key timing constants), the measured render
cost, known limitations, and paths to 2–4 representative stills.
