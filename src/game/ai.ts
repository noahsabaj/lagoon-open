import { CAST, clamp, DW, HW, L, NET, rand } from "../core/constants";
import type { BallState, MatchDiscipline, PlayerState, RivalDef, ShotTag } from "../core/types";

interface AIShotDecision {
  tx: number;
  tz: number;
  tag: ShotTag;
  top: number;
  side: number;
  T: number;
  clear: number;
  isUnforcedError: boolean;
}

export function chooseAIShot(
  cpu: PlayerState,
  rival: RivalDef,
  ball: BallState,
  targetPlayer: PlayerState,
  discipline: MatchDiscipline,
  rallyCount: number,
  paceMult = 1.0,
  isNearPartner = false
): AIShotDecision {
  const hw = discipline === "doubles" ? DW - 0.35 : HW - 0.25;
  const atNet = isNearPartner
    ? cpu.z > NET - 5.2 && ball.bounceCount === 0 && ball.z < NET - 0.4 && ball.y < 2.3
    : cpu.z < NET + 5.2 && ball.bounceCount === 0 && ball.z > NET + 0.4 && ball.y < 2.3;

  // Pace scaling with endless multiplier and rally tension
  const tensionBoost = Math.min(0.14, Math.max(0, rallyCount - 5) * 0.015);
  const speedScale = 1 / Math.max(0.7, paceMult * (1 + tensionBoost));
  let T = rand(rival.t[0], rival.t[1]) * speedScale;
  let tag: ShotTag = "drive";
  let top = rival.top;
  let clear = 0.25;
  let tx = 0;
  let tz = isNearPartner ? NET + rand(5.5, 9.8) : rand(1.4, 5.6);

  const oppX = targetPlayer.x;
  const oppAtNet = isNearPartner ? targetPlayer.z < NET + 4.4 : targetPlayer.z > NET - 4.4;
  const openSign = -Math.sign(oppX || (Math.random() < 0.5 ? 1 : -1));
  const roll = Math.random();

  if (atNet && ball.y >= 1.95) {
    tag = "smash";
    T = rand(0.50, 0.68) * speedScale;
    top = 55;
    clear = 0.20;
    tx = openSign * rand(hw * 0.55, hw * 0.94);
    tz = isNearPartner ? NET + rand(4.5, 8.8) : rand(2.5, 6.8);
  } else if (atNet) {
    tag = "volley";
    T = rand(0.58, 0.78) * speedScale;
    top = 30;
    clear = 0.18;
    tx = openSign * rand(hw * 0.58, hw * 0.92);
    tz = isNearPartner ? NET + rand(3.5, 7.2) : rand(3.4, 7.4);
  } else if (oppAtNet && roll < rival.lobRate) {
    tag = "lob";
    T = 1.60;
    clear = 2.95;
    top = 45;
    tx = rand(-hw * 0.75, hw * 0.75);
    tz = isNearPartner ? L - rand(0.9, 2.5) : rand(0.9, 2.6);
  } else if (!oppAtNet && roll < rival.dropRate && rallyCount >= 2) {
    tag = "drop";
    T = 0.94;
    clear = 0.14;
    top = -225;
    tx = openSign * rand(hw * 0.45, hw * 0.85);
    tz = isNearPartner ? NET + rand(1.6, 2.7) : NET - rand(1.6, 2.7);
  } else if (roll < rival.dropRate + rival.sliceRate) {
    tag = "slice";
    top = -165;
    clear = 0.21;
    tx = openSign * rand(hw * 0.48, hw * 0.90);
    tz = isNearPartner ? NET + rand(4.5, 7.8) : rand(3.2, 6.8);
  } else if (rival.id === "sunny") {
    tx = oppX * 0.58 + rand(-1.5, 1.5);
    tz = Math.random() < rival.short
      ? (isNearPartner ? NET + rand(4.0, 6.2) : rand(5.2, 7.6))
      : (isNearPartner ? NET + rand(6.4, 10.2) : rand(1.4, 5.2));
  } else {
    // Corner-hunting topspin drive
    tx = openSign * rand(hw * 0.52, hw * 0.94);
    tz = isNearPartner ? NET + rand(6.8, 10.6) : rand(0.9, 4.8);
  }

  // Rally fatigue & stretched-reach natural pressure errors (higher rallies create authentic pressure!)
  const fatigueErr = Math.max(0, rallyCount - 7) * 0.0085 + cpu.fatigue * 0.06;
  const stretchErr = cpu.recover > 0 ? 0.045 : 0;
  const totalErr = clamp(rival.err + fatigueErr + stretchErr, 0.012, 0.34);
  let isUnforcedError = false;

  if (!isNearPartner && Math.random() < totalErr) {
    isUnforcedError = true;
    const r = Math.random();
    if (r < 0.45) {
      // Slightly long (gives exciting close-line Hawk-Eye moments!)
      tz = rand(-1.15, -0.09);
    } else if (r < 0.78) {
      // Slightly wide
      tx = (Math.random() < 0.5 ? -1 : 1) * (hw + rand(0.10, 0.85));
    } else {
      clear = 0; // Clips the net
    }
  }

  // Left-handed rivals (like Vesper) impart inverted sidespin kick!
  const handSign = rival.avatar.handedness === "left" ? -1 : 1;
  const side =
    tag === "slice" || tag === "drop"
      ? -130 * handSign * Math.sign(tx || 1)
      : rand(-100, 120) * handSign;

  return { tx, tz, tag, top, side, T, clear, isUnforcedError };
}

export function previewAITelegraph(
  cpu: PlayerState,
  rival: RivalDef,
  ball: BallState,
  targetPlayer: PlayerState
): void {
  if (rival.telegraph <= 0.01) return;
  const dz = Math.abs(ball.z - cpu.z);
  if (dz > 1.2 && dz < 4.5 && cpu.telegraphT <= 0 && ball.vz > 0) {
    cpu.telegraphT = rival.telegraph;
    if (targetPlayer.z > NET - 4.4 && rival.lobRate > 0.25) cpu.telegraphShot = "lob";
    else if (rival.dropRate > 0.22 && Math.random() < 0.45) cpu.telegraphShot = "drop";
    else if (rival.sliceRate > 0.30 && Math.random() < 0.45) cpu.telegraphShot = "slice";
    else cpu.telegraphShot = "drive";
  }
}

export function getPartnerRival(oppId: string): RivalDef {
  const map: Record<string, string> = {
    sunny: "koa",
    koa: "sunny",
    reef: "pippa",
    pippa: "reef",
    mako: "vesper",
    vesper: "mako",
    sol: "vesper",
  };
  return CAST[map[oppId] || "reef"] || CAST.reef;
}
