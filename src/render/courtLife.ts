import * as THREE from "three";
import { BALLKID_AVATAR, lerp, NET, smoothstep, TAU, UMPIRE_AVATAR, VENUES } from "../core/constants";
import type { BallState, GameState, RGB } from "../core/types";
import { pointLabel } from "../game/rules";
import type { AssetManager } from "./assets";
import { buildCharacterRig, bakeSeatedUmpireBody, type CharacterRig, poseBallKid, poseSeatedUmpire } from "./characterRig";
import { rgb, type SharedGeos } from "./geometry";
import { ihash } from "./textures";

interface CrowdSeat {
  x: number;
  y: number;
  z: number;
  yaw: number;
  seed: number;
  shirt: RGB;
  skin: RGB;
  hair: RGB;
  shorts: RGB;
}

export class CourtLife {
  private crowdSeats: CrowdSeat[] = [];
  private crowdParts: Record<string, THREE.InstancedMesh> = {};
  private lastCrowdUpdate = -1;
  private _cm = {
    base: new THREE.Matrix4(),
    r: new THREE.Matrix4(),
    arm: new THREE.Matrix4(),
    tmp: new THREE.Matrix4(),
  };

  private umpireRig: CharacterRig;
  private ballKids: Array<{ rig: CharacterRig; seed: number }> = [];
  public mirrorHidden: THREE.Object3D[] = [];
  public gtaoHidden: THREE.Object3D[] = [];

  private ledCanvas: HTMLCanvasElement;
  private ledCtx: CanvasRenderingContext2D;
  private ledTex: THREE.CanvasTexture;
  private lastLedKey = "";

  constructor(
    parent: THREE.Group,
    geos: SharedGeos,
    assets: AssetManager,
    aniso: number,
    ledScreenMesh: THREE.Mesh | null
  ) {
    // 1. 72 Animated Instanced Spectators on both bleachers
    const palette: RGB[] = [
      [0.96, 0.28, 0.16], [0.98, 0.74, 0.16], [0.16, 0.70, 0.62],
      [0.14, 0.34, 0.52], [0.95, 0.92, 0.84], [0.92, 0.44, 0.56],
    ];
    const skins: RGB[] = [
      [0.76, 0.50, 0.32], [0.55, 0.30, 0.16], [0.88, 0.64, 0.46],
      [0.36, 0.18, 0.09], [0.68, 0.42, 0.24],
    ];
    const hairs: RGB[] = [
      [0.05, 0.04, 0.03], [0.22, 0.12, 0.05], [0.62, 0.46, 0.18],
      [0.08, 0.06, 0.06], [0.48, 0.20, 0.08],
    ];
    const shortsC: RGB[] = [
      [0.12, 0.18, 0.24], [0.86, 0.82, 0.74], [0.10, 0.10, 0.12], [0.20, 0.34, 0.44],
    ];

    let idx = 0;
    for (const side of [-1, 1]) {
      const xs = [10.35, 10.95, 11.55];
      const ys = [0.50, 0.98, 1.46];
      const yaw = side > 0 ? -Math.PI * 0.5 : Math.PI * 0.5;
      for (let r = 0; r < 3; r++) {
        for (let k = 0; k < 12; k++) {
          this.crowdSeats.push({
            x: side * xs[r],
            y: ys[r],
            z: 3.8 + k * 1.32 + (ihash(idx, 5) - 0.5) * 0.14,
            yaw,
            seed: ihash(idx, 13),
            shirt: palette[Math.floor(ihash(idx, 9) * palette.length)],
            skin: skins[Math.floor(ihash(idx, 21) * skins.length)],
            hair: hairs[Math.floor(ihash(idx, 33) * hairs.length)],
            shorts: shortsC[Math.floor(ihash(idx, 41) * shortsC.length)],
          });
          idx++;
        }
      }
    }

    const partDefs: Array<[string, THREE.BufferGeometry, keyof CrowdSeat, number]> = [
      ["head", geos.crowd.head, "skin", 0.6],
      ["hair", geos.crowd.hair, "hair", 0.8],
      ["shirt", geos.crowd.shirt, "shirt", 0.85],
      ["shorts", geos.crowd.shorts, "shorts", 0.85],
      ["armL", geos.crowd.armL, "skin", 0.6],
      ["armR", geos.crowd.armR, "skin", 0.6],
    ];
    for (const [key, geo, colKey, rough] of partDefs) {
      const im = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: rough }), this.crowdSeats.length);
      this.crowdSeats.forEach((s, i) => im.setColorAt(i, rgb(s[colKey] as RGB)));
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.castShadow = key === "shirt" || key === "head";
      im.receiveShadow = true;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.frustumCulled = false;
      parent.add(im);
      this.crowdParts[key] = im;
      this.mirrorHidden.push(im);
      this.gtaoHidden.push(im);
    }
    // Share a single GPU instanceMatrix buffer across head, hair, shirt, and shorts (4x fewer matrix writes & uploads!)
    const sharedBodyMatrix = this.crowdParts.head.instanceMatrix;
    this.crowdParts.hair.instanceMatrix = sharedBodyMatrix;
    this.crowdParts.shirt.instanceMatrix = sharedBodyMatrix;
    this.crowdParts.shorts.instanceMatrix = sharedBodyMatrix;

    // 2. Seated Animated Umpire mounted cleanly on the Umpire Chair (X=-7.35, Z=NET, facing +X)
    this.umpireRig = buildCharacterRig(UMPIRE_AVATAR, assets, aniso, false);
    this.umpireRig.root.position.set(-7.35, 0, NET);
    this.umpireRig.root.rotation.set(0, Math.PI * 0.5, 0);
    bakeSeatedUmpireBody(this.umpireRig);
    parent.add(this.umpireRig.root);
    this.mirrorHidden.push(this.umpireRig.root);

    // 3. Courtside Ball Kids (scaled ~0.84) at net-post flanks
    const bkSpots: Array<[number, number, number]> = [
      [7.6, NET - 0.8, -Math.PI * 0.5],
      [-7.8, 22.8, Math.PI * 0.35],
    ];
    bkSpots.forEach(([bx, bz, yaw], i) => {
      const rig = buildCharacterRig(BALLKID_AVATAR, assets, aniso, false);
      rig.root.position.set(bx, 0, bz);
      rig.root.rotation.set(0, yaw, 0);
      rig.root.scale.setScalar(0.84);
      rig.root.traverse((o) => { o.castShadow = false; });
      parent.add(rig.root);
      this.ballKids.push({ rig, seed: i * 2.1 + 0.7 });
      this.mirrorHidden.push(rig.root);
      this.gtaoHidden.push(rig.root);
    });

    // 4. Live 3D LED Courtside Scoreboard CanvasTexture
    this.ledCanvas = document.createElement("canvas");
    this.ledCanvas.width = 512;
    this.ledCanvas.height = 256;
    this.ledCtx = this.ledCanvas.getContext("2d")!;
    this.ledTex = new THREE.CanvasTexture(this.ledCanvas);
    this.ledTex.colorSpace = THREE.SRGBColorSpace;
    this.ledTex.anisotropy = aniso;

    if (ledScreenMesh) {
      ledScreenMesh.material = new THREE.MeshStandardMaterial({
        map: this.ledTex,
        emissiveMap: this.ledTex,
        emissive: new THREE.Color(1, 1, 1),
        emissiveIntensity: 0.95,
        roughness: 0.25,
        metalness: 0.1,
      });
    }
  }

  public updateLedScoreboard(
    game: GameState,
    youLabel: string,
    oppLabel: string,
    speedMph: number,
    trainingScore?: number,
    trainingTime?: number
  ): void {
    const key =
      game.mode === "training"
        ? `tr|${trainingScore}|${Math.floor(trainingTime || 0)}|${Math.round(speedMph)}`
        : `${game.config.venue}|${youLabel}|${oppLabel}|${game.games.join()}|${game.pts.join()}|${game.tbPts.join()}|${game.tiebreak}|${game.server}|${Math.round(speedMph)}`;
    if (key === this.lastLedKey) return;
    this.lastLedKey = key;

    const g = this.ledCtx;
    const W = 512, H = 256;

    // Deep LED panel background with subtle scanline grid
    g.fillStyle = "#071821";
    g.fillRect(0, 0, W, H);
    g.fillStyle = "rgba(56, 178, 160, 0.12)";
    for (let y = 0; y < H; y += 6) g.fillRect(0, y, W, 1);

    // Top header bar
    g.fillStyle = "#0f3344";
    g.fillRect(0, 0, W, 46);
    g.fillStyle = "#ffd23f";
    g.font = "900 22px 'Trebuchet MS','Arial Black',sans-serif";
    g.textAlign = "left";
    g.textBaseline = "middle";
    const venueName = VENUES[game.config.venue].name.toUpperCase();
    g.fillText(`LAGOON OPEN · ${venueName}`, 18, 24);

    if (game.mode === "training") {
      g.fillStyle = "#5ce1e6";
      g.font = "900 26px 'Trebuchet MS',sans-serif";
      g.fillText("TRAINING CIRCUIT", 24, 92);
      g.fillStyle = "#ffd23f";
      g.font = "900 72px 'Trebuchet MS',sans-serif";
      g.fillText(String(trainingScore || 0), 24, 175);
      g.fillStyle = "#fff8ec";
      g.textAlign = "right";
      g.font = "900 44px 'Trebuchet MS',sans-serif";
      g.fillText(`${(trainingTime || 0).toFixed(0)}s`, W - 26, 175);
    } else {
      // Score rows
      const rows = [
        { name: youLabel.toUpperCase(), games: game.games[0], pts: pointLabel(game.pts, 0, game.tiebreak, game.tbPts), srv: game.server === 0, y: 108 },
        { name: oppLabel.toUpperCase(), games: game.games[1], pts: pointLabel(game.pts, 1, game.tiebreak, game.tbPts), srv: game.server === 1, y: 176 },
      ];
      for (const r of rows) {
        g.fillStyle = "rgba(255,248,236,0.06)";
        g.fillRect(14, r.y - 26, W - 28, 52);
        if (r.srv) {
          g.fillStyle = "#ffd23f";
          g.beginPath();
          g.arc(34, r.y, 8, 0, TAU);
          g.fill();
        }
        g.fillStyle = "#fff8ec";
        g.textAlign = "left";
        g.font = "900 25px 'Trebuchet MS',sans-serif";
        g.fillText(r.name.slice(0, 14), 52, r.y + 1);

        g.fillStyle = "#ffd23f";
        g.textAlign = "center";
        g.font = "900 38px 'Trebuchet MS',sans-serif";
        g.fillText(String(r.games), 360, r.y + 1);

        g.fillStyle = "rgba(92,225,230,0.18)";
        g.fillRect(402, r.y - 22, 86, 44);
        g.fillStyle = "#5ce1e6";
        g.font = "900 36px 'Trebuchet MS',sans-serif";
        g.fillText(r.pts, 445, r.y + 1);
      }
    }

    // Bottom live radar MPH strip
    g.fillStyle = "#0a222e";
    g.fillRect(0, 214, W, 42);
    g.fillStyle = "#9ad3d8";
    g.textAlign = "left";
    g.font = "800 18px 'Trebuchet MS',sans-serif";
    g.fillText(game.tiebreak ? "TIEBREAK" : game.config.discipline === "doubles" ? "DOUBLES 2v2" : "SINGLES", 18, 236);
    if (speedMph > 20) {
      g.fillStyle = speedMph >= 120 ? "#ff6b4a" : "#ffd23f";
      g.textAlign = "right";
      g.font = "900 24px 'Trebuchet MS',sans-serif";
      g.fillText(`${Math.round(speedMph)} MPH`, W - 18, 236);
    }

    this.ledTex.needsUpdate = true;
  }

  public setUmpireVisible(visible: boolean): void {
    this.umpireRig.root.visible = visible;
  }

  public update(t: number, cheer: number, hop: number, ball: BallState): void {
    // Throttle crowd matrix uploads: 60Hz during active cheering, 30Hz during gentle idle sway (zero GC!)
    const minStep = cheer > 0.05 ? 1 / 60 : 1 / 30;
    if (this.lastCrowdUpdate < 0 || t - this.lastCrowdUpdate >= minStep) {
      this.lastCrowdUpdate = t;
      const armK = smoothstep(0.2, 0.85, cheer);
      const bodyIm = this.crowdParts.head;
      const armRIm = this.crowdParts.armR;
      const armLIm = this.crowdParts.armL;
      const base = this._cm.base;
      const rot = this._cm.r;
      const arm = this._cm.arm;
      const tmp = this._cm.tmp;
      const seats = this.crowdSeats;

      for (let i = 0; i < seats.length; i++) {
        const s = seats[i];
        const sw = Math.sin(t * 2.1 + s.seed * TAU);
        const hp = cheer > 0.01 ? Math.max(0, Math.sin(hop + s.seed * 2.2)) * cheer * 0.18 : 0;
        base.makeRotationY(s.yaw).setPosition(s.x, s.y + hp, s.z);
        rot.makeRotationZ(sw * 0.03);
        base.multiply(rot);
        bodyIm.setMatrixAt(i, base);

        const ang = lerp(0.12, 2.25, armK) + sw * (0.08 + 0.18 * cheer);
        arm.makeRotationZ(ang).setPosition(0.16, 0.52, 0);
        tmp.multiplyMatrices(base, arm);
        armRIm.setMatrixAt(i, tmp);

        arm.makeRotationZ(-ang).setPosition(-0.16, 0.52, 0);
        tmp.multiplyMatrices(base, arm);
        armLIm.setMatrixAt(i, tmp);
      }
      bodyIm.instanceMatrix.needsUpdate = true;
      armRIm.instanceMatrix.needsUpdate = true;
      armLIm.instanceMatrix.needsUpdate = true;
    }

    poseSeatedUmpire(this.umpireRig, ball, cheer, t);
    for (const bk of this.ballKids) {
      poseBallKid(bk.rig, ball, ball.live, t, bk.seed);
    }
  }
}
