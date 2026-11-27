import * as THREE from "three";
import {
  clamp,
  FLOODLIGHT_XZ,
  L,
  LANTERN_XZ,
  lerp,
  NET,
  NETH,
  POST_H,
  POST_X,
  smoothstep,
  TAU,
  VENUES,
} from "../core/constants";
import type { RGB, SkyPreset, VenueId } from "../core/types";
import type { NetHitState } from "../physics/ballPhysics";
import { AssetManager, cloneWithFreshMaterials } from "./assets";
import { buildPrim, ISLANDS, islandPoint, MeshBuilder, type SharedGeos, WHITE } from "./geometry";
import { baseMatName, createInstancedPropMeshes, forEachMaterial, freezeStaticMatrices } from "./meshOptimize";
import { ihash, type TextureBundle } from "./textures";

const vcMat = (rough = 0.75, extra: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ vertexColors: true, roughness: rough, metalness: 0, ...extra });

function buildPierTrimGeo(deckHalfX: number, deckZMin: number, deckZMax: number, trimCol: RGB, railCol: RGB): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const darkWood: RGB = [0.24, 0.14, 0.08];
  const rope: RGB = [0.76, 0.66, 0.48];
  const midZ = (deckZMin + deckZMax) * 0.5;
  const halfZ = (deckZMax - deckZMin) * 0.5;

  // Rim fascia beams
  b.addBox(0, -0.35, deckZMax + 0.05, deckHalfX + 0.15, 0.28, 0.16, darkWood);
  b.addBox(0, -0.35, deckZMin - 0.05, deckHalfX + 0.15, 0.28, 0.16, darkWood);
  b.addBox(-deckHalfX - 0.05, -0.35, midZ, 0.16, 0.28, halfZ + 0.15, darkWood);
  b.addBox(deckHalfX + 0.05, -0.35, midZ, 0.16, 0.28, halfZ + 0.15, darkWood);

  // Court border curb
  b.addBox(0, 0.012, -5.08, 9.65, 0.025, 0.08, trimCol);
  b.addBox(0, 0.012, L + 5.08, 9.65, 0.025, 0.08, trimCol);
  b.addBox(-9.58, 0.012, NET, 0.08, 0.025, L / 2 + 5.16, trimCol);
  b.addBox(9.58, 0.012, NET, 0.08, 0.025, L / 2 + 5.16, trimCol);

  // Underwater pilings
  for (let z = deckZMin + 0.6; z <= deckZMax - 0.4; z += 5.8) {
    for (const x of [-deckHalfX + 0.5, deckHalfX - 0.5]) {
      b.addCyl(x, 0, z, 0.26, 0.24, -2.6, 0.05, 12, darkWood);
    }
  }
  for (let x = -8.5; x <= 8.6; x += 4.25) {
    b.addCyl(x, 0, deckZMax - 0.6, 0.26, 0.24, -2.6, 0.05, 12, darkWood);
    b.addCyl(x, 0, deckZMin + 0.6, 0.26, 0.24, -2.6, 0.05, 12, darkWood);
  }

  // Side rope railing posts
  const postZs = [-5.0, 0.5, 6.0, 11.885, 17.8, 23.5, 29.4];
  for (const sx of [-deckHalfX + 0.4, deckHalfX - 0.4]) {
    for (let i = 0; i < postZs.length; i++) {
      b.addCyl(sx, 0, postZs[i], 0.11, 0.10, 0, 1.05, 10, railCol);
      b.addSphere(sx, 1.08, postZs[i], 0.12, 0.09, 0.12, 10, 8, darkWood);
      if (i > 0) {
        const z0 = postZs[i - 1], z1 = postZs[i], segs = 10;
        for (let k = 0; k < segs; k++) {
          const t0 = k / segs, t1 = (k + 1) / segs;
          const y0 = 0.86 - Math.sin(t0 * Math.PI) * 0.24;
          const y1 = 0.86 - Math.sin(t1 * Math.PI) * 0.24;
          b.addBox(sx, (y0 + y1) * 0.5, lerp(z0, z1, (t0 + t1) * 0.5), 0.025, 0.025, ((z1 - z0) / segs) * 0.52, rope);
        }
      }
    }
  }

  // Bleachers on both sidelines
  const plank: RGB = [0.58, 0.34, 0.18];
  const support: RGB = [0.22, 0.13, 0.08];
  for (const side of [-1, 1]) {
    const xs = [10.35, 10.95, 11.55], ys = [0.46, 0.94, 1.42];
    for (let r = 0; r < 3; r++) {
      b.addBox(side * xs[r], ys[r], 11.2, 0.26, 0.045, 7.9, plank);
      for (let z = 4.2; z <= 18.5; z += 3.5) {
        b.addBox(side * xs[r], ys[r] * 0.5, z, 0.06, ys[r] * 0.5, 0.07, support);
      }
    }
  }

  // Net posts & center strap
  b.addCyl(-POST_X, 0, NET, 0.065, 0.06, 0, POST_H + 0.06, 16, [0.10, 0.16, 0.20]);
  b.addCyl(POST_X, 0, NET, 0.065, 0.06, 0, POST_H + 0.06, 16, [0.10, 0.16, 0.20]);
  b.addSphere(-POST_X, POST_H + 0.08, NET, 0.072, 0.05, 0.072, 12, 8, [0.95, 0.92, 0.84]);
  b.addSphere(POST_X, POST_H + 0.08, NET, 0.072, 0.05, 0.072, 12, 8, [0.95, 0.92, 0.84]);
  b.addBox(0, NETH * 0.5, NET, 0.035, NETH * 0.5, 0.015, [0.94, 0.92, 0.86]);

  return b.build();
}

function buildIslandPalmGeometry(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const barkDark: RGB = [0.19, 0.12, 0.07];
  const barkMid: RGB = [0.26, 0.17, 0.10];

  // Smooth curved tapered tubular trunk (continuous rings so there are no blocky joints)
  const rings = 8;
  const seg = 7;
  const trunkH = 5.3;
  const ringStarts: number[] = [];
  let px = 0;
  let py = 0;
  for (let r = 0; r <= rings; r++) {
    const t = r / rings;
    const cx = Math.sin(t * 1.15) * 0.85;
    const cy = t * trunkH;
    const rad = lerp(0.24, 0.095, t);
    // Tangent along curve in XY plane -> perpendicular normal in XY
    const tx = Math.cos(t * 1.15) * 1.15 * 0.85;
    const ty = trunkH;
    const tl = Math.hypot(tx, ty) || 1;
    const rx = ty / tl;
    const ry = -tx / tl;
    const col: RGB = r % 2 === 0 ? barkDark : barkMid;
    ringStarts.push(b.v);
    for (let s = 0; s <= seg; s++) {
      const a = (s / seg) * TAU;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const vx = cx + ca * rx * rad;
      const vy = cy + ca * ry * rad;
      const vz = sa * rad;
      b.vert(vx, vy, vz, ca * rx, ca * ry, sa, s / seg, t * 4, col);
    }
    px = cx;
    py = cy;
  }
  for (let r = 0; r < rings; r++) {
    const r0 = ringStarts[r];
    const r1 = ringStarts[r + 1];
    for (let s = 0; s < seg; s++) {
      b.quad(r0 + s, r1 + s, r1 + s + 1, r0 + s + 1);
    }
  }

  // Crown heart / coconut cluster
  b.addSphere(px, py - 0.06, 0, 0.24, 0.22, 0.24, 7, 5, [0.16, 0.11, 0.06]);

  // Two tiers of properly yaw-rotated, arched & drooping palm fronds with V-rib spine
  const leafDark: RGB = [0.08, 0.23, 0.10];
  const leafMid: RGB = [0.12, 0.30, 0.13];
  const leafTip: RGB = [0.15, 0.34, 0.14];
  const tiers = [
    { count: 5, offset: 0.0, len: 2.75, rise: 0.92, droop: 0.90, width: 0.44, yOff: 0.08 },
    { count: 6, offset: 0.52, len: 3.15, rise: 0.44, droop: 1.42, width: 0.48, yOff: -0.02 },
  ];
  const steps = [0.0, 0.26, 0.56, 0.82, 1.0];
  const widths = [0.06, 0.88, 1.0, 0.58, 0.0];

  for (let ti = 0; ti < tiers.length; ti++) {
    const tier = tiers[ti];
    for (let f = 0; f < tier.count; f++) {
      const yaw = ((f + tier.offset) / tier.count) * TAU;
      const dx = Math.sin(yaw);
      const dz = Math.cos(yaw);
      // Lateral tangent perpendicular to frond direction
      const lx = dz;
      const lz = -dx;
      const lenVar = tier.len * (0.92 + ((f * 37 + ti * 13) % 7) * 0.026);
      const colMain: RGB = (f + ti) % 2 === 0 ? leafDark : leafMid;

      const rowBase: number[] = [];
      for (let k = 0; k < steps.length; k++) {
        const s = steps[k];
        const dist = s * lenVar;
        const archY = Math.sin(s * Math.PI * 0.78) * tier.rise - s * s * tier.droop;
        const hw = widths[k] * tier.width;
        const ridge = hw * 0.22; // gentle V-fold spine
        const sx = px + dx * dist;
        const sy = py + tier.yOff + archY;
        const sz = dz * dist;
        const col: RGB = k >= 3 ? leafTip : colMain;

        rowBase.push(b.v);
        if (k === steps.length - 1) {
          // Pointed tip vertex (duplicate 3x to keep strip indexing simple & clean)
          b.vert(sx, sy, sz, 0, 1, 0, 0.5, 1, col);
          b.vert(sx, sy, sz, 0, 1, 0, 0.5, 1, col);
          b.vert(sx, sy, sz, 0, 1, 0, 0.5, 1, col);
        } else {
          // Left blade edge, center spine, right blade edge
          b.vert(sx - lx * hw, sy - ridge, sz - lz * hw, -lx * 0.35, 0.93, -lz * 0.35, 0, s, col);
          b.vert(sx, sy + ridge * 0.45, sz, 0, 1, 0, 0.5, s, col);
          b.vert(sx + lx * hw, sy - ridge, sz + lz * hw, lx * 0.35, 0.93, lz * 0.35, 1, s, col);
        }
      }
      for (let k = 0; k < steps.length - 1; k++) {
        const a = rowBase[k];
        const c = rowBase[k + 1];
        if (k === steps.length - 2) {
          b.tri(a, c + 1, a + 1);
          b.tri(a + 1, c + 1, a + 2);
        } else {
          b.quad(a, c, c + 1, a + 1);
          b.quad(a + 1, c + 1, c + 2, a + 2);
        }
      }
    }
  }

  return b.build();
}

export class VenueManager {
  public root = new THREE.Group();
  public activeVenue: VenueId = "pier";

  private courtMat: THREE.MeshStandardMaterial;
  private deckMesh: THREE.Mesh;
  private deckMats: Partial<Record<VenueId, THREE.MeshStandardMaterial>> = {};
  private trimMeshes: Record<VenueId, THREE.Mesh>;
  private backdropGroups: Record<VenueId, THREE.Group>;

  public netGeo: THREE.BufferGeometry;
  public tapeGeo: THREE.BufferGeometry;
  private netBase: Float32Array;
  private tapeBase: Float32Array;
  private lastNetAnim = -1;

  private instancedPalms: THREE.InstancedMesh[] = [];
  private palmSpots: Array<{ x: number; z: number; ry: number }> = [];
  private _palmDummy = new THREE.Object3D();
  private _palmMat = new THREE.Matrix4();
  private boats: Array<{ obj: THREE.Object3D; x: number; z: number; s: number; dir: number; sp: number }> = [];
  private gulls: Array<{ r: number; h: number; ph: number; sp: number; cz: number }> = [];
  private gullBodyIm!: THREE.InstancedMesh;
  private gullWingIm!: THREE.InstancedMesh;
  private _gullDummy = new THREE.Object3D();
  private _gullWingDummy = new THREE.Object3D();
  private _gullMat = new THREE.Matrix4();
  private umbrellas: Array<{ obj: THREE.Object3D; side: 0 | 1 }> = [];

  private lanternEmissives: THREE.MeshStandardMaterial[] = [];
  private floodEmissives: THREE.MeshStandardMaterial[] = [];
  private lampEmissives: THREE.MeshStandardMaterial[] = [];
  private venueLampEmissives: THREE.MeshStandardMaterial[] = [];

  public ledScreenMesh: THREE.Mesh | null = null;
  public trophyDisplay = new THREE.Group();
  public trainingBasket: THREE.Object3D | null = null;
  public mirrorHidden: THREE.Object3D[] = [];
  public gtaoHidden: THREE.Object3D[] = [];

  constructor(
    scene: THREE.Scene,
    private textures: TextureBundle,
    geos: SharedGeos,
    private assets: AssetManager
  ) {
    scene.add(this.root);
    this._palmDummy.rotation.order = "YXZ";
    this._gullDummy.rotation.order = "YXZ";
    this._gullWingDummy.rotation.order = "YXZ";

    // Court playing surface (lazy-synthesized per venue!)
    const pierCourt = textures.getCourt("pier");
    this.courtMat = new THREE.MeshStandardMaterial({
      map: pierCourt.map,
      roughnessMap: pierCourt.rough,
      normalMap: pierCourt.normal,
      roughness: 1,
      metalness: 0,
    });
    this.courtMat.normalScale.set(0.6, 0.6);
    const courtMesh = new THREE.Mesh(geos.court, this.courtMat);
    courtMesh.receiveShadow = true;
    freezeStaticMatrices(courtMesh);
    this.root.add(courtMesh);
    this.mirrorHidden.push(courtMesh);

    // Deck surface materials (Timber Pier upfront; Limestone & Lawn created lazily on switch)
    const pierDeck = textures.getDeck("pier");
    this.deckMats.pier = new THREE.MeshStandardMaterial({ map: pierDeck.map, normalMap: pierDeck.normal, roughness: 0.78 });
    this.deckMesh = new THREE.Mesh(
      buildPrim((b) => b.addBox(0, -0.22, 12.0, 13.0, 0.22, 18.0, WHITE, 2.4)),
      this.deckMats.pier
    );
    this.deckMesh.castShadow = true;
    this.deckMesh.receiveShadow = true;
    freezeStaticMatrices(this.deckMesh);
    this.root.add(this.deckMesh);

    // Venue-specific deck trims & bleachers
    this.trimMeshes = {
      pier: new THREE.Mesh(buildPierTrimGeo(13.0, -6.0, 30.0, [0.16, 0.30, 0.30], [0.42, 0.25, 0.14]), vcMat(0.74)),
      cove: new THREE.Mesh(buildPierTrimGeo(13.4, -6.2, 30.4, [0.76, 0.42, 0.26], [0.82, 0.72, 0.56]), vcMat(0.84)),
      terrace: new THREE.Mesh(buildPierTrimGeo(13.4, -6.2, 30.4, [0.94, 0.93, 0.88], [0.94, 0.93, 0.88]), vcMat(0.70)),
    };
    for (const k of ["pier", "cove", "terrace"] as VenueId[]) {
      this.trimMeshes[k].castShadow = true;
      this.trimMeshes[k].receiveShadow = true;
      this.trimMeshes[k].visible = k === "pier";
      freezeStaticMatrices(this.trimMeshes[k]);
      this.root.add(this.trimMeshes[k]);
    }

    // Venue hero backdrops (Blender .glb Coral Cove Arch & Emerald Terrace Pavilion!)
    this.backdropGroups = {
      pier: new THREE.Group(),
      cove: new THREE.Group(),
      terrace: new THREE.Group(),
    };
    for (const k of ["pier", "cove", "terrace"] as VenueId[]) {
      this.backdropGroups[k].visible = k === "pier";
      this.root.add(this.backdropGroups[k]);
    }

    // Pier back rope rail (only visible on open Lagoon Pier)
    const pierBackRail = new THREE.Mesh(
      buildPrim((b) => {
        for (let x = -12.6; x <= 12.7; x += 4.2) {
          b.addCyl(x, 0, 29.4, 0.11, 0.10, 0, 1.05, 10, [0.42, 0.25, 0.14]);
          b.addSphere(x, 1.08, 29.4, 0.12, 0.09, 0.12, 10, 8, [0.24, 0.14, 0.08]);
        }
        b.addBox(0, 0.84, 29.4, 12.6, 0.03, 0.03, [0.76, 0.66, 0.48]);
      }),
      vcMat(0.76)
    );
    pierBackRail.castShadow = true;
    freezeStaticMatrices(pierBackRail);
    this.backdropGroups.pier.add(pierBackRail);

    // Coral Cove Limestone Archway & Pergola (.glb)
    if (assets.models.venues.coral_cove_arch) {
      const arch = cloneWithFreshMaterials(assets.models.venues.coral_cove_arch);
      arch.position.set(0, 0, 28.8);
      arch.rotation.y = Math.PI; // face court (-Z)
      this.collectEmissives(arch, "Mat_VenueLampGlow", this.venueLampEmissives);
      freezeStaticMatrices(arch);
      this.backdropGroups.cove.add(arch);
    }

    // Emerald Terrace Coastal Club Pavilion (.glb)
    if (assets.models.venues.emerald_pavilion) {
      const pav = cloneWithFreshMaterials(assets.models.venues.emerald_pavilion);
      pav.position.set(0, 0, 28.6);
      pav.rotation.y = Math.PI;
      this.collectEmissives(pav, "Mat_VenueLampGlow", this.venueLampEmissives);
      freezeStaticMatrices(pav);
      this.backdropGroups.terrace.add(pav);
    }

    // Distant Islands + island palms + Lighthouse (.glb)
    const islands = new THREE.Mesh(geos.islands, vcMat(0.95));
    islands.receiveShadow = false;
    freezeStaticMatrices(islands);
    this.root.add(islands);
    this.gtaoHidden.push(islands);

    if (assets.models.props.lighthouse) {
      const lh = cloneWithFreshMaterials(assets.models.props.lighthouse);
      lh.position.set(48, 7.6, 98);
      lh.traverse((o) => { o.castShadow = false; });
      this.collectEmissives(lh, "Mat_LampGlow", this.lampEmissives);
      freezeStaticMatrices(lh);
      this.root.add(lh);
      this.gtaoHidden.push(lh);
    }

    // Dynamic Wind/Impact Deformable Net
    this.netGeo = geos.net;
    this.tapeGeo = geos.netTape;
    this.netBase = (this.netGeo.attributes.position.array as Float32Array).slice();
    this.tapeBase = (this.tapeGeo.attributes.position.array as Float32Array).slice();
    const netMesh = new THREE.Mesh(
      this.netGeo,
      new THREE.MeshStandardMaterial({ map: textures.net, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.9 })
    );
    netMesh.position.z = NET;
    netMesh.castShadow = true;
    freezeStaticMatrices(netMesh);
    this.root.add(netMesh);
    this.mirrorHidden.push(netMesh);
    this.gtaoHidden.push(netMesh);
    const tapeMesh = new THREE.Mesh(this.tapeGeo, vcMat(0.8, { side: THREE.DoubleSide }));
    tapeMesh.position.z = NET;
    tapeMesh.castShadow = true;
    freezeStaticMatrices(tapeMesh);
    this.root.add(tapeMesh);
    this.mirrorHidden.push(tapeMesh);
    this.gtaoHidden.push(tapeMesh);

    // Hero Courtside Props (Blender .glb!)
    this.buildCourtsideProps();

    // Training Ball Basket (.glb)
    if (assets.models.props.ball_basket) {
      this.trainingBasket = cloneWithFreshMaterials(assets.models.props.ball_basket);
      this.trainingBasket.position.set(3.2, 0, L - 0.6);
      this.trainingBasket.visible = false;
      freezeStaticMatrices(this.trainingBasket);
      this.root.add(this.trainingBasket);
      this.mirrorHidden.push(this.trainingBasket);
    }

    // Ceremony Trophy Display (Blender lagoon_trophy.glb on coastal plinth!)
    this.trophyDisplay.position.set(0, 0, NET - 2.6);
    this.trophyDisplay.visible = false;
    this.mirrorHidden.push(this.trophyDisplay);
    const plinth = new THREE.Mesh(
      new THREE.CylinderGeometry(0.42, 0.48, 0.85, 24),
      new THREE.MeshStandardMaterial({ color: 0xf6f0e4, roughness: 0.35 })
    );
    plinth.position.y = 0.425;
    plinth.castShadow = true;
    plinth.receiveShadow = true;
    this.trophyDisplay.add(plinth);
    if (assets.models.props.lagoon_trophy) {
      const tr = cloneWithFreshMaterials(assets.models.props.lagoon_trophy);
      tr.position.y = 0.85;
      tr.scale.setScalar(1.35);
      this.trophyDisplay.add(tr);
    }
    this.root.add(this.trophyDisplay);

    // Animated Sailboats (.glb)
    const boatDefs = [
      { x: -34, z: 54, s: 1.35, dir: 1, sp: 0.7 },
      { x: 42, z: 72, s: 1.15, dir: -1, sp: 0.5 },
    ];
    for (const bt of boatDefs) {
      const obj = cloneWithFreshMaterials(assets.models.props.sailboat);
      obj.traverse((o) => { o.castShadow = false; });
      obj.rotation.order = "YXZ";
      obj.scale.setScalar(bt.s);
      this.root.add(obj);
      this.boats.push({ obj, ...bt });
      this.gtaoHidden.push(obj);
    }

    // Circling Seagulls (2 instanced draw calls total instead of 24!)
    const gullMat = new THREE.MeshStandardMaterial({ color: 0xf6f4ee, roughness: 0.8, side: THREE.DoubleSide });
    const gullBodyGeo = buildPrim((b) => {
      b.addSphere(0, 0, 0, 0.12, 0.08, 0.34, 10, 7, WHITE);
      b.addSphere(0, 0.04, 0.30, 0.07, 0.07, 0.08, 8, 6, WHITE);
    });
    const gullCount = 6;
    this.gullBodyIm = new THREE.InstancedMesh(gullBodyGeo, gullMat, gullCount);
    this.gullBodyIm.frustumCulled = false;
    this.gullBodyIm.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.gullWingIm = new THREE.InstancedMesh(geos.gullWing, gullMat, gullCount * 2);
    this.gullWingIm.frustumCulled = false;
    this.gullWingIm.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.root.add(this.gullBodyIm, this.gullWingIm);
    this.gtaoHidden.push(this.gullBodyIm, this.gullWingIm);
    for (let i = 0; i < gullCount; i++) {
      this.gulls.push({ r: 22 + i * 7, h: 11 + (i % 3) * 3.5, ph: i * 1.3, sp: 0.16 + i * 0.025, cz: 22 + i * 6 });
    }
  }

  private collectEmissives(root: THREE.Object3D, matName: string, out: THREE.MeshStandardMaterial[]): void {
    forEachMaterial(root, (m) => {
      if (baseMatName(m) === matName) {
        out.push(m as THREE.MeshStandardMaterial);
      }
    });
  }

  private buildCourtsideProps(): void {
    const a = this.assets.models.props;

    // 1. Umpire Chair (.glb) at left sideline X = -7.35, Z = NET facing +X
    if (a.umpire_chair) {
      const chair = cloneWithFreshMaterials(a.umpire_chair);
      chair.position.set(-7.35, 0, NET);
      freezeStaticMatrices(chair);
      this.root.add(chair);
      this.mirrorHidden.push(chair);
    }

    // 2. Player Benches + Scalloped Umbrellas (.glb) on both sidelines
    const benchSpots: Array<[number, number, number, 0 | 1]> = [
      [7.75, NET + 2.5, 0, 0],
      [-7.75, NET - 2.9, Math.PI, 1],
    ];
    for (const [bx, bz, ry, side] of benchSpots) {
      if (a.bench_umbrella) {
        const bu = cloneWithFreshMaterials(a.bench_umbrella);
        bu.position.set(bx, 0, bz);
        bu.rotation.y = ry;
        freezeStaticMatrices(bu);
        this.root.add(bu);
        this.umbrellas.push({ obj: bu, side });
        this.mirrorHidden.push(bu);
      }
    }

    // 3. Courtside Live 3D LED Scoreboard (.glb) behind right net/back apron facing camera (-Z)
    const sb = cloneWithFreshMaterials(a.scoreboard_led);
    sb.position.set(7.4, 0, NET - 5.2);
    sb.rotation.y = Math.PI + 0.36; // angled cleanly toward player camera
    freezeStaticMatrices(sb);
    this.root.add(sb);
    this.mirrorHidden.push(sb);
    const screen = sb.getObjectByName("LED_Screen");
    if (screen && (screen as THREE.Mesh).isMesh) {
      this.ledScreenMesh = screen as THREE.Mesh;
    }

    // 4. Corner Pier Palms (.glb instanced -> 1-2 draw calls instead of 72!) + Distant Island Palms
    this.palmSpots = [
      { x: -11.2, z: 27.8, ry: 0.4 },
      { x: 11.2, z: 27.8, ry: -2.5 },
      { x: -11.6, z: -4.4, ry: 0.9 },
      { x: 11.6, z: -4.4, ry: -2.1 },
    ];
    this.instancedPalms = createInstancedPropMeshes(
      a.palm_tree,
      this.palmSpots.map((s) => ({ x: s.x, y: 0, z: s.z, ry: s.ry })),
      { castShadow: true, receiveShadow: true, dynamic: true }
    );
    for (const im of this.instancedPalms) this.root.add(im);

    // Distant island palms (single instanced draw call for all 12 wild silhouettes — saves 215 draw calls & 96k tris!)
    const islandPalmCount = ISLANDS.length * 3;
    const islandPalms = new THREE.InstancedMesh(
      buildIslandPalmGeometry(),
      vcMat(0.88, { side: THREE.DoubleSide }),
      islandPalmCount
    );
    islandPalms.castShadow = false;
    islandPalms.receiveShadow = false;
    const dummy = new THREE.Object3D();
    let idx = 0;
    ISLANDS.forEach((def, k) => {
      for (let i = 0; i < 3; i++) {
        const ang = ihash(i, k * 13 + 1) * TAU;
        const t = 0.2 + 0.22 * ihash(i + 5, k);
        const [ix, iy, iz] = islandPoint(def, ang, t);
        const sc = 1.45 + ihash(i, k + 40) * 0.7;
        dummy.position.set(ix, iy - 0.55 * sc, iz);
        dummy.scale.setScalar(sc);
        dummy.rotation.set((ihash(i, 3) - 0.5) * 0.18, ihash(i, k + 50) * TAU, (ihash(i, 4) - 0.5) * 0.18);
        dummy.updateMatrix();
        islandPalms.setMatrixAt(idx++, dummy.matrix);
      }
    });
    islandPalms.instanceMatrix.needsUpdate = true;
    freezeStaticMatrices(islandPalms);
    this.root.add(islandPalms);
    this.gtaoHidden.push(islandPalms);

    // 5. Pier Lanterns (.glb instanced -> 3 draw calls total instead of 20!)
    if (a.pier_lantern) {
      const lanternIms = createInstancedPropMeshes(
        a.pier_lantern,
        LANTERN_XZ.map(([lx, lz]) => ({ x: lx, y: 0, z: lz, ry: lx < 0 ? Math.PI : 0 })),
        { castShadow: true, receiveShadow: true }
      );
      for (const im of lanternIms) {
        this.collectEmissives(im, "Mat_LanternGlow", this.lanternEmissives);
        freezeStaticMatrices(im);
        this.root.add(im);
        this.gtaoHidden.push(im);
      }
    }

    // 6. Night Stadium Floodlight Towers (.glb instanced -> 2 draw calls total instead of 32!)
    if (a.floodlight_tower) {
      const floodIms = createInstancedPropMeshes(
        a.floodlight_tower,
        FLOODLIGHT_XZ.map(([fx, fz, ry]) => ({ x: fx, y: 0, z: fz, ry })),
        { castShadow: true, receiveShadow: true }
      );
      for (const im of floodIms) {
        this.collectEmissives(im, "Mat_FloodGlow", this.floodEmissives);
        freezeStaticMatrices(im);
        this.root.add(im);
        this.gtaoHidden.push(im);
      }
    }
  }

  public setVenue(venueId: VenueId): void {
    this.activeVenue = venueId;
    const tex = this.textures.getCourt(venueId);
    this.courtMat.map = tex.map;
    this.courtMat.roughnessMap = tex.rough;
    this.courtMat.normalMap = tex.normal;
    this.courtMat.needsUpdate = true;

    let dMat = this.deckMats[venueId];
    if (!dMat) {
      const dTex = this.textures.getDeck(venueId);
      const rough = venueId === "cove" ? 0.86 : venueId === "terrace" ? 0.90 : 0.78;
      dMat = new THREE.MeshStandardMaterial({ map: dTex.map, normalMap: dTex.normal, roughness: rough });
      this.deckMats[venueId] = dMat;
    }
    this.deckMesh.material = dMat;
    for (const k of ["pier", "cove", "terrace"] as VenueId[]) {
      this.trimMeshes[k].visible = k === venueId;
      this.backdropGroups[k].visible = k === venueId;
    }

    // Retint bench umbrella stripes per venue palette!
    const uCols = VENUES[venueId].umbrellaColors;
    for (const u of this.umbrellas) {
      const col = uCols[u.side];
      forEachMaterial(u.obj, (m) => {
        if (baseMatName(m) === "Mat_CanopyA") {
          (m as THREE.MeshStandardMaterial).color.setRGB(col[0], col[1], col[2]);
        }
      });
    }
  }

  public applyPresetGlow(pr: SkyPreset): void {
    for (const m of this.lanternEmissives) {
      m.emissive.setRGB(1.0, 0.72, 0.34);
      m.emissiveIntensity = 0.4 + pr.lanternGlow;
    }
    for (const m of this.floodEmissives) {
      m.emissive.setRGB(0.95, 0.97, 1.0);
      m.emissiveIntensity = pr.floodGlow;
    }
    for (const m of this.lampEmissives) {
      m.emissive.setRGB(1.0, 0.85, 0.48);
      m.emissiveIntensity = 0.5 + pr.lanternGlow * 1.3;
    }
    for (const m of this.venueLampEmissives) {
      m.emissive.setRGB(1.0, 0.76, 0.40);
      m.emissiveIntensity = 0.22 + pr.lanternGlow * 0.36;
    }
  }

  public animate(t: number, netHit: NetHitState): void {
    // Wind & ball-impact net deformation (full frame-rate on impact, 30Hz during gentle wind)
    const activeHit = netHit.amp > 0.001;
    if (activeHit || this.lastNetAnim < 0 || t - this.lastNetAnim >= 1 / 30) {
      this.lastNetAnim = t;
      const deform = (geo: THREE.BufferGeometry, base: Float32Array) => {
        const p = geo.attributes.position.array as Float32Array;
        for (let i = 0; i < p.length; i += 3) {
          let x = base[i], y = base[i + 1], z = base[i + 2];
          const k = 0.025 * clamp(y, 0, 1.25);
          z += Math.sin(t * 2.2 + x * 1.1 + y * 4.0) * k * 0.45;
          x += Math.cos(t * 1.7 + y * 5.0) * k * 0.2;
          if (activeHit) {
            const d = Math.hypot(x - netHit.x, y - netHit.y);
            z += Math.exp(-d * 1.35) * Math.sin(d * 9.0 - netHit.elapsed * 26.0) * netHit.amp * smoothstep(0, 0.18, y);
          }
          p[i] = x; p[i + 1] = y; p[i + 2] = z;
        }
        geo.attributes.position.needsUpdate = true;
      };
      deform(this.netGeo, this.netBase);
      deform(this.tapeGeo, this.tapeBase);
    }

    // Swaying instanced pier palms (4 matrix updates -> 1-2 draw calls!)
    if (this.instancedPalms.length > 0) {
      for (let i = 0; i < this.palmSpots.length; i++) {
        const sp = this.palmSpots[i];
        const sw = Math.sin(t * 1.15 + i * 1.7) * 0.04;
        this._palmDummy.position.set(sp.x, 0, sp.z);
        this._palmDummy.rotation.set(sw, sp.ry, sw * 0.7);
        this._palmDummy.scale.setScalar(1);
        this._palmDummy.updateMatrix();
        for (let m = 0; m < this.instancedPalms.length; m++) {
          const im = this.instancedPalms[m];
          const rel = im.userData.localRelMatrix as THREE.Matrix4 | undefined;
          if (rel) {
            this._palmMat.multiplyMatrices(this._palmDummy.matrix, rel);
            im.setMatrixAt(i, this._palmMat);
          } else {
            im.setMatrixAt(i, this._palmDummy.matrix);
          }
        }
      }
      for (let m = 0; m < this.instancedPalms.length; m++) {
        this.instancedPalms[m].instanceMatrix.needsUpdate = true;
      }
    }

    // Sailboats gliding on lagoon
    for (const bt of this.boats) {
      const bx = bt.x + Math.sin(t * 0.08 * bt.sp + bt.z) * 14 * bt.dir;
      bt.obj.position.set(bx, -1.42 + Math.sin(t * 1.4 + bt.x) * 0.12, bt.z);
      bt.obj.rotation.set(0, bt.dir > 0 ? Math.PI * 0.42 : -Math.PI * 0.58, Math.sin(t * 1.1 + bt.z) * 0.07);
    }

    // Circling instanced gulls (2 draw calls total!)
    for (let i = 0; i < this.gulls.length; i++) {
      const g = this.gulls[i];
      const a = t * g.sp + g.ph;
      const gx = Math.cos(a) * g.r;
      const gz = g.cz + Math.sin(a) * g.r * 0.55;
      const gy = g.h + Math.sin(t * 0.9 + g.ph) * 0.7;
      const yaw = Math.atan2(-Math.sin(a) * g.r, Math.cos(a) * g.r * 0.55);
      const flap = Math.sin(t * 11 + g.ph) * 0.55;

      this._gullDummy.position.set(gx, gy, gz);
      this._gullDummy.rotation.set(0, yaw, 0);
      this._gullDummy.updateMatrix();
      this.gullBodyIm.setMatrixAt(i, this._gullDummy.matrix);

      this._gullWingDummy.position.set(0, 0, 0);
      this._gullWingDummy.rotation.set(0, 0, flap);
      this._gullWingDummy.updateMatrix();
      this._gullMat.multiplyMatrices(this._gullDummy.matrix, this._gullWingDummy.matrix);
      this.gullWingIm.setMatrixAt(i * 2, this._gullMat);

      this._gullWingDummy.rotation.set(0, Math.PI, flap);
      this._gullWingDummy.updateMatrix();
      this._gullMat.multiplyMatrices(this._gullDummy.matrix, this._gullWingDummy.matrix);
      this.gullWingIm.setMatrixAt(i * 2 + 1, this._gullMat);
    }
    this.gullBodyIm.instanceMatrix.needsUpdate = true;
    this.gullWingIm.instanceMatrix.needsUpdate = true;

    if (this.trophyDisplay.visible) {
      this.trophyDisplay.rotation.y = t * 0.85;
    }
  }
}
