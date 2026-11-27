import { clamp, rand } from "../core/constants";
import type { SettingsState, ShotTag, SurfacePhysics } from "../core/types";

export class SoundEngine {
  public ac: AudioContext | null = null;
  public master: GainNode | null = null;
  public sfxBus: GainNode | null = null;
  public musicBus: GainNode | null = null;
  public ambGain: GainNode | null = null;

  private noiseW: AudioBuffer | null = null;
  private noiseP: AudioBuffer | null = null;
  private noiseB: AudioBuffer | null = null;
  private surfStarted = false;
  public gullTimer = 9;
  private settings: SettingsState;

  public onBroadcastSfx: ((name: string, args: unknown[]) => void) | null = null;
  public panFlip = 1;

  constructor(settings: SettingsState) {
    this.settings = settings;
  }

  public init(): void {
    try {
      if (!this.ac) {
        this.ac = new AudioContext();
        const comp = this.ac.createDynamicsCompressor();
        comp.threshold.value = -13;
        comp.knee.value = 10;
        comp.ratio.value = 3.5;
        comp.attack.value = 0.003;
        comp.release.value = 0.18;

        this.master = this.ac.createGain();
        this.sfxBus = this.ac.createGain();
        this.musicBus = this.ac.createGain();
        this.ambGain = this.ac.createGain();
        this.ambGain.gain.value = 0.0001;

        this.sfxBus.connect(comp).connect(this.master).connect(this.ac.destination);
        this.musicBus.connect(this.master);
        this.ambGain.connect(this.master);

        // Prebuild 2s white, pink, brown noise buffers
        const sr = this.ac.sampleRate;
        const len = sr * 2;
        const bw = this.ac.createBuffer(1, len, sr);
        const bp = this.ac.createBuffer(1, len, sr);
        const bb = this.ac.createBuffer(1, len, sr);
        const dw = bw.getChannelData(0);
        const dp = bp.getChannelData(0);
        const db = bb.getChannelData(0);
        let b0 = 0, b1 = 0, b2 = 0, br = 0, mp = 0.01, mb = 0.01;
        for (let i = 0; i < len; i++) {
          const w = Math.random() * 2 - 1;
          dw[i] = w;
          b0 = 0.99765 * b0 + w * 0.099046;
          b1 = 0.963 * b1 + w * 0.296516;
          b2 = 0.57 * b2 + w * 1.05269;
          dp[i] = b0 + b1 + b2 + w * 0.1848;
          mp = Math.max(mp, Math.abs(dp[i]));
          br = (br + 0.02 * w) * 0.996;
          db[i] = br;
          mb = Math.max(mb, Math.abs(br));
        }
        for (let i = 0; i < len; i++) {
          dp[i] = (dp[i] / mp) * 0.9;
          db[i] = (db[i] / mb) * 0.9;
        }
        this.noiseW = bw;
        this.noiseP = bp;
        this.noiseB = bb;
        this.applyVolumes();
      }
      if (this.ac.state === "suspended") void this.ac.resume();
      if (!this.surfStarted && !this.settings.muted) this.startSurf();
    } catch {
      this.ac = null;
    }
  }

  public applyVolumes(): void {
    if (!this.ac || !this.master || !this.sfxBus || !this.musicBus || !this.ambGain) return;
    const now = this.ac.currentTime;
    const m = this.settings.muted ? 0 : this.settings.masterVol;
    this.master.gain.setTargetAtTime(m, now, 0.04);
    this.sfxBus.gain.setTargetAtTime(this.settings.sfxVol, now, 0.04);
    this.musicBus.gain.setTargetAtTime(this.settings.musicVol * 0.45, now, 0.06);
    this.ambGain.gain.setTargetAtTime(
      this.settings.muted ? 0.0001 : 0.72 * this.settings.sfxVol,
      now,
      0.15
    );
  }

  private startSurf(): void {
    if (!this.ac || !this.noiseB || !this.ambGain || this.surfStarted) return;
    this.surfStarted = true;
    const src = this.ac.createBufferSource();
    src.buffer = this.noiseB;
    src.loop = true;
    const lp = this.ac.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 500;
    const lfo = this.ac.createOscillator();
    const lfoG = this.ac.createGain();
    lfo.frequency.value = 0.085;
    lfoG.gain.value = 210;
    lfo.connect(lfoG).connect(lp.frequency);
    const g = this.ac.createGain();
    g.gain.value = 0.085;
    src.connect(lp).connect(g).connect(this.ambGain);
    src.start();
    lfo.start();
    this.applyVolumes();
  }

  private panNode(x = 0): AudioNode {
    if (!this.ac || !this.sfxBus) throw new Error("Audio not ready");
    if (this.ac.createStereoPanner) {
      const p = this.ac.createStereoPanner();
      p.pan.value = clamp(((x || 0) * this.panFlip) / 7.5, -1, 1);
      p.connect(this.sfxBus);
      return p;
    }
    return this.sfxBus;
  }

  public playTone(
    f0: number,
    f1: number,
    dur: number,
    type: OscillatorType,
    vol: number,
    delay = 0,
    x = 0
  ): void {
    if (!this.ac || this.settings.muted) return;
    const t = this.ac.currentTime + delay;
    const o = this.ac.createOscillator();
    const g = this.ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(20, f0), t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.panNode(x));
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  public playNoise(
    buf: AudioBuffer | null,
    dur: number,
    vol: number,
    fc: number,
    q: number,
    atk = 0.003,
    delay = 0,
    x = 0,
    ftype: BiquadFilterType = "bandpass"
  ): void {
    if (!this.ac || this.settings.muted || !buf) return;
    const t = this.ac.currentTime + delay;
    const s = this.ac.createBufferSource();
    const f = this.ac.createBiquadFilter();
    const g = this.ac.createGain();
    s.buffer = buf;
    s.loop = true;
    f.type = ftype;
    f.frequency.value = fc;
    f.Q.value = q;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + Math.max(0.002, atk));
    g.gain.exponentialRampToValueAtTime(0.0001, t + atk + dur);
    s.connect(f).connect(g).connect(this.panNode(x));
    s.start(t, Math.random() * 1.5);
    s.stop(t + atk + dur + 0.03);
  }

  private emit(name: string, args: unknown[]): void {
    if (this.onBroadcastSfx) this.onBroadcastSfx(name, args);
  }

  public hit(power: number, type: ShotTag | "rocket", x = 0): void {
    this.emit("hit", [power, type, x * this.panFlip]);
    const sc = 0.40 + power * 0.60;
    const fsc = 0.78 + power * 0.48;
    if (type === "rocket") {
      this.playNoise(this.noiseW, 0.045, 0.78 * sc, 5600, 0.55, 0.001, 0, x);
      this.playNoise(this.noiseW, 0.08, 0.40 * sc, 1900, 0.7, 0.002, 0.01, x);
      this.playTone(68, 36, 0.22, "sine", 0.72 * sc, 0, x);
      this.playTone(2200, 190, 0.06, "sawtooth", 0.24 * sc, 0, x);
    } else if (type === "smash") {
      this.playNoise(this.noiseW, 0.065, 0.74 * sc, 480 * fsc, 0.65, 0.001, 0, x);
      this.playTone(108, 48, 0.16, "sine", 0.60 * sc, 0, x);
      this.playTone(230, 110, 0.05, "triangle", 0.30 * sc, 0, x);
    } else if (type === "drop") {
      this.playNoise(this.noiseP, 0.06, 0.26 * sc, 2900, 1.3, 0.005, 0, x);
      this.playTone(460, 290, 0.065, "sine", 0.14 * sc, 0, x);
    } else if (type === "slice") {
      this.playNoise(this.noiseW, 0.09, 0.42 * sc, 4100 * fsc, 0.9, 0.004, 0, x);
      this.playTone(620, 400, 0.075, "sine", 0.10 * sc, 0, x);
    } else if (type === "lob") {
      this.playNoise(this.noiseW, 0.08, 0.24 * sc, 760 * fsc, 1.5, 0.004, 0, x);
      this.playTone(250, 135, 0.11, "sine", 0.30 * sc, 0, x);
    } else {
      this.playNoise(this.noiseW, 0.048, 0.54 * sc, 2250 * fsc, 0.75, 0.002, 0, x);
      this.playTone(230 * fsc, 98, 0.085, "triangle", 0.36 * sc, 0, x);
      this.playTone(960, 620, 0.025, "sine", 0.12 * sc, 0, x);
    }
  }

  public bounce(sp: number, x = 0, surface?: SurfacePhysics): void {
    const pitch = surface?.bouncePitch ?? 1.0;
    this.emit("bounce", [sp, x * this.panFlip, pitch]);
    const s = clamp(sp, 0.8, 18);
    const f = (122 + s * 5.5) * pitch;
    this.playTone(f, f * 0.64, 0.05, "sine", 0.09 + s * 0.011, 0, x);
    this.playNoise(this.noiseP, 0.045, 0.10 + s * 0.009, (340 + s * 18) * pitch, 0.8, 0.002, 0, x);
  }

  public splash(x = 0): void {
    this.emit("splash", [x * this.panFlip]);
    this.playNoise(this.noiseW, 0.26, 0.34, 1450, 0.75, 0.004, 0, x);
    this.playNoise(this.noiseP, 0.42, 0.28, 420, 0.9, 0.015, 0.03, x, "lowpass");
    this.playTone(320, 110, 0.14, "sine", 0.18, 0, x);
    this.playTone(540, 820, 0.09, "sine", 0.08, 0.06, x);
  }

  public dive(x = 0): void {
    this.emit("dive", [x * this.panFlip]);
    this.playNoise(this.noiseP, 0.18, 0.24, 920, 0.8, 0.01, 0, x);
    this.playTone(170, 75, 0.14, "triangle", 0.18, 0.02, x);
  }

  public slide(x = 0): void {
    this.emit("slide", [x * this.panFlip]);
    this.playNoise(this.noiseP, 0.22, 0.16, 1280, 0.7, 0.012, 0, x);
  }

  public net(x = 0): void {
    this.emit("net", [x * this.panFlip]);
    [900, 700, 540, 420].forEach((fc, i) =>
      this.playNoise(this.noiseP, 0.05, 0.22 * Math.pow(0.58, i), fc, 3.2, 0.002, i * 0.026, x)
    );
  }

  public squeak(x = 0): void {
    this.emit("squeak", [x * this.panFlip]);
    const f = 1650 + (Math.abs(x * 137) % 620);
    this.playTone(f, f * 1.32, 0.038, "sine", 0.045, 0, x);
  }

  public ring(combo: number, gold: boolean): void {
    const sc = [523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.66, 1318.51];
    const f = sc[combo % 8] * (combo >= 8 ? 1.5 : 1) * (gold ? 1.25 : 1);
    this.playTone(f * 1.008, f, 0.28, "sine", 0.18);
    this.playTone(f * 2, f * 2, 0.12, "triangle", 0.07);
    if (gold) this.playTone(f * 1.5, f * 1.5, 0.32, "sine", 0.14, 0.06);
  }

  public crowdCheer(big: boolean): void {
    this.emit("crowdCheer", [big]);
    const d = big ? 1.65 : 0.78;
    const v = big ? 0.26 : 0.14;
    this.playNoise(this.noiseP, d, v, 1350, 0.55, 0.08, 0, -0.55);
    this.playNoise(this.noiseP, d, v, 1520, 0.55, 0.10, 0.04, 0.55);
    // Layered applause claps
    const claps = big ? 12 : 6;
    for (let i = 0; i < claps; i++) {
      this.playNoise(this.noiseW, 0.035, 0.055, 2200 + (i % 4) * 380, 1.4, 0.002, 0.06 + i * (big ? 0.11 : 0.095), rand(-4, 4));
    }
    if (big) this.playNoise(this.noiseB, 1.35, 0.18, 520, 0.6, 0.12, 0, 0, "lowpass");
  }

  public crowdGasp(): void {
    this.emit("crowdGasp", []);
    this.playNoise(this.noiseP, 0.36, 0.15, 580, 2.0, 0.07, 0, 0);
  }

  public hawkeye(isIn: boolean): void {
    this.playTone(440, 880, 0.25, "sine", 0.12, 0);
    if (isIn) {
      this.playTone(659.25, 659.25, 0.18, "triangle", 0.16, 0.32);
      this.playTone(987.77, 987.77, 0.28, "triangle", 0.18, 0.44);
    } else {
      this.playTone(392, 311.13, 0.26, "sawtooth", 0.10, 0.32);
    }
  }

  public gull(): void {
    if (!this.ac || this.settings.muted) return;
    const x = rand(-6, 6);
    this.playTone(920, 1480, 0.11, "sine", 0.024, 0, x);
    this.playTone(1460, 680, 0.24, "sine", 0.020, 0.11, x);
  }

  public ui(): void {
    this.playTone(1380, 980, 0.03, "sine", 0.055);
  }

  public point(won: boolean, isGame: boolean, isMatch: boolean): void {
    this.emit("point", [won, isGame, isMatch]);
    const notes = isMatch
      ? won
        ? [523.25, 659.25, 783.99, 1046.5, 1318.5]
        : [392, 349.23, 293.66, 261.63]
      : isGame
      ? won
        ? [523.25, 659.25, 783.99, 1046.5]
        : [349.23, 311.13, 261.63]
      : won
      ? [659.25, 880]
      : [349.23, 293.66];
    notes.forEach((f, i) => this.playTone(f, f, 0.22, "triangle", 0.14, i * 0.105));
    if (won) this.crowdCheer(isGame || isMatch);
  }

  public chat(isRemote: boolean): void {
    if (!this.ac || !this.sfxBus) return;
    if (isRemote) {
      // Gentle two-note tropical marimba chime for incoming LAN message
      this.playTone(784, 784, 0.09, "triangle", 0.09, 0);
      this.playTone(1046.5, 1046.5, 0.13, "sine", 0.085, 0.065);
    } else {
      // Crisp soft pop for outgoing message
      this.playTone(620, 740, 0.06, "sine", 0.055, 0);
    }
  }

  public tickAmbiance(dt: number): void {
    this.gullTimer -= dt;
    if (this.gullTimer <= 0) {
      this.gull();
      this.gullTimer = rand(9, 17);
    }
  }
}
