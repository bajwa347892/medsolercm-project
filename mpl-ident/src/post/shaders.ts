/**
 * GLSL for the post pipeline (src/post/pipeline.ts). All passes are fullscreen triangles.
 * Units: CoC values are signed blur RADII in DOF-buffer pixels (negative = in front of focus).
 */

export const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Shared depth + thin-lens circle of confusion. */
const COC_GLSL = /* glsl */ `
uniform float uNear;
uniform float uFar;
uniform float uFocus;     // focus plane distance (m)
uniform float uRange;     // half depth of the fully sharp zone (m)
uniform float uAperture;  // blur radius at infinity (DOF-buffer px)
uniform float uMaxCoC;    // clamp (DOF-buffer px)
float linDepth(float d) {
  return (uNear * uFar) / (uFar - d * (uFar - uNear));
}
// thin lens: blur ~ |z - s| / z, with a sharp plateau of +-uRange around the focus plane
float cocAt(float z) {
  float dz = abs(z - uFocus) - uRange;
  float c = uAperture * max(dz, 0.0) / max(z, 1e-3);
  return min(c, uMaxCoC) * (z < uFocus ? -1.0 : 1.0);
}
`;

/** Full res -> DOF buffer: rgb = colour (box of the footprint), a = signed CoC of the nearest depth. */
export const COC_FRAG = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 uFoot;
varying vec2 vUv;
${COC_GLSL}
void main() {
  vec2 uv0 = vUv + vec2(-uFoot.x, -uFoot.y);
  vec2 uv1 = vUv + vec2(uFoot.x, -uFoot.y);
  vec2 uv2 = vUv + vec2(-uFoot.x, uFoot.y);
  vec2 uv3 = vUv + uFoot;
  vec3 c = texture2D(tColor, uv0).rgb + texture2D(tColor, uv1).rgb + texture2D(tColor, uv2).rgb + texture2D(tColor, uv3).rgb;
  float d = min(min(texture2D(tDepth, uv0).r, texture2D(tDepth, uv1).r), min(texture2D(tDepth, uv2).r, texture2D(tDepth, uv3).r));
  gl_FragColor = vec4(min(c * 0.25, vec3(400.0)), cocAt(linDepth(d)));
}
`;

/** DOF buffer -> tiles (16x16 buffer px): r = max |CoC| in the tile. */
export const TILE_FRAG = /* glsl */ `
uniform sampler2D tCoc;
uniform ivec2 uSize;
void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * 16;
  float m = 0.0;
  for (int y = 0; y < 16; y++) {
    for (int x = 0; x < 16; x++) {
      ivec2 p = min(base + ivec2(x, y), uSize - 1);
      m = max(m, abs(texelFetch(tCoc, p, 0).a));
    }
  }
  gl_FragColor = vec4(m, 0.0, 0.0, 1.0);
}
`;

/** 5x5 max of the tile texture (near-field blur can spread across tile borders; sampled bilinearly). */
export const DILATE_FRAG = /* glsl */ `
uniform sampler2D tTile;
uniform ivec2 uSize;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float m = 0.0;
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      ivec2 p = clamp(c + ivec2(x, y), ivec2(0), uSize - 1);
      m = max(m, texelFetch(tTile, p, 0).r);
    }
  }
  gl_FragColor = vec4(m, 0.0, 0.0, 1.0);
}
`;

export const GATHER_TAPS = 80;

/**
 * Scatter-as-gather bokeh (after Gustafsson / Jimenez) on a golden-angle disc, at DOF-buffer res.
 * A sample contributes when its own blur radius reaches this pixel; samples behind a sharper centre
 * are clamped so a blurred background never bleeds over an in-focus subject. Bright samples get a
 * small weight boost so out-of-focus lamps read as clean bokeh discs.
 * Output: rgb = blurred colour, a = share of that colour that is foreground (near-field) blur.
 */
export const GATHER_FRAG = /* glsl */ `
#define N ${GATHER_TAPS}
uniform sampler2D tCoc;
uniform sampler2D tTile;
uniform vec2 uTexel;
uniform vec3 uKernel[N];
uniform float uBoost;
varying vec2 vUv;
// reversible highlight compression: averaging in this space keeps lamp discs bright inside but stops
// single HDR taps from speckling their edges
const float HK = 8.0;
vec3 comp(vec3 x) { return x / (1.0 + max(x.r, max(x.g, x.b)) / HK); }
vec3 expand(vec3 y) { return y / max(1.0 - max(y.r, max(y.g, y.b)) / HK, 0.02); }
void main() {
  vec4 c = texture2D(tCoc, vUv);
  float R = texture2D(tTile, vUv).r;
  if (R < 0.6) {
    gl_FragColor = vec4(c.rgb, 0.0);
    return;
  }
  float cR = abs(c.a);
  // fewer taps for small blur (the first n points of the spiral, rescaled to the full disc); the
  // biggest discs (macro bokeh) get the full spiral so their rims stay clean
  int n = R < 3.5 ? 16 : (R < 8.0 ? 32 : (R < 13.0 ? 48 : N));
  float ks = sqrt(float(N) / float(n));
  float spread = max(0.5, R * 0.7 / sqrt(float(n)));
  // per-pixel kernel rotation (interleaved gradient noise): sampling steps become fine noise that
  // the fill pass removes, instead of visible contours
  vec3 p3 = fract(vec3(gl_FragCoord.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  float ign = fract((p3.x + p3.y) * p3.z);
  float ang = ign * 6.2831853;
  mat2 rot = mat2(cos(ang), sin(ang), -sin(ang), cos(ang));
  vec3 cc = comp(c.rgb);
  float keep = 1.0 - smoothstep(0.5, 2.5, cR);
  vec3 acc = cc;
  float wsum = 1.0;
  float nearW = 0.0;
  for (int i = 0; i < N; i++) {
    if (i >= n) break;
    vec3 k = uKernel[i] * ks;
    float r = k.z * R;
    vec4 s = texture2D(tCoc, vUv + (rot * k.xy) * (R * uTexel));
    float sR = abs(s.a);
    // a farther sample may not spread over a sharper (nearer) centre; behind a blurred
    // foreground centre it shows through the foreground's own blur radius (soft inner edge)
    if (s.a > c.a) sR = c.a < -0.5 ? cR : min(sR, cR * 2.0);
    float cover = smoothstep(r - spread, r + spread, sR) * step(0.5, sR);
    float lum = dot(s.rgb, vec3(0.2126, 0.7152, 0.0722));
    float w = cover * (1.0 + uBoost * smoothstep(1.0, 8.0, lum));
    // uncovered taps keep the centre colour for a sharp centre (so it only takes the share of
    // foreground blur that really reaches it); for a blurred centre they are simply dropped, so a
    // sharp occluder (the subject) never freezes background detail next to its silhouette
    float u = (1.0 - cover) * keep;
    acc += comp(s.rgb) * w + cc * u;
    wsum += w + u;
    nearW += w * step(s.a, -0.75) * step(s.a, c.a - 0.25);
  }
  gl_FragColor = vec4(expand(acc / wsum), nearW / wsum);
}
`;

/** Post-filter that removes the gather noise inside discs and along near-field edges. */
export const FILL_FRAG = /* glsl */ `
uniform sampler2D tGather;
uniform sampler2D tTile;
uniform sampler2D tCoc;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec4 g = texture2D(tGather, vUv);
  float R = texture2D(tTile, vUv).r;
  // filter only blurred pixels and foreground spill; sharp pixels must pass through untouched
  float need = smoothstep(1.0, 2.5, max(abs(texture2D(tCoc, vUv).a), g.a * R));
  if (R < 1.5 || need <= 0.0) { gl_FragColor = g; return; }
  vec2 o = uTexel * clamp(R * 0.17, 0.75, 4.2);
  vec4 s = g * 2.0;
  s += texture2D(tGather, vUv + vec2(o.x, 0.0));
  s += texture2D(tGather, vUv - vec2(o.x, 0.0));
  s += texture2D(tGather, vUv + vec2(0.0, o.y));
  s += texture2D(tGather, vUv - vec2(0.0, o.y));
  s += texture2D(tGather, vUv + vec2(o.x, o.y) * 0.7071);
  s += texture2D(tGather, vUv - vec2(o.x, o.y) * 0.7071);
  s += texture2D(tGather, vUv + vec2(o.x, -o.y) * 0.7071);
  s += texture2D(tGather, vUv - vec2(o.x, -o.y) * 0.7071);
  gl_FragColor = mix(g, s / 10.0, need);
}
`;

/**
 * Full res: sharp scene + blurred buffer, blended by this pixel's own CoC and the foreground spill.
 * The half-res buffer is upsampled bilaterally (texels whose CoC differs from this pixel's are
 * down-weighted), so background blur never picks up the sharp subject's edge texels and vice versa.
 */
export const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tSharp;
uniform sampler2D tBlur;
uniform sampler2D tCoc;
uniform sampler2D tDepth;
uniform vec2 uBufSize;
varying vec2 vUv;
${COC_GLSL}
void main() {
  vec3 sharp = texture2D(tSharp, vUv).rgb;
  float ownS = cocAt(linDepth(texture2D(tDepth, vUv).r));
  float own = abs(ownS);
  float tol = 0.35 + 0.15 * own;
  // fast path: plain bilinear wherever the buffer agrees with this pixel's CoC (almost everywhere)
  vec4 cl = texture2D(tCoc, vUv);
  if (abs(cl.a - ownS) < tol * 0.5) {
    vec4 bl = texture2D(tBlur, vUv);
    vec3 sp = max(bl.rgb + (1.0 - bl.a) * (sharp - cl.rgb), 0.0);
    gl_FragColor = vec4(mix(sp, bl.rgb, smoothstep(0.3, 1.2, own)), 1.0);
    return;
  }
  vec2 p = vUv * uBufSize - 0.5;
  vec2 f = fract(p);
  vec2 t = 1.0 / uBufSize;
  vec2 b0 = (floor(p) + 0.5) * t;
  vec2 uvs[4];
  uvs[0] = b0;
  uvs[1] = b0 + vec2(t.x, 0.0);
  uvs[2] = b0 + vec2(0.0, t.y);
  uvs[3] = b0 + t;
  float bil[4];
  bil[0] = (1.0 - f.x) * (1.0 - f.y);
  bil[1] = f.x * (1.0 - f.y);
  bil[2] = (1.0 - f.x) * f.y;
  bil[3] = f.x * f.y;
  vec4 bs = vec4(0.0);
  vec3 cs = vec3(0.0);
  vec4 bb = vec4(0.0);
  vec3 cb = vec3(0.0);
  float ws = 0.0;
  for (int i = 0; i < 4; i++) {
    vec4 bi = texture2D(tBlur, uvs[i]);
    vec4 ci = texture2D(tCoc, uvs[i]);
    float dd = (ci.a - ownS) / tol;
    float w = bil[i] / (1.0 + dd * dd * dd * dd);
    bs += bi * w;
    cs += ci.rgb * w;
    ws += w;
    bb += bi * bil[i];
    cb += ci.rgb * bil[i];
  }
  vec4 b = ws > 1e-3 ? bs / ws : bb;
  vec3 ctr = ws > 1e-3 ? cs / ws : cb;
  // sharp pixel: full-res detail plus exactly the foreground spill the gather found
  vec3 sharpSpill = max(b.rgb + (1.0 - b.a) * (sharp - ctr), 0.0);
  gl_FragColor = vec4(mix(sharpSpill, b.rgb, smoothstep(0.3, 1.2, own)), 1.0);
}
`;

/** Bloom bright pass at bloom-buffer res: soft-knee threshold (only lamps, LEDs, hot highlights). */
export const BRIGHT_FRAG = /* glsl */ `
uniform sampler2D tColor;
uniform vec2 uFoot;
uniform float uThreshold;
uniform float uKnee;
varying vec2 vUv;
vec3 pick(vec2 uv) {
  vec3 c = texture2D(tColor, uv).rgb;
  float l = max(c.r, max(c.g, c.b));
  float soft = clamp(l - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  float w = max(soft, l - uThreshold) / max(l, 1e-4);
  return c * w;
}
void main() {
  vec3 c = pick(vUv + vec2(-uFoot.x, -uFoot.y)) + pick(vUv + vec2(uFoot.x, -uFoot.y))
         + pick(vUv + vec2(-uFoot.x, uFoot.y)) + pick(vUv + uFoot);
  gl_FragColor = vec4(min(c * 0.25, vec3(60.0)), 1.0);
}
`;

export const MAX_STREAKS = 12;

/**
 * Streak source visibility, one output texel per source: r = visible fraction of a small disc around
 * the source (depth test against the scene), g = mean luminance of what is visible there.
 */
export const STREAK_VIS_FRAG = /* glsl */ `
#define M ${MAX_STREAKS}
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec4 uSrc[M];   // xy = uv, z = view distance (m), w = intensity (0 = unused)
uniform vec2 uTexel;
uniform float uNear;
uniform float uFar;
float linDepth(float d) { return (uNear * uFar) / (uFar - d * (uFar - uNear)); }
void main() {
  int i = int(gl_FragCoord.x);
  vec4 s = uSrc[0];
  for (int k = 0; k < M; k++) { if (k == i) s = uSrc[k]; }
  if (s.w <= 0.0 || s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0) {
    gl_FragColor = vec4(0.0);
    return;
  }
  float vis = 0.0;
  float lum = 0.0;
  float tol = max(1.0, s.z * 0.03);
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      vec2 uv = s.xy + vec2(float(x), float(y)) * uTexel * 2.0;
      float z = linDepth(texture2D(tDepth, uv).r);
      float v = step(s.z - tol, z);
      vis += v;
      lum += v * dot(texture2D(tColor, uv).rgb, vec3(0.2126, 0.7152, 0.0722));
    }
  }
  gl_FragColor = vec4(vis / 25.0, lum / max(vis, 1.0), 0.0, 1.0);
}
`;

/**
 * Final pass to screen: edge chromatic aberration, bloom, anamorphic streaks, exposure + flash,
 * vignette, ACES filmic (three.js' exact curve), colour grade, film grain and dither.
 */
export const FINISH_FRAG = /* glsl */ `
#define M ${MAX_STREAKS}
uniform sampler2D tColor;
uniform sampler2D tBloom;
uniform sampler2D tStreakVis;
uniform vec2 uRes;
uniform float uExposure;
uniform float uFlash;
uniform float uBloom;
uniform float uChroma;
uniform float uVignette;
uniform float uGrain;
uniform float uFrame;
uniform float uGradeAmt;
uniform vec3 uLift;
uniform float uGamma;
uniform vec3 uGain;
uniform float uContrast;
uniform float uPivot;
uniform float uSat;
uniform float uGrass;
uniform int uStreakN;
uniform vec4 uStreakSrc[M];   // xy = uv, z = length (frame heights), w = intensity
uniform float uStreakBlur[M]; // depth-of-field blur radius at the source (frame heights)
uniform vec3 uStreakCore;
uniform vec3 uStreakTint;
uniform int uDebug;
uniform bool uEncoded;
varying vec2 vUv;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 acesFilmic(vec3 color) {
  const mat3 ACESInputMat = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777));
  const mat3 ACESOutputMat = mat3(
    vec3(1.60475, -0.10208, -0.00327),
    vec3(-0.53108, 1.10813, -0.07276),
    vec3(-0.07367, -0.00605, 1.07602));
  color *= 1.0 / 0.6;
  color = ACESInputMat * color;
  color = RRTAndODTFit(color);
  color = ACESOutputMat * color;
  return clamp(color, 0.0, 1.0);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
// cubic S-curve around a pivot: slope uContrast at the pivot, 0 and 1 stay fixed, monotonic
vec3 contrastCurve(vec3 x, float c, float p) {
  float a = clamp((c - 1.0) / (p * (1.0 - p)), -1.2, 1.2);
  return x + a * (x - p) * x * (1.0 - x);
}

// exact sRGB transfer (the grade works on display values, like a colourist would)
vec3 toSRGB(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 fromSRGB(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

vec3 grade(vec3 x) {
  float y = dot(x, LUMA);
  float mx = max(x.r, max(x.g, x.b));
  float mn = min(x.r, min(x.g, x.b));
  float sat = (mx - mn) / max(mx, 1e-4);
  // lift: cool teal shadows; saturated hues (grass, skin, the red ball) are protected
  float sh = 1.0 - smoothstep(0.0, 0.45, y);
  sh *= sh;
  float protect = 1.0 - 0.75 * smoothstep(0.12, 0.45, sat);
  x = x + uLift * sh * protect;
  // gamma: mids
  if (uGamma != 1.0) x = pow(max(x, 0.0), vec3(1.0 / uGamma));
  // gain: slightly warm highlights only
  float hi = smoothstep(0.5, 1.0, y);
  x *= mix(vec3(1.0), uGain, hi);
  x = clamp(x, 0.0, 1.0);
  // natural grass: floodlit turf drifts toward synthetic emerald through ACES; green-dominant hues lose
  // a little saturation and turn a few degrees toward yellow. Teal (blue >= green), skin and the red
  // ball (red is the max) are untouched.
  if (uGrass > 0.0) {
    float gx = max(x.r, max(x.g, x.b));
    float gn = min(x.r, min(x.g, x.b));
    float ch = gx - gn;
    float gw = step(x.r, x.g) * step(x.b, x.g) * smoothstep(0.03, 0.15, ch);
    float h = (x.b - x.r) / max(ch, 1e-4);
    gw *= (1.0 - smoothstep(0.25, 0.8, h)) * uGrass;
    float gy = dot(x, LUMA);
    x = mix(x, mix(vec3(gy), x, 0.9), gw);
    x.r += gw * ch * 0.06;
  }
  x = contrastCurve(x, uContrast, uPivot);
  float y2 = dot(x, LUMA);
  return clamp(mix(vec3(y2), x, uSat), 0.0, 1.0);
}

void main() {
  vec2 uv = vUv;
  float aspect = uRes.x / uRes.y;
  vec2 d = uv - 0.5;
  vec2 dc = vec2(d.x * aspect, d.y);
  float r2 = dot(dc, dc) / (0.25 * (aspect * aspect + 1.0)); // 0 centre .. 1 corner

  // chromatic aberration: radial, only toward the frame edges
  float k = uChroma * 0.0028 * r2 * r2;
  vec3 col;
  if (k * length(d) * uRes.x > 0.12) {
    col.r = texture2D(tColor, 0.5 + d * (1.0 + k)).r;
    col.g = texture2D(tColor, uv).g;
    col.b = texture2D(tColor, 0.5 + d * (1.0 - k)).b;
  } else {
    col = texture2D(tColor, uv).rgb;
  }

  vec3 bloom = texture2D(tBloom, uv).rgb;
  col += bloom * (uBloom * 0.14);

  // anamorphic streaks: thin horizontal core + soft sheath, white at the source fading to teal
  for (int i = 0; i < M; i++) {
    if (i >= uStreakN) break;
    vec4 s = uStreakSrc[i];
    float dy = (uv.y - s.y);
    if (abs(dy) > 0.04 + uStreakBlur[i]) continue;
    float dx = (uv.x - s.x) * aspect;
    float L = s.z;
    float ax = abs(dx) / L;
    if (ax > 5.0) continue;
    vec2 v = texture2D(tStreakVis, vec2((float(i) + 0.5) / float(M), 0.5)).rg;
    float g = s.w * v.r * clamp(v.g / 8.0, 0.0, 1.5);
    if (g <= 0.0) continue;
    // an optical streak, not a drawn line: the hot core is thickest at the lamp and thins out along
    // its length, a soft halo hugs the source, and the long tail dies away before the frame edge
    float along = exp(-ax * 2.4) + 0.1 * exp(-ax * 1.1);
    // a defocused lamp streaks softly: the profile widens with the blur at the source and its peak
    // drops (by the square root, so a soft streak still reads across a bokeh disc)
    float bl = uStreakBlur[i] * 0.22;
    float sig0 = 0.0013 * (1.0 + 1.4 * exp(-ax * 3.0));
    float sig = sqrt(sig0 * sig0 + bl * bl);
    float sh = sqrt(0.0045 * 0.0045 + bl * bl);
    float core = along * exp(-dy * dy / (sig * sig)) * sqrt(sig0 / sig);
    float halo = exp(-ax * 2.2) * exp(-dy * dy / (0.011 * 0.011 + bl * bl));
    float sheath = exp(-ax * 1.6) * exp(-dy * dy / (sh * sh)) * sqrt(0.0045 / sh);
    vec3 tint = mix(uStreakCore, uStreakTint, smoothstep(0.03, 0.5, ax));
    col += tint * g * (core * 1.7 + sheath * 0.22 + halo * 0.07);
  }

  col *= uExposure * (1.0 + 0.6 * uFlash);
  col += uFlash * 0.012 * vec3(1.0, 0.985, 0.96);

  // vignette (optical falloff, before the tone curve)
  col *= 1.0 - uVignette * 0.38 * smoothstep(0.12, 1.05, r2);

  vec3 t = acesFilmic(col);
  vec3 g = toSRGB(t);
  if (uGradeAmt > 0.0) g = mix(g, grade(g), uGradeAmt);

  // film grain in display space (frame-seeded, resolution independent)
  if (uGrain > 0.0) {
    float cell = max(1.0, uRes.y / 1080.0) * 1.15;
    vec2 gp = gl_FragCoord.xy / cell;
    float seed = fract(uFrame * 0.6180339) * 913.0;
    vec2 cellId = floor(gp);
    // triangular-distributed per-cell noise (two hashes): fine, film-like, cheap
    float n = (hash12(cellId + seed) + hash12(cellId + seed + 57.31) - 1.0) * 0.9;
    float y = dot(g, LUMA);
    float m = mix(0.35, 1.0, smoothstep(0.02, 0.22, y)) * (1.0 - 0.6 * smoothstep(0.6, 1.0, y));
    g += n * 0.04 * uGrain * m;
  }
  g += (hash12(gl_FragCoord.xy + fract(uFrame * 0.37) * 101.0) - 0.5) / 255.0;

  if (uDebug == 2) g = toSRGB(bloom * 0.5);

  // g is already display-encoded (sRGB); decode only if the canvas is not an sRGB output
  gl_FragColor = vec4(uEncoded ? clamp(g, 0.0, 1.0) : fromSRGB(clamp(g, 0.0, 1.0)), 1.0);
}
`;

/** Debug view: CoC as colour (red = near blur, blue = far blur, black = sharp). */
export const COC_DEBUG_FRAG = /* glsl */ `
uniform sampler2D tSharp;
uniform sampler2D tDepth;
varying vec2 vUv;
${COC_GLSL}
void main() {
  float c = cocAt(linDepth(texture2D(tDepth, vUv).r)) / max(uMaxCoC, 1e-3);
  vec3 s = texture2D(tSharp, vUv).rgb;
  float y = dot(s / (1.0 + s), vec3(0.3333));
  vec3 col = vec3(y * 0.35) + vec3(max(-c, 0.0), 0.0, max(c, 0.0));
  if (abs(c) < 0.03) col += vec3(0.0, 0.35, 0.0);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;
