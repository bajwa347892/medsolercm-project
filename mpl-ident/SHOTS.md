# MPL ident: shot direction

Companion to SPEC.md. Frame numbers are global (30fps) and come from `src/cues.json`; shots must land their
actions on those exact frames. Each shot lives in `src/shots/Sxx_name.tsx`, exports a `ShotDef`, and is
registered in `src/shots/registry.ts`. Shared play geometry (ball paths, contact/catch points, fielder spots) lives
in `src/shots/play.ts` so every angle of the same moment agrees.

**Continuity across cuts.** We edit like broadcast: the same physical moment can be shown from consecutive angles, and
each shot runs its own action clock (with `actionTime` slow-motion ramps). What must match across a cut is
*screen direction, positions and pose*, not literal elapsed time. Respect the 180° rule within each scene.
Players, kits and stadium never change between shots.

**Editing rhythm.** Slow and suspenseful (S1–S2) → increasing tempo (S3) → brief slowdown at release (S4) → micro slow motion
at bat contact (S5) → fast (S6–S8) with a short slow motion at the catch (S7) → fast then a sudden ultra-slow stump impact (S9)
→ energetic (S10) → rapid (S11) → controlled and powerful (S12–S14) → slow and confident (S15).

---

## S01 Awaken · 0–66 (0:00–0:02.2)
- Opens nearly black: faint graphite silhouettes of the bowl, with only a hint of sky glow.
- Floodlight banks power on at `flood_on` frames, one bank per cue, each with a short flicker, then full beams through the haze
  and dust motes in the beams. The field fills with light as banks come on.
- LED boards sweep on in teal around the ring from `led_sweep` (46) to ~62. A few teal motes drift.
- Camera: extremely high (~230m up, ~190m out) and slowly descending and pushing toward the pitch with a slight orbit
  (~20°) for parallax. It ends ~40m up over the bowler's end, looking down the pitch. No logo.
- The cut to S02 goes from a wide to a macro.

## S02 Macro grip · 66–126 (2.2–4.2s)
- `MacroHand` at the top of the bowler's run-up (around (0, 1.4, 26)), with the stadium behind it heavily blurred into floodlight bokeh.
- The camera circles the hand slowly (~40° over the shot) at 0.25–0.45m with very shallow depth of field on the seam.
- The leather turns at `ball_handle` cues; the grip settles on the seam; controlled breathing lifts the wrist slightly at `breath`.
- A teal LED reflection crosses the ball's lacquer. The ball doesn't glow.
- Last ~8 frames: the hand starts to move forward (the run begins), motivating the cut.

## S03 Run-up · 126–186 (4.2–6.2s)
- The bowler (teal kit) runs in from z≈27 toward the crease; foot plants land exactly on `footsteps` frames,
  accelerating. Arms pump; the ball is held in the right hand.
- 126–160: low-angle tracking camera alongside him (≈0.4–0.6m high, 2.5–3.5m to his side, moving with him). Grass blades
  pass in the foreground, and dust and grass flick from each plant (`DustBurst`).
- 160–186: the camera swings behind the bowler, over his right shoulder, revealing the pitch with the **batsman** in
  stance at the striker's end (bat tapping, then raised in backlift), the **keeper** crouched behind, a slip, and
  fielders in position (`FIELDERS`). Shallow focus pulls from bowler to batsman.

## S04 Delivery · 186–216 (6.2–7.2s)
- Delivery stride: gather and leap, back-foot land, **front foot lands at `front_foot_land` (192)** just behind the
  bowler's popping crease, and the straight bowling arm rotates over the top. **Release at `ball_release` (196)**.
- Slow motion over `slowmo.release` (≈0.25×), close on the hand and ball at release with the seam rotating clearly (backspin
  with an upright seam).
- The camera then transitions into a close tracking shot behind and beside the ball as it travels toward the batsman, with a very
  restrained teal `SpeedTrail` and subtle air distortion at most. No flames.

## S05 Strike · 216–276 (7.2–9.2s)
- Side profile of the batsman from the off side (camera −X of him, looking +X), so the bat arc is in profile.
- He watches the ball, steps into a front-foot drive (front foot toward the pitch of the ball), head over the line, high
  elbow, straight bat.
- **Bat contact at `bat_contact` (240)**, with the ball EXACTLY on the bat's sweet spot (`attachmentWorld` + `BAT_SWEET_SPOT`):
  micro slow motion over `slowmo.contact`, a slight squash of the ball, a brief `ImpactFlash`, small dust, and a `Post` flash.
  The ball's incoming path must arrive continuously at that point and its outgoing path leave from it. No pop and no
  pass-through.
- Smooth, athletic follow-through. From ~258 the camera whips to follow the ball (lofted, toward long-on/deep mid-wicket).

## S06 Ball flight · 276–318 (9.2–10.6s)
- The ball-follow camera sits just behind and slightly below the spinning ball as it climbs and arcs. The stadium streaks past with
  depth of field, the seam stays visible, and the crowd rises (`crowd_rise`).
- Fielders react in the background: the deep fielder starts sprinting toward the landing area, and another turns and follows.

## S07 Diving catch · 318–378 (10.6–12.6s)
- Outfield, ground-level camera (~0.3m) tracking the sprinting fielder. Grass moves under his shoes (`fielder_steps`).
- The ball descends into frame. **Launch at `dive_launch` (340)** into a full horizontal dive, then **catch at `catch` (350)** in both
  hands (`attachmentWorld` for the ball). Slow motion over `slowmo.catch`: grass particles fly, fingers close.
- He lands and slides (`slide` 352–372). Then `GrassSpray` in lens-filling mode wipes the frame toward the end (~368–378).

## S08 Throw · 378–420 (12.6–14.0s)
- The grass particles clear (378–384) to reveal a different moment: a boundary fielder near the rope **collects (`collect`
  384)**, crow-hops and throws overarm (**`throw_release` 392**) toward the striker's end.
- Cuts within the shot (hard cuts on motion are allowed inside S08): the ball skimming low across the field → a batsman
  sprinting with bat extended toward the crease (`batsman_steps`) → the keeper ready behind the stumps.

## S09 Run-out · 420–465 (14.0–15.5s)
- Low, close camera at the striker's stumps. The keeper gathers and redirects the ball into the stumps. **The ball hits the stumps at
  `stump_hit` (438)**. Ultra-slow motion over `slowmo.stumps`: stumps tilt, bails explode upward, barely visible splinters,
  and the batsman's bat sliding in just short of the crease in the background.
- One bail rotates toward camera and fills the frame by 465. It is the transition object into S10.

## S10 Celebration · 465–510 (15.5–17.0s)
- The bail spins past the lens (465–470), revealing the bowler celebrating: he turns to his teammates and **fist-pumps
  at `fist_pump` (474)**. Teammates run in and one jumps. It's controlled and premium, with no screaming faces.
- The camera orbits fast around the group, with floodlights giving strong rim light, subtle teal lens streaks and the crowd behind.

## S11 Montage · 510–570 (17.0–19.0s)
Ten micro-shots of ~6 frames each, joined by matching motion, not plain cuts: a cover drive (the bat swing becomes a teal
streak) → a bowler appealing (the streak becomes the bowling arm) → a keeper's sharp catch → a fielder diving near the boundary
→ two batsmen sprinting between wickets → the ball hitting the boundary rope (the ball's trajectory becomes the boundary line) →
the ball striking the stumps → bails flying → a player raising his bat to the crowd → a team celebration. The pace accelerates.

## S12 Convergence · 570–630 (19–21s)
The camera moves fast through the stadium as cricket elements wrap around a central axis in a controlled vortex: ball
trajectories, bat-swing arcs, flying bails, grass particles, floodlight beams, teal metallic streaks, boundary LED light
and crowd flashes. Each element turns into clean premium geometry: the bat arc becomes a curved metallic line, the ball trajectory a circular teal ring,
the three stumps three vertical bars, and the player silhouette an abstract cricket figure. The camera pulls back to reveal that they are
assembling the MPL symbol. *(Depends on the official logo.)*

## S13 Logo formation · 630–690 · S14 Logo play · 690–735 · S15 Hero · 735–810
*(Depends on the official logo file. Logo pieces lock at `logo_locks`. In S14 the ball enters from the left, the logo batsman's
bat hits it at `logo_bat_hit` (700), the ball goes through the P opening at `ball_through_p` (708) and hits the L wickets at
`logo_wicket_hit` (716), and a teal pulse runs around the letter edges. In S15 the camera pulls back over the stadium, a deep
hit lands at `final_hit` (740), "MADSOL PREMIER LEAGUE" appears at `title_in` (752), and the logo holds to 810.)*
