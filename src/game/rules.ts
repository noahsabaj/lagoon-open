import { DW, HW, L, NET, SVC } from "../core/constants";
import type { GameState, MatchDiscipline, MatchFormat } from "../core/types";

export function courtHalfWidth(discipline: MatchDiscipline): number {
  return discipline === "doubles" ? DW : HW;
}

export function isDeuceSide(game: Pick<GameState, "pts" | "tiebreak" | "tbPts">): boolean {
  const total = game.tiebreak ? game.tbPts[0] + game.tbPts[1] : game.pts[0] + game.pts[1];
  return total % 2 === 0;
}

export function serveBoxSign(game: Pick<GameState, "pts" | "tiebreak" | "tbPts" | "server">): number {
  const d = isDeuceSide(game);
  return game.server === 0 ? (d ? -1 : 1) : d ? 1 : -1;
}

function isServeIn(
  x: number,
  z: number,
  game: Pick<GameState, "pts" | "tiebreak" | "tbPts" | "server">
): boolean {
  const s = serveBoxSign(game);
  const far = game.server === 0;
  const zOk = far ? z >= NET && z <= NET + SVC + 0.06 : z <= NET && z >= NET - SVC - 0.06;
  const xs = x * s;
  return zOk && xs >= -0.05 && xs <= HW + 0.06;
}

export function isInCourt(x: number, z: number, near: boolean, discipline: MatchDiscipline = "singles"): boolean {
  const hw = courtHalfWidth(discipline);
  if (Math.abs(x) > hw + 0.06) return false;
  return near ? z >= -0.06 && z < NET : z > NET && z <= L + 0.06;
}

interface LineCheckResult {
  isIn: boolean;
  distMeters: number;
  lineLabel: string;
  isCloseCall: boolean;
}

export function checkLineProximity(
  x: number,
  z: number,
  near: boolean,
  isServe: boolean,
  discipline: MatchDiscipline,
  game: Pick<GameState, "pts" | "tiebreak" | "tbPts" | "server">
): LineCheckResult {
  if (isServe) {
    const ok = isServeIn(x, z, game);
    const far = game.server === 0;
    const svcZ = far ? NET + SVC : NET - SVC;
    const dSvc = Math.abs(z - svcZ);
    const dSide = Math.abs(Math.abs(x) - HW);
    const dMid = Math.abs(x);
    let minD = dSvc;
    let label = "Service Line";
    if (dSide < minD) { minD = dSide; label = "Sideline"; }
    if (dMid < minD) { minD = dMid; label = "Center Line"; }
    return { isIn: ok, distMeters: minD, lineLabel: label, isCloseCall: minD <= 0.14 };
  }

  const hw = courtHalfWidth(discipline);
  const ok = isInCourt(x, z, near, discipline);
  const baseZ = near ? 0 : L;
  const dBase = Math.abs(z - baseZ);
  const dSide = Math.abs(Math.abs(x) - hw);
  const isSide = dSide < dBase;
  const minD = Math.min(dBase, dSide);
  return {
    isIn: ok,
    distMeters: minD,
    lineLabel: isSide ? (discipline === "doubles" ? "Doubles Sideline" : "Sideline") : "Baseline",
    isCloseCall: minD <= 0.15,
  };
}

function targetGamesForFormat(format: MatchFormat): number {
  if (format === "1game") return 1;
  if (format === "6games") return 6;
  return 3;
}

interface ScoreAwardOutcome {
  isGame: boolean;
  isMatch: boolean;
  enteredTiebreak: boolean;
  snapshotPts: [number, number];
  snapshotTb: boolean;
  snapshotServer: 0 | 1;
}

export function applyPointToScore(game: GameState, winner: 0 | 1): ScoreAwardOutcome {
  const snapshotServer = game.server;
  const snapshotTb = game.tiebreak;
  let isGame = false;
  let isMatch = false;
  let enteredTiebreak = false;

  if (game.tiebreak) {
    game.tbPts[winner]++;
    const snapshotPts: [number, number] = [game.tbPts[0], game.tbPts[1]];
    const a = game.tbPts[winner];
    const b = game.tbPts[1 - winner];

    if (a >= 7 && a - b >= 2) {
      isGame = true;
      isMatch = true;
      game.games[winner]++;
      game.winner = winner;
      game.tiebreak = false;
    } else {
      // Standard tiebreak serve switch: after 1st point, then every 2 points
      const total = game.tbPts[0] + game.tbPts[1];
      if (total % 2 === 1) {
        game.server = (1 - game.server) as 0 | 1;
        rotateServerSlot(game);
      }
    }
    return { isGame, isMatch, enteredTiebreak, snapshotPts, snapshotTb, snapshotServer };
  }

  game.pts[winner]++;
  const snapshotPts: [number, number] = [game.pts[0], game.pts[1]];
  const a = game.pts[winner];
  const b = game.pts[1 - winner];

  if (a >= 4 && a - b >= 2) {
    isGame = true;
    game.games[winner]++;
    game.pts = [0, 0];
    game.server = (1 - game.server) as 0 | 1;
    rotateServerSlot(game);

    const target = targetGamesForFormat(game.config.format);
    const ga = game.games[winner];
    const gb = game.games[1 - winner];

    if (game.config.format === "6games") {
      if (ga >= 6 && ga - gb >= 2) {
        isMatch = true;
        game.winner = winner;
      } else if (ga === 6 && gb === 6) {
        game.tiebreak = true;
        game.tbPts = [0, 0];
        enteredTiebreak = true;
      }
    } else if (ga >= target) {
      isMatch = true;
      game.winner = winner;
    }
  }

  return { isGame, isMatch, enteredTiebreak, snapshotPts, snapshotTb, snapshotServer };
}

function rotateServerSlot(game: GameState): void {
  if (game.config.discipline === "doubles") {
    const order = [0, 1, 2, 3];
    const idx = order.indexOf(game.serverSlot);
    game.serverSlot = order[(idx + 1) % 4];
    game.server = (game.serverSlot % 2) as 0 | 1;
  } else {
    game.serverSlot = game.server;
  }
}

export function pointLabel(pts: [number, number], i: 0 | 1, tiebreak: boolean, tbPts: [number, number]): string {
  if (tiebreak) return String(tbPts[i]);
  const a = pts[i];
  const b = pts[1 - i];
  if (a >= 3 && b >= 3) return a > b ? "AD" : "40";
  return ["0", "15", "30", "40"][Math.min(a, 3)];
}

function callScoreFor(
  pts: [number, number],
  server: 0 | 1,
  oname: string,
  tiebreak = false
): string {
  if (tiebreak) {
    const ps = pts[server];
    const pr = pts[1 - server];
    return ps === pr ? `${ps} all` : `${ps}–${pr}`;
  }
  const [a, b] = pts;
  const N = ["Love", "15", "30", "40"];
  if (a >= 3 && b >= 3) return a === b ? "Deuce" : "Advantage " + (a > b ? "You" : oname);
  const ps = pts[server];
  const pr = pts[1 - server];
  return ps === pr ? N[ps] + " all" : N[ps] + "–" + N[pr];
}

export function pointBannerText(
  w: 0 | 1,
  reason: string,
  isGame: boolean,
  isMatch: boolean,
  pts: [number, number],
  server: 0 | 1,
  oname: string,
  tiebreak = false
): [string, string] {
  if (reason === "Winner!" || reason === "Too quick") {
    reason = w === 0 ? "Winner!" : "Too quick";
  }
  let sub: string;
  if (isMatch) sub = w === 0 ? "Game, Set & Match!" : `${oname} takes the match`;
  else if (isGame) sub = w === 0 ? "Game, You!" : `Game, ${oname}`;
  else sub = callScoreFor(pts, server, oname, tiebreak);
  return [reason, sub];
}

export function getSituationBadge(game: GameState): string {
  const target = targetGamesForFormat(game.config.format);
  const [ga, gb] = game.games;
  if (game.tiebreak) {
    const [a, b] = game.tbPts;
    if (a >= 6 && a > b) return "MATCH POINT";
    if (b >= 6 && b > a) return "MATCH POINT";
    return "TIEBREAK";
  }
  const [a, b] = game.pts;
  const isMatchGame = (gWin: number, gLose: number) =>
    game.config.format === "6games" ? gWin >= 5 && gWin >= gLose + 1 : gWin >= target - 1;

  if (a >= 3 && a > b) {
    return isMatchGame(ga, gb) ? "MATCH POINT" : game.server === 1 ? "BREAK POINT" : "GAME POINT";
  }
  if (b >= 3 && b > a) {
    return isMatchGame(gb, ga) ? "MATCH POINT" : game.server === 0 ? "BREAK POINT" : "";
  }
  if (a >= 3 && a === b) return "DEUCE";
  return "";
}
