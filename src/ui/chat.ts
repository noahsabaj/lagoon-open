import type { PlayerSlot, PlayerState } from "../core/types";
import { escHtml } from "./hud";

interface ChatMessage {
  id: number;
  sender: "me" | "peer";
  senderSlot: PlayerSlot | "spec";
  name: string;
  text: string;
  quick: boolean;
  ts: number;
}

interface QuickChatPreset {
  key: string;
  text: string;
}

const MATCH_QUICK_CHATS: QuickChatPreset[] = [
  { key: "1", text: "Nice shot!" },
  { key: "2", text: "What a save!" },
  { key: "3", text: "Close one!" },
  { key: "4", text: "GG!" },
];

const LOBBY_QUICK_CHATS: string[] = ["Ready!", "Let's play!", "Nice shot!", "GG!"];
const POST_QUICK_CHATS: string[] = ["GG!", "Rematch?", "Close one!", "What a match!"];

export const CHAT_MAX_LEN = 160;
export const CHAT_COOLDOWN_MS = 350;
const MAX_HISTORY = 60;
const FEED_FADE_MS = 6500;
const BUBBLE_LIFE_MS = 3400;

export function sanitizeChatText(raw: string): string {
  // Strip ASCII control characters, collapse whitespace runs, and clamp to CHAT_MAX_LEN
  return String(raw || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CHAT_MAX_LEN);
}

interface ChatHooks {
  onSend: (text: string, quick: boolean) => boolean;
  onSound: (isRemote: boolean) => void;
  getMyName: () => string;
  getPeerName: () => string;
  getMySlot?: () => PlayerSlot | "spec";
  isLanReady: () => boolean;
  isLiveLanMatch: () => boolean;
}

interface ActiveBubble {
  name: string;
  text: string;
  quick: boolean;
  until: number;
}

export class ChatController {
  public messages: ChatMessage[] = [];
  public muted = false;
  public isOpen = false;
  public unread = 0;

  private nextId = 1;
  private lastSendMs = -9999;
  private lastActivityMs = 0;
  private fadeTimer = 0;

  // Up to 4 floating court speech bubbles (one per active player slot 0..3!)
  private bubbles: Array<ActiveBubble | null> = [null, null, null, null];
  private _proj = { x: 0, y: 0, visible: false };

  // Live match HUD elements
  private hudRoot: HTMLElement | null = null;
  private hudFeed: HTMLElement | null = null;
  private hudInput: HTMLInputElement | null = null;
  private hudTitle: HTMLElement | null = null;
  private hudMuteBtn: HTMLButtonElement | null = null;
  private hudToggleBtn: HTMLButtonElement | null = null;
  private hudUnreadBadge: HTMLElement | null = null;
  private bubbleEls: Array<HTMLElement | null> = [null, null, null, null];

  // Currently mounted embedded chat panel (Lobby or Post-Match)
  private embeddedHost: HTMLElement | null = null;
  private embeddedFeed: HTMLElement | null = null;
  private embeddedMuteBtn: HTMLButtonElement | null = null;

  constructor(private hooks: ChatHooks) {
    this.bindHud();
  }

  private bindHud(): void {
    if (typeof document === "undefined") return;
    this.hudRoot = document.getElementById("chatHud");
    this.hudFeed = document.getElementById("chatHudFeed");
    this.hudInput = document.getElementById("chatHudInput") as HTMLInputElement | null;
    this.hudTitle = document.getElementById("chatHudTitle");
    this.hudMuteBtn = document.getElementById("chatHudMute") as HTMLButtonElement | null;
    this.hudToggleBtn = document.getElementById("chatHudToggle") as HTMLButtonElement | null;
    this.hudUnreadBadge = document.getElementById("chatHudUnread");
    this.bubbleEls = [
      document.getElementById("chatBubble0"),
      document.getElementById("chatBubble1"),
      document.getElementById("chatBubble2"),
      document.getElementById("chatBubble3"),
    ];

    if (this.hudToggleBtn) {
      this.hudToggleBtn.onclick = () => {
        if (this.isOpen) this.closeComposer();
        else this.openComposer();
      };
    }

    const closeBtn = document.getElementById("chatHudClose");
    if (closeBtn) closeBtn.onclick = () => this.closeComposer();

    if (this.hudMuteBtn) {
      this.hudMuteBtn.onclick = () => this.toggleMute();
    }

    const sendBtn = document.getElementById("chatHudSend");
    if (sendBtn) {
      sendBtn.onclick = () => this.submitHudInput();
    }

    if (this.hudInput) {
      this.hudInput.maxLength = CHAT_MAX_LEN;
      this.hudInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          this.submitHudInput();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          this.closeComposer();
        }
      });
    }

    const quickRow = document.getElementById("chatHudQuick");
    if (quickRow) {
      quickRow.innerHTML = MATCH_QUICK_CHATS.map(
        (q, i) =>
          `<button class="chat-qbtn" type="button" data-qidx="${i}"><kbd>${q.key}</kbd><span>${escHtml(q.text)}</span></button>`
      ).join("");
      quickRow.querySelectorAll<HTMLButtonElement>("[data-qidx]").forEach((btn) => {
        btn.onclick = () => {
          const idx = Number(btn.dataset.qidx);
          this.sendQuick(idx);
          this.closeComposer();
        };
      });
    }

    this.refreshMuteButtons();
  }

  public toggleMute(): void {
    this.muted = !this.muted;
    if (this.muted) {
      const mySlot = this.hooks.getMySlot ? this.hooks.getMySlot() : 0;
      for (let i = 0; i < 4; i++) {
        if (i !== mySlot) {
          this.bubbles[i] = null;
          this.hideBubbleEl(i);
        }
      }
    } else {
      this.unread = 0;
    }
    this.refreshMuteButtons();
    this.renderFeeds();
  }

  private refreshMuteButtons(): void {
    const label = this.muted ? "Muted" : "Mute";
    const title = this.muted ? "Unmute incoming chat" : "Mute incoming chat";
    for (const btn of [this.hudMuteBtn, this.embeddedMuteBtn]) {
      if (!btn) continue;
      btn.textContent = label;
      btn.title = title;
      btn.setAttribute("aria-pressed", String(this.muted));
      btn.classList.toggle("is-muted", this.muted);
    }
    if (this.hudUnreadBadge) {
      this.hudUnreadBadge.textContent = String(this.unread);
      this.hudUnreadBadge.hidden = this.unread <= 0 || this.isOpen;
    }
  }

  public openComposer(): void {
    if (!this.hooks.isLiveLanMatch()) return;
    this.isOpen = true;
    this.unread = 0;
    this.refreshMuteButtons();
    if (this.hudRoot) {
      this.hudRoot.hidden = false;
      this.hudRoot.classList.add("open", "active");
    }
    this.renderFeeds();
    if (this.hudInput) {
      this.hudInput.focus();
    }
  }

  public closeComposer(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    if (this.hudInput) this.hudInput.blur();
    if (this.hudRoot) this.hudRoot.classList.remove("open");
    this.scheduleHudFade();
    this.refreshMuteButtons();
  }

  private submitHudInput(): void {
    if (!this.hudInput) return;
    const raw = this.hudInput.value;
    this.hudInput.value = "";
    const text = sanitizeChatText(raw);
    if (text) this.send(text, false);
    this.closeComposer();
  }

  public sendQuick(index: number): boolean {
    const preset = MATCH_QUICK_CHATS[index];
    if (!preset) return false;
    return this.send(preset.text, true);
  }

  public send(rawText: string, quick = false, nowMs = performance.now()): boolean {
    if (!this.hooks.isLanReady()) return false;
    const text = sanitizeChatText(rawText);
    if (!text) return false;
    if (nowMs - this.lastSendMs < CHAT_COOLDOWN_MS) return false;

    const ok = this.hooks.onSend(text, quick);
    if (!ok) return false;
    this.lastSendMs = nowMs;

    const myName = this.hooks.getMyName() || "You";
    const mySlot = this.hooks.getMySlot ? this.hooks.getMySlot() : 0;
    this.pushMessage("me", mySlot, myName, text, quick, nowMs);
    this.hooks.onSound(false);
    return true;
  }

  public receivePeer(
    peerName: string,
    rawText: string,
    quick = false,
    nowMs = performance.now(),
    senderSlot: PlayerSlot | "spec" = 1
  ): void {
    const text = sanitizeChatText(rawText);
    if (!text) return;
    this.pushMessage("peer", senderSlot, peerName || this.hooks.getPeerName() || "Buddy", text, quick, nowMs);
    if (!this.muted) {
      this.hooks.onSound(true);
    } else if (!this.isOpen) {
      this.unread++;
      this.refreshMuteButtons();
    }
  }

  private pushMessage(
    sender: "me" | "peer",
    senderSlot: PlayerSlot | "spec",
    name: string,
    text: string,
    quick: boolean,
    nowMs: number
  ): void {
    this.messages.push({ id: this.nextId++, sender, senderSlot, name, text, quick, ts: nowMs });
    if (this.messages.length > MAX_HISTORY) {
      this.messages.splice(0, this.messages.length - MAX_HISTORY);
    }

    const showIncoming = sender !== "peer" || !this.muted;
    if (showIncoming) {
      this.lastActivityMs = nowMs;
      if (this.hudRoot && this.hooks.isLiveLanMatch()) {
        this.hudRoot.classList.add("active");
        this.scheduleHudFade();
      }
      if (senderSlot !== "spec" && this.hooks.isLiveLanMatch()) {
        this.bubbles[senderSlot] = { name, text, quick, until: nowMs + BUBBLE_LIFE_MS };
      }
    }

    this.renderFeeds();
  }

  private scheduleHudFade(): void {
    if (typeof window === "undefined") return;
    window.clearTimeout(this.fadeTimer);
    if (this.isOpen) return;
    this.fadeTimer = window.setTimeout(() => {
      if (!this.isOpen && this.hudRoot) {
        this.hudRoot.classList.remove("active");
      }
    }, FEED_FADE_MS);
  }

  public clearSession(): void {
    this.messages.length = 0;
    this.unread = 0;
    this.lastActivityMs = 0;
    for (let i = 0; i < 4; i++) {
      this.bubbles[i] = null;
      this.hideBubbleEl(i);
    }
    this.closeComposer();
    this.refreshMuteButtons();
    this.renderFeeds();
    this.syncHudVisibility(false);
  }

  public syncHudVisibility(showLiveHud: boolean): void {
    if (!this.hudRoot) return;
    this.hudRoot.hidden = !showLiveHud;
    if (!showLiveHud) {
      if (this.isOpen) this.closeComposer();
      for (let i = 0; i < 4; i++) this.hideBubbleEl(i);
      return;
    }
    if (this.hudTitle) {
      this.hudTitle.textContent = `Room Chat · ${this.hooks.getPeerName() || "Online"}`;
    }
    if (this.lastActivityMs > 0 && performance.now() - this.lastActivityMs < FEED_FADE_MS) {
      this.hudRoot.classList.add("active");
    }
  }

  public mountEmbedded(container: HTMLElement | null, context: "lobby" | "post"): void {
    if (!container) {
      this.unmountEmbedded();
      return;
    }
    if (this.embeddedHost === container && container.dataset.chatCtx === context) {
      this.renderFeeds();
      return;
    }

    this.embeddedHost = container;
    container.dataset.chatCtx = context;
    const quicks = context === "lobby" ? LOBBY_QUICK_CHATS : POST_QUICK_CHATS;
    const roomLabel = escHtml(this.hooks.getPeerName() || "Room");

    container.innerHTML = `
      <div class="chat-embed">
        <div class="chat-embed-head">
          <span class="chat-embed-title">Room Chat · ${roomLabel}</span>
          <button class="chat-mute-btn" type="button" data-chat-mute>${this.muted ? "Muted" : "Mute"}</button>
        </div>
        <div class="chat-embed-feed" data-chat-feed aria-live="polite"></div>
        <div class="chat-embed-quicks">
          ${quicks.map((q) => `<button class="chat-qbtn" type="button" data-eq="${escHtml(q)}">${escHtml(q)}</button>`).join("")}
        </div>
        <div class="chat-embed-bar">
          <input class="chat-input" type="text" data-chat-input maxlength="${CHAT_MAX_LEN}" autocomplete="off" placeholder="Message room…">
          <button class="chat-send-btn" type="button" data-chat-send>Send</button>
        </div>
      </div>
    `;

    this.embeddedFeed = container.querySelector<HTMLElement>("[data-chat-feed]");
    this.embeddedMuteBtn = container.querySelector<HTMLButtonElement>("[data-chat-mute]");
    const input = container.querySelector<HTMLInputElement>("[data-chat-input]");
    const sendBtn = container.querySelector<HTMLButtonElement>("[data-chat-send]");

    if (this.embeddedMuteBtn) {
      this.embeddedMuteBtn.onclick = () => this.toggleMute();
    }

    const doSend = () => {
      if (!input) return;
      const val = input.value;
      if (this.send(val, false)) {
        input.value = "";
      }
      input.focus();
    };
    if (sendBtn) sendBtn.onclick = doSend;
    if (input) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          doSend();
        } else if (e.key === "Escape") {
          e.stopPropagation();
          input.blur();
        }
      });
    }

    container.querySelectorAll<HTMLButtonElement>("[data-eq]").forEach((btn) => {
      btn.onclick = () => {
        this.send(btn.dataset.eq || "", true);
      };
    });

    this.refreshMuteButtons();
    this.renderFeeds();
  }

  public unmountEmbedded(): void {
    this.embeddedHost = null;
    this.embeddedFeed = null;
    this.embeddedMuteBtn = null;
  }

  private renderMessageRows(maxVisible: number, emptyHint: string): string {
    const visible = this.messages.filter((m) => !(this.muted && m.sender === "peer"));
    const slice = maxVisible > 0 ? visible.slice(-maxVisible) : visible;
    if (slice.length === 0) {
      return `<div class="chat-empty">${escHtml(emptyHint)}</div>`;
    }
    return slice
      .map((m) => {
        const roleCls =
          m.senderSlot === "spec"
            ? "spec"
            : m.sender === "me"
            ? "me"
            : m.senderSlot % 2 === 0
            ? "me"
            : "peer";
        const qCls = m.quick ? " quick" : "";
        const badge = m.senderSlot === "spec" ? `<span class="chat-spec-tag">SPEC</span>` : "";
        return `<div class="chat-line ${roleCls}${qCls}">${badge}<span class="chat-who">${escHtml(m.name)}</span><span class="chat-txt">${escHtml(m.text)}</span></div>`;
      })
      .join("");
  }

  private renderFeeds(): void {
    if (this.hudFeed) {
      const limit = this.isOpen ? 30 : 4;
      const empty = this.muted
        ? "Chat muted — tap Mute to re-enable."
        : "Press Enter or T to type, or 1–4 for quick-chat.";
      this.hudFeed.innerHTML = this.renderMessageRows(limit, empty);
      this.hudFeed.scrollTop = this.hudFeed.scrollHeight;
    }
    if (this.embeddedFeed) {
      const empty = this.muted
        ? "Incoming chat muted."
        : "Say hi or tap a quick message below!";
      this.embeddedFeed.innerHTML = this.renderMessageRows(40, empty);
      this.embeddedFeed.scrollTop = this.embeddedFeed.scrollHeight;
    }
  }

  private hideBubbleEl(slot: number): void {
    const el = this.bubbleEls[slot];
    if (el) el.hidden = true;
  }

  public updateBubbles(
    nowMs: number,
    players: PlayerState[],
    viewW: number,
    viewH: number,
    project: (x: number, y: number, z: number, out: { x: number; y: number; visible: boolean }) => void
  ): void {
    const live = this.hooks.isLiveLanMatch();
    const mySlot = this.hooks.getMySlot ? this.hooks.getMySlot() : 0;

    for (let i = 0; i < 4; i++) {
      const b = this.bubbles[i];
      const el = this.bubbleEls[i];
      const player = players[i];
      if (!el) continue;

      if (!live || !b || !player || (i !== mySlot && this.muted) || nowMs >= b.until) {
        if (b && nowMs >= b.until) this.bubbles[i] = null;
        el.hidden = true;
        continue;
      }

      project(player.x, 2.15, player.z, this._proj);
      if (!this._proj.visible) {
        el.hidden = true;
        continue;
      }

      const sx = Math.max(96, Math.min(viewW - 96, this._proj.x));
      const sy = Math.max(76, Math.min(viewH - 84, this._proj.y));
      const remain = b.until - nowMs;
      const opacity = remain < 450 ? Math.max(0, remain / 450) : 1;

      if (el.dataset.msg !== b.text) {
        el.dataset.msg = b.text;
        el.textContent = b.text;
        el.classList.toggle("quick", b.quick);
      }
      el.hidden = false;
      el.style.opacity = opacity.toFixed(2);
      el.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0) translate(-50%, -100%)`;
    }
  }
}
