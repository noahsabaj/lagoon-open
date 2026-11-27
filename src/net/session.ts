import {
  BUDDY_AVATAR,
  CAST,
  clamp,
  DEFAULT_BOT_RIVALS,
  emptyMatchStats,
  generateRoomCode,
  isValidRoomCode,
  L,
  lerp,
  normalizeRoomCode,
  PRESETS,
  VENUES,
} from "../core/constants";
import type {
  AvatarConfig,
  MatchStats,
  NetLobbyConfig,
  NetMode,
  PlayerSlot,
  PlayerState,
  RoomPeerInfo,
  SeatAssignment,
  SeatKind,
  ShotIntent,
  ShotTag,
  SkyId,
  SpectatorCamMode,
  SwingAnimType,
  VenueId,
} from "../core/types";
import type { GameEngine } from "../game/engine";
import { pointBannerText } from "../game/rules";
import { physStep } from "../physics/ballPhysics";
import {
  fastForwardBall,
  restoreBall,
  SIM_TICK_DT,
  snapshotBall,
  StateHistoryRing,
  SwingPredictor,
} from "./prediction";
import {
  LanWsTransport,
  NET_PORT,
  type NetTransport,
  normalizeSignalUrl,
  resolveDefaultSignalUrl,
  WebRtcTransport,
} from "./transport";

export { NET_PORT, resolveDefaultSignalUrl };

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

interface NetUiHooks {
  refreshLobby: () => void;
  showTitle: () => void;
  showNetEnd: () => void;
  showMsg: (big: string, small: string, ms: number) => void;
  feedback: (label: string, detail?: string, isCrit?: boolean) => void;
  updateTelemetry: (mph?: number, isRocket?: boolean) => void;
  updateHud: () => void;
  setHint: () => void;
  updatePing: (ms: number | null) => void;
  updateSpectatorBar: () => void;
  hideOverlayForMatch: () => void;
  onChat?: (senderName: string, senderSlot: PlayerSlot | "spec", text: string, quick: boolean) => void;
  onChatReset?: () => void;
}

interface NetEvent {
  k: string;
  a: unknown[];
  f?: string;
  n?: string;
  slot?: PlayerSlot;
  seq?: number;
}

const SPEC_CAM_ORDER: SpectatorCamMode[] = ["umpire", "broadcast", "courtside", "follow", "orbit"];

export class MultiplayerController {
  public transport: NetTransport | null = null;
  public mode: NetMode = "online";
  public role: "host" | "guest" | null = null;
  public connected = false;
  public roomCode = "";
  public signalUrl = resolveDefaultSignalUrl();
  public myPeerId = "";
  public mySlot: PlayerSlot | null = null; // 0..3 for players, null for spectator
  public myName = "";
  public ips: string[] = [];
  public err = "";
  public addr = "";
  public target = "";
  public pingMs: number | null = null;

  public peers = new Map<string, RoomPeerInfo>();
  public seats: [SeatAssignment, SeatAssignment, SeatAssignment, SeatAssignment] = [
    { kind: "human", peerId: null, botRivalId: DEFAULT_BOT_RIVALS[0] },
    { kind: "bot", peerId: null, botRivalId: DEFAULT_BOT_RIVALS[1] },
    { kind: "bot", peerId: null, botRivalId: DEFAULT_BOT_RIVALS[2] },
    { kind: "bot", peerId: null, botRivalId: DEFAULT_BOT_RIVALS[3] },
  ];

  public lobbyConfig: NetLobbyConfig = {
    discipline: "singles",
    format: "3games",
    venue: "pier",
    sky: "golden",
    soloDoublesMode: "bot",
  };

  public peerStats: MatchStats = emptyMatchStats();
  public aimNext: "team0" | "team1" | null = null;

  // Spectator camera state
  public spectatorCamMode: SpectatorCamMode = "umpire";
  public spectatorFollowSlot: PlayerSlot = 0;
  private lastCheerAt = 0;

  // Host simulation & lag-compensation state
  private simTick = 0;
  private simTickAcc = 0;
  private history = new StateHistoryRing();
  private ackSeq: [number, number, number, number] = [0, 0, 0, 0];
  private slotNudgeRaw: Array<{ x: number; z: number }> = [
    { x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 },
  ];
  private slotNudgeSmooth: Array<{ x: number; z: number }> = [
    { x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 },
  ];
  private slotLastSwing: [number, number, number, number] = [-9, -9, -9, -9];
  private slotLobArmed: [boolean, boolean, boolean, boolean] = [false, false, false, false];
  private peerPings = new Map<string, number>();

  // Guest prediction & rollback state
  private predictor = new SwingPredictor();
  private nextSwingSeq = 1;
  private estHostTick = 0;
  private hostId = "";
  private preferSpectate = false;

  private evq: NetEvent[] = [];
  private lastSend = 0;
  private sentNx = 9;
  private sentNz = 9;
  private lastNudgeT = 0;
  private lastPingT = 0;
  private pingSmooth: number | null = null;
  private lastSentPhase = "";
  private lastMarksSig = "";
  private prevPhase: string | null = null;
  private hudKey = "";

  constructor(private engine: GameEngine, private ui: NetUiHooks) {
    try {
      this.myName = localStorage.getItem("lagoon-name") || "";
      this.addr = localStorage.getItem("lagoon-addr") || "";
    } catch {
      // ignore
    }

    // Hook VFX & SFX broadcasting cleanly with optional swing seq for guest prediction dedup
    this.engine.renderer.vfx.mirrorCoords = (x, z) =>
      this.engine.netCtx === "remote" && this.engine.netActorSlot % 2 === 1 ? [-x, L - z] : [x, z];
    this.engine.renderer.vfx.onBroadcastFx = (kind, args) => {
      if (this.isHostLive() && !this.engine.netPredictMode) {
        this.evq.push({ k: "fx", f: kind, a: args, seq: this.engine.netActorSeq });
      }
    };
    this.engine.sfx.onBroadcastSfx = (name, args) => {
      if (this.isHostLive() && !this.engine.netPredictMode) {
        this.evq.push({ k: "sfx", n: name, a: args, seq: this.engine.netActorSeq });
      }
    };
  }

  // ---------- QUERIES & PERSPECTIVE HELPERS ----------
  public get isSpectator(): boolean {
    return this.connected && this.mySlot === null;
  }

  public get isMirroredView(): boolean {
    return this.mySlot === 1 || this.mySlot === 3;
  }

  /** Local rendered slot index (always 0 or 2 for active players; 0 for spectators). */
  public get localFocusSlot(): PlayerSlot {
    if (this.mySlot === null) return this.spectatorFollowSlot;
    return (this.isMirroredView ? (this.mySlot ^ 1) : this.mySlot) as PlayerSlot;
  }

  /** True if at least one remote peer (player or spectator) is connected. */
  public get hasAnyPeer(): boolean {
    return this.getRemotePeerCount() > 0;
  }

  public getRemotePeerCount(): number {
    let n = 0;
    for (const p of this.peers.values()) {
      if (p.id !== this.myPeerId) n++;
    }
    return n;
  }

  public getSpectators(): RoomPeerInfo[] {
    const out: RoomPeerInfo[] = [];
    for (const p of this.peers.values()) {
      if (p.slot === null) out.push(p);
    }
    return out;
  }

  public getHumanPlayerCount(): number {
    let n = 0;
    for (const p of this.peers.values()) {
      if (p.slot !== null) n++;
    }
    return n;
  }

  public canStartMatch(): boolean {
    if (this.role !== "host" || !this.connected) return false;
    if (this.lobbyConfig.discipline === "singles") {
      return this.seats[0].kind === "human" && this.seats[1].kind === "human";
    }
    // Doubles allows 2, 3, or 4 humans (with Bot or Dual-Control filling empty seats)
    return this.getHumanPlayerCount() >= 2;
  }

  public isHostLive(): boolean {
    return this.role === "host" && this.connected && this.engine.game.mode === "net";
  }

  public isRemoteClient(): boolean {
    return this.role === "guest" && this.connected && this.engine.game.mode === "net";
  }

  public getSeatKinds(): [SeatKind, SeatKind, SeatKind, SeatKind] {
    return [this.seats[0].kind, this.seats[1].kind, this.seats[2].kind, this.seats[3].kind];
  }

  public getBotRivalId(slot: PlayerSlot): string {
    return this.seats[slot].botRivalId || DEFAULT_BOT_RIVALS[slot];
  }

  public getSlotAvatar(slot: PlayerSlot): AvatarConfig {
    const seat = this.seats[slot];
    if (seat.kind === "human" && seat.peerId) {
      const peer = this.peers.get(seat.peerId);
      if (peer) return peer.avatar;
    }
    if (seat.kind === "dual") {
      const leadSlot = (slot - 2) as PlayerSlot;
      const leadId = this.seats[leadSlot].peerId;
      const lead = leadId ? this.peers.get(leadId) : null;
      if (lead) return lead.avatar;
    }
    return CAST[seat.botRivalId]?.avatar || BUDDY_AVATAR;
  }

  public getSlotName(slot: PlayerSlot): string {
    const seat = this.seats[slot];
    if (seat.kind === "human" && seat.peerId) {
      return this.peers.get(seat.peerId)?.name || `P${slot + 1}`;
    }
    if (seat.kind === "dual") return "Partner";
    return `${CAST[seat.botRivalId]?.name || "Bot"} (AI)`;
  }

  /** Returns 4 avatars mapped into the LOCAL viewer's coordinate frame (swapping Team 0/1 if mirrored). */
  public getLocalSlotAvatars(): AvatarConfig[] {
    const canonical: AvatarConfig[] = [
      this.getSlotAvatar(0),
      this.getSlotAvatar(1),
      this.getSlotAvatar(2),
      this.getSlotAvatar(3),
    ];
    if (!this.isMirroredView) return canonical;
    return [canonical[1], canonical[0], canonical[3], canonical[2]];
  }

  /** Returns [nearTeamLabel, farTeamLabel] in the LOCAL viewer's perspective! */
  public getLocalTeamNames(): [string, string] {
    const isDbl = this.lobbyConfig.discipline === "doubles";
    const t0 = isDbl ? `${this.getSlotName(0)} & ${this.getSlotName(2)}` : this.getSlotName(0);
    const t1 = isDbl ? `${this.getSlotName(1)} & ${this.getSlotName(3)}` : this.getSlotName(1);
    return this.isMirroredView ? [t1, t0] : [t0, t1];
  }

  public getRoomSummaryName(): string {
    if (this.mode === "online" && this.roomCode) return `Room ${this.roomCode}`;
    const others = Array.from(this.peers.values()).filter((p) => p.id !== this.myPeerId);
    if (others.length === 1) return others[0].name;
    if (others.length > 1) return `${others.length + 1} in room`;
    return "LAN";
  }

  public getInviteUrl(): string {
    if (this.mode === "online" && this.roomCode) {
      const origin =
        typeof location !== "undefined" && location.protocol.startsWith("http")
          ? `${location.origin}${location.pathname}`
          : `http://localhost:${NET_PORT}/`;
      return `${origin}?room=${this.roomCode}`;
    }
    return `http://${this.ips[0] || (typeof location !== "undefined" ? location.hostname : "localhost")}:${NET_PORT}`;
  }

  // ---------- SPECTATOR CAMERA & REACTIONS ----------
  public setSpectatorCamera(mode: SpectatorCamMode, followSlot?: PlayerSlot): void {
    this.spectatorCamMode = mode;
    if (followSlot !== undefined) this.spectatorFollowSlot = followSlot;
    this.ui.updateSpectatorBar();
  }

  public cycleSpectatorCamera(): void {
    if (!this.isSpectator) return;
    if (this.spectatorCamMode === "follow") {
      const maxSlots = this.lobbyConfig.discipline === "doubles" ? 4 : 2;
      const nextSlot = ((this.spectatorFollowSlot + 1) % maxSlots) as PlayerSlot;
      if (nextSlot !== 0) {
        this.spectatorFollowSlot = nextSlot;
        this.ui.updateSpectatorBar();
        return;
      }
      this.spectatorFollowSlot = 0;
    }
    const idx = SPEC_CAM_ORDER.indexOf(this.spectatorCamMode);
    this.spectatorCamMode = SPEC_CAM_ORDER[(idx + 1) % SPEC_CAM_ORDER.length];
    this.ui.updateSpectatorBar();
  }

  public sendSpectatorCheer(): boolean {
    if (!this.isSpectator || !this.connected || !this.transport) return false;
    const now = performance.now();
    if (now - this.lastCheerAt < 2800) return false;
    this.lastCheerAt = now;
    this.transport.sendTo(this.hostId, { t: "cheer" }, "reliable");
    this.engine.sfx.crowdGasp();
    return true;
  }

  // ---------- LOBBY CONFIG & SEAT MANAGEMENT ----------
  public setSignalUrl(url: string): void {
    this.signalUrl = normalizeSignalUrl(url);
    try { localStorage.setItem("lagoon-signal-url", this.signalUrl); } catch { /* ignore */ }
  }

  public updateLobbyConfig(partial: Partial<NetLobbyConfig>): void {
    Object.assign(this.lobbyConfig, partial);
    if (this.role === "host") {
      this.recomputeSeatDefaults();
      if (this.connected) {
        this.broadcastRoster();
      }
    }
    this.ui.refreshLobby();
  }

  private recomputeSeatDefaults(): void {
    const isDbl = this.lobbyConfig.discipline === "doubles";
    const fillKind: SeatKind = this.lobbyConfig.soloDoublesMode === "dual" ? "dual" : "bot";

    if (!isDbl) {
      // Move any humans in slots 2 or 3 to spectators when switching back to Singles
      for (const s of [2, 3] as const) {
        const pid = this.seats[s].peerId;
        if (pid) {
          const p = this.peers.get(pid);
          if (p) p.slot = null;
        }
        this.seats[s].peerId = null;
        this.seats[s].kind = "bot";
      }
    } else {
      for (const s of [2, 3] as const) {
        if (!this.seats[s].peerId) {
          const leadSlot = (s - 2) as PlayerSlot;
          const leadIsHuman = this.seats[leadSlot].kind === "human";
          this.seats[s].kind = leadIsHuman ? fillKind : "bot";
        }
      }
    }
    if (!this.seats[1].peerId) this.seats[1].kind = "bot";
  }

  public requestSeat(target: PlayerSlot | "spectate"): void {
    if (!this.connected) return;
    if (this.role === "host") {
      this.assignPeerSeat(this.myPeerId, target);
      this.broadcastRoster();
      this.ui.refreshLobby();
    } else if (this.transport) {
      this.transport.sendTo(this.hostId, { t: "seat", target }, "reliable");
    }
  }

  private assignPeerSeat(peerId: string, target: PlayerSlot | "spectate"): boolean {
    const peer = this.peers.get(peerId);
    if (!peer) return false;
    // Host remains anchored in canonical Seat 0 (Team A Lead) to run the authoritative near-court simulation
    if (peer.isHost && target !== 0) return false;

    if (target === "spectate") {
      // Host always keeps slot 0 if they're the only human or stay in slot 0 during singles
      if (peer.isHost && this.engine.game.mode === "net") return false;
      if (peer.slot !== null) {
        const old = peer.slot;
        this.seats[old].peerId = null;
        this.seats[old].kind = "bot";
        peer.slot = null;
      }
      if (peerId === this.myPeerId) this.mySlot = null;
      this.recomputeSeatDefaults();
      return true;
    }

    const isDbl = this.lobbyConfig.discipline === "doubles";
    if (!isDbl && target >= 2) return false;
    if (this.seats[target].kind === "human" && this.seats[target].peerId && this.seats[target].peerId !== peerId) {
      return false; // Seat occupied
    }

    if (peer.slot !== null) {
      this.seats[peer.slot].peerId = null;
      this.seats[peer.slot].kind = "bot";
    }
    this.seats[target].peerId = peerId;
    this.seats[target].kind = "human";
    peer.slot = target;
    if (peerId === this.myPeerId) this.mySlot = target;
    this.recomputeSeatDefaults();
    return true;
  }

  private pickInitialSeat(wantSpectate: boolean): PlayerSlot | null {
    if (wantSpectate || this.engine.game.mode === "net") return null;
    const order: PlayerSlot[] = this.lobbyConfig.discipline === "doubles" ? [1, 2, 3, 0] : [1, 0];
    for (const s of order) {
      if (this.seats[s].kind !== "human" || !this.seats[s].peerId) return s;
    }
    return null;
  }

  private broadcastRoster(): void {
    if (this.role !== "host" || !this.transport) return;
    this.transport.broadcast(
      {
        t: "roster",
        cfg: this.lobbyConfig,
        seats: this.seats,
        peers: Array.from(this.peers.values()),
        live: this.engine.game.mode === "net" ? 1 : 0,
      },
      "reliable"
    );
  }

  // ---------- CONNECT / HOST / JOIN / CLOSE ----------
  public hostOnline(nameRaw: string, customCode?: string): void {
    const code = customCode && isValidRoomCode(normalizeRoomCode(customCode))
      ? normalizeRoomCode(customCode)
      : generateRoomCode();
    this.openSession("online", "host", { nameRaw, roomCode: code, spectate: false });
  }

  public joinOnline(codeRaw: string, nameRaw: string, spectate = false): void {
    const code = normalizeRoomCode(codeRaw);
    if (!isValidRoomCode(code)) {
      this.err = "Enter a valid 4-letter room code (e.g. PALM).";
      this.ui.refreshLobby();
      return;
    }
    this.openSession("online", "guest", { nameRaw, roomCode: code, spectate });
  }

  public connectLan(role: "host" | "guest", addrRaw: string, nameRaw: string, spectate = false): void {
    let host = String(addrRaw || "").trim().replace(/^(wss?|https?):\/\//i, "").replace(/\/.*$/, "");
    if (!host) host = "localhost";
    if (!/:\d+$/.test(host) && !host.startsWith("[")) host += ":" + NET_PORT;
    if (role === "guest") {
      this.addr = String(addrRaw || "").trim();
      try { localStorage.setItem("lagoon-addr", this.addr); } catch { /* ignore */ }
    }
    this.openSession("lan", role, { nameRaw, lanHost: host, spectate });
  }

  private openSession(
    mode: NetMode,
    role: "host" | "guest",
    opts: { nameRaw: string; roomCode?: string; lanHost?: string; spectate: boolean }
  ): void {
    this.close();
    this.mode = mode;
    this.role = role;
    this.err = "";
    this.roomCode = opts.roomCode || "";
    this.target = mode === "online" ? `Room ${this.roomCode}` : (opts.lanHost || "localhost");
    this.preferSpectate = opts.spectate;
    this.myName = (opts.nameRaw || this.myName || (role === "host" ? "Host" : opts.spectate ? "Spectator" : "Player"))
      .trim()
      .slice(0, 14) || "Player";
    try { localStorage.setItem("lagoon-name", this.myName); } catch { /* ignore */ }

    const handlers = {
      onReady: (localId: string) => {
        this.myPeerId = localId;
        this.connected = true;
        if (role === "host") {
          this.hostId = localId;
          this.mySlot = 0;
          this.peers.set(localId, {
            id: localId,
            name: this.myName,
            avatar: structuredClone(this.engine.career.avatar),
            slot: 0,
            isHost: true,
            pingMs: 0,
          });
          this.seats[0] = { kind: "human", peerId: localId, botRivalId: DEFAULT_BOT_RIVALS[0] };
          this.recomputeSeatDefaults();
        }
        this.ui.refreshLobby();
      },
      onPeerOpen: (peerId: string) => {
        if (role === "guest") {
          if (this.mode === "online") this.hostId = peerId;
          this.sendJoinHello(peerId);
        } else if (this.mode === "lan") {
          // On LAN, host broadcasts its roster so arriving guests discover hostId immediately
          this.broadcastRoster();
        }
        this.ui.refreshLobby();
      },
      onPeerClose: (peerId: string, reason?: string) => {
        this.handlePeerDisconnect(peerId, reason);
      },
      onMessage: (fromPeerId: string, msg: Record<string, unknown>) => {
        this.onMessage(fromPeerId, msg);
      },
      onSysInfo: (ips: string[]) => {
        this.ips = ips;
        this.ui.refreshLobby();
      },
      onError: (message: string) => {
        this.err = message;
        this.ui.refreshLobby();
      },
      onClose: (reason?: string) => {
        const wasPlaying = this.engine.game.mode === "net";
        const prevErr = this.err;
        this.close();
        this.err = prevErr || reason || "Disconnected.";
        if (wasPlaying) {
          this.ui.showTitle();
          this.ui.showMsg("Match Ended", this.err, 3400);
        } else {
          this.ui.refreshLobby();
        }
      },
    };

    this.transport =
      mode === "online"
        ? new WebRtcTransport(this.roomCode, role === "host", this.signalUrl, handlers)
        : new LanWsTransport(opts.lanHost || `localhost:${NET_PORT}`, role === "host", handlers);

    this.ui.refreshLobby();
  }

  private sendJoinHello(toPeerId?: string): void {
    if (!this.transport) return;
    const msg = {
      t: "hello",
      name: this.myName,
      avatar: this.engine.career.avatar,
      spec: this.preferSpectate ? 1 : 0,
    };
    if (toPeerId && this.mode === "online") this.transport.sendTo(toPeerId, msg, "reliable");
    else this.transport.broadcast(msg, "reliable");
  }

  private handlePeerDisconnect(peerId: string, _reason?: string): void {
    if (this.role === "guest" && peerId === this.hostId) {
      const wasPlaying = this.engine.game.mode === "net";
      this.close();
      this.err = "The host closed the room.";
      if (wasPlaying) {
        this.ui.showTitle();
        this.ui.showMsg("Match Ended", "The host left the match.", 3400);
      } else {
        this.ui.refreshLobby();
      }
      return;
    }

    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.peers.delete(peerId);
    this.peerPings.delete(peerId);

    if (this.role === "host") {
      if (peer.slot !== null) {
        const lostSlot = peer.slot;
        this.seats[lostSlot].peerId = null;
        this.seats[lostSlot].kind = "bot";
        this.recomputeSeatDefaults();
        if (this.engine.game.mode === "net") {
          if (this.lobbyConfig.discipline === "singles") {
            // 1v1 opponent disconnected -> end match cleanly
            this.ui.showTitle();
            this.ui.showMsg("Match Ended", `${peer.name} left the match.`, 3200);
          } else {
            // In Doubles, AI seamlessly takes over the disconnected seat so the other players keep playing!
            this.ui.showMsg("AI Subbed In", `${peer.name} left — AI took over`, 2200);
            this.evq.push({ k: "msg", a: ["AI Subbed In", `${peer.name} left — AI took over`, 2200] });
            this.ui.updateHud();
            this.engine.updateLed();
          }
        }
      }
      this.broadcastRoster();
      this.ui.refreshLobby();
      this.ui.updateSpectatorBar();
    }
  }

  public close(): void {
    const tr = this.transport;
    this.transport = null;
    this.connected = false;
    this.role = null;
    this.myPeerId = "";
    this.mySlot = null;
    this.hostId = "";
    this.peers.clear();
    this.peerPings.clear();
    this.seats = [
      { kind: "human", peerId: null, botRivalId: DEFAULT_BOT_RIVALS[0] },
      { kind: "bot", peerId: null, botRivalId: DEFAULT_BOT_RIVALS[1] },
      { kind: "bot", peerId: null, botRivalId: DEFAULT_BOT_RIVALS[2] },
      { kind: "bot", peerId: null, botRivalId: DEFAULT_BOT_RIVALS[3] },
    ];
    this.pingMs = null;
    this.pingSmooth = null;
    this.lastSentPhase = "";
    this.lastMarksSig = "";
    this.prevPhase = null;
    this.hudKey = "";
    this.evq.length = 0;
    this.history.clear();
    this.predictor.reset();
    this.ackSeq = [0, 0, 0, 0];
    this.ui.updatePing(null);
    this.ui.updateSpectatorBar();
    this.ui.onChatReset?.();
    if (tr) tr.close();
  }

  public leave(): void {
    this.transport?.broadcast({ t: "bye" }, "reliable");
    this.close();
    this.err = "";
    this.ui.showTitle();
  }

  public pushEvent(e: { k: string; a: unknown[]; slot?: PlayerSlot; seq?: number }): void {
    if (this.isHostLive() && !this.engine.netPredictMode) {
      this.evq.push(e);
      if (this.evq.length > 260) this.evq.splice(0, 120);
    }
  }

  public sendChat(text: string, quick = false): boolean {
    if (!this.connected || !this.transport || !this.hasAnyPeer) return false;
    const clean = String(text || "").trim().slice(0, 160);
    if (!clean) return false;
    const senderSlot: PlayerSlot | "spec" = this.mySlot === null ? "spec" : this.mySlot;
    if (this.role === "host") {
      this.transport.broadcast({ t: "chat", name: this.myName, slot: senderSlot, text: clean, q: quick ? 1 : 0 }, "reliable");
    } else {
      this.transport.sendTo(this.hostId, { t: "chat", name: this.myName, slot: senderSlot, text: clean, q: quick ? 1 : 0 }, "reliable");
    }
    return true;
  }

  // ---------- PROTOCOL MESSAGE DISPATCH ----------
  private onMessage(fromPeerId: string, m: Record<string, unknown>): void {
    switch (m.t) {
      case "hello": {
        if (this.role !== "host") return;
        const name = String(m.name || "Player").trim().slice(0, 14) || "Player";
        const avatar: AvatarConfig = m.avatar && typeof m.avatar === "object"
          ? { ...BUDDY_AVATAR, ...(m.avatar as Partial<AvatarConfig>) }
          : structuredClone(BUDDY_AVATAR);
        const existing = this.peers.get(fromPeerId);
        const wantSpec = !!m.spec;
        let slot: PlayerSlot | null = existing ? existing.slot : this.pickInitialSeat(wantSpec);

        this.peers.set(fromPeerId, {
          id: fromPeerId,
          name,
          avatar,
          slot,
          isHost: false,
          pingMs: this.peerPings.get(fromPeerId) ?? null,
        });
        if (slot !== null) {
          this.seats[slot].peerId = fromPeerId;
          this.seats[slot].kind = "human";
        }
        this.recomputeSeatDefaults();
        this.broadcastRoster();

        if (!existing) {
          this.engine.sfx.ui();
          const roleTxt = slot === null ? "watching as Spectator" : `joined seat P${slot + 1}`;
          this.ui.showMsg(slot === null ? "Spectator Joined" : "Player Joined!", `${name} ${roleTxt}`, 1600);
        }

        // Mid-match spectator sync! Immediately put late joiner into live match view
        if (this.engine.game.mode === "net" && this.transport) {
          this.transport.sendTo(fromPeerId, {
            t: "start",
            cfg: this.lobbyConfig,
            seats: this.seats,
            peers: Array.from(this.peers.values()),
            midMatch: 1,
          }, "reliable");
          this.sendImmediateSnapshotTo(fromPeerId);
        }
        this.ui.refreshLobby();
        this.ui.updateSpectatorBar();
        break;
      }

      case "roster": {
        if (this.role !== "guest") return;
        this.hostId = fromPeerId;
        if (m.cfg && typeof m.cfg === "object") {
          Object.assign(this.lobbyConfig, m.cfg);
        }
        if (Array.isArray(m.seats) && m.seats.length === 4) {
          this.seats = m.seats as [SeatAssignment, SeatAssignment, SeatAssignment, SeatAssignment];
        }
        if (Array.isArray(m.peers)) {
          this.peers.clear();
          for (const raw of m.peers as RoomPeerInfo[]) {
            this.peers.set(raw.id, raw);
            if (raw.id === this.myPeerId) {
              this.mySlot = raw.slot;
            }
          }
          // If host doesn't know us yet (e.g. LAN broadcast arrived before hello), send hello now
          if (this.myPeerId && !this.peers.has(this.myPeerId)) {
            this.sendJoinHello(this.hostId);
          }
        }
        this.ui.refreshLobby();
        this.ui.updateSpectatorBar();
        if (this.engine.game.mode === "net") {
          this.ui.updateHud();
          this.engine.updateLed();
        }
        break;
      }

      case "seat": {
        if (this.role !== "host" || this.engine.game.mode === "net") return;
        const target = m.target === "spectate" ? "spectate" : (Number(m.target) as PlayerSlot);
        if (target === "spectate" || (target >= 0 && target <= 3)) {
          if (this.assignPeerSeat(fromPeerId, target)) {
            this.broadcastRoster();
            this.ui.refreshLobby();
          }
        }
        break;
      }

      case "ping": {
        this.transport?.sendTo(fromPeerId, { t: "pong", ts: m.ts }, "reliable");
        break;
      }

      case "pong": {
        if (typeof m.ts === "number") {
          const rtt = Math.max(1, performance.now() - m.ts);
          if (this.role === "host") {
            const prev = this.peerPings.get(fromPeerId);
            const smooth = prev === undefined ? rtt : prev * 0.65 + rtt * 0.35;
            this.peerPings.set(fromPeerId, Math.round(smooth));
            const p = this.peers.get(fromPeerId);
            if (p) p.pingMs = Math.round(smooth);
            // Display average or highest active player ping on host HUD
            let maxPing = 0;
            for (const v of this.peerPings.values()) if (v > maxPing) maxPing = v;
            this.pingMs = maxPing || null;
            this.ui.updatePing(this.pingMs);
          } else {
            this.pingSmooth = this.pingSmooth === null ? rtt : this.pingSmooth * 0.65 + rtt * 0.35;
            this.pingMs = Math.round(this.pingSmooth);
            this.ui.updatePing(this.pingMs);
          }
        }
        break;
      }

      case "start": {
        if (this.role === "guest") this.guestStart(fromPeerId, m);
        break;
      }

      case "s": {
        if (this.role === "guest") this.applySnapshot(m);
        break;
      }

      case "sw": {
        if (this.role === "host") {
          const peer = this.peers.get(fromPeerId);
          if (!peer || peer.slot === null) return;
          this.handleRemoteSwing(
            peer.slot,
            Number(m.seq) || 0,
            Number(m.tk) || this.simTick,
            Number(m.p) || 0,
            String(m.i) as ShotIntent,
            clamp(Number(m.nx) || 0, -1, 1),
            clamp(Number(m.nz) || 0, -1, 1)
          );
        }
        break;
      }

      case "nud": {
        if (this.role === "host") {
          const peer = this.peers.get(fromPeerId);
          if (!peer || peer.slot === null) return;
          this.slotNudgeRaw[peer.slot].x = clamp(Number(m.x) || 0, -1, 1);
          this.slotNudgeRaw[peer.slot].z = clamp(Number(m.z) || 0, -1, 1);
        }
        break;
      }

      case "chat": {
        const text = typeof m.text === "string" ? m.text.trim().slice(0, 160) : "";
        if (!text) return;
        if (this.role === "host") {
          const sender = this.peers.get(fromPeerId);
          const sName = sender?.name || String(m.name || "Player");
          const sSlot: PlayerSlot | "spec" = sender ? (sender.slot === null ? "spec" : sender.slot) : "spec";
          this.ui.onChat?.(sName, sSlot, text, !!m.q);
          // Re-broadcast to all other peers in the room so everyone (4 players + spectators) sees it!
          this.transport?.broadcast({ t: "chat", name: sName, slot: sSlot, text, q: m.q ? 1 : 0 }, "reliable", fromPeerId);
        } else {
          const sName = String(m.name || "Player");
          const rawSlot = m.slot;
          let mappedSlot: PlayerSlot | "spec" = "spec";
          if (typeof rawSlot === "number" && rawSlot >= 0 && rawSlot <= 3) {
            mappedSlot = (this.isMirroredView ? (rawSlot ^ 1) : rawSlot) as PlayerSlot;
          }
          this.ui.onChat?.(sName, mappedSlot, text, !!m.q);
        }
        break;
      }

      case "cheer": {
        if (this.role === "host" && this.engine.game.mode === "net") {
          this.engine.crowd.cheer = Math.min(1, this.engine.crowd.cheer + 0.35);
          this.engine.crowd.hop = 0;
          this.engine.sfx.crowdGasp();
        }
        break;
      }

      case "bye": {
        this.handlePeerDisconnect(fromPeerId, "Left the room");
        break;
      }
    }
  }

  // ---------- 180° WORLD MIRROR (ONLY FOR TEAM 1 SLOTS 1 & 3) ----------
  private mirrorPlayer(p: PlayerState): void {
    p.x = -p.x; p.tx = -p.tx; p.homeX = -p.homeX;
    p.z = L - p.z; p.tz = L - p.tz; p.homeZ = L - p.homeZ;
    p.vx = -p.vx; p.vz = -p.vz; p.prevVx = -p.prevVx; p.prevVz = -p.prevVz;
    if (p.aimTarget) p.aimTarget = { x: -p.aimTarget.x, z: L - p.aimTarget.z };
  }

  private mirrorWorld(): void {
    const ps = this.engine.players;
    [ps[0], ps[1]] = [ps[1], ps[0]];
    [ps[2], ps[3]] = [ps[3], ps[2]];
    ps[0].slot = 0; ps[0].team = 0;
    ps[1].slot = 1; ps[1].team = 1;
    ps[2].slot = 2; ps[2].team = 0;
    ps[3].slot = 3; ps[3].team = 1;
    for (const p of ps) this.mirrorPlayer(p);

    const b = this.engine.ball;
    b.x = -b.x; b.z = L - b.z; b.vx = -b.vx; b.vz = -b.vz;
    b.w = { x: -b.w.x, y: b.w.y, z: -b.w.z };
    if (b.lastHitter >= 0) b.lastHitter = 1 - b.lastHitter;
    if (b.lastSlot >= 0) b.lastSlot = b.lastSlot ^ 1;

    const g = this.engine.game;
    g.server = (1 - g.server) as 0 | 1;
    g.serverSlot = g.serverSlot ^ 1;
    g.pts = [g.pts[1], g.pts[0]];
    g.tbPts = [g.tbPts[1], g.tbPts[0]];
    g.games = [g.games[1], g.games[0]];
    if (g.winner >= 0) g.winner = (1 - g.winner) as 0 | 1;

    for (const q of this.engine.trail) { q.x = -q.x; q.z = L - q.z; }
    for (const m of this.engine.marks) { m.x = -m.x; m.z = L - m.z; }
  }

  // ---------- HOST MATCH EXECUTION ----------
  public startHostMatch(): void {
    if (!this.canStartMatch() || !this.transport) return;
    this.evq.length = 0;
    this.history.clear();
    this.simTick = 0;
    this.simTickAcc = 0;
    this.ackSeq = [0, 0, 0, 0];
    this.slotLastSwing = [-9, -9, -9, -9];
    this.slotLobArmed = [false, false, false, false];
    for (let i = 0; i < 4; i++) {
      this.slotNudgeRaw[i].x = this.slotNudgeRaw[i].z = 0;
      this.slotNudgeSmooth[i].x = this.slotNudgeSmooth[i].z = 0;
    }
    this.aimNext = null;
    this.recomputeSeatDefaults();

    this.engine.startMatch(
      {
        discipline: this.lobbyConfig.discipline,
        format: this.lobbyConfig.format,
        venue: this.lobbyConfig.venue,
        sky: this.lobbyConfig.sky,
      },
      "net"
    );
    this.ui.hideOverlayForMatch();
    this.ui.updateSpectatorBar();

    this.transport.broadcast(
      {
        t: "start",
        cfg: this.lobbyConfig,
        seats: this.seats,
        peers: Array.from(this.peers.values()),
        midMatch: 0,
      },
      "reliable"
    );
  }

  /**
   * Executes a remote player's swing on the host with lag-compensated state rewind
   * (capped at 150ms), deterministic seeded variance (`seed = seq`), and 240Hz
   * fast-forward catch-up so high-ping guests get fair sweet-spot timing!
   */
  private handleRemoteSwing(
    slot: PlayerSlot,
    seq: number,
    clientTick: number,
    power: number,
    intent: ShotIntent,
    nx: number,
    nz: number
  ): void {
    if (!this.isHostLive() || this.engine.game.paused) return;
    const valid: ShotIntent[] = ["drive", "slice", "lob", "drop"];
    const safeIntent: ShotIntent = valid.includes(intent) ? intent : "drive";

    const isTeam1 = slot === 1 || slot === 3;
    const localSlot: 0 | 2 = isTeam1 ? ((slot ^ 1) as 0 | 2) : (slot as 0 | 2);
    const allowDual = this.engine.isTeamDualControl(isTeam1 ? 1 : 0);

    // Lag compensation: rewind ball & swinging player to clientTick (clamped to <=150ms) during rally hits
    const ph = this.engine.game.phase;
    const canRewind = ph === "rally" && this.engine.ball.live;
    const hist = canRewind ? this.history.lookup(clientTick) : null;
    const savedBall = hist && hist.rewindTicks > 0 ? snapshotBall(this.engine.ball) : null;
    const savedPos = hist && hist.rewindTicks > 0
      ? this.engine.players.map((p) => ({ x: p.x, z: p.z }))
      : null;

    if (hist && hist.rewindTicks > 0) {
      restoreBall(this.engine.ball, hist.frame.ball);
      for (let i = 0; i < 4; i++) {
        this.engine.players[i].x = hist.frame.players[i].x;
        this.engine.players[i].z = hist.frame.players[i].z;
      }
    }

    const sx = this.engine.nudge.x;
    const sz = this.engine.nudge.z;
    const savedLastSwing = this.engine.game.lastSwing;
    const savedLob = this.engine.game.lobArmed;

    if (isTeam1) this.mirrorWorld();
    this.engine.netCtx = "remote";
    this.engine.netActorSlot = slot;
    this.engine.netActorSeq = seq;
    this.engine.sfx.panFlip = isTeam1 ? -1 : 1;
    this.engine.nudge.x = nx;
    this.engine.nudge.z = nz;
    this.engine.game.lastSwing = this.slotLastSwing[slot];
    this.engine.game.lobArmed = this.slotLobArmed[slot];

    let result = { connected: false, isServe: false, isToss: false };
    try {
      result = this.engine.executeNearSlotSwing(localSlot, clamp(power, 0, 1), safeIntent, {
        seed: seq,
        allowDualControl: allowDual,
      });
    } finally {
      this.slotLastSwing[slot] = this.engine.game.lastSwing;
      this.slotLobArmed[slot] = this.engine.game.lobArmed;
      this.engine.game.lastSwing = savedLastSwing;
      this.engine.game.lobArmed = savedLob;
      this.engine.nudge.x = sx;
      this.engine.nudge.z = sz;
      this.engine.netCtx = "local";
      this.engine.netActorSlot = 0;
      this.engine.netActorSeq = undefined;
      this.engine.sfx.panFlip = 1;
      if (isTeam1) this.mirrorWorld();
    }

    // Restore present-time players; if swing connected on a rewound frame, fast-forward the launched ball to host present!
    if (savedPos) {
      for (let i = 0; i < 4; i++) {
        // Keep dive lunge offset if this slot dived
        if (i === slot && this.engine.players[i].diveT > 0.55) continue;
        this.engine.players[i].x = savedPos[i].x;
        this.engine.players[i].z = savedPos[i].z;
      }
    }
    if (savedBall) {
      if (result.connected && hist && hist.rewindTicks > 0) {
        fastForwardBall(this.engine.ball, hist.rewindTicks * SIM_TICK_DT, this.engine.getActiveVenue(), true, this.engine.netHit);
      } else if (!result.connected) {
        // Whiffed: restore present-time authoritative ball seamlessly!
        restoreBall(this.engine.ball, savedBall);
      }
    }

    if (seq > this.ackSeq[slot]) this.ackSeq[slot] = seq;
    // Flush an immediate reliable snapshot with the ack so the guest reconciles ASAP!
    this.evq.push({ k: "ack", slot, seq, a: [result.connected ? 1 : 0] });
  }

  public hostStep(dt: number): void {
    if (!this.isHostLive()) return;

    // Advance 60Hz host tick & push lag-compensation history snapshot
    this.simTickAcc += dt;
    while (this.simTickAcc >= SIM_TICK_DT) {
      this.simTickAcc -= SIM_TICK_DT;
      this.simTick++;
      this.history.push(this.simTick, this.engine.ball, this.engine.players);
    }

    // Smooth remote player nudges
    const k = clamp(dt * 12, 0, 1);
    for (let s = 1; s < 4; s++) {
      this.slotNudgeSmooth[s].x = lerp(this.slotNudgeSmooth[s].x, this.slotNudgeRaw[s].x, k);
      this.slotNudgeSmooth[s].z = lerp(this.slotNudgeSmooth[s].z, this.slotNudgeRaw[s].z, k);
    }

    if (this.aimNext === "team1") {
      this.mirrorWorld();
      this.engine.aimNearTeam();
      this.mirrorWorld();
    } else if (this.aimNext === "team0") {
      this.engine.aimNearTeam();
    }
    this.aimNext = null;

    // Apply Team 0 Partner nudge (slot 2) directly in host space
    if (this.lobbyConfig.discipline === "doubles" && this.seats[2].kind === "human") {
      this.engine.applyNudgeForSlot(2, this.slotNudgeSmooth[2].x, this.slotNudgeSmooth[2].z, dt);
    }

    // Apply Team 1 nudges (slots 1 & 3) in mirrored space
    const team1HasHuman = this.seats[1].kind === "human" || (this.lobbyConfig.discipline === "doubles" && this.seats[3].kind === "human");
    if (team1HasHuman) {
      this.mirrorWorld();
      if (this.seats[1].kind === "human") {
        this.engine.applyNudgeForSlot(0, this.slotNudgeSmooth[1].x, this.slotNudgeSmooth[1].z, dt);
      }
      if (this.lobbyConfig.discipline === "doubles" && this.seats[3].kind === "human") {
        this.engine.applyNudgeForSlot(2, this.slotNudgeSmooth[3].x, this.slotNudgeSmooth[3].z, dt);
      }
      this.mirrorWorld();
    }
  }

  private packPlayer(p: PlayerState) {
    return [
      r2(p.x), r2(p.z), r2(p.vx), r2(p.vz), r2(p.swingT), r2(p.swingDur), p.swingType,
      r2(p.splitT), r2(p.tossArm), r2(p.lungeT), p.lungeDir, r2(p.diveT), p.diveDir,
      r2(p.emoteT), p.emote,
      p.aimTarget ? r2(p.aimTarget.x) : null, p.aimTarget ? r2(p.aimTarget.z) : null,
      p.role === "net" ? 1 : 0,
    ];
  }

  private buildSnapshotPayload(includeEvents: boolean): Record<string, unknown> {
    const g = this.engine.game;
    const b = this.engine.ball;
    const activePlayers = g.config.discipline === "doubles" ? this.engine.players : this.engine.players.slice(0, 2);

    const payload: Record<string, unknown> = {
      t: "s",
      tk: this.simTick,
      ack: [this.ackSeq[0], this.ackSeq[1], this.ackSeq[2], this.ackSeq[3]],
      ph: g.phase,
      pts: g.pts,
      tb: g.tiebreak ? 1 : 0,
      tbp: g.tbPts,
      gm: g.games,
      sv: g.server,
      svs: g.serverSlot,
      fl: g.faults,
      ra: g.rally,
      tt: r2(g.tossT),
      wn: g.winner,
      b: [
        r3(b.x), r3(b.y), r3(b.z), r2(b.vx), r2(b.vy), r2(b.vz),
        r2(b.w.x), r2(b.w.y), r2(b.w.z),
        b.visible ? 1 : 0, b.live ? 1 : 0, b.rocket ? 1 : 0, b.crit ? 1 : 0,
        b.shotTag, b.lastHitter, b.bounceCount, b.serve ? 1 : 0, b.splashed ? 1 : 0,
      ],
      ps: activePlayers.map((p) => this.packPlayer(p)),
      cr: r2(this.engine.crowd.cheer),
    };

    if (g.phase === "matchOver") payload.st = g.stats;
    if (this.engine.netHit.amp > 0.002) {
      payload.nh = [r2(this.engine.netHit.x), r2(this.engine.netHit.y), r2(this.engine.netHit.amp), r2(this.engine.netHit.elapsed)];
    }
    const mkSig =
      this.engine.marks.length === 0
        ? ""
        : this.engine.marks.map((m) => `${r2(m.x)},${r2(m.z)},${m.out ? 1 : 0}`).join(";");
    if (mkSig !== this.lastMarksSig || includeEvents) {
      this.lastMarksSig = mkSig;
      payload.mk = this.engine.marks.map((m) => [r2(m.x), r2(m.z), m.out ? 1 : 0, r2(m.age)]);
    }
    if (includeEvents && this.evq.length > 0) {
      payload.ev = this.evq.splice(0);
    }
    return payload;
  }

  private sendImmediateSnapshotTo(peerId: string): void {
    if (!this.transport) return;
    const payload = this.buildSnapshotPayload(false);
    this.transport.sendTo(peerId, payload, "reliable");
  }

  public hostSendSnapshot(): void {
    const nowMs = performance.now();
    if (this.connected && this.transport && this.hasAnyPeer && nowMs - this.lastPingT > 1500) {
      this.lastPingT = nowMs;
      this.transport.broadcast({ t: "ping", ts: nowMs }, "reliable");
    }
    if (!this.isHostLive() || !this.transport) return;

    const g = this.engine.game;
    const hasEvents = this.evq.length > 0;
    const phaseChanged = g.phase !== this.lastSentPhase;
    const urgent = hasEvents || phaseChanged;

    // 30Hz UDP snapshots during live rallies (WebRTC unreliable channel), 10Hz when idle!
    const livePhase = g.phase === "rally" || g.phase === "toss" || g.phase === "cpuServe";
    const interval = livePhase ? (this.mode === "online" ? 1 / 30 : 0.04) : 0.1;
    if (!urgent && g.now - this.lastSend < interval && g.now >= this.lastSend) return;

    this.lastSend = g.now;
    this.lastSentPhase = g.phase;

    const payload = this.buildSnapshotPayload(hasEvents);
    const delivery = urgent ? "reliable" : "unreliable";

    // Per-peer backpressure guard for non-urgent snapshots
    for (const peer of this.peers.values()) {
      if (peer.id === this.myPeerId) continue;
      if (!urgent && this.transport.getBufferedAmount(peer.id) > 8192) continue;
      this.transport.sendTo(peer.id, payload, delivery);
    }
  }

  // ---------- GUEST 0ms PREDICTION & ROLLBACK ----------
  public guestSwing(power: number, intent: ShotIntent): void {
    if (this.isSpectator || this.mySlot === null || !this.transport) return;
    const g = this.engine.game;
    if (g.now - g.lastSwing < 0.22) return;
    if (g.phase === "title" || g.phase === "matchOver") return;
    if (g.lobArmed && intent !== "slice" && intent !== "drop") intent = "lob";

    const seq = this.nextSwingSeq++;
    const localSlot = this.localFocusSlot as 0 | 2;
    const allowDual = this.engine.isTeamDualControl(0);

    // Send swing immediately over reliable "ctrl" channel with our current estimated host ball tick!
    this.transport.sendTo(
      this.hostId,
      {
        t: "sw",
        seq,
        tk: Math.round(this.estHostTick),
        p: r3(power),
        i: intent,
        nx: r2(this.engine.nudge.x),
        nz: r2(this.engine.nudge.z),
      },
      "reliable"
    );

    // 0ms LOCAL PREDICTION: execute the exact same deterministic swing locally right now!
    const res = this.engine.executeNearSlotSwing(localSlot, power, intent, {
      seed: seq,
      allowDualControl: allowDual,
      predictOnly: true,
    });

    if (res.connected) {
      this.predictor.begin({
        seq,
        sentAtMs: performance.now(),
        predictedHit: !res.isToss,
        predictedPhase: this.engine.game.phase,
        predictedHitter: 0,
      });
    }
  }

  private guestStart(fromPeerId: string, m: Record<string, unknown>): void {
    this.hostId = fromPeerId;
    this.engine.sfx.init();
    const g = this.engine.game;
    g.mode = "net";
    g.paused = false;

    if (m.cfg && typeof m.cfg === "object") {
      Object.assign(this.lobbyConfig, m.cfg);
    }
    if (Array.isArray(m.seats) && m.seats.length === 4) {
      this.seats = m.seats as [SeatAssignment, SeatAssignment, SeatAssignment, SeatAssignment];
    }
    if (Array.isArray(m.peers)) {
      this.peers.clear();
      for (const raw of m.peers as RoomPeerInfo[]) {
        this.peers.set(raw.id, raw);
        if (raw.id === this.myPeerId) this.mySlot = raw.slot;
      }
    }

    g.config.discipline = this.lobbyConfig.discipline;
    g.config.format = this.lobbyConfig.format;
    g.config.venue = VENUES[this.lobbyConfig.venue as VenueId] ? this.lobbyConfig.venue : "pier";
    g.config.sky = PRESETS[this.lobbyConfig.sky as SkyId] ? this.lobbyConfig.sky : "golden";

    Object.assign(g, {
      pts: [0, 0], tbPts: [0, 0], tiebreak: false, games: [0, 0],
      server: this.isMirroredView ? 1 : 0,
      serverSlot: this.isMirroredView ? 1 : 0,
      faults: 0, winner: -1, hitstop: 0, slowMo: 0, phase: "serveReady",
    });
    this.prevPhase = null;
    this.hudKey = "";
    this.predictor.reset();
    this.engine.marks.length = 0;
    this.engine.trail.length = 0;
    for (const p of this.engine.players) {
      p.netX = undefined;
      p.swingTrail.length = 0;
    }

    this.ui.hideOverlayForMatch();
    this.ui.updateHud();
    this.ui.setHint();
    this.ui.updateSpectatorBar();
    this.engine.renderer.snapGameplayCam(this.engine.players[this.localFocusSlot] || this.engine.you);
    this.engine.music.setMood("rally", 0);

    const [t0, t1] = this.getLocalTeamNames();
    const banner = this.isSpectator
      ? `Spectating: ${t0} vs ${t1}`
      : `vs ${t1}`;
    const sub = this.isSpectator
      ? `${VENUES[g.config.venue].name} · Press Tab to switch cameras`
      : `${VENUES[g.config.venue].name} · ${this.lobbyConfig.discipline === "doubles" ? "Doubles 2v2" : "Singles 1v1"}`;
    this.ui.showMsg(banner, sub, 1900);
  }

  private unpackPlayer(p: PlayerState, a: unknown[], mirrored: boolean): void {
    const nx = mirrored ? -Number(a[0]) : Number(a[0]);
    const nz = mirrored ? L - Number(a[1]) : Number(a[1]);
    if (p.netX === undefined) { p.x = p.tx = nx; p.z = p.tz = nz; }
    p.netX = nx; p.netZ = nz;
    p.vx = mirrored ? -Number(a[2]) : Number(a[2]);
    p.vz = mirrored ? -Number(a[3]) : Number(a[3]);
    p.swingT = Number(a[4]); p.swingDur = Number(a[5]); p.swingType = String(a[6]) as SwingAnimType;
    p.splitT = Number(a[7]); p.tossArm = Number(a[8]);
    p.lungeT = Number(a[9]); p.lungeDir = Number(a[10]);
    p.diveT = Number(a[11]); p.diveDir = Number(a[12]);
    p.emoteT = Number(a[13]); p.emote = String(a[14]) as "win" | "lose";
    p.aimTarget = a[15] == null ? null : { x: mirrored ? -Number(a[15]) : Number(a[15]), z: mirrored ? L - Number(a[16]) : Number(a[16]) };
    if (a[17] !== undefined) p.role = a[17] ? "net" : "baseline";
  }

  private applySnapshot(s: Record<string, unknown>): void {
    const g = this.engine.game;
    if (g.mode !== "net") return;
    const mir = this.isMirroredView;
    const nowMs = performance.now();

    if (typeof s.tk === "number") {
      this.estHostTick = s.tk;
    }

    const ackArr = (Array.isArray(s.ack) ? s.ack : [0, 0, 0, 0]) as number[];
    const myAck = this.mySlot !== null ? (ackArr[this.mySlot] || 0) : 0;
    const holdingPred = this.predictor.shouldHoldPrediction(myAck, nowMs);

    const pts = s.pts as [number, number];
    const tbp = (s.tbp as [number, number]) || [0, 0];
    const gm = s.gm as [number, number];
    if (!holdingPred) {
      g.phase = s.ph as GameEngine["game"]["phase"];
      g.tossT = Number(s.tt);
    }
    g.pts = mir ? [pts[1], pts[0]] : [pts[0], pts[1]];
    g.tiebreak = !!s.tb;
    g.tbPts = mir ? [tbp[1], tbp[0]] : [tbp[0], tbp[1]];
    g.games = mir ? [gm[1], gm[0]] : [gm[0], gm[1]];
    g.server = mir ? ((1 - Number(s.sv)) as 0 | 1) : (Number(s.sv) as 0 | 1);
    const rawSvs = s.svs !== undefined ? Number(s.svs) : Number(s.sv);
    g.serverSlot = mir ? (rawSvs ^ 1) : rawSvs;
    g.faults = Number(s.fl);
    g.rally = Number(s.ra);
    g.winner = Number(s.wn) >= 0 ? (mir ? ((1 - Number(s.wn)) as 0 | 1) : (Number(s.wn) as 0 | 1)) : -1;
    if (s.st && typeof s.st === "object") this.peerStats = s.st as MatchStats;

    // Decode authoritative ball into local viewer frame
    const b = s.b as unknown[];
    const cur = this.engine.ball;
    const rawHitter = Number(b[14]);
    const authBall: GameEngine["ball"] = {
      ...cur,
      x: mir ? -Number(b[0]) : Number(b[0]),
      y: Number(b[1]),
      z: mir ? L - Number(b[2]) : Number(b[2]),
      vx: mir ? -Number(b[3]) : Number(b[3]),
      vy: Number(b[4]),
      vz: mir ? -Number(b[5]) : Number(b[5]),
      w: {
        x: mir ? -Number(b[6]) : Number(b[6]),
        y: Number(b[7]),
        z: mir ? -Number(b[8]) : Number(b[8]),
      },
      visible: !!b[9],
      live: !!b[10],
      rocket: !!b[11],
      crit: !!b[12],
      shotTag: String(b[13]) as ShotTag,
      lastHitter: rawHitter >= 0 ? (mir ? 1 - rawHitter : rawHitter) : -1,
      bounceCount: Number(b[15]),
      serve: !!b[16],
      splashed: !!b[17],
    };

    const recon = this.predictor.reconcile(
      authBall,
      cur,
      myAck,
      this.pingMs || 0,
      this.engine.getActiveVenue(),
      nowMs
    );

    if (recon === "idle") {
      // Normal non-predicted snapshot: extrapolate slightly for half-RTT & blend smoothly
      const halfRttSec = clamp((this.pingMs || 0) * 0.0004, 0, 0.055);
      if (authBall.visible && authBall.live && halfRttSec > 0.003) {
        fastForwardBall(authBall, halfRttSec, this.engine.getActiveVenue(), true);
      }
      const smoothFlight =
        cur.visible && authBall.visible && cur.live && authBall.live &&
        cur.lastHitter === authBall.lastHitter && cur.bounceCount === authBall.bounceCount &&
        Math.hypot(authBall.x - cur.x, authBall.y - cur.y, authBall.z - cur.z) < 1.5;

      cur.x = smoothFlight ? lerp(cur.x, authBall.x, 0.55) : authBall.x;
      cur.y = smoothFlight ? lerp(cur.y, authBall.y, 0.55) : authBall.y;
      cur.z = smoothFlight ? lerp(cur.z, authBall.z, 0.55) : authBall.z;
      cur.vx = authBall.vx; cur.vy = authBall.vy; cur.vz = authBall.vz;
      cur.w.x = authBall.w.x; cur.w.y = authBall.w.y; cur.w.z = authBall.w.z;
      cur.visible = authBall.visible; cur.live = authBall.live;
      cur.rocket = authBall.rocket; cur.crit = authBall.crit;
      cur.shotTag = authBall.shotTag; cur.lastHitter = authBall.lastHitter;
      cur.bounceCount = authBall.bounceCount; cur.serve = authBall.serve;
      cur.splashed = authBall.splashed;
    } else if (recon === "rollback") {
      this.engine.trail.length = 0;
    }

    const ps = s.ps as unknown[][];
    if (ps && ps.length >= 2) {
      if (mir) {
        this.unpackPlayer(this.engine.players[1], ps[0], true);
        this.unpackPlayer(this.engine.players[0], ps[1], true);
        if (ps.length >= 4) {
          this.unpackPlayer(this.engine.players[3], ps[2], true);
          this.unpackPlayer(this.engine.players[2], ps[3], true);
        }
      } else {
        this.unpackPlayer(this.engine.players[0], ps[0], false);
        this.unpackPlayer(this.engine.players[1], ps[1], false);
        if (ps.length >= 4) {
          this.unpackPlayer(this.engine.players[2], ps[2], false);
          this.unpackPlayer(this.engine.players[3], ps[3], false);
        }
      }
    }

    this.engine.crowd.cheer = Number(s.cr);
    const nh = s.nh as number[] | undefined;
    if (nh) {
      this.engine.netHit.x = mir ? -nh[0] : nh[0];
      this.engine.netHit.y = nh[1];
      this.engine.netHit.amp = nh[2];
      this.engine.netHit.elapsed = nh[3];
    }

    if (Array.isArray(s.mk)) {
      this.engine.marks.length = 0;
      for (const m of s.mk as number[][]) {
        this.engine.marks.push({
          x: mir ? -m[0] : m[0],
          z: mir ? L - m[1] : m[1],
          out: !!m[2],
          age: m[3],
        });
      }
    }

    for (const e of (s.ev as NetEvent[]) || []) this.applyEvent(e);

    const hk = `${g.pts.join()}|${g.tbPts.join()}|${g.games.join()}|${g.server}|${g.serverSlot}|${g.tiebreak}`;
    if (hk !== this.hudKey) {
      this.hudKey = hk;
      this.ui.updateHud();
      this.engine.updateLed();
    }
    if (g.phase !== this.prevPhase) {
      this.prevPhase = g.phase;
      this.ui.setHint();
      this.ui.updateTelemetry();
      if (g.phase === "matchOver") {
        this.engine.ball.visible = false;
        this.ui.showNetEnd();
      }
    }
  }

  private applyEvent(e: NetEvent): void {
    // Skip personal events addressed to another player slot
    if (e.slot !== undefined && e.slot !== this.mySlot) return;
    // Skip duplicate SFX/VFX/feedback/juice that we already predicted locally at 0ms!
    if (e.k !== "ack" && e.k !== "pt" && e.k !== "msg" && this.predictor.shouldSuppressEvent(e.seq)) return;

    const a = e.a || [];
    const mir = this.isMirroredView;
    const vfx = this.engine.renderer.vfx;
    switch (e.k) {
      case "ack":
        break;
      case "fx": {
        const b = a.slice();
        const tx = (v: unknown) => (mir ? -Number(v) : Number(v));
        const tz = (v: unknown) => (mir ? L - Number(v) : Number(v));
        if (e.f === "dust") {
          vfx.burstDust(tx(b[0]), tz(b[1]), Number(b[2]), b[3] as [number, number, number]);
        } else if (e.f === "splash") {
          vfx.burstSplash(tx(b[0]), tz(b[1]), Number(b[2]));
        } else if (e.f === "sparks") {
          vfx.burstSparks(tx(b[0]), Number(b[1]), tz(b[2]), b[3] as [number, number, number], Number(b[4]), Number(b[5]), Number(b[6]), Number(b[7]));
        } else if (e.f === "confetti") {
          vfx.burstConfetti(tx(b[0]), Number(b[1]), tz(b[2]), Number(b[3]));
        }
        break;
      }
      case "sfx": {
        const name = String(e.n);
        const sfxObj = this.engine.sfx as unknown as Record<string, (...args: unknown[]) => void>;
        if (typeof sfxObj[name] !== "function") break;
        const b = a.slice();
        if (mir) {
          const panIdx: Record<string, number> = { hit: 2, bounce: 1, net: 0, squeak: 0, splash: 0, dive: 0, slide: 0 };
          if (panIdx[name] !== undefined) b[panIdx[name]] = -(Number(b[panIdx[name]]) || 0);
          if (name === "point") b[0] = !b[0];
        }
        sfxObj[name](...b);
        break;
      }
      case "msg":
        this.ui.showMsg(String(a[0]), String(a[1]), Number(a[2]));
        break;
      case "pt": {
        const [w, reason, isGame, isMatch, pts, sv, tb] = a as [0 | 1, string, boolean, boolean, [number, number], 0 | 1, boolean];
        const [t0, t1] = this.getLocalTeamNames();
        const lw = mir ? ((1 - w) as 0 | 1) : w;
        const lpts: [number, number] = mir ? [pts[1], pts[0]] : [pts[0], pts[1]];
        const lsv = mir ? ((1 - sv) as 0 | 1) : sv;
        const oppLabel = this.isSpectator ? (lw === 0 ? t0 : t1) : t1;
        const [big, sub] = pointBannerText(lw, reason, isGame, isMatch, lpts, lsv, oppLabel, !!tb);
        this.ui.showMsg(big, sub, isMatch ? 2400 : 1750);
        this.engine.umpire.announcePoint(big, sub, isMatch);
        break;
      }
      case "fb":
        this.ui.feedback(String(a[0]), String(a[1]), !!a[2]);
        break;
      case "tel":
        this.engine.lastMph = Number(a[0]);
        this.ui.updateTelemetry(Number(a[0]), !!a[1]);
        this.engine.updateLed();
        break;
      case "juice":
        this.engine.applyJuiceCam(!!a[0], !!a[1]);
        break;
      case "rum":
        this.engine.input.rumble(Number(a[0]));
        break;
      case "rumP":
        this.engine.input.rumblePattern(a[0] as number[]);
        break;
    }
  }

  public guestTick(dt: number): void {
    this.estHostTick += dt * 60;
    const now = performance.now();

    if (!this.isSpectator && this.transport) {
      const [nx, nz] = this.engine.input.readNudge();
      this.engine.nudge.x = lerp(this.engine.nudge.x, nx, clamp(dt * 12, 0, 1));
      this.engine.nudge.z = lerp(this.engine.nudge.z, nz, clamp(dt * 12, 0, 1));
      if (nx !== this.sentNx || nz !== this.sentNz || ((nx !== 0 || nz !== 0) && now - this.lastNudgeT > 200)) {
        this.sentNx = nx; this.sentNz = nz; this.lastNudgeT = now;
        this.transport.sendTo(this.hostId, { t: "nud", x: nx, z: nz }, "unreliable");
      }
    }

    if (this.connected && this.transport && this.hostId && now - this.lastPingT > 1500) {
      this.lastPingT = now;
      this.transport.sendTo(this.hostId, { t: "ping", ts: now }, "reliable");
    }

    // Velocity-blended smooth player interpolation on guests & spectators
    const k = clamp(dt * 18, 0, 1);
    for (const p of this.engine.players) {
      if (p.netX !== undefined && p.netZ !== undefined) {
        p.x = lerp(p.x + p.vx * dt * 0.35, p.netX, k);
        p.z = lerp(p.z + p.vz * dt * 0.35, p.netZ, k);
      }
    }

    // Dead-reckon ball with exact 240Hz venue physics between snapshots
    const venue = this.engine.getActiveVenue();
    if (this.engine.ball.visible) {
      const n = Math.max(1, Math.ceil(dt * 240));
      const h = dt / n;
      for (let i = 0; i < n; i++) physStep(this.engine.ball, h, venue, false, this.engine.netHit);
    }

    if (this.engine.netHit.amp > 0.001) {
      this.engine.netHit.elapsed += dt;
      this.engine.netHit.amp *= Math.exp(-dt * 4.2);
    }
    this.engine.crowd.hop += dt * 11;
    this.engine.sfx.tickAmbiance(dt);

    const g = this.engine.game;
    const isDbl = g.config.discipline === "doubles";
    const srvSlot = (isDbl ? g.serverSlot : g.server) as PlayerSlot;
    const myServing = !this.isSpectator && g.phase === "toss" && g.server === 0 &&
      (srvSlot === this.localFocusSlot || (srvSlot === 2 && this.engine.isTeamDualControl(0)));
    this.engine.ui.updateServeMeter(myServing && this.engine.ball.visible, clamp((this.engine.ball.y - 1.1) / 2.1, 0, 1) * 100);

    if (this.engine.ball.visible && this.engine.ball.live) {
      this.engine.trail.push({ x: this.engine.ball.x, y: this.engine.ball.y, z: this.engine.ball.z });
      if (this.engine.trail.length > 24) this.engine.trail.shift();
    } else if (this.engine.trail.length) {
      this.engine.trail.shift();
    }

    this.engine.renderer.vfx.updateParticles(dt, venue.waterY);
    const focusP = this.engine.players[this.localFocusSlot] || this.engine.you;
    this.engine.renderer.updateCamera(
      dt,
      g,
      focusP,
      this.engine.ball,
      this.engine.replay,
      false,
      this.isSpectator ? { active: true, mode: this.spectatorCamMode, followPlayer: focusP } : undefined
    );
  }
}
