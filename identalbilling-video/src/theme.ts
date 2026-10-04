import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";

// Fonts ship with the project (variable woff2, latin subset), so renders
// never depend on network access.
export const inter = "Inter";
export const mono = "JetBrains Mono";

loadFont({
  family: inter,
  url: staticFile("fonts/Inter-latin-var.woff2"),
  weight: "100 900",
  format: "woff2",
});
loadFont({
  family: mono,
  url: staticFile("fonts/JetBrainsMono-latin-var.woff2"),
  weight: "100 800",
  format: "woff2",
});

export const C = {
  orange: "#F47521",
  orangeHi: "#FF9447",
  orangeDeep: "#D9600F",
  navy: "#0A1628",
  navyMid: "#10213B",
  navyHi: "#1A3155",
  charcoal: "#111317",
  white: "#FFFFFF",
  // Greys for the "before" world. Color only arrives with iDental Billing.
  g1: "#9CA2AB",
  g2: "#737983",
  g3: "#555A63",
  g4: "#3B3F46",
  cardDark: "#1C1F25",
  cardDarkLine: "#2C3038",
};
