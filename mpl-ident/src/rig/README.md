# Character rig and actions (`src/rig`)

Procedural, articulated cricketers for the MPL ident. Everything is a pure function of its inputs
(no `useFrame`, no state, no randomness): `pose = action(t)`, `<Player pose={pose} />`.

| File | Contents |
|---|---|
| `types.ts` | the shared `Pose` contract (read-only) |
| `solve.ts` | skeleton, FK (`solvePose`), analytic two-bone IK (`armIK` with automatic elbow swivel that keeps the wrist human, `legIK`), wrist range (`WRIST_RANGE`, `wristAngles`), hand frames, bat/ball holds (adaptive grip), attachment slots (`attachmentWorld`, `batContact`), `blendPose`, `blendArm` |
| `pose.ts` | authoring layer: `build(BodySpec)` turns targets (feet on the ground, hands on a bat, a look-at point) into a `Pose`; `gripFor` (how the hands sit on the handle), `stableBuild` (temporally coherent arm solutions), `limitWrist`, `aimQuat` |
| `gait.ts` | footfall-driven walk/jog/sprint (planted feet never slide, heel peel, swing arcs, pelvis bob that sinks where a stride would over-reach, counter-rotation, arm phase) |
| `anim.ts` | deterministic key tracks (Hermite/Catmull-Rom scalar, vector, quaternion), easing helpers |
| `actions.ts` | the cricket action library (below) and the `ACTIONS` registry used by T-Player |
| `body.ts` | procedural geometry: skinned body (shirt, trousers, skin), sculpted head with painted hair, hands, hinged shoes, pads, helmet, cap |
| `kit.ts` | materials: kits with panels, piping, yokes, collar and the "MPL" chest mark; skin; shoes; gear |
| `Player.tsx` | `<Player/>` component |

## Coordinate conventions

**Character space**: metres, **Y up, the character faces +Z, +X is the character's LEFT**, ground at y = 0.
`<Player position rotationY>` maps character space to the world: `world = T(position) * Ry(rotationY) * char`.

Rest pose (all joint rotations zero): standing straight, arms hanging, palms to the thighs, thumbs forward.
Standing height 1.83 m: pelvis 0.99, hips 0.95, knees 0.51, ankles 0.08, shoulders 1.465, neck base 1.51, head pivot 1.62.
Segment lengths: upper arm 0.30, forearm 0.262, hand ~0.19, thigh 0.44, shin 0.43.

### Joints (`Pose.joints`, radians, local to the parent)

| Joint | Euler order | x | y | z |
|---|---|---|---|---|
| `rootRot` (pelvis, in char space) | YXZ | pitch: + tips forward | yaw: + turns left | roll: + leans right |
| `spine`, `chest`, `neck`, `head` | YXZ | + bend forward | + twist left | + lean right |
| `lShoulder`, `rShoulder` | XZY | − raises the arm forward (flexion) | twist about the arm | ± abduction (sign mirrors per side) |
| `lElbow`, `rElbow` | XZY | **−flex** (negative = bent) | forearm twist: + = right pronation / left supination | 0 |
| `lWrist`, `rWrist` | XZY | + ulnar deviation (toward the little finger) | residual twist | + bends toward local +X (right: flexion, left: extension) |
| `lHip`, `rHip` | XZY | − raises the thigh forward | twist | ± abduction |
| `lKnee`, `rKnee` | XZY | **+flex** (positive = bent) | 0 | 0 |
| `lAnkle`, `rAnkle` | XZY | + toes down (plantarflexion) | twist | inversion/eversion |

Bones produced by `solvePose` also include derived helpers used for skinning: `lClav`/`rClav` (automatic
shoulder girdle: the shoulder joint lifts and draws in when the arm goes overhead, protracts when reaching
forward) and `ForeA`/`ForeB` (forearm twist spread along the forearm).

`lGrip` / `rGrip`: 0 open hand .. 1 fist. Optional per-finger override `lFingers`/`rFingers`
`[thumb, index, middle, ring, little]` (e.g. the appeal's pointing finger).

### Hand-local axes (attachment slots `leftHand` / `rightHand`)

Origin at the wrist joint. **−Y runs to the fingertips, +Z is the thumb side**, the **palm faces +X on the
right hand and −X on the left hand**. React nodes passed as `rightHand` / `leftHand` render in this space.
`FIST_CENTER` is the point inside a closed fist where a handle runs: right `[0.036, −0.083, 0]`, left `[−0.036, −0.083, 0]`.

### Bat and ball holds (extra channels on the pose)

Actions return `RigPose = Pose & { bat?: BatHold; ball?: BallHold; lFingers?; rFingers? }`.

* `pose.bat = { hand, grip, tilt?, roll? }`: the bat is parented to that hand with
  `batInHand(hand, grip, role?, tilt?, roll?)` (also exported for manual placement:
  `<Bat position={b.position} rotation={b.rotation}/>` inside the hand slot; always pass the pose's tilt/roll).
  The cricket grip: the thumb–forefinger "V" of both hands points **down the handle toward the blade**, the
  handle crosses the palm diagonally from the heel of the hand to the index finger (`tilt`, default
  `BAT_GRIP_TILT` 42° batting / 30° carrying), the face looks the way the back of the top hand / the palm of
  the bottom hand looks. `build()` adapts `tilt` (30–58°) and the hand's `roll` around the handle (±24°, where
  the V sits) per pose so the wrists stay in their natural range (`gripFor`). Two-handed batting
  (`grip: "bat"`): left (top) hand at bat-local y = 0.088, right (bottom) hand at −0.024; the bat is attached
  to the **left** hand and the right hand is IK'd to the solved handle, so the hands can never separate from
  the bat. `grip: "carry"`: one hand near the handle top (running, raising).
* `pose.ball = { hand, grip }` with grips `seam` (bowling: seam upright between index and middle finger),
  `throw`, `cup` (two-hand catch), `keeper`, `palm`. `ballInHand(hand, grip)` gives the hand-local placement.
* `<Player bat ball />` renders them automatically (bat defaults on for batsmen); or render your own.

### Slots and helpers (`solve.ts`)

```ts
solvePose(pose): Record<Bone, Matrix4>                  // character-space matrices
slotMatrix(pose, slot)                                  // slot: leftHand rightHand head chest pelvis leftFoot rightFoot bat ball
attachmentWorld(pose, slot, playerPos, playerRotY, localPoint = [0,0,0]): Vec3
attachmentDir(pose, slot, playerRotY, localDir): Vec3
batContact(pose, playerPos, playerRotY, r = 0.036) -> { spot, normal, ballCentre }   // ball exactly on BAT_SWEET_SPOT
blendPose(a, b, w)                                      // quaternion slerp per joint (bat grip lerped)
blendArm(a, b, side, w)                                 // blend one arm only (chest-local, exact when trunks match)
armIK(chest, side, wrist, handQ, pole, {swivel?, swivelN?}) -> {shoulder, elbow, wrist, err, twist, strain, swivel}
WRIST_RANGE = {flex 70, ext 60, ulnar 32, radial 18} (deg); wristAngles(q, side) -> {flex, dev, twist}
```

**Arm IK keeps hands human.** When a requested hand orientation (a bat grip, a catch) would need more forearm
twist (> 80°) or wrist bend than `WRIST_RANGE`, `armIK` swivels the elbow about the shoulder–wrist axis
(humeral rotation) to the configuration with the least strain, as close to the requested pole as possible
(a soft-argmin, continuous in its inputs). `build()` also chooses the bat grip (`gripFor`). For whole actions,
`stableBuild(key, specAt, t, t0, t1)` optimises these choices at anchors every 1/30 s **with continuation**
(each anchor starts from the previous one, so the solution never jumps between equally good families) and
interpolates them; it is memoised per key (first call ~0.1–0.3 s, then < 0.2 ms per pose) and pure.

## `<Player/>`

```tsx
<Player
  pose={pose}                 // Pose / RigPose
  role="batsman"              // batsman | bowler | fielder | keeper   (gear)
  kit="graphite"              // teal = fielding side, graphite = batting side (default from role)
  position={[0, 0, -8.84]} rotationY={0}
  rightHand={node} leftHand={node}   // hand-local attachments
  bat ball ballSpin={[x,y,z]}        // render pose.bat / pose.ball
  headwear="auto"             // auto: helmet for batsman/keeper, cap for the bowler, seeded cap (2 in 3) or bare head for fielders
  seed={3}                    // skin tone, hair
  detail="mid"                // hero (close-ups) | mid | far
  castShadow receiveShadow
/>
```

Kits: fielding = deep-teal shirt, graphite side panels running under the sleeves, white piping, graphite
V-collar and cuffs, graphite trousers with teal seam piping, white shoes with teal soles, graphite cap or short
hair. Batting = graphite shirt with teal yokes and piping, teal-graphite trousers, white caned pads with
straps and a teal knee-roll line, padded batting gloves with teal cuffs, navy-graphite helmet with peak, steel
grille and teal neck guard. Keeper = fielding kit + keeper pads, webbed keeper gloves, helmet.
A small "MPL" mark sits on the left chest. No numbers or names. Glove cuffs ride on the forearm (the wrist
bends inside the glove). Role `"bowler"` uses the fielding kit and gear with a cap.

**Rim light.** Every player material opts into the stadium fresnel rim (`withStadiumRim` from
`world/Lights.tsx`; kit ~1, skin 0.55, helmet 0.8, pads/shoes ~0.35). It follows the shot's `rimDir`
through shared uniforms that `<StadiumLights/>` writes each frame, so **render `<StadiumLights/>` in every
shot that shows players** (a shot without it would inherit the previous shot's rim).

## Action library (`actions.ts`)

Every action is `(t: seconds, opts?) => ActionPose`, continuous for any t (holds before/after).
Each has its own **action frame**: +Z is the direction of play. Shots place the frame with `position` /
`rotationY` (e.g. the bowler bowls toward world −Z → `rotationY = Math.PI`). Default key times are chosen
so `t = (F − shotStart) / 30` lands on the cue frames; pass options (or an `actionTime` remap) for slow motion.

| Action | Frame (origin, +Z) | Key times (s) | Options | Holds |
|---|---|---|---|---|
| `batStance(t, {liftT})` | striker's popping crease on the middle-stump line; +Z to the bowler (place at `[0,0,STRIKER_POPPING_Z]`, rotY 0) | bat taps every `BAT.TAP_PERIOD` 0.62; with `liftT` the backlift starts at liftT and holds at the top (~liftT+0.47) | `liftT` | bat (2 hands) |
| `batDrive(t, {contactT, direction})` | as batStance | backlift Tc−0.72; front foot lifts Tc−0.45; top of backlift Tc−0.25; front foot lands Tc−0.13; **CONTACT Tc = `BAT.CONTACT_T` 1.0**; high finish over the left shoulder Tc+0.32; settle to Tc+1.2 | `contactT`, `direction` (0 lofted straight/long-on … −0.6 cover) | bat |
| `batCoverDrive(t, {contactT})` | as batStance | same phases, **contact `BAT.COVER_CONTACT_T` 0.62** (montage) | `contactT` | bat |
| `raiseBat(t)` | standing at the origin facing +Z (the crowd) | bat rises 0.12→**`RAISE_T` 0.7** (blade up, face out), left glove up, sway after | | bat (right, carry) |
| `runBetweenWickets(t, {groundT, speed})` | origin = where the bat toe touches down; running +Z at 7 m/s | footfalls every 0.2 s (…, groundT−0.3, −0.1, +0.1); reach from groundT−0.34; **toe down `RUN_GROUND_T` 1.1**, slides along +Z to groundT+0.45; three braking steps, stopped by groundT+1.0 | `groundT`, `speed` | bat (right, carry) |
| `bowlRunUp(t, {steps, length})` | **bowling frame**: origin = front-foot ankle at front-foot contact, just behind the bowler's popping crease; +Z to the batsman (right-arm over: origin ~0.3 m to the bowler's **left** of middle stump, i.e. world `[-0.3, 0, 8.9]`, rotY π) | footfalls `BOWL.runUpSteps` = −0.1, 0.2, 0.5, 0.8, 1.067, 1.333, 1.567, 1.767, **take-off plant 1.933** (= cue 132…184 with t0 = frame 126; take-off at z −2.3); starts ~11.8 m behind the crease (`length` scales it); **gather** over the last stride (1.63→1.91): both hands come up, ball under the chin, front arm cocked | `steps`, `length` | ball (seam) |
| `bowlDelivery(t, {tBFC, tFFC, tRelease})` | bowling frame, t = 0 at the take-off plant (frame 184) | take-off push → bound (front arm climbs out of the gather) → **BFC 0.17** (back foot side-on, front arm high) → **FFC 0.2667** (frame 192, braced front leg at the origin) → **RELEASE 0.4** (frame 196; straight arm just past vertical, ball at [0.04, 2.16, 0.16]) → arm across to the left knee, back leg through, run-off veering left, settled by ~1.6. The key times are hit exactly through a C1 monotone time warp (no speed jumps). Slower, more visible leap: `BOWL.NATURAL` {0.3, 0.42, 0.54} | key-time remap | ball until release |
| `keeperCrouch(t, {riseT})` | between the keeper's feet; +Z to the bowler (stumps in front) | crouch with gentle rocking; rises into a half crouch from `KEEPER.RISE_T` 1.0 over 0.3 | `riseT` | |
| `keeperCollect(t, {collectT, at, finish, stumps})` | as keeperCrouch | rises from collectT−0.55; **collect `KEEPER.COLLECT_T` 0.55** at `at` (default [0.12, 0.72, 0.42]); soft hands 0.12; `finish:'break'` sweeps the gloves into the stumps at collectT+0.22 | | ball (keeper) from collect |
| `fielderReady(t)` | origin = set position | walks in (−0.62…0.85), split-step hop, **set `FIELD_READY.SET_T` 1.25**: wide base, knees bent, hips hinged, hands low, eyes on the bat | | |
| `sprint(t, {steps, speed, lean})` | pelvis at z ≈ speed·t | footfalls every 0.2 s (custom `steps` for cues), 7.5 m/s | | |
| `diveCatch(t, {steps, launchT, catchT, landT, slideEndT, side})` | origin at the run start; +Z running | steps −0.333…0.467, take-off plant 0.633 (cues 320/326/332/337 with t0 = 318); **launch `DIVE.LAUNCH_T` 0.733** (340); flat full-length dive to the right; **catch `DIVE.CATCH_T` 1.067** (350; ball ≈ [−1.26, 0.50, 8.33]); land 1.12; slide to 1.8 (372); ball raised after | all key times, `side` | ball (cup) from catch |
| `pickupThrow(t, {collectT, releaseT})` | origin = ball on the ground; +Z = run-in and throw direction | jog in, stoop; **collect `THROW.COLLECT_T` 0.6** (right hand beside the left foot); crow hop; 'L' cock with the elbow at shoulder height; **release `THROW.THROW_RELEASE_T` 1.2** (flat return, arm ~38° in front of vertical; ball ≈ [−0.07, 1.97, 2.24]); follow-through. Post-collect phases scale with releaseT−collectT (the cue gap 384→392 plays the crow hop 2.25× fast) | | ball (throw) collect→release |
| `appeal(t)` | at the origin, starting in a follow-through facing +Z | pivots on the right foot toward −Z (the umpire), knee lift; **peak `APPEAL_T` 0.45**: right arm straight up, index finger pointing; small pulses | | |
| `celebrateFistPump(t, {pumpT})` | at the origin | steps round toward his left, fist loads by the ear pumpT−0.18, **pull-down `FIST_PUMP_T` 0.4** with knee dip, second pump +0.35 | `pumpT` | |
| `celebrateJump(t, {jumpT})` | at the origin | crouch from J−0.42, toes push J−0.2, **apex `JUMP_T` 0.52** (22 cm, fist up), toes down J+0.2, recover | `jumpT` | |
| `runToTeammate(t, {stopT})` | stops at the origin, running along +Z | decelerating steps from stopT−1.73, arms open from stopT−0.45, **stop `RUN_TO_STOP_T` 1.2**, right hand up for the high five | `stopT` | |

Top-level aliases: `CONTACT_T` (= `BAT.CONTACT_T`), `RELEASE_T` (= `BOWL.RELEASE_T`), `CATCH_T`
(= `DIVE.CATCH_T`), `THROW_RELEASE_T` (= `THROW.THROW_RELEASE_T`).

`swingQ(phi, psi, plane, lean)` (the bat's swing-plane parameterisation used by the drives) and `runArm` are
exported for shots that author their own variations. `ACTIONS` lists every action with a preview window.

### Cue mapping (`src/cues.json`, global frames, 30 fps)

* S03 run-up: `bowlRunUp((F − 126) / 30)` puts footfalls on `footsteps` 132…184.
* S04 delivery: `bowlDelivery(t, { tFFC: a(192), tRelease: a(196) })` with the shot's `actionTime` a(); the
  defaults already land FFC on 192 and release on 196 at 1×.
* S05 strike: `batDrive(a(F), { contactT: a(240) })`; place the ball with `batContact(pose, pos, rotY).ballCentre`.
* S07 catch: `diveCatch(a(F), { launchT: a(340), catchT: a(350), landT: a(352), slideEndT: a(372) })`.
* S08 throw: `pickupThrow(a(F), { collectT: a(384), releaseT: a(392) })`; batsman: `runBetweenWickets`.
* S10 celebration: `celebrateFistPump(…, { pumpT: a(474) })`, teammates `runToTeammate` / `celebrateJump`.
* S11 montage: `batCoverDrive`, `appeal`, `keeperCollect`, `diveCatch`, `runBetweenWickets`, `raiseBat`.

## Authoring new poses (`pose.ts`)

Arm specs: `ArmIKSpec {wrist|hand, fingers, palm, pole, swivel?}`, `ArmAimSpec {aim, pole, flex, pron, wflex,
space, q?}` (blend aims with quaternions: `aimQuat`, actions' `mixAim`), `ArmReachSpec {dir, dist, fingers,
palm, pole, swivel?}`. `BatSpec {pos, q, hands, grip?, lPole?, rPole?, lGrip?, rGrip?, lSwivel?, rSwivel?,
wristLimit?}`. Use `stableBuild` for any action where hands hold a bat or follow IK targets over time.

```ts
build({
  root: [0, 0.95, 0], rootRot: [pitch, yaw, roll],
  spine: [bend, twist, lean], chest: [...],
  look: [x, y, z],                        // eyes level, split neck/head
  lFoot: plant(x, z, yaw, heelRoll), rFoot: airFoot([x, y, z], yaw, pitch),
  lArm: { aim, pole, flex, pron, wflex, space },          // FK by direction (chest or char space)
  rArm: { wrist, fingers, palm, pole },                   // IK to a hand target
  // or { dir, dist, fingers, palm, pole } (straight-arm reach), or bat: { pos, q, hands: "both" }
});
```

## Quality checks

Validated per action with an offline sampler (60 Hz over each action window ±0.3 s): planted feet do not slide
(except the bowler's deliberate back-toe drag of ~0.1 m in the delivery stride and the batsman's back-toe drag in
the drive's finish, 0.13 m), soles never go below the turf (hinged toe box), knees and elbows never hyperextend,
no joint pops (worst frame-to-frame acceleration jump: limbs ≤ 7 cm at 60 Hz, except the dive's drive-leg kick
at take-off, 14 cm, which is real swing speed), both batting hands stay on the handle (< 0.5 mm), the blade
clears the body (≥ −3 cm against generous capsules: it brushes the back pad in the stance and the shirt in the
cover drive's downswing), the carried bat clears the legs (+6 cm) and the grounded bat toe never digs in more
than 1.3 cm, the dive's knees stay ≥ 6 cm above the turf, wrists stay inside `WRIST_RANGE` for everything except
the brief bat roll right after contact in the drives (see limitations), and the bowling arm stays straight
(elbow flex at most 7.9°, 4.9° at release, inside the 15° law) from back-foot contact through release.

Render cost: ~3 s per 1080p frame for a single canvas with four players (one at `hero` detail), the field
and one shadow map (T-Player `{"view":"perf"}`, concurrency 1, CPU shared). Pose evaluation < 0.5 ms
(stabilised batting actions: ~0.1–0.3 s once per key, then < 0.2 ms).

T-Player views: default 8-segment overview (two actions per segment, side + 3/4); `{"action":"batDrive",
"speed":0.5}` one action; `{"view":"shot","shot":"s05"}` **director views** that stage the film's own camera
angles on the cue frames (`s03low`, `s03back`, `s04`, `s05`, `s07`, `s08`, `s09`, `s10`; `at` renders one global
frame, `camOff` overrides the camera); `body`, `face`, `hands`, `perf`.

## Known limitations

* Linear-blend skinning: the shoulder cap reads as a raglan sleeve seam in extreme close-ups; elbows and
  knees lose a little volume at full flexion. No cloth simulation.
* Faces are sculpted and lit but static (no facial animation) and read as stylised up close (under ~1.5 m);
  the bowler wears a cap and batsmen/keepers helmets by default, which keeps faces shaded. Keep bare faces at
  mid distance.
* Fingers are rigid capsule phalanges driven by one curl value per hand (plus per-finger overrides).
* The cue sheet leaves 8 frames from the take-off plant (184) to front-foot contact (192): the bound is short
  and fast at the cue-locked default; for a visible leap use `BOWL.NATURAL` timing.
* Drives: the authored bat path rolls ~190° face-first through the follow-through; just after contact
  (contact +0.05…+0.2 s) the top-hand wrist briefly exceeds its natural range (worst ~100° beyond for 2–3
  frames, a forearm twist flip at contact +0.18). Contact itself and the high finish are within range; at
  broadcast framing it reads as a wrist roll at speed.
* `pickupThrow` at the cue gap (collect 384 → release 392) compresses the crow hop 2.25×.
