import { HW, L, NET, rand, SVC } from "../core/constants";
import type { BallState, TrainingDrill, TrainingState } from "../core/types";
import { launchBall } from "../physics/solver";

export function createTrainingState(drill: TrainingDrill): TrainingState {
  const st: TrainingState = {
    drill,
    score: 0,
    combo: 0,
    comboT: 0,
    time: drill === "rally" ? 0 : 60,
    feedT: 0.85,
    rings: [],
    spawned: 0,
    rallyStreak: 0,
    lives: 3,
    serveTarget: null,
    servePhase: "serve",
  };
  if (drill === "rings") {
    for (let i = 0; i < 3; i++) spawnRing(st, i);
  } else if (drill === "serve") {
    spawnServeZone(st, true);
  }
  return st;
}

function spawnRing(training: TrainingState, slot: number): void {
  training.spawned++;
  const gold = training.spawned % 4 === 0;
  const spots: Array<[number, number, number]> = [
    [-3.4, 1.08, L - 1.3],
    [3.4, 1.08, L - 1.3],
    [-2.4, 1.02, NET + 3.6],
    [2.4, 1.02, NET + 3.6],
    [0.0, 1.35, L - 2.4],
    [-3.1, 0.85, NET + 2.2], // drop-shot sweet ring!
    [3.1, 0.85, NET + 2.2],
  ];
  const sp = spots[(training.spawned * 3 + slot * 2) % spots.length];
  training.rings[slot] = {
    active: true,
    gold,
    baseX: sp[0],
    x: sp[0],
    y: sp[1],
    z: sp[2],
    r: gold ? 0.56 : 0.78,
    seed: Math.random() * 10,
    moving: gold || training.spawned >= 8,
  };
}

export function spawnServeZone(training: TrainingState, isServe: boolean): void {
  training.servePhase = isServe ? "serve" : "return";
  if (isServe) {
    const side = Math.random() < 0.5 ? -1 : 1;
    training.serveTarget = {
      x: side * rand(1.2, HW - 0.9),
      z: NET + rand(2.2, SVC - 0.8),
      r: 1.35,
      isServe: true,
    };
  } else {
    const side = Math.random() < 0.5 ? -1 : 1;
    training.serveTarget = {
      x: side * rand(1.6, HW - 0.8),
      z: L - rand(1.2, 3.6),
      r: 1.55,
      isServe: false,
    };
  }
}

export function feedTrainingBall(ball: BallState, training: TrainingState): void {
  const isRally = training.drill === "rally";
  const isServeReturn = training.drill === "serve" && training.servePhase === "return";

  Object.assign(ball, {
    x: isServeReturn ? rand(-1.6, 1.6) : rand(-1.1, 1.1),
    y: isServeReturn ? 2.45 : 1.35,
    z: isServeReturn ? L + 0.2 : L - 0.4,
    visible: true,
    live: true,
    serve: isServeReturn,
    lastHitter: 1,
    lastSlot: 1,
  });

  if (isServeReturn) {
    const tx = rand(-2.9, 2.9);
    const tz = NET - rand(3.0, SVC - 0.6);
    launchBall(ball, tx, tz, { mph: rand(92, 114), top: 95, side: rand(-110, 110), clear: 0.18, tag: "drive" });
  } else if (isRally) {
    const speedUp = Math.min(0.42, training.rallyStreak * 0.018);
    const tx = rand(-2.8, 2.8);
    const tz = rand(0.9, 4.0);
    launchBall(ball, tx, tz, { T: Math.max(0.72, 1.18 - speedUp), top: 130 + training.rallyStreak * 6, side: rand(-90, 90), clear: 0.28, tag: "drive" });
  } else {
    const tx = rand(-2.5, 2.5);
    const tz = rand(0.5, 3.4);
    launchBall(ball, tx, tz, { T: 1.14, top: 65, side: 0, clear: 0.34, tag: "drive" });
  }
}

interface RingHitOutcome {
  hit: boolean;
  pts: number;
  gold: boolean;
  mul: number;
  rx: number;
  ry: number;
  rz: number;
}

export function checkTrainingRingHit(
  training: TrainingState,
  ball: BallState,
  px: number,
  py: number,
  pz: number
): RingHitOutcome | null {
  if (training.drill !== "rings" || !ball.live || ball.lastHitter !== 0) return null;
  for (let i = 0; i < training.rings.length; i++) {
    const rg = training.rings[i];
    if (!rg.active) continue;
    if ((pz - rg.z) * (ball.z - rg.z) <= 0 && ball.z !== pz) {
      const u = (rg.z - pz) / (ball.z - pz);
      const hx = px + (ball.x - px) * u;
      const hy = py + (ball.y - py) * u;
      if (Math.hypot(hx - rg.x, hy - rg.y) <= rg.r + 0.28) {
        training.combo++;
        training.comboT = 3.4;
        const mul = Math.min(5, 1 + 0.25 * (training.combo - 1));
        const pts = Math.round((rg.gold ? 250 : 100) * mul);
        training.score += pts;
        training.time = Math.min(60, training.time + (rg.gold ? 1.3 : 0.6));
        const out: RingHitOutcome = { hit: true, pts, gold: rg.gold, mul, rx: rg.x, ry: rg.y, rz: rg.z };
        spawnRing(training, i);
        return out;
      }
    }
  }
  return null;
}
