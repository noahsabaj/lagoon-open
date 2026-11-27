import {
  BUDDY_AVATAR,
  CAST,
  clamp,
  emptyMatchStats,
  G,
  L,
  lerp,
  makeSeededRng,
  NET,
  PRESETS,
  rand,
  SHOT,
  SVC,
  TOSS_VY,
  VENUES,
  WIN,
} from "../core/constants";
import type {
  AvatarConfig,
  BallState,
  BounceMark,
  CareerState,
  EndlessState,
  GameMode,
  GameState,
  MatchConfig,
  PlayerSlot,
  PlayerState,
  RGB,
  SeatKind,
  SettingsState,
  ShotIntent,
  ShotTag,
  SkyPreset,
  TournamentState,
  TrainingDrill,
  TrainingState,
} from "../core/types";
import type { SoundEngine } from "../audio/soundEngine";
import type { TropicalMusicEngine } from "../audio/music";
import type { UmpireVoice } from "../audio/umpireVoice";
import type { InputController } from "../input/controls";
import { type NetHitState, physStep } from "../physics/ballPhysics";
import { launchBall, predictBall } from "../physics/solver";
import type { GameRenderer } from "../render/renderer";
import { chooseAIShot, getPartnerRival, previewAITelegraph } from "./ai";
import { computeSkillDelta, evaluateUnlocks, saveCareer, upgradeMedal } from "./career";
import { ReplaySystem } from "./replay";
import {
  applyPointToScore,
  checkLineProximity,
  courtHalfWidth,
  isDeuceSide,
  isInCourt,
  pointBannerText,
  serveBoxSign,
} from "./rules";
import { advanceEndless, createEndless, createTournament, recordTournamentResult, tournamentRoundName, tournamentVenueForRound } from "./tournament";
import { checkTrainingRingHit, createTrainingState, feedTrainingBall, spawnServeZone } from "./training";

interface EngineUiHooks {
  showMsg: (big: string, small: string, ms: number) => void;
  feedback: (label: string, detail?: string, isCrit?: boolean) => void;
  updateHud: () => void;
  updateTrainHud: () => void;
  updateTelemetry: (mph?: number, isRocket?: boolean) => void;
  updateServeMeter: (visible: boolean, pct: number) => void;
  setHint: () => void;
  showEnd: () => void;
  showTrainEnd: () => void;
  showTournamentBracket: (champion?: boolean) => void;
  showEndlessResult: () => void;
  updateReplayBanner: (visible: boolean, label?: string) => void;
  updateHawkEyeBanner: (visible: boolean, isIn?: boolean, distCm?: number, lineLabel?: string) => void;
  onNetEvent?: (e: { k: string; a: unknown[]; slot?: PlayerSlot; seq?: number }) => void;
  isNetRemoteClient?: () => boolean;
  isNetSpectator?: () => boolean;
  onNetGuestSwing?: (power: number, intent: ShotIntent) => void;
  getNetTeamNames?: () => [string, string];
  getNetSlotAvatars?: () => AvatarConfig[];
  getNetSeatKinds?: () => [SeatKind, SeatKind, SeatKind, SeatKind];
  getNetBotRivalId?: (slot: PlayerSlot) => string;
  setNetAimNext?: (who: "team0" | "team1") => void;
}

export function mkPlayer(slot: number, team: 0 | 1, role: "baseline" | "net", x: number, z: number, speed: number): PlayerState {
  return {
    slot,
    team,
    role,
    x,
    z,
    tx: x,
    tz: z,
    vx: 0,
    vz: 0,
    prevVx: 0,
    prevVz: 0,
    homeX: x,
    homeZ: z,
    run: 0,
    speed,
    swingT: 0,
    swingDur: 0.36,
    swingType: "fh",
    splitT: 0,
    tossArm: 0,
    lungeT: 0,
    lungeDir: 1,
    diveT: 0,
    diveDir: 1,
    telegraphT: 0,
    telegraphShot: null,
    emoteT: 0,
    emote: "win",
    tailAng: 0,
    react: 0,
    recover: 0,
    fatigue: 0,
    pending: null,
    aimTarget: null,
    squeakCd: 0,
    swingTrail: [],
    handedness: "right",
  };
}

export class GameEngine {
  public game: GameState;
  public ball: BallState;
  public players: PlayerState[];
  public crowd = { cheer: 0, hop: 0 };
  public netHit: NetHitState = { x: 0, y: 0.8, amp: 0, elapsed: 0 };
  public marks: BounceMark[] = [];
  public trail: Array<{ x: number; y: number; z: number }> = [];
  public nudge = { x: 0, z: 0 };
  public training: TrainingState = createTrainingState("rings");
  public tournament: TournamentState | null = null;
  public endless: EndlessState | null = null;
  public replay = new ReplaySystem();

  public netCtx: "local" | "remote" = "local";
  public netActorSlot: PlayerSlot = 0;
  public netActorSeq: number | undefined = undefined;
  public netPredictMode = false;
  public lastMph = 0;
  public trophyCeremony = false;
  private pendingReplayLabel: string | null = null;
  private lastPointSnapshot = { isBig: false, label: "" };
  private _slotAvatars: AvatarConfig[] = [];
  private _visibleSlots: boolean[] = [true, true, false, false];
  private _rng: (a: number, b: number) => number = rand;

  constructor(
    public career: CareerState,
    public settings: SettingsState,
    public renderer: GameRenderer,
    public sfx: SoundEngine,
    public music: TropicalMusicEngine,
    public umpire: UmpireVoice,
    public input: InputController,
    public ui: EngineUiHooks
  ) {
    this.game = {
      mode: "match",
      phase: "title",
      paused: false,
      config: {
        discipline: "singles",
        format: "3games",
        venue: "pier",
        sky: "auto",
        oppId: "reef",
        oppPartnerId: "pippa",
        partnerId: "sunny",
      },
      pts: [0, 0],
      games: [0, 0],
      tiebreak: false,
      tbPts: [0, 0],
      server: 0,
      serverSlot: 0,
      faults: 0,
      timer: 0,
      tossT: 0,
      tossed: false,
      lastSwing: -9,
      now: 0,
      winner: -1,
      rally: 0,
      strokes: 0,
      hitstop: 0,
      slowMo: 0,
      lobArmed: false,
      lastSkillDelta: 0,
      newUnlocks: [],
      stats: emptyMatchStats(),
    };

    this.ball = {
      x: 0, y: -5, z: 0, vx: 0, vy: 0, vz: 0,
      w: { x: 0, y: 0, z: 0 },
      rotX: 0, rotY: 0, rotZ: 0,
      visible: false, live: false, serve: false, netted: false, touched: null,
      lastHitter: -1, lastSlot: -1, bounceCount: 0,
      mph: 0, rocket: false, crit: false, shotTag: "drive", splashed: false,
    };

    this.players = [
      mkPlayer(0, 0, "baseline", 0.7, -0.4, 5.9),
      mkPlayer(1, 1, "baseline", -2.0, L + 0.8, 4.25),
      mkPlayer(2, 0, "net", -2.2, NET - 3.6, 5.6),
      mkPlayer(3, 1, "net", 2.2, NET + 3.6, 4.35),
    ];
  }

  public get you(): PlayerState { return this.players[0]; }
  public get cpu(): PlayerState { return this.players[1]; }
  public get partner(): PlayerState { return this.players[2]; }
  public get cpuPartner(): PlayerState { return this.players[3]; }

  public getActiveVenue() {
    return VENUES[this.game.config.venue] || VENUES.pier;
  }

  public getActiveSkyPreset(): SkyPreset {
    if (this.settings.skyOverride !== "auto") return PRESETS[this.settings.skyOverride];
    if (this.game.config.sky !== "auto") return PRESETS[this.game.config.sky];
    const rival = CAST[this.game.config.oppId];
    return PRESETS[rival?.sky || this.getActiveVenue().defaultSky] || PRESETS.golden;
  }

  public getTeamNames(): [string, string] {
    if (this.game.mode === "net" && this.ui.getNetTeamNames) {
      return this.ui.getNetTeamNames();
    }
    const o = CAST[this.game.config.oppId] || CAST.reef;
    if (this.game.config.discipline === "doubles") {
      const op = CAST[this.game.config.oppPartnerId] || getPartnerRival(o.id);
      return ["You + Partner", `${o.name} & ${op.name}`];
    }
    return ["You", o.name];
  }

  public getOppName(): string {
    return this.getTeamNames()[1];
  }

  public getSlotAvatars(): AvatarConfig[] {
    if (this.game.mode === "net" && this.ui.getNetSlotAvatars) {
      const avs = this.ui.getNetSlotAvatars();
      for (let i = 0; i < 4; i++) this._slotAvatars[i] = avs[i] || BUDDY_AVATAR;
      this._slotAvatars.length = 4;
      return this._slotAvatars;
    }
    const opp = CAST[this.game.config.oppId] || CAST.reef;
    const oppP = CAST[this.game.config.oppPartnerId] || getPartnerRival(opp.id);
    const youP = CAST[this.game.config.partnerId] || CAST.sunny;

    this._slotAvatars[0] = this.career.avatar;
    this._slotAvatars[1] = opp.avatar;
    this._slotAvatars[2] = youP.avatar;
    this._slotAvatars[3] = oppP.avatar;
    this._slotAvatars.length = 4;
    return this._slotAvatars;
  }

  public isNetBotSlot(slot: PlayerSlot): boolean {
    if (this.game.mode !== "net") return false;
    const kinds = this.ui.getNetSeatKinds?.();
    return !!kinds && kinds[slot] === "bot";
  }

  public isTeamDualControl(team: 0 | 1): boolean {
    if (this.game.config.discipline !== "doubles" || this.game.mode === "training") return false;
    if (this.game.mode !== "net") return !this.settings.aiPartner && team === 0;
    const kinds = this.ui.getNetSeatKinds?.();
    if (!kinds) return true;
    return team === 0 ? kinds[2] === "dual" : kinds[3] === "dual";
  }

  public getVisibleSlots(): boolean[] {
    const v = this._visibleSlots;
    if (this.game.phase === "customizer") {
      v[0] = true; v[1] = false; v[2] = false; v[3] = false;
      return v;
    }
    if (this.game.mode === "training") {
      v[0] = true; v[1] = this.training.drill === "rally"; v[2] = false; v[3] = false;
      return v;
    }
    const isDbl = this.game.config.discipline === "doubles";
    v[0] = true; v[1] = true; v[2] = isDbl; v[3] = isDbl;
    return v;
  }

  public placePlayer(p: PlayerState, x: number, z: number): void {
    p.x = p.tx = p.homeX = x;
    p.z = p.tz = p.homeZ = z;
    p.vx = p.vz = 0;
    p.swingTrail.length = 0;
    p.diveT = 0;
    p.lungeT = 0;
    p.telegraphT = 0;
  }

  public startMatch(config?: Partial<MatchConfig>, mode: GameMode = "match"): void {
    this.sfx.init();
    this.sfx.ui();
    this.trophyCeremony = false;
    this.replay.stopReplay();
    this.replay.clearBuffer();
    if (config) Object.assign(this.game.config, config);
    if (!this.game.config.oppPartnerId || this.game.config.oppPartnerId === this.game.config.oppId) {
      this.game.config.oppPartnerId = getPartnerRival(this.game.config.oppId).id;
    }

    this.game.mode = mode;
    this.game.paused = false;
    this.ball.mph = 0;
    Object.assign(this.game, {
      pts: [0, 0],
      games: [0, 0],
      tiebreak: false,
      tbPts: [0, 0],
      server: 0,
      serverSlot: 0,
      faults: 0,
      winner: -1,
      hitstop: 0,
      slowMo: 0,
      newUnlocks: [],
      stats: emptyMatchStats(),
    });

    this.setupPoint();
    this.renderer.snapGameplayCam(this.you);
    this.music.setMood("rally", 0);

    const fmtLabel =
      this.game.config.format === "1game"
        ? "1-Game Sprint"
        : this.game.config.format === "6games"
        ? "Full Set (6 Games)"
        : "First to 3 Games";
    const title =
      mode === "tournament" && this.tournament
        ? `${tournamentRoundName(this.tournament.round)} · vs ${this.getOppName()}`
        : mode === "endless" && this.endless
        ? `Challenger #${this.endless.wins + 1} · ${this.getOppName()}`
        : `vs ${this.getOppName()}`;
    this.ui.showMsg(title, `${fmtLabel} · ${this.getActiveVenue().name}`, 1750);
    this.umpire.announceCall("Play!");
  }

  public startTournament(discipline: MatchConfig["discipline"], format: MatchConfig["format"]): void {
    this.tournament = createTournament(discipline, format, this.game.config.venue, this.career);
    this.ui.showTournamentBracket(false);
  }

  public launchNextTournamentMatch(): void {
    if (!this.tournament || !this.tournament.active) return;
    const oppId = this.tournament.opponents[this.tournament.round];
    const venue = tournamentVenueForRound(this.tournament);
    this.startMatch(
      {
        discipline: this.tournament.discipline,
        format: this.tournament.format,
        venue,
        oppId,
        oppPartnerId: getPartnerRival(oppId).id,
        partnerId: this.tournament.partnerId,
        sky: "auto",
      },
      "tournament"
    );
  }

  public startEndless(discipline: MatchConfig["discipline"]): void {
    this.endless = createEndless(discipline);
    this.startMatch(
      {
        discipline,
        format: "1game",
        venue: "pier",
        oppId: this.endless.currentOpp,
        oppPartnerId: getPartnerRival(this.endless.currentOpp).id,
        sky: "auto",
      },
      "endless"
    );
  }

  public startTraining(drill: TrainingDrill): void {
    this.sfx.init();
    this.sfx.ui();
    this.trophyCeremony = false;
    this.replay.stopReplay();
    this.game.mode = "training";
    this.game.phase = "training";
    this.game.paused = false;
    this.game.config.discipline = "singles";
    this.training = createTrainingState(drill);

    this.placePlayer(this.you, 0, -0.4);
    this.you.homeX = 0;
    this.you.homeZ = -0.5;
    if (drill === "rally") {
      this.placePlayer(this.cpu, 0, L + 0.6);
      this.cpu.speed = 6.2;
    }

    Object.assign(this.ball, { visible: false, live: false, splashed: false });
    this.trail.length = 0;

    if (drill === "serve") {
      this.game.phase = "serveReady";
      this.game.server = 0;
      this.placePlayer(this.you, 0.7, -0.4);
    }

    this.renderer.snapGameplayCam(this.you);
    this.ui.updateTrainHud();
    this.ui.setHint();
    this.music.setMood("rally", 0);

    const titles: Record<TrainingDrill, [string, string]> = {
      rings: ["Target Rings!", "Hit glowing rings · Build ×5.0 combo · 60s"],
      rally: ["Rally Endurance!", "Keep the accelerating rally alive · 3 lives"],
      serve: ["Serve & Return!", "Land serves & returns in the glowing zones · 60s"],
    };
    this.ui.showMsg(titles[drill][0], titles[drill][1], 1800);
  }

  public enterCustomizer(): void {
    this.trophyCeremony = false;
    this.replay.stopReplay();
    this.game.phase = "customizer";
    this.game.paused = false;
    this.ball.visible = false;
    this.placePlayer(this.you, 0, NET - 2.6);
    this.renderer.cam.customizerYaw = 0.28;
    this.music.setMood("menu");
  }

  public setupPoint(): void {
    const d = isDeuceSide(this.game);
    const o = CAST[this.game.config.oppId] || CAST.reef;
    const op = CAST[this.game.config.oppPartnerId] || getPartnerRival(o.id);
    const isNet = this.game.mode === "net";
    const isDbl = this.game.config.discipline === "doubles";
    const paceMult = this.game.mode === "endless" && this.endless ? this.endless.paceMult : 1.0;

    Object.assign(this.ball, {
      visible: false, live: false, serve: false, netted: false, touched: null,
      lastHitter: -1, lastSlot: -1, bounceCount: 0, rocket: false, crit: false, splashed: false,
    });
    this.trail.length = 0;
    this.game.rally = 0;
    this.game.strokes = 0;
    this.game.lobArmed = false;
    this.replay.clearBuffer();
    this.pendingReplayLabel = null;

    const avatars = this.getSlotAvatars();
    this.you.handedness = avatars[0].handedness;
    this.cpu.handedness = avatars[1].handedness;
    this.partner.handedness = avatars[2].handedness;
    this.cpuPartner.handedness = avatars[3].handedness;

    const seatKinds = isNet ? this.ui.getNetSeatKinds?.() : undefined;
    const botSpeed = (slot: PlayerSlot, fallback: number) => {
      const rid = this.ui.getNetBotRivalId?.(slot);
      return rid && CAST[rid] ? CAST[rid].speed : fallback;
    };
    this.you.speed = 5.9;
    this.cpu.speed = isNet
      ? seatKinds?.[1] === "bot" ? botSpeed(1, 4.35) : this.you.speed
      : o.speed * Math.min(1.25, paceMult);
    this.partner.speed = isNet
      ? seatKinds?.[2] === "bot" ? botSpeed(2, 4.45) : this.you.speed
      : 5.65;
    this.cpuPartner.speed = isNet
      ? seatKinds?.[3] === "bot" ? botSpeed(3, 4.35) : this.you.speed
      : op.speed * Math.min(1.22, paceMult);

    for (const p of this.players) {
      p.pending = null;
      p.recover = 0;
      p.fatigue = 0;
      p.aimTarget = null;
      p.telegraphT = 0;
      p.telegraphShot = null;
    }

    // In 4-player Doubles, rotate baseline/net roles so the active serverSlot serves from the baseline!
    const srvSlot = (isDbl ? this.game.serverSlot : this.game.server) as PlayerSlot;
    const nearBase = isDbl && srvSlot === 2 ? this.partner : this.you;
    const nearNet = nearBase === this.you ? this.partner : this.you;
    const farBase = isDbl && srvSlot === 3 ? this.cpuPartner : this.cpu;
    const farNet = farBase === this.cpu ? this.cpuPartner : this.cpu;
    nearBase.role = "baseline";
    nearNet.role = "net";
    farBase.role = "baseline";
    farNet.role = "net";

    const sSign = d ? 1 : -1;
    const serverIsBot = isNet ? this.isNetBotSlot(srvSlot) : this.game.server === 1;
    if (this.game.server === 0) {
      this.placePlayer(nearBase, sSign * 0.75, -0.4);
      this.placePlayer(farBase, -sSign * 2.3, L + 0.8);
      if (serverIsBot) {
        this.game.phase = "cpuServe";
        this.game.timer = 1.25;
        this.game.tossed = false;
      } else {
        this.game.phase = "serveReady";
      }
    } else {
      this.placePlayer(farBase, -sSign * 0.75, L + 0.4);
      this.placePlayer(nearBase, sSign * 2.2, -0.85);
      if (serverIsBot) {
        this.game.phase = "cpuServe";
        this.game.timer = 1.3;
        this.game.tossed = false;
      } else {
        this.game.phase = "serveReady";
      }
    }
    if (isDbl) {
      this.placePlayer(nearNet, -sSign * 2.4, NET - 3.6);
      this.placePlayer(farNet, sSign * 2.4, NET + 3.6);
    }

    this.ui.updateHud();
    this.ui.setHint();
    this.ui.updateTelemetry(0, false);
    this.updateLed();
  }

  public applyJuiceCam(isCrit: boolean, isRocket: boolean): void {
    if (isRocket) {
      this.renderer.cam.shake = 0.95;
      this.renderer.cam.zoomPunch = 1.0;
    } else if (isCrit) {
      this.renderer.cam.shake = 0.50;
      this.renderer.cam.zoomPunch = 0.55;
    } else {
      this.renderer.cam.shake = Math.max(this.renderer.cam.shake, 0.16);
    }
  }

  private triggerImpactJuice(isCrit: boolean, isRocket: boolean, col: RGB): void {
    if (this.netCtx === "remote") {
      this.ui.onNetEvent?.({ k: "juice", a: [isCrit, isRocket], slot: this.netActorSlot, seq: this.netActorSeq });
    } else {
      this.applyJuiceCam(isCrit, isRocket);
    }

    if (isRocket) {
      if (!this.netPredictMode) this.game.hitstop = 0.055;
      this.renderer.vfx.burstSparks(this.ball.x, this.ball.y, this.ball.z, [1.0, 0.94, 0.55], 38, 7.5, 0.11, 3.8);
    } else if (isCrit) {
      if (!this.netPredictMode) this.game.hitstop = 0.038;
      this.renderer.vfx.burstSparks(this.ball.x, this.ball.y, this.ball.z, col, 26, 6.0, 0.09, 3.2);
    } else {
      this.renderer.vfx.burstSparks(this.ball.x, this.ball.y, this.ball.z, col, 12, 3.8, 0.07, 2.2);
    }
  }

  public humanSwing(power: number, intent: ShotIntent = "drive"): void {
    this.sfx.init();
    if (this.ui.isNetSpectator?.() && this.game.mode === "net") return;
    if (this.ui.isNetRemoteClient?.() && this.game.mode === "net") {
      this.ui.onNetGuestSwing?.(power, intent);
      return;
    }
    this.executeNearSlotSwing(0, power, intent, { allowDualControl: this.isTeamDualControl(0) });
  }

  /**
   * Executes a near-side (Team 0 in current world orientation) swing or serve for
   * `localSlot` (0 or 2). Used directly by Host (slots 0 & 2), by Host in mirrored
   * orientation for Team 1 (slots 1 & 3), and by Guests for 0ms local swing prediction!
   */
  public executeNearSlotSwing(
    localSlot: 0 | 2,
    power: number,
    intent: ShotIntent = "drive",
    opts?: { seed?: number; allowDualControl?: boolean; predictOnly?: boolean }
  ): { connected: boolean; isServe: boolean; isToss: boolean } {
    if (!opts?.predictOnly) {
      if (this.replay.active || this.replay.hawkeye.active) {
        this.skipBroadcastOverlay();
        return { connected: false, isServe: false, isToss: false };
      }
      if (this.game.paused) return { connected: false, isServe: false, isToss: false };
    }

    const prevRng = this._rng;
    const prevPredict = this.netPredictMode;
    this._rng = opts?.seed !== undefined ? makeSeededRng(opts.seed) : rand;
    this.netPredictMode = !!opts?.predictOnly;

    try {
      const ph = this.game.phase;
      if (ph === "title" || ph === "matchOver" || ph === "trainOver" || ph === "customizer") {
        return { connected: false, isServe: false, isToss: false };
      }
      if (!opts?.predictOnly && this.game.now - this.game.lastSwing < 0.25) {
        return { connected: false, isServe: false, isToss: false };
      }

      const isDbl = this.game.config.discipline === "doubles" && this.game.mode !== "training";
      const dual = opts?.allowDualControl ?? this.isTeamDualControl(0);

      if (ph === "serveReady" || ph === "toss") {
        if (this.game.server !== 0) return { connected: false, isServe: false, isToss: false };
        const expectedSrv = (isDbl ? this.game.serverSlot : 0) as 0 | 2;
        if (isDbl && !dual && expectedSrv !== localSlot) {
          return { connected: false, isServe: false, isToss: false };
        }
        const serverP = this.players[expectedSrv] || this.you;
        this.game.lastSwing = this.game.now;

        if (ph === "serveReady") {
          const handSign = serverP.handedness === "left" ? -1 : 1;
          Object.assign(this.ball, {
            x: serverP.x + 0.20 * handSign,
            y: 1.55,
            z: serverP.z + 0.35,
            vx: 0, vy: TOSS_VY, vz: 0,
            w: { x: 0, y: 0, z: 0 },
            visible: true, live: false, netted: false, rocket: false, crit: false, splashed: false,
          });
          serverP.tossArm = 1.0;
          this.game.phase = "toss";
          this.game.tossT = 0;
          this.ui.setHint();
          return { connected: true, isServe: false, isToss: true };
        }

        this.serveHit(serverP, power, intent);
        return { connected: true, isServe: true, isToss: false };
      }

      if (ph !== "rally" && ph !== "training") return { connected: false, isServe: false, isToss: false };
      this.game.lastSwing = this.game.now;

      let hitter = this.players[localSlot] || this.you;
      if (isDbl && dual) {
        const d0 = Math.hypot(this.ball.x - this.you.x, this.ball.z - this.you.z);
        const d2 = Math.hypot(this.ball.x - this.partner.x, this.ball.z - this.partner.z);
        hitter = d2 < d0 - 0.15 ? this.partner : this.you;
      }

      const b = this.ball;
      const useLob = intent === "lob" || (this.game.lobArmed && intent !== "slice" && intent !== "drop");
      this.game.lobArmed = false;
      this.ui.updateTelemetry();

      if (!b.live || b.lastHitter !== 1 || (b.serve && b.bounceCount === 0 && b.z > NET)) {
        hitter.swingT = hitter.swingDur = 0.32;
        hitter.swingType = "fh";
        this.ui.feedback("Swing", "wait for the ball");
        return { connected: false, isServe: false, isToss: false };
      }

      const dz = b.z - hitter.z;
      const dx = b.x - hitter.x;
      const absDx = Math.abs(dx);
      const isSmash = b.y >= 1.95 && b.z > NET - 4.8 && absDx < WIN.smash.diveX && dz <= WIN.smash.early && dz >= WIN.smash.late;
      const isVolley = !isSmash && b.bounceCount === 0 && hitter.z > NET - SVC - 0.8 && dz <= WIN.volley.early && dz >= WIN.volley.late && b.y >= WIN.volley.yLo && b.y <= WIN.volley.yHi;
      const shotKey: ShotTag = isSmash ? "smash" : isVolley ? "volley" : useLob ? "lob" : intent === "drop" ? "drop" : intent === "slice" ? "slice" : "drive";
      const win = isSmash ? WIN.smash : isVolley ? WIN.volley : useLob ? WIN.lob : intent === "drop" ? WIN.drop : WIN.ground;
      const volleyOk = b.bounceCount >= 1 || isVolley || isSmash || b.z > 4.2;

      const isDive = absDx > win.x && absDx <= win.diveX && dz <= win.early + 0.25 && dz >= win.late - 0.25 && b.y <= win.yHi && volleyOk && b.z <= NET - 0.25;

      if (!isDive && (b.z > NET - 0.25 || dz > win.early || dz < win.late || absDx > win.x || b.y > win.yHi || !volleyOk)) {
        hitter.swingT = hitter.swingDur = 0.32;
        hitter.swingType = dx <= 0 ? "fh" : "bh";
        if (b.vz < 0 && dz > win.early && dz < 9.5) this.ui.feedback("Too early", "let it come to you");
        else if (dz < win.late) this.ui.feedback("Too late", "swing sooner");
        return { connected: false, isServe: false, isToss: false };
      }

      const hw = courtHalfWidth(this.game.config.discipline);
      const span = dz >= win.sweet ? win.early - win.sweet : win.sweet - win.late;
      const tau = clamp((dz - win.sweet) / span, -1, 1);
      const side = Math.sign(dx) || 1;
      const oppX = this.game.mode === "training" ? 0 : this.cpu.x;
      const open = -Math.sign(oppX || side);
      const bias = clamp(0.55 * open + 0.35 * this.nudge.x, -1, 1);
      const steered = -side * tau * (0.38 + 0.62 * Math.abs(tau));
      const aim = clamp(steered + bias * (1 - Math.abs(tau)), -1, 1);

      const finalTag: ShotTag = isDive ? "lob" : shotKey;
      const sh = SHOT[finalTag];
      const depth = isDive
        ? this._rng(6.2, 8.6)
        : tau > 0
        ? lerp(sh.depthSweet, sh.depthEarly, tau)
        : lerp(sh.depthSweet, sh.depthLate, -tau);
      const miss = isDive ? 0.35 : 0.06 + 0.16 * Math.abs(tau) * (1.05 - 0.28 * power);
      const tx = aim * (hw - 0.26) + this._rng(-miss, miss);
      const tz = NET + depth + this._rng(-miss, miss);

      const cross = clamp(tau, 0, 1);
      const line = clamp(-tau, 0, 1);
      const mid = 1 - cross - line;
      const wantMph = sh.T
        ? 0
        : ((sh.mphSweet || 80) * mid + (sh.mphCross || 70) * cross + (sh.mphLine || 75) * line) *
          (0.76 + 0.28 * power);
      const isCrit = !isDive && (isSmash || (Math.abs(tau) < 0.26 && power >= 0.68));

      const handSign = hitter.handedness === "left" ? -1 : 1;
      const fore = dx * handSign <= 0;
      hitter.swingDur = isSmash ? 0.44 : finalTag === "slice" || finalTag === "drop" ? 0.36 : 0.38;
      hitter.swingT = hitter.swingDur;
      hitter.swingType = isDive ? "dive" : isSmash ? "smash" : finalTag === "drop" ? "drop" : finalTag === "slice" ? "slice" : finalTag === "lob" ? "lob" : fore ? "fh" : "bh";

      if (isDive) {
        hitter.diveT = 0.62;
        hitter.diveDir = -side;
        hitter.recover = 0.55;
        hitter.x += Math.sign(dx) * 0.65;
        this.sfx.dive(hitter.x);
        this.renderer.vfx.burstDust(hitter.x, hitter.z, 18, this.getActiveVenue().physics.dustColor);
      } else if (absDx > 1.35) {
        hitter.lungeT = 0.32;
        hitter.lungeDir = -side;
      }

      const mph = launchBall(this.ball, tx, tz, {
        mph: wantMph,
        T: isDive ? 1.48 : sh.T,
        top: sh.top * (0.75 + 0.35 * power),
        side: sh.side * aim * handSign,
        clear: isDive ? 2.1 : sh.clear,
        crit: isCrit,
        tag: finalTag,
      });
      this.trail.length = 0;
      this.lastMph = mph;
      b.lastHitter = 0;
      b.lastSlot = hitter.slot;
      b.serve = false;

      if (!opts?.predictOnly) {
        this.game.rally++;
        this.game.strokes++;
        if (this.game.rally > this.game.stats.longestRally) this.game.stats.longestRally = this.game.rally;
        if (this.game.rally > this.career.longestRally && this.netCtx === "local") {
          this.career.longestRally = this.game.rally;
          saveCareer(this.career);
        }
        if (this.game.rally >= 7 && this.game.rally % 4 === 3) {
          this.sfx.crowdGasp();
          this.crowd.cheer = Math.max(this.crowd.cheer, 0.38);
        }

        if (this.game.mode === "training" && this.training.drill === "rally") {
          this.training.rallyStreak++;
          this.training.score = Math.max(this.training.score, this.training.rallyStreak);
          this.ui.updateTrainHud();
        }
      }

      this.sfx.hit(isDive ? 0.55 : power, isSmash ? "smash" : finalTag, b.x);
      this.rumbleHit(isSmash ? 130 : isDive ? 95 : isCrit ? 78 : finalTag === "drop" ? 28 : 52);
      const sparkCol: RGB =
        finalTag === "drop"
          ? [0.65, 1.0, 0.72]
          : finalTag === "slice"
          ? [0.45, 0.96, 1.0]
          : isSmash
          ? [1.0, 0.86, 0.28]
          : [1.0, 0.68, 0.24];
      this.triggerImpactJuice(isCrit, false, sparkCol);

      if (isSmash && !opts?.predictOnly) this.lastPointSnapshot = { isBig: true, label: "SMASH REPLAY" };

      const label = isDive
        ? "DIVE SAVE!"
        : isSmash
        ? "SMASH!"
        : isVolley
        ? "VOLLEY!"
        : finalTag === "drop"
        ? "DROP SHOT!"
        : useLob
        ? "LOB!"
        : Math.abs(tau) < 0.26
        ? isCrit
          ? "PERFECT!"
          : "Clean"
        : tau > 0
        ? "Early · Cross"
        : "Late · Line";
      const detail = `${Math.round(mph)} MPH · ${finalTag === "drop" ? "feather touch" : finalTag === "slice" ? "slice" : finalTag === "lob" ? "high arc" : fore ? "forehand" : "backhand"}`;
      this.ui.feedback(label, detail, isCrit || isSmash || isDive);
      this.ui.updateTelemetry(mph, false);
      this.updateLed();

      if (!opts?.predictOnly) {
        if (this.game.mode === "match" || this.game.mode === "tournament" || this.game.mode === "endless" || (this.game.mode === "training" && this.training.drill === "rally")) {
          this.assignFarPrediction(tx);
        } else if (this.game.mode === "net") {
          this.cpu.splitT = 0.24;
          if (isDbl) this.cpuPartner.splitT = 0.24;
          this.ui.setNetAimNext?.(this.netActorSlot % 2 === 1 ? "team0" : "team1");
        }
      }

      return { connected: true, isServe: false, isToss: false };
    } finally {
      this._rng = prevRng;
      this.netPredictMode = prevPredict;
    }
  }

  private serveHit(serverP: PlayerState, power: number, intent: ShotIntent): void {
    const dtA = Math.abs(this.game.tossT - TOSS_VY / G);
    const isRocket = dtA <= 0.075 && power >= 0.56 && intent !== "slice";
    const isSlice = intent === "slice";
    const tq = isRocket ? 1 : clamp(1 - Math.max(0, dtA - 0.075) / 0.32, 0, 1);
    const targetMph = isRocket
      ? 126 + 8 * (1 - dtA / 0.075) + 4 * clamp((power - 0.56) / 0.44, 0, 1)
      : dtA > 0.36
      ? 64 + 14 * power
      : 78 + 34 * tq * (0.55 + 0.45 * power);

    const s = this.game.mode === "training" && this.training.serveTarget
      ? Math.sign(this.training.serveTarget.x || 1)
      : serveBoxSign(this.game);
    const e = 1 - tq;
    const tx = s * this._rng(0.75, 3.25) + e * this._rng(-1, 1) * 2.1;
    const tz = NET + SVC * (0.48 + 0.42 * power) + e * this._rng(-1, 1.15) * 2.6;
    const handSign = serverP.handedness === "left" ? -1 : 1;

    serverP.swingDur = 0.42;
    serverP.swingT = 0.42;
    serverP.swingType = "serve";

    const mph = launchBall(this.ball, tx, tz, {
      mph: targetMph,
      top: isSlice ? -85 : isRocket ? 115 : 80,
      side: (isSlice ? -210 : 55) * s * handSign,
      clear: isRocket ? 0.14 : 0.20,
      rocket: isRocket,
      crit: isRocket || tq > 0.82,
      tag: isSlice ? "slice" : "drive",
    });
    this.trail.length = 0;
    this.lastMph = mph;
    Object.assign(this.ball, { serve: true, lastHitter: 0, lastSlot: serverP.slot });
    this.game.phase = this.game.mode === "training" ? "training" : "rally";
    this.game.strokes = 1;
    this.game.rally = 1;
    this.ui.setHint();

    const rMph = Math.round(mph);
    if (!this.netPredictMode && this.netCtx === "local") {
      if (rMph > this.game.stats.fastestServe) this.game.stats.fastestServe = rMph;
      if (rMph > this.career.fastestServe) {
        this.career.fastestServe = rMph;
        saveCareer(this.career);
      }
    }

    this.sfx.hit(isRocket ? 1.0 : power, isRocket ? "rocket" : isSlice ? "slice" : "drive", this.ball.x);
    this.rumbleHit(isRocket ? 135 : 70);
    this.triggerImpactJuice(tq > 0.8, isRocket, isRocket ? [1.0, 0.96, 0.65] : [1.0, 0.80, 0.30]);
    this.ui.feedback(
      isRocket ? "ROCKET SERVE!" : tq > 0.78 ? "Clean Serve" : tq > 0.42 ? "Off the toss" : "Mistimed",
      `${rMph} MPH${isSlice ? " · slice" : ""}`,
      isRocket
    );
    this.ui.updateTelemetry(mph, isRocket);
    this.updateLed();

    if (this.netPredictMode) return;
    if (this.game.mode === "net") {
      this.cpu.splitT = 0.24;
      if (this.game.config.discipline === "doubles") this.cpuPartner.splitT = 0.24;
      this.ui.setNetAimNext?.(this.netActorSlot % 2 === 1 ? "team0" : "team1");
      return;
    }
    if (this.game.mode !== "training") {
      this.assignFarPrediction(tx, isRocket ? 1.18 : 0.65);
    }
  }

  private assignFarPrediction(tx: number, reactMult = 1.0): void {
    const rival = CAST[this.game.config.oppId] || CAST.reef;
    const pred = predictBall(this.ball, false, this.getActiveVenue());
    this.cpu.splitT = 0.24;
    this.cpu.pending = pred;
    this.cpu.react = this.game.mode === "training" ? 0.04 : rival.react * reactMult;
    if (Math.abs(tx) > 3.2) {
      this.cpu.recover = 0.34;
      this.cpu.fatigue = Math.min(1, this.cpu.fatigue + 0.14);
    }
    if (this.game.config.discipline === "doubles") {
      this.cpuPartner.splitT = 0.24;
      this.cpuPartner.pending = predictBall(this.ball, false, this.getActiveVenue(), true, this.cpuPartner.z);
      this.cpuPartner.react = rival.react * 0.85;
    }
  }

  private cpuServe(): void {
    const isDbl = this.game.config.discipline === "doubles" && this.game.mode !== "training";
    const srvSlot = (isDbl ? this.game.serverSlot : this.game.server) as PlayerSlot;
    const srvP = this.players[srvSlot] || this.cpu;
    const isNearServe = srvP.team === 0;
    const botRid = this.game.mode === "net" ? this.ui.getNetBotRivalId?.(srvSlot) : undefined;
    const o = CAST[botRid || this.game.config.oppId] || CAST.reef;
    const s = serveBoxSign(this.game);
    let tx = s * rand(0.7, 3.45);
    let tz = isNearServe ? NET + rand(3.5, 6.0) : NET - rand(3.5, 6.0);
    if (Math.random() < o.err * 0.65) {
      if (Math.random() < 0.6) tz = isNearServe ? NET + rand(6.6, 7.6) : NET - rand(6.6, 7.6);
      else tx = s * rand(4.3, 5.0);
    }
    srvP.swingDur = 0.40;
    srvP.swingT = 0.40;
    srvP.swingType = "serve";
    const paceMult = this.game.mode === "endless" && this.endless ? this.endless.paceMult : 1.0;
    const baseMph = (80 + o.tier * 6.5) * Math.min(1.18, paceMult);
    const mph = launchBall(this.ball, tx, tz, {
      mph: baseMph,
      top: 75 + o.tier * 12,
      side: 45 * s * (srvP.handedness === "left" ? -1 : 1),
      clear: 0.20,
      tag: "drive",
    });
    this.trail.length = 0;
    this.lastMph = mph;
    Object.assign(this.ball, { serve: true, lastHitter: srvP.team, lastSlot: srvP.slot });
    this.game.phase = "rally";
    this.game.strokes = 1;
    this.game.rally = 1;
    this.ui.setHint();
    this.sfx.hit(0.75, "drive", this.ball.x);
    this.ui.updateTelemetry(mph, false);
    if (isNearServe) {
      this.cpu.splitT = 0.24;
      if (isDbl) this.cpuPartner.splitT = 0.24;
      if (this.game.mode === "net") this.ui.setNetAimNext?.("team1");
      else this.assignFarPrediction(tx);
    } else {
      this.you.splitT = 0.24;
      if (isDbl) this.partner.splitT = 0.24;
      this.aimNearTeam();
    }
  }

  public aimNearTeam(): void {
    const venue = this.getActiveVenue();
    const isDbl = this.game.config.discipline === "doubles" && this.game.mode !== "training";
    const baseP = isDbl && this.partner.role === "baseline" ? this.partner : this.you;
    const netP = baseP === this.you ? this.partner : this.you;

    const tryVolley = baseP.homeZ > NET - SVC - 0.5;
    const t = predictBall(this.ball, true, venue, tryVolley, baseP.homeZ);

    if (!isDbl) {
      baseP.aimTarget = { x: t.bx, z: t.bz };
      const autoX = clamp(t.x - 0.48 * (baseP.handedness === "left" ? -1 : 1), -6.5, 6.5);
      const autoZ = clamp(t.z, -1.75, NET - 1.0);
      baseP.tx = lerp(baseP.homeX, autoX, 0.84);
      baseP.tz = lerp(baseP.homeZ, autoZ, 0.84);
      return;
    }

    // Doubles: split coverage between active net player and active baseline player
    const netT = predictBall(this.ball, true, venue, true, netP.homeZ);
    const nearPartnerIntercept =
      netT.volley && Math.abs(netT.x - netP.x) < 3.4 && this.ball.y < 2.4;

    if (nearPartnerIntercept) {
      netP.aimTarget = { x: netT.bx, z: netT.bz };
      netP.tx = clamp(netT.x, -5.6, 5.6);
      netP.tz = clamp(netT.z, NET - 5.2, NET - 1.1);
      baseP.aimTarget = { x: t.bx, z: t.bz };
      baseP.tx = clamp(t.x * 0.65, -5.2, 5.2);
      baseP.tz = clamp(t.z, -1.6, NET - 4.0);
    } else {
      baseP.aimTarget = { x: t.bx, z: t.bz };
      baseP.tx = lerp(baseP.homeX, clamp(t.x - 0.45, -6.4, 6.4), 0.84);
      baseP.tz = lerp(baseP.homeZ, clamp(t.z, -1.75, NET - 1.2), 0.84);
      netP.aimTarget = null;
      netP.tx = clamp(-Math.sign(t.x || 1) * 2.1, -4.6, 4.6);
      netP.tz = NET - 3.6;
    }
  }

  private cpuTry(): void {
    const b = this.ball;
    if (!b.live) return;

    const isNet = this.game.mode === "net";
    const isDbl = this.game.config.discipline === "doubles" && this.game.mode !== "training";

    // Near-side AI Partner (offline AI partner OR Net Doubles Bot in slot 2!)
    const nearBotActive =
      isDbl &&
      b.lastHitter === 1 &&
      (isNet ? this.isNetBotSlot(2) : this.settings.aiPartner);

    if (nearBotActive) {
      const p = this.partner;
      const atNet = p.z > NET - 5.2 && b.bounceCount === 0 && b.z < NET - 0.4 && b.y < 2.25;
      const baselineReady = p.role === "baseline" && !b.serve && b.bounceCount === 1 && b.z < NET;
      if ((atNet || baselineReady) && Math.abs(b.x - p.x) < 1.25 && Math.abs(b.z - p.z) < 0.78 && b.y < 2.55) {
        const rid = isNet ? this.ui.getNetBotRivalId?.(2) : this.game.config.partnerId;
        const rival = CAST[rid || "sunny"] || CAST.sunny;
        const dec = chooseAIShot(p, rival, b, this.cpu, "doubles", this.game.rally, 1.0, true);
        p.swingDur = 0.36;
        p.swingT = 0.36;
        p.swingType = dec.tag === "smash" ? "smash" : dec.tag === "slice" ? "slice" : b.x - p.x <= 0 ? "fh" : "bh";
        const mph = launchBall(b, dec.tx, dec.tz, { T: dec.T, top: dec.top, side: dec.side, clear: dec.clear, tag: dec.tag });
        this.trail.length = 0;
        this.lastMph = mph;
        b.lastHitter = 0;
        b.lastSlot = 2;
        b.serve = false;
        this.game.rally++;
        this.game.strokes++;
        this.sfx.hit(0.74, dec.tag, b.x);
        this.ui.feedback("PARTNER SHOT!", `${Math.round(mph)} MPH`);
        this.ui.updateTelemetry(mph, false);
        this.updateLed();
        if (isNet) this.ui.setNetAimNext?.("team1");
        else this.assignFarPrediction(dec.tx);
        return;
      }
    }

    // Far-side AI (CPU singles, CPU doubles duo, Rally Endurance partner, OR Net Bot seats 1 / 3!)
    const isAiMode =
      this.game.mode === "match" ||
      this.game.mode === "tournament" ||
      this.game.mode === "endless" ||
      (this.game.mode === "training" && this.training.drill === "rally");
    if (b.lastHitter !== 0) return;

    const farCandidates: PlayerState[] = [];
    if (isNet) {
      if (isDbl && this.isNetBotSlot(3)) farCandidates.push(this.cpuPartner);
      if (this.isNetBotSlot(1)) farCandidates.push(this.cpu);
      if (farCandidates.length === 0) return;
    } else if (isAiMode) {
      if (isDbl) farCandidates.push(this.cpuPartner, this.cpu);
      else farCandidates.push(this.cpu);
    } else {
      return;
    }

    const paceMult = this.game.mode === "endless" && this.endless ? this.endless.paceMult : 1.0;

    for (const f of farCandidates) {
      const rival = isNet
        ? CAST[this.ui.getNetBotRivalId?.(f.slot as PlayerSlot) || "reef"] || CAST.reef
        : f.slot === 3
        ? CAST[this.game.config.oppPartnerId] || getPartnerRival(this.game.config.oppId)
        : CAST[this.game.config.oppId] || CAST.reef;

      previewAITelegraph(f, rival, b, this.you);

      const atNet = f.z < NET + 5.2 && b.bounceCount === 0 && b.z > NET + 0.4 && b.y < 2.25;
      if (!atNet && (b.serve || b.bounceCount !== 1)) continue;

      const effReach =
        (f.recover > 0 && Math.abs(b.x - f.x) > 1.2 ? rival.reach * 0.62 : rival.reach) *
        (this.game.mode === "training" ? 1.55 : 1.0);

      if (Math.abs(b.x - f.x) < effReach && Math.abs(b.z - f.z) < 0.74 && b.y < 2.65) {
        if (this.game.mode === "training" && this.training.drill === "rally") {
          // Steady accelerating partner feed in Rally Endurance!
          const speedUp = Math.min(0.42, this.training.rallyStreak * 0.018);
          const tx = rand(-2.8, 2.8);
          const tz = rand(0.9, 4.1);
          f.swingDur = 0.36; f.swingT = 0.36; f.swingType = b.x - f.x <= 0 ? "fh" : "bh";
          const mph = launchBall(b, tx, tz, { T: Math.max(0.72, 1.16 - speedUp), top: 140 + this.training.rallyStreak * 6, side: rand(-80, 80), clear: 0.28, tag: "drive" });
          this.trail.length = 0;
          b.lastHitter = 1; b.lastSlot = 1;
          this.sfx.hit(0.68, "drive", b.x);
          this.ui.updateTelemetry(mph, false);
          this.aimNearTeam();
          f.tx = 0; f.tz = L + 0.6; f.pending = null;
          return;
        }

        const dec = chooseAIShot(f, rival, b, this.you, this.game.config.discipline, this.game.rally, paceMult, false);
        f.swingDur = 0.36;
        f.swingT = 0.36;
        const hSign = f.handedness === "left" ? -1 : 1;
        f.swingType = dec.tag === "drop" ? "drop" : dec.tag === "slice" ? "slice" : dec.tag === "smash" ? "smash" : (b.x - f.x) * hSign <= 0 ? "fh" : "bh";
        f.telegraphT = 0;

        const mph = launchBall(b, dec.tx, dec.tz, {
          T: dec.T,
          top: dec.top,
          side: dec.side,
          clear: dec.clear,
          tag: dec.tag,
        });
        this.trail.length = 0;
        this.lastMph = mph;
        b.lastHitter = 1;
        b.lastSlot = f.slot;
        b.serve = false;
        this.game.rally++;
        this.game.strokes++;
        this.sfx.hit(0.70, dec.tag, b.x);
        this.ui.updateTelemetry(mph, false);
        this.updateLed();
        this.you.splitT = 0.24;
        if (isDbl) this.partner.splitT = 0.24;
        this.aimNearTeam();

        if (f.role === "baseline") {
          f.tx = 0;
          f.tz = rival.rush > 0.5 && Math.random() < 0.42 ? NET + 3.4 : L + 0.75;
        } else {
          f.tx = clamp(-Math.sign(dec.tx || 1) * 2.2, -4.4, 4.4);
          f.tz = NET + 3.5;
        }
        f.pending = null;
        return;
      }
    }
  }

  private onBounce(): void {
    const b = this.ball;
    const venue = this.getActiveVenue();
    this.sfx.bounce(Math.hypot(b.vx, b.vy, b.vz), b.x, venue.physics);
    this.renderer.vfx.burstDust(b.x, b.z, venue.id === "cove" ? 14 : 8, venue.physics.dustColor);
    if (!b.live) return;

    // Training drills bounce handling
    if (this.game.mode === "training") {
      b.bounceCount++;
      if (this.training.drill === "rings") {
        if (b.lastHitter === 1 && b.bounceCount >= 2) {
          this.training.combo = 0;
          b.live = false;
          this.ui.updateTrainHud();
          this.ui.feedback("Missed ball", "combo reset");
        }
        if (b.lastHitter === 0 && b.bounceCount >= 1) {
          this.marks.push({ x: b.x, z: b.z, out: !isInCourt(b.x, b.z, false), age: 0 });
          b.live = false;
        }
      } else if (this.training.drill === "rally") {
        const near = b.z < NET;
        if (b.lastHitter === 0 && b.bounceCount === 1) {
          const ok = isInCourt(b.x, b.z, false);
          this.marks.push({ x: b.x, z: b.z, out: !ok, age: 0 });
          if (!ok || near) {
            this.loseRallyLife("Out!");
          }
        } else if (b.lastHitter === 1 && b.bounceCount >= 2) {
          this.loseRallyLife("Missed!");
        }
      } else if (this.training.drill === "serve") {
        if (b.lastHitter === 0 && b.bounceCount === 1) {
          const tgt = this.training.serveTarget;
          const ok = tgt ? Math.hypot(b.x - tgt.x, b.z - tgt.z) <= tgt.r + 0.35 : false;
          this.marks.push({ x: b.x, z: b.z, out: !ok, age: 0 });
          b.live = false;
          if (ok && tgt) {
            this.training.combo++;
            const mul = Math.min(5, 1 + 0.25 * (this.training.combo - 1));
            const bonus = b.rocket ? 350 : 180;
            const pts = Math.round(bonus * mul);
            this.training.score += pts;
            this.renderer.vfx.burstSparks(b.x, 0.2, b.z, [0.24, 0.96, 0.88], 28, 6, 0.09, 3.2);
            this.sfx.ring(this.training.combo, b.rocket);
            this.ui.feedback(b.rocket ? `ROCKET BULLSEYE! +${pts}` : `BULLSEYE! +${pts}`, `×${mul.toFixed(2)}`, true);
          } else {
            this.training.combo = 0;
            this.ui.feedback("Missed Zone", "keep swinging");
          }
          // Alternate between Serve and Return waves!
          const nextServe = !this.training.serveTarget?.isServe;
          spawnServeZone(this.training, nextServe);
          if (nextServe) {
            this.game.phase = "serveReady";
            this.placePlayer(this.you, 0.7, -0.4);
          } else {
            this.game.phase = "training";
            this.placePlayer(this.you, 0, -0.7);
            this.training.feedT = 0.8;
          }
          this.ui.updateTrainHud();
          this.ui.setHint();
        } else if (b.lastHitter === 1 && b.bounceCount >= 2) {
          b.live = false;
          this.training.combo = 0;
          this.ui.feedback("Ace got past you", "next serve!");
          spawnServeZone(this.training, true);
          this.game.phase = "serveReady";
          this.placePlayer(this.you, 0.7, -0.4);
          this.ui.updateTrainHud();
          this.ui.setHint();
        }
      }
      return;
    }

    const near = b.z < NET;
    const hitter = b.lastHitter as 0 | 1;
    const recv = (1 - hitter) as 0 | 1;
    const recvNear = recv === 0;
    const disc = this.game.config.discipline;

    if (b.serve) {
      const check = checkLineProximity(b.x, b.z, near, true, disc, this.game);
      if (b.netted && check.isIn) {
        this.marks.push({ x: b.x, z: b.z, out: false, age: 0 });
        b.live = false;
        this.ui.showMsg("Let", "Take that serve again", 1100);
        this.umpire.announceCall("Let. First serve.");
        this.sfx.crowdGasp();
        if (this.game.mode === "net") this.ui.onNetEvent?.({ k: "msg", a: ["Let", "Take that serve again", 1100] });
        this.game.phase = "between";
        this.game.timer = 1.2;
        return;
      }
      this.marks.push({ x: b.x, z: b.z, out: !check.isIn, age: 0 });
      if (!check.isIn) {
        this.triggerCloseHawkEye(check, b.x, b.z);
        this.fault();
        return;
      }
      b.serve = false;
      b.bounceCount = 1;
      return;
    }

    if (near !== recvNear) {
      this.marks.push({ x: b.x, z: b.z, out: true, age: 0 });
      this.pointTo(recv, b.netted ? "Into the net" : "Fell short");
      return;
    }

    b.bounceCount++;
    if (b.bounceCount === 1) {
      const check = checkLineProximity(b.x, b.z, near, false, disc, this.game);
      this.marks.push({ x: b.x, z: b.z, out: !check.isIn, age: 0 });
      if (!check.isIn) {
        this.triggerCloseHawkEye(check, b.x, b.z);
        this.pointTo(recv, "Out!");
      }
    } else {
      this.pointTo(hitter, hitter === 0 ? "Winner!" : "Too quick");
    }
  }

  private triggerCloseHawkEye(check: ReturnType<typeof checkLineProximity>, x: number, z: number): void {
    if (this.game.mode === "net" || !check.isCloseCall) return;
    this.replay.triggerHawkEye(x, z, check.isIn, check.distMeters, check.lineLabel);
    this.sfx.hawkeye(check.isIn);
    this.ui.updateHawkEyeBanner(true, check.isIn, this.replay.hawkeye.distCm, check.lineLabel);
  }

  private loseRallyLife(msg: string): void {
    this.ball.live = false;
    this.training.lives--;
    this.training.rallyStreak = 0;
    this.sfx.crowdGasp();
    this.ui.feedback(msg, `${this.training.lives} lives left`);
    this.ui.updateTrainHud();
    if (this.training.lives <= 0) {
      this.finishTraining();
    } else {
      this.training.feedT = 1.1;
    }
  }

  private finishTraining(): void {
    this.game.phase = "trainOver";
    this.ball.visible = false;
    const earned = upgradeMedal(this.career, this.training.drill, this.training.score);
    this.game.newUnlocks = evaluateUnlocks(this.career);
    saveCareer(this.career);
    this.music.setMood("victory");
    if (earned !== "none") this.sfx.point(true, true, false);
    this.ui.showTrainEnd();
  }

  private fault(): void {
    this.game.faults++;
    this.ball.live = false;
    if (this.game.faults >= 2) {
      this.pointTo((1 - this.game.server) as 0 | 1, "Double fault");
      return;
    }
    this.ui.showMsg("Fault", "Second serve", 1150);
    this.umpire.announceCall("Fault. Second serve.");
    if (this.game.mode === "net") this.ui.onNetEvent?.({ k: "msg", a: ["Fault", "Second serve", 1150] });
    this.sfx.crowdGasp();
    this.game.phase = "between";
    this.game.timer = this.replay.hawkeye.active ? 2.35 : 1.25;
    this.ui.setHint();
  }

  public pointTo(w: 0 | 1, reason: string): void {
    this.ball.live = false;
    this.game.faults = 0;
    const o = CAST[this.game.config.oppId] || CAST.reef;
    const isNet = this.game.mode === "net";
    const isAce = this.game.strokes === 1 && w === this.game.server && (isNet || this.game.server === 0);

    if (isAce) {
      reason = "ACE!";
      if (w === 0) {
        this.game.stats.aces++;
        if (!isNet) this.career.aces++;
      }
      this.lastPointSnapshot = { isBig: true, label: "ACE REPLAY" };
    } else if (this.ball.touched === "cord" && (isNet || w === 0)) {
      reason = "Net cord!";
    }
    if (w === 0 && (reason === "Winner!" || reason === "ACE!" || reason === "Net cord!")) {
      this.game.stats.winners++;
    }

    const res = applyPointToScore(this.game, w);
    const { isGame, isMatch, snapshotPts, snapshotTb, snapshotServer } = res;

    if (isMatch) {
      this.game.slowMo = 0.72;
      this.lastPointSnapshot = { isBig: true, label: "MATCH POINT REPLAY" };
    }

    if (isMatch && !isNet) {
      const delta = computeSkillDelta(this.career, w === 0, o, {
        gamesFor: this.game.games[0],
        gamesAgainst: this.game.games[1],
        aces: this.game.stats.aces,
        streakBefore: this.career.streak,
      });
      this.game.lastSkillDelta = delta;
      this.career.skill = clamp(this.career.skill + delta, 0, 2000);
      if (w === 0) {
        this.career.wins++;
        this.career.streak++;
        this.career.bestStreak = Math.max(this.career.bestStreak, this.career.streak);
        this.career.crowns[o.id] = true;
      } else {
        this.career.losses++;
        this.career.streak = 0;
      }
      this.game.newUnlocks = evaluateUnlocks(this.career);
      saveCareer(this.career);
    }

    const [big, sub] = pointBannerText(w, reason, isGame, isMatch, snapshotPts, snapshotServer, this.getOppName(), snapshotTb);
    if (isNet) {
      this.ui.onNetEvent?.({
        k: "pt",
        a: [w, reason, isGame, isMatch, snapshotPts, snapshotServer, snapshotTb],
      });
    }

    // Emotes, crowd cheer & confetti
    const winners = w === 0 ? [this.you, this.partner] : [this.cpu, this.cpuPartner];
    const losers = w === 0 ? [this.cpu, this.cpuPartner] : [this.you, this.partner];
    for (const p of winners) { p.emote = "win"; p.emoteT = 1.4; }
    for (const p of losers) { p.emote = "lose"; p.emoteT = 1.4; }

    if (w === 0) {
      this.crowd.cheer = isMatch || isGame || reason === "ACE!" ? 1.0 : 0.58;
      this.crowd.hop = 0;
      this.input.rumblePattern(isGame ? [85, 55, 85] : [65]);
      if (isMatch) this.renderer.vfx.burstConfetti(this.you.x, 1.5, this.you.z + 2, 100);
      else if (isGame || reason === "ACE!") this.renderer.vfx.burstConfetti(this.you.x, 1.8, this.you.z + 1.5, 48);
      if (isNet && this.game.config.discipline === "doubles") {
        this.ui.onNetEvent?.({ k: "rumP", a: [isGame ? [85, 55, 85] : [65]], slot: 2 });
      }
    } else {
      this.crowd.cheer = isNet ? (isMatch || isGame || reason === "ACE!" ? 1.0 : 0.55) : 0.25;
      if (isNet) {
        this.ui.onNetEvent?.({ k: "rumP", a: [isGame ? [85, 55, 85] : [65]], slot: 1 });
        if (this.game.config.discipline === "doubles") {
          this.ui.onNetEvent?.({ k: "rumP", a: [isGame ? [85, 55, 85] : [65]], slot: 3 });
        }
        if (isMatch) this.renderer.vfx.burstConfetti(this.cpu.x, 1.5, this.cpu.z - 2, 100);
        else if (isGame || reason === "ACE!") this.renderer.vfx.burstConfetti(this.cpu.x, 1.8, this.cpu.z - 1.5, 48);
      }
    }

    this.ui.showMsg(big, sub, isMatch ? 2500 : 1800);
    this.sfx.point(w === 0, isGame, isMatch);
    this.umpire.announcePoint(big, sub, isMatch);

    if (isGame && !isMatch) this.music.setMood("transition");
    if (isMatch) this.music.setMood("victory");

    // Schedule skippable slow-mo instant replay on Aces, Smashes, and Match Points (offline modes)
    if (!isNet && this.lastPointSnapshot.isBig && !this.replay.hawkeye.active) {
      this.pendingReplayLabel = this.lastPointSnapshot.label;
    }
    this.lastPointSnapshot = { isBig: false, label: "" };

    this.game.phase = "pointOver";
    this.game.timer = isMatch ? 2.4 : this.replay.hawkeye.active ? 2.45 : 1.85;
    this.ui.updateHud();
    this.ui.setHint();
    this.updateLed();
  }

  public skipBroadcastOverlay(): boolean {
    if (this.replay.skipAny()) {
      this.ui.updateReplayBanner(false);
      this.ui.updateHawkEyeBanner(false);
      this.music.setMood(this.game.phase === "matchOver" ? "victory" : "rally");
      return true;
    }
    return false;
  }

  private rumbleHit(ms: number): void {
    if (this.netCtx === "remote") {
      this.ui.onNetEvent?.({ k: "rum", a: [ms], slot: this.netActorSlot, seq: this.netActorSeq });
    } else {
      this.input.rumble(ms);
    }
  }

  public updateLed(): void {
    const [t0, t1] = this.getTeamNames();
    this.renderer.courtLife.updateLedScoreboard(
      this.game,
      t0,
      t1,
      this.lastMph,
      this.training.score,
      this.training.time
    );
  }

  public movePlayer(p: PlayerState, dt: number): void {
    p.prevVx = p.vx;
    p.prevVz = p.vz;
    const dx = p.tx - p.x;
    const dz = p.tz - p.z;
    const d = Math.hypot(dx, dz);
    const diveSlow = p.diveT > 0 ? 0.25 : p.recover > 0 ? 0.72 : 1.0;
    const step = Math.min(d, p.speed * diveSlow * dt);
    if (d > 0.01) {
      p.vx = (dx / d) * (step / Math.max(dt, 1e-4));
      p.vz = (dz / d) * (step / Math.max(dt, 1e-4));
      p.x += (dx / d) * step;
      p.z += (dz / d) * step;
    } else {
      p.vx *= 0.8;
      p.vz *= 0.8;
    }

    // Court sneaker squeak or clay slide on hard cut!
    p.squeakCd = Math.max(0, p.squeakCd - dt);
    const sp = Math.hypot(p.vx, p.vz);
    const psp = Math.hypot(p.prevVx, p.prevVz);
    if (p.squeakCd <= 0 && sp > 2.4 && psp > 2.4) {
      const dot = (p.vx * p.prevVx + p.vz * p.prevVz) / (sp * psp);
      if (dot < 0.25) {
        const venue = this.getActiveVenue();
        if (venue.id === "cove") {
          this.sfx.slide(p.x);
          this.renderer.vfx.burstDust(p.x, p.z, 10, venue.physics.dustColor);
        } else {
          this.sfx.squeak(p.x);
          this.renderer.vfx.burstDust(p.x, p.z, 5, venue.physics.dustColor);
        }
        p.squeakCd = 0.45;
      }
    }
  }

  public applyNudgeForSlot(slot: 0 | 2, nx: number, nz: number, dt: number): void {
    if (this.game.phase === "rally" || this.game.phase === "training") {
      const p = this.players[slot] || this.you;
      const zMin = p.role === "net" ? NET - 6.2 : -1.6;
      const zMax = p.role === "net" ? NET - 1.05 : NET - 1.15;
      p.homeX = clamp(p.homeX + nx * 3.4 * dt, -5.6, 5.6);
      p.homeZ = clamp(p.homeZ + nz * 3.8 * dt, zMin, zMax);
      if (!this.ball.live || this.ball.lastHitter !== 1) {
        p.tx = lerp(p.tx, p.homeX, clamp(dt * 4.5, 0, 1));
        p.tz = lerp(p.tz, p.homeZ, clamp(dt * 4.5, 0, 1));
      }
    }
  }

  public applyNudgeMove(dt: number): void {
    this.applyNudgeForSlot(0, this.nudge.x, this.nudge.z, dt);
  }

  public update(rawDt: number): void {
    if (this.game.paused) return;

    // 1. Hawk-Eye laser inspection pause
    if (this.replay.hawkeye.active) {
      const alive = this.replay.stepHawkEye(rawDt);
      if (!alive) this.ui.updateHawkEyeBanner(false);
      this.renderer.vfx.updateParticles(rawDt * 0.4, this.getActiveVenue().waterY);
      this.renderer.updateCamera(rawDt, this.game, this.you, this.ball, this.replay, this.trophyCeremony);
      return;
    }

    // 2. Slow-Mo Instant Replay playback
    if (this.replay.active) {
      const frame = this.replay.stepReplay(rawDt);
      if (!frame) {
        this.ui.updateReplayBanner(false);
        if (this.game.phase === "matchOver") {
          this.music.setMood("victory");
          this.finishMatchFlow();
        } else {
          this.music.setMood("rally");
          this.setupPoint();
        }
        return;
      }
      // Apply smoothly interpolated keyframe to visual ball, trail & characters at full monitor FPS
      const prevBx = this.ball.x, prevBy = this.ball.y, prevBz = this.ball.z;
      this.ball.x = frame.bx; this.ball.y = frame.by; this.ball.z = frame.bz;
      this.ball.visible = frame.bvis; this.ball.rocket = frame.brocket; this.ball.crit = frame.bcrit;
      this.ball.shotTag = frame.btag; this.ball.rotX = frame.brotX; this.ball.rotY = frame.brotY; this.ball.rotZ = frame.brotZ;
      if (frame.bvis) {
        if (this.trail.length && Math.hypot(frame.bx - prevBx, frame.by - prevBy, frame.bz - prevBz) > 3.0) {
          this.trail.length = 0;
        }
        this.trail.push({ x: frame.bx, y: frame.by, z: frame.bz });
        if (this.trail.length > 26) this.trail.shift();
      } else if (this.trail.length) {
        this.trail.shift();
      }
      for (const ps of frame.players) {
        const p = this.players[ps.slot];
        if (!p) continue;
        Object.assign(p, ps);
        const spd = Math.hypot(p.vx, p.vz);
        if (spd > 0.25) p.run += spd * rawDt * 0.52 * 2.1;
      }
      this.renderer.vfx.updateParticles(rawDt * 0.52, this.getActiveVenue().waterY);
      this.renderer.updateCamera(rawDt, this.game, this.you, this.ball, this.replay, this.trophyCeremony);
      return;
    }

    if (this.game.hitstop > 0) {
      this.game.hitstop -= rawDt;
      this.renderer.cam.shake = Math.max(0, this.renderer.cam.shake - rawDt * 1.8);
      return;
    }

    let dt = rawDt;
    if (this.game.slowMo > 0) {
      this.game.slowMo -= rawDt;
      dt *= 0.38;
    }

    this.sfx.tickAmbiance(dt);
    if (this.netHit.amp > 0.001) {
      this.netHit.elapsed += dt;
      this.netHit.amp *= Math.exp(-dt * 4.2);
    }
    this.crowd.cheer = Math.max(0, this.crowd.cheer - dt * 0.35);
    this.crowd.hop += dt * 11;

    // Input nudge
    const [nx, nz] = this.input.readNudge();
    this.nudge.x = lerp(this.nudge.x, nx, clamp(dt * 12, 0, 1));
    this.nudge.z = lerp(this.nudge.z, nz, clamp(dt * 12, 0, 1));
    this.applyNudgeMove(dt);

    // Phase timers
    const ph = this.game.phase;
    if (ph === "pointOver" || ph === "between") {
      this.game.timer -= rawDt;
      if (this.game.timer <= 0) {
        // Kick off instant replay if queued!
        if (ph === "pointOver" && this.pendingReplayLabel && this.replay.triggerReplay(this.pendingReplayLabel)) {
          const lbl = this.pendingReplayLabel;
          this.pendingReplayLabel = null;
          this.trail.length = 0;
          this.ui.updateReplayBanner(true, lbl);
          this.music.setMood("replay");
          if (this.game.winner >= 0) this.game.phase = "matchOver";
          return;
        }
        if (ph === "pointOver" && this.game.winner >= 0) {
          this.game.phase = "matchOver";
          this.ball.visible = false;
          this.finishMatchFlow();
        } else {
          this.music.setMood("rally", clamp(this.game.games[0] + this.game.games[1], 0, 8) / 8);
          this.setupPoint();
        }
      }
    }

    if (ph === "cpuServe") {
      this.game.timer -= dt;
      if (!this.game.tossed && this.game.timer < 0.56) {
        this.game.tossed = true;
        const isDbl = this.game.config.discipline === "doubles" && this.game.mode !== "training";
        const srvSlot = (isDbl ? this.game.serverSlot : this.game.server) as PlayerSlot;
        const srvP = this.players[srvSlot] || this.cpu;
        const zOff = srvP.team === 0 ? 0.35 : -0.35;
        Object.assign(this.ball, {
          x: srvP.x + 0.18, y: 1.6, z: srvP.z + zOff,
          vx: 0, vy: 5.2, vz: 0, w: { x: 0, y: 0, z: 0 },
          visible: true, live: false, netted: false, splashed: false,
        });
        srvP.tossArm = 1.0;
      }
      if (this.game.tossed && this.ball.vy < 0.15) this.cpuServe();
    }

    if (ph === "toss") {
      this.game.tossT += dt;
      const yPct = clamp((this.ball.y - 1.1) / 2.1, 0, 1) * 100;
      const isDbl = this.game.config.discipline === "doubles" && this.game.mode !== "training";
      const srvSlot = (isDbl ? this.game.serverSlot : this.game.server) as PlayerSlot;
      const showLocalMeter =
        this.game.mode !== "net"
          ? this.game.server === 0
          : srvSlot === 0 || (srvSlot === 2 && this.isTeamDualControl(0));
      this.ui.updateServeMeter(showLocalMeter, yPct);
      if (this.ball.y < 1.05 && this.ball.vy < 0) {
        this.ball.visible = false;
        this.ui.updateServeMeter(false, 0);
        this.game.phase = "serveReady";
        if (showLocalMeter) this.ui.feedback("Missed the toss", "click or swing to toss again");
        else this.ui.onNetEvent?.({ k: "fb", a: ["Missed the toss", "swing to toss again", false], slot: srvSlot });
        this.ui.setHint();
      }
    } else {
      this.ui.updateServeMeter(false, 0);
    }

    // Training drills tick
    if (this.game.mode === "training" && (ph === "training" || ph === "serveReady" || ph === "toss")) {
      if (this.training.drill === "rings" || this.training.drill === "serve") {
        this.training.time = Math.max(0, this.training.time - dt);
      } else {
        this.training.time += dt;
      }
      if (this.training.comboT > 0) {
        this.training.comboT -= dt;
        if (this.training.comboT <= 0) this.training.combo = 0;
      }
      for (const rg of this.training.rings) {
        if (rg.active && rg.moving) {
          rg.x = rg.baseX + Math.sin(this.game.now * (rg.gold ? 1.65 : 1.0) + rg.seed) * (rg.gold ? 1.55 : 0.95);
        }
      }
      if (ph === "training") {
        this.training.feedT -= dt;
        const shouldFeed =
          this.training.drill === "rings"
            ? this.training.feedT <= 0 && (!this.ball.live || this.ball.z > NET + 2)
            : this.training.drill === "rally"
            ? this.training.feedT <= 0 && !this.ball.live
            : this.training.drill === "serve" && this.training.servePhase === "return" && this.training.feedT <= 0 && !this.ball.live;
        if (shouldFeed) {
          feedTrainingBall(this.ball, this.training);
          this.sfx.hit(0.55, "drive", this.ball.x);
          this.aimNearTeam();
          this.training.feedT = 2.05;
        }
      }
      this.ui.updateTrainHud();
      this.updateLed();
      if ((this.training.drill === "rings" || this.training.drill === "serve") && this.training.time <= 0) {
        this.finishTraining();
      }
    }

    // Fixed 240Hz physics sub-stepping
    const venue = this.getActiveVenue();
    const n = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      if (this.ball.visible) {
        const px = this.ball.x, py = this.ball.y, pz = this.ball.z;
        const ev = physStep(this.ball, h, venue, false, this.netHit);

        if (this.game.mode === "training" && this.training.drill === "rings") {
          const hit = checkTrainingRingHit(this.training, this.ball, px, py, pz);
          if (hit) {
            this.renderer.vfx.burstSparks(hit.rx, hit.ry, hit.rz, hit.gold ? [1.0, 0.88, 0.22] : [0.22, 0.96, 0.98], 34, 6.5, 0.10, 3.6);
            this.sfx.ring(this.training.combo, hit.gold);
            this.input.rumble(hit.gold ? 95 : 42);
            this.crowd.cheer = Math.min(1, this.crowd.cheer + 0.35);
            this.crowd.hop = 0;
            this.ui.feedback(hit.gold ? `GOLD TARGET! +${hit.pts}` : `TARGET! +${hit.pts}`, `×${hit.mul.toFixed(2)} combo`, hit.gold);
            this.ui.updateTrainHud();
          }
        }

        if (ev === "bounce") {
          this.onBounce();
        } else if (ev === "splash") {
          this.renderer.vfx.burstSplash(this.ball.x, this.ball.z, venue.waterY);
          this.sfx.splash(this.ball.x);
          if (this.ball.live) {
            const hitter = this.ball.lastHitter as 0 | 1;
            const recv = (1 - hitter) as 0 | 1;
            if (this.game.mode === "training") {
              this.ball.live = false;
              if (this.training.drill === "rally") this.loseRallyLife("Splashed!");
            } else if (this.ball.serve) {
              this.fault();
            } else {
              this.pointTo(this.ball.bounceCount >= 1 ? hitter : recv, "Splashdown!");
            }
          }
        } else if (ev === "net" && this.ball.live) {
          this.sfx.net(this.ball.x);
          this.renderer.vfx.burstSparks(this.ball.x, this.ball.y, NET, [1, 0.96, 0.85], 12, 3.2, 0.06, 2.0);
        }
      }
      this.cpuTry();
    }

    // Far-side AI reaction & net-rush steering
    for (const f of [this.cpu, this.cpuPartner]) {
      f.recover = Math.max(0, f.recover - dt);
      if (f.pending && f.react > 0) {
        f.react -= dt;
        if (f.react <= 0) {
          const t = f.pending;
          const rival = f.slot === 3 ? CAST[this.game.config.oppPartnerId] || CAST.reef : CAST[this.game.config.oppId] || CAST.reef;
          if (f.slot === 3) {
            f.tx = clamp(t.x, -5.2, 5.2);
            f.tz = clamp(t.z, NET + 1.4, NET + 5.8);
          } else {
            const doRush = t.bz < rival.rushZ && Math.random() < rival.rush;
            if (doRush) {
              f.tx = clamp(t.x, -4.8, 4.8);
              f.tz = NET + 2.4;
            } else {
              f.tx = clamp(t.x + (t.x > f.x ? -0.45 : 0.45), -6.5, 6.5);
              f.tz = clamp(t.z, NET + 1.8, L + 2.8);
            }
          }
          f.pending = null;
        }
      }
    }

    // Move active players
    const vis = this.getVisibleSlots();
    for (let i = 0; i < this.players.length; i++) {
      if (vis[i]) this.movePlayer(this.players[i], dt);
    }

    // Record 60Hz replay buffer during live rallies
    if (this.game.mode !== "net" && (ph === "rally" || ph === "toss" || ph === "pointOver")) {
      this.replay.record(dt, this.ball, this.players);
    }

    if (this.ball.visible && this.ball.live) {
      this.trail.push({ x: this.ball.x, y: this.ball.y, z: this.ball.z });
      if (this.trail.length > 24) this.trail.shift();
    } else if (this.trail.length) {
      this.trail.shift();
    }

    for (let i = this.marks.length - 1; i >= 0; i--) {
      this.marks[i].age += dt;
      if (this.marks[i].age > 1.5) this.marks.splice(i, 1);
    }

    this.renderer.vfx.updateParticles(dt, venue.waterY);
    this.renderer.updateCamera(dt, this.game, this.you, this.ball, this.replay, this.trophyCeremony);
  }

  private finishMatchFlow(): void {
    const won = this.game.winner === 0;

    if (this.game.mode === "tournament" && this.tournament) {
      const scoreTxt = `${this.game.games[0]}–${this.game.games[1]}`;
      const res = recordTournamentResult(this.tournament, won, scoreTxt);
      if (res.champion) {
        this.career.cupsWon++;
        this.game.newUnlocks = evaluateUnlocks(this.career);
        saveCareer(this.career);
        this.trophyCeremony = true;
        this.renderer.vfx.burstConfetti(0, 2.2, NET - 2.6, 140);
      }
      this.ui.showTournamentBracket(res.champion);
      return;
    }

    if (this.game.mode === "endless" && this.endless) {
      if (won) {
        const next = advanceEndless(this.endless, this.career.bossUnlocked);
        if (this.endless.wins > this.career.endlessBest) {
          this.career.endlessBest = this.endless.wins;
          this.game.newUnlocks = evaluateUnlocks(this.career);
          saveCareer(this.career);
        }
        this.ui.showMsg(`Win Streak: ${this.endless.wins}!`, `Next Challenger: ${CAST[next.oppId]?.name || next.oppId} · Faster pace!`, 2000);
        setTimeout(() => {
          if (this.game.mode === "endless" && this.endless?.active) {
            this.startMatch({ oppId: next.oppId, venue: next.venue, discipline: this.endless.discipline, format: "1game" }, "endless");
          }
        }, 2100);
        return;
      } else {
        this.endless.active = false;
        if (this.endless.wins > this.career.endlessBest) {
          this.career.endlessBest = this.endless.wins;
          this.game.newUnlocks = evaluateUnlocks(this.career);
          saveCareer(this.career);
        }
        this.ui.showEndlessResult();
        return;
      }
    }

    this.ui.showEnd();
  }
}
