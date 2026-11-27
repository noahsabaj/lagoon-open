import "./styles/main.css";
import { QUALITY_TIERS, SKY_CYCLE } from "./core/constants";
import { SoundEngine } from "./audio/soundEngine";
import { TropicalMusicEngine } from "./audio/music";
import { UmpireVoice } from "./audio/umpireVoice";
import { loadCareer, loadSettings, saveSettings } from "./game/career";
import { GameEngine } from "./game/engine";
import { InputController } from "./input/controls";
import { LanController } from "./net/lan";
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
  let lan!: LanController;
  let menus!: MenuController;
  let chat!: ChatController;

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
      else if (engine.game.phase === "title" && !lan.ws) { menus.closeOverlay(); engine.startMatch(); }
    },
    onSkipReplay: () => engine.skipBroadcastOverlay(),
    onAudioUnlock: () => {
      sfx.init();
      if (engine.game.phase === "title") music.setMood("menu");
    },
    onWiiStatusChange: (connected, label, msg) => {
      hud.updateWiiToolbar(connected, label);
      if (msg) hud.showMsg(msg[0], msg[1], 2400);
      hud.setHint(engine.game, engine.getOppName(), connected, input.gamepad.connected, input.touchy, engine.training);
    },
    onGamepadStatusChange: (connected, label) => {
      hud.updateGamepadToolbar(connected, label);
      if (connected) hud.showMsg("Gamepad Connected", "A Drive · B Slice · X Drop · Y Lob", 2000);
      hud.setHint(engine.game, engine.getOppName(), !!input.wii.dev, connected, input.touchy, engine.training);
    },
    isOverlayOpen: () => menus.isOverlayOpen(),
    isServeReady: () => engine.game.phase === "serveReady",
    isChatOpen: () => chat.isOpen,
    canChat: () => lan.connected && lan.peer && engine.game.mode === "net",
    onChatOpen: () => chat.openComposer(),
    onChatClose: () => chat.closeComposer(),
    onQuickChat: (slot) => { chat.sendQuick(slot); },
    getViewportSize: () => [renderer.W, renderer.H],
    getHandedness: () => career.avatar.handedness,
  });

  engine = new GameEngine(career, settings, renderer, sfx, music, umpire, input, {
    showMsg: (big, small, ms) => hud.showMsg(big, small, ms),
    feedback: (label, detail, isCrit) => {
      if (engine.netCtx === "guest") lan.pushEvent({ k: "fb", a: [label, detail || "", !!isCrit] });
      else hud.feedback(label, detail, isCrit);
    },
    updateHud: () => hud.updateScoreHud(engine.game, engine.getOppName()),
    updateTrainHud: () => hud.updateTrainHud(engine.training, career, engine.game.mode === "training"),
    updateTelemetry: (mph, isRocket) => {
      if (mph && mph > 20 && lan.isHostLive()) lan.pushEvent({ k: "tel", a: [mph, !!isRocket] });
      if (engine.netCtx !== "guest") hud.updateTelemetry(engine.game, mph, isRocket);
    },
    updateServeMeter: (v, p) => hud.updateServeMeter(v, p),
    setHint: () => {
      if (engine.netCtx === "guest") return;
      hud.setHint(engine.game, engine.getOppName(), !!input.wii.dev, input.gamepad.connected, input.touchy, engine.training);
    },
    showEnd: () => menus.showEnd(),
    showTrainEnd: () => menus.showTrainEnd(),
    showTournamentBracket: (champ) => menus.showTournamentBracket(champ),
    showEndlessResult: () => menus.showEndlessResult(),
    updateReplayBanner: (vis, lbl) => hud.updateReplayBanner(vis, lbl),
    updateHawkEyeBanner: (vis, isIn, cm, line) => hud.updateHawkEyeBanner(vis, isIn, cm, line),
    onNetEvent: (e) => lan.pushEvent(e),
    isLanGuest: () => lan.role === "guest",
    onLanGuestSwing: (p, i) => lan.guestSwing(p, i),
    getLanPeerName: () => lan.peerName,
    getLanPeerAvatar: () => lan.peerAvatar,
    getLanRole: () => lan.role,
    setLanAimNext: (who) => { lan.aimNext = who; },
  });

  lan = new LanController(engine, {
    refreshLobby: () => menus.refreshLanLobby(),
    showTitle: () => menus.showTitle(),
    showNetEnd: () => menus.showNetEnd(),
    showMsg: (b, s, m) => hud.showMsg(b, s, m),
    feedback: (l, d, c) => hud.feedback(l, d, c),
    updateTelemetry: (m, r) => hud.updateTelemetry(engine.game, m, r),
    updateHud: () => hud.updateScoreHud(engine.game, engine.getOppName()),
    setHint: () => hud.setHint(engine.game, engine.getOppName(), !!input.wii.dev, input.gamepad.connected, input.touchy, engine.training),
    updatePing: (ms) => hud.updatePing(ms),
    hideOverlayForMatch: () => menus.closeOverlay(),
    onChat: (peerName, text, quick) => chat.receivePeer(peerName, text, quick),
    onChatReset: () => chat.clearSession(),
  });

  chat = new ChatController({
    onSend: (text, quick) => lan.sendChat(text, quick),
    onSound: (isRemote) => { sfx.init(); sfx.chat(isRemote); },
    getMyName: () => lan.myName || "You",
    getPeerName: () => lan.peerName || "Buddy",
    isLanReady: () => lan.connected && lan.peer,
    isLiveLanMatch: () => lan.connected && lan.peer && engine.game.mode === "net" && !menus.isOverlayOpen(),
  });

  menus = new MenuController(engine, lan, hud, chat);

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
  menus.showTitle();
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

    if (lan.role === "guest" && engine.game.mode === "net") {
      lan.guestTick(dt);
    } else {
      if (engine.game.mode === "net") lan.hostStep(dt);
      engine.update(dt);
      lan.hostSendSnapshot();
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
