import { CAST, CORE_RIVAL_IDS, VENUE_ORDER } from "../core/constants";
import type {
  CareerState,
  EndlessState,
  MatchDiscipline,
  MatchFormat,
  TournamentMatch,
  TournamentState,
  VenueId,
} from "../core/types";

export function createTournament(
  discipline: MatchDiscipline,
  format: MatchFormat,
  venue: VenueId,
  career: CareerState
): TournamentState {
  // Pick 7 rivals for an 8-slot knockout bracket (You vs Round 1, 2, 3)
  const pool = [...CORE_RIVAL_IDS];
  if (career.bossUnlocked) pool.push("sol");

  // Order opponents progressively: QF (Rookie/Club), SF (Pro/Ace), Final (Champ/Master/Boss)
  const qfOpp = pool[Math.random() < 0.5 ? 0 : 1]; // Sunny or Koa
  const sfOpp = pool[Math.random() < 0.5 ? 2 : 3]; // Reef or Pippa
  const finPool = career.bossUnlocked ? ["mako", "vesper", "sol"] : ["mako", "vesper"];
  const finOpp = finPool[Math.floor(Math.random() * finPool.length)];
  const remaining = pool.filter((id) => id !== qfOpp && id !== sfOpp && id !== finOpp);
  const f1 = remaining[0] || "koa";
  const f2 = remaining[1] || "pippa";
  const f3 = remaining[2] || "mako";
  // Use Captain Sol when unlocked or a unique club qualifier ("Kai") so no rival ever repeats in QFs
  const f4 = remaining[3] || "Kai";

  const r0: TournamentMatch[] = [
    { round: 0, p1: "YOU", p2: qfOpp, winner: null, score: "" },
    { round: 0, p1: sfOpp, p2: f1, winner: sfOpp, score: "3–1" },
    { round: 0, p1: f2, p2: f3, winner: f2, score: "3–2" },
    { round: 0, p1: finOpp, p2: f4, winner: finOpp, score: "3–0" },
  ];
  const r1: TournamentMatch[] = [
    { round: 1, p1: "TBD", p2: sfOpp, winner: null, score: "" },
    { round: 1, p1: f2, p2: finOpp, winner: finOpp, score: "3–1" },
  ];
  const r2: TournamentMatch[] = [
    { round: 2, p1: "TBD", p2: finOpp, winner: null, score: "" },
  ];

  const partnerId = qfOpp === "sunny" ? "koa" : "sunny";

  return {
    active: true,
    discipline,
    format,
    venue,
    round: 0,
    opponents: [qfOpp, sfOpp, finOpp],
    partnerId,
    rounds: [r0, r1, r2],
  };
}

export function recordTournamentResult(
  t: TournamentState,
  won: boolean,
  scoreText: string
): { tournamentOver: boolean; champion: boolean } {
  const m = t.rounds[t.round][0];
  m.score = scoreText;
  m.winner = won ? "YOU" : m.p2;

  if (!won) {
    t.active = false;
    return { tournamentOver: true, champion: false };
  }

  if (t.round === 2) {
    t.active = false;
    return { tournamentOver: true, champion: true };
  }

  // Advance player to next round
  t.round++;
  t.rounds[t.round][0].p1 = "YOU";
  return { tournamentOver: false, champion: false };
}

export function tournamentRoundName(round: number): string {
  return round === 0 ? "Quarterfinal" : round === 1 ? "Semifinal" : "Championship Final";
}

export function tournamentVenueForRound(t: TournamentState): VenueId {
  // Cycle through the 3 tropical venues across rounds for tournament spectacle!
  const startIdx = VENUE_ORDER.indexOf(t.venue);
  return VENUE_ORDER[(startIdx + t.round) % VENUE_ORDER.length];
}

export function rivalDisplayName(id: string): string {
  if (id === "YOU") return "You";
  if (id === "TBD") return "TBD";
  return CAST[id]?.name || id;
}

export function createEndless(discipline: MatchDiscipline): EndlessState {
  return {
    active: true,
    wins: 0,
    paceMult: 1.0,
    discipline,
    currentOpp: CORE_RIVAL_IDS[0],
  };
}

export function advanceEndless(e: EndlessState, bossUnlocked: boolean): { oppId: string; venue: VenueId } {
  e.wins++;
  e.paceMult = Math.min(1.38, 1.0 + e.wins * 0.045);
  const ladder = bossUnlocked ? [...CORE_RIVAL_IDS, "sol"] : [...CORE_RIVAL_IDS];
  e.currentOpp = ladder[e.wins % ladder.length];
  const venue = VENUE_ORDER[e.wins % VENUE_ORDER.length];
  return { oppId: e.currentOpp, venue };
}
