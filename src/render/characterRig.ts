import * as THREE from "three";
import { clamp, lerp, smoothstep, TAU } from "../core/constants";
import type { AvatarConfig, BallState, PlayerState, RGB } from "../core/types";
import { AssetManager, cloneWithFreshMaterials } from "./assets";
import { baseMatName, forEachMaterial, mergeUntexturedSubtree } from "./meshOptimize";
import { mkNumberTex } from "./textures";

export interface CharacterRig {
  root: THREE.Group;
  pelvis: THREE.Object3D;
  chest: THREE.Object3D;
  head: THREE.Object3D;
  uArmL: THREE.Object3D;
  lArmL: THREE.Object3D;
  uArmR: THREE.Object3D;
  lArmR: THREE.Object3D;
  racketSocketR: THREE.Object3D;
  racketSocketL: THREE.Object3D;
  uLegL: THREE.Object3D;
  lLegL: THREE.Object3D;
  uLegR: THREE.Object3D;
  lLegR: THREE.Object3D;
  tailL: THREE.Object3D;
  tailR: THREE.Object3D;
  racketMount: THREE.Group;
  handedness: "right" | "left";
}

const numTexCache = new Map<string, THREE.CanvasTexture>();

function applyAvatarMaterials(root: THREE.Object3D, av: AvatarConfig): void {
  const soleCol: RGB =
    av.shoe[0] > 0.8 && av.shoe[1] > 0.8 ? [0.75, 0.42, 0.22] : [0.95, 0.94, 0.90];
  const colorMap: Record<string, RGB> = {
    Mat_Skin: av.skin,
    Mat_Shirt: av.shirt,
    Mat_Stripe: av.stripe,
    Mat_Shorts: av.shorts,
    Mat_Shoe: av.shoe,
    Mat_Sole: soleCol,
    Mat_Sock: [0.95, 0.95, 0.93],
    Mat_Band: av.band,
    Mat_Hair: av.hairColor,
    Mat_Accent: av.accent,
  };

  forEachMaterial(root, (mat) => {
    const col = colorMap[baseMatName(mat)];
    if (col && "color" in mat && (mat as THREE.MeshStandardMaterial).color) {
      (mat as THREE.MeshStandardMaterial).color.setRGB(col[0], col[1], col[2]);
    }
  });
}

export function buildCharacterRig(
  av: AvatarConfig,
  assets: AssetManager,
  aniso: number,
  withRacket = true
): CharacterRig {
  const root = new THREE.Group();
  root.rotation.order = "YXZ";
  const cloned = cloneWithFreshMaterials(assets.models.player);
  root.add(cloned);

  const req = (name: string): THREE.Object3D => {
    const node = cloned.getObjectByName(name);
    if (!node) throw new Error(`[CharacterRig] Missing bone "${name}" in tennis_player.glb`);
    return node;
  };

  const pelvis = req("Pelvis");
  const chest = req("Chest");
  const head = req("Head");
  const uArmL = req("UpperArm_L");
  const lArmL = req("Forearm_L");
  const uArmR = req("UpperArm_R");
  const lArmR = req("Forearm_R");
  const uLegL = req("Thigh_L");
  const lLegL = req("Shin_L");
  const uLegR = req("Thigh_R");
  const lLegR = req("Shin_R");
  const tailL = cloned.getObjectByName("HeadbandTail_L") || new THREE.Group();
  const tailR = cloned.getObjectByName("HeadbandTail_R") || new THREE.Group();
  const racketSocketR = cloned.getObjectByName("RacketSocket_R") || lArmR;
  const racketSocketL = cloned.getObjectByName("RacketSocket_L") || lArmL;

  for (const b of [pelvis, chest, head, uArmL, lArmL, uArmR, lArmR, uLegL, lLegL, uLegR, lLegR, tailL, tailR, racketSocketR, racketSocketL]) {
    b.rotation.order = "YXZ";
  }

  // Mount Hair & Hat from Blender accessories.glb onto Head bone
  const hairModel = assets.models.accessories.get(av.hair);
  if (hairModel) {
    const hClone = cloneWithFreshMaterials(hairModel);
    hClone.position.set(0, 0, 0);
    hClone.rotation.set(0, 0, 0);
    head.add(hClone);
  }
  if (av.hat !== "none") {
    const hatModel = assets.models.accessories.get(av.hat);
    if (hatModel) {
      const hatClone = cloneWithFreshMaterials(hatModel);
      hatClone.position.set(0, 0, 0);
      hatClone.rotation.set(0, 0, 0);
      head.add(hatClone);
    }
  }

  // Apply customizer colors to all named PBR material slots across body + hair + hat
  applyAvatarMaterials(root, av);

  // Merge all untextured sub-meshes per animated bone (Head+Face+Hair+Hat -> 1 draw call,
  // Shin+Shoe+Sock -> 1 draw call, Forearm+Hand -> 1 draw call, etc.): 53 -> 13 draw calls per character!
  const anchor = cloned.getObjectByName("BackNumberAnchor");
  const boneList = [pelvis, chest, head, uArmL, lArmL, uArmR, lArmR, uLegL, lLegL, uLegR, lLegR, tailL, tailR];
  const stopNodes = new Set<THREE.Object3D>([...boneList, racketSocketR, racketSocketL]);
  if (anchor) stopNodes.add(anchor);
  const preserveNodes = new Set<string>(["BackNumberAnchor"]);
  for (const b of boneList) {
    mergeUntexturedSubtree(b, { stopAtNodes: stopNodes, preserveNodes, label: b.name || "Bone" });
  }

  // Back jersey number decal
  if (av.num > 0 && anchor) {
    const nKey = `${av.num}|${av.stripe.join(",")}`;
    let nTex = numTexCache.get(nKey);
    if (!nTex) {
      nTex = mkNumberTex(av.num, av.stripe, aniso);
      numTexCache.set(nKey, nTex);
    }
    const numMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.15, 0.15),
      new THREE.MeshStandardMaterial({
        map: nTex,
        transparent: true,
        alphaTest: 0.1,
        roughness: 0.8,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      })
    );
    numMesh.position.set(0, 0, -0.008);
    numMesh.rotation.set(0, Math.PI, 0);
    anchor.add(numMesh);
  }

  // Mount Blender sculpted racket (righty or lefty socket!)
  const racketMount = new THREE.Group();
  racketMount.rotation.order = "YXZ";
  if (withRacket) {
    const rModel = assets.models.rackets[av.racket] || assets.models.rackets.coral;
    racketMount.add(cloneWithFreshMaterials(rModel));
    const socket = av.handedness === "left" ? racketSocketL : racketSocketR;
    socket.add(racketMount);
  }

  return {
    root,
    pelvis,
    chest,
    head,
    uArmL,
    lArmL,
    uArmR,
    lArmR,
    racketSocketR,
    racketSocketL,
    uLegL,
    lLegL,
    uLegR,
    lLegR,
    tailL,
    tailR,
    racketMount,
    handedness: av.handedness,
  };
}

const _tipV = new THREE.Vector3();

export function poseCharacterRig(
  C: CharacterRig,
  p: PlayerState,
  ball: BallState,
  now: number,
  dt: number,
  isNear: boolean,
  recordTrail = false
): void {
  const yaw = isNear ? 0 : Math.PI;
  const spd = Math.hypot(p.vx, p.vz);
  const runAmp = clamp(spd / 5.2, 0, 1);

  p.run += dt * (2.5 + 8.5 * runAmp);
  p.splitT = Math.max(0, p.splitT - dt);
  p.swingT = Math.max(0, p.swingT - dt);
  p.tossArm = Math.max(0, p.tossArm - dt * 1.4);
  p.lungeT = Math.max(0, p.lungeT - dt);
  p.diveT = Math.max(0, p.diveT - dt);
  p.telegraphT = Math.max(0, p.telegraphT - dt);
  p.emoteT = Math.max(0, p.emoteT - dt);

  const s = Math.sin(p.run);
  const split = p.splitT > 0 ? Math.sin((1 - p.splitT / 0.24) * Math.PI) : 0;

  // Handedness mirror sign: +1 for righty (racket on -X), -1 for lefty (racket on +X)
  const hs = C.handedness === "left" ? -1 : 1;

  let rootY = 0.88 - 0.05 * (1 - runAmp) + Math.abs(s) * 0.03 * runAmp + split * 0.09;
  let pelvRx = 0.08;
  let pelvRy = 0;
  let pelvRz = 0;
  let spineRx = 0.14 + clamp((isNear ? p.vz : -p.vz) * 0.04, -0.1, 0.24);
  let spineRy = 0;
  let spineRz = clamp((isNear ? -p.vx : p.vx) * 0.04, -0.18, 0.18);

  // Off-hand (non-racket) & racket-hand canonical variables (before handedness mapping)
  let off_rx = -0.32 - s * 0.45 * runAmp;
  let off_rz = -0.45 - split * 0.15;
  let offF_rx = -0.82;

  let dom_rx = -0.38 + s * 0.40 * runAmp;
  let dom_ry = -0.20;
  let dom_rz = 0.58 + split * 0.15;
  let domF_rx = -0.95;
  let rack_rx = -1.15;
  let rack_rz = 0.0;

  let uLegL_rx = -0.36 + s * 0.62 * runAmp;
  let uLegL_rz = -0.08 - split * 0.12;
  let lLegL_rx = 0.52 + Math.max(0, -s) * 0.65 * runAmp - split * 0.22;
  let uLegR_rx = -0.36 - s * 0.62 * runAmp;
  let uLegR_rz = 0.08 + split * 0.12;
  let lLegR_rx = 0.52 + Math.max(0, s) * 0.65 * runAmp - split * 0.22;

  // Serve toss arm raise
  if (p.tossArm > 0) {
    const k = smoothstep(0, 1, p.tossArm);
    off_rz = lerp(off_rz, -2.55, k);
    off_rx = lerp(off_rx, 0.18, k);
    offF_rx = lerp(offF_rx, -0.15, k);
    dom_rx = lerp(dom_rx, 0.62, k);
    dom_rz = lerp(dom_rz, 1.85, k);
    domF_rx = lerp(domF_rx, -1.60, k);
    spineRy = lerp(spineRy, -0.32 * hs, k);
    pelvRy = lerp(pelvRy, -0.20 * hs, k);
  }

  // Visible AI wind-up telegraph before impact!
  if (p.telegraphT > 0 && p.swingT <= 0) {
    const tk = smoothstep(0, 0.22, p.telegraphT);
    const shot = p.telegraphShot || "drive";
    if (shot === "lob") {
      spineRx = lerp(spineRx, 0.36, tk);
      dom_rx = lerp(dom_rx, 0.48, tk);
      dom_rz = lerp(dom_rz, 0.82, tk);
      rack_rx = lerp(rack_rx, -0.52, tk);
    } else if (shot === "slice" || shot === "drop") {
      spineRy = lerp(spineRy, -0.28 * hs, tk);
      dom_rx = lerp(dom_rx, -0.95, tk);
      dom_rz = lerp(dom_rz, 0.92, tk);
      rack_rx = lerp(rack_rx, -1.65, tk);
    } else {
      spineRy = lerp(spineRy, -0.45 * hs, tk);
      dom_rx = lerp(dom_rx, 0.32, tk);
      dom_ry = lerp(dom_ry, -0.58, tk);
      dom_rz = lerp(dom_rz, 1.15, tk);
    }
  }

  // Active tennis swing
  if (p.swingT > 0) {
    const dur = p.swingDur || 0.36;
    const rawU = 1 - p.swingT / dur;
    const u =
      rawU < 0.45
        ? (rawU / 0.45) * (rawU / 0.45) * 0.48
        : 0.48 + ((rawU - 0.45) / 0.55) * 0.52;
    const k1 = smoothstep(0, 0.48, u);
    const k2 = smoothstep(0.48, 1.0, u);
    const st = p.swingType || "fh";

    if (st === "fh") {
      spineRy = lerp(lerp(-0.42, 0.12, k1), 0.52, k2) * hs;
      pelvRy = spineRy * 0.65;
      dom_rx = lerp(lerp(0.28, -0.65, k1), -1.02, k2);
      dom_ry = lerp(lerp(-0.62, -0.16, k1), 0.38, k2);
      dom_rz = lerp(lerp(1.22, 0.92, k1), 0.48, k2);
      domF_rx = lerp(lerp(-1.65, -0.42, k1), -0.35, k2);
      rack_rx = lerp(lerp(-0.70, -1.42, k1), -1.78, k2);
    } else if (st === "bh") {
      spineRy = lerp(lerp(0.42, -0.08, k1), -0.50, k2) * hs;
      pelvRy = spineRy * 0.65;
      dom_rx = lerp(lerp(-0.18, -0.55, k1), -0.88, k2);
      dom_ry = lerp(lerp(0.45, -0.35, k1), -0.55, k2);
      dom_rz = lerp(lerp(-0.35, 0.25, k1), 0.78, k2);
      domF_rx = lerp(lerp(-1.18, -0.32, k1), -0.28, k2);
      rack_rx = lerp(lerp(-1.05, -1.35, k1), -1.68, k2);
      rack_rz = lerp(0.4, -0.2, k2);
    } else if (st === "slice" || st === "drop") {
      const soft = st === "drop" ? 0.62 : 1.0;
      spineRx = lerp(0.08, 0.38 * soft, u);
      dom_rx = lerp(lerp(-1.05 * soft, 0.18, k1), 0.58 * soft, k2);
      dom_rz = lerp(lerp(0.90, 0.55, k1), 0.28, k2);
      domF_rx = lerp(-0.72, -1.10, u);
      rack_rx = lerp(lerp(-1.70, -0.78, k1), 0.08 * soft, k2);
      rack_rz = lerp(-0.38, 0.48 * soft, u);
    } else if (st === "lob") {
      spineRx = lerp(lerp(0.36, 0.14, k1), -0.10, k2);
      dom_rx = lerp(lerp(0.42, -0.82, k1), -1.45, k2);
      dom_rz = lerp(lerp(0.85, 0.55, k1), 0.35, k2);
      domF_rx = lerp(-1.15, -0.25, u);
      rack_rx = lerp(lerp(-0.45, -1.25, k1), -1.85, k2);
    } else if (st === "smash" || st === "serve") {
      rootY += Math.sin(clamp(rawU / 0.72, 0, 1) * Math.PI) * (st === "smash" ? 0.24 : 0.13);
      spineRx = lerp(lerp(0.32, -0.14, k1), 0.22, k2);
      spineRy = lerp(lerp(-0.42, 0.22, k1), 0.52, k2) * hs;
      dom_rx = lerp(lerp(0.55, -1.32, k1), -0.70, k2);
      dom_rz = lerp(lerp(2.22, 0.28, k1), -0.22, k2);
      domF_rx = lerp(lerp(-1.85, -0.12, k1), -0.35, k2);
      rack_rx = lerp(lerp(-0.55, -1.55, k1), -1.92, k2);
    }
  }

  // Wide lunge lean
  if (p.lungeT > 0) {
    const lk = Math.min(1, p.lungeT * 4);
    const dir = p.lungeDir || 1;
    spineRx = lerp(spineRx, 0.40, lk);
    spineRz = lerp(spineRz, -0.32 * dir, lk);
    rootY -= 0.12 * lk;
  }

  // Dramatic full-body desperation dive stretch!
  if (p.diveT > 0) {
    const dk = Math.sin(clamp(p.diveT / 0.62, 0, 1) * Math.PI);
    const dir = p.diveDir || 1;
    rootY = lerp(rootY, 0.34, dk);
    pelvRz = lerp(pelvRz, -1.08 * dir, dk);
    pelvRx = lerp(pelvRx, 0.32, dk);
    spineRz = lerp(spineRz, -0.25 * dir, dk);
    dom_rz = lerp(dom_rz, 2.55, dk);
    dom_rx = lerp(dom_rx, -0.55, dk);
    domF_rx = lerp(domF_rx, -0.15, dk);
    uLegL_rx = lerp(uLegL_rx, 0.45, dk);
    uLegR_rx = lerp(uLegR_rx, 0.55, dk);
    lLegL_rx = lerp(lLegL_rx, 0.18, dk);
    lLegR_rx = lerp(lLegR_rx, 0.25, dk);
  }

  // Point win/lose emotes
  if (p.emoteT > 0) {
    if (p.emote === "win") {
      const eu = 1 - p.emoteT / 1.4;
      rootY += Math.abs(Math.sin(eu * Math.PI * 2)) * 0.24;
      off_rz = -2.55;
      dom_rz = 2.55;
      dom_rx = -0.2 + Math.sin(eu * TAU * 3) * 0.25;
      offF_rx = -0.35;
      domF_rx = -0.35;
    } else {
      spineRx = 0.48;
      off_rz = -0.22;
      dom_rz = 0.22;
      offF_rx = -0.4;
      domF_rx = -0.4;
    }
  }

  // Head tracks live ball
  let headRy = 0;
  let headRx = -0.10;
  if (ball.visible) {
    const dx = ball.x - p.x;
    const dz = ball.z - p.z;
    const lx = isNear ? dx : -dx;
    const lz = isNear ? dz : -dz;
    headRy = clamp(Math.atan2(lx, Math.max(1.0, lz)) * 0.55, -0.65, 0.65);
    headRx = clamp(-Math.atan2(ball.y - 1.55, Math.hypot(lx, lz) + 0.5) * 0.6, -0.55, 0.35);
  }

  const tailTarget = clamp(-spd * 0.18 + Math.sin(now * 3.4 + p.slot * 2) * 0.12, -0.85, 0.35);
  p.tailAng = lerp(p.tailAng || 0, tailTarget, clamp(dt * 9, 0, 1));

  // Map dominant/off-hand onto physical L/R arm bones based on handedness
  C.root.position.set(p.x, 0, p.z);
  C.root.rotation.set(0, yaw, 0);
  C.pelvis.position.set(0, rootY, 0);
  C.pelvis.rotation.set(pelvRx, pelvRy, pelvRz);
  C.chest.rotation.set(spineRx, spineRy, spineRz);
  C.head.rotation.set(headRx, headRy, 0);

  if (C.handedness === "right") {
    C.uArmL.rotation.set(off_rx, -0.14, -off_rz);
    C.lArmL.rotation.set(offF_rx, 0, 0);
    C.uArmR.rotation.set(dom_rx, -dom_ry, -dom_rz);
    C.lArmR.rotation.set(domF_rx, 0, 0);
    C.racketSocketR.rotation.set(rack_rx, 0, -rack_rz);
    C.racketSocketL.rotation.set(0, 0, 0);
  } else {
    C.uArmR.rotation.set(off_rx, 0.14, off_rz);
    C.lArmR.rotation.set(offF_rx, 0, 0);
    C.uArmL.rotation.set(dom_rx, dom_ry, dom_rz);
    C.lArmL.rotation.set(domF_rx, 0, 0);
    C.racketSocketL.rotation.set(rack_rx, 0, rack_rz);
    C.racketSocketR.rotation.set(0, 0, 0);
  }

  C.uLegL.rotation.set(uLegL_rx, 0, -uLegL_rz);
  C.lLegL.rotation.set(lLegL_rx, 0, 0);
  C.uLegR.rotation.set(uLegR_rx, 0, -uLegR_rz);
  C.lLegR.rotation.set(lLegR_rx, 0, 0);
  C.tailL.rotation.set(0.35 + p.tailAng, -0.25, -0.2);
  C.tailR.rotation.set(0.35 + p.tailAng * 0.85, 0.25, 0.2);

  if (recordTrail) {
    if (p.swingT > 0.04) {
      C.root.updateMatrixWorld(true);
      const activeSocket = C.handedness === "left" ? C.racketSocketL : C.racketSocketR;
      _tipV.set(0, 0.68, 0).applyMatrix4(activeSocket.matrixWorld);
      const tx = _tipV.x, ty = _tipV.y, tz = _tipV.z;
      _tipV.set(0, 0.44, 0).applyMatrix4(activeSocket.matrixWorld);
      p.swingTrail.push([tx, ty, tz, _tipV.x, _tipV.y, _tipV.z]);
      if (p.swingTrail.length > 15) p.swingTrail.shift();
    } else if (p.swingTrail.length) {
      p.swingTrail.shift();
    }
  }
}

/**
 * Poses the umpire's stationary seated torso, legs, and resting left arm once
 * and collapses them into a single draw call while keeping Head and Right Arm
 * fully live-animated (51 -> 4 draw calls total!).
 */
export function bakeSeatedUmpireBody(C: CharacterRig): void {
  C.pelvis.position.set(0, 1.84, 0);
  C.pelvis.rotation.set(-0.08, 0, 0);
  C.chest.rotation.set(0.06, 0, 0);
  C.uLegL.rotation.set(-1.42, 0, -0.06);
  C.lLegL.rotation.set(1.48, 0, 0);
  C.uLegR.rotation.set(-1.42, 0, 0.06);
  C.lLegR.rotation.set(1.48, 0, 0);
  C.uArmL.rotation.set(-0.65, 0, 0.25);
  C.lArmL.rotation.set(-0.75, 0, 0);
  mergeUntexturedSubtree(C.pelvis, {
    stopAtNodes: new Set<THREE.Object3D>([C.head, C.uArmR]),
    label: "UmpireSeatedBody",
  });
}

export function poseSeatedUmpire(C: CharacterRig, ball: BallState, cheer: number, now: number): void {
  // Right arm gesturing on calls (legs, torso, and resting left arm are pre-baked)
  const gesture = smoothstep(0.3, 0.9, cheer);
  C.uArmR.rotation.set(lerp(-0.65, -1.35, gesture), 0, lerp(-0.25, -0.65, gesture));
  C.lArmR.rotation.set(lerp(-0.75, -0.30, gesture), 0, 0);

  // Smooth head tracking of the tennis ball across the court!
  let headRy = Math.sin(now * 0.7) * 0.12;
  let headRx = 0.08;
  if (ball.visible) {
    const dx = ball.x - C.root.position.x;
    const dz = ball.z - C.root.position.z;
    // Umpire root is rotated +PI/2 so forward is +X
    const localForward = dx;
    const localLeft = -dz;
    headRy = clamp(Math.atan2(localLeft, Math.max(2.0, localForward)) * 0.85, -0.85, 0.85);
    headRx = clamp(-Math.atan2(ball.y - 2.35, Math.hypot(dx, dz) + 1.0) * 0.6, -0.45, 0.45);
  }
  C.head.rotation.set(headRx, headRy, 0);
}

export function poseBallKid(C: CharacterRig, ball: BallState, live: boolean, now: number, seed: number): void {
  const crouch = live ? 1.0 : 0.25;
  C.pelvis.position.set(0, lerp(0.84, 0.62, crouch), 0);
  C.pelvis.rotation.set(lerp(0.08, 0.35, crouch), 0, 0);
  C.chest.rotation.set(lerp(0.10, 0.38, crouch), 0, Math.sin(now * 1.8 + seed) * 0.03);
  C.uLegL.rotation.set(lerp(-0.22, -0.92, crouch), 0, -0.10);
  C.lLegL.rotation.set(lerp(0.32, 1.42, crouch), 0, 0);
  C.uLegR.rotation.set(lerp(-0.22, -0.92, crouch), 0, 0.10);
  C.lLegR.rotation.set(lerp(0.32, 1.42, crouch), 0, 0);
  C.uArmL.rotation.set(-0.55, 0, 0.32);
  C.lArmL.rotation.set(-0.65, 0, 0);
  C.uArmR.rotation.set(-0.55, 0, -0.32);
  C.lArmR.rotation.set(-0.65, 0, 0);

  let headRy = 0;
  if (ball.visible) {
    const dx = ball.x - C.root.position.x;
    const dz = ball.z - C.root.position.z;
    const yaw = C.root.rotation.y;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const lx = fz;
    const lz = -fx;
    headRy = clamp(Math.atan2(dx * lx + dz * lz, Math.max(2.0, dx * fx + dz * fz)) * 0.65, -0.75, 0.75);
  }
  C.head.rotation.set(-0.08, headRy, 0);
}
