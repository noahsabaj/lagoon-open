import {
  ALL_RIVAL_IDS,
  CAST,
  clamp,
  CORE_RIVAL_IDS,
  CUSTOMIZER_PALETTES,
  normalizeRoomCode,
  PRESETS,
  RACKET_CATALOG,
  TRAIL_CATALOG,
  VENUE_ORDER,
  VENUES,
} from "../core/constants";
import type {
  HairId,
  HatId,
  MatchDiscipline,
  MatchFormat,
  NetMode,
  PlayerSlot,
  RGB,
  SkyId,
  TrainingDrill,
  VenueId,
} from "../core/types";
import { saveCareer, saveSettings } from "../game/career";
import type { GameEngine } from "../game/engine";
import { rivalDisplayName, tournamentRoundName } from "../game/tournament";
import type { MultiplayerController } from "../net/session";
import { NET_PORT, resolveDefaultSignalUrl } from "../net/session";
import type { ChatController } from "./chat";
import { $, escHtml, type HudController } from "./hud";

const cssRgb = (c: RGB) => `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
const sameRgb = (a: RGB, b: RGB) => Math.abs(a[0] - b[0]) < 0.03 && Math.abs(a[1] - b[1]) < 0.03 && Math.abs(a[2] - b[2]) < 0.03;

const ICO = {
  play: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>`,
  trophy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>`,
  flame: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>`,
  target: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>`,
  wifi: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>`,
};

export class MenuController {
  private wiiMeterInterval: number | null = null;
  private lobbyTab: NetMode = "online";
  private joinCodeDraft = "";

  constructor(
    private engine: GameEngine,
    private net: MultiplayerController,
    private hud: HudController,
    private chat: ChatController
  ) {}

  private clearMeters(): void {
    if (this.wiiMeterInterval !== null) {
      clearInterval(this.wiiMeterInterval);
      this.wiiMeterInterval = null;
    }
  }

  private openCard(html: string, opts: { sideDock?: boolean; variant?: "" | "hub-card" | "wide-card" } = {}): void {
    this.clearMeters();
    this.chat.unmountEmbedded();
    this.chat.syncHudVisibility(false);
    const ov = $("overlay");
    const card = $("card");
    ov.classList.toggle("side-dock", !!opts.sideDock);
    card.className = `card chip${opts.variant ? " " + opts.variant : ""}`;
    card.innerHTML = html;
    ov.hidden = false;
    $("hint").hidden = true;
  }

  public closeOverlay(): void {
    this.clearMeters();
    this.chat.unmountEmbedded();
    $("overlay").hidden = true;
    $("overlay").classList.remove("side-dock");
    this.chat.syncHudVisibility(this.net.connected && this.net.hasAnyPeer && this.engine.game.mode === "net");
  }

  public isOverlayOpen(): boolean {
    return !$("overlay").hidden;
  }

  public openJoinRoomCode(code: string): void {
    this.lobbyTab = "online";
    this.joinCodeDraft = normalizeRoomCode(code);
    this.showLanLobby();
  }

  // ---------- MAIN TITLE HUB (2-Column Console Layout, Zero Scroll) ----------
  public showTitle(): void {
    if (this.engine.game.mode === "net") this.net.close();
    this.engine.trophyCeremony = false;
    this.engine.replay.stopReplay();
    this.engine.game.mode = "match";
    this.engine.game.phase = "title";
    this.engine.game.paused = false;
    this.engine.music.setMood("menu");
    this.hud.updateScoreHud(this.engine.game, this.engine.getOppName());
    this.hud.updateTrainHud(this.engine.training, this.engine.career, false);
    this.hud.updateSpectatorBar(false, this.net.spectatorCamMode, this.net.spectatorFollowSlot, 0);

    const cfg = this.engine.game.config;
    const c = this.engine.career;
    const selOpp = CAST[cfg.oppId] || CAST.reef;
    const selVenue = VENUES[cfg.venue] || VENUES.pier;
    const proBadge = c.skill >= 1000 ? `<span class="pro">PRO</span>` : "";
    const skillPct = clamp((c.skill / 1000) * 100, 3, 100);

    const surfaceShort: Record<VenueId, string> = { pier: "Hard", cove: "Clay", terrace: "Grass" };
    const coreCards = CORE_RIVAL_IDS.map((id) => {
      const o = CAST[id];
      const crestStyle = `background:linear-gradient(135deg,${cssRgb(o.avatar.shirt)},${cssRgb(o.avatar.shorts)});border-color:${cssRgb(o.avatar.stripe)}`;
      return `
        <button type="button" class="opp-card" data-opp="${o.id}" aria-pressed="${cfg.oppId === o.id}">
          <div class="opp-top">
            <span class="rival-crest" style="${crestStyle}">${o.name[0]}</span>
            <div class="opp-meta">
              <span class="opp-nm">${o.name}</span>
              <span class="opp-tier">${o.tierLabel} · ${surfaceShort[o.venue]}</span>
            </div>
            <span class="opp-crown">${c.crowns[o.id] ? "★" : ""}</span>
          </div>
          <div class="opp-desc">${o.desc}</div>
        </button>`;
    }).join("");

    const sol = CAST.sol;
    const solLocked = !c.bossUnlocked;
    const solCrest = solLocked
      ? `background:rgba(255,210,63,0.16);border-color:rgba(255,210,63,0.5);color:var(--sun)`
      : `background:linear-gradient(135deg,${cssRgb(sol.avatar.shirt)},${cssRgb(sol.avatar.shorts)});border-color:${cssRgb(sol.avatar.stripe)}`;

    const fmtLabel = cfg.format === "1game" ? "1 Game" : cfg.format === "6games" ? "6-Game Set" : "First to 3";
    const discLabel = cfg.discipline === "doubles" ? "Doubles 2v2" : "Singles 1v1";

    this.openCard(
      `
      <div class="hub-header">
        <div class="hub-brand">
          <div class="eyebrow">${escHtml(c.title)} · Tropical Pier Circuit</div>
          <div class="hub-title-row">
            <h1>Lagoon Open</h1>
            <span class="hub-sub">Wii-style auto-run arcade tennis</span>
          </div>
        </div>
        <div class="hub-profile">
          <div class="skill-pill" title="Reach 1000 Skill for PRO rank & Captain Sol">
            <span>Skill ${c.skill}</span>
            <span class="mini-bar"><i style="width:${skillPct}%"></i></span>
            ${proBadge}
          </div>
          <button class="profile-btn" id="customBtn" type="button">
            <span class="kit-dot" style="background:${cssRgb(c.avatar.shirt)};border-color:${cssRgb(c.avatar.stripe)}"></span>
            <span>Avatar #${c.avatar.num}</span>
          </button>
          <button class="profile-btn" id="careerBtn" type="button">
            <span>🏆 ${c.cupsWon}</span>
            <span>Trophies</span>
          </button>
        </div>
      </div>

      <div class="hub-grid">
        <div class="hub-left">
          <div class="sec-lbl"><span>Venue &amp; Surface Physics</span><span>${selVenue.physics.label}</span></div>
          <div class="venue-strip" role="group" aria-label="Venue">
            ${VENUE_ORDER.map((vid) => {
              const v = VENUES[vid];
              return `
                <button type="button" class="venue-btn" data-venue="${vid}" aria-pressed="${cfg.venue === vid}">
                  <span class="venue-dot ${vid}"></span>
                  <span class="venue-info">
                    <span class="venue-nm">${v.name}</span>
                    <span class="venue-surf">${v.surfaceLabel}</span>
                  </span>
                </button>`;
            }).join("")}
          </div>

          <div class="sec-lbl"><span>Select Challenger</span><span>${Object.keys(c.crowns).length}/7 Defeated</span></div>
          <div class="opps">${coreCards}</div>

          <button type="button" class="boss-bar${solLocked ? " locked" : ""}" data-opp="sol" aria-pressed="${cfg.oppId === "sol"}" ${solLocked ? "disabled" : ""}>
            <div class="boss-bar-left">
              <span class="rival-crest" style="${solCrest}">${solLocked ? "?" : "S"}</span>
              <div class="boss-bar-txt">
                <span class="opp-nm">${solLocked ? "Secret Legend · ???" : `${sol.name} ${c.crowns.sol ? "★" : ""}`}</span>
                <span class="opp-desc">${solLocked ? "Win the Lagoon Cup or reach PRO (1000 Skill) to unlock." : sol.desc}</span>
              </div>
            </div>
            <span class="boss-badge">${solLocked ? "LOCKED" : "LEGEND"}</span>
          </button>
        </div>

        <div class="hub-right">
          <div class="launch-box">
            <div class="sec-lbl"><span>Quick Match</span><span>${discLabel} · ${fmtLabel}</span></div>
            <div class="matchup-head">
              <div class="matchup-vs">vs ${escHtml(selOpp.name)}</div>
              <div class="matchup-sub">${selVenue.name}</div>
            </div>
            <div class="seg full" role="group" aria-label="Discipline">
              <button type="button" data-disc="singles" aria-pressed="${cfg.discipline === "singles"}">Singles (1v1)</button>
              <button type="button" data-disc="doubles" aria-pressed="${cfg.discipline === "doubles"}">Doubles (2v2)</button>
            </div>
            <div class="seg full" role="group" aria-label="Match Length">
              <button type="button" data-fmt="1game" aria-pressed="${cfg.format === "1game"}">1 Game</button>
              <button type="button" data-fmt="3games" aria-pressed="${cfg.format === "3games"}">First to 3</button>
              <button type="button" data-fmt="6games" aria-pressed="${cfg.format === "6games"}">6-Game Set</button>
            </div>
            <button class="play hero-cta" id="playBtn" type="button">${ICO.play}<span>Play Match</span></button>
          </div>

          <div class="sec-lbl"><span>Game Modes</span></div>
          <div class="mode-grid">
            <button class="mode-tile cup" id="cupBtn" type="button">
              <div class="mode-tile-top">
                <span class="mode-ico">${ICO.trophy}</span>
                <span class="mode-tag">3 Rounds</span>
              </div>
              <span class="mode-nm">Lagoon Cup</span>
              <span class="mode-sub">Knockout bracket &amp; trophy ceremony</span>
            </button>
            <button class="mode-tile endless" id="endlessBtn" type="button">
              <div class="mode-tile-top">
                <span class="mode-ico">${ICO.flame}</span>
                <span class="mode-tag">Best ${c.endlessBest}</span>
              </div>
              <span class="mode-nm">King of the Pier</span>
              <span class="mode-sub">Endless rising-pace streak</span>
            </button>
            <button class="mode-tile train" id="trainBtn" type="button">
              <div class="mode-tile-top">
                <span class="mode-ico">${ICO.target}</span>
                <span class="mode-tag">3 Drills</span>
              </div>
              <span class="mode-nm">Training</span>
              <span class="mode-sub">Rings, rally &amp; serve blitz</span>
            </button>
            <button class="mode-tile lan" id="lanBtn" type="button">
              <div class="mode-tile-top">
                <span class="mode-ico">${ICO.wifi}</span>
                <span class="mode-tag">Online · LAN</span>
              </div>
              <span class="mode-nm">Online &amp; LAN</span>
              <span class="mode-sub">4-letter code, 2v2 &amp; Spectate</span>
            </button>
          </div>
        </div>
      </div>

      <div class="keybar">
        <div class="keybar-items">
          <span class="key-item"><kbd>LMB</kbd> / <kbd>Space</kbd> Drive</span>
          <span class="key-item"><kbd>RMB</kbd> / <kbd>X</kbd> Slice</span>
          <span class="key-item"><kbd>V</kbd> / <kbd>S+RMB</kbd> Drop</span>
          <span class="key-item"><kbd>C</kbd> Lob</span>
          <span class="key-item"><kbd>WASD</kbd> Shade / Net</span>
        </div>
        <span class="keybar-ctrl">Gamepad &amp; Wii Remote Ready</span>
      </div>
    `,
      { variant: "hub-card" }
    );

    document.querySelectorAll<HTMLButtonElement>("[data-disc]").forEach((b) => {
      b.onclick = () => {
        this.engine.sfx.init(); this.engine.sfx.ui();
        cfg.discipline = b.dataset.disc as MatchDiscipline;
        this.showTitle();
      };
    });
    document.querySelectorAll<HTMLButtonElement>("[data-fmt]").forEach((b) => {
      b.onclick = () => {
        this.engine.sfx.init(); this.engine.sfx.ui();
        cfg.format = b.dataset.fmt as MatchFormat;
        this.showTitle();
      };
    });
    document.querySelectorAll<HTMLButtonElement>("[data-venue]").forEach((b) => {
      b.onclick = () => {
        this.engine.sfx.init(); this.engine.sfx.ui();
        cfg.venue = b.dataset.venue as VenueId;
        this.showTitle();
      };
    });
    document.querySelectorAll<HTMLButtonElement>("[data-opp]:not(:disabled)").forEach((b) => {
      b.onclick = () => {
        this.engine.sfx.init(); this.engine.sfx.ui();
        const id = b.dataset.opp!;
        cfg.oppId = id;
        cfg.venue = CAST[id].venue;
        this.showTitle();
      };
    });

    $("playBtn").onclick = () => { this.closeOverlay(); this.engine.startMatch(undefined, "match"); };
    $("cupBtn").onclick = () => { this.engine.sfx.init(); this.engine.sfx.ui(); this.engine.startTournament(cfg.discipline, cfg.format); };
    $("trainBtn").onclick = () => { this.engine.sfx.init(); this.engine.sfx.ui(); this.showTrainingMenu(); };
    $("endlessBtn").onclick = () => { this.closeOverlay(); this.engine.startEndless(cfg.discipline); };
    $("lanBtn").onclick = () => { this.engine.sfx.init(); this.engine.sfx.ui(); this.showLanLobby(); };
    $("customBtn").onclick = () => { this.engine.sfx.init(); this.engine.sfx.ui(); this.showCustomizer(); };
    $("careerBtn").onclick = () => { this.engine.sfx.init(); this.engine.sfx.ui(); this.showCareer(); };
  }

  // ---------- TRAINING DRILLS MENU ----------
  public showTrainingMenu(): void {
    const c = this.engine.career;
    const medalIcon = (m: string) => (m === "gold" ? "🥇 Gold Medal" : m === "silver" ? "🥈 Silver Medal" : m === "bronze" ? "🥉 Bronze Medal" : "No medal yet");
    const drills: Array<{ id: TrainingDrill; name: string; desc: string; best: string }> = [
      { id: "rings", name: "Target Rings", desc: "60s corner-painting challenge. Chain hits through moving gold rings up to a ×5.0 multiplier.", best: `${c.trainingBest.rings} pts` },
      { id: "rally", name: "Rally Endurance", desc: "Survive an accelerating rally with 3 lives. Sharpens swing timing & desperation Dive saves.", best: `${c.trainingBest.rally} streak` },
      { id: "serve", name: "Serve & Return Blitz", desc: "Alternate Rocket Serves and 110+ MPH return bombs into glowing bonus court targets.", best: `${c.trainingBest.serve} pts` },
    ];

    this.openCard(
      `
      <div class="top-meta">
        <div class="eyebrow">Training Circuit · ${VENUES[this.engine.game.config.venue].name}</div>
        <div class="skill-pill"><span>${VENUES[this.engine.game.config.venue].surfaceLabel}</span></div>
      </div>
      <h1>Training Drills</h1>
      <p class="lede">Earn medals to unlock the <b>Aero Carbon</b> racket frame and <b>Twilight Pulse</b> swing trail.</p>
      <div class="drill-grid">
        ${drills.map((d) => `
          <button type="button" class="drill-card" data-drill="${d.id}">
            <span class="drill-nm">${d.name}</span>
            <span class="drill-medal">${medalIcon(c.trainingMedals[d.id])}</span>
            <span class="drill-desc">${d.desc}</span>
            <span class="drill-best">Personal Best: ${d.best}</span>
          </button>`).join("")}
      </div>
      <div class="row">
        <button class="play ghost" id="trBack" type="button">Back to Hub</button>
      </div>
    `,
      { variant: "wide-card" }
    );

    document.querySelectorAll<HTMLButtonElement>("[data-drill]").forEach((b) => {
      b.onclick = () => {
        this.closeOverlay();
        this.engine.startTraining(b.dataset.drill as TrainingDrill);
      };
    });
    $("trBack").onclick = () => { this.engine.sfx.ui(); this.showTitle(); };
  }

  // ---------- LIVE 3D AVATAR & RACKET CUSTOMIZER (Pinned Header & Footer) ----------
  public showCustomizer(): void {
    this.engine.enterCustomizer();
    const av = this.engine.career.avatar;
    const c = this.engine.career;

    const swatchRow = (label: string, key: "skin" | "hairColor" | "shirt" | "stripe" | "shorts", palette: RGB[]) => `
      <div class="swatch-line">
        <span class="swatch-name">${label}</span>
        <div class="swatches">${palette
          .map(
            (col, i) =>
              `<button type="button" class="swatch" data-pal="${key}" data-idx="${i}" style="background:${cssRgb(col)}" aria-pressed="${sameRgb(av[key], col)}" aria-label="${label} color ${i + 1}"></button>`
          )
          .join("")}</div>
      </div>`;

    const hairs: Array<{ id: HairId; label: string }> = [
      { id: "Hair_Classic", label: "Classic" },
      { id: "Hair_Ponytail", label: "Ponytail" },
      { id: "Hair_Mohawk", label: "Mohawk" },
      { id: "Hair_Curly", label: "Curly" },
      { id: "Hair_Bob", label: "Bob" },
    ];
    const hats: Array<{ id: HatId; label: string }> = [
      { id: "none", label: "None" },
      { id: "Hat_Visor", label: "Visor" },
      { id: "Hat_Cap", label: "Cap" },
      { id: "Hat_Captain", label: "Captain" },
    ];

    const activeRacket = RACKET_CATALOG.find((r) => r.id === av.racket)?.name || "Coral Pro";
    const activeTrail = TRAIL_CATALOG.find((t) => t.id === av.trail)?.name || "Solar Flare";

    this.openCard(
      `
      <div class="drawer-head">
        <div class="top-meta">
          <div class="eyebrow">Live 3D Studio Preview</div>
          <div class="skill-pill"><span>Jersey #${av.num}</span></div>
        </div>
        <h2>Player &amp; Racket</h2>
      </div>

      <div class="drawer-body">
        <div class="cust-group">
          <div class="cust-lbl"><span>Stance &amp; Jersey Number</span></div>
          <div class="split-row">
            <div class="seg">
              <button type="button" data-hand="right" aria-pressed="${av.handedness === "right"}">Right-Handed</button>
              <button type="button" data-hand="left" aria-pressed="${av.handedness === "left"}">Left-Handed</button>
            </div>
            <div class="row">
              <button type="button" class="btn" id="numDec" aria-label="Decrease jersey number">−</button>
              <b>#${av.num}</b>
              <button type="button" class="btn" id="numInc" aria-label="Increase jersey number">+</button>
            </div>
          </div>
        </div>

        <div class="cust-group">
          <div class="cust-lbl"><span>Racket Frame</span><span class="val-tag">${escHtml(activeRacket)}</span></div>
          <div class="seg">
            ${RACKET_CATALOG.map((r) => {
              const ok = c.unlockedRackets.includes(r.id);
              return `<button type="button" data-racket="${r.id}" aria-pressed="${av.racket === r.id}" ${ok ? "" : `disabled title="${r.unlockHint}"`}>${ok ? r.name : "🔒 " + r.name}</button>`;
            }).join("")}
          </div>
        </div>

        <div class="cust-group">
          <div class="cust-lbl"><span>Swing Trail</span><span class="val-tag">${escHtml(activeTrail)}</span></div>
          <div class="seg">
            ${TRAIL_CATALOG.map((t) => {
              const ok = c.unlockedTrails.includes(t.id);
              return `<button type="button" data-trail="${t.id}" aria-pressed="${av.trail === t.id}" ${ok ? "" : `disabled title="${t.unlockHint}"`}>${ok ? t.name : "🔒 " + t.name}</button>`;
            }).join("")}
          </div>
        </div>

        <div class="cust-group">
          <div class="cust-lbl"><span>Hairstyle &amp; Headgear</span></div>
          <div class="seg full">${hairs.map((h) => `<button type="button" data-hair="${h.id}" aria-pressed="${av.hair === h.id}">${h.label}</button>`).join("")}</div>
          <div class="seg full">${hats.map((h) => {
            const ok = c.unlockedHats.includes(h.id);
            return `<button type="button" data-hat="${h.id}" aria-pressed="${av.hat === h.id}" ${ok ? "" : "disabled"}>${ok ? h.label : "🔒 " + h.label}</button>`;
          }).join("")}</div>
        </div>

        <div class="cust-group">
          <div class="cust-lbl"><span>Appearance</span></div>
          ${swatchRow("Skin", "skin", CUSTOMIZER_PALETTES.skins)}
          ${swatchRow("Hair", "hairColor", CUSTOMIZER_PALETTES.hairs)}
        </div>

        <div class="cust-group">
          <div class="cust-lbl"><span>Match Kit Colors</span></div>
          ${swatchRow("Shirt", "shirt", CUSTOMIZER_PALETTES.clothes)}
          ${swatchRow("Trim", "stripe", CUSTOMIZER_PALETTES.clothes)}
          ${swatchRow("Shorts", "shorts", CUSTOMIZER_PALETTES.clothes)}
        </div>
      </div>

      <div class="drawer-foot">
        <button class="play" id="custDone" type="button">Save &amp; Back to Hub</button>
      </div>
    `,
      { sideDock: true }
    );

    const refresh = () => {
      saveCareer(this.engine.career);
      this.showCustomizer();
    };

    document.querySelectorAll<HTMLButtonElement>("[data-hand]").forEach((b) => {
      b.onclick = () => { av.handedness = b.dataset.hand as "right" | "left"; this.engine.sfx.ui(); refresh(); };
    });
    $("numDec").onclick = () => { av.num = av.num <= 1 ? 99 : av.num - 1; this.engine.sfx.ui(); refresh(); };
    $("numInc").onclick = () => { av.num = av.num >= 99 ? 1 : av.num + 1; this.engine.sfx.ui(); refresh(); };
    document.querySelectorAll<HTMLButtonElement>("[data-racket]:not(:disabled)").forEach((b) => {
      b.onclick = () => { av.racket = b.dataset.racket as typeof av.racket; this.engine.sfx.ui(); refresh(); };
    });
    document.querySelectorAll<HTMLButtonElement>("[data-trail]:not(:disabled)").forEach((b) => {
      b.onclick = () => { av.trail = b.dataset.trail as typeof av.trail; this.engine.sfx.ui(); refresh(); };
    });
    document.querySelectorAll<HTMLButtonElement>("[data-hair]").forEach((b) => {
      b.onclick = () => { av.hair = b.dataset.hair as HairId; this.engine.sfx.ui(); refresh(); };
    });
    document.querySelectorAll<HTMLButtonElement>("[data-hat]:not(:disabled)").forEach((b) => {
      b.onclick = () => { av.hat = b.dataset.hat as HatId; this.engine.sfx.ui(); refresh(); };
    });
    document.querySelectorAll<HTMLButtonElement>("[data-pal]").forEach((b) => {
      b.onclick = () => {
        const key = b.dataset.pal as "skin" | "hairColor" | "shirt" | "stripe" | "shorts";
        const idx = Number(b.dataset.idx);
        const pal = key === "skin" ? CUSTOMIZER_PALETTES.skins : key === "hairColor" ? CUSTOMIZER_PALETTES.hairs : CUSTOMIZER_PALETTES.clothes;
        av[key] = [...pal[idx]] as RGB;
        if (key === "shirt") av.accent = [...pal[idx]] as RGB;
        this.engine.sfx.ui();
        refresh();
      };
    });
    $("custDone").onclick = () => { this.engine.sfx.ui(); saveCareer(this.engine.career); this.showTitle(); };
  }

  // ---------- CAREER & TROPHY CASE ----------
  public showCareer(): void {
    const c = this.engine.career;
    const pct = clamp((c.skill / 2000) * 100, 1, 100);
    const rivalChips = ALL_RIVAL_IDS.map((id) => {
      const won = !!c.crowns[id];
      const nm = CAST[id].secret && !c.bossUnlocked ? "???" : CAST[id].name;
      return `<span class="crown-chip${won ? " won" : ""}">${won ? "★ " : ""}${escHtml(nm)}</span>`;
    }).join("");

    this.openCard(
      `
      <div class="top-meta">
        <div class="eyebrow">Career Profile · ${escHtml(c.title)}</div>
        <div class="skill-pill"><span>Skill ${c.skill}</span>${c.skill >= 1000 ? `<span class="pro">PRO</span>` : ""}</div>
      </div>
      <h1>Trophy Case</h1>
      <div class="skill-box">
        <div class="skill-head"><span>Skill Rating (PRO &amp; ${c.bossUnlocked ? "Captain Sol" : "Secret Legend"} at 1000)</span><span>${c.skill} / 2000</span></div>
        <div class="skill-bar"><div class="skill-fill" style="width:${pct}%"></div><div class="skill-mark"></div></div>
      </div>
      <div class="stats-grid">
        <div class="stat-box"><div class="sv">${c.wins}–${c.losses}</div><div class="sl">Record</div></div>
        <div class="stat-box"><div class="sv">${c.cupsWon} 🏆</div><div class="sl">Lagoon Cups</div></div>
        <div class="stat-box"><div class="sv">${c.endlessBest}</div><div class="sl">Pier Streak</div></div>
        <div class="stat-box"><div class="sv">${c.fastestServe || "—"}</div><div class="sl">Top MPH</div></div>
        <div class="stat-box"><div class="sv">${c.aces}</div><div class="sl">Career Aces</div></div>
        <div class="stat-box"><div class="sv">${c.longestRally}</div><div class="sl">Max Rally</div></div>
        <div class="stat-box"><div class="sv">${c.unlockedRackets.length}/5</div><div class="sl">Rackets</div></div>
        <div class="stat-box"><div class="sv">${c.unlockedTrails.length}/5</div><div class="sl">Trails</div></div>
      </div>
      <div class="cust-group">
        <div class="cust-lbl"><span>Rival Crowns</span></div>
        <div class="crown-chips">${rivalChips}</div>
      </div>
      <div class="row">
        <button class="play" id="carBack" type="button">Back to Hub</button>
      </div>
    `,
      { variant: "wide-card" }
    );
    $("carBack").onclick = () => { this.engine.sfx.ui(); this.showTitle(); };
  }

  // ---------- TOURNAMENT BRACKET ----------
  public showTournamentBracket(champion = false): void {
    const t = this.engine.tournament;
    if (!t) { this.showTitle(); return; }
    const colHtml = (rIdx: number, title: string) => `
      <div class="b-col">
        <div class="b-hdr">${title}</div>
        ${t.rounds[rIdx]
          .map(
            (m, mi) => `
          <div class="b-match ${t.active && t.round === rIdx && mi === 0 ? "active" : ""}">
            <div class="b-row ${m.winner === m.p1 ? "win" : ""}"><span>${escHtml(rivalDisplayName(m.p1))}</span><span>${m.score && m.winner === m.p1 ? m.score : ""}</span></div>
            <div class="b-row ${m.winner === m.p2 ? "win" : ""}"><span>${escHtml(rivalDisplayName(m.p2))}</span><span>${m.score && m.winner === m.p2 ? m.score : ""}</span></div>
          </div>`
          )
          .join("")}
      </div>`;

    const unlocks = this.engine.game.newUnlocks.length
      ? `<div class="unlock-toast">🎉 ${this.engine.game.newUnlocks.map(escHtml).join(" · ")}</div>`
      : "";

    this.openCard(
      `
      <div class="eyebrow">Lagoon Cup · ${t.discipline === "doubles" ? "Doubles 2v2" : "Singles"} Knockout</div>
      <h1>${champion ? "Cup Champion! 🏆" : t.active ? tournamentRoundName(t.round) : "Eliminated"}</h1>
      ${unlocks}
      <div class="bracket">
        ${colHtml(0, "Quarterfinals")}
        ${colHtml(1, "Semifinals")}
        ${colHtml(2, "Final")}
      </div>
      <div class="row">
        ${t.active ? `<button class="play" id="cupNext" type="button">${ICO.play}<span>Play ${tournamentRoundName(t.round)}</span></button>` : `<button class="play gold" id="cupAgain" type="button">New Lagoon Cup</button>`}
        <button class="play ghost" id="cupHome" type="button">Main Menu</button>
      </div>
    `,
      { variant: "wide-card" }
    );

    if (t.active) $("cupNext").onclick = () => { this.closeOverlay(); this.engine.launchNextTournamentMatch(); };
    else $("cupAgain").onclick = () => { this.engine.startTournament(t.discipline, t.format); };
    $("cupHome").onclick = () => { this.engine.sfx.ui(); this.showTitle(); };
  }

  // ---------- SETTINGS & CONTROLS (2-Column Balanced + Custom Switches) ----------
  public showSettings(returnToPause = false): void {
    const s = this.engine.settings;
    const wasPaused = this.engine.game.paused;
    if (this.engine.game.phase !== "title" && this.engine.game.mode !== "net") {
      this.engine.game.paused = true;
    }

    this.openCard(
      `
      <div class="eyebrow">Audio, Gameplay &amp; Controller Calibration</div>
      <h1>Settings</h1>

      <div class="settings-grid">
        <div class="cust-group">
          <div class="cust-lbl"><span>Audio Mixer</span></div>
          <div class="setting-row"><span>Master Volume</span><span class="setting-ctrl"><input id="sMaster" type="range" min="0" max="1" step="0.05" value="${s.masterVol}"><span class="range-val" id="vMaster">${Math.round(s.masterVol * 100)}%</span></span></div>
          <div class="setting-row"><span>Tropical Music</span><span class="setting-ctrl"><input id="sMusic" type="range" min="0" max="1" step="0.05" value="${s.musicVol}"><span class="range-val" id="vMusic">${Math.round(s.musicVol * 100)}%</span></span></div>
          <div class="setting-row"><span>Court &amp; Crowd SFX</span><span class="setting-ctrl"><input id="sSfx" type="range" min="0" max="1" step="0.05" value="${s.sfxVol}"><span class="range-val" id="vSfx">${Math.round(s.sfxVol * 100)}%</span></span></div>
          <div class="setting-row"><span>Umpire Voice</span><span class="setting-ctrl"><input id="sVoice" type="range" min="0" max="1" step="0.05" value="${s.voiceVol}"><span class="range-val" id="vVoice">${Math.round(s.voiceVol * 100)}%</span></span></div>
          <div class="setting-row"><span>Music During Rallies</span><input class="switch" id="sRallyMus" type="checkbox" ${s.rallyMusic ? "checked" : ""}></div>
          <div class="setting-row"><span>Spoken Umpire Callouts</span><input class="switch" id="sVoiceOn" type="checkbox" ${s.umpireVoice ? "checked" : ""}></div>
        </div>

        <div class="cust-group">
          <div class="cust-lbl"><span>Controls &amp; Motion</span></div>
          <div class="setting-row"><span>Doubles AI Partner<br><span class="note">Off = Classic Dual-Control</span></span><input class="switch" id="sAiPart" type="checkbox" ${s.aiPartner ? "checked" : ""}></div>
          <div class="setting-row"><span>Mouse Hover-Flick<br><span class="note">No-click cursor swings</span></span><input class="switch" id="sHover" type="checkbox" ${s.hoverFlick ? "checked" : ""}></div>
          <div class="setting-row"><span>Wii Sensitivity</span><span class="setting-ctrl"><input id="sWiiSens" type="range" min="0.6" max="1.8" step="0.1" value="${s.wiiSensitivity}"><span class="range-val" id="vWiiSens">${s.wiiSensitivity.toFixed(1)}×</span></span></div>
          <div class="setting-row"><span>MotionPlus Gyro Assist</span><input class="switch" id="sWiiMp" type="checkbox" ${s.wiiMotionPlus ? "checked" : ""}></div>
          <div class="setting-row"><span>Live Wii Swing G-Meter</span><div class="g-meter"><div class="g-fill" id="wiiGFill"></div></div></div>
        </div>
      </div>

      <div class="row">
        <button class="play" id="setClose" type="button">Done</button>
        <button class="play ghost" id="setTestVoice" type="button">Test Umpire Voice</button>
      </div>
    `,
      { variant: "wide-card" }
    );

    const apply = () => {
      s.masterVol = Number(($("sMaster") as HTMLInputElement).value);
      s.musicVol = Number(($("sMusic") as HTMLInputElement).value);
      s.sfxVol = Number(($("sSfx") as HTMLInputElement).value);
      s.voiceVol = Number(($("sVoice") as HTMLInputElement).value);
      s.rallyMusic = ($("sRallyMus") as HTMLInputElement).checked;
      s.umpireVoice = ($("sVoiceOn") as HTMLInputElement).checked;
      s.aiPartner = ($("sAiPart") as HTMLInputElement).checked;
      s.hoverFlick = ($("sHover") as HTMLInputElement).checked;
      s.wiiSensitivity = Number(($("sWiiSens") as HTMLInputElement).value);
      s.wiiMotionPlus = ($("sWiiMp") as HTMLInputElement).checked;
      $("vMaster").textContent = `${Math.round(s.masterVol * 100)}%`;
      $("vMusic").textContent = `${Math.round(s.musicVol * 100)}%`;
      $("vSfx").textContent = `${Math.round(s.sfxVol * 100)}%`;
      $("vVoice").textContent = `${Math.round(s.voiceVol * 100)}%`;
      $("vWiiSens").textContent = `${s.wiiSensitivity.toFixed(1)}×`;
      saveSettings(s);
      this.engine.sfx.applyVolumes();
      this.engine.music.refreshSettings();
    };

    for (const id of ["sMaster", "sMusic", "sSfx", "sVoice", "sRallyMus", "sVoiceOn", "sAiPart", "sHover", "sWiiSens", "sWiiMp"]) {
      $(id).oninput = apply;
    }
    $("setTestVoice").onclick = () => {
      this.engine.sfx.init();
      this.engine.umpire.announceCall("Fifteen, Love. Lagoon Open!");
    };
    $("setClose").onclick = () => {
      apply();
      this.engine.sfx.ui();
      if (this.engine.game.phase === "title") this.showTitle();
      else if (returnToPause) this.showPause();
      else {
        this.engine.game.paused = wasPaused;
        this.closeOverlay();
      }
    };

    this.wiiMeterInterval = window.setInterval(() => {
      const fill = document.getElementById("wiiGFill");
      if (fill) fill.style.width = `${clamp((this.engine.input.wii.lastMag / 4.5) * 100, 0, 100)}%`;
    }, 60);
  }

  // ---------- PAUSE & POST-MATCH ----------
  public showPause(): void {
    this.engine.game.paused = true;
    this.openCard(`
      <div class="eyebrow">Match Paused</div>
      <h1>Timeout</h1>
      <p class="lede">Adjust audio, controls, lighting, or graphics anytime, or jump straight back into the rally.</p>
      <div class="row">
        <button class="play" id="resumeBtn" type="button">${ICO.play}<span>Resume</span></button>
        <button class="play alt" id="restartBtn" type="button">Restart</button>
        <button class="play ghost" id="pauseSetBtn" type="button">Settings</button>
        <button class="play ghost" id="homeBtn" type="button">Main Menu</button>
      </div>
    `);
    $("resumeBtn").onclick = () => { this.engine.sfx.ui(); this.engine.game.paused = false; this.closeOverlay(); };
    $("restartBtn").onclick = () => {
      this.engine.sfx.ui();
      this.engine.game.paused = false;
      this.closeOverlay();
      if (this.engine.game.mode === "training") this.engine.startTraining(this.engine.training.drill);
      else this.engine.startMatch(undefined, this.engine.game.mode);
    };
    $("pauseSetBtn").onclick = () => { this.engine.sfx.ui(); this.showSettings(true); };
    $("homeBtn").onclick = () => { this.engine.sfx.ui(); this.showTitle(); };
  }

  public showEnd(): void {
    if (this.engine.game.mode === "net") { this.showNetEnd(); return; }
    const g = this.engine.game;
    const c = this.engine.career;
    const w = g.winner;
    const o = CAST[g.config.oppId] || CAST.reef;
    const d = g.lastSkillDelta;
    const pct = clamp((c.skill / 2000) * 100, 1, 100);
    const idx = ALL_RIVAL_IDS.indexOf(o.id);
    const nextId = idx >= 0 && idx + 1 < ALL_RIVAL_IDS.length ? ALL_RIVAL_IDS[idx + 1] : null;
    const nextUnlocked = nextId && (!CAST[nextId].secret || c.bossUnlocked) ? nextId : null;
    const unlocks = g.newUnlocks.length
      ? `<div class="unlock-toast">🎉 ${g.newUnlocks.map(escHtml).join(" · ")}</div>`
      : "";

    this.openCard(`
      <div class="top-meta">
        <div class="eyebrow">${w === 0 ? "Pier Champion" : `${o.name} keeps the court`}</div>
        <div class="skill-pill"><span>Skill ${c.skill}</span>${c.skill >= 1000 ? `<span class="pro">PRO</span>` : ""}</div>
      </div>
      <div class="final-row">
        <h1>${w === 0 ? "You Win!" : "Tough Match"}</h1>
        <div class="final">${g.games[0]}–${g.games[1]}</div>
      </div>
      ${unlocks}
      <div class="skill-box">
        <div class="skill-head"><span>Skill Rating (PRO at 1000)</span><span class="skill-delta ${d >= 0 ? "up" : "dn"}">${d >= 0 ? "+" : ""}${d}</span></div>
        <div class="skill-bar"><div class="skill-fill" style="width:${pct}%"></div><div class="skill-mark"></div></div>
      </div>
      <div class="stats-grid">
        <div class="stat-box"><div class="sv">${g.stats.fastestServe || "—"}</div><div class="sl">Top MPH</div></div>
        <div class="stat-box"><div class="sv">${g.stats.aces}</div><div class="sl">Aces</div></div>
        <div class="stat-box"><div class="sv">${g.stats.winners}</div><div class="sl">Winners</div></div>
        <div class="stat-box"><div class="sv">${g.stats.longestRally}</div><div class="sl">Max Rally</div></div>
      </div>
      <div class="row">
        <button class="play" id="rematchBtn" type="button">Rematch</button>
        ${w === 0 && nextUnlocked ? `<button class="play alt" id="nextBtn" type="button">Challenge ${CAST[nextUnlocked].name}</button>` : ""}
        <button class="play ghost" id="homeBtn" type="button">Main Menu</button>
      </div>
    `);
    $("rematchBtn").onclick = () => { this.closeOverlay(); this.engine.startMatch(undefined, "match"); };
    if (w === 0 && nextUnlocked) {
      $("nextBtn").onclick = () => {
        this.closeOverlay();
        this.engine.startMatch({ oppId: nextUnlocked, venue: CAST[nextUnlocked].venue }, "match");
      };
    }
    $("homeBtn").onclick = () => this.showTitle();
  }

  public showTrainEnd(): void {
    const tr = this.engine.training;
    const c = this.engine.career;
    const medal = c.trainingMedals[tr.drill];
    const unlocks = this.engine.game.newUnlocks.length
      ? `<div class="unlock-toast">🎉 ${this.engine.game.newUnlocks.map(escHtml).join(" · ")}</div>`
      : "";

    this.openCard(`
      <div class="eyebrow">Training Complete · Medal: ${medal.toUpperCase()}</div>
      <div class="final-row">
        <h1>${tr.score >= c.trainingBest[tr.drill] && tr.score > 0 ? "New Record!" : "Nice Session!"}</h1>
        <div class="final">${tr.score}</div>
      </div>
      ${unlocks}
      <p class="lede">Personal Best: <b>${c.trainingBest[tr.drill]}</b>.</p>
      <div class="row">
        <button class="play" id="againBtn" type="button">Play Again</button>
        <button class="play alt" id="drillsBtn" type="button">All Drills</button>
        <button class="play ghost" id="homeBtn" type="button">Main Menu</button>
      </div>
    `);
    $("againBtn").onclick = () => { this.closeOverlay(); this.engine.startTraining(tr.drill); };
    $("drillsBtn").onclick = () => this.showTrainingMenu();
    $("homeBtn").onclick = () => this.showTitle();
  }

  public showEndlessResult(): void {
    const e = this.engine.endless;
    const wins = e ? e.wins : 0;
    const unlocks = this.engine.game.newUnlocks.length
      ? `<div class="unlock-toast">🎉 ${this.engine.game.newUnlocks.map(escHtml).join(" · ")}</div>`
      : "";
    this.openCard(`
      <div class="eyebrow">King of the Pier · Endless Run Over</div>
      <div class="final-row">
        <h1>${wins >= 5 ? "Pier Legend!" : "Great Run!"}</h1>
        <div class="final">${wins} Wins</div>
      </div>
      ${unlocks}
      <p class="lede">All-time Endless Best: <b>${this.engine.career.endlessBest} consecutive wins</b>.</p>
      <div class="row">
        <button class="play" id="endAgain" type="button">Run Again</button>
        <button class="play ghost" id="endHome" type="button">Main Menu</button>
      </div>
    `);
    $("endAgain").onclick = () => { this.closeOverlay(); this.engine.startEndless(this.engine.game.config.discipline); };
    $("endHome").onclick = () => this.showTitle();
  }

  private async copyText(text: string, btn: HTMLButtonElement, defaultLabel: string): Promise<void> {
    let ok = false;
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      document.body.removeChild(ta);
    }
    this.engine.sfx.ui();
    btn.textContent = ok ? "Copied ✓" : "Select & Cmd+C";
    window.setTimeout(() => {
      if (btn.isConnected) btn.textContent = defaultLabel;
    }, 1800);
  }

  // ---------- ONLINE (4-LETTER CODE) & LOCAL LAN MULTIPLAYER LOBBY ----------
  public showLanLobby(): void {
    this.engine.game.phase = "title";
    this.hud.updateSpectatorBar(false, this.net.spectatorCamMode, this.net.spectatorFollowSlot, 0);
    if (this.net.connected) this.lobbyTab = this.net.mode;

    const served = location.protocol.startsWith("http") && String(location.port) === String(NET_PORT);
    const joinVal = this.net.addr || (served ? location.hostname : "");
    const lc = this.net.lobbyConfig;
    const isGuest = this.net.role === "guest";
    const isConnected = this.net.connected;
    const tab = this.lobbyTab;

    this.openCard(
      `
      <div class="top-meta">
        <div class="eyebrow">${tab === "online" ? "Online Multiplayer · 4-Letter Room Code · P2P" : "Local LAN · Zero-Internet Wi-Fi"}</div>
        <div class="skill-pill"><span id="lanPill">Offline</span></div>
      </div>
      <h1>Online &amp; LAN</h1>

      <div class="net-tabs" role="tablist" aria-label="Multiplayer connection mode">
        <button type="button" class="net-tab" data-nettab="online" aria-pressed="${tab === "online"}" ${isConnected ? "disabled" : ""}>Online (Room Code)</button>
        <button type="button" class="net-tab" data-nettab="lan" aria-pressed="${tab === "lan"}" ${isConnected ? "disabled" : ""}>Local LAN (Wi-Fi)</button>
      </div>

      <label class="field">Your Display Name<input id="lanName" maxlength="14" autocomplete="off" spellcheck="false" value="${escHtml(this.net.myName)}" placeholder="Player"></label>

      <div class="cust-group">
        <div class="cust-lbl"><span>Match Settings</span><span class="val-tag" id="lanCtrlTag">${isGuest ? "Controlled by Host" : "Host Controls"}</span></div>
        <div class="split-row">
          <div class="seg">
            <button type="button" data-ldisc="singles" aria-pressed="${lc.discipline === "singles"}" ${isGuest ? "disabled" : ""}>Singles (1v1)</button>
            <button type="button" data-ldisc="doubles" aria-pressed="${lc.discipline === "doubles"}" ${isGuest ? "disabled" : ""}>Doubles (2v2)</button>
          </div>
          <div class="seg">
            <button type="button" data-lfmt="1game" aria-pressed="${lc.format === "1game"}" ${isGuest ? "disabled" : ""}>1 Game</button>
            <button type="button" data-lfmt="3games" aria-pressed="${lc.format === "3games"}" ${isGuest ? "disabled" : ""}>First to 3</button>
            <button type="button" data-lfmt="6games" aria-pressed="${lc.format === "6games"}" ${isGuest ? "disabled" : ""}>6-Game Set</button>
          </div>
        </div>
        <div class="split-row" id="lanSoloFillRow" ${lc.discipline === "doubles" ? "" : "hidden"}>
          <span class="note">Empty Doubles Seats:</span>
          <div class="seg">
            <button type="button" data-lfill="bot" aria-pressed="${lc.soloDoublesMode === "bot"}" ${isGuest ? "disabled" : ""}>AI Bot Fill</button>
            <button type="button" data-lfill="dual" aria-pressed="${lc.soloDoublesMode === "dual"}" ${isGuest ? "disabled" : ""}>Dual-Control</button>
          </div>
        </div>
        <div class="split-row">
          <div class="seg">
            ${VENUE_ORDER.map((v) => `<button type="button" data-lven="${v}" aria-pressed="${lc.venue === v}" ${isGuest ? "disabled" : ""}>${VENUES[v].name}</button>`).join("")}
          </div>
          <div class="seg">
            ${(["noon", "golden", "twilight", "night"] as SkyId[]).map((sk) => `<button type="button" data-lsky="${sk}" aria-pressed="${lc.sky === sk}" ${isGuest ? "disabled" : ""}>${PRESETS[sk].label.split(" ")[0]}</button>`).join("")}
          </div>
        </div>
      </div>

      <div id="lanConnectGrid">
        ${
          tab === "online"
            ? `
          <div class="lan-grid">
            <div class="lan-box">
              <b>Host Room</b>
              <span class="note">Instant 4-letter room code for up to 4 players &amp; 6 spectators.</span>
              <button class="play alt" id="hostBtn" type="button">Host Room</button>
            </div>
            <div class="lan-box">
              <b>Join or Watch</b>
              <input id="roomCodeInput" class="code-input" maxlength="4" autocomplete="off" spellcheck="false" placeholder="PALM" value="${escHtml(this.joinCodeDraft)}" aria-label="4-letter room code">
              <div class="join-actions">
                <button class="play alt" id="joinBtn" type="button">Join Game</button>
                <button class="play ghost" id="watchBtn" type="button">Watch</button>
              </div>
            </div>
          </div>
          <details class="adv-signal" style="margin-top:8px">
            <summary><span>Advanced: Signaling Server</span><span id="sigUrlPreview">${escHtml(this.net.signalUrl)}</span></summary>
            <div class="adv-signal-body">
              <input id="signalUrlInput" autocomplete="off" spellcheck="false" value="${escHtml(this.net.signalUrl)}" aria-label="Signaling server URL">
              <button class="lan-copy-btn" id="sigSaveBtn" type="button">Apply</button>
              <button class="lan-copy-btn" id="sigResetBtn" type="button">Default</button>
            </div>
          </details>
        `
            : `
          <div class="lan-grid">
            <div class="lan-box">
              <b>Host LAN</b>
              <span class="note">Requires <b>python3 lagoon-server.py</b> (port ${NET_PORT}) running locally.</span>
              <button class="play alt" id="hostLanBtn" type="button">Host LAN</button>
            </div>
            <div class="lan-box">
              <b>Join or Watch LAN</b>
              <input id="lanAddr" autocomplete="off" spellcheck="false" placeholder="192.168.1.23" value="${escHtml(joinVal)}" aria-label="Host LAN address">
              <div class="join-actions">
                <button class="play alt" id="joinLanBtn" type="button">Join Game</button>
                <button class="play ghost" id="watchLanBtn" type="button">Watch</button>
              </div>
            </div>
          </div>
        `
        }
      </div>

      <div id="lanRoomHero" hidden></div>
      <div id="lanSeatArea" class="seat-section" hidden></div>
      <div class="lan-status" id="lanStatus" aria-live="polite"></div>
      <div id="lanLobbyChat" hidden></div>
      <div class="row">
        <button class="play" id="lanStart" type="button" hidden>${ICO.play}<span>Start Match</span></button>
        <button class="play ghost" id="lanBack" type="button">${isConnected ? "Leave Room" : "Back to Hub"}</button>
      </div>
    `,
      { variant: "wide-card" }
    );

    const nameInput = $("lanName") as HTMLInputElement;
    nameInput.oninput = () => {
      this.net.myName = nameInput.value.slice(0, 14);
    };

    document.querySelectorAll<HTMLButtonElement>("[data-nettab]:not(:disabled)").forEach((b) => {
      b.onclick = () => {
        this.engine.sfx.ui();
        this.lobbyTab = b.dataset.nettab as NetMode;
        this.net.err = "";
        this.showLanLobby();
      };
    });

    document.querySelectorAll<HTMLButtonElement>("[data-ldisc]:not(:disabled)").forEach((b) => {
      b.onclick = () => {
        this.engine.sfx.ui();
        this.net.updateLobbyConfig({ discipline: b.dataset.ldisc as MatchDiscipline });
        this.showLanLobby();
      };
    });
    document.querySelectorAll<HTMLButtonElement>("[data-lfmt]:not(:disabled)").forEach((b) => {
      b.onclick = () => {
        this.engine.sfx.ui();
        this.net.updateLobbyConfig({ format: b.dataset.lfmt as MatchFormat });
        this.showLanLobby();
      };
    });
    document.querySelectorAll<HTMLButtonElement>("[data-lfill]:not(:disabled)").forEach((b) => {
      b.onclick = () => {
        this.engine.sfx.ui();
        this.net.updateLobbyConfig({ soloDoublesMode: b.dataset.lfill as "bot" | "dual" });
        this.showLanLobby();
      };
    });
    document.querySelectorAll<HTMLButtonElement>("[data-lven]:not(:disabled)").forEach((b) => {
      b.onclick = () => {
        this.engine.sfx.ui();
        this.net.updateLobbyConfig({ venue: b.dataset.lven as VenueId });
        this.showLanLobby();
      };
    });
    document.querySelectorAll<HTMLButtonElement>("[data-lsky]:not(:disabled)").forEach((b) => {
      b.onclick = () => {
        this.engine.sfx.ui();
        this.net.updateLobbyConfig({ sky: b.dataset.lsky as SkyId });
        this.showLanLobby();
      };
    });

    if (tab === "online") {
      const codeInput = document.getElementById("roomCodeInput") as HTMLInputElement | null;
      if (codeInput) {
        codeInput.oninput = () => {
          codeInput.value = normalizeRoomCode(codeInput.value);
          this.joinCodeDraft = codeInput.value;
        };
        codeInput.onkeydown = (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            this.net.joinOnline(codeInput.value, ($("lanName") as HTMLInputElement).value, false);
          }
        };
      }
      const hostBtn = document.getElementById("hostBtn");
      if (hostBtn) {
        hostBtn.onclick = () => {
          this.engine.sfx.ui();
          this.net.hostOnline(($("lanName") as HTMLInputElement).value);
        };
      }
      const joinBtn = document.getElementById("joinBtn");
      if (joinBtn) {
        joinBtn.onclick = () => {
          this.engine.sfx.ui();
          const code = (document.getElementById("roomCodeInput") as HTMLInputElement | null)?.value || "";
          this.net.joinOnline(code, ($("lanName") as HTMLInputElement).value, false);
        };
      }
      const watchBtn = document.getElementById("watchBtn");
      if (watchBtn) {
        watchBtn.onclick = () => {
          this.engine.sfx.ui();
          const code = (document.getElementById("roomCodeInput") as HTMLInputElement | null)?.value || "";
          this.net.joinOnline(code, ($("lanName") as HTMLInputElement).value, true);
        };
      }
      const sigSave = document.getElementById("sigSaveBtn");
      if (sigSave) {
        sigSave.onclick = () => {
          const inp = document.getElementById("signalUrlInput") as HTMLInputElement | null;
          if (!inp) return;
          this.net.setSignalUrl(inp.value);
          inp.value = this.net.signalUrl;
          const prev = document.getElementById("sigUrlPreview");
          if (prev) prev.textContent = this.net.signalUrl;
          this.engine.sfx.ui();
        };
      }
      const sigReset = document.getElementById("sigResetBtn");
      if (sigReset) {
        sigReset.onclick = () => {
          try { localStorage.removeItem("lagoon-signal-url"); } catch { /* ignore */ }
          this.net.signalUrl = resolveDefaultSignalUrl();
          const inp = document.getElementById("signalUrlInput") as HTMLInputElement | null;
          if (inp) inp.value = this.net.signalUrl;
          const prev = document.getElementById("sigUrlPreview");
          if (prev) prev.textContent = this.net.signalUrl;
          this.engine.sfx.ui();
        };
      }
    } else {
      const hostLan = document.getElementById("hostLanBtn");
      if (hostLan) {
        hostLan.onclick = () => {
          this.engine.sfx.ui();
          this.net.connectLan("host", "localhost", ($("lanName") as HTMLInputElement).value, false);
        };
      }
      const joinLan = document.getElementById("joinLanBtn");
      if (joinLan) {
        joinLan.onclick = () => {
          this.engine.sfx.ui();
          const addr = (document.getElementById("lanAddr") as HTMLInputElement | null)?.value || "";
          this.net.connectLan("guest", addr, ($("lanName") as HTMLInputElement).value, false);
        };
      }
      const watchLan = document.getElementById("watchLanBtn");
      if (watchLan) {
        watchLan.onclick = () => {
          this.engine.sfx.ui();
          const addr = (document.getElementById("lanAddr") as HTMLInputElement | null)?.value || "";
          this.net.connectLan("guest", addr, ($("lanName") as HTMLInputElement).value, true);
        };
      }
      const lanAddr = document.getElementById("lanAddr") as HTMLInputElement | null;
      if (lanAddr) {
        lanAddr.onkeydown = (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            this.net.connectLan("guest", lanAddr.value, ($("lanName") as HTMLInputElement).value, false);
          }
        };
      }
    }

    $("lanStart").onclick = () => this.net.startHostMatch();
    $("lanBack").onclick = () => {
      this.engine.sfx.ui();
      if (this.net.connected || this.net.transport) {
        this.net.close();
        this.showLanLobby();
      } else {
        this.showTitle();
      }
    };

    this.refreshLanLobby();
  }

  public refreshLanLobby(): void {
    const st = document.getElementById("lanStatus");
    if (!st) return;

    const lc = this.net.lobbyConfig;
    const isGuest = this.net.role === "guest";
    const isConnected = this.net.connected;
    const isOnline = this.net.mode === "online";

    // Sync Match Settings toggle states live (so guests see Host's live changes without losing chat focus!)
    const ctrlTag = document.getElementById("lanCtrlTag");
    if (ctrlTag) ctrlTag.textContent = isGuest ? "Controlled by Host" : "Host Controls";
    const fillRow = document.getElementById("lanSoloFillRow");
    if (fillRow) fillRow.hidden = lc.discipline !== "doubles";

    document.querySelectorAll<HTMLButtonElement>("[data-nettab]").forEach((b) => {
      b.disabled = isConnected || !!this.net.transport;
    });
    document.querySelectorAll<HTMLButtonElement>("[data-ldisc]").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.ldisc === lc.discipline));
      b.disabled = isGuest;
    });
    document.querySelectorAll<HTMLButtonElement>("[data-lfmt]").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.lfmt === lc.format));
      b.disabled = isGuest;
    });
    document.querySelectorAll<HTMLButtonElement>("[data-lfill]").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.lfill === lc.soloDoublesMode));
      b.disabled = isGuest;
    });
    document.querySelectorAll<HTMLButtonElement>("[data-lven]").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.lven === lc.venue));
      b.disabled = isGuest;
    });
    document.querySelectorAll<HTMLButtonElement>("[data-lsky]").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.lsky === lc.sky));
      b.disabled = isGuest;
    });

    const connectGrid = document.getElementById("lanConnectGrid");
    if (connectGrid) connectGrid.hidden = isConnected;

    const backBtn = document.getElementById("lanBack");
    if (backBtn) backBtn.textContent = isConnected || this.net.transport ? "Leave Room" : "Back to Hub";

    // Room Code / Invite Share Hero
    const hero = document.getElementById("lanRoomHero");
    if (hero) {
      if (isConnected && isOnline && this.net.roomCode) {
        const shareUrl = this.net.getInviteUrl();
        hero.hidden = false;
        hero.innerHTML = `
          <div class="room-code-hero">
            <div class="room-code-meta">
              <span class="room-code-lbl">Room Code · WebRTC P2P</span>
              <span class="room-code-badge">${escHtml(this.net.roomCode)}</span>
            </div>
            <div class="lan-share-row" style="margin-top:0">
              <code class="lan-url" id="lanShareUrl">${escHtml(shareUrl)}</code>
              <button class="lan-copy-btn" id="lanCopyBtn" type="button">Copy Invite Link</button>
              <button class="lan-copy-btn" id="codeCopyBtn" type="button">Copy Code</button>
            </div>
          </div>`;
        const copyLinkBtn = document.getElementById("lanCopyBtn") as HTMLButtonElement | null;
        if (copyLinkBtn) copyLinkBtn.onclick = () => void this.copyText(shareUrl, copyLinkBtn, "Copy Invite Link");
        const copyCodeBtn = document.getElementById("codeCopyBtn") as HTMLButtonElement | null;
        if (copyCodeBtn) copyCodeBtn.onclick = () => void this.copyText(this.net.roomCode, copyCodeBtn, "Copy Code");
      } else if (isConnected && !isOnline && this.net.role === "host") {
        const ips = this.net.ips.length
          ? this.net.ips.map((ip) => `<span class="ip">${escHtml(ip)}</span>`).join(" or ")
          : "<i>localhost</i>";
        const shareUrl = this.net.getInviteUrl();
        hero.hidden = false;
        hero.innerHTML = `
          <div class="room-code-hero">
            <div class="room-code-meta">
              <span class="room-code-lbl">Local LAN Host</span>
              <div>${ips}</div>
            </div>
            <div class="lan-share-row" style="margin-top:0">
              <code class="lan-url" id="lanShareUrl">${escHtml(shareUrl)}</code>
              <button class="lan-copy-btn" id="lanCopyBtn" type="button">Copy Link</button>
            </div>
          </div>`;
        const copyLinkBtn = document.getElementById("lanCopyBtn") as HTMLButtonElement | null;
        if (copyLinkBtn) copyLinkBtn.onclick = () => void this.copyText(shareUrl, copyLinkBtn, "Copy Link");
      } else {
        hero.hidden = true;
        hero.innerHTML = "";
      }
    }

    // Interactive 4-Seat & Spectator Roster Grid
    const seatArea = document.getElementById("lanSeatArea");
    if (seatArea) {
      if (isConnected) {
        const isDbl = lc.discipline === "doubles";
        const renderSeat = (slot: PlayerSlot, roleLbl: string) => {
          const seat = this.net.seats[slot];
          const peer = seat.peerId ? this.net.peers.get(seat.peerId) : null;
          const isMine = this.net.mySlot === slot;
          const isHostSeat = !!peer?.isHost;
          const isOccupied = seat.kind === "human" && !!peer;
          const canClick = !isOccupied && this.net.role === "guest";
          const av = this.net.getSlotAvatar(slot);
          const name = isOccupied
            ? peer.name
            : seat.kind === "dual"
            ? "Open · Dual-Control"
            : `Open · ${CAST[seat.botRivalId]?.name || "Bot"} (AI)`;
          const pillCls = isHostSeat ? "host" : isMine ? "you" : canClick ? "join" : "";
          const pillTxt = isHostSeat ? "Host" : isMine ? "You" : isOccupied ? `P${slot + 1}` : canClick ? "Sit Here" : seat.kind === "dual" ? "Dual" : "AI";
          const cardCls = isMine ? "mine" : isOccupied ? "occupied" : "open";
          return `
            <button type="button" class="seat-card ${cardCls}" data-seat="${slot}" ${canClick ? "" : "disabled"}>
              <span class="seat-card-left">
                <span class="seat-dot" style="background:${cssRgb(av.shirt)};border-color:${cssRgb(av.stripe)}"></span>
                <span class="seat-name">${escHtml(name)}</span>
              </span>
              <span class="seat-pill ${pillCls}">${roleLbl} · ${pillTxt}</span>
            </button>`;
        };

        const spectators = this.net.getSpectators();
        const specChips = spectators.length
          ? spectators
              .map((sp) => `<span class="spec-chip">${escHtml(sp.name)}${sp.id === this.net.myPeerId ? " (You)" : ""}</span>`)
              .join("")
          : `<span class="note">None yet — up to 6 spectators can watch live.</span>`;

        seatArea.hidden = false;
        seatArea.innerHTML = `
          <div class="seat-grid">
            <div class="seat-team team0">
              <div class="seat-team-hdr"><span>Team A · Near Court</span><span>${isDbl ? "2 Seats" : "1 Seat"}</span></div>
              ${renderSeat(0, "P1")}
              ${isDbl ? renderSeat(2, "P3") : ""}
            </div>
            <div class="seat-team team1">
              <div class="seat-team-hdr"><span>Team B · Far Court</span><span>${isDbl ? "2 Seats" : "1 Seat"}</span></div>
              ${renderSeat(1, "P2")}
              ${isDbl ? renderSeat(3, "P4") : ""}
            </div>
          </div>
          <div class="spec-strip">
            <div class="spec-strip-names">
              <b>Spectators (${spectators.length}/6):</b>
              ${specChips}
            </div>
            ${
              this.net.role === "guest"
                ? `<button type="button" class="spec-switch-btn" id="seatSpecBtn" aria-pressed="${this.net.isSpectator}">${this.net.isSpectator ? "Spectating ✓" : "Watch as Spectator"}</button>`
                : ""
            }
          </div>`;

        seatArea.querySelectorAll<HTMLButtonElement>("[data-seat]:not(:disabled)").forEach((b) => {
          b.onclick = () => {
            this.engine.sfx.ui();
            this.net.requestSeat(Number(b.dataset.seat) as PlayerSlot);
          };
        });
        const specBtn = document.getElementById("seatSpecBtn");
        if (specBtn) {
          specBtn.onclick = () => {
            this.engine.sfx.ui();
            this.net.requestSeat("spectate");
          };
        }
      } else {
        seatArea.hidden = true;
        seatArea.innerHTML = "";
      }
    }

    // Status message & Start button
    const pill = document.getElementById("lanPill");
    const startBtn = document.getElementById("lanStart") as HTMLButtonElement | null;
    const humans = this.net.getHumanPlayerCount();
    const specs = this.net.getSpectators().length;
    let html = "";
    let cls = "";

    if (this.net.transport && !isConnected) {
      html = `Connecting to <b>${escHtml(this.net.target)}</b>…`;
    } else if (isConnected && this.net.role === "host") {
      if (this.net.canStartMatch()) {
        html = `<b>${humans} player${humans > 1 ? "s" : ""}</b>${specs ? ` &amp; <b>${specs} spectator${specs > 1 ? "s" : ""}</b>` : ""} ready — press <b>Start Match</b>!`;
      } else {
        html = isOnline
          ? `Room <b>${escHtml(this.net.roomCode)}</b> is live! Share the code or invite link — waiting for at least 1 opponent to join.`
          : `LAN room is live! Waiting for a buddy to join on Wi-Fi.`;
      }
      cls = "ok";
    } else if (isConnected && this.net.role === "guest") {
      const roleDesc = this.net.isSpectator
        ? "Seated as <b>Spectator</b> (Umpire Chair POV)"
        : `Seated in <b>P${(this.net.mySlot ?? 0) + 1}</b>`;
      html = this.net.hasAnyPeer
        ? `Connected! ${roleDesc} · ${VENUES[lc.venue].name} (${lc.discipline}). Waiting for host to start…`
        : `Connected to server. Waiting for host…`;
      cls = "ok";
    } else {
      html =
        this.net.err ||
        (this.lobbyTab === "online"
          ? `Press <b>Host Room</b> for a 4-letter code, or enter a friend's code to play or spectate.`
          : `Local LAN uses <b>python3 lagoon-server.py</b> (port ${NET_PORT}) with zero internet required.`);
    }
    if (this.net.err && !isConnected) cls = "err";
    st.innerHTML = html;
    st.className = "lan-status " + cls;

    if (pill) {
      pill.textContent = isConnected
        ? this.net.hasAnyPeer
          ? `${humans}P${specs ? ` · ${specs}W` : ""}`
          : this.net.role === "host"
          ? isOnline
            ? `Code ${this.net.roomCode}`
            : "Hosting"
          : "Connected"
        : "Offline";
    }
    if (startBtn) {
      startBtn.hidden = !(this.net.role === "host" && isConnected);
      startBtn.disabled = !this.net.canStartMatch();
      startBtn.title = this.net.canStartMatch() ? "Start multiplayer match" : "Waiting for at least 2 seated players";
    }

    const chatSlot = document.getElementById("lanLobbyChat");
    if (chatSlot) {
      const showChat = isConnected && this.net.hasAnyPeer;
      chatSlot.hidden = !showChat;
      if (showChat) this.chat.mountEmbedded(chatSlot, "lobby");
      else this.chat.unmountEmbedded();
    }
  }

  public showNetMenu(): void {
    const modeLabel = this.net.mode === "online" ? `Room ${this.net.roomCode}` : "LAN Match";
    const summary = this.net.getRoomSummaryName();
    this.openCard(`
      <div class="eyebrow">${escHtml(modeLabel)} · Live</div>
      <h1>${this.net.isSpectator ? "Spectator Menu" : "Timeout?"}</h1>
      <p class="lede">${this.net.isSpectator ? "Switch cameras anytime with Tab or jump back to the live broadcast." : `The rally stays live for ${escHtml(summary)} while this menu is open.`}</p>
      <div class="row">
        <button class="play" id="resumeBtn" type="button">Back to Court</button>
        <button class="play ghost" id="leaveBtn" type="button">${this.net.isSpectator ? "Stop Watching" : "Leave Match"}</button>
      </div>
    `);
    $("resumeBtn").onclick = () => { this.engine.sfx.ui(); this.closeOverlay(); };
    $("leaveBtn").onclick = () => { this.engine.sfx.ui(); this.net.leave(); };
  }

  public showNetEnd(): void {
    const g = this.engine.game;
    const isHost = this.net.role === "host";
    const stats = isHost ? g.stats : this.net.peerStats;
    const [t0, t1] = this.net.getLocalTeamNames();
    const headline = this.net.isSpectator
      ? `${escHtml(g.winner === 0 ? t0 : t1)} Wins!`
      : g.winner === 0
      ? "You Win!"
      : `${escHtml(t1)} Wins`;
    const eyebrow = this.net.isSpectator
      ? `${this.net.mode === "online" ? `Room ${this.net.roomCode}` : "LAN Match"} · Final`
      : `${this.net.mode === "online" ? `Room ${this.net.roomCode}` : "LAN Match"} · ${g.winner === 0 ? "Pier Champion" : "Runner-up"}`;

    this.openCard(`
      <div class="top-meta">
        <div class="eyebrow">${escHtml(eyebrow)}</div>
      </div>
      <div class="final-row">
        <h1>${headline}</h1>
        <div class="final">${g.games[0]}–${g.games[1]}</div>
      </div>
      <div class="stats-grid">
        <div class="stat-box"><div class="sv">${stats.fastestServe || "—"}</div><div class="sl">Top MPH</div></div>
        <div class="stat-box"><div class="sv">${stats.aces}</div><div class="sl">Aces</div></div>
        <div class="stat-box"><div class="sv">${stats.winners}</div><div class="sl">Winners</div></div>
        <div class="stat-box"><div class="sv">${stats.longestRally}</div><div class="sl">Max Rally</div></div>
      </div>
      <p class="lede">${isHost ? "Ready for another? Start an instant rematch for the whole room." : `Waiting for host to start a rematch…`}</p>
      <div id="lanPostChat"></div>
      <div class="row">
        ${isHost ? `<button class="play" id="rematchBtn" type="button">Rematch</button>` : ""}
        <button class="play ghost" id="leaveBtn" type="button">Leave Room</button>
      </div>
    `);
    const postChatSlot = document.getElementById("lanPostChat");
    if (postChatSlot && this.net.connected && this.net.hasAnyPeer) {
      this.chat.mountEmbedded(postChatSlot, "post");
    }
    if (isHost) {
      $("rematchBtn").onclick = () => {
        if (this.net.canStartMatch()) this.net.startHostMatch();
        else this.showLanLobby();
      };
    }
    $("leaveBtn").onclick = () => { this.engine.sfx.ui(); this.net.leave(); };
  }
}
