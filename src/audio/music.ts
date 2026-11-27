import type { SettingsState } from "../core/types";
import type { SoundEngine } from "./soundEngine";

type MusicMood = "silent" | "menu" | "rally" | "transition" | "replay" | "victory";

const MIDI = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

// Breezy Wii Resort tropical jazz-pop chord progression (Fmaj7 -> Em7 -> Dm7 -> Cmaj7 -> Bbmaj7 -> Am7 -> Gm7 -> C9)
const MENU_CHORDS: number[][] = [
  [53, 57, 60, 64, 67], // Fmaj9
  [52, 55, 59, 62, 67], // Em7
  [50, 53, 57, 60, 64], // Dm9
  [48, 52, 55, 59, 62], // Cmaj9
  [46, 50, 53, 57, 60], // Bbmaj9
  [45, 48, 52, 55, 59], // Am9
  [43, 46, 50, 53, 57], // Gm9
  [48, 52, 55, 58, 62], // C9
];

const MENU_MELODY: Array<number | null> = [
  76, null, 79, 81, null, 79, 76, null,
  74, null, 76, 79, null, 76, 74, null,
  72, null, 74, 76, 79, null, 76, 74,
  72, null, null, 69, 72, 74, 76, null,
];

const VICTORY_MELODY: Array<number | null> = [
  72, 76, 79, 84, null, 81, 84, null,
  79, 81, 84, 88, null, 86, 84, null,
];

export class TropicalMusicEngine {
  private sfx: SoundEngine;
  private settings: SettingsState;
  private mood: MusicMood = "silent";
  private timer: number | null = null;
  private step = 0;
  private nextTime = 0;
  private tension = 0;

  constructor(sfx: SoundEngine, settings: SettingsState) {
    this.sfx = sfx;
    this.settings = settings;
  }

  public setMood(nextMood: MusicMood, tension = 0): void {
    this.tension = tension;
    const effective: MusicMood =
      nextMood === "rally" && !this.settings.rallyMusic ? "silent" : nextMood;

    if (effective === this.mood) return;
    this.mood = effective;
    if (this.mood === "silent") {
      this.stopScheduler();
      return;
    }
    this.startScheduler();
  }

  public refreshSettings(): void {
    if (this.mood === "rally" && !this.settings.rallyMusic) {
      this.mood = "silent";
      this.stopScheduler();
    }
  }

  private startScheduler(): void {
    if (!this.sfx.ac || !this.sfx.musicBus) return;
    if (this.timer !== null) return;
    this.nextTime = this.sfx.ac.currentTime + 0.06;
    this.step = 0;
    this.timer = window.setInterval(() => this.schedule(), 70);
  }

  private stopScheduler(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    const ac = this.sfx.ac;
    const bus = this.sfx.musicBus;
    if (!ac || !bus || this.settings.muted || this.settings.musicVol <= 0.01) return;
    if (ac.state !== "running") return;

    const bpm =
      this.mood === "victory" ? 124 :
      this.mood === "rally" ? 118 + this.tension * 10 :
      this.mood === "replay" ? 104 :
      110;
    const stepDur = 60 / bpm / 2; // eighth notes

    while (this.nextTime < ac.currentTime + 0.22) {
      this.triggerStep(ac, bus, this.step, this.nextTime, stepDur);
      this.nextTime += stepDur;
      this.step = (this.step + 1) % 64;
    }
  }

  private triggerStep(ac: AudioContext, bus: GainNode, step: number, t: number, dur: number): void {
    const bar = Math.floor(step / 8) % MENU_CHORDS.length;
    const beatInBar = step % 8;
    const chord = MENU_CHORDS[bar];

    // Electric piano warm chord pad on downbeat & syncopated "and of 2"
    if (beatInBar === 0 || (beatInBar === 3 && this.mood !== "replay")) {
      const vol = this.mood === "transition" ? 0.042 : this.mood === "rally" ? 0.036 : 0.052;
      const len = beatInBar === 0 ? dur * 2.8 : dur * 3.8;
      for (const note of chord.slice(1)) {
        this.playRhodes(ac, bus, MIDI(note), t, len, vol);
      }
    }

    // Warm resort bass groove (bossa-inspired 1, 3.5, 4)
    if (beatInBar === 0 || beatInBar === 5 || (beatInBar === 7 && this.mood !== "transition")) {
      const root = chord[0] - 12;
      const bassNote = beatInBar === 5 ? root + 7 : root;
      this.playBass(ac, bus, MIDI(bassNote), t, dur * 1.6, this.mood === "rally" ? 0.14 : 0.11);
    }

    // Marimba / Steel-drum melody
    if (this.mood === "menu" || this.mood === "victory" || this.mood === "replay") {
      const seq = this.mood === "victory" ? VICTORY_MELODY : MENU_MELODY;
      const mNote = seq[step % seq.length];
      if (mNote !== null) {
        this.playMarimba(ac, bus, MIDI(mNote), t, dur * 1.4, this.mood === "victory" ? 0.11 : 0.085);
      }
    } else if (this.mood === "rally" && (beatInBar % 2 === 0 || this.tension > 0.4)) {
      const arpNote = chord[1 + ((step + bar) % 4)] + 12;
      this.playMarimba(ac, bus, MIDI(arpNote), t, dur * 0.9, 0.055 + this.tension * 0.025);
    }

    // Light brushed tropical shaker on eighth notes
    if (this.mood !== "replay") {
      const accent = beatInBar % 2 === 0 ? 0.024 : 0.012;
      this.playShaker(ac, bus, t, accent);
    }
  }

  private playRhodes(ac: AudioContext, bus: GainNode, freq: number, t: number, dur: number, vol: number): void {
    const o = ac.createOscillator();
    const o2 = ac.createOscillator();
    const g = ac.createGain();
    o.type = "sine";
    o2.type = "triangle";
    o.frequency.setValueAtTime(freq, t);
    o2.frequency.setValueAtTime(freq * 2, t);
    const g2 = ac.createGain();
    g2.gain.setValueAtTime(0.14, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t + Math.min(0.18, dur));
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.018);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    o2.connect(g2).connect(g);
    g.connect(bus);
    o.start(t);
    o2.start(t);
    o.stop(t + dur + 0.03);
    o2.stop(t + dur + 0.03);
  }

  private playMarimba(ac: AudioContext, bus: GainNode, freq: number, t: number, dur: number, vol: number): void {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(bus);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private playBass(ac: AudioContext, bus: GainNode, freq: number, t: number, dur: number, vol: number): void {
    const o = ac.createOscillator();
    const lp = ac.createBiquadFilter();
    const g = ac.createGain();
    o.type = "triangle";
    o.frequency.setValueAtTime(freq, t);
    lp.type = "lowpass";
    lp.frequency.value = 320;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(lp).connect(g).connect(bus);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private playShaker(ac: AudioContext, bus: GainNode, t: number, vol: number): void {
    // Ultra-light high-frequency impulse click using short detuned oscillators
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = "square";
    o.frequency.setValueAtTime(6400 + Math.random() * 1400, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol * 0.35, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.025);
    o.connect(g).connect(bus);
    o.start(t);
    o.stop(t + 0.03);
  }
}
