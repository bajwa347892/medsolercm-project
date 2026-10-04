# iDental Billing: 25-second motion piece

A 1920×1080, 30fps, 25-second motion graphics video for iDental Billing, built in [Remotion](https://www.remotion.dev) (React).

Final render: `out/iDentalBilling-25s.mp4`

## Story

| Time | Scene | On-screen text |
|---|---|---|
| 0.0–5.0s | Problem | "Denied claims pile up." / "AR ages while your team sits on hold." |
| 5.0–9.0s | Turn | "iDental Billing" / "One team runs the full revenue cycle." / "Nothing gets lost between handoffs." |
| 9.0–16.0s | Process | "Every claim, start to finish." / six pipeline stages: Insurance verified, CDT coded, Clean claim sent, Payment posted, Denial appealed, AR worked |
| 16.0–21.0s | Proof | 98.7% net collection rate vs. industry average 91% to 95%; 98% clean claim rate; 21 days average in AR |
| 21.0–25.0s | Payoff | "Good dentistry deserves better billing." / iDental Billing / "Get your free billing review" / "No setup fees. No long-term contracts." |

The piece is one continuous take. Elements carry across scenes instead of cutting:

- the top denied claim card flips into a clean claim, rides the pipeline, then glides into the 98.7% figure
- the aging-report bar shrinks into the pipeline track, which becomes the chart axis
- the "one team" ring unrolls into the pipeline; its six stage dots become the axis ticks
- the 98.7% bar and its marker become the accent rule under the closing line

Every scene-to-scene morph runs 0.4 to 0.8 seconds, and every headline stays readable for at least 1.5 seconds after it lands.

## Project layout

- `src/timeline.ts`: every timing and position constant, in frames (30fps)
- `src/IDentalBilling.tsx`: the composition and headline schedule
- `src/layers/`: background, claim cards, pipeline and axis morphs, proof stats, opening and closing
- `public/fonts/`: Inter and JetBrains Mono (SIL Open Font License), bundled so renders work offline

## Commands

```bash
npm install
npm run dev                      # Remotion Studio preview
npx remotion render IDentalBilling out/iDentalBilling-25s.mp4
```

In this repository's cloud environment, point Remotion at the preinstalled browser first:

```bash
export REMOTION_BROWSER=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell
```
