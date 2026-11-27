import {
  clamp,
  DRAG_K,
  G,
  KI,
  MAGNUS_K,
  NET,
  NETH,
  POST_H,
  POST_X,
  R,
  rand,
  SPIN_DECAY,
  VENUES,
} from "../core/constants";
import type { BallState, VenueDef } from "../core/types";

type PhysEvent = "bounce" | "net" | "splash" | null;

export interface NetHitState {
  x: number;
  y: number;
  amp: number;
  elapsed: number;
}

export function cordY(x: number): number {
  return NETH + (POST_H - NETH) * Math.pow(Math.min(Math.abs(x), POST_X) / POST_X, 2);
}

export function isOverDeck(x: number, z: number, venue: VenueDef): boolean {
  return Math.abs(x) <= venue.deckHalfX && z >= venue.deckZMin && z <= venue.deckZMax;
}

export function physStep(
  b: BallState,
  dt: number,
  venue: VenueDef = VENUES.pier,
  simOnly = false,
  netHit?: NetHitState
): PhysEvent {
  const px = b.x;
  const py = b.y;
  const pz = b.z;
  let ax = 0;
  let ay = -G;
  let az = 0;

  if (b.live) {
    const v = Math.hypot(b.vx, b.vy, b.vz);
    const drag = -DRAG_K * v;
    const w = b.w;
    ax = drag * b.vx + MAGNUS_K * (w.y * b.vz - w.z * b.vy);
    ay = -G + drag * b.vy + MAGNUS_K * (w.z * b.vx - w.x * b.vz);
    az = drag * b.vz + MAGNUS_K * (w.x * b.vy - w.y * b.vx);
    const dec = 1 - SPIN_DECAY * dt;
    w.x *= dec;
    w.y *= dec;
    w.z *= dec;
  }

  b.vx += ax * dt;
  b.vy += ay * dt;
  b.vz += az * dt;
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.z += b.vz * dt;

  if (!simOnly) {
    b.rotX += (b.w.x * 0.06 + b.vz * 0.4) * dt;
    b.rotY += b.w.y * 0.06 * dt;
    b.rotZ += (b.w.z * 0.06 - b.vx * 0.4) * dt;
  }

  let ev: PhysEvent = null;

  // Net crossing
  if (!b.netted && pz !== b.z && (pz - NET) * (b.z - NET) <= 0) {
    const u = (NET - pz) / (b.z - pz);
    const cx = px + (b.x - px) * u;
    const cy = py + (b.y - py) * u;
    if (Math.abs(cx) <= POST_X + R) {
      const gap = cy - cordY(cx);
      if (gap <= R + 0.08) {
        const dir = Math.sign(b.vz) || 1;
        if (!simOnly && netHit) {
          netHit.x = cx;
          netHit.y = clamp(cy, 0.1, 1.0);
          netHit.amp = clamp(Math.hypot(b.vx, b.vz) * 0.012, 0.08, 0.26);
          netHit.elapsed = 0;
        }
        if (gap > R + 0.01) {
          b.vy += 0.55;
          b.vz *= 0.84;
          b.netted = true;
          b.touched = "cord";
          ev = "net";
        } else if (gap > -R * 0.55 && b.vy < 1.8) {
          b.x = cx;
          b.z = NET + dir * 0.08;
          b.y = cordY(cx) + R + 0.025;
          b.vz = dir * (simOnly ? 1.1 : rand(0.8, 1.65));
          b.vy = simOnly ? 0.5 : rand(0.35, 0.85);
          b.vx *= 0.25;
          b.w.x *= 0.1;
          b.w.y *= 0.1;
          b.w.z *= 0.1;
          b.netted = true;
          b.touched = "cord";
          ev = "net";
        } else {
          b.x = cx;
          b.z = NET - dir * 0.06;
          b.vz = -dir * Math.min(1.2, Math.abs(b.vz) * 0.14);
          b.vx *= 0.25;
          if (b.vy > 0) b.vy *= 0.25;
          b.netted = true;
          b.touched = "mesh";
          ev = "net";
        }
      }
    }
  }

  // Pier / Venue Deck drop-off into lagoon water!
  const overDeck = isOverDeck(b.x, b.z, venue);
  if (overDeck) {
    // Surface-specific ground bounce (Hard / Clay / Grass physics)
    if (b.y < R && b.vy < 0) {
      const vn = -b.vy;
      b.y = R;
      if (vn < 0.45) {
        b.vy = 0;
      } else {
        const surf = venue.physics;
        const top = b.w.x * Math.sign(b.vz || 1);
        const e = clamp(
          surf.rest + clamp((surf.grip * R * top) / (vn + 3.5), -0.26, 0.30),
          0.32,
          0.90
        );
        const Jmax = surf.mu * (1 + e) * vn;
        const slip = b.vz - 1.15 * R * b.w.x;
        const J = clamp(slip / (1 + 1 / KI), -Jmax, Jmax);
        b.vz = (b.vz - J) * surf.speedScale;
        b.w.x += J / (KI * R);
        b.vx *= 0.94 * (0.96 + 0.04 * surf.speedScale);
        b.vy = Math.min(e * vn, surf.vyCap);
        ev = "bounce";
      }
    }
    if (b.y <= R + 1e-3 && b.vy === 0) {
      const f = Math.max(0, 1 - (1.4 + venue.physics.mu * 1.1) * dt);
      b.vx *= f;
      b.vz *= f;
    }
  } else {
    // Off the pier/deck! Falls into the lagoon water and splashes
    if (!b.splashed && b.y <= venue.waterY) {
      b.y = venue.waterY;
      b.vx *= 0.15;
      b.vy = 0;
      b.vz *= 0.15;
      b.splashed = true;
      ev = "splash";
    } else if (b.splashed) {
      b.y = venue.waterY + Math.sin(b.x * 1.2 + b.z) * 0.02;
      b.vx *= Math.max(0, 1 - 3.5 * dt);
      b.vz *= Math.max(0, 1 - 3.5 * dt);
      b.vy = 0;
    }
  }

  return ev;
}
