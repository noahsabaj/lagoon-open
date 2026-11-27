import { clamp, DEFAULT_AVATAR, DEFAULT_SETTINGS } from "../core/constants";
import type {
  CareerState,
  HatId,
  RacketId,
  RivalDef,
  SettingsState,
  TrailSkinId,
  TrainingDrill,
} from "../core/types";

const CAREER_KEY = "lagoon-open-v3-career";
const SETTINGS_KEY = "lagoon-open-v3-settings";

export function defaultCareer(): CareerState {
  return {
    skill: 0,
    wins: 0,
    losses: 0,
    streak: 0,
    bestStreak: 0,
    aces: 0,
    fastestServe: 0,
    longestRally: 0,
    trainingBest: { rings: 0, rally: 0, serve: 0 },
    trainingMedals: { rings: "none", rally: "none", serve: "none" },
    crowns: {},
    cupsWon: 0,
    endlessBest: 0,
    unlockedRackets: ["classic", "coral"],
    unlockedTrails: ["default", "lagoon"],
    unlockedHats: ["none", "Hat_Visor", "Hat_Cap"],
    bossUnlocked: false,
    title: "Pier Rookie",
    avatar: structuredClone(DEFAULT_AVATAR),
  };
}

export function loadCareer(): CareerState {
  const def = defaultCareer();
  try {
    const raw = localStorage.getItem(CAREER_KEY);
    if (!raw) return def;
    const parsed = JSON.parse(raw);
    return {
      ...def,
      ...parsed,
      trainingBest: { ...def.trainingBest, ...(parsed.trainingBest || {}) },
      trainingMedals: { ...def.trainingMedals, ...(parsed.trainingMedals || {}) },
      crowns: { ...def.crowns, ...(parsed.crowns || {}) },
      avatar: { ...def.avatar, ...(parsed.avatar || {}) },
      unlockedRackets: Array.from(new Set([...def.unlockedRackets, ...(parsed.unlockedRackets || [])])),
      unlockedTrails: Array.from(new Set([...def.unlockedTrails, ...(parsed.unlockedTrails || [])])),
      unlockedHats: Array.from(new Set([...def.unlockedHats, ...(parsed.unlockedHats || [])])),
    };
  } catch {
    return def;
  }
}

export function saveCareer(career: CareerState): void {
  try {
    localStorage.setItem(CAREER_KEY, JSON.stringify(career));
  } catch {
    // ignore quota errors
  }
}

export function loadSettings(): SettingsState {
  const def = { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return def;
    return { ...def, ...JSON.parse(raw) };
  } catch {
    return def;
  }
}

export function saveSettings(s: SettingsState): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}

export function computeSkillDelta(
  career: CareerState,
  win: boolean,
  opp: RivalDef,
  m: { gamesFor: number; gamesAgainst: number; aces: number; streakBefore: number }
): number {
  const tierK = 1.0 + opp.tier * 0.22;
  const anchor = 80 + opp.tier * 240;
  const expect = 1 / (1 + Math.pow(10, -((career.skill - anchor) / 420) * 1.1));
  let d = ((win ? 1 : 0) - expect) * 48 * tierK;
  d += (m.gamesFor - m.gamesAgainst) * 4.2 * (win ? 1 : 0.6);
  d += m.aces * (win ? 3.5 : 1.4);
  if (win) d *= 1 + Math.min(m.streakBefore, 6) * 0.05;
  if (!win && career.skill < 120) d *= 0.45;
  return clamp(Math.round(d), win ? 8 : -65, win ? 105 : -4);
}

function medalForDrill(drill: TrainingDrill, score: number): "none" | "bronze" | "silver" | "gold" {
  const cuts: Record<TrainingDrill, [number, number, number]> = {
    rings: [1200, 2600, 4500],
    rally: [12, 24, 40],
    serve: [900, 1900, 3200],
  };
  const [b, s, g] = cuts[drill];
  if (score >= g) return "gold";
  if (score >= s) return "silver";
  if (score >= b) return "bronze";
  return "none";
}

const MEDAL_RANK = { none: 0, bronze: 1, silver: 2, gold: 3 };

export function evaluateUnlocks(career: CareerState): string[] {
  const newly: string[] = [];

  const addRacket = (id: RacketId, label: string) => {
    if (!career.unlockedRackets.includes(id)) {
      career.unlockedRackets.push(id);
      newly.push(`Racket Unlocked: ${label}`);
    }
  };
  const addTrail = (id: TrailSkinId, label: string) => {
    if (!career.unlockedTrails.includes(id)) {
      career.unlockedTrails.push(id);
      newly.push(`Swing Trail Unlocked: ${label}`);
    }
  };
  const addHat = (id: HatId, label: string) => {
    if (!career.unlockedHats.includes(id)) {
      career.unlockedHats.push(id);
      newly.push(`Headgear Unlocked: ${label}`);
    }
  };

  const anyMedal = Object.values(career.trainingMedals).some((m) => m !== "none");
  const anyGold = Object.values(career.trainingMedals).some((m) => m === "gold");

  if (career.skill >= 400 || anyMedal) addRacket("carbon", "Aero Carbon");
  if (career.wins >= 3) addTrail("sunset", "Coral Sunset");
  if (anyGold) addTrail("plasma", "Twilight Pulse");
  if (career.cupsWon >= 1 || career.skill >= 1000) {
    addRacket("gold", "Sol Champion");
    addTrail("gold", "Gilded Arc");
    if (!career.bossUnlocked) {
      career.bossUnlocked = true;
      newly.push("Secret Boss Unlocked: Captain Sol!");
    }
  }
  if (career.crowns["sol"] || career.endlessBest >= 5) {
    addRacket("flame", "Volcanic Legend");
    addHat("Hat_Captain", "Captain's Yacht Cap");
  }

  // Dynamic player title
  if (career.crowns["sol"]) career.title = "Lagoon Legend";
  else if (career.cupsWon >= 1) career.title = "Cup Champion";
  else if (career.skill >= 1000) career.title = "Pier Pro";
  else if (career.skill >= 500) career.title = "Circuit Contender";
  else if (career.wins >= 1) career.title = "Club Challenger";
  else career.title = "Pier Rookie";

  return newly;
}

export function upgradeMedal(
  career: CareerState,
  drill: TrainingDrill,
  score: number
): "none" | "bronze" | "silver" | "gold" {
  const earned = medalForDrill(drill, score);
  if (MEDAL_RANK[earned] > MEDAL_RANK[career.trainingMedals[drill]]) {
    career.trainingMedals[drill] = earned;
  }
  if (score > career.trainingBest[drill]) {
    career.trainingBest[drill] = score;
  }
  return earned;
}
