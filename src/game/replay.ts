import { clamp, lerp } from "../core/constants";
import type { BallState, HawkEyeState, PlayerState, ReplayFrame, ReplayPlayerSnap } from "../core/types";

const MAX_FRAMES = 480; // ~4s at 120Hz or ~8s at 60Hz
const REPLAY_CLIP_SIM_SEC = 2.4;
const REPLAY_SPEED = 0.52; // Smooth 52% broadcast slow-motion at full monitor FPS (60/120/144Hz)

function lerpPlayer(a: ReplayPlayerSnap, b: ReplayPlayerSnap, u: number): ReplayPlayerSnap {
  const sameSwing = a.swingType === b.swingType && b.swingT >= a.swingT;
  const sameDive = a.diveDir === b.diveDir && b.diveT >= a.diveT;
  const sameLunge = a.lungeDir === b.lungeDir && b.lungeT >= a.lungeT;
  const sameEmote = a.emote === b.emote && b.emoteT >= a.emoteT;
  return {
    slot: a.slot,
    x: lerp(a.x, b.x, u),
    z: lerp(a.z, b.z, u),
    vx: lerp(a.vx, b.vx, u),
    vz: lerp(a.vz, b.vz, u),
    swingT: sameSwing ? lerp(a.swingT, b.swingT, u) : a.swingT,
    swingDur: sameSwing ? lerp(a.swingDur, b.swingDur, u) : a.swingDur,
    swingType: a.swingType,
    diveT: sameDive ? lerp(a.diveT, b.diveT, u) : a.diveT,
    diveDir: a.diveDir,
    lungeT: sameLunge ? lerp(a.lungeT, b.lungeT, u) : a.lungeT,
    lungeDir: a.lungeDir,
    tossArm: lerp(a.tossArm, b.tossArm, u),
    emoteT: sameEmote ? lerp(a.emoteT, b.emoteT, u) : a.emoteT,
    emote: a.emote,
  };
}

export class ReplaySystem {
  private ring: ReplayFrame[] = [];
  private simTime = 0;

  public active = false;
  public label = "INSTANT REPLAY";
  public playbackFrames: ReplayFrame[] = [];
  public playIdx = 0;
  public playTimer = 0;
  private playSimTime = 0;

  public hawkeye: HawkEyeState = {
    active: false,
    timer: 0,
    duration: 2.3,
    x: 0,
    z: 0,
    isIn: true,
    distCm: 0,
    lineLabel: "Baseline",
  };

  public clearBuffer(): void {
    this.ring.length = 0;
    this.simTime = 0;
  }

  public record(dt: number, ball: BallState, players: PlayerState[]): void {
    if (this.active || dt <= 0) return;
    // Advance monotonic simulation clock so live slow-mo never creates double-slow-mo stutter!
    this.simTime += dt;

    const snap: ReplayFrame = {
      t: this.simTime,
      bx: ball.x,
      by: ball.y,
      bz: ball.z,
      bvis: ball.visible,
      brocket: ball.rocket,
      bcrit: ball.crit,
      btag: ball.shotTag,
      brotX: ball.rotX,
      brotY: ball.rotY,
      brotZ: ball.rotZ,
      players: players.map((p) => ({
        slot: p.slot,
        x: p.x,
        z: p.z,
        vx: p.vx,
        vz: p.vz,
        swingT: p.swingT,
        swingDur: p.swingDur,
        swingType: p.swingType,
        diveT: p.diveT,
        diveDir: p.diveDir,
        lungeT: p.lungeT,
        lungeDir: p.lungeDir,
        tossArm: p.tossArm,
        emoteT: p.emoteT,
        emote: p.emote,
      })),
    };

    this.ring.push(snap);
    if (this.ring.length > MAX_FRAMES) {
      this.ring.shift();
    }
  }

  public triggerReplay(label: string): boolean {
    if (this.ring.length < 18) return false;
    const endT = this.ring[this.ring.length - 1].t;
    const startT = endT - REPLAY_CLIP_SIM_SEC;
    let startIdx = 0;
    while (startIdx < this.ring.length - 2 && this.ring[startIdx].t < startT) {
      startIdx++;
    }
    this.playbackFrames = this.ring.slice(startIdx);
    if (this.playbackFrames.length < 2) return false;
    this.active = true;
    this.label = label;
    this.playIdx = 0;
    this.playTimer = 0;
    this.playSimTime = this.playbackFrames[0].t;
    return true;
  }

  public stepReplay(dt: number): ReplayFrame | null {
    if (!this.active || this.playbackFrames.length < 2) return null;
    this.playTimer += dt;
    this.playSimTime += dt * REPLAY_SPEED;

    const frames = this.playbackFrames;
    const lastT = frames[frames.length - 1].t;
    if (this.playSimTime >= lastT) {
      this.stopReplay();
      return null;
    }

    while (this.playIdx + 1 < frames.length - 1 && frames[this.playIdx + 1].t <= this.playSimTime) {
      this.playIdx++;
    }

    const a = frames[this.playIdx];
    const b = frames[this.playIdx + 1];
    const span = Math.max(1e-6, b.t - a.t);
    const u = clamp((this.playSimTime - a.t) / span, 0, 1);

    const ballJump = Math.hypot(b.bx - a.bx, b.by - a.by, b.bz - a.bz) > 3.0;
    const interpBall = a.bvis && b.bvis && !ballJump;

    return {
      t: this.playSimTime,
      bx: interpBall ? lerp(a.bx, b.bx, u) : a.bx,
      by: interpBall ? lerp(a.by, b.by, u) : a.by,
      bz: interpBall ? lerp(a.bz, b.bz, u) : a.bz,
      bvis: a.bvis && (b.bvis || u < 0.5),
      brocket: a.brocket || b.brocket,
      bcrit: a.bcrit || b.bcrit,
      btag: u < 0.5 ? a.btag : b.btag,
      brotX: interpBall ? lerp(a.brotX, b.brotX, u) : a.brotX,
      brotY: interpBall ? lerp(a.brotY, b.brotY, u) : a.brotY,
      brotZ: interpBall ? lerp(a.brotZ, b.brotZ, u) : a.brotZ,
      players: a.players.map((pa, idx) => {
        const pb = b.players[idx];
        return pb && pb.slot === pa.slot ? lerpPlayer(pa, pb, u) : pa;
      }),
    };
  }

  public stopReplay(): void {
    this.active = false;
    this.playbackFrames = [];
    this.playIdx = 0;
    this.playTimer = 0;
    this.playSimTime = 0;
  }

  public triggerHawkEye(x: number, z: number, isIn: boolean, distMeters: number, lineLabel: string): void {
    this.hawkeye = {
      active: true,
      timer: 0,
      duration: 2.15,
      x,
      z,
      isIn,
      distCm: Math.max(0.1, Math.round(distMeters * 1000) / 10),
      lineLabel,
    };
  }

  public stepHawkEye(dt: number): boolean {
    if (!this.hawkeye.active) return false;
    this.hawkeye.timer += dt;
    if (this.hawkeye.timer >= this.hawkeye.duration) {
      this.hawkeye.active = false;
      return false;
    }
    return true;
  }

  public skipAny(): boolean {
    if (this.hawkeye.active) {
      this.hawkeye.active = false;
      return true;
    }
    if (this.active) {
      this.stopReplay();
      return true;
    }
    return false;
  }
}
