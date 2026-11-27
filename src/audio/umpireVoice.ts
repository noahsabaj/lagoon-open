import type { SettingsState } from "../core/types";

export class UmpireVoice {
  private settings: SettingsState;
  private preferredVoice: SpeechSynthesisVoice | null = null;

  constructor(settings: SettingsState) {
    this.settings = settings;
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      const pick = () => {
        const voices = window.speechSynthesis.getVoices();
        if (!voices.length) return;
        // Prefer crisp natural English voice (macOS Samantha/Daniel/Karen or Google/Microsoft EN)
        this.preferredVoice =
          voices.find((v) => /en[-_](GB|US|AU)/i.test(v.lang) && /(Daniel|Samantha|Karen|Google UK|Natural)/i.test(v.name)) ||
          voices.find((v) => /^en/i.test(v.lang)) ||
          voices[0];
      };
      pick();
      window.speechSynthesis.onvoiceschanged = pick;
    }
  }

  public speak(text: string, rate = 1.06, pitch = 1.0): void {
    if (
      typeof window === "undefined" ||
      !("speechSynthesis" in window) ||
      this.settings.muted ||
      !this.settings.umpireVoice ||
      this.settings.voiceVol <= 0.01
    ) {
      return;
    }
    try {
      const synth = window.speechSynthesis;
      synth.cancel();
      const utt = new SpeechSynthesisUtterance(text);
      if (this.preferredVoice) utt.voice = this.preferredVoice;
      utt.rate = rate;
      utt.pitch = pitch;
      utt.volume = Math.min(1, this.settings.masterVol * this.settings.voiceVol);
      synth.speak(utt);
    } catch {
      // ignore if speech synthesis is unavailable
    }
  }

  public announcePoint(big: string, sub: string, isMatch: boolean): void {
    const cleanBig = big.replace(/!/g, "").trim();
    const cleanSub = sub.replace(/–/g, " ").replace(/!/g, "").trim();
    if (isMatch) {
      this.speak(cleanSub, 1.0, 1.04);
      return;
    }
    if (/^(ACE|Out|Double fault|Fault|Let)$/i.test(cleanBig)) {
      this.speak(`${cleanBig}. ${cleanSub}`, 1.08, 1.02);
    } else {
      this.speak(cleanSub, 1.06, 1.0);
    }
  }

  public announceCall(call: string): void {
    this.speak(call, 1.12, 1.02);
  }
}
