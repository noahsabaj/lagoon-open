import type {
  AvatarConfig,
  MatchStats,
  RacketId,
  RGB,
  RivalDef,
  SettingsState,
  ShotSpec,
  ShotTag,
  SkyId,
  SkyPreset,
  TrailSkinId,
  VenueDef,
  VenueId,
} from "./types";

// =========================================================================
// PHYSICS & COURT GEOMETRY CONSTANTS
// =========================================================================
export const G = 9.8;
export const R = 0.04;
export const MPH = 2.2369362920544;
export const HW = 4.115; // Singles half-width
export const DW = 5.485; // Doubles half-width
export const L = 23.77;
export const NET = L / 2;
export const NETH = 0.914;
export const SVC = 6.4;
export const POST_X = DW + 0.914;
export const POST_H = 1.07;
export const TOSS_VY = 5.4;

export const DRAG_K = 0.0115;
export const MAGNUS_K = 0.00135;
export const SPIN_DECAY = 0.20;
export const KI = 0.55;

export const DEG = Math.PI / 180;
export const TAU = Math.PI * 2;

export const rand = (a: number, b: number) => a + Math.random() * (b - a);
export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

// =========================================================================
// SHOTS & TIMING WINDOWS
// =========================================================================
export const SHOT: Record<ShotTag, ShotSpec> = {
  drive: { mphSweet: 99, mphCross: 76, mphLine: 95, top: 280, side: 200, clear: 0.30, depthEarly: 5.5, depthSweet: 10.2, depthLate: 10.5 },
  slice: { mphSweet: 64, mphCross: 57, mphLine: 60, top: -180, side: -180, clear: 0.22, depthEarly: 5.8, depthSweet: 7.5, depthLate: 8.3 },
  drop:  { T: 0.92, top: -240, side: -110, clear: 0.14, depthEarly: 1.55, depthSweet: 2.05, depthLate: 2.55 },
  lob:   { T: 1.68, top: 50, side: 40, clear: 3.05, depthEarly: 8.8, depthSweet: 10.7, depthLate: 11.0 },
  smash: { mphSweet: 112, mphCross: 99, mphLine: 106, top: 45, side: 50, clear: 0.24, depthEarly: 4.5, depthSweet: 8.7, depthLate: 10.0 },
  volley: { mphSweet: 78, mphCross: 69, mphLine: 74, top: 25, side: 90, clear: 0.18, depthEarly: 3.4, depthSweet: 4.9, depthLate: 6.2 },
};

export const WIN = {
  ground: { early: 1.85, sweet: 0.26, late: -1.05, x: 2.25, diveX: 3.45, yLo: 0.08, yHi: 2.15 },
  drop:   { early: 1.85, sweet: 0.28, late: -0.95, x: 2.20, diveX: 3.10, yLo: 0.08, yHi: 2.05 },
  lob:    { early: 1.95, sweet: 0.32, late: -1.10, x: 2.35, diveX: 3.30, yLo: 0.10, yHi: 2.40 },
  volley: { early: 1.25, sweet: 0.12, late: -0.65, x: 1.80, diveX: 2.65, yLo: 0.35, yHi: 2.15 },
  smash:  { early: 1.45, sweet: 0.05, late: -0.55, x: 2.35, diveX: 2.85, yLo: 1.95, yHi: 4.35 },
};

export const emptyMatchStats = (): MatchStats => ({
  aces: 0,
  winners: 0,
  fastestServe: 0,
  longestRally: 0,
});

// =========================================================================
// 3 TROPICAL VENUES WITH AUTHENTIC SURFACE PHYSICS
// =========================================================================
export const VENUES: Record<VenueId, VenueDef> = {
  pier: {
    id: "pier",
    name: "Lagoon Pier",
    surfaceLabel: "Hard Court",
    defaultSky: "golden",
    physics: {
      rest: 0.60,
      grip: 2.75,
      mu: 0.60,
      vyCap: 6.6,
      speedScale: 1.0,
      dustColor: [0.96, 0.94, 0.84],
      bouncePitch: 1.0,
      label: "Balanced Hard",
    },
    deckHalfX: 13.0,
    deckZMin: -6.0,
    deckZMax: 30.0,
    waterY: -1.5,
    inPlayColor: [36, 152, 136],
    outPlayColor: [24, 94, 92],
    umbrellaColors: [[0.98, 0.74, 0.18], [0.18, 0.72, 0.68]],
  },
  cove: {
    id: "cove",
    name: "Coral Cove",
    surfaceLabel: "Red Clay",
    defaultSky: "noon",
    physics: {
      rest: 0.66,
      grip: 3.35,
      mu: 0.72,
      vyCap: 7.3,
      speedScale: 0.86,
      dustColor: [0.92, 0.44, 0.24],
      bouncePitch: 0.84,
      label: "High-Kick Clay",
    },
    deckHalfX: 13.4,
    deckZMin: -6.2,
    deckZMax: 30.4,
    waterY: -1.5,
    inPlayColor: [188, 86, 52],
    outPlayColor: [148, 66, 42],
    umbrellaColors: [[0.94, 0.34, 0.24], [0.96, 0.78, 0.28]],
  },
  terrace: {
    id: "terrace",
    name: "Emerald Terrace",
    surfaceLabel: "Fast Grass",
    defaultSky: "golden",
    physics: {
      rest: 0.54,
      grip: 2.15,
      mu: 0.44,
      vyCap: 5.9,
      speedScale: 1.08,
      dustColor: [0.68, 0.86, 0.50],
      bouncePitch: 0.74,
      label: "Low-Skid Grass",
    },
    deckHalfX: 13.4,
    deckZMin: -6.2,
    deckZMax: 30.4,
    waterY: -1.5,
    inPlayColor: [52, 136, 62],
    outPlayColor: [38, 102, 48],
    umbrellaColors: [[0.14, 0.56, 0.32], [0.92, 0.78, 0.26]],
  },
};

export const VENUE_ORDER: VenueId[] = ["pier", "cove", "terrace"];

// =========================================================================
// 4 LIGHTING PRESETS (Noon, Golden Hour, Twilight, Night Floodlights)
// =========================================================================
export const PRESETS: Record<SkyId, SkyPreset> = {
  golden: {
    id: "golden",
    label: "Golden Hour",
    sunDir: [-0.25, 0.145, 0.957],
    sunCol: [2.25, 0.78, 0.24],
    zenith: [0.025, 0.10, 0.34],
    horizon: [0.92, 0.28, 0.08],
    sky: [0.28, 0.19, 0.22],
    ground: [0.12, 0.06, 0.03],
    fogNear: 72,
    fogFar: 215,
    cloud: 0.56,
    pointCount: 4,
    pointCol: [[0.95, 0.42, 0.12], [0.95, 0.42, 0.12], [0.95, 0.42, 0.12], [0.95, 0.42, 0.12]],
    pointDist: 11.5,
    lanternGlow: 1.6,
    floodGlow: 0.15,
    floodIntensity: 0,
    exposure: 1.05,
    presetExposure: 1.0,
    bloom: { threshold: 0.68, strength: 0.58, spread: 1.50 },
    flare: 0.52,
    vignette: 0.34,
  },
  noon: {
    id: "noon",
    label: "Resort Noon",
    sunDir: [-0.28, 0.87, 0.40],
    sunCol: [1.55, 1.46, 1.30],
    zenith: [0.03, 0.26, 0.78],
    horizon: [0.34, 0.66, 0.88],
    sky: [0.22, 0.34, 0.44],
    ground: [0.12, 0.11, 0.09],
    fogNear: 82,
    fogFar: 245,
    cloud: 0.34,
    pointCount: 0,
    pointCol: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]],
    pointDist: 11.5,
    lanternGlow: 0.12,
    floodGlow: 0.05,
    floodIntensity: 0,
    exposure: 1.02,
    presetExposure: 0.84,
    bloom: { threshold: 0.88, strength: 0.24, spread: 1.15 },
    flare: 0.16,
    vignette: 0.24,
  },
  twilight: {
    id: "twilight",
    label: "Twilight",
    sunDir: [-0.36, 0.095, 0.928],
    sunCol: [0.75, 0.20, 0.22],
    zenith: [0.008, 0.016, 0.072],
    horizon: [0.22, 0.055, 0.14],
    sky: [0.05, 0.065, 0.14],
    ground: [0.025, 0.022, 0.04],
    fogNear: 62,
    fogFar: 185,
    cloud: 0.46,
    pointCount: 4,
    pointCol: [[2.95, 1.30, 0.40], [2.95, 1.30, 0.40], [2.95, 1.30, 0.40], [2.95, 1.30, 0.40]],
    pointDist: 18.5,
    lanternGlow: 3.6,
    floodGlow: 0.85,
    floodIntensity: 0.55,
    exposure: 1.18,
    presetExposure: 0.74,
    bloom: { threshold: 0.64, strength: 0.78, spread: 1.75 },
    flare: 0.16,
    vignette: 0.44,
  },
  night: {
    id: "night",
    label: "Night Floodlights",
    sunDir: [0.15, 0.72, 0.68],
    sunCol: [0.34, 0.44, 0.66],
    zenith: [0.004, 0.009, 0.032],
    horizon: [0.022, 0.046, 0.095],
    sky: [0.06, 0.09, 0.16],
    ground: [0.03, 0.04, 0.06],
    fogNear: 58,
    fogFar: 175,
    cloud: 0.24,
    pointCount: 4,
    pointCol: [[1.9, 1.05, 0.46], [1.9, 1.05, 0.46], [1.9, 1.05, 0.46], [1.9, 1.05, 0.46]],
    pointDist: 16.0,
    lanternGlow: 2.8,
    floodGlow: 4.2,
    floodIntensity: 1.05,
    exposure: 1.02,
    presetExposure: 0.84,
    bloom: { threshold: 1.15, strength: 0.36, spread: 1.20 },
    flare: 0.03,
    vignette: 0.38,
  },
};

export const SKY_CYCLE: Array<"auto" | SkyId> = ["auto", "golden", "noon", "twilight", "night"];

// =========================================================================
// DEFAULT AVATARS, UNLOCKABLES & 6+1 RIVAL ROSTER
// =========================================================================
export const DEFAULT_AVATAR: AvatarConfig = {
  skin: [0.76, 0.45, 0.26],
  hairColor: [0.12, 0.06, 0.03],
  shirt: [0.96, 0.26, 0.15],
  stripe: [0.98, 0.96, 0.90],
  shorts: [0.07, 0.12, 0.18],
  shoe: [0.96, 0.94, 0.88],
  band: [0.98, 0.96, 0.90],
  accent: [0.16, 0.72, 0.66],
  hair: "Hair_Classic",
  hat: "none",
  num: 7,
  handedness: "right",
  racket: "coral",
  trail: "default",
};

export const BUDDY_AVATAR: AvatarConfig = {
  skin: [0.62, 0.38, 0.22],
  hairColor: [0.30, 0.16, 0.06],
  shirt: [0.10, 0.40, 0.86],
  stripe: [0.98, 0.84, 0.22],
  shorts: [0.94, 0.92, 0.86],
  shoe: [0.12, 0.14, 0.18],
  band: [0.98, 0.84, 0.22],
  accent: [0.98, 0.84, 0.22],
  hair: "Hair_Classic",
  hat: "Hat_Visor",
  num: 11,
  handedness: "right",
  racket: "classic",
  trail: "lagoon",
};

export const UMPIRE_AVATAR: AvatarConfig = {
  skin: [0.72, 0.48, 0.30],
  hairColor: [0.22, 0.18, 0.14],
  shirt: [0.08, 0.16, 0.26],
  stripe: [0.96, 0.82, 0.32],
  shorts: [0.88, 0.84, 0.74],
  shoe: [0.14, 0.12, 0.10],
  band: [0.96, 0.82, 0.32],
  accent: [0.08, 0.16, 0.26],
  hair: "Hair_Classic",
  hat: "Hat_Cap",
  num: 0,
  handedness: "right",
  racket: "classic",
  trail: "default",
};

export const BALLKID_AVATAR: AvatarConfig = {
  skin: [0.80, 0.56, 0.36],
  hairColor: [0.15, 0.10, 0.06],
  shirt: [0.14, 0.62, 0.58],
  stripe: [0.98, 0.94, 0.84],
  shorts: [0.10, 0.16, 0.22],
  shoe: [0.96, 0.94, 0.90],
  band: [0.98, 0.82, 0.24],
  accent: [0.14, 0.62, 0.58],
  hair: "Hair_Bob",
  hat: "Hat_Visor",
  num: 0,
  handedness: "right",
  racket: "classic",
  trail: "default",
};

export const CAST: Record<string, RivalDef> = {
  sunny: {
    id: "sunny", name: "Sunny", tierLabel: "Rookie", tier: 0, venue: "pier", sky: "noon",
    desc: "Forgiving noon rallies & easy short balls.",
    speed: 3.20, reach: 1.18, react: 0.44, err: 0.14, t: [1.18, 1.48], rush: 0.0, rushZ: 99, telegraph: 0.36,
    top: 140, short: 0.22, sliceRate: 0.10, lobRate: 0.10, dropRate: 0.0,
    avatar: {
      skin: [0.88, 0.62, 0.38], hairColor: [0.92, 0.78, 0.32], shirt: [0.22, 0.74, 0.96], stripe: [0.98, 0.96, 0.90],
      shorts: [0.95, 0.93, 0.86], shoe: [0.98, 0.34, 0.22], band: [0.98, 0.80, 0.20], accent: [0.98, 0.96, 0.90],
      hair: "Hair_Ponytail", hat: "Hat_Visor", num: 1, handedness: "right", racket: "classic", trail: "default",
    },
  },
  koa: {
    id: "koa", name: "Koa", tierLabel: "Club", tier: 1, venue: "cove", sky: "noon",
    desc: "Clay grinder. Heavy topspin & baseline grit.",
    speed: 3.75, reach: 1.08, react: 0.34, err: 0.095, t: [1.02, 1.30], rush: 0.06, rushZ: NET + 6.5, telegraph: 0.24,
    top: 260, short: 0.12, sliceRate: 0.18, lobRate: 0.26, dropRate: 0.12,
    avatar: {
      skin: [0.64, 0.36, 0.20], hairColor: [0.06, 0.05, 0.04], shirt: [0.92, 0.38, 0.22], stripe: [0.98, 0.88, 0.68],
      shorts: [0.24, 0.16, 0.12], shoe: [0.96, 0.92, 0.82], band: [0.22, 0.76, 0.64], accent: [0.92, 0.38, 0.22],
      hair: "Hair_Curly", hat: "none", num: 3, handedness: "right", racket: "coral", trail: "sunset",
    },
  },
  reef: {
    id: "reef", name: "Reef", tierLabel: "Pro", tier: 2, venue: "pier", sky: "golden",
    desc: "Sharp cross-court angles & skidding slices.",
    speed: 4.25, reach: 1.00, react: 0.25, err: 0.06, t: [0.88, 1.14], rush: 0.16, rushZ: NET + 7.2, telegraph: 0.14,
    top: 225, short: 0.08, sliceRate: 0.38, lobRate: 0.35, dropRate: 0.12,
    avatar: {
      skin: [0.34, 0.16, 0.08], hairColor: [0.05, 0.05, 0.06], shirt: [0.98, 0.72, 0.14], stripe: [0.05, 0.28, 0.30],
      shorts: [0.05, 0.24, 0.26], shoe: [0.08, 0.09, 0.11], band: [0.96, 0.28, 0.16], accent: [0.08, 0.42, 0.44],
      hair: "Hair_Classic", hat: "Hat_Visor", num: 4, handedness: "right", racket: "coral", trail: "lagoon",
    },
  },
  pippa: {
    id: "pippa", name: "Pippa", tierLabel: "Ace", tier: 3, venue: "terrace", sky: "golden",
    desc: "Grass trickster. Crafty lobs & drop shots.",
    speed: 4.55, reach: 0.96, react: 0.21, err: 0.05, t: [0.82, 1.06], rush: 0.42, rushZ: NET + 7.6, telegraph: 0.12,
    top: 190, short: 0.16, sliceRate: 0.32, lobRate: 0.38, dropRate: 0.30,
    avatar: {
      skin: [0.90, 0.68, 0.52], hairColor: [0.58, 0.20, 0.10], shirt: [0.14, 0.62, 0.36], stripe: [0.98, 0.96, 0.90],
      shorts: [0.96, 0.95, 0.90], shoe: [0.14, 0.58, 0.34], band: [0.98, 0.78, 0.24], accent: [0.14, 0.62, 0.36],
      hair: "Hair_Bob", hat: "Hat_Visor", num: 5, handedness: "right", racket: "classic", trail: "lagoon",
    },
  },
  mako: {
    id: "mako", name: "Mako", tierLabel: "Champ", tier: 4, venue: "pier", sky: "twilight",
    desc: "Net-rusher with fierce volleys. Lob him!",
    speed: 4.80, reach: 0.92, react: 0.17, err: 0.038, t: [0.72, 0.94], rush: 0.88, rushZ: NET + 7.6, telegraph: 0.08,
    top: 305, short: 0.04, sliceRate: 0.14, lobRate: 0.28, dropRate: 0.10,
    avatar: {
      skin: [0.58, 0.32, 0.18], hairColor: [0.04, 0.06, 0.09], shirt: [0.06, 0.10, 0.16], stripe: [0.16, 0.74, 0.68],
      shorts: [0.96, 0.28, 0.16], shoe: [0.98, 0.78, 0.18], band: [0.95, 0.96, 0.98], accent: [0.16, 0.74, 0.68],
      hair: "Hair_Mohawk", hat: "none", num: 8, handedness: "right", racket: "carbon", trail: "plasma",
    },
  },
  vesper: {
    id: "vesper", name: "Vesper", tierLabel: "Master", tier: 5, venue: "cove", sky: "night",
    desc: "Lefty night specialist. Brutal kicking drives.",
    speed: 5.05, reach: 0.94, react: 0.15, err: 0.03, t: [0.68, 0.88], rush: 0.45, rushZ: NET + 7.0, telegraph: 0.06,
    top: 335, short: 0.03, sliceRate: 0.26, lobRate: 0.30, dropRate: 0.18,
    avatar: {
      skin: [0.46, 0.26, 0.18], hairColor: [0.14, 0.08, 0.22], shirt: [0.36, 0.14, 0.56], stripe: [0.98, 0.42, 0.62],
      shorts: [0.08, 0.08, 0.14], shoe: [0.98, 0.42, 0.62], band: [0.98, 0.42, 0.62], accent: [0.36, 0.14, 0.56],
      hair: "Hair_Ponytail", hat: "Hat_Cap", num: 9, handedness: "left", racket: "flame", trail: "sunset",
    },
  },
  sol: {
    id: "sol", name: "Captain Sol", tierLabel: "Legend", tier: 6, venue: "pier", sky: "night",
    desc: "Secret Lagoon Legend. All-court mastery, blazing pace & signature golden arc.",
    secret: true,
    speed: 5.30, reach: 0.96, react: 0.13, err: 0.022, t: [0.64, 0.82], rush: 0.62, rushZ: NET + 7.8, telegraph: 0.05,
    top: 350, short: 0.02, sliceRate: 0.28, lobRate: 0.34, dropRate: 0.22,
    avatar: {
      skin: [0.70, 0.44, 0.25], hairColor: [0.90, 0.90, 0.92], shirt: [0.98, 0.96, 0.90], stripe: [0.98, 0.78, 0.18],
      shorts: [0.06, 0.14, 0.28], shoe: [0.98, 0.78, 0.18], band: [0.98, 0.78, 0.18], accent: [0.98, 0.78, 0.18],
      hair: "Hair_Classic", hat: "Hat_Captain", num: 99, handedness: "right", racket: "gold", trail: "gold",
    },
  },
};

export const CORE_RIVAL_IDS = ["sunny", "koa", "reef", "pippa", "mako", "vesper"];
export const ALL_RIVAL_IDS = [...CORE_RIVAL_IDS, "sol"];

export const RACKET_CATALOG: Array<{ id: RacketId; name: string; desc: string; unlockHint: string }> = [
  { id: "classic", name: "Lagoon Classic", desc: "Balanced resort teak & cream frame", unlockHint: "Starter" },
  { id: "coral",   name: "Coral Pro",      desc: "Sleek coral-teal tournament frame", unlockHint: "Starter" },
  { id: "carbon",  name: "Aero Carbon",    desc: "Graphite stealth frame with cyan vents", unlockHint: "Reach Skill 400 or earn a Training Medal" },
  { id: "gold",    name: "Sol Champion",   desc: "Brushed championship gold & pearl", unlockHint: "Win the Lagoon Cup or reach PRO (1000 Skill)" },
  { id: "flame",   name: "Volcanic Legend",desc: "Obsidian blade with glowing magma core", unlockHint: "Defeat Captain Sol or reach 5-win Endless streak" },
];

export const TRAIL_CATALOG: Array<{ id: TrailSkinId; name: string; c0: RGB; c1: RGB; unlockHint: string }> = [
  { id: "default", name: "Solar Flare",    c0: [1.0, 0.92, 0.30], c1: [1.0, 0.50, 0.12], unlockHint: "Starter" },
  { id: "lagoon",  name: "Lagoon Surge",   c0: [0.55, 1.0, 0.94], c1: [0.12, 0.62, 0.98], unlockHint: "Starter" },
  { id: "sunset",  name: "Coral Sunset",   c0: [1.0, 0.74, 0.45], c1: [0.96, 0.20, 0.48], unlockHint: "Win 3 matches" },
  { id: "gold",    name: "Gilded Arc",     c0: [1.0, 0.98, 0.68], c1: [0.96, 0.70, 0.10], unlockHint: "Win the Lagoon Cup" },
  { id: "plasma",  name: "Twilight Pulse", c0: [0.84, 0.64, 1.0], c1: [0.22, 0.92, 1.0],  unlockHint: "Earn any Gold Training Medal" },
];

export const CUSTOMIZER_PALETTES = {
  skins: [
    [0.92, 0.70, 0.54], [0.84, 0.58, 0.38], [0.76, 0.45, 0.26],
    [0.58, 0.34, 0.18], [0.42, 0.22, 0.12], [0.28, 0.14, 0.08],
  ] as RGB[],
  hairs: [
    [0.05, 0.05, 0.06], [0.18, 0.10, 0.05], [0.48, 0.26, 0.10],
    [0.88, 0.74, 0.30], [0.68, 0.20, 0.10], [0.90, 0.90, 0.92], [0.16, 0.74, 0.76],
  ] as RGB[],
  clothes: [
    [0.96, 0.26, 0.15], [0.12, 0.52, 0.92], [0.14, 0.68, 0.54], [0.98, 0.76, 0.16],
    [0.42, 0.18, 0.68], [0.96, 0.94, 0.88], [0.08, 0.12, 0.18], [0.94, 0.34, 0.56],
  ] as RGB[],
};

export const DEFAULT_SETTINGS: SettingsState = {
  masterVol: 0.85,
  musicVol: 0.55,
  sfxVol: 0.9,
  voiceVol: 0.85,
  muted: false,
  rallyMusic: false,
  umpireVoice: true,
  hoverFlick: false, // Disabled by default so LMB click/charge never conflicts with cursor movement!
  aiPartner: false,  // Classic Wii Sports Dual-Control is default for Doubles
  wiiSensitivity: 1.0,
  wiiMotionPlus: true,
  qualityIdx: 0,     // Ultra default — engine-wide draw-call batching & fused HDR pipeline run smoothly at full fidelity!
  skyOverride: "auto",
};

export const QUALITY_TIERS = [
  { name: "Ultra",    dprCap: 2.0,  shadow: 2048, bloom: true, ao: true,  msaa: 4, mirror: 512 },
  { name: "Balanced", dprCap: 1.5,  shadow: 2048, bloom: true, ao: false, msaa: 2, mirror: 384 },
  { name: "Fast",     dprCap: 1.15, shadow: 1024, bloom: true, ao: false, msaa: 0, mirror: 0 },
];

export const LANTERN_XZ: Array<[number, number]> = [
  [-8.6, -1.5], [8.6, -1.5], [-8.6, 25.2], [8.6, 25.2],
];

export const FLOODLIGHT_XZ: Array<[number, number, number]> = [
  [-11.8, -4.6, Math.PI * 0.22],
  [11.8, -4.6, -Math.PI * 0.22],
  [-11.8, 28.4, Math.PI * 0.78],
  [11.8, 28.4, -Math.PI * 0.78],
];
