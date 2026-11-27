import { BUDDY_AVATAR, clamp, emptyMatchStats, L, lerp, PRESETS, VENUES } from "../core/constants";
import type {
  AvatarConfig,
  MatchStats,
  NetLobbyConfig,
  PlayerState,
  ShotIntent,
  ShotTag,
  SkyId,
  SwingAnimType,
  VenueId,
} from "../core/types";
import type { GameEngine } from "../game/engine";
import { pointBannerText } from "../game/rules";
import { physStep } from "../physics/ballPhysics";

export const NET_PORT = 8765;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

interface LanUiHooks {
  refreshLobby: () => void;
  showTitle: () => void;
  showNetEnd: () => void;
  showMsg: (big: string, small: string, ms: number) => void;
  feedback: (label: string, detail?: string, isCrit?: boolean) => void;
  updateTelemetry: (mph?: number, isRocket?: boolean) => void;
  updateHud: () => void;
  setHint: () => void;
  updatePing: (ms: number | null) => void;
  hideOverlayForMatch: () => void;
  onChat?: (peerName: string, text: string, quick: boolean) => void;
  onChatReset?: () => void;
}

export class LanController {
  public ws: WebSocket | null = null;
  public role: "host" | "guest" | null = null;
  public connected = false;
  public peer = false;
  public peerName = "";
  public myName = "";
  public peerAvatar: AvatarConfig = structuredClone(BUDDY_AVATAR);
  public ips: string[] = [];
  public count = 0;
  public err = "";
  public addr = "";
  public target = "";
  public pingMs: number | null = null;

  public lobbyConfig: NetLobbyConfig = {
    discipline: "singles",
    format: "3games",
    venue: "pier",
    sky: "golden",
  };

  public peerStats: MatchStats = emptyMatchStats();

  private rnx = 0;
  private rnz = 0;
  private gnx = 0;
  private gnz = 0;
  private lastSwingB = -9;
  private lobB = false;
  public aimNext: "host" | "guest" | null = null;

  private evq: Array<Record<string, unknown>> = [];
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

  constructor(private engine: GameEngine, private ui: LanUiHooks) {
    try {
      this.myName = localStorage.getItem("lagoon-name") || "";
      this.addr = localStorage.getItem("lagoon-addr") || "";
    } catch {
      // ignore
    }

    // Hook VFX & SFX broadcasting cleanly
    this.engine.renderer.vfx.mirrorCoords = (x, z) => (this.engine.netCtx === "guest" ? [-x, L - z] : [x, z]);
    this.engine.renderer.vfx.onBroadcastFx = (kind, args) => {
      if (this.isHostLive()) this.evq.push({ k: "fx", f: kind, a: args });
    };
    this.engine.sfx.onBroadcastSfx = (name, args) => {
      if (this.isHostLive()) this.evq.push({ k: "sfx", n: name, a: args });
    };
  }

  public isHostLive(): boolean {
    return this.role === "host" && this.peer && this.engine.game.mode === "net";
  }

  public send(obj: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  public sendChat(text: string, quick = false): boolean {
    if (!this.connected || !this.peer || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    const clean = String(text || "").trim().slice(0, 160);
    if (!clean) return false;
    this.send({ t: "chat", text: clean, q: quick ? 1 : 0 });
    return true;
  }

  public pushEvent(e: { k: string; a: unknown[] }): void {
    if (this.isHostLive()) {
      this.evq.push(e);
      if (this.evq.length > 240) this.evq.splice(0, 120);
    }
  }

  public updateLobbyConfig(partial: Partial<NetLobbyConfig>): void {
    Object.assign(this.lobbyConfig, partial);
    if (this.role === "host" && this.connected) {
      this.send({ t: "cfg", cfg: this.lobbyConfig });
    }
    this.ui.refreshLobby();
  }

  public close(): void {
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    this.peer = false;
    this.role = null;
    this.count = 0;
    this.pingMs = null;
    this.pingSmooth = null;
    this.lastSentPhase = "";
    this.lastMarksSig = "";
    this.ui.updatePing(null);
    this.ui.onChatReset?.();
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      try { ws.close(); } catch { /* ignore */ }
    }
  }

  public leave(): void {
    this.send({ t: "bye" });
    this.close();
    this.err = "";
    this.ui.showTitle();
  }

  private peerLost(why: string): void {
    const wasPlaying = this.engine.game.mode === "net";
    this.peer = false;
    this.pingMs = null;
    this.ui.updatePing(null);
    if (wasPlaying) {
      this.ui.showTitle();
      this.ui.showMsg("LAN match ended", why, 3400);
    }
    this.ui.refreshLobby();
  }

  public connect(role: "host" | "guest", addrRaw: string, nameRaw: string): void {
    this.close();
    this.myName = (nameRaw || this.myName || (role === "host" ? "Host" : "Buddy")).trim().slice(0, 14) || "Player";
    try { localStorage.setItem("lagoon-name", this.myName); } catch { /* ignore */ }

    let host = String(addrRaw || "").trim().replace(/^(wss?|https?):\/\//i, "").replace(/\/.*$/, "");
    if (!host) host = "localhost";
    if (!/:\d+$/.test(host) && !host.startsWith("[")) host += ":" + NET_PORT;
    if (role === "guest") {
      this.addr = String(addrRaw || "").trim();
      try { localStorage.setItem("lagoon-addr", this.addr); } catch { /* ignore */ }
    }
    this.role = role;
    this.err = "";
    this.target = host;

    let ws: WebSocket;
    try {
      ws = new WebSocket("ws://" + host + "/");
    } catch {
      this.role = null;
      this.err = `That address doesn't look right (${host}).`;
      this.ui.refreshLobby();
      return;
    }
    this.ws = ws;
    this.ui.refreshLobby();

    ws.onopen = () => {
      this.connected = true;
      this.sendHello();
      this.ui.refreshLobby();
    };
    ws.onerror = () => {
      this.err =
        role === "host"
          ? `Couldn't reach the server on this computer. Run <b>npm run build</b> &amp; start <b>python3 lagoon-server.py</b> (or <b>Start-Lagoon-Server</b>), then press Host again.`
          : `Couldn't reach <b>${host}</b>. Check the address, confirm the host's server is open, and allow firewall access.`;
    };
    ws.onclose = () => {
      const was = this.peer;
      this.close();
      if (!this.err) this.err = "Disconnected from the server.";
      if (was) this.peerLost("Connection to the server was lost.");
      else this.ui.refreshLobby();
    };
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(String(ev.data));
        this.onMessage(m);
      } catch {
        // ignore malformed packets
      }
    };
  }

  private sendHello(): void {
    this.send({
      t: "hello",
      role: this.role,
      name: this.myName,
      avatar: this.engine.career.avatar,
      cfg: this.role === "host" ? this.lobbyConfig : undefined,
    });
  }

  private onMessage(m: Record<string, unknown>): void {
    switch (m.t) {
      case "sys":
        this.ips = Array.isArray(m.ips) ? (m.ips as string[]) : [];
        this.count = Number(m.count) | 0;
        if (this.count >= 2) {
          this.sendHello();
        } else if (this.peer) {
          this.peerLost(`${this.peerName || "Your buddy"} left the game.`);
        }
        this.ui.refreshLobby();
        break;
      case "hello":
        if (m.role === this.role) {
          this.err = `Someone else is already connected as ${m.role}. One computer must Host and the other Join.`;
          this.ui.refreshLobby();
          return;
        }
        if (m.avatar && typeof m.avatar === "object") {
          this.peerAvatar = { ...BUDDY_AVATAR, ...(m.avatar as Partial<AvatarConfig>) };
        }
        if (this.role === "guest" && m.cfg && typeof m.cfg === "object") {
          Object.assign(this.lobbyConfig, m.cfg);
        }
        if (!this.peer) {
          this.peer = true;
          this.peerName = String(m.name || (m.role === "host" ? "Host" : "Buddy")).slice(0, 14);
          this.sendHello();
          this.engine.sfx.ui();
          this.ui.showMsg(this.role === "host" ? "Buddy joined!" : "Connected!", `${this.peerName} is in the lobby`, 1600);
        }
        this.ui.refreshLobby();
        break;
      case "cfg":
        if (this.role === "guest" && m.cfg && typeof m.cfg === "object") {
          Object.assign(this.lobbyConfig, m.cfg);
          this.ui.refreshLobby();
        }
        break;
      case "ping":
        this.send({ t: "pong", ts: m.ts });
        break;
      case "pong":
        if (typeof m.ts === "number") {
          const rtt = Math.max(1, performance.now() - m.ts);
          this.pingSmooth = this.pingSmooth === null ? rtt : this.pingSmooth * 0.65 + rtt * 0.35;
          this.pingMs = Math.round(this.pingSmooth);
          this.ui.updatePing(this.pingMs);
        }
        break;
      case "start":
        if (this.role === "guest") this.guestStart(m);
        break;
      case "s":
        if (this.role === "guest") this.applySnapshot(m);
        break;
      case "sw":
        if (this.role === "host") this.handleRemoteSwing(Number(m.p), String(m.i) as ShotIntent);
        break;
      case "nud":
        if (this.role === "host") {
          this.rnx = clamp(Number(m.x) || 0, -1, 1);
          this.rnz = clamp(Number(m.z) || 0, -1, 1);
        }
        break;
      case "chat":
        if (typeof m.text === "string" && m.text.trim()) {
          this.ui.onChat?.(this.peerName || (this.role === "host" ? "Buddy" : "Host"), m.text, !!m.q);
        }
        break;
      case "bye":
        this.peerLost(`${this.peerName || "Your buddy"} left the match.`);
        break;
    }
  }

  // ---------- 180° WORLD MIRROR FOR HOST SIMULATION OF GUEST SWINGS ----------
  private mirrorPlayer(p: PlayerState): void {
    p.x = -p.x; p.tx = -p.tx; p.homeX = -p.homeX;
    p.z = L - p.z; p.tz = L - p.tz; p.homeZ = L - p.homeZ;
    p.vx = -p.vx; p.vz = -p.vz; p.prevVx = -p.prevVx; p.prevVz = -p.prevVz;
    if (p.aimTarget) p.aimTarget = { x: -p.aimTarget.x, z: L - p.aimTarget.z };
  }

  private mirrorWorld(): void {
    const ps = this.engine.players;
    // Swap team 0 <-> team 1 (0 <-> 1, 2 <-> 3)
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

    const g = this.engine.game;
    g.server = (1 - g.server) as 0 | 1;
    g.pts = [g.pts[1], g.pts[0]];
    g.tbPts = [g.tbPts[1], g.tbPts[0]];
    g.games = [g.games[1], g.games[0]];
    if (g.winner >= 0) g.winner = (1 - g.winner) as 0 | 1;

    const tmpS = g.lastSwing; g.lastSwing = this.lastSwingB; this.lastSwingB = tmpS;
    const tmpL = g.lobArmed; g.lobArmed = this.lobB; this.lobB = tmpL;
    for (const q of this.engine.trail) { q.x = -q.x; q.z = L - q.z; }
    for (const m of this.engine.marks) { m.x = -m.x; m.z = L - m.z; }
  }

  // ---------- HOST ----------
  public startHostMatch(): void {
    if (this.role !== "host" || !this.peer) return;
    this.evq.length = 0;
    this.rnx = this.rnz = this.gnx = this.gnz = 0;
    this.lastSwingB = -9;
    this.lobB = false;
    this.aimNext = null;
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
    this.send({
      t: "start",
      name: this.myName || "Host",
      avatar: this.engine.career.avatar,
      cfg: this.lobbyConfig,
    });
  }

  private handleRemoteSwing(p: number, intent: ShotIntent): void {
    if (this.engine.game.mode !== "net" || this.role !== "host" || this.engine.game.paused) return;
    const valid: ShotIntent[] = ["drive", "slice", "lob", "drop"];
    const safeIntent: ShotIntent = valid.includes(intent) ? intent : "drive";
    const sx = this.engine.nudge.x;
    const sz = this.engine.nudge.z;

    this.mirrorWorld();
    this.engine.netCtx = "guest";
    this.engine.sfx.panFlip = -1;
    this.engine.nudge.x = this.gnx;
    this.engine.nudge.z = this.gnz;
    try {
      this.engine.humanSwing(clamp(p || 0, 0, 1), safeIntent);
    } finally {
      this.engine.nudge.x = sx;
      this.engine.nudge.z = sz;
      this.engine.netCtx = "local";
      this.engine.sfx.panFlip = 1;
      this.mirrorWorld();
    }
  }

  public hostStep(dt: number): void {
    if (!this.isHostLive()) return;
    this.gnx = lerp(this.gnx, this.rnx, clamp(dt * 12, 0, 1));
    this.gnz = lerp(this.gnz, this.rnz, clamp(dt * 12, 0, 1));
    if (this.aimNext === "guest") {
      this.mirrorWorld();
      this.engine.aimNearTeam();
      this.mirrorWorld();
    } else if (this.aimNext === "host") {
      this.engine.aimNearTeam();
    }
    this.aimNext = null;

    const sx = this.engine.nudge.x;
    const sz = this.engine.nudge.z;
    this.mirrorWorld();
    this.engine.nudge.x = this.gnx;
    this.engine.nudge.z = this.gnz;
    this.engine.applyNudgeMove(dt);
    this.engine.nudge.x = sx;
    this.engine.nudge.z = sz;
    this.mirrorWorld();
  }

  private packPlayer(p: PlayerState) {
    return [
      r2(p.x), r2(p.z), r2(p.vx), r2(p.vz), r2(p.swingT), r2(p.swingDur), p.swingType,
      r2(p.splitT), r2(p.tossArm), r2(p.lungeT), p.lungeDir, r2(p.diveT), p.diveDir,
      r2(p.emoteT), p.emote,
      p.aimTarget ? r2(p.aimTarget.x) : null, p.aimTarget ? r2(p.aimTarget.z) : null,
    ];
  }

  public hostSendSnapshot(): void {
    const nowMs = performance.now();
    if (this.connected && this.peer && nowMs - this.lastPingT > 1500) {
      this.lastPingT = nowMs;
      this.send({ t: "ping", ts: nowMs });
    }
    if (!this.isHostLive()) return;
    const g = this.engine.game;
    const hasEvents = this.evq.length > 0;
    const phaseChanged = g.phase !== this.lastSentPhase;
    const urgent = hasEvents || phaseChanged;

    // Adaptive cadence: instant flush on hits/events, 25Hz during live rallies, 8Hz when idle
    const livePhase = g.phase === "rally" || g.phase === "toss" || g.phase === "cpuServe";
    const interval = livePhase ? 0.04 : 0.125;
    if (!urgent && g.now - this.lastSend < interval && g.now >= this.lastSend) return;

    // Backpressure guard: never pile non-urgent state snapshots onto a congested Wi-Fi socket!
    if (!urgent && this.ws && this.ws.bufferedAmount > 6144) return;

    this.lastSend = g.now;
    this.lastSentPhase = g.phase;
    const b = this.engine.ball;
    const activePlayers = g.config.discipline === "doubles" ? this.engine.players : this.engine.players.slice(0, 2);

    const payload: Record<string, unknown> = {
      t: "s",
      ph: g.phase,
      pts: g.pts,
      tb: g.tiebreak ? 1 : 0,
      tbp: g.tbPts,
      gm: g.games,
      sv: g.server,
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
    if (mkSig !== this.lastMarksSig) {
      this.lastMarksSig = mkSig;
      payload.mk = this.engine.marks.map((m) => [r2(m.x), r2(m.z), m.out ? 1 : 0, r2(m.age)]);
    }
    // Only include "ev" key when non-empty so lagoon-server.py coalesces pure state snapshots!
    if (hasEvents) {
      payload.ev = this.evq.splice(0);
    }

    this.send(payload);
  }

  // ---------- GUEST ----------
  public guestSwing(power: number, intent: ShotIntent): void {
    const g = this.engine.game;
    if (g.now - g.lastSwing < 0.2) return;
    if (g.phase === "title" || g.phase === "matchOver") return;
    g.lastSwing = g.now;
    if (g.lobArmed && intent !== "slice" && intent !== "drop") intent = "lob";
    g.lobArmed = false;
    this.ui.updateTelemetry();
    this.send({ t: "sw", p: r3(power), i: intent });
  }

  private guestStart(m: Record<string, unknown>): void {
    this.engine.sfx.init();
    const g = this.engine.game;
    g.mode = "net";
    g.paused = false;
    this.peerName = String(m.name || this.peerName || "Host").slice(0, 14);
    if (m.avatar && typeof m.avatar === "object") {
      this.peerAvatar = { ...BUDDY_AVATAR, ...(m.avatar as Partial<AvatarConfig>) };
    }
    if (m.cfg && typeof m.cfg === "object") {
      Object.assign(this.lobbyConfig, m.cfg);
    }
    g.config.discipline = this.lobbyConfig.discipline;
    g.config.format = this.lobbyConfig.format;
    g.config.venue = VENUES[this.lobbyConfig.venue as VenueId] ? this.lobbyConfig.venue : "pier";
    g.config.sky = PRESETS[this.lobbyConfig.sky as SkyId] ? this.lobbyConfig.sky : "golden";

    Object.assign(g, {
      pts: [0, 0], tbPts: [0, 0], tiebreak: false, games: [0, 0],
      server: 1, faults: 0, winner: -1, hitstop: 0, slowMo: 0, phase: "serveReady",
    });
    this.prevPhase = null;
    this.hudKey = "";
    this.engine.marks.length = 0;
    this.engine.trail.length = 0;
    for (const p of this.engine.players) {
      p.netX = undefined;
      p.swingTrail.length = 0;
    }

    this.ui.hideOverlayForMatch();
    this.ui.updateHud();
    this.ui.setHint();
    this.engine.renderer.snapGameplayCam(this.engine.you);
    this.engine.music.setMood("rally", 0);
    this.ui.showMsg(`vs ${this.peerName}`, `${VENUES[g.config.venue].name} · ${this.peerName} serves first`, 1600);
  }

  private unpackPlayer(p: PlayerState, a: unknown[]): void {
    const nx = -Number(a[0]);
    const nz = L - Number(a[1]);
    if (p.netX === undefined) { p.x = p.tx = nx; p.z = p.tz = nz; }
    p.netX = nx; p.netZ = nz;
    p.vx = -Number(a[2]); p.vz = -Number(a[3]);
    p.swingT = Number(a[4]); p.swingDur = Number(a[5]); p.swingType = String(a[6]) as SwingAnimType;
    p.splitT = Number(a[7]); p.tossArm = Number(a[8]);
    p.lungeT = Number(a[9]); p.lungeDir = Number(a[10]);
    p.diveT = Number(a[11]); p.diveDir = Number(a[12]);
    p.emoteT = Number(a[13]); p.emote = String(a[14]) as "win" | "lose";
    p.aimTarget = a[15] == null ? null : { x: -Number(a[15]), z: L - Number(a[16]) };
  }

  private applySnapshot(s: Record<string, unknown>): void {
    const g = this.engine.game;
    if (g.mode !== "net") return;
    const pts = s.pts as [number, number];
    const tbp = (s.tbp as [number, number]) || [0, 0];
    const gm = s.gm as [number, number];
    g.phase = s.ph as GameEngine["game"]["phase"];
    g.pts = [pts[1], pts[0]];
    g.tiebreak = !!s.tb;
    g.tbPts = [tbp[1], tbp[0]];
    g.games = [gm[1], gm[0]];
    g.server = (1 - Number(s.sv)) as 0 | 1;
    g.faults = Number(s.fl);
    g.rally = Number(s.ra);
    g.tossT = Number(s.tt);
    g.winner = Number(s.wn) >= 0 ? ((1 - Number(s.wn)) as 0 | 1) : -1;
    if (s.st && typeof s.st === "object") this.peerStats = s.st as MatchStats;

    const b = s.b as unknown[];
    const cur = this.engine.ball;
    const bx = -Number(b[0]), by = Number(b[1]), bz = L - Number(b[2]);
    const bvis = !!b[9], blive = !!b[10];
    const bHitter = Number(b[14]) >= 0 ? 1 - Number(b[14]) : -1;
    const bBounce = Number(b[15]);
    const smoothFlight =
      cur.visible && bvis && cur.live && blive &&
      cur.lastHitter === bHitter && cur.bounceCount === bBounce &&
      Math.hypot(bx - cur.x, by - cur.y, bz - cur.z) < 1.4;

    cur.x = smoothFlight ? lerp(cur.x, bx, 0.55) : bx;
    cur.y = smoothFlight ? lerp(cur.y, by, 0.55) : by;
    cur.z = smoothFlight ? lerp(cur.z, bz, 0.55) : bz;
    cur.vx = -Number(b[3]);
    cur.vy = Number(b[4]);
    cur.vz = -Number(b[5]);
    cur.w.x = -Number(b[6]);
    cur.w.y = Number(b[7]);
    cur.w.z = -Number(b[8]);
    cur.visible = bvis;
    cur.live = blive;
    cur.rocket = !!b[11];
    cur.crit = !!b[12];
    cur.shotTag = String(b[13]) as ShotTag;
    cur.lastHitter = bHitter;
    cur.bounceCount = bBounce;
    cur.serve = !!b[16];
    cur.splashed = !!b[17];

    const ps = s.ps as unknown[][];
    if (ps && ps.length >= 2) {
      // Mirror slot pairs: host 0 -> guest 1, host 1 -> guest 0, host 2 -> guest 3, host 3 -> guest 2
      this.unpackPlayer(this.engine.players[1], ps[0]);
      this.unpackPlayer(this.engine.players[0], ps[1]);
      if (ps.length >= 4) {
        this.unpackPlayer(this.engine.players[3], ps[2]);
        this.unpackPlayer(this.engine.players[2], ps[3]);
      }
    }

    this.engine.crowd.cheer = Number(s.cr);
    const nh = s.nh as number[] | undefined;
    if (nh) {
      this.engine.netHit.x = -nh[0]; this.engine.netHit.y = nh[1];
      this.engine.netHit.amp = nh[2]; this.engine.netHit.elapsed = nh[3];
    }

    if (Array.isArray(s.mk)) {
      this.engine.marks.length = 0;
      for (const m of s.mk as number[][]) {
        this.engine.marks.push({ x: -m[0], z: L - m[1], out: !!m[2], age: m[3] });
      }
    }

    for (const e of (s.ev as Array<Record<string, unknown>>) || []) this.applyEvent(e);

    const hk = `${g.pts.join()}|${g.tbPts.join()}|${g.games.join()}|${g.server}|${g.tiebreak}`;
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

  private applyEvent(e: Record<string, unknown>): void {
    const a = (e.a as unknown[]) || [];
    const vfx = this.engine.renderer.vfx;
    switch (e.k) {
      case "fx": {
        const b = a.slice();
        if (e.f === "dust") {
          vfx.burstDust(-Number(b[0]), L - Number(b[1]), Number(b[2]), b[3] as [number, number, number]);
        } else if (e.f === "splash") {
          vfx.burstSplash(-Number(b[0]), L - Number(b[1]), Number(b[2]));
        } else if (e.f === "sparks") {
          vfx.burstSparks(-Number(b[0]), Number(b[1]), L - Number(b[2]), b[3] as [number, number, number], Number(b[4]), Number(b[5]), Number(b[6]), Number(b[7]));
        } else if (e.f === "confetti") {
          vfx.burstConfetti(-Number(b[0]), Number(b[1]), L - Number(b[2]), Number(b[3]));
        }
        break;
      }
      case "sfx": {
        const name = String(e.n);
        const sfxObj = this.engine.sfx as unknown as Record<string, (...args: unknown[]) => void>;
        if (typeof sfxObj[name] !== "function") break;
        const b = a.slice();
        const panIdx: Record<string, number> = { hit: 2, bounce: 1, net: 0, squeak: 0, splash: 0, dive: 0, slide: 0 };
        if (panIdx[name] !== undefined) b[panIdx[name]] = -(Number(b[panIdx[name]]) || 0);
        if (name === "point") b[0] = !b[0];
        sfxObj[name](...b);
        break;
      }
      case "msg":
        this.ui.showMsg(String(a[0]), String(a[1]), Number(a[2]));
        break;
      case "pt": {
        const [w, reason, isGame, isMatch, pts, sv, tb] = a as [0 | 1, string, boolean, boolean, [number, number], 0 | 1, boolean];
        const [big, sub] = pointBannerText((1 - w) as 0 | 1, reason, isGame, isMatch, [pts[1], pts[0]], (1 - sv) as 0 | 1, this.peerName || "Host", !!tb);
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
    const [nx, nz] = this.engine.input.readNudge();
    this.engine.nudge.x = lerp(this.engine.nudge.x, nx, clamp(dt * 12, 0, 1));
    this.engine.nudge.z = lerp(this.engine.nudge.z, nz, clamp(dt * 12, 0, 1));
    const now = performance.now();
    if (nx !== this.sentNx || nz !== this.sentNz || ((nx !== 0 || nz !== 0) && now - this.lastNudgeT > 250)) {
      this.sentNx = nx; this.sentNz = nz; this.lastNudgeT = now;
      this.send({ t: "nud", x: nx, z: nz });
    }
    if (this.connected && this.peer && now - this.lastPingT > 1500) {
      this.lastPingT = now;
      this.send({ t: "ping", ts: now });
    }

    // Velocity-blended smooth player interpolation on guest
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
    const showMeter = g.phase === "toss" && g.server === 0 && this.engine.ball.visible;
    this.engine.ui.updateServeMeter(showMeter, clamp((this.engine.ball.y - 1.1) / 2.1, 0, 1) * 100);

    if (this.engine.ball.visible && this.engine.ball.live) {
      this.engine.trail.push({ x: this.engine.ball.x, y: this.engine.ball.y, z: this.engine.ball.z });
      if (this.engine.trail.length > 24) this.engine.trail.shift();
    } else if (this.engine.trail.length) {
      this.engine.trail.shift();
    }

    this.engine.renderer.vfx.updateParticles(dt, venue.waterY);
    this.engine.renderer.updateCamera(dt, g, this.engine.you, this.engine.ball, this.engine.replay, false);
  }
}
