import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { Water } from "three/addons/objects/Water.js";
import {
  clamp,
  DEG,
  FLOODLIGHT_XZ,
  LANTERN_XZ,
  lerp,
  NET,
  QUALITY_TIERS,
  TOSS_VY,
  G,
  VENUES,
} from "../core/constants";
import type {
  AvatarConfig,
  BallState,
  BounceMark,
  GameState,
  PlayerSlot,
  PlayerState,
  RGB,
  SkyPreset,
  SpectatorCamMode,
  TrainingState,
  VenueId,
} from "../core/types";
import type { NetHitState } from "../physics/ballPhysics";
import { isOverDeck } from "../physics/ballPhysics";
import type { ReplaySystem } from "../game/replay";
import type { AssetManager } from "./assets";
import { buildCharacterRig, type CharacterRig, poseCharacterRig } from "./characterRig";
import { CourtLife } from "./courtLife";
import { createSharedGeos, rgb, type SharedGeos } from "./geometry";
import { forEachMaterial } from "./meshOptimize";
import { createTextures, type TextureBundle } from "./textures";
import { VenueManager } from "./venues";
import { VfxSystem } from "./vfx";

const TUNE = {
  sun: Math.PI * 0.95,
  hemi: Math.PI * 0.62,
  env: 0.55,
  lantern: 6.6,
  exposure: 0.78,
  bloomK: 0.62,
  bloomThreshold: 0.92,
};

const SKY_VS = `varying vec3 vDir;
void main(){vec4 wp=modelMatrix*vec4(position,1.0);vDir=wp.xyz-cameraPosition;gl_Position=projectionMatrix*viewMatrix*wp;gl_Position.z=gl_Position.w;}`;

const SKY_FS = `
uniform vec3 uSunDir,uSunCol,uZenithCol,uHorizonCol,uOceanCol;
uniform float uCloudCover,uTime,uDisc,uEnvMode,uStars;
varying vec3 vDir;
float hash21(vec2 p){vec3 p3=fract(vec3(p.xyx)*0.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}
float vnoise(vec2 p){vec2 i=floor(p),f=fract(p),u=f*f*(3.0-2.0*f);return mix(mix(hash21(i),hash21(i+vec2(1,0)),u.x),mix(hash21(i+vec2(0,1)),hash21(i+vec2(1,1)),u.x),u.y);}
float fbm(vec2 p){float a=0.5,s=0.0;for(int i=0;i<5;i++){s+=vnoise(p)*a;p=p*2.03+vec2(19.1,7.7);a*=0.5;}return s/0.97;}
vec3 fogSky(vec3 dir,vec3 sun){
  float elev=pow(max(dir.y,0.0),0.44),mu=max(dot(dir,sun),0.0);
  vec3 col=mix(uHorizonCol,uZenithCol,elev);
  col+=uSunCol*(0.75*(1.0+mu*mu))*pow(1.0-elev,2.0)*0.05;
  col+=uSunCol*pow(mu,8.0)*0.10;
  return col;
}
void main(){
  vec3 dir=normalize(vDir),sun=normalize(uSunDir),col=fogSky(dir,sun);
  float up=dir.y,mu=max(dot(dir,sun),0.0),cover=clamp(uCloudCover,0.0,1.0);
  if(uStars>0.01&&up>0.05){
    vec2 suv=floor((dir.xz/max(up,0.12))*180.0);
    float st=hash21(suv);
    float tw=0.65+0.35*sin(uTime*3.0+st*62.0);
    col+=vec3(0.88,0.94,1.0)*smoothstep(0.994,0.9995,st)*uStars*tw*smoothstep(0.05,0.35,up);
  }
  vec2 cuv=dir.xz/max(up,0.1)*0.42+vec2(uTime*0.010,uTime*0.004);
  float n=fbm(cuv*1.55);
  float dens=smoothstep(0.62-cover*0.36,0.86-cover*0.16,n);
  float cf=dens*smoothstep(0.02,0.2,up);
  float shade=smoothstep(0.35,1.0,fbm(cuv*1.55+sun.xz*0.06));
  float silver=pow(mu,2.2);
  vec3 cloudCol=mix(uZenithCol*0.35+uHorizonCol*0.25,uSunCol*0.9,0.25+0.75*silver);
  cloudCol*=mix(1.15,0.72,shade);
  cloudCol=mix(cloudCol,uHorizonCol,clamp(1.0-up*1.6,0.0,1.0)*0.55);
  col=mix(col,cloudCol,cf*0.92);
  float occ=1.0-cf*0.85,sunUp=smoothstep(-0.02,0.03,sun.y);
  col+=uSunCol*uDisc*occ*sunUp*(pow(mu,220.0)*0.65+smoothstep(0.99945,0.99985,mu)*9.0);
  if(uEnvMode>0.5&&dir.y<0.0)col=mix(col,uOceanCol+uHorizonCol*0.12,smoothstep(0.0,-0.12,dir.y));
  gl_FragColor=vec4(col,1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const WATER_FS = `
uniform sampler2D mirrorSampler;
uniform float alpha,time,size,distortionScale,uBump;
uniform sampler2D normalSampler;
uniform vec3 sunColor,sunDirection,eye,waterColor,uShallow,uDeep,uAmbient;
varying vec4 mirrorCoord;
varying vec4 worldPosition;
vec3 getNoise(vec2 uv){
  vec2 uv0=uv/9.0+vec2(time/28.0,time/48.0);
  vec2 uv1=uv/11.3-vec2(time/-32.0,time/52.0);
  vec2 uv2=uv/41.0+vec2(time/160.0,time/150.0);
  vec2 uv3=uv/2.7-vec2(time/19.0,time/-23.0);
  vec3 n=(texture2D(normalSampler,uv0).rgb+texture2D(normalSampler,uv1).rgb+texture2D(normalSampler,uv2).rgb+texture2D(normalSampler,uv3).rgb*0.5)/3.5;
  return n*2.0-1.0;
}
float sdRect(vec2 p,vec2 c,vec2 h){vec2 q=abs(p-c)-h;return length(max(q,0.0))+min(max(q.x,q.y),0.0);}
#include <common>
#include <packing>
#include <bsdfs>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>
void main(){
  #include <logdepthbuf_fragment>
  vec3 nz=getNoise(worldPosition.xz);
  vec3 N=normalize(vec3(nz.x*uBump,nz.z,nz.y*uBump));
  vec3 toEye=eye-worldPosition.xyz;
  float dist=length(toEye);
  vec3 V=toEye/dist,Ls=normalize(sunDirection);
  float sh=getShadowMask();
  vec2 distortion=N.xz*(0.001+1.0/dist)*distortionScale;
  vec3 refl=texture2D(mirrorSampler,mirrorCoord.xy/mirrorCoord.w+distortion).rgb;
  float fres=0.02+0.98*pow(1.0-max(dot(N,V),0.0),5.0);
  float sd=sdRect(worldPosition.xz,vec2(0.0,12.0),vec2(13.4,18.4));
  float shallowK=1.0-smoothstep(-1.5,16.0,sd);
  vec3 body=mix(uDeep,uShallow,shallowK);
  vec3 base=body*(uAmbient+sunColor*clamp(dot(N,Ls)*0.65+0.35,0.0,1.0)*0.55*sh);
  vec3 col=mix(base,refl,fres*0.92+0.04);
  vec3 Hh=normalize(Ls+V);
  float nh=max(dot(N,Hh),0.0);
  float spark=step(0.6,fract(sin(dot(floor(worldPosition.xz*6.0),vec2(12.9898,78.233)))*43758.5453+time*0.5));
  col+=sunColor*(pow(nh,12.0)*0.06+pow(nh,320.0)*(1.2+spark*2.5))*sh;
  float edge=abs(sd);
  float foam=(1.0-smoothstep(0.1,1.7,edge))*smoothstep(0.3,0.9,sin(edge*5.5-time*2.1+worldPosition.x*0.17)*0.5+0.5);
  foam*=0.5+0.5*texture2D(normalSampler,worldPosition.xz*0.11+time*0.015).r;
  col=mix(col,vec3(0.86,0.93,0.95)*(uAmbient*1.6+sunColor*0.35*sh),clamp(foam,0.0,0.8));
  gl_FragColor=vec4(col,alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

const FAST_WATER_VS = `
varying vec3 vWorldPos;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const FAST_WATER_FS = `
uniform float time, uBump;
uniform sampler2D normalSampler;
uniform vec3 sunColor, sunDirection, uShallow, uDeep, uAmbient, uSkyReflect;
varying vec3 vWorldPos;
vec3 getNoise(vec2 uv){
  vec2 uv0=uv/9.0+vec2(time/28.0,time/48.0);
  vec2 uv1=uv/11.3-vec2(time/-32.0,time/52.0);
  vec3 n=(texture2D(normalSampler,uv0).rgb+texture2D(normalSampler,uv1).rgb)*0.5;
  return n*2.0-1.0;
}
float sdRect(vec2 p,vec2 c,vec2 h){vec2 q=abs(p-c)-h;return length(max(q,0.0))+min(max(q.x,q.y),0.0);}
void main(){
  vec3 nz=getNoise(vWorldPos.xz);
  vec3 N=normalize(vec3(nz.x*uBump,nz.z,nz.y*uBump));
  vec3 V=normalize(cameraPosition - vWorldPos);
  vec3 Ls=normalize(sunDirection);
  float fres=0.04+0.92*pow(1.0-max(dot(N,V),0.0),4.5);
  float sd=sdRect(vWorldPos.xz,vec2(0.0,12.0),vec2(13.4,18.4));
  float shallowK=1.0-smoothstep(-1.5,16.0,sd);
  vec3 body=mix(uDeep,uShallow,shallowK);
  vec3 base=body*(uAmbient+sunColor*clamp(dot(N,Ls)*0.65+0.35,0.0,1.0)*0.52);
  vec3 col=mix(base,uSkyReflect,fres*0.82);
  vec3 Hh=normalize(Ls+V);
  float nh=max(dot(N,Hh),0.0);
  col+=sunColor*(pow(nh,16.0)*0.07+pow(nh,240.0)*1.3);
  float edge=abs(sd);
  float foam=(1.0-smoothstep(0.1,1.7,edge))*smoothstep(0.3,0.9,sin(edge*5.5-time*2.1+vWorldPos.x*0.17)*0.5+0.5);
  col=mix(col,vec3(0.86,0.93,0.95)*(uAmbient*1.5+sunColor*0.3),clamp(foam,0.0,0.75));
  gl_FragColor=vec4(col,1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// Fused final post-processing pass: GTAO composite + Bloom composite + ACESFilmic tone mapping + sRGB OETF + Filmic Grade/Flare/Vignette in ONE pass!
const OutputGradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    tAO: { value: null },
    tBloom: { value: null },
    uAoStrength: { value: 0 },
    uBloomEnable: { value: 0 },
    uVignette: { value: 0.3 },
    uSat: { value: 1.12 },
    uFlare: { value: 0.3 },
    uSunVis: { value: 0 },
    uSunUV: { value: new THREE.Vector2(-2, -2) },
    uSunCol: { value: new THREE.Vector3(1, 0.8, 0.5) },
    uAspect: { value: 1 },
    uTime: { value: 0 },
  },
  vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
  fragmentShader: `
uniform sampler2D tDiffuse, tAO, tBloom;
uniform float uAoStrength, uBloomEnable, uVignette, uSat, uFlare, uSunVis, uAspect, uTime;
uniform vec2 uSunUV;
uniform vec3 uSunCol;
varying vec2 vUv;
void main(){
  vec3 col = texture2D(tDiffuse, vUv).rgb;
  if (uAoStrength > 0.001) {
    float ao = texture2D(tAO, vUv).r;
    float hdrLuma = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col *= mix(1.0, ao, uAoStrength * (1.0 - smoothstep(0.95, 2.2, hdrLuma)));
  }
  if (uBloomEnable > 0.5) {
    col += texture2D(tBloom, vUv).rgb;
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  col = gl_FragColor.rgb;
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSat);
  vec2 d = (vUv - uSunUV) * vec2(uAspect, 1.0);
  float fl = exp(-dot(d, d) * 30.0) * 0.16 + exp(-dot(d, d) * 160.0) * 0.24;
  vec2 gp = mix(vec2(0.5), vec2(1.0) - uSunUV, 0.68), gd = (vUv - gp) * vec2(uAspect, 1.0);
  fl += exp(-dot(gd, gd) * 90.0) * 0.05;
  vec2 gp2 = mix(vec2(0.5), vec2(1.0) - uSunUV, 1.25), gd2 = (vUv - gp2) * vec2(uAspect, 1.0);
  fl += smoothstep(0.045, 0.035, length(gd2)) * 0.03;
  float edge = smoothstep(0.0, 0.06, uSunUV.x) * smoothstep(0.0, 0.06, uSunUV.y) * smoothstep(0.0, 0.06, 1.0 - uSunUV.x) * smoothstep(0.0, 0.06, 1.0 - uSunUV.y);
  col += uSunCol * fl * uFlare * uSunVis * edge;
  vec2 q = vUv - 0.5;
  col *= clamp(1.0 - dot(q, q) * uVignette, 0.0, 1.0);
  float n = fract(sin(dot(gl_FragCoord.xy + fract(uTime) * 91.0, vec2(12.9898, 78.233))) * 43758.5453);
  gl_FragColor = vec4(clamp(col + (n - 0.5) * (1.5 / 255.0), 0.0, 1.0), 1.0);
}`,
};

function avatarsEqual(a: AvatarConfig | null, b: AvatarConfig): boolean {
  if (!a) return false;
  if (a === b) return true;
  return (
    a.hair === b.hair &&
    a.hat === b.hat &&
    a.num === b.num &&
    a.handedness === b.handedness &&
    a.racket === b.racket &&
    a.trail === b.trail &&
    a.skin[0] === b.skin[0] && a.skin[1] === b.skin[1] && a.skin[2] === b.skin[2] &&
    a.hairColor[0] === b.hairColor[0] && a.hairColor[1] === b.hairColor[1] && a.hairColor[2] === b.hairColor[2] &&
    a.shirt[0] === b.shirt[0] && a.shirt[1] === b.shirt[1] && a.shirt[2] === b.shirt[2] &&
    a.stripe[0] === b.stripe[0] && a.stripe[1] === b.stripe[1] && a.stripe[2] === b.stripe[2] &&
    a.shorts[0] === b.shorts[0] && a.shorts[1] === b.shorts[1] && a.shorts[2] === b.shorts[2] &&
    a.shoe[0] === b.shoe[0] && a.shoe[1] === b.shoe[1] && a.shoe[2] === b.shoe[2] &&
    a.band[0] === b.band[0] && a.band[1] === b.band[1] && a.band[2] === b.band[2] &&
    a.accent[0] === b.accent[0] && a.accent[1] === b.accent[1] && a.accent[2] === b.accent[2]
  );
}

function disposeRig(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      const m = obj as THREE.Mesh;
      if (m.geometry && m.name.includes("_Merged")) m.geometry.dispose();
    }
  });
  forEachMaterial(root, (mat) => {
    if (!mat.userData?.sharedVertexPbr) mat.dispose();
  });
}

interface CameraRig {
  ex: number; ey: number; ez: number;
  tx: number; ty: number; tz: number;
  shake: number;
  zoomPunch: number;
  orbitA: number;
  customizerYaw: number;
}

export class GameRenderer {
  public renderer: THREE.WebGLRenderer;
  public scene: THREE.Scene;
  public camera: THREE.PerspectiveCamera;
  public composer: EffectComposer;
  public W = 1;
  public H = 1;
  public DPR = 1;
  public qualIdx = 0;

  public cam: CameraRig = {
    ex: 0, ey: 5.5, ez: -9.8, tx: 0, ty: 0.9, tz: 11.5,
    shake: 0, zoomPunch: 0, orbitA: 0, customizerYaw: 0.25,
  };

  public textures: TextureBundle;
  public geos: SharedGeos;
  public venues: VenueManager;
  public courtLife: CourtLife;
  public vfx: VfxSystem;

  private pmrem: THREE.PMREMGenerator;
  private sun: THREE.DirectionalLight;
  private sunTarget: THREE.Object3D;
  private hemi: THREE.HemisphereLight;
  private lanternLights: THREE.PointLight[] = [];
  private floodLights: THREE.PointLight[] = [];
  private ballLight: THREE.PointLight;
  private sky: THREE.Mesh;
  private envScene: THREE.Scene;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private skyUniforms: Record<string, { value: unknown }>;
  private water: THREE.Mesh | null = null;
  private waterIsPlanar = false;
  private waterFrame = 0;
  private gtaoPass: GTAOPass | null = null;
  private bloomPass: UnrealBloomPass;
  private gradePass: ShaderPass;

  private ballMesh: THREE.Mesh;
  private ballMat: THREE.MeshPhysicalMaterial;
  private ringMeshes: THREE.Mesh[] = [];
  private playerRigs: Array<CharacterRig | null> = [null, null, null, null];
  private rigAvatarCache: Array<AvatarConfig | null> = [null, null, null, null];
  private _mirrorSaved: THREE.Object3D[] = [];
  private _gtaoSaved: THREE.Object3D[] = [];
  private dummyWhiteTex: THREE.DataTexture;
  private dummyBlackTex: THREE.DataTexture;
  private lastRenderCalls = 0;
  private lastRenderTris = 0;
  private lastShadowTime = -1;

  private lastShadowSize = 0;
  private lastMirror = -1;
  private lastSamples = -1;
  public appliedPreset: SkyPreset | null = null;
  private _sunDir = new THREE.Vector3();
  private _sunP = new THREE.Vector3();
  private _fwd = new THREE.Vector3();
  private _projV = new THREE.Vector3();
  private maxAniso: number;

  constructor(private canvas: HTMLCanvasElement, private assets: AssetManager, initialQual = 0) {
    this.qualIdx = clamp(initialQual, 0, QUALITY_TIERS.length - 1);
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      stencil: false,
      powerPreference: "high-performance",
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.maxAniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x8899aa, 80, 240);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.25, 900);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);

    // Lighting rig
    this.sunTarget = new THREE.Object3D();
    this.sunTarget.position.set(0, 1, 12);
    this.scene.add(this.sunTarget);

    this.sun = new THREE.DirectionalLight(0xffffff, TUNE.sun);
    this.sun.target = this.sunTarget;
    this.sun.castShadow = true;
    Object.assign(this.sun.shadow.camera, { left: -19, right: 19, top: 19, bottom: -19, near: 6, far: 105 });
    this.sun.shadow.bias = -0.00025;
    this.sun.shadow.normalBias = 0.022;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.scene.add(this.sun);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x222222, TUNE.hemi);
    this.scene.add(this.hemi);

    for (const [lx, lz] of LANTERN_XZ) {
      const pl = new THREE.PointLight(0xffaa55, 0, 14, 1);
      pl.position.set(lx - Math.sign(lx) * 0.42, 2.95, lz);
      this.scene.add(pl);
      this.lanternLights.push(pl);
    }

    // Stadium Night Floodlights (illuminate court evenly at night!)
    for (const [fx, fz] of FLOODLIGHT_XZ) {
      const fl = new THREE.PointLight(0xeef5ff, 0, 38, 1.1);
      fl.position.set(fx * 0.78, 8.6, fz * 0.88 + 1.5);
      this.scene.add(fl);
      this.floodLights.push(fl);
    }

    this.ballLight = new THREE.PointLight(0xfff0a0, 0, 5, 1.6);
    this.scene.add(this.ballLight);

    // Sky dome + PMREM environment dome
    this.skyUniforms = {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunCol: { value: new THREE.Vector3(1, 1, 1) },
      uZenithCol: { value: new THREE.Vector3() },
      uHorizonCol: { value: new THREE.Vector3() },
      uOceanCol: { value: new THREE.Vector3(0.012, 0.05, 0.1) },
      uCloudCover: { value: 0.5 },
      uTime: { value: 0 },
      uStars: { value: 0 },
    };
    const mkSkyMat = (disc: number, envMode: number) =>
      new THREE.ShaderMaterial({
        uniforms: { ...this.skyUniforms, uDisc: { value: disc }, uEnvMode: { value: envMode } },
        vertexShader: SKY_VS,
        fragmentShader: SKY_FS,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: true,
        depthFunc: THREE.LessEqualDepth,
        fog: false,
      });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(500, 48, 24), mkSkyMat(1, 0));
    this.sky.frustumCulled = false;
    // Draw sky AFTER opaque geometry so GPU Early-Z skips ~70% of sky pixels covered by court/ocean/islands!
    this.sky.renderOrder = 2;
    this.scene.add(this.sky);
    this.envScene = new THREE.Scene();
    this.envScene.add(new THREE.Mesh(new THREE.SphereGeometry(500, 48, 24), mkSkyMat(0, 1)));

    // Textures, Shared Geos, Venues, CourtLife, VFX
    this.textures = createTextures(this.maxAniso);
    this.geos = createSharedGeos();
    this.venues = new VenueManager(this.scene, this.textures, this.geos, assets);
    this.courtLife = new CourtLife(
      this.venues.root,
      this.geos,
      assets,
      this.maxAniso,
      this.venues.ledScreenMesh
    );
    this.vfx = new VfxSystem(this.scene);

    // Training rings
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(
        this.geos.torus,
        new THREE.MeshStandardMaterial({ color: 0x33eeff, emissive: 0x33eeff, emissiveIntensity: 2, roughness: 0.25, metalness: 0.2 })
      );
      m.castShadow = true;
      m.rotation.order = "YXZ";
      m.visible = false;
      this.venues.root.add(m);
      this.ringMeshes.push(m);
    }

    // Ball
    this.ballMat = new THREE.MeshPhysicalMaterial({
      map: this.textures.ball,
      roughness: 0.9,
      sheen: 1.0,
      sheenRoughness: 0.45,
      sheenColor: new THREE.Color(0.9, 1.0, 0.35),
      emissive: 0xffffff,
      emissiveMap: this.textures.ball,
      emissiveIntensity: 0,
    });
    this.ballMesh = new THREE.Mesh(this.geos.ball, this.ballMat);
    this.ballMesh.castShadow = true;
    this.ballMesh.receiveShadow = true;
    this.ballMesh.rotation.order = "YXZ";
    this.venues.root.add(this.ballMesh);

    // 1x1 fallback textures for disabled AO / Bloom slots
    this.dummyWhiteTex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    this.dummyWhiteTex.needsUpdate = true;
    this.dummyBlackTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.dummyBlackTex.needsUpdate = true;

    // Zero-swap lean HDR post-processing composer:
    // RenderPass -> readBuffer (single MSAA target, writeBuffer unused & 1x1)
    // -> GTAOPass (half-res, OUTPUT.Off, no copy/blend)
    // -> UnrealBloomPass (half-res, computes mip bloom only, no MSAA writeback!)
    // -> OutputGradePass (fuses AO + Bloom + ACESFilmic + sRGB + Grade/Flare straight to screen!)
    const composerRT = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, composerRT);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    try {
      this.gtaoPass = new GTAOPass(this.scene, this.camera, 2, 2);
      this.gtaoPass.updateGtaoMaterial({ radius: 0.42, distanceExponent: 1.4, thickness: 1.2, scale: 1.0, samples: 8, distanceFallOff: 1.0 });
      this.gtaoPass.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 5, rings: 1, samples: 8 });
      this.gtaoPass.blendIntensity = 0.80;
      this.gtaoPass.output = GTAOPass.OUTPUT.Off;
      this.gtaoPass.needsSwap = false;
      const baseRender = this.gtaoPass.render.bind(this.gtaoPass);
      this.gtaoPass.render = (...a: Parameters<GTAOPass["render"]>) => {
        const saved = this._gtaoSaved;
        saved.length = 0;
        const hide = (obj: THREE.Object3D | null) => {
          if (obj && obj.visible) {
            saved.push(obj);
            obj.visible = false;
          }
        };
        hide(this.water);
        hide(this.sky);
        hide(this.vfx.group);
        for (let i = 0; i < this.venues.gtaoHidden.length; i++) hide(this.venues.gtaoHidden[i]);
        for (let i = 0; i < this.courtLife.gtaoHidden.length; i++) hide(this.courtLife.gtaoHidden[i]);
        baseRender(...a);
        for (let i = 0; i < saved.length; i++) saved[i].visible = true;
        saved.length = 0;
      };
      this.composer.addPass(this.gtaoPass);
    } catch {
      this.gtaoPass = null;
    }

    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.4, 0.55, TUNE.bloomThreshold);
    this.bloomPass.needsSwap = false;
    // Run half-res bright extraction + 5-mip separable blur + mip composite into renderTargetsHorizontal[0]
    // WITHOUT writing back into the MSAA readBuffer (OutputGradePass adds tBloom directly in 1 pass!)
    const bloomClearCol = new THREE.Color(0, 0, 0);
    const bloomOldClear = new THREE.Color();
    const bloomDirX = new THREE.Vector2(1.0, 0.0);
    const bloomDirY = new THREE.Vector2(0.0, 1.0);
    this.bloomPass.render = (renderer, _writeBuffer, readBuffer) => {
      const bp = this.bloomPass as unknown as {
        threshold: number;
        strength: number;
        radius: number;
        nMips: number;
        highPassUniforms: Record<string, { value: unknown }>;
        materialHighPassFilter: THREE.ShaderMaterial;
        renderTargetBright: THREE.WebGLRenderTarget;
        renderTargetsHorizontal: THREE.WebGLRenderTarget[];
        renderTargetsVertical: THREE.WebGLRenderTarget[];
        separableBlurMaterials: THREE.ShaderMaterial[];
        compositeMaterial: THREE.ShaderMaterial;
        bloomTintColors: THREE.Vector3[];
        fsQuad: { material: THREE.Material; render: (r: THREE.WebGLRenderer) => void };
      };
      renderer.getClearColor(bloomOldClear);
      const oldClearAlpha = renderer.getClearAlpha();
      const oldAutoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.setClearColor(bloomClearCol, 0);

      bp.highPassUniforms.tDiffuse.value = readBuffer.texture;
      bp.highPassUniforms.luminosityThreshold.value = bp.threshold;
      bp.fsQuad.material = bp.materialHighPassFilter;
      renderer.setRenderTarget(bp.renderTargetBright);
      renderer.clear();
      bp.fsQuad.render(renderer);

      let inputRT = bp.renderTargetBright;
      for (let i = 0; i < bp.nMips; i++) {
        const blurMat = bp.separableBlurMaterials[i];
        bp.fsQuad.material = blurMat;
        blurMat.uniforms.colorTexture.value = inputRT.texture;
        blurMat.uniforms.direction.value = bloomDirX;
        renderer.setRenderTarget(bp.renderTargetsHorizontal[i]);
        renderer.clear();
        bp.fsQuad.render(renderer);

        blurMat.uniforms.colorTexture.value = bp.renderTargetsHorizontal[i].texture;
        blurMat.uniforms.direction.value = bloomDirY;
        renderer.setRenderTarget(bp.renderTargetsVertical[i]);
        renderer.clear();
        bp.fsQuad.render(renderer);
        inputRT = bp.renderTargetsVertical[i];
      }

      bp.fsQuad.material = bp.compositeMaterial;
      bp.compositeMaterial.uniforms.bloomStrength.value = bp.strength;
      bp.compositeMaterial.uniforms.bloomRadius.value = bp.radius;
      bp.compositeMaterial.uniforms.bloomTintColors.value = bp.bloomTintColors;
      renderer.setRenderTarget(bp.renderTargetsHorizontal[0]);
      renderer.clear();
      bp.fsQuad.render(renderer);

      renderer.setClearColor(bloomOldClear, oldClearAlpha);
      renderer.autoClear = oldAutoClear;
    };
    this.composer.addPass(this.bloomPass);

    this.gradePass = new ShaderPass(OutputGradeShader);
    this.gradePass.material.toneMapped = true;
    this.gradePass.needsSwap = false;
    this.gradePass.uniforms.tAO.value = this.gtaoPass ? this.gtaoPass.gtaoMap : this.dummyWhiteTex;
    this.gradePass.uniforms.tBloom.value = this.bloomPass.renderTargetsHorizontal[0].texture;
    this.composer.addPass(this.gradePass);

    this.resize();
  }

  public getPerfStats() {
    return {
      calls: this.lastRenderCalls,
      triangles: this.lastRenderTris,
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
      programs: this.renderer.info.programs?.length || 0,
      quality: QUALITY_TIERS[this.qualIdx]?.name || "?",
      dpr: this.DPR,
    };
  }

  public projectWorldToScreen(
    x: number,
    y: number,
    z: number,
    out: { x: number; y: number; visible: boolean }
  ): void {
    this._projV.set(x, y, z).project(this.camera);
    out.visible = this._projV.z >= -1 && this._projV.z <= 1;
    out.x = (this._projV.x * 0.5 + 0.5) * this.W;
    out.y = (-this._projV.y * 0.5 + 0.5) * this.H;
  }

  private buildWater(res: number): void {
    if (this.water) {
      this.scene.remove(this.water);
      const mat = this.water.material as THREE.ShaderMaterial;
      if (mat.uniforms?.mirrorSampler?.value) mat.uniforms.mirrorSampler.value.dispose();
      mat.dispose();
      this.water.geometry.dispose();
      this.water = null;
    }

    if (res <= 0) {
      // Zero-mirror single-pass ocean shader for Fast tier (eliminates entire 2nd scene pass!)
      this.waterIsPlanar = false;
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          time: { value: 0 },
          uBump: { value: 1.25 },
          normalSampler: { value: this.textures.waterN },
          sunDirection: { value: new THREE.Vector3(0, 1, 0) },
          sunColor: { value: new THREE.Color(1, 1, 1) },
          uShallow: { value: rgb([0.05, 0.42, 0.42]) },
          uDeep: { value: rgb([0.010, 0.048, 0.10]) },
          uAmbient: { value: new THREE.Color(0.3, 0.3, 0.3) },
          uSkyReflect: { value: new THREE.Color(0.25, 0.45, 0.65) },
        },
        vertexShader: FAST_WATER_VS,
        fragmentShader: FAST_WATER_FS,
      });
      this.water = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400), mat);
      this.water.rotation.x = -Math.PI / 2;
      this.water.position.y = -1.5;
      this.scene.add(this.water);
      if (this.appliedPreset) this.applyWaterPreset(this.appliedPreset);
      return;
    }

    this.waterIsPlanar = true;
    this.waterFrame = 0;
    const w = new Water(new THREE.PlaneGeometry(1400, 1400), {
      textureWidth: res,
      textureHeight: res,
      waterNormals: this.textures.waterN,
      sunDirection: new THREE.Vector3(0, 1, 0),
      sunColor: 0xffffff,
      waterColor: 0x001e0f,
      distortionScale: 2.2,
      fog: true,
    });
    const u = w.material.uniforms;
    u.uShallow = { value: rgb([0.05, 0.42, 0.42]) };
    u.uDeep = { value: rgb([0.010, 0.048, 0.10]) };
    u.uAmbient = { value: new THREE.Color(0.3, 0.3, 0.3) };
    u.uBump = { value: 1.35 };
    w.material.fragmentShader = WATER_FS;
    w.material.needsUpdate = true;
    w.rotation.x = -Math.PI / 2;
    w.position.y = -1.5;
    w.receiveShadow = true;

    // Throttle planar reflection to 30Hz & skip court-surface actors/props that sit behind the pier wall (zero GC!)
    const origMirror = w.onBeforeRender;
    w.onBeforeRender = (renderer, scene, camera, geo, mat, group) => {
      if ((this.waterFrame++ & 1) === 1) return;
      const saved = this._mirrorSaved;
      saved.length = 0;
      const hide = (obj: THREE.Object3D | null) => {
        if (obj && obj.visible) {
          saved.push(obj);
          obj.visible = false;
        }
      };
      for (let i = 0; i < this.venues.mirrorHidden.length; i++) hide(this.venues.mirrorHidden[i]);
      for (let i = 0; i < this.courtLife.mirrorHidden.length; i++) hide(this.courtLife.mirrorHidden[i]);
      hide(this.vfx.group);
      hide(this.ballMesh);
      for (let i = 0; i < this.playerRigs.length; i++) {
        const r = this.playerRigs[i];
        if (r) hide(r.root);
      }
      origMirror.call(w, renderer, scene, camera, geo, mat, group);
      for (let i = 0; i < saved.length; i++) saved[i].visible = true;
      saved.length = 0;
    };

    this.water = w;
    this.scene.add(this.water);
    if (this.appliedPreset) this.applyWaterPreset(this.appliedPreset);
  }

  private applyWaterPreset(pr: SkyPreset): void {
    if (!this.water) return;
    const u = (this.water.material as THREE.ShaderMaterial).uniforms;
    u.sunDirection.value.set(pr.sunDir[0], pr.sunDir[1], pr.sunDir[2]).normalize();
    u.sunColor.value.setRGB(pr.sunCol[0], pr.sunCol[1], pr.sunCol[2]);
    u.uAmbient.value.setRGB(
      pr.sky[0] * 0.9 + pr.zenith[0] * 0.4,
      pr.sky[1] * 0.9 + pr.zenith[1] * 0.4,
      pr.sky[2] * 0.9 + pr.zenith[2] * 0.4
    );
    if (!this.waterIsPlanar && u.uSkyReflect) {
      u.uSkyReflect.value.setRGB(
        pr.horizon[0] * 0.65 + pr.zenith[0] * 0.35,
        pr.horizon[1] * 0.65 + pr.zenith[1] * 0.35,
        pr.horizon[2] * 0.65 + pr.zenith[2] * 0.35
      );
    }
  }

  public applyPreset(pr: SkyPreset): void {
    this._sunDir.set(pr.sunDir[0], pr.sunDir[1], pr.sunDir[2]).normalize();
    this.sun.position.copy(this.sunTarget.position).addScaledVector(this._sunDir, 55);
    this.sun.color.setRGB(pr.sunCol[0], pr.sunCol[1], pr.sunCol[2]);
    this.sun.intensity = TUNE.sun;
    this.hemi.color.setRGB(pr.sky[0], pr.sky[1], pr.sky[2]);
    this.hemi.groundColor.setRGB(pr.ground[0], pr.ground[1], pr.ground[2]);
    this.hemi.intensity = TUNE.hemi;

    this.scene.fog = new THREE.Fog(
      new THREE.Color().setRGB(
        pr.horizon[0] * 0.85 + pr.zenith[0] * 0.15,
        pr.horizon[1] * 0.85 + pr.zenith[1] * 0.15,
        pr.horizon[2] * 0.85 + pr.zenith[2] * 0.15
      ),
      pr.fogNear,
      pr.fogFar * 1.25
    );

    (this.skyUniforms.uSunDir.value as THREE.Vector3).copy(this._sunDir);
    (this.skyUniforms.uSunCol.value as THREE.Vector3).set(pr.sunCol[0], pr.sunCol[1], pr.sunCol[2]);
    (this.skyUniforms.uZenithCol.value as THREE.Vector3).set(pr.zenith[0], pr.zenith[1], pr.zenith[2]);
    (this.skyUniforms.uHorizonCol.value as THREE.Vector3).set(pr.horizon[0], pr.horizon[1], pr.horizon[2]);
    this.skyUniforms.uCloudCover.value = pr.cloud;
    this.skyUniforms.uStars.value = pr.id === "night" ? 1.0 : pr.id === "twilight" ? 0.35 : 0.0;

    this.lanternLights.forEach((pl, i) => {
      const c = pr.pointCol[i];
      const mx = Math.max(c[0], c[1], c[2], 1e-4);
      pl.color.setRGB(c[0] / mx, c[1] / mx, c[2] / mx);
      pl.intensity = i < pr.pointCount ? mx * TUNE.lantern : 0;
      pl.distance = pr.pointDist;
      pl.visible = pl.intensity > 0.001;
    });
    for (const fl of this.floodLights) {
      fl.intensity = pr.floodIntensity * 35;
      fl.visible = fl.intensity > 0.001;
    }

    this.venues.applyPresetGlow(pr);
    this.renderer.toneMappingExposure = pr.exposure * TUNE.exposure * pr.presetExposure;
    this.bloomPass.strength = pr.bloom.strength * TUNE.bloomK;
    this.bloomPass.radius = clamp(0.25 + pr.bloom.spread * 0.2, 0, 1);
    this.bloomPass.threshold = TUNE.bloomThreshold * (0.75 + pr.bloom.threshold * 0.3);

    const gu = this.gradePass.uniforms;
    gu.uVignette.value = pr.vignette * 1.1;
    gu.uFlare.value = pr.flare;
    const smx = Math.max(pr.sunCol[0], pr.sunCol[1], pr.sunCol[2]);
    gu.uSunCol.value.set(pr.sunCol[0] / smx, pr.sunCol[1] / smx, pr.sunCol[2] / smx);
    this.applyWaterPreset(pr);

    // PMREM Sky IBL
    this.skyUniforms.uTime.value = 0;
    const prevEnv = this.envRT;
    this.envRT = this.pmrem.fromScene(this.envScene, 0, 0.1, 1000);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = TUNE.env;
    if (prevEnv) prevEnv.dispose();
    this.appliedPreset = pr;
  }

  public setQuality(idx: number): void {
    this.qualIdx = clamp(idx, 0, QUALITY_TIERS.length - 1);
    this.resize();
  }

  public resize(): void {
    const q = QUALITY_TIERS[this.qualIdx];
    this.DPR = Math.min(q.dprCap, window.devicePixelRatio || 1);
    this.W = Math.max(1, this.canvas.clientWidth);
    this.H = Math.max(1, this.canvas.clientHeight);
    this.renderer.setPixelRatio(this.DPR);
    this.renderer.setSize(this.W, this.H, false);

    if (this.lastSamples !== q.msaa) {
      // Only readBuffer (renderTarget2) needs MSAA; renderTarget1 is never swapped to!
      this.composer.renderTarget2.samples = q.msaa;
      this.composer.renderTarget2.dispose();
      this.composer.renderTarget1.samples = 0;
      this.composer.renderTarget1.dispose();
      this.lastSamples = q.msaa;
    }
    this.composer.setPixelRatio(this.DPR);
    this.composer.setSize(this.W, this.H);
    // Keep unused writeBuffer tiny (1x1, 0 MSAA) so it costs zero VRAM
    this.composer.renderTarget1.setSize(1, 1);

    const effW = Math.max(2, Math.floor(this.W * this.DPR));
    const effH = Math.max(2, Math.floor(this.H * this.DPR));
    const halfW = Math.max(2, Math.floor(effW * 0.5));
    const halfH = Math.max(2, Math.floor(effH * 0.5));

    if (this.lastShadowSize !== q.shadow) {
      this.sun.shadow.mapSize.set(q.shadow, q.shadow);
      if (this.sun.shadow.map) {
        this.sun.shadow.map.dispose();
        this.sun.shadow.map = null;
      }
      this.lastShadowSize = q.shadow;
    }
    if (this.lastMirror !== q.mirror) {
      this.buildWater(q.mirror);
      this.lastMirror = q.mirror;
    }
    this.bloomPass.enabled = q.bloom;
    if (q.bloom) {
      this.bloomPass.setSize(halfW, halfH);
    }
    const gu = this.gradePass.uniforms;
    gu.uBloomEnable.value = q.bloom ? 1.0 : 0.0;
    gu.tBloom.value = q.bloom ? this.bloomPass.renderTargetsHorizontal[0].texture : this.dummyBlackTex;

    if (this.gtaoPass) {
      this.gtaoPass.enabled = q.ao;
      if (q.ao) {
        this.gtaoPass.setSize(halfW, halfH);
        gu.uAoStrength.value = 0.80;
        gu.tAO.value = this.gtaoPass.gtaoMap;
      } else {
        this.gtaoPass.setSize(2, 2);
        gu.uAoStrength.value = 0.0;
        gu.tAO.value = this.dummyWhiteTex;
      }
    } else {
      gu.uAoStrength.value = 0.0;
      gu.tAO.value = this.dummyWhiteTex;
    }
    this.camera.aspect = this.W / this.H;
    this.camera.updateProjectionMatrix();
  }

  public ensurePlayerRig(slot: number, avatar: AvatarConfig): CharacterRig {
    const existing = this.playerRigs[slot];
    if (existing && avatarsEqual(this.rigAvatarCache[slot], avatar)) return existing;
    if (existing) {
      if (existing.root.parent) existing.root.parent.remove(existing.root);
      disposeRig(existing.root);
    }
    const rig = buildCharacterRig(avatar, this.assets, this.maxAniso, true);
    this.venues.root.add(rig.root);
    this.playerRigs[slot] = rig;
    this.rigAvatarCache[slot] = structuredClone(avatar);
    return rig;
  }

  public snapGameplayCam(you: PlayerState): void {
    this.cam.ex = you.x * 0.5;
    this.cam.ey = 4.9;
    this.cam.ez = -9.6;
    this.cam.tx = 0;
    this.cam.ty = 0.95;
    this.cam.tz = NET;
  }

  public updateCamera(
    dt: number,
    game: GameState,
    you: PlayerState,
    ball: BallState,
    replay: ReplaySystem,
    trophyCeremony: boolean,
    spectator?: { active: boolean; mode: SpectatorCamMode; followPlayer: PlayerState }
  ): void {
    this.cam.shake = Math.max(0, this.cam.shake - dt * 3.4);
    this.cam.zoomPunch = Math.max(0, this.cam.zoomPunch - dt * 2.4);
    const inUmpireChair =
      !!spectator?.active &&
      spectator.mode === "umpire" &&
      !replay.active &&
      !replay.hawkeye.active &&
      game.phase !== "title" &&
      game.phase !== "matchOver" &&
      game.phase !== "trainOver";
    this.courtLife.setUmpireVisible(!inUmpireChair);

    // 1. Hawk-Eye close-line laser zoom camera!
    if (replay.hawkeye.active) {
      const he = replay.hawkeye;
      const u = clamp(he.timer / 0.55, 0, 1);
      const wantEx = he.x + (he.x >= 0 ? 1.85 : -1.85);
      const wantEy = lerp(2.2, 0.78, u);
      const wantEz = he.z - 2.25;
      const k = clamp(dt * 7.5, 0, 1);
      this.cam.ex = lerp(this.cam.ex, wantEx, k);
      this.cam.ey = lerp(this.cam.ey, wantEy, k);
      this.cam.ez = lerp(this.cam.ez, wantEz, k);
      this.cam.tx = lerp(this.cam.tx, he.x, k);
      this.cam.ty = lerp(this.cam.ty, 0.08, k);
      this.cam.tz = lerp(this.cam.tz, he.z, k);
      return;
    }

    // 2. Slow-Mo Instant Replay dramatic courtside broadcast camera!
    if (replay.active) {
      const angle = 0.65 + replay.playTimer * 0.22;
      const wantEx = Math.sin(angle) * 9.5;
      const wantEy = 3.1;
      const wantEz = NET - Math.cos(angle) * 10.5;
      const k = clamp(dt * 5.0, 0, 1);
      this.cam.ex = lerp(this.cam.ex, wantEx, k);
      this.cam.ey = lerp(this.cam.ey, wantEy, k);
      this.cam.ez = lerp(this.cam.ez, wantEz, k);
      this.cam.tx = lerp(this.cam.tx, clamp(ball.x * 0.65, -4, 4), k);
      this.cam.ty = lerp(this.cam.ty, clamp(0.85 + ball.y * 0.3, 0.7, 2.5), k);
      this.cam.tz = lerp(this.cam.tz, clamp(ball.z, 2, 21), k);
      return;
    }

    // 3. Avatar & Racket Customizer live 3D studio orbit camera!
    if (game.phase === "customizer") {
      this.cam.customizerYaw += dt * 0.22;
      const r = 3.05;
      const cx = you.x + Math.sin(this.cam.customizerYaw) * r;
      const cz = you.z + Math.cos(this.cam.customizerYaw) * r;
      const k = clamp(dt * 6, 0, 1);
      this.cam.ex = lerp(this.cam.ex, cx, k);
      this.cam.ey = lerp(this.cam.ey, 1.48, k);
      this.cam.ez = lerp(this.cam.ez, cz, k);
      this.cam.tx = lerp(this.cam.tx, you.x, k);
      this.cam.ty = lerp(this.cam.ty, 1.05, k);
      this.cam.tz = lerp(this.cam.tz, you.z, k);
      return;
    }

    // 4. Lagoon Cup Trophy Ceremony camera
    if (trophyCeremony) {
      this.cam.orbitA += dt * 0.32;
      const k = clamp(dt * 3, 0, 1);
      this.cam.ex = lerp(this.cam.ex, Math.sin(this.cam.orbitA) * 3.8, k);
      this.cam.ey = lerp(this.cam.ey, 1.9, k);
      this.cam.ez = lerp(this.cam.ez, NET - 2.6 - Math.cos(this.cam.orbitA) * 3.8, k);
      this.cam.tx = lerp(this.cam.tx, 0, k);
      this.cam.ty = lerp(this.cam.ty, 1.18, k);
      this.cam.tz = lerp(this.cam.tz, NET - 2.6, k);
      return;
    }

    // 5. Title / End orbit camera
    const ph = game.phase;
    if (ph === "title" || ph === "matchOver" || ph === "trainOver") {
      this.cam.orbitA += dt * 0.14;
      const tx = Math.sin(this.cam.orbitA) * 14.5;
      const tz = NET - Math.cos(this.cam.orbitA) * 21.5;
      const k = clamp(dt * 2, 0, 1);
      this.cam.ex = lerp(this.cam.ex, tx, k);
      this.cam.ey = lerp(this.cam.ey, 6.2 + Math.sin(this.cam.orbitA * 1.5) * 0.8, k);
      this.cam.ez = lerp(this.cam.ez, tz, k);
      this.cam.tx = lerp(this.cam.tx, 0, k);
      this.cam.ty = lerp(this.cam.ty, 1.0, k);
      this.cam.tz = lerp(this.cam.tz, NET, k);
      return;
    }

    // 5b. Live Spectator Camera Modes (Umpire Chair POV, TV Broadcast, Courtside, Follow, Orbit)
    if (spectator?.active) {
      const mode = spectator.mode;
      const bx = ball.visible ? ball.x : 0;
      const by = ball.visible ? ball.y : 1.0;
      const bz = ball.visible ? ball.z : NET;
      let wantEx = 0, wantEy = 7.2, wantEz = -12.0;
      let wantTx = clamp(bx * 0.25, -3.5, 3.5);
      let wantTy = clamp(0.85 + by * 0.2, 0.75, 2.2);
      let wantTz = clamp(bz, 2.0, 21.8);
      let speed = 5.5;

      if (mode === "umpire") {
        // Seated inside the high Umpire Chair at (-7.35, 0, NET) looking right in front of the umbrella canopy straight down the net!
        wantEx = -6.78;
        wantEy = 2.55;
        wantEz = NET;
        wantTx = clamp(bx * 0.50 + 1.2, -3.0, 6.0);
        wantTy = clamp(0.95 + by * 0.26, 0.85, 2.5);
        wantTz = clamp(lerp(NET, bz, 0.78), 1.2, 22.5);
        speed = 7.5;
      } else if (mode === "broadcast") {
        wantEx = clamp(bx * 0.16, -2.6, 2.6);
        wantEy = 7.6;
        wantEz = -12.6;
        wantTx = clamp(bx * 0.22, -2.8, 2.8);
        wantTy = 0.9;
        wantTz = NET;
        speed = 4.2;
      } else if (mode === "courtside") {
        wantEx = 8.9;
        wantEy = 1.62;
        wantEz = NET - 2.4;
        wantTx = clamp(bx * 0.45, -4.5, 4.5);
        wantTy = clamp(0.85 + by * 0.25, 0.8, 2.3);
        wantTz = clamp(bz, 1.5, 22.2);
        speed = 6.2;
      } else if (mode === "follow") {
        const fp = spectator.followPlayer;
        const farSide = fp.team === 1;
        wantEx = clamp(fp.x * 0.45, -4.4, 4.4);
        wantEy = 5.2;
        wantEz = farSide ? 23.77 + 10.0 : -10.0;
        wantTx = clamp(bx * 0.24, -2.8, 2.8);
        wantTy = clamp(0.8 + by * 0.12, 0.8, 1.8);
        wantTz = NET;
        speed = 5.0;
      } else {
        this.cam.orbitA += dt * 0.20;
        wantEx = Math.sin(this.cam.orbitA) * 14.2;
        wantEy = 6.6 + Math.sin(this.cam.orbitA * 1.4) * 0.7;
        wantEz = NET - Math.cos(this.cam.orbitA) * 19.5;
        wantTx = 0;
        wantTy = 1.0;
        wantTz = NET;
        speed = 3.2;
      }

      const k = clamp(dt * speed, 0, 1);
      this.cam.ex = lerp(this.cam.ex, wantEx, k);
      this.cam.ey = lerp(this.cam.ey, wantEy, k);
      this.cam.ez = lerp(this.cam.ez, wantEz, k);
      this.cam.tx = lerp(this.cam.tx, wantTx, k);
      this.cam.ty = lerp(this.cam.ty, wantTy, k);
      this.cam.tz = lerp(this.cam.tz, wantTz, k);
      return;
    }

    // 6. Standard dynamic Wii-broadcast gameplay camera
    const serving = ph === "serveReady" || ph === "toss";
    const wantEx = serving ? you.x * 0.52 : clamp(you.x * 0.36 + (ball.visible ? ball.x * 0.14 : 0), -4.4, 4.4);
    const wantEy = serving ? 4.75 : 5.45 - this.cam.zoomPunch * 0.35;
    const wantEz = serving ? -9.2 : -10.2 + clamp((you.z + 0.8) * 0.24, -0.4, 2.3);
    const wantTx = ball.visible ? clamp(ball.x * 0.22, -2.5, 2.5) : you.x * 0.2;
    const wantTy = ball.visible ? clamp(0.75 + ball.y * 0.12, 0.75, 1.75) : 0.95;
    const wantTz = serving ? NET + 0.6 : NET - 0.3;
    const k = clamp(dt * 4.5, 0, 1);
    this.cam.ex = lerp(this.cam.ex, wantEx, k);
    this.cam.ey = lerp(this.cam.ey, wantEy, k);
    this.cam.ez = lerp(this.cam.ez, wantEz, k);
    this.cam.tx = lerp(this.cam.tx, wantTx, k);
    this.cam.ty = lerp(this.cam.ty, wantTy, k);
    this.cam.tz = lerp(this.cam.tz, wantTz, k);
  }

  public render(params: {
    now: number;
    dt: number;
    preset: SkyPreset;
    venueId: VenueId;
    game: GameState;
    players: PlayerState[];
    avatars: AvatarConfig[];
    visibleSlots: boolean[];
    ball: BallState;
    netHit: NetHitState;
    crowdCheer: number;
    crowdHop: number;
    marks: BounceMark[];
    trail: Array<{ x: number; y: number; z: number }>;
    training: TrainingState;
    replay: ReplaySystem;
    trophyCeremony: boolean;
    focusSlot?: PlayerSlot;
    isSpectator?: boolean;
  }): void {
    const { now, dt, preset, venueId, game, players, avatars, visibleSlots, ball, netHit, crowdCheer, crowdHop, marks, trail, training, replay, trophyCeremony } = params;
    const focusSlot: PlayerSlot = params.focusSlot ?? 0;
    const isSpectator = !!params.isSpectator;

    if (this.venues.activeVenue !== venueId) {
      this.venues.setVenue(venueId);
      this.renderer.shadowMap.needsUpdate = true;
    }
    if (this.appliedPreset !== preset) {
      this.applyPreset(preset);
      this.renderer.shadowMap.needsUpdate = true;
    }
    // Cap shadow map re-rasterization to 60Hz (every frame on 60Hz displays; saves 50% shadow GPU load on 120Hz+ displays!)
    if (this.lastShadowTime < 0 || now - this.lastShadowTime >= 1 / 62) {
      this.lastShadowTime = now;
      this.renderer.shadowMap.needsUpdate = true;
    }

    this.venues.trophyDisplay.visible = trophyCeremony;
    if (this.venues.trainingBasket) {
      this.venues.trainingBasket.visible = game.mode === "training";
    }

    // Update Camera
    const aspect = this.W / this.H;
    this.camera.fov = ((aspect < 1 ? 56 : 45) * DEG - this.cam.zoomPunch * 0.09) / DEG;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    const shX = (Math.random() - 0.5) * this.cam.shake * 0.24;
    const shY = (Math.random() - 0.5) * this.cam.shake * 0.18;
    this.camera.position.set(this.cam.ex + shX, this.cam.ey + shY, this.cam.ez);
    this.camera.lookAt(this.cam.tx, this.cam.ty, this.cam.tz);
    this.camera.updateMatrixWorld();

    this.sky.position.copy(this.camera.position);
    this.skyUniforms.uTime.value = now;
    if (this.water) (this.water.material as THREE.ShaderMaterial).uniforms.time.value = now;

    // Characters (up to 4 for Doubles!)
    for (let i = 0; i < players.length; i++) {
      const rig = this.ensurePlayerRig(i, avatars[i]);
      rig.root.visible = visibleSlots[i];
      if (visibleSlots[i]) {
        poseCharacterRig(rig, players[i], ball, now, dt, players[i].team === 0, i === focusSlot);
      }
    }

    // Ball
    this.ballMesh.visible = ball.visible;
    if (ball.visible) {
      const bRad = ball.rocket ? 0.115 : 0.095;
      this.ballMesh.position.set(ball.x, ball.y, ball.z);
      this.ballMesh.rotation.set(ball.rotX, ball.rotY, ball.rotZ);
      this.ballMesh.scale.setScalar(bRad);
      this.ballMat.emissiveIntensity = ball.rocket ? 1.6 : ball.crit ? 0.7 : 0.02;
      this.ballMat.emissive.setRGB(1.0, ball.rocket ? 0.92 : 1.0, ball.rocket ? 0.6 : 1.0);
      this.ballLight.position.copy(this.ballMesh.position);
      this.ballLight.intensity = ball.rocket ? 2.2 : ball.crit ? 0.8 : 0;
      this.ballLight.color.setRGB(1.0, ball.rocket ? 0.9 : 0.85, ball.rocket ? 0.55 : 0.4);
    } else {
      this.ballLight.intensity = 0;
    }

    // Environment & living court
    this.venues.animate(now, netHit);
    this.courtLife.update(now, crowdCheer, crowdHop, ball);

    // Training target rings
    this.ringMeshes.forEach((m) => (m.visible = false));
    if (game.mode === "training" && training.drill === "rings") {
      training.rings.forEach((rg, i) => {
        const m = this.ringMeshes[i];
        if (!m || !rg.active) return;
        const pulse = 1 + Math.sin(now * 6 + rg.seed) * 0.06;
        m.visible = true;
        m.position.set(rg.x, rg.y, rg.z);
        m.rotation.set(0, Math.sin(now * 1.8 + rg.seed) * 0.18, 0);
        m.scale.setScalar(rg.r * pulse);
        const c = rg.gold ? [1.0, 0.86, 0.20] : [0.22, 0.94, 0.96];
        const mat = m.material as THREE.MeshStandardMaterial;
        mat.color.setRGB(c[0], c[1], c[2]);
        mat.emissive.setRGB(c[0], c[1], c[2]);
        mat.emissiveIntensity = rg.gold ? 3.4 : 2.5;
      });
    }

    // Overhead smash cue position
    const focusP = players[focusSlot] || players[0];
    let smashCuePos: { x: number; z: number } | null = null;
    if (
      !isSpectator &&
      ball.visible &&
      ball.live &&
      ball.lastHitter === 1 &&
      ball.y >= 1.95 &&
      ball.z < NET &&
      ball.z > NET - 5.2 &&
      !replay.active
    ) {
      smashCuePos = { x: ball.x, z: ball.z };
    }

    const venueDef = VENUES[venueId];
    const overDeck = isOverDeck(ball.x, ball.z, venueDef);
    const serveTarget =
      game.mode === "training" && training.drill === "serve" && training.serveTarget
        ? { x: training.serveTarget.x, z: training.serveTarget.z, r: training.serveTarget.r }
        : null;

    // VFX (grounded ball shadow, smash star, rings, splash ripples, trails, particles)
    this.vfx.renderVfx(
      this.camera,
      this.H,
      this.DPR,
      now,
      ball,
      marks,
      trail,
      focusP,
      avatars[focusSlot]?.trail || avatars[0].trail,
      overDeck,
      smashCuePos,
      serveTarget,
      () => {
        // Incoming bounce target + sweet-spot timing ring + toss apex flash + Hawk-Eye highlight
        if (replay.hawkeye.active) {
          const he = replay.hawkeye;
          const col: RGB = he.isIn ? [0.22, 0.98, 0.56] : [1.0, 0.28, 0.18];
          this.vfx.drawRing(he.x, 0.032, he.z, 0.26 + Math.sin(now * 14) * 0.04, col, 0.96, 0.65, 1);
        }
        if (!isSpectator && !replay.active && ball.visible && ball.live && ball.lastHitter === 1 && (game.phase === "rally" || game.phase === "training")) {
          const activeNear =
            focusSlot === 0 &&
            game.config.discipline === "doubles" && visibleSlots[2] &&
            Math.hypot(ball.x - players[2].x, ball.z - players[2].z) < Math.hypot(ball.x - focusP.x, ball.z - focusP.z) &&
            game.mode !== "net"
              ? players[2]
              : focusP;
          if (activeNear.aimTarget && ball.bounceCount === 0 && activeNear.aimTarget.z < NET) {
            this.vfx.drawRing(
              activeNear.aimTarget.x,
              0.024,
              activeNear.aimTarget.z,
              0.34 + Math.sin(now * 14) * 0.05,
              [1.0, 0.86, 0.25],
              0.76,
              0.74,
              0
            );
          }
          const dz = ball.z - activeNear.z;
          const dx = Math.abs(ball.x - activeNear.x);
          if (dz > -1.1 && dz < 3.6 && dx < 3.5) {
            const inSweet = Math.abs(dz - 0.26) < 0.42 && dx <= 2.25;
            const inDive = dx > 2.25 && dx <= 3.45;
            const rCol: RGB = inSweet
              ? [1.0, 0.90, 0.26]
              : inDive
              ? [1.0, 0.48, 0.22]
              : dz < 1.85
              ? [0.35, 0.94, 0.88]
              : [1.0, 1.0, 1.0];
            this.vfx.drawRing(
              activeNear.x,
              0.026,
              activeNear.z + 0.25,
              clamp(0.45 + Math.abs(dz - 0.26) * 0.24, 0.45, 1.25),
              rCol,
              inSweet ? 0.94 : 0.48,
              0.78,
              inSweet ? 1 : 0
            );
          }
        }
        if (game.phase === "toss" && ball.visible) {
          const dtA = Math.abs(game.tossT - TOSS_VY / G);
          if (dtA < 0.16) {
            const k = 1 - dtA / 0.16;
            this.vfx.drawRing(ball.x, 0.026, ball.z, 0.25 + k * 0.45, [1.0, 0.90, 0.28], k * 0.88, 0.72, 1);
          }
        }
      }
    );

    // Lens flare sun projection
    this._sunP.copy(this.camera.position).addScaledVector(this._sunDir, 100);
    this.camera.getWorldDirection(this._fwd);
    const gu = this.gradePass.uniforms;
    if (this._fwd.dot(this._sunDir) > 0.05) {
      this._sunP.project(this.camera);
      gu.uSunUV.value.set(this._sunP.x * 0.5 + 0.5, this._sunP.y * 0.5 + 0.5);
      gu.uSunVis.value = 1;
    } else {
      gu.uSunUV.value.set(-2, -2);
      gu.uSunVis.value = 0;
    }
    gu.uAspect.value = aspect;
    gu.uTime.value = now;

    this.renderer.info.autoReset = false;
    this.renderer.info.reset();
    this.composer.render();
    this.lastRenderCalls = this.renderer.info.render.calls;
    this.lastRenderTris = this.renderer.info.render.triangles;
  }
}
