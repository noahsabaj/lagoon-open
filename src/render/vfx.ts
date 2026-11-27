import * as THREE from "three";
import { clamp, lerp, rand, TAU, TRAIL_CATALOG } from "../core/constants";
import type { BallState, BounceMark, PlayerState, RGB, TrailSkinId } from "../core/types";

const TRAIL_BY_ID = new Map(TRAIL_CATALOG.map((s) => [s.id, s]));

const ADD_BLEND = {
  transparent: true,
  depthWrite: false,
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneFactor,
  fog: false,
};

interface RibbonHandle {
  mesh: THREE.Mesh;
  geo: THREE.BufferGeometry;
  pos: Float32Array;
  uv: Float32Array;
  col: Float32Array;
  maxPts: number;
}

interface WaterRipple {
  x: number;
  y: number;
  z: number;
  age: number;
  maxAge: number;
}

const MAX_PART = 640;
const MAX_RINGS = 40;

export class VfxSystem {
  public group = new THREE.Group();

  private parts = {
    n: 0,
    x: new Float32Array(MAX_PART), y: new Float32Array(MAX_PART), z: new Float32Array(MAX_PART),
    vx: new Float32Array(MAX_PART), vy: new Float32Array(MAX_PART), vz: new Float32Array(MAX_PART),
    r: new Float32Array(MAX_PART), g: new Float32Array(MAX_PART), b: new Float32Array(MAX_PART),
    sz: new Float32Array(MAX_PART), life: new Float32Array(MAX_PART), maxL: new Float32Array(MAX_PART),
    grav: new Float32Array(MAX_PART), emit: new Float32Array(MAX_PART),
    iPos: new Float32Array(MAX_PART * 3), iCol: new Float32Array(MAX_PART * 4), iExt: new Float32Array(MAX_PART * 2),
  };
  private partGeo: THREE.BufferGeometry;
  private partMat: THREE.ShaderMaterial;
  private partPoints: THREE.Points;

  private ballRib: RibbonHandle;
  private swingRib: RibbonHandle;

  // Single instanced court-ring batch (replaces 40 individual meshes & 40 ShaderMaterials with 1 draw call!)
  private ringMesh: THREE.InstancedMesh;
  private ringColArr = new Float32Array(MAX_RINGS * 4);
  private ringParamArr = new Float32Array(MAX_RINGS * 4);
  private ringColAttr: THREE.InstancedBufferAttribute;
  private ringParamAttr: THREE.InstancedBufferAttribute;
  private _ringMat4 = new THREE.Matrix4();
  private ringUsed = 0;

  // Grounded contact ball drop-shadow (stays directly under ball at ANY sun elevation!)
  private ballShadow: THREE.Mesh;
  private ballShadowMat: THREE.ShaderMaterial;

  // Overhead Smash Star court cue
  private smashStar: THREE.Mesh;
  private smashStarMat: THREE.ShaderMaterial;

  // Water splash expanding ripples
  private waterRipples: WaterRipple[] = [];

  public onBroadcastFx: ((kind: string, args: unknown[]) => void) | null = null;
  public mirrorCoords: ((x: number, z: number) => [number, number]) | null = null;

  constructor(scene: THREE.Scene) {
    scene.add(this.group);

    // 1. Additive GPU Points particle pool
    this.partGeo = new THREE.BufferGeometry();
    this.partGeo.setAttribute("position", new THREE.BufferAttribute(this.parts.iPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.partGeo.setAttribute("aCol", new THREE.BufferAttribute(this.parts.iCol, 4).setUsage(THREE.DynamicDrawUsage));
    this.partGeo.setAttribute("aExt", new THREE.BufferAttribute(this.parts.iExt, 2).setUsage(THREE.DynamicDrawUsage));
    this.partMat = new THREE.ShaderMaterial({
      ...ADD_BLEND,
      uniforms: { uScale: { value: 500 } },
      vertexShader: `attribute vec4 aCol;attribute vec2 aExt;uniform float uScale;varying vec4 vCol;varying float vEmit;
void main(){vec4 mv=modelViewMatrix*vec4(position,1.0);gl_Position=projectionMatrix*mv;gl_PointSize=max(1.0,aExt.x*2.0*uScale/max(-mv.z,0.05));vCol=aCol;vEmit=aExt.y;}`,
      fragmentShader: `varying vec4 vCol;varying float vEmit;
void main(){vec2 p=gl_PointCoord*2.0-1.0;float m=1.0-smoothstep(0.14,1.0,length(p));float a=m*vCol.a;gl_FragColor=vec4(vCol.rgb*vEmit*a,0.0);}`,
    });
    this.partPoints = new THREE.Points(this.partGeo, this.partMat);
    this.partPoints.frustumCulled = false;
    this.partPoints.renderOrder = 12;
    this.group.add(this.partPoints);

    // 2. Ball & Swing Ribbons
    this.ballRib = this.createRibbon(28);
    this.swingRib = this.createRibbon(16);

    // 3. Single Instanced Court Rings Batch (bounce marks, landing cue, timing ring, water splash ripples, training zone)
    const ringGeo = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    const instRingGeo = ringGeo.clone();
    this.ringColAttr = new THREE.InstancedBufferAttribute(this.ringColArr, 4).setUsage(THREE.DynamicDrawUsage);
    this.ringParamAttr = new THREE.InstancedBufferAttribute(this.ringParamArr, 4).setUsage(THREE.DynamicDrawUsage);
    instRingGeo.setAttribute("aColA", this.ringColAttr);
    instRingGeo.setAttribute("aParam", this.ringParamAttr);
    const ringMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      fog: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      vertexShader: `attribute vec4 aColA;attribute vec4 aParam;varying vec2 vUv;varying vec4 vColA;varying vec4 vParam;
void main(){vUv=uv;vColA=aColA;vParam=aParam;gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.0);}`,
      fragmentShader: `varying vec2 vUv;varying vec4 vColA;varying vec4 vParam;
void main(){vec2 p=vUv*2.0-1.0;float r=length(p),s=max(vParam.y,0.001);
float m=smoothstep(vParam.x-s,vParam.x,r)*(1.0-smoothstep(1.0-s,1.0,r));float a=m*vColA.a;
gl_FragColor=vec4(vColA.rgb*vParam.z*a,vParam.w>0.5?0.0:a);}`,
    });
    this.ringMesh = new THREE.InstancedMesh(instRingGeo, ringMat, MAX_RINGS);
    this.ringMesh.count = 0;
    this.ringMesh.visible = false;
    this.ringMesh.frustumCulled = false;
    this.ringMesh.renderOrder = 10;
    this.ringMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.ringMesh);

    // 4. Grounded vertical ball contact drop-shadow
    this.ballShadowMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      fog: false,
      uniforms: { uAlpha: { value: 0.5 } },
      vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
      fragmentShader: `uniform float uAlpha;varying vec2 vUv;
void main(){float r=length(vUv*2.0-1.0);float a=(1.0-smoothstep(0.15,1.0,r))*uAlpha;gl_FragColor=vec4(0.02,0.06,0.08,a);}`,
    });
    this.ballShadow = new THREE.Mesh(ringGeo, this.ballShadowMat);
    this.ballShadow.visible = false;
    this.ballShadow.renderOrder = 9;
    this.group.add(this.ballShadow);

    // 5. Overhead Smash Star marker on court beneath hittable lobs!
    this.smashStarMat = new THREE.ShaderMaterial({
      ...ADD_BLEND,
      uniforms: { uTime: { value: 0 }, uAlpha: { value: 0.9 } },
      vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
      fragmentShader: `uniform float uTime,uAlpha;varying vec2 vUv;
void main(){
  vec2 p=vUv*2.0-1.0;
  float r=length(p);
  float ang=atan(p.y,p.x)+uTime*2.4;
  float star=0.58+0.34*cos(ang*5.0);
  float fill=1.0-smoothstep(star-0.08,star+0.04,r);
  float ring=smoothstep(0.76,0.82,r)*(1.0-smoothstep(0.92,0.98,r));
  float m=max(fill*0.55,ring);
  vec3 col=mix(vec3(1.0,0.45,0.12),vec3(1.0,0.94,0.38),fill);
  gl_FragColor=vec4(col*2.8*m*uAlpha,0.0);
}`,
    });
    this.smashStar = new THREE.Mesh(ringGeo, this.smashStarMat);
    this.smashStar.visible = false;
    this.smashStar.renderOrder = 11;
    this.group.add(this.smashStar);
  }

  private createRibbon(maxPts: number): RibbonHandle {
    const geo = new THREE.BufferGeometry();
    const maxV = maxPts * 2;
    const pos = new Float32Array(maxV * 3);
    const uv = new Float32Array(maxV * 2);
    const col = new Float32Array(maxV * 4);
    const idx: number[] = [];
    for (let i = 0; i < maxPts - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aCol", new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      ...ADD_BLEND,
      side: THREE.DoubleSide,
      uniforms: { uSoft: { value: 0.2 }, uEmit: { value: 2.4 } },
      vertexShader: `attribute vec4 aCol;varying vec2 vUv;varying vec4 vCol;void main(){vUv=uv;vCol=aCol;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
      fragmentShader: `uniform float uSoft,uEmit;varying vec2 vUv;varying vec4 vCol;
void main(){float s=max(uSoft,0.001);float m=smoothstep(0.0,s,vUv.x)*smoothstep(0.0,s,1.0-vUv.x);float a=m*vCol.a;gl_FragColor=vec4(vCol.rgb*uEmit*a,0.0);}`,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 11;
    mesh.visible = false;
    this.group.add(mesh);
    return { mesh, geo, pos, uv, col, maxPts };
  }

  private spawnPart(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    r: number, g: number, b: number,
    sz: number, life: number, grav = 4.0, emit = 2.0
  ): void {
    let i = this.parts.n;
    if (i >= MAX_PART) i = (Math.random() * MAX_PART) | 0;
    else this.parts.n++;
    this.parts.x[i] = x; this.parts.y[i] = y; this.parts.z[i] = z;
    this.parts.vx[i] = vx; this.parts.vy[i] = vy; this.parts.vz[i] = vz;
    this.parts.r[i] = r; this.parts.g[i] = g; this.parts.b[i] = b;
    this.parts.sz[i] = sz; this.parts.life[i] = life; this.parts.maxL[i] = life;
    this.parts.grav[i] = grav; this.parts.emit[i] = emit;
  }

  private mapXZ(x: number, z: number): [number, number] {
    return this.mirrorCoords ? this.mirrorCoords(x, z) : [x, z];
  }

  public burstSparks(x: number, y: number, z: number, col: RGB, count = 24, spd = 5.5, sz = 0.08, emit = 3.2): void {
    [x, z] = this.mapXZ(x, z);
    if (this.onBroadcastFx) this.onBroadcastFx("sparks", [x, y, z, col, count, spd, sz, emit]);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const el = rand(-0.3, 1.1);
      const s = rand(0.35, 1.0) * spd;
      this.spawnPart(
        x, y, z,
        Math.cos(a) * Math.cos(el) * s, Math.sin(el) * s + 1.2, Math.sin(a) * Math.cos(el) * s,
        col[0], col[1], col[2], sz * rand(0.6, 1.4), rand(0.22, 0.55), 7.0, emit
      );
    }
  }

  public burstDust(x: number, z: number, count = 10, col: RGB = [0.95, 0.92, 0.80]): void {
    [x, z] = this.mapXZ(x, z);
    if (this.onBroadcastFx) this.onBroadcastFx("dust", [x, z, count, col]);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const s = rand(0.6, 2.4);
      this.spawnPart(
        x, 0.06, z,
        Math.cos(a) * s, rand(0.5, 1.9), Math.sin(a) * s,
        col[0], col[1], col[2], rand(0.08, 0.16), rand(0.28, 0.58), 3.0, 0.85
      );
    }
  }

  public burstSplash(x: number, z: number, waterY = -1.5): void {
    [x, z] = this.mapXZ(x, z);
    if (this.onBroadcastFx) this.onBroadcastFx("splash", [x, z, waterY]);
    // Plume of foaming turquoise/white water droplets
    for (let i = 0; i < 34; i++) {
      const a = Math.random() * TAU;
      const s = rand(0.4, 2.6);
      const isFoam = i % 2 === 0;
      this.spawnPart(
        x + rand(-0.12, 0.12), waterY + 0.06, z + rand(-0.12, 0.12),
        Math.cos(a) * s, rand(2.2, 5.2), Math.sin(a) * s,
        isFoam ? 0.92 : 0.35, isFoam ? 0.98 : 0.88, 1.0,
        rand(0.08, 0.16), rand(0.45, 0.95), 9.2, 1.4
      );
    }
    this.waterRipples.push({ x, y: waterY + 0.04, z, age: 0, maxAge: 1.65 });
    this.waterRipples.push({ x, y: waterY + 0.04, z, age: -0.22, maxAge: 1.85 });
  }

  public burstConfetti(x: number, y: number, z: number, count = 65): void {
    [x, z] = this.mapXZ(x, z);
    if (this.onBroadcastFx) this.onBroadcastFx("confetti", [x, y, z, count]);
    const cols: RGB[] = [[1, 0.38, 0.22], [1, 0.84, 0.22], [0.26, 0.92, 0.84], [1, 0.96, 0.88], [1, 0.45, 0.75]];
    for (let i = 0; i < count; i++) {
      const c = cols[i % cols.length];
      const a = Math.random() * TAU;
      const s = rand(1.5, 6.5);
      this.spawnPart(
        x + rand(-1.5, 1.5), y + rand(0, 1.5), z + rand(-1.5, 1.5),
        Math.cos(a) * s, rand(3.5, 8.5), Math.sin(a) * s,
        c[0], c[1], c[2], rand(0.11, 0.19), rand(1.2, 2.2), 3.4, 2.4
      );
    }
  }

  public updateParticles(dt: number, waterY = -1.5): void {
    let out = 0;
    const p = this.parts;
    for (let i = 0; i < p.n; i++) {
      const nl = p.life[i] - dt;
      if (nl <= 0) {
        const last = --p.n;
        if (i < last) {
          p.x[i] = p.x[last]; p.y[i] = p.y[last]; p.z[i] = p.z[last];
          p.vx[i] = p.vx[last]; p.vy[i] = p.vy[last]; p.vz[i] = p.vz[last];
          p.r[i] = p.r[last]; p.g[i] = p.g[last]; p.b[i] = p.b[last];
          p.sz[i] = p.sz[last]; p.life[i] = p.life[last]; p.maxL[i] = p.maxL[last];
          p.grav[i] = p.grav[last]; p.emit[i] = p.emit[last];
        }
        i--;
        continue;
      }
      p.life[i] = nl;
      p.vy[i] -= p.grav[i] * dt;
      p.x[i] += p.vx[i] * dt;
      p.y[i] += p.vy[i] * dt;
      p.z[i] += p.vz[i] * dt;
      const floorY = Math.abs(p.x[i]) <= 13.4 && p.z[i] >= -6.2 && p.z[i] <= 30.4 ? 0.03 : waterY;
      if (p.y[i] < floorY) {
        p.y[i] = floorY;
        p.vy[i] *= -0.25;
        p.vx[i] *= 0.7;
        p.vz[i] *= 0.7;
      }
      const k = nl / p.maxL[i];
      const k3 = out * 3, k4 = out * 4, k2 = out * 2;
      p.iPos[k3] = p.x[i]; p.iPos[k3 + 1] = p.y[i]; p.iPos[k3 + 2] = p.z[i];
      p.iCol[k4] = p.r[i]; p.iCol[k4 + 1] = p.g[i]; p.iCol[k4 + 2] = p.b[i]; p.iCol[k4 + 3] = k;
      p.iExt[k2] = p.sz[i] * (0.45 + 0.55 * k); p.iExt[k2 + 1] = p.emit[i];
      out++;
    }

    for (let i = this.waterRipples.length - 1; i >= 0; i--) {
      this.waterRipples[i].age += dt;
      if (this.waterRipples[i].age > this.waterRipples[i].maxAge) {
        this.waterRipples.splice(i, 1);
      }
    }
  }

  public beginRings(): void {
    this.ringUsed = 0;
  }

  public drawRing(
    x: number, y: number, z: number, radius: number,
    col: RGB, alpha: number, inner = 0.72, additive = 0
  ): void {
    if (this.ringUsed >= MAX_RINGS) return;
    const idx = this.ringUsed++;
    const m = this._ringMat4;
    m.makeScale(radius, 1, radius);
    m.setPosition(x, y, z);
    this.ringMesh.setMatrixAt(idx, m);
    const o = idx * 4;
    this.ringColArr[o] = col[0];
    this.ringColArr[o + 1] = col[1];
    this.ringColArr[o + 2] = col[2];
    this.ringColArr[o + 3] = alpha;
    this.ringParamArr[o] = inner;
    this.ringParamArr[o + 1] = 0.09;
    this.ringParamArr[o + 2] = additive ? 2.6 : 1.2;
    this.ringParamArr[o + 3] = additive;
  }

  public endRings(): void {
    this.ringMesh.count = this.ringUsed;
    this.ringMesh.visible = this.ringUsed > 0;
    if (this.ringUsed > 0) {
      this.ringMesh.instanceMatrix.needsUpdate = true;
      this.ringColAttr.needsUpdate = true;
      this.ringParamAttr.needsUpdate = true;
    }
  }

  public renderVfx(
    camera: THREE.PerspectiveCamera,
    H: number,
    DPR: number,
    now: number,
    ball: BallState,
    marks: BounceMark[],
    trail: Array<{ x: number; y: number; z: number }>,
    nearPlayer: PlayerState,
    trailSkin: TrailSkinId,
    overDeck: boolean,
    smashCuePos: { x: number; z: number } | null,
    serveTargetZone: { x: number; z: number; r: number } | null,
    extraRings?: () => void
  ): void {
    // 1. Grounded contact ball shadow (always right below ball on court!)
    if (ball.visible && overDeck && !ball.splashed) {
      const h = Math.max(0, ball.y);
      const rad = lerp(0.14, 0.34, clamp(h / 5.0, 0, 1));
      const alpha = lerp(0.55, 0.14, clamp(h / 5.5, 0, 1));
      this.ballShadow.visible = true;
      this.ballShadow.position.set(ball.x, 0.021, ball.z);
      this.ballShadow.scale.set(rad, 1, rad);
      this.ballShadowMat.uniforms.uAlpha.value = alpha;
    } else {
      this.ballShadow.visible = false;
    }

    // 2. Overhead Smash Star court indicator!
    if (smashCuePos) {
      this.smashStar.visible = true;
      this.smashStar.position.set(smashCuePos.x, 0.028, smashCuePos.z);
      const pulse = 0.72 + Math.sin(now * 10) * 0.08;
      this.smashStar.scale.set(pulse, 1, pulse);
      this.smashStarMat.uniforms.uTime.value = now;
    } else {
      this.smashStar.visible = false;
    }

    // 3. Court rings (bounce marks + water splash ripples + training zone + caller cues)
    this.beginRings();
    for (const m of marks) {
      const k = m.age / 1.5;
      this.drawRing(m.x, 0.025, m.z, 0.18 + k * 0.55, m.out ? [1.0, 0.30, 0.18] : [0.98, 0.96, 0.88], (1 - k) * 0.88, 0.72, 0);
    }
    for (const r of this.waterRipples) {
      if (r.age < 0) continue;
      const k = r.age / r.maxAge;
      this.drawRing(r.x, r.y, r.z, 0.25 + k * 2.8, [0.78, 0.96, 1.0], (1 - k) * 0.78, 0.82, 0);
    }
    if (serveTargetZone) {
      this.drawRing(serveTargetZone.x, 0.026, serveTargetZone.z, serveTargetZone.r * (1 + Math.sin(now * 6) * 0.05), [0.22, 0.96, 0.92], 0.88, 0.72, 1);
    }
    if (extraRings) extraRings();
    this.endRings();

    // 4. Ball trail ribbon (respects unlockable trail skin!)
    const skin = TRAIL_BY_ID.get(trailSkin) || TRAIL_CATALOG[0];
    if (trail.length >= 2) {
      let c0: RGB = skin.c0;
      let c1: RGB = skin.c1;
      let rw = 0.095;
      let em = 2.4;
      if (ball.rocket) { c0 = [1.0, 0.98, 0.80]; c1 = [0.22, 0.78, 1.0]; rw = 0.175; em = 3.9; }
      else if (ball.shotTag === "drop") { c0 = [0.92, 0.98, 0.75]; c1 = [0.32, 0.85, 0.60]; rw = 0.075; em = 1.9; }
      else if (ball.shotTag === "slice") { c0 = [0.65, 0.98, 1.0]; c1 = [0.16, 0.56, 0.96]; rw = 0.10; em = 2.6; }
      else if (ball.shotTag === "smash") { c0 = [1.0, 0.95, 0.45]; c1 = [1.0, 0.22, 0.14]; rw = 0.16; em = 3.5; }
      else if (ball.shotTag === "lob") { c0 = [0.62, 1.0, 0.76]; c1 = [0.20, 0.72, 0.65]; rw = 0.085; em = 2.0; }
      else if (ball.crit) { rw = 0.14; em = 3.2; }
      this.uploadRibbon(camera, this.ballRib, trail, rw, c0, c1, false, 0.20, em);
    } else {
      this.ballRib.mesh.visible = false;
    }

    // 5. Swing arc ribbon
    if (nearPlayer.swingTrail.length >= 2) {
      const sCol: RGB =
        nearPlayer.swingType === "slice" || nearPlayer.swingType === "drop"
          ? [0.42, 0.92, 1.0]
          : nearPlayer.swingType === "smash" || nearPlayer.swingType === "serve"
          ? [1.0, 0.88, 0.30]
          : skin.c0;
      this.uploadRibbon(
        camera,
        this.swingRib,
        nearPlayer.swingTrail,
        0.1,
        sCol,
        [sCol[0] * 0.4, sCol[1] * 0.4, sCol[2] * 0.4],
        true,
        0.18,
        2.2
      );
    } else {
      this.swingRib.mesh.visible = false;
    }

    // 6. GPU Particles
    this.partPoints.visible = this.parts.n > 0;
    if (this.parts.n > 0) {
      for (const k of ["position", "aCol", "aExt"]) {
        this.partGeo.attributes[k].needsUpdate = true;
      }
      this.partGeo.setDrawRange(0, this.parts.n);
      this.partMat.uniforms.uScale.value = (H * DPR * 0.5) / Math.tan((camera.fov * Math.PI) / 360);
    }
  }

  private uploadRibbon(
    camera: THREE.PerspectiveCamera,
    rib: RibbonHandle,
    pts: Array<{ x: number; y: number; z: number } | [number, number, number, number, number, number]>,
    width: number,
    colStart: RGB,
    colEnd: RGB,
    isSwing: boolean,
    soft: number,
    emit: number
  ): void {
    const n = Math.min(pts.length, rib.maxPts);
    rib.mesh.visible = n >= 2;
    if (n < 2) return;
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;

    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const q = pts[i];
      const k = i * 2;
      let ax: number, ay: number, az: number, bx: number, by: number, bz: number;
      if (isSwing) {
        const s = q as [number, number, number, number, number, number];
        ax = s[0]; ay = s[1]; az = s[2]; bx = s[3]; by = s[4]; bz = s[5];
      } else {
        const qp = q as { x: number; y: number; z: number };
        const prev = pts[Math.max(0, i - 1)] as { x: number; y: number; z: number };
        const next = pts[Math.min(n - 1, i + 1)] as { x: number; y: number; z: number };
        const tx = next.x - prev.x, ty = next.y - prev.y, tz = next.z - prev.z;
        const vx = cx - qp.x, vy = cy - qp.y, vz = cz - qp.z;
        let sx = ty * vz - tz * vy, sy = tz * vx - tx * vz, sz = tx * vy - ty * vx;
        const sl = Math.hypot(sx, sy, sz) || 1;
        const hw = width * (0.15 + 0.85 * t);
        sx = (sx / sl) * hw; sy = (sy / sl) * hw; sz = (sz / sl) * hw;
        ax = qp.x - sx; ay = qp.y - sy; az = qp.z - sz;
        bx = qp.x + sx; by = qp.y + sy; bz = qp.z + sz;
      }
      const pOff = k * 3;
      rib.pos[pOff] = ax; rib.pos[pOff + 1] = ay; rib.pos[pOff + 2] = az;
      rib.pos[pOff + 3] = bx; rib.pos[pOff + 4] = by; rib.pos[pOff + 5] = bz;
      const uOff = k * 2;
      rib.uv[uOff] = 0; rib.uv[uOff + 1] = t;
      rib.uv[uOff + 2] = 1; rib.uv[uOff + 3] = t;
      const r = lerp(colEnd[0], colStart[0], t);
      const g = lerp(colEnd[1], colStart[1], t);
      const b = lerp(colEnd[2], colStart[2], t);
      const a = t * t * (isSwing ? 0.65 : 0.88);
      const cOff = k * 4;
      rib.col[cOff] = r; rib.col[cOff + 1] = g; rib.col[cOff + 2] = b; rib.col[cOff + 3] = a;
      rib.col[cOff + 4] = r; rib.col[cOff + 5] = g; rib.col[cOff + 6] = b; rib.col[cOff + 7] = a;
    }
    rib.geo.attributes.position.needsUpdate = true;
    rib.geo.attributes.uv.needsUpdate = true;
    rib.geo.attributes.aCol.needsUpdate = true;
    rib.geo.setDrawRange(0, (n - 1) * 6);
    const mat = rib.mesh.material as THREE.ShaderMaterial;
    mat.uniforms.uSoft.value = soft;
    mat.uniforms.uEmit.value = emit;
  }
}
