export type RGB = [number, number, number];

export type VenueId = "pier" | "cove" | "terrace";
export type SkyId = "noon" | "golden" | "twilight" | "night";
export type SkySelection = "auto" | SkyId;
export type MatchFormat = "1game" | "3games" | "6games";
export type MatchDiscipline = "singles" | "doubles";
export type GameMode = "match" | "tournament" | "endless" | "training" | "net";
export type TrainingDrill = "rings" | "rally" | "serve";
export type ShotIntent = "drive" | "slice" | "lob" | "drop";
export type ShotTag = "drive" | "slice" | "lob" | "drop" | "smash" | "volley";
export type SwingAnimType = "fh" | "bh" | "slice" | "drop" | "lob" | "smash" | "serve" | "dive";
export type Handedness = "right" | "left";

export type RacketId = "classic" | "coral" | "carbon" | "gold" | "flame";
export type HairId = "Hair_Classic" | "Hair_Ponytail" | "Hair_Mohawk" | "Hair_Curly" | "Hair_Bob";
export type HatId = "none" | "Hat_Visor" | "Hat_Cap" | "Hat_Captain";
export type TrailSkinId = "default" | "lagoon" | "sunset" | "gold" | "plasma";

export type GamePhase =
  | "title"
  | "serveReady"
  | "toss"
  | "cpuServe"
  | "rally"
  | "between"
  | "pointOver"
  | "matchOver"
  | "training"
  | "trainOver"
  | "customizer";

export interface AvatarConfig {
  skin: RGB;
  hairColor: RGB;
  shirt: RGB;
  stripe: RGB;
  shorts: RGB;
  shoe: RGB;
  band: RGB;
  accent: RGB;
  hair: HairId;
  hat: HatId;
  num: number;
  handedness: Handedness;
  racket: RacketId;
  trail: TrailSkinId;
}

export interface SurfacePhysics {
  rest: number;
  grip: number;
  mu: number;
  vyCap: number;
  speedScale: number;
  dustColor: RGB;
  bouncePitch: number;
  label: string;
}

export interface VenueDef {
  id: VenueId;
  name: string;
  surfaceLabel: string;
  defaultSky: SkyId;
  physics: SurfacePhysics;
  deckHalfX: number;
  deckZMin: number;
  deckZMax: number;
  waterY: number;
  inPlayColor: RGB;
  outPlayColor: RGB;
  umbrellaColors: [RGB, RGB];
}

export interface SkyPreset {
  id: SkyId;
  label: string;
  sunDir: RGB;
  sunCol: RGB;
  zenith: RGB;
  horizon: RGB;
  sky: RGB;
  ground: RGB;
  fogNear: number;
  fogFar: number;
  cloud: number;
  pointCount: number;
  pointCol: RGB[];
  pointDist: number;
  lanternGlow: number;
  floodGlow: number;
  floodIntensity: number;
  exposure: number;
  presetExposure: number;
  bloom: { threshold: number; strength: number; spread: number };
  flare: number;
  vignette: number;
}

export interface RivalDef {
  id: string;
  name: string;
  tierLabel: string;
  tier: number;
  venue: VenueId;
  sky: SkyId;
  desc: string;
  secret?: boolean;
  speed: number;
  reach: number;
  react: number;
  err: number;
  t: [number, number];
  rush: number;
  rushZ: number;
  telegraph: number;
  top: number;
  short: number;
  sliceRate: number;
  lobRate: number;
  dropRate: number;
  avatar: AvatarConfig;
}

export interface ShotSpec {
  mphSweet?: number;
  mphCross?: number;
  mphLine?: number;
  T?: number;
  top: number;
  side: number;
  clear: number;
  depthEarly: number;
  depthSweet: number;
  depthLate: number;
}

export interface BallSpin {
  x: number;
  y: number;
  z: number;
}

export interface BallState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  w: BallSpin;
  rotX: number;
  rotY: number;
  rotZ: number;
  visible: boolean;
  live: boolean;
  serve: boolean;
  netted: boolean;
  touched: "cord" | "mesh" | null;
  lastHitter: number; // 0 = near team, 1 = far team, -1 = none
  lastSlot: number;   // 0..3 player slot index
  bounceCount: number;
  mph: number;
  rocket: boolean;
  crit: boolean;
  shotTag: ShotTag;
  splashed: boolean;
}

export interface PredictionResult {
  x: number;
  z: number;
  bx: number;
  bz: number;
  volley?: boolean;
}

export interface PlayerState {
  slot: number;       // 0=you-main, 1=cpu-main, 2=you-partner, 3=cpu-partner
  team: 0 | 1;
  role: "baseline" | "net";
  x: number;
  z: number;
  tx: number;
  tz: number;
  vx: number;
  vz: number;
  prevVx: number;
  prevVz: number;
  homeX: number;
  homeZ: number;
  run: number;
  speed: number;
  swingT: number;
  swingDur: number;
  swingType: SwingAnimType;
  splitT: number;
  tossArm: number;
  lungeT: number;
  lungeDir: number;
  diveT: number;
  diveDir: number;
  telegraphT: number;
  telegraphShot: ShotTag | null;
  emoteT: number;
  emote: "win" | "lose";
  tailAng: number;
  react: number;
  recover: number;
  fatigue: number;
  pending: PredictionResult | null;
  aimTarget: { x: number; z: number } | null;
  squeakCd: number;
  swingTrail: Array<[number, number, number, number, number, number]>;
  handedness: Handedness;
  netX?: number;
  netZ?: number;
}

export interface SettingsState {
  masterVol: number;
  musicVol: number;
  sfxVol: number;
  voiceVol: number;
  muted: boolean;
  rallyMusic: boolean;
  umpireVoice: boolean;
  hoverFlick: boolean;
  aiPartner: boolean;
  wiiSensitivity: number;
  wiiMotionPlus: boolean;
  qualityIdx: number;
  skyOverride: SkySelection;
}

export interface MatchStats {
  aces: number;
  winners: number;
  fastestServe: number;
  longestRally: number;
}

export interface CareerState {
  skill: number;
  wins: number;
  losses: number;
  streak: number;
  bestStreak: number;
  aces: number;
  fastestServe: number;
  longestRally: number;
  trainingBest: Record<TrainingDrill, number>;
  trainingMedals: Record<TrainingDrill, "none" | "bronze" | "silver" | "gold">;
  crowns: Record<string, boolean>;
  cupsWon: number;
  endlessBest: number;
  unlockedRackets: RacketId[];
  unlockedTrails: TrailSkinId[];
  unlockedHats: HatId[];
  bossUnlocked: boolean;
  title: string;
  avatar: AvatarConfig;
}

export interface BounceMark {
  x: number;
  z: number;
  out: boolean;
  age: number;
}

export interface TrainingRing {
  active: boolean;
  gold: boolean;
  baseX: number;
  x: number;
  y: number;
  z: number;
  r: number;
  seed: number;
  moving: boolean;
}

export interface TrainingState {
  drill: TrainingDrill;
  score: number;
  combo: number;
  comboT: number;
  time: number;
  feedT: number;
  rings: TrainingRing[];
  spawned: number;
  rallyStreak: number;
  lives: number;
  serveTarget: { x: number; z: number; r: number; isServe: boolean } | null;
  servePhase: "serve" | "return";
}

export interface TournamentMatch {
  round: number; // 0=QF, 1=SF, 2=Final
  p1: string;
  p2: string;
  winner: string | null;
  score: string;
}

export interface TournamentState {
  active: boolean;
  discipline: MatchDiscipline;
  format: MatchFormat;
  venue: VenueId;
  round: number;
  opponents: string[];
  partnerId: string;
  rounds: TournamentMatch[][];
}

export interface EndlessState {
  active: boolean;
  wins: number;
  paceMult: number;
  discipline: MatchDiscipline;
  currentOpp: string;
}

export interface ReplayPlayerSnap {
  slot: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
  swingT: number;
  swingDur: number;
  swingType: SwingAnimType;
  diveT: number;
  diveDir: number;
  lungeT: number;
  lungeDir: number;
  tossArm: number;
  emoteT: number;
  emote: "win" | "lose";
}

export interface ReplayFrame {
  t: number;
  bx: number;
  by: number;
  bz: number;
  bvis: boolean;
  brocket: boolean;
  bcrit: boolean;
  btag: ShotTag;
  brotX: number;
  brotY: number;
  brotZ: number;
  players: ReplayPlayerSnap[];
}

export interface HawkEyeState {
  active: boolean;
  timer: number;
  duration: number;
  x: number;
  z: number;
  isIn: boolean;
  distCm: number;
  lineLabel: string;
}

export interface MatchConfig {
  discipline: MatchDiscipline;
  format: MatchFormat;
  venue: VenueId;
  sky: SkySelection;
  oppId: string;
  oppPartnerId: string;
  partnerId: string;
}

export interface GameState {
  mode: GameMode;
  phase: GamePhase;
  paused: boolean;
  config: MatchConfig;
  pts: [number, number];
  games: [number, number];
  tiebreak: boolean;
  tbPts: [number, number];
  server: 0 | 1;
  serverSlot: number;
  faults: number;
  timer: number;
  tossT: number;
  tossed: boolean;
  lastSwing: number;
  now: number;
  winner: -1 | 0 | 1;
  rally: number;
  strokes: number;
  hitstop: number;
  slowMo: number;
  lobArmed: boolean;
  lastSkillDelta: number;
  newUnlocks: string[];
  stats: MatchStats;
}

export type NetMode = "online" | "lan";
export type PlayerSlot = 0 | 1 | 2 | 3;
export type SeatKind = "human" | "bot" | "dual";
export type SpectatorCamMode = "umpire" | "broadcast" | "courtside" | "follow" | "orbit";

export interface RoomPeerInfo {
  id: string;
  name: string;
  avatar: AvatarConfig;
  slot: PlayerSlot | null; // null => spectator
  isHost: boolean;
  pingMs: number | null;
}

export interface SeatAssignment {
  kind: SeatKind;
  peerId: string | null;
  botRivalId: string;
}

export interface NetLobbyConfig {
  discipline: MatchDiscipline;
  format: MatchFormat;
  venue: VenueId;
  sky: SkyId;
  soloDoublesMode: "bot" | "dual";
}
