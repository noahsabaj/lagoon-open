import "./styles/main.css";
import { isValidRoomCode, normalizeRoomCode, QUALITY_TIERS, SKY_CYCLE } from "./core/constants";
import type { PlayerSlot, SpectatorCamMode } from "./core/types";
import { SoundEngine } from "./audio/soundEngine";
import { TropicalMusicEngine } from "./audio/music";
import { UmpireVoice } from "./audio/umpireVoice";
import { loadCareer, loadSettings, saveSettings } from "./game/career";
import { GameEngine } from "./game/engine";
import { InputController } from "./input/controls";
import { MultiplayerController } from "./net/session";
import { AssetManager } from "./render/assets";
import { GameRenderer } from "./render/renderer";
import { ChatController } from "./ui/chat";
import { $, escHtml, HudController } from "./ui/hud";
import { MenuController } from "./ui/menus";

async function boot() {
  const cv = $<HTMLCanvasElement>("court");
  const career = loadCareer();
  const settings = loadSettings();
  const hud = new HudController();

  // Preload Blender 5.3 .glb hero models (offline bundled in dist/models/)
  const assets = new AssetManager();
  try {
    await assets.loadAll((pct, label) => hud.setBootProgress(pct, label));
  } catch (err) {
    hud.hideBootLoader();
    const detail = err instanceof Error ? err.message : String(err);
    $("card").innerHTML = `<h1>3D Assets Unavailable</h1><p class="lede">Lagoon Open could not load its bundled 3D models. Ensure the game is built and served over HTTP.</p><p class="note">${escHtml(detail)}</p>`;
    $("overlay").hidden = false;
    return;
  }
  hud.hideBootLoader();

  let renderer: GameRenderer;
  try {
    renderer = new GameRenderer(cv, assets, settings.qualityIdx);
  } catch {
    $("card").innerHTML = `<h1>WebGL2 Required</h1><p class="lede">Lagoon Open's Three.js engine needs WebGL2 (Chrome, Edge, Firefox, or Safari).</p>`;
    $("overlay").hidden = false;
    return;
  }

  const sfx = new SoundEngine(settings);
  const music = new TropicalMusicEngine(sfx, settings);
  const umpire = new UmpireVoice(settings);

  // Forward declarations resolved right after instantiation
  let engine!: GameEngine;
  let net!: MultiplayerController;
  let menus!: MenuController;
  let chat!: ChatController;

  const syncScoreHud = () => {
    const [t0, t1] = engine.getTeamNames();
    const badge = net.mode === "online" ? `ROOM ${net.roomCode || ""}`.trim() : "LAN";
    hud.updateScoreHud(engine.game, t1, engine.game.mode === "net" ? t0 : undefined, badge);
  };

  const syncHint = () => {
    const g = engine.game;
    const isNet = g.mode === "net";
    const srvSlot = (g.config.discipline === "doubles" ? g.serverSlot : g.server) as PlayerSlot;
    const canonicalSrv = (isNet && net.isMirroredView ? (srvSlot ^ 1) : srvSlot) as PlayerSlot;
    const serverName = isNet ? net.getSlotName(canonicalSrv) : engine.getOppName();
    hud.setHint(
      g,
      engine.getOppName(),
      !!input.wii.dev,
      input.gamepad.connected,
      input.touchy,
      engine.training,
      {
        isSpectator: net.isSpectator,
        myFocusSlot: net.localFocusSlot,
        serverName,
      }
    );
  };

  const syncSpectatorBar = () => {
    const vis = net.isSpectator && engine.game.mode === "net" && engine.game.phase !== "title" && engine.game.phase !== "matchOver";
    const followName = net.getSlotName(net.spectatorFollowSlot);
    hud.updateSpectatorBar(
      vis,
      net.spectatorCamMode,
      net.spectatorFollowSlot,
      net.getSpectators().length,
      followName
    );
  };

  const input = new InputController(cv, settings, {
    onSwing: (pwr, intent) => engine.humanSwing(pwr, intent),
    onChargeUpdate: (active, pwr, intent) => hud.updateChargeMeter(active, pwr, intent),
    onArmLobToggle: () => {
      if (engine.game.phase === "rally" || engine.game.phase === "training") {
        engine.game.lobArmed = !engine.game.lobArmed;
        hud.updateTelemetry(engine.game);
      }
    },
    onPauseToggle: () => {
      const g = engine.game;
      if (g.phase === "title" || g.phase === "matchOver" || g.phase === "trainOver") return;
      if (g.phase === "customizer") { menus.showTitle(); return; }
      if (g.mode === "net") {
        if (menus.isOverlayOpen()) menus.closeOverlay();
        else menus.showNetMenu();
        return;
      }
      if (g.paused) { g.paused = false; menus.closeOverlay(); }
      else menus.showPause();
    },
    onOverlayConfirm: () => {
      if (engine.game.paused) { engine.game.paused = false; menus.closeOverlay(); }
      else if (engine.game.phase === "title" && !net.transport) { menus.closeOverlay(); engine.startMatch(); }
    },
    onSkipReplay: () => engine.skipBroadcastOverlay(),
    onAudioUnlock: () => {
      sfx.init();
      if (engine.game.phase === "title") music.setMood("menu");
    },
    onWiiStatusChange: (connected, label, msg) => {
      hud.updateWiiToolbar(connected, label);
      if (msg) hud.showMsg(msg[0], msg[1], 2400);
      syncHint();
    },
    onGamepadStatusChange: (connected, label) => {
      hud.updateGamepadToolbar(connected, label);
      if (connected) hud.showMsg("Gamepad Connected", "A Drive · B Slice · X Drop · Y Lob", 2000);
      syncHint();
    },
    isOverlayOpen: () => menus.isOverlayOpen(),
    isServeReady: () => engine.game.phase === "serveReady",
    isChatOpen: () => chat.isOpen,
    canChat: () => net.connected && net.hasAnyPeer && engine.game.mode === "net",
    onChatOpen: () => chat.openComposer(),
    onChatClose: () => chat.closeComposer(),
    onQuickChat: (slot) => { chat.sendQuick(slot); },
    isSpectator: () => net.isSpectator && engine.game.mode === "net",
    onSpectatorCycleCam: () => { sfx.ui(); net.cycleSpectatorCamera(); },
    getViewportSize: () => [renderer.W, renderer.H],
    getHandedness: () => career.avatar.handedness,
  });

  engine = new GameEngine(career, settings, renderer, sfx, music, umpire, input, {
    showMsg: (big, small, ms) => hud.showMsg(big, small, ms),
    feedback: (label, detail, isCrit) => {
      if (engine.netCtx === "remote") {
        net.pushEvent({ k: "fb", a: [label, detail || "", !!isCrit], slot: engine.netActorSlot, seq: engine.netActorSeq });
      } else {
        hud.feedback(label, detail, isCrit);
      }
    },
    updateHud: () => syncScoreHud(),
    updateTrainHud: () => hud.updateTrainHud(engine.training, career, engine.game.mode === "training"),
    updateTelemetry: (mph, isRocket) => {
      if (mph && mph > 20 && net.isHostLive() && !engine.netPredictMode) {
        net.pushEvent({ k: "tel", a: [mph, !!isRocket], seq: engine.netActorSeq });
      }
      if (engine.netCtx !== "remote") hud.updateTelemetry(engine.game, mph, isRocket);
    },
    updateServeMeter: (v, p) => hud.updateServeMeter(v, p),
    setHint: () => {
      if (engine.netCtx === "remote") return;
      syncHint();
    },
    showEnd: () => menus.showEnd(),
    showTrainEnd: () => menus.showTrainEnd(),
    showTournamentBracket: (champ) => menus.showTournamentBracket(champ),
    showEndlessResult: () => menus.showEndlessResult(),
    updateReplayBanner: (vis, lbl) => hud.updateReplayBanner(vis, lbl),
    updateHawkEyeBanner: (vis, isIn, cm, line) => hud.updateHawkEyeBanner(vis, isIn, cm, line),
    onNetEvent: (e) => net.pushEvent(e),
    isNetRemoteClient: () => net.isRemoteClient(),
    isNetSpectator: () => net.isSpectator,
    onNetGuestSwing: (p, i) => net.guestSwing(p, i),
    getNetTeamNames: () => net.getLocalTeamNames(),
    getNetSlotAvatars: () => net.getLocalSlotAvatars(),
    getNetSeatKinds: () => net.getSeatKinds(),
    getNetBotRivalId: (slot) => net.getBotRivalId(slot),
    setNetAimNext: (who) => { net.aimNext = who; },
  });

  net = new MultiplayerController(engine, {
    refreshLobby: () => menus.refreshLanLobby(),
    showTitle: () => menus.showTitle(),
    showNetEnd: () => { syncSpectatorBar(); menus.showNetEnd(); },
    showMsg: (b, s, m) => hud.showMsg(b, s, m),
    feedback: (l, d, c) => hud.feedback(l, d, c),
    updateTelemetry: (m, r) => hud.updateTelemetry(engine.game, m, r),
    updateHud: () => syncScoreHud(),
    setHint: () => syncHint(),
    updatePing: (ms) => hud.updatePing(ms),
    updateSpectatorBar: () => syncSpectatorBar(),
    hideOverlayForMatch: () => { menus.closeOverlay(); syncSpectatorBar(); },
    onChat: (senderName, senderSlot, text, quick) => chat.receivePeer(senderName, text, quick, undefined, senderSlot),
    onChatReset: () => chat.clearSession(),
  });

  chat = new ChatController({
    onSend: (text, quick) => net.sendChat(text, quick),
    onSound: (isRemote) => { sfx.init(); sfx.chat(isRemote); },
    getMyName: () => net.myName || "You",
    getPeerName: () => net.getRoomSummaryName(),
    getMySlot: () => (net.isSpectator ? "spec" : net.localFocusSlot),
    isLanReady: () => net.connected && net.hasAnyPeer,
    isLiveLanMatch: () => net.connected && net.hasAnyPeer && engine.game.mode === "net" && !menus.isOverlayOpen(),
  });

  menus = new MenuController(engine, net, hud, chat);

  // Spectator bar controls (camera buttons + crowd cheer reaction)
  document.querySelectorAll<HTMLButtonElement>("#specBar [data-scam]").forEach((btn) => {
    btn.onclick = () => {
      sfx.init(); sfx.ui();
      const cam = btn.dataset.scam as SpectatorCamMode;
      if (cam === "follow" && net.spectatorCamMode === "follow") {
        const maxSlots = engine.game.config.discipline === "doubles" ? 4 : 2;
        const nextSlot = ((net.spectatorFollowSlot + 1) % maxSlots) as PlayerSlot;
        net.setSpectatorCamera("follow", nextSlot);
      } else {
        net.setSpectatorCamera(cam);
      }
    };
  });
  const specCheerBtn = document.getElementById("specCheerBtn");
  if (specCheerBtn) {
    specCheerBtn.onclick = () => {
      sfx.init();
      if (net.sendSpectatorCheer()) {
        hud.feedback("CHEER!", "Crowd goes wild!");
      }
    };
  }

  // Toolbar controls
  $("wiiBtn").onclick = () => { sfx.init(); void input.connectWii(true); };
  $("sndBtn").onclick = () => {
    sfx.init();
    settings.muted = !settings.muted;
    saveSettings(settings);
    sfx.applyVolumes();
    hud.updateToolbar(settings, engine.getActiveSkyPreset().label);
  };
  $("skyBtn").onclick = () => {
    sfx.init(); sfx.ui();
    settings.skyOverride = SKY_CYCLE[(SKY_CYCLE.indexOf(settings.skyOverride) + 1) % SKY_CYCLE.length];
    saveSettings(settings);
    hud.updateToolbar(settings, engine.getActiveSkyPreset().label);
  };
  $("qualBtn").onclick = () => {
    sfx.init(); sfx.ui();
    settings.qualityIdx = (settings.qualityIdx + 1) % QUALITY_TIERS.length;
    saveSettings(settings);
    renderer.setQuality(settings.qualityIdx);
    hud.updateToolbar(settings, engine.getActiveSkyPreset().label);
  };
  $("settingsBtn").onclick = () => {
    sfx.init(); sfx.ui();
    menus.showSettings(false);
  };
  $("menuBtn").onclick = () => {
    sfx.init(); sfx.ui();
    const g = engine.game;
    if (g.phase === "title") return;
    if (g.phase === "customizer") { menus.showTitle(); return; }
    if (g.mode === "net") {
      if (menus.isOverlayOpen()) menus.closeOverlay();
      else menus.showNetMenu();
      return;
    }
    if (g.paused) { g.paused = false; menus.closeOverlay(); }
    else menus.showPause();
  };

  window.addEventListener("resize", () => renderer.resize());

  hud.updateToolbar(settings, engine.getActiveSkyPreset().label);

  // Deep-link `?room=PALM` opens straight into the Online Join lobby with code pre-filled!
  const urlRoom = normalizeRoomCode(new URLSearchParams(location.search).get("room") || "");
  if (isValidRoomCode(urlRoom)) {
    menus.openJoinRoomCode(urlRoom);
  } else {
    menus.showTitle();
  }
  void input.connectWii(false);

  // Main animation loop + adaptive FPS quality safeguard
  let lastTs = 0;
  let fpsFrames = 0;
  let fpsAcc = 0;
  let slowStreak = 0;

  function frame(ts: number) {
    const t = ts * 0.001;
    const dt = Math.min(0.05, lastTs ? t - lastTs : 0.016);
    lastTs = t;
    engine.game.now = t;

    input.poll(ts);

    if (net.role === "guest" && engine.game.mode === "net") {
      net.guestTick(dt);
    } else {
      if (engine.game.mode === "net") net.hostStep(dt);
      engine.update(dt);
      net.hostSendSnapshot();
    }

    renderer.render({
      now: t,
      dt,
      preset: engine.getActiveSkyPreset(),
      venueId: engine.game.config.venue,
      game: engine.game,
      players: engine.players,
      avatars: engine.getSlotAvatars(),
      visibleSlots: engine.getVisibleSlots(),
      ball: engine.ball,
      netHit: engine.netHit,
      crowdCheer: engine.crowd.cheer,
      crowdHop: engine.crowd.hop,
      marks: engine.marks,
      trail: engine.trail,
      training: engine.training,
      replay: engine.replay,
      trophyCeremony: engine.trophyCeremony,
      focusSlot: engine.game.mode === "net" ? net.localFocusSlot : 0,
      isSpectator: engine.game.mode === "net" && net.isSpectator,
    });

    chat.updateBubbles(
      ts,
      engine.players,
      renderer.W,
      renderer.H,
      (x, y, z, out) => renderer.projectWorldToScreen(x, y, z, out)
    );

    fpsFrames++;
    fpsAcc += dt;
    if (fpsAcc >= 0.75) {
      const fps = Math.round(fpsFrames / fpsAcc);
      const tag = $("fpsTag");
      tag.textContent = `${fps} FPS`;
      const ps = renderer.getPerfStats();
      tag.dataset.calls = String(ps.calls);
      tag.dataset.tris = String(ps.triangles);
      tag.dataset.programs = String(ps.programs);
      tag.dataset.dpr = ps.dpr.toFixed(2);
      tag.title = `${ps.quality} · ${ps.calls} draw calls · ${Math.round(ps.triangles / 1000)}k tris · ${ps.programs} shaders · DPR ${ps.dpr.toFixed(2)}`;
      tag.hidden = false;
      if (fps < 35 && settings.qualityIdx < 2) {
        slowStreak++;
        if (slowStreak >= 3) {
          settings.qualityIdx++;
          saveSettings(settings);
          renderer.setQuality(settings.qualityIdx);
          hud.updateToolbar(settings, engine.getActiveSkyPreset().label);
          slowStreak = 0;
        }
      } else {
        slowStreak = 0;
      }
      fpsFrames = 0;
      fpsAcc = 0;
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

void boot();
