import { CAST, QUALITY_TIERS, VENUES } from "../core/constants";
import type { CareerState, GameState, PlayerSlot, SettingsState, ShotIntent, SpectatorCamMode, TrainingState } from "../core/types";
import { getSituationBadge, pointLabel } from "../game/rules";

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
export const escHtml = (s: string) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));

export class HudController {
  private msgTimer = 0;
  private fbTimer = 0;
  private speedTimer = 0;

  public setBootProgress(pct: number, label: string): void {
    const fill = $("bootFill");
    const status = $("bootStatus");
    if (fill) fill.style.width = `${Math.round(pct * 100)}%`;
    if (status) status.textContent = `Loading 3D asset: ${label}…`;
  }

  public hideBootLoader(): void {
    const el = $("bootLoader");
    if (el) el.hidden = true;
  }

  public showMsg(big: string, small: string, ms: number): void {
    $("msgBig").textContent = big;
    $("msgSmall").textContent = small || "";
    $("msg").classList.add("show");
    window.clearTimeout(this.msgTimer);
    this.msgTimer = window.setTimeout(() => $("msg").classList.remove("show"), ms);
  }

  public feedback(label: string, detail?: string, isCrit = false): void {
    const el = $("feedback");
    el.textContent = "";
    const b = document.createElement("b");
    b.textContent = label;
    el.append(b);
    if (detail) el.append(" · " + detail);
    el.classList.toggle("crit", !!isCrit);
    el.classList.add("show");
    window.clearTimeout(this.fbTimer);
    this.fbTimer = window.setTimeout(() => el.classList.remove("show"), 1450);
  }

  public updateTelemetry(game: GameState, mph?: number, isRocket?: boolean): void {
    const sp = $("speedPill");
    const rp = $("rallyPill");
    const lb = $("lobBadge");
    if (mph && mph > 20) {
      $("speedVal").textContent = String(Math.round(mph));
      sp.classList.toggle("rocket", !!isRocket);
      sp.classList.add("show");
      window.clearTimeout(this.speedTimer);
      this.speedTimer = window.setTimeout(() => sp.classList.remove("show"), 2600);
    }
    if (game.rally >= 3 && game.mode !== "training") {
      $("rallyVal").textContent = String(game.rally);
      rp.classList.add("show");
    } else {
      rp.classList.remove("show");
    }
    lb.classList.toggle("show", !!game.lobArmed);
  }

  public updatePing(ms: number | null): void {
    const el = $("pingPill");
    if (!el) return;
    if (ms == null) {
      el.hidden = true;
    } else {
      el.hidden = false;
      $("pingVal").textContent = String(ms);
    }
  }

  public updateChargeMeter(active: boolean, power: number, intent: ShotIntent): void {
    const el = $("chargeMeter");
    el.hidden = !active;
    if (!active) return;
    $("chargeFill").style.width = `${Math.round(power * 100)}%`;
    $("chargeLbl").textContent = intent === "slice" ? "SLICE" : intent === "drop" ? "DROP" : intent === "lob" ? "LOB" : "POWER";
  }

  public updateServeMeter(visible: boolean, pct: number): void {
    const el = $("serveMeter");
    el.hidden = !visible;
    if (visible) $("servePin").style.bottom = `${pct}%`;
  }

  public updateReplayBanner(visible: boolean, label = "INSTANT REPLAY"): void {
    const el = $("replayBanner");
    el.hidden = !visible;
    if (visible) $("replayLabel").textContent = label;
  }

  public updateHawkEyeBanner(visible: boolean, isIn = true, distCm = 0, lineLabel = "Line"): void {
    const el = $("hawkeyeBanner");
    el.hidden = !visible;
    if (!visible) return;
    const v = $("hawkeyeVerdict");
    v.textContent = isIn ? "IN" : "OUT";
    v.className = "he-verdict " + (isIn ? "in" : "out");
    $("hawkeyeDist").textContent = `${distCm.toFixed(1)} cm · ${lineLabel}`;
  }

  public updateScoreHud(game: GameState, oppName: string, team0Name?: string, netBadge = "ONLINE"): void {
    const inMenu = game.phase === "title" || game.phase === "customizer";
    const scoreEl = $("score");
    scoreEl.hidden = game.mode === "training" || inMenu;

    const menuBtn = document.getElementById("menuBtn");
    if (menuBtn) menuBtn.hidden = inMenu;

    const accent = document.getElementById("bsAccent");
    if (accent) accent.className = `bs-accent ${game.config.venue}`;
    const vLbl = document.getElementById("bsVenueLbl");
    if (vLbl) vLbl.textContent = VENUES[game.config.venue].name.toUpperCase();

    const o = CAST[game.config.oppId] || CAST.reef;
    $("youNameHud").textContent =
      team0Name || (game.config.discipline === "doubles" ? "You + Partner" : "You");
    $("modeTagHud").hidden = game.config.discipline !== "doubles";
    $("oppNameHud").textContent = oppName;
    $("oppTierHud").textContent =
      game.mode === "net"
        ? netBadge
        : game.mode === "endless"
        ? "ENDLESS"
        : game.mode === "tournament"
        ? "CUP"
        : o.tierLabel;

    for (const i of [0, 1] as const) {
      $("g" + i).textContent = String(game.games[i]);
      $("p" + i).textContent = pointLabel(game.pts, i, game.tiebreak, game.tbPts);
      $("srv" + i).classList.toggle("on", game.server === i);
    }

    const badge = $("scoreBadge");
    const txt = getSituationBadge(game);
    badge.textContent = txt;
    badge.hidden = !txt;
  }

  public updateSpectatorBar(
    visible: boolean,
    camMode: SpectatorCamMode,
    followSlot: PlayerSlot,
    watcherCount: number,
    followLabel?: string
  ): void {
    const bar = document.getElementById("specBar");
    if (!bar) return;
    bar.hidden = !visible;
    document.body.classList.toggle("is-spectating", visible);
    if (!visible) return;
    const countEl = document.getElementById("specCount");
    if (countEl) {
      const n = Math.max(1, watcherCount);
      countEl.textContent = `LIVE · ${n} watching`;
    }
    const followBtn = document.getElementById("specFollowBtn");
    if (followBtn) {
      followBtn.textContent = followLabel ? `Follow: ${followLabel}` : `Follow P${followSlot + 1}`;
    }
    bar.querySelectorAll<HTMLButtonElement>("[data-scam]").forEach((btn) => {
      btn.setAttribute("aria-pressed", String(btn.dataset.scam === camMode));
    });
  }

  public updateTrainHud(training: TrainingState, career: CareerState, visible: boolean): void {
    const el = $("trainHud");
    el.hidden = !visible;
    const menuBtn = document.getElementById("menuBtn");
    if (menuBtn && visible) menuBtn.hidden = false;
    if (!visible) return;
    if (training.drill === "rally") {
      $("trScoreLbl").textContent = "Streak";
      $("trComboLbl").textContent = "Lives";
      $("trTimeLbl").textContent = "Elapsed";
      $("trScore").textContent = String(training.rallyStreak);
      $("trCombo").textContent = "♥".repeat(Math.max(0, training.lives));
      $("trTime").textContent = `${training.time.toFixed(0)}s`;
      $("trTime").classList.remove("low");
    } else {
      const mul = Math.min(5, 1 + 0.25 * Math.max(0, training.combo - 1));
      $("trScoreLbl").textContent = "Score";
      $("trComboLbl").textContent = "Combo";
      $("trTimeLbl").textContent = "Time";
      $("trScore").textContent = String(training.score);
      $("trCombo").textContent = "×" + mul.toFixed(2);
      const te = $("trTime");
      te.textContent = training.time.toFixed(1);
      te.classList.toggle("low", training.time < 10);
    }
    $("trBest").textContent = String(Math.max(career.trainingBest[training.drill], training.score));
  }

  public setHint(
    game: GameState,
    oppName: string,
    wiiConnected: boolean,
    gpConnected: boolean,
    touchy: boolean,
    training: TrainingState,
    opts?: { isSpectator?: boolean; myFocusSlot?: PlayerSlot; serverName?: string }
  ): void {
    const h = $("hint");
    const ph = game.phase;
    if (opts?.isSpectator && game.mode === "net" && ph !== "title" && ph !== "matchOver") {
      h.innerHTML = `<strong>Spectating Live.</strong> Press <strong>Tab</strong> to switch camera · <strong>T</strong> chat · <strong>1–4</strong> quick-chat`;
      h.hidden = false;
      return;
    }

    const how = wiiConnected
      ? "swing Wii Remote"
      : gpConnected
      ? "press A (hold to charge)"
      : touchy
      ? "swipe"
      : "click LMB (hold to charge) or press Space";
    let txt = "";
    const isDbl = game.config.discipline === "doubles";
    const myFocus = opts?.myFocusSlot ?? 0;
    const isMyServe =
      game.server === 0 &&
      (!isDbl || game.mode !== "net" || game.serverSlot === myFocus);

    if ((ph === "serveReady" || ph === "toss") && game.mode === "net" && !isMyServe) {
      const who = opts?.serverName || oppName;
      txt = `<strong>${escHtml(who)} is serving.</strong> Get ready! · <strong>T</strong> chat · <strong>1–4</strong> quick-chat`;
    } else if (ph === "serveReady") {
      txt = `<strong>Your serve.</strong> ${cap(how)} to toss, then strike at the golden apex for a <strong>Rocket Serve</strong>!${game.mode === "net" ? " · <strong>T</strong> chat · <strong>1–4</strong> quick" : ""}`;
    } else if (ph === "toss") {
      txt = `<strong>Strike at the golden peak!</strong> Hit the top zone for 130+ MPH.`;
    } else if (ph === "cpuServe" || ph === "rally") {
      txt = `${cap(how)} · <strong>RMB / X</strong> slice · <strong>V / S+RMB</strong> drop shot · <strong>C</strong> lob · <strong>WASD</strong> shade/rush net${game.mode === "net" ? " · <strong>T</strong> chat · <strong>1–4</strong> quick" : ""}.`;
    } else if (ph === "training") {
      if (training.drill === "rings") {
        txt = `Hit glowing rings for ×5.0 combos! <strong>Early</strong> = cross-court · <strong>Late</strong> = down the line · <strong>V</strong> = drop shot.`;
      } else if (training.drill === "rally") {
        txt = `Keep the accelerating rally alive! Don't miss 3 times — extreme reaches trigger an auto-<strong>Dive Save</strong>.`;
      } else {
        txt = `Land serves & blistering returns inside the glowing target zones!`;
      }
    }
    h.innerHTML = txt;
    h.hidden = !txt;
  }

  public updateToolbar(settings: SettingsState, skyLabel: string): void {
    $("skyLbl").textContent = settings.skyOverride === "auto" ? "Sky: Auto" : skyLabel.split(" ")[0];
    $("qualLbl").textContent = QUALITY_TIERS[settings.qualityIdx]?.name || "Ultra";
    $("sndLbl").textContent = settings.muted ? "Muted" : "Sound";
    $("sndBtn").setAttribute("aria-pressed", String(!settings.muted));
  }

  public updateWiiToolbar(connected: boolean, label: string): void {
    $("wiiLed").classList.toggle("on", connected);
    $("wiiLbl").textContent = label;
  }

  public updateGamepadToolbar(connected: boolean, label: string): void {
    const btn = $("gpBtn");
    btn.hidden = !connected;
    $("gpLbl").textContent = label;
  }
}
