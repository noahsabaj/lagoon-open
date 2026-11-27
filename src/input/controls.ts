import { clamp } from "../core/constants";
import type { SettingsState, ShotIntent } from "../core/types";

interface InputCallbacks {
  onSwing: (power: number, intent: ShotIntent) => void;
  onChargeUpdate: (active: boolean, power: number, intent: ShotIntent) => void;
  onArmLobToggle: () => void;
  onPauseToggle: () => void;
  onOverlayConfirm: () => void;
  onSkipReplay: () => boolean;
  onAudioUnlock: () => void;
  onWiiStatusChange: (connected: boolean, label: string, msg?: [string, string]) => void;
  onGamepadStatusChange: (connected: boolean, label: string) => void;
  isOverlayOpen: () => boolean;
  isServeReady: () => boolean;
  isChatOpen?: () => boolean;
  canChat?: () => boolean;
  onChatOpen?: () => void;
  onChatClose?: () => void;
  onQuickChat?: (slot: number) => void;
  isSpectator?: () => boolean;
  onSpectatorCycleCam?: () => void;
  getViewportSize: () => [number, number];
  getHandedness: () => "right" | "left";
}

// WebHID minimal typing for Chrome/Edge Wii Remote support
interface HIDInputReportEvent extends Event {
  device: HIDDevice;
  reportId: number;
  data: DataView;
}
interface HIDDevice extends EventTarget {
  vendorId: number;
  productId: number;
  opened: boolean;
  open(): Promise<void>;
  sendReport(reportId: number, data: BufferSource): Promise<void>;
}
interface NavigatorHID extends EventTarget {
  getDevices(): Promise<HIDDevice[]>;
  requestDevice(options: { filters: Array<{ vendorId: number; productId: number }> }): Promise<HIDDevice[]>;
}

const WII_IDS = [
  { vendorId: 0x057e, productId: 0x0306 },
  { vendorId: 0x057e, productId: 0x0330 },
];
const isWii = (d: HIDDevice) => WII_IDS.some((f) => f.vendorId === d.vendorId && f.productId === d.productId);

export class InputController {
  public keys = new Set<string>();
  public touchy = false;

  // Wii Remote state (also read by Settings calibration G-meter!)
  public wii = {
    dev: null as HIDDevice | null,
    armed: new Set<HIDDevice>(),
    lastErr: null as unknown,
    searchId: 0,
    g: { x: 0, y: 0, z: 1 },
    reports: 0,
    lastT: 0,
    state: "idle" as "idle" | "armed" | "cool",
    peak: 0,
    startT: 0,
    sumX: 0,
    sumY: 0,
    sumZ: 0,
    sumN: 0,
    aWas: false,
    pWas: false,
    bHeld: false,
    dpL: false,
    dpR: false,
    dpU: false,
    dpD: false,
    lastMag: 0,
    motionPlusActive: false,
    gyroRoll: 0,
  };

  // Gamepad state
  public gamepad = {
    connected: false,
    name: "",
    nx: 0,
    nz: 0,
    prevBtns: new Array<boolean>(16).fill(false),
    chargeStart: 0,
    chargeIntent: "drive" as ShotIntent,
  };

  // Pointer / Keyboard Charge tracking
  private samples: Array<{ x: number; y: number; t: number }> = [];
  private pointerDownT = 0;
  private pointerBtn = 0;
  private pointerStartY = 0;
  private pointerIntent: ShotIntent = "drive";
  private keyChargeStart = 0;
  private keyChargeIntent: ShotIntent = "drive";
  private lastSwingMs = -9000;

  constructor(
    private canvas: HTMLCanvasElement,
    private settings: SettingsState,
    private cb: InputCallbacks
  ) {
    this.bindPointer();
    this.bindKeyboard();
    this.bindHidEvents();
    window.addEventListener("gamepadconnected", (e) => {
      this.gamepad.connected = true;
      this.gamepad.name = e.gamepad.id.slice(0, 22);
      this.cb.onGamepadStatusChange(true, "Gamepad Ready");
    });
    window.addEventListener("gamepaddisconnected", () => {
      this.gamepad.connected = false;
      this.gamepad.name = "";
      this.cb.onGamepadStatusChange(false, "Gamepad");
    });
  }

  public isBackHeld(): boolean {
    return this.keys.has("KeyS") || this.keys.has("ArrowDown") || this.wii.dpD || this.gamepad.nz < -0.45;
  }

  public readNudge(): [number, number] {
    let nx = 0;
    let nz = 0;
    // Looking from -Z toward +Z: screen-left is +X, screen-right is -X
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft") || this.wii.dpL) nx += 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight") || this.wii.dpR) nx -= 1;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp") || this.wii.dpU) nz += 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown") || this.wii.dpD) nz -= 1;
    if (Math.abs(this.gamepad.nx) > 0.15) nx = clamp(nx + this.gamepad.nx, -1, 1);
    if (Math.abs(this.gamepad.nz) > 0.15) nz = clamp(nz + this.gamepad.nz, -1, 1);
    return [nx, nz];
  }

  public poll(nowMs: number): void {
    // Update live visual charge meter if mouse/keyboard/gamepad button is held
    let active = false;
    let held = 0;
    let intent: ShotIntent = "drive";

    if (this.pointerDownT > 0) {
      held = nowMs - this.pointerDownT;
      if (held > 110) {
        active = true;
        intent = this.pointerIntent;
      }
    } else if (this.keyChargeStart > 0) {
      held = nowMs - this.keyChargeStart;
      if (held > 110) {
        active = true;
        intent = this.keyChargeIntent;
      }
    } else if (this.gamepad.chargeStart > 0) {
      held = nowMs - this.gamepad.chargeStart;
      if (held > 110) {
        active = true;
        intent = this.gamepad.chargeIntent;
      }
    }

    if (active && !this.cb.isOverlayOpen()) {
      const pwr = clamp((held - 90) / 340, 0.25, 1.0);
      this.cb.onChargeUpdate(true, pwr, intent);
    } else {
      this.cb.onChargeUpdate(false, 0, "drive");
    }

    this.pollGamepad(nowMs);
  }

  private fireSwing(power: number, intent: ShotIntent): void {
    this.lastSwingMs = performance.now();
    this.cb.onChargeUpdate(false, 0, "drive");
    this.cb.onSwing(power, intent);
  }

  private bindPointer(): void {
    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    this.canvas.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") this.touchy = true;
      this.samples.length = 0;
      this.cb.onAudioUnlock();
      if (this.cb.isChatOpen?.()) {
        this.cb.onChatClose?.();
        return;
      }
      if (this.cb.onSkipReplay()) return;
      if (this.cb.isOverlayOpen() || this.cb.isSpectator?.()) return;

      if (e.pointerType === "mouse") {
        this.pointerDownT = performance.now();
        this.pointerBtn = e.button;
        this.pointerStartY = e.clientY;
        const back = this.isBackHeld();
        if (e.button === 1) this.pointerIntent = "lob";
        else if (e.button === 2 || e.shiftKey) this.pointerIntent = back ? "drop" : "slice";
        else if (e.altKey) this.pointerIntent = "lob";
        else this.pointerIntent = "drive";
      }
    });

    this.canvas.addEventListener("pointermove", (e) => {
      if (e.pointerType === "touch") this.touchy = true;
      if (this.cb.isOverlayOpen() || this.cb.isSpectator?.()) return;

      // For mouse: ONLY allow no-button hover-flick if the user opted in via Settings!
      // For touch: always track swipe gestures!
      const allowSwipe = e.pointerType === "touch" || this.settings.hoverFlick;
      if (!allowSwipe) return;

      const t = performance.now();
      this.samples.push({ x: e.clientX, y: e.clientY, t });
      while (this.samples.length && t - this.samples[0].t > 85) this.samples.shift();
      if (this.samples.length < 3) return;
      const a = this.samples[0];
      const b = this.samples[this.samples.length - 1];
      const dtm = b.t - a.t;
      if (dtm < 12) return;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      const [W, H] = this.cb.getViewportSize();
      const v = (d / dtm) / Math.min(W, H) * 1000;
      const thr = this.touchy ? 2.0 : 2.75;
      if (v > thr && t - this.lastSwingMs > 280) {
        const up = -dy / (d || 1);
        const intent: ShotIntent =
          up > 0.84 && v < thr + 1.6
            ? "lob"
            : up < -0.58 && v < thr + 1.2
            ? "drop"
            : up < -0.42
            ? "slice"
            : "drive";
        this.pointerDownT = 0;
        this.fireSwing(clamp((v - thr) / 4.8, 0.22, 1), intent);
        this.samples.length = 0;
      }
    });

    this.canvas.addEventListener("pointerup", (e) => {
      if (e.pointerType !== "mouse" || !this.pointerDownT) return;
      const held = performance.now() - this.pointerDownT;
      this.pointerDownT = 0;
      if (this.cb.isOverlayOpen() || this.cb.isSpectator?.()) return;
      const pwr = held < 130 ? 0.68 : clamp((held - 70) / 310, 0.50, 1.0);
      const dragUp = this.pointerStartY - e.clientY > 34;
      const dragDown = e.clientY - this.pointerStartY > 38;
      let intent = this.pointerIntent;
      if (this.pointerBtn === 0 && dragUp) intent = "lob";
      else if (this.pointerBtn === 2 && (dragDown || this.isBackHeld())) intent = "drop";
      this.fireSwing(pwr, intent);
    });
  }

  private bindKeyboard(): void {
    window.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA";
      if (typing) return;
      if (this.cb.isChatOpen?.()) {
        if (e.code === "Escape") {
          e.preventDefault();
          this.cb.onChatClose?.();
        }
        return;
      }

      if (!this.cb.isOverlayOpen() && this.cb.canChat?.()) {
        if (e.code === "KeyT" || e.code === "Enter") {
          e.preventDefault();
          this.keys.clear();
          this.keyChargeStart = 0;
          this.cb.onChargeUpdate(false, 0, "drive");
          this.cb.onChatOpen?.();
          return;
        }
        if (!e.repeat && (e.code === "Digit1" || e.code === "Digit2" || e.code === "Digit3" || e.code === "Digit4")) {
          e.preventDefault();
          this.cb.onAudioUnlock();
          this.cb.onQuickChat?.(Number(e.code.charAt(5)) - 1);
          return;
        }
      }

      this.keys.add(e.code);
      this.cb.onAudioUnlock();

      if (this.cb.onSkipReplay()) {
        e.preventDefault();
        return;
      }

      if (e.code === "Escape" || e.code === "KeyP") {
        e.preventDefault();
        this.cb.onPauseToggle();
        return;
      }
      if (e.code === "Tab" && !this.cb.isOverlayOpen() && this.cb.isSpectator?.()) {
        e.preventDefault();
        this.cb.onSpectatorCycleCam?.();
        return;
      }
      if (e.code === "Enter" && this.cb.isOverlayOpen()) {
        e.preventDefault();
        this.cb.onOverlayConfirm();
        return;
      }
      if (this.cb.isOverlayOpen() || e.repeat || this.cb.isSpectator?.()) return;

      if (e.code === "Space") {
        e.preventDefault();
        if (this.cb.isServeReady()) {
          this.fireSwing(0.75, "drive");
        } else {
          this.keyChargeStart = performance.now();
          this.keyChargeIntent = e.shiftKey ? "slice" : "drive";
        }
      } else if (e.code === "KeyX" || e.code === "ShiftLeft" || e.code === "ShiftRight") {
        e.preventDefault();
        this.fireSwing(0.74, this.isBackHeld() ? "drop" : "slice");
      } else if (e.code === "KeyC") {
        e.preventDefault();
        this.fireSwing(0.72, "lob");
      } else if (e.code === "KeyV") {
        e.preventDefault();
        this.fireSwing(0.55, "drop");
      }
    });

    window.addEventListener("keyup", (e) => {
      this.keys.delete(e.code);
      if (e.code === "Space" && this.keyChargeStart > 0) {
        const held = performance.now() - this.keyChargeStart;
        const intent = this.keyChargeIntent;
        this.keyChargeStart = 0;
        if (!this.cb.isOverlayOpen() && !this.cb.isChatOpen?.()) {
          const pwr = held < 120 ? 0.74 : clamp((held - 60) / 310, 0.56, 1.0);
          this.fireSwing(pwr, intent);
        }
      }
    });
  }

  private pollGamepad(nowMs: number): void {
    if (!navigator.getGamepads) return;
    const pads = navigator.getGamepads();
    let pad: Gamepad | null = null;
    for (const p of pads) {
      if (p && p.connected) {
        pad = p;
        break;
      }
    }
    if (!pad) {
      this.gamepad.nx = 0;
      this.gamepad.nz = 0;
      return;
    }
    if (!this.gamepad.connected) {
      this.gamepad.connected = true;
      this.gamepad.name = pad.id.slice(0, 22);
      this.cb.onGamepadStatusChange(true, "Gamepad Ready");
    }

    // Left stick + D-pad court shading & net-rush
    const ax = Math.abs(pad.axes[0] || 0) > 0.2 ? -(pad.axes[0] || 0) : 0; // screen-left = +X
    const az = Math.abs(pad.axes[1] || 0) > 0.2 ? -(pad.axes[1] || 0) : 0; // up = +Z
    const dpL = pad.buttons[14]?.pressed ? 1 : 0;
    const dpR = pad.buttons[15]?.pressed ? -1 : 0;
    const dpU = pad.buttons[12]?.pressed ? 1 : 0;
    const dpD = pad.buttons[13]?.pressed ? -1 : 0;
    this.gamepad.nx = clamp(ax + dpL + dpR, -1, 1);
    this.gamepad.nz = clamp(az + dpU + dpD, -1, 1);

    const pressed = (idx: number) => !!pad!.buttons[idx]?.pressed;
    const justDown = (idx: number) => pressed(idx) && !this.gamepad.prevBtns[idx];
    const justUp = (idx: number) => !pressed(idx) && this.gamepad.prevBtns[idx];

    if (justDown(0) || justDown(1) || justDown(2) || justDown(3) || justDown(9)) {
      this.cb.onAudioUnlock();
      if (this.cb.onSkipReplay()) {
        for (let i = 0; i < 16; i++) this.gamepad.prevBtns[i] = pressed(i);
        return;
      }
    }

    if (justDown(9)) {
      this.cb.onPauseToggle();
    } else if (this.cb.isOverlayOpen()) {
      if (justDown(0)) this.cb.onOverlayConfirm();
    } else {
      // A (btn 0) = tap/hold charge Drive (or immediate toss on serveReady)
      if (justDown(0)) {
        if (this.cb.isServeReady()) this.fireSwing(0.75, "drive");
        else {
          this.gamepad.chargeStart = nowMs;
          this.gamepad.chargeIntent = "drive";
        }
      }
      if (justUp(0) && this.gamepad.chargeStart > 0) {
        const held = nowMs - this.gamepad.chargeStart;
        this.gamepad.chargeStart = 0;
        const pwr = held < 120 ? 0.74 : clamp((held - 60) / 310, 0.56, 1.0);
        this.fireSwing(pwr, "drive");
      }
      // B (btn 1) = Slice (or Drop if pulling back)
      if (justDown(1)) this.fireSwing(0.74, this.isBackHeld() ? "drop" : "slice");
      // X (btn 2) = Drop Shot
      if (justDown(2)) this.fireSwing(0.56, "drop");
      // Y (btn 3) = Lob
      if (justDown(3)) this.fireSwing(0.72, "lob");
    }

    for (let i = 0; i < 16; i++) this.gamepad.prevBtns[i] = pressed(i);
  }

  public rumble(ms: number): void {
    // 1. Wii Remote rumble
    const d = this.wii.dev;
    if (d) {
      d.sendReport(0x11, new Uint8Array([0x11]))
        .then(() => setTimeout(() => d.sendReport(0x11, new Uint8Array([0x10])).catch(() => {}), ms))
        .catch(() => {});
    }
    // 2. Standard Gamepad dual-rumble haptic actuator
    if (navigator.getGamepads) {
      for (const p of navigator.getGamepads()) {
        const act = (p as unknown as { vibrationActuator?: { playEffect?: (t: string, o: Record<string, number>) => Promise<void> } })?.vibrationActuator;
        if (act && act.playEffect) {
          act.playEffect("dual-rumble", {
            startDelay: 0,
            duration: ms,
            weakMagnitude: clamp(ms / 130, 0.25, 0.9),
            strongMagnitude: clamp(ms / 150, 0.2, 0.85),
          }).catch(() => {});
          break;
        }
      }
    }
  }

  public rumblePattern(arr: number[]): void {
    let t = 0;
    arr.forEach((ms, i) => {
      if (i % 2 === 0) setTimeout(() => this.rumble(ms), t);
      t += ms;
    });
  }

  // ---------- WebHID Wii Remote + Optional MotionPlus Gyro ----------
  private setWiiReporting(d: HIDDevice): Promise<void> {
    // Report 0x35 = Core Buttons + Accel + 16-byte Extension (for MotionPlus); fallback 0x31 = Buttons + Accel
    const mode = this.settings.wiiMotionPlus && this.wii.motionPlusActive ? 0x35 : 0x31;
    return d.sendReport(0x12, new Uint8Array([0x04, mode]));
  }

  private async tryInitMotionPlus(d: HIDDevice): Promise<void> {
    if (!this.settings.wiiMotionPlus) return;
    try {
      // Standard Wii MotionPlus activation sequence (write 0x04 to 0xA600FE)
      const buf = new Uint8Array(21);
      buf[0] = 0x04; // register space
      buf[1] = 0xa6; buf[2] = 0x00; buf[3] = 0xfe; buf[4] = 0x01; buf[5] = 0x04;
      await d.sendReport(0x16, buf);
      this.wii.motionPlusActive = true;
    } catch {
      this.wii.motionPlusActive = false;
    }
  }

  private async armWii(d: HIDDevice): Promise<void> {
    try {
      if (!d.opened) await d.open();
    } catch (e) {
      this.wii.lastErr = e;
      return;
    }
    if (!this.wii.armed.has(d)) {
      d.addEventListener("inputreport", (ev) => this.onWiiReport(ev as HIDInputReportEvent));
      this.wii.armed.add(d);
    }
    try { await d.sendReport(0x15, new Uint8Array([0x00])); } catch (e) { this.wii.lastErr = e; }
    await this.tryInitMotionPlus(d);
    try { await this.setWiiReporting(d); } catch (e) { this.wii.lastErr = e; }
  }

  public async connectWii(interactive = true): Promise<void> {
    if (this.wii.dev) return;
    const navHid = (navigator as unknown as { hid?: NavigatorHID }).hid;
    if (!navHid) {
      if (interactive) this.cb.onWiiStatusChange(false, "Wii Remote", ["Wii Remote", "Needs Chrome or Edge on desktop"]);
      return;
    }
    let devs: HIDDevice[] = [];
    try {
      devs = (await navHid.getDevices()).filter(isWii);
      if (!devs.length && interactive) await navHid.requestDevice({ filters: WII_IDS });
      devs = (await navHid.getDevices()).filter(isWii);
    } catch (e) {
      this.cb.onWiiStatusChange(false, "Wii Remote", ["Device Picker", (e as Error).message || String(e)]);
      return;
    }
    if (!devs.length) return;
    this.cb.onWiiStatusChange(false, "Searching…");
    this.wii.lastErr = null;
    const id = ++this.wii.searchId;
    await Promise.all(devs.map((d) => this.armWii(d)));
    setTimeout(() => {
      if (this.wii.dev || id !== this.wii.searchId) return;
      this.cb.onWiiStatusChange(
        false,
        "Wii Remote",
        interactive
          ? ["No remote answered", this.wii.lastErr ? String((this.wii.lastErr as Error).message || this.wii.lastErr) : "Press a button on the synced remote & retry"]
          : undefined
      );
    }, 2000);
  }

  private adoptWii(d: HIDDevice): void {
    this.wii.dev = d;
    this.wii.reports = 0;
    this.wii.state = "idle";
    d.sendReport(0x11, new Uint8Array([0x10])).catch(() => {});
    const mpLabel = this.wii.motionPlusActive ? "Wii Motion+" : "Wii Ready";
    this.cb.onWiiStatusChange(true, mpLabel, ["Wii Remote Connected", "Swing like a real racket!"]);
    this.rumble(140);
  }

  private bindHidEvents(): void {
    const navHid = (navigator as unknown as { hid?: NavigatorHID }).hid;
    if (!navHid || !navHid.addEventListener) return;
    navHid.addEventListener("disconnect", (ev) => {
      const d = (ev as unknown as { device: HIDDevice }).device;
      this.wii.armed.delete(d);
      if (d === this.wii.dev) {
        this.wii.dev = null;
        this.wii.motionPlusActive = false;
        this.cb.onWiiStatusChange(false, "Wii Remote");
      }
    });
    navHid.addEventListener("connect", (ev) => {
      const d = (ev as unknown as { device: HIDDevice }).device;
      if (isWii(d) && !this.wii.dev) void this.armWii(d);
    });
  }

  private onWiiReport(e: HIDInputReportEvent): void {
    if (!this.wii.dev) this.adoptWii(e.device);
    if (e.device !== this.wii.dev) return;
    const dv = e.data;
    if (e.reportId === 0x20) {
      this.setWiiReporting(this.wii.dev).catch(() => {});
      return;
    }
    if (e.reportId !== 0x31 && e.reportId !== 0x30 && e.reportId !== 0x35) return;

    const b0 = dv.getUint8(0);
    const b1 = dv.getUint8(1);
    this.wii.dpL = !!(b0 & 0x01);
    this.wii.dpR = !!(b0 & 0x02);
    this.wii.dpD = !!(b0 & 0x04);
    this.wii.dpU = !!(b0 & 0x08);
    const a = !!(b1 & 0x08);
    const pauseBtn = !!(b1 & 0x80) || !!(b0 & 0x10);
    this.wii.bHeld = !!(b1 & 0x04);

    if (a && !this.wii.aWas) {
      this.cb.onAudioUnlock();
      if (this.cb.onSkipReplay()) {
        this.wii.aWas = a;
        return;
      }
      if (this.cb.isOverlayOpen()) this.cb.onOverlayConfirm();
      else if (this.cb.isServeReady()) this.fireSwing(0.75, "drive");
      else this.cb.onArmLobToggle();
    }
    if (pauseBtn && !this.wii.pWas) {
      this.cb.onPauseToggle();
    }
    this.wii.aWas = a;
    this.wii.pWas = pauseBtn;

    if ((e.reportId !== 0x31 && e.reportId !== 0x35) || dv.byteLength < 5) return;

    // Parse optional MotionPlus gyro roll velocity if present in report 0x35 extension bytes
    if (e.reportId === 0x35 && dv.byteLength >= 11 && (dv.getUint8(10) & 0x02) !== 0) {
      const rollRaw = dv.getUint8(6) | ((dv.getUint8(9) & 0xfc) << 6);
      this.wii.gyroRoll = (rollRaw - 8063) / 2000;
    }

    const now = performance.now();
    const dt = this.wii.lastT ? clamp((now - this.wii.lastT) / 1000, 0.002, 0.05) : 0.01;
    this.wii.lastT = now;
    this.wii.reports++;

    const rx = (dv.getUint8(2) - 0x80) / 25;
    const ry = (dv.getUint8(3) - 0x80) / 25;
    const rz = (dv.getUint8(4) - 0x80) / 25;
    const tau = this.wii.state === "armed" ? 2.0 : 0.18;
    const alpha = 1 - Math.exp(-dt / tau);
    this.wii.g.x += (rx - this.wii.g.x) * alpha;
    this.wii.g.y += (ry - this.wii.g.y) * alpha;
    this.wii.g.z += (rz - this.wii.g.z) * alpha;
    if (this.wii.reports < 15) return;

    const lx = rx - this.wii.g.x;
    const ly = ry - this.wii.g.y;
    const lz = rz - this.wii.g.z;
    const sens = clamp(this.settings.wiiSensitivity || 1.0, 0.5, 2.0);
    const mag = Math.hypot(lx, ly, lz) * sens;
    this.wii.lastMag = mag;

    if (this.wii.state === "cool") {
      if (mag < 1.0 && now - this.lastSwingMs > 300) this.wii.state = "idle";
      return;
    }
    if (this.wii.state === "idle" && mag > 1.70 && now - this.lastSwingMs > 300) {
      this.wii.state = "armed";
      this.wii.peak = mag;
      this.wii.startT = now;
      this.wii.sumX = lx;
      this.wii.sumY = ly;
      this.wii.sumZ = lz;
      this.wii.sumN = 1;
    } else if (this.wii.state === "armed") {
      if (mag > this.wii.peak) this.wii.peak = mag;
      if (mag >= this.wii.peak * 0.7) {
        this.wii.sumX += lx; this.wii.sumY += ly; this.wii.sumZ += lz; this.wii.sumN++;
      }
      if (now - this.wii.startT > 75) {
        if (this.wii.peak >= 1.85) {
          const gln = Math.hypot(this.wii.g.x, this.wii.g.y, this.wii.g.z) || 1;
          const up = (this.wii.sumX * this.wii.g.x + this.wii.sumY * this.wii.g.y + this.wii.sumZ * this.wii.g.z) / (this.wii.sumN * gln);
          const handSign = this.cb.getHandedness() === "left" ? -1 : 1;
          const gyroSlice = this.wii.motionPlusActive && this.wii.gyroRoll * handSign < -1.1;
          let intent: ShotIntent = "drive";
          if (this.wii.bHeld && (this.wii.dpD || this.wii.peak < 2.35)) intent = "drop";
          else if (this.wii.bHeld || up < -0.55 || gyroSlice) intent = "slice";
          this.fireSwing(clamp((this.wii.peak - 1.55) / 3.1, 0.18, 1), intent);
          this.wii.state = "cool";
        } else {
          this.wii.state = "idle";
        }
      }
    }
  }
}
