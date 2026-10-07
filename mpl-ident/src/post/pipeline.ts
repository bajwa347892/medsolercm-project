/**
 * Synchronous post pipeline (no React state, no effects): built once per renderer and driven from a
 * priority-1 useFrame in <Post/>. It exists because @react-three/postprocessing's <EffectComposer>
 * creates its composer in a useEffect, i.e. after Remotion has already advanced the frame, so the
 * first frame every render tab draws (and every still) comes out black.
 *
 * Passes per frame (B = DOF/bloom buffer: half res, capped at 540 lines so 1080p and 4K match):
 *   scene  -> sceneRT (full res, 4x MSAA, packed float R11F_G11F_B10F, depth texture)
 *   DOF    -> coc (B) -> tile max (B/16) -> dilate -> gather (B) -> fill (B) -> composite (full)   [focus only]
 *   bloom  -> bright pass (B) -> postprocessing MipmapBlurPass (6 levels)                           [bloom > 0]
 *   streak -> visibility of each source (12x1)                                                     [sources only]
 *   finish -> screen: CA, bloom, streaks, exposure/flash, vignette, ACES, grade, grain, dither
 * Everything is a pure function of the scene, camera and params: no temporal accumulation.
 */
import * as THREE from "three";
import { MipmapBlurPass } from "postprocessing";
import {
  BRIGHT_FRAG,
  COC_DEBUG_FRAG,
  COC_FRAG,
  COMPOSITE_FRAG,
  DILATE_FRAG,
  FILL_FRAG,
  FINISH_FRAG,
  FS_VERT,
  GATHER_FRAG,
  GATHER_TAPS,
  MAX_STREAKS,
  STREAK_VIS_FRAG,
  TILE_FRAG,
} from "./shaders";

export type GradeParams = {
  /** additive shadow tint in display space (cool teal) */
  lift: [number, number, number];
  /** mid-tone gamma (>1 brighter) */
  gamma: number;
  /** highlight multiplier (slightly warm) */
  gain: [number, number, number];
  /** contrast: slope of the S-curve at the pivot (1 = none) */
  contrast: number;
  /** contrast pivot in display space */
  pivot: number;
  /** saturation (1 = unchanged) */
  saturation: number;
  /** 0..1 natural-grass correction: green-dominant hues -10% saturation, a few degrees toward yellow */
  grass: number;
};

/** The house grade: cool-teal shadows, neutral mids, slightly warm highlights, gentle contrast. */
export const HOUSE_GRADE: GradeParams = {
  lift: [-0.006, 0.009, 0.014],
  gamma: 1.0,
  gain: [1.035, 1.0, 0.955],
  contrast: 1.12,
  pivot: 0.38,
  saturation: 1.02,
  grass: 1,
};

export type ResolvedStreak = { pos: THREE.Vector3; intensity: number; length: number };

export type PostParams = {
  focus: THREE.Vector3 | null;
  focusRange: number;
  /** blur radius at infinity, fraction of frame height */
  aperture: number;
  /** max blur radius, fraction of frame height */
  maxBlur: number;
  bokeh: number;
  bloom: number;
  bloomThreshold: number;
  bloomKnee: number;
  bloomRadius: number;
  flash: number;
  grain: number;
  vignette: number;
  chroma: number;
  grade: number;
  gradeParams: GradeParams;
  exposure: number;
  streaks: ResolvedStreak[];
  streakCore: THREE.Color;
  streakTint: THREE.Color;
  frame: number;
  debug: 0 | 1 | 2;
};

const mat = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) =>
  new THREE.ShaderMaterial({
    vertexShader: FS_VERT,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    blending: THREE.NoBlending,
  });

const rt = (w: number, h: number, filter: THREE.MagnificationTextureFilter = THREE.LinearFilter) =>
  new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    minFilter: filter,
    magFilter: filter,
    generateMipmaps: false,
  });

const cocUniforms = () => ({
  uNear: { value: 0.01 },
  uFar: { value: 2000 },
  uFocus: { value: 10 },
  uRange: { value: 0.3 },
  uAperture: { value: 0 },
  uMaxCoC: { value: 1 },
});

const goldenKernel = (n: number) => {
  const out: THREE.Vector3[] = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt((i + 0.5) / n);
    const a = i * ga;
    out.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, r));
  }
  return out;
};

export class PostPipeline {
  readonly gl: THREE.WebGLRenderer;
  private w = 0;
  private h = 0;
  private bw = 0;
  private bh = 0;
  private tw = 0;
  private th = 0;
  private sceneRT: THREE.WebGLRenderTarget;
  private depthTex: THREE.DepthTexture;
  private cocRT: THREE.WebGLRenderTarget;
  private tileRT: THREE.WebGLRenderTarget;
  private dilRT: THREE.WebGLRenderTarget;
  private gatherRT: THREE.WebGLRenderTarget;
  private fillRT: THREE.WebGLRenderTarget;
  private dofRT: THREE.WebGLRenderTarget;
  private brightRT: THREE.WebGLRenderTarget;
  private streakRT: THREE.WebGLRenderTarget;
  private mip: MipmapBlurPass;
  private black: THREE.DataTexture;
  private fsScene = new THREE.Scene();
  private fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private fsMesh: THREE.Mesh;
  private m: {
    coc: THREE.ShaderMaterial;
    tile: THREE.ShaderMaterial;
    dilate: THREE.ShaderMaterial;
    gather: THREE.ShaderMaterial;
    fill: THREE.ShaderMaterial;
    composite: THREE.ShaderMaterial;
    bright: THREE.ShaderMaterial;
    streak: THREE.ShaderMaterial;
    finish: THREE.ShaderMaterial;
    cocDebug: THREE.ShaderMaterial;
  };
  private tmpV = new THREE.Vector3();
  private tmpF = new THREE.Vector3();
  params: PostParams | null = null;

  constructor(gl: THREE.WebGLRenderer) {
    this.gl = gl;
    const samples = Math.min(4, gl.capabilities.maxSamples || 0);
    this.depthTex = new THREE.DepthTexture(1, 1);
    // HDR scene target: packed R11F_G11F_B10F (no alpha needed). In SwiftShader 4x MSAA on RGBA16F
    // costs ~2.9 s per 1080p frame; on this packed float format ~0.55 s, with no visible banding
    // (max 4 code values against RGBA16F, verified on the macro bokeh and night aerial views).
    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.UnsignedInt101111Type,
      format: THREE.RGBFormat,
      samples,
      depthBuffer: true,
      depthTexture: this.depthTex,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    });
    this.cocRT = rt(1, 1);
    this.tileRT = rt(1, 1, THREE.NearestFilter);
    this.dilRT = rt(1, 1);
    this.gatherRT = rt(1, 1);
    this.fillRT = rt(1, 1);
    this.dofRT = rt(1, 1);
    this.brightRT = rt(1, 1);
    this.streakRT = rt(MAX_STREAKS, 1, THREE.NearestFilter);
    this.mip = new MipmapBlurPass();
    this.mip.levels = 6;
    this.mip.radius = 0.8;
    this.mip.initialize(gl, false, THREE.HalfFloatType);
    this.black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.black.needsUpdate = true;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.fsMesh = new THREE.Mesh(geo);
    this.fsMesh.frustumCulled = false;
    this.fsScene.add(this.fsMesh);

    this.m = {
      coc: mat(COC_FRAG, { tColor: { value: null }, tDepth: { value: null }, uFoot: { value: new THREE.Vector2() }, ...cocUniforms() }),
      tile: mat(TILE_FRAG, { tCoc: { value: null }, uSize: { value: new THREE.Vector2() } }),
      dilate: mat(DILATE_FRAG, { tTile: { value: null }, uSize: { value: new THREE.Vector2() } }),
      gather: mat(GATHER_FRAG, {
        tCoc: { value: null },
        tTile: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uKernel: { value: goldenKernel(GATHER_TAPS) },
        uBoost: { value: 2.5 },
      }),
      fill: mat(FILL_FRAG, {
        tGather: { value: null },
        tTile: { value: null },
        tCoc: { value: null },
        uTexel: { value: new THREE.Vector2() },
      }),
      composite: mat(COMPOSITE_FRAG, {
        tSharp: { value: null },
        tBlur: { value: null },
        tCoc: { value: null },
        tDepth: { value: null },
        uBufSize: { value: new THREE.Vector2(1, 1) },
        ...cocUniforms(),
      }),
      bright: mat(BRIGHT_FRAG, {
        tColor: { value: null },
        uFoot: { value: new THREE.Vector2() },
        uThreshold: { value: 1 },
        uKnee: { value: 0.5 },
      }),
      streak: mat(STREAK_VIS_FRAG, {
        tColor: { value: null },
        tDepth: { value: null },
        uSrc: { value: Array.from({ length: MAX_STREAKS }, () => new THREE.Vector4()) },
        uTexel: { value: new THREE.Vector2() },
        uNear: { value: 0.01 },
        uFar: { value: 2000 },
      }),
      finish: mat(FINISH_FRAG, {
        tColor: { value: null },
        tBloom: { value: null },
        tStreakVis: { value: null },
        uRes: { value: new THREE.Vector2() },
        uExposure: { value: 1 },
        uFlash: { value: 0 },
        uBloom: { value: 1 },
        uChroma: { value: 1 },
        uVignette: { value: 1 },
        uGrain: { value: 1 },
        uFrame: { value: 0 },
        uGradeAmt: { value: 1 },
        uLift: { value: new THREE.Vector3() },
        uGamma: { value: 1 },
        uGain: { value: new THREE.Vector3(1, 1, 1) },
        uContrast: { value: 1 },
        uPivot: { value: 0.4 },
        uSat: { value: 1 },
        uGrass: { value: 0 },
        uStreakN: { value: 0 },
        uStreakSrc: { value: Array.from({ length: MAX_STREAKS }, () => new THREE.Vector4()) },
        uStreakBlur: { value: new Array<number>(MAX_STREAKS).fill(0) },
        uStreakCore: { value: new THREE.Color() },
        uStreakTint: { value: new THREE.Color() },
        uDebug: { value: 0 },
        uEncoded: { value: true },
      }),
      cocDebug: mat(COC_DEBUG_FRAG, { tSharp: { value: null }, tDepth: { value: null }, ...cocUniforms() }),
    };
  }

  private ensureSize() {
    const size = this.gl.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(1, Math.round(size.x));
    const h = Math.max(1, Math.round(size.y));
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.bh = Math.max(1, Math.min(540, Math.round(h / 2)));
    this.bw = Math.max(1, Math.round((w * this.bh) / h));
    this.tw = Math.ceil(this.bw / 16);
    this.th = Math.ceil(this.bh / 16);
    this.sceneRT.setSize(w, h);
    this.dofRT.setSize(w, h);
    this.cocRT.setSize(this.bw, this.bh);
    this.gatherRT.setSize(this.bw, this.bh);
    this.fillRT.setSize(this.bw, this.bh);
    this.brightRT.setSize(this.bw, this.bh);
    this.tileRT.setSize(this.tw, this.th);
    this.dilRT.setSize(this.tw, this.th);
    this.mip.setSize(this.bw, this.bh);
  }

  private pass(material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) {
    this.fsMesh.material = material;
    this.gl.setRenderTarget(target);
    this.gl.render(this.fsScene, this.fsCam);
  }

  private setCoc(u: Record<string, THREE.IUniform>, cam: THREE.PerspectiveCamera, focusDist: number, p: PostParams) {
    u.uNear.value = cam.near;
    u.uFar.value = cam.far;
    u.uFocus.value = focusDist;
    u.uRange.value = p.focusRange;
    u.uAperture.value = p.aperture * this.bh;
    u.uMaxCoC.value = p.maxBlur * this.bh;
  }

  render(scene: THREE.Scene, camera: THREE.Camera) {
    const p = this.params;
    const gl = this.gl;
    if (!p) {
      gl.render(scene, camera);
      return;
    }
    this.ensureSize();
    const cam = camera as THREE.PerspectiveCamera;
    const prevAutoClear = gl.autoClear;
    const prevTarget = gl.getRenderTarget();

    // 1. scene (HDR, linear, MSAA)
    gl.autoClear = true;
    gl.setRenderTarget(this.sceneRT);
    gl.render(scene, camera);
    gl.autoClear = false;

    let color: THREE.Texture = this.sceneRT.texture;
    const m = this.m;

    // 2. depth of field
    let focusDist = 0;
    if (p.focus) {
      cam.getWorldPosition(this.tmpV);
      cam.getWorldDirection(this.tmpF);
      focusDist = Math.max(cam.near * 2, this.tmpV.clone().sub(p.focus).multiplyScalar(-1).dot(this.tmpF));
    }
    if (p.focus && p.debug === 1) {
      this.setCoc(m.cocDebug.uniforms, cam, focusDist, p);
      m.cocDebug.uniforms.tSharp.value = color;
      m.cocDebug.uniforms.tDepth.value = this.depthTex;
      this.pass(m.cocDebug, null);
      gl.autoClear = prevAutoClear;
      gl.setRenderTarget(prevTarget);
      return;
    }
    if (p.focus && p.aperture > 0) {
      const u = m.coc.uniforms;
      this.setCoc(u, cam, focusDist, p);
      u.tColor.value = color;
      u.tDepth.value = this.depthTex;
      const k = this.h / this.bh;
      u.uFoot.value.set((k / 4) / this.w, (k / 4) / this.h);
      this.pass(m.coc, this.cocRT);

      m.tile.uniforms.tCoc.value = this.cocRT.texture;
      m.tile.uniforms.uSize.value.set(this.bw, this.bh);
      this.pass(m.tile, this.tileRT);
      m.dilate.uniforms.tTile.value = this.tileRT.texture;
      m.dilate.uniforms.uSize.value.set(this.tw, this.th);
      this.pass(m.dilate, this.dilRT);

      const g = m.gather.uniforms;
      g.tCoc.value = this.cocRT.texture;
      g.tTile.value = this.dilRT.texture;
      g.uTexel.value.set(1 / this.bw, 1 / this.bh);
      g.uBoost.value = p.bokeh;
      this.pass(m.gather, this.gatherRT);

      const f = m.fill.uniforms;
      f.tGather.value = this.gatherRT.texture;
      f.tTile.value = this.dilRT.texture;
      f.tCoc.value = this.cocRT.texture;
      f.uTexel.value.set(1 / this.bw, 1 / this.bh);
      this.pass(m.fill, this.fillRT);

      const c = m.composite.uniforms;
      this.setCoc(c, cam, focusDist, p);
      c.tSharp.value = color;
      c.tBlur.value = this.fillRT.texture;
      c.tCoc.value = this.cocRT.texture;
      c.uBufSize.value.set(this.bw, this.bh);
      c.tDepth.value = this.depthTex;
      this.pass(m.composite, this.dofRT);
      color = this.dofRT.texture;
    }

    // 3. bloom
    let bloomTex: THREE.Texture = this.black;
    if (p.bloom > 0) {
      const b = m.bright.uniforms;
      b.tColor.value = color;
      const k = this.h / this.bh;
      b.uFoot.value.set((k / 4) / this.w, (k / 4) / this.h);
      b.uThreshold.value = p.bloomThreshold;
      b.uKnee.value = p.bloomKnee;
      this.pass(m.bright, this.brightRT);
      this.mip.radius = p.bloomRadius;
      this.mip.render(gl, this.brightRT, null as unknown as THREE.WebGLRenderTarget);
      bloomTex = this.mip.texture;
    }

    // 4. streak source visibility
    const fu = m.finish.uniforms;
    let n = 0;
    if (p.streaks.length) {
      cam.updateMatrixWorld();
      const su = m.streak.uniforms;
      const src = su.uSrc.value as THREE.Vector4[];
      const fsrc = fu.uStreakSrc.value as THREE.Vector4[];
      const fblur = fu.uStreakBlur.value as number[];
      const dofOn = !!p.focus && p.aperture > 0;
      for (const s of p.streaks) {
        if (n >= MAX_STREAKS) break;
        if (s.intensity <= 0) continue;
        const v = this.tmpV.copy(s.pos).applyMatrix4(cam.matrixWorldInverse);
        const dist = -v.z;
        if (dist <= cam.near) continue;
        v.applyMatrix4(cam.projectionMatrix);
        const ux = v.x * 0.5 + 0.5;
        const uy = v.y * 0.5 + 0.5;
        if (ux < 0 || ux > 1 || uy < 0 || uy > 1) continue;
        src[n].set(ux, uy, dist, s.intensity);
        fsrc[n].set(ux, uy, s.length, s.intensity);
        // same thin-lens blur as the DOF pass (fraction of frame height)
        fblur[n] = dofOn ? Math.min(p.maxBlur, (p.aperture * Math.max(Math.abs(dist - focusDist) - p.focusRange, 0)) / dist) : 0;
        n++;
      }
      for (let i = n; i < MAX_STREAKS; i++) src[i].set(0, 0, 0, 0);
      if (n > 0) {
        su.tColor.value = this.sceneRT.texture;
        su.tDepth.value = this.depthTex;
        su.uTexel.value.set(1 / this.w, 1 / this.h);
        su.uNear.value = cam.near;
        su.uFar.value = cam.far;
        this.pass(m.streak, this.streakRT);
      }
    }

    // 5. finish to screen
    fu.tColor.value = color;
    fu.tBloom.value = bloomTex;
    fu.tStreakVis.value = n > 0 ? this.streakRT.texture : this.black;
    fu.uStreakN.value = n;
    fu.uStreakCore.value.copy(p.streakCore);
    fu.uStreakTint.value.copy(p.streakTint);
    fu.uRes.value.set(this.w, this.h);
    fu.uExposure.value = p.exposure * gl.toneMappingExposure;
    fu.uFlash.value = p.flash;
    fu.uBloom.value = p.bloom;
    fu.uChroma.value = p.chroma;
    fu.uVignette.value = p.vignette;
    fu.uGrain.value = p.grain;
    fu.uFrame.value = p.frame;
    fu.uGradeAmt.value = p.grade;
    const gp = p.gradeParams;
    fu.uLift.value.set(...gp.lift);
    fu.uGamma.value = gp.gamma;
    fu.uGain.value.set(...gp.gain);
    fu.uContrast.value = gp.contrast;
    fu.uPivot.value = gp.pivot;
    fu.uSat.value = gp.saturation;
    fu.uGrass.value = gp.grass;
    fu.uDebug.value = p.debug;
    fu.uEncoded.value = gl.outputColorSpace === THREE.SRGBColorSpace;
    this.pass(m.finish, null);

    gl.autoClear = prevAutoClear;
    gl.setRenderTarget(prevTarget);
  }
}

const pipelines = new WeakMap<THREE.WebGLRenderer, PostPipeline>();

/** One pipeline per renderer, shared by every shot's <Post/> (no re-allocation at cuts). */
export const getPostPipeline = (gl: THREE.WebGLRenderer) => {
  let p = pipelines.get(gl);
  if (!p) {
    p = new PostPipeline(gl);
    pipelines.set(gl, p);
  }
  return p;
};
