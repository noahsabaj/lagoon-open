import {
  DRAG_K,
  G,
  L,
  MAGNUS_K,
  MPH,
  NET,
  R,
  SPIN_DECAY,
  VENUES,
} from "../core/constants";
import type { BallSpin, BallState, PredictionResult, ShotTag, VenueDef } from "../core/types";
import { cordY, physStep } from "./ballPhysics";

interface FlightSolution {
  vx: number;
  vy: number;
  vz: number;
  gap: number;
}

function solveFlight(
  bx: number,
  by: number,
  bz: number,
  tx: number,
  tz: number,
  T: number,
  w0: BallSpin
): FlightSolution {
  let vx = (tx - bx) / T;
  let vz = (tz - bz) / T;
  let vy = (R - by + 0.5 * G * T * T) / T;
  const steps = Math.max(24, Math.min(90, Math.round(T * 60)));
  const dt = T / steps;
  let minGap = 99;

  for (let it = 0; it < 5; it++) {
    let x = bx;
    let y = by;
    let z = bz;
    let cvx = vx;
    let cvy = vy;
    let cvz = vz;
    let wx = w0.x;
    let wy = w0.y;
    let wz = w0.z;
    minGap = 99;
    for (let s = 0; s < steps; s++) {
      const pz = z;
      const v = Math.hypot(cvx, cvy, cvz);
      const dg = -DRAG_K * v;
      cvx += (dg * cvx + MAGNUS_K * (wy * cvz - wz * cvy)) * dt;
      cvy += (-G + dg * cvy + MAGNUS_K * (wz * cvx - wx * cvz)) * dt;
      cvz += (dg * cvz + MAGNUS_K * (wx * cvy - wy * cvx)) * dt;
      x += cvx * dt;
      y += cvy * dt;
      z += cvz * dt;
      const dec = 1 - SPIN_DECAY * dt;
      wx *= dec;
      wy *= dec;
      wz *= dec;
      if ((pz - NET) * (z - NET) <= 0 && z !== pz) {
        const u = (NET - pz) / (z - pz);
        const nx = x - cvx * dt * (1 - u);
        const ny = y - cvy * dt * (1 - u);
        minGap = ny - cordY(nx);
      }
    }
    vx += (tx - x) / T;
    vy += (R - y) / T;
    vz += (tz - z) / T;
  }
  return { vx, vy, vz, gap: minGap };
}

interface LaunchSpec {
  mph?: number;
  T?: number;
  top?: number;
  side?: number;
  clear?: number;
  rocket?: boolean;
  crit?: boolean;
  tag?: ShotTag;
}

export function launchBall(ball: BallState, tx: number, tz: number, spec: LaunchSpec): number {
  const dir = Math.sign(tz - ball.z) || 1;
  const w0: BallSpin = {
    x: (spec.top || 0) * dir,
    y: spec.side || 0,
    z: Math.abs(spec.top || 0) * 0.08 * dir,
  };
  let sol: FlightSolution = { vx: 0, vy: 5, vz: dir * 15, gap: 0.5 };
  if (spec.T) {
    let T = spec.T;
    for (let k = 0; k < 6; k++) {
      sol = solveFlight(ball.x, ball.y, ball.z, tx, tz, T, w0);
      if (sol.gap >= (spec.clear ?? 0.2)) break;
      T *= 1.07;
    }
  } else {
    let lo = 0.34;
    let hi = 1.65;
    for (let k = 0; k < 8; k++) {
      const T = (lo + hi) * 0.5;
      sol = solveFlight(ball.x, ball.y, ball.z, tx, tz, T, w0);
      const mph = Math.hypot(sol.vx, sol.vy, sol.vz) * MPH;
      if (sol.gap < (spec.clear ?? 0.2)) lo = T;
      else if (mph > (spec.mph || 80)) lo = T;
      else hi = T;
    }
  }

  Object.assign(ball, {
    vx: sol.vx,
    vy: sol.vy,
    vz: sol.vz,
    w: w0,
    netted: false,
    touched: null,
    bounceCount: 0,
    visible: true,
    live: true,
    splashed: false,
    rocket: !!spec.rocket,
    crit: !!spec.crit,
    shotTag: spec.tag || "drive",
    mph: Math.hypot(sol.vx, sol.vy, sol.vz) * MPH,
  });
  return ball.mph;
}

export function predictBall(
  ball: BallState,
  near: boolean,
  venue: VenueDef = VENUES.pier,
  forVolley = false,
  volleyZ = 3.5
): PredictionResult {
  const s: BallState = { ...ball, w: { ...ball.w } };
  let bounces = 0;
  let firstBounce: { x: number; z: number } | null = null;
  const h = 1 / 120;

  for (let i = 0; i < 600; i++) {
    const ev = physStep(s, h, venue, true);
    if (ev === "bounce" && (s.z < NET) === near) {
      bounces++;
      if (!firstBounce) firstBounce = { x: s.x, z: s.z };
    }
    if (ev === "splash") break;
    if (
      near &&
      forVolley &&
      bounces === 0 &&
      s.z <= volleyZ + 0.4 &&
      s.z > 0 &&
      s.y >= 0.45 &&
      s.y <= 2.15
    ) {
      return { x: s.x, z: s.z, bx: s.x, bz: s.z, volley: true };
    }
    if (
      !near &&
      forVolley &&
      bounces === 0 &&
      s.z >= volleyZ - 0.4 &&
      s.z < L &&
      s.y >= 0.45 &&
      s.y <= 2.15
    ) {
      return { x: s.x, z: s.z, bx: s.x, bz: s.z, volley: true };
    }
    if (near) {
      if (bounces >= 1 && ((s.vy < 0 && s.y < 1.30) || s.z < -1.5)) {
        return { x: s.x, z: s.z, bx: firstBounce!.x, bz: firstBounce!.z };
      }
      if (bounces === 0 && s.z < -2.6) return { x: s.x, z: -1.5, bx: s.x, bz: -1.2 };
    } else {
      if (bounces >= 1 && ((s.vy < 0 && s.y < 1.30) || s.z > L + 1.5)) {
        return { x: s.x, z: s.z, bx: firstBounce!.x, bz: firstBounce!.z };
      }
      if (bounces === 0 && s.z > L + 2.6) return { x: s.x, z: L + 1.5, bx: s.x, bz: L + 1.2 };
    }
  }

  return {
    x: s.x,
    z: s.z,
    bx: firstBounce ? firstBounce.x : s.x,
    bz: firstBounce ? firstBounce.z : s.z,
  };
}
