import { clamp, lerp } from "../core/constants";
import type { BallState, GamePhase, Handedness, PlayerState, ShotTag, VenueDef } from "../core/types";
import { type NetHitState, physStep } from "../physics/ballPhysics";

export const SIM_TICK_HZ = 60;
export const SIM_TICK_DT = 1 / SIM_TICK_HZ;
export const MAX_REWIND_TICKS = 9; // Up to 150ms of host lag-compensated swing validation
const MAX_HISTORY_FRAMES = 28;     // ~466ms rolling buffer

export interface BallSnapshot {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  wx: number;
  wy: number;
  wz: number;
  visible: boolean;
  live: boolean;
  serve: boolean;
  netted: boolean;
  touched: "cord" | "mesh" | null;
  lastHitter: number;
  lastSlot: number;
  bounceCount: number;
  mph: number;
  rocket: boolean;
  crit: boolean;
  shotTag: ShotTag;
  splashed: boolean;
}

export interface HistoryPlayerSnap {
  x: number;
  z: number;
  handedness: Handedness;
  diveT: number;
}

export interface HistoryFrame {
  tick: number;
  ball: BallSnapshot;
  players: HistoryPlayerSnap[];
}

export function snapshotBall(b: BallState): BallSnapshot {
  return {
    x: b.x, y: b.y, z: b.z,
    vx: b.vx, vy: b.vy, vz: b.vz,
    wx: b.w.x, wy: b.w.y, wz: b.w.z,
    visible: b.visible,
    live: b.live,
    serve: b.serve,
    netted: b.netted,
    touched: b.touched,
    lastHitter: b.lastHitter,
    lastSlot: b.lastSlot,
    bounceCount: b.bounceCount,
    mph: b.mph,
    rocket: b.rocket,
    crit: b.crit,
    shotTag: b.shotTag,
    splashed: b.splashed,
  };
}

export function restoreBall(b: BallState, s: BallSnapshot): void {
  b.x = s.x; b.y = s.y; b.z = s.z;
  b.vx = s.vx; b.vy = s.vy; b.vz = s.vz;
  b.w.x = s.wx; b.w.y = s.wy; b.w.z = s.wz;
  b.visible = s.visible;
  b.live = s.live;
  b.serve = s.serve;
  b.netted = s.netted;
  b.touched = s.touched;
  b.lastHitter = s.lastHitter;
  b.lastSlot = s.lastSlot;
  b.bounceCount = s.bounceCount;
  b.mph = s.mph;
  b.rocket = s.rocket;
  b.crit = s.crit;
  b.shotTag = s.shotTag;
  b.splashed = s.splashed;
}

/**
 * Advances a ball forward by `seconds` using exact 240Hz venue physics.
 * Used on host to fast-forward a lag-compensated shot back to present time,
 * and on guests to extrapolate authoritative snapshots forward by RTT / 2.
 */
export function fastForwardBall(
  ball: BallState,
  seconds: number,
  venue: VenueDef,
  simOnly = true,
  netHit?: NetHitState
): Array<"bounce" | "net" | "splash"> {
  const dt = clamp(seconds, 0, 0.16);
  if (dt <= 1e-5 || !ball.visible) return [];
  const steps = Math.max(1, Math.ceil(dt * 240));
  const h = dt / steps;
  const events: Array<"bounce" | "net" | "splash"> = [];
  for (let i = 0; i < steps; i++) {
    const ev = physStep(ball, h, venue, simOnly, netHit);
    if (ev) events.push(ev);
  }
  return events;
}

/**
 * Host-side 60Hz state history ring buffer enabling lag-compensated hit registration
 * so remote guests with 50-120ms ping get fair sweet-spot timing windows.
 */
export class StateHistoryRing {
  private frames: HistoryFrame[] = [];

  public push(tick: number, ball: BallState, players: PlayerState[]): void {
    const snap: HistoryFrame = {
      tick,
      ball: snapshotBall(ball),
      players: players.map((p) => ({ x: p.x, z: p.z, handedness: p.handedness, diveT: p.diveT })),
    };
    const last = this.frames[this.frames.length - 1];
    if (last && last.tick === tick) {
      this.frames[this.frames.length - 1] = snap;
      return;
    }
    this.frames.push(snap);
    if (this.frames.length > MAX_HISTORY_FRAMES) {
      this.frames.shift();
    }
  }

  public latestTick(): number {
    return this.frames.length ? this.frames[this.frames.length - 1].tick : 0;
  }

  public lookup(targetTick: number): { frame: HistoryFrame; rewindTicks: number } | null {
    if (this.frames.length === 0) return null;
    const latest = this.frames[this.frames.length - 1].tick;
    const clamped = clamp(Math.round(targetTick), latest - MAX_REWIND_TICKS, latest);
    let chosen = this.frames[0];
    for (let i = this.frames.length - 1; i >= 0; i--) {
      if (this.frames[i].tick <= clamped) {
        chosen = this.frames[i];
        break;
      }
    }
    return { frame: chosen, rewindTicks: Math.max(0, latest - chosen.tick) };
  }

  public clear(): void {
    this.frames.length = 0;
  }
}

export interface PendingSwing {
  seq: number;
  sentAtMs: number;
  predictedHit: boolean;
  predictedPhase: GamePhase;
  predictedHitter: number;
}

export type ReconcileOutcome = "idle" | "hold" | "matched" | "rollback";

/**
 * Guest-side 0ms local swing predictor & mispredict rollback reconciler.
 * Holds locally predicted ball flight until the host acknowledges `seq`,
 * suppresses duplicate hit SFX/VFX on match, and snaps smoothly on mispredict.
 */
export class SwingPredictor {
  public pending: PendingSwing | null = null;
  private suppressedSeqs: number[] = [];

  public begin(entry: PendingSwing): void {
    this.pending = entry;
    if (entry.predictedHit) {
      this.suppressedSeqs.push(entry.seq);
      if (this.suppressedSeqs.length > 16) this.suppressedSeqs.shift();
    }
  }

  public shouldHoldPrediction(ackedSeq: number, nowMs: number): boolean {
    if (!this.pending) return false;
    if (ackedSeq >= this.pending.seq) return false;
    if (nowMs - this.pending.sentAtMs > 240) {
      this.pending = null;
      return false;
    }
    return true;
  }

  public shouldSuppressEvent(seq: number | undefined): boolean {
    if (seq === undefined) return false;
    return this.suppressedSeqs.includes(seq);
  }

  /**
   * Reconciles a locally predicted ball against the newly received authoritative host ball.
   * Both `authBall` and `localBall` must be in the SAME coordinate frame (the guest's view frame).
   */
  public reconcile(
    authBall: BallState,
    localBall: BallState,
    ackedSeq: number,
    rttMs: number,
    venue: VenueDef,
    nowMs = performance.now()
  ): ReconcileOutcome {
    if (!this.pending) return "idle";
    if (this.shouldHoldPrediction(ackedSeq, nowMs)) return "hold";

    const pred = this.pending;
    this.pending = null;

    // Extrapolate authoritative ball forward by half-RTT so comparison matches local display time
    const ext: BallState = { ...authBall, w: { ...authBall.w } };
    const halfRttSec = clamp((rttMs || 0) * 0.0005, 0, 0.08);
    if (ext.visible && ext.live && halfRttSec > 0.002) {
      fastForwardBall(ext, halfRttSec, venue, true);
    }

    const posErr = Math.hypot(ext.x - localBall.x, ext.y - localBall.y, ext.z - localBall.z);
    const sameHitter = ext.lastHitter === pred.predictedHitter;
    const hitAgreed = pred.predictedHit ? sameHitter && ext.live : !localBall.live || sameHitter;

    if (hitAgreed && posErr < 0.65) {
      // Prediction matched! Gently blend residual centimeter drift & adopt authoritative velocities
      localBall.x = lerp(localBall.x, ext.x, 0.45);
      localBall.y = lerp(localBall.y, ext.y, 0.45);
      localBall.z = lerp(localBall.z, ext.z, 0.45);
      localBall.vx = ext.vx;
      localBall.vy = ext.vy;
      localBall.vz = ext.vz;
      localBall.w.x = ext.w.x;
      localBall.w.y = ext.w.y;
      localBall.w.z = ext.w.z;
      localBall.rocket = ext.rocket;
      localBall.crit = ext.crit;
      localBall.shotTag = ext.shotTag;
      localBall.lastHitter = ext.lastHitter;
      localBall.lastSlot = ext.lastSlot;
      localBall.bounceCount = ext.bounceCount;
      localBall.serve = ext.serve;
      localBall.splashed = ext.splashed;
      localBall.visible = ext.visible;
      localBall.live = ext.live;
      return "matched";
    }

    // Mispredict rollback (e.g. opponent poached a volley first or guest whiffed outside rewind cap)
    const idx = this.suppressedSeqs.indexOf(pred.seq);
    if (idx !== -1) this.suppressedSeqs.splice(idx, 1);
    restoreBall(localBall, snapshotBall(ext));
    return "rollback";
  }

  public reset(): void {
    this.pending = null;
    this.suppressedSeqs.length = 0;
  }
}
