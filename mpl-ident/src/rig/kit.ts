/**
 * Kit and skin materials. Patterns (panels, piping, yokes, collar, the small "MPL" chest mark)
 * are procedural in rest-pose space, so they stick to the cloth as the body moves.
 * Materials are cached per kit / tone and shared by every Player.
 */
import * as THREE from "three";
import { PAL } from "../theme";
import { withStadiumRim } from "../world/Lights";

/**
 * Every player material opts into the stadium fresnel rim (Lights.tsx): the dark graphite kit has ~2%
 * albedo and would otherwise never show the broadcast rim on shoulders, helmets and bats. The rim follows
 * the shot's rimDir via the shared uniforms that <StadiumLights/> writes each frame (strength per SPEC:
 * ~1 kit, 0.6 skin, 0.4 white pads/shoes, 0.8 helmet).
 */
const rim = <M extends THREE.MeshStandardMaterial>(m: M, strength: number, power = 3.2): M => withStadiumRim(m, strength, power);

export type KitName = "teal" | "graphite";

const lin = (hex: string) => new THREE.Color(hex);
const glslColor = (c: THREE.Color) => `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;

/** Teal-graphite (batting trousers) and navy-graphite (helmet shell): mixes of palette colours. */
export const KIT_EXTRA = {
  tealGraphite: "#17292d",
  helmetShell: "#1a2230",
};

/** Deep, warm skin tones (seeded per player). */
export const SKIN_TONES = ["#8a5a3e", "#6f4632", "#9e6a4c", "#5e3c2b", "#a8775a", "#7b4e37"];

/* ------------------------------------------------------------------ */
/* Shared GLSL                                                          */
/* ------------------------------------------------------------------ */

const NOISE = /* glsl */ `
float kHash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float kNoise(vec3 x){
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(kHash(i + vec3(0,0,0)), kHash(i + vec3(1,0,0)), f.x), mix(kHash(i + vec3(0,1,0)), kHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(kHash(i + vec3(0,0,1)), kHash(i + vec3(1,0,1)), f.x), mix(kHash(i + vec3(0,1,1)), kHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
// anti-aliased band: 1 inside |d| < w
float kBand(float d, float w){ float fw = max(fwidth(d), 1e-5); return 1.0 - smoothstep(w - fw, w + fw, abs(d)); }
// procedural bump (screen-space derivatives), after three's perturbNormalArb
vec3 kBump(vec3 surf_pos, vec3 surf_norm, float h, float faceDirection){
  vec2 dHdxy = vec2(dFdx(h), dFdy(h));
  vec3 vSigmaX = normalize(dFdx(surf_pos));
  vec3 vSigmaY = normalize(dFdy(surf_pos));
  vec3 vN = surf_norm;
  vec3 R1 = cross(vSigmaY, vN);
  vec3 R2 = cross(vN, vSigmaX);
  float fDet = dot(vSigmaX, R1) * faceDirection;
  vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
  return normalize(abs(fDet) * surf_norm - vGrad);
}
`;

const VERT_PARS = /* glsl */ `
attribute float aPart;
varying vec3 vRest;
varying float vPart;
`;

const patch = (
  m: THREE.Material,
  key: string,
  fragPars: string,
  colorCode: string,
  bumpCode: string | null,
  uniforms: Record<string, THREE.IUniform> = {},
) => {
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERT_PARS}`)
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvRest = position;\nvPart = aPart;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vRest;\nvarying float vPart;\n${NOISE}\n${fragPars}`)
      .replace("#include <color_fragment>", `#include <color_fragment>\n${colorCode}`);
    if (bumpCode)
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>\n{ ${bumpCode} normal = kBump(-vViewPosition, normal, kH, faceDirection); }`,
      );
  };
  m.customProgramCacheKey = () => key;
};

/* ------------------------------------------------------------------ */
/* "MPL" chest mark (the only branding allowed)                        */
/* ------------------------------------------------------------------ */

let markTex: THREE.Texture | null = null;
const getMarkTexture = () => {
  if (markTex) return markTex;
  const W = 256;
  const H = 96;
  const data = new Uint8Array(W * H * 4);
  if (typeof document !== "undefined") {
    const cv = document.createElement("canvas");
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = "bold 78px 'DejaVu Sans', Arial, sans-serif";
      ctx.fillText("MPL", W / 2, H / 2 + 4);
      const img = ctx.getImageData(0, 0, W, H).data;
      // flip Y for GL
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const s = ((H - 1 - y) * W + x) * 4;
          const d = (y * W + x) * 4;
          data[d] = img[s];
          data[d + 1] = img[s];
          data[d + 2] = img[s];
          data[d + 3] = 255;
        }
    }
  }
  const t = new THREE.DataTexture(data, W, H);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  markTex = t;
  return t;
};

/* ------------------------------------------------------------------ */
/* Shirt                                                               */
/* ------------------------------------------------------------------ */

const shirtCache = new Map<KitName, THREE.MeshPhysicalMaterial>();

export const shirtMaterial = (kit: KitName) => {
  const hit = shirtCache.get(kit);
  if (hit) return hit;
  const teal = kit === "teal";
  const base = lin(teal ? PAL.tealDeep : PAL.graphite);
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.78,
    metalness: 0,
    sheen: 0.85,
    sheenRoughness: 0.42,
    sheenColor: teal ? lin(PAL.teal).multiplyScalar(0.55) : lin(PAL.silver).multiplyScalar(0.32),
    specularIntensity: 0.35,
  });
  const graphite = lin(PAL.graphite);
  const white = lin(PAL.white).multiplyScalar(0.86);
  const tealDeep = lin(PAL.tealDeep);
  const tealC = lin(PAL.teal);
  const uMark = { value: getMarkTexture() };
  const color = /* glsl */ `
  {
    vec3 p = vRest;
    float torso = 1.0 - step(0.5, vPart);
    float sleeve = step(0.5, vPart);
    float ax = abs(p.x);
    vec3 col = ${glslColor(base)};
    // ---- angle around the torso: 0 at the side seam, +pi/2 front, -pi/2 back
    float ang = atan(p.z + 0.008, ax);
    float underArm = 1.0 - smoothstep(1.395, 1.425, p.y);
    // ---- sleeve coordinates (rest arm hangs from the shoulder at |x| = 0.18, y = 1.465)
    float s = 1.465 - p.y;
    float inner = (ax - 0.18);
    float hem = smoothstep(0.155, 0.158, s);
    float pipe = 0.0;
    ${
      teal
        ? /* glsl */ `
    // graphite side panels from the hem to the armpit, continuing along the sleeve underside
    float panelT = torso * underArm * (1.0 - smoothstep(0.40, 0.41, abs(ang)));
    float panelS = sleeve * (1.0 - smoothstep(-0.018, -0.012, inner)) * step(0.02, s);
    col = mix(col, ${glslColor(graphite)}, max(panelT, panelS));
    pipe = max(pipe, torso * underArm * kBand(abs(ang) - 0.405, 0.022));
    pipe = max(pipe, sleeve * step(0.02, s) * kBand(inner + 0.015, 0.0016));
    `
        : /* glsl */ `
    // teal shoulder yokes: front and back above a curved line, and the sleeve caps
    float yokeLine = 1.415 + 0.05 * (1.0 - smoothstep(0.0, 0.17, ax)) - 0.012 * step(p.z + 0.02, 0.0);
    float yokeT = torso * smoothstep(yokeLine - 0.002, yokeLine + 0.002, p.y);
    float yokeS = sleeve * (1.0 - smoothstep(0.045, 0.05, s + 0.25 * max(0.0, -inner)));
    col = mix(col, ${glslColor(tealDeep)}, max(yokeT, yokeS));
    pipe = max(pipe, torso * kBand(p.y - yokeLine, 0.0022) * step(ax, 0.2));
    pipe = max(pipe, sleeve * kBand(s + 0.25 * max(0.0, -inner) - 0.0475, 0.0018));
    // slim teal side seam piping
    col = mix(col, ${glslColor(tealC)} * 0.7, torso * underArm * kBand(abs(ang) - 0.0, 0.012));
    `
    }
    // ---- collar: a V-neck band with piping
    float vdip = 0.034 * (1.0 - smoothstep(0.0, 0.06, ax)) * step(0.0, p.z + 0.01);
    float collarY = 1.505 - vdip;
    float collar = torso * smoothstep(collarY - 0.001, collarY + 0.001, p.y + 0.012 * step(0.0, p.z));
    col = mix(col, ${glslColor(teal ? graphite : tealDeep)}, collar);
    pipe = max(pipe, torso * kBand(p.y + 0.012 * step(0.0, p.z) - collarY, 0.0018));
    // ---- sleeve hem: a contrasting cuff with piping
    float cuffY = 0.152;
    col = mix(col, ${glslColor(teal ? graphite : tealDeep)}, sleeve * smoothstep(cuffY - 0.001, cuffY + 0.001, s));
    pipe = max(pipe, sleeve * kBand(s - cuffY, 0.0016));
    // ---- shirt hem: a fine band
    pipe = max(pipe, torso * kBand(p.y - 0.918, 0.0016));
    col = mix(col, ${glslColor(white)}, pipe);
    // ---- "MPL" chest mark, left chest
    vec2 muv = vec2((p.x - 0.052) / 0.06, (p.y - 1.352) / 0.0225);
    float front = torso * step(0.0, p.z) * step(0.0, muv.x) * step(muv.x, 1.0) * step(0.0, muv.y) * step(muv.y, 1.0);
    float mk = texture2D(uMark, muv).r * front;
    col = mix(col, ${glslColor(teal ? white : tealC)}, mk * 0.92);
    // ---- fabric: very fine knit variation
    col *= 0.94 + 0.06 * kNoise(p * 900.0);
    diffuseColor.rgb = col;
  }
  `;
  const bump = /* glsl */ `
    vec3 p = vRest;
    float kH = 0.0;
    float waist = exp(-pow((p.y - 1.0) / 0.06, 2.0));
    kH += 0.0015 * sin(p.y * 260.0 + sin(p.x * 40.0) * 2.0) * waist;
    float armpit = exp(-pow((p.y - 1.38) / 0.05, 2.0)) * smoothstep(0.1, 0.17, abs(p.x));
    kH += 0.0012 * sin((p.y + abs(p.x) * 0.8) * 300.0) * armpit;
    kH += 0.00025 * kNoise(p * 420.0);
    kH *= 8.0;
  `;
  patch(m, `mpl-shirt-${kit}`, "uniform sampler2D uMark;", color, bump, { uMark });
  rim(m, teal ? 0.85 : 1.1);
  shirtCache.set(kit, m);
  return m;
};

/* ------------------------------------------------------------------ */
/* Trousers                                                            */
/* ------------------------------------------------------------------ */

const trouserCache = new Map<KitName, THREE.MeshPhysicalMaterial>();

export const trouserMaterial = (kit: KitName) => {
  const hit = trouserCache.get(kit);
  if (hit) return hit;
  const teal = kit === "teal";
  const base = lin(teal ? PAL.graphite : KIT_EXTRA.tealGraphite);
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.8,
    sheen: 0.8,
    sheenRoughness: 0.45,
    sheenColor: teal ? lin(PAL.silver).multiplyScalar(0.3) : lin(PAL.teal).multiplyScalar(0.35),
    specularIntensity: 0.3,
  });
  const color = /* glsl */ `
  {
    vec3 p = vRest;
    vec3 col = ${glslColor(base)};
    // outer seam piping on the legs (legs are parts == 3 below the seat)
    float leg = step(p.y, 0.86);
    float outer = abs(p.x) - 0.092;
    float side = atan(p.z - 0.0, outer);
    col = mix(col, ${glslColor(lin(PAL.teal))} * 0.75, leg * kBand(side, 0.07) * step(0.0, outer));
    col *= 0.95 + 0.05 * kNoise(p * 800.0);
    diffuseColor.rgb = col;
  }
  `;
  const bump = /* glsl */ `
    vec3 p = vRest;
    float kH = 0.0;
    // creases behind the knees and at the hip front
    float knee = exp(-pow((p.y - 0.51) / 0.045, 2.0));
    kH += 0.0016 * sin(p.y * 210.0 + sin(p.x * 60.0)) * knee;
    float hip = exp(-pow((p.y - 0.86) / 0.04, 2.0)) * step(0.0, p.z);
    kH += 0.0012 * sin((p.y - abs(p.x) * 0.6) * 240.0) * hip;
    kH += 0.0002 * kNoise(p * 420.0);
    kH *= 8.0;
  `;
  patch(m, `mpl-trousers-${kit}`, "", color, bump);
  rim(m, 1.0);
  trouserCache.set(kit, m);
  return m;
};

/* ------------------------------------------------------------------ */
/* Skin, hair, eyes                                                    */
/* ------------------------------------------------------------------ */

const skinCache = new Map<string, THREE.MeshPhysicalMaterial>();

/**
 * Skin. Geometry with an `aHair` attribute (the head) gets painted short hair:
 * dark, rougher, a fine directional grain and a soft hairline.
 */
export const skinMaterial = (tone: string) => {
  const hit = skinCache.get(tone);
  if (hit) return hit;
  const m = new THREE.MeshPhysicalMaterial({
    color: lin(tone),
    roughness: 0.5,
    sheen: 0.35,
    sheenRoughness: 0.5,
    sheenColor: lin(tone).lerp(lin(PAL.warm), 0.5).multiplyScalar(0.6),
    specularIntensity: 0.55,
    clearcoat: 0.08,
    clearcoatRoughness: 0.4,
  });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERT_PARS}\nattribute float aHair;\nvarying float vHair;`)
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvRest = position;\nvPart = aPart;\nvHair = aHair;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vRest;\nvarying float vPart;\nvarying float vHair;\n${NOISE}`)
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        vec3 p = vRest;
        float v = kNoise(p * 60.0) * 0.6 + kNoise(p * 160.0) * 0.4;
        diffuseColor.rgb *= 0.93 + 0.1 * v;
        // painted hair
        float hm = smoothstep(0.08, 0.55, vHair);
        float grain = kNoise(vec3(p.x * 2200.0, p.y * 500.0, p.z * 2200.0)) * 0.6 + kNoise(p * 900.0) * 0.4;
        vec3 hairC = vec3(0.011, 0.009, 0.008) * (0.7 + 0.6 * grain);
        diffuseColor.rgb = mix(diffuseColor.rgb, hairC, hm);`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.72, smoothstep(0.08, 0.55, vHair));",
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
        { float kH = smoothstep(0.1, 0.6, vHair) * 0.0012 * kNoise(vec3(vRest.x * 1800.0, vRest.y * 400.0, vRest.z * 1800.0)) * 8.0;
          normal = kBump(-vViewPosition, normal, kH, faceDirection); }`,
      );
  };
  m.customProgramCacheKey = () => "mpl-skin-hair";
  rim(m, 0.55, 3.6);
  skinCache.set(tone, m);
  return m;
};

const matCache = new Map<string, THREE.Material>();
const cached = <T extends THREE.Material>(key: string, make: () => T): T => {
  const hit = matCache.get(key);
  if (hit) return hit as T;
  const m = make();
  matCache.set(key, m);
  return m;
};

export const hairMaterial = () =>
  cached(
    "hair",
    () =>
      new THREE.MeshPhysicalMaterial({
        color: lin("#0e0b0a"),
        roughness: 0.62,
        sheen: 0.7,
        sheenRoughness: 0.35,
        sheenColor: lin("#5a4c44"),
        specularIntensity: 0.4,
      }),
  );

export const eyeMaterial = () =>
  cached("eye", () => {
    const m = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.05 });
    m.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vLocal;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvLocal = position;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vLocal;")
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          vec3 n = normalize(vLocal);
          float iris = smoothstep(0.70, 0.74, n.z);
          float pupil = smoothstep(0.91, 0.93, n.z);
          vec3 sclera = vec3(0.30, 0.27, 0.25);
          vec3 irisC = vec3(0.045, 0.028, 0.018);
          diffuseColor.rgb = mix(mix(sclera, irisC, iris), vec3(0.008), pupil);`,
        );
    };
    m.customProgramCacheKey = () => "mpl-eye";
    return m;
  });

/* ------------------------------------------------------------------ */
/* Footwear and gear                                                   */
/* ------------------------------------------------------------------ */

export const shoeMaterial = () =>
  cached("shoe", () => {
    const m = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.42,
      clearcoat: 0.35,
      clearcoatRoughness: 0.35,
      specularIntensity: 0.5,
    });
    const color = /* glsl */ `
    {
      vec3 p = vRest;
      vec3 col = ${glslColor(lin(PAL.white).multiplyScalar(0.82))};
      // graphite heel counter and a teal accent line along the side
      float heel = smoothstep(-0.035, -0.045, p.z) * smoothstep(-0.07, -0.06, p.y);
      col = mix(col, ${glslColor(lin(PAL.graphite))}, heel);
      float stripe = kBand(p.y + 0.052 - p.z * 0.12, 0.0022) * step(0.035, abs(p.x)) * step(-0.03, p.z) * step(p.z, 0.15);
      col = mix(col, ${glslColor(lin(PAL.teal))}, stripe);
      diffuseColor.rgb = col;
    }
    `;
    patch(m, "mpl-shoe", "", color, null);
    return rim(m, 0.35);
  });

export const soleMaterial = () =>
  cached("sole", () => rim(new THREE.MeshPhysicalMaterial({ color: lin(PAL.tealDeep).lerp(lin(PAL.teal), 0.35), roughness: 0.55, clearcoat: 0.2 }), 0.4));

export const capMaterial = () =>
  cached(
    "cap",
    () =>
      rim(
        new THREE.MeshPhysicalMaterial({
          color: lin(PAL.graphite),
          roughness: 0.82,
          sheen: 0.6,
          sheenRoughness: 0.5,
          sheenColor: lin(PAL.silver).multiplyScalar(0.25),
          side: THREE.DoubleSide,
        }),
        0.9,
      ),
  );

export const helmetMaterial = () =>
  cached(
    "helmet",
    () =>
      rim(
        new THREE.MeshPhysicalMaterial({
          color: lin(KIT_EXTRA.helmetShell),
          roughness: 0.32,
          metalness: 0.25,
          clearcoat: 1,
          clearcoatRoughness: 0.08,
          side: THREE.DoubleSide,
        }),
        0.8,
      ),
  );

export const grilleMaterial = () =>
  cached("grille", () => new THREE.MeshStandardMaterial({ color: lin(PAL.silver), metalness: 1, roughness: 0.26 }));

export const neckGuardMaterial = () =>
  cached(
    "neckguard",
    () =>
      rim(
        new THREE.MeshPhysicalMaterial({
          color: lin(PAL.tealDeep).lerp(lin(PAL.teal), 0.3),
          roughness: 0.45,
          clearcoat: 0.6,
          side: THREE.DoubleSide,
        }),
        0.7,
      ),
  );

export const padMaterial = (keeper = false) =>
  cached("pad" + keeper, () => {
    const m = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.55,
      sheen: 0.4,
      sheenColor: lin("#ffffff").multiplyScalar(0.3),
      clearcoat: 0.15,
      side: THREE.DoubleSide,
    });
    const color = /* glsl */ `
    {
      vec3 p = vRest;
      vec3 col = ${glslColor(lin(PAL.white).multiplyScalar(0.83))};
      // straps on the outside of the pad (left pad: outside is +x; mirrored pads flip x too)
      float strap = 0.0;
      strap = max(strap, kBand(p.y + 0.06, 0.012));
      strap = max(strap, kBand(p.y + 0.2, 0.012));
      strap = max(strap, kBand(p.y + 0.33, 0.012));
      strap *= smoothstep(0.03, 0.06, p.x);
      col = mix(col, ${glslColor(lin(PAL.graphite))}, strap);
      // teal accent on the knee roll
      col = mix(col, ${glslColor(lin(PAL.tealDeep))}, kBand(p.y - 0.035, 0.004) * ${keeper ? "0.0" : "1.0"});
      diffuseColor.rgb = col;
    }
    `;
    patch(m, "mpl-pad" + keeper, "", color, null);
    return rim(m, 0.35);
  });

/** Batting glove (white leather, graphite and teal accents) or keeper glove. */
export const gloveMaterial = (keeper = false) =>
  cached("glove" + keeper, () => {
    const m = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.5,
      sheen: 0.4,
      sheenColor: lin("#ffffff").multiplyScalar(0.25),
      clearcoat: 0.2,
    });
    const color = /* glsl */ `
    {
      vec3 p = vRest;
      vec3 col = ${glslColor(lin(PAL.white).multiplyScalar(0.8))};
      // back of the hand (x < 0 in right-hand space) carries a graphite panel
      float back = smoothstep(0.004, -0.004, p.x) * step(-0.09, p.y) * step(p.y, 0.0);
      col = mix(col, ${glslColor(lin(keeper ? PAL.tealDeep : PAL.graphite))}, back * ${keeper ? "0.9" : "0.85"});
      diffuseColor.rgb = col;
    }
    `;
    patch(m, "mpl-glove" + keeper, "", color, null);
    return rim(m, 0.4);
  });

export const gloveCuffMaterial = () =>
  cached("glovecuff", () => rim(new THREE.MeshPhysicalMaterial({ color: lin(PAL.tealDeep), roughness: 0.55, sheen: 0.5, sheenColor: lin(PAL.teal).multiplyScalar(0.4) }), 0.7));

export const webbingMaterial = () =>
  cached(
    "webbing",
    () => new THREE.MeshPhysicalMaterial({ color: lin(PAL.graphite), roughness: 0.6, side: THREE.DoubleSide }),
  );
